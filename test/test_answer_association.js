#!/usr/bin/env node
// Answer association and hidden-answer lookup (F07).
//
// The behaviour this protects: the answer key is found by ASSOCIATION with the
// exercise book, not by "whatever PDF happens to be open on the other side".
// The old rule looks right until the day the other side is holding last year's
// key — at which point every individual comparison still looks fine and the
// answers are confidently wrong.
//
// And the second half: a key that is rotated underneath a scratchpad is still
// usable. Indexing is separate from rendering, so the lookup runs without
// replacing what either pane is showing.

import assert from 'node:assert/strict';

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
let storage = new FakeStorage();
globalThis.localStorage = new Proxy({}, {
  get: (_, prop) => (typeof storage[prop] === 'function' ? storage[prop].bind(storage) : storage[prop]),
});

const {
  answerFor, forgetPairsFor, rememberPair,
} = await import('../src/pdf/answer-association.js');
const { PdfWorkspace } = await import('../src/pdf/pdf-workspace.js');
const {
  SLOTS, createWorkspaceState, openInSlot, activeEntryIn, deckFor,
} = await import('../src/pdf/workspace-state.js');
const { ENTRY_KINDS } = await import('../src/pdf/deck-state.js');
const { DOC_ROLES } = await import('../src/pdf/pdf-library.js');

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function group(n) { console.log(`\n─── [${n}] ───`); }
async function check(label, fn) {
  storage = new FakeStorage();
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

/**
 * A workspace built from the prototype with only what the answer path uses.
 *
 * `roles` says what each library document is; `destroyed` records every
 * background handle that was released, which is how "a reader, not a renderer"
 * is checked.
 */
function makeWorkspace({ roles = {}, decks = {} } = {}) {
  const opened = [];
  const destroyed = [];
  let state = createWorkspaceState();
  for (const [slot, ids] of Object.entries(decks)) {
    for (const id of [...ids].reverse()) {
      state = openInSlot(state, slot, {
        kind: id.startsWith('pad') ? ENTRY_KINDS.SCRATCH : ENTRY_KINDS.PDF,
        resourceId: id,
      }).state;
    }
  }
  const ws = Object.create(PdfWorkspace.prototype);
  Object.assign(ws, {
    state,
    panes: {
      [SLOTS.PRIMARY]: { isLoaded: () => false },
      [SLOTS.SECONDARY]: { isLoaded: () => false },
    },
    _pdfLibrary: {
      async getDocumentMeta(id) {
        return roles[id] ? { id, name: id, role: roles[id], pageCount: 10 } : null;
      },
      async openStoredDocument(id) {
        opened.push(id);
        return {
          numPages: 10,
          getOutline: async () => ({ available: false, items: [] }),
          destroy() { destroyed.push(id); },
        };
      },
    },
    _setState(next) { this.state = next; },
  });
  return { ws, opened, destroyed };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Answer Association Tests — the key belongs to the book');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. The association itself');

await check('a pairing survives, and is looked up by the exercise book', async () => {
  rememberPair('book-2023', 'key-2023');
  assert.equal(answerFor('book-2023'), 'key-2023');
  assert.equal(answerFor('book-2024'), null, 'and says nothing about a book it has not seen');
});

await check('the pairing is independent of where either book sits', async () => {
  rememberPair('book', 'key');
  // Nothing about a slot, a side or a deck position is recorded — that is the
  // whole point: the panes can be swapped and either book rotated underneath.
  const raw = JSON.parse(storage.getItem('ls_answer_pairs'));
  assert.deepEqual(raw, { book: 'key' });
});

await check('re-pairing replaces rather than accumulating', async () => {
  rememberPair('book', 'key-2023');
  rememberPair('book', 'key-2024');
  assert.equal(answerFor('book'), 'key-2024');
});

await check('deleting either book drops the pairing that names it', async () => {
  rememberPair('book', 'key');
  forgetPairsFor('key');
  assert.equal(answerFor('book'), null,
    'a pairing pointing at bytes that are gone would send the next lookup after them');

  rememberPair('book2', 'key2');
  forgetPairsFor('book2');
  assert.equal(answerFor('book2'), null);
});

await check('storage being unavailable loses the pairing, not the lookup', async () => {
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  assert.equal(answerFor('anything'), null);
  assert.doesNotThrow(() => rememberPair('a', 'b'));
  assert.doesNotThrow(() => forgetPairsFor('a'));
  globalThis.localStorage = real;
});

// ═══════════════════════════════════════════════════════════════
group('2. Finding the key, wherever it is');

await check('the live pane is used when the key is on screen opposite', async () => {
  const { ws, opened } = makeWorkspace({
    roles: { book: DOC_ROLES.EXERCISE, key: DOC_ROLES.ANSWER },
    decks: { [SLOTS.PRIMARY]: ['book'], [SLOTS.SECONDARY]: ['key'] },
  });
  ws.panes[SLOTS.SECONDARY].isLoaded = () => true;
  rememberPair('book', 'key');

  const source = await ws._resolveAnswerSource(SLOTS.PRIMARY);
  assert.equal(source.resourceId, 'key');
  assert.equal(source.holder, ws.panes[SLOTS.SECONDARY], 'the pane that already has it');
  assert.deepEqual(opened, [], 'no second handle on the same bytes');
});

await check('a key hidden under a scratchpad is read in the background', async () => {
  const { ws, opened } = makeWorkspace({
    roles: { book: DOC_ROLES.EXERCISE, key: DOC_ROLES.ANSWER },
    // The pad was opened last, so it is in front and the key is underneath it.
    decks: { [SLOTS.PRIMARY]: ['book'], [SLOTS.SECONDARY]: ['pad-1', 'key'] },
  });
  rememberPair('book', 'key');
  assert.equal(activeEntryIn(ws.state, SLOTS.SECONDARY).resourceId, 'pad-1');

  const source = await ws._resolveAnswerSource(SLOTS.PRIMARY);
  assert.equal(source.resourceId, 'key');
  assert.deepEqual(opened, ['key'], 'indexed without being rendered');
  // And nothing moved: the pad is still what that pane is showing.
  assert.equal(activeEntryIn(ws.state, SLOTS.SECONDARY).resourceId, 'pad-1',
    'looking up an answer does not replace the scratchpad');
});

await check('a key in neither deck is still read, without opening a pane', async () => {
  const { ws, opened } = makeWorkspace({
    roles: { book: DOC_ROLES.EXERCISE, key: DOC_ROLES.ANSWER },
    decks: { [SLOTS.PRIMARY]: ['book'] },
  });
  rememberPair('book', 'key');

  const source = await ws._resolveAnswerSource(SLOTS.PRIMARY);
  assert.equal(source.resourceId, 'key');
  assert.deepEqual(opened, ['key']);
  assert.equal(deckFor(ws.state, SLOTS.SECONDARY).entries.length, 0,
    'opening it into a pane is what View original is for, and that is the reader\'s call');
});

await check('the background handle is cached, not reopened per page', async () => {
  const { ws, opened } = makeWorkspace({
    roles: { book: DOC_ROLES.EXERCISE, key: DOC_ROLES.ANSWER },
    decks: { [SLOTS.PRIMARY]: ['book'] },
  });
  rememberPair('book', 'key');
  await ws._resolveAnswerSource(SLOTS.PRIMARY);
  await ws._resolveAnswerSource(SLOTS.PRIMARY);
  await ws._resolveAnswerSource(SLOTS.PRIMARY);
  assert.deepEqual(opened, ['key'], 'indexing a 372-page key once is the point');
});

await check('a background handle is a reader, not a renderer', async () => {
  const { ws } = makeWorkspace({
    roles: { book: DOC_ROLES.EXERCISE, key: DOC_ROLES.ANSWER },
    decks: { [SLOTS.PRIMARY]: ['book'] },
  });
  rememberPair('book', 'key');
  const source = await ws._resolveAnswerSource(SLOTS.PRIMARY);
  assert.equal(source.holder.doc.numPages, 10, 'it has a document');
  assert.equal(source.holder.answerIndex, null, 'and somewhere to put an index');
  assert.equal(typeof source.holder.goToPage, 'function', 'and it goes nowhere');
});

await check('handles are released when the pair changes', async () => {
  const { ws, destroyed } = makeWorkspace({
    roles: { book: DOC_ROLES.EXERCISE, key: DOC_ROLES.ANSWER },
    decks: { [SLOTS.PRIMARY]: ['book'] },
  });
  rememberPair('book', 'key');
  await ws._resolveAnswerSource(SLOTS.PRIMARY);
  ws._invalidatePairCaches();
  assert.deepEqual(destroyed, ['key'],
    'a handle held across a change of book would answer out of the old key');
});

// ═══════════════════════════════════════════════════════════════
group('3. Inferring a pairing, once');

await check('the only answer-role book in the decks becomes the pairing', async () => {
  const { ws } = makeWorkspace({
    roles: { book: DOC_ROLES.EXERCISE, key: DOC_ROLES.ANSWER },
    decks: { [SLOTS.PRIMARY]: ['book'], [SLOTS.SECONDARY]: ['key'] },
  });
  const source = await ws._resolveAnswerSource(SLOTS.PRIMARY);
  assert.equal(source.resourceId, 'key');
  assert.equal(answerFor('book'), 'key', 'and it is recorded, so it is never guessed twice');
});

await check('two answer books in the decks are not guessed between', async () => {
  const { ws } = makeWorkspace({
    roles: {
      book: DOC_ROLES.EXERCISE, key2023: DOC_ROLES.ANSWER, key2024: DOC_ROLES.ANSWER,
    },
    decks: { [SLOTS.PRIMARY]: ['book'], [SLOTS.SECONDARY]: ['key2023', 'key2024'] },
  });
  const source = await ws._resolveAnswerSource(SLOTS.PRIMARY);
  assert.equal(source, null, 'the reader is asked rather than a year being picked for them');
});

await check('no answer book at all yields nothing, not a wrong one', async () => {
  const { ws } = makeWorkspace({
    roles: { book: DOC_ROLES.EXERCISE, other: DOC_ROLES.EXERCISE },
    decks: { [SLOTS.PRIMARY]: ['book'], [SLOTS.SECONDARY]: ['other'] },
  });
  assert.equal(await ws._resolveAnswerSource(SLOTS.PRIMARY), null,
    'another exercise book is not an answer key');
});

await check('a recorded pairing outranks whatever is open opposite', async () => {
  const { ws, opened } = makeWorkspace({
    roles: {
      book: DOC_ROLES.EXERCISE, right: DOC_ROLES.ANSWER, mine: DOC_ROLES.ANSWER,
    },
    decks: { [SLOTS.PRIMARY]: ['book'], [SLOTS.SECONDARY]: ['right'] },
  });
  ws.panes[SLOTS.SECONDARY].isLoaded = () => true;
  // The reader has already said which key belongs to this book.
  rememberPair('book', 'mine');

  const source = await ws._resolveAnswerSource(SLOTS.PRIMARY);
  assert.equal(source.resourceId, 'mine',
    'the association decides, not which book happens to be on the other side');
  assert.deepEqual(opened, ['mine']);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
