// PDF Module — the side panel that drops over a column: which face it is
// showing, and how much of the column it is allowed to take.
//
// DOM-free on purpose, like the deck and toolbar state next to it. What the
// panel is showing and how tall it is are decisions with rules — a tab that
// survives closing and reopening, a height that cannot be dragged past the
// point where the page underneath stops being readable — and rules are worth
// testing without a browser in the way.

/** The faces of one panel. Both look at the same document. */
export const PANEL_TABS = Object.freeze({
  /** The book's own bookmarks. Absent from plenty of books. */
  OUTLINE: 'outline',
  /** Every page as a picture. Always available, because it is the pages. */
  THUMBS: 'thumbs',
  /** The pages the reader put a finger in. Theirs, not the book's. */
  MARKS: 'marks',
});

/**
 * How much of the column the panel may cover.
 *
 * The floor is not politeness, it is the point below which a thumbnail grid
 * shows one and a half rows and stops being a way to find anything. The
 * ceiling leaves a strip of the page showing: a panel that covers the column
 * completely reads as having navigated away, and the reader loses the thing
 * they were about to come back to.
 */
export const PANEL_HEIGHT = Object.freeze({
  MIN: 0.25,
  MAX: 0.85,
  DEFAULT: 0.42,
  /**
   * Drag the grip above this and letting go closes the panel.
   *
   * Strictly below MIN, and by a margin you have to mean: the panel stops
   * shrinking at MIN, so everything between MIN and here is a deliberate pull
   * against a stop. Without that gap, every drag that slightly overshot the
   * smallest useful size would dismiss the panel instead of resting at it.
   */
  CLOSE_AT: 0.17,
});

const TAB_VALUES = Object.values(PANEL_TABS);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const next = (state, patch) => Object.freeze({ ...state, ...patch });

/**
 * @param {{tab?: string, height?: number}} initial  usually straight off disk,
 *   so every field is treated as untrusted.
 */
export function createPanelState(initial = {}) {
  return Object.freeze({
    tab: TAB_VALUES.includes(initial.tab) ? initial.tab : PANEL_TABS.OUTLINE,
    height: Number.isFinite(initial.height)
      ? clamp(initial.height, PANEL_HEIGHT.MIN, PANEL_HEIGHT.MAX)
      : PANEL_HEIGHT.DEFAULT,
  });
}

/**
 * The chosen face, remembered.
 *
 * A reader who went to the thumbnails once is usually navigating by eye rather
 * than by chapter, and making them choose again every time they reopen the
 * panel is making them repeat themselves.
 */
export function selectTab(state, tab) {
  if (!TAB_VALUES.includes(tab) || state.tab === tab) return state;
  return next(state, { tab });
}

/**
 * The height, as a fraction of the column.
 *
 * A fraction rather than pixels, so the choice survives the divider moving,
 * the window resizing and the two panes being swapped — all of which change
 * what "300px of panel" means without the reader having asked for anything.
 */
export function setHeight(state, fraction) {
  if (!Number.isFinite(fraction)) return state;
  const height = clamp(fraction, PANEL_HEIGHT.MIN, PANEL_HEIGHT.MAX);
  if (height === state.height) return state;
  return next(state, { height });
}

/**
 * Has the grip been pulled far enough up to mean "close this"?
 *
 * Asked of the RAW fraction the pointer is at, not of the stored height —
 * the stored one is clamped at MIN and so can never answer this.
 */
export function shouldClose(fraction) {
  return Number.isFinite(fraction) && fraction < PANEL_HEIGHT.CLOSE_AT;
}

export function serializePanelState(state) {
  return { tab: state.tab, height: state.height };
}

/**
 * The pages worth keeping rendered, centred on the one being read.
 *
 * A thumbnail is a rasterised page, and this reader's book is 827 of them.
 * Keeping every one ever scrolled past is how a panel that helps you find a
 * page becomes the reason the app runs out of memory — but dropping everything
 * off-screen is just as bad, because scrolling back up then repaints pages
 * that were fine a second ago.
 *
 * So: a window around where the reader is, and nothing else. Returned as a
 * range rather than a set so the caller can test membership without building
 * 827 entries to answer a question about one.
 *
 * @returns {{from: number, to: number}} inclusive, 1-based, clamped to the book
 */
export function thumbWindow(current, total, radius = 24) {
  if (!Number.isFinite(total) || total < 1) return { from: 1, to: 0 };
  const page = clamp(Math.round(current) || 1, 1, total);
  const r = Math.max(1, Math.round(radius));
  return { from: Math.max(1, page - r), to: Math.min(total, page + r) };
}

export function inThumbWindow(window, page) {
  return page >= window.from && page <= window.to;
}
