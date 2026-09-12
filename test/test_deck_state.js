#!/usr/bin/env node
// Deck tests (F01-F04, F08, F09).
//
// The requirement this file exists to prove, in the user's own words: content
// that is replaced does not disappear, it rotates underneath and can be
// recalled. Everything below is a statement about ordering, activation and
// moving — all of which the deck modules answer without a canvas, a PDF or a
// database, which is why they are pure.

import assert from 'node:assert/strict';

import {
  DECK_ERRORS,
  ENTRY_KINDS,
  activeEntry,
  activePosition,
  canCycle,
  createDeck,
  createEntry,
  cycleEntry,
  deckLength,
  findByResource,
  indexOfEntry,
  insertEntry,
  insertEntryAfter,
  isEmptyDeck,
  moveEntry,
  nextEntry,
  previousEntry,
  removeEntry,
  serializeDeck,
  activateEntry,
} from '../src/pdf/deck-state.js';

import {
  SLOTS,
  activeEntryIn,
  collapseSlot,
  createWorkspaceState,
  cycleInSlot,
  deckFor,
  isCollapsed,
  moveEntryBetweenSlots,
  openInSlot,
  openSlots,
  paneFractions,
  removeFromSlot,
  restoreCollapsed,
  serializeWorkspaceState,
  setDividerRatio,
  slotsWithResource,
  toggleFocus,
} from '../src/pdf/workspace-state.js';

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function group(n) { console.log(`\n─── [${n}] ───`); }
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

/** A deck built from resource ids, active on the first one. */
const deckOf = (...ids) => createDeck({
  entries: ids.map(id => createEntry({ kind: ENTRY_KINDS.PDF, resourceId: id })),
});
/** What a deck holds, in order — the shape every assertion below is written in. */
const order = (deck) => deck.entries.map(e => e.resourceId);
const showing = (deck) => activeEntry(deck)?.resourceId ?? null;
const idOf = (deck, resourceId) => findByResource(deck, resourceId).id;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Deck Tests — rotate underneath, recall, move between panes');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. Ordering — the specification\'s worked example');

check('a new entry goes in front, and what it replaced becomes its next', () => {
  // "Answer A becomes [Scratch S, A] after creation, then [File B, S, A] after
  // another open. Next cycles through S, A, B."
  let deck = deckOf('A');
  deck = insertEntry(deck, createEntry({ kind: ENTRY_KINDS.SCRATCH, resourceId: 'S' }));
  assert.deepEqual(order(deck), ['S', 'A'], 'the pad goes in front of the answer book');
  assert.equal(showing(deck), 'S', 'and is what the pane shows');

  deck = insertEntry(deck, createEntry({ resourceId: 'B' }));
  assert.deepEqual(order(deck), ['B', 'S', 'A']);
  assert.equal(showing(deck), 'B');
});

check('next cycles S, A, B and comes back round', () => {
  let deck = deckOf('A');
  deck = insertEntry(deck, createEntry({ resourceId: 'S' }));
  deck = insertEntry(deck, createEntry({ resourceId: 'B' }));

  deck = cycleEntry(deck, 1); assert.equal(showing(deck), 'S');
  deck = cycleEntry(deck, 1); assert.equal(showing(deck), 'A');
  deck = cycleEntry(deck, 1); assert.equal(showing(deck), 'B', 'the deck is circular');
});

check('previous runs the other way', () => {
  let deck = deckOf('B', 'S', 'A');
  deck = cycleEntry(deck, -1);
  assert.equal(showing(deck), 'A', 'previous from the head wraps to the tail');
  deck = cycleEntry(deck, -1);
  assert.equal(showing(deck), 'S');
});

check('inserting while A is active makes A the next item', () => {
  // "Inserting C while A is active must make A the next item after C while
  // preserving other relative order."
  let deck = deckOf('B', 'S', 'A');
  deck = activateEntry(deck, idOf(deck, 'A'));
  deck = insertEntry(deck, createEntry({ resourceId: 'C' }));

  assert.deepEqual(order(deck), ['B', 'S', 'C', 'A']);
  assert.equal(showing(deck), 'C');
  assert.equal(nextEntry(deck).resourceId, 'A', 'A is what C displaced');
  // B before S, exactly as it was.
  assert.ok(indexOfEntry(deck, idOf(deck, 'B')) < indexOfEntry(deck, idOf(deck, 'S')));
});

check('selecting an entry directly never reorders the deck', () => {
  let deck = deckOf('B', 'S', 'A');
  const before = order(deck);
  deck = activateEntry(deck, idOf(deck, 'A'));
  assert.deepEqual(order(deck), before, 'the list must not rotate under a selection');
  assert.equal(showing(deck), 'A');
});

check('one entry shows 1 / 1 and has nothing to cycle to', () => {
  const deck = deckOf('only');
  assert.equal(deckLength(deck), 1);
  assert.equal(activePosition(deck), 1);
  assert.equal(canCycle(deck), false, 'cycling is disabled, the list stays available');
  assert.equal(cycleEntry(deck, 1), deck, 'and a cycle is a no-op rather than a flicker');
});

check('the position readout follows the active entry', () => {
  let deck = deckOf('B', 'S', 'A');
  assert.equal(activePosition(deck), 1);
  deck = cycleEntry(deck, 1);
  assert.equal(activePosition(deck), 2);
  deck = cycleEntry(deck, 1);
  assert.equal(activePosition(deck), 3);
});

// ═══════════════════════════════════════════════════════════════
group('2. Invariants');

check('one deck never holds the same resource twice', () => {
  let deck = deckOf('A', 'B');
  const doubled = createDeck({
    entries: [
      createEntry({ resourceId: 'A' }),
      createEntry({ resourceId: 'B' }),
      createEntry({ resourceId: 'A' }),
    ],
  });
  assert.deepEqual(order(doubled), ['A', 'B'], 'a duplicate is dropped on construction');
  assert.equal(deckLength(deck), 2);
});

check('an active id naming nothing is repaired, not carried', () => {
  const deck = createDeck({
    entries: [createEntry({ resourceId: 'A' })],
    activeId: 'e-does-not-exist',
  });
  assert.equal(showing(deck), 'A', 'a deck always knows what it is showing');
});

check('entries with no resource are refused', () => {
  const deck = createDeck({ entries: [{ id: 'x', kind: 'pdf' }, createEntry({ resourceId: 'A' })] });
  assert.deepEqual(order(deck), ['A']);
});

check('an empty deck is empty, and says so', () => {
  const deck = createDeck();
  assert.equal(isEmptyDeck(deck), true);
  assert.equal(activeEntry(deck), null);
  assert.equal(activePosition(deck), 0);
  assert.equal(nextEntry(deck), null);
  assert.equal(previousEntry(deck), null);
});

check('a deck survives serialisation with its order and its active entry', () => {
  let deck = deckOf('B', 'S', 'A');
  deck = cycleEntry(deck, 1);
  const back = createDeck(serializeDeck(deck));
  assert.deepEqual(order(back), ['B', 'S', 'A']);
  assert.equal(back.activeId, deck.activeId, 'entry ids are stable across a restart');
  assert.equal(showing(back), 'S');
});

// ═══════════════════════════════════════════════════════════════
group('3. Removal — remove is not delete');

check('removing the active entry activates what was its next', () => {
  let deck = deckOf('B', 'S', 'A');
  deck = removeEntry(deck, idOf(deck, 'B'));
  assert.deepEqual(order(deck), ['S', 'A']);
  assert.equal(showing(deck), 'S', 'the deck falls to the entry underneath');
});

check('removing a background entry leaves the foreground alone', () => {
  let deck = deckOf('B', 'S', 'A');
  deck = removeEntry(deck, idOf(deck, 'A'));
  assert.deepEqual(order(deck), ['B', 'S']);
  assert.equal(showing(deck), 'B', 'what the pane shows has not changed');
});

check('removing the last entry leaves an empty deck, not a deleted resource', () => {
  let deck = deckOf('only');
  deck = removeEntry(deck, idOf(deck, 'only'));
  assert.equal(isEmptyDeck(deck), true);
  assert.equal(showing(deck), null);
});

check('removing the tail while it is active wraps to the head', () => {
  let deck = deckOf('B', 'S', 'A');
  deck = activateEntry(deck, idOf(deck, 'A'));
  deck = removeEntry(deck, idOf(deck, 'A'));
  assert.deepEqual(order(deck), ['B', 'S']);
  assert.equal(showing(deck), 'B', 'the next item after the tail is the head');
});

check('removing something that is not there changes nothing', () => {
  const deck = deckOf('A', 'B');
  assert.equal(removeEntry(deck, 'nope'), deck);
});

// ═══════════════════════════════════════════════════════════════
group('4. Moving entries between panes (F09)');

const twoDecks = () => ({
  [SLOTS.PRIMARY]: deckOf('X', 'Y'),
  [SLOTS.SECONDARY]: deckOf('P', 'Q'),
});

check('a background entry moves without changing either foreground', () => {
  const decks = twoDecks();
  const moving = idOf(decks[SLOTS.PRIMARY], 'Y');
  const anchor = idOf(decks[SLOTS.SECONDARY], 'P');
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY, to: SLOTS.SECONDARY, entryId: moving, afterId: anchor,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order(r.decks[SLOTS.PRIMARY]), ['X']);
  assert.deepEqual(order(r.decks[SLOTS.SECONDARY]), ['P', 'Y', 'Q'], 'placed after P');
  assert.equal(showing(r.decks[SLOTS.PRIMARY]), 'X', 'source still shows X');
  assert.equal(showing(r.decks[SLOTS.SECONDARY]), 'P', 'destination still shows P');
});

check('moving the source\'s active entry activates its pre-move next', () => {
  const decks = twoDecks();
  const moving = idOf(decks[SLOTS.PRIMARY], 'X');       // X is active
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY, to: SLOTS.SECONDARY, entryId: moving, afterId: null,
  });
  assert.equal(r.ok, true);
  assert.equal(showing(r.decks[SLOTS.PRIMARY]), 'Y', 'the source falls to what was underneath');
  assert.deepEqual(order(r.decks[SLOTS.SECONDARY]), ['X', 'P', 'Q'], 'null anchor means first');
  assert.equal(showing(r.decks[SLOTS.SECONDARY]), 'P', 'the destination is not disturbed');
});

check('moving the source\'s only entry leaves it empty', () => {
  const decks = { [SLOTS.PRIMARY]: deckOf('lonely'), [SLOTS.SECONDARY]: deckOf('P') };
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY,
    to: SLOTS.SECONDARY,
    entryId: idOf(decks[SLOTS.PRIMARY], 'lonely'),
    afterId: idOf(decks[SLOTS.SECONDARY], 'P'),
  });
  assert.equal(r.ok, true);
  assert.equal(isEmptyDeck(r.decks[SLOTS.PRIMARY]), true);
  assert.equal(showing(r.decks[SLOTS.SECONDARY]), 'P');
});

check('an empty destination displays what arrives, because it is all there is', () => {
  const decks = { [SLOTS.PRIMARY]: deckOf('X', 'Y'), [SLOTS.SECONDARY]: createDeck() };
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY,
    to: SLOTS.SECONDARY,
    entryId: idOf(decks[SLOTS.PRIMARY], 'Y'),
    afterId: null,
  });
  assert.equal(r.ok, true);
  assert.equal(showing(r.decks[SLOTS.SECONDARY]), 'Y');
});

check('Move and show activates the arrival at the position it was dropped', () => {
  const decks = twoDecks();
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY,
    to: SLOTS.SECONDARY,
    entryId: idOf(decks[SLOTS.PRIMARY], 'Y'),
    afterId: idOf(decks[SLOTS.SECONDARY], 'P'),
    andShow: true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order(r.decks[SLOTS.SECONDARY]), ['P', 'Y', 'Q'], 'not reordered again');
  assert.equal(showing(r.decks[SLOTS.SECONDARY]), 'Y');
});

check('a same-pane reorder keeps showing what it was showing', () => {
  const decks = twoDecks();
  const deck = decks[SLOTS.PRIMARY];
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY,
    to: SLOTS.PRIMARY,
    entryId: idOf(deck, 'X'),                     // X is active
    afterId: idOf(deck, 'Y'),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order(r.decks[SLOTS.PRIMARY]), ['Y', 'X'], 'the order changed');
  assert.equal(showing(r.decks[SLOTS.PRIMARY]), 'X', 'moving the current entry does not hide it');
});

check('dropping an entry onto itself does nothing at all', () => {
  const decks = twoDecks();
  const same = idOf(decks[SLOTS.PRIMARY], 'X');
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY, to: SLOTS.PRIMARY, entryId: same, afterId: same,
  });
  assert.equal(r.ok, true);
  assert.equal(r.decks, decks, 'the very same object comes back');
});

check('the same PDF may not be moved into a deck that already holds it', () => {
  const decks = {
    [SLOTS.PRIMARY]: deckOf('shared', 'Y'),
    [SLOTS.SECONDARY]: deckOf('shared', 'Q'),
  };
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY,
    to: SLOTS.SECONDARY,
    entryId: idOf(decks[SLOTS.PRIMARY], 'shared'),
    afterId: idOf(decks[SLOTS.SECONDARY], 'Q'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DECK_ERRORS.DUPLICATE_RESOURCE);
  assert.ok(r.entry, 'and it names the entry that is already there, to locate it');
});

check('a refused move leaves both decks exactly as they were', () => {
  const decks = {
    [SLOTS.PRIMARY]: deckOf('shared', 'Y'),
    [SLOTS.SECONDARY]: deckOf('shared'),
  };
  const before = { a: order(decks[SLOTS.PRIMARY]), b: order(decks[SLOTS.SECONDARY]) };
  moveEntry(decks, {
    from: SLOTS.PRIMARY,
    to: SLOTS.SECONDARY,
    entryId: idOf(decks[SLOTS.PRIMARY], 'shared'),
    afterId: null,
  });
  assert.deepEqual(order(decks[SLOTS.PRIMARY]), before.a);
  assert.deepEqual(order(decks[SLOTS.SECONDARY]), before.b);
});

check('a same-pane reorder is not blocked by the entry\'s own resource', () => {
  // The duplicate check has to exclude the entry being moved, or every reorder
  // matches itself and nothing can ever be rearranged.
  const decks = { [SLOTS.PRIMARY]: deckOf('X', 'Y', 'Z'), [SLOTS.SECONDARY]: createDeck() };
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY,
    to: SLOTS.PRIMARY,
    entryId: idOf(decks[SLOTS.PRIMARY], 'X'),
    afterId: idOf(decks[SLOTS.PRIMARY], 'Z'),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order(r.decks[SLOTS.PRIMARY]), ['Y', 'Z', 'X']);
});

check('an anchor that is not there is refused rather than guessed at', () => {
  const decks = twoDecks();
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY,
    to: SLOTS.SECONDARY,
    entryId: idOf(decks[SLOTS.PRIMARY], 'Y'),
    afterId: 'e-deleted-while-the-dialog-was-open',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DECK_ERRORS.NO_SUCH_ANCHOR);
});

check('an entry that is not in the source is refused', () => {
  const r = moveEntry(twoDecks(), {
    from: SLOTS.PRIMARY, to: SLOTS.SECONDARY, entryId: 'nope', afterId: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DECK_ERRORS.NO_SUCH_ENTRY);
});

check('a moved entry keeps its id, and with it its page and its ink', () => {
  const decks = twoDecks();
  const movingId = idOf(decks[SLOTS.PRIMARY], 'Y');
  const r = moveEntry(decks, {
    from: SLOTS.PRIMARY, to: SLOTS.SECONDARY, entryId: movingId, afterId: null,
  });
  const landed = findByResource(r.decks[SLOTS.SECONDARY], 'Y');
  assert.equal(landed.id, movingId, 'moving is not reopening');
});

// ═══════════════════════════════════════════════════════════════
group('5. Workspace — decks in slots');

check('opening keeps what was there underneath', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { kind: ENTRY_KINDS.PDF, resourceId: 'answers' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { kind: ENTRY_KINDS.SCRATCH, resourceId: 'pad' }).state;

  assert.deepEqual(order(deckFor(s, SLOTS.PRIMARY)), ['pad', 'answers']);
  assert.equal(activeEntryIn(s, SLOTS.PRIMARY).resourceId, 'pad');
  assert.equal(s.documents[SLOTS.PRIMARY], 'pad', 'the derived mirror follows the active entry');
  assert.equal(s.documents[SLOTS.SECONDARY], null, 'the other slot is untouched');
});

check('reopening a resource already in the deck recalls it instead of duplicating', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'A' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'B' }).state;
  const r = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'A' });
  s = r.state;

  assert.deepEqual(order(deckFor(s, SLOTS.PRIMARY)), ['B', 'A'], 'no second copy, no reorder');
  assert.equal(activeEntryIn(s, SLOTS.PRIMARY).resourceId, 'A');
  assert.equal(r.entry.resourceId, 'A');
});

check('the same PDF may be open in BOTH slots', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'shared' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'shared' }).state;
  const a = activeEntryIn(s, SLOTS.PRIMARY);
  const b = activeEntryIn(s, SLOTS.SECONDARY);
  assert.notEqual(a.id, b.id, 'two entries, so two independent reading positions');
  assert.deepEqual(slotsWithResource(s, 'shared'), [SLOTS.PRIMARY, SLOTS.SECONDARY]);
});

check('a slot holding a scratchpad is occupied and gets room', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { kind: ENTRY_KINDS.SCRATCH, resourceId: 'pad' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'book' }).state;
  s = setDividerRatio(s, 0.4);
  assert.deepEqual(openSlots(s), [SLOTS.PRIMARY, SLOTS.SECONDARY]);
  assert.equal(paneFractions(s)[SLOTS.PRIMARY], 0.4);
});

check('cycling a slot changes only what it shows', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'A' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'B' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'other' }).state;

  const before = order(deckFor(s, SLOTS.PRIMARY));
  s = cycleInSlot(s, SLOTS.PRIMARY, 1);
  assert.deepEqual(order(deckFor(s, SLOTS.PRIMARY)), before, 'order untouched');
  assert.equal(s.documents[SLOTS.PRIMARY], 'A');
  assert.equal(s.documents[SLOTS.SECONDARY], 'other', 'the decks are independent');
});

check('removing the last entry of a focused slot releases the focus', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'A' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'B' }).state;
  s = toggleFocus(s, SLOTS.SECONDARY);
  s = removeFromSlot(s, SLOTS.SECONDARY, activeEntryIn(s, SLOTS.SECONDARY).id);
  assert.equal(s.focusedSlot, null, 'focus must not point at an empty pane');
  assert.deepEqual(openSlots(s), [SLOTS.PRIMARY]);
});

check('a move through the workspace keeps both decks consistent', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'A' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'pad' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'answers' }).state;

  const padId = findByResource(deckFor(s, SLOTS.PRIMARY), 'pad').id;
  const anchor = findByResource(deckFor(s, SLOTS.SECONDARY), 'answers').id;
  const r = moveEntryBetweenSlots(s, {
    from: SLOTS.PRIMARY, to: SLOTS.SECONDARY, entryId: padId, afterId: anchor,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order(deckFor(r.state, SLOTS.SECONDARY)), ['answers', 'pad']);
  assert.equal(r.state.documents[SLOTS.SECONDARY], 'answers', 'still showing the answer book');
  assert.equal(r.state.documents[SLOTS.PRIMARY], 'A', 'the source fell to what was underneath');
});

// ═══════════════════════════════════════════════════════════════
group('6. Collapse is not close (F08)');

check('a collapsed slot gives up its room and keeps its deck', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'A' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'B' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'C' }).state;
  s = setDividerRatio(s, 0.62);

  s = collapseSlot(s, SLOTS.PRIMARY);
  assert.equal(isCollapsed(s, SLOTS.PRIMARY), true);
  assert.equal(paneFractions(s)[SLOTS.PRIMARY], 0);
  assert.equal(paneFractions(s)[SLOTS.SECONDARY], 1);
  assert.equal(deckLength(deckFor(s, SLOTS.PRIMARY)), 2, 'nothing was closed');
  assert.deepEqual(openSlots(s), [SLOTS.PRIMARY, SLOTS.SECONDARY]);
});

check('restoring returns the split the reader had chosen', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'A' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'B' }).state;
  s = setDividerRatio(s, 0.62);
  s = collapseSlot(s, SLOTS.PRIMARY);
  s = setDividerRatio(s, 0);            // what the drag to the edge left behind
  s = restoreCollapsed(s);

  assert.equal(s.collapsedSlot, null);
  assert.equal(s.dividerRatio, 0.62, 'not 50:50, and not the 0 that meant collapse');
});

check('collapsing an empty slot is refused — there is nothing to bring back', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'B' }).state;
  assert.equal(collapseSlot(s, SLOTS.PRIMARY), s);
});

check('collapse and focus are never both claiming the same pane', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'A' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'B' }).state;
  s = toggleFocus(s, SLOTS.PRIMARY);
  s = collapseSlot(s, SLOTS.PRIMARY);
  assert.equal(s.focusedSlot, null);
  assert.equal(paneFractions(s)[SLOTS.SECONDARY], 1);
});

check('collapsed and restore state survive a restart', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'A' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'B' }).state;
  s = setDividerRatio(s, 0.31);
  s = collapseSlot(s, SLOTS.SECONDARY);

  const back = createWorkspaceState(serializeWorkspaceState(s));
  assert.equal(back.collapsedSlot, SLOTS.SECONDARY);
  assert.equal(back.restoreRatio, 0.31);
  assert.deepEqual(order(deckFor(back, SLOTS.PRIMARY)), ['A']);
});

// ═══════════════════════════════════════════════════════════════
group('7. Backwards compatibility');

check('a workspace saved as one-document-per-slot restores as one-entry decks', () => {
  const legacy = { documents: { [SLOTS.PRIMARY]: 'book', [SLOTS.SECONDARY]: 'key' } };
  const s = createWorkspaceState(legacy);
  assert.deepEqual(order(deckFor(s, SLOTS.PRIMARY)), ['book']);
  assert.deepEqual(order(deckFor(s, SLOTS.SECONDARY)), ['key']);
  assert.equal(s.documents[SLOTS.PRIMARY], 'book', 'and the old field still answers');
});

check('the serialised record still carries the old field for an older build', () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'book' }).state;
  const raw = serializeWorkspaceState(s);
  assert.equal(raw.documents[SLOTS.PRIMARY], 'book');
  assert.ok(Array.isArray(raw.decks[SLOTS.PRIMARY].entries));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
