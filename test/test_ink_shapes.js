#!/usr/bin/env node
// 形状工具：拖出一条直线、拖出一个圆。
//
// 这一整套行为是照着一段视频逐帧量出来的（1920×1228、55.9fps），量到的数字写在
// src/ink/shape-geometry.js 的开头。这个文件的用处是把那些数字**钉住**：容差改
// 成别的值、吸附的方向反了、圆点跑到外接框的角上去了，这里都会当场红。
//
// 所以下面好几条断言里直接写着视频的帧号和当时笔的位置。那不是注释，那是证据。
//
// 另外钉三件「它必须和别的东西一样」的事：
//   · 形状落下来是一条**普通笔迹** —— 同一个层、同一段撤销、同一把橡皮。不然
//     它就是页面上一类新的东西，而这个应用里所有别的功能都不认识它。
//   · 拖一颗圆点改形状，是**一步**撤销，不是「擦一次 + 画一次」两步。
//   · 那几颗圆点和套索的选区一样，翻页、换工具就该走。

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
// jsdom 的指针捕获只实现了一半，而这条路上每一次按下都要用它。组件本来就把它
// 当「能捕就捕」，这里给它一个不会抛的空实现。
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};

const {
  SHAPE_KINDS, SHAPE_ORDER, createShape, deserializeShape, handleAt, hitShape, isClosedShape,
  reshape, serializeShape, shapeBox, shapeGuides, shapeHandles, shapeLabels, shapePoints,
  shapeVertices, tooSmall,
} = await import('../src/ink/shape-geometry.js');
const { InkSurface } = await import('../src/ink/ink-surface.js');

const P = (x, y) => ({ x, y });
/** 从锚点出发、和水平方向成某个角度、长 len 的一次拖动。 */
const at = (deg, len = 500) => P(
  Math.cos(deg * Math.PI / 180) * len,
  Math.sin(deg * Math.PI / 180) * len,
);
/** 一条形状的实际角度（度）。 */
const angleOf = (shape) => Math.atan2(
  shape.to.y - shape.from.y, shape.to.x - shape.from.x,
) * 180 / Math.PI;

// ═══════════════════════════════════════════════════════════════
group('1. 直线：视频里那几帧');

// 落笔 (424,822)，下面四帧是从录像里数出来的笔的位置，换算成相对锚点的角度。
await test('第 182 帧 −3.9°：吸成正水平', async () => {
  const shape = createShape(SHAPE_KINDS.LINE, P(424, 822), P(632, 808));
  assert.equal(shape.snapped, true);
  assert.equal(shape.to.y, 822, '吸住之后 y 和锚点一样高，屏幕上量到的正是这个');
});

await test('第 199 帧 −5.2°：还是正水平', async () => {
  const shape = createShape(SHAPE_KINDS.LINE, P(424, 822), P(958, 773));
  assert.equal(shape.snapped, true);
  assert.equal(Math.round(shape.to.y), 822);
});

await test('第 202 帧 −6.0°：脱开，回到真实角度', async () => {
  const shape = createShape(SHAPE_KINDS.LINE, P(424, 822), P(941, 768));
  assert.equal(shape.snapped, false);
  assert.ok(Math.abs(angleOf(shape) + 5.96) < 0.1, `量到的是 −5.96°，算出来 ${angleOf(shape)}`);
});

await test('第 180 帧 −5.9°：还没画到刻度上，也不吸', async () => {
  // 这一条和上一条一起把容差夹在 5.2° 和 5.9° 之间。只有一边的话，把容差写成
  // 90° 也能过。
  const shape = createShape(SHAPE_KINDS.LINE, P(424, 822), P(588, 805));
  assert.equal(shape.snapped, false);
});

await test('吸附不改长度，只改方向', async () => {
  const from = P(0, 0);
  const to = at(-4, 500);
  const shape = createShape(SHAPE_KINDS.LINE, from, to);
  assert.equal(shape.snapped, true);
  const len = Math.hypot(shape.to.x - from.x, shape.to.y - from.y);
  assert.ok(Math.abs(len - 500) < 1e-6, `长度应该还是 500，实际 ${len}`);
  assert.ok(Math.abs(shape.to.y) < 1e-9, '方向吸到 0° 上');
});

await test('15 的倍数都吸：45°、90°、−135° 都能吸住', async () => {
  for (const target of [15, 45, 90, 135, -45, -90, -135, 180]) {
    const shape = createShape(SHAPE_KINDS.LINE, P(0, 0), at(target + 3, 400));
    assert.equal(shape.snapped, true, `${target}+3° 该吸住`);
    const got = angleOf(shape);
    const diff = Math.abs(((got - target + 540) % 360) - 180);
    assert.ok(diff < 1e-6, `${target}+3° 应该吸到 ${target}，实际 ${got}`);
  }
});

await test('刻度之间不吸：22° 就是 22°', async () => {
  const shape = createShape(SHAPE_KINDS.LINE, P(0, 0), at(22, 300));
  assert.equal(shape.snapped, false);
  assert.ok(Math.abs(angleOf(shape) - 22) < 1e-6);
});

await test('直线吸住时不画辅助线', async () => {
  // 视频里那二十帧屏幕上只有线本身，没有第二个物体。给它编一条「水平参考线」
  // 是在还原之外自己加戏。
  const shape = createShape(SHAPE_KINDS.LINE, P(0, 0), at(-2, 300));
  assert.equal(shape.snapped, true);
  assert.deepEqual(shapeGuides(shape), []);
});

// ═══════════════════════════════════════════════════════════════
group('2. 圆：视频里那几帧');

// 落笔 (1117,625) 是外接框的一角。
await test('第 339 帧 169×153（差 10%）：还是椭圆', async () => {
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(1117, 625), P(1117 + 169, 625 + 153));
  assert.equal(shape.snapped, false);
  const box = shapeBox(shape);
  assert.equal(box.x1 - box.x0, 169);
  assert.equal(box.y1 - box.y0, 153);
});

await test('第 343 帧 差 3%：吸成正圆，直径取长的那一边', async () => {
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(1117, 625), P(1117 + 234, 625 + 228));
  assert.equal(shape.snapped, true);
  const box = shapeBox(shape);
  assert.equal(box.x1 - box.x0, 234, '取的是长边 234，不是短边 228');
  assert.equal(box.y1 - box.y0, 234);
});

await test('吸住的时候锚点那一角不动', async () => {
  // 视频里外接框的左上角从落笔到松手一个像素都没挪过。动锚点的话，圆会在吸住
  // 的一瞬间从笔底下滑走。
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(1117, 625), P(1117 + 234, 625 + 228));
  assert.deepEqual({ x: shape.from.x, y: shape.from.y }, { x: 1117, y: 625 });
});

await test('往左上拖也一样吸，方向不丢', async () => {
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(500, 500), P(500 - 200, 500 - 196));
  assert.equal(shape.snapped, true);
  assert.equal(shape.to.x, 300);
  assert.equal(shape.to.y, 300, '往左上拖，对角就该落在左上');
});

await test('吸成正圆时有一横一竖两条辅助线，各贯穿整个直径', async () => {
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(0, 0), P(200, 196));
  const guides = shapeGuides(shape);
  assert.equal(guides.length, 2);
  const box = shapeBox(shape);
  const horizontal = guides.find(g => g.y1 === g.y2);
  const vertical = guides.find(g => g.x1 === g.x2);
  assert.ok(horizontal && vertical, '一条横的、一条竖的');
  assert.equal(horizontal.x1, box.x0);
  assert.equal(horizontal.x2, box.x1);
  assert.equal(vertical.y1, box.y0);
  assert.equal(vertical.y2, box.y1);
  assert.equal(horizontal.y1, (box.y0 + box.y1) / 2, '横线穿过圆心');
  assert.equal(vertical.x1, (box.x0 + box.x1) / 2);
});

await test('没吸住的椭圆没有辅助线', async () => {
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(0, 0), P(200, 120));
  assert.equal(shape.snapped, false);
  assert.deepEqual(shapeGuides(shape), []);
});

// ═══════════════════════════════════════════════════════════════
group('3. 采出来的点');

await test('直线两端准确，中间是采出来的', async () => {
  const shape = createShape(SHAPE_KINDS.LINE, P(10, 10), P(10, 130));
  const pts = shapePoints(shape);
  assert.ok(pts.length > 2, '只有两个点的直线在区域橡皮底下是切不开的');
  assert.deepEqual([pts[0].x, pts[0].y], [10, 10]);
  assert.deepEqual([pts[pts.length - 1].x, pts[pts.length - 1].y], [10, 130]);
  assert.ok(pts.every(p => p.p === 0.5), '压力一律中间值，形状是等宽的');
});

await test('圆是闭合的，而且点都落在圆上', async () => {
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(0, 0), P(200, 200));
  const pts = shapePoints(shape);
  const first = pts[0];
  const last = pts[pts.length - 1];
  assert.ok(Math.hypot(first.x - last.x, first.y - last.y) < 1e-9, '首尾要重合，不然圆上有道缝');
  for (const p of pts) {
    const d = Math.hypot(p.x - 100, p.y - 100);
    assert.ok(Math.abs(d - 100) < 1e-6, `点 (${p.x},${p.y}) 不在圆上`);
  }
});

await test('椭圆按外接框走，不偷偷变圆', async () => {
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(0, 0), P(200, 100));
  const pts = shapePoints(shape);
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  assert.ok(Math.abs(Math.max(...xs) - 200) < 1e-6);
  assert.ok(Math.abs(Math.max(...ys) - 100) < 1e-6);
});

await test('点一下、没拖出大小的，不算一个形状', async () => {
  assert.equal(tooSmall(createShape(SHAPE_KINDS.LINE, P(5, 5), P(6, 6))), true);
  assert.equal(tooSmall(createShape(SHAPE_KINDS.CIRCLE, P(5, 5), P(7, 5))), true);
  assert.equal(tooSmall(createShape(SHAPE_KINDS.LINE, P(5, 5), P(50, 5))), false);
});

// ═══════════════════════════════════════════════════════════════
group('4. 松手之后那几颗圆点');

await test('直线两颗，就在两端', async () => {
  const shape = createShape(SHAPE_KINDS.LINE, P(10, 20), P(110, 20));
  const handles = shapeHandles(shape);
  assert.equal(handles.length, 2);
  assert.deepEqual(handles.map(h => [h.x, h.y]), [[10, 20], [110, 20]]);
});

await test('圆四颗，在四个正交点上，不在外接框的角上', async () => {
  // 视频里那四颗是压在线上的。摆到角上去的话，人会以为拖它能斜着缩放。
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(0, 0), P(200, 200));
  const handles = shapeHandles(shape);
  assert.equal(handles.length, 4);
  assert.deepEqual(
    handles.map(h => [h.x, h.y]).sort(),
    [[0, 100], [100, 0], [100, 200], [200, 100]].sort(),
  );
});

await test('够近才算摸到那颗圆点', async () => {
  const shape = createShape(SHAPE_KINDS.LINE, P(0, 0), P(100, 0));
  assert.equal(handleAt(shape, P(98, 3), 10)?.id, 'v1');
  assert.equal(handleAt(shape, P(50, 0), 10), null, '线的中间不是把手');
});

await test('拖直线一端：另一端不动，吸附照旧', async () => {
  const shape = createShape(SHAPE_KINDS.LINE, P(0, 0), P(100, 40));
  const moved = reshape(shape, 'v1', at(-3, 200));
  assert.deepEqual([moved.from.x, moved.from.y], [0, 0], '锚还是原来那一端');
  assert.equal(moved.snapped, true, '改回来的那一下和画出来的那一下同一套规矩');
});

await test('拖直线的起点：这时另一端当锚', async () => {
  const shape = createShape(SHAPE_KINDS.LINE, P(0, 0), P(100, 0));
  const moved = reshape(shape, 'v0', P(-50, 60));
  const ends = [[moved.from.x, moved.from.y], [moved.to.x, moved.to.y]];
  assert.ok(ends.some(e => e[0] === 100 && e[1] === 0), '原来的终点得留在原处');
});

await test('拖圆的右边：左边不动', async () => {
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(0, 0), P(100, 100));
  const moved = reshape(shape, 'v1', P(300, 50));
  const box = shapeBox(moved);
  assert.equal(box.x0, 0, '对边不动');
  assert.equal(box.x1, 300);
  assert.equal(box.y1 - box.y0, 100, '另一个方向没被动过');
});

await test('把椭圆拖到接近正方，会咬住', async () => {
  const shape = createShape(SHAPE_KINDS.CIRCLE, P(0, 0), P(100, 200));
  assert.equal(shape.snapped, false);
  const moved = reshape(shape, 'v1', P(196, 0));
  assert.equal(moved.snapped, true);
  const box = shapeBox(moved);
  assert.equal(box.x1 - box.x0, box.y1 - box.y0);
});

// ═══════════════════════════════════════════════════════════════
group('5. 画在真画布上：它就是一条普通笔迹');

/** jsdom 没有画布。这里要的不是画得对，是别在画的时候炸掉。 */
function stubContext() {
  const sink = {};
  return new Proxy(sink, {
    get(target, key) {
      if (key === 'canvas') return null;
      if (!(key in target)) target[key] = () => {};
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function mount() {
  document.body.innerHTML = '<div class="host"></div>';
  const host = document.querySelector('.host');
  const canvas = document.createElement('canvas');
  canvas.getContext = () => stubContext();
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0,
  });
  host.appendChild(canvas);
  const surface = new InkSurface(canvas, {});
  surface.resize(800, 600, 1);
  surface.setTransform(1, 0, 0);
  return surface;
}

function pointer(type, x, y) {
  return new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
    clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1,
  });
}

/** 一次完整的拖动：按下、走几步、松手。 */
function drag(surface, from, to, steps = 4) {
  const c = surface.canvas;
  c.dispatchEvent(pointer('pointerdown', from.x, from.y));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    c.dispatchEvent(pointer('pointermove', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t));
  }
  c.dispatchEvent(pointer('pointerup', to.x, to.y));
}

await test('拖一下，层里多一条笔迹；撤销一下，它就没了', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.LINE);
  drag(surface, P(100, 100), P(400, 103));
  assert.equal(surface.layer.getAll().length, 1, '形状落进的是同一个层');
  assert.equal(surface.canUndo(), true);
  surface.history.undo();
  assert.equal(surface.layer.getAll().length, 0, '一步撤销就该回去');
});

await test('落下来的那条线是吸过的：−0.6° 拖出来是水平的', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.LINE);
  drag(surface, P(100, 100), P(400, 103));
  const stroke = surface.layer.getAll()[0];
  const ys = stroke.points.map(p => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 1e-6, '吸住之后整条一样高');
});

await test('点一下不留东西', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.LINE);
  drag(surface, P(200, 200), P(201, 200), 1);
  assert.equal(surface.layer.getAll().length, 0, '一个点不是任何人要的形状');
});

await test('画圆：接近正方的一拖，落下来是正圆', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.CIRCLE);
  drag(surface, P(100, 100), P(300, 296));
  const stroke = surface.layer.getAll()[0];
  const w = stroke.bounds.maxX - stroke.bounds.minX;
  const h = stroke.bounds.maxY - stroke.bounds.minY;
  assert.ok(Math.abs(w - h) < 1e-6, `吸成正圆之后长宽该一样，实际 ${w}×${h}`);
});

await test('松手之后圆点在；按别处它们就走，同时开始画新的', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.LINE);
  drag(surface, P(100, 100), P(400, 103));
  assert.ok(surface._shapeSel, '松手之后还能改它');

  surface.canvas.dispatchEvent(pointer('pointerdown', P(50, 400).x, P(50, 400).y));
  assert.equal(surface._shapeSel, null, '视频里圆点正是在下一次碰屏幕那一帧灭的');
  surface.canvas.dispatchEvent(pointer('pointerup', 50, 400));
});

await test('换工具，圆点跟着走', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.CIRCLE);
  drag(surface, P(100, 100), P(300, 296));
  assert.ok(surface._shapeSel);
  surface.setTool('pen');
  assert.equal(surface._shapeSel, null, '换了笔还留着圆点，等于给了一个按不动的东西');
});

await test('翻一页，圆点也走', async () => {
  const { InkLayer } = await import('../src/ink/ink-layer.js');
  const surface = mount();
  surface.setShape(SHAPE_KINDS.LINE);
  drag(surface, P(100, 100), P(400, 103));
  surface.loadLayer(new InkLayer());
  assert.equal(surface._shapeSel, null, '那几颗圆点指着的是上一页的东西');
});

await test('拖一颗圆点：层里还是一条，不是两条', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.LINE);
  drag(surface, P(100, 100), P(400, 103));
  const before = surface.layer.getAll()[0];
  const endX = before.points[before.points.length - 1].x;

  drag(surface, P(endX, 100), P(500, 260));
  assert.equal(surface.layer.getAll().length, 1, '改形状不是复制一份出来');
  const after = surface.layer.getAll()[0];
  assert.notEqual(after.id, before.id);
  assert.ok(after.bounds.maxX > 450, '真的被拖长了');
});

await test('拖完圆点，一次撤销回到改之前的样子', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.LINE);
  drag(surface, P(100, 100), P(400, 103));
  const before = surface.layer.getAll()[0];
  const beforeMaxX = before.bounds.maxX;
  const endX = before.points[before.points.length - 1].x;

  drag(surface, P(endX, 100), P(500, 260));
  surface.history.undo();

  const all = surface.layer.getAll();
  assert.equal(all.length, 1, '撤销之后还是一条，不是零条也不是两条');
  assert.ok(Math.abs(all[0].bounds.maxX - beforeMaxX) < 1e-6, '回到改之前的那条');
});

await test('拖圆点拖到没了：当这一下没发生过', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.LINE);
  drag(surface, P(100, 100), P(400, 103));
  const before = surface.layer.getAll()[0];
  const endX = before.points[before.points.length - 1].x;

  drag(surface, P(endX, 100), P(100, 100));
  assert.equal(surface.layer.getAll().length, 1, '一条笔迹不该因为拖过头就消失');
});

// ═══════════════════════════════════════════════════════════════
group('6. 面板上那十个');

await test('每一种的控制点数，和它该有的一样', async () => {
  const want = {
    line: 2, arrow: 2, darrow: 2, corner: 3, arc: 3,
    circle: 4, triangle: 3, rect: 4, pentagon: 5, star: 10,
  };
  for (const kind of SHAPE_ORDER) {
    const shape = createShape(kind, P(0, 0), P(200, 140));
    assert.equal(shapeVertices(shape).length, want[kind], `${kind} 的控制点数不对`);
    assert.equal(shapeHandles(shape).length, want[kind], `${kind} 的圆点数不对`);
  }
});

await test('闭合的是那五个，开口的是那五个', async () => {
  const closed = SHAPE_ORDER.filter(k => isClosedShape(createShape(k, P(0, 0), P(10, 10))));
  assert.deepEqual(closed, ['circle', 'triangle', 'rect', 'pentagon', 'star']);
});

await test('三角形吸住的时候是正三角形，不是底高相等的那个瘦高个', async () => {
  // 虚线十字说的是「现在是正的那一个」。圆、方、五边、星的「正」都对应一个正方
  // 形的框，三角形不是：它的三个顶点是「上中 + 左下 + 右下」，框正方的时候顶角
  // 53°。正三角形的高是底的 √3/2。
  const shape = createShape(SHAPE_KINDS.TRIANGLE, P(0, 0), P(200, 170));
  assert.equal(shape.snapped, true, '离正三角形只差 2%，该吸住');
  const box = shapeBox(shape);
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  assert.ok(Math.abs(h / w - Math.sqrt(3) / 2) < 1e-9, `框该是 1:0.866，实际 ${(h / w).toFixed(4)}`);

  const v = shapeVertices(shape);
  const sides = v.map((p, i) => {
    const q = v[(i + 1) % v.length];
    return Math.hypot(q.x - p.x, q.y - p.y);
  });
  const max = Math.max(...sides);
  const min = Math.min(...sides);
  assert.ok(max - min < 1e-9, `三条边该一样长，实际 ${min.toFixed(2)}–${max.toFixed(2)}`);
  assert.equal(shapeGuides(shape).length, 2, '吸住了就该画那两条线');
});

await test('三角形拖成正方形的框：那是等腰不是正三角，所以不吸', async () => {
  const shape = createShape(SHAPE_KINDS.TRIANGLE, P(0, 0), P(200, 200));
  assert.equal(shape.snapped, false, '底高相等离正三角差 15%，不该报「正」');
  assert.deepEqual(shapeGuides(shape), []);
});

await test('三角形的三个内角吸住时各 60°', async () => {
  const labels = shapeLabels(createShape(SHAPE_KINDS.TRIANGLE, P(0, 0), P(200, 170)));
  assert.equal(labels.length, 3);
  for (const l of labels) {
    assert.ok(Math.abs(l.degrees - 60) < 1e-6, `该是 60°，实际 ${l.degrees.toFixed(2)}`);
  }
});

await test('别的形状还是按正方形的框吸，一点没变', async () => {
  for (const kind of ['circle', 'rect', 'pentagon', 'star']) {
    const shape = createShape(kind, P(0, 0), P(200, 196));
    assert.equal(shape.snapped, true, `${kind} 差 2% 该吸住`);
    const box = shapeBox(shape);
    assert.equal(box.x1 - box.x0, box.y1 - box.y0, `${kind} 吸住之后框该是正方的`);
  }
});

await test('框是正方形时，五边形五条边一样长', async () => {
  const v = shapeVertices(createShape(SHAPE_KINDS.PENTAGON, P(0, 0), P(200, 200)));
  const sides = v.map((p, i) => {
    const q = v[(i + 1) % v.length];
    return Math.hypot(q.x - p.x, q.y - p.y);
  });
  const max = Math.max(...sides);
  const min = Math.min(...sides);
  assert.ok(max - min < 1e-6, `五条边应该一样长，实际 ${min.toFixed(2)}–${max.toFixed(2)}`);
  assert.ok(Math.abs(v[0].x - 100) < 1e-6 && Math.abs(v[0].y) < 1e-6, '第一个顶点朝正上');
});

await test('五角星：内外半径之比是正五角星那个数', async () => {
  // 视频里量到的是 73/183 = 0.399，正五角星是 1/φ² = 0.382——差在测量误差里。
  const v = shapeVertices(createShape(SHAPE_KINDS.STAR, P(0, 0), P(200, 200)));
  const r = v.map(p => Math.hypot(p.x - 100, p.y - 100));
  const outer = r.filter((_, i) => i % 2 === 0);
  const inner = r.filter((_, i) => i % 2 === 1);
  const ratio = inner[0] / outer[0];
  assert.ok(Math.abs(ratio - 0.382) < 1e-6, `比值应是 0.382，实际 ${ratio.toFixed(3)}`);
  assert.ok(outer.every(x => Math.abs(x - outer[0]) < 1e-6), '五个外顶点一样远');
});

await test('弧：两端齐平，最高点在正中间，整条都在半椭圆上', async () => {
  const shape = createShape(SHAPE_KINDS.ARC, P(0, 100), P(200, 0));
  const v = shapeVertices(shape);
  assert.deepEqual([v[0].x, v[0].y], [0, 100]);
  assert.deepEqual([v[2].x, v[2].y], [200, 100]);
  assert.deepEqual([v[1].x, v[1].y], [100, 0], '鼓到对边的正中间');
  for (const p of shapePoints(shape)) {
    const t = ((p.x - 100) / 100) ** 2 + ((p.y - 100) / 100) ** 2;
    assert.ok(Math.abs(t - 1) < 1e-6, `点 (${p.x.toFixed(1)},${p.y.toFixed(1)}) 不在半椭圆上`);
    assert.ok(p.y <= 100 + 1e-9, '只画上半边');
  }
});

await test('箭头比直线多两根倒须，双箭头多四根', async () => {
  const from = P(0, 0);
  const to = P(200, 0);
  const line = shapePoints(createShape(SHAPE_KINDS.LINE, from, to), { width: 3 });
  const arrow = shapePoints(createShape(SHAPE_KINDS.ARROW, from, to), { width: 3 });
  const darrow = shapePoints(createShape(SHAPE_KINDS.DARROW, from, to), { width: 3 });
  assert.ok(arrow.length > line.length, '倒须也是点');
  assert.ok(darrow.length > arrow.length, '两头都有头');
  // 倒须是斜着往回走的，所以会离开那条水平线。
  assert.ok(arrow.some(p => Math.abs(p.y) > 2), '箭头得张开，不能缩在杆上');
  // 倒须是从尖上往回长的：尖在起点的那一对，长在起点右边一小段。
  assert.ok(darrow.some(p => p.x < 20 && Math.abs(p.y) > 2), '起点那一头也有');
  assert.ok(darrow.some(p => p.x > 180 && Math.abs(p.y) > 2), '终点那一头也有');
});

await test('矩形四个角都是 90°，而且都带直角符号', async () => {
  const labels = shapeLabels(createShape(SHAPE_KINDS.RECT, P(0, 0), P(160, 90)));
  assert.equal(labels.length, 4);
  assert.ok(labels.every(l => Math.abs(l.degrees - 90) < 1e-6));
  assert.ok(labels.every(l => l.right), '正好 90° 的才画那个符号');
});

await test('三角和五边的内角和对得上', async () => {
  const sum = (kind) => shapeLabels(createShape(kind, P(0, 0), P(200, 200)))
    .reduce((n, l) => n + l.degrees, 0);
  assert.ok(Math.abs(sum(SHAPE_KINDS.TRIANGLE) - 180) < 1e-6, '三角形内角和 180°');
  assert.ok(Math.abs(sum(SHAPE_KINDS.PENTAGON) - 540) < 1e-6, '五边形内角和 540°');
});

await test('直线、箭头、圆、弧没有角度标签', async () => {
  for (const kind of ['line', 'arrow', 'darrow', 'circle', 'arc']) {
    assert.deepEqual(shapeLabels(createShape(kind, P(0, 0), P(100, 80))), [],
      `${kind} 不该有标签——它没有「角」可言，视频里也一个字都没有`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('7. 点一下已经画好的形状（第 2706–2724 帧）');

await test('闭合形状：点在它里面就算点中它', async () => {
  const rect = createShape(SHAPE_KINDS.RECT, P(0, 0), P(200, 120));
  assert.equal(hitShape(rect, P(100, 60)), true, '视频里那一下正是点在矩形当中的空白处');
  assert.equal(hitShape(rect, P(400, 60)), false);
});

await test('开口形状只认线附近，不认它外接框里的空地', async () => {
  const line = createShape(SHAPE_KINDS.LINE, P(0, 0), P(200, 200));
  assert.equal(hitShape(line, P(100, 102), 8), true);
  assert.equal(hitShape(line, P(30, 170), 8), false, '斜线不该把它的外接框都认成自己');
});

await test('拖一个顶点之后，它不再是矩形，角度当场各自报数', async () => {
  // 第 2724→2754 帧：四个 90° 变成 83°/92°/95°/90°，直角符号只留在还是 90° 的
  // 那个角上。
  const rect = createShape(SHAPE_KINDS.RECT, P(0, 0), P(200, 120));
  const moved = reshape(rect, 'v0', P(-40, -30));
  assert.equal(moved.kind, SHAPE_KINDS.POLY, '拖过顶点就回不去了，这是对的');
  const labels = shapeLabels(moved);
  assert.equal(labels.length, 4);
  assert.equal(labels.filter(l => l.right).length, 1, '只剩一个角还是 90°');
  assert.ok(Math.abs(labels.reduce((n, l) => n + l.degrees, 0) - 360) < 1e-6,
    '四边形内角和还是 360°');
});

await test('星星被拖过一个顶点之后是一团自由多边形，顶点还是十个', async () => {
  const star = createShape(SHAPE_KINDS.STAR, P(0, 0), P(200, 200));
  const blob = reshape(star, 'v3', P(400, 400));
  assert.equal(blob.kind, SHAPE_KINDS.POLY);
  assert.equal(shapeVertices(blob).length, 10);
  assert.deepEqual([blob.pts[3].x, blob.pts[3].y], [400, 400]);
});

await test('形状跟着笔迹落盘，读回来还是同一个', async () => {
  for (const kind of [...SHAPE_ORDER, SHAPE_KINDS.POLY]) {
    const shape = kind === SHAPE_KINDS.POLY
      ? reshape(createShape(SHAPE_KINDS.RECT, P(0, 0), P(100, 100)), 'v2', P(160, 40))
      : createShape(kind, P(10, 20), P(160, 130));
    const back = deserializeShape(serializeShape(shape));
    assert.ok(back, `${kind} 读不回来`);
    assert.equal(back.kind, shape.kind);
    const a = shapeVertices(shape);
    const b = shapeVertices(back);
    assert.equal(b.length, a.length, `${kind} 的控制点数变了`);
    for (let i = 0; i < a.length; i++) {
      assert.ok(Math.abs(a[i].x - b[i].x) < 0.01 && Math.abs(a[i].y - b[i].y) < 0.01,
        `${kind} 第 ${i} 个控制点对不上`);
    }
  }
});

await test('画布上：点空处圆点就走，点回形状里圆点就回来', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.RECT);
  drag(surface, P(120, 120), P(320, 260));
  assert.ok(surface._shapeSel, '刚画完是选中的');

  drag(surface, P(600, 400), P(600, 400), 1);
  assert.equal(surface._shapeSel, null, '点一下空处，圆点该走');

  drag(surface, P(220, 190), P(220, 190), 1);
  assert.ok(surface._shapeSel, '点一下已有的形状，它就该重新亮起来');
  assert.equal(surface.layer.getAll().length, 1, '点一下不该多出一条笔迹');
});

await test('在已有形状上面拖，画的是新的一个，不是选中它', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.RECT);
  drag(surface, P(120, 120), P(320, 260));
  drag(surface, P(200, 180), P(300, 240));
  assert.equal(surface.layer.getAll().length, 2, '手走了就是在画新的');
});

await test('选中之后拖一个顶点：层里还是一条，一次撤销回得去', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.TRIANGLE);
  drag(surface, P(100, 100), P(300, 260));
  const before = surface.layer.getAll()[0];
  const apex = shapeHandles(surface._shapeSel.shape)[0];

  drag(surface, P(apex.x, apex.y), P(apex.x + 120, apex.y - 60));
  assert.equal(surface.layer.getAll().length, 1, '改形状不是复制一份出来');
  assert.equal(surface.layer.getAll()[0].shape.kind, SHAPE_KINDS.POLY);

  surface.history.undo();
  assert.equal(surface.layer.getAll().length, 1);
  assert.equal(surface.layer.getAll()[0].id, before.id, '撤销之后回来的是原来那一条');
  assert.equal(surface.layer.getAll()[0].shape.kind, SHAPE_KINDS.TRIANGLE);
});

await test('填充只给闭合的形状，直线不填', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.CIRCLE, '#dc2626');
  drag(surface, P(100, 100), P(300, 296));
  assert.equal(surface.layer.getAll()[0].fill, '#dc2626');

  surface.setShape(SHAPE_KINDS.LINE);
  drag(surface, P(400, 400), P(560, 460));
  const line = surface.layer.getAll()[1];
  assert.equal(line.fill, null, '一条直线「里面」没有面积可填');
});

await test('撤销之后，圆点跟着一起走', async () => {
  // 真机上撞到的：画完一个形状按撤销，形状没了，四颗琥珀点还浮在纸上——拖不动
  // （那条笔迹已经查无此人）、擦不掉（橡皮擦的是笔迹），但看着像页面上的内容。
  const surface = mount();
  surface.setShape(SHAPE_KINDS.CIRCLE);
  drag(surface, P(100, 100), P(300, 296));
  assert.ok(surface._shapeSel, '刚画完是选中的');

  surface.history.undo();
  surface.render();
  assert.equal(surface._shapeSel, null, '笔迹都不在层里了，圆点不该还留着');
});

await test('形状被别的东西删掉，圆点也不留', async () => {
  const surface = mount();
  surface.setShape(SHAPE_KINDS.RECT);
  drag(surface, P(120, 120), P(320, 260));
  const id = surface.layer.getAll()[0].id;

  surface.layer.removeByIds([id]);   // 橡皮、套索删除走的都是这条路
  surface.render();
  assert.equal(surface._shapeSel, null);
});

await test('被套索搬走之后，它就变回一条普通笔迹', async () => {
  // 形状记的是「这些点是怎么算出来的」。搬过之后点已经不是那么算出来的了，再让
  // 它亮圆点，拖一下会把整条笔迹弹回原处——那是谁都看不懂的一下。
  const surface = mount();
  surface.setShape(SHAPE_KINDS.RECT);
  drag(surface, P(120, 120), P(320, 260));
  const stroke = surface.layer.getAll()[0];
  for (const p of stroke.points) { p.x += 90; p.y += 40; }
  surface._dropShapeSelection();

  drag(surface, P(310, 230), P(310, 230), 1);
  assert.equal(surface._shapeSel, null, '搬过的形状不该再认自己身上那几个点');
});

// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
