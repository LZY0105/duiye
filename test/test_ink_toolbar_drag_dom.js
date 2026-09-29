#!/usr/bin/env node
// Ink toolbar drag lifecycle — real DOM, real pointer events.
//
// The state machine in toolbar-state.js is pure and already well covered, and
// every one of those tests passed while dragging the toolbar in a browser left
// it permanently stuck as a drag token with no handle and no tools.
//
// The gap was never in the state: it was that `render()` replaces
// `root.innerHTML`, and the drag used to bind pointermove/pointerup to the
// handle element inside it. `_set(startDrag(...))` renders synchronously, so
// the handle — and its listeners, and its pointer capture — were destroyed
// during the pointerdown that started the drag. pointerup then had nothing to
// land on and `endDrag()` never ran.
//
// A pure state test cannot see that, because in a pure test nothing replaces a
// DOM node. So this file drives the component through a DOM: it dispatches
// genuine PointerEvents and asserts on what is left in the tree afterwards.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ── environment ─────────────────────────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

// The component reads these off the globals, the way it does in a browser.
for (const key of [
  'window', 'document', 'localStorage',
  'PointerEvent', 'Event', 'MutationObserver', 'DOMMatrixReadOnly',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
]) {
  if (dom.window[key] === undefined) continue;
  // Node defines some of these as getter-only on globalThis (`navigator`), so
  // assignment has to go through defineProperty rather than `=`.
  Object.defineProperty(globalThis, key, {
    value: dom.window[key], configurable: true, writable: true,
  });
}

// jsdom has no layout engine, so every rect is zero and `nearestEdge()` would
// be asked to pick an edge of a zero-sized workspace. Give it a real one.
const HOST_RECT = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0 };

// jsdom implements the pointer-capture API only partially; the component
// already treats it as best-effort, and these stubs let the capture/release
// calls resolve so the rest of the lifecycle is exercised for real.
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};

const { InkToolbar } = await import('../src/ink/ink-toolbar.js');
const { InkSurface } = await import('../src/ink/ink-surface.js');

/** The bar the last mount created, so the next one can retire it. */
let mounted = null;

function mountToolbar() {
  dom.window.localStorage.clear();
  // Replacing the body detaches the DOM but leaves every window listener the
  // previous toolbar installed. They then run for the rest of the file.
  if (mounted) { try { mounted.destroy(); } catch (_) { /* already gone */ } }
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ ...HOST_RECT });
  document.body.appendChild(host);
  const bar = new InkToolbar(host, { getSurface: () => null });
  mounted = bar;
  if (!TOOL_COUNT) TOOL_COUNT = bar.root.querySelectorAll('.ink-tool').length;
  return { host, bar };
}

/**
 * A toolbar wired to a REAL surface.
 *
 * Tool buttons reach the surface through `_pushToSurface`, and that method is
 * where the eraser regression lived: it calls `setEraser()` for the eraser and
 * `setTool()` for everything else, so a test that only drives the surface
 * directly never touches the path the user actually takes.
 */
function mountWithSurface() {
  dom.window.localStorage.clear();
  if (mounted) { try { mounted.destroy(); } catch (_) { /* already gone */ } }
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ ...HOST_RECT });
  document.body.appendChild(host);

  const canvas = document.createElement('canvas');
  canvas.getContext = () => ({
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, arc() {}, stroke() {}, fill() {}, clearRect() {},
    setLineDash() {}, setTransform() {}, quadraticCurveTo() {}, bezierCurveTo() {},
  });
  const surface = new InkSurface(canvas, {});

  const bar = new InkToolbar(host, { getSurface: () => surface });
  mounted = bar;
  return { bar, surface };
}

function pointer(type, { x = 0, y = 0, id = 1, target } = {}) {
  const ev = new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: id, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
  (target || dom.window).dispatchEvent(ev);
  return ev;
}

/** Drives one complete drag: grab the handle, move, then finish with `endWith`. */
function drag(bar, { from = [40, 40], to = [820, 300], endWith = 'pointerup', id = 1 } = {}) {
  const handle = bar.root.querySelector('[data-role="handle"]');
  assert.ok(handle, 'the handle must exist before a drag can start');
  pointer('pointerdown', { x: from[0], y: from[1], id, target: handle });
  pointer('pointermove', { x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2, id });
  pointer('pointermove', { x: to[0], y: to[1], id });
  pointer(endWith, { x: to[0], y: to[1], id });
}

// The tool count is read from the bar rather than hardcoded: these tests are
// about the DRAG lifecycle, and they should not fail every time the toolbar
// gains or loses a tool. TOOL_COUNT is captured from a freshly mounted bar.
let TOOL_COUNT = 0;

const isExpanded = (bar) => ({
  phase: bar.state.phase,
  handles: bar.root.querySelectorAll('[data-role="handle"]').length,
  tools: bar.root.querySelectorAll('.ink-tool').length,
  tokens: bar.root.querySelectorAll('.ink-token').length,
});

// ── the regression ──────────────────────────────────────────────────────────

console.log('\nink toolbar — drag lifecycle across DOM replacement');

test('pointerdown collapses the bar to its drag token', () => {
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, target: handle });
  assert.equal(bar.state.phase, 'dragging', 'the drag must actually start');
  assert.equal(bar.root.querySelectorAll('.ink-token').length, 1, 'the token replaces the bar');
});

test('the node that owned pointer capture is gone once the drag starts', () => {
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, target: handle });
  // This is the condition that broke the old implementation. Asserting it
  // keeps the test honest: if a later refactor stops replacing the handle,
  // this test would silently stop covering the thing it was written for.
  assert.equal(handle.isConnected, false, 'render() must have detached the original handle');
  assert.equal(bar.root.querySelectorAll('[data-role="handle"]').length, 0);
});

test('pointerup ends the drag and restores the whole toolbar', () => {
  const { bar } = mountToolbar();
  drag(bar);
  const after = isExpanded(bar);
  assert.equal(after.phase, 'expanded', 'phase must leave dragging');
  assert.equal(after.handles, 1, 'the drag handle must come back');
  assert.equal(after.tools, TOOL_COUNT, 'every tool button must come back');
  assert.equal(after.tokens, 0, 'the drag token must be gone');
});

test('pointercancel ends the drag the same way', () => {
  const { bar } = mountToolbar();
  drag(bar, { endWith: 'pointercancel' });
  assert.deepEqual(isExpanded(bar), { phase: 'expanded', handles: 1, tools: TOOL_COUNT, tokens: 0 });
});

test('lostpointercapture ends the drag the same way', () => {
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, target: handle });
  pointer('pointermove', { x: 500, y: 300 });
  pointer('lostpointercapture', { x: 500, y: 300 });
  assert.deepEqual(isExpanded(bar), { phase: 'expanded', handles: 1, tools: TOOL_COUNT, tokens: 0 });
});

test('a pointer released outside the toolbar still ends the drag', () => {
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, target: handle });
  pointer('pointermove', { x: 995, y: 400 });
  // Released on the page, far from the toolbar and its host. Mid-edge, not a
  // corner: a corner release is a DOCK, which is its own test below.
  pointer('pointerup', { x: 995, y: 400, target: document.body });
  assert.equal(bar.state.phase, 'expanded');
  assert.equal(bar.root.querySelectorAll('[data-role="handle"]').length, 1);
});

test('a corner release parks the bar as a puck, and a tap unfolds it', () => {
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 400, target: handle });
  pointer('pointermove', { x: 970, y: 770 });
  pointer('pointerup', { x: 970, y: 770, target: document.body });

  assert.equal(bar.state.phase, 'docked', 'a corner does not unfold the bar');
  assert.equal(bar.state.corner, 'bottom-right');
  assert.equal(bar.root.querySelectorAll('.ink-token').length, 1, 'it stays a circle');
  assert.equal(bar.root.querySelectorAll('.ink-tool').length, 0, 'and nothing unfolds');
  assert.ok(bar.root.classList.contains('is-docked'));

  // The puck is still the handle, so it can be picked up again.
  const puck = bar.root.querySelector('[data-role="handle"]');
  assert.ok(puck, 'the puck must be grabbable');

  // A press that goes nowhere is a tap, and a tap expands.
  pointer('pointerdown', { x: 960, y: 760, target: puck });
  assert.equal(bar.state.phase, 'docked', 'a press alone must not move it');
  pointer('pointerup', { x: 962, y: 761, target: puck });
  assert.equal(bar.state.phase, 'expanded', 'the tap unfolded it');
  assert.equal(bar.root.querySelectorAll('.ink-tool').length, TOOL_COUNT);
});

test('unfolding measures the bar it becomes, not one still easing open', () => {
  const { bar, host } = mountToolbar();
  // 工作区要在屏幕上：不在屏幕上（切到设置页）时横杠本来就不摆位置，见 render。
  measurable(bar, host);
  drag(bar, { from: [40, 400], to: [970, 770] });
  assert.equal(bar.state.phase, 'docked', 'precondition: parked in a corner');

  // `.is-docked` sets `padding: 0`, and the bar transitions padding over 200ms
  // on the way out of it. `_clampIntoHost()` positions the bar by measuring
  // `offsetHeight`; run while that padding is still easing open it measures a
  // short bar and centres it too high. Nothing corrects that until the NEXT
  // render — which is the first tool tap — and that one measures the settled
  // height and drops the bar a few pixels. That step is the "slight downward
  // jump after expanding" the tablet run reported.
  const clampedUnder = [];
  const realClamp = bar._clampIntoHost.bind(bar);
  bar._clampIntoHost = () => {
    clampedUnder.push(bar.root.classList.contains('is-instant'));
    realClamp();
  };

  const puck = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 960, y: 760, target: puck });
  pointer('pointerup', { x: 962, y: 761, target: puck });

  assert.equal(bar.state.phase, 'expanded', 'the tap unfolded it');
  assert.ok(clampedUnder.length > 0, 'unfolding does place the bar');
  assert.ok(clampedUnder[0],
    'and it measures with the size transition suppressed, so the first '
    + 'measurement is the settled one and there is nothing left to correct');
});

test('dragging the puck moves it instead of expanding it', () => {
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  drag(bar, { from: [40, 400], to: [970, 770] });
  assert.equal(bar.state.phase, 'docked');
  void handle;

  const puck = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 960, y: 760, target: puck });
  pointer('pointermove', { x: 500, y: 400 });
  assert.equal(bar.state.phase, 'dragging', 'travel past the slop starts a drag');
  pointer('pointerup', { x: 500, y: 400 });
  assert.equal(bar.state.phase, 'expanded', 'released mid-page, it goes back to an edge');
  assert.equal(bar.state.corner, null);
});

test('a second pointer cannot terminate the drag owned by the first', () => {
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, id: 1, target: handle });
  pointer('pointerup', { x: 300, y: 300, id: 7 });
  assert.equal(bar.state.phase, 'dragging', 'a stray pointer must not end someone else’s drag');
  pointer('pointerup', { x: 300, y: 300, id: 1 });
  assert.equal(bar.state.phase, 'expanded');
});

test('the drag commits a new edge and survives the round trip', () => {
  const { bar } = mountToolbar();
  const before = bar.state.edge;
  // Far right of a 1000x800 host: the nearest edge is unambiguous.
  drag(bar, { from: [40, 400], to: [995, 400] });
  assert.equal(bar.state.phase, 'expanded');
  assert.equal(bar.state.edge, 'right', `expected the bar to dock right, not ${bar.state.edge}`);
  assert.notEqual(bar.state.edge, before);
});

test('20 consecutive drags each terminate cleanly', () => {
  const { bar } = mountToolbar();
  const corners = [[995, 400], [5, 400], [500, 795], [500, 5]];
  for (let i = 0; i < 20; i++) {
    const to = corners[i % corners.length];
    drag(bar, { from: [10, 10], to, id: i + 1 });
    const state = isExpanded(bar);
    assert.equal(state.phase, 'expanded', `drag ${i + 1} left the bar in ${state.phase}`);
    assert.equal(state.handles, 1, `drag ${i + 1} lost the handle`);
    assert.equal(state.tools, TOOL_COUNT, `drag ${i + 1} lost the tools`);
    assert.equal(state.tokens, 0, `drag ${i + 1} left a stale drag token`);
  }
});

test('tool selection still works after a drag', () => {
  const { bar } = mountToolbar();
  drag(bar);
  const pencil = bar.root.querySelector('[data-tool="pencil"]');
  assert.ok(pencil, 'the pencil button must be reachable after a drag');
  pencil.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(bar.state.tool, 'pencil');
});

test('the drag listeners are installed once, not once per render', () => {
  const { bar } = mountToolbar();
  const first = bar._onDragMove;
  for (let i = 0; i < 10; i++) bar.render();
  assert.equal(bar._onDragMove, first, 'render() must not rebind the drag controller');
  // And the rebound handle still starts a drag.
  drag(bar);
  assert.equal(bar.state.phase, 'expanded');
});

// ── teardown ────────────────────────────────────────────────────────────────
//
// The version of this test that shipped first asserted only that the root was
// detached and that a later pointerup did not throw. A leaked handler has no
// reason to throw, so that test passed against an implementation whose
// effective destroy() removed none of its window listeners. Both tests
// below are written so that restoring that implementation fails them.

/** Records every window listener registered while `fn` runs, minus the removed ones. */
function trackingWindowListeners(fn) {
  const live = new Map(); // handler → Set of event types still registered
  const origAdd = dom.window.addEventListener;
  const origRemove = dom.window.removeEventListener;

  dom.window.addEventListener = function (type, handler, opts) {
    if (!live.has(handler)) live.set(handler, new Set());
    live.get(handler).add(type);
    return origAdd.call(this, type, handler, opts);
  };
  dom.window.removeEventListener = function (type, handler, opts) {
    live.get(handler)?.delete(type);
    return origRemove.call(this, type, handler, opts);
  };

  try {
    return fn(() => [...live.values()].flatMap(types => [...types]).sort());
  } finally {
    dom.window.addEventListener = origAdd;
    dom.window.removeEventListener = origRemove;
  }
}

test('destroy() gives back every window listener the toolbar took', () => {
  trackingWindowListeners((stillRegistered) => {
    const { bar } = mountToolbar();

    const taken = stillRegistered();
    // `click` joined the list when the puck had to suppress the click the
    // browser synthesises after a tap on it. It is the one listener here whose
    // effect is not scoped by a pointer id, so it matters most that destroy()
    // gives it back.
    assert.deepEqual(
      taken,
      ['click', 'lostpointercapture', 'pointercancel', 'pointermove', 'pointerup'],
      `the drag controller must own exactly its window listeners, saw ${taken.join(', ') || 'none'}`,
    );

    bar.destroy();

    const leaked = stillRegistered();
    assert.deepEqual(leaked, [], `destroy() left ${leaked.join(', ')} registered on window`);
  });
});

test('a toolbar destroyed mid-drag cannot be driven by the rest of that gesture', () => {
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, id: 3, target: handle });
  assert.equal(bar.state.phase, 'dragging', 'the drag must be live when destroy() lands');

  bar.destroy();

  // Everything a leaked handler would reach: the render, the state, the
  // persisted placement and the host's callback.
  let renders = 0;
  bar.render = () => { renders++; };
  let changes = 0;
  bar.handlers.onChange = () => { changes++; };
  const stateAtTeardown = JSON.stringify(bar.state);
  const storedAtTeardown = dom.window.localStorage.getItem('ls_ink_toolbar');

  // The same pointer id, continuing the gesture destroy() interrupted.
  pointer('pointermove', { x: 700, y: 500, id: 3 });
  pointer('pointerup', { x: 700, y: 500, id: 3 });
  pointer('pointercancel', { x: 700, y: 500, id: 3 });
  pointer('lostpointercapture', { x: 700, y: 500, id: 3 });

  assert.equal(renders, 0, 'a destroyed toolbar must not render');
  assert.equal(changes, 0, 'a destroyed toolbar must not call back into the host');
  assert.equal(JSON.stringify(bar.state), stateAtTeardown, 'a destroyed toolbar must not change state');
  assert.equal(
    dom.window.localStorage.getItem('ls_ink_toolbar'), storedAtTeardown,
    'a destroyed toolbar must not write its placement',
  );
  assert.equal(bar.root.isConnected, false, 'the toolbar must leave the document');
  assert.equal(bar._drag.pointerId, null, 'destroy() must end the drag it interrupted');
});

// ── continuous controls survive their own gesture ───────────────────────────
//
// A slider fires `input` on every pixel of a drag. If the handler rebuilds the
// card, the very <input> the pointer is holding is replaced, the browser drops
// the drag with it, and the control moves once and then goes dead — clickable,
// not draggable. That is the third time this shape of bug has appeared in this
// file's subject (the handle, the lens, now the sliders), so it gets a test.

test('the eraser still erases after the lasso has been used', () => {
  // The bug as the user hit it: pick the lasso, pick the eraser, and every
  // press ran the lasso instead. Driven through the buttons, not the surface,
  // because the toolbar reaches the eraser by a different method than every
  // other tool and that asymmetry is what broke.
  const { bar, surface } = mountWithSurface();
  const press = (tool) => bar.root.querySelector(`[data-tool="${tool}"]`).click();

  press('lasso');
  assert.equal(surface.selecting, true, 'precondition: the lasso is in hand');

  press('eraser');
  assert.equal(surface.erasing, true, 'the eraser must be live');
  assert.equal(surface.selecting, false, 'and the lasso must have let go');

  press('lasso');
  press('pen');
  assert.equal(surface.selecting, false);
  assert.equal(surface.erasing, false);
  assert.equal(surface.tool, 'pen', 'and a pen draws again');
});

test('a tap on the puck cannot reach a control underneath it', () => {
    // TBR-04 from the tablet run: a puck parked at the top-left could not be
    // reopened, and the tap opened the Android file picker instead. The click
    // the browser synthesises after the tap outlives the token — the render
    // that expands the toolbar destroys it — and a click whose target is gone
    // gets retargeted to whatever is behind it, which there was 导入练习册.
    const { bar } = mountToolbar();

    // Something underneath, standing in for the import button.
    const underneath = document.createElement('button');
    let opened = 0;
    underneath.addEventListener('click', function () { opened++; });
    document.body.insertBefore(underneath, document.body.firstChild);

    drag(bar, { from: [40, 400], to: [12, 12] });
    assert.equal(bar.state.phase, 'docked', 'precondition: parked in the top-left');

    const puck = bar.root.querySelector('[data-role="handle"]');
    pointer('pointerdown', { x: 14, y: 14, target: puck });
    pointer('pointerup', { x: 15, y: 14, target: puck });
    assert.equal(bar.state.phase, 'expanded', 'the tap must expand the toolbar');

    // The retargeted click, as the browser delivers it once the token is gone.
    underneath.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(opened, 0, 'the toolbar\'s own tap must not reach the control behind it');

    // And the very next click still works — the guard is for one click, not
    // for every click after a toolbar gesture.
    underneath.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(opened, 1, 'only the synthesised one is swallowed');
    underneath.remove();
  });

test('a cancelled drag lands where the pointer was, not at the origin', () => {
    // TBR-06: Android delivers pointercancel with stale or zero coordinates
    // when it takes a gesture over. Read as a release, (0, 0) is the top-left
    // corner of the workspace — so a puck dragged from anywhere jumped there
    // and stayed collapsed.
    const { bar } = mountToolbar();
    const handle = bar.root.querySelector('[data-role="handle"]');

    pointer('pointerdown', { x: 40, y: 400, target: handle });
    pointer('pointermove', { x: 980, y: 770 });
    assert.equal(bar.state.phase, 'dragging');

    // The system takes the gesture, and says nothing useful about where.
    pointer('pointercancel', { x: 0, y: 0 });

    assert.equal(bar.state.corner, 'bottom-right',
      'it must dock where the finger actually was');
    assert.notEqual(bar.state.corner, 'top-left', 'and never at the coordinate origin');
  });

test('a slider is not destroyed by its own input event', () => {
  const { bar } = mountToolbar();
  // Tapping the already-selected tool opens its settings card.
  const selected = bar.root.querySelector('.ink-tool.is-selected')
    || bar.root.querySelector('[data-tool]');
  selected.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

  const card = bar.cardLayer.querySelector('.ink-card');
  assert.ok(card, 'the tool card must open');
  const slider = card.querySelector('input[type="range"][data-role="width"]');
  assert.ok(slider, 'the width slider must exist');

  slider.value = '9';
  slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  assert.equal(slider.isConnected, true,
    'the element being dragged must still be in the document afterwards');
  assert.equal(bar.state.width, 9, 'and the value must have been committed');

  // A second event from the same element must still land — this is what a drag
  // actually is.
  slider.value = '13';
  slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(bar.state.width, 13, 'a drag is many input events from one element');
});

test('the eraser size slider survives its own input too', () => {
  const { bar } = mountToolbar();
  const eraser = bar.root.querySelector('[data-tool="eraser"]');
  eraser.dispatchEvent(new dom.window.Event('click', { bubbles: true }));   // select
  eraser.dispatchEvent(new dom.window.Event('click', { bubbles: true }));   // open card

  const slider = bar.cardLayer.querySelector('input[data-role="eraser-width"]');
  assert.ok(slider, 'the eraser card must carry its size slider');
  slider.value = '24';
  slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(slider.isConnected, true, 'still draggable');
  assert.equal(bar.state.eraserWidth, 24);
});

test('destroy() is idempotent', () => {
  const { bar } = mountToolbar();
  bar.destroy();
  assert.doesNotThrow(() => bar.destroy());
  assert.equal(bar.root.isConnected, false);
});

// ── stepping aside, and coming back ─────────────────────────────────────────
//
// A deck list opening over the bar used to display:none it. Nothing travelled,
// so there was nothing to follow, and it reappeared out of nowhere when the
// list closed. Now it folds into the puck and flies to a corner — and the
// placement it left behind is a debt, not a new home. These tests are about
// that debt: what it is worth is that the bar comes back to the SAME place,
// and that a list which happened to be open at the last save cannot decide
// where the bar lives next launch.

const RECT = (left, top, right, bottom) => ({
  left, top, right, bottom, x: left, y: top,
  width: right - left, height: bottom - top,
});

test('a yield folds the bar into the puck in the corner it was given', () => {
  const { bar } = mountToolbar();
  bar.yieldTo('bottom-left');
  assert.equal(bar.isYielded(), true);
  assert.equal(bar.state.phase, 'docked');
  assert.equal(bar.state.corner, 'bottom-left');
  assert.equal(bar.root.classList.contains('is-docked'), true, 'and it looks like the puck');
});

test('restoring gives back the exact placement it borrowed', () => {
  const { bar } = mountToolbar();
  const before = { phase: bar.state.phase, edge: bar.state.edge, offset: bar.state.offset };
  bar.yieldTo('bottom-right');
  bar.restoreFromYield();
  assert.equal(bar.isYielded(), false);
  assert.equal(bar.state.phase, before.phase);
  assert.equal(bar.state.edge, before.edge);
  assert.equal(bar.state.offset, before.offset);
  assert.equal(bar.state.corner, null, 'and it is not left parked in the borrowed corner');
  assert.equal(bar.root.classList.contains('is-docked'), false);
});

test('a bar the reader docked themselves gets THEIR corner back', () => {
  // The two states look identical on screen. Only one of them is owed back.
  const { bar } = mountToolbar();
  drag(bar, { from: [40, 40], to: [980, 780] });
  assert.equal(bar.state.phase, 'docked', 'parked by hand');
  const chosen = bar.state.corner;
  assert.equal(chosen, 'bottom-right', 'the drag went to the bottom right');
  bar.yieldTo('bottom-left');
  assert.equal(bar.state.corner, 'bottom-left', 'it moved off the list');
  bar.restoreFromYield();
  assert.equal(bar.state.corner, chosen);
  assert.equal(bar.state.phase, 'docked');
});

test('a yield will not go to a top corner even when asked to', () => {
  // "Sometimes it goes to the top corner, sometimes the bottom": stepping
  // aside has to land in the same place every time, or it is not a place.
  const { bar } = mountToolbar();
  bar.yieldTo('top-left');
  assert.equal(bar.isYielded(), false, 'refused outright rather than obeyed');
  assert.equal(bar.state.phase, 'expanded', 'and the bar is left alone');

  bar.yieldTo(['top-left', 'top-right', 'bottom-left']);
  assert.equal(bar.state.corner, 'bottom-left', 'the tops are dropped, the floor is kept');
});

test('a borrowed corner is never what gets written to storage', () => {
  const { bar } = mountToolbar();
  const owed = bar.state.offset;
  bar.yieldTo('bottom-left');
  const saved = JSON.parse(dom.window.localStorage.getItem('ls_ink_toolbar'));
  assert.equal(saved.corner, null, 'a list that happened to be open cannot re-home the bar');
  assert.equal(saved.offset, owed);
});

test('a yield never interrupts a drag in progress', () => {
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, target: handle });
  pointer('pointermove', { x: 300, y: 300 });
  assert.equal(bar.state.phase, 'dragging');
  bar.yieldTo('bottom-left');
  assert.equal(bar.state.phase, 'dragging', 'the token stays under the stylus');
  assert.equal(bar.isYielded(), false);
  pointer('pointerup', { x: 300, y: 300 });
});

test('the first corner that clears the panel is the one it lands in', () => {
  const { bar } = mountToolbar();
  // jsdom has no layout, so the puck is told where each corner would put it.
  // bottom-left is still under the panel; bottom-right is not.
  const where = { 'bottom-left': RECT(0, 700, 60, 760), 'bottom-right': RECT(940, 700, 1000, 760) };
  bar.root.getBoundingClientRect = () => where[bar.state.corner] || RECT(0, 0, 0, 0);
  bar.yieldTo(['bottom-left', 'bottom-right'], RECT(0, 100, 500, 800));
  assert.equal(bar.state.corner, 'bottom-right');
});

test('every corner covered still parks it — small and in a corner beats across the panel', () => {
  const { bar } = mountToolbar();
  bar.root.getBoundingClientRect = () => RECT(0, 700, 60, 760);
  bar.yieldTo(['bottom-left', 'bottom-right'], RECT(0, 0, 1000, 800));
  assert.equal(bar.isYielded(), true);
});

test('restoring a bar that never yielded does nothing at all', () => {
  const { bar } = mountToolbar();
  const before = bar.state;
  bar.restoreFromYield();
  assert.equal(bar.state, before);
});

test('a second yield does not overwrite the debt', () => {
  const { bar } = mountToolbar();
  const owed = bar.state.offset;
  bar.yieldTo('bottom-left');
  bar.yieldTo('top-right');
  assert.equal(bar.state.corner, 'bottom-left', 'the second call is refused outright');
  bar.restoreFromYield();
  assert.equal(bar.state.offset, owed);
});

// ── what actually travels ───────────────────────────────────────────────────
//
// The first version of the fold animated the element itself, and the element
// is the PUCK by the time there is anything to animate: render() swaps the
// bar's contents in one frame, so all that was left to scale was a circle. It
// stretched into a tall ellipse and squashed back — which is not a bar folding
// up, and read as a glitch. What has to travel is a still of the bar, taken
// the instant before the swap.

/** A test that may await. The sync `test()` above would score a rejected
    promise as a pass, which is how the first cut of these hid its own failure. */
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

/** jsdom has no Web Animations API; this is enough of one to assert against. */
function fakeAnimations() {
  const played = [];
  let settle;
  const finished = new Promise((res) => { settle = res; });
  const real = dom.window.Element.prototype.animate;
  dom.window.Element.prototype.animate = function (frames, opts) {
    const anim = { frames, opts, cancelled: false, finished, cancel() { this.cancelled = true; } };
    played.push({ el: this, anim });
    return anim;
  };
  return {
    played,
    finish: async () => { settle(); await finished; await Promise.resolve(); },
    restore: () => { dom.window.Element.prototype.animate = real; },
  };
}

const BAR_RECT = { left: 10, top: 100, right: 62, bottom: 660, x: 10, y: 100, width: 52, height: 560 };
const PUCK_RECT = { left: 10, top: 742, right: 58, bottom: 790, x: 10, y: 742, width: 48, height: 48 };

/**
 * A bar that knows its own size.
 *
 * jsdom lays nothing out, so every rect is zero — and a zero-sized bar is
 * correctly given no fold at all, which made the first cut of these tests
 * assert against a feature that had quietly switched itself off.
 */
function mountForFold() {
  const { bar } = mountToolbar();
  bar.root.getBoundingClientRect = () => ({ ...(bar.state.phase === 'docked' ? PUCK_RECT : BAR_RECT) });
  return bar;
}

const ghosts = () => document.querySelectorAll('[data-role="toolbar-ghost"]');

test('the fold sends a picture of the BAR travelling, not the puck', () => {
  const anims = fakeAnimations();
  try {
    const bar = mountForFold();
    const toolCount = bar.root.querySelectorAll('.ink-tool').length;
    assert.ok(toolCount > 0, 'the bar has tools to begin with');

    bar.yieldTo('bottom-left');

    assert.equal(ghosts().length, 1, 'exactly one still is in the air');
    const ghost = ghosts()[0];
    assert.equal(ghost.querySelectorAll('.ink-tool').length, toolCount,
      'and it is the bar, complete with its tools — not the circle it became');
    assert.equal(ghost.getAttribute('aria-hidden'), 'true', 'invisible to a screen reader');
    assert.equal(ghost.style.pointerEvents, 'none', 'and it swallows no taps');

    const travelled = anims.played.find(({ el }) => el === ghost);
    assert.ok(travelled, 'the still is what is animated');
    const [from, to] = travelled.anim.frames;
    assert.equal(from.transform, 'none', 'starting where the bar was');
    assert.match(to.transform, /translate\(.+\) scale\(/, 'and shrinking as it travels');
    assert.equal(to.opacity, 0, 'handing over rather than piling up');
    assert.ok(travelled.anim.opts.duration >= 300,
      'slow enough to be seen — a fold nobody asked for has to be legible');
  } finally { anims.restore(); }
});

test('it shrinks to the size of the puck, and lands on it', () => {
  const anims = fakeAnimations();
  try {
    const bar = mountForFold();
    bar.yieldTo('bottom-left');
    const [, to] = anims.played.find(({ el }) => el === ghosts()[0]).anim.frames;
    const [, sx, sy] = to.transform.match(/scale\(([\d.]+), ([\d.]+)\)/).map(Number);
    assert.ok(Math.abs(sx - PUCK_RECT.width / BAR_RECT.width) < 0.001, 'across');
    assert.ok(Math.abs(sy - PUCK_RECT.height / BAR_RECT.height) < 0.001, 'and down to a ball');

    const [, dx, dy] = to.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/).map(Number);
    const wantX = (PUCK_RECT.left + PUCK_RECT.width / 2) - (BAR_RECT.left + BAR_RECT.width / 2);
    const wantY = (PUCK_RECT.top + PUCK_RECT.height / 2) - (BAR_RECT.top + BAR_RECT.height / 2);
    assert.ok(Math.abs(dx - wantX) < 0.001 && Math.abs(dy - wantY) < 0.001,
      'centre to centre, so it arrives ON the corner rather than near it');
  } finally { anims.restore(); }
});

test('the puck is brought up as the still goes out, not before', () => {
  const anims = fakeAnimations();
  try {
    const bar = mountForFold();
    bar.yieldTo('bottom-left');
    const onPuck = anims.played.find(({ el }) => el === bar.root);
    assert.ok(onPuck, 'the puck fades in on its own');
    assert.equal(onPuck.anim.frames[0].opacity, 0, 'starting invisible');
    assert.ok(onPuck.anim.opts.delay > 0, 'and held back while the still is still on its way');
    assert.equal(onPuck.anim.opts.fill, 'backwards', 'invisible during the wait, not just after it');
  } finally { anims.restore(); }
});

await atest('the still is taken down once it has arrived', async () => {
  const anims = fakeAnimations();
  try {
    const bar = mountForFold();
    bar.yieldTo('bottom-left');
    assert.equal(ghosts().length, 1);
    await anims.finish();
    assert.equal(ghosts().length, 0, 'nothing is left lying over the page');
  } finally { anims.restore(); }
});

test('a list closed mid-fold does not leave the still behind', () => {
  const anims = fakeAnimations();
  try {
    const bar = mountForFold();
    bar.yieldTo('bottom-left');
    assert.equal(ghosts().length, 1);
    bar.restoreFromYield();
    assert.equal(ghosts().length, 0, 'the bar is coming back; the picture of it must go');
  } finally { anims.restore(); }
});

test('a reader who asked for less motion gets no still at all', () => {
  const anims = fakeAnimations();
  const realMM = dom.window.matchMedia;
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  try {
    const bar = mountForFold();
    bar.yieldTo('bottom-left');
    assert.equal(ghosts().length, 0);
    assert.equal(bar.isYielded(), true, 'but it still gets out of the way');
    assert.equal(bar.state.corner, 'bottom-left');
  } finally { dom.window.matchMedia = realMM; anims.restore(); }
});

// ── one anchor at a time ────────────────────────────────────────────────────
//
// The bar stepped aside and disappeared instead of landing in the corner.
// _positionDocked() anchors the puck to the two sides of its corner —
// left + bottom — and clears top. Then fitTo(), which the workspace calls from
// onChange on the very _set() that docked it, re-clamped and wrote `top` back.
//
// An absolutely positioned element given BOTH top and bottom is not moved by
// the second one, it is STRETCHED between them: the 48px puck became a 549px
// sliver, and translateY(-50%) then lifted it 274px off the top of the screen.
// Nothing was hidden and nothing was faded — it was pulled out of the viewport.
//
// It only happened some of the time because fitTo() returns early when the
// scale has not moved, so whether the bar survived came down to whether
// docking changed how big it wanted to be.

/** Gives jsdom enough measurements for _clampIntoHost to want to run. */
function measurable(bar, host) {
  Object.defineProperty(host, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: 700, configurable: true });
  Object.defineProperty(bar.root, 'offsetWidth', { value: 52, configurable: true });
  Object.defineProperty(bar.root, 'offsetHeight', { value: 560, configurable: true });
}

test('clamping leaves a folded-away bar alone', () => {
  const { bar, host } = mountToolbar();
  measurable(bar, host);

  bar.yieldTo('bottom-left');
  assert.equal(bar.state.corner, 'bottom-left');
  bar._clampIntoHost();

  const s = bar.root.style;
  assert.equal(s.bottom, '10px', 'still anchored to the floor of its corner');
  assert.equal(s.top, '', 'and NOT also to the top — that would stretch it, not move it');
  assert.equal(s.transform, '', 'nor shifted half its own height off the screen');
});

test('clamping leaves a token under the pointer alone', () => {
  const { bar, host } = mountToolbar();
  measurable(bar, host);
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, target: handle });
  pointer('pointermove', { x: 300, y: 300 });
  assert.equal(bar.state.phase, 'dragging');

  bar._clampIntoHost();
  assert.equal(bar.root.style.top, '300px', 'it stays where the pen is');
  pointer('pointerup', { x: 300, y: 300 });
});

test('and still clamps the bar it is meant to clamp', () => {
  const { bar, host } = mountToolbar();
  measurable(bar, host);
  assert.equal(bar.state.phase, 'expanded');
  bar.root.style.top = '';
  bar._clampIntoHost();
  assert.notEqual(bar.root.style.top, '', 'an expanded bar is still kept inside the workspace');
});
// ── the tap that expands must not also pick something ───────────────────────
//
// Parking the bar with the marker selected, closing the app, reopening it and
// tapping the puck gave back the LASSO. The tap expands the bar, which puts a
// whole column of tool buttons under a finger that is still down, and the
// click that follows lands on whichever one now occupies that spot.
//
// The swallow that exists for exactly this let it through, because it made an
// exception for clicks landing inside the toolbar — reasonable after a drag,
// where the bar under the finger is the same bar, and wrong here, where every
// control under the finger is one second old.

test('expanding a parked puck does not select whatever lands under the finger', () => {
  const { bar } = mountToolbar();
  // Park it, the way a drag into a corner does.
  drag(bar, { from: [40, 40], to: [980, 780] });
  assert.equal(bar.state.phase, 'docked', 'parked');
  const parkedWith = bar.state.tool;

  // Tap it: press and release without travelling.
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 970, y: 770, target: handle || bar.root });
  pointer('pointerup', { x: 970, y: 770 });
  assert.equal(bar.state.phase, 'expanded', 'the tap expanded it');

  // The click the browser synthesises now, retargeted onto the new bar.
  const victim = [...bar.root.querySelectorAll('.ink-tool')].pop();
  assert.ok(victim, 'there is a tool button to land on');
  victim.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(bar.state.tool, parkedWith,
    'it came back holding the tool it was parked with');
});

test('and a real tap on a tool straight afterwards still works', () => {
  // The swallow is armed once and spent once; the next click is the reader's.
  const { bar } = mountToolbar();
  drag(bar, { from: [40, 40], to: [980, 780] });
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 970, y: 770, target: handle || bar.root });
  pointer('pointerup', { x: 970, y: 770 });

  const first = [...bar.root.querySelectorAll('.ink-tool')].pop();
  first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  const pencil = bar.root.querySelector('.ink-tool[data-tool="pencil"]');
  pencil.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(bar.state.tool, 'pencil', 'the reader deliberate tap is not eaten');
});



// ── 自动最小化 ───────────────────────────────────────────────────────────────
//
// 「工具栏的自动最小化不起作用」——设置里那颗复选框一直在，勾上它会被存下来，
// 下次开机还在，唯独没有任何代码读过它。这一组钉的是它现在读了，以及读法：
//
//   收起来的信号是**落笔**，不是「这一栏被点了一下」。后者每次把手放上去都在
//   发，拿它当信号的话，人碰哪儿工具栏就躲哪儿。
//
//   收是真的收（dockToCorner），不是为面板让开（yieldTo）。两者在屏幕上是同一
//   颗球，区别只在一件事上：让开欠着一个位置，面板关掉要还；自动收起来不欠，
//   因为「笔在纸上」不是一件会结束、会有人来还账的事。

/** 勾上设置里那颗「自动最小化」，走真正那颗复选框。 */
function turnOnAutoMinimize(bar) {
  bar.root.querySelector('[data-role="overflow"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const box = document.querySelector('[data-role="auto-minimize"]');
  assert.ok(box, '设置卡片上得有这颗复选框');
  box.checked = true;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(bar.state.autoMinimize, true, '勾上了就该记下来');
}

/** 把球点开成横杠，和人用手指做的那一下一样。 */
function tapOpen(bar, at = [970, 770]) {
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: at[0], y: at[1], target: handle || bar.root });
  pointer('pointerup', { x: at[0], y: at[1] });
}

test('没勾这项，落笔的时候横杠一动不动', () => {
  const { bar } = mountToolbar();
  const before = bar.state.phase;
  bar.minimizeOnDraw();
  assert.equal(bar.state.phase, before, '没要求过的事不能自己发生');
  assert.equal(bar.root.classList.contains('is-docked'), false);
});

test('勾上之后，笔一落到纸上横杠就收成角上那颗球', () => {
  const { bar } = mountToolbar();
  turnOnAutoMinimize(bar);
  bar.minimizeOnDraw();
  assert.equal(bar.state.phase, 'docked', '这就是那句「自动缩小到角落」');
  assert.equal(bar.root.classList.contains('is-docked'), true);
});

test('收回去的是人自己停过球的那个角', () => {
  const { bar } = mountToolbar();
  turnOnAutoMinimize(bar);
  drag(bar, { from: [40, 40], to: [980, 780] });
  assert.equal(bar.state.corner, 'bottom-right', '人把它停在了右下');
  tapOpen(bar);
  assert.equal(bar.state.phase, 'expanded', '点开了');

  bar.minimizeOnDraw();
  assert.equal(bar.state.corner, 'bottom-right',
    '收去别的角，等于每画一笔就让他重新找一次工具栏');
});

test('从来没当过球的横杠，收去自己这半边的下角', () => {
  const { bar } = mountToolbar();
  turnOnAutoMinimize(bar);
  bar.root.getBoundingClientRect = () => RECT(940, 300, 992, 600);
  bar.minimizeOnDraw();
  assert.equal(bar.state.corner, 'bottom-right', '它本来就贴在右边');

  const second = mountToolbar();
  turnOnAutoMinimize(second.bar);
  second.bar.root.getBoundingClientRect = () => RECT(8, 300, 60, 600);
  second.bar.minimizeOnDraw();
  assert.equal(second.bar.state.corner, 'bottom-left');
});

test('这样收起来不欠谁：它不是「让开」，没有人会来把它还回去', () => {
  const { bar } = mountToolbar();
  turnOnAutoMinimize(bar);
  bar.minimizeOnDraw();
  assert.equal(bar.isYielded(), false, '欠账一旦记上，面板一关它就自己弹回纸上了');
  bar.restoreFromYield();
  assert.equal(bar.state.phase, 'docked', '没有账可还，所以什么都不该发生');
});

test('正为一块面板让着的时候落笔，那笔账不能被改写', () => {
  const { bar } = mountToolbar();
  turnOnAutoMinimize(bar);
  const home = { phase: bar.state.phase, edge: bar.state.edge, offset: bar.state.offset };
  bar.yieldTo('bottom-left');
  bar.minimizeOnDraw();
  assert.equal(bar.isYielded(), true, '账还在');
  bar.restoreFromYield();
  assert.equal(bar.state.phase, home.phase, '面板关掉，横杠还是回到它自己的位置');
  assert.equal(bar.state.edge, home.edge);
  assert.equal(bar.state.offset, home.offset);
});

test('已经是球了就不再折一次', () => {
  const { bar } = mountToolbar();
  turnOnAutoMinimize(bar);
  drag(bar, { from: [40, 40], to: [980, 780] });
  const before = bar.state;
  bar.minimizeOnDraw();
  assert.equal(bar.state, before, '一颗球缩成一颗球，是一段什么都没说的动画');
  assert.equal(document.querySelectorAll('[data-role="toolbar-ghost"]').length, 0);
});

test('拖动途中落笔不收：那根横杠正在人手里', () => {
  const { bar } = mountToolbar();
  turnOnAutoMinimize(bar);
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, target: handle });
  pointer('pointermove', { x: 400, y: 400 });
  assert.equal(bar.state.phase, 'dragging');
  bar.minimizeOnDraw();
  assert.equal(bar.state.phase, 'dragging', '不能从人手里把它收走');
});

test('收起来的同时，摊开的那张卡片也跟着合上', () => {
  const { bar } = mountToolbar();
  turnOnAutoMinimize(bar);
  assert.equal(bar.state.openCard, 'overflow', '设置卡片还开着');
  bar.minimizeOnDraw();
  assert.equal(bar.state.openCard, null, '一颗球上挂不住一张卡片');
});

test('一次落笔只放一张静像出去', () => {
  const { bar } = mountToolbar();
  turnOnAutoMinimize(bar);
  bar.minimizeOnDraw();
  const ghosts = document.querySelectorAll('[data-role="toolbar-ghost"]').length;
  assert.ok(ghosts <= 1, `一根横杠上同时挂 ${ghosts} 张静像，看着就是多出来一个`);
});

// ── 形状卡片：点了就得看得见 ──────────────────────────────────────────────────
//
// 真机上报的：点卡片上的形状，笔落下去确实换了，可卡片上那个高亮还留在旧的那一
// 格——人看着像没点上，于是又点一次。填充那一排也一样。
//
// 原因是那两处传了 keepCard。keepCard 的意思不是「别关卡片」（关不关只看
// state.openCard），而是「这一次别重建卡片的 DOM」——它是给滑杆用的：重建会把人
// 正按着的那个 input 拆掉。用在一次性的挑选上，就等于挑完不刷新。

/** 把形状卡片摊开：选中这支工具，再点一次打开它的卡片。 */
function openShapeCard(bar) {
  const tap = () => bar.root.querySelector('.ink-tool[data-tool="shape"]')
    ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  tap();
  tap();
  const card = document.querySelector('.ink-card');
  assert.ok(card, '形状卡片没摊开');
  return card;
}

const pickedShape = () => [...document.querySelectorAll('[data-shape-kind]')]
  .filter(b => b.classList.contains('is-selected')).map(b => b.dataset.shapeKind);

test('点一下形状，卡片上的高亮跟着走——而且卡片不重建', () => {
  const { bar } = mountToolbar();
  const card = openShapeCard(bar);
  assert.deepEqual(pickedShape(), ['line'], '默认是直线');

  document.querySelector('[data-shape-kind="triangle"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(bar.state.shapeKind, 'triangle', 'state 换了');
  assert.deepEqual(pickedShape(), ['triangle'],
    '高亮没跟着走的话，人只会再点一次——而它本来就已经换了');
  // 同一个节点，不是换了一个新的。`.ink-card` 带着一段 200ms 的入场动画，重建
  // 就是重播它一次，看着是「闪一下才更新」——人在平板上正是这么说的。
  assert.equal(document.querySelector('.ink-card'), card, '卡片得是原来那一张');
  assert.ok(card.isConnected, '挑完卡片还开着');
});

test('点一下填充色，那一排的高亮也跟着走，卡片同样不重建', () => {
  const { bar } = mountToolbar();
  const card = openShapeCard(bar);
  const chosen = () => [...document.querySelectorAll('[data-shape-fill]')]
    .filter(b => b.classList.contains('is-selected')).map(b => b.dataset.shapeFill || 'none');
  assert.deepEqual(chosen(), ['none'], '默认不填');

  document.querySelector('[data-shape-fill="#dc2626"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(bar.state.shapeFill, '#dc2626');
  assert.deepEqual(chosen(), ['#dc2626']);
  assert.equal(document.querySelector('.ink-card'), card, '卡片得是原来那一张');
});

test('换颜色：高亮和预览线一起改，卡片还是那一张', () => {
  // 笔那张卡片上有一条预览线，颜色粗细透明度都画在它身上。卡片不重建了，那条
  // 线就得有人单独去改——不改的话，颜色换了、预览还是旧色。
  const { bar } = mountToolbar();
  const tap = () => bar.root.querySelector('.ink-tool[data-tool="pen"]')
    ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  // 笔本来就是选中的那一支，所以一下就开（再点一下反而会把它合上）。
  tap();
  const card = document.querySelector('.ink-card');
  assert.ok(card, '笔的卡片没摊开');
  const line = card.querySelector('.ink-preview-line');
  assert.ok(line, '卡片上有一条预览线');

  card.querySelector('[data-swatch="#dc2626"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.equal(bar.state.color, '#dc2626');
  assert.equal(document.querySelector('.ink-card'), card, '卡片得是原来那一张');
  assert.ok(line.style.background.includes('220') || line.style.background.includes('#dc2626'),
    `预览线得跟着换色，现在是 ${line.style.background}`);
  const selected = [...card.querySelectorAll('[data-swatch]')]
    .filter(b => b.classList.contains('is-selected')).map(b => b.dataset.swatch);
  assert.deepEqual(selected, ['#dc2626']);
});

test('滑杆还是不能被自己的 input 拆掉', () => {
  // 上面那两处去掉了 keepCard，而滑杆必须留着它：重建卡片会把人正按着的那个
  // input 换成一个新的，手指下面那一根就没了。
  const { bar } = mountToolbar();
  const card = openShapeCard(bar);
  const slider = card.querySelector('[data-role="width"]');
  assert.ok(slider, '边框那一栏有一根粗细滑杆');
  slider.value = '7.5';
  slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(bar.state.width, 7.5);
  assert.ok(slider.isConnected, '滑杆得是原来那一根，不然拖到一半手就空了');
});

test('信号来自落笔，不是来自「这一栏被点了一下」', () => {
  // 两块画布都要报，而且都要和 onFocus 分开报：onFocus 是手指碰到窗格就发的。
  for (const file of ['src/pdf/pdf-pane.js', 'src/scratch/scratch-pane.js']) {
    const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    const at = code.indexOf('onDrawStart:');
    assert.ok(at > -1, `${file} 得有 onDrawStart`);
    const body = code.slice(at, at + 400);
    assert.ok(/onInkDraw\?\.\(\)/.test(body), `${file} 落笔时要把这件事报出去`);
  }
  const ws = readFileSync(new URL('../src/pdf/pdf-workspace.js', import.meta.url), 'utf-8');
  const hooks = ws.match(/onInkDraw: \(\) => this\.toolbar\?\.minimizeOnDraw\?\.\(\)/g) || [];
  assert.equal(hooks.length, 2, '书和草稿纸两边都要接上，少一边就有一半的纸不灵');
});



// ── 拖粗细滑杆的时候，横杠上的图标在闪 ──────────────────────────────────────
//
// 真机上报的：拖笔那张卡片上的粗细滑杆，横杠上的图标一直在闪。
//
// 滑杆每动一个像素来一次 input → _set → render，而 render 每次都把整条横杠连同
// 每一个图标拆了重搭。选中的那一格底下那片镜片带着一段 220ms 的入场动画，重搭一
// 次重播一次——一秒几十次，就是闪。卡片那边早就改成就地刷了，横杠这边没有。

const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const openPenCard = (bar) => {
  click(bar.root.querySelector('.ink-tool[data-tool="pen"]'));
  const card = document.querySelector('.ink-card');
  assert.ok(card, '笔的卡片没摊开');
  return card;
};

test('拖粗细滑杆：横杠上的图标一个都不重搭', () => {
  const { bar } = mountToolbar();
  const tools = bar.root.querySelector('.ink-tools');
  const pen = bar.root.querySelector('.ink-tool[data-tool="pen"]');
  const card = openPenCard(bar);
  const slider = card.querySelector('[data-role="width"]');
  for (const v of ['2.5', '3.1', '4.8', '6.2', '7.0']) {
    slider.value = v;
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  assert.equal(bar.state.width, 7);
  assert.equal(bar.root.querySelector('.ink-tools'), tools, '工具那一组还是原来那一组');
  assert.equal(bar.root.querySelector('.ink-tool[data-tool="pen"]'), pen,
    '选中的那一格还是原来那个节点——换了新的，它的镜片就要重播一次入场');
  assert.ok(pen.classList.contains('is-selected'));
  assert.equal(document.querySelector('.ink-card'), card, '卡片也还是那一张');
});

test('换工具也不重搭，只把高亮挪过去', () => {
  const { bar } = mountToolbar();
  const tools = bar.root.querySelector('.ink-tools');
  const pen = bar.root.querySelector('.ink-tool[data-tool="pen"]');
  const pencil = bar.root.querySelector('.ink-tool[data-tool="pencil"]');
  click(pencil);
  assert.equal(bar.state.tool, 'pencil');
  assert.equal(bar.root.querySelector('.ink-tools'), tools);
  assert.equal(pen.classList.contains('is-selected'), false, '旧的那一格放下');
  assert.equal(pen.getAttribute('aria-pressed'), 'false');
  assert.equal(pencil.classList.contains('is-selected'), true, '新的那一格拿起');
  assert.equal(pencil.getAttribute('aria-pressed'), 'true');
});

test('换颜色：横杠上那一排色的高亮跟着走，也不重搭', () => {
  const { bar } = mountToolbar();
  const swatches = bar.root.querySelector('.ink-swatches');
  click(bar.root.querySelector('.ink-swatches [data-swatch="#2563eb"]'));
  assert.equal(bar.state.color, '#2563eb');
  assert.equal(bar.root.querySelector('.ink-swatches'), swatches);
  const on = [...bar.root.querySelectorAll('.ink-swatches [data-swatch].is-selected')]
    .map(b => b.dataset.swatch);
  assert.deepEqual(on, ['#2563eb']);
});

test('色板本身变了才重搭——那时候横杠上的格子数都不一样了', () => {
  const { bar } = mountToolbar();
  const swatches = bar.root.querySelector('.ink-swatches');
  bar._set({ ...bar.state, swatches: Object.freeze(['#111827', '#dc2626']) }, { pushTools: false });
  assert.notEqual(bar.root.querySelector('.ink-swatches'), swatches);
  assert.equal(bar.root.querySelectorAll('.ink-swatches [data-swatch]').length, 2);
});

test('收成球再展开，横杠是新搭的一条——球把它的 DOM 换掉了', () => {
  const { bar } = mountToolbar();
  drag(bar, { from: [40, 40], to: [980, 780] });
  assert.equal(bar.state.phase, 'docked');
  assert.ok(bar.root.querySelector('.ink-token'));
  bar._undock();
  assert.equal(bar.state.phase, 'expanded');
  assert.ok(bar.root.querySelector('.ink-tools'), '展开之后工具都在');
  assert.equal(bar.root.querySelector('.ink-token'), null, '球不留在横杠里');
});

test('拖滑杆的时候不写盘，松手时写一次', () => {
  // 看存下来的内容，不去替换 setItem：往 Storage 对象上赋一个叫 setItem 的属性，
  // 存进去的是一条名叫 setItem 的记录，方法本身纹丝不动。
  const { bar } = mountToolbar();
  const card = openPenCard(bar);
  const stored = () => JSON.parse(dom.window.localStorage.getItem('ls_ink_toolbar') || '{}').width;
  const before = stored();
  const slider = card.querySelector('[data-role="width"]');
  for (const v of ['3', '4', '5', '6']) {
    slider.value = v;
    slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  assert.equal(bar.state.width, 6, '笔已经是新粗细了');
  assert.equal(stored(), before, '拖到一半的值没人要，平板上每一次都是一次同步写盘');
  slider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(stored(), 6, '松手时存一次');
});

test('拖着球走：每一帧只挪球，不写盘，也不去惊动工作区', () => {
  dom.window.localStorage.clear();
  if (mounted) { try { mounted.destroy(); } catch (_) { /* gone */ } }
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ ...HOST_RECT });
  document.body.appendChild(host);
  let changes = 0;
  const bar = new InkToolbar(host, { getSurface: () => null, onChange: () => { changes += 1; } });
  mounted = bar;
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, target: handle });
  const afterPickUp = changes;
  for (let i = 1; i <= 8; i++) pointer('pointermove', { x: 40 + i * 30, y: 40 + i * 20 });
  assert.equal(bar.state.phase, 'dragging');
  assert.equal(bar.state.dragPoint.x, 280, '球确实跟着走了');
  assert.equal(changes, afterPickUp,
    '原来每一帧都让工作区量一遍安全区和缩放——量的还是这颗球，还把缩放量回了 1');
  pointer('pointerup', { x: 280, y: 200 });
  assert.ok(changes > afterPickUp, '落下的那一下才告诉工作区');
});

test('从球变回横杠的那一下，尺寸过渡是关着的', () => {
  // 拖完落到边上，原来没有这一步：量到的是一条内边距还在从 0 往 5px 长的横杠，
  // 夹到边上时位置差 5px，下一次换工具重量一次，它就挪一下。
  const { bar } = mountToolbar();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 40, y: 40, target: handle });
  pointer('pointermove', { x: 400, y: 300 });
  bar.root.classList.remove('is-instant');
  pointer('pointerup', { x: 10, y: 300 });
  assert.equal(bar.state.phase, 'expanded');
  assert.ok(bar.root.classList.contains('is-instant'), '落边的那一帧不跑尺寸过渡');
});

test('菜单栏把横杠顶上去的时候，开着的卡片跟着重新贴过去', () => {
  // 卡片是打开那一刻按横杠的位置摆的。菜单栏升起来、横杠被顶上去 86px，卡片原来
  // 留在原地——两样东西就这么分开了。
  const { bar } = mountToolbar();
  const card = openPenCard(bar);
  const anchored = [];
  const real = bar._anchorCard.bind(bar);
  bar._anchorCard = (c) => { anchored.push(c); return real(c); };
  bar.setSafeArea(0, 86);
  assert.deepEqual(anchored, [card], '同一张卡片，重新贴了一次');
  assert.equal(document.querySelector('.ink-card'), card, '贴过去，不是重建');
});

test('收成球的时候不去贴卡片——球不带卡片', () => {
  const { bar } = mountToolbar();
  drag(bar, { from: [40, 40], to: [980, 780] });
  assert.equal(bar.state.phase, 'docked');
  let anchored = 0;
  bar._anchorCard = () => { anchored += 1; };
  bar.setSafeArea(0, 86);
  assert.equal(anchored, 0);
});

await atest('语言换了，横杠的名字跟着换，不用等人去点它', async () => {
  const i18n = await import('../src/core/i18n.js');
  const { bar } = mountToolbar();
  const before = bar.root.getAttribute('aria-label');
  try {
    await i18n.setLang('en');
    const after = bar.root.getAttribute('aria-label');
    assert.equal(after, i18n.t('ink.toolbarLabel'));
    assert.notEqual(after, before, '换成英文之后整条横杠的名字得是英文的');
    const pen = bar.root.querySelector('.ink-tool[data-tool="pen"]');
    assert.equal(pen.getAttribute('aria-label'), i18n.t('ink.pen'), '按钮上的也是');
  } finally {
    await i18n.setLang('zh-CN');
  }
});

await atest('撤掉横杠时，语言那条回调也摘掉', async () => {
  const i18n = await import('../src/core/i18n.js');
  const { bar } = mountToolbar();
  let renders = 0;
  const real = bar.render.bind(bar);
  bar.render = () => { renders += 1; return real(); };
  bar.destroy();
  mounted = null;
  try {
    await i18n.setLang('en');
    assert.equal(renders, 0, '一根撤掉的横杠还在响应语言切换，就是开一次漏一个');
  } finally {
    await i18n.setLang('zh-CN');
  }
});
// ── 工作区不在屏幕上的时候 ────────────────────────────────────────────────────
//
// 设置页和练习页是两个 .page，不在前台的那个是 display:none。在设置页换语言，横
// 杠会跟着重搭（名字要换成新语言的）——那一刻工作区量出来是 0。原来重搭时先写一
// 个没夹过的百分比，夹它的那一步量不到尺寸直接返回：回到练习页，横杠停在那个百
// 分比上（偏上一截），人点一下工具、重画一次，它才跳回去。

/** 工作区量出来多大：0 就是它所在的那一页不在前台。 */
function hostSize(host, w, h) {
  Object.defineProperty(host, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: h, configurable: true });
}

await atest('在设置页换了语言：横杠重搭了，位置原样；回到练习页再夹一次', async () => {
  const i18n = await import('../src/core/i18n.js');
  const { bar, host } = mountToolbar();
  measurable(bar, host);
  bar.render();
  const settled = bar.root.style.top;
  assert.match(settled, /px$/, '前提：在屏幕上时夹成了像素');

  hostSize(host, 0, 0);
  try {
    await i18n.setLang('en');
    const pen = bar.root.querySelector('.ink-tool[data-tool="pen"]');
    assert.equal(pen.getAttribute('aria-label'), i18n.t('ink.pen'), '换了语言，横杠照样重搭');
    assert.equal(bar.root.style.top, settled, '位置原样，没被写回一个没夹过的百分比');

    hostSize(host, 1000, 700);
    bar.root.style.top = '';
    bar.fitTo({ height: 700, column: 500 });
    assert.equal(bar.root.style.top, settled,
      '回到练习页，尺寸观察器叫 fitTo——缩放没变也要重新夹');
  } finally {
    await i18n.setLang('zh-CN');
  }
});

test('从来没在屏幕上摆过的横杠：回到屏幕上时，贴哪条边也一起摆上', () => {
  // 只夹不摆的话，夹的只是沿着边的那一个方向；贴边的那 10px 没人写，横杠会落在
  // 它在文档流里的位置——工作区左上角，而不是它该贴的那条边。
  const { bar, host } = mountToolbar();   // jsdom 里工作区量出来是 0：一出生就不在屏幕上
  const { edge } = bar.state;
  assert.equal(bar.root.style[edge], '', '前提：不在屏幕上时什么都没写');
  measurable(bar, host);
  bar.fitTo({ height: 700, column: 500 });
  assert.equal(bar.root.style[edge], '10px', '贴着它那条边');
  const along = edge === 'left' || edge === 'right' ? 'top' : 'left';
  assert.match(bar.root.style[along], /px$/, '沿着边的位置也夹好了');
});

// ── 让开时欠下的那个位置 ─────────────────────────────────────────────────────

test('让开时记下原来停在哪儿；还回去之后就没有这笔账了', () => {
  const { bar } = mountToolbar();
  bar.root.getBoundingClientRect = () => RECT(10, 200, 62, 620);
  assert.equal(bar.homeRect(), null, '没让开就没有「原来」');
  bar.yieldTo('bottom-left');
  const home = bar.homeRect();
  assert.deepEqual([home.left, home.top, home.width, home.height], [10, 200, 52, 420],
    '工作区问「回去会不会又被压住」，问的就是这一块');
  bar.restoreFromYield();
  assert.equal(bar.homeRect(), null);
});

test('让着的球被人拿起来挪走：不再欠谁一个位置', () => {
  const { bar } = mountToolbar();
  bar.root.getBoundingClientRect = () => RECT(10, 200, 62, 620);
  bar.yieldTo('bottom-left');
  const puck = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 30, y: 760, target: puck });
  pointer('pointermove', { x: 500, y: 400 });
  assert.equal(bar.isYielded(), false, '拿在手里了，落在哪儿由人定');
  pointer('pointerup', { x: 500, y: 400 });
  assert.equal(bar.homeRect(), null);
  const placed = { edge: bar.state.edge, offset: bar.state.offset };
  bar.restoreFromYield();
  assert.deepEqual({ edge: bar.state.edge, offset: bar.state.offset }, placed,
    '面板关上时没有什么要还：不会跳回拖动之前的地方');
});

test('点开正在让位的球：告诉工作区一声；人自己停进角里的球点开不算', () => {
  const { bar } = mountToolbar();
  let reclaimed = 0;
  bar.handlers.onReclaim = () => { reclaimed += 1; };
  bar.yieldTo('bottom-left');
  tapOpen(bar, [30, 760]);
  assert.equal(bar.state.phase, 'expanded', '点开了');
  assert.equal(bar.isYielded(), false, '账结清了：它不再以为自己还让着');
  assert.equal(reclaimed, 1, '工作区要知道：此刻开着的那几块面板不该再把它赶回去');

  drag(bar, { from: [40, 400], to: [970, 770] });
  assert.equal(bar.state.phase, 'docked', '人自己停进角里');
  tapOpen(bar);
  assert.equal(bar.state.phase, 'expanded');
  assert.equal(reclaimed, 1, '这颗球不欠谁，点开它和面板无关');
});

// ── 卡片的退场 ───────────────────────────────────────────────────────────────
//
// 换一张卡片、关掉卡片，走掉的那一张原来是当场消失的：新的那张带着入场动画浮上
// 来，旧的凭空没了，看着像闪了一下。现在它退场——淡出、往上收一点，演完再拿掉。

/** 选中的那支工具再点一下：打开它的卡片。 */
function openToolCard(bar) {
  const selected = bar.root.querySelector('.ink-tool.is-selected')
    || bar.root.querySelector('[data-tool]');
  selected.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const card = bar.cardLayer.querySelector('.ink-card');
  assert.ok(card, '工具卡片没打开');
  return card;
}

test('换一张卡片：旧的那张退场，新的那张排在最前面接手', () => {
  const { bar } = mountToolbar();
  const toolCard = openToolCard(bar);
  bar.root.querySelector('[data-role="color-card"]')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const cards = [...bar.cardLayer.querySelectorAll('.ink-card')];
  assert.equal(cards.length, 2, '交接的这一小段里两张都在');
  assert.ok(toolCard.classList.contains('is-leaving'), '旧的那张在退场，不是当场消失');
  assert.equal(toolCard.inert, true, '退场的那张点不到');
  assert.notEqual(cards[0], toolCard, '最前面的是新的那张：别处找 .ink-card 找到的是它');
  assert.ok(!cards[0].classList.contains('is-leaving'));
  assert.equal(cards[0].dataset.card, 'color');
});

test('退场演完就拿掉：只认它自己的动画', () => {
  const { bar } = mountToolbar();
  const toolCard = openToolCard(bar);
  bar.root.querySelector('[data-role="color-card"]')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const inner = toolCard.querySelector('*');
  inner?.dispatchEvent(new dom.window.Event('animationend', { bubbles: true }));
  assert.ok(toolCard.isConnected, '冒泡上来的是卡片里别的东西的动画');
  toolCard.dispatchEvent(new dom.window.Event('animationend'));
  assert.equal(toolCard.isConnected, false);
  assert.equal(bar.cardLayer.querySelectorAll('.ink-card').length, 1);
});

test('关掉卡片：它退场；关掉之后开着的卡片是「没有」', () => {
  const { bar } = mountToolbar();
  const toolCard = openToolCard(bar);
  // 选另一支工具：卡片关掉。
  const other = [...bar.root.querySelectorAll('.ink-tool[data-tool]')]
    .find(b => !b.classList.contains('is-selected') && !['eraser', 'lasso', 'shape'].includes(b.dataset.tool));
  other.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(bar.state.openCard, null, '没有卡片开着（CARDS.NONE）');
  assert.ok(toolCard.classList.contains('is-leaving'));
  assert.equal(bar._liveCard(), null, '退场的那张不算开着');
});

test('钢笔的卡片换成荧光笔的，也算换了一张', () => {
  const { bar } = mountToolbar();
  const penCard = openToolCard(bar);
  const key = penCard.dataset.card;
  assert.ok(/^tool:/.test(key), `工具卡片按工具分：${key}`);
});

test('同一张卡片原地重建（换语言之类）：不退场，也不重播入场', () => {
  const { bar } = mountToolbar();
  const card = openToolCard(bar);
  bar._renderCard();
  const cards = [...bar.cardLayer.querySelectorAll('.ink-card')];
  assert.equal(cards.length, 1, '没有东西在退场');
  assert.notEqual(cards[0], card, '确实是重建的');
  assert.ok(cards[0].classList.contains('is-instant'), '重播一次入场，就是闪一下');
});

test('样式：退场是一段反着入场的动画，演的时候点不到', () => {
  const css = readFileSync(new URL('../src/styles/ink-toolbar.css', import.meta.url), 'utf-8');
  assert.ok(/\.ink-card\.is-leaving \{[^}]*pointer-events: none;[^}]*animation: ink-card-out/.test(css));
  assert.ok(/@keyframes ink-card-out/.test(css));
  assert.ok(/\.ink-card\.is-instant \{ animation: none; \}/.test(css));
});

console.log(`\nink toolbar drag lifecycle: ${failed ? 'FAIL' : 'PASS'} (${passed} checks${failed ? `, ${failed} failed` : ''})`);
if (failed) process.exit(1);
