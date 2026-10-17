// Which pages of the answer key does this exercise page correspond to?
//
// The cheapest useful thing the engine can say, and for a long time it had no
// way to say it. When a question cannot be identified, the section alignment
// usually still knows which chapter of the answer key the reader is in — that is
// a bounded page range, and for someone holding a paper answer key it is most of
// what they needed.
//
// Measured on the real books: with the answer key's question bookmarks removed,
// 858 of 872 attempts refuse and 8 distinct questions resolve. The section
// alignment those runs discard is unaffected by the missing question level,
// because it is computed from chapter titles.
//
// This module never identifies a question. It bounds a region and says what the
// bound rests on. A region that does not contain the answer is still an error —
// it costs the reader some page turns — so `basis` records what produced it and
// the caller is expected to measure located precision separately from match
// precision, never to fold one into the other.

/** What a located region was derived from. Governs how far it can be trusted. */
export const REGION_BASIS = Object.freeze({
  /** An exact question-id correspondence between the two bookmark trees. */
  EXACT_ID: 'EXACT_ID',
  /** An aligned section pair: this chapter here maps to that chapter there. */
  SECTION_ALIGNMENT: 'SECTION_ALIGNMENT',
  /** The containing chapter of the answer key, with no finer structure. */
  CHAPTER: 'CHAPTER',
});

/**
 * The alignment's usable pairs in exercise-page order, computed once per
 * alignment. This is asked for once per question on every page turn, and the
 * alignment does not change between calls.
 */
const sortedPairsCache = new WeakMap();
function sortedPairs(alignment) {
  let sorted = sortedPairsCache.get(alignment);
  if (!sorted) {
    sorted = [...(alignment.pairs ?? [])]
      .filter(p => p.exercise?.pageNumber && p.answer?.pageNumber)
      .sort((a, b) => a.exercise.pageNumber - b.exercise.pageNumber);
    sortedPairsCache.set(alignment, sorted);
  }
  return sorted;
}

/**
 * The answer-book page range for one exercise page, from the section alignment.
 *
 * The aligned pairs are sorted by exercise page and the last pair at or before
 * the requested page wins. The range then runs to the page before the next pair
 * that starts LATER in the answer book — "later" rather than "next", because two
 * exercise sections can map into the same answer section and the naive next-pair
 * rule would produce an empty range for the first of them.
 *
 * @returns {{from, to, section, basis, sectionPath}|null}
 */
export function sectionRangeForPage(alignment, exercisePage, answerPageCount) {
  if (!alignment?.available) return null;
  if (!Number.isFinite(exercisePage)) return null;

  const sorted = sortedPairs(alignment);
  if (sorted.length === 0) return null;

  // The page must fall INSIDE an aligned exercise section, and the tightest
  // such section wins. The previous rule took the last aligned section starting
  // at or before the page, with no upper bound — so three sections a wrong book
  // happened to share with this one located 91 of 96 sampled pages of it.
  // Measured on the 2026-09 textbook corpus: 陈纪修 against a 近世代数
  // textbook aligned "1 集合" and "2 映射与函数" and nothing else, and pages
  // three hundred further on were still "located" through them.
  let chosen = null;
  for (const pair of sorted) {
    const from = pair.exercise.pageNumber;
    const to = Number.isFinite(pair.exercise.endPage) ? pair.exercise.endPage : Infinity;
    if (exercisePage < from || exercisePage > to) continue;
    if (!chosen || (pair.exercise.depth ?? 0) >= (chosen.exercise.depth ?? 0)) chosen = pair;
  }
  if (!chosen) return null;
  const index = sorted.indexOf(chosen);
  const answerStart = chosen.answer.pageNumber;
  // The answer side's own span, when the classifier measured one: a chapter
  // runs to the next chapter, not to its first section. The next-pair rule
  // below cut a chapter-level range at the first aligned section inside it —
  // on the 2023 pair that left "第一章" covering pages 19-59 of a chapter
  // running to 210, and every question in a section the alignment had missed
  // fell outside the range that was supposed to be its fallback.
  const ownEnd = Number.isFinite(chosen.answer.endPage) ? chosen.answer.endPage : null;
  // Failing that, the next aligned section at the same or a shallower depth on
  // the answer side — a chapter's range must not stop at its own first section.
  const depth = chosen.answer.depth ?? 0;
  const next = sorted.slice(index + 1).find(p =>
    p.answer.pageNumber > answerStart && (p.answer.depth ?? 0) <= depth);
  const answerEnd = ownEnd ?? (next ? next.answer.pageNumber - 1 : (answerPageCount || answerStart));

  return {
    from: answerStart,
    to: Math.max(answerStart, answerEnd),
    section: chosen,
    basis: REGION_BASIS.SECTION_ALIGNMENT,
    sectionPath: chosen.exercise.sectionPath ?? [],
    exerciseSection: chosen.exercise.title ?? null,
    answerSection: chosen.answer.title ?? null,
    score: chosen.score ?? null,
  };
}

/**
 * The best region available for one exercise page, whatever evidence exists.
 *
 * Tried strongest first. Returns null only when the engine genuinely has no idea
 * where in the answer key to look — which, once section classification is
 * correct, is rarer than the old refusal rate suggested.
 *
 * @param {object} alignment    from alignOutlines
 * @param {object} options
 * @param {number} options.exercisePage
 * @param {number} options.answerPageCount
 * @param {object} [options.question]  when known, its exact-id range is preferred
 * @returns {{from, to, basis, ...}|null}
 */
export function locateAnswerRegion(alignment, {
  exercisePage,
  answerPageCount,
  question = null,
} = {}) {
  if (!alignment) return null;

  // An exact id correspondence bounds the region to one answer bookmark's own
  // span, which is as tight as this can get without identifying anything.
  if (question) {
    const exact = exactRegionForQuestion(alignment, question, answerPageCount);
    if (exact) return exact;
  }

  const page = Number.isFinite(question?.page) ? question.page : exercisePage;
  return sectionRangeForPage(alignment, page, answerPageCount);
}

function exactRegionForQuestion(alignment, question, answerPageCount) {
  const id = question?.label ?? question?.id ?? null;
  if (!id || !(alignment.questionIds instanceof Map)) return null;
  const hit = alignment.questionIds.get(String(id));
  if (!hit?.answer?.pageNumber) return null;

  const from = hit.answer.pageNumber;
  const to = hit.answer.endPage ?? hit.answer.pageNumber;
  return {
    from,
    to: Math.max(from, Math.min(to, answerPageCount || to)),
    basis: REGION_BASIS.EXACT_ID,
    section: null,
    sectionPath: hit.exercise?.sectionPath ?? [],
    exerciseSection: hit.exercise?.title ?? null,
    answerSection: hit.answer?.title ?? null,
    answerBookmark: hit.answer,
  };
}

/**
 * Human-facing description of a region, for the host to render.
 *
 * Deliberately says where to look and not what the answer is: a located result
 * that reads like a match invites exactly the misreading the rung exists to
 * prevent.
 */
export function describeRegion(region) {
  if (!region) return null;
  const where = region.from === region.to
    ? `答案册第 ${region.from} 页`
    : `答案册第 ${region.from}–${region.to} 页`;
  return region.answerSection ? `${region.answerSection} · ${where}` : where;
}
