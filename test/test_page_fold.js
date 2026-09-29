#!/usr/bin/env node
// 翻页：按折痕对折，而折痕永远不越过固定的那一边（src/pdf/page-fold.js）。
//
// 人说「滑动翻页的手感优化一下，应该有一边是固定的」，又说清楚了：从右往左翻（下一页）固定左边，
// 从左往右翻（上一页）固定右边。原来斜着拉一个角、或者松手以后自己翻完的那一段，折痕会斜着扫过
// 固定的那一边，那一边的角也被折了起来。
//
//   1. 约束：被拉着的那一点投回「折痕不越过固定边」的范围，范围两头正好是纸平躺、翻到底；
//   2. 松手：甩得够快听甩的方向，不快看翻过去多少；手停住再松开不算甩；
//   3. 剩下那一段：弹簧一路走，每一帧都守着约束，最后停在翻到底的那一点上。

import assert from 'node:assert/strict';
import {
  SETTLE_OMEGA,
  TURN_FLING,
  constrainFold,
  foldProgress,
  pointVelocity,
  releaseCommits,
  settleStep,
  spineX,
  stepFold,
  turnedPoint,
} from '../src/pdf/page-fold.js';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 折痕没越过固定边：固定边两头到 P 都不比到 A 远。 */
function keepsSpine(p, anchor, spine, h, eps = 1e-6) {
  return [{ x: spine, y: 0 }, { x: spine, y: h }]
    .every((q) => dist(p, q) <= dist(anchor, q) + eps);
}

// ═══════════════════════════════════════════════════════════════
group('1. 约束');

test('固定的那一边：往后翻是左边，往前翻是右边', () => {
  assert.equal(spineX('next', 300), 0);
  assert.equal(spineX('prev', 300), 300);
});

test('范围里面的点原样放行', () => {
  const A = { x: 300, y: 200 };
  for (const p of [{ x: 300, y: 200 }, { x: 150, y: 200 }, { x: 0, y: 200 }, { x: -250, y: 200 }, { x: 200, y: 150 }]) {
    assert.deepEqual(constrainFold(p, A, 0, 400), p);
  }
});

test('往后翻：怎么拉，左边都不会被折起来', () => {
  const w = 300;
  const h = 400;
  for (const A of [{ x: w, y: 0 }, { x: w, y: h }, { x: w, y: 170 }]) {
    for (const p of [{ x: -600, y: -300 }, { x: -400, y: 900 }, { x: -250, y: 20 }, { x: 100, y: -500 }, { x: 900, y: 900 }]) {
      const q = constrainFold(p, A, 0, h);
      assert.ok(keepsSpine(q, A, 0, h), `锚点 (${A.x},${A.y}) 拉到 (${p.x},${p.y})：折痕越过了左边`);
    }
  }
});

test('往前翻：右边是固定的那一边', () => {
  const A = { x: 0, y: 0 };
  const q = constrainFold({ x: 900, y: 500 }, A, 300, 400);
  assert.ok(keepsSpine(q, A, 300, 400));
});

test('投回去的是范围里离它最近的那一点', () => {
  const A = { x: 300, y: 400 };
  const p = { x: -500, y: 450 };
  const q = constrainFold(p, A, 0, 400);
  // 在范围里随便撒点，没有一个比它更近
  for (let x = -300; x <= 300; x += 7) {
    for (let y = -100; y <= 700; y += 7) {
      const r = { x, y };
      if (!keepsSpine(r, A, 0, 400, 0)) continue;
      assert.ok(dist(r, p) >= dist(q, p) - 1e-6, `(${x},${y}) 比投出来的点更近`);
    }
  }
});

test('翻到底：锚点关于固定边的镜像，正好在范围的另一头', () => {
  const A = { x: 300, y: 130 };
  const T = turnedPoint(A, 0);
  assert.deepEqual(T, { x: -300, y: 130 });
  assert.ok(keepsSpine(T, A, 0, 400));
  assert.deepEqual(constrainFold({ x: -2000, y: 130 }, A, 0, 400), T, '拉过了头，停在翻到底');
  assert.equal(foldProgress(A, T, 300), 1);
});

// ═══════════════════════════════════════════════════════════════
group('2. 松手');

test('甩得够快听甩的方向；不快看翻过去多少', () => {
  const fast = TURN_FLING + 0.2;
  assert.equal(releaseCommits('next', 0.05, -fast, 0.32), true, '往前甩，才拉开一点也翻');
  assert.equal(releaseCommits('next', 0.45, +fast, 0.32), false, '往回甩，翻过一大半也退回去');
  assert.equal(releaseCommits('prev', 0.05, +fast, 0.32), true);
  assert.equal(releaseCommits('prev', 0.45, -fast, 0.32), false);
  assert.equal(releaseCommits('next', 0.33, 0, 0.32), true, '慢慢松手：过了那条线就翻');
  assert.equal(releaseCommits('next', 0.31, 0, 0.32), false, '没过就退');
});

test('手停住一会儿再松开，那一下没有在甩', () => {
  const s = [{ t: 0, x: 300, y: 200 }, { t: 16, x: 280, y: 200 }, { t: 32, x: 260, y: 204 }];
  const v = pointVelocity(s, 40);
  assert.ok(Math.abs(v.vx + 1.25) < 1e-9 && Math.abs(v.vy - 0.125) < 1e-9);
  assert.deepEqual(pointVelocity(s, 400), { vx: 0, vy: 0 });
  const long = [{ t: 0, x: 300, y: 0 }, { t: 10, x: 299.5, y: 0 }, { t: 150, x: 280, y: 0 },
    { t: 166, x: 260, y: 0 }, { t: 182, x: 240, y: 0 }];
  assert.ok(Math.abs(pointVelocity(long, 182).vx + 1.25) < 1e-9, '只看最后 90ms');
});

// ═══════════════════════════════════════════════════════════════
group('3. 剩下那一段');

test('斜着松手、甩着翻过去：每一帧折痕都没越过固定边，最后停在翻到底', () => {
  const w = 300;
  const h = 400;
  const A = { x: w, y: h };                     // 拉着右下角
  const T = turnedPoint(A, 0);
  let s = { x: 120, y: 180, vx: -900, vy: -400 };   // 往左上甩出去
  for (let i = 0; i < 90; i++) {
    s = stepFold(s, T, 1 / 120, A, 0, h);
    assert.ok(keepsSpine(s, A, 0, h), `第 ${i} 帧折痕越过了左边：(${s.x.toFixed(1)}, ${s.y.toFixed(1)})`);
  }
  assert.ok(dist(s, T) < 2, `0.75 秒后还差 ${dist(s, T).toFixed(2)}px`);
});

test('退回去：落回原来的位置，一路也守着固定边', () => {
  const A = { x: 0, y: 200 };                   // 往前翻，拉着左边中间
  let s = { x: 180, y: 260, vx: 0, vy: 0 };
  for (let i = 0; i < 90; i++) {
    s = stepFold(s, A, 1 / 120, A, 300, 400);
    assert.ok(keepsSpine(s, A, 300, 400));
  }
  assert.ok(dist(s, A) < 2);
});

test('弹簧是临界阻尼的：从静止出发不越过目标', () => {
  let x = 200;
  let v = 0;
  for (let i = 0; i < 120; i++) {
    [x, v] = settleStep(x, v, 1 / 120, SETTLE_OMEGA);
    assert.ok(x >= -1e-9);
  }
  assert.ok(x < 1);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
