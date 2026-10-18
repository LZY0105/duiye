#!/usr/bin/env node
// 插入图片：栏头上那一颗、页上先占的框和挑图的单子、放进来以后的那张图。
//
// 一张图在笔迹层里是「一笔」（stroke.js 的 IMAGE_TOOL）：四个点是四个角，图本身另存（ink-image.js）。这里钉：
//   1. 存、取、复制、跨栏都带着它是哪一张；套索圈住一个角或者正中算圈到它，整圈都在图里面不算（那是要认图上的字）。
//   2. 橡皮不擦它；换色换不到它，只圈了图片时条上不摆「颜色」。
//   3. 画：照四个角搭仿射变换画整张图；还没解好先画一块淡灰。
//   4. 放进来：在已有的图片上面、所有笔迹下面；一步撤销；放好就是选中的，拿着笔也能按住它搬，按在别处就放开。
//   5. 认字：圈里的图片画进截图（只画在圈里）。
//   6. 导出：图嵌进 PDF，在它在层里的那个位置、照四个角画；同一张只嵌一次。
//   7. 挑图的单子：最近照片、没权限时那一句、拍照 / 从图库中选择、点外面收起。
//   8. 栏头：那一颗在缩放后面（原来「适合宽度」「整页」的位置），⋯ 菜单里不再有它。
//   9. 跨栏拖：对面照笔迹的换算摆位置，画的是照片的简笔画（色调 + 轮廓）；松手才是照片，简笔画在上面淡掉；
//      落在那一页的字底下；捏着拖过去的，到了那边也还捏着；拖到一半松手，整张滑进接住它的那一栏（有动画）。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err?.stack?.split('\n').slice(0, 4).join('\n     ') || err}`); }
}

const ROOT = new URL('../', import.meta.url);
const $read = (f) => readFileSync(new URL(f, ROOT), 'utf-8').replace(/\r\n/g, '\n');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event', 'PointerEvent', 'KeyboardEvent',
  'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DataTransfer']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};

localStorage.setItem('latexsnipper-lang', 'zh-CN');
const { initI18n } = await import('../src/core/i18n.js');
await initI18n();

const S = await import('../src/ink/stroke.js');
const I = await import('../src/ink/ink-image.js');
const { InkLayer } = await import('../src/ink/ink-layer.js');
const { strokeIdsAtPoint, eraseArea, strokeIdsInRegion } = await import('../src/ink/ink-eraser.js');
const { drawStroke, createTransform } = await import('../src/ink/ink-renderer.js');
const { InkSurface } = await import('../src/ink/ink-surface.js');
const { SELECTION_ACTIONS } = await import('../src/ink/ink-selection-bar.js');
const { ImagePicker } = await import('../src/ink/ink-image-picker.js');
const X = await import('../src/export/pdf-export.js');
const { PDFDocument, PDFDict, PDFName, decodePDFRawStream, PDFArray, PDFRawStream } = await import('pdf-lib');

/** 一张 1×1 的 PNG。 */
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));

/** 记下每一次调用的假画布上下文。 */
function recordingContext() {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'canvas') return null;
      return (...args) => { calls.push([key, ...args]); };
    },
    set(target, key, value) { target[key] = value; calls.push([`=${String(key)}`, value]); return true; },
  });
  return ctx;
}

function mount({ capture = null } = {}) {
  document.body.innerHTML = '<div class="host"></div>';
  const host = document.querySelector('.host');
  const canvas = document.createElement('canvas');
  canvas.getContext = () => recordingContext();
  host.appendChild(canvas);
  const changes = [];
  const handlers = { onChange: () => changes.push(1) };
  if (capture) handlers.captureRegion = capture;
  const surface = new InkSurface(canvas, handlers);
  surface.resize(800, 600, 1);
  surface.setTransform(1, 0, 0);
  return { surface, host, canvas, changes };
}

function pen(type, x, y, id = 7) {
  return new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: id, isPrimary: true, pointerType: 'pen', pressure: 0.5,
    clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1,
  });
}

function line(x, y, len = 40) {
  const st = S.createStroke({ tool: S.INK_TOOLS.PEN, color: '#000', width: 2 });
  S.appendPoint(st, x, y, 0.5, 0);
  S.appendPoint(st, x + len, y, 0.5, 0);
  return st;
}

const fakeBitmap = (w = 400, h = 300) => ({ width: w, height: h, close() {} });

// ═══════════════════════════════════════════════════════════════
group('1. 一张图是一笔：存、取、复制都带着它是哪一张；套索怎么算圈到它');

await test('四个角、带着 image；存盘再读回来还是它；复制出来的指着同一张、自己的四个角', () => {
  const st = I.createImageStroke({ id: 'img_a', width: 400, height: 300 }, { x: 10, y: 20, width: 200, height: 150 });
  assert.equal(st.tool, S.IMAGE_TOOL);
  assert.ok(S.isImageStroke(st));
  assert.deepEqual(st.points.map((p) => [p.x, p.y]), [[10, 20], [210, 20], [210, 170], [10, 170]]);
  assert.ok(st.bounds.minX <= 10 && st.bounds.maxX >= 210);
  const json = S.serializeStroke(st);
  assert.deepEqual(json.image, { id: 'img_a', w: 400, h: 300 });
  const back = S.deserializeStroke(json);
  assert.ok(S.isImageStroke(back));
  assert.deepEqual(back.image, { id: 'img_a', w: 400, h: 300 });
  const copy = S.cloneStroke(st, 5, 5);
  assert.notEqual(copy.id, st.id);
  assert.notEqual(copy.image, st.image, '不是同一个对象');
  assert.equal(copy.image.id, 'img_a', '指着同一张图');
  assert.equal(copy.points[0].x, 15);
  // 手写笔迹没有它，存盘也不多写一个 null。
  const plain = line(0, 0);
  assert.equal(plain.image, null);
  assert.ok(!('image' in S.serializeStroke(plain)));
  assert.equal(S.deserializeStroke(S.serializeStroke(plain)).image, null);
});

await test('套索：圈住一个角、或者圈住正中算圈到；整圈都在图里面（圈图上的一道公式）不算；「整个在圈里」要四个角都在', () => {
  const layer = new InkLayer();
  const img = I.createImageStroke({ id: 'img_b', width: 400, height: 300 }, { x: 100, y: 100, width: 400, height: 300 });
  layer.add(img);
  const box = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  assert.deepEqual(strokeIdsInRegion(layer, box(80, 80, 140, 140)), [img.id], '套住左上角');
  assert.deepEqual(strokeIdsInRegion(layer, box(280, 230, 320, 270)), [img.id], '套住正中');
  assert.deepEqual(strokeIdsInRegion(layer, box(120, 120, 220, 180)), [], '整圈在图里面、没有角也没有正中：留给认字');
  assert.deepEqual(strokeIdsInRegion(layer, box(80, 80, 140, 140), { requireFullyInside: true }), []);
  assert.deepEqual(strokeIdsInRegion(layer, box(90, 90, 510, 410), { requireFullyInside: true }), [img.id]);
});

await test('橡皮不擦图片：整笔的不拿它，一块一块的不切它；图上写的字照样擦得掉', () => {
  const layer = new InkLayer();
  const img = I.createImageStroke({ id: 'img_c', width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 });
  const ink = line(10, 0, 80);
  layer.add(img);
  layer.add(ink);
  assert.deepEqual(strokeIdsAtPoint(layer, 0, 0, 6), [], '按在图的角上');
  assert.deepEqual(strokeIdsAtPoint(layer, 20, 0, 6), [ink.id], '按在图上那一笔上');
  assert.equal(eraseArea(layer, null, { x: 0, y: 0, radius: 8 }), false);
  assert.ok(layer.has(img.id));
});

// ═══════════════════════════════════════════════════════════════
group('2. 画：照四个角搭仿射，还没解好先画一块淡灰');

await test('还没解好：在那个平行四边形里填一块淡灰（同时去解）；解好了画整张图，变换就是四个角', () => {
  const st = I.createImageStroke({ id: 'img_draw', width: 4, height: 3 }, { x: 10, y: 20, width: 40, height: 30 });
  const t = createTransform(2, 5, 10); // screen = (doc - offset) * scale
  const ctx = recordingContext();
  drawStroke(ctx, st, t);
  const transform = ctx.calls.find((c) => c[0] === 'transform');
  // 左上 (10,20) → (10, 20)；右上 (50,20) → (90, 20)；左下 (10,50) → (10, 80)
  assert.deepEqual(transform.slice(1), [80, 0, 0, 60, 10, 20]);
  assert.ok(ctx.calls.some((c) => c[0] === 'fillRect' && c[1] === 0 && c[2] === 0 && c[3] === 1 && c[4] === 1), '一块占位');
  assert.ok(!ctx.calls.some((c) => c[0] === 'drawImage'));
  const bitmap = fakeBitmap();
  I.rememberDecoded('img_draw', bitmap);
  const again = recordingContext();
  drawStroke(again, st, t);
  const draw = again.calls.find((c) => c[0] === 'drawImage');
  assert.ok(draw, '解好了画图');
  assert.equal(draw[1], bitmap);
  assert.deepEqual(draw.slice(2), [0, 0, 1, 1]);
});

await test('转过的图：变换跟着四个角转', () => {
  const st = I.createImageStroke({ id: 'img_rot', width: 4, height: 3 }, { x: 0, y: 0, width: 40, height: 30 });
  // 绕原点转 90°：左上 (0,0)、右上 (0,40)、左下 (-30,0)
  st.points = [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: -30, y: 40 }, { x: -30, y: 0 }];
  S.recomputeBounds(st);
  const ctx = recordingContext();
  drawStroke(ctx, st, createTransform(1, 0, 0));
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'transform').slice(1), [0, 40, -30, 0, 0, 0]);
});

await test('画在屏幕上用缩小版：挑边长不小于要画的大小的最小一档，后台生成，好了叫画布重画；比原图还大就画原图', async () => {
  const made = [];
  const saved = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (source, opts) => {
    const bitmap = { width: opts.resizeWidth, height: opts.resizeHeight, from: source, closed: false, close() { this.closed = true; } };
    made.push(bitmap);
    return bitmap;
  };
  const heard = [];
  const off = I.onImageReady((id) => heard.push(id));
  try {
    const full = fakeBitmap(2048, 600);
    I.rememberDecoded('img_lv', full);
    heard.length = 0;
    // 屏幕上 500×146 设备像素：1/4（512×150）是不小于它的最小一档。
    assert.equal(I.imageForSize('img_lv', 500, 146), full, '还没生成好：先画原图');
    assert.equal(made.length, 1);
    assert.deepEqual([made[0].width, made[0].height, made[0].from], [512, 150, full]);
    assert.equal(I.imageForSize('img_lv', 500, 146), full, '正在生成：不重复要');
    assert.equal(made.length, 1);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(heard, ['img_lv'], '生成好了叫一声，画布重画');
    assert.equal(I.imageForSize('img_lv', 500, 146), made[0], '好了就画它');
    // 再小一点：1/8 那一档还没好，先用已经有的 1/4。
    assert.equal(I.imageForSize('img_lv', 200, 60), made[0]);
    assert.equal(made.length, 2);
    // 比原图的一半还大：画原图。
    assert.equal(I.imageForSize('img_lv', 1400, 400), full);
    assert.equal(I.imageFor('img_lv'), full, '导出、识别用的还是原图');
    // 原图换掉（又放进来一遍）：旧的缩小版放掉。
    I.rememberDecoded('img_lv', fakeBitmap(2048, 600));
    assert.ok(made[0].closed);
  } finally {
    off();
    if (saved === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = saved;
  }
});

// ═══════════════════════════════════════════════════════════════
group('3. 库：存、取，放在哪一层位置，放多大');

await test('存进去取得出来（没有 IndexedDB 时记在内存里）', async () => {
  const blob = new Blob([PNG], { type: 'image/png' });
  const id = await I.putImage(blob, { width: 1, height: 1 });
  assert.match(id, /^img_/);
  const record = await I.getImage(id);
  assert.equal(record.width, 1);
  assert.equal(record.type, 'image/png');
  assert.equal(await I.getImage('img_nope'), null);
});

await test('放在已有的图片上面、所有笔迹下面；框里等比放好、居中', () => {
  const layer = new InkLayer();
  assert.equal(I.imageInsertIndex(layer), 0, '空的一层：最底下');
  layer.add(line(0, 0));
  assert.equal(I.imageInsertIndex(layer), 0, '只有字：字底下');
  layer.insertAt(0, I.createImageStroke({ id: 'img_z', width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }));
  assert.equal(I.imageInsertIndex(layer), 1, '先放的图上面、字下面');
  assert.deepEqual(I.fitImageRect(400, 200, { minX: 0, minY: 0, maxX: 200, maxY: 150 }),
    { x: 0, y: 25, width: 200, height: 100 });
  assert.deepEqual(I.fitImageRect(100, 200, { minX: 0, minY: 0, maxX: 200, maxY: 100 }),
    { x: 75, y: 0, width: 50, height: 100 });
});

await test('收拾图片库：没人指着、这一次没画过、存了一礼拜以上的才删；一天最多一次；读不出谁在用就什么都不删', async () => {
  const blob = () => new Blob([PNG], { type: 'image/png' });
  const used = await I.putImage(blob(), { width: 1, height: 1 });
  const orphan = await I.putImage(blob(), { width: 1, height: 1 });
  const drawn = await I.putImage(blob(), { width: 1, height: 1 });
  I.imageFor(drawn); // 这一次打开里画过：撤销可能把它带回来
  const later = Date.now() + 8 * 86400000;
  assert.equal(await I.removeUnusedImages(new Set([used]), { now: Date.now() }), 0, '都还没满一礼拜');
  const removed = await I.removeUnusedImages(new Set([used]), { now: later });
  assert.ok(removed >= 1);
  assert.equal(await I.getImage(orphan), null, '没人要的那张删了');
  assert.ok(await I.getImage(used), '有人指着的留着');
  assert.ok(await I.getImage(drawn), '这一次画过的留着');
  localStorage.removeItem('ls_image_sweep');
  const spare = await I.putImage(blob(), { width: 1, height: 1 });
  assert.equal(await I.sweepUnusedImages(async () => { throw new Error('db'); }, { now: later }), 0, '读不出来：不删');
  assert.ok(await I.getImage(spare));
  assert.equal(await I.sweepUnusedImages(async () => new Set([used]), { now: later }), 1);
  assert.equal(await I.getImage(spare), null);
  const again = await I.putImage(blob(), { width: 1, height: 1 });
  assert.equal(await I.sweepUnusedImages(async () => new Set(), { now: later + 3600000 }), 0, '一天之内不再收拾');
  assert.ok(await I.getImage(again));
});

// ═══════════════════════════════════════════════════════════════
group('4. 放进来：一步撤销；放好就是选中的，拿着笔也能搬');

const prepared = (w = 400, h = 300) => ({ blob: new Blob([PNG], { type: 'image/png' }), width: w, height: h, canvas: fakeBitmap(w, h) });

await test('框：看得见的那一块正中，宽占四成多、4:3；给了书页的范围就收在页里', () => {
  const { surface } = mount();
  const box = surface.imageSlotBox();
  assert.equal(Math.round(box.maxX - box.minX), Math.round(800 * 0.44));
  assert.equal(Math.round((box.maxY - box.minY) * 4 / 3), Math.round(box.maxX - box.minX));
  assert.equal(Math.round((box.minX + box.maxX) / 2), 400);
  const inPage = surface.imageSlotBox({ minX: 0, minY: 0, maxX: 400, maxY: 600 });
  assert.ok(inPage.maxX <= 400 && inPage.minX >= 0, '收在页里');
  assert.deepEqual(surface.screenRectOf({ minX: 10, minY: 20, maxX: 30, maxY: 60 }), { x: 10, y: 20, width: 20, height: 40 });
});

await test('放在字底下、先放的图上面；一步撤销、重做回到原来那个位置；放好就选中、选区条上没有「颜色」', async () => {
  const { surface, changes } = mount();
  const ink = line(100, 100);
  surface.layer.add(ink);
  const st = await surface.insertImage(prepared(), { minX: 100, minY: 100, maxX: 500, maxY: 400 });
  assert.ok(st && S.isImageStroke(st));
  assert.equal(surface.layer.getAll()[0], st, '垫在字底下');
  assert.deepEqual(st.points[0], { x: 100, y: 100, p: 0.5 }, '4:3 正好放满框');
  assert.equal(changes.length, 1);
  assert.deepEqual(surface.selection, [st.id]);
  assert.equal(surface._held, true, '拿着笔也是选中的');
  assert.ok(surface._bar.el?.classList.contains('is-visible'));
  const actions = [...surface._bar.el.querySelectorAll('[data-action]')].map((b) => b.dataset.action);
  assert.ok(!actions.includes(SELECTION_ACTIONS.COLOR), '只圈了图片：不摆「颜色」');
  assert.ok(actions.includes(SELECTION_ACTIONS.DELETE));
  surface.undo();
  assert.ok(!surface.layer.has(st.id));
  surface.redo();
  assert.equal(surface.layer.getAll()[0], st, '重做回到原来那个位置');
  // 图片和字一起圈：「颜色」回来，换色只换字。（撤销、重做把套索线收掉了，重新圈一圈。）
  surface.selection = [st.id, ink.id];
  surface.selectionLoop = [{ x: 90, y: 90 }, { x: 510, y: 90 }, { x: 510, y: 410 }, { x: 90, y: 410 }];
  surface.recolorSelection('#dc2626');
  assert.equal(ink.color, '#dc2626');
  assert.equal(st.color, '#000000');
  surface._placeBar();
  assert.ok([...surface._bar.el.querySelectorAll('[data-action]')].some((b) => b.dataset.action === SELECTION_ACTIONS.COLOR));
});

await test('拿着笔按在图上：搬它（一步撤销）；按在别处：放开它，这一下照常写字', async () => {
  const { surface, canvas } = mount();
  surface.setTool('pen');
  const st = await surface.insertImage(prepared(), { minX: 100, minY: 100, maxX: 500, maxY: 400 });
  canvas.dispatchEvent(pen('pointerdown', 300, 250));
  canvas.dispatchEvent(pen('pointermove', 330, 270));
  canvas.dispatchEvent(pen('pointermove', 350, 290));
  canvas.dispatchEvent(pen('pointerup', 350, 290));
  assert.equal(st.points[0].x, 150, '搬过去了');
  assert.equal(st.points[0].y, 140);
  assert.equal(surface.layer.length, 1, '没有多写一笔');
  assert.deepEqual(surface.selection, [st.id], '还捏着');
  surface.undo();
  assert.equal(st.points[0].x, 100, '一步撤销');
  surface.redo();
  canvas.dispatchEvent(pen('pointerdown', 700, 500));
  canvas.dispatchEvent(pen('pointermove', 720, 520));
  canvas.dispatchEvent(pen('pointerup', 720, 520));
  assert.deepEqual(surface.selection, [], '放开了');
  assert.equal(surface._held, false);
  assert.equal(surface.layer.length, 2, '这一下照常写了一笔');
});

await test('换了工具就放开；换成套索，它就成了套索的选区；同一种工具再推一遍不算换', async () => {
  const { surface } = mount();
  surface.setTool('pen');
  const st = await surface.insertImage(prepared(), { minX: 100, minY: 100, maxX: 500, maxY: 400 });
  surface.setTool('pen');
  assert.deepEqual(surface.selection, [st.id], '落笔时外面再推一遍工具：不放');
  surface.setTool('eraser');
  assert.deepEqual(surface.selection, [], '换成橡皮：放开');
  surface.setTool('pen');
  await surface.insertImage(prepared(), { minX: 100, minY: 100, maxX: 500, maxY: 400 });
  surface.setTool('lasso');
  assert.equal(surface.selection.length, 1, '换成套索：还选着');
  assert.equal(surface._held, false, '成了套索自己的选区');
});

await test('等存图的这一会儿翻了页：不放进去', async () => {
  const { surface } = mount();
  const pending = surface.insertImage(prepared(), { minX: 0, minY: 0, maxX: 100, maxY: 100 });
  surface.loadLayer(new InkLayer());
  assert.equal(await pending, null);
  assert.equal(surface.layer.length, 0);
});

// ═══════════════════════════════════════════════════════════════
group('5. 认字：圈里的图片画进截图');

await test('截图上按截图的比例画图片，只画在圈里；没有图片就什么都不画', async () => {
  const { surface } = mount();
  const st = I.createImageStroke({ id: 'img_ocr', width: 4, height: 3 }, { x: 100, y: 100, width: 40, height: 30 });
  I.rememberDecoded('img_ocr', fakeBitmap(4, 3));
  surface.layer.add(st);
  const ctx = recordingContext();
  const capture = { image: { getContext: () => ctx }, scale: 2, box: { minX: 90, minY: 90, maxX: 150, maxY: 140 } };
  const loop = [{ x: 90, y: 90 }, { x: 150, y: 90 }, { x: 150, y: 140 }, { x: 90, y: 140 }];
  await surface._paintImagesInto(capture, loop);
  const names = ctx.calls.map((c) => c[0]);
  assert.ok(names.indexOf('clip') >= 0 && names.indexOf('clip') < names.indexOf('drawImage'), '先按圈裁，再画');
  // 图的左上 (100,100) 在截图上是 ((100-90)*2, (100-90)*2) = (20, 20)，宽 40*2。
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'transform').slice(1), [80, 0, 0, 60, 20, 20]);
  const empty = recordingContext();
  surface.layer.removeByIds([st.id]);
  await surface._paintImagesInto({ ...capture, image: { getContext: () => empty } }, loop);
  assert.equal(empty.calls.length, 0);
});

await test('草稿纸：圈在空白处不留识别区域、只圈了手写的字条上不摆「识别」；圈住了图片才有', async () => {
  const { registerOcrProvider, resetOcrProviders } = await import('../src/ocr/ocr-service.js');
  resetOcrProviders();
  registerOcrProvider({ id: 'stub', recognize: async () => ({ items: [] }) });
  try {
    document.body.innerHTML = '<div class="host"></div>';
    const host = document.querySelector('.host');
    const canvas = document.createElement('canvas');
    canvas.getContext = () => recordingContext();
    host.appendChild(canvas);
    let touches = false;
    const surface = new InkSurface(canvas, {
      captureRegion: async () => ({ image: null, scale: 1, box: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }),
      regionHasContent: () => touches,
      recognizable: (ids) => ids.some((id) => S.isImageStroke(surface.layer.getById(id))),
    });
    surface.resize(800, 600, 1);
    surface.setTransform(1, 0, 0);
    surface.setTool('lasso');
    const loop = (x0, y0, x1, y1) => {
      canvas.dispatchEvent(pen('pointerdown', x0, y0));
      for (const [x, y] of [[x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]]) canvas.dispatchEvent(pen('pointermove', x, y));
      canvas.dispatchEvent(pen('pointerup', x0, y0 + 2));
    };
    loop(100, 100, 300, 200);
    assert.equal(surface.regionLoop, null, '空白处：不留');
    touches = true;
    loop(100, 100, 300, 200);
    assert.ok(surface.regionLoop, '碰到了图片：留下当识别区域');
    const ink = line(500, 300);
    surface.layer.add(ink);
    loop(480, 280, 560, 320);
    assert.deepEqual(surface.selection, [ink.id]);
    const actions = () => [...surface._bar.el.querySelectorAll('[data-action]')].map((b) => b.dataset.action);
    assert.ok(!actions().includes(SELECTION_ACTIONS.RECOGNIZE), '只圈了手写的字：不摆');
    const img = I.createImageStroke({ id: 'img_s', width: 1, height: 1 }, { x: 600, y: 300, width: 40, height: 30 });
    surface.layer.add(img);
    surface.clearSelection(); // 按在上一片的套索线上是搬它，不是重新圈
    loop(480, 280, 660, 340);
    assert.deepEqual(surface.selection.sort(), [ink.id, img.id].sort());
    assert.ok(actions().includes(SELECTION_ACTIONS.RECOGNIZE), '圈住了图片：摆');
  } finally {
    resetOcrProviders();
  }
});

await test('按条上的按钮：同一根手指抬起来补的那一下 click 吞掉（不落到刚冒出来的小条「取消」上）；别的指针的不管', async () => {
  const { surface } = mount();
  const st = await surface.insertImage(prepared(), { minX: 100, minY: 100, maxX: 500, maxY: 400 });
  assert.ok(st);
  const btn = surface._bar.el.querySelector(`[data-action="${SELECTION_ACTIONS.COPY}"]`);
  btn.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 5, pointerType: 'touch' }));
  const target = document.createElement('button');
  document.body.appendChild(target);
  let reached = 0;
  target.addEventListener('click', () => { reached++; });
  const click = (id) => {
    const e = new dom.window.PointerEvent('click', { bubbles: true, cancelable: true, pointerId: id });
    target.dispatchEvent(e);
    return e;
  };
  assert.equal(click(6).defaultPrevented, false, '别的手指：照常');
  assert.equal(reached, 1);
  assert.equal(click(5).defaultPrevented, true, '按按钮的那根手指：吞掉');
  assert.equal(reached, 1);
  assert.equal(click(5).defaultPrevented, false, '只吞一下');
  assert.equal(reached, 2);
});

await test('识别的那一路先把图片画进截图，再交给引擎（源码里的次序）', () => {
  const src = $read('src/ink/ink-surface.js');
  const body = src.slice(src.indexOf('async recognizeRegion()'), src.indexOf('_cancelRecognition() {'));
  const paint = body.indexOf('await this._paintImagesInto(capture, job.loop)');
  assert.ok(paint > 0);
  assert.ok(paint < body.indexOf('printedExtent(capture)'), '量书上的字多大之前');
  assert.ok(paint < body.indexOf('await recognizeRegion('), '交给引擎之前');
});

// ═══════════════════════════════════════════════════════════════
group('6. 导出：图嵌进 PDF，在它在层里的位置、照四个角画');

function pageContent(doc, page) {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
    return Buffer.from(bytes).toString('latin1');
  }).join('\n');
}

await test('inkOps：图在笔迹中间按层里的次序出现，cm 把单位方块搬到四个角上', () => {
  const img = I.createImageStroke({ id: 'img_e', width: 4, height: 3 }, { x: 10, y: 20, width: 40, height: 30 });
  const before = line(0, 0);
  const after = line(0, 50);
  const { content, images } = X.inkOps([before, img, after], [1, 0, 0, 1, 0, 0]);
  assert.deepEqual([...images.entries()], [['/@IMG0', 'img_e']]);
  const at = content.indexOf('/@IMG0 Do');
  assert.ok(at > 0);
  // 左下 (10,50)；右下 - 左下 = (40,0)；左上 - 左下 = (0,-30)
  assert.ok(content.slice(0, at).trimEnd().endsWith('40 0 0 -30 10 50 cm'), content.slice(at - 60, at));
  assert.ok(content.indexOf(' f') < at || content.indexOf('S') < at, '前面那一笔画在它前面');
});

await test('草稿纸导出：图嵌进去、挂在页面资源上；同一张只嵌一次；没取到的那张不画、别的照画', async () => {
  const a = I.createImageStroke({ id: 'img_x', width: 1, height: 1 }, { x: 10, y: 10, width: 40, height: 40 });
  const b = S.cloneStroke(a, 60, 0);
  const lost = I.createImageStroke({ id: 'img_lost', width: 1, height: 1 }, { x: 10, y: 80, width: 40, height: 40 });
  const ink = line(10, 140, 100);
  const strokes = [a, b, lost, ink];
  const box = X.scratchPageBox(strokes);
  const bytes = await X.buildScratchPdf({ strokes, box, images: { img_x: { bytes: PNG, type: 'image/png' } } });
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0];
  const text = pageContent(doc, page);
  const dos = text.match(/\/DyImg\S* Do/g) || [];
  assert.equal(dos.length, 2, '两份各画一次，丢了的那张不画');
  assert.ok(!text.includes('@IMG'), '占位符都换掉了');
  const names = new Set(dos.map((d) => d.split(' ')[0]));
  assert.equal(names.size, 1, '同一页上同一张图挂一个名字');
  const xobjects = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  const refs = xobjects.keys().map((key) => xobjects.get(key));
  assert.equal(refs.length, 1, '只嵌了一张');
});

// ═══════════════════════════════════════════════════════════════
group('7. 挑图的单子');

function fakeSource({ photos = [], error = null, permissionAsk = null } = {}) {
  const calls = { thumbs: [], read: [] };
  return {
    calls,
    PHOTO_ERRORS: { NO_PERMISSION: 'PDF_FILES_NO_PERMISSION' },
    photosAvailable: () => true,
    recentPhotos: async () => { if (error) throw new Error(error); return photos; },
    photoThumbnail: async (uri) => { calls.thumbs.push(uri); return `data:image/jpeg;base64,${uri}`; },
    readPhoto: async (photo) => { calls.read.push(photo.uri); return new Blob(['x'], { type: 'image/jpeg' }); },
    requestPhotosPermission: async () => { permissionAsk?.(); },
  };
}

function openPicker(source, onPick = async () => true) {
  document.body.innerHTML = '<div class="host" style="position:relative"></div>';
  const host = document.querySelector('.host');
  const picks = [];
  let closed = 0;
  const picker = new ImagePicker(host, {
    onPick: async (blob) => { picks.push(blob); return onPick(blob); },
    onClose: () => { closed++; },
  }, { source });
  picker.open({ x: 100, y: 100, width: 300, height: 225 }, { width: 900, height: 600 });
  return { host, picker, picks, closed: () => closed };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

await test('框摆在给的位置；单子上最近照片一格一格补上缩略图，下面是「拍照」「从图库中选择」', async () => {
  const source = fakeSource({ photos: [{ uri: 'u1', name: 'a.jpg' }, { uri: 'u2', name: 'b.jpg' }, { uri: 'u3' }] });
  const { host } = openPicker(source);
  const slot = host.querySelector('.ink-image-slot');
  assert.equal(slot.style.width, '300px');
  assert.equal(slot.style.transform, 'translate(100px, 100px)');
  assert.equal(slot.getAttribute('aria-hidden'), 'true');
  for (let i = 0; i < 5; i++) await settle();
  const cells = [...host.querySelectorAll('.ink-image-thumb')];
  assert.equal(cells.length, 3);
  assert.equal(host.querySelector('[data-role="recent-title"]').textContent, '最近照片');
  assert.deepEqual(source.calls.thumbs.sort(), ['u1', 'u2', 'u3']);
  assert.ok(cells.every((c) => c.querySelector('img')?.src.startsWith('data:image/jpeg')));
  assert.equal(cells[0].getAttribute('aria-label'), '照片 1');
  assert.deepEqual([...host.querySelectorAll('.ink-image-row')].map((b) => b.textContent.trim()), ['拍照', '从图库中选择']);
  assert.equal(host.querySelector('[data-role="camera-input"]').getAttribute('capture'), 'environment');
  assert.equal(host.querySelector('[data-role="camera-input"]').getAttribute('accept'), 'image/*');
  assert.equal(host.querySelector('.ink-image-card').getAttribute('role'), 'dialog');
});

await test('点一张最近照片：读出来交出去，放进去了就收起', async () => {
  const source = fakeSource({ photos: [{ uri: 'u9' }] });
  const { host, picks, closed } = openPicker(source);
  for (let i = 0; i < 5; i++) await settle();
  host.querySelector('.ink-image-thumb').click();
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(source.calls.read, ['u9']);
  assert.equal(picks.length, 1);
  assert.equal(host.querySelector('.ink-image-picker'), null, '收起了');
  assert.equal(closed(), 1);
});

await test('放不进去：单子上说一声，留着再挑', async () => {
  const source = fakeSource({ photos: [{ uri: 'u5' }] });
  const { host } = openPicker(source, async () => false);
  for (let i = 0; i < 5; i++) await settle();
  host.querySelector('.ink-image-thumb').click();
  for (let i = 0; i < 5; i++) await settle();
  assert.ok(host.querySelector('.ink-image-picker'));
  assert.equal(host.querySelector('[data-role="status"]').textContent, '这张图没能放进来，换一张试试');
  assert.ok(!host.querySelector('.ink-image-card').classList.contains('is-busy'));
});

await test('没有「所有文件访问」：说一句、给「去打开」；没有原生层：这一块不摆', async () => {
  let asked = 0;
  const source = fakeSource({ error: 'PDF_FILES_NO_PERMISSION', permissionAsk: () => { asked++; } });
  const { host } = openPicker(source);
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(host.querySelector('[data-role="hint"]').hidden, false);
  assert.equal(host.querySelector('[data-role="grid"]').hidden, true);
  host.querySelector('[data-role="allow"]').click();
  await settle();
  assert.equal(asked, 1);
  const none = openPicker({ ...fakeSource(), photosAvailable: () => false });
  assert.equal(none.host.querySelector('[data-role="recent"]').hidden, true);
});

await test('从图库中选择：选了一张就交出去；点单子外面收起（按在页上的那一下吞掉），Esc 也收起', async () => {
  const { host, picks } = openPicker({ ...fakeSource(), photosAvailable: () => false });
  const input = host.querySelector('[data-role="gallery-input"]');
  const file = new dom.window.File(['abc'], 'p.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(picks[0], file);
  const again = openPicker({ ...fakeSource(), photosAvailable: () => false });
  const page = document.createElement('div');
  again.host.appendChild(page);
  const down = new dom.window.PointerEvent('pointerdown', { bubbles: true, cancelable: true });
  let reached = false;
  page.addEventListener('pointerdown', () => { reached = true; });
  page.dispatchEvent(down);
  assert.equal(again.host.querySelector('.ink-image-picker'), null, '收起了');
  assert.equal(reached, false, '没落到页上');
  const third = openPicker({ ...fakeSource(), photosAvailable: () => false });
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(third.host.querySelector('.ink-image-picker'), null);
});

await test('摆法：右边、左边、下面、上面哪边放得下放哪边；四边都放不下就把框挪开（上下叠着 / 左右并排 / 缩小），不让单子盖住框', async () => {
  const { layoutPicker } = await import('../src/ink/ink-image-picker.js');
  const card = { width: 300, height: 400 };
  const overlaps = (s, c) => s.x < c.left + 300 && c.left < s.x + s.width && s.y < c.top + 400 && c.top < s.y + s.height;
  // 宽的那一栏：右边
  let r = layoutPicker({ x: 100, y: 100, width: 400, height: 300 }, card, { width: 1200, height: 700 });
  assert.equal(r.card.left, 512);
  assert.deepEqual(r.slot, { x: 100, y: 100, width: 400, height: 300 });
  // 右边贴边：左边
  r = layoutPicker({ x: 700, y: 100, width: 400, height: 300 }, card, { width: 1200, height: 700 });
  assert.equal(r.card.left, 700 - 12 - 300);
  // 竖着的窄栏（机上右边那一栏）：两边都不够、上下也不够 → 上下叠着，整组居中，框挪上去
  r = layoutPicker({ x: 264, y: 280, width: 200, height: 150 }, card, { width: 728, height: 640 });
  assert.ok(!overlaps(r.slot, r.card), `不盖住框：${JSON.stringify(r)}`);
  assert.equal(r.slot.width, 200, '叠得下就不缩');
  assert.equal(r.card.top, r.slot.y + 150 + 12);
  // 又矮又窄：并排也不够 → 框缩小到叠得下
  r = layoutPicker({ x: 50, y: 100, width: 280, height: 210 }, card, { width: 420, height: 560 });
  assert.ok(!overlaps(r.slot, r.card), `缩小以后也不盖住：${JSON.stringify(r)}`);
  assert.ok(r.slot.height < 210 && r.slot.height >= 48);
  assert.ok(Math.abs(r.slot.width / r.slot.height - 280 / 210) < 1e-6, '等比缩');
});

await test('框挪了：告诉调用方（图放进人看见的那个框里）；没挪不说', () => {
  document.body.innerHTML = '<div class="host"></div>';
  const host = document.querySelector('.host');
  const moves = [];
  const picker = new ImagePicker(host, { onPick: async () => true, onSlotMove: (r) => moves.push(r) },
    { source: { ...fakeSource(), photosAvailable: () => false } });
  // jsdom 不排版：单子量出来是 0×0，哪儿都放得下，框不挪。
  picker.open({ x: 100, y: 100, width: 300, height: 225 }, { width: 900, height: 600 });
  assert.equal(moves.length, 0);
  const card = host.querySelector('.ink-image-card');
  Object.defineProperty(card, 'offsetWidth', { value: 300, configurable: true });
  Object.defineProperty(card, 'offsetHeight', { value: 420, configurable: true });
  picker._viewport = { width: 420, height: 640 };
  picker._placeCard();
  assert.equal(moves.length, 1, '窄的地方：框让开了');
  assert.equal(host.querySelector('.ink-image-slot').style.transform, `translate(${Math.round(moves[0].x)}px, ${Math.round(moves[0].y)}px)`);
  picker.close();
});

// ═══════════════════════════════════════════════════════════════
group('8. 栏头上那一颗');

await test('在缩放后面（原来「适合宽度」「整页」的位置），书、本子、草稿纸都有；⋯ 菜单里不再有它', () => {
  const ws = $read('src/pdf/pdf-workspace.js');
  const chrome = ws.slice(ws.indexOf('function slotChrome('), ws.indexOf('${deckStripHtml()}'));
  const menu = ws.slice(ws.indexOf('<div class="pdf-slot-menu"'), ws.indexOf('<div class="pdf-outline-panel"'));
  assert.match(chrome, /data-role="zoom-in"[^\n]*\n(\s*<!--[^]*?-->\n)?\s*<button type="button" class="pdf-slot-btn" data-role="insert-image" title="插入图片" aria-label="插入图片"><svg class="pdf-slot-icon"/);
  const at = chrome.indexOf('data-role="insert-image"');
  const groupOpen = chrome.lastIndexOf('<span class="pdf-slot-group', at);
  const groupClose = chrome.lastIndexOf('</span>', at);
  assert.ok(groupOpen < groupClose, '不在「只有书才有」的那一组里');
  assert.ok(!menu.includes('insert-image'), '菜单里拿掉了');
  assert.match(ws, /on\('insert-image', \(\) => \{ this\._closeSlotMenus\(\); this\.insertImage\(slot\); \}\);/);
  assert.match(ws, /set\('insert-image', n => \{ labelled\(n, t\('image\.insert'\)\); n\.disabled = !loaded; \}\);/);
});

// ═══════════════════════════════════════════════════════════════
group('9. 跨栏拖：对面先画照片的简笔画，松手才是照片');

const SK = await import('../src/ink/ink-image-sketch.js');

/** 一张 w×h 的图：底色 bg，[x0,x1)×[y0,y1) 里是 fg（颜色给三个数是不透明的，给四个数第四个是透明度）。 */
function pixels(w, h, bg, fg = null, [x0, y0, x1, y1] = [0, 0, 0, 0]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fg && x >= x0 && x < x1 && y >= y0 && y < y1 ? fg : bg;
      const i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3] ?? 255;
    }
  }
  return data;
}
/** 色调那一张在 (u, v)（占整张的比例）处的颜色。 */
const toneAt = (tones, u, v) => {
  const x = Math.min(tones.width - 1, Math.floor(u * tones.width));
  const y = Math.min(tones.height - 1, Math.floor(v * tones.height));
  const i = (y * tones.width + x) * 4;
  return [tones.data[i], tones.data[i + 1], tones.data[i + 2]];
};

await test('简笔画：轮廓线沿着照片里的边走、四条边都有；色调是那几块颜色调淡了；描线用最深的那种颜色；每次一样', () => {
  const W = 120;
  const H = 80;
  const sk = SK.sketchFromPixels(pixels(W, H, [255, 255, 255], [20, 40, 160], [30, 20, 90, 60]), W, H);
  assert.ok(sk.paths.length >= 1, '有线');
  const pts = sk.paths.flat().map((p) => [p.x * W, p.y * H]);
  // 离那个方块的边多远：在外面量到边的距离，在里面量到最近一条边的距离。
  const off = (x, y) => {
    const outside = Math.hypot(Math.max(30 - x, 0, x - 90), Math.max(20 - y, 0, y - 60));
    return outside > 0 ? outside : Math.min(x - 30, 90 - x, y - 20, 60 - y);
  };
  assert.ok(pts.every(([x, y]) => off(x, y) <= 4), `线都贴着边：${pts.filter(([x, y]) => off(x, y) > 4).slice(0, 3)}`);
  assert.ok(pts.some(([x]) => Math.abs(x - 30) < 4) && pts.some(([x]) => Math.abs(x - 90) < 4), '左右两条边');
  assert.ok(pts.some(([, y]) => Math.abs(y - 20) < 4) && pts.some(([, y]) => Math.abs(y - 60) < 4), '上下两条边');
  const blue = toneAt(sk.tones, 0.5, 0.5);
  assert.ok(blue[2] > blue[0] + 60, `方块那一块还是蓝的：${blue}`);
  assert.ok(blue[0] > 60 && blue[2] < 255, `往白里调淡了：${blue}`);
  assert.ok(toneAt(sk.tones, 0.05, 0.05).every((v) => v >= 250), '白底还是白的');
  assert.equal(sk.tones.data.length, sk.tones.width * sk.tones.height * 4);
  const [r, g, b] = sk.ink.match(/\d+/g).map(Number);
  assert.ok(b > r && 0.299 * r + 0.587 * g + 0.114 * b <= 64, `描线是深蓝：${sk.ink}`);
  assert.deepEqual(SK.sketchFromPixels(pixels(W, H, [255, 255, 255], [20, 40, 160], [30, 20, 90, 60]), W, H), sk);
});

await test('简笔画：一片平的（带点纸纹、噪点也算）没有线；透明的地方当白纸；数据不对回 null', () => {
  const flat = SK.sketchFromPixels(pixels(64, 48, [200, 180, 150]), 64, 48);
  assert.deepEqual(flat.paths, []);
  assert.deepEqual(toneAt(flat.tones, 0.5, 0.5), toneAt(flat.tones, 0.1, 0.9));
  let seed = 7;
  const noisy = pixels(64, 48, [128, 128, 128]);
  for (let i = 0; i < noisy.length; i += 4) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const n = (seed % 13) - 6;
    noisy[i] += n; noisy[i + 1] += n; noisy[i + 2] += n;
  }
  assert.deepEqual(SK.sketchFromPixels(noisy, 64, 48).paths, [], '纸纹、噪点不当轮廓');
  const clear = SK.sketchFromPixels(pixels(40, 40, [0, 0, 0, 0], [220, 30, 30, 255], [10, 10, 30, 30]), 40, 40);
  assert.ok(toneAt(clear.tones, 0.02, 0.02).every((v) => v >= 250), '透明的底当白纸，不是黑的');
  assert.equal(SK.sketchFromPixels(new Uint8ClampedArray(4), 10, 10), null);
  assert.equal(SK.sketchFromPixels(null, 10, 10), null);
});

await test('画简笔画：先照四个角的仿射铺色调，再在屏幕上描线；算不出简笔画（没有画布）就照常画照片', () => {
  const st = I.createImageStroke({ id: 'img_sk', width: 4, height: 3 }, { x: 10, y: 20, width: 40, height: 30 });
  const tones = { width: 8, height: 6 };
  SK.rememberSketch('img_sk', { tones, paths: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]], ink: 'rgb(1, 2, 3)' });
  const t = createTransform(2, 5, 10);
  const ctx = recordingContext();
  drawStroke(ctx, st, t, { sketch: true });
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'transform').slice(1), [80, 0, 0, 60, 10, 20]);
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'drawImage'), ['drawImage', tones, 0, 0, 1, 1], '铺色调');
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'moveTo'), ['moveTo', 10, 20], '线在屏幕上算：图的左上角');
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'lineTo'), ['lineTo', 90, 80], '图的右下角');
  assert.ok(ctx.calls.some((c) => c[0] === '=strokeStyle' && c[1] === 'rgb(1, 2, 3)'));
  const bitmap = fakeBitmap();
  I.rememberDecoded('img_plain', bitmap);
  const plain = I.createImageStroke({ id: 'img_plain', width: 4, height: 3 }, { x: 10, y: 20, width: 40, height: 30 });
  const ctx2 = recordingContext();
  drawStroke(ctx2, plain, t, { sketch: true });
  assert.equal(ctx2.calls.find((c) => c[0] === 'drawImage')?.[1], bitmap, 'jsdom 没有画布，算不出简笔画：画照片');
});

/** 两块并排的画布（左 0..400，右 400..800），接法照 pdf-workspace（和 test_ink_handoff.js 一样）。 */
function twoPanes(tool) {
  document.body.innerHTML = '';
  const panes = [0, 400].map((left) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const canvas = document.createElement('canvas');
    const ctx = recordingContext();
    canvas.getContext = () => ctx;
    canvas.getBoundingClientRect = () => ({ left, top: 0, right: left + 400, bottom: 600, width: 400, height: 600, x: left, y: 0 });
    host.appendChild(canvas);
    const surface = new InkSurface(canvas, {});
    surface.resize(400, 600, 1);
    surface.setTransform(1, 0, 0);
    surface.setTool(tool);
    return { surface, canvas, ctx, rect: { left, width: 400 } };
  });
  for (const pane of panes) {
    // 回「探进对面了没有」，和工作区的 _previewInkDrag 一样。
    pane.surface.handlers.onDragOver = ({ ghost }) => {
      let reached = false;
      for (const other of panes) {
        if (other === pane) continue;
        const b = ghost?.bounds;
        if (b && b.maxX > other.rect.left && b.minX < other.rect.left + other.rect.width) {
          other.surface.showDragGhost(ghost);
          reached = true;
        } else {
          other.surface.clearDragGhost();
        }
      }
      return reached;
    };
    pane.surface.handlers.onDragDrop = ({ strokes, clientX, clientY, scale, origin }) => {
      const hit = panes.find((p) => p !== pane && clientX >= p.rect.left && clientX <= p.rect.left + p.rect.width);
      return hit ? hit.surface.adoptStrokes(strokes, clientX, clientY, scale, origin) : null;
    };
  }
  return panes;
}
const drawnImages = (pane) => {
  pane.ctx.calls.length = 0;
  pane.surface.render();
  return pane.ctx.calls.filter((c) => c[0] === 'drawImage').map((c) => c[1]);
};

await test('图片拖到另一栏：对面照笔迹的换算摆位置、画简笔画；松手才是照片，简笔画在上面淡掉；落在那一页的字底下', async () => {
  const [left, right] = twoPanes('lasso');
  const bitmap = fakeBitmap(400, 300);
  I.rememberDecoded('img_x', bitmap);
  const tones = { width: 8, height: 6 };
  SK.rememberSketch('img_x', { tones, paths: [[{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }]], ink: 'rgb(0, 0, 0)' });
  const img = I.createImageStroke({ id: 'img_x', width: 400, height: 300 }, { x: 200, y: 100, width: 160, height: 120 });
  const word = line(220, 150, 60);
  left.surface.layer.add(img);
  left.surface.layer.add(word);
  const old = line(50, 160, 80);
  right.surface.layer.add(old);
  // 倒着选：交过去、画预览都还是图在前、写在图上的字在后。
  left.surface.selection = [word.id, img.id];
  left.surface.selectionLoop = [{ x: 190, y: 90 }, { x: 370, y: 90 }, { x: 370, y: 230 }, { x: 190, y: 230 }];
  left.canvas.dispatchEvent(pen('pointerdown', 280, 160));
  left.canvas.dispatchEvent(pen('pointermove', 330, 160));
  left.canvas.dispatchEvent(pen('pointermove', 430, 160));
  const ghost = right.surface._ghost;
  assert.ok(ghost, '右栏画出了预览');
  assert.equal(ghost[0].image?.id, 'img_x', '图在前，带着是哪一张');
  assert.deepEqual(ghost[0].points.map((p) => [p.x, p.y]), [[-50, 100], [110, 100], [110, 220], [-50, 220]],
    '和笔迹一个换算：左栏屏幕上的位置换成右栏的坐标');
  let drawn = drawnImages(right);
  assert.ok(drawn.includes(tones), '画的是简笔画');
  assert.ok(!drawn.includes(bitmap), '还没画照片');
  left.canvas.dispatchEvent(pen('pointerup', 430, 160));
  assert.equal(left.surface.layer.length, 0, '左栏交出去了');
  const all = right.surface.layer.getAll();
  const landed = all.find((s) => S.isImageStroke(s));
  assert.ok(landed, '右栏收下了');
  assert.equal(all[0], landed, '落在那一页原来的字底下');
  assert.equal(all[2].color, word.color, '图上的字还压着图');
  assert.deepEqual(landed.points.map((p) => [p.x, p.y]), ghost[0].points.map((p) => [p.x, p.y]), '落在预览最后停着的地方');
  assert.equal(right.surface._ghost, null);
  drawn = drawnImages(right);
  assert.ok(drawn.includes(bitmap), '松手就是照片');
  assert.ok(right.surface._reveal && drawn.includes(tones), '简笔画还盖在上面，正在淡');
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(right.surface._reveal, null, '淡完了');
  assert.ok(!drawnImages(right).includes(tones), '只剩照片');
  left.surface.undo();
  assert.ok(!right.surface.layer.getAll().some((s) => S.isImageStroke(s)), '撤销：右栏那一份跟着走');
  left.surface.redo();
  assert.ok(S.isImageStroke(right.surface.layer.getAll()[0]), '重做：回来还垫在最底下');
});

await test('拿着笔、捏着刚放进来的图片拖到另一栏：到了那边也还捏着，按在它上面接着搬', async () => {
  const [left, right] = twoPanes('pen');
  const st = await left.surface.insertImage(prepared(), { minX: 150, minY: 100, maxX: 350, maxY: 250 });
  assert.equal(left.surface._held, true);
  left.canvas.dispatchEvent(pen('pointerdown', 250, 175));
  left.canvas.dispatchEvent(pen('pointermove', 400, 175));
  left.canvas.dispatchEvent(pen('pointermove', 550, 175));
  left.canvas.dispatchEvent(pen('pointerup', 550, 175));
  assert.ok(!left.surface.layer.has(st.id), '交过去了');
  const landed = right.surface.layer.getAll().find((s) => S.isImageStroke(s));
  assert.ok(landed);
  assert.equal(right.surface._held, true, '那边也捏着');
  const x0 = landed.points[0].x;
  right.canvas.dispatchEvent(pen('pointerdown', 550, 175));
  right.canvas.dispatchEvent(pen('pointermove', 580, 175));
  right.canvas.dispatchEvent(pen('pointerup', 580, 175));
  assert.equal(landed.points[0].x, x0 + 30, '按在它上面接着搬');
  assert.equal(right.surface.layer.length, 1, '没有多写一笔');
});

/** 左栏放一张图（200..360 × 100..220），选中它。 */
function imageInLeft(left, id = 'img_g') {
  I.rememberDecoded(id, fakeBitmap(400, 300));
  const img = I.createImageStroke({ id, width: 400, height: 300 }, { x: 200, y: 100, width: 160, height: 120 });
  left.surface.layer.add(img);
  left.surface.selection = [img.id];
  left.surface.selectionLoop = [{ x: 196, y: 96 }, { x: 364, y: 96 }, { x: 364, y: 224 }, { x: 196, y: 224 }];
  return img;
}
const imageIn = (pane) => pane.surface.layer.getAll().find((s) => S.isImageStroke(s));
const xs = (st) => st.points.map((p) => p.x);

await test('拖到一半松在对面（手指刚过分隔线、图大半还在这边）：先落在松手的位置，再整张滑进那一栏；滑完重做也是那儿', async () => {
  const [left, right] = twoPanes('lasso');
  imageInLeft(left);
  // 按在图的右边一截，只往右挪 55：手指过了分隔线（400），图大半还在左栏这边。
  left.canvas.dispatchEvent(pen('pointerdown', 350, 160));
  left.canvas.dispatchEvent(pen('pointermove', 380, 160));
  left.canvas.dispatchEvent(pen('pointermove', 405, 160));
  left.canvas.dispatchEvent(pen('pointerup', 405, 160));
  const landed = imageIn(right);
  assert.ok(landed, '右栏接住了');
  assert.deepEqual(xs(landed), [-145, 15, 15, -145], '先落在松手时的位置（和预览最后停着的一样）：大半在右栏画布外面');
  await new Promise((r) => setTimeout(r, 110));
  const mid = xs(landed)[0];
  assert.ok(mid > -145 && mid < 8, `滑到半路：${mid}`);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(xs(landed), [8, 168, 168, 8], '整张滑进来，离边留 8');
  assert.deepEqual(landed.points.map((p) => p.y), [100, 100, 220, 220], '上下本来就在里面，不动');
  assert.equal(right.surface.selectionLoop[0].x, 8 - 6, '套索线跟着滑过来');
  left.surface.undo();
  assert.equal(imageIn(right), undefined, '撤销：右栏那一份跟着走');
  left.surface.redo();
  assert.deepEqual(xs(imageIn(right)), [8, 168, 168, 8], '重做：放回滑进来以后的位置');
});

await test('拖到一半松在原栏（手指没过去、图探进了对面）：探过去的那一截滑回来，滑完才记成一步撤销', async () => {
  const [left, right] = twoPanes('lasso');
  const img = imageInLeft(left);
  left.canvas.dispatchEvent(pen('pointerdown', 220, 160));
  left.canvas.dispatchEvent(pen('pointermove', 300, 160));
  left.canvas.dispatchEvent(pen('pointermove', 380, 160));
  assert.ok(right.surface._ghost, '右栏画着探过去的那一截');
  left.canvas.dispatchEvent(pen('pointerup', 380, 160));
  assert.equal(right.surface._ghost, null, '松了手，预览收掉');
  assert.equal(imageIn(right), undefined, '手指没过去：不交出去');
  assert.deepEqual(xs(img), [360, 520, 520, 360], '先停在松手的位置');
  const steps = left.surface.history.undoStack?.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(xs(img), [232, 392, 392, 232], `探过去的那一截滑回左栏，离分隔线留 8：${xs(img)}`);
  if (steps != null) assert.equal(left.surface.history.undoStack.length, steps + 1, '滑完才记');
  left.surface.undo();
  assert.deepEqual(xs(img), [200, 360, 360, 200], '一步撤销回到拖之前');
});

await test('落在书页上：滑进页面里，不停在页外的灰边上；滑到一半又落笔，先一下滑到位', async () => {
  const [left, right] = twoPanes('lasso');
  right.surface.handlers.pageBounds = () => ({ minX: 60, minY: 0, maxX: 340, maxY: 600 });
  imageInLeft(left);
  left.canvas.dispatchEvent(pen('pointerdown', 350, 160));
  left.canvas.dispatchEvent(pen('pointermove', 405, 160));
  left.canvas.dispatchEvent(pen('pointerup', 405, 160));
  const landed = imageIn(right);
  assert.deepEqual(xs(landed), [-145, 15, 15, -145]);
  // 马上又在右栏落一笔（换了笔）：上一片先一下滑到位，不停在半路。
  right.surface.setTool('pen');
  right.canvas.dispatchEvent(pen('pointerdown', 600, 500, 9));
  assert.deepEqual(xs(landed), [68, 228, 228, 68], '收进页面里（页边 60，再留 8）');
  right.canvas.dispatchEvent(pen('pointerup', 600, 500, 9));
});

await test('减少动态效果：不滑，直接到位；普通的拖动（没探进对面）松手照旧停在松手的地方', async () => {
  const saved = globalThis.matchMedia;
  globalThis.matchMedia = (q) => ({ matches: /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
  try {
    const [left, right] = twoPanes('lasso');
    imageInLeft(left);
    left.canvas.dispatchEvent(pen('pointerdown', 350, 160));
    left.canvas.dispatchEvent(pen('pointermove', 405, 160));
    left.canvas.dispatchEvent(pen('pointerup', 405, 160));
    assert.deepEqual(xs(imageIn(right)), [8, 168, 168, 8], '一下到位');
  } finally {
    globalThis.matchMedia = saved;
  }
  const [left] = twoPanes('lasso');
  const img = imageInLeft(left, 'img_g2');
  left.canvas.dispatchEvent(pen('pointerdown', 220, 160));
  left.canvas.dispatchEvent(pen('pointermove', 220, 400));
  left.canvas.dispatchEvent(pen('pointermove', 220, 560));
  left.canvas.dispatchEvent(pen('pointerup', 220, 560)); // 往下拖出了画布底边一截，没碰到右栏
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(img.points.map((p) => p.y), [500, 500, 620, 620], '没探进对面：照旧停在松手的地方');
});

console.log(`\n═══════════════════════════════════════════════════════════════\n  ${passed} passed, ${failed} failed\n═══════════════════════════════════════════════════════════════`);
if (failed) process.exitCode = 1;
