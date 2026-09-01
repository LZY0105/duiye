// PDF Module — aligning an exercise book with its answer key.
//
// Matching runs cheapest-signal-first, because the cheapest signal is also the
// strongest one this corpus offers:
//
//   Stage 0 (exact)   hierarchical question id from the bookmark tree. On the
//                     2023 set this alone resolves all 508 questions uniquely,
//                     with no content comparison at all.
//   Stage 1 (coarse)  outline/TOC alignment — narrows an exercise page to a
//                     region of the answer book, for books whose ids do not
//                     line up.
//   Stage 2 (fine)    content similarity within that region, combined with the
//                     question number.
//
// Stage 0 was previously absent: every lookup went straight to scoring, so the
// expensive comparison ran before anyone checked whether an exact id existed.
// It is not merely a speed-up — content scoring against these books' text layer
// is scoring against noise, so skipping it is also the more correct path.
//
// Numbers alone are not enough in general: answer books restart numbering per
// chapter, so a bare "12" is ambiguous across a whole book. Content alone is not
// enough either: an answer entry often gives only the result. Used together,
// each covers the other's blind spot — which is why the confidence a match
// reports is derived from how many signals agree, not from one score.
//
// Nothing here guesses silently. A match carries its confidence and its
// reasoning, and the UI is expected to show weak matches as weak.

import {
  compareIds,
  normalizeId,
  sameQuestionId,
} from './question-id.js';
import { classifyOutline } from './outline-classify.js';
import {
  PAIR_STATUS,
  RUNG,
  applyPairPermissions,
  capRung,
  rungForConfidence,
} from './decision.js';
import { locateAnswerRegion, sectionRangeForPage } from './region-locator.js';
import { FORMULA_POLICY, formulaCeiling } from './formula-set.js';
import { positionalWindow, separateByPosition } from './positional-prior.js';
import { symbolContextSimilarity } from './symbol-context.js';
import {
  TEXT_QUALITY,
  textCanCarryMatch,
  textIsComparable,
} from './text-quality.js';

/** How much the two documents' structure and content agree. */
export const CONFIDENCE = Object.freeze({
  /** Section aligned AND number matched AND content agrees. */
  HIGH: 'HIGH',
  /** Two signals agree — enough to show, worth labelling. */
  MEDIUM: 'MEDIUM',
  /** One weak signal. Shown only with a visible caution. */
  LOW: 'LOW',
  /** Nothing credible. Never shown as an answer. */
  NONE: 'NONE',
});

// ── text normalisation ──────────────────────────────────────────────────────

/**
 * Reduces a line to comparable content.
 *
 * Formatting differs between a question and its answer entry — spacing,
 * full-width punctuation, LaTeX spelling of the same symbol — while the
 * mathematical content is the point.
 *
 * Brackets are CANONICALISED, not deleted. Deleting them made 1/(x+1) and
 * 1/x+1 the same string, which is not a formatting difference but a different
 * function; any pair of questions differing only in grouping scored as
 * identical. Full-width and LaTeX bracket spellings still fold together,
 * because those genuinely are the same expression written two ways.
 */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\\(left|right|,|;|:|!|quad|qquad)/g, '')
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/[［【]/g, '[').replace(/[］】]/g, ']')
    .replace(/[｛]/g, '{').replace(/[｝]/g, '}')
    // Sentence punctuation only — it is the least reliable part of an extracted
    // line, and unlike brackets it carries no mathematical structure.
    .replace(/[，,。.、；;：:？?！!"'“”‘’]/g, '')
    .replace(/[－−–—]/g, '-')
    .replace(/[＝]/g, '=')
    .replace(/\s+/g, '')
    .trim();
}

/** Character bigrams; robust for mixed Chinese and mathematical text. */
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/**
 * Dice coefficient over character bigrams, 0..1.
 *
 * Chosen over exact or prefix matching because a question and its answer entry
 * usually share a distinctive fragment (the expression being solved) inside
 * otherwise different prose.
 */
export function similarity(a, b) {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;

  const ga = bigrams(x);
  const gb = bigrams(y);
  let shared = 0;
  for (const [g, count] of ga) {
    const other = gb.get(g);
    if (other) shared += Math.min(count, other);
  }
  const total = [...ga.values()].reduce((s, n) => s + n, 0)
    + [...gb.values()].reduce((s, n) => s + n, 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

// ── mathematical content ────────────────────────────────────────────────────

/**
 * Characters that carry mathematical meaning.
 *
 * Latin letters are included because they are variables here; Chinese
 * characters are not, because in this corpus they are prose.
 */
const MATH_CHAR = /[0-9a-zA-Z+\-*/=^_(){}[\]<>|.,\\∫∑∏√±×÷≤≥≠∞πθαβγλμσ]/;

/**
 * Pulls the mathematical fragments out of a question.
 *
 * The problem this solves: in a page of derivative exercises the prose is
 * nearly identical — 求函数…的导数 — so a whole-string similarity is dominated
 * by words that carry no distinguishing information, and two different
 * questions score almost the same. The mathematics is where the difference
 * actually lives.
 *
 * Runs are kept whole rather than reduced to a set of symbols, because a
 * fragment carries its own local context: "x^2+3x" and "x^3+5x" share every
 * individual symbol and differ only in how they are arranged.
 *
 * @returns {string[]} fragments, single characters discarded
 */
export function extractMathFragments(text) {
  const s = normalizeForMatch(text);
  const runs = [];
  let current = '';
  for (const ch of s) {
    if (MATH_CHAR.test(ch)) current += ch;
    else { if (current) runs.push(current); current = ''; }
  }
  if (current) runs.push(current);
  // A lone digit or letter is as likely to be a page number or a list marker
  // as it is to be mathematics.
  return runs.filter(r => r.length >= 2);
}

/** Similarity over mathematical content only. */
export function mathSimilarity(a, b) {
  const fa = extractMathFragments(a).join(' ');
  const fb = extractMathFragments(b).join(' ');
  if (!fa || !fb) return null;   // nothing mathematical to compare
  return similarity(fa, fb);
}

/**
 * How much the mathematics outweighs the surrounding words.
 *
 * 0.75 keeps prose meaningful as a tie-breaker while letting a clear
 * difference in the expression decide on its own.
 */
const MATH_WEIGHT = 0.75;

/**
 * How much of the mathematical signal comes from operator context rather than
 * from the bag of fragment bigrams.
 *
 * Context is the sharper of the two — it widens the worst-case margin between a
 * correct and a wrong candidate from 0.160 to 0.500 on the near-identical pairs
 * this engine exists to separate. It does not replace the bigram signal
 * outright: bigrams still catch a difference that sits away from any operator,
 * such as a renamed function or a changed interval.
 */
const SYMBOL_SHARE = 0.6;

/**
 * Similarity weighted toward the mathematics.
 *
 * Prose still contributes — it distinguishes "求导数" from "求积分" when the
 * expression is identical — but it cannot outvote the expression itself. When
 * a text has no mathematics at all, this degrades to plain similarity rather
 * than scoring zero.
 */
export function contentSimilarity(a, b) {
  const prose = similarity(a, b);
  const fragments = mathSimilarity(a, b);
  if (fragments === null) return prose;

  // Measured on the same normalised strings the rest of the scoring sees.
  const contexts = symbolContextSimilarity(normalizeForMatch(a), normalizeForMatch(b));
  const math = contexts === null
    ? fragments
    : SYMBOL_SHARE * contexts + (1 - SYMBOL_SHARE) * fragments;

  return MATH_WEIGHT * math + (1 - MATH_WEIGHT) * prose;
}

// ── stage 0/1: outline alignment ────────────────────────────────────────────

const SECTION_THRESHOLD = 0.45;

/**
 * Splits an outline into question bookmarks and section headings.
 *
 * Delegates to the structural classifier. The rule this replaced — "id-bearing
 * nodes at the deepest depth are the questions" — is correct only while the
 * question level is present. On a book whose question bookmarks are absent the
 * deepest surviving level IS the section level, and every section was promoted
 * into the question index: 18 sections became 18 questions and produced 479
 * accepted matches at HIGH confidence, all wrong. See src/outline-classify.js.
 */
function partitionOutline(outline, numPages) {
  const classified = classifyOutline(outline, { numPages });
  return {
    questions: classified.questions,
    sections: classified.sections,
    cohorts: classified.cohorts,
    hasQuestionLevel: classified.hasQuestionLevel,
  };
}

/**
 * Monotonic best-effort pairing of two title sequences at one depth.
 *
 * Needleman-Wunsch rather than greedy best-first. Greedy could pair chapter 5
 * with chapter 2's answers whenever the titles happened to score higher, which
 * produces a page range that excludes the right answer entirely and does so
 * with no visible symptom. Sections cannot cross; enforcing that structurally
 * costs nothing at these sizes.
 */
function alignTitlesMonotonic(exercises, answers, threshold) {
  const n = exercises.length;
  const m = answers.length;
  if (n === 0 || m === 0) return [];

  const GAP = -0.05;
  const score = Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => similarity(exercises[i].title, answers[j].title)));

  const F = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) F[i][0] = F[i - 1][0] + GAP;
  for (let j = 1; j <= m; j++) F[0][j] = F[0][j - 1] + GAP;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = score[i - 1][j - 1];
      const diagonal = s >= threshold ? F[i - 1][j - 1] + s : -Infinity;
      F[i][j] = Math.max(diagonal, F[i - 1][j] + GAP, F[i][j - 1] + GAP);
    }
  }

  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = score[i - 1][j - 1];
    const diagonal = s >= threshold ? F[i - 1][j - 1] + s : -Infinity;
    if (F[i][j] === diagonal) {
      pairs.push({ exercise: exercises[i - 1], answer: answers[j - 1], score: s });
      i--; j--;
    } else if (F[i][j] === F[i - 1][j] + GAP) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

/**
 * Pairs sections of an exercise book with sections of its answer key, and maps
 * question ids across the two bookmark trees.
 *
 * Two things the previous version did not do:
 *
 *   Depth is respected. Section headings and question bookmarks were previously
 *   pooled together, so "1.1 极限与连续函数" and "例题 1.1" competed for the same
 *   partner on title similarity — and the question, being shorter, often won.
 *   They are now aligned within their own level and never against each other.
 *
 *   Question ids are matched exactly. Where both books carry a bookmark for
 *   例题 1.31, no similarity is involved at all: the id IS the correspondence.
 *
 * @returns {{pairs, unmatched, available, questionIds: Map, questionIdsAvailable: boolean}}
 */
export function alignOutlines(exerciseOutline, answerOutline, {
  threshold = SECTION_THRESHOLD,
  exercisePageCount,
  answerPageCount,
} = {}) {
  const empty = {
    pairs: [],
    unmatched: [],
    available: false,
    questionIds: new Map(),
    questionIdsAvailable: false,
    exerciseHasQuestionLevel: false,
    answerHasQuestionLevel: false,
    cohorts: { exercise: [], answer: [] },
  };
  if (!exerciseOutline?.available || !answerOutline?.available) return empty;

  const ex = partitionOutline(exerciseOutline, exercisePageCount);
  const an = partitionOutline(answerOutline, answerPageCount);
  if (ex.questions.length + ex.sections.length === 0) return empty;
  if (an.questions.length + an.sections.length === 0) return empty;

  // ── exact id correspondence, the primary signal ──
  const answersById = new Map();
  for (const item of an.questions) {
    if (!item.questionId) continue;
    const bucket = answersById.get(item.questionId);
    if (bucket) bucket.push(item);
    else answersById.set(item.questionId, [item]);
  }
  const questionIds = new Map();
  for (const item of ex.questions) {
    if (!item.questionId) continue;
    const hits = answersById.get(item.questionId);
    // A repeated id in the key is not a correspondence — it is exactly the
    // ambiguity this engine refuses to resolve by guessing.
    if (hits && hits.length === 1) {
      questionIds.set(item.questionId, { exercise: item, answer: hits[0] });
    }
  }

  // ── section correspondence, per depth, monotonic ──
  const depths = [...new Set(ex.sections.map(s => s.depth ?? 0))].sort((a, b) => a - b);
  const pairs = [];
  for (const depth of depths) {
    const exAtDepth = ex.sections.filter(s => (s.depth ?? 0) === depth);
    const anAtDepth = an.sections.filter(s => (s.depth ?? 0) === depth);
    pairs.push(...alignTitlesMonotonic(exAtDepth, anAtDepth, threshold));
  }

  const used = new Set(pairs.map(p => p.exercise));
  return {
    pairs,
    unmatched: ex.sections.filter(s => !used.has(s)),
    available: pairs.length > 0,
    questionIds,
    questionIdsAvailable: questionIds.size > 0,
    // Whether each book actually carries a question level. A book with sections
    // only can still anchor a LOCATED region, which is why the section
    // alignment above is computed even when no question ids exist at all.
    exerciseHasQuestionLevel: ex.hasQuestionLevel,
    answerHasQuestionLevel: an.hasQuestionLevel,
    cohorts: { exercise: ex.cohorts, answer: an.cohorts },
  };
}

/**
 * The answer-book page range for ONE question.
 *
 * This is the per-question replacement for the old per-page range. A page
 * carrying six questions used to yield a single range for all six, computed
 * from whichever section contained the page — so on a shared page the last
 * question's range silently governed the first question's search, and a
 * question whose answer sat outside that range could never be found.
 *
 * An exact id correspondence gives the tightest possible range: the answer
 * bookmark's own span. Everything else falls back to the containing section.
 *
 * @returns {{from, to, exact: boolean, section: object|null}|null}
 */
export function answerRangeForQuestion(alignment, question, answerPageCount) {
  if (!alignment) return null;

  const id = normalizeId(question?.label ?? question?.id ?? '');
  const exact = id && alignment.questionIds?.get(id);
  if (exact) {
    const from = exact.answer.pageNumber;
    const to = exact.answer.endPage ?? exact.answer.pageNumber;
    return {
      from,
      to: Math.max(from, Math.min(to, answerPageCount || to)),
      exact: true,
      section: null,
      answerBookmark: exact.answer,
    };
  }

  const page = question?.page;
  if (!Number.isFinite(page)) return null;
  const section = sectionRangeForPage(alignment, page, answerPageCount);
  return section ? { ...section, exact: false } : null;
}

/**
 * The answer-book page range corresponding to an exercise PAGE.
 *
 * Retained for callers that have a page and no question. Prefer
 * answerRangeForQuestion: a page-level range cannot distinguish between the
 * questions sharing that page.
 */
export function answerRangeForPage(alignment, exercisePage, answerPageCount) {
  const range = sectionRangeForPage(alignment, exercisePage, answerPageCount);
  return range ? { ...range, exact: false } : null;
}

// sectionRangeForPage now lives in src/region-locator.js and is re-exported
// below, so a caller that wants a region without wanting a match can ask for one.
export { locateAnswerRegion, sectionRangeForPage, describeRegion } from './region-locator.js';

// ── stage 2: content matching ───────────────────────────────────────────────

const SIMILARITY_STRONG = 0.55;
const SIMILARITY_WEAK = 0.3;

/**
 * Finds the answer entry for one question.
 *
 * Order of work matters here. A unique exact id short-circuits before any
 * similarity is computed — that is both the fastest path and, on a book whose
 * text layer is broken, the only trustworthy one. Similarity is reached only
 * when the id is duplicated or absent, and it is refused outright when the
 * quality gate says the text cannot support a comparison.
 *
 * @param {{label?: string, text: string}} question
 * @param {Array} candidates answer entries, ideally already narrowed
 * @param {{sectionAligned?: boolean, exactId?: boolean, textQuality?: string}} context
 */
export function matchQuestion(question, candidates, {
  sectionAligned = false,
  exactId = false,
  exactReason = null,
  textQuality = TEXT_QUALITY.USABLE,
  crossBookComparable = false,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { matched: false, confidence: CONFIDENCE.NONE, reason: '答案册中没有可比对的条目' };
  }

  const wanted = normalizeId(question.label);
  const byLabel = wanted
    ? candidates.filter(entry => sameQuestionId(entry.label, wanted))
    : [];

  // ── stage 0: a unique exact id needs no content at all ──
  if (byLabel.length === 1 && exactId) {
    return {
      matched: true,
      confidence: CONFIDENCE.HIGH,
      reason: exactReason ?? '书签题号唯一对应',
      entry: byLabel[0].entry ?? byLabel[0],
      labelMatched: true,
      similarity: null,
      // Resolved by structure — a bookmark id, or a printed-contents location
      // corroborated by the body. Recorded so the arbiter can tell this apart
      // from a match that content had to argue for.
      structuralId: true,
    };
  }

  const comparable = textIsComparable(textQuality, crossBookComparable);
  const scored = candidates.map((entry) => ({
    entry,
    labelMatches: !!wanted && sameQuestionId(entry.label, wanted),
    textScore: comparable ? contentSimilarity(question.text, entry.text) : 0,
  }));

  const labelHits = scored.filter(s => s.labelMatches);

  if (labelHits.length === 1) {
    const hit = labelHits[0];
    if (comparable && hit.textScore >= SIMILARITY_WEAK) {
      return result(hit, sectionAligned ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
        sectionAligned ? '题号与题目内容一致，且章节已对齐' : '题号与题目内容一致');
    }
    return result(hit, sectionAligned ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
      sectionAligned ? '章节内题号唯一' : '题号匹配，但未按章节对齐');
  }

  if (labelHits.length > 1) {
    // Same number several times. Content is the only tie-breaker, and it is not
    // available when the text layer is untrustworthy — so this refuses instead.
    if (comparable) {
      const ranked = [...labelHits].sort((a, b) => b.textScore - a.textScore);
      if (ranked[0].textScore >= SIMILARITY_STRONG
        && ranked[0].textScore - (ranked[1]?.textScore ?? 0) > 0.15) {
        return result(ranked[0], CONFIDENCE.MEDIUM, '题号重复，由题目内容确定');
      }
    }
    return refuse(
      `答案册中有 ${labelHits.length} 个第 ${wanted} 题，无法确定`,
      labelHits.map(s => s.entry),
    );
  }

  // ── no id agreement: content alone, and only when it can carry a match ──
  if (!comparable) {
    return refuse('题号不匹配，且文本层不可用，无法用内容比对', candidates);
  }
  if (!textCanCarryMatch(textQuality)) {
    return refuse('题号不匹配，文本层质量不足以单独支撑匹配', candidates);
  }

  const best = [...scored].sort((a, b) => b.textScore - a.textScore)[0];
  if (best && best.textScore >= SIMILARITY_STRONG) {
    const runnerUp = scored.filter(s => s !== best)
      .reduce((m, s) => Math.max(m, s.textScore), 0);
    if (best.textScore - runnerUp > 0.12) {
      return result(best, CONFIDENCE.MEDIUM, '题目内容高度相似');
    }
    return result(best, CONFIDENCE.LOW, '题目内容相似，但有其他相近条目');
  }

  return refuse('没有找到足够相似的题目', []);
}

function result(scored, confidence, reason) {
  return {
    matched: true,
    confidence,
    reason,
    entry: scored.entry,
    labelMatched: scored.labelMatches,
    similarity: Number(scored.textScore.toFixed(3)),
  };
}

/**
 * An abstention that keeps its evidence.
 *
 * Candidate ids, pages and the reason are all preserved: a refusal that
 * discards what it saw forces the next stage — or the user — to rediscover it.
 */
function refuse(reason, candidates) {
  const list = candidates ?? [];
  return {
    matched: false,
    confidence: CONFIDENCE.NONE,
    reason,
    candidates: list,
    candidateIds: list.map(e => e?.id ?? null),
    candidateLabels: list.map(e => e?.label ?? null),
    candidatePages: list.map(e => e?.page ?? null),
  };
}

// ── monotonic alignment ─────────────────────────────────────────────────────

/** Cost of leaving a question or an answer entry unpaired. */
const GAP_PENALTY = -0.18;
/** Added to a pair's score when the question ids agree. */
const LABEL_BONUS = 0.45;
/** Below this a pairing is worth less than simply leaving a gap. */
const MIN_PAIR_SCORE = 0.12;

/** Ceilings that keep a pathological document from hanging the UI thread. */
export const ALIGN_LIMITS = Object.freeze({
  /** Answer entries considered for one page of questions. */
  maxCandidates: 400,
  /** |i - j| beyond this is not a plausible alignment of ordered material. */
  band: 64,
  /** Wall-clock ceiling for one page's alignment. */
  timeoutMs: 1500,
});

function pairScore(question, entry, comparable) {
  const content = comparable ? contentSimilarity(question.text, entry.text) : 0;
  return content + (sameQuestionId(question.label, entry.label) ? LABEL_BONUS : 0);
}

/**
 * Aligns a page's questions to answer entries, preserving order.
 *
 * Needleman-Wunsch over the two sequences, which adds the one property scoring
 * each question independently cannot provide: MONOTONICITY. Questions appear in
 * the same order in both books, so an alignment that crosses — question 3 to
 * answer 7 while question 4 takes answer 2 — is structurally impossible, and
 * two questions can never claim the same answer.
 *
 * The practical gain is positional support. When Q4→A4 and Q6→A6 are both
 * strong, Q5→A5 follows from position even if its own content score is weak.
 *
 * Gaps are modelled rather than forced: a question with no answer in the book,
 * or an answer with no question on this page, stays unpaired instead of
 * dragging a wrong partner into the alignment.
 *
 * Bounded three ways — candidate count, a diagonal band, and a deadline — so an
 * unaligned 500-page key cannot turn one page-turn into a multi-second stall.
 * Exceeding the deadline reports `timedOut` rather than returning the partial
 * table's answer, which would be an arbitrary alignment wearing a real one's
 * clothes.
 *
 * @returns {{assignments: Array, timedOut: boolean, truncated: boolean}}
 */
export function alignSequences(questions, entries, {
  comparable = true,
  band = ALIGN_LIMITS.band,
  timeoutMs = ALIGN_LIMITS.timeoutMs,
  maxCandidates = ALIGN_LIMITS.maxCandidates,
  signal = null,
  now = () => Date.now(),
} = {}) {
  const n = questions.length;
  const truncated = entries.length > maxCandidates;
  const pool = truncated ? entries.slice(0, maxCandidates) : entries;
  const m = pool.length;

  const none = () => questions.map((_, i) => ({ questionIndex: i, entryIndex: null, score: 0 }));
  if (n === 0 || m === 0) {
    return { assignments: none(), timedOut: false, truncated };
  }

  const deadline = now() + timeoutMs;
  const width = Math.max(band, Math.abs(n - m) + 1);

  // F[i][j] = best score aligning the first i questions with the first j entries.
  const F = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(-Infinity));
  F[0][0] = 0;
  for (let i = 1; i <= n; i++) F[i][0] = F[i - 1][0] + GAP_PENALTY;
  for (let j = 1; j <= m; j++) F[0][j] = F[0][j - 1] + GAP_PENALTY;

  const score = Array.from({ length: n }, () => new Float64Array(m).fill(NaN));
  const scoreAt = (i, j) => {
    const cached = score[i][j];
    if (!Number.isNaN(cached)) return cached;
    const value = pairScore(questions[i], pool[j], comparable);
    score[i][j] = value;
    return value;
  };

  for (let i = 1; i <= n; i++) {
    if (signal?.aborted) return { assignments: none(), timedOut: true, truncated };
    if (now() > deadline) return { assignments: none(), timedOut: true, truncated };

    const lo = Math.max(1, i - width);
    const hi = Math.min(m, i + width);
    for (let j = lo; j <= hi; j++) {
      const s = scoreAt(i - 1, j - 1);
      // A pairing too weak to be worth making is excluded outright, so the
      // optimum cannot be reached by accumulating meaningless matches.
      const diagonal = s >= MIN_PAIR_SCORE ? F[i - 1][j - 1] + s : -Infinity;
      F[i][j] = Math.max(diagonal, F[i - 1][j] + GAP_PENALTY, F[i][j - 1] + GAP_PENALTY);
    }
  }

  // Traceback, recovering the pairing that produced the optimum.
  const out = [];
  let i = n;
  let j = m;
  let guard = n + m + 2;
  while (i > 0 && guard-- > 0) {
    const inBand = j > 0 && Math.abs(i - j) <= width;
    const s = inBand ? scoreAt(i - 1, j - 1) : -Infinity;
    const diagonal = (inBand && s >= MIN_PAIR_SCORE) ? F[i - 1][j - 1] + s : -Infinity;
    if (inBand && F[i][j] === diagonal) {
      out.push({ questionIndex: i - 1, entryIndex: j - 1, score: s });
      i--; j--;
    } else if (F[i][j] === F[i - 1][j] + GAP_PENALTY) {
      out.push({ questionIndex: i - 1, entryIndex: null, score: 0 });
      i--;
    } else if (j > 0) {
      j--;
    } else {
      out.push({ questionIndex: i - 1, entryIndex: null, score: 0 });
      i--;
    }
  }
  return { assignments: out.reverse(), timedOut: false, truncated };
}

/**
 * Raises a weak match whose neighbours in the alignment are strong.
 *
 * Position is evidence the pair itself does not carry: sitting between two
 * confident matches is a reason to trust an uncertain one. Applied only one
 * step — a lone strong neighbour is not enough to vouch for a whole run of
 * guesses — and never across a refusal, whose whole point is that the position
 * is not established there.
 */
function applyPositionalSupport(matches) {
  const strong = matches.map(m =>
    m.matched && (m.confidence === CONFIDENCE.HIGH || m.confidence === CONFIDENCE.MEDIUM));
  return matches.map((m, i) => {
    if (m.confidence !== CONFIDENCE.LOW || !m.matched) return m;
    if (strong[i - 1] && strong[i + 1]) {
      return { ...m, confidence: CONFIDENCE.MEDIUM, reason: `${m.reason}；前后题目匹配可靠，按顺序推定` };
    }
    return m;
  });
}

/**
 * Matches every question on one exercise page.
 *
 * Each question gets its OWN candidate range. Previously one range was computed
 * for the page and shared by every question on it, which on a shared page meant
 * the questions after the first were searched in a window chosen for someone
 * else.
 *
 * Where the two bookmark trees agree on a question id, that question is
 * resolved directly and never enters the sequence alignment at all.
 */
/**
 * Candidates a reader can reasonably scan themselves.
 *
 * Above this the list stops being a shortlist and becomes a second search, so
 * the result falls back to a bounded region instead — one range to turn to beats
 * fifteen entries to compare.
 */
const MAX_REVIEW_CANDIDATES = 5;

/**
 * Assigns each result the strongest claim its evidence supports.
 *
 * This is the step that stops a failure to IDENTIFY from becoming a failure to
 * HELP. A refusal with a handful of candidates is a shortlist; a refusal with a
 * section alignment behind it is a page range; only a refusal with neither is
 * actually nothing. Measured on the real books, the regime where the answer key
 * has no bookmarks refuses 858 of 872 attempts while its section alignment is
 * intact the whole time — every one of those refusals had a region available and
 * no way to return it.
 *
 * The rung is a ceiling. Nothing here promotes a match: an entry that did not
 * earn HIGH does not become an answer because a region exists. It becomes a
 * region.
 */
function assignRungs(matches, {
  alignment, exercisePage, answerPageCount, pairStatus,
  formulaPolicy = FORMULA_POLICY.STRICT,
}) {
  return matches.map((match) => {
    if (!match) return match;

    const region = match.range ?? locateAnswerRegion(alignment, {
      exercisePage,
      answerPageCount,
      question: match.question,
    });

    let rung = rungForConfidence(match.confidence, match.matched);
    // A LOW band is one weak signal, and is a review candidate by construction.
    // Recording that here is what lets a host tell a reader the difference
    // between "not sure enough to show you this" and "found nothing at all".
    let cappedBy = (match.matched && match.confidence === 'LOW') ? 'LOW_CONFIDENCE' : null;
    let formula = null;

    // Mathematics gets a veto over what CONTENT argued for — not over structure.
    //
    // The evidence is always computed and always reported. Whether it may cap is
    // the measured part. On an outline-derived index an entry's text is the whole
    // page RANGE it spans, so it routinely contains its neighbours' material:
    // measured on the 2023 pair, question 1.255's extracted expressions belonged
    // to 1.254, and prose question 2.206's only "expression" was the fragment
    // 3×3a= scavenged from an adjoining question. Those two, and only those two
    // of 508, were vetoed — both wrongly, and both because the text attributed to
    // the question was not the question's.
    //
    // So a match resolved by a bookmark id, or by a printed-contents location the
    // body corroborates, is not overturned by formula evidence drawn from text
    // that structure itself says belongs to a page rather than to a question.
    // Everything content argued for still faces the veto, which is where the
    // decoys and the positional prior's 120 wrong answers are caught.
    // Evidence is drawn from the question's OWN text where that could be
    // bounded, and from the page range only as a fallback — an expression
    // scavenged from a neighbour is not this question's evidence.
    const qText = match.question?.scopedText || match.question?.text;
    const aText = match.entry?.scopedText || match.entry?.text;

    if (match.matched && qText && aText) {
      const verdict = formulaCeiling(qText, aText, { policy: formulaPolicy });
      formula = verdict.evidence;
      const exempt = formulaPolicy !== FORMULA_POLICY.STRICT && match.structuralId;
      if (verdict.ceiling && !exempt) {
        const capped = capRung(rung, verdict.ceiling, verdict.reason);
        rung = capped.rung;
        cappedBy = capped.cappedBy ?? cappedBy;
      } else if (verdict.ceiling) {
        formula = { ...verdict.evidence, notApplied: 'STRUCTURAL_ID' };
      }
    }

    if (!match.matched) {
      const candidates = match.candidates ?? [];
      if (candidates.length >= 1 && candidates.length <= MAX_REVIEW_CANDIDATES) {
        rung = RUNG.REVIEW;
        cappedBy = 'AMBIGUOUS_LABEL';
      } else if (region) {
        rung = RUNG.LOCATED;
        cappedBy = 'NO_QUESTION_LEVEL_INDEX';
      } else {
        rung = RUNG.REFUSED;
      }
    }

    const permitted = applyPairPermissions(rung, pairStatus, { hasRegion: !!region });
    return {
      ...match,
      rung: permitted.rung,
      cappedBy: permitted.cappedBy ?? cappedBy,
      region: region ?? null,
      formula,
      // matched means "the engine asserts this entry is the answer". Only
      // AUTO_MATCH asserts that. A REVIEW carrying matched=true is exactly how a
      // LOW-confidence guess reaches a reader as a final answer.
      matched: permitted.rung === RUNG.AUTO_MATCH,
      asserted: permitted.rung === RUNG.AUTO_MATCH,
    };
  });
}

export function matchPage(questions, answerIndex, {
  alignment,
  exercisePage,
  answerPageCount,
  // Whether the two books have been established to belong together.
  //
  // Defaults to VERIFIED_PAIR so this change does not silently alter what the
  // engine accepts. That default is WRONG for the product and must be flipped
  // once preparePair exists: an unverified pair reaching AUTO_MATCH is how the
  // cross-year mismatch produced 872 wrong HIGH acceptances. Tracked as the
  // Phase 0.5 pair gate.
  // Fail safe. A caller that has not established the pair may not be handed an
  // automatic answer, and the engine cannot tell an omission from an assertion.
  // MatchingEngine.preparePair supplies the real status; nothing else may.
  pairStatus = PAIR_STATUS.UNKNOWN_PAIR,
  formulaPolicy = FORMULA_POLICY.STRICT,
  limits = {},
  signal = null,
  // OFF by default, and measured: see src/positional-prior.js. On books that
  // are genuinely parallel it lifts no-outline recall from 0% to 83–100% at
  // 100% precision; on books that are not, precision collapses to 0–19%.
  usePositionalPrior = false,
  questionCount = null,
  // From sharedAlphabetOverlap(questionLines, answerLines). Unreadable OPAQUE
  // text is only evidence once both books are known to garble identically.
  crossBookComparable = false,
} = {}) {
  const entries = answerIndex?.entries ?? [];
  const textQuality = answerIndex?.quality ?? TEXT_QUALITY.USABLE;
  const comparable = textIsComparable(textQuality, crossBookComparable);
  const byLabel = answerIndex?.byLabel instanceof Map ? answerIndex.byLabel : null;

  const resolved = new Map();   // question index -> finished match
  const deferred = [];          // questions still needing the alignment

  questions.forEach((question, index) => {
    const range = answerRangeForQuestion(alignment, { ...question, page: question.page ?? exercisePage }, answerPageCount);

    // A label whose location the answer book's own printed contents confirms is
    // structurally established, exactly as a bookmark would be — two independent
    // readings of one document agreeing. It resolves here without any content
    // comparison, which on a book with no bookmark tree is the only place such a
    // resolution can come from.
    const structuralId = normalizeId(question.label);
    const structuralHits = structuralId
      ? (byLabel?.get(structuralId) ?? entries.filter(e => sameQuestionId(e.label, structuralId)))
      : [];
    if (!range?.exact && structuralHits.length === 1 && structuralHits[0].structural) {
      resolved.set(index, {
        question,
        ...matchQuestion(question, structuralHits, {
          sectionAligned: false,
          exactId: true,
          exactReason: '题号在答案册目录中唯一定位，且与正文一致',
          textQuality,
          crossBookComparable,
        }),
        range: { from: structuralHits[0].page, to: structuralHits[0].endPage ?? structuralHits[0].page, exact: true, section: null },
        alignmentScore: 1,
        section: null,
      });
      return;
    }

    if (range?.exact) {
      const id = normalizeId(question.label);
      const hits = byLabel?.get(id)
        ?? entries.filter(e => sameQuestionId(e.label, id));
      if (hits.length === 1) {
        resolved.set(index, {
          question,
          ...matchQuestion(question, hits, {
            sectionAligned: true,
            exactId: true,
            textQuality,
            crossBookComparable,
          }),
          range,
          alignmentScore: 1,
          section: null,
        });
        return;
      }
    }
    deferred.push({ question, index, range });
  });

  if (deferred.length > 0) {
    const pageRange = deferred[0].range ?? null;
    const pool = pageRange
      ? entries.filter(e => e.page >= pageRange.from && e.page <= pageRange.to)
      : entries;

    // Entries must be in book order for a monotonic alignment to mean anything.
    const ordered = [...pool].sort((a, b) =>
      (a.page - b.page) || compareIds(a.label, b.label));

    const { assignments, timedOut, truncated } = alignSequences(
      deferred.map(d => d.question),
      ordered,
      { comparable, signal, ...limits },
    );
    const byQuestion = new Map(assignments.map(a => [a.questionIndex, a]));

    deferred.forEach((item, slot) => {
      const { question, index, range } = item;
      if (timedOut) {
        resolved.set(index, {
          question,
          ...refuse('匹配超时，已中止而不是返回不完整的结果', []),
          range,
          alignmentScore: 0,
          section: range?.section ?? null,
          timedOut: true,
        });
        return;
      }

      const assignment = byQuestion.get(slot);
      const entry = assignment && assignment.entryIndex !== null
        ? ordered[assignment.entryIndex]
        : null;

      // Without a section alignment, a duplicated id must NOT be settled by the
      // sequence alignment. It always produces some assignment, and accepting
      // it would convert genuine ambiguity into a confident answer — the one
      // failure this engine exists to avoid.
      //
      // The positional prior is allowed one narrow exception, because it is not
      // a ranking: it accepts only when exactly ONE candidate falls inside the
      // expected band, i.e. when position SEPARATED the alternatives rather than
      // ordered them. Everything else still refuses.
      const id = normalizeId(question.label);
      const duplicated = id
        ? (byLabel?.get(id)?.length ?? entries.filter(e => sameQuestionId(e.label, id)).length) > 1
        : false;
      if (duplicated && !range) {
        const hits = byLabel?.get(id) ?? entries.filter(e => sameQuestionId(e.label, id));
        // questionCount is the whole book's question total, not this page's.
        // Without it the window cannot be placed, so the prior stays out of the
        // way rather than guessing at the scale — `questions.length` here would
        // be the page's handful and would put every window at the book's start.
        const separated = (usePositionalPrior && questionCount > 1)
          ? separateByPosition(hits, positionalWindow(
            question.ordinal, questionCount, entries.length))
          : null;

        if (separated) {
          resolved.set(index, {
            question,
            matched: true,
            confidence: CONFIDENCE.MEDIUM,
            reason: `题号在答案册中出现 ${hits.length} 次，由书中位置区分`,
            entry: separated.entry,
            labelMatched: true,
            similarity: null,
            range: null,
            alignmentScore: assignment?.score ?? 0,
            section: null,
            positional: true,
          });
          return;
        }

        // Content still gets its chance, against ALL the duplicates rather than
        // the single entry the alignment picked. matchQuestion accepts only when
        // one candidate is both strong and clearly ahead of the rest, so this
        // cannot resolve a tie — and it refuses outright when the text layer is
        // untrustworthy, which is when the duplicates are indistinguishable
        // anyway. Handing it one pre-chosen entry hid the ambiguity instead.
        const judgedDup = matchQuestion(question, hits, {
          sectionAligned: false,
          exactId: false,
          textQuality,
          crossBookComparable,
        });
        resolved.set(index, {
          question,
          ...judgedDup,
          range: null,
          alignmentScore: assignment?.score ?? 0,
          section: null,
        });
        return;
      }

      // The per-question rules still decide CONFIDENCE — the alignment decides
      // WHICH entry. Keeping those separate means the ordering constraint cannot
      // manufacture certainty the evidence does not support.
      const judged = matchQuestion(question, entry ? [entry] : [], {
        sectionAligned: !!range,
        exactId: false,
        textQuality,
        crossBookComparable,
      });

      resolved.set(index, {
        question,
        ...judged,
        range,
        alignmentScore: assignment?.score ?? 0,
        section: range?.section ?? null,
        truncated: truncated || undefined,
      });
    });
  }

  const matches = questions.map((_, index) => resolved.get(index));
  return assignRungs(applyPositionalSupport(matches), {
    alignment,
    exercisePage,
    answerPageCount,
    pairStatus,
    formulaPolicy,
  });
}
