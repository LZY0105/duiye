#!/usr/bin/env node
// 套索「识别」：给以后接进来的 OCR 留的那个口子，和圈一块 → 认 → 挑 → 复制 / 转成笔迹这一整段。
//
// 软件现在没有识别引擎，所以这里钉的是「接口长得对不对」和「界面在每一种结局下说的话对不对」：
//
//   1. 登记处：没有引擎时套索上没有「识别」、一切照旧；登记、撤销、换引擎时听的人知道；同一个引擎再登记一次不惊动谁；
//      认的时候进度只往前走、取消和等太久都把引擎那边的信号也掐掉，迟到的结果一律不要；引擎给的东西收拾干净再给界面。
//   2. 模拟引擎只在开发者模式开着、开关也开着时才在；它给的结果长得像真的（有框、有进度）。
//   3. 原生那一位（native-proxy 的 'ocr'）：报 ready 才登记；交下去的是 PNG；自建公式模型原样的回法也认得。
//   4. 排版：上下标、分式、根号、认不得的命令；骨架：一道杠是一条线、一个圈是一个闭合的环。
//   5. 套索：没套到笔迹的一圈留下当识别区域，条上只有「识别」；套到笔迹时「识别」排在删除前面；草稿纸（没有
//      「文件里的字」）上没有它。
//   6. 一整段：扫、进度、出结果（框完再浮出单子）、挑、复制、转成笔迹（一步撤销、写完是选中的）；取消、落笔、换圈、
//      Esc、引擎走了都算取消；没认出、认失败（能再试一次）、写不成笔迹各说各的话。
//   7. 样式表和词条：动画只动 transform / opacity；减少动态效果时都停；三种语言的词条一样多。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.stack || err.message}`); }
}
const $read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event', 'PointerEvent', 'KeyboardEvent',
  'getComputedStyle', 'localStorage']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};

// 剪贴板：记下写进去的东西。
const clipboard = [];
const fakeNavigator = { clipboard: { writeText: async (text) => { clipboard.push(text); } }, language: 'zh-CN' };
Object.defineProperty(globalThis, 'navigator', { value: fakeNavigator, configurable: true, writable: true });

// 词表要先装上（initI18n），t() 才查得到；setLang 遇到「已经是这个语言」什么都不做，单靠它装不上。
const { initI18n, currentLang } = await import('../src/core/i18n.js');
localStorage.setItem('latexsnipper-lang', 'zh-CN');
await initI18n();
assert.equal(currentLang(), 'zh-CN');

const service = await import('../src/ocr/ocr-service.js');
const {
  OCR_ERRORS, registerOcrProvider, unregisterOcrProvider, useOcrProvider, activeOcrProvider, ocrAvailable,
  onOcrAvailabilityChange, normalizeOcrItems, recognizeRegion, resetOcrProviders,
} = service;
const mock = await import('../src/ocr/ocr-mock.js');
const native = await import('../src/ocr/ocr-native.js');
const { parseLatex, layoutLatex, layoutText, tokenize } = await import('../src/ocr/latex-layout.js');
const { thin, tracePaths, simplifyPath, maskToPaths } = await import('../src/ocr/skeleton.js');
const { registerInkTypesetter, typesetToStrokes } = await import('../src/ocr/ink-typeset.js');
const { InkSurface } = await import('../src/ink/ink-surface.js');
const { SelectionBar, SELECTION_ACTIONS } = await import('../src/ink/ink-selection-bar.js');
const { INK_TOOLS, appendPoint, createStroke, recomputeBounds } = await import('../src/ink/stroke.js');

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** 一个由测试自己决定什么时候回话的引擎。 */
function controlledProvider(id = 'test', extra = {}) {
  const calls = [];
  const provider = {
    id,
    ...extra,
    recognize(request, ctx) {
      return new Promise((resolve, reject) => { calls.push({ request, ctx, resolve, reject }); });
    },
  };
  return { provider, calls, last: () => calls[calls.length - 1] };
}

// ═══════════════════════════════════════════════════════════════
group('1. 登记处');

await test('没有引擎：不能识别，认的时候说「没接」', async () => {
  resetOcrProviders();
  assert.equal(ocrAvailable(), false);
  assert.equal(activeOcrProvider(), null);
  await assert.rejects(recognizeRegion({}), { message: OCR_ERRORS.UNAVAILABLE });
});

await test('登记、换、撤：最后登记的在用；撤掉在用的那个，退回前一个；听的人每次变化都知道', async () => {
  resetOcrProviders();
  const heard = [];
  const off = onOcrAvailabilityChange((on) => heard.push(on));
  const a = { id: 'a', recognize: async () => ({ items: [] }) };
  const b = { id: 'b', recognize: async () => ({ items: [] }) };
  registerOcrProvider(a);
  registerOcrProvider(b);
  assert.equal(activeOcrProvider(), b);
  assert.equal(useOcrProvider('a'), true);
  assert.equal(activeOcrProvider(), a);
  assert.equal(useOcrProvider('nope'), false);
  unregisterOcrProvider('a');
  assert.equal(activeOcrProvider(), b, '撤掉在用的那个，退回还登记着的');
  unregisterOcrProvider('b');
  assert.equal(ocrAvailable(), false);
  assert.deepEqual(heard, [true, true, true, true, false]);
  off();
});

await test('同一个引擎原样再登记一次：什么都不变，也不惊动听的人', async () => {
  resetOcrProviders();
  const a = { id: 'a', recognize: async () => ({ items: [] }) };
  registerOcrProvider(a);
  let heard = 0;
  const off = onOcrAvailabilityChange(() => { heard++; });
  registerOcrProvider(a);
  useOcrProvider('a');
  assert.equal(heard, 0);
  off();
});

await test('撤销那一次登记：那个 id 已经被别的引擎换掉了，就什么都不做', async () => {
  resetOcrProviders();
  const first = { id: 'same', recognize: async () => ({ items: [] }) };
  const second = { id: 'same', recognize: async () => ({ items: [] }) };
  const undoFirst = registerOcrProvider(first);
  registerOcrProvider(second);
  undoFirst();
  assert.equal(activeOcrProvider(), second);
});

await test('长得不对的引擎登记不进来', async () => {
  assert.throws(() => registerOcrProvider({ id: 'x' }), TypeError);
  assert.throws(() => registerOcrProvider({ recognize() {} }), TypeError);
});

await test('引擎给的东西收拾干净：去空、去重、补 kind、信心夹到 0..1、坏框不要、编号', async () => {
  const items = normalizeOcrItems({
    items: [
      { kind: 'text', text: '  设  函数 \n f(x) ' },
      { kind: 'text', text: '设 函数 f(x)' },
      { latex: ' x^2 ', confidence: 1.7 },
      { kind: 'math', text: 'y=1', confidence: -3 },
      { kind: 'text', text: '' },
      null,
      { kind: 'text', text: 'a', box: { x: 1, y: 2, width: 'w', height: 4 } },
      { kind: 'text', latex: 'z', text: '' },
    ],
  });
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.text, i.latex, i.confidence]), [
    ['ocr-1', 'text', '设 函数 f(x)', '', null],
    ['ocr-2', 'math', 'x^2', 'x^2', 1],
    ['ocr-3', 'math', 'y=1', 'y=1', 0],
    ['ocr-4', 'text', 'a', '', null],
    ['ocr-5', 'text', 'z', '', null],
  ]);
  assert.equal(items[3].box, null, '框里有一项不是数，整个框不要');
  assert.deepEqual(normalizeOcrItems([{ text: 'q', box: { x: 0, y: 0, width: 3, height: 4 } }])[0].box,
    { x: 0, y: 0, width: 3, height: 4 }, '也收一个光秃秃的数组');
});

await test('进度只往前走、夹在 0..1；结果带上引擎名和用时', async () => {
  resetOcrProviders();
  registerOcrProvider({
    id: 'p',
    async recognize(_req, { onProgress }) {
      [0.2, 0.1, 0.5, Number.NaN, 2, 0.9].forEach((f) => onProgress(f));
      return { items: [{ kind: 'text', text: 'ok' }] };
    },
  });
  const seen = [];
  const result = await recognizeRegion({}, { onProgress: (f) => seen.push(f) });
  assert.deepEqual(seen, [0.2, 0.5, 1]);
  assert.equal(result.provider, 'p');
  assert.equal(result.items[0].text, 'ok');
  assert.ok(result.ms >= 0);
});

await test('取消：马上以 CANCELLED 结束，引擎那边的信号也掐掉；迟到的结果不要', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const controller = new AbortController();
  const pending = recognizeRegion({}, { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(pending, { message: OCR_ERRORS.CANCELLED });
  assert.equal(p.last().ctx.signal.aborted, true, '引擎得知道不用认了');
  p.last().resolve({ items: [{ text: 'late' }] });
  await flush();
});

await test('已经取消了才来认：一开始就是 CANCELLED，引擎碰都不碰', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recognizeRegion({}, { signal: controller.signal }), { message: OCR_ERRORS.CANCELLED });
  assert.equal(p.calls.length, 0);
});

await test('等太久：TIMEOUT，引擎那边也掐掉', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  await assert.rejects(recognizeRegion({}, { timeoutMs: 15 }), { message: OCR_ERRORS.TIMEOUT });
  assert.equal(p.last().ctx.signal.aborted, true);
});

await test('引擎自己出错（同步抛、异步拒绝都算）：FAILED，原来的错挂在 cause 上', async () => {
  resetOcrProviders();
  const boom = new Error('model missing');
  registerOcrProvider({ id: 'sync', recognize() { throw boom; } });
  await assert.rejects(recognizeRegion({}), (err) => err.message === OCR_ERRORS.FAILED && err.cause === boom);
  registerOcrProvider({ id: 'async', recognize: async () => { throw boom; } });
  await assert.rejects(recognizeRegion({}), (err) => err.message === OCR_ERRORS.FAILED && err.cause === boom);
});

// ═══════════════════════════════════════════════════════════════
group('2. 模拟引擎');

/** 模拟引擎慢慢报进度（一秒半）：测试里让它的计时器当场到点。 */
async function fastTimers(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => real(cb, 0);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}

await test('开发者模式和开关都开着才登记；任何一样关了就撤', async () => {
  resetOcrProviders();
  localStorage.clear();
  mock.setMockOcrEnabled(true);
  assert.equal(mock.mockOcrSwitchOn(), true);
  assert.equal(ocrAvailable(), false, '开发者模式没开：开关记着，但不登记');
  localStorage.setItem('ls_dev', '1');
  mock.syncMockOcr();
  assert.equal(activeOcrProvider()?.id, mock.MOCK_OCR_ID);
  assert.equal(activeOcrProvider().mock, true, '单子上要标「模拟」');
  localStorage.setItem('ls_dev', '0');
  mock.syncMockOcr();
  assert.equal(ocrAvailable(), false, '关了开发者模式，模拟识别跟着撤');
  localStorage.setItem('ls_dev', '1');
  mock.syncMockOcr();
  mock.setMockOcrEnabled(false);
  assert.equal(ocrAvailable(), false);
  localStorage.clear();
});

await test('给的结果像真的：有进度走到头、每条有框、扁长的一条给两条', async () => {
  const progress = [];
  const tall = await fastTimers(() => mock.mockOcrProvider.recognize(
    { image: { width: 800, height: 400 }, scale: 2 }, { onProgress: (f) => progress.push(f) }));
  assert.equal(progress.at(-1), 1);
  assert.equal(tall.items.length, 3);
  assert.ok(tall.items.every((i) => i.box && i.box.width > 0 && i.box.height > 0));
  assert.ok(tall.items.some((i) => i.kind === 'math') && tall.items.some((i) => i.kind === 'text'));
  const flat = await fastTimers(() => mock.mockOcrProvider.recognize({ image: { width: 900, height: 120 }, scale: 2 }));
  assert.equal(flat.items.length, 2);
});

await test('圈得太小：什么都没认出；取消了就停', async () => {
  const tiny = await fastTimers(() => mock.mockOcrProvider.recognize({ image: { width: 30, height: 10 }, scale: 2 }));
  assert.deepEqual(tiny.items, []);
  const controller = new AbortController();
  const pending = mock.mockOcrProvider.recognize({ image: { width: 800, height: 400 }, scale: 2 },
    { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
});

// ═══════════════════════════════════════════════════════════════
group('3. 原生那一位');

await test('describe 里 ocr 报 ready 才算接上', async () => {
  assert.equal(native.nativeOcrReady(null), false);
  assert.equal(native.nativeOcrReady({ loaded: false, services: [{ name: 'ocr', ready: true }] }), false);
  assert.equal(native.nativeOcrReady({ loaded: true, services: [{ name: 'ocr', ready: false, reason: 'UNIMPLEMENTED' }] }), false);
  assert.equal(native.nativeOcrReady({ loaded: true, services: [{ name: 'agent', ready: true }] }), false);
  assert.equal(native.nativeOcrReady({ loaded: true, services: [{ name: 'ocr', ready: true }] }), true);
});

await test('自建公式模型原样的回法：整块一个公式；没写完的标不准；EMPTY 当没认出；也收网页那种 items', async () => {
  const done = native.mapNativeResult({ latex: ' \\frac{1}{2} ', endedWithEos: true, meanLogProbability: -0.05, reasonCodes: ['MODEL_NOT_REALWORLD_VALIDATED'] });
  assert.equal(done.items.length, 1);
  assert.equal(done.items[0].kind, 'math');
  assert.equal(done.items[0].latex, '\\frac{1}{2}');
  assert.ok(Math.abs(done.items[0].confidence - Math.exp(-0.05)) < 1e-9);
  assert.equal(done.items[0].box, undefined, '整块就是它，不另画框');
  const unfinished = native.mapNativeResult({ latex: 'x^{2', endedWithEos: false, meanLogProbability: -0.01 });
  assert.ok(unfinished.items[0].confidence < 0.6, '没写完的要打「?」');
  assert.equal(native.mapNativeResult({ latex: 'x', reasonCodes: ['NO_EOS'] }).items[0].confidence < 0.6, true);
  assert.deepEqual(native.mapNativeResult({ latex: '', reasonCodes: ['EMPTY'] }).items, []);
  assert.deepEqual(native.mapNativeResult({ latex: 'x', reasonCodes: ['EMPTY'] }).items, []);
  assert.deepEqual(native.mapNativeResult({ items: [{ text: 'a' }] }).items, [{ text: 'a' }]);
  assert.deepEqual(native.mapNativeResult(null).items, []);
});

await test('交下去的是 PNG（不带 data: 前缀）和尺寸；进度照 chunk 报；取消时原生那边也撤', async () => {
  const submitted = [];
  const cancelled = [];
  let emit = () => {};
  globalThis.Capacitor = {
    Plugins: {
      NativeProxy: {
        addListener(name, handler) { if (name === 'proxyEvent') emit = handler; return Promise.resolve({ remove() {} }); },
        submit(call) { submitted.push(call); return Promise.resolve(); },
        cancel(call) { cancelled.push(call); return Promise.resolve(); },
        describe: async () => ({ loaded: true, services: JSON.stringify({ services: [{ name: 'ocr', ready: true }] }) }),
      },
    },
  };
  try {
    const image = { width: 320, height: 96, toDataURL: () => 'data:image/png;base64,UE5H' };
    const progress = [];
    const pending = native.nativeOcrProvider.recognize(
      { image, scale: 2, pageNumber: 7, mode: 'auto', lang: 'zh-CN' }, { onProgress: (f) => progress.push(f) });
    await flush();
    assert.equal(submitted.length, 1);
    const call = submitted[0];
    assert.equal(call.service, 'ocr');
    assert.equal(call.op, 'recognize');
    assert.deepEqual(call.payload, {
      image: 'UE5H', format: 'png-base64', width: 320, height: 96, scale: 2, pageNumber: 7, mode: 'auto', lang: 'zh-CN',
    });
    emit({ requestId: call.requestId, kind: 'chunk', data: JSON.stringify({ progress: 0.4 }) });
    emit({ requestId: call.requestId, kind: 'done', data: JSON.stringify({ latex: 'a+b', endedWithEos: true, meanLogProbability: -0.1 }) });
    const result = await pending;
    assert.deepEqual(progress, [0.4]);
    assert.equal(result.items[0].latex, 'a+b');

    const controller = new AbortController();
    const second = native.nativeOcrProvider.recognize({ image, scale: 2 }, { signal: controller.signal });
    second.catch(() => {});
    await flush();
    controller.abort();
    await flush();
    assert.equal(cancelled.length, 1, '人取消了，原生那边也该停');
    assert.equal(cancelled[0].requestId, submitted[1].requestId);
  } finally {
    delete globalThis.Capacitor;
  }
});

await test('开机那次探测：ocr 报 ready 才登记原生识别', async () => {
  const app = $read('src/core/app.js');
  const probe = app.slice(app.indexOf('function probeNativeProxy'));
  assert.ok(/import\('\.\.\/ocr\/ocr-native\.js'\)/.test(probe), '原生识别按需加载，不进开机那一包');
  assert.ok(probe.indexOf('nativeOcrReady(description)') < probe.indexOf('registerNativeOcr()'));
  resetOcrProviders();
  native.registerNativeOcr();
  assert.equal(activeOcrProvider()?.id, native.NATIVE_OCR_ID);
  resetOcrProviders();
});

// ═══════════════════════════════════════════════════════════════
group('4. 排版和骨架');

/** 每个字 0.5em 宽：排版规则和真字体无关的那一部分。 */
const measure = (text, size) => [...String(text)].length * 0.5 * size;
const opsOf = (box, type) => box.ops.filter((op) => op.type === type);
const textOf = (box) => opsOf(box, 'text').map((op) => op.text).join('');

await test('拆词：命令、单个符号、花括号', async () => {
  const tokens = tokenize('\\frac{a}{b}+x_1');
  assert.ok(tokens.length >= 8);
  assert.ok(JSON.stringify(tokens).includes('frac'));
});

await test('上标：小一号、抬到基线上面；下标：落到基线下面', async () => {
  const sup = layoutLatex('x^2', measure);
  const two = opsOf(sup, 'text').find((op) => op.text === '2');
  assert.ok(two.size < 1 && two.y < 0, `上标 ${JSON.stringify(two)}`);
  const sub = layoutLatex('x_1', measure);
  const one = opsOf(sub, 'text').find((op) => op.text === '1');
  assert.ok(one.size < 1 && one.y > 0, `下标 ${JSON.stringify(one)}`);
});

await test('分式：一道横线，分子在上、分母在下，横线比两头都宽', async () => {
  const box = layoutLatex('\\frac{a}{b}', measure);
  const rules = opsOf(box, 'rule');
  assert.equal(rules.length, 1);
  const a = opsOf(box, 'text').find((op) => op.text === 'a');
  const b = opsOf(box, 'text').find((op) => op.text === 'b');
  assert.ok(a.y < rules[0].y && b.y > rules[0].y);
  assert.ok(rules[0].w >= 0.5);
});

await test('根号画成一条折线，带次数的次数小一号', async () => {
  const box = layoutLatex('\\sqrt[3]{x}', measure);
  assert.ok(opsOf(box, 'path').length >= 1);
  const three = opsOf(box, 'text').find((op) => op.text === '3');
  assert.ok(three && three.size < 1);
});

await test('希腊字母、函数名直立、\\left \\right 不出字、认不得的命令照名字写出来', async () => {
  const box = layoutLatex('\\lim_{x \\to 0} \\left( \\alpha + \\foo \\right)', measure);
  const text = textOf(box);
  assert.ok(text.includes('lim') && text.includes('α') && text.includes('→') && text.includes('foo'));
  assert.ok(!text.includes('left') && !text.includes('right'));
  const lim = opsOf(box, 'text').find((op) => op.text === 'lim');
  assert.equal(lim.italic, false, '函数名不斜');
  assert.ok(parseLatex('\\mathbb{R}'));
  assert.ok(textOf(layoutLatex('\\mathbb{R}', measure)).includes('ℝ'));
});

await test('函数名和自变量之间一个细空（\\sin x 不写成 sinx）；跟着括号、关系符就不空', async () => {
  const at = (latex, ch) => opsOf(layoutLatex(latex, measure), 'text').find((op) => op.text === ch).x;
  assert.ok(Math.abs(at(String.raw`\sin x`, 'x') - 1.67) < 1e-9, '「sin」1.5em 宽，再空 0.17em');
  assert.ok(Math.abs(at(String.raw`\sin(x)`, '(') - 1.5) < 1e-9, '括号紧挨着');
  assert.ok(Math.abs(at(String.raw`\sin\,x`, 'x') - 1.67) < 1e-9, '自己写了细空就不再加一个');
  const gap = (latex) => at(latex, '=') - at(latex, 'x');
  assert.ok(Math.abs(gap(String.raw`\sin x = 1`) - gap('x = 1')) < 1e-9, '后面的关系符照旧，不多不少');
  const y = at(String.raw`\lim_{x \to 0} y`, 'y');
  const zero = at(String.raw`\lim_{x \to 0} y`, '0');
  assert.ok(y - zero >= 0.35 + 0.17 - 1e-9, '带下标的函数名也空');
});

await test('一段文字：一行，直立；空的什么都不画', async () => {
  const box = layoutText('  设 函数 ', measure);
  assert.equal(opsOf(box, 'text')[0].text, '设 函数');
  assert.equal(layoutText('   ', measure).ops.length, 0);
});

/** 一张 w×h 的空白，画上几块墨。 */
function mask(w, h, paint) {
  const m = new Uint8Array(w * h);
  paint((x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) m[y * w + x] = 1; });
  return m;
}

await test('骨架：一道粗杠是一条线，两头到得了', async () => {
  const w = 60; const h = 20;
  const m = mask(w, h, (set) => { for (let y = 7; y < 13; y++) for (let x = 5; x < 55; x++) set(x, y); });
  const paths = maskToPaths(m, w, h);
  assert.equal(paths.length, 1);
  const xs = paths[0].map(([x]) => x);
  assert.ok(Math.min(...xs) <= 9 && Math.max(...xs) >= 50, `从 ${Math.min(...xs)} 到 ${Math.max(...xs)}`);
});

await test('骨架：一个圈是一条闭合的环；一个点是一个点', async () => {
  const w = 40; const h = 40;
  const ring = mask(w, h, (set) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - 20, y - 20);
      if (r >= 11 && r <= 15) set(x, y);
    }
  });
  const loops = maskToPaths(ring, w, h);
  assert.equal(loops.length, 1);
  const [first, last] = [loops[0][0], loops[0].at(-1)];
  assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) <= 2, `首尾接上：${first} … ${last}`);
  assert.ok(loops[0].length >= 8, '是一个环，不是几个点');
  // 2×2 的一团、半径三像素的圆点——「·」、i 上那一点、小数点就是这么大。原来的细化（Zhang–Suen）会把它整个剥光，
  // 现在细化留得住；万一哪一块拆完一个像素都没留下，maskToPaths 也会在它的重心补一个点。
  const dot = mask(10, 10, (set) => { set(4, 4); set(5, 4); set(4, 5); set(5, 5); });
  const dots = maskToPaths(dot, 10, 10);
  assert.equal(dots.length, 1);
  assert.ok(dots[0].every(([x, y]) => x >= 4 && x <= 6 && y >= 4 && y <= 6), `点在那一团里：${JSON.stringify(dots)}`);
  const two = mask(16, 16, (set) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (Math.hypot(x - 4, y - 4) <= 3.2 || Math.hypot(x - 11, y - 11) <= 3.2) set(x, y);
    }
  });
  assert.equal(maskToPaths(two, 16, 16).length, 2, '省略号那样几个点：一个都不能少');
});

await test('骨架：两像素粗的斜线、「×」的两条斜线都留得住（原来的细化把「/」整条剥光，写出来的「×」只剩「\\」）', async () => {
  const diag = mask(30, 30, (set) => { for (let i = 2; i < 27; i++) { set(i, 28 - i); set(i + 1, 28 - i); } });
  const lines = maskToPaths(diag, 30, 30);
  const pts = lines.flat();
  const span = (k) => Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k]));
  assert.ok(span(0) >= 20 && span(1) >= 20, `斜线还在：${JSON.stringify(lines)}`);
  // KaTeX 在浏览器里画出来的「×」（掩码原样抄下来）：「\」五像素粗，「/」四像素粗。
  const art = [
    '.##................................##.', '####..............................####', '.####............................####.',
    '.#####..........................####..', '..#####........................####...', '...#####......................####....',
    '....#####....................####.....', '.....#####..................####......', '......#####................####.......',
    '.......#####..............####........', '........#####............####.........', '.........#####..........####..........',
    '..........#####........####...........', '...........#####......####............', '............#####....####.............',
    '.............#####..####..............', '..............#########...............', '...............#######................',
    '................######................', '................######................', '...............########...............',
    '..............####.#####..............', '.............####...#####.............', '............####.....#####............',
    '...........####.......#####...........', '..........####.........#####..........', '.........####...........#####.........',
    '........####.............#####........', '.......####...............#####.......', '......####.................#####......',
    '.....####...................#####.....', '....####......................####....', '...####........................####...',
    '..####..........................####..', '.####............................####.', '####..............................####',
    '###................................##.',
  ];
  const w = art[0].length + 4;
  const h = art.length + 4;
  const times = mask(w, h, (set) => art.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') set(x + 2, y + 2); })));
  const strokesPts = maskToPaths(times, w, h).flat();
  // 四个角都得有笔：左上、右上、左下、右下。
  const corner = (cx, cy) => strokesPts.some(([x, y]) => Math.hypot(x - cx, y - cy) <= 6);
  assert.ok(corner(2, 2) && corner(w - 3, 2) && corner(2, h - 3) && corner(w - 3, h - 3), '「×」的四个角都写到了');
});

await test('骨架：十字分成几段，每段都碰到中间', async () => {
  const w = 41; const h = 41;
  const m = mask(w, h, (set) => {
    for (let y = 18; y <= 22; y++) for (let x = 2; x <= 38; x++) set(x, y);
    for (let x = 18; x <= 22; x++) for (let y = 2; y <= 38; y++) set(x, y);
  });
  const paths = maskToPaths(m, w, h);
  assert.ok(paths.length >= 2 && paths.length <= 4, `${paths.length} 段`);
  const near = ([x, y]) => Math.hypot(x - 20.5, y - 20.5) <= 3;
  assert.ok(paths.every((path) => path.some(near)), '每段都经过交叉点');
});

await test('细化只留一像素宽；化简把一条直线收成两头', async () => {
  const w = 30; const h = 12;
  const m = mask(w, h, (set) => { for (let y = 3; y < 9; y++) for (let x = 3; x < 27; x++) set(x, y); });
  const skel = thin(m, w, h);
  for (let x = 6; x < 24; x++) {
    let column = 0;
    for (let y = 0; y < h; y++) column += skel[y * w + x] ? 1 : 0;
    assert.ok(column <= 1, `第 ${x} 列有 ${column} 个点`);
  }
  assert.ok(tracePaths(skel, w, h).length >= 1);
  const straight = Array.from({ length: 20 }, (_, i) => [i, 5]);
  assert.deepEqual(simplifyPath(straight), [[0, 5], [19, 5]]);
  const corner = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]];
  assert.deepEqual(simplifyPath(corner), [[0, 0], [10, 0], [10, 10]], '拐角留着');
});

await test('没有画布的地方（jsdom）：说「没有画布」，不去要上下文', async () => {
  registerInkTypesetter(null);
  await assert.rejects(typesetToStrokes([{ kind: 'text', text: 'a' }], { em: 10 }), { message: 'TYPESET_NO_CANVAS' });
});

// ═══════════════════════════════════════════════════════════════
group('5. 套索那条小条');

const pressDown = (node) => node.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
const actionsOf = (bar) => [...bar.el.querySelectorAll('.ink-selection-row [data-action]')].map((b) => b.dataset.action);

await test('识别区域那一副：只有「识别」，叫得出名字', async () => {
  document.body.innerHTML = '<div class="host"></div>';
  const seen = [];
  const bar = new SelectionBar(document.querySelector('.host'), (action) => seen.push(action));
  bar.place({ minX: 10, minY: 10, maxX: 100, maxY: 60 }, { width: 800, height: 600 }, { mode: 'region' });
  assert.deepEqual(actionsOf(bar), [SELECTION_ACTIONS.RECOGNIZE]);
  assert.equal(bar.el.getAttribute('aria-label'), '识别这一块');
  assert.equal(bar.el.querySelector('.ink-selection-text').textContent, '识别');
  pressDown(bar.el.querySelector('[data-action="recognize"]'));
  assert.deepEqual(seen, [SELECTION_ACTIONS.RECOGNIZE]);
});

await test('套到笔迹：接了识别时「识别」排在删除前面，危险的那一颗还是最后；没接时和原来一样', async () => {
  document.body.innerHTML = '<div class="host"></div>';
  const bar = new SelectionBar(document.querySelector('.host'), () => {});
  const box = { minX: 10, minY: 10, maxX: 100, maxY: 60 };
  bar.place(box, { width: 800, height: 600 }, { mode: 'selection', colors: ['#000'], recognize: true });
  assert.deepEqual(actionsOf(bar), [SELECTION_ACTIONS.COPY, SELECTION_ACTIONS.CUT, SELECTION_ACTIONS.COLOR,
    SELECTION_ACTIONS.SIZE, SELECTION_ACTIONS.RECOGNIZE, SELECTION_ACTIONS.DELETE]);
  bar.place(box, { width: 800, height: 600 }, { mode: 'selection', colors: ['#000'], recognize: false });
  assert.deepEqual(actionsOf(bar), [SELECTION_ACTIONS.COPY, SELECTION_ACTIONS.CUT, SELECTION_ACTIONS.COLOR,
    SELECTION_ACTIONS.SIZE, SELECTION_ACTIONS.DELETE], '识别断开了，条跟着重搭');
});

// ═══════════════════════════════════════════════════════════════
group('6. 一整段：圈、认、挑、复制、转成笔迹');

/** jsdom 没有画布：要的不是画得对，是别在画的时候炸掉。 */
function stubContext() {
  return new Proxy({}, {
    get(target, key) {
      if (key === 'canvas') return null;
      if (!(key in target)) target[key] = () => {};
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

/** 一块书页上的画布：主人会把圈里那一块截给它（captureRegion），除非说了不给（草稿纸）。 */
function mount({ capture = true, captureImpl = null } = {}) {
  document.body.innerHTML = '<div class="host"></div>';
  const host = document.querySelector('.host');
  const canvas = document.createElement('canvas');
  canvas.getContext = () => stubContext();
  host.appendChild(canvas);
  const captures = [];
  const changes = [];
  const handlers = { onChange: () => changes.push(1) };
  if (captureImpl) handlers.captureRegion = captureImpl;
  else if (capture) {
    handlers.captureRegion = async (request) => {
      captures.push(request);
      const xs = request.polygon.map((p) => p.x);
      const ys = request.polygon.map((p) => p.y);
      const box = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
      return {
        image: { width: (box.maxX - box.minX) * 2, height: (box.maxY - box.minY) * 2 },
        scale: 2,
        box,
        pageNumber: 3,
      };
    };
  }
  const surface = new InkSurface(canvas, handlers);
  surface.resize(800, 600, 1);
  surface.setTransform(1, 0, 0);
  surface.setTool('lasso');
  return { surface, host, canvas, captures, changes };
}

function pointer(type, x, y) {
  return new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'pen', pressure: 0.5,
    clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1,
  });
}

/** 用笔圈一个方框。 */
function lasso(surface, x0, y0, x1, y1) {
  const c = surface.canvas;
  c.dispatchEvent(pointer('pointerdown', x0, y0));
  const steps = [[x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]];
  for (const [x, y] of steps) {
    const [px, py] = [c._lastX ?? x0, c._lastY ?? y0];
    for (let i = 1; i <= 6; i++) c.dispatchEvent(pointer('pointermove', px + ((x - px) * i) / 6, py + ((y - py) * i) / 6));
    c._lastX = x; c._lastY = y;
  }
  c.dispatchEvent(pointer('pointerup', x0, y0 + 2));
  delete c._lastX; delete c._lastY;
}

function line(surface, x, y, len = 40) {
  const stroke = createStroke({ tool: INK_TOOLS.PEN, color: '#000', width: 2 });
  appendPoint(stroke, x, y, 0.5, 0);
  appendPoint(stroke, x + len, y, 0.5, 0);
  surface.layer.add(stroke);
  return stroke;
}

const overlay = (host) => host.querySelector('.ink-recognize');
const $o = (host, role) => host.querySelector(`.ink-recognize [data-role="${role}"]`);
const barVisible = (surface) => !!surface._bar?.el?.classList.contains('is-visible');
const barActions = (surface) => [...surface._bar.el.querySelectorAll('[data-action]')].map((b) => b.dataset.action);

/** 圈一块空白、点「识别」，等到引擎被叫上。 */
async function startRecognition(env) {
  lasso(env.surface, 100, 100, 300, 200);
  pressDown(env.surface._bar.el.querySelector('[data-action="recognize"]'));
  await flush();
  await flush();
}

await test('没接识别：圈一块空白什么都不留，条也不出来（和原来一样）', async () => {
  resetOcrProviders();
  const env = mount();
  lasso(env.surface, 100, 100, 300, 200);
  assert.equal(env.surface.regionLoop, null);
  assert.equal(barVisible(env.surface), false);
  assert.equal(overlay(env.host), null, '没用到就不搭那一套界面');
});

await test('接了识别：圈一块空白（书上印的字）留下当识别区域，条上只有「识别」', async () => {
  resetOcrProviders();
  registerOcrProvider(controlledProvider().provider);
  const env = mount();
  lasso(env.surface, 100, 100, 300, 200);
  assert.ok(env.surface.regionLoop?.length >= 3);
  assert.equal(env.surface.selection.length, 0, '它不是选区：没有能搬的东西');
  assert.equal(barVisible(env.surface), true);
  assert.deepEqual(barActions(env.surface), [SELECTION_ACTIONS.RECOGNIZE]);
});

await test('草稿纸（没有「文件里的字」可截）：接了识别也没有识别区域、条上也没有「识别」', async () => {
  resetOcrProviders();
  registerOcrProvider(controlledProvider().provider);
  const env = mount({ capture: false });
  assert.equal(env.surface.canRecognize(), false);
  lasso(env.surface, 100, 100, 300, 200);
  assert.equal(env.surface.regionLoop, null);
  const s = line(env.surface, 150, 150);
  lasso(env.surface, 100, 100, 300, 200);
  assert.deepEqual(env.surface.selection, [s.id]);
  assert.ok(!barActions(env.surface).includes(SELECTION_ACTIONS.RECOGNIZE));
});

await test('点「识别」：截圈里那一块交给引擎；扫光、流动的圈线、小条上「正在识别…」和「取消」；套索那条让位', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  assert.equal(env.captures.length, 1);
  assert.ok(env.captures[0].polygon.length >= 3);
  const req = p.last().request;
  assert.equal(req.scale, 2);
  assert.equal(req.pageNumber, 3);
  assert.equal(req.mode, 'auto');
  assert.equal(req.lang, 'zh-CN');
  assert.ok(req.image.width > 0 && req.polygon.length >= 3);
  assert.deepEqual(req.strokes, [], '圈里没笔迹');
  const el = overlay(env.host);
  assert.equal(el.dataset.state, 'scanning');
  assert.ok(el.hasAttribute('data-lens-moving'), '告诉液态玻璃「有东西在动」，换便宜的那一版');
  assert.ok($o(env.host, 'outline').getAttribute('d').startsWith('M'));
  assert.ok(Number($o(env.host, 'band').getAttribute('height')) >= 28);
  assert.equal($o(env.host, 'label').textContent, '正在识别…');
  assert.equal($o(env.host, 'pill-close').textContent, '取消');
  assert.equal($o(env.host, 'retry').hidden, true);
  assert.equal($o(env.host, 'panel').hidden, true);
  assert.equal(barVisible(env.surface), false, '两样东西不挤在圈旁边');
  p.last().ctx.onProgress(0.42);
  assert.equal($o(env.host, 'label').textContent, '正在识别… 42%');
  p.last().ctx.onProgress(0.6);
  assert.equal($o(env.host, 'label').textContent, '正在识别… 60%', '百分比换掉，不是越接越长');
  env.surface.clearSelection();
});

await test('出结果：先在图上依次框出来，框完单子才浮上来；默认全选；没把握的打「?」', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  p.last().resolve({
    items: [
      { kind: 'text', text: '设函数 f(x) 连续', confidence: 0.95, box: { x: 10, y: 10, width: 300, height: 40 } },
      { kind: 'math', latex: 'x^2+y^2=r^2', confidence: 0.4, box: { x: 10, y: 80, width: 200, height: 50 } },
    ],
  });
  await flush();
  const el = overlay(env.host);
  assert.equal(el.dataset.state, 'results');
  assert.ok(!el.hasAttribute('data-lens-moving'), '不扫了就摘掉');
  const boxes = el.querySelectorAll('.ink-recognize-box');
  assert.equal(boxes.length, 2);
  assert.deepEqual([...boxes].map((b) => b.style.getPropertyValue('--i')), ['0', '1'], '一个接一个');
  // 框在屏幕上：截图 2 倍，圈从 (100,100) 起 → 第一条在 (105,105)、150×20。
  assert.deepEqual(['x', 'y', 'width', 'height'].map((k) => Number(boxes[0].getAttribute(k))), [105, 105, 150, 20]);
  const panel = $o(env.host, 'panel');
  assert.equal(panel.hidden, true, '框还没框完，单子先不出来');
  await flush(450);
  assert.equal(panel.hidden, false);
  await flush(30);
  assert.ok(panel.classList.contains('is-in'), '先摆好再加 is-in，浮上来的过渡才演得出来');
  assert.equal($o(env.host, 'title').textContent, '认出 2 条');
  assert.equal($o(env.host, 'tag').hidden, true, '不是模拟的就不标「模拟」');
  const rows = [...panel.querySelectorAll('.ink-recognize-row')];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.classList.contains('is-selected') && r.getAttribute('aria-selected') === 'true'));
  assert.equal(rows[0].querySelector('.ink-recognize-kind').textContent, '文字');
  assert.equal(rows[1].querySelector('.ink-recognize-kind').textContent, '公式');
  assert.equal(rows[0].querySelector('.ink-recognize-doubt').hidden, true);
  assert.equal(rows[1].querySelector('.ink-recognize-doubt').hidden, false);
  assert.equal($o(env.host, 'copy').textContent, '复制');
  assert.equal($o(env.host, 'convert').textContent, '转为笔迹');
  env.surface.clearSelection();
});

await test('点一行选上 / 取消；一条都没挑时两颗按钮按不下去', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  p.last().resolve({ items: [{ kind: 'text', text: 'a' }, { kind: 'math', latex: 'b' }] });
  await flush();
  const rows = [...env.host.querySelectorAll('.ink-recognize-row')];
  assert.equal($o(env.host, 'panel').hidden, false, '没有框：不用等，当场浮出来');
  rows[0].click();
  assert.equal(rows[0].classList.contains('is-selected'), false);
  assert.equal($o(env.host, 'copy').disabled, false);
  rows[1].click();
  assert.equal($o(env.host, 'copy').disabled, true);
  assert.equal($o(env.host, 'convert').disabled, true);
  rows[1].click();
  assert.equal($o(env.host, 'convert').disabled, false);
  env.surface.clearSelection();
});

await test('复制：挑中的几条一行一条，公式写成 $LaTeX$；按钮上说一声「已复制」', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  p.last().resolve({ items: [{ kind: 'text', text: '设函数' }, { kind: 'math', latex: '\\frac{1}{2}' }, { kind: 'text', text: '不要' }] });
  await flush();
  env.host.querySelectorAll('.ink-recognize-row')[2].click();
  clipboard.length = 0;
  $o(env.host, 'copy').click();
  await flush();
  assert.deepEqual(clipboard, ['设函数\n$\\frac{1}{2}$']);
  assert.equal($o(env.host, 'copy').textContent, '已复制 2 条');
  assert.ok($o(env.host, 'copy').classList.contains('is-done'));
  assert.equal(overlay(env.host).dataset.state, 'results', '复制完单子还开着：人可能接着要转成笔迹');
  env.surface.clearSelection();
});

await test('改一条认错的：回车算数、改完还是选上的；Esc 不改，也不把单子关了', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  p.last().resolve({ items: [{ kind: 'math', latex: 'x^3' }] });
  await flush();
  const row = env.host.querySelector('.ink-recognize-row');
  row.click();
  row.querySelector('.ink-recognize-edit-btn').click();
  const input = row.querySelector('.ink-recognize-edit');
  assert.equal(input.hidden, false);
  assert.equal(input.value, 'x^3');
  input.value = 'x^2';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(input.hidden, true);
  assert.ok(row.classList.contains('is-selected'), '改过的那条就是要用的');
  clipboard.length = 0;
  $o(env.host, 'copy').click();
  await flush();
  assert.deepEqual(clipboard, ['$x^2$']);

  row.querySelector('.ink-recognize-edit-btn').click();
  input.value = 'garbage';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(overlay(env.host).dataset.state, 'results', '改字时的 Esc 只退出改字');
  clipboard.length = 0;
  $o(env.host, 'copy').click();
  await flush();
  assert.deepEqual(clipboard, ['$x^2$'], 'Esc 不改');
  env.surface.clearSelection();
});

await test('转为笔迹：写在圈下面、一步撤销、写完是选中的（套索线圈着），界面收起', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  let style = null;
  registerInkTypesetter(async (items, s) => {
    style = s;
    return {
      strokes: items.map((_, i) => {
        const stroke = createStroke({ tool: INK_TOOLS.PEN, color: s.color, width: s.width });
        appendPoint(stroke, 0, i * 20, 0.5, 0);
        appendPoint(stroke, 50, i * 20, 0.5, 0);
        recomputeBounds(stroke);
        return stroke;
      }),
      width: 50,
      height: 20,
    };
  });
  try {
    const env = mount();
    env.surface.setColor?.('#2563eb');
    await startRecognition(env);
    p.last().resolve({ items: [{ kind: 'text', text: 'a', box: { x: 0, y: 0, width: 100, height: 40 } }, { kind: 'math', latex: 'b' }] });
    await flush();
    const before = env.surface.layer.strokes.length;
    const changes = env.changes.length;
    $o(env.host, 'convert').click();
    await flush();
    const added = env.surface.layer.strokes.slice(before);
    assert.equal(added.length, 2);
    assert.equal(style.em, 16, '字高照书上的：框高 40 像素、截图 2 倍 → 20，取八成');
    assert.ok(added.every((s) => s.points[0].x === 100), '左边对齐圈的左沿');
    assert.ok(added.every((s) => s.points[0].y > 200), '写在圈的下面，不压着原文');
    assert.deepEqual(env.surface.selection, added.map((s) => s.id), '写完是选中的：接着就能拖、缩放、换色');
    assert.ok(env.surface.selectionLoop?.length === 4);
    assert.equal(env.surface.regionLoop, null);
    assert.equal(overlay(env.host).dataset.state, 'idle');
    assert.ok(env.changes.length > changes, '多了东西要存盘');
    env.surface.undo();
    assert.equal(env.surface.layer.strokes.length, before, '一步撤销整个收回');
  } finally {
    registerInkTypesetter(null);
  }
});

await test('写不成笔迹（没有画布）：小条上说「没能写成笔迹」，不给「再试一次」，书上什么都不多', async () => {
  resetOcrProviders();
  registerInkTypesetter(null);
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  p.last().resolve({ items: [{ kind: 'text', text: 'a' }] });
  await flush();
  $o(env.host, 'convert').click();
  await flush();
  assert.equal(overlay(env.host).dataset.state, 'error');
  assert.equal($o(env.host, 'label').textContent, '没能写成笔迹');
  assert.equal($o(env.host, 'retry').hidden, true);
  assert.equal(env.surface.layer.strokes.length, 0);
  env.surface.clearSelection();
});

await test('取消：引擎那边停下，界面收起，识别区域留着（可以再点一次）', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  $o(env.host, 'pill-close').click();
  await flush();
  assert.equal(p.last().ctx.signal.aborted, true);
  assert.equal(overlay(env.host).dataset.state, 'idle');
  assert.ok(env.surface.regionLoop, '识别区域还在');
  assert.equal(barVisible(env.surface), true, '条回来了，还能再点「识别」');
  p.last().resolve({ items: [{ text: 'late' }] });
  await flush();
  assert.equal(overlay(env.host).dataset.state, 'idle', '取消以后才回来的结果不要');
});

await test('Esc 取消；结果开着时 Esc 关单子', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  assert.equal(p.last().ctx.signal.aborted, true);
  assert.equal(overlay(env.host).dataset.state, 'idle');
  pressDown(env.surface._bar.el.querySelector('[data-action="recognize"]'));
  await flush(); await flush();
  p.last().resolve({ items: [{ text: 'a' }] });
  await flush();
  assert.equal(overlay(env.host).dataset.state, 'results');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(overlay(env.host).dataset.state, 'idle');
});

await test('笔又落到纸上、又圈了一块、翻页换工具（clearSelection）：都算取消', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  env.canvas.dispatchEvent(pointer('pointerdown', 500, 500));
  env.canvas.dispatchEvent(pointer('pointerup', 500, 500));
  assert.equal(p.last().ctx.signal.aborted, true);
  assert.equal(overlay(env.host).dataset.state, 'idle');

  await startRecognition(env);
  env.surface.clearSelection();
  assert.equal(p.last().ctx.signal.aborted, true);
  assert.equal(env.surface.regionLoop, null);
  assert.equal(overlay(env.host).dataset.state, 'idle');
});

await test('引擎走了：认着的取消，识别区域也不要了，条收起', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  unregisterOcrProvider(p.provider.id);
  assert.equal(p.last().ctx.signal.aborted, true);
  assert.equal(env.surface.regionLoop, null);
  assert.equal(overlay(env.host).dataset.state, 'idle');
  assert.equal(barVisible(env.surface), false);
});

await test('没认出：小条上说一句，不跳了，按钮是「知道了」', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  p.last().resolve({ items: [{ text: '   ' }] });
  await flush();
  assert.equal(overlay(env.host).dataset.state, 'empty');
  assert.equal($o(env.host, 'label').textContent, '这一块没认出文字或公式');
  assert.ok($o(env.host, 'pill').classList.contains('is-still'));
  assert.equal($o(env.host, 'pill-close').textContent, '知道了');
  assert.equal($o(env.host, 'retry').hidden, true);
  $o(env.host, 'pill-close').click();
  assert.equal(overlay(env.host).dataset.state, 'idle');
});

await test('认失败：说「识别没成功」，能「再试一次」，再试就重新扫', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  p.last().reject(new Error('boom'));
  await flush();
  assert.equal(overlay(env.host).dataset.state, 'error');
  assert.equal($o(env.host, 'label').textContent, '识别没成功');
  assert.equal($o(env.host, 'retry').hidden, false);
  assert.equal($o(env.host, 'retry').textContent, '再试一次');
  $o(env.host, 'retry').click();
  await flush(); await flush();
  assert.equal(p.calls.length, 2);
  assert.equal(overlay(env.host).dataset.state, 'scanning');
  env.surface.clearSelection();
});

await test('截不出图（书页一直画不完）：15 秒后说「等太久了」，能再试一次；引擎碰都没碰', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount({ captureImpl: () => new Promise(() => {}) });
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...rest) => real(cb, ms >= 15000 ? 0 : ms, ...rest);
  try {
    await startRecognition(env);
    await flush(); await flush();
  } finally {
    globalThis.setTimeout = real;
  }
  assert.equal(overlay(env.host).dataset.state, 'error');
  assert.equal($o(env.host, 'label').textContent, '等太久了，没认完');
  assert.equal($o(env.host, 'retry').hidden, false);
  assert.equal(p.calls.length, 0);
  env.surface.clearSelection();
});

await test('圈在书页外面：说「没认出」，不说「没认成」', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount({ captureImpl: async () => { throw new Error('CAPTURE_OUTSIDE_PAGE'); } });
  await startRecognition(env);
  assert.equal(overlay(env.host).dataset.state, 'empty');
  assert.equal($o(env.host, 'label').textContent, '这一块没认出文字或公式');
  assert.equal($o(env.host, 'retry').hidden, true);
  env.surface.clearSelection();
});

await test('套到笔迹时也能认：圈里的笔迹以矢量交给引擎', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  const env = mount();
  const s = line(env.surface, 150, 150);
  lasso(env.surface, 100, 100, 300, 200);
  assert.deepEqual(env.surface.selection, [s.id]);
  assert.equal(env.surface.regionLoop, null, '套到了笔迹就是选区，不是识别区域');
  pressDown(env.surface._bar.el.querySelector('[data-action="recognize"]'));
  await flush(); await flush();
  assert.equal(p.last().request.strokes.length, 1);
  env.surface.clearSelection();
});

await test('模拟引擎的结果：单子上标「模拟」', async () => {
  resetOcrProviders();
  const p = controlledProvider('fake', { mock: true });
  registerOcrProvider(p.provider);
  const env = mount();
  await startRecognition(env);
  p.last().resolve({ items: [{ text: 'a' }] });
  await flush();
  assert.equal($o(env.host, 'tag').hidden, false);
  assert.equal($o(env.host, 'tag').textContent, '模拟');
  env.surface.clearSelection();
  resetOcrProviders();
});

// ═══════════════════════════════════════════════════════════════
group('7. 样式表、开关和词条');

const css = $read('src/styles/ink-recognize.css');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

await test('样式表在笔迹栏那份后面引入', async () => {
  const main = $read('src/main.js');
  const a = main.indexOf("import './styles/ink-toolbar.css';");
  const b = main.indexOf("import './styles/ink-recognize.css';");
  assert.ok(a > 0 && b > a);
});

await test('动画只动 transform / translate / opacity / stroke-dashoffset：不碰排版', async () => {
  const body = noComments(css);
  const frames = [...body.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\}\s*\}/g)];
  assert.ok(frames.length >= 4, `${frames.length} 段动画`);
  for (const [, name, inner] of frames) {
    const props = [...inner.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    for (const prop of props) {
      assert.ok(['transform', 'translate', 'opacity', 'stroke-dashoffset'].includes(prop), `${name} 动了 ${prop}`);
    }
  }
});

await test('减少动态效果：扫光、圈线、框、行、小圆点都停', async () => {
  const body = noComments(css);
  const reduced = body.slice(body.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const sel of ['.ink-recognize-band', '.ink-recognize-outline', '.ink-recognize-box', '.ink-recognize-row',
    '.ink-recognize-dots i', '.ink-recognize-panel']) {
    assert.ok(reduced.includes(sel), `${sel} 没管`);
  }
  assert.ok(body.includes('.ink-recognize.is-reduced .ink-recognize-band'), '系统设置读得到时 JS 也挂一个类');
});

await test('液态玻璃：小条和单子和套索那条一起是透明的玻璃，只按 data-glass 挑；纸里单子是一张纸条', async () => {
  const lgr = noComments($read('src/styles/liquid-glass-react.css'));
  assert.ok(lgr.includes('html[data-glass="liquid"] .ink-recognize-pill'));
  assert.ok(lgr.includes('html[data-glass="liquid"] .ink-recognize-panel'));
  assert.ok(lgr.includes('html[data-glass="liquid"].lgr-busy .ink-recognize-panel'), '手在屏幕上换便宜的那一版');
  assert.ok(!/data-skin[^{]*ink-recognize/.test(lgr));
  const paper = noComments($read('src/styles/paper.css'));
  assert.ok(paper.includes('html[data-skin="minimal"] .ink-recognize-panel'));
  assert.ok(!noComments(css).includes('data-skin'), '基础样式只用变量，不按皮肤挑');
});

await test('开发者选项里有「预览识别」那颗开关，接在设置里', async () => {
  const html = $read('index.html');
  const content = html.slice(html.indexOf('id="devOptionsContent"'));
  assert.ok(content.indexOf('id="devOcrMock"') > 0);
  assert.ok(content.includes('data-i18n="dev.ocrMock"'));
  const settings = $read('src/settings/settings.js');
  assert.ok(/getElementById\('devOcrMock'\)/.test(settings));
  assert.ok(settings.includes('setMockOcrEnabled(ocrMock.checked)'));
  assert.ok((settings.match(/syncMockOcr\(\)/g) || []).length >= 2, '开机一次、开发者模式变了一次');
});

await test('三种语言的识别词条一样多、占位符一样', async () => {
  const keysOf = async (lang) => (await import(`../src/core/lang/${lang}.js`)).default;
  const dicts = { 'zh-CN': await keysOf('zh-CN'), 'zh-TW': await keysOf('zh-TW'), en: await keysOf('en') };
  const ocrKeys = (d) => Object.keys(d).filter((k) => k.startsWith('ocr.') || k === 'dev.ocrMock').sort();
  const base = ocrKeys(dicts['zh-CN']);
  assert.ok(base.length >= 25);
  for (const lang of ['zh-TW', 'en']) assert.deepEqual(ocrKeys(dicts[lang]), base, lang);
  for (const key of ['ocr.resultsTitle', 'ocr.copied']) {
    for (const lang of Object.keys(dicts)) assert.ok(dicts[lang][key].includes('{{count}}'), `${lang} ${key}`);
  }
  const used = new Set([...$read('src/ink/ink-recognize.js').matchAll(/t\('(ocr\.[\w]+)'/g)].map((m) => m[1]));
  for (const key of used) assert.ok(base.includes(key), `用了没定义：${key}`);
});

// ═══════════════════════════════════════════════════════════════
group('8. 公式用 KaTeX 排、照书上的大小写、能放大缩小');

// 人在平板上试了真的识别以后说：转成笔迹显示的不该是 LaTeX，要是正常的公式；有些符号认对了、写出来却不对；写出来的要大小
// 合适，也要能放大缩小。原因是写成笔迹用的是自己的小排版（认不得的命令照名字写出来），和单子上 KaTeX 的预览不是一个东西。

const katexInk = await import('../src/ocr/katex-ink.js');
const { printedExtent } = await import('../src/ocr/ink-typeset.js');
const katexLib = await katexInk.loadKatex();

/** 只在上下文里才有意义的命令（\hline 在表格里、\limits 跟在运算符后面、\kern 后面跟尺寸……），单独试不出来，照这样试。 */
const IN_CONTEXT = {
  '\\begin{subarray}': String.raw`\sum_{\begin{subarray}{c} i \\ j \end{subarray}} x`,
  '\\genfrac': String.raw`\genfrac{(}{)}{0pt}{}{n}{k}`,
  '\\hline': String.raw`\begin{array}{c} a \\ \hline b \end{array}`,
  '\\hskip': String.raw`a \hskip 1em b`,
  '\\kern': String.raw`a \kern 1em b`,
  '\\mskip': String.raw`a \mskip 3mu b`,
  '\\mspace': String.raw`a \mspace{3mu} b`,
  '\\rule': String.raw`\rule{1em}{0.1em}`,
  '\\limits': String.raw`\sum\limits_{i} x`,
  '\\nolimits': String.raw`\sum\nolimits_{i} x`,
  '\\buildrel': String.raw`\buildrel \alpha \over =`,
  '\\raise': String.raw`x \raise 1ex \hbox{y}`,
  '\\lower': String.raw`x \lower 1ex \hbox{y}`,
};

function samplesFor(cmd) {
  if (IN_CONTEXT[cmd]) return [IN_CONTEXT[cmd]];
  if (cmd.startsWith('\\begin{')) {
    const env = cmd.slice(7, -1);
    const spec = env === 'array' ? '{cc}' : '';
    return [`${cmd}${spec} a & b \\\\ c & d \\end{${env}}`, `${cmd}${spec} a \\end{${env}}`];
  }
  if (cmd === '\\left' || cmd === '\\right' || cmd === '\\middle') return ['\\left( a \\middle| b \\right)'];
  if (cmd === '\\\\') return ['\\begin{aligned} a \\\\ b \\end{aligned}'];
  if (cmd === '\\over' || cmd === '\\atop' || cmd === '\\choose') return [`{a ${cmd} b}`];
  return [cmd, `${cmd}{a}`, `${cmd}{a}{b}`, `${cmd}{a}{b}{c}`, `${cmd} a`, `x${cmd} y`, `${cmd}[a]{b}`];
}

const katexAccepts = (src) => {
  try {
    katexLib.renderToString(src, {
      throwOnError: true, displayMode: true, strict: 'ignore', macros: { ...katexInk.OCR_KATEX_MACROS },
    });
    return true;
  } catch (_) {
    return false;
  }
};

await test('模型词表里的每一个命令 KaTeX 都排得出来（它不认的那几个换成了意思一样的写法）', async () => {
  const { commands } = JSON.parse($read('test/fixtures/formula-ocr-commands.json'));
  assert.ok(commands.length >= 400, `${commands.length} 个命令`);
  const bad = commands
    .filter((cmd) => !cmd.startsWith('\\end{'))
    .filter((cmd) => !samplesFor(cmd).some((src) => katexAccepts(katexInk.repairLatex(src))));
  assert.deepEqual(bad, []);
});

await test('没写完的公式先补齐：括号、\\left、环境按次序关上；多出来的右括号、\\right 不要；两样 TeX 老写法换掉', () => {
  assert.equal(katexInk.repairLatex(String.raw`\frac{1}{2`), String.raw`\frac{1}{2}`);
  assert.equal(katexInk.repairLatex(String.raw`\left( x`), String.raw`\left( x\right.`);
  assert.equal(katexInk.repairLatex(String.raw`\begin{cases} x & y \\ z`), String.raw`\begin{cases} x & y \\ z\end{cases}`);
  assert.equal(katexInk.repairLatex(String.raw`\left( \begin{matrix} a`), String.raw`\left( \begin{matrix} a\end{matrix}\right.`,
    '从里往外关');
  assert.equal(katexInk.repairLatex('a } b'), 'a  b');
  assert.equal(katexInk.repairLatex(String.raw`\right) x`), 'x');
  assert.equal(katexInk.repairLatex(String.raw`\buildrel \alpha \over =`), String.raw`\stackrel{\alpha}{=}`);
  assert.equal(katexInk.repairLatex(String.raw`x \raise 1ex \hbox{y}`), String.raw`x  \hbox{y}`);
});

await test('KaTeX 还排不出来的地方删掉那一处、末尾缺参数的补一个空组：宁可少一个记号，也别整条变成红字', () => {
  const fit = (s) => katexInk.fitLatexForKatex(katexLib, s);
  assert.equal(fit('x^'), 'x');
  assert.equal(fit(String.raw`\frac{a}`), String.raw`\frac{a}{}`);
  assert.equal(fit(String.raw`\foo + 1`), '+ 1');
  assert.equal(fit(String.raw`\sqrt`), String.raw`\sqrt{}`);
  assert.ok(katexAccepts(fit(String.raw`a \limits b`)));
  const good = String.raw`\int_a^b f(x)\,dx = F(b)-F(a)`;
  assert.equal(fit(good), good, '排得出来的一个字不动');
});

await test('单子上的预览和写成笔迹是同一个排法：KaTeX 不认的命令换成意思一样的写法，不出红字', async () => {
  const el = document.createElement('div');
  katexInk.renderFormula(katexLib, String.raw`\upepsilon + \mbox{ok} + \textless + \prescript{a}{b}{X}`, el);
  assert.ok(el.querySelector('.katex'));
  assert.equal(el.querySelector('.katex-error'), null);
  assert.ok(/renderFormula\(katex, item\.latex, preview\)/.test($read('src/ink/ink-recognize.js')), '预览走它');
  assert.ok(/rasterizeFormula\(item\.latex \|\| item\.text\)/.test($read('src/ocr/ink-typeset.js')), '写成笔迹时公式先交给 KaTeX');
  assert.equal(await katexInk.rasterizeFormula('x^2'), null, '没有排版、没有 Path2D 的地方（jsdom）画不出来：退回自己的小排版');
});

await test('一笔里的尖角拆成两笔（笔迹沿中点画平滑曲线，拐直角的一笔会被抹成大圆弧，「+」就成了错开的两个弯）；弧线不拆', async () => {
  const { splitAtCorners } = await import('../src/ocr/skeleton.js');
  // 逐像素的 L：往下走 20 步，在交叉处斜着岔一步，再往右走 20 步（细化以后「+」拆出来的就是这样）。
  const down = Array.from({ length: 21 }, (_, i) => [10.5, 10.5 + i]);
  const right = Array.from({ length: 21 }, (_, i) => [11.5 + i, 31.5]);
  const pieces = splitAtCorners([...down, ...right]);
  assert.equal(pieces.length, 2, JSON.stringify(pieces.map((p) => [p[0], p.at(-1)])));
  const straight = (p) => p.every(([x]) => x === p[0][0]) || p.every(([, y]) => y === p.at(-1)[1]);
  assert.ok(pieces.every((p) => p.length >= 18), '每一笔都是整整一条臂');
  assert.ok(straight(pieces[0].slice(0, -1)) && straight(pieces[1].slice(1)), '拆开以后各是一条直线');
  // 半径 12 像素的半圆（逐像素走）：均匀地弯，不拆。
  const arc = [];
  for (let a = 0; a <= Math.PI; a += 1 / 12) arc.push([Math.round(30 + 12 * Math.cos(a)) + 0.5, Math.round(30 + 12 * Math.sin(a)) + 0.5]);
  assert.equal(splitAtCorners(arc).length, 1, '弧线一笔到底');
  assert.equal(splitAtCorners([[0.5, 0.5], [1.5, 1.5]]).length, 1);
});

await test('透明的颜色只认 alpha 为 0 的：\\phantom 的字不画，黑字照画', () => {
  assert.equal(katexInk.isTransparent('rgba(0, 0, 0, 0)'), true);
  assert.equal(katexInk.isTransparent('transparent'), true);
  assert.equal(katexInk.isTransparent('rgb(0, 0, 0)'), false, 'rgb 的第三个分量是蓝，不是透明度');
  assert.equal(katexInk.isTransparent('rgba(20, 20, 20, 0.6)'), false);
});

/** 一张假的截图：白底，几块深色。 */
function fakeImage(w, h, rects) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4;
        data[o] = 20; data[o + 1] = 20; data[o + 2] = 20;
      }
    }
  }
  return {
    width: w,
    height: h,
    getContext: () => ({
      getImageData: (x, y, cw, ch) => {
        const out = new Uint8ClampedArray(cw * ch * 4);
        for (let r = 0; r < ch; r++) out.set(data.subarray(((y + r) * w + x) * 4, ((y + r) * w + x + cw) * 4), r * cw * 4);
        return { data: out };
      },
    }),
  };
}

await test('书上那一条印出来多大：截图里深色像素的外框，换成文档坐标；给了框就只看框里', () => {
  const capture = { image: fakeImage(200, 100, [[40, 30, 160, 70]]), scale: 2, box: { minX: 100, minY: 50 } };
  assert.deepEqual(printedExtent(capture), { x: 120, y: 65, width: 60, height: 20 });
  const two = { image: fakeImage(200, 100, [[10, 10, 50, 30], [100, 60, 180, 90]]), scale: 2, box: { minX: 0, minY: 0 } };
  assert.deepEqual(printedExtent(two, { x: 90, y: 50, width: 110, height: 50 }), { x: 50, y: 30, width: 40, height: 15 });
  assert.equal(printedExtent({ image: fakeImage(10, 10, []), scale: 1, box: { minX: 0, minY: 0 } }), null, '一片白：量不到');
  assert.equal(printedExtent({ image: { width: 10, height: 10 }, scale: 1, box: { minX: 0, minY: 0 } }), null, '读不了像素');
});

/** 一个排版器替身：每一条写成一笔 50×10 的斜线，带着各自的那一组。 */
function stubTypesetter() {
  registerInkTypesetter(async (items, s) => ({
    strokes: [],
    width: 0,
    height: 0,
    groups: items.map(() => {
      const st = createStroke({ tool: INK_TOOLS.PEN, color: s.color, width: s.width });
      appendPoint(st, 0, 0, 0.5, 0);
      appendPoint(st, 50, 10, 0.5, 0);
      recomputeBounds(st);
      return { strokes: [st], em: s.em };
    }),
  }));
}

/** 截图替身：圈多大图就多大（2 倍），书上的东西印在 printed（图上的像素）那几块。 */
const captureWith = (printed) => async (request) => {
  const xs = request.polygon.map((pt) => pt.x);
  const ys = request.polygon.map((pt) => pt.y);
  const box = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  const w = Math.round((box.maxX - box.minX) * 2);
  const h = Math.round((box.maxY - box.minY) * 2);
  return { image: fakeImage(w, h, printed), scale: 2, box, pageNumber: 1 };
};

await test('转成笔迹照书上印的那么大：写出来的正好放得进书上那一条的外框，左边对齐它；「大小」那一排直接打开', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  stubTypesetter();
  try {
    // 圈 (100,100)–(300,200)；书上的公式印在图上 (40,40)–(190,100)，即文档里从 (120,120) 起、75×30。
    const env = mount({ captureImpl: captureWith([[40, 40, 190, 100]]) });
    await startRecognition(env);
    p.last().resolve({ items: [{ kind: 'math', latex: 'x' }] });
    await flush();
    $o(env.host, 'convert').click();
    await flush();
    const added = env.surface.layer.strokes;
    assert.equal(added.length, 1);
    const [a, b] = added[0].points;
    // 写出来 50×10，书上 75×30：宽 1.5 倍、高 3 倍，取小的 → 1.5 倍，75×15。
    assert.ok(Math.abs(b.x - a.x - 75) < 1e-6 && Math.abs(b.y - a.y - 15) < 1e-6, `${b.x - a.x}×${b.y - a.y}`);
    assert.ok(Math.abs(a.x - 120) < 1e-6, `左边对齐书上那一条：${a.x}`);
    assert.ok(a.y > 200, '在圈的下面');
    const row = env.surface._bar.el.querySelector('.ink-selection-size');
    assert.equal(row.hidden, false, '刚写成：「大小」那一排直接打开');
    assert.equal(row.querySelector('.ink-selection-size-value').textContent, '100%');
  } finally {
    registerInkTypesetter(null);
  }
});

await test('圈下面放不下（出了屏幕）、上面放得下：写在圈的上面；量不到书上的大小就照估的字号', async () => {
  resetOcrProviders();
  const p = controlledProvider();
  registerOcrProvider(p.provider);
  stubTypesetter();
  try {
    const env = mount();
    lasso(env.surface, 100, 520, 300, 590);
    pressDown(env.surface._bar.el.querySelector('[data-action="recognize"]'));
    await flush(); await flush();
    p.last().resolve({ items: [{ kind: 'math', latex: 'x' }] });
    await flush();
    $o(env.host, 'convert').click();
    await flush();
    const pts = env.surface.layer.strokes.flatMap((st) => st.points);
    assert.ok(pts.length > 0);
    assert.ok(pts.every((pt) => pt.y < 520), `应在圈的上面：${pts.map((pt) => pt.y.toFixed(1))}`);
    assert.ok(Math.abs(pts[1].x - pts[0].x - 50) < 1e-6, '量不到：不缩放');
  } finally {
    registerInkTypesetter(null);
  }
});

await test('「大小」：放大、缩小以选区中心为准，笔的粗细跟着变；连着按那一排不收；点百分比回到原来；一下一步撤销', async () => {
  resetOcrProviders();
  const env = mount({ capture: false });
  const st = line(env.surface, 100, 100, 100);
  env.surface.selection = [st.id];
  env.surface.selectionLoop = [{ x: 90, y: 90 }, { x: 210, y: 90 }, { x: 210, y: 110 }, { x: 90, y: 110 }];
  env.surface.render();
  const bar = env.surface._bar.el;
  const row = bar.querySelector('.ink-selection-size');
  const value = () => row.querySelector('.ink-selection-size-value').textContent;
  const xs = () => st.points.map((pt) => Math.round(pt.x * 1000) / 1000);
  assert.equal(row.hidden, true, '平时收着');
  pressDown(bar.querySelector('[data-action="size"]'));
  assert.equal(row.hidden, false);
  assert.equal(row.querySelector('.ink-selection-size-value').disabled, true, '已经是原来的大小，回不回去都一样');
  pressDown(row.querySelector('[data-action="size-up"]'));
  assert.deepEqual(xs(), [87.5, 212.5], '中心 150 不动，长度 100 → 125');
  assert.equal(st.width, 2.5, '笔的粗细跟着放大');
  assert.equal(value(), '125%');
  assert.equal(row.hidden, false, '连着按：那一排不收');
  pressDown(row.querySelector('[data-action="size-down"]'));
  pressDown(row.querySelector('[data-action="size-down"]'));
  assert.equal(value(), '80%');
  assert.deepEqual(xs(), [110, 190]);
  pressDown(row.querySelector('[data-action="size-reset"]'));
  assert.equal(value(), '100%');
  assert.deepEqual(xs(), [100, 200], '点百分比回到原来的大小');
  env.surface.undo();
  assert.deepEqual(xs(), [110, 190], '撤销一步：回到 80% 那一下');
  for (let i = 0; i < 12; i++) pressDown(row.querySelector('[data-action="size-up"]'));
  assert.ok(Math.max(...xs()) - Math.min(...xs()) <= 500 + 1e-6, '最多放大到原来的 5 倍');
  pressDown(bar.querySelector('[data-action="color"]'));
  assert.equal(row.hidden, true, '换色那排和它一次只开一个');
  assert.equal(bar.querySelector('.ink-selection-palette').hidden, false);
});

await test('条和单子压到浮着的工具栏就横着挪开：哪边放得下、挪得少用哪边；两边都放不下就不动', async () => {
  const { avoidFloatingObstacles } = await import('../src/ink/float-avoid.js');
  document.body.innerHTML = '<div class="host"></div><div class="ink-toolbar"></div>';
  const host = document.querySelector('.host');
  const toolbar = document.querySelector('.ink-toolbar');
  const rect = (x, y, w, h) => () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y });
  host.getBoundingClientRect = rect(0, 0, 600, 800);
  const view = { width: 600, height: 800 };
  // 平板上看到的：工具栏贴着左边（10–64），单子按圈居中摆到了 8。
  toolbar.getBoundingClientRect = rect(10, 100, 54, 600);
  assert.equal(avoidFloatingObstacles(host, 8, 250, 360, 200, view), 72, '挪到工具栏右边');
  assert.equal(avoidFloatingObstacles(host, 100, 250, 360, 200, view), 100, '没压到：不动');
  assert.equal(avoidFloatingObstacles(host, 8, 720, 360, 60, view), 8, '上下错开了：不动');
  // 工具栏在右边：往左挪。
  toolbar.getBoundingClientRect = rect(530, 100, 54, 600);
  assert.equal(avoidFloatingObstacles(host, 300, 250, 260, 200, view), 262);
  // 单子比两边的空都宽：不动。
  toolbar.getBoundingClientRect = rect(200, 100, 54, 600);
  assert.equal(avoidFloatingObstacles(host, 100, 250, 400, 200, view), 100);
  toolbar.getBoundingClientRect = rect(0, 0, 0, 0);
  assert.equal(avoidFloatingObstacles(host, 8, 250, 360, 200, view), 8, '工具栏收起来了（量出来是 0）：不管它');
});

await test('样式：「大小」那一排和色排一样收在条下面；液态玻璃里那道细线换成浅灰（只按 data-glass 挑）', () => {
  const toolbar = $read('src/styles/ink-toolbar.css');
  assert.ok(/\.ink-selection-size \{/.test(toolbar));
  assert.ok(/\.ink-selection-size\[hidden\] \{ display: none; \}/.test(toolbar));
  assert.ok($read('src/styles/liquid-glass-react.css').includes('html[data-glass="liquid"] .ink-selection-size'));
  assert.ok(css.includes('.ink-recognize-preview .katex-display { margin: 0; text-align: left; }'), '预览里的块级公式靠左、不留白');
});

// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
