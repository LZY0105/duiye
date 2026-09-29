#!/usr/bin/env node
// 「全部关闭」：一下关掉两栏里开着的全部。
//
// 盯的是两件做错了当场看不出来的事：
//
//   **一、没存的笔迹不能跟着关掉。** 正显示着的草稿纸可能有几笔还没落盘；逐个
//   「移出本栏」会先存，一下全关也得先存。存不进去就一份都不关——关掉一半、剩下
//   那一半挂着一份没存进去的笔迹，是最难收拾的那种半截状态。
//
//   **二、关的是整摞，不只是露在外面的那两份。** 一栏里压着三本，只关掉最上面那
//   本，人会看见下面那本冒出来，以为按钮没起作用。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'localStorage']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}

const { createWorkspaceState, openInSlot, SLOTS } = await import('../src/pdf/workspace-state.js');
const { ENTRY_KINDS } = await import('../src/pdf/deck-state.js');
const { PdfWorkspace } = await import('../src/pdf/pdf-workspace.js');
const { initI18n } = await import('../src/core/i18n.js');
await initI18n();

const $read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf-8');

/** 左栏一摞三份（新开的压在最上面：草稿纸、答案、谢惠民），右栏一本书。 */
function busyState(extra = {}) {
  let s = createWorkspaceState();
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: '谢惠民' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { resourceId: '答案' }).state;
  s = openInSlot(s, SLOTS.PRIMARY, { kind: ENTRY_KINDS.SCRATCH, resourceId: '草稿' }).state;
  s = openInSlot(s, SLOTS.SECONDARY, { resourceId: '数分' }).state;
  return { ...s, ...extra };
}

/** 把 DOM 那几片叶子桩掉、事务留真的工作区；每一步做了什么记在 log 里。 */
function workspaceWith(state, views = {}) {
  const ws = Object.create(PdfWorkspace.prototype);
  const log = [];
  Object.assign(ws, {
    state,
    log,
    agentTarget: null,
    viewFor: (slot) => views[slot] || null,
    describeEntry: (slot, entry) => ({ name: entry.resourceId }),
    _setStatus: (slot, message) => log.push(`status:${slot}:${message}`),
    _rememberSlotView: (slot) => log.push(`remember:${slot}`),
    _closeAgentPanel: () => log.push('agent-closed'),
    _setState(next) { log.push('clear'); this.state = next; },
    _unloadSlot: (slot) => log.push(`unload:${slot}`),
    _layout() {}, _resizePanes() {},
    _persist: () => log.push('persist'),
    _syncSlotChrome() {},
  });
  return ws;
}

const deckOf = (ws, slot) => ws.state.decks[slot].entries.map(e => e.resourceId);

// ═══════════════════════════════════════════════════════════════
group('关的是什么');

await test('两栏都关，每一栏的整摞都关——不只是露在外面的那一份', async () => {
  const ws = workspaceWith(busyState());
  assert.deepEqual(deckOf(ws, SLOTS.PRIMARY), ['草稿', '答案', '谢惠民']);
  assert.equal(await ws.closeAll(), true);
  assert.deepEqual(deckOf(ws, SLOTS.PRIMARY), [], '压在下面的两本也关了');
  assert.deepEqual(deckOf(ws, SLOTS.SECONDARY), []);
  assert.ok(ws.log.includes(`unload:${SLOTS.PRIMARY}`) && ws.log.includes(`unload:${SLOTS.SECONDARY}`),
    '两个窗格都卸了');
  assert.ok(ws.log.includes('persist'), '关完落盘——下次开机不该又把它们开回来');
});

await test('收起的那一栏、专注模式一起放开：桌上什么都不剩，没有哪一栏该还收着', async () => {
  const ws = workspaceWith(busyState({
    collapsedSlot: SLOTS.SECONDARY,
    restoreRatio: 0.5,
    focusedSlot: SLOTS.PRIMARY,
  }));
  await ws.closeAll();
  assert.equal(ws.state.collapsedSlot, null);
  assert.equal(ws.state.focusedSlot, null);
});

await test('两栏都空着：什么都不做', async () => {
  const ws = workspaceWith(createWorkspaceState());
  assert.equal(await ws.closeAll(), false);
  assert.deepEqual(ws.log, []);
});

// ═══════════════════════════════════════════════════════════════
group('先存，再关');

await test('露在外面的草稿纸先落盘，存好了才关', async () => {
  const pad = { flush: async () => { pad.flushed = true; ws.log.push('flush'); return true; } };
  const ws = workspaceWith(busyState(), { [SLOTS.PRIMARY]: pad });
  await ws.closeAll();
  assert.ok(pad.flushed);
  assert.ok(ws.log.indexOf('flush') < ws.log.indexOf('clear'), '存在前，关在后');
});

await test('书记下停在哪一页再走', async () => {
  const book = { isLoaded: () => true };
  const ws = workspaceWith(busyState(), { [SLOTS.SECONDARY]: book });
  await ws.closeAll();
  assert.ok(ws.log.includes(`remember:${SLOTS.SECONDARY}`), '下次打开还回到这一页');
  assert.ok(ws.log.indexOf(`remember:${SLOTS.SECONDARY}`) < ws.log.indexOf('clear'));
});

await test('有一份存不进去：一份都不关，并且说出来', async () => {
  const pad = { flush: async () => false };
  const ws = workspaceWith(busyState(), { [SLOTS.PRIMARY]: pad });
  assert.equal(await ws.closeAll(), false);
  assert.deepEqual(deckOf(ws, SLOTS.PRIMARY), ['草稿', '答案', '谢惠民'], '左栏原样');
  assert.deepEqual(deckOf(ws, SLOTS.SECONDARY), ['数分'], '右栏也原样——关掉一半比一份不关更糟');
  assert.ok(ws.log.some(l => l.startsWith(`status:${SLOTS.PRIMARY}:`)), '存不进去要说');
  assert.ok(!ws.log.includes('clear'));
});

await test('Agent 正开着看其中一栏：一起合上', async () => {
  const ws = workspaceWith(busyState());
  ws.agentTarget = { slot: SLOTS.SECONDARY };
  await ws.closeAll();
  assert.ok(ws.log.includes('agent-closed'));
});

// ═══════════════════════════════════════════════════════════════
group('问话里列的是谁');

await test('按屏幕上的先后列：左右对调过，右边那一摞排在后面', async () => {
  const ws = workspaceWith(busyState({ swapped: false }));
  assert.deepEqual(ws.openEntries().map(e => e.name), ['草稿', '答案', '谢惠民', '数分']);
  const swapped = workspaceWith(busyState({ swapped: true }));
  assert.deepEqual(swapped.openEntries().map(e => e.name), ['数分', '草稿', '答案', '谢惠民'],
    '对调之后 SECONDARY 画在左边');
});

await test('横杠上有这颗按钮，三种语言都有它的字', async () => {
  const html = $read('index.html');
  assert.ok(/data-role="close-all"[^>]*data-i18n="pdf\.closeAll"/.test(html));
  for (const lang of ['zh-CN', 'zh-TW', 'en']) {
    const pack = $read(`src/core/lang/${lang}.js`);
    for (const key of ['pdf.closeAll', 'pdf.closeAllTitle', 'pdf.closeAllBody', 'pdf.closeAllNone', 'pdf.closedAll']) {
      assert.ok(pack.includes(`"${key}"`), `${lang} 少了 ${key}`);
    }
  }
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const fn = ui.slice(ui.indexOf('async function closeAllOpen'));
  assert.ok(fn.indexOf('confirmDestructive') > -1
    && fn.indexOf('confirmDestructive') < fn.indexOf('workspace.closeAll()'),
    '先问，再关');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
