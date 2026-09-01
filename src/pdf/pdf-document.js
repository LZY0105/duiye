// PDF Module — document domain layer.
//
// A thin, UI-free wrapper over pdf.js. pdf.js is loaded as a classic script in
// index.html (/vendor/pdf.min.js) and exposes a `pdfjsLib` global with its
// worker already pointed at /vendor/pdf.worker.min.js — it is deliberately NOT
// an npm import, and nothing here should turn it into one.
//
// This layer knows nothing about canvases, layout or slots. It answers three
// questions: how many pages, what is the original outline, and what does page N
// look like at scale S.

/** Outline extraction never invents entries; this is the "absent" answer. */
export const NO_OUTLINE = Object.freeze({ available: false, items: [] });

/**
 * Baseline drift tolerated when grouping text fragments into a line, in PDF
 * units. Large enough to keep a superscript with its line, small enough not to
 * merge adjacent lines of body text.
 */
const LINE_TOLERANCE = 2.5;

/**
 * Resources pdf.js needs to decode CID-keyed fonts.
 *
 * Chinese textbooks embed CID-keyed CJK fonts, and decoding their text requires
 * the character maps. Without cMapUrl, pdf.js cannot map glyph ids back to
 * Unicode and returns a stream of plausible-looking codepoints from unrelated
 * scripts instead — extraction "succeeds", every downstream stage treats the
 * result as content, and nothing looks wrong.
 *
 * Measured on 2023年名校数学专业考研真题分类, page 4, the same line:
 *
 *   without cmaps   ২ี 1.1 2023.॓࿐ჽն࿐ ჰ PDFֻ4 ်
 *   with cmaps      例题 1.1 2023. 中国科学院大学 原 PDF 第 4 页
 *
 * The fonts are not broken; the reader was missing its decoding tables. Both
 * directories are copied into public/vendor/ so they resolve offline, which the
 * app requires.
 */
const PDF_RESOURCES = Object.freeze({
  cMapUrl: '/vendor/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/vendor/standard_fonts/',
});

export const PDF_ERRORS = Object.freeze({
  RUNTIME_MISSING: 'PDF_RUNTIME_MISSING',
  OPEN_FAILED: 'PDF_OPEN_FAILED',
  PAGE_OUT_OF_RANGE: 'PDF_PAGE_OUT_OF_RANGE',
});

function runtime() {
  const lib = typeof window !== 'undefined' ? window.pdfjsLib : undefined;
  if (!lib || typeof lib.getDocument !== 'function') {
    throw new Error(PDF_ERRORS.RUNTIME_MISSING);
  }
  return lib;
}

/** True when pdf.js is present. Lets callers degrade instead of throwing. */
export function isPdfRuntimeAvailable() {
  try {
    runtime();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Converts pdf.js's raw outline tree into our own shape.
 *
 * Spec rule: preserve the original table of contents when the document has one,
 * and never force-generate one when it does not. A document without bookmarks
 * therefore yields `available: false` and an empty list — callers must render
 * "this document has no table of contents" rather than synthesising headings
 * from page numbers or text.
 *
 * Destinations are resolved to 1-based page numbers where pdf.js can resolve
 * them; an entry whose destination cannot be resolved keeps `pageNumber: null`
 * and is shown as non-navigable rather than silently pointing at page 1.
 */
async function extractOutline(pdf) {
  let raw;
  try {
    raw = await pdf.getOutline();
  } catch (_) {
    return NO_OUTLINE;
  }
  if (!Array.isArray(raw) || raw.length === 0) return NO_OUTLINE;

  const resolvePage = async (dest) => {
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const index = await pdf.getPageIndex(explicit[0]);
      return index + 1;
    } catch (_) {
      return null;
    }
  };

  const convert = async (nodes, depth) => {
    const out = [];
    for (const node of nodes) {
      const pageNumber = node.dest ? await resolvePage(node.dest) : null;
      out.push({
        title: String(node.title || '').trim(),
        pageNumber,
        depth,
        children: Array.isArray(node.items) && node.items.length
          ? await convert(node.items, depth + 1)
          : [],
      });
    }
    return out;
  };

  return { available: true, items: await convert(raw, 0) };
}

/**
 * Opens a PDF from raw bytes.
 *
 * Takes an ArrayBuffer/Uint8Array rather than a File so the same call works for
 * a freshly imported file and for bytes replayed out of the library on session
 * restore.
 *
 * pdf.js takes ownership of the buffer it is handed and detaches it, so a copy
 * is passed. Without this, re-opening the same cached bytes a second time fails
 * with a detached-ArrayBuffer error.
 */
export async function openPdfDocument(bytes) {
  const lib = runtime();
  const data = bytes instanceof Uint8Array
    ? bytes.slice()
    : new Uint8Array(bytes).slice();

  let pdf;
  try {
    pdf = await lib.getDocument({ data, ...PDF_RESOURCES }).promise;
  } catch (cause) {
    const error = new Error(PDF_ERRORS.OPEN_FAILED);
    error.cause = cause;
    throw error;
  }

  // Page 1 is already usable once pdf.js has opened the document. Resolving a
  // large bookmark tree can require hundreds of destination lookups, so keep
  // that optional work behind one memoized promise instead of putting it on
  // the first-paint path.
  // null means "not requested yet"; NO_OUTLINE means extraction completed and
  // the source PDF genuinely has no bookmark tree.
  let outline = null;
  let outlinePromise = null;
  const getOutline = () => {
    if (!outlinePromise) {
      outlinePromise = extractOutline(pdf).then((value) => {
        outline = value;
        return value;
      });
    }
    return outlinePromise;
  };

  return {
    numPages: pdf.numPages,
    get outline() { return outline; },
    getOutline,

    /**
     * Renders one page into a canvas at the given scale.
     * @returns {Promise<{canvas: HTMLCanvasElement, width: number, height: number}>}
     */
    async renderPage(pageNumber, scale) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
        throw new Error(PDF_ERRORS.PAGE_OUT_OF_RANGE);
      }
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: context, viewport }).promise;
      // Release pdf.js's per-page cache; without this a long document keeps
      // every visited page's operator list alive for the session.
      page.cleanup();
      return { canvas, width: canvas.width, height: canvas.height };
    },

    /**
     * Extracts a page's embedded text.
     *
     * This is the PDF's own text layer, not OCR: a digital exercise book
     * already carries its characters, and reading them is both exact and free
     * compared with rasterising and recognising the page.
     *
     * Returns lines rather than one blob. pdf.js emits positioned fragments in
     * no guaranteed reading order, so fragments are grouped by their baseline
     * y-coordinate and sorted left-to-right — without that, "1. 解方程" and its
     * answer on the same visual line can arrive interleaved with text from
     * elsewhere on the page.
     *
     * @returns {Promise<{lines: string[], empty: boolean}>}
     */
    async pageText(pageNumber) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
        throw new Error(PDF_ERRORS.PAGE_OUT_OF_RANGE);
      }
      const page = await pdf.getPage(pageNumber);
      let content;
      try {
        content = await page.getTextContent();
      } catch (_) {
        page.cleanup();
        return { lines: [], empty: true };
      }

      // Group fragments into rows by baseline, tolerating small drift so
      // superscripts and inline maths stay on their own line.
      const rows = [];
      for (const item of content.items) {
        const text = typeof item.str === 'string' ? item.str : '';
        if (!text) continue;
        const x = item.transform ? item.transform[4] : 0;
        const y = item.transform ? item.transform[5] : 0;
        const row = rows.find(r => Math.abs(r.y - y) <= LINE_TOLERANCE);
        if (row) row.parts.push({ x, text });
        else rows.push({ y, parts: [{ x, text }] });
      }

      page.cleanup();

      const lines = rows
        .sort((a, b) => b.y - a.y)                  // PDF y grows upward
        .map(row => row.parts
          .sort((a, b) => a.x - b.x)
          .map(p => p.text)
          .join('')
          .replace(/\s+/g, ' ')
          .trim())
        .filter(Boolean);

      return { lines, empty: lines.length === 0 };
    },

    /**
     * Text for a range of pages, tagged with the page each line came from.
     * Page numbers matter downstream: an answer's location is how a user
     * checks the match themselves.
     */
    async extractText({ from = 1, to = pdf.numPages } = {}) {
      const start = Math.max(1, from);
      const end = Math.min(pdf.numPages, to);
      const out = [];
      for (let p = start; p <= end; p++) {
        const { lines } = await this.pageText(p);
        for (const text of lines) out.push({ page: p, text });
      }
      return out;
    },

    /** Intrinsic page size at scale 1, used to fit a page to the viewport. */
    async pageSize(pageNumber) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
        throw new Error(PDF_ERRORS.PAGE_OUT_OF_RANGE);
      }
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const size = { width: viewport.width, height: viewport.height };
      page.cleanup();
      return size;
    },

    destroy() {
      try { pdf.destroy(); } catch (_) { /* already torn down */ }
    },
  };
}
