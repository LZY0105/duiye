// PDF Module — dual-workspace layout state.
//
// Pure, like the per-view state. Holds only how the workspace is arranged:
// which document sits in which slot, where the divider is, whether the panes
// are side-by-side or stacked, and whether one pane is temporarily focused.
//
// It deliberately does NOT hold page/zoom/scroll — those belong to each pane's
// own view state, so layout changes can never disturb what a pane is showing.

export const SLOTS = Object.freeze({ PRIMARY: 'a', SECONDARY: 'b' });

export const ORIENTATIONS = Object.freeze({
  /** Landscape dual-panel: panes side by side, vertical divider. */
  ROW: 'row',
  /** Portrait adaptive: panes stacked, horizontal divider. */
  COLUMN: 'column',
});

// The divider drags the whole way: 0:10 to 10:0, no snap set and no stops.
//
// Reaching an end is not a layout state, it is an intent. A pane dragged to
// nothing is a pane the user is closing, so the workspace closes that document
// when the drag ends there (see PdfWorkspace._bindDivider) rather than leaving
// a zero-width pane that cannot be grabbed back.
//
// A pane can get very narrow before that point, so the panes report their own
// width band to CSS (see PdfWorkspace._syncPaneWidthBands) and their chrome
// adapts instead of overflowing.
export const MIN_RATIO = 0;
export const MAX_RATIO = 1;

/**
 * Within this of an end, releasing the divider closes that side.
 *
 * It was 0.04, and inside that zone the divider stopped following the finger
 * and jumped the rest of the way — edge magnetism, to make the answer to "will
 * this close?" visible before the release. The trouble is that 4% of a
 * 1200px workspace is 48px, and 48px is a normal amount of resizing: someone
 * making one column narrow found it snatched out from under them and the pane
 * shut. A drag is a drag for the whole of its travel.
 *
 * 0.004 is about five pixels — the divider has to be taken to the edge of the
 * workspace, which nobody does by accident and anybody can do on purpose.
 */
export const CLOSE_THRESHOLD = 0.004;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A ratio, defaulting to centre only when one was not supplied.
 *
 * This was `Number(v) || 0.5`, which was correct only while 0 was outside the
 * legal range. Now that the divider travels to 0, that idiom reads a perfectly
 * good "fully collapsed" as "missing" and snaps it back to the middle —
 * silently undoing the drag, and restoring a session to 50:50 whenever the user
 * had left a pane closed.
 */
const toRatio = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0.5;
};
const freeze = (o) => Object.freeze(o);

export function createWorkspaceState(initial = {}) {
  const documents = initial.documents || {};
  return freeze({
    documents: freeze({
      [SLOTS.PRIMARY]: documents[SLOTS.PRIMARY] || null,
      [SLOTS.SECONDARY]: documents[SLOTS.SECONDARY] || null,
    }),
    dividerRatio: clamp(toRatio(initial.dividerRatio), MIN_RATIO, MAX_RATIO),
    orientation: initial.orientation === ORIENTATIONS.COLUMN
      ? ORIENTATIONS.COLUMN
      : ORIENTATIONS.ROW,
    /** Slot id when one pane is maximised, else null. */
    focusedSlot: initial.focusedSlot === SLOTS.PRIMARY || initial.focusedSlot === SLOTS.SECONDARY
      ? initial.focusedSlot
      : null,
    /**
     * Which side each slot is displayed on.
     *
     * `false` is the natural order: PRIMARY left, SECONDARY right. The slots
     * themselves never move — a slot owns a live pane with a rendered document,
     * its ink, its scroll position and its zoom, and re-seating those into the
     * other pane would mean re-rendering the document and losing all of it.
     * Only the SIDE they are drawn on changes.
     */
    swapped: initial.swapped === true,
  });
}

const next = (state, patch) => freeze({ ...state, ...patch });

export function isSlot(slot) {
  return slot === SLOTS.PRIMARY || slot === SLOTS.SECONDARY;
}

export function otherSlot(slot) {
  return slot === SLOTS.PRIMARY ? SLOTS.SECONDARY : SLOTS.PRIMARY;
}

/** Assigns a document id to a slot. Only two may be open at once, by shape. */
export function assignDocument(state, slot, documentId) {
  if (!isSlot(slot)) return state;
  return next(state, {
    documents: freeze({ ...state.documents, [slot]: documentId || null }),
  });
}

/**
 * Closes a slot. If the closed pane was the focused one, focus is released
 * rather than left pointing at an empty pane.
 */
export function closeSlot(state, slot) {
  if (!isSlot(slot)) return state;
  const cleared = assignDocument(state, slot, null);
  return state.focusedSlot === slot ? next(cleared, { focusedSlot: null }) : cleared;
}

export function setDividerRatio(state, ratio) {
  const target = clamp(toRatio(ratio), MIN_RATIO, MAX_RATIO);
  if (target === state.dividerRatio) return state;
  return next(state, { dividerRatio: target });
}

export function setOrientation(state, orientation) {
  const target = orientation === ORIENTATIONS.COLUMN ? ORIENTATIONS.COLUMN : ORIENTATIONS.ROW;
  if (target === state.orientation) return state;
  return next(state, { orientation: target });
}

/** Landscape gets side-by-side panes; portrait stacks them. */
export function orientationForViewport(width, height) {
  return width >= height ? ORIENTATIONS.ROW : ORIENTATIONS.COLUMN;
}

/** Single-document focus mode: maximise one pane without closing the other. */
export function focusSlot(state, slot) {
  if (!isSlot(slot)) return state;
  return next(state, { focusedSlot: slot });
}

export function clearFocus(state) {
  if (state.focusedSlot === null) return state;
  return next(state, { focusedSlot: null });
}

export function toggleFocus(state, slot) {
  return state.focusedSlot === slot ? clearFocus(state) : focusSlot(state, slot);
}

/**
 * Exchanges the two panes left-for-right.
 *
 * `dividerRatio` is NOT touched, and that is the whole point. It is the
 * fraction belonging to the PRIMARY slot, and a slot carries its width with it
 * to the other side: a user who widened the pane holding a dense exercise page
 * and then swapped wants that exercise page still wide, just on the other
 * hand. Mirroring the ratio here would keep the *regions* fixed and pour the
 * documents between them, which makes the document you just gave room to the
 * one that loses it.
 *
 * Because a swapped PRIMARY is drawn on the right, the divider's own pointer
 * and keyboard maths has to be mirrored instead — see `ratioFromEvent` and the
 * arrow-key handler in PdfWorkspace. That is the only place the flip belongs:
 * in the input, not in the state.
 */
export function swapSides(state) {
  return next(state, { swapped: !state.swapped });
}

export function openSlots(state) {
  return [SLOTS.PRIMARY, SLOTS.SECONDARY].filter(s => state.documents[s]);
}

export function isDualMode(state) {
  return openSlots(state).length === 2 && state.focusedSlot === null;
}

/**
 * Fraction of the workspace each pane occupies right now.
 *
 * Focus mode and a single open document both collapse to one full-size pane,
 * so the divider is only meaningful when two documents are showing.
 */
export function paneFractions(state) {
  const open = openSlots(state);
  if (open.length === 0) return { [SLOTS.PRIMARY]: 0, [SLOTS.SECONDARY]: 0 };
  if (state.focusedSlot) {
    return {
      [SLOTS.PRIMARY]: state.focusedSlot === SLOTS.PRIMARY ? 1 : 0,
      [SLOTS.SECONDARY]: state.focusedSlot === SLOTS.SECONDARY ? 1 : 0,
    };
  }
  if (open.length === 1) {
    return {
      [SLOTS.PRIMARY]: open[0] === SLOTS.PRIMARY ? 1 : 0,
      [SLOTS.SECONDARY]: open[0] === SLOTS.SECONDARY ? 1 : 0,
    };
  }
  return {
    [SLOTS.PRIMARY]: state.dividerRatio,
    [SLOTS.SECONDARY]: 1 - state.dividerRatio,
  };
}

export function serializeWorkspaceState(state) {
  return {
    documents: { ...state.documents },
    dividerRatio: state.dividerRatio,
    orientation: state.orientation,
    focusedSlot: state.focusedSlot,
    swapped: state.swapped,
  };
}
