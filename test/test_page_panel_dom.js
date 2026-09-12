#!/usr/bin/env node
// The thumbnail grid, in a real DOM.
//
// Three things a pure test cannot see, and all three were reported by the
// reader before they were fixed:
//
//   1. Every reopen rasterised the same pages again, and they waited through
//      it again — for a book they had not changed and a page they had not
//      left.
//   2. The first screenful took seconds, because every visible page was
//      started at once and pdf.js finished them all at the end rather than
//      any of them early.
//   3. What was started first had nothing to do with what the reader was
//      looking at.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event', 'PointerEvent',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'localStorage']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
// jsdom has neither, and the panel is written to cope without them.
dom.window.Element.prototype.scrollIntoView = function () {};
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};

const { PagePanel } = await import('../src/pdf/page-panel.js');
const { PANEL_TABS, createPanelState, selectTab, setHeight } = await import('../src/pdf/panel-state.js');

/**
 * A panel over a stub book.
 *
 * `renderPage` records every call and hands back a promise the test resolves,
 * so "how many are in flight at once" is something we can actually stand still
 * and look at.
 */
function mount({ pages = 40, current = 20 } = {}) {
  document.body.innerHTML = '<div class="pdf-ws-slot">'
    + '<div data-role="outline-panel" hidden></div>'
    + '<div data-role="pane"></div></div>';
  const host = document.querySelector('.pdf-ws-slot');

  const asked = [];
  let inFlight = 0;
  let peak = 0;
  const pending = [];
  const doc = {
    numPages: pages,
    renderPage(page) {
      asked.push(page);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        pending.push(() => {
          inFlight -= 1;
          resolve({ canvas: document.createElement('canvas') });
        });
      });
    },
  };

  let state = createPanelState();
  const panel = new PagePanel(host, {
    getState: () => state,
    onState: (change) => {
      state = change({
        selectTab: (tab) => selectTab(state, tab),
        setHeight: (h) => setHeight(state, h),
      });
    },
    getDoc: () => doc,
    getPageCount: () => pages,
    getCurrentPage: () => current,
    getPageSize: () => ({ width: 595, height: 842 }),
    onGoToPage: () => {},
    onOpenChange: () => {},
  });
  state = selectTab(state, PANEL_TABS.THUMBS);

  /** Lets `n` renders finish, then drains the microtask queue. */
  const settle = async (n = pending.length) => {
    for (let i = 0; i < n && pending.length; i++) pending.shift()();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  return { panel, asked, settle, peak: () => peak, inFlight: () => inFlight, host };
}

const paintedIn = (host) => host.querySelectorAll('.pdf-thumb-shot.is-loaded').length;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Thumbnail grid — what it starts, and what it keeps');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. A few at a time, nearest first');

await test('it does not start every visible page at once', async () => {
  const { panel, peak, settle } = mount();
  panel.open();
  await settle(0);
  assert.ok(peak() > 0, 'it started something');
  assert.ok(peak() <= 3,
    `at most three at once, not a stampede — saw ${peak()}`);
  panel.destroy();
});

await test('what it starts first is what the reader is looking at', async () => {
  const { panel, asked, settle } = mount({ pages: 40, current: 20 });
  panel.open();
  await settle(0);
  // Without an IntersectionObserver the panel asks for a first screenful; the
  // queue is what decides which of those go first, and it sorts by distance
  // from the page being read.
  const anchor = 20;
  const first = asked.slice(0, 3);
  const rest = asked.slice(3);
  for (const near of first) {
    for (const far of rest) {
      assert.ok(Math.abs(near - anchor) <= Math.abs(far - anchor),
        `page ${near} was started before ${far}, but is further from ${anchor}`);
    }
  }
  panel.destroy();
});

await test('finishing one lets the next begin', async () => {
  const { panel, asked, settle } = mount();
  panel.open();
  await settle(0);
  const started = asked.length;
  await settle(1);
  assert.ok(asked.length > started, 'the queue kept moving');
  panel.destroy();
});

// ═══════════════════════════════════════════════════════════════
group('2. Reopening is not reloading');

await test('reopening shows the same pages without rasterising them again', async () => {
  const { panel, asked, settle, host } = mount();
  panel.open();
  await settle();
  const painted = paintedIn(host);
  assert.ok(painted > 0, 'something was painted the first time');
  const firstRound = asked.length;

  panel.close();
  panel.open();
  await settle(0);

  assert.equal(asked.length, firstRound,
    'not one page was asked for a second time');
  assert.ok(paintedIn(host) > 0,
    'and what was kept is back on screen straight away, unrendered');
  void painted;
  panel.destroy();
});

await test('closing gives back the pages it is not going to need', async () => {
  // Keeping the whole scrolling window while nobody is looking would hold
  // about fifty pages of bitmap for a panel that is not on screen.
  const { panel, settle } = mount({ pages: 400, current: 200 });
  panel.open();
  await settle();
  const held = panel._thumbs.size;
  panel.close();
  assert.ok(panel._thumbs.size <= held, 'no more than it had');
  for (const page of panel._thumbs.keys()) {
    assert.ok(Math.abs(page - 200) <= 12,
      `page ${page} is nowhere near where the reader was`);
  }
  panel.destroy();
});

await test('a page still rasterising when it closes is not remembered as done', async () => {
  // In-flight pages are recorded as null. Left behind, they would look painted
  // for ever and never be asked for again — a permanently blank cell.
  const { panel, settle, asked } = mount();
  panel.open();
  await settle(0);
  panel.close();
  for (const [, canvas] of panel._thumbs) {
    assert.ok(canvas, 'nothing half-finished was kept');
  }
  const before = asked.length;
  panel.open();
  // The renders that were in the air when it closed still hold the
  // concurrency budget until they land; letting them land frees it.
  await settle();
  assert.ok(asked.length > before, 'they get asked for again instead');
  panel.destroy();
});

// ═══════════════════════════════════════════════════════════════
group('3. A different book is a different set of pictures');

await test('changing the book drops everything', async () => {
  const { panel, settle } = mount();
  panel.open();
  await settle();
  assert.ok(panel._thumbs.size > 0);
  panel.reset();
  assert.equal(panel._thumbs.size, 0,
    'every picture in the cache was a picture of the old book');
  panel.destroy();
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);
