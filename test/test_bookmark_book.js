#!/usr/bin/env node
// 书签成书：把一本书标过书签的页挑出来，存成一本新书或导出。
//
// 盯这几样：
//   一、做出来的那份 PDF：页是原书的页（字还是字、转过的还转着、裁切框还在），按挑的次序排；「导出」那份笔迹画在
//       人下笔的地方，「存成新书」那份一笔都不画（笔迹另拷成新书自己的）；读不懂、加了密的交给逐页画成图那条路。
//   二、新书上的书签：每页一条，说清楚是原书第几页；名字太长截原来的名字，不截「原第 N 页」。
//   三、那张单子：默认全选，全选 / 全不选，一页都没选时按不下去，交出去的页按原书次序，名字空着就用默认的。
//   四、入口：书签那一页底下、本栏 ⋯ 里，只给标过书签的书；本子、草稿纸、没书签的书都没有。
//   五、接线：先存下没落盘的笔迹再做；存成新书 = 做文件 → 进文档库 → 拷笔迹 → 标书签 → 放进原来的文件夹 → 打开。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err?.stack?.split('\n').slice(0, 3).join('\n     ') || err}`); }
}

const ROOT = new URL('../', import.meta.url);
const $read = (f) => readFileSync(new URL(f, ROOT), 'utf-8').replace(/\r\n/g, '\n');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event', 'KeyboardEvent', 'PointerEvent',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'localStorage']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
dom.window.Element.prototype.scrollIntoView = function () {};

const pdfLib = await import('pdf-lib');
const { PDFDocument, StandardFonts, degrees, PDFArray } = pdfLib;
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = new URL('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', ROOT).href;

const X = await import('../src/export/pdf-export.js');
const { bookmarksForNewBook } = await import('../src/pdf/bookmark-book.js');
const { LABEL_MAX } = await import('../src/pdf/bookmark-state.js');
const { chooseMarkPages } = await import('../src/pdf/deck-dialogs.js');
const { PagePanel } = await import('../src/pdf/page-panel.js');
const { PANEL_TABS, createPanelState, selectTab, setHeight } = await import('../src/pdf/panel-state.js');
const { initI18n, setLang, t } = await import('../src/core/i18n.js');
await initI18n();
// 下面有简体中文的断言；不钉住的话语言跟着系统走，CI 那台英文 Linux 上就挂。
await setLang('zh-CN');

const openWithPdfJs = (bytes) => pdfjs.getDocument({
  data: new Uint8Array(bytes).slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0,
}).promise;

/** 六页：第 3 页转过 90° 带裁切框，其余不转。每页一行字说自己是第几页。 */
async function sampleBook({ encrypted = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 6; i++) {
    const page = doc.addPage(i === 3 ? [600, 800] : [595, 842]);
    if (i === 3) { page.setRotation(degrees(90)); page.setCropBox(20, 30, 540, 710); }
    page.drawText(`Page ${i} words`, { x: 80, y: 300, size: 18, font });
  }
  if (encrypted) {
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 }));
  }
  return doc.save();
}
const book = await sampleBook();
const dot = (x, y) => ({ tool: 'pen', color: '#dc2626', width: 3, opacity: 1, points: [{ x, y, p: 0.5 }] });
const textOf = async (js, n) => (await (await js.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ');
const contentsOf = (doc, i) => {
  const c = doc.getPages()[i].node.Contents();
  return c instanceof PDFArray ? c.size() : 1;
};

// ═══════════════════════════════════════════════════════════════
group('一、做出来的那份 PDF');

await test('挑出来的页按给的次序排，字还是字', async () => {
  const bytes = await X.buildPagesPdf({ bytes: book, pages: [{ pageNumber: 5 }, { pageNumber: 2 }, { pageNumber: 3 }] });
  const js = await openWithPdfJs(bytes);
  assert.equal(js.numPages, 3);
  assert.ok((await textOf(js, 1)).includes('Page 5 words'));
  assert.ok((await textOf(js, 2)).includes('Page 2 words'));
  assert.ok((await textOf(js, 3)).includes('Page 3 words'), '第三页是原书第 3 页，字取得出来——没被画成图');
});

await test('转过的页还转着、裁切框还在：和原书那一页一样大、一样朝向', async () => {
  const bytes = await X.buildPagesPdf({ bytes: book, pages: [{ pageNumber: 3 }] });
  const original = (await (await openWithPdfJs(book)).getPage(3)).getViewport({ scale: 1 });
  const copied = (await (await openWithPdfJs(bytes)).getPage(1)).getViewport({ scale: 1 });
  assert.equal(copied.rotation, 90);
  assert.deepEqual([copied.width, copied.height], [original.width, original.height]);
  assert.deepEqual(copied.transform, original.transform, '屏幕上那一页的坐标系一样，笔迹才落得回原处');
});

await test('导出那份（stamp）：笔迹画在人下笔的地方，转过的页也是；没笔迹的页一段都不多', async () => {
  const bytes = await X.buildPagesPdf({
    bytes: book, stamp: true,
    pages: [{ pageNumber: 3, strokes: [dot(30, 40)] }, { pageNumber: 4, strokes: [] }],
  });
  const lib = await PDFDocument.load(bytes);
  assert.ok(contentsOf(lib, 0) >= 3, '有笔迹的那页：原内容包进 q…Q，笔迹接在后面');
  assert.equal(contentsOf(lib, 1), 1, '没笔迹的那页原样');
  // 笔迹那一段的 cm 和第一个 m，按 pdf.js 的视口推回屏幕：落在 (30 + 半宽, 40)。
  const arr = lib.getPages()[0].node.Contents();
  const stream = lib.context.lookup(arr.get(arr.size() - 1));
  const text = new TextDecoder().decode(pdfLib.decodePDFRawStream(stream).decode());
  const cm = text.match(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/).slice(1).map(Number);
  const m = text.match(/\n(-?[\d.]+) (-?[\d.]+) m\n/).slice(1).map(Number);
  const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];
  const viewport = (await (await openWithPdfJs(bytes)).getPage(1)).getViewport({ scale: 1 }).transform;
  const [sx, sy] = apply(viewport, apply(cm, m));
  assert.ok(Math.abs(sx - 31.5) < 0.05 && Math.abs(sy - 40) < 0.05, `落在 (${sx.toFixed(2)}, ${sy.toFixed(2)})`);
});

await test('存成新书那份（不 stamp）：给了笔迹也一笔不画——笔迹另拷成新书自己的，画进去就擦不掉了', async () => {
  const bytes = await X.buildPagesPdf({ bytes: book, pages: [{ pageNumber: 3, strokes: [dot(30, 40)] }] });
  const lib = await PDFDocument.load(bytes);
  assert.equal(contentsOf(lib, 0), 1);
});

await test('原书没有的页不要；一页都不剩就说「没东西可做」', async () => {
  const bytes = await X.buildPagesPdf({ bytes: book, pages: [{ pageNumber: 2 }, { pageNumber: 99 }, { pageNumber: 0 }] });
  assert.equal((await openWithPdfJs(bytes)).numPages, 1);
  await assert.rejects(X.buildPagesPdf({ bytes: book, pages: [{ pageNumber: 99 }] }),
    (e) => e.message === X.EXPORT_ERRORS.EMPTY);
});

await test('加了密、读不懂：交给逐页画成图那条路（和导出整本书一样的两个错）', async () => {
  await assert.rejects(X.buildPagesPdf({ bytes: await sampleBook({ encrypted: true }), pages: [{ pageNumber: 1 }] }),
    (e) => e.message === X.EXPORT_ERRORS.ENCRYPTED);
  await assert.rejects(X.buildPagesPdf({ bytes: new TextEncoder().encode('not a pdf'), pages: [{ pageNumber: 1 }] }),
    (e) => e.message === X.EXPORT_ERRORS.UNREADABLE);
});

await test('进度一页报一次；文件信息里写着书名和「对页」，不冒充原书', async () => {
  const seen = [];
  const bytes = await X.buildPagesPdf({
    bytes: book, title: '高代（书签）', pages: [{ pageNumber: 1 }, { pageNumber: 6 }],
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.deepEqual(seen, [[1, 2], [2, 2]]);
  // 读回来时别让 pdf-lib 改写信息（它默认会把 Producer 换成自己）。
  const lib = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(lib.getTitle(), '高代（书签）');
  assert.equal(lib.getProducer(), '对页 Duìyè');
});

await test('后台线程认得「pages」这一种', async () => {
  const posted = [];
  const prevSelf = globalThis.self;
  globalThis.self = { postMessage: (msg, transfer) => posted.push({ msg, transfer }) };
  try {
    await import(new URL('../src/export/export-worker.js', import.meta.url).href + '?pages=' + Date.now());
    await globalThis.self.onmessage({ data: { id: 3, job: 'pages', input: { bytes: book, pages: [{ pageNumber: 2 }] } } });
    const done = posted.find((p) => p.msg.id === 3 && p.msg.bytes);
    assert.ok(done, '交回了字节');
    assert.equal((await openWithPdfJs(done.msg.bytes)).numPages, 1);
  } finally {
    globalThis.self = prevSelf;
  }
});

// ═══════════════════════════════════════════════════════════════
group('二、新书上的书签');

const words = {
  named: (label, page) => t('marksBook.newMark', { label, page }),
  unnamed: (page) => t('marksBook.newMarkPage', { page }),
};

await test('每页一条：有名字的照抄再说原第几页，没名字的就说原第几页', () => {
  const marks = [{ page: 37, label: '' }, { page: 76, label: '扰动法' }, { page: 89, label: '' }];
  const out = bookmarksForNewBook(marks, [76, 89], words);
  assert.deepEqual(out.map((m) => [m.page, m.label]), [[1, '扰动法（原第 76 页）'], [2, '原第 89 页']]);
});

await test('名字太长：截原来的名字，「原第 N 页」那半句一个字不少', () => {
  const long = '一'.repeat(80);
  const [mark] = bookmarksForNewBook([{ page: 123, label: long }], [123], words);
  assert.ok(mark.label.length <= LABEL_MAX, `${mark.label.length} 字`);
  assert.ok(mark.label.endsWith('…（原第 123 页）'), mark.label);
});

// ═══════════════════════════════════════════════════════════════
group('三、那张单子');

const MARKS = [{ page: 11, label: '' }, { page: 2, label: '' }, { page: 5, label: '洛必达法则' }];
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
function openDialog(spec = {}) {
  const answer = chooseMarkPages({
    bookName: '高代', marks: MARKS, defaultName: '高代（书签）', labelFor: (m) => m.label || `第 ${m.page} 页`, ...spec,
  });
  const d = document.querySelector('.marks-book-dialog');
  const $ = (role) => d.querySelector(`[data-role="${role}"]`);
  const rows = () => [...d.querySelectorAll('.marks-book-row')];
  return { answer, d, $, rows };
}

await test('一打开就是全选；按原书的页码排；上面说已选几页', async () => {
  const { $, rows, answer } = openDialog();
  assert.deepEqual(rows().map((r) => r.dataset.page), ['2', '5', '11']);
  assert.ok(rows().every((r) => r.classList.contains('is-selected')));
  assert.equal($('count').textContent, '已选 3 / 3 页');
  assert.equal($('all').textContent, '全不选');
  assert.equal($('name').value, '高代（书签）');
  $('cancel').click();
  assert.equal(await answer, null, '取消什么都不做');
});

await test('全不选：两颗按钮都按不下去；点回几行就能按，交出去的按原书次序', async () => {
  const { $, rows, answer } = openDialog();
  $('all').click();
  assert.equal($('count').textContent, '已选 0 / 3 页');
  assert.equal($('all').textContent, '全选');
  assert.ok($('save').disabled && $('export').disabled);
  rows()[2].click();
  rows()[0].click();
  assert.equal($('save').disabled, false);
  $('save').click();
  assert.deepEqual(await answer, { action: 'save', pages: [2, 11], name: '高代（书签）', withInk: true });
});

await test('导出 PDF 那一颗交出 export；名字改了用改的，清空了用默认的', async () => {
  const one = openDialog();
  one.$('name').value = '  期中  复习 ';
  one.$('export').click();
  assert.deepEqual(await one.answer, { action: 'export', pages: [2, 5, 11], name: '期中 复习', withInk: true });
  const two = openDialog();
  two.$('name').value = '   ';
  two.$('save').click();
  assert.equal((await two.answer).name, '高代（书签）');
});

await test('「带上批注」默认勾着；去掉勾，交出去的就是不带', async () => {
  const { d, $, answer } = openDialog();
  const box = d.querySelector('[data-role="with-ink"]');
  assert.equal(box.checked, true, '人问「包含笔记吗」，要的是带着');
  assert.equal(d.querySelector('[data-role="with-ink-label"]').textContent, '带上批注');
  box.checked = false;
  $('export').click();
  assert.equal((await answer).withInk, false);
});

await test('一行显示原书页码和书签名字（没名字的照书签单子的写法）', async () => {
  const { rows, $, answer } = openDialog();
  assert.equal(rows()[1].querySelector('.marks-book-page').textContent, '5');
  assert.equal(rows()[1].querySelector('.deck-pick-name').textContent, '洛必达法则');
  assert.equal(rows()[0].querySelector('.deck-pick-name').textContent, '第 2 页');
  $('cancel').click();
  await answer;
  await flush();
});

// ═══════════════════════════════════════════════════════════════
group('四、入口');

function mountPanel({ canMake = true, marks = MARKS } = {}) {
  document.body.innerHTML = '<div class="pdf-ws-slot"><div data-role="outline-panel" hidden></div><div data-role="pane"></div></div>';
  const host = document.querySelector('.pdf-ws-slot');
  let state = selectTab(createPanelState(), PANEL_TABS.MARKS);
  const asked = [];
  const panel = new PagePanel(host, {
    getState: () => state,
    onState: (change) => { state = change({ selectTab: (tab) => selectTab(state, tab), setHeight: (h) => setHeight(state, h) }); },
    getDoc: () => ({ numPages: 200, renderPage: () => new Promise(() => {}) }),
    getPageCount: () => 200,
    getCurrentPage: () => 5,
    getPageSize: () => ({ width: 595, height: 842 }),
    getBookmarks: () => marks,
    canMakeBookFromMarks: () => canMake,
    onBookFromMarks: () => asked.push(1),
    onGoToPage: () => {},
    onOpenChange: () => {},
  });
  panel.open();
  return { host, panel, asked };
}

await test('书签那一页底下有「书签成书」，说着几页；点它交给工作区', () => {
  const { host, panel, asked } = mountPanel();
  const button = host.querySelector('.pdf-mark-book');
  assert.ok(button, '在');
  assert.equal(button.textContent.trim(), '把这 3 页书签做成一本');
  const list = host.querySelector('.pdf-mark-list');
  assert.ok(list.compareDocumentPosition(button) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, '在单子底下，不压在最常点的那几行前面');
  button.click();
  assert.equal(asked.length, 1);
  panel.destroy();
});

await test('本子的书签、没有书签：没有这颗按钮', () => {
  const note = mountPanel({ canMake: false });
  assert.equal(note.host.querySelector('.pdf-mark-book'), null);
  note.panel.destroy();
  const none = mountPanel({ marks: [] });
  assert.equal(none.host.querySelector('.pdf-mark-book'), null);
  none.panel.destroy();
});

await test('本栏 ⋯ 里有一项，只给标过书签的书；换书签时跟着显隐', () => {
  const ws = $read('src/pdf/pdf-workspace.js');
  assert.ok(/data-role="marks-book" hidden/.test(ws), '菜单里有，默认藏着');
  assert.ok(/on\('marks-book', \(\) => \{ this\._closeSlotMenus\(\); this\.bookFromMarksSlot\(slot\); \}\)/.test(ws));
  assert.ok(/n\.hidden = !loaded \|\| !this\.canMakeBookFromMarks\(slot\);/.test(ws));
  const can = ws.slice(ws.indexOf('  canMakeBookFromMarks(slot) {'), ws.indexOf('  bookFromMarksSlot(slot) {'));
  assert.ok(/entry\?\.kind === ENTRY_KINDS\.PDF/.test(can), '只给书：本子拷不出「原书的页」');
  assert.ok(/this\._bookmarksIn\(slot\)\.length > 0/.test(can));
  // 书签一变（_toggleBookmark）就 _syncSlotChrome，菜单那一项跟着显隐。
  const toggle = ws.slice(ws.indexOf('  _toggleBookmark(slot, page) {'));
  assert.ok(toggle.indexOf('this._syncSlotChrome(slot)') > 0);
});

// ═══════════════════════════════════════════════════════════════
group('五、接线');

await test('「导出 PDF」走导出那条路：只导这几页、笔迹画进去、名字不加「（批注）」', () => {
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const make = ui.slice(ui.indexOf('async function makeBookFromMarks'));
  assert.ok(/kind: EXPORT_KINDS\.PDF, id: source\.id, name: answer\.name, pages: answer\.pages, ink: answer\.withInk,/.test(make));
  const run = ui.slice(ui.indexOf('async function runExport'));
  assert.ok(/buildPagesExport\(\{ id, pages, stamp: ink !== false, title \}/.test(run), '去掉「带上批注」就不画');
  assert.ok(/async function runExport\(\{ kind, id, name, pages, ink = true \}\)/.test(run), '整本导出照旧带批注');
  assert.ok(/kind === EXPORT_KINDS\.PDF && !pages \? t\('export\.suffix'\)/.test(run));
  // 权限、落盘、做、存的次序和整本导出一样（test_pdf_export 钉着），这几页走的是同一个函数。
  assert.ok(run.indexOf('ensureExportPermission(') < run.indexOf('buildPagesExport('));
});

await test('「存成新书」：先存笔迹 → 做文件 → 进文档库 → 拷笔迹 → 标书签 → 放进原来的文件夹 → 打开', () => {
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const body = ui.slice(ui.indexOf('async function runSaveBookmarkBook'));
  const steps = ['flushInkFor', 'buildPagesExport(', 'importPdf(', 'saveLayer(meta.id, i + 1', 'saveBookmarks(meta.id',
    'moveToFolder(meta.id', 'refreshLibrary()', 'openResource(meta.id'].map((s) => body.indexOf(s));
  assert.ok(steps.every((v) => v > 0), `每一步都在：${steps}`);
  assert.deepEqual([...steps].sort((a, b) => a - b), steps, '次序不能乱');
  assert.ok(/stamp: false/.test(body.slice(0, body.indexOf('importPdf('))), '新书的页不画笔迹');
  assert.ok(/original\?\.role \|\| DOC_ROLES\.UNSPECIFIED/.test(body), '册别照原书');
  assert.ok(/slot: source\.slot/.test(body), '在原书那一栏打开');
});

await test('同一时刻只做一本；存储满了说存储满了', () => {
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const save = ui.slice(ui.indexOf('function saveBookmarkBook'), ui.indexOf('async function runSaveBookmarkBook'));
  assert.ok(/if \(makingBook\) \{/.test(save));
  assert.ok(/LIBRARY_ERRORS\.STORAGE_FULL/.test(save));
  assert.ok(/workspace\.onBookFromMarks = \(source\) => makeBookFromMarks\(source\);/.test(ui));
});

await test('做文件和导出同一套：后台线程里做，原文件转手；读不懂、加了密换逐页画成图', () => {
  const doc = $read('src/export/export-document.js');
  const body = doc.slice(doc.indexOf('export async function buildPagesExport'));
  assert.ok(/inBackground\('pages'/.test(body));
  assert.ok(/transferOf: \(input\) => bufferOf\(input\.bytes\)/.test(body));
  assert.ok(/buildRasterPdf\(/.test(body));
  assert.ok(/rasterBookPage\(doc, inRange\[n - 1\]\.pageNumber, inRange\[n - 1\]\.strokes\)/.test(body));
});

await test('三种语言的字一样多', () => {
  const keysOf = (lang) => [...$read(`src/core/lang/${lang}.js`).matchAll(/"(marksBook\.[^"]+)"/g)].map((m) => m[1]).sort();
  const zh = keysOf('zh-CN');
  assert.ok(zh.length >= 15, `${zh.length} 条`);
  assert.deepEqual(keysOf('zh-TW'), zh);
  assert.deepEqual(keysOf('en'), zh);
  const used = new Set([...['src/pdf/deck-dialogs.js', 'src/pdf/page-panel.js', 'src/pdf/pdf-workspace.js', 'src/pdf/pdf-workspace-ui.js']
    .flatMap((f) => [...$read(f).matchAll(/'(marksBook\.[^']+)'/g)].map((m) => m[1]))]);
  for (const k of used) assert.ok(zh.includes(k), `用到的 ${k} 没有字`);
  for (const k of zh) assert.ok(used.has(k), `${k} 没人用`);
});

// ═══════════════════════════════════════════════════════════════
group('六、从母本更新');

const { mergeFromSource, syncBaseOf } = await import('../src/pdf/bookmark-book.js');
const D = await import('../src/pdf/derived-store.js');

/** 一笔，id 自己给，好认。 */
const ink = (id, x, color = '#111827') => ({
  id, tool: 'pen', color, width: 2, opacity: 1, fill: null, shape: null,
  points: [{ x, y: 10, p: 0.5 }, { x: x + 20, y: 12, p: 0.5 }],
});
const ids = (list) => list.map((s) => s.id);

await test('母本改了的跟过来，母本新写的加进来，母本擦了的去掉', () => {
  const was = [ink('a', 0), ink('b', 50), ink('c', 100)];
  const base = syncBaseOf(was);
  const child = [ink('a', 0), ink('b', 50), ink('c', 100)];
  const parent = [ink('a', 0, '#dc2626'), ink('c', 100), ink('d', 150)];
  const out = mergeFromSource(parent, child, base);
  assert.equal(out.changed, true);
  assert.deepEqual(ids(out.strokes), ['a', 'c', 'd'], 'b 母本擦了；d 母本新写的');
  assert.equal(out.strokes[0].color, '#dc2626', 'a 母本换了色，跟着换');
});

await test('自己写的不动、叠在上面；在新书上改过（母本没动）的留新书的；在新书上擦掉的不加回来', () => {
  const was = [ink('a', 0), ink('b', 50), ink('c', 100)];
  const base = syncBaseOf(was);
  const moved = ink('a', 30);
  const child = [moved, ink('c', 100), ink('mine', 200)];
  const parent = [ink('a', 0), ink('b', 50), ink('c', 100)];
  const out = mergeFromSource(parent, child, base);
  assert.deepEqual(ids(out.strokes), ['a', 'c', 'mine'], 'b 是人在新书上擦掉的：不回来');
  assert.equal(out.strokes[0], moved, '新书上搬过的 a，母本没动它：留新书的');
  assert.equal(out.changed, false, '和新书现在一样：没有要更新的');
});

await test('两边都改了同一笔：以母本为准（「从母本更新」要的就是母本的最新）', () => {
  const base = syncBaseOf([ink('a', 0)]);
  const out = mergeFromSource([ink('a', 0, '#2563eb')], [ink('a', 40)], base);
  assert.equal(out.strokes[0].color, '#2563eb');
  assert.equal(out.strokes[0].points[0].x, 0);
});

await test('当初没带批注（一笔没拷）：更新把母本那一页整个拉过来', () => {
  const parent = [ink('a', 0), ink('b', 50)];
  const out = mergeFromSource(parent, [ink('mine', 300)], {});
  assert.deepEqual(ids(out.strokes), ['a', 'b', 'mine']);
});

await test('这一次的样子记下来，下次拿来比——包括在新书上擦掉的那几笔，下次也不回来', () => {
  const parent = [ink('a', 0), ink('b', 50)];
  const first = mergeFromSource(parent, [ink('a', 0)], syncBaseOf(parent));
  assert.deepEqual(Object.keys(first.base).sort(), ['a', 'b']);
  const again = mergeFromSource(parent, first.strokes, first.base);
  assert.equal(again.changed, false);
  assert.deepEqual(ids(again.strokes), ['a']);
});

/** 存第三样的地方：Node 里没有 IndexedDB，换成内存里的一张表。 */
const memory = new Map();
D.setDerivedBaseBackend({
  get: async (k) => memory.get(k),
  put: async (k, v) => { memory.set(k, JSON.parse(JSON.stringify(v))); },
  delete: async (k) => { memory.delete(k); },
});

await test('那根线：记下、读回、更新、一本删掉就断（它是新书，或它是母本）', async () => {
  localStorage.removeItem('ls_pdf_derived');
  memory.clear();
  D.resetDerivedCache();
  await D.recordDerived('kid', { source: 'mom', pages: [5, 11], base: { 1: { a: 'x' } } }, 1000);
  await D.recordDerived('kid2', { source: 'mom', pages: [2], base: {} }, 1000);
  await D.recordDerived('kid3', { source: 'other', pages: [1], base: {} }, 1000);
  D.resetDerivedCache();
  assert.deepEqual(D.derivedFrom('kid'), { source: 'mom', pages: [5, 11], syncedAt: 1000 }, '从 localStorage 读回来一样');
  assert.deepEqual(await D.loadDerivedBase('kid'), { 1: { a: 'x' } });
  await D.updateDerivedBase('kid', { 1: { a: 'y' }, 2: {} }, 2000);
  assert.deepEqual(await D.loadDerivedBase('kid'), { 1: { a: 'y' }, 2: {} });
  assert.equal(D.derivedFrom('kid').syncedAt, 2000);
  D.forgetDerived('kid3');
  assert.equal(D.derivedFrom('kid3'), null, '新书删了');
  D.forgetDerived('mom');
  assert.equal(D.derivedFrom('kid'), null, '母本删了：从它做出来的都断线');
  assert.equal(D.derivedFrom('kid2'), null);
  assert.equal(D.derivedFrom(''), null);
  await Promise.resolve();
  assert.deepEqual([...memory.keys()], [], '断了线的，每笔的记录也一起删');
});

await test('每笔的 id 和指纹不放 localStorage：一本几百上千笔的书那一份有几百 KB，localStorage 一共就几兆', async () => {
  localStorage.removeItem('ls_pdf_derived');
  memory.clear();
  D.resetDerivedCache();
  const big = {};
  for (let page = 1; page <= 29; page++) {
    big[page] = {};
    for (let i = 0; i < 800; i++) big[page]['s' + page + 'x' + i + 'abcdef'] = 'abcdefg.1hh';
  }
  await D.recordDerived('kid', { source: 'mom', pages: Array.from({ length: 29 }, (_, i) => i + 1), base: big });
  const stored = localStorage.getItem('ls_pdf_derived');
  assert.ok(stored.length < 1000, 'localStorage 里只有 ' + stored.length + ' 个字');
  assert.equal(Object.keys((await D.loadDerivedBase('kid'))[29]).length, 800);
});

await test('第一版放在 localStorage 里的那一份：读到时搬进去，搬完 localStorage 里就不留了', async () => {
  memory.clear();
  localStorage.setItem('ls_pdf_derived', JSON.stringify({
    old: { source: 'mom', pages: [3, 6], base: { 1: { a: 'x' } }, syncedAt: 5 },
  }));
  D.resetDerivedCache();
  assert.deepEqual(D.derivedFrom('old'), { source: 'mom', pages: [3, 6], syncedAt: 5 });
  assert.deepEqual(await D.loadDerivedBase('old'), { 1: { a: 'x' } }, '搬的时候也读得到');
  await D.derivedMigration();
  assert.deepEqual(memory.get('old'), { 1: { a: 'x' } });
  assert.equal(JSON.parse(localStorage.getItem('ls_pdf_derived')).old.base, undefined);
  assert.deepEqual(await D.loadDerivedBase('old'), { 1: { a: 'x' } });
});

await test('存成新书：带批注才拷笔迹、记下这一次拷了哪几笔；不带也记下母本是谁', () => {
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const body = ui.slice(ui.indexOf('async function runSaveBookmarkBook'), ui.indexOf('function syncFromSource'));
  const guard = body.indexOf('if (withInk) {');
  assert.ok(guard > 0 && guard < body.indexOf('saveLayer(meta.id, i + 1'), '拷笔迹在「带上批注」里面');
  assert.ok(/base\[i \+ 1\] = syncBaseOf\(layer\.getAll\(\)\);/.test(body));
  assert.ok(/await recordDerived\(meta\.id, \{ source: source\.id, pages, base \}\);/.test(body));
  assert.ok(body.indexOf('recordDerived(') < body.indexOf('openResource('), '打开之前线已经接上：一打开 ⋯ 里就有「从母本更新」');
  assert.ok(/if \(source\.slot\) await workspace\?\.openResource\(meta\.id/.test(body), '从书架上做的不替人打开');
});

await test('从母本更新：先存两边的笔迹 → 一页页合 → 有改动先问 → 栏里就地换上再存 → 记下这一次', () => {
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const body = ui.slice(ui.indexOf('async function runSyncFromSource'));
  const steps = ['flushInkFor?.(link.source)', 'flushInkFor?.(id)', 'mergeFromSource(', 'chooseAction(',
    'replaceInkOnScreen?.(id, page, strokes)', 'saveLayer(id, page', 'updateDerivedBase(id, base);\r\n  setStatus(t(\'marksBook.syncDone\''.replace('\r\n', '\n')]
    .map((x) => body.indexOf(x));
  assert.ok(steps.every((v) => v > 0), String(steps));
  assert.deepEqual([...steps].sort((a, b) => a - b), steps, '次序不能乱：栏里那一层是旧的话，它下次自动保存会把更新盖回去');
  const none = body.slice(body.indexOf('if (!plan.length) {'), body.indexOf('const shown'));
  assert.ok(/updateDerivedBase\(id, base\);/.test(none) && /marksBook\.syncNone/.test(none), '没改动：不问，一句话');
  assert.ok(/if \(!parent\) \{\n    setStatus\(t\('marksBook\.syncGone'\), true\);/.test(body), '母本没了照实说');
  assert.ok(/workspace\.onSyncFromSource = \(target\) => syncFromSource\(target\);/.test(ui));
  assert.ok(/const was = await loadDerivedBase\(id\);/.test(body) && /mergeFromSource\(theirs\.getAll\(\), mine\.getAll\(\), was\[page\] \|\| \{\}\)/.test(body));
  assert.equal((body.match(/await updateDerivedBase\(id, base\);/g) || []).length, 2, '有改动、没改动两处都等它写完');
  assert.ok(/derivedFrom\(item\.id\)\) actions\.push\(\{ id: 'sync', label: t\('marksBook\.syncMenu'\) \}\)/.test(ui), '书架 ⋯ 里也有');
});

await test('书架上一本书的 ⋯：标过书签的书有「书签成书」（本子、草稿纸、组合没有），交给同一张单子', () => {
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const menu = ui.slice(ui.indexOf('async function openItemMenu'), ui.indexOf('async function moveItemToFolder'));
  assert.ok(/const marks = !isPad && !isNote && !isCombo \? loadBookmarks\(item\.id\) : \[\];/.test(menu));
  assert.ok(/if \(marks\.length\) actions\.push\(\{ id: 'marks-book', label: t\('marksBook\.menu'\) \}\);/.test(menu));
  assert.ok(/makeBookFromMarks\(\{ id: item\.id, name: item\.name, marks, slot: null \}\)/.test(menu));
  assert.ok(menu.indexOf("id: 'marks-book'") < menu.indexOf("id: 'delete'"), '危险的那条永远最后');
});

await test('本栏 ⋯ 里「从母本更新」只给有母本的书；删书时断线；栏里就地换的是同一个对象', () => {
  const ws = $read('src/pdf/pdf-workspace.js');
  assert.ok(/data-role="marks-sync" hidden/.test(ws));
  assert.ok(/on\('marks-sync', \(\) => \{ this\._closeSlotMenus\(\); this\.syncFromSourceSlot\(slot\); \}\)/.test(ws));
  assert.ok(/n\.hidden = !loaded \|\| !this\.canSyncFromSource\(slot\);/.test(ws));
  assert.ok(/entry\?\.kind === ENTRY_KINDS\.PDF && !!derivedFrom\(entry\.resourceId\)/.test(ws));
  const forget = ws.slice(ws.indexOf('  async forgetResource(resourceId) {'));
  assert.ok(forget.indexOf('forgetDerived(resourceId)') > 0 && forget.indexOf('forgetDerived(resourceId)') < 600);
  const pane = $read('src/pdf/pdf-pane.js');
  const replace = pane.slice(pane.indexOf('  replaceInk(documentId, page, strokes) {'));
  assert.ok(/if \(!this\.meta \|\| this\.meta\.id !== documentId \|\| this\._inkPage !== page\) return false;/.test(replace),
    '只换正显示着的那一页');
  assert.ok(/const layer = this\.ink\.getLayer\(\);\n    layer\.strokes = strokes\.slice\(\);\n    this\.ink\.loadLayer\(layer\);/.test(replace),
    '换手里那一层本身（另一栏拿的是同一个对象），撤销记录重来');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
