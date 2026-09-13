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
//
// 有两条路能回答这三个问题，形状完全一样：渲染 worker（pdf-worker-client.js），
// 和这个文件里的主线程实现。默认走 worker —— 栅格化一页要 14–34ms，放在主线程上
// 就是放大缩小时那一下卡顿。worker 起不来、或者 pdf.js 在里面跑不动，就落回主线
// 程，功能一点不少，只是会卡。回退是静默的，但 Logger 里会留一行。

import { extractOutline, fragmentsFrom, textLinesFrom, NO_OUTLINE } from './pdf-extract.js';
import { PDF_ERRORS } from './pdf-errors.js';
import { openInWorker, workerRenderingAvailable } from './pdf-worker-client.js';

// 目录抽取和文本归行的实现在 pdf-extract.js —— worker 那条路要用同一份，两边抽出
// 来的文本不能有任何差别。这里转发出去，免得调用方还要知道它搬过家了。
export { NO_OUTLINE, PDF_ERRORS };

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
  if (workerRenderingAvailable()) {
    try {
      return await openInWorker(bytes);
    } catch (cause) {
      // worker 那条路整条不可用（浏览器不给开、pdf.js 在里面跑不动、或者将来某次
      // 升级碰了 document 桩没给的东西）。功能不能因此少一块，所以落回主线程 ——
      // 页还是那些页，字还是那些字，只是栅格化重新占着主线程，放大缩小会卡。
      //
      // 这一行日志是唯一能看出「为什么又卡了」的地方，不要删。
      try { console.warn('[PDF] worker 渲染不可用，回退主线程：', cause); } catch (_) { /* 没有 console */ }
    }
  }
  return openOnMainThread(bytes);
}

/**
 * 主线程上的实现，也是回退路径。
 *
 * 在 worker 之前，这是唯一的实现，所以它的行为就是基准：worker 那条路要和它逐像
 * 素、逐行地一致，任何一处对不上都是 worker 的 bug，不是这里的。
 */
async function openOnMainThread(bytes) {
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
     *
     * `drawable` 只对 worker 那条路有意义（那边默认给的是零拷贝的
     * bitmaprenderer 画布，拿不到 2d 上下文）。主线程画出来的画布本来就能继续
     * 画，所以这里收下就完了 —— 两条路的签名必须一样，否则调用方得先知道自己
     * 在跟谁说话。
     *
     * @returns {Promise<{canvas: HTMLCanvasElement, width: number, height: number}>}
     */
    async renderPage(pageNumber, scale, _options = {}) {
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

      const fragments = fragmentsFrom(content.items);
      page.cleanup();
      return textLinesFrom(fragments);
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
