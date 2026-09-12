#!/usr/bin/env node
// The content organizer (F09 §08) — real DOM, real pointer events.
//
// Two things are proven here. First, that dragging and clicking reach the same
// commit: F09-A07 requires identical results, and the only way to get that
// reliably is for both to call one function, which this checks by watching what
// each path asks for. Second, that the drag stays where it belongs — it starts
// on a dedicated handle, an ordinary row is not a drag source, and every way a
// gesture can be interrupted leaves both decks untouched.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}
function group(n) { console.log(`\n─── [${n}] ───`); }

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
for (const key of [
  'window', 'document', 'localStorage', 'PointerEvent', 'Event',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
  'AbortController', 'AbortSignal',
]) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, {
    value: dom.window[key], configurable: true, writable: true,
  });
}
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { openOrganizer } = await import('../src/pdf/deck-organizer.js');
const { ENTRY_KINDS, createDeck, createEntry } = await import('../src/pdf/deck-state.js');
const { SLOTS } = await import('../src/pdf/workspace-state.js');
const { initI18n } = await import('../src/core/i18n.js');
await initI18n();

/** Rectangles jsdom cannot compute, laid out as two stacked lists. */
function stubLayout(panel) {
  const lists = [...panel.querySelectorAll('[data-role="organizer-list"]')];
  lists.forEach((list, i) => {
    const top = i * 400;
    list.getBoundingClientRect = () => ({
      left: 0, right: 300, top, bottom: top + 400, width: 300, height: 400,
    });
    [...list.querySelectorAll('.organizer-row')].forEach((row, r) => {
      const rowTop = top + 20 + r * 70;
      row.getBoundingClientRect = () => ({
        left: 0, right: 300, top: rowTop, bottom: rowTop + 64, width: 300, height: 64,
      });
    });
  });
  return lists;
}

function makeOrganizer({ a = ['A1', 'A2'], b = ['B1'] } = {}) {
  // Each test gets the document to itself. The organizer appends its overlay to
  // the body, so a panel left over from the previous test would be the one
  // every query below found.
  dom.window.document.body.replaceChildren();
  const decks = {
    [SLOTS.PRIMARY]: createDeck({
      entries: a.map(id => createEntry({ kind: ENTRY_KINDS.PDF, resourceId: id })),
    }),
    [SLOTS.SECONDARY]: createDeck({
      entries: b.map(id => createEntry({ kind: ENTRY_KINDS.PDF, resourceId: id })),
    }),
  };
  const moves = [];
  const done = openOrganizer({
    getDecks: () => decks,
    describe: (slot, entry) => ({ name: entry.resourceId }),
    positions: [
      { slot: SLOTS.PRIMARY, position: 'Left', current: a[0] || '' },
      { slot: SLOTS.SECONDARY, position: 'Right', current: b[0] || '' },
    ],
    onMove: async (request) => { moves.push(request); return { ok: true }; },
  });
  const panel = dom.window.document.querySelector('.organizer');
  const lists = stubLayout(panel);
  return { panel, lists, decks, moves, done };
}

let clock = 1000;
function pointer(el, type, { x = 100, y = 40, id = 1, primary = true, kind = 'mouse' } = {}) {
  clock += 16;
  const e = new dom.window.PointerEvent(type, {
    pointerId: id, clientX: x, clientY: y, isPrimary: primary, bubbles: true, cancelable: true,
  });
  Object.defineProperty(e, 'pointerType', { value: kind, configurable: true });
  Object.defineProperty(e, 'timeStamp', { value: clock, configurable: true });
  el.dispatchEvent(e);
  return e;
}

const idOf = (decks, slot, resourceId) =>
  decks[slot].entries.find(e => e.resourceId === resourceId).id;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Organizer Tests — one commit, two ways to reach it');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. What it shows');

test('each list is labelled by where it is and what it is showing', () => {
  const o = makeOrganizer();
  const heads = [...o.panel.querySelectorAll('.organizer-column-head')];
  assert.equal(heads.length, 2);
  assert.ok(heads[0].textContent.includes('Left'));
  assert.ok(heads[0].textContent.includes('A1'), 'position AND current content');
  assert.ok(heads[1].textContent.includes('Right'));
});

test('every entry gets a row, a handle and a click Move', () => {
  const o = makeOrganizer();
  const rows = [...o.panel.querySelectorAll('.organizer-row')];
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(row.querySelector('[data-role="handle"]'), 'a dedicated drag handle');
    assert.ok(row.querySelector('[data-role="move"]'), 'and a click path beside it');
  }
});

test('an empty deck still offers somewhere to aim at', () => {
  const o = makeOrganizer({ b: [] });
  const empty = o.panel.querySelectorAll('.organizer-empty');
  assert.equal(empty.length, 1);
  assert.ok(empty[0].textContent.length > 0, 'and says what dropping there means');
});

test('the current entry is marked without the list being reordered', () => {
  const o = makeOrganizer();
  const rows = [...o.panel.querySelectorAll('.organizer-row')];
  assert.ok(rows[0].classList.contains('is-current'));
  assert.deepEqual(rows.map(r => r.querySelector('.organizer-name').textContent),
    ['A1', 'A2', 'B1'], 'saved order, not rotated');
});

// ═══════════════════════════════════════════════════════════════
group('2. The click path');

test('Move asks for a commit with a stable entry id', () => {
  const o = makeOrganizer();
  o.panel.querySelectorAll('[data-role="move"]')[1].click();
  assert.equal(o.moves.length, 1);
  assert.equal(o.moves[0].from, SLOTS.PRIMARY);
  assert.equal(o.moves[0].to, SLOTS.SECONDARY);
  assert.equal(o.moves[0].entryId, idOf(o.decks, SLOTS.PRIMARY, 'A2'));
  // Never a row index: rows shift under every insert and removal.
  assert.ok(typeof o.moves[0].entryId === 'string' && o.moves[0].entryId.length > 1);
});

test('the click path never turns Move into Move and show', () => {
  const o = makeOrganizer();
  o.panel.querySelectorAll('[data-role="move"]')[0].click();
  assert.notEqual(o.moves[0].andShow, true,
    'moving something underneath must not change what a pane displays');
});

// ═══════════════════════════════════════════════════════════════
group('3. The drag path');

test('dragging a handle into the other list commits the same request', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[1];   // A2
  pointer(handle, 'pointerdown', { y: 90 });
  pointer(o.panel, 'pointermove', { y: 300 });
  pointer(o.panel, 'pointermove', { y: 440 });                          // into the second list
  pointer(o.panel, 'pointerup', { y: 440 });

  assert.equal(o.moves.length, 1);
  assert.equal(o.moves[0].from, SLOTS.PRIMARY);
  assert.equal(o.moves[0].to, SLOTS.SECONDARY);
  assert.equal(o.moves[0].entryId, idOf(o.decks, SLOTS.PRIMARY, 'A2'),
    'the same entry id the click path would have sent');
});

test('dropping above every row means the head of that deck', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[2];   // B1
  pointer(handle, 'pointerdown', { y: 420 });
  pointer(o.panel, 'pointermove', { y: 200 });
  pointer(o.panel, 'pointermove', { y: 5 });
  pointer(o.panel, 'pointerup', { y: 5 });
  assert.equal(o.moves[0].afterId, null, 'first entry here');
});

test('dropping below a row lands after that entry, by id', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[2];   // B1
  pointer(handle, 'pointerdown', { y: 420 });
  pointer(o.panel, 'pointermove', { y: 200 });
  pointer(o.panel, 'pointermove', { y: 70 });      // past the midpoint of the first row
  pointer(o.panel, 'pointerup', { y: 70 });
  assert.equal(o.moves[0].afterId, idOf(o.decks, SLOTS.PRIMARY, 'A1'));
});

test('the insertion point is announced in words, not by colour alone', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[2];
  pointer(handle, 'pointerdown', { y: 420 });
  pointer(o.panel, 'pointermove', { y: 70 });
  const gap = o.panel.querySelector('.organizer-gap');
  assert.ok(gap, 'there is an insertion line');
  assert.ok(gap.textContent.includes('A1'), 'and it names what it will land after');
});

test('a lifted row leaves a placeholder rather than collapsing the list', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[1];
  pointer(handle, 'pointerdown', { y: 90 });
  pointer(o.panel, 'pointermove', { y: 200 });
  const rows = [...o.panel.querySelectorAll('.organizer-row')];
  assert.ok(rows.some(r => r.classList.contains('is-lifted')));
  assert.ok(o.panel.querySelector('.organizer-row.is-ghost'), 'a lightweight preview follows');
});

test('an ordinary row is not a drag source', () => {
  const o = makeOrganizer();
  const row = o.panel.querySelectorAll('.organizer-row')[1];
  pointer(row, 'pointerdown', { y: 90 });
  pointer(o.panel, 'pointermove', { y: 440 });
  pointer(o.panel, 'pointerup', { y: 440 });
  assert.deepEqual(o.moves, [], 'row space scrolls and selects; only the handle drags');
});

test('a drop outside either list commits nothing', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[0];
  pointer(handle, 'pointerdown', { y: 30 });
  pointer(o.panel, 'pointermove', { x: 900, y: 900 });
  pointer(o.panel, 'pointerup', { x: 900, y: 900 });
  assert.deepEqual(o.moves, []);
});

// ═══════════════════════════════════════════════════════════════
group('4. Everything that stops a drag');

test('a second pointer cancels, and both decks are untouched', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[1];
  pointer(handle, 'pointerdown', { y: 90 });
  pointer(o.panel, 'pointermove', { y: 300 });
  pointer(o.panel, 'pointermove', { y: 310, id: 2, primary: false });
  pointer(o.panel, 'pointerup', { y: 440 });
  assert.deepEqual(o.moves, []);
  assert.equal(o.panel.querySelector('.organizer-row.is-ghost'), null, 'and nothing is left over');
});

test('pointercancel cancels', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[1];
  pointer(handle, 'pointerdown', { y: 90 });
  pointer(o.panel, 'pointermove', { y: 300 });
  pointer(o.panel, 'pointercancel', { y: 300 });
  assert.deepEqual(o.moves, []);
  assert.equal(o.panel.querySelector('.organizer-gap'), null);
});

test('Escape stops the drag first, and only a second one closes the panel', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[1];
  pointer(handle, 'pointerdown', { y: 90 });
  pointer(o.panel, 'pointermove', { y: 300 });

  const escape = () => {
    const e = new dom.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'key', { value: 'Escape' });
    dom.window.document.dispatchEvent(e);
  };
  escape();
  assert.deepEqual(o.moves, [], 'the drag was abandoned');
  assert.ok(dom.window.document.querySelector('.organizer'), 'the panel is still open');
  escape();
  assert.equal(dom.window.document.querySelector('.organizer'), null, 'now it closes');
});

test('a resize stops an uncommitted drag rather than using stale coordinates', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[1];
  pointer(handle, 'pointerdown', { y: 90 });
  pointer(o.panel, 'pointermove', { y: 300 });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  pointer(o.panel, 'pointerup', { y: 440 });
  assert.deepEqual(o.moves, []);
});

test('closing the panel during a drag leaves nothing behind', () => {
  const o = makeOrganizer();
  const handle = o.panel.querySelectorAll('[data-role="handle"]')[1];
  pointer(handle, 'pointerdown', { y: 90 });
  pointer(o.panel, 'pointermove', { y: 300 });
  o.panel.querySelector('[data-role="close"]').click();
  assert.deepEqual(o.moves, []);
  assert.equal(dom.window.document.querySelector('.organizer-row.is-ghost'), null);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);
