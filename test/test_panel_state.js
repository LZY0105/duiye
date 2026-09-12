#!/usr/bin/env node
// The find-a-page panel: which face it shows, and how much of the column it
// may take.
//
// Pure, so these run in plain Node. The rules worth pinning are the ones a
// reader would notice being broken: a tab that forgets itself between opens,
// a height that can be dragged until the page underneath is gone, and a
// thumbnail window that either keeps every page of an 827-page book alive or
// throws away the one being looked at.

import assert from 'node:assert/strict';
import {
  PANEL_HEIGHT,
  PANEL_TABS,
  createPanelState,
  inThumbWindow,
  selectTab,
  serializePanelState,
  setHeight,
  shouldClose,
  thumbWindow,
} from '../src/pdf/panel-state.js';

let PASS = 0;
let FAIL = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
function check(label, fn) {
  try { fn(); PASS++; console.log(`  ✅ ${label}`); }
  catch (e) { FAIL++; console.log(`  ❌ ${label}\n     ${e.message}`); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Find-a-page panel — the tab, the height, and 827 pages');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. Which face it shows');

check('a fresh panel opens on the contents', () => {
  assert.equal(createPanelState().tab, PANEL_TABS.OUTLINE);
});

check('the chosen tab is remembered', () => {
  const s = selectTab(createPanelState(), PANEL_TABS.THUMBS);
  assert.equal(s.tab, PANEL_TABS.THUMBS);
  assert.equal(createPanelState(serializePanelState(s)).tab, PANEL_TABS.THUMBS,
    'a reader navigating by eye should not have to say so again every time');
});

check('choosing the tab already showing changes nothing at all', () => {
  const s = createPanelState();
  assert.equal(selectTab(s, PANEL_TABS.OUTLINE), s, 'same object, so nothing re-renders');
});

check('a tab name from disk that means nothing falls back', () => {
  assert.equal(createPanelState({ tab: 'ai-summary' }).tab, PANEL_TABS.OUTLINE);
  const s = createPanelState();
  assert.equal(selectTab(s, 'nonsense'), s);
});

// ═══════════════════════════════════════════════════════════════
group('2. How much of the column it may take');

check('the height starts at the default', () => {
  assert.equal(createPanelState().height, PANEL_HEIGHT.DEFAULT);
});

check('a drag past the ceiling stops at the ceiling', () => {
  // A panel covering the whole column reads as having navigated away, and the
  // reader loses sight of the thing they were about to come back to.
  assert.equal(setHeight(createPanelState(), 3).height, PANEL_HEIGHT.MAX);
});

check('a drag past the floor stops at the floor', () => {
  // Below this a thumbnail grid shows a row and a half and stops being a way
  // to find anything.
  assert.equal(setHeight(createPanelState(), -1).height, PANEL_HEIGHT.MIN);
});

check('a height in between is taken as given', () => {
  assert.equal(setHeight(createPanelState(), 0.6).height, 0.6);
});

check('nonsense from a drag that produced NaN is ignored', () => {
  // fractionAt() divides by the column height, which is 0 for a pane that has
  // not been laid out yet.
  const s = createPanelState();
  assert.equal(setHeight(s, NaN), s);
  assert.equal(setHeight(s, Infinity), s,
    'Infinity is a broken measurement too, not a request for the maximum');
});

check('the height survives a restart, already clamped', () => {
  const s = setHeight(createPanelState(), 0.71);
  assert.equal(createPanelState(serializePanelState(s)).height, 0.71);
  assert.equal(createPanelState({ height: 9 }).height, PANEL_HEIGHT.MAX,
    'including a value hand-edited into storage');
});

check('setting the height it already has changes nothing', () => {
  const s = createPanelState();
  assert.equal(setHeight(s, PANEL_HEIGHT.DEFAULT), s);
});

check('the two choices are independent', () => {
  const s = setHeight(selectTab(createPanelState(), PANEL_TABS.THUMBS), 0.8);
  assert.equal(s.tab, PANEL_TABS.THUMBS);
  assert.equal(s.height, 0.8);
});

check('pulling the grip up past the stop means "close this"', () => {
  // The panel stops shrinking at MIN, so the stretch between MIN and CLOSE_AT
  // is a deliberate pull against a stop rather than an overshoot.
  assert.ok(PANEL_HEIGHT.CLOSE_AT < PANEL_HEIGHT.MIN, 'strictly below the floor');
  assert.equal(shouldClose(0.05), true);
  assert.equal(shouldClose(PANEL_HEIGHT.CLOSE_AT - 0.001), true);
});

check('resting at the smallest useful size is not closing it', () => {
  assert.equal(shouldClose(PANEL_HEIGHT.MIN), false);
  assert.equal(shouldClose(PANEL_HEIGHT.CLOSE_AT), false, 'the threshold itself still holds');
  assert.equal(shouldClose(0.5), false);
});

check('a drag that produced no number closes nothing', () => {
  assert.equal(shouldClose(NaN), false);
  assert.equal(shouldClose(undefined), false);
});

check('closing by drag does not become the remembered height', () => {
  // setHeight can never store anything below MIN, so a pull to 0.05 that were
  // (wrongly) saved would come back as MIN rather than as "closed".
  const s = setHeight(createPanelState(), 0.05);
  assert.equal(s.height, PANEL_HEIGHT.MIN,
    'which is why the close path skips saving and keeps the height it had');
});

// ═══════════════════════════════════════════════════════════════
group('3. Which pages are worth keeping rendered');

check('the window is centred on where the reader is', () => {
  const w = thumbWindow(400, 827, 24);
  assert.deepEqual(w, { from: 376, to: 424 });
  assert.ok(inThumbWindow(w, 400) && inThumbWindow(w, 376) && inThumbWindow(w, 424));
  assert.ok(!inThumbWindow(w, 375) && !inThumbWindow(w, 425));
});

check('it never runs off either end of the book', () => {
  assert.deepEqual(thumbWindow(2, 827, 24), { from: 1, to: 26 });
  assert.deepEqual(thumbWindow(826, 827, 24), { from: 802, to: 827 });
});

check('a book shorter than the window is simply all of it', () => {
  assert.deepEqual(thumbWindow(3, 5, 24), { from: 1, to: 5 });
});

check('827 pages never means 827 live canvases', () => {
  const w = thumbWindow(400, 827, 24);
  assert.equal(w.to - w.from + 1, 49, 'a bounded band, not the whole book');
});

check('an empty or unknown book asks for nothing', () => {
  const w = thumbWindow(1, 0, 24);
  assert.ok(w.to < w.from, 'an empty range');
  assert.equal(inThumbWindow(w, 1), false);
  assert.ok(thumbWindow(1, NaN, 24).to < thumbWindow(1, NaN, 24).from);
});

check('a page number outside the book is pulled back into it', () => {
  // The current page and the page count come from different objects and can
  // disagree for a frame while a book is being swapped.
  assert.deepEqual(thumbWindow(9000, 10, 3), { from: 7, to: 10 });
  assert.deepEqual(thumbWindow(-5, 10, 3), { from: 1, to: 4 });
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
