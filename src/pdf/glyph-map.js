// Recovering a broken font map by watching OCR read the same page.
//
// A PDF whose CJK ToUnicode map is broken extracts as a consistent substitution:
// one glyph always becomes the same wrong codepoint. That is a cipher with a
// key, and the key can be learned rather than worked around — OCR a page, line
// its output up against what the text layer said for that page, and read the
// substitutions off the difference.
//
// Why this beats OCRing the book:
//
//   Measured on the 2023 pair, ~20 pages of OCR observe enough distinct glyphs
//   to decode 80-90% of a 372-page book, permanently, including the pages never
//   looked at. The table belongs to the FONT, so a second book embedding the
//   same subset needs no OCR at all.
//
//   And the mathematics was never broken. Full-page OCR would re-recognise
//   formulas that already extract perfectly and would need a 198MB formula model
//   to do it badly; repairing the map fixes only the prose and leaves the
//   mathematics exactly as the PDF had it.
//
// The alignment anchors on what survives. Digits, Latin letters and operators
// come through the broken map untouched and appear identically in both strings,
// so they pin the two sequences together; the broken characters between two
// pinned anchors are what gets learned.
//
// One wrong entry poisons every page it touches, so learning is deliberately
// timid: a span is only read when both sides agree on how many characters it
// holds, a substitution is only accepted once it has been seen repeatedly and
// consistently, and a target that is not plausibly a real character is thrown
// away. Everything uncertain is discarded rather than guessed — the same rule
// the matcher follows.
//
// One thing it CANNOT check: that the two strings describe the same page. Hand
// it page 1's text layer with page 4's OCR output and it will align on the
// shared digits and learn confident nonsense. A single mispaired page is
// absorbed by the vote threshold, but a systematic mispairing is believed. Page
// correspondence belongs to the caller; nothing here can verify it.

/**
 * Characters the broken map does not touch.
 *
 * These are the alignment anchors. They are exactly the characters the quality
 * gate counts as "structured", for the same reason: a CJK mapping failure
 * cannot damage what was never mapped through the CJK font.
 */
const SURVIVES = /[0-9A-Za-z+\-*/=^_(){}[\]<>|∫∑∏√±×÷≤≥≠∞→]/;

/** What a recovered character is allowed to be: Han, or CJK punctuation. */
const PLAUSIBLE = /[㐀-䶿一-鿿　-〿！-･]/;

// Thresholds swept against the real ans2023 text with a known mapping applied,
// 80 pages, under two kinds of OCR error. Deletion is caught by the span-length
// check and costs nothing; SUBSTITUTION is length-preserving, slips past it, and
// is what these two numbers exist for:
//
//   OCR noise          minVotes 1      minVotes 3/0.8    agreement 0.9
//   4% del,  0% sub    100%  93.1%     100%  87.8%       100%  87.8%
//   4% del,  5% sub     95.9% 93.1%    100%  85.8%       100%  60.6%
//   4% del, 15% sub     94.3% 92.5%    100%  61.2%       100%  14.1%
//   2% del, 25% sub     91.2% 92.0%    100%  21.9%       100%   4.8%
//                      (precision, book coverage)
//
// One vote is not evidence — it leaks 14 to 29 wrong entries, and a wrong entry
// silently corrupts every page its glyph appears on. Raising agreement to 0.9
// buys no precision and collapses coverage. Three votes at 0.8 holds 100%
// precision across the whole range.
const DEFAULTS = Object.freeze({
  /** Times a substitution must be seen before it is believed. */
  minVotes: 3,
  /** Share of that glyph's votes the winner must hold. */
  minAgreement: 0.8,
  /** Anchors needed on a page before its spans are read at all. */
  minAnchors: 8,
  /** Longest unpinned span worth pairing; beyond this the order is a guess. */
  maxSpan: 24,
  /** Guard against a pathological page: LCS is O(n*m). */
  maxAnchorsPerPage: 3000,
});

const isSpace = (ch) => /\s/.test(ch);

/** Anchor characters and their positions. */
function anchorsOf(text, limit) {
  const out = [];
  for (let i = 0; i < text.length && out.length < limit; i++) {
    if (SURVIVES.test(text[i])) out.push({ ch: text[i], at: i });
  }
  return out;
}

/**
 * Longest common subsequence of two anchor sequences, as index pairs.
 *
 * The anchors are the only characters both strings agree on, so this is what
 * pins the alignment. OCR drops and inserts freely; an LCS tolerates both,
 * where a positional walk would desynchronise at the first difference and learn
 * hundreds of wrong pairs afterwards.
 */
function lcsAnchorPairs(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    const row = L[i];
    const prev = L[i - 1];
    for (let j = 1; j <= m; j++) {
      row[j] = a[i - 1].ch === b[j - 1].ch
        ? prev[j - 1] + 1
        : Math.max(prev[j], row[j - 1]);
    }
  }

  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1].ch === b[j - 1].ch) {
      pairs.push([a[i - 1].at, b[j - 1].at]);
      i--; j--;
    } else if (L[i - 1][j] >= L[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

/** Non-anchor, non-space characters of text[from..to), with positions. */
function brokenBetween(text, from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (isSpace(ch) || SURVIVES.test(ch)) continue;
    out.push(ch);
  }
  return out;
}

/**
 * Accumulates evidence across pages and produces a table when it is confident.
 *
 * Stateful on purpose: one page rarely shows a glyph often enough to be
 * believed, and the whole point is to pool ~20 pages into one table.
 */
export function createGlyphLearner(options = {}) {
  const config = { ...DEFAULTS, ...options };
  /** @type {Map<string, Map<string, number>>} garbled -> candidate -> votes */
  const votes = new Map();
  const stats = { pages: 0, spansRead: 0, spansSkipped: 0, pairsSeen: 0, rejected: 0 };

  /**
   * Reads one page: the text layer's version and OCR's version of the SAME page.
   * @returns {{spansRead: number, spansSkipped: number, pairs: number}}
   */
  function observe(corruptText, ocrText) {
    const corrupt = String(corruptText ?? '');
    const ocr = String(ocrText ?? '');
    stats.pages++;

    const ca = anchorsOf(corrupt, config.maxAnchorsPerPage);
    const oa = anchorsOf(ocr, config.maxAnchorsPerPage);
    if (ca.length < config.minAnchors || oa.length < config.minAnchors) {
      return { spansRead: 0, spansSkipped: 0, pairs: 0 };
    }

    const pinned = lcsAnchorPairs(ca, oa);
    if (pinned.length < config.minAnchors) {
      return { spansRead: 0, spansSkipped: 0, pairs: 0 };
    }

    let read = 0;
    let skipped = 0;
    let pairs = 0;

    // Only the spans BETWEEN two consecutive pins are safely bounded. The text
    // before the first pin and after the last is open-ended at one end, so its
    // contents cannot be paired positionally and is left alone.
    for (let k = 0; k + 1 < pinned.length; k++) {
      const [c0, o0] = pinned[k];
      const [c1, o1] = pinned[k + 1];
      const cSpan = brokenBetween(corrupt, c0 + 1, c1);
      const oSpan = brokenBetween(ocr, o0 + 1, o1);

      if (cSpan.length === 0 && oSpan.length === 0) continue;
      // Unequal spans mean OCR saw a different number of characters than the
      // text layer did. Which one dropped a character is unknowable from here,
      // so the whole span is discarded rather than paired off by one.
      if (cSpan.length !== oSpan.length
        || cSpan.length > config.maxSpan) {
        skipped++;
        stats.spansSkipped++;
        continue;
      }

      read++;
      stats.spansRead++;
      for (let t = 0; t < cSpan.length; t++) {
        const from = cSpan[t];
        const to = oSpan[t];
        // A glyph that decodes to something which is not a real character means
        // the alignment slipped, not that the font maps there.
        if (!PLAUSIBLE.test(to)) { stats.rejected++; continue; }
        // A character that survived cannot also be broken.
        if (SURVIVES.test(from)) { stats.rejected++; continue; }

        let bucket = votes.get(from);
        if (!bucket) { bucket = new Map(); votes.set(from, bucket); }
        bucket.set(to, (bucket.get(to) || 0) + 1);
        pairs++;
        stats.pairsSeen++;
      }
    }
    return { spansRead: read, spansSkipped: skipped, pairs };
  }

  /**
   * The substitutions confident enough to use.
   *
   * A glyph is only included when one candidate both clears `minVotes` and holds
   * `minAgreement` of that glyph's votes. Split evidence means the alignment
   * disagreed with itself, and a coin-flip entry would corrupt every page the
   * glyph appears on.
   */
  function table({ minVotes = config.minVotes, minAgreement = config.minAgreement } = {}) {
    const out = new Map();
    for (const [from, bucket] of votes) {
      let best = null;
      let bestCount = 0;
      let total = 0;
      for (const [to, n] of bucket) {
        total += n;
        if (n > bestCount) { best = to; bestCount = n; }
      }
      if (best === null || bestCount < minVotes) continue;
      if (bestCount / total < minAgreement) continue;
      out.set(from, best);
    }
    return out;
  }

  /** What the learner has seen, for deciding whether to OCR another page. */
  function progress() {
    const confident = table().size;
    return {
      ...stats,
      glyphsSeen: votes.size,
      glyphsConfident: confident,
      /** Glyphs seen but not yet believed — more pages would settle them. */
      glyphsPending: votes.size - confident,
    };
  }

  /** Vote detail for one glyph, for diagnosing a refusal. */
  function evidenceFor(ch) {
    const bucket = votes.get(ch);
    return bucket ? [...bucket.entries()].sort((a, b) => b[1] - a[1]) : [];
  }

  return { observe, table, progress, evidenceFor };
}

/**
 * Learns from a single page pair.
 *
 * A single page rarely shows a glyph three times, so this drops to one vote —
 * and one vote is measurably not enough: against OCR that substitutes 5% of
 * characters it admits wrong entries at ~4% (see the sweep above), and a wrong
 * entry corrupts every page its glyph appears on.
 *
 * Use it to inspect one page, or when the caller pools results itself. For
 * building a table to actually decode a book, use createGlyphLearner and feed it
 * pages — the votes are the entire safety mechanism.
 */
export function learnGlyphTable(corruptText, ocrText, options = {}) {
  const learner = createGlyphLearner({ minVotes: 1, minAgreement: 0.6, ...options });
  learner.observe(corruptText, ocrText);
  return { table: learner.table(), progress: learner.progress() };
}

/**
 * Applies a learned table.
 *
 * @param {Map<string,string>|object} table wrong codepoint -> real character
 * @returns {(text: string) => string}
 */
export function createGlyphRepair(table) {
  const map = table instanceof Map ? table : new Map(Object.entries(table ?? {}));
  if (map.size === 0) return (text) => String(text ?? '');
  return (text) => {
    let out = '';
    for (const ch of String(text ?? '')) out += map.get(ch) ?? ch;
    return out;
  };
}

/**
 * How much of a book a table would actually fix.
 *
 * Run before committing to building one, and again to decide when to stop
 * OCRing: a table covering 30% of the broken characters leaves the text no more
 * readable than before, and the honest answer is then page OCR.
 *
 * @returns {{covered: number, total: number, coverage: number, missing: string[]}}
 */
export function repairCoverage(lines, table) {
  const map = table instanceof Map ? table : new Map(Object.entries(table ?? {}));
  const counts = new Map();
  for (const line of lines ?? []) {
    for (const ch of String(line?.text ?? '')) {
      if (isSpace(ch) || SURVIVES.test(ch)) continue;   // never broken
      if (/[\x20-\x7E]/.test(ch)) continue;
      counts.set(ch, (counts.get(ch) || 0) + 1);
    }
  }
  let covered = 0;
  let total = 0;
  const missing = [];
  for (const [ch, n] of counts) {
    total += n;
    if (map.has(ch)) covered += n;
    else missing.push(ch);
  }
  // Most-frequent first: these are the pages worth OCRing next.
  missing.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
  return {
    covered,
    total,
    coverage: total === 0 ? 1 : Number((covered / total).toFixed(4)),
    missing: missing.slice(0, 50),
  };
}
