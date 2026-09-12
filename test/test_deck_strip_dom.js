#!/usr/bin/env node
// The switching strip's gesture contract (F03, F04, M01-M04) — real DOM, real
// pointer events.
//
// The deck state is pure and already covered. What cannot be seen from there is
// whether a gesture ever reaches it: a swipe that is classified horizontal, a
// second finger arriving, a pointer capture lost mid-drag, the tab being
// hidden. Every one of those has to leave the deck exactly as it was and leave
// no drag behind — and every one of them is a DOM event, so this file
// dispatches genuine PointerEvents and asserts on what is left afterwards.
//
// The rule underneath all of it: a preview never changes what the pane is
// showing. Only a committed release does.

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

// ── environment ─────────────────────────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

for (const key of [
  'window', 'document', 'localStorage', 'PointerEvent', 'Event',
  // NOT `performance`: copying jsdom's onto globalThis makes its own `now()`
  // recurse into itself. Node's is a perfectly good clock and the strip only
  // ever asks it for elapsed milliseconds.
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
  // jsdom's addEventListener validates `signal` against ITS OWN AbortSignal, so
  // Node's global one is rejected. The strip takes its listeners off with an
  // AbortController, which is the whole reason a rebuilt workspace does not end
  // up handling every gesture twice — so it has to be jsdom's here.
  'AbortController', 'AbortSignal',
]) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, {
    value: dom.window[key], configurable: true, writable: true,
  });
}
// Reduced motion off, so the spring path is the one under test.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { DeckStrip, deckStripHtml } = await import('../src/pdf/deck-strip.js');
const {
  ENTRY_KINDS, activeEntry, createDeck, createEntry, cycleEntry,
} = await import('../src/pdf/deck-state.js');
const { initI18n } = await import('../src/core/i18n.js');
await initI18n();

/** A slot host with a strip in it, and a deck behind it. */
function makeStrip({ entries = ['A', 'B', 'C'], paperHeight = 600 } = {}) {
  const host = dom.window.document.createElement('div');
  host.innerHTML = deckStripHtml();
  dom.window.document.body.replaceChildren(host);

  let deck = createDeck({
    entries: entries.map(id => createEntry({ kind: ENTRY_KINDS.PDF, resourceId: id })),
  });
  const cycled = [];
  const activated = [];
  const paper = dom.window.document.createElement('div');
  paper.getBoundingClientRect = () => ({ height: paperHeight, width: 800, top: 0, left: 0 });

  const strip = new DeckStrip(host, {
    getDeck: () => deck,
    describe: (entry) => ({ name: entry.resourceId, detail: '', save: '' }),
    getPaper: () => paper,
    isBusy: () => false,
    // The workspace owns the transaction; the strip only asks. Recording the
    // request is exactly what a test of the gesture should assert on.
    onCycle: (step) => { cycled.push(step); deck = cycleEntry(deck, step); },
    onActivate: (id) => activated.push(id),
    onRemove: () => {},
    onOrganize: () => {},
  });
  strip.render();

  const el = host.querySelector('[data-role="strip"]');
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};

  return {
    host, strip, el, paper, cycled, activated,
    showing: () => activeEntry(deck)?.resourceId,
    deck: () => deck,
  };
}

let clock = 1000;
function pointer(el, type, { x = 100, y = 300, id = 1, primary = true, dt = 16 } = {}) {
  clock += dt;
  const event = new dom.window.PointerEvent(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    isPrimary: primary,
    bubbles: true,
    cancelable: true,
  });
  // jsdom's PointerEvent has no timeStamp we can set, and the contract reads
  // one — a stationary pause at the end of a drag has to make velocity zero.
  Object.defineProperty(event, 'timeStamp', { value: clock, configurable: true });
  el.dispatchEvent(event);
  return event;
}

/** A drag from `from` to `to`, in a given number of steps. */
function drag(el, { fromY, toY, steps = 6, x = 100, dt = 16, releaseDt = 16 }) {
  pointer(el, 'pointerdown', { x, y: fromY });
  for (let i = 1; i <= steps; i++) {
    pointer(el, 'pointermove', { x, y: fromY + ((toY - fromY) * i) / steps, dt });
  }
  pointer(el, 'pointerup', { x, y: toY, dt: releaseDt });
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Switching Strip Tests — the gesture, and everything that cancels it');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. What the strip says');

test('the strip names the content, its type and its position in the deck', () => {
  const s = makeStrip();
  assert.equal(s.el.querySelector('[data-role="deck-name"]').textContent, 'A');
  assert.equal(s.el.querySelector('[data-role="deck-count"]').textContent, '1 / 3');
  assert.ok(s.el.querySelector('[data-role="deck-kind"]').textContent.length > 0);
});

test('one entry still reads 1 / 1, with cycling disabled and the list reachable', () => {
  const s = makeStrip({ entries: ['only'] });
  assert.equal(s.el.querySelector('[data-role="deck-count"]').textContent, '1 / 1');
  assert.equal(s.el.querySelector('[data-role="deck-prev"]').disabled, true);
  assert.equal(s.el.querySelector('[data-role="deck-next"]').disabled, true);
  s.el.querySelector('[data-role="deck-title"]').click();
  assert.equal(s.strip.listOpen, true, 'the list is where Remove and Organize live');
});

test('the full name reaches a screen reader even when the pane clips it', () => {
  const s = makeStrip();
  const label = s.el.querySelector('[data-role="deck-title"]').getAttribute('aria-label');
  assert.ok(label.includes('A') && label.includes('1 / 3'));
});

// ═══════════════════════════════════════════════════════════════
group('2. The arrows and the list');

test('the arrows ask for one step, in the direction they point', () => {
  const s = makeStrip();
  s.el.querySelector('[data-role="deck-next"]').click();
  assert.deepEqual(s.cycled, [1]);
  s.el.querySelector('[data-role="deck-prev"]').click();
  assert.deepEqual(s.cycled, [1, -1]);
});

test('an arrow press does not also start a drag', () => {
  const s = makeStrip();
  const arrow = s.el.querySelector('[data-role="deck-next"]');
  pointer(arrow, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 200 });
  pointer(s.el, 'pointerup', { y: 200 });
  assert.deepEqual(s.cycled, [], 'no switch was requested by the drag path');
});

test('selecting from the list asks for that entry and never reorders', () => {
  const s = makeStrip();
  s.strip.openList();
  const rows = s.host.querySelectorAll('.deck-row-select');
  assert.equal(rows.length, 3);
  rows[2].click();
  assert.equal(s.activated.length, 1);
  assert.deepEqual(s.deck().entries.map(e => e.resourceId), ['A', 'B', 'C'],
    'the order is untouched by a selection');
});

test('the list carries its own previous and next, at every width', () => {
  // A very narrow pane sheds the arrows from the strip — three controls and a
  // name will not fit — and the list it falls back to has to carry the pair.
  const s = makeStrip();
  s.strip.openList();
  const cycle = [...s.host.querySelectorAll('.deck-list-cycle button')];
  assert.equal(cycle.length, 2);
  cycle[1].click();
  assert.deepEqual(s.cycled, [1]);
  cycle[0].click();
  assert.deepEqual(s.cycled, [1, -1]);
});

test('with one entry the list keeps its cycle controls, disabled', () => {
  const s = makeStrip({ entries: ['only'] });
  s.strip.openList();
  const cycle = [...s.host.querySelectorAll('.deck-list-cycle button')];
  assert.equal(cycle.length, 2);
  assert.ok(cycle.every(b => b.disabled));
});

test('the list shows saved deck order, not rotated to put the current first', () => {
  const s = makeStrip();
  s.el.querySelector('[data-role="deck-next"]').click();   // now showing B
  s.strip.render();
  s.strip.openList();
  const names = [...s.host.querySelectorAll('.deck-row-name')].map(n => n.textContent);
  assert.deepEqual(names, ['A', 'B', 'C']);
});

// ═══════════════════════════════════════════════════════════════
group('3. The swipe');

test('a long drag up asks for the next entry', () => {
  const s = makeStrip();
  drag(s.el, { fromY: 300, toY: 180 });
  assert.deepEqual(s.cycled, [1], 'up recalls next');
});

test('a long drag down asks for the previous entry', () => {
  const s = makeStrip();
  drag(s.el, { fromY: 300, toY: 420 });
  assert.deepEqual(s.cycled, [-1]);
});

test('a short drag returns without switching', () => {
  const s = makeStrip();
  // Under the commit threshold, and slowly enough not to be a flick.
  drag(s.el, { fromY: 300, toY: 292, steps: 4, dt: 60, releaseDt: 200 });
  assert.deepEqual(s.cycled, []);
});

test('a stationary pause before release cancels the flick', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  for (let i = 1; i <= 4; i++) pointer(s.el, 'pointermove', { y: 300 - i * 4, dt: 8 });
  // Held still, well past the velocity window: the hand has given the momentum
  // up, and the gesture must not keep it.
  pointer(s.el, 'pointerup', { y: 284, dt: 400 });
  assert.deepEqual(s.cycled, [], 'holding still means "not this far"');
});

test('one gesture advances at most one entry, however far it travels', () => {
  const s = makeStrip();
  drag(s.el, { fromY: 700, toY: 20, steps: 12 });
  assert.deepEqual(s.cycled, [1], 'no inertial multi-skip');
});

test('a drag classified horizontal never switches', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { x: 100, y: 300 });
  pointer(s.el, 'pointermove', { x: 200, y: 292 });
  pointer(s.el, 'pointermove', { x: 320, y: 288 });
  pointer(s.el, 'pointerup', { x: 400, y: 285 });
  assert.deepEqual(s.cycled, [], 'sideways is not this gesture');
});

test('a gesture that reverses through zero commits nothing', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  for (let i = 1; i <= 5; i++) pointer(s.el, 'pointermove', { y: 300 - i * 18 });
  for (let i = 1; i <= 5; i++) pointer(s.el, 'pointermove', { y: 210 + i * 18 });
  pointer(s.el, 'pointerup', { y: 300, dt: 200 });
  assert.deepEqual(s.cycled, [], 'released back at the origin');
});

test('the paper moves under the finger, and is put back on release', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 240 });
  assert.ok(s.paper.style.transform.includes('translateY'), 'the card follows');
  assert.ok(parseFloat(s.paper.style.opacity) < 1, 'and dims a little');
  pointer(s.el, 'pointerup', { y: 240 });
  // The spring settles it; what matters here is that a released gesture is not
  // left holding the transform.
  assert.ok(s.strip._drag === null);
});

test('a preview names its target and never changes what is showing', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 250 });
  const preview = s.host.querySelector('[data-role="deck-preview"]');
  assert.equal(preview.hidden, false);
  assert.ok(preview.textContent.includes('B'), 'the entry a release would reach');
  assert.equal(s.showing(), 'A', 'and the pane is still showing what it was');
});

test('the click a drag leaves behind never reaches whatever it landed on', () => {
  // The strip is 52dp tall and a swipe travels well past it, so the click the
  // browser synthesises is delivered to something else entirely — on the tablet
  // it landed on the pane's own menu button and opened it. It is swallowed at
  // the document, in the capture phase, before it can reach anything.
  const s = makeStrip();
  const elsewhere = dom.window.document.createElement('button');
  let pressed = 0;
  elsewhere.addEventListener('click', () => { pressed += 1; });
  dom.window.document.body.appendChild(elsewhere);

  drag(s.el, { fromY: 300, toY: 180 });
  elsewhere.click();
  assert.equal(pressed, 0, 'the synthesised click was taken off the table');

  // And only that one: the very next press is the reader's own.
  elsewhere.click();
  assert.equal(pressed, 1);
});

test('a tap on the title still opens the list', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointerup', { y: 302 });          // within the slop: a tap
  s.el.querySelector('[data-role="deck-title"]').click();
  assert.equal(s.strip.listOpen, true, 'a tap is not a drag and is not swallowed');
});

// ═══════════════════════════════════════════════════════════════
group('4. Everything that cancels');

test('a second pointer cancels, leaving no drag and no switch', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 240 });
  pointer(s.el, 'pointermove', { y: 230, id: 2, primary: false });
  pointer(s.el, 'pointerup', { y: 200 });
  assert.deepEqual(s.cycled, []);
  assert.equal(s.strip._drag, null);
});

test('pointercancel cancels', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 220 });
  pointer(s.el, 'pointercancel', { y: 220 });
  assert.equal(s.strip._drag, null);
  assert.deepEqual(s.cycled, []);
});

test('a lost capture mid-gesture cancels, and one after a release does nothing', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 220 });
  pointer(s.el, 'lostpointercapture', { y: 220 });
  assert.equal(s.strip._drag, null);
  assert.deepEqual(s.cycled, [], 'nothing committed');

  // The expected one, after a normal release, must not cancel a second time.
  const t = makeStrip();
  drag(t.el, { fromY: 300, toY: 180 });
  pointer(t.el, 'lostpointercapture', { y: 180 });
  assert.deepEqual(t.cycled, [1], 'the committed switch stands');
});

test('the page being hidden cancels an uncommitted gesture', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 230 });
  Object.defineProperty(dom.window.document, 'hidden', { value: true, configurable: true });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  Object.defineProperty(dom.window.document, 'hidden', { value: false, configurable: true });
  assert.equal(s.strip._drag, null);
  assert.deepEqual(s.cycled, []);
});

test('Escape cancels a live gesture before it closes the list', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 230 });
  const escape = new dom.window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  s.el.dispatchEvent(escape);
  assert.equal(s.strip._drag, null);
  assert.deepEqual(s.cycled, []);
});

test('destroying the strip during a gesture leaves nothing behind', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 230 });
  s.strip.destroy();
  assert.equal(s.strip._drag, null);
  // And the listeners are gone with it: a later event cannot reach a dead strip.
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 200 });
  pointer(s.el, 'pointerup', { y: 200 });
  assert.deepEqual(s.cycled, []);
});

test('a rotation cancels an uncommitted drag rather than rescaling it', () => {
  const s = makeStrip();
  pointer(s.el, 'pointerdown', { y: 300 });
  pointer(s.el, 'pointermove', { y: 240 });
  s.strip.onViewportChange();
  assert.equal(s.strip._drag, null);
  assert.deepEqual(s.cycled, []);
});

// ═══════════════════════════════════════════════════════════════
group('5. Keyboard and discoverability');

test('Up and Down cycle only while the strip has focus', () => {
  const s = makeStrip();
  const key = (name) => {
    const e = new dom.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'key', { value: name });
    s.el.dispatchEvent(e);
  };
  key('ArrowUp');
  key('ArrowDown');
  assert.deepEqual(s.cycled, [1, -1]);

  // The same keys elsewhere are not the strip's business: they belong to the
  // page, the paper and any field with focus.
  const elsewhere = new dom.window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(elsewhere, 'key', { value: 'ArrowUp' });
  dom.window.document.body.dispatchEvent(elsewhere);
  assert.deepEqual(s.cycled, [1, -1], 'no global arrow hijacking');
});

test('the hint is shown once and never again', () => {
  // The swallow is module-level and may be armed by whatever ran before this;
  // consume it so the arrow press below is the reader's own.
  dom.window.document.body.click();
  dom.window.localStorage.clear();
  const s = makeStrip();
  assert.equal(s.el.querySelector('[data-role="deck-hint"]').hidden, false);
  s.el.querySelector('[data-role="deck-next"]').click();

  const t = makeStrip();
  assert.equal(t.el.querySelector('[data-role="deck-hint"]').hidden, true,
    'a tutorial that replays is a tutorial nobody reads');
});

test('a single-entry pane has nothing to discover, so no hint', () => {
  dom.window.localStorage.clear();
  const s = makeStrip({ entries: ['only'] });
  assert.equal(s.el.querySelector('[data-role="deck-hint"]').hidden, true);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);
