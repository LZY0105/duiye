#!/usr/bin/env node
// Liquid Glass — reduced motion is a live setting, and teardown gives back
// everything init took.
//
// The effects controller used to read `prefers-reduced-motion` exactly once,
// at init. Turning the OS preference on while the app was open therefore did
// nothing: every tap kept spawning a ripple until the page was reloaded —
// which, on the tablet this app ships to, essentially never happens.
//
// So this file drives the module through a DOM with a controllable media
// query: it flips the preference at runtime and asserts on what the effects
// actually do afterwards, not on what was decided at boot.
//
// There is no catchlight to test. The pointer-tracked lighting this file used
// to cover was removed from the module — see the note in its reduced-motion
// section — and with it the module's `pointermove` listener.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;

async function test(name, fn) {
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

// ── environment ─────────────────────────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

for (const key of [
  'window', 'document', 'Event', 'PointerEvent', 'MutationObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
  'DOMMatrixReadOnly',
]) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, {
    value: dom.window[key], configurable: true, writable: true,
  });
}

// jsdom has no matchMedia at all, which is also the case this module has to
// survive. Here it is a real, controllable MediaQueryList: the point of the
// fix is that the module listens to it instead of sampling it once.
const motion = {
  matches: false,
  listeners: new Set(),
  addEventListener(type, fn) { if (type === 'change') this.listeners.add(fn); },
  removeEventListener(type, fn) { if (type === 'change') this.listeners.delete(fn); },
  /** Flip the OS preference the way the platform would. */
  set(value) {
    this.matches = value;
    for (const fn of [...this.listeners]) fn({ matches: value });
  },
};
dom.window.matchMedia = (query) => {
  if (String(query).includes('prefers-reduced-motion')) return motion;
  return { matches: false, addEventListener() {}, removeEventListener() {} };
};

// Count what the module owns on window, by identity, so teardown can be
// checked against registration rather than against "it did not throw".
const liveListeners = new Map();
const origAdd = dom.window.addEventListener;
const origRemove = dom.window.removeEventListener;
dom.window.addEventListener = function (type, handler, opts) {
  if (!liveListeners.has(handler)) liveListeners.set(handler, new Set());
  liveListeners.get(handler).add(type);
  return origAdd.call(this, type, handler, opts);
};
dom.window.removeEventListener = function (type, handler, opts) {
  liveListeners.get(handler)?.delete(type);
  return origRemove.call(this, type, handler, opts);
};
// jsdom registers window listeners of its own (click, focus, keydown and
// friends) as a side effect of dispatching events, so only the event types
// this module is responsible for are counted.
const OWNED = new Set(['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'resize']);
const stillRegistered = () =>
  [...liveListeners.values()].flatMap(types => [...types]).filter(t => OWNED.has(t)).sort();

const { initLiquidGlass, destroyLiquidGlass } = await import('../src/ui/liquid-glass.js');

// ── fixtures ────────────────────────────────────────────────────────────────

const RECT = { left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100, x: 100, y: 100 };

function mount() {
  destroyLiquidGlass();
  motion.matches = false;
  motion.listeners.clear();
  document.documentElement.setAttribute('data-skin', 'liquid-math');
  document.body.innerHTML = '';

  const surface = document.createElement('div');
  surface.className = 'ink-toolbar';
  surface.getBoundingClientRect = () => ({ ...RECT });
  document.body.appendChild(surface);

  const button = document.createElement('button');
  button.className = 'ink-tool';
  button.getBoundingClientRect = () => ({ ...RECT });
  surface.appendChild(button);

  initLiquidGlass();
  return { surface, button };
}

const pointerAt = (type, { x = 200, y = 150, target } = {}) => {
  const ev = new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
  (target || dom.window).dispatchEvent(ev);
  return ev;
};

/** The light is applied in a rAF; give the module the frame it asked for. */
const nextFrame = () => new Promise(resolve => {
  dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve));
});

const ripples = (el) => el.querySelectorAll('.liquid-ripple-wave').length;

// ── the regression ──────────────────────────────────────────────────────────

console.log('\nliquid glass — runtime reduced motion');

await test('ripples stop and resume with the preference', async () => {
  const { button } = mount();
  pointerAt('pointerdown', { target: button });
  assert.equal(ripples(button), 1, 'a tap must ripple while motion is allowed');
  pointerAt('pointerup', { target: button });
  button.innerHTML = '';

  motion.set(true);
  pointerAt('pointerdown', { target: button });
  assert.equal(ripples(button), 0, 'no ripple may be spawned under reduced motion');
  pointerAt('pointerup', { target: button });

  motion.set(false);
  pointerAt('pointerdown', { target: button });
  assert.equal(ripples(button), 1, 'the ripple must return when the user allows motion again');
  pointerAt('pointerup', { target: button });
});

await test('a boot with reduced motion already on never ripples', async () => {
  destroyLiquidGlass();
  motion.matches = true;
  document.documentElement.setAttribute('data-skin', 'liquid-math');
  document.body.innerHTML = '';
  const surface = document.createElement('div');
  surface.className = 'ink-toolbar';
  surface.getBoundingClientRect = () => ({ ...RECT });
  document.body.appendChild(surface);
  const button = document.createElement('button');
  button.className = 'ink-tool';
  button.getBoundingClientRect = () => ({ ...RECT });
  surface.appendChild(button);
  initLiquidGlass();

  pointerAt('pointerdown', { target: button });
  assert.equal(ripples(button), 0, 'no ripple may be spawned');
  assert.ok(button.classList.contains('liquid-bulge-press'), 'the press state is not motion');
  pointerAt('pointerup', { target: button });
});

await test('the module owns no pointermove listener at all', async () => {
  mount();
  const taken = stillRegistered();
  assert.equal(
    taken.includes('pointermove'), false,
    'the pointer-tracked catchlight is gone; nothing may listen to pointermove',
  );
});

await test('destroyLiquidGlass() gives back every window listener and the media query', async () => {
  const { surface } = mount();
  const taken = stillRegistered();
  assert.ok(taken.includes('pointerdown'), 'precondition: the module owns pointerdown');
  assert.equal(motion.listeners.size, 1, 'precondition: the module listens to the media query');

  destroyLiquidGlass();

  const leaked = stillRegistered();
  assert.deepEqual(leaked, [], `teardown left ${leaked.join(', ')} on window`);
  assert.equal(motion.listeners.size, 0, 'teardown must release the media-query listener');

  // And a press after teardown reaches nothing.
  const button = surface.querySelector('.ink-tool');
  pointerAt('pointerdown', { target: button });
  assert.equal(ripples(button), 0, 'a torn-down controller must not still ripple');
  assert.equal(button.classList.contains('liquid-bulge-press'), false);
});

await test('a press held across teardown does not keep its release listeners', async () => {
  const { button } = mount();
  pointerAt('pointerdown', { target: button });
  assert.ok(button.classList.contains('liquid-bulge-press'), 'precondition: the press is held');

  destroyLiquidGlass();

  assert.equal(button.classList.contains('liquid-bulge-press'), false, 'teardown must release the press');
  assert.deepEqual(stillRegistered(), [], 'the pointerup/pointercancel release pair must be gone');
});

await test('init is idempotent and teardown is safe to repeat', async () => {
  mount();
  initLiquidGlass();
  const afterDoubleInit = stillRegistered().length;
  destroyLiquidGlass();
  assert.doesNotThrow(() => destroyLiquidGlass());
  assert.deepEqual(stillRegistered(), [], `a second init registered listeners nobody owns (${afterDoubleInit})`);
});

console.log(`\nliquid glass runtime motion: ${failed ? 'FAIL' : 'PASS'} (${passed} checks${failed ? `, ${failed} failed` : ''})`);
if (failed) process.exit(1);
