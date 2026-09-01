// Table-of-contents rows are not answers.
//
// Body parsing of the 2023 answer key produces 1,235 entries for 508 real
// answers. A large share of the excess is the book's own 目录: every question id
// appears once in the printed contents and once at its actual answer, so every
// lookup finds the label twice and the engine — correctly — refuses to choose.
//
// Measured before this filter, on the regime where the answer key has no
// bookmarks: 825 of 872 attempts returned exactly two candidates, one of which
// was the contents row on page 4-10 and the other the real answer. In all 825
// the true answer was the non-contents candidate. The engine was refusing 825
// questions it had already found, because a spurious duplicate made a unique id
// look ambiguous.
//
// That is the over-extraction defect costing precision AND coverage from one
// root cause: the surplus entries are never right, and their presence suppresses
// the entries that are.
//
// ── the signal ──
//
// Not density. A threshold on labels-per-page would need tuning and would
// mis-fire on a book that legitimately packs many short answers onto one page.
// The reliable signal is typographic — a contents row ends in a dot leader and
// the page it points to:
//
//   1.31 2023. 大连理工大学 . . . . . . . . . . . . . . . . 25
//   1.10 2023. 华东师范大学 原 PDF 第 5 页 ′ 设一元函数 f (x) 在 ...
//
// The first is a pointer, the second is an answer. A dot leader is a convention
// of the same typesetting tradition that produced the numbering this engine
// already relies on, and it needs no threshold.
//
// ── why the whole page, and not the row ──
//
// Suppression is decided per PAGE, not per row. Extraction drops characters, so
// some contents rows lose their leaders and would survive a row-level test —
// leaving exactly the duplicate this exists to remove. A page is judged a
// contents page when a clear majority of its entries carry leaders AND it holds
// several distinct labels; then all of its entries go. A real answer page cannot
// pass both tests, and a stray dotted line inside a real answer cannot delete it.

/**
 * A dot leader followed by a page number, at the end of a line.
 *
 * Spaced dots are the common rendering; the run must be at least three so that
 * an ellipsis or a decimal cannot trigger it. Middle dots and the ideographic
 * variants appear in the same role in CJK typesetting.
 */
const DOT_LEADER = /[.．·・‧∙•](?:\s*[.．·・‧∙•]){2,}\s*\d{1,4}\s*$/;

/** A contents heading. Corroborating evidence, never sufficient on its own. */
const CONTENTS_HEADING = /^\s*(目\s*录|索\s*引|题号索引|Contents|Index)\s*$/;

const THRESHOLDS = Object.freeze({
  /** Share of a page's entries that must carry a leader for the page to be contents. */
  leaderShare: 0.6,
  /**
   * Distinct labels a page must hold before it can be judged contents at all.
   *
   * A real answer page in this corpus holds 1-3 (p50 2, p90 3). Contents pages
   * hold 36. Four is chosen inside that gap and is deliberately closer to the
   * answer-page side: suppressing a real page costs coverage, so the test has to
   * clear the normal case comfortably before it fires.
   */
  minLabels: 4,
});

/** True when a line reads as a pointer to somewhere else rather than as content. */
export function isTocRow(text) {
  return DOT_LEADER.test(String(text ?? ''));
}

/** True when a line is a contents heading. */
export function isContentsHeading(text) {
  return CONTENTS_HEADING.test(String(text ?? ''));
}

/**
 * Pages whose entries are contents rows rather than answers.
 *
 * @param {Array<{page:number,label:string,text:string}>} entries
 * @returns {Set<number>}
 */
export function findContentsPages(entries) {
  const byPage = new Map();
  for (const entry of entries ?? []) {
    if (!byPage.has(entry.page)) byPage.set(entry.page, []);
    byPage.get(entry.page).push(entry);
  }

  const pages = new Set();
  for (const [page, list] of byPage) {
    const labels = new Set(list.map(e => e.label)).size;
    if (labels < THRESHOLDS.minLabels) continue;
    const leaders = list.filter(e => isTocRow(e.text)).length;
    if (leaders / list.length >= THRESHOLDS.leaderShare) pages.add(page);
  }
  return pages;
}

/**
 * Removes contents rows from a set of parsed entries.
 *
 * Returns what was removed rather than discarding it silently: a filter that
 * cannot be inspected is a filter nobody can debug, and if this ever suppresses
 * a real answer page the evidence has to be visible.
 *
 * @returns {{entries: Array, suppressed: Array, pages: number[]}}
 */
export function suppressContentsRows(entries) {
  const list = entries ?? [];
  const pages = findContentsPages(list);
  if (pages.size === 0) return { entries: list, suppressed: [], pages: [] };

  const kept = [];
  const suppressed = [];
  for (const entry of list) (pages.has(entry.page) ? suppressed : kept).push(entry);
  return { entries: kept, suppressed, pages: [...pages].sort((a, b) => a - b) };
}

/**
 * The label -> printed page mapping a contents page carries.
 *
 * Not used for matching yet, and deliberately kept separate from suppression:
 * the number at the end of a contents row is the book's PRINTED page, which is
 * offset from the PDF page index by however many pages of front matter precede
 * it. That offset is knowable — it is constant within a volume and can be
 * recovered from a handful of entries whose position is independently known —
 * but until it is measured this mapping cannot locate anything, and guessing the
 * offset would produce confident wrong page numbers.
 *
 * Exposed because a book with no bookmark tree still prints its own index, and
 * that index is exactly the label->location map the missing bookmarks would have
 * provided. See the note in tools/measure-located.mjs.
 *
 * @returns {Map<string, number>} label -> printed page number
 */
export function contentsPageMap(entries) {
  const out = new Map();
  for (const entry of entries ?? []) {
    if (!isTocRow(entry.text)) continue;
    const m = String(entry.text).match(/(\d{1,4})\s*$/);
    if (!m) continue;
    if (!out.has(entry.label)) out.set(entry.label, Number(m[1]));
  }
  return out;
}
