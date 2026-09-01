// PDF Module — per-view state.
//
// Deliberately pure and DOM-free. Every pane in the dual workspace owns one of
// these objects and nothing else, which is what makes "independent zoom,
// scrolling and page navigation" a structural property rather than a promise:
// there is no shared mutable state for two panes to fight over, and each
// operation returns a NEW state instead of mutating a shared one.
//
// Being pure also means the isolation guarantee is testable in plain Node,
// without a canvas or a real PDF.

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 6;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6];

export const FIT_MODES = Object.freeze({
  NONE: 'none',
  WIDTH: 'width',
  PAGE: 'page',
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {number} pageCount total pages in the bound document
 * @param {Object} [initial] restored fields (from a saved session)
 */
export function createViewState(pageCount, initial = {}) {
  const pages = Math.max(1, Math.floor(pageCount) || 1);
  return Object.freeze({
    pageCount: pages,
    pageNumber: clamp(Math.floor(initial.pageNumber) || 1, 1, pages),
    zoom: clamp(Number(initial.zoom) || 1, ZOOM_MIN, ZOOM_MAX),
    // Pan offsets in CSS pixels, relative to the rendered page origin.
    scrollX: Number(initial.scrollX) || 0,
    scrollY: Number(initial.scrollY) || 0,
    fitMode: Object.values(FIT_MODES).includes(initial.fitMode)
      ? initial.fitMode
      : FIT_MODES.WIDTH,
  });
}

const next = (state, patch) => Object.freeze({ ...state, ...patch });

/** Page navigation resets pan, so a new page always starts at its top-left. */
export function goToPage(state, pageNumber) {
  const target = clamp(Math.floor(pageNumber) || 1, 1, state.pageCount);
  if (target === state.pageNumber) return state;
  return next(state, { pageNumber: target, scrollX: 0, scrollY: 0 });
}

export function nextPage(state) {
  return goToPage(state, state.pageNumber + 1);
}

export function previousPage(state) {
  return goToPage(state, state.pageNumber - 1);
}

export function canGoNext(state) {
  return state.pageNumber < state.pageCount;
}

export function canGoPrevious(state) {
  return state.pageNumber > 1;
}

/**
 * Sets an explicit zoom. Any manual zoom drops the fit mode — otherwise the
 * next relayout would silently undo what the user just did.
 */
export function setZoom(state, zoom) {
  const target = clamp(Number(zoom) || 1, ZOOM_MIN, ZOOM_MAX);
  if (target === state.zoom && state.fitMode === FIT_MODES.NONE) return state;
  return next(state, { zoom: target, fitMode: FIT_MODES.NONE });
}

export function zoomIn(state) {
  const step = ZOOM_STEPS.find(z => z > state.zoom + 1e-6);
  return setZoom(state, step === undefined ? ZOOM_MAX : step);
}

export function zoomOut(state) {
  const below = ZOOM_STEPS.filter(z => z < state.zoom - 1e-6);
  return setZoom(state, below.length ? below[below.length - 1] : ZOOM_MIN);
}

/**
 * Applies a fit mode by computing the zoom it implies for the given viewport
 * and page size. The mode is remembered so a later resize (or a divider drag,
 * which changes the pane width) re-fits instead of keeping a stale zoom.
 */
export function applyFit(state, mode, viewport, pageSize) {
  if (!viewport || !pageSize || !pageSize.width || !pageSize.height) return state;
  if (mode === FIT_MODES.NONE) return state;
  const byWidth = viewport.width / pageSize.width;
  const byHeight = viewport.height / pageSize.height;
  const zoom = clamp(
    mode === FIT_MODES.PAGE ? Math.min(byWidth, byHeight) : byWidth,
    ZOOM_MIN,
    ZOOM_MAX,
  );
  return next(state, { zoom, fitMode: mode, scrollX: 0, scrollY: 0 });
}

/** Re-applies the remembered fit mode; a no-op when the user set zoom manually. */
export function refit(state, viewport, pageSize) {
  if (state.fitMode === FIT_MODES.NONE) return state;
  return applyFit(state, state.fitMode, viewport, pageSize);
}

/**
 * Pans by a delta, clamped so the page cannot be dragged entirely off screen.
 * `content` is the rendered page size in CSS pixels at the current zoom.
 */
export function panBy(state, dx, dy, viewport, content) {
  if (!viewport || !content) return state;
  const maxX = Math.max(0, content.width - viewport.width);
  const maxY = Math.max(0, content.height - viewport.height);
  const x = clamp(state.scrollX - dx, 0, maxX);
  const y = clamp(state.scrollY - dy, 0, maxY);
  if (x === state.scrollX && y === state.scrollY) return state;
  return next(state, { scrollX: x, scrollY: y });
}

/** The subset worth persisting across app restarts. */
export function serializeViewState(state) {
  return {
    pageNumber: state.pageNumber,
    zoom: state.zoom,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    fitMode: state.fitMode,
  };
}
