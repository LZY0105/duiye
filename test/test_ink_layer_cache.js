#!/usr/bin/env node
// 写字的时候，已经落笔的那一层不重画，贴一张缓存的图；这张图跨笔留着。
//
// 笔每动一下（一秒一百多次）原来都要把这一页所有笔迹重拼一遍、填一次：平板上量过，一页九百来个圆一次 5.5ms，
// 一帧 8.3ms 里只剩不到 3ms。可写字的时候变的只有正在写的那一笔。满是字的一页（2.1 万个圆）整页画一遍要 40ms，
// 落笔、松手各来一遍的话每一笔开头都晚一截，所以图要跨笔留着。
//
// 这里钉六样：
//   1. 落笔那一下把已有的那一层画进一块离屏画布，之后每动一下只把它整张贴回来、再画正在写的那一笔；
//      松手只把新的那一笔画进图里再贴，下一笔落笔接着用——旧的笔迹一条也不重画。
//   2. 贴上去之前先清掉，按像素一比一贴：变换、透明度、混合都回到默认。
//   3. 写着的时候视图、画布大小、这一层、这一层的笔数哪一样变了，那张图跟着重画；两笔之间撤销、翻页、缩放、
//      套索原地换色 / 搬动过，下一笔落笔也重画。贴出来的永远是这一刻的层。
//   4. 不写字的时候图对得上也贴；对不上（被原地改过）就整页画，不拿旧图充数。
//   5. 松手以后一分钟不写就把那张图放掉；接着写就留着用，不再建一块。
//   6. 建不了离屏画布（jsdom、要不到 2D 上下文）就照旧整页重画，一笔里只试一次，也不让 jsdom 喊「没实现」。

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
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
// jsdom 的指针捕获只实现了一半，而落笔每一次都要用它：给一个不会抛的空实现。
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};

const { InkSurface } = await import('../src/ink/ink-surface.js');
const { InkLayer } = await import('../src/ink/ink-layer.js');
const { INK_TOOLS, appendPoint, createStroke, recomputeBounds } = await import('../src/ink/stroke.js');

/** 一块记账的 2D 上下文：调了什么、设了什么都记下来，不真画。 */
function recordingContext(canvas, log) {
  return new Proxy({}, {
    get(target, key) {
      if (key === 'canvas') return canvas;
      if (!(key in target)) target[key] = (...args) => { log.push([key, ...args]); };
      return target[key];
    },
    set(target, key, value) {
      log.push([`=${String(key)}`, value]);
      target[key] = value;
      return true;
    },
  });
}

/**
 * 离屏画布那一头：jsdom 的画布没有 2D 上下文，这里给每块新建的画布发一本账。
 * `enabled` 关掉就是「这儿没有 2D 画布」（原样的 jsdom）；`refuse` 打开就是「要不到上下文」。
 */
const offscreen = { enabled: true, refuse: false, asked: 0, made: [] };
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  offscreen.asked++;
  if (offscreen.refuse) return null;
  if (!this.__log) {
    this.__log = [];
    this.__ctx = recordingContext(this, this.__log);
    offscreen.made.push(this);
  }
  return this.__ctx;
};
function setOffscreen({ enabled = true, refuse = false } = {}) {
  offscreen.enabled = enabled;
  offscreen.refuse = refuse;
  offscreen.asked = 0;
  offscreen.made = [];
  if (enabled) dom.window.CanvasRenderingContext2D = function CanvasRenderingContext2D() {};
  else delete dom.window.CanvasRenderingContext2D;
}

/** 一块装好的画布：自己的那本账在 `log` 里。 */
function mount({ width = 800, height = 600 } = {}) {
  document.body.innerHTML = '<div class="host"></div>';
  const host = document.querySelector('.host');
  const canvas = document.createElement('canvas');
  const log = [];
  const ctx = recordingContext(canvas, log);
  canvas.getContext = () => ctx;
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0,
  });
  host.appendChild(canvas);
  const surface = new InkSurface(canvas, {});
  surface.resize(width, height, 1);
  surface.setTransform(1, 0, 0);
  surface.setTool(INK_TOOLS.PEN);
  return { surface, canvas, log };
}

/** 往层里放一条已经写好的笔迹，颜色当它的名字用：账上看见这个颜色，就是它被画了。 */
function inked(layer, color, x = 100, y = 100) {
  const stroke = createStroke({ tool: INK_TOOLS.PEN, color, width: 2 });
  appendPoint(stroke, x, y, 0.5, 0);
  appendPoint(stroke, x + 40, y + 10, 0.5, 0);
  appendPoint(stroke, x + 80, y, 0.5, 0);
  layer.add(stroke);
  return stroke;
}

function pointer(type, x, y) {
  return new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'pen', pressure: 0.5,
    clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1,
  });
}
const down = (s, x, y) => s.canvas.dispatchEvent(pointer('pointerdown', x, y));
const move = (s, x, y) => s.canvas.dispatchEvent(pointer('pointermove', x, y));
const up = (s, x, y) => s.canvas.dispatchEvent(pointer('pointerup', x, y));

/** 账上画了哪些颜色（按设 fillStyle 的次序）。 */
const colours = (log) => log.filter(([k]) => k === '=fillStyle').map(([, v]) => v);
const calls = (log, name) => log.filter(([k]) => k === name);

/** 换上一套假的计时器，看那张图什么时候被放掉。 */
function fakeTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timers = new Map();
  let next = 1;
  globalThis.setTimeout = (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  return {
    timers,
    fire(id) { const t = timers.get(id); timers.delete(id); t.fn(); },
    restore() { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; },
  };
}

const OLD = ['#111111', '#222222', '#333333'];
const PEN = '#ff0000';

// ═══════════════════════════════════════════════════════════════
group('1. 写的时候只贴图，再画正在写的那一笔');

await test('落笔画一次那张图，之后每动一下只贴它，已有的笔一条也不重画', async () => {
  setOffscreen();
  const { surface, log } = mount();
  for (const c of OLD) inked(surface.layer, c);
  surface.setColor(PEN);
  log.length = 0;

  down(surface, 100, 300);
  assert.equal(offscreen.made.length, 1, '落笔时建了一块离屏画布');
  const cache = offscreen.made[0];
  assert.deepEqual(colours(cache.__log), OLD, '已有的那三条画进了那张图，各一次');
  assert.ok(colours(log).every((c) => c === PEN), `落笔那一下主画布上只画正在写的那一笔，实际 ${colours(log)}`);

  for (let i = 1; i <= 5; i++) move(surface, 100 + i * 20, 300 + i * 3);
  assert.deepEqual(colours(cache.__log), OLD, '动了五下，那张图一次也没重画');
  assert.equal(calls(log, 'drawImage').length, 6, '落笔一下加动五下，主画布贴了六次');
  assert.ok(calls(log, 'drawImage').every(([, src]) => src === cache), '贴的就是那张图');
  assert.ok(!colours(log).some((c) => OLD.includes(c)),
    '写着的时候主画布上一条旧笔迹也不重画——这正是那 5.5ms 省下来的地方');
});

await test('松手：只把新的那一笔画进图里再贴，旧的一条也不重画', async () => {
  setOffscreen();
  const { surface, log } = mount();
  for (const c of OLD) inked(surface.layer, c);
  surface.setColor(PEN);
  down(surface, 100, 300);
  move(surface, 160, 310);
  const cache = offscreen.made[0];
  log.length = 0;
  cache.__log.length = 0;

  up(surface, 200, 300);
  assert.equal(surface.layer.getAll().length, 4, '这一笔落进层里');
  assert.deepEqual(colours(cache.__log), [PEN], '图里只添了刚落下的那一笔');
  assert.equal(calls(log, 'drawImage').length, 1, '主画布贴了一次图');
  assert.ok(!colours(log).some((c) => OLD.includes(c)),
    '松手不再整页重画——满是字的一页那一遍要 40ms');
});

await test('下一笔落笔接着用那张图：什么都没变，就一条旧的也不重画', async () => {
  setOffscreen();
  const { surface, log } = mount();
  for (const c of OLD) inked(surface.layer, c);
  surface.setColor(PEN);
  down(surface, 100, 300); move(surface, 160, 300); up(surface, 200, 300);
  const cache = offscreen.made[0];
  cache.__log.length = 0;
  log.length = 0;

  surface.setColor('#00aa00');
  down(surface, 100, 400);
  move(surface, 160, 400);
  up(surface, 200, 400);
  assert.deepEqual(colours(cache.__log), ['#00aa00'], '第二笔落笔不重画，松手只添它自己');
  assert.ok(!colours(log).some((c) => OLD.includes(c) || c === PEN), '主画布上旧的（包括上一笔）都是贴上去的');
  assert.equal(offscreen.made.length, 1);
});

await test('不写字的时候：图对得上也贴；没有图就整页画，不为它去建一块', async () => {
  setOffscreen();
  const { surface, log } = mount();
  for (const c of OLD) inked(surface.layer, c);
  log.length = 0;
  surface.render();
  assert.equal(calls(log, 'drawImage').length, 0);
  assert.deepEqual(colours(log), OLD);
  assert.equal(offscreen.made.length, 0, '没写过字，就不建那张图');

  down(surface, 100, 300); up(surface, 160, 300);
  log.length = 0;
  surface.render();
  assert.equal(calls(log, 'drawImage').length, 1, '写过一笔以后，别的原因重画也贴图');
  assert.ok(!colours(log).some((c) => OLD.includes(c)));
});

await test('不写字的时候视图变了（缩放、平移）：整页画，不拿旧图充数', async () => {
  setOffscreen();
  const { surface, log } = mount();
  for (const c of OLD) inked(surface.layer, c);
  down(surface, 100, 300); up(surface, 160, 300);
  log.length = 0;
  surface.setTransform(2, 0, 0);
  assert.equal(calls(log, 'drawImage').length, 0);
  assert.deepEqual(colours(log).slice(0, 3), OLD);
});

await test('不写字的时候原地换了色：整页画出新的颜色，不贴旧图', async () => {
  setOffscreen();
  const { surface, log } = mount();
  const old = inked(surface.layer, OLD[0]);
  down(surface, 100, 300); up(surface, 160, 300);
  old.color = '#777777';
  log.length = 0;
  surface.render();
  assert.equal(calls(log, 'drawImage').length, 0);
  assert.ok(colours(log).includes('#777777'));
});

// ═══════════════════════════════════════════════════════════════
group('2. 贴之前清掉，一比一贴');

await test('先回到一比一的变换、默认的透明度和混合，清掉整块，再把那张图贴在原点', async () => {
  setOffscreen();
  const { surface, canvas, log } = mount({ width: 640, height: 480 });
  inked(surface.layer, OLD[0]);
  down(surface, 100, 300);
  log.length = 0;
  move(surface, 140, 310);

  const at = log.findIndex(([k]) => k === 'drawImage');
  assert.ok(at > 0, '贴了');
  const before = log.slice(0, at);
  const after = log.slice(at + 1);
  const save = before.map(([k]) => k).lastIndexOf('save');
  assert.ok(save >= 0, '贴图前存了状态');
  const prep = before.slice(save);
  assert.deepEqual(prep.find(([k]) => k === 'setTransform'), ['setTransform', 1, 0, 0, 1, 0, 0],
    '按像素贴：要是带着 dpr 的变换贴，图会被放大一倍');
  assert.ok(prep.some(([k, v]) => k === '=globalAlpha' && v === 1), '透明度回到 1');
  assert.ok(prep.some(([k, v]) => k === '=globalCompositeOperation' && v === 'source-over'),
    '混合回到默认：荧光笔留下的 multiply 不能带到贴图上');
  assert.deepEqual(prep.find(([k]) => k === 'clearRect'), ['clearRect', 0, 0, canvas.width, canvas.height],
    '整块清掉：图里透明的地方要真是透明');
  const [, src, x, y] = log[at];
  assert.equal(src, offscreen.made[0]);
  assert.deepEqual([x, y], [0, 0]);
  assert.equal(after[0][0], 'restore', '贴完立刻还原，后面画正在写的那一笔用的还是原来的变换');
});

await test('那张图和这块画布一样大、按同一个比例画', async () => {
  setOffscreen();
  const { surface, canvas } = mount({ width: 400, height: 300 });
  surface.resize(400, 300, 2);
  inked(surface.layer, OLD[0]);
  down(surface, 50, 50);
  const cache = offscreen.made[0];
  assert.equal(cache.width, canvas.width);
  assert.equal(cache.height, canvas.height);
  assert.equal(canvas.width, 800, '这块画布是 dpr 2 的');
  assert.deepEqual(calls(cache.__log, 'setTransform')[0], ['setTransform', 2, 0, 0, 2, 0, 0],
    '那张图里的笔迹和直接画在这块画布上的一样粗、一样位置');
});

// ═══════════════════════════════════════════════════════════════
group('3. 贴出来的永远是这一刻的层');

await test('写着的时候视图变了（双指缩放打断），那张图跟着重画一次', async () => {
  setOffscreen();
  const { surface } = mount();
  for (const c of OLD) inked(surface.layer, c);
  down(surface, 100, 300);
  move(surface, 120, 300);
  const cache = offscreen.made[0];
  assert.equal(colours(cache.__log).length, 3);

  surface.setTransform(1.5, -20, 0);
  assert.equal(colours(cache.__log).length, 6, '视图变了，按新视图重画');
  move(surface, 140, 300);
  move(surface, 160, 300);
  assert.equal(colours(cache.__log).length, 6, '之后视图没再变，就不再重画');
  assert.equal(offscreen.made.length, 1, '重画用的还是那一块，不再建');
});

await test('写着的时候层里多了一笔（别的栏拖进来），下一下就看得见它', async () => {
  setOffscreen();
  const { surface } = mount();
  inked(surface.layer, OLD[0]);
  down(surface, 100, 300);
  move(surface, 120, 300);
  inked(surface.layer, '#444444', 300, 100);
  move(surface, 140, 300);
  const cache = offscreen.made[0];
  assert.ok(colours(cache.__log).includes('#444444'), '笔数变了，那张图重画');
});

await test('写着的时候画布大小变了（转屏），那张图跟着变大小、重画', async () => {
  setOffscreen();
  const { surface, canvas } = mount({ width: 800, height: 600 });
  inked(surface.layer, OLD[0]);
  down(surface, 100, 300);
  surface.resize(600, 800, 1);
  const cache = offscreen.made[0];
  assert.equal(cache.width, 600);
  assert.equal(cache.height, 800);
  assert.equal(canvas.width, 600);
  assert.equal(colours(cache.__log).length, 2, '换了大小，重画了一次');
});

await test('两笔之间撤销了：下一笔的那张图里没有被撤掉的那一笔', async () => {
  setOffscreen();
  const { surface } = mount();
  inked(surface.layer, OLD[0]);
  surface.setColor('#aa0000');
  down(surface, 100, 300); move(surface, 160, 300); up(surface, 200, 300);
  assert.equal(surface.layer.getAll().length, 2);
  surface.undo();
  assert.equal(surface.layer.getAll().length, 1);

  const cache = offscreen.made[0];
  cache.__log.length = 0;
  surface.setColor('#00aa00');
  down(surface, 100, 400);
  move(surface, 160, 400);
  assert.deepEqual(colours(cache.__log), [OLD[0]], '落笔时照这一刻的层重画，撤掉的那一笔不会被贴回来');
});

await test('两笔之间原地换了色（套索换色）：下一笔落笔照改过的样子重画', async () => {
  // 换色是改那条笔迹自己，层还是那个数组、条数也没变——光比这些认不出来，得挨条比。
  setOffscreen();
  const { surface } = mount();
  const old = inked(surface.layer, OLD[0]);
  down(surface, 100, 300); move(surface, 160, 300); up(surface, 200, 300);

  old.color = '#777777';
  const cache = offscreen.made[0];
  cache.__log.length = 0;
  down(surface, 100, 400);
  move(surface, 160, 400);
  assert.ok(colours(cache.__log).includes('#777777'), '贴出来的是改过之后的颜色');
  assert.ok(!colours(cache.__log).includes(OLD[0]), '不是上一笔时存下的旧样子');
});

await test('两笔之间套索搬过、转过一条：下一笔落笔重画（点数组换了、边界变了）', async () => {
  setOffscreen();
  const { surface } = mount();
  const old = inked(surface.layer, OLD[0]);
  down(surface, 100, 300); up(surface, 160, 300);
  const cache = offscreen.made[0];

  // 照 transformSelection 的做法：换一个新的点数组、重算边界。
  old.points = old.points.map((p) => ({ ...p, x: p.x + 30 }));
  recomputeBounds(old);
  cache.__log.length = 0;
  down(surface, 100, 400);
  assert.ok(colours(cache.__log).includes(OLD[0]), '搬过的那一条重画进图里');

  // 转半圈、边界不变：只换了点数组，也认得出来。
  up(surface, 160, 400);
  const box = { ...old.bounds };
  old.points = old.points.slice().reverse();
  recomputeBounds(old);
  assert.deepEqual({ ...old.bounds }, box);
  cache.__log.length = 0;
  down(surface, 100, 450);
  assert.ok(colours(cache.__log).includes(OLD[0]));
});

await test('两笔之间缩放、平移过：下一笔落笔按新视图重画', async () => {
  setOffscreen();
  const { surface } = mount();
  inked(surface.layer, OLD[0]);
  down(surface, 100, 300); up(surface, 160, 300);
  surface.setTransform(1.4, -12, 0);
  const cache = offscreen.made[0];
  cache.__log.length = 0;
  down(surface, 100, 400);
  assert.ok(colours(cache.__log).includes(OLD[0]));
});

await test('写着的时候同一页被别处原地改了：松手不往旧图上添，整张重画', async () => {
  // 同一页开在两栏，另一栏换了色；这一栏的图在这一笔开头还是对的，松手时已经不对了。
  setOffscreen();
  const { surface, log } = mount();
  const old = inked(surface.layer, OLD[0]);
  surface.setColor(PEN);
  down(surface, 100, 300);
  move(surface, 140, 300);
  old.color = '#777777';
  const cache = offscreen.made[0];
  cache.__log.length = 0;
  up(surface, 200, 300);
  assert.deepEqual(colours(cache.__log), ['#777777', PEN], '松手那一下按这一刻的层整张重画');
  assert.equal(calls(log, 'drawImage').at(-1)[1], cache);

  // 重画过了，下一笔落笔不用再画。
  cache.__log.length = 0;
  down(surface, 100, 400);
  assert.deepEqual(colours(cache.__log), []);
});

await test('两笔之间翻了一页：下一笔贴的是新那一页的笔迹', async () => {
  setOffscreen();
  const { surface } = mount();
  inked(surface.layer, OLD[0]);
  down(surface, 100, 300); move(surface, 160, 300); up(surface, 200, 300);

  const next = new InkLayer();
  inked(next, '#555555');
  surface.loadLayer(next);
  const cache = offscreen.made[0];
  cache.__log.length = 0;
  down(surface, 100, 400);
  move(surface, 160, 400);
  assert.deepEqual(colours(cache.__log), ['#555555']);
});

// ═══════════════════════════════════════════════════════════════
group('4. 停下来就放掉，接着写就留着用');

await test('松手以后一分钟不写，那张图放掉（位图清成 0×0）', async () => {
  setOffscreen();
  const clock = fakeTimers();
  try {
    const { surface } = mount();
    inked(surface.layer, OLD[0]);
    down(surface, 100, 300); move(surface, 160, 300);
    assert.equal(clock.timers.size, 0, '写着的时候没有要放掉它的计时');
    up(surface, 200, 300);
    const [[id, timer]] = [...clock.timers];
    assert.equal(timer.ms, 60000, '停下来想一会儿再写是常事，十秒太短');
    const cache = offscreen.made[0];
    assert.ok(cache.width > 0);
    clock.fire(id);
    assert.equal(surface._layerCache, null);
    assert.deepEqual([cache.width, cache.height], [0, 0], '一块和画布一样大的位图，不写了就别占着');
  } finally {
    clock.restore();
  }
});

await test('一分钟内接着写：计时作废，用的还是那一块', async () => {
  setOffscreen();
  const clock = fakeTimers();
  try {
    const { surface, log } = mount();
    inked(surface.layer, OLD[0]);
    down(surface, 100, 300); move(surface, 160, 300); up(surface, 200, 300);
    assert.equal(clock.timers.size, 1);
    down(surface, 100, 400);
    assert.equal(clock.timers.size, 0, '又落笔了，不能在写着的时候把它放掉');
    move(surface, 160, 400);
    assert.equal(offscreen.made.length, 1, '没有再建一块');
    const last = calls(log, 'drawImage').at(-1);
    assert.equal(last[1], offscreen.made[0]);
    up(surface, 200, 400);
    assert.equal(clock.timers.size, 1, '松手又开始数');
  } finally {
    clock.restore();
  }
});

await test('放掉以后再写：重新建一块，照样贴', async () => {
  setOffscreen();
  const clock = fakeTimers();
  try {
    const { surface, log } = mount();
    inked(surface.layer, OLD[0]);
    down(surface, 100, 300); up(surface, 160, 300);
    clock.fire([...clock.timers.keys()][0]);
    down(surface, 100, 400);
    move(surface, 160, 400);
    assert.equal(offscreen.made.length, 2);
    assert.equal(calls(log, 'drawImage').at(-1)[1], offscreen.made[1]);
    assert.ok(offscreen.made[1].width > 0);
  } finally {
    clock.restore();
  }
});

// ═══════════════════════════════════════════════════════════════
group('5. 建不了离屏画布就照旧整页重画');

await test('没有 2D 画布（原样的 jsdom）：不去建、不去要上下文，每一下整页重画', async () => {
  setOffscreen({ enabled: false });
  const { surface, log } = mount();
  inked(surface.layer, OLD[0]);
  surface.setColor(PEN);
  log.length = 0;
  down(surface, 100, 300);
  move(surface, 120, 300);
  move(surface, 140, 300);
  assert.equal(offscreen.asked, 0, 'jsdom 里要 2D 上下文会喊一声「没实现」，干脆不要');
  assert.equal(calls(log, 'drawImage').length, 0);
  assert.equal(colours(log).filter((c) => c === OLD[0]).length, 3, '落笔加两下，整页画了三次');
  up(surface, 160, 300);
  assert.equal(surface.layer.getAll().length, 2, '笔照样落下');
});

await test('要不到 2D 上下文（内存不够之类）：这一笔只试一次，整页重画；下一笔再试', async () => {
  setOffscreen({ refuse: true });
  const { surface, log } = mount();
  inked(surface.layer, OLD[0]);
  down(surface, 100, 300);
  for (let i = 0; i < 5; i++) move(surface, 120 + i * 10, 300);
  assert.equal(offscreen.asked, 1, '不是每动一下都去建一块画布、要一次上下文');
  assert.equal(calls(log, 'drawImage').length, 0);
  up(surface, 200, 300);

  offscreen.refuse = false;
  log.length = 0;
  down(surface, 100, 400);
  move(surface, 140, 400);
  assert.equal(offscreen.made.length, 1, '下一笔又试了，这回建出来了');
  assert.equal(calls(log, 'drawImage').length, 2);
});

// ═══════════════════════════════════════════════════════════════
group('6. 缩放还在变的那几帧（setTransform 带 approximate）：借拼好的轮廓按比例画');

await test('捏合、拖分栏线时整层重画借别的缩放下拼好的轮廓；停下来那一下按准确的缩放重拼', async () => {
  const made = [];
  class FakePath2D {
    constructor() { made.push(this); }
    moveTo() {} lineTo() {} arc() {} closePath() {} quadraticCurveTo() {}
  }
  const saved = globalThis.Path2D;
  globalThis.Path2D = FakePath2D;
  try {
    setOffscreen({ enabled: false });
    const { surface, log } = mount();
    inked(surface.layer, '#a00000', 100, 100);
    inked(surface.layer, '#00a000', 100, 200);
    surface.setTransform(1, 0, 0);
    assert.equal(made.length, 2, '两条各拼一个');
    log.length = 0;
    for (const k of [1.1, 1.25, 1.4]) surface.setTransform(k, 0, 0, { approximate: true });
    assert.equal(made.length, 2, '缩放在变的那几帧不重拼');
    assert.equal(calls(log, 'scale').length, 6, '每帧两条各按比例缩放一次');
    surface.setTransform(1.4, 0, 0);
    assert.equal(made.length, 4, '停下来按准确的缩放重拼');
  } finally {
    if (saved === undefined) delete globalThis.Path2D;
    else globalThis.Path2D = saved;
  }
});

await test('写字那张缓存图的键记着是不是近似画的：停下来那一下不拿近似画的图顶', async () => {
  setOffscreen({ enabled: true });
  const { surface } = mount();
  surface.setTransform(1.5, 0, 0, { approximate: true });
  const roughKey = surface._layerCacheKey();
  surface.setTransform(1.5, 0, 0);
  assert.notDeepEqual(surface._layerCacheKey(), roughKey);
});

// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
