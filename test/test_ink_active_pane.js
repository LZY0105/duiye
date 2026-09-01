#!/usr/bin/env node
// The pane you draw on is the pane the toolbar is talking to.
//
// This app shows two documents side by side and drives both with ONE floating
// ink toolbar. The toolbar pushes its tool, colour, width and eraser mode to
// `panes[activeSlot]`, and the active pane was set by the pane's own
// `pointerdown` handler.
//
// But the ink canvas covers the viewport, and the moment it claims a pointer
// for drawing it calls `stopPropagation()` — so the pane's handler never ran,
// the active pane never changed, and every setting went to whichever pane
// happened to be active before. Drawing in the other pane came out as the same
// marker in the same colour no matter what was selected: the highlighter did
// nothing, the eraser drew instead of erasing, and colour changes were ignored.
//
// The fix is one callback fired before the stroke is built, so the host can
// make this pane active and push the current tool back down in time for THIS
// stroke. These tests hold that ordering.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
for (const key of [
  'window', 'document', 'Event', 'PointerEvent', 'MutationObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DOMMatrixReadOnly',
]) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};
// jsdom has no 2D context; the surface only needs the calls to resolve.
dom.window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({}, { get: () => () => {} });
};

const { InkSurface } = await import('../src/ink/ink-surface.js');

const RECT = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };

function mount(handlers = {}) {
  document.body.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ ...RECT });
  document.body.appendChild(canvas);
  const ink = new InkSurface(canvas, handlers);
  ink.setEnabled(true);
  return { canvas, ink };
}

const pen = (canvas, type, { x = 100, y = 100, id = 1 } = {}) => canvas.dispatchEvent(
  new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: id, clientX: x, clientY: y, button: 0,
    buttons: type === 'pointerup' ? 0 : 1, pointerType: 'pen', isPrimary: true,
  }),
);

console.log('\nink — the stroke announces its pane before it is built');

test('a stroke announces itself before anything is drawn', () => {
  const seen = [];
  const { canvas, ink } = mount({
    onDrawStart: () => seen.push('draw-start'),
    onChange: () => seen.push('change'),
  });
  pen(canvas, 'pointerdown');
  assert.equal(seen[0], 'draw-start', 'the host must be told first, not after the fact');
  assert.ok(ink);
});

test('a tool selected inside the announcement applies to THAT stroke', () => {
  // This is the real scenario: the host answers onDrawStart by pushing the
  // toolbar's current tool to this surface. If the callback fired after the
  // stroke was created, the first stroke on a newly-active pane would still
  // come out with the previous pane's settings.
  const { canvas, ink } = mount({
    onDrawStart: () => { ink.setTool('highlighter'); ink.setColor('#ff0000'); },
  });
  ink.setTool('marker');
  ink.setColor('#000000');

  pen(canvas, 'pointerdown');

  assert.equal(ink.tool, 'highlighter', 'the tool pushed on announcement must win');
  assert.equal(ink.color, '#ff0000', 'and so must the colour');
});

test('an eraser selected on announcement erases instead of drawing', () => {
  const { canvas, ink } = mount({
    onDrawStart: () => { ink.setEraser('stroke'); },
  });
  ink.setTool('marker');
  assert.equal(ink.erasing, false, 'precondition: this surface was drawing');

  pen(canvas, 'pointerdown');

  assert.equal(ink.erasing, true, 'the eraser must be in effect for this very stroke');
  // The eraser branch returns before a stroke is created; a stroke here would
  // mean the eraser had painted a marker line, which is the reported bug.
  assert.equal(ink._active, null, 'an erasing pointer must not open a stroke');
});

test('a pointer the surface does not claim is left to the pane', () => {
  let announced = 0;
  const { canvas, ink } = mount({ onDrawStart: () => { announced++; } });
  ink.setEnabled(false);           // nothing here draws
  pen(canvas, 'pointerdown');
  assert.equal(announced, 0, 'a pointer ink does not take must not claim focus either');
});

console.log(`\nink active pane: ${failed ? 'FAIL' : 'PASS'} (${passed} checks${failed ? `, ${failed} failed` : ''})`);
if (failed) process.exit(1);
