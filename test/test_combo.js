#!/usr/bin/env node
// 组合：一套「书是怎么摆的」。
//
// 这个文件盯的是整个设计里唯一容易做错、而且做错了当场看不出来的那件事：
//
//   **组合不存页码。**
//
// 人保存组合的那一刻手上的书停在第 42 页；两天后他用这个组合把书开回来，要的
// 是「我上次读到哪儿」，不是「我保存那天读到哪儿」。页码属于书，不属于摆法，
// 而 document-session 已经替每份资源记着它。组合里再存一份，就是同一个问题的
// 第二个答案——两个答案迟早不一样，而到那时人只会看到「这个组合开出来的页码是
// 错的」。
//
// 所以这里有一条断言是对**序列化结果本身**做的：组合落盘之后，里面不该出现任
// 何页码字段。往里加字段很容易，删掉很难。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'localStorage']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}

const {
  COMBO_LIMITS, comboFacing, comboFromWorkspace, comboResourceIds, comboSize,
  createCombo, deserializeCombo, pruneCombo, serializeCombo,
} = await import('../src/pdf/combo-state.js');
const {
  COMBO_ERRORS, COMBO_MAX, clearCombos, deleteCombo, getCombo, listCombos,
  renameCombo, replaceCombo, saveCombo,
} = await import('../src/pdf/combo-store.js');
const { createWorkspaceState, ORIENTATIONS, SLOTS } = await import('../src/pdf/workspace-state.js');
const { ENTRY_KINDS, createEntry } = await import('../src/pdf/deck-state.js');

/** 一个两栏都摆着书的工作区，左栏两本、开着第二本。 */
function workspace(extra = {}) {
  const left = [
    createEntry({ kind: ENTRY_KINDS.PDF, resourceId: 'doc-xie' }),
    createEntry({ kind: ENTRY_KINDS.PDF, resourceId: 'doc-pei' }),
  ];
  const right = [createEntry({ kind: ENTRY_KINDS.NOTE, resourceId: 'note-1' })];
  return createWorkspaceState({
    decks: {
      [SLOTS.PRIMARY]: { entries: left, activeId: left[1].id },
      [SLOTS.SECONDARY]: { entries: right, activeId: right[0].id },
    },
    dividerRatio: 0.38,
    orientation: ORIENTATIONS.ROW,
    swapped: true,
    ...extra,
  });
}

// ═══════════════════════════════════════════════════════════════
group('1. 组合不存页码');

test('落盘的结构里没有任何页码字段', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c1', name: '数分对照', now: 100 });
  const text = JSON.stringify(serializeCombo(combo));
  for (const word of ['page', 'Page', 'zoom', 'scroll', 'offset']) {
    assert.ok(!text.includes(word),
      `序列化里出现了「${word}」。页码属于书不属于摆法，存了它，组合打开的就是保存那天那一页`);
  }
});

test('拍快照时工作区上的页码一个都没被读走', () => {
  // 摞里塞一个带页码的字段：真实的工作区状态里没有它，但如果哪天有人把视图并进
  // 来，这一条会当场红。
  const state = workspace();
  const withPages = {
    ...state,
    decks: {
      ...state.decks,
      [SLOTS.PRIMARY]: {
        ...state.decks[SLOTS.PRIMARY],
        entries: state.decks[SLOTS.PRIMARY].entries.map((e) => ({ ...e, pageNumber: 42 })),
      },
    },
  };
  const combo = comboFromWorkspace(withPages, { id: 'c', name: 'n', now: 1 });
  const first = combo.slots[SLOTS.PRIMARY].entries[0];
  assert.deepEqual(Object.keys(first).sort(), ['kind', 'resourceId'],
    '一本书在组合里只该有类型和身份两样东西');
});

// ═══════════════════════════════════════════════════════════════
group('2. 拍快照');

test('两栏的书、顺序、各自开着第几本都在', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c1', name: '数分对照', now: 100 });
  assert.equal(combo.name, '数分对照');
  assert.deepEqual(
    combo.slots[SLOTS.PRIMARY].entries.map((e) => e.resourceId),
    ['doc-xie', 'doc-pei'],
  );
  assert.equal(combo.slots[SLOTS.PRIMARY].active, 1, '左栏开着的是第二本');
  assert.equal(combo.slots[SLOTS.SECONDARY].entries[0].kind, ENTRY_KINDS.NOTE);
});

test('活动项存的是下标，不是条目 id', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c1', name: 'n', now: 1 });
  assert.equal(typeof combo.slots[SLOTS.PRIMARY].active, 'number',
    '条目 id 是这一次会话里的身份，用组合开出来的是一批新条目，旧 id 指不到任何东西');
});

test('分栏比例、横竖、左右对调都跟着走', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c1', name: 'n', now: 1 });
  assert.equal(combo.dividerRatio, 0.38);
  assert.equal(combo.orientation, ORIENTATIONS.ROW);
  assert.equal(combo.swapped, true);
});

test('某一栏收起来的时候，存的是展开之后该多宽', () => {
  // 收起来时 dividerRatio 是 0 或 1，那个位置本身就是「收起」的意思。照存的话，
  // 这个组合一打开就把半个屏幕藏起来——而人保存它的时候看到的是两栏。
  const collapsed = createWorkspaceState({
    ...workspace(),
    dividerRatio: 1,
    collapsedSlot: SLOTS.SECONDARY,
    restoreRatio: 0.45,
  });
  const combo = comboFromWorkspace(collapsed, { id: 'c', name: 'n', now: 1 });
  assert.equal(combo.dividerRatio, 0.45);
});

// ═══════════════════════════════════════════════════════════════
group('3. 读取与修剪');

test('用到的资源，去重、左栏在前', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c', name: 'n', now: 1 });
  assert.deepEqual(comboResourceIds(combo), ['doc-xie', 'doc-pei', 'note-1']);
});

test('缩略图要画的是两栏各自开着的那一本', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c', name: 'n', now: 1 });
  const facing = comboFacing(combo);
  assert.equal(facing[SLOTS.PRIMARY].resourceId, 'doc-pei', '左栏开着的是第二本');
  assert.equal(facing[SLOTS.SECONDARY].resourceId, 'note-1');
});

test('书被删了就从组合里摘掉，活动项落回这一栏的第一本', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c', name: 'n', now: 1 });
  const { combo: after, changed } = pruneCombo(combo, (id) => id !== 'doc-pei');
  assert.equal(changed, true);
  assert.deepEqual(after.slots[SLOTS.PRIMARY].entries.map((e) => e.resourceId), ['doc-xie']);
  assert.equal(after.slots[SLOTS.PRIMARY].active, 0,
    '原来开着的那本被删了，落回第一本，而不是把这一栏变成空的');
});

test('一本都不剩时 size 是 0，由调用方决定删不删', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c', name: 'n', now: 1 });
  const { combo: after } = pruneCombo(combo, () => false);
  assert.equal(comboSize(after), 0);
});

test('什么都没删就回原来那一个，不白做一次拷贝', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c', name: 'n', now: 1 });
  const { combo: after, changed } = pruneCombo(combo, () => true);
  assert.equal(changed, false);
  assert.equal(after, combo);
});

// ═══════════════════════════════════════════════════════════════
group('4. 坏数据不该把书架弄崩');

test('没有 resourceId 的条目直接丢掉', () => {
  const combo = createCombo({
    id: 'c', name: 'n',
    slots: { a: { entries: [{ kind: 'pdf' }, { kind: 'pdf', resourceId: 'ok' }], active: 0 } },
  });
  assert.deepEqual(combo.slots.a.entries.map((e) => e.resourceId), ['ok']);
});

test('认不出的类型当 PDF，而不是让整个组合打不开', () => {
  const combo = createCombo({
    id: 'c', name: 'n',
    slots: { a: { entries: [{ kind: '外星人', resourceId: 'x' }], active: 0 } },
  });
  assert.equal(combo.slots.a.entries[0].kind, ENTRY_KINDS.PDF);
});

test('空栏的活动项是 -1，不是 0', () => {
  const combo = createCombo({ id: 'c', name: 'n', slots: {} });
  assert.equal(combo.slots.a.active, -1, '「这一栏是空的」和「这一栏开着第一本」是两回事');
  assert.equal(comboFacing(combo).a, null);
});

test('名字过长就截断', () => {
  const combo = createCombo({ id: 'c', name: 'x'.repeat(200), slots: {} });
  assert.equal(combo.name.length, COMBO_LIMITS.NAME);
});

test('存进去再读出来还是同一套摆法', () => {
  const combo = comboFromWorkspace(workspace(), { id: 'c', name: '数分对照', now: 7 });
  assert.deepEqual(deserializeCombo(serializeCombo(combo)), combo);
});

// ═══════════════════════════════════════════════════════════════
group('5. 存哪儿');

test('存了能列出来，新的在前', () => {
  clearCombos();
  const one = comboFromWorkspace(workspace(), { id: '', name: '甲', now: 1 });
  saveCombo({ ...one, name: '甲' });
  saveCombo({ ...one, name: '乙' });
  const list = listCombos();
  assert.equal(list.length, 2);
  assert.ok(list.every((c) => c.id), '每个组合都得有自己的身份');
});

test('改名不动摆法', () => {
  clearCombos();
  const saved = saveCombo({ ...comboFromWorkspace(workspace(), { name: 'x', now: 1 }), name: '旧名' });
  const after = renameCombo(saved.id, '新名');
  assert.equal(after.name, '新名');
  assert.deepEqual(
    after.slots.a.entries.map((e) => e.resourceId),
    saved.slots.a.entries.map((e) => e.resourceId),
  );
});

test('删掉就查不到了', () => {
  clearCombos();
  const saved = saveCombo({ ...comboFromWorkspace(workspace(), { name: 'x', now: 1 }), name: 'x' });
  assert.equal(deleteCombo(saved.id), true);
  assert.equal(getCombo(saved.id), null);
  assert.equal(deleteCombo(saved.id), false, '删第二次要说「没这个」，而不是假装删了');
});

test('一本书都没有的组合存不进去', () => {
  clearCombos();
  assert.throws(
    () => saveCombo({ name: '空的', slots: {} }),
    (e) => e.message === COMBO_ERRORS.EMPTY,
  );
});

test('到上限就说一句，而不是悄悄顶掉最旧的那个', () => {
  clearCombos();
  const one = comboFromWorkspace(workspace(), { name: 'x', now: 1 });
  for (let i = 0; i < COMBO_MAX; i++) saveCombo({ ...one, name: `第${i}个` });
  assert.throws(
    () => saveCombo({ ...one, name: '再来一个' }),
    (e) => e.message === COMBO_ERRORS.FULL,
    '悄悄顶掉最旧的那个，等于替人做了一个他没同意的删除',
  );
});

test('修剪空了就整条删掉', () => {
  clearCombos();
  const saved = saveCombo({ ...comboFromWorkspace(workspace(), { name: 'x', now: 1 }), name: 'x' });
  const { combo: emptied } = pruneCombo(saved, () => false);
  replaceCombo({ ...emptied, id: saved.id });
  assert.equal(getCombo(saved.id), null,
    '一本书都没有的组合点开什么也不会发生，留着只是在架子上占一格并让人以为它坏了');
});

// ═══════════════════════════════════════════════════════════════
group('6. 换过去之前，先把被盖掉的那两本记下来');

// 这一条盯的是顺序，而顺序在源码里。applyCombo 必须先 _rememberSlotView 再
// unload：反过来的话，unload 会把窗格的视图状态丢掉，而那正是这本书该记住的
// 那一页——人用组合换过去再换回来，书会退到更早的某一页，而他什么都没做错。
const wsSrc = readFileSync(new URL('../src/pdf/pdf-workspace.js', import.meta.url), 'utf-8');
const applyBody = wsSrc.slice(
  wsSrc.indexOf('async applyCombo('),
  wsSrc.indexOf('/** Files the pane'),
);

test('applyCombo 里先记页码，后卸窗格', () => {
  const remember = applyBody.indexOf('_rememberSlotView');
  const unload = applyBody.indexOf('unload()');
  assert.ok(remember > 0 && unload > 0, '两件事都得在 applyCombo 里发生');
  assert.ok(remember < unload,
    'unload 会把窗格的视图状态丢掉，而那正是这本书该记住的那一页');
});

test('开新书时不指定视图，让它自己去问最后读到哪一页', () => {
  assert.ok(/showEntry\(slot, entry\.id, \{ force: true \}\)/.test(applyBody),
    '传了 restoredView 就等于又把页码钉死了一次；不传，showEntry 会去问 recallDocView');
});

test('拍快照之前也要记一次', () => {
  const snap = wsSrc.slice(wsSrc.indexOf('snapshotCombo('), wsSrc.indexOf('async applyCombo('));
  assert.ok(snap.includes('_rememberSlotView'),
    '不记的话，刚存完就用的组合会把书开回上一次落盘时那一页，而人刚看着屏幕按了保存');
});

// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
