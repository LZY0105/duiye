#!/usr/bin/env node
// 导出 PDF：做出来的东西对不对，以及「要文件权限」的那一整套流程。
//
// 盯的是做错了当场看不出来的几件事：
//
//   **一、笔迹落在哪儿。** 书页可能转过 90°、可能带裁切框，屏幕上那一页的坐标是
//   pdf.js 按这两样算出来的。导出时反算错一点，批注就整片挪位——而且只在那几页上
//   挪，最难发现。所以这里用 pdf.js 自己给的视口当尺子：把画进 PDF 的点按 pdf.js 的
//   视口变换推回屏幕坐标，必须落回人下笔的地方。
//
//   **二、原书还是原书。** 字还取得出来（没被画成图），没写字的页一个算子都没多。
//
//   **三、要不到权限时的每一条路。** 开机只问一次；导出时再问；人去设置里开了、回来，
//   导出接着走、不用再点一遍；人不给，说清楚这个功能需要文件权限。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}\n     ${err?.stack?.split('\n').slice(0, 3).join('\n     ') || err}`);
  }
}

const ROOT = new URL('../', import.meta.url);
const $read = (f) => readFileSync(new URL(f, ROOT), 'utf-8');

// 对话框要 DOM，文案要 i18n。pdf.js 那几条不碰 DOM（关掉了 FontFace）。
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'localStorage', 'Event', 'KeyboardEvent']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}

const pdfLib = await import('pdf-lib');
const { PDFDocument, StandardFonts, degrees, decodePDFRawStream, PDFArray, PDFRawStream } = pdfLib;
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = new URL('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', ROOT).href;

const X = await import('../src/export/pdf-export.js');
const { initI18n, t } = await import('../src/core/i18n.js');
await initI18n();

/** pdf.js 读一份字节。给它一份拷贝：它会把传进去的那块内存转交给 worker，原数组就空了。 */
async function openWithPdfJs(bytes) {
  return pdfjs.getDocument({
    data: new Uint8Array(bytes).slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0,
  }).promise;
}

const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];
const near = (actual, expected, tol, label) => {
  assert.ok(Math.abs(actual[0] - expected[0]) <= tol && Math.abs(actual[1] - expected[1]) <= tol,
    `${label}: 期望 (${expected.map((v) => v.toFixed(2))})，实际 (${actual.map((v) => v.toFixed(2))})`);
};

/** 一笔。坐标是屏幕上那一页的坐标（pdf.js 1 倍视口）。 */
const stroke = (pts, extra = {}) => ({
  tool: 'pen', color: '#dc2626', width: 3, opacity: 1,
  points: pts.map(([x, y, p = 0.5]) => ({ x, y, p })),
  ...extra,
});
/** 点一下：一个点。它画出来是一个圆，第一段 `m` 落在 (x + r, y)。 */
const dot = (x, y) => stroke([[x, y]]);

/** 一段内容流解码成文本。存盘时它们都压过（FlateDecode），直接读是一串乱码。 */
function streamText(doc, ref) {
  const stream = doc.context.lookup(ref);
  const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  return new TextDecoder().decode(bytes);
}

/** 一页最后接上的那一段内容流。 */
function lastContent(doc, pageIndex) {
  const page = doc.getPages()[pageIndex];
  const contents = page.node.Contents();
  const arr = contents instanceof PDFArray ? contents : null;
  return streamText(doc, arr ? arr.get(arr.size() - 1) : page.node.get(pdfLib.PDFName.of('Contents')));
}

/** 内容流里的 cm 矩阵和第一个 m 的坐标。 */
function firstMove(text) {
  const cm = text.match(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/);
  const m = text.match(/\n(-?[\d.]+) (-?[\d.]+) m\n/);
  return { cm: cm.slice(1).map(Number), m: [Number(m[1]), Number(m[2])] };
}

// 四页：不转、90°、180°、270°，后三页都带一个偏移的裁切框。每一页写一行字。
async function sampleBook({ encrypted = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const specs = [
    { size: [595, 842] },
    { size: [600, 800], rotate: 90, crop: [20, 30, 540, 710] },
    { size: [612, 792], rotate: 180, crop: [36, 18, 500, 700] },
    { size: [500, 700], rotate: 270, crop: [10, 40, 470, 600] },
    { size: [595, 842] },
  ];
  specs.forEach((s, i) => {
    const page = doc.addPage(s.size);
    if (s.rotate) page.setRotation(degrees(s.rotate));
    if (s.crop) page.setCropBox(...s.crop);
    page.drawText(`Page ${i + 1} words`, { x: 80, y: 300, size: 18, font });
  });
  if (encrypted) {
    // pdf-lib 加不了密，但只要 trailer 里有 /Encrypt，它读回来就认为这是加了密的。
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 }));
  }
  return doc.save();
}

// ═══════════════════════════════════════════════════════════════
group('颜色');

await test('色板的 #rrggbb、带透明度的 #rrggbbaa 和 rgba()', () => {
  assert.deepEqual(X.parseColor('#ff0000'), { r: 1, g: 0, b: 0, a: 1 });
  const c = X.parseColor('#11182780');
  assert.ok(Math.abs(c.a - 128 / 255) < 1e-9);
  assert.deepEqual(X.parseColor('#fff'), { r: 1, g: 1, b: 1, a: 1 });
  const r = X.parseColor('rgba(255, 0, 0, 0.5)');
  assert.deepEqual([r.r, r.g, r.b, r.a], [1, 0, 0, 0.5]);
});

await test('认不出的颜色当黑色画——一笔画成黑的，好过这一笔没了', () => {
  assert.deepEqual(X.parseColor('not-a-colour'), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(X.parseColor(undefined), { r: 0, g: 0, b: 0, a: 1 });
});

// ═══════════════════════════════════════════════════════════════
group('坐标：和 pdf.js 的视口逐页对照');

const book = await sampleBook();

await test('每一页（转过的、裁过的）算出来的视口变换都和 pdf.js 给的一样', async () => {
  const lib = await PDFDocument.load(book);
  const js = await openWithPdfJs(book);
  for (let n = 1; n <= js.numPages; n++) {
    const page = await js.getPage(n);
    const theirs = page.getViewport({ scale: 1 }).transform;
    const { view, rotate } = X.pageViewOf(lib.getPages()[n - 1]);
    const ours = X.viewportTransform(view, rotate);
    ours.forEach((v, i) => assert.ok(Math.abs(v - theirs[i]) < 1e-9,
      `第 ${n} 页第 ${i} 项：pdf.js ${theirs[i]}，这里 ${v}`));
    assert.deepEqual(view, page.view, `第 ${n} 页的 view`);
    assert.equal(rotate, page.rotate, `第 ${n} 页的 rotate`);
  }
});

await test('逆变换是真的逆：推过去再推回来是同一个点', () => {
  for (const rotate of [0, 90, 180, 270]) {
    const m = X.viewportTransform([13, 27, 580, 790], rotate);
    const inv = X.invertTransform(m);
    for (const p of [[0, 0], [100, 250], [333.3, 12.5]]) near(apply(m, apply(inv, p)), p, 1e-9, `rotate ${rotate}`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('书：原文件加一层笔迹');

const inked = await X.buildBookPdf({
  bytes: book,
  pages: [
    { pageNumber: 1, strokes: [dot(100, 120), stroke([[50, 60], [150, 70], [250, 60]])] },
    { pageNumber: 2, strokes: [dot(30, 40)] },
    { pageNumber: 3, strokes: [dot(200, 300)] },
    { pageNumber: 4, strokes: [dot(410, 55)] },
  ],
});

await test('画进去的点，按 pdf.js 的视口推回去，正落在人下笔的地方——四个方向都是', async () => {
  const lib = await PDFDocument.load(inked);
  const js = await openWithPdfJs(inked);
  const expected = { 1: [100, 120], 2: [30, 40], 3: [200, 300], 4: [410, 55] };
  for (const n of [1, 2, 3, 4]) {
    const { cm, m } = firstMove(lastContent(lib, n - 1));
    const viewport = (await js.getPage(n)).getViewport({ scale: 1 }).transform;
    // 第一段 m 是圆的最右点 (x + r, y)，r = 钢笔 3 宽的一半。
    const r = 1.5;
    const screen = apply(viewport, apply(cm, m));
    near(screen, [expected[n][0] + r, expected[n][1]], 0.05, `第 ${n} 页`);
  }
});

await test('原书的字还在，而且还是字——不是被画成了图', async () => {
  const js = await openWithPdfJs(inked);
  for (let n = 1; n <= 5; n++) {
    const text = await (await js.getPage(n)).getTextContent();
    assert.ok(text.items.some((i) => i.str.includes(`Page ${n} words`)), `第 ${n} 页的字`);
  }
  assert.equal(js.numPages, 5, '页数不变');
});

await test('没写字的那一页，一个绘制算子都没多', async () => {
  const before = await (await (await openWithPdfJs(book)).getPage(5)).getOperatorList();
  const after = await (await (await openWithPdfJs(inked)).getPage(5)).getOperatorList();
  assert.deepEqual(after.fnArray, before.fnArray);
});

await test('原来的内容整个包进 q … Q，笔迹接在最后——原书没配对的变换漏不到笔迹上', async () => {
  const lib = await PDFDocument.load(inked);
  const page = lib.getPages()[0];
  const arr = page.node.Contents();
  assert.ok(arr instanceof PDFArray && arr.size() >= 3);
  const first = streamText(lib, arr.get(0)).trim();
  assert.equal(first, 'q', '最前面是 q');
  assert.ok(/ cm\n/.test(lastContent(lib, 0)), '最后一段是笔迹');
});

await test('加了密的书不硬写：交给「逐页画成图」那条路', async () => {
  const locked = await sampleBook({ encrypted: true });
  await assert.rejects(
    X.buildBookPdf({ bytes: locked, pages: [{ pageNumber: 1, strokes: [dot(1, 1)] }] }),
    (e) => e.message === X.EXPORT_ERRORS.ENCRYPTED);
});

await test('读不懂的文件也交给那条路，而不是抛一个谁也接不住的错', async () => {
  await assert.rejects(
    X.buildBookPdf({ bytes: new TextEncoder().encode('not a pdf at all'), pages: [] }),
    (e) => e.message === X.EXPORT_ERRORS.UNREADABLE);
});

await test('进度一页报一次，只报有笔迹的页', async () => {
  const seen = [];
  await X.buildBookPdf({
    bytes: book,
    pages: [{ pageNumber: 2, strokes: [dot(5, 5)] }, { pageNumber: 3, strokes: [] }, { pageNumber: 9, strokes: [dot(1, 1)] }],
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.deepEqual(seen, [[1, 1]], '空的那一页、不存在的第 9 页都不算');
});

// ═══════════════════════════════════════════════════════════════
group('每一种笔翻成什么');

const MAT = [1, 0, 0, -1, 0, 842];

await test('钢笔：一条路径填一次（非零环绕），完全不透明就不设透明度', () => {
  const { content, states } = X.inkOps([stroke([[10, 10], [40, 20], [80, 10]])], MAT);
  assert.ok(/\nf\n/.test(content), '填充');
  assert.ok(!/\bS\n/.test(content), '不描边');
  assert.equal(states.size, 0);
  assert.ok(content.startsWith('q\n1 0 0 -1 0 842 cm'), '先整体换到 PDF 的坐标');
});

await test('荧光笔：等宽描一次边、圆头圆角、正片叠底、0.35 的透明度', () => {
  const { content, states } = X.inkOps([stroke([[10, 10], [40, 20], [80, 10]],
    { tool: 'highlighter', color: '#facc15', width: 16, opacity: 0.35 })], MAT);
  assert.ok(/\n16 w\n1 J\n1 j\n/.test(content));
  assert.ok(/\nS\n/.test(content));
  assert.ok(/ c\n/.test(content), '中间那段是曲线，和屏幕上一样平滑');
  const [spec] = [...states.values()];
  assert.deepEqual(spec, { alpha: 0.35, blend: 'Multiply' });
});

await test('铅笔：外圈淡、内芯深两遍，都按纸纹平均盖掉的那一截减淡', () => {
  const { states } = X.inkOps([stroke([[10, 10], [40, 20]], { tool: 'pencil', color: '#111827', opacity: 0.72 })], MAT);
  const alphas = [...states.values()].map((s) => s.alpha).sort((a, b) => a - b);
  assert.deepEqual(alphas, [
    Math.round(0.72 * 0.30 * 0.73 * 1000) / 1000,
    Math.round(0.72 * 0.95 * 0.73 * 1000) / 1000,
  ]);
});

await test('点一下是一个实心圆，不是一条长度为零的线', () => {
  const { content } = X.inkOps([dot(50, 50)], MAT);
  assert.equal((content.match(/ c\n/g) || []).length, 4, '四段贝塞尔');
  assert.ok(/\nh\nf\n/.test(content));
});

await test('带填充的形状：先填、再画边，填充带自己的透明度', () => {
  const shape = stroke([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], { fill: '#2563eb80' });
  const { content, states } = X.inkOps([shape], MAT);
  const fillAt = content.indexOf(' rg\n0 0 m');
  const edgeAt = content.lastIndexOf('\nf\n');
  assert.ok(fillAt > 0 && fillAt < edgeAt, '填充在描边之前');
  assert.ok([...states.values()].some((s) => Math.abs(s.alpha - 128 / 255) < 0.002), '填充的半透明');
});

await test('一笔都没有：什么都不写（不往页面上接一段空的）', () => {
  assert.equal(X.inkOps([], MAT).content, '');
  assert.equal(X.inkOps([{ tool: 'pen', points: [] }], MAT).content, '');
});

// ═══════════════════════════════════════════════════════════════
group('笔记本、草稿纸、逐页画成图');

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQIHWP8+uEZAwMD49cPzxgYGAAvvAWZacAbrwAAAABJRU5ErkJggg==', 'base64'));
const JPEG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAADAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9/KKKKAP/2Q==', 'base64'));

await test('笔记本：页数和屏幕上一样（没写的页也在），每页 A4，写过的那页有笔迹', async () => {
  const bytes = await X.buildNotebookPdf({
    pageCount: 3,
    size: { width: 595, height: 842 },
    paper: { color: X.parseColor('#f6f1e3'), png: PNG },
    strokesFor: async (n) => (n === 2 ? [dot(100, 200)] : []),
  });
  const js = await openWithPdfJs(bytes);
  assert.equal(js.numPages, 3);
  for (let n = 1; n <= 3; n++) {
    const page = await js.getPage(n);
    assert.deepEqual(page.view, [0, 0, 595, 842]);
    const ops = await page.getOperatorList();
    assert.ok(ops.fnArray.includes(pdfjs.OPS.paintImageXObject), `第 ${n} 页铺了纸样`);
    assert.equal(ops.fnArray.includes(pdfjs.OPS.fill), n === 2, `第 ${n} 页${n === 2 ? '有' : '没有'}笔迹`);
  }
  const lib = await PDFDocument.load(bytes);
  const { cm, m } = firstMove(lastContent(lib, 1));
  const viewport = (await js.getPage(2)).getViewport({ scale: 1 }).transform;
  near(apply(viewport, apply(cm, m)), [101.5, 200], 0.05, '本子上的那一点');
});

await test('白纸不画底色；有颜色的纸铺一整页的纸色', async () => {
  const white = await X.buildNotebookPdf({
    pageCount: 1, size: { width: 595, height: 842 }, paper: { color: X.parseColor('#ffffff') }, strokesFor: async () => [],
  });
  const whiteOps = await (await (await openWithPdfJs(white)).getPage(1)).getOperatorList();
  assert.ok(!whiteOps.fnArray.includes(pdfjs.OPS.fill), '白纸什么都不画');
  const tinted = await X.buildNotebookPdf({
    pageCount: 1, size: { width: 595, height: 842 }, paper: { color: X.parseColor('#f6f1e3') }, strokesFor: async () => [],
  });
  const tintedOps = await (await (await openWithPdfJs(tinted)).getPage(1)).getOperatorList();
  assert.ok(tintedOps.fnArray.includes(pdfjs.OPS.fill), '米色纸铺一层底色');
});

await test('草稿纸：一页，大小是笔迹的范围加一圈白；笔迹原样落在里面', async () => {
  const strokes = [dot(1000, 500), stroke([[1200, 700], [1300, 720]])];
  const box = X.scratchPageBox(strokes);
  assert.ok(box.width > 300 && box.height > 220 && box.scale === 1);
  const bytes = await X.buildScratchPdf({ strokes, box, paper: { color: X.parseColor('#ffffff') } });
  const js = await openWithPdfJs(bytes);
  assert.equal(js.numPages, 1);
  const page = await js.getPage(1);
  assert.ok(Math.abs(page.view[2] - box.width) < 0.01 && Math.abs(page.view[3] - box.height) < 0.01);
  const lib = await PDFDocument.load(bytes);
  const { cm, m } = firstMove(lastContent(lib, 0));
  const pdfPoint = apply(cm, m);
  near(pdfPoint, [1001.5 - box.x0, box.y1 - 500], 0.05, '草稿纸上的那一点');
});

await test('画得极开的草稿纸整体缩小放进一页，而不是切掉一块', () => {
  const box = X.scratchPageBox([dot(0, 0), dot(40000, 100)]);
  assert.ok(box.width <= 14400 && box.scale < 1);
  assert.equal(X.scratchPageBox([]), null, '一笔都没有就没有范围');
});

await test('逐页画成图：每页一张图，页的大小照原书', async () => {
  const bytes = await X.buildRasterPdf({
    pageCount: 2,
    rasterPage: async (n) => ({ width: n === 1 ? 595 : 842, height: n === 1 ? 842 : 595, jpeg: JPEG }),
  });
  const js = await openWithPdfJs(bytes);
  assert.equal(js.numPages, 2);
  assert.deepEqual((await js.getPage(2)).view, [0, 0, 842, 595]);
  const ops = await (await js.getPage(1)).getOperatorList();
  assert.ok(ops.fnArray.includes(pdfjs.OPS.paintImageXObject));
});

await test('文件名：文件系统不认的字符换掉、开头的点去掉、书加「（批注）」', () => {
  assert.equal(X.exportFileName('谢惠民 数学分析.pdf', '（批注）'), '谢惠民 数学分析（批注）.pdf');
  assert.equal(X.exportFileName('a/b:c*d?"e"<f>|g'), 'a b c d e f g.pdf');
  assert.equal(X.exportFileName('...hidden'), 'hidden.pdf');
  assert.equal(X.exportFileName(''), 'Duiye.pdf');
  assert.ok(X.exportFileName('长'.repeat(200)).length <= 84);
});

// ═══════════════════════════════════════════════════════════════
group('写文件：一块一块过桥');

/** 一个假的原生插件：记下每一次调用，权限由测试说了算。 */
function fakePlugin({ granted = true } = {}) {
  const calls = [];
  const written = [];
  const api = {
    granted,
    calls,
    written,
    async hasPermission() { calls.push('has'); return { granted: api.granted }; },
    async requestPermission() { calls.push('request'); return { opened: true }; },
    async beginExport({ name }) {
      calls.push(`begin:${name}`);
      if (!api.granted) { const e = new Error('all-files access has not been granted'); e.code = 'NO_PERMISSION'; throw e; }
      return { token: 't1' };
    },
    async appendExport({ token, data }) { calls.push(`append:${token}`); written.push(Buffer.from(data, 'base64')); },
    async finishExport({ token }) { calls.push(`finish:${token}`); return { name: 'out.pdf', folder: 'Documents/对页', path: '/x/out.pdf' }; },
    async abortExport({ token }) { calls.push(`abort:${token}`); },
  };
  window.Capacitor = { Plugins: { PdfFiles: api } };
  return api;
}
const noPlugin = () => { delete window.Capacitor; };

const files = await import('../src/pdf/pdf-files.js');

await test('七兆的文件分三块写，拼回来一个字节不差', async () => {
  const api = fakePlugin();
  const bytes = new Uint8Array(7 * 1024 * 1024 + 123).map((_, i) => (i * 31) % 251);
  const progress = [];
  const saved = await files.writeExportFile(bytes, 'big.pdf', { onProgress: (d, t2) => progress.push([d, t2]) });
  assert.equal(saved.name, 'out.pdf');
  assert.equal(api.calls.filter((c) => c.startsWith('append')).length, 3);
  assert.deepEqual(Buffer.concat(api.written), Buffer.from(bytes));
  assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
  noPlugin();
});

await test('原生那边说没权限：换成调用方认得的 NO_PERMISSION', async () => {
  fakePlugin({ granted: false });
  await assert.rejects(files.writeExportFile(new Uint8Array(10), 'x.pdf'),
    (e) => e.message === files.FILES_ERRORS.NO_PERMISSION);
  noPlugin();
});

await test('写到一半出错：放弃那个临时文件，不留半截', async () => {
  const api = fakePlugin();
  api.appendExport = async () => { throw new Error('disk full'); };
  await assert.rejects(files.writeExportFile(new Uint8Array(10), 'x.pdf'),
    (e) => e.message === files.FILES_ERRORS.WRITE_FAILED);
  assert.ok(api.calls.includes('abort:t1'));
  noPlugin();
});

// ═══════════════════════════════════════════════════════════════
group('文件权限：开机问一次，导出时再问');

const perm = await import('../src/export/export-permission.js');

const dialog = () => document.querySelector('.deck-overlay .deck-dialog');
const dialogTitle = () => dialog()?.querySelector('.deck-dialog-title')?.textContent || '';
/** 等对话框出来（它是异步摆上去的：先问了一次有没有权限）。 */
async function waitDialog() {
  for (let i = 0; i < 50; i++) {
    if (dialog()) return dialog();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('对话框没有出来');
}
const press = (sel) => dialog().querySelector(sel).click();
let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
/** 人离开应用去了设置，又回来。 */
function goToSettingsAndBack(api, grant) {
  visibility = 'hidden';
  document.dispatchEvent(new window.Event('visibilitychange'));
  api.granted = grant;
  visibility = 'visible';
  document.dispatchEvent(new window.Event('visibilitychange'));
}
const settle = () => new Promise((r) => setTimeout(r, 20));

await test('开机：没有权限就问一次，「以后再说」之后不再问', async () => {
  localStorage.clear();
  document.body.replaceChildren();
  fakePlugin({ granted: false });
  const said = [];
  const first = perm.introduceFilesPermission({ notify: (m) => said.push(m) });
  await waitDialog();
  assert.equal(dialogTitle(), t('permission.introTitle'));
  assert.equal(dialog().querySelector('[data-role="cancel"]').textContent, t('permission.later'),
    '不给的那颗按钮说「以后再说」，不是「取消」');
  press('[data-role="cancel"]');
  assert.equal(await first, true);
  assert.deepEqual(said, [t('permission.skipped')], '告诉人：不开也能用，导出时会再问');
  assert.equal(await perm.introduceFilesPermission({ notify: (m) => said.push(m) }), false, '第二次开机不再问');
  assert.equal(dialog(), null);
  noPlugin();
});

await test('开机：已经有权限、或者在浏览器里跑，什么都不问', async () => {
  localStorage.clear();
  document.body.replaceChildren();
  fakePlugin({ granted: true });
  assert.equal(await perm.introduceFilesPermission(), false);
  assert.equal(dialog(), null);
  localStorage.clear();
  noPlugin();
  assert.equal(await perm.introduceFilesPermission(), false);
});

await test('开机：「去开启」→ 去设置里开了 → 回来说一声已开启', async () => {
  localStorage.clear();
  document.body.replaceChildren();
  const api = fakePlugin({ granted: false });
  const said = [];
  const done = perm.introduceFilesPermission({ notify: (m) => said.push(m) });
  await waitDialog();
  press('.deck-action');
  await settle();
  assert.ok(api.calls.includes('request'), '送去了设置');
  goToSettingsAndBack(api, true);
  await done;
  assert.deepEqual(said, [t('permission.granted')]);
  noPlugin();
});

await test('导出：有权限直接放行，一个框都不弹', async () => {
  document.body.replaceChildren();
  fakePlugin({ granted: true });
  assert.equal(await perm.ensureExportPermission(), true);
  assert.equal(dialog(), null);
  noPlugin();
});

await test('导出：没权限就再问；人不给，告诉他这个功能需要文件权限', async () => {
  document.body.replaceChildren();
  fakePlugin({ granted: false });
  const said = [];
  const asked = perm.ensureExportPermission({ notify: (m) => said.push(m) });
  await waitDialog();
  assert.equal(dialogTitle(), t('export.permissionTitle'));
  press('[data-role="cancel"]');
  assert.equal(await asked, false);
  assert.deepEqual(said, [t('export.needsPermission')]);
  noPlugin();
});

await test('导出：去设置里开了、回来——接着导出，不用再点一遍', async () => {
  document.body.replaceChildren();
  const api = fakePlugin({ granted: false });
  let waited = 0;
  const asked = perm.ensureExportPermission({ onWaiting: () => { waited++; } });
  await waitDialog();
  press('.deck-action');
  await settle();
  assert.equal(waited, 1, '跳去设置那一刻提示「开了回来就接着导出」');
  goToSettingsAndBack(api, true);
  assert.equal(await asked, true);
  noPlugin();
});

await test('导出：去了设置却没开、回来——照实说需要权限', async () => {
  document.body.replaceChildren();
  const api = fakePlugin({ granted: false });
  const said = [];
  const asked = perm.ensureExportPermission({ notify: (m) => said.push(m) });
  await waitDialog();
  press('.deck-action');
  await settle();
  goToSettingsAndBack(api, false);
  assert.equal(await asked, false);
  assert.deepEqual(said, [t('export.needsPermission')]);
  noPlugin();
});

await test('导出：分屏里开的设置（应用一直看得见）——权限一出现就接着走', async () => {
  document.body.replaceChildren();
  const api = fakePlugin({ granted: false });
  const asked = perm.ensureExportPermission();
  await waitDialog();
  press('.deck-action');
  await settle();
  api.granted = true;   // 没有 visibilitychange，只是权限自己出现了
  const result = await Promise.race([asked, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  assert.equal(result, true);
  noPlugin();
});

await test('导出：问着的时候再点一次，不叠第二张单子', async () => {
  document.body.replaceChildren();
  fakePlugin({ granted: false });
  const a = perm.ensureExportPermission();
  const b = perm.ensureExportPermission();
  assert.equal(a, b);
  await waitDialog();
  assert.equal(document.querySelectorAll('.deck-overlay').length, 1);
  press('[data-role="cancel"]');
  await a;
  noPlugin();
});

await test('浏览器里跑：导出走浏览器下载，不需要这个权限', async () => {
  noPlugin();
  assert.equal(await perm.ensureExportPermission(), true);
});

// ═══════════════════════════════════════════════════════════════
group('接线');

await test('本栏 ⋯ 和书架 ⋯ 里都有「导出 PDF」；组合没有（它不是一份文件）', () => {
  const ws = $read('src/pdf/pdf-workspace.js');
  assert.ok(/data-role="export-pdf"/.test(ws));
  assert.ok(/on\('export-pdf'/.test(ws));
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  assert.ok(/if \(!isCombo\) actions\.push\(\{ id: 'export'/.test(ui));
});

await test('先问权限、再存下屏幕上没落盘的笔迹、再做、最后存', () => {
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const body = ui.slice(ui.indexOf('async function runExport'));
  const order = ['ensureExportPermission(', 'flushInkFor', 'buildExport(', 'writeExportFile('].map((s) => body.indexOf(s));
  assert.ok(order.every((v) => v > 0), '四步都在');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '次序不能乱：做完才发现存不进去是最糟的');
});

await test('开机那一问接在工作区起来之后，不挡开机', () => {
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const init = ui.slice(ui.indexOf('export async function initPdfWorkspace'));
  assert.ok(/introduceFilesPermission\(\{ notify: showSaveToast \}\)\.catch/.test(init), '不 await');
});

await test('原生插件：四个写文件的方法都在，开头先查权限，临时文件是隐藏的', () => {
  const java = $read('android/app/src/main/java/io/github/lzy0105/duiye/files/PdfFilesPlugin.java');
  for (const m of ['beginExport', 'appendExport', 'finishExport', 'abortExport']) {
    assert.ok(new RegExp(`public void ${m}\\(PluginCall call\\)`).test(java), m);
  }
  const begin = java.slice(java.indexOf('public void beginExport'));
  assert.ok(begin.indexOf('granted()') < begin.indexOf('mkdirs'), '先查权限');
  assert.ok(/new File\(dir, "\." \+ token \+ "\.part"\)/.test(java), '点开头：list() 和文件管理器都不列它');
  assert.ok(/MediaScannerConnection\.scanFile/.test(java), '写完告诉媒体库');
});

await test('三种语言都有导出和权限的字', () => {
  const keys = ['export.menu', 'export.done', 'export.needsPermission', 'export.permissionTitle',
    'export.waiting', 'permission.introTitle', 'permission.introNote', 'permission.later'];
  for (const lang of ['zh-CN', 'zh-TW', 'en']) {
    const pack = $read(`src/core/lang/${lang}.js`);
    for (const key of keys) assert.ok(pack.includes(`"${key}"`), `${lang} 少了 ${key}`);
  }
});

// 人说「导出 pdf 时启动速度有点慢，软件会卡死一会直到开始导出时才恢复」：一本几十上百兆的书，
// pdf-lib 整份读一遍、再整份写回去，原来都在主线程上。现在在后台线程里做。
await test('做 PDF 在后台线程里：三种都交过去，书的原文件转手不复制', async () => {
  const doc = $read('src/export/export-document.js');
  for (const job of ["'book'", "'notebook'", "'scratch'"]) {
    assert.ok(doc.includes(`inBackground(${job}`), `${job} 交给后台线程`);
  }
  assert.ok(/transferOf: \(input\) => bufferOf\(input\.bytes\)/.test(doc), '书的字节转手');
  // 后台线程用不了：重新读一份原文件，在主线程上照做（交过去的那一份已经空了）
  assert.ok(/const again = transferOf \? await inputFor\(\) : input;/.test(doc));
  const client = $read('src/export/export-worker-client.js');
  assert.ok(/new Worker\(new URL\('\.\/export-worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/.test(client));
});

await test('后台线程按同一套消息做出 PDF，做好的那一份整块交回', async () => {
  const posted = [];
  const prevSelf = globalThis.self;
  globalThis.self = { postMessage: (msg, transfer) => posted.push({ msg, transfer }) };
  try {
    await import(new URL('../src/export/export-worker.js', import.meta.url).href + '?t=' + Date.now());
    const strokes = [{ tool: 'pen', color: '#dc2626', width: 3, opacity: 1,
      points: [{ x: 10, y: 10, p: 0.5 }, { x: 80, y: 40, p: 0.5 }] }];
    await globalThis.self.onmessage({ data: { id: 7, job: 'notebook',
      input: { pageCount: 2, size: { width: 300, height: 400 }, paper: null, strokesByPage: { 2: strokes } } } });
    const done = posted.find((p) => p.msg.id === 7 && p.msg.bytes);
    assert.ok(done, '交回了字节');
    assert.equal(String.fromCharCode(...done.msg.bytes.slice(0, 5)), '%PDF-');
    assert.deepEqual(done.transfer, [done.msg.bytes.buffer], '整块交回，不复制');
    assert.ok(posted.some((p) => p.msg.id === 7 && p.msg.progress), '一路报进度');
    await globalThis.self.onmessage({ data: { id: 8, job: 'nope', input: {} } });
    assert.equal(posted.find((p) => p.msg.id === 8)?.msg.error, 'EXPORT_UNKNOWN_JOB');
  } finally {
    globalThis.self = prevSelf;
  }
});

await test('没有后台线程（Node 里、WebView 起不来）：说一声用不了，调用方照做', async () => {
  const { buildInWorker, WORKER_UNAVAILABLE } = await import('../src/export/export-worker-client.js');
  const prev = globalThis.Worker;
  delete globalThis.Worker;
  try {
    await assert.rejects(buildInWorker('book', {}), (error) => error.message === WORKER_UNAVAILABLE);
  } finally {
    if (prev) globalThis.Worker = prev;
  }
});

await test('pdf-lib 按需加载，不进开机那一包', () => {
  const src = $read('src/export/pdf-export.js');
  assert.ok(/import\('pdf-lib'\)/.test(src));
  assert.ok(!/^import .* from 'pdf-lib'/m.test(src));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
