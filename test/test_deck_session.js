#!/usr/bin/env node
// Session tests (F06) — decks across a restart, and the version 1 migration.
//
// The acceptance requirement is that a restart brings back every deck, its
// order, each slot's active entry, the divider, the placement and the collapsed
// state — and that a user upgrading from the one-document-per-slot build does
// not lose the books they had open or the pages they were on.
//
// localStorage is stubbed, and the resource lookups are injected, so all of it
// runs in plain Node with no database and no browser.

import assert from 'node:assert/strict';

// ── a localStorage that behaves like the real one, including failing ─────────
class FakeStorage {
  constructor() { this.map = new Map(); this.failWrites = false; this.dropWrites = false; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.failWrites) {
      const e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    }
    // A storage that accepts a write and then has nothing to give back is the
    // nastiest of the three, because it looks like success.
    if (!this.dropWrites) this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
}

let storage = new FakeStorage();
globalThis.localStorage = new Proxy({}, {
  get: (_, prop) => (typeof storage[prop] === 'function'
    ? storage[prop].bind(storage)
    : storage[prop]),
});

const {
  restoreSession, saveSession, clearSession, viewForEntry,
} = await import('../src/pdf/document-session.js');
const {
  SLOTS, createWorkspaceState, openInSlot, deckFor, activeEntryIn,
  collapseSlot, setDividerRatio, swapSides, cycleInSlot,
} = await import('../src/pdf/workspace-state.js');
const { ENTRY_KINDS, findByResource } = await import('../src/pdf/deck-state.js');

const SESSION_KEY = 'ls_pdf_session';
const BACKUP_KEY = 'ls_pdf_session_v1';

/** Everything exists, unless the test says otherwise. */
const allPresent = {
  getDocumentMeta: async (id) => ({ id, name: id, pageCount: 100 }),
  getScratchpad: async (id) => ({ id, name: id }),
};
const missing = (...gone) => ({
  getDocumentMeta: async (id) => (gone.includes(id) ? null : { id, name: id, pageCount: 100 }),
  getScratchpad: async (id) => (gone.includes(id) ? null : { id, name: id }),
});

const order = (deck) => deck.entries.map(e => e.resourceId);

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function group(n) { console.log(`\n─── [${n}] ───`); }
async function check(label, fn) {
  storage = new FakeStorage();
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Session Tests — decks across a restart, and the v1 migration');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. A whole workspace comes back');

await check('every deck, its order and its active entry survive a restart', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'answers' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { kind: ENTRY_KINDS.SCRATCH, resourceId: 'pad' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'exercises' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'other' }).state;
  s = cycleInSlot(s, SLOTS.PRIMARY, 1);            // showing the pad
  saveSession(s, {});

  const back = await restoreSession(allPresent);
  assert.deepEqual(order(deckFor(back.workspace, SLOTS.PRIMARY)),
    ['exercises', 'pad', 'answers']);
  assert.equal(activeEntryIn(back.workspace, SLOTS.PRIMARY).resourceId, 'pad');
  assert.deepEqual(order(deckFor(back.workspace, SLOTS.SECONDARY)), ['other']);
  assert.equal(back.migrated, false);
});

await check('divider, placement and collapsed state come back with them', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'a' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'b' }).state;
  s = setDividerRatio(s, 0.37);
  s = swapSides(s);
  s = collapseSlot(s, SLOTS.SECONDARY);
  saveSession(s, {});

  const { workspace } = await restoreSession(allPresent);
  assert.equal(workspace.swapped, true);
  assert.equal(workspace.collapsedSlot, SLOTS.SECONDARY);
  assert.equal(workspace.restoreRatio, 0.37);
});

await check('each entry keeps its own page, including two entries on one book', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'shared' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: 'shared' }).state;
  const left = activeEntryIn(s, SLOTS.PRIMARY).id;
  const right = activeEntryIn(s, SLOTS.SECONDARY).id;

  saveSession(s, {
    [left]: { pageNumber: 12, zoom: 1, scrollX: 0, scrollY: 0, fitMode: 'page' },
    [right]: { pageNumber: 240, zoom: 1, scrollX: 0, scrollY: 0, fitMode: 'page' },
  });

  const back = await restoreSession(allPresent);
  assert.equal(back.views[left].pageNumber, 12);
  assert.equal(back.views[right].pageNumber, 240,
    'one resource, two entries, two reading positions');
});

await check('an entry rotated underneath keeps its page across many saves', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'buried' }).state;
  const buriedId = activeEntryIn(s, SLOTS.PRIMARY).id;
  saveSession(s, { [buriedId]: { pageNumber: 88, zoom: 1, scrollX: 0, scrollY: 0, fitMode: 'page' } });

  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'front' }).state;
  const frontId = activeEntryIn(s, SLOTS.PRIMARY).id;
  // The pane on screen reports only ITSELF, over and over, exactly as a pan does.
  for (let i = 0; i < 5; i++) {
    saveSession(s, { [frontId]: { pageNumber: i + 1, zoom: 1, scrollX: 0, scrollY: 0, fitMode: 'page' } });
  }

  const back = await restoreSession(allPresent);
  assert.equal(back.views[buriedId].pageNumber, 88,
    'the buried entry was not on screen to defend itself');
  assert.equal(back.views[frontId].pageNumber, 5);
});

await check('views of removed entries are pruned rather than accumulating', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'gone' }).state;
  const goneId = activeEntryIn(s, SLOTS.PRIMARY).id;
  saveSession(s, { [goneId]: { pageNumber: 4, zoom: 1, scrollX: 0, scrollY: 0, fitMode: 'page' } });

  const empty = createWorkspaceState();
  saveSession(empty, {});
  const raw = JSON.parse(storage.getItem(SESSION_KEY));
  assert.deepEqual(raw.views, {}, 'nothing is kept for an entry no deck holds');
  assert.equal(viewForEntry(goneId), null);
});

await check('no saved session yields a clean workspace rather than an error', async () => {
  const back = await restoreSession(allPresent);
  assert.deepEqual(back.dropped, []);
  assert.equal(back.workspace.documents[SLOTS.PRIMARY], null);
});

await check('an unreadable record is discarded, not half-applied', async () => {
  storage.setItem(SESSION_KEY, '{not json');
  const back = await restoreSession(allPresent);
  assert.equal(back.workspace.documents[SLOTS.PRIMARY], null);
});

await check('a record from a future version is left alone and not applied', async () => {
  storage.setItem(SESSION_KEY, JSON.stringify({ version: 99, workspace: {} }));
  const back = await restoreSession(allPresent);
  assert.equal(back.workspace.documents[SLOTS.PRIMARY], null);
  assert.equal(back.migrated, false);
});

// ═══════════════════════════════════════════════════════════════
group('2. A deleted resource costs its entry, not the deck');

await check('one missing book is dropped and the rest of the deck stands', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'keep-1' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'deleted' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'keep-2' }).state;
  saveSession(s, {});

  const back = await restoreSession(missing('deleted'));
  assert.deepEqual(order(deckFor(back.workspace, SLOTS.PRIMARY)), ['keep-2', 'keep-1']);
  assert.deepEqual(back.dropped, ['deleted']);
});

await check('losing the active entry falls to the next, never to nothing', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'survivor' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'deleted' }).state;   // active
  saveSession(s, {});

  const back = await restoreSession(missing('deleted'));
  assert.equal(activeEntryIn(back.workspace, SLOTS.PRIMARY).resourceId, 'survivor');
});

await check('a missing scratchpad is dropped by the same rule as a missing PDF', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'book' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { kind: ENTRY_KINDS.SCRATCH, resourceId: 'pad' }).state;
  saveSession(s, {});

  const back = await restoreSession(missing('pad'));
  assert.deepEqual(order(deckFor(back.workspace, SLOTS.PRIMARY)), ['book']);
  assert.deepEqual(back.dropped, ['pad']);
});

await check('a dropped entry takes its view with it', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'deleted' }).state;
  const id = activeEntryIn(s, SLOTS.PRIMARY).id;
  saveSession(s, { [id]: { pageNumber: 9, zoom: 1, scrollX: 0, scrollY: 0, fitMode: 'page' } });

  const back = await restoreSession(missing('deleted'));
  assert.equal(back.views[id], undefined);
});

// ═══════════════════════════════════════════════════════════════
group('3. Version 1 migration');

/** What the previous build wrote: one document and one view per slot. */
function writeV1({ a = 'exercise-book', b = 'answer-key', pageA = 40, pageB = 210 } = {}) {
  storage.setItem(SESSION_KEY, JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    workspace: {
      documents: { [SLOTS.PRIMARY]: a, [SLOTS.SECONDARY]: b },
      dividerRatio: 0.44,
      orientation: 'row',
      focusedSlot: null,
      swapped: true,
    },
    views: {
      [SLOTS.PRIMARY]: { pageNumber: pageA, zoom: 1, scrollX: 0, scrollY: 0, fitMode: 'page' },
      [SLOTS.SECONDARY]: { pageNumber: pageB, zoom: 1.5, scrollX: 10, scrollY: 20, fitMode: 'none' },
    },
  }));
}

await check('each occupied slot becomes a deck of exactly one entry', async () => {
  writeV1();
  const back = await restoreSession(allPresent);
  assert.equal(back.migrated, true);
  assert.deepEqual(order(deckFor(back.workspace, SLOTS.PRIMARY)), ['exercise-book']);
  assert.deepEqual(order(deckFor(back.workspace, SLOTS.SECONDARY)), ['answer-key']);
});

await check('the reader keeps the page they were on', async () => {
  writeV1();
  const back = await restoreSession(allPresent);
  const left = activeEntryIn(back.workspace, SLOTS.PRIMARY).id;
  const right = activeEntryIn(back.workspace, SLOTS.SECONDARY).id;
  assert.equal(back.views[left].pageNumber, 40);
  assert.equal(back.views[right].pageNumber, 210);
  assert.equal(back.views[right].zoom, 1.5, 'and their zoom');
});

await check('the layout comes across untouched', async () => {
  writeV1();
  const { workspace } = await restoreSession(allPresent);
  assert.equal(workspace.dividerRatio, 0.44);
  assert.equal(workspace.swapped, true);
});

await check('an empty slot migrates to an empty deck, not a phantom entry', async () => {
  storage.setItem(SESSION_KEY, JSON.stringify({
    version: 1,
    workspace: { documents: { [SLOTS.PRIMARY]: 'only', [SLOTS.SECONDARY]: null } },
    views: { [SLOTS.PRIMARY]: { pageNumber: 3, zoom: 1, scrollX: 0, scrollY: 0, fitMode: 'page' } },
  }));
  const { workspace } = await restoreSession(allPresent);
  assert.equal(deckFor(workspace, SLOTS.SECONDARY).entries.length, 0);
});

await check('the migrated record is written as version 2 and reads back', async () => {
  writeV1();
  await restoreSession(allPresent);
  const stored = JSON.parse(storage.getItem(SESSION_KEY));
  assert.equal(stored.version, 2);
  assert.ok(stored.workspace.decks[SLOTS.PRIMARY].entries.length === 1);
});

await check('the version 1 record is kept as a backup — only after the read-back', async () => {
  writeV1();
  const original = storage.getItem(SESSION_KEY);
  await restoreSession(allPresent);
  assert.equal(storage.getItem(BACKUP_KEY), original,
    'the original is preserved verbatim');
});

await check('a storage that cannot be written leaves version 1 exactly where it was', async () => {
  writeV1();
  const original = storage.getItem(SESSION_KEY);
  storage.failWrites = true;
  const back = await restoreSession(allPresent);
  storage.failWrites = false;

  assert.equal(back.migrated, false, 'the migration is not claimed');
  assert.equal(storage.getItem(SESSION_KEY), original, 'the old session is untouched');
  assert.equal(storage.getItem(BACKUP_KEY), null, 'and nothing was moved aside');
  // The workspace is still usable this session; only the write failed.
  assert.deepEqual(order(deckFor(back.workspace, SLOTS.PRIMARY)), ['exercise-book']);
});

await check('a storage that swallows writes does not count as a migration', async () => {
  writeV1();
  storage.dropWrites = true;
  const back = await restoreSession(allPresent);
  storage.dropWrites = false;
  assert.equal(back.migrated, false, 'a write that cannot be read back is not a write');
  assert.equal(storage.getItem(BACKUP_KEY), null);
});

await check('migrating twice is not possible — the second read is already version 2', async () => {
  writeV1();
  const first = await restoreSession(allPresent);
  const second = await restoreSession(allPresent);
  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.equal(activeEntryIn(second.workspace, SLOTS.PRIMARY).id,
    activeEntryIn(first.workspace, SLOTS.PRIMARY).id,
    'and the entry ids are stable, so the views still find their entries');
});

await check('a v1 book that has since been deleted migrates to an empty deck', async () => {
  writeV1();
  const back = await restoreSession(missing('answer-key'));
  assert.deepEqual(order(deckFor(back.workspace, SLOTS.PRIMARY)), ['exercise-book']);
  assert.equal(deckFor(back.workspace, SLOTS.SECONDARY).entries.length, 0);
  assert.deepEqual(back.dropped, ['answer-key']);
});

// ═══════════════════════════════════════════════════════════════
group('4. Storage failure is never data loss');

await check('a save that throws does not break the workspace', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'a' }).state;
  storage.failWrites = true;
  assert.doesNotThrow(() => saveSession(s, {}));
  storage.failWrites = false;
});

await check('clearing the session clears the cached views with it', async () => {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: 'a' }).state;
  const id = activeEntryIn(s, SLOTS.PRIMARY).id;
  saveSession(s, { [id]: { pageNumber: 7, zoom: 1, scrollX: 0, scrollY: 0, fitMode: 'page' } });
  assert.ok(viewForEntry(id));
  clearSession();
  assert.equal(viewForEntry(id), null, 'no stale view outlives the record it came from');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
