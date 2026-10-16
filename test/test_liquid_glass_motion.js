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

/** 一帧一帧地等，直到 cond() 成立（最多 ms 毫秒）。 */
async function until(cond, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => dom.window.requestAnimationFrame(r));
  }
  return cond();
}
const num = (v) => parseFloat(v) || 0;

await test('点另一格：透镜弹过去——不是一下子到，路上顺着方向拉长，落定正好在那一格上', async () => {
  const { tabs, lens } = mountNav();
  await nextFrame();
  assert.equal(lens.style.left, '4px', '开机那一次当场摆在选中那一格上');
  assert.equal(lens.style.transition, 'none', '位置逐帧写，样式表里那条过渡不要');
  await choose(tabs, 1);
  assert.ok(num(lens.style.left) < 88, `一下子就到了（${lens.style.left}）`);
  let widest = 0;
  const landed = await until(() => {
    widest = Math.max(widest, num(lens.style.width));
    return lens.style.left === '88px' && lens.style.width === '80px';
  });
  assert.ok(landed, `没落定：${lens.style.left} ${lens.style.width}`);
  assert.ok(widest > 80 * 1.05, `路上没拉长（最宽 ${widest}）`);
  assert.equal(lens.style.height, '36px', '没按着：高度不动');
});

await test('透镜开始动时发一声 glassbusy（液态玻璃换成动态时那一版），动着的时候不重复发', async () => {
  const { tabs, lens } = mountNav();
  await nextFrame();
  let busy = 0;
  const onBusy = () => { busy++; };
  dom.window.addEventListener('glassbusy', onBusy);
  try {
    await choose(tabs, 1);
    assert.equal(busy, 1, '开始动：一声');
    await nextFrame();
    await choose(tabs, 0); // 动着的时候改了终点：接着弹，不再发
    assert.equal(busy, 1);
    assert.ok(await until(() => lens.style.left === '4px'), '落定');
  } finally {
    dom.window.removeEventListener('glassbusy', onBusy);
  }
});

await test('动着的时候来一声当场重摆（顶上那一排露出来、resize）：不跳，接着弹', async () => {
  const { nav, tabs, lens } = mountNav();
  await nextFrame();
  await choose(tabs, 1);
  await nextFrame(); // 起步了
  // 从设置点回练习时，顶上那一排跟着露出来，top-bar-fit 量完就叫这一声。
  nav._relayoutLens();
  assert.ok(num(lens.style.left) < 87, `重摆把这一段掐掉了，透镜一帧跳到终点（${lens.style.left}）`);
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  assert.ok(num(lens.style.left) < 87);
  assert.ok(await until(() => lens.style.left === '88px'), '接着弹，落在终点');
});

await test('没在动的时候尺寸变了：照旧当场到位', async () => {
  const { nav, tabs, lens } = mountNav();
  await nextFrame();
  await choose(tabs, 1);
  assert.ok(await until(() => lens.style.left === '88px' && !nav.hasAttribute('data-lens-moving')), '这一段弹完');
  // 第二格往右挪了 10px（换了语言、字变宽了）。
  tabs[1].getBoundingClientRect = () => ({ left: 598, top: 14, right: 678, bottom: 50, width: 80, height: 36, x: 598, y: 14 });
  nav._relayoutLens();
  assert.equal(lens.style.left, '98px');
});

await test('按住透镜划：在自己那一格里挪它不动；进了另一格它浮起来（扁下去）弹过去，字的蓝跟着它走；松手落定', async () => {
  const { nav, tabs, lens } = mountNav();
  // 像 app 一样：点了哪一格，哪一格就是选中的。
  tabs.forEach((t, i) => t.addEventListener('click', () => tabs.forEach((x, j) => x.classList.toggle('active', j === i))));
  // 字只占按钮正中 40px（两边是内边距）：蓝不蓝看的是字被盖住多少，不是整颗按钮。
  const realRange = document.createRange;
  document.createRange = () => {
    let node = null;
    return {
      selectNodeContents(n) { node = n; },
      getBoundingClientRect() {
        const r = node.getBoundingClientRect();
        return { left: r.left + 20, right: r.right - 20, width: r.width - 40, top: r.top, bottom: r.bottom, height: r.height };
      },
    };
  };
  try {
    await nextFrame();
    const cover = (i) => Number(tabs[i].style.getPropertyValue('--lens-cover'));
    const centre = () => num(lens.style.left) + num(lens.style.width) / 2;
    assert.equal(cover(0), 1, '开机：选中那一格整个被盖着');
    assert.equal(cover(1), 0);
    const fire = (type, x) => tabs[0].dispatchEvent(new dom.window.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: 30, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
    fire('pointerdown', 544);
    await nextFrame();
    assert.ok(num(lens.style.width) < 80, `按住它：缩一点（${lens.style.width}）`);
    fire('pointermove', 560); // 过了定方向那一截，手指还在第一格里
    await nextFrame();
    assert.ok(Math.abs(centre() - 44) < 0.5, `手指在自己那一格里挪，它不该跟着走（中心 ${centre()}）`);
    assert.equal(cover(0), 1, '缩了一点也还盖着字');
    fire('pointermove', 640); // 进了第二格
    assert.ok(await until(() => cover(1) > 0.2 && cover(1) < 0.9), `路上：第二格半蓝（${cover(1)}）`);
    assert.ok(cover(0) < 1, `路上：第一格的蓝在退（${cover(0)}）`);
    assert.ok(num(lens.style.height) < 36 * 0.95, `浮起来：扁下去（高 ${lens.style.height}）`);
    assert.ok(await until(() => Math.abs(centre() - 128) < 0.5), '手还按着：它自己弹到第二格');
    assert.equal(cover(0), 0, '完全离开第一格：它的蓝结束');
    assert.equal(cover(1), 1, '盖到第二格：它变蓝');
    assert.ok(num(lens.style.height) < 36 * 0.95, '手还按着：还是扁的');
    fire('pointerup', 640);
    assert.ok(tabs[1].classList.contains('active'), '松手：替人点了第二格');
    assert.ok(await until(() => lens.style.left === '88px' && lens.style.width === '80px'
      && lens.style.height === '36px' && !nav.hasAttribute('data-lens-moving'), 2500),
    `落定：${lens.style.left} ${lens.style.width} ${lens.style.height}`);
  } finally {
    document.createRange = realRange;
  }
});

await test('纸里只是普通地滑：点另一格一路不拉长不扁；按住划跟着手指走、不缩；松手滑到最近那一格', async () => {
  const { nav, tabs, lens } = mountNav();
  document.documentElement.setAttribute('data-skin', 'minimal');
  tabs.forEach((t, i) => t.addEventListener('click', () => tabs.forEach((x, j) => x.classList.toggle('active', j === i))));
  try {
    await nextFrame();
    let widest = 0;
    let lowest = Infinity;
    const watch = () => { widest = Math.max(widest, num(lens.style.width)); lowest = Math.min(lowest, num(lens.style.height)); };
    await choose(tabs, 1);
    assert.ok(num(lens.style.left) < 88, '点一下也是滑过去的，不是一下子到');
    assert.ok(await until(() => { watch(); return lens.style.left === '88px' && !nav.hasAttribute('data-lens-moving'); }), `没落定（${lens.style.left}）`);
    assert.ok(widest <= 80.05 && lowest >= 35.95, `点一下：不该拉长、压扁（最宽 ${widest}、最矮 ${lowest}）`);

    const fire = (type, x) => tabs[1].dispatchEvent(new dom.window.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 4, clientX: x, clientY: 30, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
    fire('pointerdown', 628);
    await nextFrame();
    assert.equal(lens.style.width, '80px', '按住：纸里不缩');
    fire('pointermove', 610); // 过了定方向那一截
    assert.equal(lens.style.left, '70px', '跟着手指走（手指在 610，透镜正中对着它）');
    fire('pointermove', 560);
    assert.equal(lens.style.left, '20px');
    assert.equal(lens.style.height, '36px', '划的时候也不扁');
    fire('pointerup', 560);
    assert.ok(tabs[0].classList.contains('active'), '松在第一格：替人点了它');
    widest = 0;
    lowest = Infinity;
    assert.ok(await until(() => { watch(); return lens.style.left === '4px' && !nav.hasAttribute('data-lens-moving'); }), `松手后没滑到第一格（${lens.style.left}）`);
    assert.ok(widest <= 80.05 && lowest >= 35.95, `松手滑过去：不该拉长、压扁（最宽 ${widest}、最矮 ${lowest}）`);
  } finally {
    document.documentElement.setAttribute('data-skin', 'liquid-math');
  }
});

await test('竖着走的手指不归它：按在透镜上缩下去的那一点还回去', async () => {
  const { nav, tabs, lens } = mountNav();
  await nextFrame();
  const fire = (type, x, y) => tabs[0].dispatchEvent(new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 2, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  }));
  fire('pointerdown', 544, 30);
  await nextFrame();
  assert.ok(num(lens.style.width) < 80, '按住：缩了一点');
  fire('pointermove', 546, 60); // 往下拉那一排
  assert.ok(await until(() => lens.style.width === '80px' && !nav.hasAttribute('data-lens-moving')), `没还回去（${lens.style.width}）`);
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

await test('减少动态：点另一格当场到位；按住、划过去也不缩不扁', async () => {
  const { tabs, lens } = mountNav({ reduced: true });
  await nextFrame();
  await choose(tabs, 1);
  assert.equal(lens.style.left, '88px');
  assert.equal(lens.style.transition, 'none');
  const fire = (type, x) => tabs[1].dispatchEvent(new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 3, clientX: x, clientY: 30, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  }));
  fire('pointerdown', 628);
  assert.equal(lens.style.width, '80px');
  fire('pointermove', 600);
  fire('pointermove', 540);
  assert.equal(lens.style.left, '4px', '进了第一格：当场过去');
  assert.equal(lens.style.height, '36px');
  fire('pointerup', 540);
});

// ── 透镜的动法：照录屏量出来的数 ──────────────────────────────────────────────

console.log('\nliquid glass — 透镜的动法（照录屏量出来的数）');

const { createLensMotion } = await import('../src/ui/lens-motion.js');

/** 推 ms 毫秒，每 1/120 秒一帧（平板的刷新率）。 */
function simulate(m, ms, onFrame) {
  const dt = 1 / 120;
  const n = Math.round(ms / 1000 / dt);
  for (let k = 1; k <= n; k++) {
    m.step(dt);
    onFrame?.(k * dt, m.rect());
  }
}
const CELL_A = { left: 4, top: 4, width: 80, height: 36 };
const CELL_B = { left: 88, top: 4, width: 80, height: 36 };
const centreX = (r) => r.left + r.width / 2;

await test('走一格：100ms 走一半、215ms 到九成、几乎不过冲（录屏里四次走的都是这一条）', () => {
  const m = createLensMotion();
  m.set(CELL_A);
  m.target(CELL_B);
  const from = centreX(CELL_A);
  const to = centreX(CELL_B);
  let t50 = null;
  let t90 = null;
  let peak = -Infinity;
  simulate(m, 1500, (t, r) => {
    const f = (centreX(r) - from) / (to - from);
    if (t50 === null && f >= 0.5) t50 = t;
    if (t90 === null && f >= 0.9) t90 = t;
    peak = Math.max(peak, f);
  });
  assert.ok(Math.abs(t50 - 0.1) < 0.012, `走一半用了 ${t50}s`);
  assert.ok(Math.abs(t90 - 0.215) < 0.015, `到九成用了 ${t90}s`);
  assert.ok(peak < 1.01, `过冲 ${peak}`);
  assert.ok(m.settled(), '1.5 秒后该停了');
});

await test('路上顺着方向拉长、慢半拍：最长长出一成以上，出现在跑得最快那一下之后', () => {
  const m = createLensMotion();
  m.set(CELL_A);
  m.target(CELL_B);
  let prev = centreX(CELL_A);
  let fastest = 0;
  let tFastest = 0;
  let widest = 0;
  let tWidest = 0;
  simulate(m, 1500, (t, r) => {
    const v = centreX(r) - prev;
    prev = centreX(r);
    if (v > fastest) { fastest = v; tFastest = t; }
    if (r.width > widest) { widest = r.width; tWidest = t; }
  });
  assert.ok(widest / 80 > 1.1 && widest / 80 < 1.3, `最长是原来的 ${widest / 80}`);
  assert.ok(tWidest > tFastest, `拉得最长（${tWidest}s）应在跑得最快（${tFastest}s）之后`);
  assert.ok(Math.abs(m.rect().width - 80) < 0.1, '停下来回到原来的长度');
  assert.ok(Math.abs(m.rect().height - 36) < 0.01, '没按着：走的时候高度不变');
});

await test('按住：0.17 秒宽缩到九成二、高缩到九成四上下（录屏里按下到浮起那几帧）', () => {
  const m = createLensMotion();
  m.set(CELL_A);
  m.press(true);
  simulate(m, 170);
  const r = m.rect();
  assert.ok(Math.abs(r.width / 80 - 0.923) < 0.02, `宽 ${r.width / 80}`);
  assert.ok(Math.abs(r.height / 36 - 0.94) < 0.02, `高 ${r.height / 36}`);
  assert.ok(Math.abs(centreX(r) - centreX(CELL_A)) < 0.01, '缩是朝中间缩，不挪');
});

await test('浮起来：一下子扁到八成九上下；松手 0.4 秒内回到原样', () => {
  const m = createLensMotion();
  m.set(CELL_A);
  m.lift(true);
  simulate(m, 60);
  assert.ok(Math.abs(m.rect().height / 36 - 0.888) < 0.02, `扁到 ${m.rect().height / 36}`);
  m.lift(false);
  simulate(m, 400);
  assert.ok(Math.abs(m.rect().height / 36 - 1) < 0.01, `回到 ${m.rect().height / 36}`);
});

await test('按得久、划过去、松手：落定时先窄一点再回来（像一滴水落定）', () => {
  const m = createLensMotion();
  m.set(CELL_A);
  m.press(true);
  simulate(m, 200); // 按住，手指在自己那一格里挪（录屏第一次：浮起前按了 6 帧）
  m.lift(true);
  m.target(CELL_B);
  simulate(m, 230); // 浮起来弹过去，手还按着（又 7 帧）
  m.press(false);
  m.lift(false);
  let narrowest = Infinity;
  simulate(m, 1500, (t, r) => { narrowest = Math.min(narrowest, r.width); });
  assert.ok(narrowest / 80 < 0.96, `落定时没收窄（最窄 ${narrowest / 80}）`);
  assert.ok(Math.abs(m.rect().width - 80) < 0.1 && m.settled(), '最后回到原样、停下');
});

await test('停下时落在正好的位置上：没有零点几像素的毛边', () => {
  const m = createLensMotion();
  m.set(CELL_A);
  m.target(CELL_B);
  simulate(m, 1500);
  m.snap();
  assert.deepEqual(m.rect(), CELL_B);
});

console.log(`\nliquid glass runtime motion: ${failed ? 'FAIL' : 'PASS'} (${passed} checks${failed ? `, ${failed} failed` : ''})`);
if (failed) process.exit(1);
