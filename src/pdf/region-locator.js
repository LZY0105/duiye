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

  const sorted = [...(alignment.pairs ?? [])]
    .filter(p => p.exercise?.pageNumber && p.answer?.pageNumber)
    .sort((a, b) => a.exercise.pageNumber - b.exercise.pageNumber);
  if (sorted.length === 0) return null;

  let index = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].exercise.pageNumber <= exercisePage) index = i;
    else break;
  }
  if (index < 0) return null;

  const chosen = sorted[index];
  const answerStart = chosen.answer.pageNumber;
  const next = sorted.slice(index + 1).find(p => p.answer.pageNumber > answerStart);
  const answerEnd = next ? next.answer.pageNumber - 1 : (answerPageCount || answerStart);

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
