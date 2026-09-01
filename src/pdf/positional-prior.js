// Where in the answer key should question k be?
//
// The last anchor available when there is no outline. Without one, a book whose
// numbering restarts each chapter has nothing to separate the six questions
// numbered 12, and the engine refuses all of them — measured recall zero.
//
// Both books list the same questions in the same order, so question k of N in
// the exercise book belongs near entry k·M/N of the key. This is the positional
// half of Gale–Church, applied to ordinal position instead of sentence length:
// no content is read, only counting.
//
// It accepts only when EXACTLY ONE candidate falls inside the window, so the
// alternatives are separated by position rather than ranked by it. That is not
// enough. OFF BY DEFAULT — measured:
//
//   books genuinely parallel        recall  0% -> 100%   precision 100%
//     10 questions absent from key  recall  0% ->  83%   precision 100%
//     8 extra entries in the key    recall  0% -> 100%   precision 100%
//   ── and where the books are not parallel ──
//     key's chapter 1 bloated 10x   21 matched, 17 wrong  precision  19%
//     key's chapters reversed      120 matched, 120 wrong precision   0%
//     key missing chapters 1-3      54 matched, 45 wrong  precision  17%
//
// Separation is not evidence of correctness: when the two books are scaled
// differently the window lands over the WRONG chapter's copy, and being alone
// in there makes it look unambiguous. Every one of those 120 reversed-chapter
// errors was returned at MEDIUM confidence.
//
// The engine's rule is that a wrong match is worse than no match, and a signal
// that cannot detect its own inapplicability cannot honour it. Enable this only
// for a corpus you have verified is parallel. Prefer content: resolving
// duplicates by similarity reaches 100% precision on all three failing cases
// above, because content does not care what order the books are in.

/**
 * How far from the expected position a genuine match may sit.
 *
 * The two books are never scaled identically — a key carries worked solutions
 * the exercise book does not, and either may omit questions — so the window has
 * to absorb real drift. Too tight and correct matches fall outside it; too loose
 * and both duplicates fit, which is not a failure but a refusal, so erring loose
 * costs recall rather than precision.
 */
const DEFAULT_TOLERANCE = 0.06;   // fraction of the answer index
const MIN_WINDOW = 4;             // entries, for short books

/**
 * The band of answer-entry ordinals where question `ordinal` is expected.
 *
 * @param {number} ordinal        position of the question in the exercise book
 * @param {number} questionCount  questions in the exercise book
 * @param {number} answerCount    entries in the answer key
 * @returns {{from: number, to: number, expected: number, halfWidth: number}|null}
 */
export function positionalWindow(ordinal, questionCount, answerCount, {
  tolerance = DEFAULT_TOLERANCE,
} = {}) {
  if (!Number.isFinite(ordinal) || ordinal < 0) return null;
  if (!(questionCount > 1) || !(answerCount > 0)) return null;

  const scaled = (ordinal * (answerCount - 1)) / (questionCount - 1);
  const expected = Math.round(scaled);
  const halfWidth = Math.max(MIN_WINDOW, Math.ceil(answerCount * tolerance));

  return {
    expected,
    halfWidth,
    from: Math.max(0, expected - halfWidth),
    to: Math.min(answerCount - 1, expected + halfWidth),
  };
}

/**
 * Picks the single candidate the position separates, or nothing.
 *
 * Returns null when the window contains none of them (the prior has no opinion)
 * and equally when it contains several (the prior cannot tell them apart). Both
 * are refusals. There is no "closest to expected" branch on purpose: choosing
 * the nearest of two plausible candidates is ranking, and a mis-scaled pair of
 * books would then produce a confident wrong answer on every duplicate in the
 * book rather than declining.
 *
 * @param {Array<{ordinal:number}>} candidates entries sharing a label
 * @param {{from:number,to:number}} window from positionalWindow
 * @returns {{entry: object, alternatives: number}|null}
 */
export function separateByPosition(candidates, window) {
  if (!window || !Array.isArray(candidates) || candidates.length === 0) return null;

  const inside = candidates.filter(c =>
    Number.isFinite(c?.ordinal) && c.ordinal >= window.from && c.ordinal <= window.to);

  if (inside.length !== 1) return null;
  return { entry: inside[0], alternatives: candidates.length - 1 };
}
