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

console.log(`\nink toolbar drag lifecycle: ${failed ? 'FAIL' : 'PASS'} (${passed} checks${failed ? `, ${failed} failed` : ''})`);
if (failed) process.exit(1);
