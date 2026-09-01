// Getting text for a page, from wherever it is actually available.
//
// The engine does not read PDFs and does not do OCR. It asks for the text of a
// page range and gets it. This module is the seam: it decides, per page,
// whether the PDF's own text layer will do or whether the host has to render
// and recognise the page, and it remembers the answer.
//
// Why this exists rather than the host simply passing OCR'd text in:
//
//   Indexing used to extract the whole book before anything could be matched.
//   With a text layer that costs milliseconds — 9ms for the 372-page key. With
//   OCR it costs 372 page renders and recognitions, before the reader sees a
//   single answer. That is not a slower version of the same design; it is a
//   different design, and it has to be lazy.
//
// So: ids and page ranges come from the bookmark tree, which needs no text at
// all. Text is fetched only for the pages a decision actually depends on —
// typically the one page the reader is looking at, and the one answer page a
// question resolves to. On the 2023 books that is 2 pages out of 740.
//
// The recognise() function is injected. The host already has one (tesseract.js,
// or an ONNX text-detection/recognition pair, or a platform API); this file
// stays dependency-free and never learns which.

// Repairing a broken font map lives in glyph-map.js; re-exported here because
// it is part of the same story: how a page's text is obtained and made usable.
export {
  createGlyphLearner,
  createGlyphRepair,
  learnGlyphTable,
  repairCoverage,
} from './glyph-map.js';

import {
  TEXT_QUALITY,
  assessTextQuality,
  textMayBeComparable,
} from './text-quality.js';

/** Where a page's text came from. Governs how far it can be trusted. */
export const TEXT_ORIGIN = Object.freeze({
  /** The PDF's own text layer, good enough to use. */
  LAYER: 'LAYER',
  /** Rendered and recognised, because the layer was not. */
  OCR: 'OCR',
  /** Neither worked. */
  NONE: 'NONE',
});

/**
 * A lazy, cached text provider over a document.
 *
 * @param {object} doc the usual document interface: numPages, outline,
 *   extractText({from, to}). May additionally expose renderPage({page}) for OCR.
 * @param {object} options
 * @param {(page:number)=>Promise<string|Array<{text:string}>>} [options.recognise]
 *   Host-supplied OCR for one page. Absent, the source is layer-only and simply
 *   reports pages it cannot serve.
 * @param {string} [options.expectScript] passed to the quality gate.
 * @param {number} [options.samplePages] how many pages to sample when judging
 *   the layer's quality up front.
 */
export function createTextSource(doc, {
  recognise = null,
  expectScript = 'auto',
  samplePages = 12,
} = {}) {
  const cache = new Map();       // page -> {text, origin}
  let layerVerdict = null;       // assessed once, from a sample

  /**
   * Judges the text layer from a sample rather than the whole book.
   *
   * A 372-page book's quality is not a different number when measured on 12
   * pages spread through it, and measuring it on 12 avoids paying for 372
   * before deciding they are worthless.
   */
  async function assessLayer() {
    if (layerVerdict) return layerVerdict;
    const total = doc.numPages || 0;
    if (total === 0) {
      layerVerdict = assessTextQuality([], { expectScript });
      return layerVerdict;
    }
    const stride = Math.max(1, Math.floor(total / samplePages));
    const sampled = [];
    for (let page = 1; page <= total; page += stride) {
      const lines = await doc.extractText({ from: page, to: page });
      sampled.push(...(lines ?? []));
      if (sampled.length > 4000) break;
    }
    layerVerdict = assessTextQuality(sampled, { expectScript });
    return layerVerdict;
  }

  /**
   * The text of one page, from the layer when it is usable and from OCR when it
   * is not.
   *
   * OPAQUE counts as usable HERE even though it cannot be displayed: it is
   * still the cheaper signal, and a caller that needs readable text asks for
   * `{ needReadable: true }` and gets OCR instead.
   */
  async function pageText(page, { needReadable = false } = {}) {
    const key = `${page}:${needReadable ? 'R' : 'C'}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const verdict = await assessLayer();
    const layerWillDo = needReadable
      ? (verdict.quality === TEXT_QUALITY.USABLE || verdict.quality === TEXT_QUALITY.DEGRADED)
      : textMayBeComparable(verdict.quality);

    if (layerWillDo) {
      const lines = await doc.extractText({ from: page, to: page });
      const text = (lines ?? []).map(l => l.text).join(' ').trim();
      if (text) {
        const out = { text, origin: TEXT_ORIGIN.LAYER, page };
        cache.set(key, out);
        return out;
      }
    }

    if (!recognise) {
      const out = { text: '', origin: TEXT_ORIGIN.NONE, page, reason: verdict.reason };
      cache.set(key, out);
      return out;
    }

    const recognised = await recognise(page);
    const text = Array.isArray(recognised)
      ? recognised.map(r => r?.text ?? '').join(' ').trim()
      : String(recognised ?? '').trim();
    const out = text
      ? { text, origin: TEXT_ORIGIN.OCR, page }
      : { text: '', origin: TEXT_ORIGIN.NONE, page, reason: 'OCR 未返回文本' };
    cache.set(key, out);
    return out;
  }

  /** The text of an inclusive page range, concatenated. */
  async function rangeText(from, to, options) {
    const parts = [];
    let origin = TEXT_ORIGIN.NONE;
    for (let page = from; page <= to; page++) {
      const got = await pageText(page, options);
      if (!got.text) continue;
      parts.push(got.text);
      // OCR anywhere in the range taints the whole range's provenance.
      origin = got.origin === TEXT_ORIGIN.OCR ? TEXT_ORIGIN.OCR
        : (origin === TEXT_ORIGIN.NONE ? got.origin : origin);
    }
    return { text: parts.join(' ').trim(), origin, from, to };
  }

  /**
   * Fills in one index entry's text on demand.
   *
   * Returns a COPY rather than mutating: an entry that has been through OCR is
   * a different thing from one that has not, and the caller should be able to
   * see which it is holding.
   */
  async function hydrate(entry, options) {
    if (!entry) return entry;
    if (entry.text) return entry;
    const got = await rangeText(entry.page, entry.endPage ?? entry.page, options);
    return { ...entry, text: got.text, textOrigin: got.origin };
  }

  return {
    assessLayer,
    pageText,
    rangeText,
    hydrate,
    /** Pages fetched so far — the cost this design exists to keep small. */
    get pagesFetched() { return new Set([...cache.keys()].map(k => k.split(':')[0])).size; },
    get cacheSize() { return cache.size; },
  };
}
