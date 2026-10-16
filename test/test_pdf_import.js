#!/usr/bin/env node
// 导入：大文件不崩、可以多选。
//
// 人报「导入文件时软件会崩溃」。机上复现：读一份 315 兆的书，原生那边一次 read() 把整份读进内存、编成
// base64 过桥，缓冲翻倍扩到 512 兆，正撞上这台平板给应用的堆上限——OutOfMemoryError（不是
// Exception，catch 接不住），am_crash，整个应用没了。现在先走 Capacitor 的本地网址流式读（机上 315 兆
// 1.6 秒），走不通再一块一块地过桥（同一本 26 秒），哪条路桥上、Java 那边都不会有整份。
//
// 人又说「导入文件时要允许用户多选」。以前故意只收一份（一份一问角色、第三份失败前两份已经进去了说不
// 清），现在：角色一批问一次，一份一份读、一份一份导，失败的跳过，最后一句话说清楚。
//
// 这里钉：
//   1. readDevicePdf 一块一块地要，拼回来的字节和原文件一模一样；不再调整份的 read()；出错时把流关掉。
//   1b. 先走本地网址：字节一样、不过桥；404、连不上、半路断、长度对不上、空的、放不下，都退回一块一块地读。
//   2. 应用内那张单子能多选：勾几份、按钮写「导入 N 份」、按勾的先后回来；再点一下取消勾。
//   3. 原生插件：没有整份读进内存的那条路了，读一块时连 OutOfMemoryError 也接住。
//   4. 导入流程：角色问一次、一份一份来（不是一起读进来）、存储满了停下；系统选择器也能多选。

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
const $read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event', 'MouseEvent',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}

const { initI18n, setLang } = await import('../src/core/i18n.js');
await initI18n();
await setLang('zh-CN');

const { readDevicePdf, FILES_ERRORS } = await import('../src/pdf/pdf-files.js');
const { openDevicePdfPicker } = await import('../src/pdf/pdf-picker.js');

/** 一份假 PDF：前面是 %PDF-，后面是按位置算出来的字节，好比对。 */
function fakePdf(size) {
  const bytes = new Uint8Array(size);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  for (let i = 5; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

/** 装一个按块读的原生插件。reportedSize 是 openRead 报的大小（-1 是问不出）；failAt 是第几块出错。 */
function installReader(source, { reportedSize = source.length, failAt = -1, chunk = 3 << 20 } = {}) {
  const calls = { open: 0, chunks: 0, close: 0, wholeRead: 0 };
  let at = 0;
  dom.window.Capacitor = {
    Plugins: {
      PdfFiles: {
        async read() { calls.wholeRead++; throw new Error('整份读的那条路不该再走'); },
        async openRead({ uri }) {
          calls.open++;
          assert.equal(uri, 'content://media/external/file/1');
          at = 0;
          return { token: 't1', size: reportedSize };
        },
        async readChunk({ token }) {
          assert.equal(token, 't1');
          calls.chunks++;
          if (calls.chunks === failAt) throw new Error('READ_FAILED');
          const end = Math.min(source.length, at + chunk);
          const data = toBase64(source.subarray(at, end));
          const done = end - at < chunk;
          at = end;
          return { data, done };
        },
        async closeRead() { calls.close++; },
      },
    },
  };
  return calls;
}

// ═══════════════════════════════════════════════════════════════
group('1. 一块一块地读');

await test('拼回来的字节和原文件一模一样；一块一块地要，不走整份读', async () => {
  const source = fakePdf((3 << 20) * 2 + 12345); // 三块，最后一块不满
  const calls = installReader(source);
  const progress = [];
  const file = await readDevicePdf({ uri: 'content://media/external/file/1', name: 'a.pdf', size: source.length },
    { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(calls.wholeRead, 0, '不再调 read()');
  assert.equal(calls.open, 1);
  assert.equal(calls.chunks, 3);
  assert.equal(file.name, 'a.pdf');
  assert.equal(file.size, source.length);
  const back = new Uint8Array(await file.arrayBuffer());
  assert.equal(back.length, source.length);
  assert.ok(back.every((v, i) => v === source[i]), '每一个字节都对');
  assert.deepEqual(progress.map((p) => p[0]), [3 << 20, 6 << 20, source.length], '每读完一块报一次');
  assert.ok(progress.every((p) => p[1] === source.length));
});

await test('正好是整块的倍数：最后多要一块空的，读到头就停', async () => {
  const source = fakePdf(3 << 20);
  const calls = installReader(source);
  const file = await readDevicePdf({ uri: 'content://media/external/file/1', name: 'b.pdf' });
  assert.equal(calls.chunks, 2, '第二块是空的、done');
  assert.equal(file.size, source.length);
});

await test('原生那边问不出大小（-1）：边读边长，长度照样对', async () => {
  const source = fakePdf((3 << 20) * 3 + 99);
  installReader(source, { reportedSize: -1 });
  const file = await readDevicePdf({ uri: 'content://media/external/file/1', name: 'c.pdf' });
  const back = new Uint8Array(await file.arrayBuffer());
  assert.equal(back.length, source.length);
  assert.equal(back[back.length - 1], source[source.length - 1]);
});

await test('读到一半出错：报读取失败，并且把流关掉', async () => {
  const source = fakePdf((3 << 20) * 3);
  const calls = installReader(source, { failAt: 2 });
  await assert.rejects(
    readDevicePdf({ uri: 'content://media/external/file/1', name: 'd.pdf' }),
    (error) => error.message === FILES_ERRORS.READ_FAILED,
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.close, 1, '流关掉了');
});

// ═══════════════════════════════════════════════════════════════
group('1b. 先走本地网址');

const realFetch = globalThis.fetch;
/**
 * 在 installReader 装好的插件上再装 Capacitor 的本地网址：convertFileSrc 换网址，fetch 一段一段地流。
 * contentLength 是回的长度头（null 是不给）；breakAt 是第几段断掉；chunks 给了就照它一段一段地给。
 */
function installLocalServer(source, { status = 200, contentLength = source.length, segment = 64 << 10,
  breakAt = -1, chunks = null, fetchFails = false } = {}) {
  const calls = { fetched: [], cancelled: 0 };
  dom.window.Capacitor.convertFileSrc = (uri) => uri.replace('content://', 'http://localhost/_capacitor_content_/');
  globalThis.fetch = async (url) => {
    calls.fetched.push(url);
    if (fetchFails) throw new TypeError('Failed to fetch');
    let at = 0;
    let n = 0;
    const queue = chunks ? [...chunks] : null;
    const body = new ReadableStream({
      pull(controller) {
        if (n++ === breakAt) { controller.error(new Error('net::ERR_CONNECTION_RESET')); return; }
        if (queue) { if (queue.length) controller.enqueue(queue.shift()); else controller.close(); return; }
        if (at >= source.length) { controller.close(); return; }
        const end = Math.min(source.length, at + segment);
        controller.enqueue(source.slice(at, end));
        at = end;
      },
      cancel() { calls.cancelled++; },
    });
    const headers = new Headers();
    if (contentLength != null) headers.set('content-length', String(contentLength));
    return new Response(body, { status, headers });
  };
  return calls;
}
const ENTRY = { uri: 'content://media/external/file/1', name: 'e.pdf' };
const sameBytes = async (file, source) => {
  const back = new Uint8Array(await file.arrayBuffer());
  assert.equal(back.length, source.length);
  assert.equal(back.buffer.byteLength, source.length, '交出去的内存正好那么大，不带多开的尾巴');
  assert.ok(back.every((v, i) => v === source[i]), '每一个字节都对');
};

await test('走本地网址：字节一模一样，一块也不过桥；进度大约每 1% 报一次，最后报满', async () => {
  const source = fakePdf((10 << 20) + 777); // 一百六十多段
  const bridge = installReader(source);
  const local = installLocalServer(source);
  const progress = [];
  const file = await readDevicePdf({ ...ENTRY, size: source.length },
    { onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual(local.fetched, ['http://localhost/_capacitor_content_/media/external/file/1']);
  assert.equal(bridge.open, 0, '没走桥');
  assert.equal(bridge.chunks, 0);
  await sameBytes(file, source);
  assert.ok(progress.length > 50 && progress.length <= 101, `报了 ${progress.length} 次`);
  assert.deepEqual(progress.at(-1), [source.length, source.length], '最后报满');
  assert.ok(progress.every(([d], i) => i === 0 || d > progress[i - 1][0]), '一路往上');
});

await test('不给长度头：按列表里记的大小核对，对得上就收', async () => {
  const source = fakePdf((3 << 20) + 5);
  const bridge = installReader(source);
  installLocalServer(source, { contentLength: null });
  const file = await readDevicePdf({ ...ENTRY, size: source.length });
  assert.equal(bridge.open, 0);
  await sameBytes(file, source);
});

await test('长度头和列表都没有：边读边长，最后截成正好那么长', async () => {
  const source = fakePdf((7 << 20) + 3);
  const bridge = installReader(source);
  installLocalServer(source, { contentLength: null });
  const file = await readDevicePdf(ENTRY);
  assert.equal(bridge.open, 0);
  await sameBytes(file, source);
});

for (const [why, options, cancelled] of [
  ['回 404（没权限、文件没了）', { status: 404 }, 0],
  ['连不上（fetch 直接抛）', { fetchFails: true }, 0],
  ['读到一半断了', { breakAt: 20 }, 0],
  ['比长度头短（截断了）', { contentLength: (5 << 20) + 1 }, 0],
  ['一个字节都没有', { chunks: [] , contentLength: null }, 0],
  // 后面还得有没读的一段：流已经自己读完了，就没有什么可关的。
  ['半路放不下（开不出内存）', { chunks: [new Uint8Array(8), { length: Infinity }, new Uint8Array(8)], contentLength: null }, 1],
]) {
  await test(`${why}：退回一块一块地读，字节照样对`, async () => {
    const source = fakePdf(5 << 20);
    const bridge = installReader(source);
    const local = installLocalServer(source, options);
    const file = await readDevicePdf({ ...ENTRY, size: source.length });
    assert.equal(local.fetched.length, 1, '先试了本地网址');
    assert.equal(bridge.open, 1, '然后过桥');
    await sameBytes(file, source);
    assert.equal(local.cancelled, cancelled, cancelled ? '没读完的流关掉了' : '流自己结束了，不用关');
  });
}

await test('列表记的大小和本地网址读到的对不上（文件后来变了）：交给桥，按桥问到的大小收', async () => {
  const source = fakePdf((4 << 20) + 9);
  const bridge = installReader(source);
  installLocalServer(source, { contentLength: null });
  const file = await readDevicePdf({ ...ENTRY, size: source.length - 100 });
  assert.equal(bridge.open, 1);
  await sameBytes(file, source);
});

await test('没权限：本地网址 404，桥那边报没权限——还是「没权限」，不是「读取失败」', async () => {
  const source = fakePdf(1 << 20);
  installReader(source);
  dom.window.Capacitor.Plugins.PdfFiles.openRead = async () => { throw Object.assign(new Error('x'), { code: 'NO_PERMISSION' }); };
  installLocalServer(source, { status: 404 });
  await assert.rejects(readDevicePdf({ ...ENTRY, size: source.length }),
    (error) => error.message === FILES_ERRORS.NO_PERMISSION);
});

globalThis.fetch = realFetch;

// ═══════════════════════════════════════════════════════════════
group('2. 单子能多选');

const ENTRIES = [
  { uri: 'u1', name: '谢惠民.pdf', size: 122322223, modified: 1788855030000, folder: 'Download/' },
  { uri: 'u2', name: '裴礼文.pdf', size: 53932453, modified: 1788854976000, folder: 'Download/' },
  { uri: 'u3', name: '李杨高代.pdf', size: 47333829, modified: 1789979765000, folder: 'Download/' },
];

function installLister() {
  dom.window.Capacitor = {
    Plugins: {
      PdfFiles: {
        async hasPermission() { return { granted: true }; },
        async list() { return { files: ENTRIES }; },
      },
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const rows = () => [...document.querySelectorAll('.pdf-picker-row')];
const confirmButton = () => document.querySelector('.pdf-picker-confirm');
const countText = () => document.querySelector('.pdf-picker-count')?.textContent;

await test('勾两份：按钮写「导入 2 份」、底下写已选几份，按勾的先后回来', async () => {
  installLister();
  const picking = openDevicePdfPicker({ title: '导入 PDF' });
  await settle();
  assert.equal(rows().length, 3);
  assert.equal(document.querySelector('.pdf-picker-list').getAttribute('aria-multiselectable'), 'true');
  assert.ok(confirmButton().disabled, '一份没勾不能导');
  rows()[2].click();
  rows()[0].click();
  assert.equal(confirmButton().disabled, false);
  assert.equal(confirmButton().textContent.trim(), '导入 2 份');
  assert.equal(countText(), '已选 2 份 · 共 3 份');
  assert.ok(rows()[2].classList.contains('is-chosen') && rows()[0].classList.contains('is-chosen'));
  confirmButton().click();
  const chosen = await picking;
  assert.deepEqual(chosen.map((e) => e.uri), ['u3', 'u1'], '按勾的先后');
  assert.equal(document.querySelector('.pdf-picker-overlay'), null, '单子收掉了');
});

await test('再点一下取消勾；只勾一份时按钮还是「导入」', async () => {
  installLister();
  const picking = openDevicePdfPicker({ title: '导入 PDF' });
  await settle();
  rows()[1].click();
  rows()[0].click();
  rows()[0].click();
  assert.equal(confirmButton().textContent.trim(), '导入');
  assert.equal(countText(), '已选 1 份 · 共 3 份');
  assert.ok(!rows()[0].classList.contains('is-chosen'));
  confirmButton().click();
  assert.deepEqual((await picking).map((e) => e.uri), ['u2']);
});

await test('双击一行：连同它一起，马上导入', async () => {
  installLister();
  const picking = openDevicePdfPicker({ title: '导入 PDF' });
  await settle();
  rows()[0].click();
  rows()[1].dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  assert.deepEqual((await picking).map((e) => e.uri), ['u1', 'u2']);
});

await test('取消：回 null', async () => {
  installLister();
  const picking = openDevicePdfPicker({ title: '导入 PDF' });
  await settle();
  rows()[0].click();
  document.querySelector('[data-role="cancel"]').click();
  assert.equal(await picking, null);
});

// ═══════════════════════════════════════════════════════════════
group('3. 原生插件');

const java = $read('android/app/src/main/java/io/github/lzy0105/duiye/files/PdfFilesPlugin.java');

await test('没有整份读进内存的那条路了：openRead / readChunk / closeRead', () => {
  for (const m of ['openRead', 'readChunk', 'closeRead']) {
    assert.ok(new RegExp(`@PluginMethod\\s+public void ${m}\\(PluginCall call\\)`).test(java), m);
  }
  assert.ok(!/public void read\(PluginCall call\)/.test(java), '整份读的 read() 拆了');
  assert.ok(!/new ByteArrayOutputStream/.test(java), '没有会翻倍扩容的整份缓冲（注释里提到崩溃栈不算）');
  assert.ok(/READ_CHUNK = 3 << 20/.test(java), '一块 3 MiB');
});

await test('读一块时连 OutOfMemoryError 也接住，出错关掉流；开头先查权限', () => {
  const chunk = java.slice(java.indexOf('public void readChunk'), java.indexOf('public void closeRead'));
  assert.ok(/catch \(Throwable e\)/.test(chunk), '接 Throwable，不只是 Exception');
  assert.ok(/closeQuietly\(token\)/.test(chunk));
  const open = java.slice(java.indexOf('public void openRead'), java.indexOf('public void readChunk'));
  assert.ok(open.indexOf('granted()') < open.indexOf('openInputStream'), '先查权限');
});

// ═══════════════════════════════════════════════════════════════
group('4. 导入流程');

const ui = $read('src/pdf/pdf-workspace-ui.js');
const handle = ui.slice(ui.indexOf('async function handleImport('), ui.indexOf('function importFailureReason('));

await test('角色一批只问一次；一份一份读、一份一份导（不是一起读进来）', () => {
  assert.equal((handle.match(/confirmRole\(/g) || []).length, 1, '只问一次');
  assert.ok(/for \(let i = 0; i < total; i\+\+\)/.test(handle), '一份一份来');
  assert.ok(!/Promise\.all/.test(handle), '不并发：几本几百兆的书不能同时躺在内存里');
  assert.ok(handle.indexOf('await source.open(') < handle.indexOf('await importPdf('), '读一份、导一份');
  assert.ok(/LIBRARY_ERRORS\.STORAGE_FULL[\s\S]*?break;/.test(handle), '存储满了就停下');
});

await test('应用内那张单子交来的是「到时候再读」：选的时候一份都不读', () => {
  const pick = ui.slice(ui.indexOf('export async function pickAndImport('), ui.indexOf('function openSystemPicker('));
  assert.ok(/open: \(onProgress\) => readDevicePdf\(entry, \{ onProgress \}\)/.test(pick));
  assert.ok(!/await readDevicePdf\(/.test(pick), '不在这里先读');
});

await test('系统选择器也能多选；问角色那张单子能问一批', () => {
  const html = $read('index.html');
  assert.ok(/<input type="file" accept="application\/pdf,\.pdf" multiple hidden data-role="file-exercise">/.test(html));
  assert.ok(/<input type="file" accept="application\/pdf,\.pdf" multiple hidden data-role="file-answer">/.test(html));
  const role = ui.slice(ui.indexOf('function confirmRole('), ui.indexOf('function confirmRole(') + 900);
  assert.ok(/这 \$\{list\.length\} 份文件是？/.test(role));
});

await test('三种语言都有多选的字', () => {
  for (const lang of ['zh-CN', 'zh-TW', 'en']) {
    const pack = $read(`src/core/lang/${lang}.js`);
    for (const key of ['picker.confirmCount', 'picker.selected']) assert.ok(pack.includes(`"${key}"`), `${lang} 少了 ${key}`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
