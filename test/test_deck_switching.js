#!/usr/bin/env node
// The handoff transaction (F06 §04, F08, F09, F10).
//
// This is the half of the deck work that the pure tests cannot see: not what a
// deck should look like afterwards, but what happens to the PANE on the way —
// and in particular what happens when the way does not work.
//
// The rule the specification is most insistent about, and the one that is
// easiest to get wrong: a failed switch must never blank a pane. A PdfPane
// holds one document, so preparing the target means releasing the source; if
// the target then fails, something has to put the source back.
//
// The panes are stubs. What is under test is the transaction — flush, prepare,
// commit, and the restore that failure owes the reader.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const $read = (f) => readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf-8');

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

// Focus mode puts a class on the body, which is the only DOM this file needs.
const bodyClasses = new Set();
globalThis.document = {
  body: {
    classList: {
      add: (c) => bodyClasses.add(c),
      remove: (c) => bodyClasses.delete(c),
      contains: (c) => bodyClasses.has(c),
    },
  },
};

const { PdfWorkspace } = await import('../src/pdf/pdf-workspace.js');
const {
  SLOTS, createWorkspaceState, openInSlot, activeEntryIn, deckFor, collapseSlot,
  setDividerRatio, focusSlot,
} = await import('../src/pdf/workspace-state.js');
const { ENTRY_KINDS, findByResource, deckLength } = await import('../src/pdf/deck-state.js');
const { initI18n, t } = await import('../src/core/i18n.js');
// 真的那一个，不是骨架里那个空的 _persist()——这条测试盯的正是存盘写下的
// 那份条目缓存，桩掉它就等于把要测的东西拿走了。
const { saveSession } = await import('../src/pdf/document-session.js');
await initI18n();

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function group(n) { console.log(`\n─── [${n}] ───`); }
async function check(label, fn) {
  storage = new FakeStorage();
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

/** A stand-in book pane: it knows whether it is loaded and what it holds. */
function stubPdfPane() {
  return {
    doc: null, meta: null, state: null,
    isLoaded() { return !!this.doc; },
    unload() { this.doc = null; this.meta = null; this.state = null; },
    // The real pane opens ON the view it is handed; a stub that ignores it
    // cannot see whether the right view was chosen, which is the whole
    // question in group 7.
    async loadDocument(doc, meta, view) {
      this.doc = doc;
      this.meta = meta;
      this.state = {
        pageNumber: view?.pageNumber || 1,
        pageCount: meta.pageCount || 1,
      };
      return true;
    },
    goToPage(n) { if (this.state) this.state = { ...this.state, pageNumber: n }; },
    resize() {},
    ink: { id: 'pdf-ink', canUndo: () => false, canRedo: () => false, clear() { this.cleared = true; } },
  };
}

/** And a stand-in pad pane, with the save gate the transaction consults. */
function stubScratchPane() {
  return {
    pad: null,
    saveState: 'saved',
    flushResult: true,
    flushed: 0,
    isLoaded() { return !!this.pad; },
    async flush() { this.flushed += 1; return this.flushResult; },
    async loadPad(pad) { this.pad = pad; return true; },
    unload() { this.pad = null; },
    resize() {},
    displayZoom() { return 100; },
    ink: { id: 'pad-ink', canUndo: () => false, canRedo: () => false, clear() { this.cleared = true; } },
  };
}

/**
 * A workspace with the DOM-touching leaves stubbed and the transaction real.
 *
 * `library` maps a resource id to what opening it does: a record, or a thrower.
 */
function makeWorkspace({ docs = {}, pads = {}, failOpen = new Set() } = {}) {
  const status = [];
  const ws = Object.create(PdfWorkspace.prototype);
  const scratch = { [SLOTS.PRIMARY]: stubScratchPane(), [SLOTS.SECONDARY]: stubScratchPane() };
  Object.assign(ws, {
    state: createWorkspaceState(),
    panes: { [SLOTS.PRIMARY]: stubPdfPane(), [SLOTS.SECONDARY]: stubPdfPane() },
    scratchPanes: scratch,
    strips: {},
    pads: {},
    _names: {},
    _switching: {}, _pending: {}, _openTokens: {}, _outlines: {},
    _pdfLibrary: {
      async getDocumentMeta(id) { return docs[id] ? { id, ...docs[id] } : null; },
      async openStoredDocument(id) {
        if (failOpen.has(id)) throw new Error('PDF_OPEN_FAILED');
        return {
          numPages: docs[id]?.pageCount || 1,
          getOutline: async () => ({ available: false, items: [] }),
          destroy() {},
        };
      },
      async getScratchpad(id) { return pads[id] ? { id, ...pads[id] } : null; },
    },
    // The leaves. Everything above them is the code under test.
    _setState(next) { this.state = next; },
    _layout() {}, _persist() {}, _resizePanes() {}, _syncSlotChrome() {},
    _resetOutline() {}, _renderOutline() {}, _invalidatePairCaches() {},
    _showPaneFor() {}, _unloadSlotDom() {}, _resolveNames() {},
    _setStatus(slot, message) { status.push([slot, message]); },
    _scratchPane(slot) { return scratch[slot]; },
    _markActive() {},
    _releaseAnswerHandles() {},
    // The close-a-scratchpad question and the delete that may follow it.
    deleted: [],
    deleteFails: false,
    _ask() { return Promise.resolve(null); },
    async _deleteScratchpad(id) {
      if (this.deleteFails) throw new Error('SCRATCH_DELETE_FAILED');
      this.deleted.push(id);
    },
  });
  return { ws, status, scratch, lastStatus: () => status.filter(s => s[1]).slice(-1)[0]?.[1] };
}

const showingIn = (ws, slot) => {
  const entry = activeEntryIn(ws.state, slot);
  if (!entry) return null;
  return entry.kind === ENTRY_KINDS.SCRATCH
    ? ws.scratchPanes[slot].pad?.id ?? null
    : ws.panes[slot].meta?.id ?? null;
};
const order = (ws, slot) => deckFor(ws.state, slot).entries.map(e => e.resourceId);

/** Puts a resource in a slot and shows it, the way the app does. */
async function open(ws, slot, resourceId, kind = ENTRY_KINDS.PDF) {
  const { state, entry } = openInSlot(ws.state, slot, { kind, resourceId });
  ws._setState(state);
  await ws.showEntry(slot, entry.id, { force: true });
  return entry;
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Handoff Tests — flush, prepare, commit, and what failure owes');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. The ordinary switch');

await check('opening puts the book on screen and keeps the deck', async () => {
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 10 }, B: { pageCount: 20 } } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.PRIMARY, 'B');
  assert.deepEqual(order(ws, SLOTS.PRIMARY), ['B', 'A'], 'inserted before the active entry');
  assert.equal(showingIn(ws, SLOTS.PRIMARY), 'B');
});

await check('cycling shows the next entry without touching the order', async () => {
  const { ws } = makeWorkspace({ docs: { A: {}, B: {} } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.PRIMARY, 'B');
  ws.cycleSlot(SLOTS.PRIMARY, 1);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(showingIn(ws, SLOTS.PRIMARY), 'A');
  assert.deepEqual(order(ws, SLOTS.PRIMARY), ['B', 'A']);
});

await check('a pad and a book swap the pane between them', async () => {
  const { ws, scratch } = makeWorkspace({ docs: { A: {} }, pads: { pad: { name: 'Pad' } } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.PRIMARY, 'pad', ENTRY_KINDS.SCRATCH);
  assert.equal(scratch[SLOTS.PRIMARY].isLoaded(), true, 'the pad is up');
  assert.equal(ws.panes[SLOTS.PRIMARY].isLoaded(), false, 'and the book is released');

  const back = findByResource(deckFor(ws.state, SLOTS.PRIMARY), 'A');
  await ws.showEntry(SLOTS.PRIMARY, back.id);
  assert.equal(ws.panes[SLOTS.PRIMARY].isLoaded(), true);
  assert.equal(scratch[SLOTS.PRIMARY].isLoaded(), false, 'never two loaded views in one slot');
});

await check('showing what is already showing is a no-op', async () => {
  const { ws } = makeWorkspace({ docs: { A: {} } });
  const entry = await open(ws, SLOTS.PRIMARY, 'A');
  const before = ws.panes[SLOTS.PRIMARY].doc;
  await ws.showEntry(SLOTS.PRIMARY, entry.id);
  assert.equal(ws.panes[SLOTS.PRIMARY].doc, before, 'the document was not reopened');
});

// ═══════════════════════════════════════════════════════════════
group('2. A failed switch never blanks the pane');

await check('a book that will not open leaves the previous one on screen', async () => {
  const { ws, lastStatus } = makeWorkspace({
    docs: { good: { pageCount: 5 }, broken: { pageCount: 5 } },
    failOpen: new Set(['broken']),
  });
  await open(ws, SLOTS.PRIMARY, 'good');
  const { state, entry } = openInSlot(ws.state, SLOTS.PRIMARY, {
    kind: ENTRY_KINDS.PDF, resourceId: 'broken',
  });
  ws._setState(state);

  const ok = await ws.showEntry(SLOTS.PRIMARY, entry.id, { force: true });
  assert.equal(ok, false, 'the switch is reported as failed');
  assert.equal(ws.panes[SLOTS.PRIMARY].isLoaded(), true, 'the pane is not blank');
  assert.equal(showingIn(ws, SLOTS.PRIMARY), 'good', 'and it is showing what it was');
  assert.equal(activeEntryIn(ws.state, SLOTS.PRIMARY).resourceId, 'good',
    'the active entry never moved to the file that would not open');
  assert.ok(lastStatus(), 'and the reader is told why');
});

await check('a missing scratchpad leaves the book that was there', async () => {
  const { ws } = makeWorkspace({ docs: { A: {} }, pads: {} });
  await open(ws, SLOTS.PRIMARY, 'A');
  const { state, entry } = openInSlot(ws.state, SLOTS.PRIMARY, {
    kind: ENTRY_KINDS.SCRATCH, resourceId: 'gone',
  });
  ws._setState(state);

  assert.equal(await ws.showEntry(SLOTS.PRIMARY, entry.id, { force: true }), false);
  assert.equal(showingIn(ws, SLOTS.PRIMARY), 'A');
  assert.equal(ws.panes[SLOTS.PRIMARY].isLoaded(), true);
});

await check('a pad that cannot be saved stops the switch before anything is released', async () => {
  const { ws, scratch } = makeWorkspace({
    docs: { A: {} }, pads: { pad: { name: 'Pad' } },
  });
  await open(ws, SLOTS.PRIMARY, 'pad', ENTRY_KINDS.SCRATCH);
  scratch[SLOTS.PRIMARY].flushResult = false;         // the write fails

  const { state, entry } = openInSlot(ws.state, SLOTS.PRIMARY, {
    kind: ENTRY_KINDS.PDF, resourceId: 'A',
  });
  ws._setState(state);
  assert.equal(await ws.showEntry(SLOTS.PRIMARY, entry.id, { force: true }), false);
  assert.equal(scratch[SLOTS.PRIMARY].isLoaded(), true,
    'the only unsaved copy is still resident');
  assert.equal(ws.panes[SLOTS.PRIMARY].isLoaded(), false, 'and nothing was opened over it');
});

await check('a failure on the very first open leaves an empty pane, honestly', async () => {
  const { ws } = makeWorkspace({ docs: { broken: {} }, failOpen: new Set(['broken']) });
  const { state, entry } = openInSlot(ws.state, SLOTS.PRIMARY, {
    kind: ENTRY_KINDS.PDF, resourceId: 'broken',
  });
  ws._setState(state);
  assert.equal(await ws.showEntry(SLOTS.PRIMARY, entry.id, { force: true }), false);
  // Nothing was on screen to restore, and pretending otherwise would be worse.
  assert.equal(ws.panes[SLOTS.PRIMARY].isLoaded(), false);
});

await check('a restore that also fails gives up rather than looping', async () => {
  const { ws } = makeWorkspace({
    docs: { first: {}, second: {} },
    failOpen: new Set(),
  });
  await open(ws, SLOTS.PRIMARY, 'first');
  // Both the target and the source break, which is what a device running out
  // of storage mid-session looks like.
  ws._pdfLibrary.openStoredDocument = async () => { throw new Error('PDF_OPEN_FAILED'); };
  const { state, entry } = openInSlot(ws.state, SLOTS.PRIMARY, {
    kind: ENTRY_KINDS.PDF, resourceId: 'second',
  });
  ws._setState(state);
  assert.equal(await ws.showEntry(SLOTS.PRIMARY, entry.id, { force: true }), false);
  assert.equal(ws.panes[SLOTS.PRIMARY].isLoaded(), false, 'it stopped, rather than retrying forever');
});

// ═══════════════════════════════════════════════════════════════
group('2b. The floating toolbar reaches what is on screen');

await check('the ink toolbar talks to the pad when a pad is showing', async () => {
  // It used to ask for `panes[slot].ink`, which is only ever the BOOK's
  // surface. On a scratchpad every tool, colour and width went to a surface
  // nobody was drawing on, and the pad kept the single tool its constructor
  // gave it — so on paper the toolbar did nothing and every stroke came out
  // the same.
  const { ws } = makeWorkspace({ docs: { A: {} }, pads: { pad: { name: 'Pad' } } });
  await open(ws, SLOTS.PRIMARY, 'A');
  ws.activeSlot = SLOTS.PRIMARY;
  assert.equal(ws._loadedViewIn(SLOTS.PRIMARY).ink.id, 'pdf-ink', 'a book reaches the book');

  await open(ws, SLOTS.PRIMARY, 'pad', ENTRY_KINDS.SCRATCH);
  assert.equal(ws._loadedViewIn(SLOTS.PRIMARY).ink.id, 'pad-ink',
    'and a pad reaches the pad');
});

await check('clearing ink clears the surface on screen, not the one beneath', async () => {
  const { ws, scratch } = makeWorkspace({ docs: { A: {} }, pads: { pad: { name: 'Pad' } } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.PRIMARY, 'pad', ENTRY_KINDS.SCRATCH);
  ws.activeSlot = SLOTS.PRIMARY;

  ws._loadedViewIn(SLOTS.PRIMARY).ink.clear();
  assert.equal(scratch[SLOTS.PRIMARY].ink.cleared, true);
  assert.notEqual(ws.panes[SLOTS.PRIMARY].ink.cleared, true, 'the book was not touched');
});

await check('an empty slot offers no surface at all', async () => {
  const { ws } = makeWorkspace({ docs: {} });
  ws.activeSlot = SLOTS.PRIMARY;
  assert.equal(ws._loadedViewIn(SLOTS.PRIMARY), null);
});

// ═══════════════════════════════════════════════════════════════
group('3. Removing');

await check('removing the shown entry falls to what was underneath', async () => {
  const { ws } = makeWorkspace({ docs: { A: {}, B: {} } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.PRIMARY, 'B');
  const showing = activeEntryIn(ws.state, SLOTS.PRIMARY);
  await ws.removeEntry(SLOTS.PRIMARY, showing.id);
  assert.deepEqual(order(ws, SLOTS.PRIMARY), ['A']);
  assert.equal(showingIn(ws, SLOTS.PRIMARY), 'A', 'the pane did not go blank');
});

await check('removing a background entry does not disturb the foreground', async () => {
  const { ws } = makeWorkspace({ docs: { A: {}, B: {} } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.PRIMARY, 'B');
  const buried = findByResource(deckFor(ws.state, SLOTS.PRIMARY), 'A');
  const doc = ws.panes[SLOTS.PRIMARY].doc;
  await ws.removeEntry(SLOTS.PRIMARY, buried.id);
  assert.deepEqual(order(ws, SLOTS.PRIMARY), ['B']);
  assert.equal(ws.panes[SLOTS.PRIMARY].doc, doc, 'the shown book was not reloaded');
});

await check('a deleted resource is taken out of both decks', async () => {
  const { ws } = makeWorkspace({ docs: { shared: {}, other: {} } });
  await open(ws, SLOTS.PRIMARY, 'shared');
  await open(ws, SLOTS.SECONDARY, 'other');
  await open(ws, SLOTS.SECONDARY, 'shared');

  await ws.forgetResource('shared');
  assert.deepEqual(order(ws, SLOTS.PRIMARY), []);
  assert.deepEqual(order(ws, SLOTS.SECONDARY), ['other']);
  assert.equal(showingIn(ws, SLOTS.SECONDARY), 'other',
    'the pane showing it fell to what was underneath');
});

// ═══════════════════════════════════════════════════════════════
group('4. Moving between panes');

await check('a background move leaves both panes showing what they were', async () => {
  const { ws } = makeWorkspace({ docs: { A: {}, B: {}, C: {} } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.PRIMARY, 'B');
  await open(ws, SLOTS.SECONDARY, 'C');

  const buried = findByResource(deckFor(ws.state, SLOTS.PRIMARY), 'A');
  const anchor = activeEntryIn(ws.state, SLOTS.SECONDARY);
  const result = await ws._applyMove({
    from: SLOTS.PRIMARY, to: SLOTS.SECONDARY, entryId: buried.id, afterId: anchor.id,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order(ws, SLOTS.SECONDARY), ['C', 'A']);
  assert.equal(showingIn(ws, SLOTS.PRIMARY), 'B');
  assert.equal(showingIn(ws, SLOTS.SECONDARY), 'C');
});

await check('moving the shown entry away brings the source down to the next', async () => {
  const { ws } = makeWorkspace({ docs: { A: {}, B: {}, C: {} } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.PRIMARY, 'B');
  await open(ws, SLOTS.SECONDARY, 'C');

  const showing = activeEntryIn(ws.state, SLOTS.PRIMARY);
  await ws._applyMove({
    from: SLOTS.PRIMARY,
    to: SLOTS.SECONDARY,
    entryId: showing.id,
    afterId: activeEntryIn(ws.state, SLOTS.SECONDARY).id,
  });
  assert.equal(showingIn(ws, SLOTS.PRIMARY), 'A', 'the source fell to what was underneath');
  assert.equal(showingIn(ws, SLOTS.SECONDARY), 'C', 'the destination is undisturbed');
});

await check('moving the only entry away empties the source pane', async () => {
  const { ws } = makeWorkspace({ docs: { A: {}, C: {} } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.SECONDARY, 'C');
  const showing = activeEntryIn(ws.state, SLOTS.PRIMARY);
  await ws._applyMove({
    from: SLOTS.PRIMARY,
    to: SLOTS.SECONDARY,
    entryId: showing.id,
    afterId: activeEntryIn(ws.state, SLOTS.SECONDARY).id,
  });
  assert.equal(deckLength(deckFor(ws.state, SLOTS.PRIMARY)), 0);
  assert.equal(ws.panes[SLOTS.PRIMARY].isLoaded(), false, 'and releases its renderer');
});

// ═══════════════════════════════════════════════════════════════
group('5. Collapse and focus');

await check('collapsing keeps the whole deck and the split to come back to', async () => {
  const { ws } = makeWorkspace({ docs: { A: {}, B: {}, C: {} } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.PRIMARY, 'B');
  await open(ws, SLOTS.SECONDARY, 'C');
  ws._setState(setDividerRatio(ws.state, 0.66));

  ws.collapsePane(SLOTS.PRIMARY, 0.66);
  assert.equal(ws.state.collapsedSlot, SLOTS.PRIMARY);
  assert.equal(deckLength(deckFor(ws.state, SLOTS.PRIMARY)), 2, 'nothing was closed');

  ws.restorePane();
  assert.equal(ws.state.collapsedSlot, null);
  assert.equal(ws.state.dividerRatio, 0.66);
});

await check('collapsing an empty pane closes it instead', async () => {
  const { ws } = makeWorkspace({ docs: { C: {} } });
  await open(ws, SLOTS.SECONDARY, 'C');
  ws.collapsePane(SLOTS.PRIMARY, 0.5);
  assert.equal(ws.state.collapsedSlot, null, 'there is nothing to bring back');
});

await check('focus restores the divider, and the collapse it was entered from', async () => {
  const { ws } = makeWorkspace({ docs: { A: {} }, pads: { pad: { name: 'Pad' } } });
  await open(ws, SLOTS.PRIMARY, 'pad', ENTRY_KINDS.SCRATCH);
  await open(ws, SLOTS.SECONDARY, 'A');
  ws._setState(setDividerRatio(ws.state, 0.4));
  ws._setState(collapseSlot(ws.state, SLOTS.SECONDARY));

  ws.enterFocus(SLOTS.PRIMARY);
  assert.equal(ws.focusSlot, SLOTS.PRIMARY);
  assert.equal(ws.state.collapsedSlot, null,
    'focus and collapse are not both claiming the workspace');

  ws.exitFocus();
  assert.equal(ws.focusSlot, null);
  assert.equal(ws.state.dividerRatio, 0.4, 'the split comes back');
  assert.equal(ws.state.collapsedSlot, SLOTS.SECONDARY, 'and so does the collapse');
});

await check('focus never rolls back a switch made while focused', async () => {
  const { ws } = makeWorkspace({
    docs: { A: {} }, pads: { pad1: { name: 'One' }, pad2: { name: 'Two' } },
  });
  await open(ws, SLOTS.PRIMARY, 'pad1', ENTRY_KINDS.SCRATCH);
  await open(ws, SLOTS.SECONDARY, 'A');
  ws.enterFocus(SLOTS.PRIMARY);

  // A second pad is opened while focused; leaving focus must not undo it.
  await open(ws, SLOTS.PRIMARY, 'pad2', ENTRY_KINDS.SCRATCH);
  ws.exitFocus();
  assert.equal(showingIn(ws, SLOTS.PRIMARY), 'pad2');
  assert.deepEqual(order(ws, SLOTS.PRIMARY), ['pad2', 'pad1']);
});

await check('focus is refused for a book — it is a scratchpad mode', async () => {
  const { ws } = makeWorkspace({ docs: { A: {} } });
  await open(ws, SLOTS.PRIMARY, 'A');
  ws.enterFocus(SLOTS.PRIMARY);
  assert.equal(ws.focusSlot, undefined);
});

// ═══════════════════════════════════════════════════════════════
group('2c. Stepping aside for an open list');

// The bar used to be display:none'd for as long as a list was up: it did not
// move out of the way, it stopped existing, and came back out of nowhere. What
// replaces it has to answer two questions — DOES it need to move, and WHERE
// to — and the first is the one worth testing, because a bar that hops into a
// corner every time any list opens anywhere is the app fidgeting at the reader.

const rect = (left, top, right, bottom) => ({
  left, top, right, bottom, x: left, y: top,
  width: right - left, height: bottom - top,
});

/** A workspace carrying a toolbar that only records what it was asked to do. */
function withToolbar(barRect) {
  const { ws } = makeWorkspace({ docs: { A: {} } });
  const calls = [];
  ws.root = { getBoundingClientRect: () => rect(0, 0, 1000, 800) };
  ws.toolbar = {
    yielded: false,
    rect: () => barRect,
    isYielded() { return this.yielded; },
    yieldTo(corners, avoid) { this.yielded = true; calls.push(['yieldTo', corners, avoid]); },
    restoreFromYield() { this.yielded = false; calls.push(['restore']); },
  };
  return { ws, calls };
}

// The bar down the left edge, where it sits by default.
const LEFT_BAR = rect(10, 200, 66, 620);
/** A panel that knows which column it is in, the way a real one does. */
const listIn = (col, box) => ({
  getBoundingClientRect: () => box,
  closest: (sel) => (sel === '.pdf-ws-slot' ? { getBoundingClientRect: () => col } : null),
});
const COL_LEFT = rect(6, 70, 590, 730);
const COL_RIGHT = rect(610, 70, 1194, 730);
const LEFT_LIST = () => listIn(COL_LEFT, rect(20, 150, 460, 700));

// 「对照本页答案」那块面板也算一块盖上来的东西。
//
// 它和单子、找页面板是同一类：盖在某一栏上、在笔迹栏下面、打开来是要读的。但它
// 一直不在 _openOverlay 那张表里，于是答案一出来，笔迹栏就杵在上面不动——正是人
// 报的「打开答案匹配时菜单和工具栏冲突」。
await check('答案面板也在「会挡住笔迹栏」那张表里', async () => {
  const src = $read('src/pdf/pdf-workspace.js');
  const body = src.slice(src.indexOf('  _openOverlay() {'), src.indexOf('  _renderOutline('));
  assert.ok(body.includes("'answer-panel'"), '答案面板要在表里');
  // 顺序就是叠放顺序：单子 z-index 30，找页面板 24，答案面板在文档流里最下面。
  const order = ['deck-list', 'outline-panel', 'answer-panel'].map(r => body.indexOf(r));
  assert.ok(order[0] < order[1] && order[1] < order[2], '按从上到下排，最上面的先返回');
});

await check('答案面板的高度变化也要重新判一次冲突', async () => {
  // 它的高度是内容撑出来的（最高 48%）：一条「请先指定答案册」的提示和一整页匹配
  // 结果差很多，而这两种高度下笔迹栏该不该让位可能是两个答案。栏本身的尺寸不会跟
  // 着变，所以只观察栏是看不见这件事的。
  const src = $read('src/pdf/pdf-workspace.js');
  const body = src.slice(src.indexOf('  _watchSlotSizes() {'), src.indexOf('  // ── state → DOM'));
  assert.ok(/observe\(answers\)/.test(body), '答案面板要被单独观察');
  assert.ok(/_reviewToolbarConflict\(\)/.test(body), '——而回调里要重判冲突');
});

await check('a list the bar is lying across folds it into that column bottom corner', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(LEFT_LIST());
  assert.equal(calls.length, 1, 'it moved');
  assert.equal(calls[0][0], 'yieldTo');
  assert.equal(calls[0][1], 'bottom-left', 'the bottom of the column the list is in');
});

await check('a list in the OTHER column leaves the bar exactly where it is', async () => {
  // Nothing is covered, so nothing may move. This is the whole reason the
  // collision is measured rather than assumed.
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(listIn(COL_RIGHT, rect(620, 150, 960, 700)));
  assert.deepEqual(calls, [], 'no animation was triggered at all');
});

await check('a list touching the bar edge-to-edge is not a collision', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(listIn(COL_LEFT, rect(66, 150, 460, 700)));
  assert.deepEqual(calls, []);
});

await check('a list in the right column sends the bar to the right corner', async () => {
  const { ws, calls } = withToolbar(rect(930, 200, 986, 620));
  ws._yieldToolbarAround(listIn(COL_RIGHT, rect(620, 150, 960, 700)));
  assert.equal(calls[0][1], 'bottom-right');
});

await check('the bar never crosses the divider to find room', async () => {
  // A left conflict goes bottom-left and nowhere else. Offering the far corner
  // as a fallback would carry the bar into the column it was not serving.
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(LEFT_LIST());
  assert.equal(calls[0][1], 'bottom-left');
  assert.equal(calls[0][2], undefined, 'no second choice is offered at all');
});

await check('a tall list still only ever gets that column corner', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(listIn(COL_LEFT, rect(20, 90, 560, 728)));
  assert.equal(calls[0][1], 'bottom-left', 'covered or not, it is the column that decides');
});

await check('a swapped split follows the column, not the slot name', async () => {
  // The panes can be swapped, and then slot b is the LEFT column. The corner
  // comes from where the column actually is.
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(listIn(COL_LEFT, rect(20, 150, 460, 700)));
  assert.equal(calls[0][1], 'bottom-left');
});

await check('closing every list hands the placement back', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(LEFT_LIST());
  ws._yieldToolbarAround(null);
  assert.deepEqual(calls.map(c => c[0]), ['yieldTo', 'restore']);
});

await check('a second list does not move an already-folded bar', async () => {
  // Two strips, one bar. The first list folded it away; the second must not
  // set it off again, or the puck skates from corner to corner.
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(LEFT_LIST());
  ws._yieldToolbarAround(LEFT_LIST());
  assert.equal(calls.filter(c => c[0] === 'yieldTo').length, 1);
});

await check('the find-a-page panel is treated exactly like the list', async () => {
  // Same kind of thing: a slab laid over one column, under the ink bar, opened
  // to be read. So it gets the same rule — fold to that column's floor when it
  // is actually covered, stay put when it is not.
  const { ws, calls } = withToolbar(LEFT_BAR);
  const panel = listIn(COL_LEFT, rect(20, 150, 460, 700));
  panel.getBoundingClientRect = () => rect(20, 150, 460, 700);
  ws._yieldToolbarAround(panel);
  assert.equal(calls[0][1], 'bottom-left', 'folded, just as a list would');
});

await check('a panel in the other column leaves the bar alone too', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(listIn(COL_RIGHT, rect(620, 150, 960, 700)));
  assert.deepEqual(calls, [], 'no conflict, no movement — same as a list');
});

await check('closing everything hands the bar back, whichever slab it was', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(LEFT_LIST());
  ws._yieldToolbarAround(null);
  assert.deepEqual(calls.map(c => c[0]), ['yieldTo', 'restore']);
});

// A panel keeps its own open flag, and its column can go out from under it.

/** A root holding panels, each either on screen or measuring nothing. */
function rootWithPanels(panels) {
  const els = panels.map((box) => ({
    getBoundingClientRect: () => box,
    closest: () => ({ getBoundingClientRect: () => COL_LEFT }),
  }));
  return {
    getBoundingClientRect: () => rect(0, 0, 1000, 800),
    querySelectorAll: (sel) => (sel.includes('outline-panel') ? els : []),
    querySelector: (sel) => (sel.includes('outline-panel') ? els[0] || null : null),
  };
}

await check('a panel whose column has left the screen is not in front of anything', async () => {
  // Tap 专注 on the other pane and the column holding an open table of contents
  // is taken out of the flow — with the panel still marked open, measuring 0
  // by 0. That empty answer used to be enough to keep the bar folded in its
  // corner, with nothing on screen the reader could close to get it back.
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws.root = rootWithPanels([rect(0, 0, 0, 0)]);
  ws.toolbar.yielded = true;

  assert.equal(ws._openOverlay(), null, 'nothing visible is covering the page');
  ws._reviewToolbarConflict();
  assert.deepEqual(calls, [['restore']], 'so the bar comes home');
});

await check('a panel that IS on screen still counts', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws.root = rootWithPanels([rect(0, 0, 0, 0), rect(20, 150, 460, 700)]);
  assert.ok(ws._openOverlay(), 'the second one is real');
  ws._reviewToolbarConflict();
  assert.equal(calls[0][0], 'yieldTo', 'and the bar steps aside for it');
  assert.equal(calls[0][1], 'bottom-left');
});

// ── one open file ──────────────────────────────────────────────────────────
//
// Everything above was written with two columns in mind, and only two columns
// were ever right. With ONE file open the column is the whole workspace, so
// "which half is the column's midpoint in" compares the centre with itself:
// never less than, always the bottom right. A panel conflicting on the LEFT
// sent the bar across the screen to the far corner.
//
// A column owns the workspace corners its own span reaches. When it owns both,
// the bar's own side decides — stepping aside is a short move, not a journey.

const WHOLE = rect(0, 64, 1200, 736);

await check('one open file: a bar on the left folds to the LEFT corner', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws._yieldToolbarAround(listIn(WHOLE, rect(20, 150, 1180, 700)));
  assert.equal(calls[0][1], 'bottom-left',
    'it steps aside, it does not cross the screen');
});

await check('one open file: a bar on the right folds to the RIGHT corner', async () => {
  const { ws, calls } = withToolbar(rect(1130, 200, 1190, 620));
  ws._yieldToolbarAround(listIn(WHOLE, rect(20, 150, 1180, 700)));
  assert.equal(calls[0][1], 'bottom-right');
});

await check('two columns still go by the column, not by the bar', async () => {
  // A bar that has wandered over the divider still belongs to the column whose
  // panel is open: the far corner there is in the OTHER column.
  const { ws, calls } = withToolbar(rect(400, 200, 460, 620));
  ws._yieldToolbarAround(listIn(COL_LEFT, rect(20, 150, 460, 700)));
  assert.equal(calls[0][1], 'bottom-left',
    'the left column owns only the left corner, wherever the bar happens to be');
});

await check('the corner rule is a function of geometry alone', async () => {
  // Stated directly, so the three cases are readable without a whole workspace.
  const { ws } = makeWorkspace({ docs: {} });
  ws.root = { getBoundingClientRect: () => WHOLE };
  const onLeft = rect(10, 200, 66, 620);
  const onRight = rect(1130, 200, 1190, 620);
  assert.equal(ws._cornerFor(COL_LEFT, WHOLE, onRight), 'bottom-left',
    'left column owns the left corner only');
  assert.equal(ws._cornerFor(COL_RIGHT, WHOLE, onLeft), 'bottom-right',
    'right column owns the right corner only');
  assert.equal(ws._cornerFor(WHOLE, WHOLE, onLeft), 'bottom-left',
    'a column that owns both defers to the bar');
  assert.equal(ws._cornerFor(WHOLE, WHOLE, onRight), 'bottom-right');
});

await check('no toolbar yet is not a crash', async () => {
  const { ws } = makeWorkspace({ docs: {} });
  ws.toolbar = null;
  assert.doesNotThrow(() => ws._yieldToolbarAround(null));
});

// ── 两块面板同时开着 ─────────────────────────────────────────────────────────
//
// 用户录的屏：右栏开着缩略图，左栏开单子、开缩略图。原来这里一次只接得住一块
// ——「现在开着的第一块」——于是：
//   · 左栏单子关了，横杠也不回来：「还有东西开着」（右栏那块）；
//   · 点开那颗球之后再开左栏的单子、缩略图，横杠压在上面不让：它以为自己还让着。
// 两边都一样。

const RIGHT_THUMBS = () => listIn(COL_RIGHT, rect(620, 150, 1180, 460));
const LEFT_THUMBS = () => listIn(COL_LEFT, rect(20, 150, 580, 460));

await check('另一栏开着缩略图时，这一栏再开一块照样让', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  const right = RIGHT_THUMBS();
  ws._yieldToolbarAround([right]);
  assert.deepEqual(calls, [], '右栏那块压不着左边的横杠');
  ws._yieldToolbarAround([right, LEFT_THUMBS()]);
  assert.equal(calls.length, 1, '左栏这块压着它了，就让——不管排在前头的是谁');
  assert.equal(calls[0][1], 'bottom-left');
});

await check('让开之后，另一栏还开着的面板不拦着它回来', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws.toolbar.homeRect = () => LEFT_BAR;
  const right = RIGHT_THUMBS();
  ws._yieldToolbarAround([right, LEFT_LIST()]);
  assert.equal(calls[0][0], 'yieldTo');
  ws._yieldToolbarAround([right]);   // 左栏的单子关了，右栏的缩略图还开着
  assert.deepEqual(calls.map(c => c[0]), ['yieldTo', 'restore'],
    '回去的那个位置上没压着东西就还——屏幕上还开着别的，和这件事无关');
});

await check('回去的位置上还压着别的一块：接着让着', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  ws.toolbar.homeRect = () => LEFT_BAR;
  ws._yieldToolbarAround([LEFT_LIST()]);
  ws._yieldToolbarAround([LEFT_THUMBS()]);   // 单子关了，这一栏又开着缩略图
  assert.deepEqual(calls.map(c => c[0]), ['yieldTo'], '回去就又被压住，那就不回');
});

/** 一个根节点：开着哪几块面板、工作区量出来多大，都由测试说了算。 */
function rootWith(getOpen, getSize = () => rect(0, 0, 1000, 800)) {
  return {
    getBoundingClientRect: () => getSize(),
    querySelectorAll: (sel) => (sel.includes('outline-panel') ? getOpen() : []),
    querySelector: () => null,
  };
}

await check('人亲手把球点开：这时已经开着的面板不再赶它；关了再开是新的一次', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  const panel = LEFT_THUMBS();
  let open = [panel];
  ws.root = rootWith(() => open);

  ws._reviewToolbarConflict();
  assert.equal(calls.length, 1, '先让开');
  // 人点开了那颗球：状态层把账结清（undock），横杠通知工作区（onReclaim）
  ws.toolbar.yielded = false;
  ws._waiveOpenOverlays();
  ws._reviewToolbarConflict();
  assert.equal(calls.length, 1, '不再赶回角上——人点开它就是要用');

  // 关上：真的面板关上时带着 hidden，查询里也就没有它了
  panel.hidden = true;
  open = [];
  ws._reviewToolbarConflict();
  panel.hidden = false;
  open = [panel];
  ws._reviewToolbarConflict();
  assert.equal(calls.length, 2, '面板关掉再打开，照常让');
});

await check('豁免不因为一时量不到而作废：那一栏被专注模式收走又回来，面板还是那一块', async () => {
  const { ws, calls } = withToolbar(LEFT_BAR);
  const panel = LEFT_THUMBS();
  ws.root = rootWith(() => [panel]);
  ws._waiveOpenOverlays();
  // 点另一栏的「专注」：这一栏被移出排版，面板还开着，只是量出来是 0
  panel.getBoundingClientRect = () => rect(0, 0, 0, 0);
  ws._reviewToolbarConflict();
  // 退出专注，这一栏回来
  panel.getBoundingClientRect = () => rect(20, 150, 580, 460);
  ws._reviewToolbarConflict();
  assert.deepEqual(calls, [], '人点开球的时候这块就开着，一直没关过，就不该再赶它');
});

await check('整个工作区不在屏幕上（切到了设置页）：横杠一动不动', async () => {
  // 设置页和练习页是两个 .page，不在前台的那个是 display:none：工作区和里面每一块
  // 面板量出来都是 0，看上去就像「面板全关了」。原来横杠会在后台还位，等人从设置
  // 页（比如刚换完语言）回来，面板还开着，它再当着人折一次。
  const { ws, calls } = withToolbar(LEFT_BAR);
  const panel = LEFT_THUMBS();
  let size = rect(0, 0, 1000, 800);
  ws.root = rootWith(() => [panel], () => size);
  ws._reviewToolbarConflict();
  assert.deepEqual(calls.map(c => c[0]), ['yieldTo'], '在屏幕上时照常让');

  size = rect(0, 0, 0, 0);
  panel.getBoundingClientRect = () => rect(0, 0, 0, 0);
  ws._reviewToolbarConflict();
  assert.deepEqual(calls.map(c => c[0]), ['yieldTo'], '不在屏幕上：不还位');

  size = rect(0, 0, 1000, 800);
  panel.getBoundingClientRect = () => rect(20, 150, 580, 460);
  ws._reviewToolbarConflict();
  assert.deepEqual(calls.map(c => c[0]), ['yieldTo'], '回来时它本来就让着，不用再折一次');
});

await check('栏的尺寸一变（包括从设置页切回来）：先安顿横杠，再判冲突', async () => {
  // 在设置页换完语言回来，栏从 0 变回原来的大小、栏头换了字。原来这条路只重判
  // 冲突，横杠要等人点下一个工具才回到该在的地方——录屏里那一下「往上偏、一点
  // 工具又跳下来」。先判冲突再安顿也不对：判的是一根还没摆好的横杠。
  const src = $read('src/pdf/pdf-workspace.js');
  const body = src.slice(src.indexOf('  _watchSlotSizes() {'), src.indexOf('  // ── state → DOM'));
  const sync = body.indexOf('_syncToolbarSize(');
  const review = body.indexOf('_reviewToolbarConflict()');
  assert.ok(sync > -1, '尺寸观察器里要重新安顿横杠');
  assert.ok(sync < review, '先摆好，再判它压没压住东西');
});

await check('布局一变（拖分栏、对调、专注、收起一栏）：也是先安顿横杠，再判冲突', async () => {
  // 栏变窄，横杠跟着缩短；栏头多出一行，它被往下推。这些都发生在给它定大小的
  // 那一步里——在那之前去判，判的是上一种布局里的那根横杠。
  const src = $read('src/pdf/pdf-workspace.js');
  const start = src.indexOf('  _syncPaneWidthBands(fractions) {');
  const body = src.slice(start, src.indexOf('\n  }', start));
  const sync = body.indexOf('this._syncToolbarSize(fractions)');
  const review = body.indexOf('this._reviewToolbarConflict()');
  assert.ok(sync > -1 && review > -1);
  assert.ok(sync < review, '先定好大小和位置，再判');
});

// ═══════════════════════════════════════════════════════════════
group('6. Closing a scratchpad takes it off the column and nothing more');

// This briefly asked "save or delete?", and answering delete wiped the pad and
// its ink. That put one mis-tap between a reader and ink that has no second
// copy — and deleting already had a home: 永久删除 in the document library,
// with its own confirmation and enough context to see which pad you are about
// to lose. Closing is closing. Deleting is deleting.

await check('closing a pad saves it and takes it off the column', async () => {
  const { ws, scratch } = makeWorkspace({ docs: { A: {} }, pads: { pad: { name: '草稿纸 09' } } });
  await open(ws, SLOTS.PRIMARY, 'A');
  const entry = await open(ws, SLOTS.PRIMARY, 'pad', ENTRY_KINDS.SCRATCH);
  const before = scratch[SLOTS.PRIMARY].flushed;

  await ws.removeEntry(SLOTS.PRIMARY, entry.id);

  assert.ok(scratch[SLOTS.PRIMARY].flushed > before, 'the ink was written out first');
  assert.deepEqual(order(ws, SLOTS.PRIMARY), ['A'], 'and the pad left the column');
});

await check('and the pad itself is never deleted on the way out', async () => {
  const { ws } = makeWorkspace({ docs: { A: {} }, pads: { pad: { name: '草稿纸 09' } } });
  await open(ws, SLOTS.PRIMARY, 'A');
  const entry = await open(ws, SLOTS.PRIMARY, 'pad', ENTRY_KINDS.SCRATCH);

  await ws.removeEntry(SLOTS.PRIMARY, entry.id);

  assert.deepEqual(ws.deleted, [],
    'it is still in the library, where the reader can open it again or delete it on purpose');
});

await check('closing a pad puts no question in the way', async () => {
  // A pad and a book are treated alike here; neither loses anything by being
  // taken off a column, so neither needs to be asked about.
  const { ws } = makeWorkspace({ docs: { A: {} }, pads: { pad: { name: 'p' } } });
  await open(ws, SLOTS.PRIMARY, 'A');
  const entry = await open(ws, SLOTS.PRIMARY, 'pad', ENTRY_KINDS.SCRATCH);
  const asked = [];
  ws._ask = (o) => { asked.push(o); return Promise.resolve(null); };

  await ws.removeEntry(SLOTS.PRIMARY, entry.id);

  assert.deepEqual(asked, [], 'nothing was asked');
  assert.deepEqual(order(ws, SLOTS.PRIMARY), ['A'], 'and it just closed');
});

// ═══════════════════════════════════════════════════════════════
group('7. A book comes back to the page it was left on');

// Opening commits the deck first and swaps the screen second. In between,
// activeEntryIn already names the INCOMING entry while the pane still holds
// the outgoing one — so anything that pairs "the deck's entry" with "the pane's
// state" in that window files the old book's page under the new book's name.
// The old page is then lost, and the new one is overwritten with a stranger's.
//
// The same shape as the flush bug that lost ink on a handoff, in a second
// place. Worth pinning, because it survived being fixed once elsewhere.

await check('switching away and back returns to the same page', async () => {
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 476 }, B: { pageCount: 827 } } });
  const a = await open(ws, SLOTS.PRIMARY, 'A');
  ws.panes[SLOTS.PRIMARY].goToPage(124);
  ws._persist();

  await open(ws, SLOTS.PRIMARY, 'B');
  assert.equal(showingIn(ws, SLOTS.PRIMARY), 'B', 'the other book is up');

  await ws.showEntry(SLOTS.PRIMARY, a.id, { force: true });
  assert.equal(ws.panes[SLOTS.PRIMARY].state.pageNumber, 124,
    'back on page 124, not wherever the other book was');
});

await check('翻过页之后换走再换回来，回到翻到的那一页而不是存盘那一页', async () => {
  // 上面那条是先翻页、再存盘、再换。真机上的顺序是反的：存盘早就发生过了
  // （开机恢复会话就写了一次），然后人翻到 124 页，随手切到另一本，再切回来。
  // 翻页只安排了一次 500ms 之后的延迟记账，所以这中间没有第二次存盘。
  //
  // 「这一条目上次在哪一页」的优先级高于「这本书上次在哪一页」——同一本书同时
  // 开在两栏里时靠的正是前者。而前者那份缓存原来只在存盘时整个换一遍，于是它
  // 答出来的是存盘那一刻的页码：第 1 页。
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 476 }, B: { pageCount: 827 } } });
  const a = await open(ws, SLOTS.PRIMARY, 'A');
  // 真存一次盘：这一刻 A 停在第 1 页，条目缓存记下的就是第 1 页。骨架把
  // ws._persist() 桩成了空函数，所以这里直接叫真的那一个。
  saveSession(ws.state, { [a.id]: ws.panes[SLOTS.PRIMARY].state });
  ws.panes[SLOTS.PRIMARY].goToPage(124);

  await open(ws, SLOTS.PRIMARY, 'B');
  await ws.showEntry(SLOTS.PRIMARY, a.id, { force: true });
  assert.equal(ws.panes[SLOTS.PRIMARY].state.pageNumber, 124,
    '回到翻到的第 124 页，而不是缓存里那个第 1 页');
});

await check('只开一份时也一样——换走再换回来还是那一页', async () => {
  // 记页码这件事是按栏做的，和屏幕上摆着几栏没关系；但「双开修好了、单开还错着」
  // 在这个工作区里出现过不止一次，所以两种摆法各钉一条。
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 476 }, B: { pageCount: 827 } } });
  const a = await open(ws, SLOTS.PRIMARY, 'A');
  ws._setState(focusSlot(ws.state, SLOTS.PRIMARY));   // 这一栏铺满整屏
  saveSession(ws.state, { [a.id]: ws.panes[SLOTS.PRIMARY].state });
  ws.panes[SLOTS.PRIMARY].goToPage(310);

  await open(ws, SLOTS.PRIMARY, 'B');
  await ws.showEntry(SLOTS.PRIMARY, a.id, { force: true });
  assert.equal(ws.state.focusedSlot, SLOTS.PRIMARY, '全程都只开着一份');
  assert.equal(ws.panes[SLOTS.PRIMARY].state.pageNumber, 310);
});

await check('右栏也一样，记页码跟它是哪一栏无关', async () => {
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 476 }, B: { pageCount: 827 } } });
  const a = await open(ws, SLOTS.SECONDARY, 'A');
  saveSession(ws.state, { [a.id]: ws.panes[SLOTS.SECONDARY].state });
  ws.panes[SLOTS.SECONDARY].goToPage(77);

  await open(ws, SLOTS.SECONDARY, 'B');
  await ws.showEntry(SLOTS.SECONDARY, a.id, { force: true });
  assert.equal(ws.panes[SLOTS.SECONDARY].state.pageNumber, 77);
});

await check('桌上空了会提一句，而且只提一次', async () => {
  // 关掉最后一份文件之后留在原地，人看到的是两块空白；他接下来必然要做的那件
  // 事（挑下一本）的入口却藏在横杠上。所以空了就让书架回来——但只在「从有到无」
  // 那一次，不然空着的时候每动一下书架都会再开一遍，连关都关不掉。
  //
  // 这里没用上面那个骨架：它把 _setState 整个换成了一行赋值，而这一下正是挂在
  // _setState 上的。所以直接拿真的那个方法来跑。
  const ws = Object.create(PdfWorkspace.prototype);
  ws._layout = () => {};
  let called = 0;
  ws.onEmpty = () => { called += 1; };

  const withBook = openInSlot(createWorkspaceState({}), SLOTS.PRIMARY,
    { kind: ENTRY_KINDS.PDF, resourceId: 'A' }).state;
  ws.state = createWorkspaceState({});
  ws._setState(withBook);
  assert.equal(called, 0, '开着东西的时候不提');

  ws._setState(createWorkspaceState({}));
  assert.equal(called, 1, '最后一份关掉了');

  ws._setState(setDividerRatio(ws.state, 0.42));
  assert.equal(called, 1, '已经空着的时候再动别的，不该再提一遍');
});

await check('上次还开着书就接着读，全关了才回书架', async () => {
  // 「回来先看见书架」这条规矩只对一种情形成立：上次是把书都合上才走的。手边
  // 还摊着东西的时候盖一层书架上去，是拿一个人没问的问题挡住他要的东西。
  const ws = Object.create(PdfWorkspace.prototype);
  ws._layout = () => {};

  ws.state = createWorkspaceState({});
  assert.equal(ws.isEmpty(), true, '什么都没恢复出来');

  ws.state = openInSlot(createWorkspaceState({}), SLOTS.SECONDARY,
    { kind: ENTRY_KINDS.PDF, resourceId: 'A' }).state;
  assert.equal(ws.isEmpty(), false, '哪一栏里有都算有，不只是左边那栏');
});

await check('装新书的途中落一次盘，不会把新书的页码记到旧书名下', async () => {
  // 真机上抓到的那一下，堆栈是：
  //   _persist ← onStateChange ← loadDocument ← _preparePdf
  // 也就是新书正往窗格里装的时候，pdf.js 发出的状态变化触发了一次落盘。那一刻
  // 窗格里装的已经是新书，而 _shown 还指着走掉的那一份——于是新书的页码被写进
  // 了旧书名下。旧书从此每次打开都落在别人的页上，下一轮再换回来，又把这个错
  // 抄给第三本。
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 476 }, B: { pageCount: 827 } } });
  const a = await open(ws, SLOTS.PRIMARY, 'A');
  ws.panes[SLOTS.PRIMARY].goToPage(124);
  saveSession(ws.state, { [a.id]: ws.panes[SLOTS.PRIMARY].state });

  // 照着真窗格的样子，在装载途中记一次账。
  const pane = ws.panes[SLOTS.PRIMARY];
  const realLoad = pane.loadDocument.bind(pane);
  pane.loadDocument = async (...args) => {
    const ok = await realLoad(...args);
    ws._rememberSlotView(SLOTS.PRIMARY);
    return ok;
  };

  await open(ws, SLOTS.PRIMARY, 'B');
  await ws.showEntry(SLOTS.PRIMARY, a.id, { force: true });
  assert.equal(ws.panes[SLOTS.PRIMARY].state.pageNumber, 124,
    'A 还在第 124 页，没被 B 的页码盖掉');
});

await check('换完之后牌子摘干净，不会从此再也不记账', async () => {
  // 只挡住那一段，不是挡住以后。牌子忘了摘的话，症状是反过来的：翻页再也存不
  // 下来，退出去一次全丢。
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 476 }, B: { pageCount: 827 } } });
  const a = await open(ws, SLOTS.PRIMARY, 'A');
  assert.equal(ws._paneInFlux[SLOTS.PRIMARY], false, '开完就该是落定的');

  await open(ws, SLOTS.PRIMARY, 'B');
  assert.equal(ws._paneInFlux[SLOTS.PRIMARY], false);

  await ws.showEntry(SLOTS.PRIMARY, a.id, { force: true });
  ws.panes[SLOTS.PRIMARY].goToPage(300);
  ws._rememberSlotView(SLOTS.PRIMARY);
  saveSession(ws.state, {});
  await open(ws, SLOTS.PRIMARY, 'B');
  await ws.showEntry(SLOTS.PRIMARY, a.id, { force: true });
  assert.equal(ws.panes[SLOTS.PRIMARY].state.pageNumber, 300,
    '换完之后记的账要算数');
});

await check('装载途中失败了，牌子也得摘', async () => {
  const { ws } = makeWorkspace({
    docs: { A: { pageCount: 476 }, B: { pageCount: 827 } },
    failOpen: new Set(['B']),
  });
  await open(ws, SLOTS.PRIMARY, 'A');
  const before = ws.panes[SLOTS.PRIMARY].state.pageNumber;
  await open(ws, SLOTS.PRIMARY, 'B').catch(() => {});
  assert.equal(ws._paneInFlux[SLOTS.PRIMARY], false,
    '一次打不开的切换不该让这一栏从此不记账');
  assert.equal(ws.panes[SLOTS.PRIMARY].state.pageNumber, before, 'A 还在原处');
});

await check('选栏的单子按屏幕上的先后排，不是按内部名字', async () => {
  // 两栏交换过之后，这份单子原来还是 [PRIMARY, SECONDARY]，只有标签跟着走。
  // 于是对话框里第一个按钮写着「右栏」、第二个写着「左栏」——字是真话，位置是
  // 反的。这种矛盾里人信的是位置：要开到右边，手就往右边那个按钮去。
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 10 }, B: { pageCount: 10 } } });
  await open(ws, SLOTS.PRIMARY, 'A');
  await open(ws, SLOTS.SECONDARY, 'B');

  const plain = ws.destinationOptions();
  assert.deepEqual(plain.map(o => o.slot), [SLOTS.PRIMARY, SLOTS.SECONDARY]);
  assert.equal(plain[0].position, t('deck.left'));
  assert.equal(plain[1].position, t('deck.right'));

  ws._setState({ ...ws.state, swapped: true });
  const swapped = ws.destinationOptions();
  assert.equal(swapped[0].position, t('deck.left'), '第一个永远是屏幕左边那个');
  assert.equal(swapped[1].position, t('deck.right'));
  assert.equal(swapped[0].slot, SLOTS.SECONDARY, '交换之后，屏幕左边是 b');
  assert.deepEqual(
    swapped.map(o => o.current),
    plain.map(o => o.current).reverse(),
    '装着什么也跟着换位置，不然按钮写的是这一栏、底下说的是另一栏',
  );
});

await check('the book switched TO does not inherit the other one page', async () => {
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 476 }, B: { pageCount: 827 } } });
  await open(ws, SLOTS.PRIMARY, 'A');
  ws.panes[SLOTS.PRIMARY].goToPage(124);
  ws._persist();

  await open(ws, SLOTS.PRIMARY, 'B');
  assert.equal(ws.panes[SLOTS.PRIMARY].state.pageNumber, 1,
    'a book never opened before starts at page 1, not at 124');
});

await check('the page is filed against what the pane shows, not what the deck says', async () => {
  const { ws } = makeWorkspace({ docs: { A: { pageCount: 476 }, B: { pageCount: 827 } } });
  const a = await open(ws, SLOTS.PRIMARY, 'A');
  ws.panes[SLOTS.PRIMARY].goToPage(200);

  // The deck moves on; the pane has not been swapped yet.
  const committed = openInSlot(ws.state, SLOTS.PRIMARY,
    { kind: ENTRY_KINDS.PDF, resourceId: 'B' });
  ws._setState(committed.state);

  assert.equal(ws._entryOnScreen(SLOTS.PRIMARY).id, a.id,
    'the pane still holds A, whatever the deck now claims');
  ws._persist();

  await ws.showEntry(SLOTS.PRIMARY, committed.entry.id, { force: true });
  await ws.showEntry(SLOTS.PRIMARY, a.id, { force: true });
  assert.equal(ws.panes[SLOTS.PRIMARY].state.pageNumber, 200,
    'A kept its own page through a persist taken mid-switch');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
