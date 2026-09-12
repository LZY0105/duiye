// PDF Module — the pages a reader put a finger in.
//
// A bookmark is not a note and not an annotation. It is "come back here",
// and the only things it has to be are: exact about which page, ordered the
// way the book is, and impossible to lose. So it is a page number and an
// optional label, kept per document, and nothing else.
//
// DOM-free, like the deck and panel state beside it. The rules worth having
// tested are the ones a reader would notice: the same page never bookmarked
// twice, the list always in reading order, and a page number that could not
// possibly be right never getting in.

/** A label longer than this is a note, and this is not the place for notes. */
export const LABEL_MAX = 60;

const clean = (label) => {
  if (typeof label !== 'string') return '';
  return label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
};

const validPage = (page, pageCount) => {
  if (!Number.isFinite(page)) return 0;
  const n = Math.round(page);
  if (n < 1) return 0;
  // A page count of 0 means "not known yet" — a restore that arrives before
  // the document does. Refusing everything then would silently drop the
  // reader's marks, so an unknown length accepts any positive page.
  if (pageCount > 0 && n > pageCount) return 0;
  return n;
};

/**
 * @param {Array} initial  straight off disk, so treated as untrusted
 * @returns {ReadonlyArray<{page: number, label: string}>} ascending, unique
 */
export function createBookmarks(initial = []) {
  if (!Array.isArray(initial)) return Object.freeze([]);
  const byPage = new Map();
  for (const raw of initial) {
    const page = validPage(raw?.page ?? raw, 0);
    if (!page || byPage.has(page)) continue;
    byPage.set(page, Object.freeze({ page, label: clean(raw?.label) }));
  }
  return freezeSorted([...byPage.values()]);
}

function freezeSorted(list) {
  return Object.freeze(list.sort((a, b) => a.page - b.page));
}

/**
 * Adds a page, or relabels it if it is already marked.
 *
 * Never a duplicate: two entries for one page is a list that cannot be read
 * and a "remove" that leaves one behind.
 */
export function addBookmark(marks, page, { label = '', pageCount = 0 } = {}) {
  const n = validPage(page, pageCount);
  if (!n) return marks;
  const next = marks.filter(m => m.page !== n);
  next.push(Object.freeze({ page: n, label: clean(label) }));
  return freezeSorted(next);
}

/**
 * 给一条已经存在的书签起名字。
 *
 * 和 addBookmark 传 label 是两件事，尽管它们看着能互相代替：addBookmark 对一页
 * 还没标过的页会新建一条，而「改名」对一页没标过的页什么都不该做。面板里那支
 * 笔点下去的时候，这一页必然是标过的——如果它不是，那说明单子和真相已经对不
 * 上了，这时候悄悄补一条书签只会把那个错固定下来。
 *
 * 名字清空就是把名字去掉，退回「第 N 页」，而不是把这条书签删掉。
 */
export function renameBookmark(marks, page, label) {
  const n = Math.round(page);
  const at = marks.findIndex(m => m.page === n);
  if (at < 0) return marks;
  const next = clean(label);
  if (marks[at].label === next) return marks;
  const copy = marks.slice();
  copy[at] = Object.freeze({ page: n, label: next });
  return freezeSorted(copy);
}

export function removeBookmark(marks, page) {
  const n = Math.round(page);
  if (!marks.some(m => m.page === n)) return marks;
  return Object.freeze(marks.filter(m => m.page !== n));
}

/** The gesture a single control performs: on if it was off, off if it was on. */
export function toggleBookmark(marks, page, opts = {}) {
  return hasBookmark(marks, page)
    ? removeBookmark(marks, page)
    : addBookmark(marks, page, opts);
}

export function hasBookmark(marks, page) {
  const n = Math.round(page);
  return marks.some(m => m.page === n);
}

/** What to show for a mark that was never given words of its own. */
export function bookmarkLabel(mark) {
  return mark?.label || `第 ${mark?.page} 页`;
}

/**
 * The mark at or after `page`, wrapping to the first — "jump to the next one".
 *
 * Wrapping rather than stopping at the end, because a reader cycling through
 * their own marks in a 827-page book should not have to scroll back to the
 * front to carry on.
 */
export function nextBookmark(marks, page) {
  if (!marks.length) return null;
  const n = Math.round(page);
  return marks.find(m => m.page > n) || marks[0];
}

export function prevBookmark(marks, page) {
  if (!marks.length) return null;
  const n = Math.round(page);
  const before = marks.filter(m => m.page < n);
  return before.length ? before[before.length - 1] : marks[marks.length - 1];
}

export function serializeBookmarks(marks) {
  return marks.map(m => (m.label ? { page: m.page, label: m.label } : { page: m.page }));
}
