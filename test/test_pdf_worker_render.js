#!/usr/bin/env node
// 渲染 worker 的回归测试。
//
// 这条路存在的唯一理由是性能：平板实测，同一次放大缩小，栅格化在主线程上时主线程
// rAF 间隔 p95 27ms、最坏 84ms；搬进 worker 之后 p95 9ms、最坏 9ms。渲染本身没变
// 快，只是不再占着主线程。
//
// 但它带来三个可以静默损坏的东西，这里就是守它们的：
//
//   1. 两条路（worker / 主线程回退）必须是同一个形状。调用方不知道自己在跟谁说
//      话，少一个方法就是运行时 undefined is not a function，而且只在回退时才犯。
//   2. 抽文本的实现必须只有一份。两份「差不多」的实现会让同一本书在两条路下对出
//      不同的题，没有任何地方会报错。
//   3. 默认给的是 bitmaprenderer 画布（零拷贝上屏），这种画布拿不到 2d 上下文。
//      谁要往页面上继续画，谁必须显式要 drawable —— 漏了就是缩略图上的批注没了。
//
// 还有一条：worker 必须是 classic 的。pdf.js 3.11 的 pdf.min.js 是 UMD 不是 ESM，
// 只能 importScripts 进来，而 module worker 里没有 importScripts。

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NO_OUTLINE, extractOutline, fragmentsFrom, textLinesFrom } from '../src/pdf/pdf-extract.js';
import { PDF_ERRORS } from '../src/pdf/pdf-errors.js';
import { workerRenderingAvailable } from '../src/pdf/pdf-worker-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const $read = (f) => readFileSync(join(ROOT, f), 'utf-8');
// 去掉注释再看。注释里正常会提到路径长什么样，那不是代码。
const $code = (f) => $read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const ok = (c, l, d) => { if (c) pass(l); else fail(l, d); };
const group = (n) => console.log(`\n─── [${n}] ───`);
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  PDF Worker Rendering Tests');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. 文件在位');

for (const f of [
  'src/pdf/pdf-extract.js',
  'src/pdf/pdf-errors.js',
  'src/pdf/pdf-render-worker.js',
  'src/pdf/pdf-worker-client.js',
]) {
  ok(existsSync(join(ROOT, f)), `${f} exists`);
}

// ═══════════════════════════════════════════════════════════════
group('2. 两条路是同一个形状');

const clientSource = $read('src/pdf/pdf-worker-client.js');
const docSource = $read('src/pdf/pdf-document.js');

// 调用方实际用到的那些（见 pdf-pane、page-panel、book-cover、answer-index、
// text-source、pdf-workspace、pdf-library）。任一条在 worker 那边漏掉，都是回退
// 时才暴露的运行时错误。
const SURFACE = ['numPages', 'getOutline', 'renderPage', 'pageText', 'extractText', 'pageSize', 'destroy'];
for (const name of SURFACE) {
  ok(clientSource.includes(name), `worker 那条路提供 ${name}`);
  ok(docSource.includes(name), `主线程那条路提供 ${name}`);
}

ok(
  /get outline\(\)/.test(clientSource) && /get outline\(\)/.test(docSource),
  '两条路都有 outline 这个「还没要过 / 要过了没有」的只读属性',
);

ok(
  clientSource.includes('PDF_ERRORS.PAGE_OUT_OF_RANGE')
  && clientSource.includes('PDF_ERRORS.OPEN_FAILED'),
  'worker 那条路抛的是同一套错误码',
);

// ═══════════════════════════════════════════════════════════════
group('3. 抽文本只有一份实现');

const workerSource = $read('src/pdf/pdf-render-worker.js');
// 注释里会正常提到 document.createElement、/vendor/… 这些，那不是代码。
const workerCode = $code('src/pdf/pdf-render-worker.js');
ok(
  workerSource.includes("from './pdf-extract.js'"),
  'worker 用的是共用的抽取实现，不是自己抄了一份',
);
ok(
  docSource.includes("from './pdf-extract.js'"),
  '主线程回退路径用的是同一份',
);
ok(
  !/LINE_TOLERANCE/.test(docSource) && !/LINE_TOLERANCE/.test(workerSource),
  '归行容差只在 pdf-extract.js 里有一个值',
);

check('归行按基线分组，行内从左到右', () => {
  // 同一行的三个碎片，到达顺序是乱的；上一行的 y 更大。
  const { lines, empty } = textLinesFrom([
    { text: '解方程', x: 120, y: 500 },
    { text: '1.', x: 40, y: 500.8 },      // 2.5 以内的漂移算同一行
    { text: '答案', x: 300, y: 500 },
    { text: '第一章', x: 40, y: 560 },
  ]);
  assert.equal(empty, false);
  assert.deepEqual(lines, ['第一章', '1.解方程答案']);
});

check('相隔够远的基线是两行', () => {
  const { lines } = textLinesFrom([
    { text: 'a', x: 0, y: 100 },
    { text: 'b', x: 0, y: 96 },
  ]);
  assert.deepEqual(lines, ['a', 'b']);
});

check('没有文字的页面如实报空', () => {
  assert.deepEqual(textLinesFrom([]), { lines: [], empty: true });
  assert.deepEqual(textLinesFrom(null), { lines: [], empty: true });
});

check('fragmentsFrom 只留下 text/x/y', () => {
  const out = fragmentsFrom([
    { str: '甲', transform: [1, 0, 0, 1, 12, 34], width: 9, fontName: 'g_d0_f1' },
    { str: '', transform: [1, 0, 0, 1, 0, 0] },      // 空串丢掉
    { str: '乙' },                                    // 没有 transform 也不能炸
  ]);
  assert.deepEqual(out, [{ text: '甲', x: 12, y: 34 }, { text: '乙', x: 0, y: 0 }]);
});

check('没有书签的文档报 available: false，绝不替它生成目录', async () => {
  const bare = { async getOutline() { return null; } };
  const empty = { async getOutline() { return []; } };
  return Promise.all([extractOutline(bare), extractOutline(empty)]).then(([a, b]) => {
    assert.deepEqual(a, NO_OUTLINE);
    assert.deepEqual(b, NO_OUTLINE);
  });
});

// ═══════════════════════════════════════════════════════════════
group('4. 零拷贝画布的代价：谁要画谁得说');

ok(
  clientSource.includes("getContext('bitmaprenderer')"),
  '默认走 bitmaprenderer，位图零拷贝上屏',
);
ok(
  /drawable/.test(clientSource) && /drawImage\(bitmap, 0, 0\)/.test(clientSource),
  'drawable 那条路真拷一次，换一张能拿 2d 上下文的画布',
);

const panelSource = $read('src/pdf/page-panel.js');
ok(
  /renderPage\([^)]*\{\s*drawable:\s*true\s*\}\s*\)/.test(panelSource),
  '缩略图要把批注画在页面上，所以它要的是 drawable 画布',
);
ok(
  panelSource.includes("canvas.getContext('2d')"),
  '——而它确实在那张画布上拿了 2d 上下文（上一条不是摆设）',
);

// book-cover 只调 toBlob，那个不需要 2d 上下文，所以它留在零拷贝这条路上。
const coverSource = $read('src/pdf/book-cover.js');
ok(
  !/renderPage\([^)]*drawable/.test(coverSource),
  '封面只做 toBlob，不必为它多拷一张整页位图',
);

// ═══════════════════════════════════════════════════════════════
group('5. worker 必须是 classic 的');

ok(
  /importScripts\(`\$\{ORIGIN\}\/vendor\/pdf\.min\.js`\)/.test(workerSource),
  'pdf.js 3.11 是 UMD，只能 importScripts 进来',
);
ok(
  !/new Worker\([^)]*type:\s*['"]module['"]/.test(clientSource),
  '所以构造 worker 时不能声明 type: module —— module worker 里没有 importScripts',
);
ok(
  /new Worker\(`\$\{ORIGIN\}\/vendor\/pdf\.worker\.min\.js`\)/.test(workerSource),
  'worker 里的 pdf.js 指向的是同一份 vendor 产物，版本不可能和主线程对不上',
);

// worker 的 base URL 是它自己的脚本地址，不是页面地址。真出过这个事：从 blob: 起
// 一个 worker 时，'/vendor/pdf.min.js' 解析不出来，importScripts 在第一行就抛
// SyntaxError。拼 ORIGIN 之后，无论 worker 从哪送进来都对。
ok(
  !/['"`]\/vendor\//.test(workerCode),
  'worker 里没有任何根相对的 /vendor/ 路径，全部拼在 ORIGIN 上',
);
ok(
  workerSource.includes('const ORIGIN = self.location.origin;'),
  '——而 ORIGIN 来自 worker 自己的 location，不是写死的',
);

// ═══════════════════════════════════════════════════════════════
group('6. document 桩只给 pdf.js 真正要的两样');

ok(
  /self\.document = \{ baseURI:.*fonts: self\.fonts \}/.test(workerSource),
  'baseURI 给 useWorkerFetch 判定，fonts 给 FontLoader，都是真东西',
);
ok(
  !/createElement/.test(workerCode),
  '桩里没有 createElement —— 画布走 canvasFactory，不是假装有 DOM',
);
ok(
  workerSource.includes('OffscreenCanvas'),
  '画布是 OffscreenCanvas',
);

// ═══════════════════════════════════════════════════════════════
group('7. 回退是完整的，不是残缺的');

ok(
  docSource.includes('openOnMainThread'),
  '主线程实现还在，没有被删掉',
);
ok(
  /catch \(cause\) \{[\s\S]{0,600}?openOnMainThread|openInWorker[\s\S]{0,900}?openOnMainThread/.test(docSource),
  'worker 打不开就落回主线程，而不是把文档打不开这件事报给用户',
);
ok(
  /console\.warn\('\[PDF\]/.test(docSource),
  '回退会留一行日志 —— 否则「为什么又卡了」永远查不出来',
);

check('宿主没有 Worker/OffscreenCanvas 时，这条路根本不走', () => {
  // Node 里三样都没有，正是回退要覆盖的情形。
  assert.equal(workerRenderingAvailable(), false);
});

check('错误码两边共用一份', () => {
  assert.equal(PDF_ERRORS.PAGE_OUT_OF_RANGE, 'PDF_PAGE_OUT_OF_RANGE');
  assert.equal(PDF_ERRORS.OPEN_FAILED, 'PDF_OPEN_FAILED');
  assert.equal(PDF_ERRORS.RUNTIME_MISSING, 'PDF_RUNTIME_MISSING');
});

// ═══════════════════════════════════════════════════════════════
group('8. 在飞的请求不会永远等下去');

ok(
  /addEventListener\('error'/.test(clientSource) && /pending/.test(clientSource),
  'worker 挂掉时，所有 pending 的请求都被 reject —— 否则界面只是再也不刷新',
);
ok(
  clientSource.includes('worker.terminate()'),
  'destroy 真的终止 worker：一本书一百多兆，靠垃圾回收等不起',
);
// ═══════════════════════════════════════════════════════════════
group('9. 页对象留一点，但有界');

// 放大缩小就是同一页换个 scale 重渲。每渲完就 cleanup 等于每次重解一遍图：平板上
// 同一页连渲 6 个缩放级别，每次都清是 646/548/495/492/561/490ms，留着页对象是
// 544/24/12/16/36/15ms。但「留」必须有界 —— 原来那句 cleanup 的理由（一本长书不能
// 把每一页的操作列表留到会话结束）一个字都没过时。
ok(
  /const PAGE_HOLD = \d+;/.test(workerSource),
  '保留的页数是一个写死的上限，不是「有多少留多少」',
);
ok(
  /heldPages\.delete\(oldest\)[\s\S]{0,240}?dropped\.cleanup\(\)/.test(workerSource),
  '被挤出去的那一页照样 cleanup —— 上限之外不留任何东西',
);
ok(
  /function releasePages\(\)[\s\S]{0,300}?cleanup\(\)/.test(workerSource)
  && /async close\(\) \{[\s\S]{0,80}?releasePages\(\)/.test(workerSource),
  '关文档时全部释放，不等垃圾回收',
);
// releasePages 里当然还有 cleanup，所以只看 render / text / size 三个 op 的函数体。
const renderOp = workerCode.slice(
  workerCode.indexOf('async render('), workerCode.indexOf('async text('));
ok(
  renderOp.length > 0 && !/cleanup\(/.test(renderOp)
  && /pageAt\(pageNumber\)/.test(renderOp),
  '渲完不再立刻 cleanup，页对象从 LRU 里拿 —— 那正是每次重解图的原因',
);
ok(
  $code('src/pdf/pdf-document.js').includes('page.cleanup()'),
  '主线程回退路径保持原样：它没有这个缓存，也就没有这个上限要守',
);

// ═══════════════════════════════════════════════════════════════
group('10. 解析 worker 由我们亲手起');

// pdf.js 自己起 worker 要读 window.location；worker 里没有 window，它就退到 fake
// worker，而 fake worker 用 document.createElement 插 <script>，于是整份文档打不
// 开。补一个 window 桩更糟：pdf.js 拿 `typeof window !== 'undefined'` 决定要不要用
// requestAnimationFrame 分块，而 worker 里没有那个函数 —— 扫描件一次画完看不出
// 来，矢量正文页分块时才炸。
ok(
  /new pdfjs\.PDFWorker\(\{ port:/.test(workerSource),
  '给 pdf.js 一个现成的 port，它就不会去碰 window.location',
);
ok(
  /worker: pdfWorker/.test(workerSource),
  '——而 getDocument 确实收下了它',
);
ok(
  !/self\.window|globalThis\.window|window =/.test(workerCode),
  'worker 里没有 window 桩，_useRequestAnimationFrame 才会是 false',
);
ok(
  /parsePort\.terminate\(\)/.test(workerSource),
  'port 是我们起的，所以也由我们关：PDFWorker.destroy 只关它自己起的那个',
);


console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
if (FAIL > 0) process.exit(1);
console.log('PASS: worker rendering keeps one shape, one extractor, and a complete fallback');
