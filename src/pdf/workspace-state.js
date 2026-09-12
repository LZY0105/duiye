// PDF Module — dual-workspace layout state.
//
// Pure, like the per-view state. Holds only how the workspace is arranged:
// what each slot is holding, where the divider is, whether the panes are
// side-by-side or stacked, and whether one pane is temporarily focused.
//
// It deliberately does NOT hold page/zoom/scroll — those belong to each pane's
// own view state, so layout changes can never disturb what a pane is showing.
//
// A slot holds a DECK rather than a single document (see deck-state.js): what
// it is showing, plus everything rotated underneath it. `documents` survives as
// a DERIVED mirror — the resource each slot currently shows — so the layout
// maths and the callers that only ever asked "is this slot occupied, and with
// what" go on reading the same field.

import {
  activateEntry,
  activeEntry,
  createDeck,
  createEntry,
  cycleEntry,
  ENTRY_KINDS,
  findByResource,
  insertEntry,
  isEmptyDeck,
  moveEntry,
  removeEntry,
  serializeDeck,
} from './deck-state.js';

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

/**
 * The deck each slot starts with.
 *
 * Two shapes are accepted, and this is the only place that has to know both:
 * `decks`, which is what this version writes, and `documents`, the one-document
 * -per-slot record every earlier version wrote. A legacy document becomes a
 * deck of exactly one PDF entry — which is precisely what it always was, just
 * said in the new vocabulary.
 */
function decksFrom(initial) {
  const decks = {};
  for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
    const saved = initial.decks?.[slot];
    if (saved) {
      decks[slot] = createDeck(saved);
      continue;
    }
    const legacy = initial.documents?.[slot];
    decks[slot] = createDeck(legacy
      ? { entries: [createEntry({ kind: ENTRY_KINDS.PDF, resourceId: legacy })] }
      : {});
  }
  return freeze(decks);
}

/** The resource each slot is SHOWING — the derived compatibility mirror. */
function documentsFrom(decks) {
  return freeze({
    [SLOTS.PRIMARY]: activeEntry(decks[SLOTS.PRIMARY])?.resourceId || null,
    [SLOTS.SECONDARY]: activeEntry(decks[SLOTS.SECONDARY])?.resourceId || null,
  });
}

export function createWorkspaceState(initial = {}) {
  const decks = decksFrom(initial);
  return freeze({
    decks,
    documents: documentsFrom(decks),
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
    /**
     * Slot hidden by dragging the divider to its edge, or null.
     *
     * Collapse is NOT close. The deck is untouched and every entry stays in it;
     * only the room the slot is given goes to zero. That is the difference the
     * specification draws between collapsing a pane, removing an entry from it
     * and deleting a resource, and it is the reason a collapsed pane keeps a
     * restore control rather than an import button.
     */
    collapsedSlot: initial.collapsedSlot === SLOTS.PRIMARY
      || initial.collapsedSlot === SLOTS.SECONDARY
      ? initial.collapsedSlot
      : null,
    /**
     * The split to come back to when a collapsed slot is restored.
     *
     * Captured on the way in, because by then `dividerRatio` is 0 or 1 — the
     * position that MEANT collapse — and restoring to it would collapse the
     * pane again the moment it reappeared.
     */
    restoreRatio: clamp(toRatio(initial.restoreRatio), MIN_RATIO, MAX_RATIO),
  });
}

const next = (state, patch) => freeze({ ...state, ...patch });

export function isSlot(slot) {
  return slot === SLOTS.PRIMARY || slot === SLOTS.SECONDARY;
}

export function otherSlot(slot) {
  return slot === SLOTS.PRIMARY ? SLOTS.SECONDARY : SLOTS.PRIMARY;
}

// ── decks ───────────────────────────────────────────────────────────────────

/**
 * Writes one slot's deck back into the workspace, re-deriving `documents`.
 *
 * Every deck change goes through here, which is what keeps the mirror from
 * drifting: there is no path that can put a deck in without also saying what
 * the slot is now showing.
 */
function withDeck(state, slot, deck) {
  if (!isSlot(slot) || deck === state.decks[slot]) return state;
  const decks = freeze({ ...state.decks, [slot]: deck });
  return next(state, { decks, documents: documentsFrom(decks) });
}

export function deckFor(state, slot) {
  return state.decks?.[slot] || null;
}

export function activeEntryIn(state, slot) {
  return activeEntry(deckFor(state, slot));
}

/**
 * Opens a resource in a slot, keeping what was there underneath.
 *
 * The displaced entry becomes the new one's next item; nothing is closed. A
 * resource already in this deck is RECALLED rather than opened twice — one
 * deck may not hold the same resource in two places, and reopening something
 * you already have open means "show it to me", not "give me a second copy".
 *
 * @returns {{state: Object, entry: Object}} the new state and the live entry
 */
export function openInSlot(state, slot, { kind, resourceId, entryId } = {}) {
  if (!isSlot(slot) || resourceId == null) return { state, entry: null };
  const deck = deckFor(state, slot);
  const existing = findByResource(deck, resourceId);
  if (existing) {
    return { state: withDeck(state, slot, activateEntry(deck, existing.id)), entry: existing };
  }
  const entry = createEntry({ id: entryId, kind, resourceId });
  return { state: withDeck(state, slot, insertEntry(deck, entry)), entry };
}

/** Brings one entry of a slot's deck to the foreground. Order is untouched. */
export function activateInSlot(state, slot, entryId) {
  return withDeck(state, slot, activateEntry(deckFor(state, slot), entryId));
}

/** One step along a slot's deck: +1 next, -1 previous. */
export function cycleInSlot(state, slot, step = 1) {
  return withDeck(state, slot, cycleEntry(deckFor(state, slot), step));
}

/**
 * Detaches one entry from a slot. The resource stays in its library.
 *
 * Emptying the last entry out of a focused slot releases the focus too, for the
 * same reason closing one always did: focus on a pane with nothing in it is a
 * maximised blank.
 */
export function removeFromSlot(state, slot, entryId) {
  const after = withDeck(state, slot, removeEntry(deckFor(state, slot), entryId));
  if (after === state) return state;
  return isEmptyDeck(deckFor(after, slot)) && after.focusedSlot === slot
    ? next(after, { focusedSlot: null })
    : after;
}

/**
 * Moves one entry within a deck or between the two (F09).
 *
 * Refusals come back as a reason rather than a thrown error or a half-applied
 * pair: the caller shows the reason and both decks are exactly as they were.
 *
 * @returns {{ok: true, state: Object} | {ok: false, reason: string, entry?: Object}}
 */
export function moveEntryBetweenSlots(state, request) {
  const result = moveEntry(state.decks, request);
  if (!result.ok) return result;
  if (result.decks === state.decks) return { ok: true, state };
  const decks = freeze({ ...result.decks });
  let after = next(state, { decks, documents: documentsFrom(decks) });
  // The source can be emptied by a move just as it can by a removal.
  if (after.focusedSlot && isEmptyDeck(deckFor(after, after.focusedSlot))) {
    after = next(after, { focusedSlot: null });
  }
  return { ok: true, state: after };
}

/** Which slots hold an entry for this resource — for deletes and lookups. */
export function slotsWithResource(state, resourceId) {
  return [SLOTS.PRIMARY, SLOTS.SECONDARY]
    .filter(slot => findByResource(deckFor(state, slot), resourceId));
}

/**
 * Replaces a slot's whole deck with a single PDF, or empties it.
 *
 * The pre-deck API, kept because it says exactly what it used to: one document
 * in one slot and nothing underneath. New code opens with `openInSlot`, which
 * is the operation that keeps the displaced content.
 */
export function assignDocument(state, slot, documentId) {
  if (!isSlot(slot)) return state;
  const deck = createDeck(documentId
    ? { entries: [createEntry({ kind: ENTRY_KINDS.PDF, resourceId: documentId })] }
    : {});
  return withDeck(state, slot, deck);
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

// ── collapse (F08) ──────────────────────────────────────────────────────────

/**
 * Hides a slot without touching its deck.
 *
 * The split it was at is remembered here rather than recomputed on the way
 * out, so restoring gives back the arrangement the reader had chosen — not a
 * default 50:50, and not the 0 or 1 that collapsing left in `dividerRatio`.
 *
 * Collapsing an empty slot is a no-op: there is nothing to hide and nothing a
 * restore control could bring back.
 */
export function collapseSlot(state, slot) {
  if (!isSlot(slot) || state.collapsedSlot === slot) return state;
  if (isEmptyDeck(deckFor(state, slot))) return state;
  const keep = state.collapsedSlot ? state.restoreRatio : state.dividerRatio;
  return next(state, {
    collapsedSlot: slot,
    restoreRatio: keep,
    // Focus and collapse are two ways of saying "one pane"; holding both leaves
    // a state with no way back that the restore control can express.
    focusedSlot: state.focusedSlot === slot ? null : state.focusedSlot,
  });
}

export function restoreCollapsed(state) {
  if (!state.collapsedSlot) return state;
  return next(state, { collapsedSlot: null, dividerRatio: state.restoreRatio });
}

export function isCollapsed(state, slot) {
  return state.collapsedSlot === slot;
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

/**
 * Slots with anything in them.
 *
 * A slot is occupied when its DECK holds an entry, not when it happens to be
 * rendering a PDF: a pane showing a scratchpad, or one whose active entry is
 * still being prepared, is every bit as occupied, and the layout maths below
 * has to give it room.
 */
export function openSlots(state) {
  return [SLOTS.PRIMARY, SLOTS.SECONDARY].filter(s => !isEmptyDeck(deckFor(state, s)));
}

export function isDualMode(state) {
  return openSlots(state).length === 2 && state.focusedSlot === null;
}

/**
 * Fraction of the workspace each pane occupies right now.
 *
 * Focus mode, a collapsed slot and a single open document all come to one
 * full-size pane, so the divider is only meaningful when two are showing.
 */
export function paneFractions(state) {
  const open = openSlots(state);
  if (open.length === 0) return { [SLOTS.PRIMARY]: 0, [SLOTS.SECONDARY]: 0 };
  // A collapsed slot keeps its deck and gives up its room. Read before focus
  // because collapsing releases focus on that slot, so the two cannot disagree.
  if (state.collapsedSlot && open.length === 2) {
    return {
      [SLOTS.PRIMARY]: state.collapsedSlot === SLOTS.PRIMARY ? 0 : 1,
      [SLOTS.SECONDARY]: state.collapsedSlot === SLOTS.SECONDARY ? 0 : 1,
    };
  }
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
    decks: {
      [SLOTS.PRIMARY]: serializeDeck(state.decks[SLOTS.PRIMARY]),
      [SLOTS.SECONDARY]: serializeDeck(state.decks[SLOTS.SECONDARY]),
    },
    // Still written, and still read by createWorkspaceState when no decks are
    // present. It costs two strings and it is what an older build of the app
    // would find if a user moved back a version — it would show the two active
    // documents rather than an empty workspace.
    documents: { ...state.documents },
    dividerRatio: state.dividerRatio,
    orientation: state.orientation,
    focusedSlot: state.focusedSlot,
    swapped: state.swapped,
    collapsedSlot: state.collapsedSlot,
    restoreRatio: state.restoreRatio,
  };
}
