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
import { readFileSync } from 'node:fs';
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

// ── 正中那两个标签：点一下，透镜滑过去 ─────────────────────────────────────

console.log('\nliquid glass — 标签底下那块透镜');

/** 顶上正中那两个标签（练习 / 设置），第一个选中。jsdom 不排版，位置写死。 */
function mountNav({ reduced = false } = {}) {
  destroyLiquidGlass();
  motion.matches = reduced;
  motion.listeners.clear();
  document.documentElement.setAttribute('data-skin', 'liquid-math');
  document.body.innerHTML = '';
  const nav = document.createElement('nav');
  nav.className = 'app-nav';
  nav.getBoundingClientRect = () => ({ left: 500, top: 10, right: 672, bottom: 54, width: 172, height: 44, x: 500, y: 10 });
  const tabs = [['pdf', 504], ['settings', 588]].map(([page, left], i) => {
    const b = document.createElement('button');
    b.dataset.page = page;
    if (i === 0) b.className = 'active';
    b.getBoundingClientRect = () => ({ left, top: 14, right: left + 80, bottom: 50, width: 80, height: 36, x: left, y: 14 });
    nav.appendChild(b);
    return b;
  });
  document.body.appendChild(nav);
  initLiquidGlass();
  return { nav, tabs, lens: nav.querySelector('.nav-glass-lens') };
}

/** 点了另一格——和 bootstrap.js 的 showPage 一样，只换 active；透镜自己跟过去。 */
async function choose(tabs, index) {
  tabs.forEach((t, i) => t.classList.toggle('active', i === index));
  await new Promise((r) => setTimeout(r, 0)); // 让 MutationObserver 的回调跑完
}

await test('点另一格：透镜带着过渡滑过去', async () => {
  const { tabs, lens } = mountNav();
  await nextFrame();
  assert.equal(lens.style.left, '4px', '开机那一次当场摆在选中那一格上');
  assert.equal(lens.style.transition, 'none');
  await choose(tabs, 1);
  assert.equal(lens.style.left, '88px');
  assert.notEqual(lens.style.transition, 'none', '点一下应该是滑过去的');
});

await test('滑着的时候来一声当场重摆（顶上那一排露出来、resize）：不跳，接着滑', async () => {
  const { nav, tabs, lens } = mountNav();
  await nextFrame();
  await choose(tabs, 1);
  // 从设置点回练习时，顶上那一排跟着露出来，top-bar-fit 量完就叫这一声。
  nav._relayoutLens();
  assert.notEqual(lens.style.transition, 'none', '重摆把这一段滑动掐掉了，透镜会一帧跳到终点');
  assert.equal(lens.style.left, '88px');
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  assert.notEqual(lens.style.transition, 'none');
});

await test('没在滑的时候尺寸变了：照旧当场到位', async () => {
  const { nav, tabs, lens } = mountNav();
  await nextFrame();
  await choose(tabs, 1);
  await new Promise((r) => setTimeout(r, 450)); // 这一段滑完
  nav._relayoutLens();
  assert.equal(lens.style.transition, 'none');
  assert.equal(lens.style.left, '88px');
});

await test('按住透镜划：离开哪一格，那一格的蓝就退掉；盖到哪一格，哪一格就蓝', async () => {
  const { tabs, lens } = mountNav();
  // jsdom 不排版：透镜画在哪按它的 left / width 算（胶囊从 500 起）。
  lens.getBoundingClientRect = () => {
    const l = 500 + (parseFloat(lens.style.left) || 0);
    const w = parseFloat(lens.style.width) || 0;
    return { left: l, right: l + w, top: 14, bottom: 50, width: w, height: 36, x: l, y: 14 };
  };
  await nextFrame();
  const cover = (i) => Number(tabs[i].style.getPropertyValue('--lens-cover'));
  assert.equal(cover(0), 1, '开机：选中那一格整个被盖着');
  assert.equal(cover(1), 0);
  const fire = (type, x) => tabs[0].dispatchEvent(new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: 30, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  }));
  fire('pointerdown', 544);
  fire('pointermove', 560); // 透镜 520–600：第一格还盖着八成
  assert.ok(Math.abs(cover(0) - 0.8) < 0.01, `第一格 ${cover(0)}`);
  assert.ok(cover(1) > 0 && cover(1) < 0.2, `第二格 ${cover(1)}`);
  fire('pointermove', 640); // 透镜 592–672：完全离开第一格
  assert.equal(cover(0), 0, '完全离开第一格：它的蓝结束');
  assert.ok(cover(1) > 0.9, `盖到第二格：它变蓝（${cover(1)}）`);
  fire('pointerup', 640);
});

await test('字的颜色由样式表按 --lens-cover 在蓝和灰之间调；选中那一格默认 1；颜色不过渡', () => {
  const css = readFileSync(new URL('../src/styles/liquid.css', import.meta.url), 'utf8');
  const at = css.indexOf('html[data-skin] .app-nav button {');
  assert.ok(at > 0);
  const base = css.slice(at, css.indexOf('}', at));
  assert.match(base, /color: color-mix\(in oklab, var\(--lg-tint\) calc\(var\(--lens-cover\) \* 100%\), var\(--lg-label-2\)\)/);
  assert.match(base, /transition: scale var\(--transition-fast\);/);
  const act = css.indexOf('html[data-skin] .app-nav button.active {');
  assert.match(css.slice(act, css.indexOf('}', act)), /--lens-cover: 1;/);
});

await test('减少动态：点另一格当场到位', async () => {
  const { tabs, lens } = mountNav({ reduced: true });
  await nextFrame();
  await choose(tabs, 1);
  assert.equal(lens.style.left, '88px');
  assert.equal(lens.style.transition, 'none');
});

console.log(`\nliquid glass runtime motion: ${failed ? 'FAIL' : 'PASS'} (${passed} checks${failed ? `, ${failed} failed` : ''})`);
if (failed) process.exit(1);
