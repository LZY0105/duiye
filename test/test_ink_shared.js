#!/usr/bin/env node
// A09：同一份 PDF 同时开在两栏里，两边的批注不能互相吞掉。
//
// 原来会。每一栏各自 loadLayer 得到一份**新反序列化**的副本，而存盘是整层盲写：
//
//   两栏都停在第 7 页（各有那 2 笔）
//   → 左边画一笔，手里 3 笔，存成 3 笔
//   → 右边画一笔，可它手里还是当初那 2 笔，加上自己的一笔存成 3 笔
//   → 左边那一笔被整个盖掉
//
// 人看到的是「我刚画的没了」，而且是在另一栏里没的——最难查的那种。
//
// 合并不是好办法：要知道「哪些是我删掉的」才能和别人的改动合起来，而那要求撤销栈
// 参与存盘。共用同一个对象就没有这个问题——左边加进去的那一笔本来就已经在右边的层
// 里了，右边只需要重画一次。
//
// 这里测的是那套共用规则本身，不碰 IndexedDB。

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

const {
  shareLayer, releaseLayer, notifyPeers, holderCount, resetSharedInk,
} = await import('../src/ink/ink-shared.js');
const { InkLayer } = await import('../src/ink/ink-layer.js');
const { INK_TOOLS, appendPoint, createStroke } = await import('../src/ink/stroke.js');

/** 一层带 n 笔的层。 */
function layerOf(n) {
  const layer = new InkLayer();
  for (let i = 0; i < n; i++) {
    const s = createStroke({ tool: INK_TOOLS.PEN });
    appendPoint(s, i * 10, 0, 0.5, 0);
    appendPoint(s, i * 10 + 5, 5, 0.5, 0);
    layer.add(s);
  }
  return layer;
}

const LEFT = { name: 'left' };
const RIGHT = { name: 'right' };

// ═══════════════════════════════════════════════════════════════
group('1. 同一页只有一份');

test('第二个来的人拿到的是第一个人那一份', () => {
  resetSharedInk();
  const mine = layerOf(2);
  const theirs = layerOf(2);
  const a = shareLayer('doc', 7, mine, LEFT);
  const b = shareLayer('doc', 7, theirs, RIGHT);
  assert.equal(a, mine, '第一个人的那份成了大家的那份');
  assert.equal(b, mine, '第二个人读出来的副本被丢掉了');
  assert.notEqual(b, theirs);
});

test('那一笔加进去，另一栏手里立刻就有', () => {
  // 这就是「不丢更新」的全部：不是合并合出来的，是本来就是同一个对象。
  resetSharedInk();
  const shared = shareLayer('doc', 7, layerOf(2), LEFT);
  shareLayer('doc', 7, layerOf(2), RIGHT);
  const s = createStroke({ tool: INK_TOOLS.PEN });
  appendPoint(s, 1, 1, 0.5, 0);
  shared.add(s);
  assert.equal(shared.getAll().length, 3);
});

test('不同页互不相干', () => {
  resetSharedInk();
  const p7 = shareLayer('doc', 7, layerOf(1), LEFT);
  const p8 = shareLayer('doc', 8, layerOf(1), RIGHT);
  assert.notEqual(p7, p8);
});

test('不同文件的同一页也互不相干', () => {
  resetSharedInk();
  const a = shareLayer('bookA', 7, layerOf(1), LEFT);
  const b = shareLayer('bookB', 7, layerOf(1), RIGHT);
  assert.notEqual(a, b);
});

// ═══════════════════════════════════════════════════════════════
group('2. 谁先走不该决定这一页还在不在');

test('一个人走了，另一个人手里那份还算数', () => {
  resetSharedInk();
  const shared = shareLayer('doc', 7, layerOf(2), LEFT);
  shareLayer('doc', 7, layerOf(2), RIGHT);
  assert.equal(holderCount('doc', 7), 2);

  releaseLayer('doc', 7, LEFT);
  assert.equal(holderCount('doc', 7), 1);
  // 还是同一个对象——没有因为左边翻走就换一份
  assert.equal(shareLayer('doc', 7, layerOf(9), { name: 'third' }), shared);
});

test('最后一个人走了才撤掉', () => {
  resetSharedInk();
  shareLayer('doc', 7, layerOf(2), LEFT);
  shareLayer('doc', 7, layerOf(2), RIGHT);
  releaseLayer('doc', 7, LEFT);
  releaseLayer('doc', 7, RIGHT);
  assert.equal(holderCount('doc', 7), 0);

  // 下一次来的人，读出来的那份就是大家的那份
  const fresh = layerOf(5);
  assert.equal(shareLayer('doc', 7, fresh, LEFT), fresh);
});

test('同一个人说两遍不会算成两个人', () => {
  resetSharedInk();
  shareLayer('doc', 7, layerOf(1), LEFT);
  shareLayer('doc', 7, layerOf(1), LEFT);
  assert.equal(holderCount('doc', 7), 1);
  releaseLayer('doc', 7, LEFT);
  assert.equal(holderCount('doc', 7), 0, '一次归还就该走干净');
});

test('没人拿过的页，归还不炸', () => {
  resetSharedInk();
  releaseLayer('doc', 99, LEFT);
  assert.equal(holderCount('doc', 99), 0);
});

// ═══════════════════════════════════════════════════════════════
group('3. 改了就叫另一栏重画');

test('只叫别人，不叫自己', () => {
  // 改的那一方早就画过了，再叫一次是白画一帧。
  resetSharedInk();
  const seen = [];
  shareLayer('doc', 7, layerOf(1), LEFT, () => seen.push('left'));
  shareLayer('doc', 7, layerOf(1), RIGHT, () => seen.push('right'));

  assert.equal(notifyPeers('doc', 7, LEFT), 1);
  assert.deepEqual(seen, ['right']);
});

test('只有一个人看这一页时，谁也不用叫', () => {
  resetSharedInk();
  const seen = [];
  shareLayer('doc', 7, layerOf(1), LEFT, () => seen.push('left'));
  assert.equal(notifyPeers('doc', 7, LEFT), 0);
  assert.deepEqual(seen, []);
});

test('走了的人不会再被叫', () => {
  resetSharedInk();
  const seen = [];
  shareLayer('doc', 7, layerOf(1), LEFT, () => seen.push('left'));
  shareLayer('doc', 7, layerOf(1), RIGHT, () => seen.push('right'));
  releaseLayer('doc', 7, RIGHT);
  assert.equal(notifyPeers('doc', 7, LEFT), 0);
});

test('一个人重画时炸了，不该拖住其他人', () => {
  resetSharedInk();
  const seen = [];
  shareLayer('doc', 7, layerOf(1), LEFT, () => { throw new Error('炸了'); });
  shareLayer('doc', 7, layerOf(1), RIGHT, () => seen.push('right'));
  const third = { name: 'third' };
  shareLayer('doc', 7, layerOf(1), third, () => seen.push('third'));
  notifyPeers('doc', 7, third);
  assert.deepEqual(seen, ['right']);
});

// ═══════════════════════════════════════════════════════════════
group('4. 分栏真的接上了这套规则');

const { readFileSync } = await import('node:fs');
const $read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf-8');

test('装层都过登记处，离开都归还', () => {
  const src = $read('src/pdf/pdf-pane.js');
  assert.equal((src.match(/this\._takeInk\(/g) || []).length, 2,
    '换页和开文档两条路都要过登记处');
  assert.ok((src.match(/this\._dropInk\(/g) || []).length >= 4,
    '换页、卸载、换书、半路作废的那次打开，四条路都要归还');
  assert.ok(!/const layer = await loadLayer\(/.test(src),
    '不能再有绕过登记处直接装的路');
});

test('一笔下去就叫另一栏，不等那 400ms 的落盘', () => {
  // 落盘可以攒着写，重画不能：人一笔下去，另一边要立刻看见。
  const src = $read('src/pdf/pdf-pane.js');
  const fn = src.slice(src.indexOf('_scheduleInkSave() {'));
  const body = fn.slice(0, fn.indexOf('_takeInk('));
  const notifyAt = body.indexOf('notifyPeers');
  const timerAt = body.indexOf('setTimeout');
  assert.ok(notifyAt > 0, '改动要通知同看这一页的另一栏');
  assert.ok(notifyAt < timerAt, '通知在前，落盘的定时器在后');
});

test('草稿纸也接上了——同一本可以同时开在两栏', () => {
  // 草稿纸走的是同一个 ink-store（pad.id 当文件 id，页恒为 SCRATCH_PAGE），所以
  // 同一本开在两栏时是同一个毛病：两份副本各自盲写，后写的把先写的整个盖掉。
  const src = $read('src/scratch/scratch-pane.js');
  assert.ok(src.includes("from '../ink/ink-shared.js'"), '要接登记处');
  assert.ok(src.includes('this._takeInk(pad.id, await this._store.loadLayer('),
    '读出来的那一份要过登记处');
  assert.ok((src.match(/this[.]_dropInk[(]/g) || []).length >= 3,
    '换本、半路作废、卸载，三条路都要归还');
  const changed = src.slice(src.indexOf('_inkChanged() {'));
  const notifyAt = changed.indexOf('notifyPeers');
  const revAt = changed.indexOf('_inkRevision += 1');
  assert.ok(notifyAt > 0 && notifyAt < revAt, '一笔下去先叫另一栏，再去数版本');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(failed ? 1 : 0);
