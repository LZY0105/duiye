// Is this text layer worth matching against?
//
// "The PDF returned some text" is not the same as "the PDF returned its text".
// A CJK font with a broken ToUnicode map extracts as a stream of plausible-
// looking codepoints from unrelated scripts, and every downstream stage treats
// it as content. Similarity scores come back in the normal range, so nothing
// looks wrong — the engine simply matches noise against noise and reports its
// usual confidence.
//
// Measured on the four books in the test corpus (Chinese mathematics, all four
// with a text layer pdf.js reads without error):
//
//   book       chars    odd-script   ctrl/FFFD   Han
//   q2023       56,682       7.36%       1.98%   0.00%
//   ans2023    242,801       4.89%       2.27%   0.00%
//   a2024      272,633       6.91%       2.13%   1.60%
//   g2024      206,391       6.85%       2.87%   1.87%
//
// Chinese textbooks containing no Chinese. The thresholds below are set from
// those numbers: clean extraction sits near zero on all three rates, so any
// appreciable reading means the mapping is broken and the caller must fall back
// to bookmarks or OCR rather than match against the result.

/** Why an index has no usable text — each needs a different message. */
export const TEXT_QUALITY = Object.freeze({
  /** Extraction succeeded and the result reads like the language it should. */
  USABLE: 'USABLE',
  /** Readable but with enough noise to distrust fine-grained comparison. */
  DEGRADED: 'DEGRADED',
  /**
   * Unreadable, but internally consistent.
   *
   * A broken ToUnicode map is a SUBSTITUTION, not noise: the same glyph decodes
   * to the same wrong codepoint every time. Measured on the 2023 pair, the
   * exercise book and its key share 334 of 335 garbled characters — 99.7% — so
   * text neither of them can display still compares correctly between them.
   *
   * The mathematics is usually untouched, because it is written in Latin and
   * digits: 13-20% digits, 16-20% Latin, 9-13% operators survive, and only the
   * CJK prose is destroyed. Ranking the correct answer first on this text scores
   * 95.8% by operator context.
   *
   * Comparable only against a book corrupted THE SAME WAY — across the 2023 and
   * 2024 series only 66% of the alphabet is shared. Always verify with
   * sharedAlphabetOverlap before trusting it, and never display it.
   */
  OPAQUE: 'OPAQUE',
  /** A text layer exists but does not carry the document's actual characters. */
  CORRUPT: 'CORRUPT',
  /**
   * A text layer exists, reads correctly, and covers almost none of the book.
   *
   * The state this gate was missing. Every other verdict here is a RATIO — what
   * share of the characters are Han, are noise, are structured — and a ratio
   * cannot see how FEW characters there are. Measured on the 2025 exercise book:
   * 609 characters across 465 pages, 48.9% of them Han, on 3 pages out of 465.
   * Every ratio looks healthy, and the document assessed as USABLE while being a
   * scan with a handful of stray text objects on it.
   *
   * The corpus separates the two cases by more than two orders of magnitude:
   * every genuine text layer covers 100% of its pages at 188-1,664 characters
   * per page, against 0.6% and 1.3. This is a coverage failure, not a decoding
   * failure, and the remedy is OCR rather than a different reader.
   */
  SPARSE_LAYER: 'SPARSE_LAYER',
  /** A text layer exists and is blank — a genuinely empty page range. */
  BLANK: 'BLANK',
  /** No text layer at all. A scanned book; OCR is the only route. */
  SCANNED: 'SCANNED',
});

/** Control characters and the replacement char, which extraction should never emit. */
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFD]');

/**
 * Scripts that cannot legitimately appear in a Chinese or English mathematics
 * book. A broken CJK mapping lands here constantly, because these blocks sit
 * where the misread glyph indices happen to point.
 */
const ODD_SCRIPT = new RegExp(
  '[\\u0530-\\u058F\\u0590-\\u05FF\\u0600-\\u06FF\\u0700-\\u074F'
  + '\\u0900-\\u097F\\u0980-\\u09FF\\u0A00-\\u0A7F\\u0B80-\\u0BFF'
  + '\\u0C00-\\u0C7F\\u0D00-\\u0D7F\\u0E00-\\u0E7F\\u0F00-\\u0FFF'
  + '\\u10A0-\\u10FF\\u1200-\\u137F]',
);

const HAN = /[㐀-䶿一-鿿]/;

/** Latin, digits and operators: what the mathematics is written in. */
const STRUCTURED = /[0-9A-Za-z+\-*/=^_(){}\[\]<>|∫∑∏√±×÷≤≥≠∞→]/;

const THRESHOLDS = Object.freeze({
  /** Above this the extraction is not carrying real characters. */
  corruptOddScript: 0.03,
  corruptControl: 0.02,
  /** Enough noise to stop trusting similarity, not enough to refuse outright. */
  degradedOddScript: 0.01,
  degradedControl: 0.005,
  /** A document expected to be Chinese with less Han than this has lost its CJK map. */
  minHanWhenExpected: 0.005,
  /** Latin+digit+operator share above which the mathematics is judged intact. */
  minStructuredForOpaque: 0.25,
  /** Below this many characters the rates are too noisy to judge. */
  minCharsToJudge: 200,
  /**
   * Characters per page below which the layer is not carrying the book.
   *
   * Measured floor across every genuine text layer in the corpus is 188.5;
   * the scanned book sits at 1.3. Twenty is an order of magnitude below the
   * real floor and an order above the scan, so it is not a tuned value.
   */
  minCharsPerPage: 20,
  /**
   * Share of pages that must carry any text at all.
   *
   * Every genuine text layer in the corpus covers 100% of its pages; the
   * scanned book covers 0.6%. Half sits in the middle of a gap that wide.
   */
  minPageCoverage: 0.5,
  /**
   * Pages a document needs before coverage means anything.
   *
   * The same guard minCharsToJudge provides for the ratios. A one-page extract
   * has no coverage to speak of, and a short fixture must not be mistaken for a
   * 465-page scan. Every real book in the corpus is 197 pages or more.
   */
  minPagesForCoverage: 8,
});

/**
 * Measures a set of extracted lines and returns a verdict.
 *
 * @param {Array<{page:number, text:string}>} lines
 * @param {{expectScript?: 'han'|'latin'|'auto'}} options
 *   'auto' judges on noise alone. Pass 'han' when the book is known to be
 *   Chinese: absence of the expected script is a far sharper signal than the
 *   noise rate, and it is the one that catches ans2023, whose odd-script rate
 *   is only 4.89% but whose Han rate is zero.
 * @returns {{quality: string, chars: number, controlRatio: number,
 *            oddScriptRatio: number, hanRatio: number, reason: string}}
 */
export function assessTextQuality(lines, { expectScript = 'auto', pagesRead = null } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  if (list.length === 0) {
    return report(TEXT_QUALITY.SCANNED, 0, 0, 0, 0, '没有文本层，可能是扫描件', 0);
  }

  let chars = 0;
  let control = 0;
  let odd = 0;
  let han = 0;
  let structured = 0;
  for (const line of list) {
    for (const ch of String(line?.text ?? '')) {
      chars++;
      if (CONTROL.test(ch)) control++;
      if (ODD_SCRIPT.test(ch)) odd++;
      if (HAN.test(ch)) han++;
      if (STRUCTURED.test(ch)) structured++;
    }
  }

  if (chars === 0) {
    return report(TEXT_QUALITY.BLANK, 0, 0, 0, 0, '文本层为空白', 0);
  }

  // Coverage, which no ratio can express. Judged only when the caller says how
  // many pages were actually read — without that number the denominator is
  // unknown and the question is unanswerable, so it is left unasked rather than
  // answered from the pages that happened to have text.
  const pagesWithText = new Set(
    list.filter(l => String(l?.text ?? '').trim().length > 0).map(l => l.page),
  ).size;
  const denominator = Number.isFinite(pagesRead) && pagesRead > 0 ? pagesRead : null;
  const charsPerPage = denominator ? chars / denominator : null;
  const pageCoverage = denominator ? pagesWithText / denominator : null;

  const controlRatio = control / chars;
  const oddScriptRatio = odd / chars;
  const hanRatio = han / chars;
  const structuredRatio = structured / chars;
  const judgeable = chars >= THRESHOLDS.minCharsToJudge;

  const done = (quality, reason) => ({
    ...report(quality, chars, controlRatio, oddScriptRatio, hanRatio, reason, structuredRatio),
    pagesRead: denominator,
    pagesWithText,
    charsPerPage: charsPerPage === null ? null : Number(charsPerPage.toFixed(2)),
    pageCoverage: pageCoverage === null ? null : Number(pageCoverage.toFixed(4)),
  });

  // Coverage is checked BEFORE the ratio tests. A scan with a few readable text
  // objects on it passes every ratio, and "is what I got readable" is the wrong
  // question when almost nothing was got.
  if (denominator !== null && denominator >= THRESHOLDS.minPagesForCoverage
    && (charsPerPage < THRESHOLDS.minCharsPerPage
      || pageCoverage < THRESHOLDS.minPageCoverage)) {
    return done(TEXT_QUALITY.SPARSE_LAYER,
      `文本层仅覆盖 ${(pageCoverage * 100).toFixed(1)}% 的页面、每页 ${charsPerPage.toFixed(1)} 字符，实为扫描件，需 OCR`);
  }

  // A broken CJK mapping destroys the prose and leaves the mathematics alone,
  // because the mathematics is written in Latin and digits. Enough of that
  // surviving means the text is unreadable rather than worthless — see OPAQUE.
  const opaque = structuredRatio >= THRESHOLDS.minStructuredForOpaque;

  if (judgeable && expectScript === 'han' && hanRatio < THRESHOLDS.minHanWhenExpected) {
    return opaque
      ? done(TEXT_QUALITY.OPAQUE,
        `汉字丢失（${(hanRatio * 100).toFixed(2)}%），但数式内容完整（${(structuredRatio * 100).toFixed(0)}%），可比对不可显示`)
      : done(TEXT_QUALITY.CORRUPT,
        `应为中文文档，但汉字占比仅 ${(hanRatio * 100).toFixed(2)}%，字库映射已损坏`);
  }
  if (judgeable && oddScriptRatio > THRESHOLDS.corruptOddScript) {
    return opaque
      ? done(TEXT_QUALITY.OPAQUE,
        `异常文种字符占比 ${(oddScriptRatio * 100).toFixed(2)}%，但数式内容完整，可比对不可显示`)
      : done(TEXT_QUALITY.CORRUPT,
        `异常文种字符占比 ${(oddScriptRatio * 100).toFixed(2)}%，文本层不可信`);
  }
  if (controlRatio > THRESHOLDS.corruptControl) {
    return done(TEXT_QUALITY.CORRUPT,
      `控制字符占比 ${(controlRatio * 100).toFixed(2)}%，文本提取失败`);
  }
  if (oddScriptRatio > THRESHOLDS.degradedOddScript
    || controlRatio > THRESHOLDS.degradedControl) {
    return done(TEXT_QUALITY.DEGRADED, '文本层含明显噪声，仅作辅助信号');
  }
  return done(TEXT_QUALITY.USABLE, '文本层可用');
}

function report(quality, chars, controlRatio, oddScriptRatio, hanRatio, reason, structuredRatio = 0) {
  return {
    quality,
    chars,
    controlRatio: round(controlRatio),
    oddScriptRatio: round(oddScriptRatio),
    hanRatio: round(hanRatio),
    structuredRatio: round(structuredRatio),
    reason,
  };
}

const round = (n) => Number(n.toFixed(4));

/**
 * Distinct characters needed before an alphabet comparison means anything.
 * Set from the measured separation curve in compareAlphabets.
 */
const MIN_ALPHABET = 250;

/** The set of characters a book's text layer actually emits. */
function alphabetOf(lines, minCount = 2) {
  const counts = new Map();
  for (const line of lines ?? []) {
    for (const ch of String(line?.text ?? '')) {
      if (/\s/.test(ch)) continue;
      counts.set(ch, (counts.get(ch) || 0) + 1);
    }
  }
  // Singletons are as likely to be extraction flukes as real alphabet members.
  return new Set([...counts.entries()].filter(([, n]) => n >= minCount).map(([c]) => c));
}

/**
 * Do two books garble their text the SAME way?
 *
 * This is the check that makes OPAQUE text safe to use, and the reason it can be
 * trusted where the positional prior could not: a signal that cannot detect its
 * own inapplicability has no business deciding anything, and this one can.
 *
 * A broken ToUnicode map is a substitution. If both books embed the same font
 * subset, the same source character produces the same wrong codepoint in each,
 * and comparing garbage to garbage is exactly as valid as comparing the real
 * text. If they embed different subsets, the two garbled alphabets barely
 * intersect and every cross-book score collapses toward zero — silently, and
 * indistinguishably from "these questions do not match".
 *
 * Measured: the 2023 exercise book and its key share 334 of 335 characters
 * (99.7%). The 2023 exercise book against the unrelated 2024 volume shares 66%.
 *
 * @returns {{overlap: number, comparable: boolean, shared: number, total: number}}
 */
export function sharedAlphabetOverlap(linesA, linesB, options = {}) {
  return compareAlphabets(alphabetOf(linesA), alphabetOf(linesB), options);
}

/** The characters a document's text layer emits, for later comparison. */
export function alphabetOfLines(lines, minCount = 2) {
  return alphabetOf(lines, minCount);
}

/**
 * The same verdict from two already-collected alphabets.
 *
 * Indexes carry theirs, so a caller that has indexed both books can ask whether
 * they garble alike without re-reading either — which matters when the text is
 * only being sampled, or is coming through OCR.
 */
export function compareAlphabets(a, b, { threshold = 0.9, minAlphabet = MIN_ALPHABET } = {}) {
  if (!(a instanceof Set) || !(b instanceof Set) || a.size === 0 || b.size === 0) {
    return { overlap: 0, comparable: false, sufficient: false, shared: 0, total: a?.size ?? 0 };
  }
  let shared = 0;
  for (const ch of a) if (b.has(ch)) shared++;

  // Containment of the SMALLER alphabet in the larger, not a plain ratio. An
  // answer key carries more prose and so more distinct glyphs than its exercise
  // book — 632 against 375 on the 2023 pair — and dividing by the wrong side
  // reads a perfect containment as 59% and refuses it. What matters is that one
  // book's characters are all interpretable in the other's, whichever is which.
  const overlap = shared / Math.min(a.size, b.size);
  // A small alphabet cannot separate the two cases. Measured on the 2023 pair
  // against the unrelated 2024 volume, by pages sampled:
  //
  //   pages   alphabet   matched   unrelated    gap
  //      12        109    0.9083      0.8807   0.028
  //      25        186    0.8978      0.8763   0.022   <- matched scores LOWER
  //      50        242    0.9421      0.8430   0.099       than the threshold
  //     100        287    0.9965      0.8467   0.150
  //     200        375    1.0000      0.7893   0.211
  //
  // Under ~250 characters the two are indistinguishable and the verdict is a
  // coin flip either way, so it is reported as insufficient rather than
  // guessed. A caller that wants OPAQUE text used must index enough of the book
  // to earn the answer — roughly 100 pages sampled, or index eagerly.
  const sufficient = Math.min(a.size, b.size) >= minAlphabet;
  return {
    overlap: Number(overlap.toFixed(4)),
    comparable: sufficient && overlap >= threshold,
    sufficient,
    shared,
    total: Math.min(a.size, b.size),
  };
}

/**
 * Whether text is worth ATTACHING to an index at all.
 *
 * Broader than textIsComparable: OPAQUE text is attached before anyone knows
 * whether the other book garbles the same way, because that verdict needs both
 * books and an index is built from one.
 */
/**
 * Whether this quality requires a recognizer before anything can be matched.
 *
 * SPARSE_LAYER joins SCANNED here: a page with no text on it cannot be matched
 * by reading text, whatever the few characters elsewhere in the book decode to.
 */
export function requiresRecognizer(quality) {
  return quality === TEXT_QUALITY.SCANNED
    || quality === TEXT_QUALITY.SPARSE_LAYER
    || quality === TEXT_QUALITY.BLANK
    || quality === TEXT_QUALITY.CORRUPT;
}

export function textMayBeComparable(quality) {
  return quality === TEXT_QUALITY.USABLE
    || quality === TEXT_QUALITY.DEGRADED
    || quality === TEXT_QUALITY.OPAQUE;
}

/**
 * Whether content similarity may be used as evidence at this quality.
 *
 * OPAQUE qualifies only once the caller has established that the other book
 * garbles identically — pass `crossBookComparable` from sharedAlphabetOverlap.
 * Defaulting it to false keeps the unverified case refusing.
 */
export function textIsComparable(quality, crossBookComparable = false) {
  if (quality === TEXT_QUALITY.USABLE || quality === TEXT_QUALITY.DEGRADED) return true;
  return quality === TEXT_QUALITY.OPAQUE && crossBookComparable === true;
}

/** Whether similarity may carry a match on its own, with no id agreement. */
export function textCanCarryMatch(quality) {
  return quality === TEXT_QUALITY.USABLE;
}
