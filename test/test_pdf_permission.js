#!/usr/bin/env node
// 导入时那个权限，是主动问出来的。
//
// 列出全机的 PDF 要「所有文件访问权限」。这个权限没有应用内的系统弹窗可用——
// Android 只允许把人送到设置里那一页。所以「找系统要」这一步只能是「把那一页打
// 开」，而在那之前必须自己先说清楚为什么要。
//
// 原来是先摊开面板、再在空面板里放一行「需要权限」。那等于先把人领进一间空屋
// 子，再告诉他门没开——而一张空面板看着更像「这台机器上没有 PDF」。
//
// 这里钉五样：
//   1. 有权限就什么都不弹，直接走。多问一句都是打扰。
//   2. 没权限就弹，而且是在面板**之前**弹。
//   3. 「去设置里打开」真的会去开那一页；回到前台会自己再看一眼，给了就继续。
//   4. 从设置回来还是没给，就再摆一次那张单子，不是卡住也不是默默失败。
//   5. 永远不把人堵死：那张单子上一直有「这次用系统选择器」，不给这个权限的人照
//      样导得进东西。

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
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}

/** jsdom 的 visibilityState 是只读的，而这条路全靠它。 */
let visibility = 'visible';
Object.defineProperty(dom.window.document, 'visibilityState', {
  get: () => visibility,
  configurable: true,
});

const { initI18n, setLang } = await import('../src/core/i18n.js');
await initI18n();
await setLang('zh-CN');

const { PERMISSION, ensureFilesPermission } = await import('../src/pdf/pdf-picker.js');

/**
 * 装一个原生插件。
 *
 * `granted` 是一个函数而不是一个值：这条路的全部意思就是「那个值会在人离开应用
 * 期间变」，用常量测不出任何东西。
 */
function install({ granted, onRequest }) {
  const calls = { has: 0, request: 0 };
  dom.window.Capacitor = {
    Plugins: {
      PdfFiles: {
        async hasPermission() {
          calls.has += 1;
          return { granted: granted(calls.has) };
        },
        async requestPermission() {
          calls.request += 1;
          if (onRequest) return onRequest(calls.request);
          return { opened: true };
        },
      },
    },
  };
  return calls;
}

/** 现在屏幕上摆着的那张单子。 */
const sheet = () => dom.window.document.querySelector('.deck-overlay');

/** 单子上那几颗按钮的字。 */
const labels = () => [...dom.window.document.querySelectorAll('.deck-overlay button')]
  .map(b => b.textContent.trim());

/** 按标题里带某几个字的那一颗。 */
function press(text) {
  const button = [...dom.window.document.querySelectorAll('.deck-overlay button')]
    .find(b => b.textContent.includes(text));
  assert.ok(button, `单子上没有「${text}」这一颗，只有：${labels().join(' / ')}`);
  button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

/** 等那张单子被摆上来。它是在一个 await 之后建的，所以得让出去几轮。 */
async function untilSheet() {
  for (let i = 0; i < 50; i++) {
    if (sheet()) return sheet();
    await new Promise(r => setTimeout(r, 0));
  }
  throw new Error('等不到那张单子');
}

/**
 * 从设置里回来。
 *
 * 要先让出去几轮：按下「去设置里打开」之后，代码还要走完 requestPermission 才装上
 * 那个 visibilitychange 监听。装上之前把事件发出去，等于没发。
 */
async function returnFromSettings() {
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  comeBack();
}

/** 假装人切出去又切回来。 */
function comeBack() {
  visibility = 'hidden';
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  visibility = 'visible';
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
}

function reset() {
  dom.window.document.body.innerHTML = '';
  visibility = 'visible';
}

// ═══════════════════════════════════════════════════════════════
group('1. 有权限就什么都不弹');

await test('直接就是 granted', async () => {
  reset();
  install({ granted: () => true });
  const result = await ensureFilesPermission();
  assert.equal(result, PERMISSION.GRANTED);
  assert.equal(sheet(), null, '已经有权限还弹一张单子，是纯粹的打扰');
});

// ═══════════════════════════════════════════════════════════════
group('2. 没权限就主动弹');

await test('单子上写着为什么要，也写着怎么给', async () => {
  reset();
  install({ granted: () => false });
  const pending = ensureFilesPermission();
  await untilSheet();

  const text = sheet().textContent;
  press('取消');
  assert.equal(await pending, PERMISSION.CANCELLED);

  assert.ok(text.includes('所有文件访问权限'), '得说清楚要的是哪个权限');
  assert.ok(text.includes('系统设置') || text.includes('设置'),
    '得说清楚它只能在系统设置里开——不然人会以为应用自己不肯弹窗');
});

await test('「去设置里打开」真的去开那一页', async () => {
  reset();
  const calls = install({ granted: (n) => n > 1 });
  const pending = ensureFilesPermission();
  await untilSheet();
  press('去设置里打开');
  await returnFromSettings();
  assert.equal(await pending, PERMISSION.GRANTED);
  assert.equal(calls.request, 1, '没有把人送到那一页去');
});

// ═══════════════════════════════════════════════════════════════
group('3. 回到前台自己再看一眼');

await test('在设置里开了，回来就继续', async () => {
  reset();
  // 第一次问是「点导入的那一刻」，还没给；去设置之后回来那次才给。
  let grantedNow = false;
  install({ granted: () => grantedNow, onRequest: () => { grantedNow = true; return { opened: true }; } });
  const pending = ensureFilesPermission();
  await untilSheet();
  press('去设置里打开');
  await returnFromSettings();
  assert.equal(await pending, PERMISSION.GRANTED);
});

await test('跳去设置那一刻会说一句「回来就接着走」', async () => {
  reset();
  let said = null;
  install({ granted: (n) => n > 1 });
  const pending = ensureFilesPermission({ onWaiting: () => { said = true; } });
  await untilSheet();
  press('去设置里打开');
  await returnFromSettings();
  await pending;
  assert.equal(said, true, '不说的话，人从设置回来会以为刚才那一下没生效');
});

await test('回来还是没给，就再摆一次，而不是卡住', async () => {
  reset();
  install({ granted: () => false });
  const pending = ensureFilesPermission();
  await untilSheet();
  press('去设置里打开');
  await returnFromSettings();
  await untilSheet();
  const again = !!sheet();
  press('取消');
  assert.equal(await pending, PERMISSION.CANCELLED);
  assert.ok(again, '第二次没摆出来的话，人就站在原地不知道发生了什么');
});

// ═══════════════════════════════════════════════════════════════
group('4. 永远给得出一条退路');

await test('「这次用系统选择器」回 fallback', async () => {
  reset();
  install({ granted: () => false });
  const pending = ensureFilesPermission();
  await untilSheet();
  const shown = labels();
  press('系统选择器');
  assert.equal(await pending, PERMISSION.FALLBACK);
  assert.ok(shown.some(l => l.includes('系统选择器')),
    '不给这个权限的人得有别的路可走，不然导入这件事对他就是坏的');
});

await test('这台机器上没有那一页设置时，说出来而不是假装打开了', async () => {
  reset();
  install({
    granted: () => false,
    onRequest: () => { throw new Error('NO_SETTINGS_PAGE'); },
  });
  const pending = ensureFilesPermission();
  await untilSheet();
  press('去设置里打开');
  assert.equal(await pending, PERMISSION.NO_SETTINGS_PAGE);
});

// ═══════════════════════════════════════════════════════════════
group('5. 同时叫两次只弹一张');

await test('两个调用共用同一次询问', async () => {
  reset();
  install({ granted: () => false });
  const a = ensureFilesPermission();
  const b = ensureFilesPermission();
  await untilSheet();
  const count = dom.window.document.querySelectorAll('.deck-overlay').length;
  press('取消');
  assert.deepEqual([await a, await b], [PERMISSION.CANCELLED, PERMISSION.CANCELLED]);
  assert.equal(count, 1, '人在设置里的时候又点了一下导入，不该叠出第二张单子');
});

await test('问完之后锁放开，下一次还能再问', async () => {
  reset();
  install({ granted: () => false });
  const first = ensureFilesPermission();
  await untilSheet();
  press('取消');
  await first;

  reset();
  const second = ensureFilesPermission();
  const back = await untilSheet().catch(() => null);
  if (back) press('取消');
  await Promise.race([second, new Promise(r => setTimeout(r, 200))]);
  assert.ok(back, '锁没放开的话，第二次点导入就什么都不会发生');
});

// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
