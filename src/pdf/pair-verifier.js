// Do these two documents belong together, and which is which?
//
// The engine answered neither question. Measured over all 60 wrong-book and
// wrong-role combinations, 52 produced accepted results at HIGH confidence, and
// one representative full-book run — 2023 exercises against the 2025 answer key
// — returned 463 accepted matches, every one of them wrong. The eight
// combinations that produced nothing did so because their label spaces happen
// not to overlap, not because anything checked.
//
// Two separate questions, and they need different evidence:
//
//   IDENTITY   are these the same book?     year, subject, content anchors
//   ROLE       which one holds the answers? answer-language density
//
// Neither substitutes for the other, and the measurements say so plainly. An
// answer book matched against ITSELF scores a perfect 100% on content anchors,
// because it is genuinely the same content — identity cannot see the problem.
// Conversely a 2023 exercise book against a 2025 answer key has two answer-role
// documents' worth of correct role assignment and is still the wrong pair.
//
// ── measured separations ──
//
// Content anchors, share of sampled labels whose correct partner ranks first:
//
//   q2023 -> ans2023      75%      valid
//   a2024 -> a2024_ma     58%      valid
//   g2024 -> a2024_alg    71%      valid
//   q2023 -> a2025         0%      wrong year
//
// Year, modal 20xx across outline titles and sampled body text: correct for all
// eight documents at 93-100% agreement. A year conflict is a hard rejection.
//
// Role, over indexed entries:
//
//   document      answer-language   explicit answer
//   ans2023             99.8%            100.0%     ANSWER
//   a2024_ma           100.0%             98.9%     ANSWER
//   a2024_alg          100.0%             99.5%     ANSWER
//   a2025               98.8%            100.0%     ANSWER
//   q2023               76.0%             95.5%     exercise
//   a2024               91.9%             37.3%     exercise
//   g2024               93.1%             42.4%     exercise
//
// Both conditions are required. Each measure alone leaves a pair of documents
// within a couple of points of each other; together every answer book clears
// both and every exercise book fails at least one by a wide margin.
//
// ── what a failure means ──
//
// A conflict is a REJECTION. Missing evidence is not — it is UNKNOWN, which
// forbids AUTO_MATCH while still permitting REVIEW and LOCATED. That difference
// is what keeps a scanned book, whose content anchors cannot be sampled at all,
// a working document rather than a blocked one.

import { PAIR_STATUS } from './decision.js';
import { bindingMatches, fingerprintDocument } from './fingerprint.js';
import { contentSimilarity } from './question-matcher.js';
import { extractAnswer } from './answer-index.js';

/** Language that appears when a text is working a problem rather than posing one. */
const SOLUTION_LANGUAGE = /(答案|解答|解[：:]|证明|综上|因此|所以|故\s|得证|证毕|由此可得)/;

const THRESHOLDS = Object.freeze({
  /** Share of entries containing solution language for a document to be an answer key. */
  answerLanguage: 0.97,
  /** Share of entries yielding an explicit marked answer. */
  explicitAnswer: 0.97,
  /** Entries needed before role can be judged at all. */
  minEntriesForRole: 20,
  /**
   * Share of sampled labels whose correct partner must rank first.
   *
   * Valid pairs measure 58-75%; a wrong-year pair measures 0%. Forty sits in
   * the middle of that gap.
   */
  anchorTop1: 0.4,
  /** Labels sampled when testing content agreement. */
  anchorSample: 24,
  /** Shared labels needed before content agreement can be judged. */
  minSharedForAnchors: 8,
  /** Share of a document's 20xx mentions that must agree for a year to be claimed. */
  yearAgreement: 0.6,
});

export const ROLE = Object.freeze({
  EXERCISE: 'EXERCISE',
  ANSWER: 'ANSWER',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Whether a document reads as an answer key.
 *
 * Judged on indexed entries rather than raw lines. Raw-line density does not
 * separate the two roles at all on this corpus — measured, exercise books run
 * from 14 to 71 lines per page and answer books from 51 to 103, and the ranges
 * overlap. What separates them is whether the material attached to each QUESTION
 * works the problem.
 */
export function classifyRole(index) {
  const entries = (index?.entries ?? []).filter(e => e.text);
  if (entries.length < THRESHOLDS.minEntriesForRole) {
    return { role: ROLE.UNKNOWN, reason: 'too few indexed entries to judge', entries: entries.length };
  }

  const withLanguage = entries.filter(e => SOLUTION_LANGUAGE.test(e.text)).length / entries.length;
  const withAnswer = entries.filter(e => {
    const a = extractAnswer(e.text);
    return a && a.length > 0 && a !== e.text;
  }).length / entries.length;

  const isAnswer = withLanguage >= THRESHOLDS.answerLanguage
    && withAnswer >= THRESHOLDS.explicitAnswer;

  // "Not an answer key" and "cannot tell" are different verdicts, and only the
  // first may reject a pair.
  //
  // These thresholds were measured on OUTLINE-derived indexes, where the signal
  // is clean: answer books score 0.988-1.000 and exercise books 0.760-0.931. On
  // a body-parsed index the same books collapse together — with its bookmarks
  // stripped the 2024 answer key scores 0.725 and reads exactly like an exercise
  // book, because body parsing over-extracts and dilutes every ratio. Claiming
  // EXERCISE from that evidence would reject a perfectly valid pair for the sole
  // reason that one of its bookmark trees is missing.
  //
  // So a body index may CONFIRM an answer key (the thresholds are high enough to
  // be meaningful when met) but may never confirm the absence of one.
  // OUTLINE only. A CONTENTS index has had its LOCATIONS corroborated by the
  // printed table of contents, which says nothing about whether its TEXT is
  // clean — it is still body-parsed and still over-extracted (513 entries for
  // 508 answers on the 2023 key). Measured there: the answer book scores 0.969
  // against a 0.970 threshold and would be declared a confirmed exercise book,
  // rejecting a valid pair for the sole reason that one bookmark tree is gone.
  const structural = index?.source === 'OUTLINE';
  const role = isAnswer ? ROLE.ANSWER : (structural ? ROLE.EXERCISE : ROLE.UNKNOWN);

  return {
    role,
    answerLanguage: Number(withLanguage.toFixed(4)),
    explicitAnswer: Number(withAnswer.toFixed(4)),
    entries: entries.length,
    source: index?.source ?? null,
    reason: isAnswer ? 'entries work the problem'
      : (structural ? 'entries pose rather than solve' : 'body index cannot settle the role'),
  };
}

/** The modal 20xx in a document's outline titles and sampled body text. */
export function documentYear(doc, { sampleLines = 4000 } = {}) {
  const counts = new Map();
  const scan = (text) => {
    for (const m of String(text ?? '').matchAll(/20[0-9]{2}/g)) {
      counts.set(m[0], (counts.get(m[0]) || 0) + 1);
    }
  };
  const walk = (items) => {
    for (const item of items || []) { scan(item?.title); walk(item?.children); }
  };
  walk(doc?.outline?.items);
  for (const line of (doc?.lines ?? []).slice(0, sampleLines)) scan(line?.text);

  const total = [...counts.values()].reduce((s, n) => s + n, 0);
  if (total === 0) return { year: null, agreement: 0 };
  const [year, votes] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const agreement = votes / total;
  return agreement >= THRESHOLDS.yearAgreement
    ? { year, agreement: Number(agreement.toFixed(3)) }
    : { year: null, agreement: Number(agreement.toFixed(3)) };
}

const MATH_ANALYSIS = /(数学分析|微积分|极限|积分|导数|级数)/;
const ALGEBRA = /(高等代数|线性代数|矩阵|多项式|行列式|特征值|二次型)/;

/** Which subject a document is mostly about. */
export function documentSubject(doc, { sampleLines = 3000 } = {}) {
  let ma = 0;
  let alg = 0;
  const scan = (text) => {
    const s = String(text ?? '');
    if (MATH_ANALYSIS.test(s)) ma++;
    if (ALGEBRA.test(s)) alg++;
  };
  const walk = (items) => {
    for (const item of items || []) { scan(item?.title); walk(item?.children); }
  };
  walk(doc?.outline?.items);
  for (const line of (doc?.lines ?? []).slice(0, sampleLines)) scan(line?.text);

  if (ma > alg * 2) return { subject: 'MATH_ANALYSIS', ma, alg };
  if (alg > ma * 2) return { subject: 'ALGEBRA', ma, alg };
  return { subject: 'MIXED', ma, alg };
}

/**
 * How often the answer this pair claims for a label actually looks like its answer.
 *
 * The identity signal the architecture specifies, reusing the engine's own
 * similarity rather than a second scoring path: sample labels present in both
 * documents, score the exercise text against every candidate answer, and ask how
 * often the same-label answer ranks first. A valid pair reaches 58-75%; a pair
 * from the wrong year reaches 0%.
 */
export function contentAnchorAgreement(exerciseIndex, answerIndex, {
  sample = THRESHOLDS.anchorSample,
} = {}) {
  const answers = new Map();
  for (const e of answerIndex?.entries ?? []) {
    if (e.text && !answers.has(e.label)) answers.set(e.label, e);
  }
  const shared = (exerciseIndex?.entries ?? [])
    .filter(e => e.text && answers.has(e.label));

  if (shared.length < THRESHOLDS.minSharedForAnchors) {
    return { top1: null, sampled: 0, shared: shared.length, sufficient: false };
  }

  const pool = (answerIndex?.entries ?? []).filter(e => e.text);
  const step = Math.max(1, Math.floor(shared.length / sample));
  let first = 0;
  let sampled = 0;
  for (let i = 0; i < shared.length && sampled < sample; i += step) {
    const q = shared[i];
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of pool) {
      const s = contentSimilarity(q.text, candidate.text);
      if (s > bestScore) { bestScore = s; best = candidate; }
    }
    sampled++;
    if (best && best.label === q.label) first++;
  }

  return {
    top1: sampled ? Number((first / sampled).toFixed(3)) : null,
    sampled,
    shared: shared.length,
    sufficient: true,
  };
}

/**
 * The pair verdict.
 *
 * A CONFLICT rejects; MISSING EVIDENCE does not. That distinction is the whole
 * policy: rejecting on absent evidence would block every scanned book, whose
 * content anchors cannot be sampled at all, and blocking is not what safety
 * requires — withholding AUTO_MATCH is.
 *
 * @returns {{status, exerciseRole, answerRole, reasonCodes, evidence}}
 */
export function verifyPair({
  exerciseDoc, answerDoc, exerciseIndex, answerIndex, manualBinding = null,
} = {}) {
  const reasonCodes = [];

  const left = classifyRole(exerciseIndex);
  const right = classifyRole(answerIndex);

  const exYear = documentYear(exerciseDoc);
  const anYear = documentYear(answerDoc);
  const exSubject = documentSubject(exerciseDoc);
  const anSubject = documentSubject(answerDoc);

  const evidence = {
    exerciseRole: left,
    answerRole: right,
    year: { exercise: exYear, answer: anYear },
    subject: { exercise: exSubject, answer: anSubject },
    anchors: null,
    manualBinding: !!manualBinding,
  };

  const reject = (code) => {
    reasonCodes.push(code);
    return {
      status: PAIR_STATUS.REJECTED_PAIR,
      exerciseRole: left.role, answerRole: right.role, reasonCodes, evidence,
    };
  };

  // ── role, both sides ──
  //
  // Checked before identity because identity cannot see this class of error at
  // all: an answer book compared with itself agrees perfectly on content.
  // A CONFIRMED wrong role rejects. An unconfirmable one does not — it withholds
  // AUTO_MATCH via UNKNOWN_PAIR and leaves the pair working at the lower rungs.
  if (right.role === ROLE.EXERCISE) return reject('RIGHT_ROLE_INVALID');
  if (left.role === ROLE.ANSWER) return reject('LEFT_ROLE_INVALID');

  if (right.role === ROLE.UNKNOWN) {
    reasonCodes.push('PAIR_IDENTITY_UNKNOWN');
    return {
      status: PAIR_STATUS.UNKNOWN_PAIR,
      exerciseRole: left.role, answerRole: right.role, reasonCodes, evidence,
    };
  }

  // ── hard identity conflicts ──
  if (exYear.year && anYear.year && exYear.year !== anYear.year) {
    return reject('PAIR_IDENTITY_MISMATCH');
  }
  if (exSubject.subject !== 'MIXED' && anSubject.subject !== 'MIXED'
    && exSubject.subject !== anSubject.subject) {
    return reject('PAIR_IDENTITY_MISMATCH');
  }

  // ── positive identity evidence ──
  const anchors = contentAnchorAgreement(exerciseIndex, answerIndex);
  evidence.anchors = anchors;

  // Low content agreement rejects only when both sides were indexed from their
  // bookmark trees.
  //
  // The 40% threshold was measured on OUTLINE indexes, where valid pairs score
  // 58-75% and a wrong-year pair scores 0%. A body-parsed index does not behave
  // that way: it over-extracts by two to four times, so the correct partner has
  // to outrank thousands of spurious entries and legitimately falls below the
  // line. Measured, applying this test to a body index rejected the valid 2024
  // Mathematical Analysis pair outright the moment its exercise bookmarks were
  // removed — a valid pair refused for lack of a bookmark tree.
  //
  // Weak agreement from unreliable indexes is missing evidence, and missing
  // evidence is UNKNOWN, never REJECTED.
  const anchorsAreReliable = exerciseIndex?.source === 'OUTLINE'
    && answerIndex?.source === 'OUTLINE';

  /**
   * A binding is the user asserting a pairing the engine could not establish.
   *
   * It resolves ABSENCE of reliable evidence, and nothing else. Every hard
   * conflict — wrong role, wrong year, wrong subject, and weak content agreement
   * between two indexes good enough to be believed — has already returned above,
   * so a binding can never reach one. What remains is the case it exists for: a
   * scanned book whose identity simply cannot be checked, where the alternative
   * is refusing a pair the user is looking at.
   *
   * The binding must still name the documents it was made against. A stale one
   * confers nothing.
   */
  const useBinding = () => {
    if (!manualBinding) return null;
    const exFp = fingerprintDocument(exerciseDoc);
    const anFp = fingerprintDocument(answerDoc);
    const check = bindingMatches(manualBinding, exFp, anFp);
    evidence.binding = {
      checked: true,
      valid: check.valid,
      reason: check.reason,
      changed: check.changed,
      exercise: exFp.id,
      answer: anFp.id,
    };
    if (!check.valid) { reasonCodes.push(check.reason); return null; }
    reasonCodes.push('PAIR_BOUND_MANUALLY');
    return {
      status: PAIR_STATUS.VERIFIED_PAIR,
      exerciseRole: left.role, answerRole: right.role, reasonCodes, evidence,
    };
  };

  if (anchors.sufficient && anchors.top1 !== null
    && anchors.top1 < THRESHOLDS.anchorTop1) {
    // Two bookmark-derived indexes disagreeing on content is a contradiction,
    // and no binding overrides it.
    if (anchorsAreReliable) return reject('PAIR_IDENTITY_MISMATCH');
    const bound = useBinding();
    if (bound) return bound;
    reasonCodes.push('PAIR_IDENTITY_UNKNOWN');
    return {
      status: PAIR_STATUS.UNKNOWN_PAIR,
      exerciseRole: left.role, answerRole: right.role, reasonCodes, evidence,
    };
  }

  if (!anchors.sufficient) {
    // Not enough shared, readable material to confirm.
    const bound = useBinding();
    if (bound) return bound;
    reasonCodes.push('PAIR_IDENTITY_UNKNOWN');
    return {
      status: PAIR_STATUS.UNKNOWN_PAIR,
      exerciseRole: left.role, answerRole: right.role, reasonCodes, evidence,
    };
  }

  return {
    status: PAIR_STATUS.VERIFIED_PAIR,
    exerciseRole: left.role, answerRole: right.role, reasonCodes, evidence,
  };
}
