#!/usr/bin/env node
// 液态玻璃：照 rdev/liquid-glass-react 来（src/ui/liquid-glass-react.js、src/styles/liquid-glass-react.css）。
//
// 人说「液态玻璃按钮和液态玻璃的 react 全按里面来重写」，又说「完全透明的液态，像库里展示的一样」。
// 这里钉住的是：
//
//   1. 数和滤镜是库里的：按钮用 README 的示例（位移 64、模糊 0.1、饱和度 130、色散 2、弹性 0.35）；
//      平时只弯一次（库里那张贴图、那个位移量）——库里三个通道各弯一次的色散版在平板上每隔一帧
//      50–67ms，留着逐个原语照搬的那一版对照；给 backdrop-filter 用的色散版只少那条遮罩链；
//   2. 挂层、拆层：哪些东西挂、哪些不挂（红色的删除、笔迹工具栏），字被整个换掉当场补回，
//      换到毛玻璃（改写之前那一套，同一个 data-skin、没有 data-glass）或纸全部拆干净、原来那两段折射
//      放回来；和玻璃无关的 DOM 变化不去翻整页；
//   3. 指针：鼠标、笔悬停才跟；手指不跟、按下去照样有反馈；挪到书页上当作走了；离得远一帧都不量；
//   4. 样子：完全透明（身子没有任何底色）、影子单独一层、不用混合模式、边和亮光的数是库里的；
//   5. 接线：样式在 liquid.css 之后、纸之前；按下去不再叠旧的水波纹；库的 MIT 声明留着。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

// ── 环境 ────────────────────────────────────────────────────────────────────

const dom = new JSDOM(`<!doctype html><html data-skin="liquid-math" data-glass="liquid"><body>
  <div class="pdf-page-bar">
    <div class="pdf-bar-group" style="position: relative"><button class="pdf-bar-btn">导入</button></div>
    <div class="pdf-bar-trail"><div class="pdf-bar-group is-end"><button class="pdf-bar-btn">全部关闭</button></div></div>
  </div>
  <nav class="app-nav" style="position: fixed; z-index: 1000"><div class="nav-glass-lens" aria-hidden="true" style="position: absolute; z-index: 1"></div><button>练习</button><button>设置</button></nav>
  <div class="pdf-slot-header"><button class="pdf-slot-btn is-answer-action" style="position: relative">对答案</button></div>
  <div class="settings"><button id="settingsSave" class="action-btn">保存设置</button><button class="action-btn" id="plain">别的</button></div>
  <div class="deck-dialog"><button class="deck-dialog-btn is-primary">好</button><button class="deck-dialog-btn is-danger">删除</button></div>
  <div class="ink-toolbar is-perched"><button class="ink-tool">笔</button></div>
  <div class="page"><canvas class="ink-surface"></canvas></div>
  <div class="churn"></div>
  <svg class="lg-filter-defs" width="0" height="0"><defs>
    <filter id="lg-refract"><feImage href="old"/></filter>
    <filter id="lg-refract-soft"><feImage href="old"/></filter>
  </defs></svg>
</body></html>`, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// 帧：手动推。数着排了几次，才能说「这一下什么都没排」。
let frames = [];
let rafCalls = 0;
window.requestAnimationFrame = (cb) => { rafCalls++; frames.push(cb); return frames.length; };
window.cancelAnimationFrame = () => {};
function flush() {
  for (let i = 0; i < 5 && frames.length; i++) {
    const q = frames;
    frames = [];
    for (const cb of q) cb(0);
  }
}
const microtasks = () => new Promise((r) => setTimeout(r, 0));

// 减少动态：一个能拨的开关。
const motion = { matches: false, addEventListener() {}, removeEventListener() {} };
window.matchMedia = (q) => (String(q).includes('reduced-motion') ? motion : { matches: false, addEventListener() {}, removeEventListener() {} });

for (const key of ['window', 'document', 'Event', 'PointerEvent', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Node', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { value: window[key] ?? window, configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true });

/** jsdom 不排版：给要量的元素一个位置。 */
function place(el, left, top, width, height) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
}
function move(target, pointerType, x, y, buttons = 0) {
  target.dispatchEvent(new window.PointerEvent('pointermove', { pointerType, clientX: x, clientY: y, buttons, bubbles: true }));
}

const lgr = await import('../src/ui/liquid-glass-react.js');
const maps = await import('../src/ui/liquid-glass-maps.js');
const { PRESETS, blurRadius, glassFilterMarkup, rimGradient, glassResponse, ACTIVATION_ZONE } = lgr;

/** 把一段滤镜标记按 SVG 解析出来。 */
function parseFilter(markup) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.innerHTML = markup;
  return svg.firstElementChild;
}
const scalesOf = (f) => [...f.querySelectorAll('feDisplacementMap')].map((d) => Number(d.getAttribute('scale')));

// ═══════════════════════════════════════════════════════════════
group('1. 数和滤镜是库里的');

await test('按钮用 README 里按钮那个示例的数', () => {
  assert.deepEqual({ ...PRESETS.button }, {
    displacementScale: 64, blurAmount: 0.1, saturation: 130, aberrationIntensity: 2, elasticity: 0.35, mode: 'standard',
  });
});

await test('标签里那块透镜：和按钮同一种玻璃（模糊 0.1、饱和度 130、色散 2），位移按它的个头收到 32，不弹', () => {
  assert.deepEqual({ ...PRESETS.lens }, {
    displacementScale: 32, blurAmount: 0.1, saturation: 130, aberrationIntensity: 2, elasticity: 0, mode: 'standard',
  });
});

await test('胶囊用库的默认（模糊 0.0625、饱和度 140、色散 2），位移按 44px 高收到 48，不弹', () => {
  assert.equal(PRESETS.capsule.blurAmount, 0.0625);
  assert.equal(PRESETS.capsule.saturation, 140);
  assert.equal(PRESETS.capsule.aberrationIntensity, 2);
  assert.equal(PRESETS.capsule.displacementScale, 48);
  assert.equal(PRESETS.capsule.elasticity, 0);
});

await test('空桌面那张卡片：库的默认值原样（位移 70、模糊 0.0625、饱和度 140、色散 2），不弹', () => {
  assert.deepEqual({ ...PRESETS.panel }, {
    displacementScale: 70, blurAmount: 0.0625, saturation: 140, aberrationIntensity: 2, elasticity: 0, mode: 'standard',
  });
});

await test('box、convex 两个选项只改单位和方向，别的照旧；不给就和原来一模一样', () => {
  const opts = { displacementScale: 20, aberrationIntensity: 1, mode: 'standard' };
  const plain = glassFilterMarkup('t1', opts, { backdrop: true });
  assert.ok(!/primitiveUnits/.test(plain));
  assert.match(plain, /scale="-20"/);
  const convex = glassFilterMarkup('t2', opts, { backdrop: true, convex: true });
  assert.match(convex, /scale="20"/);
  assert.ok(!/primitiveUnits/.test(convex));
});

await test('磨砂的半径：4 + blurAmount × 32', () => {
  assert.equal(blurRadius(0.0625), 6);
  assert.equal(+blurRadius(0.1).toFixed(6), 7.2);
});

await test('平时只弯一次：库里那张贴图、库里那个位移量（红通道那一次），别的一步都没有', () => {
  const f = parseFilter(glassFilterMarkup('t0', PRESETS.button));
  assert.deepEqual([...f.children].map((c) => c.localName), ['feImage', 'feDisplacementMap']);
  assert.equal(f.querySelector('feImage').getAttribute('href'), maps.STANDARD_MAP);
  assert.equal(f.querySelector('feImage').getAttribute('preserveAspectRatio'), 'xMidYMid slice');
  const d = f.querySelector('feDisplacementMap');
  assert.equal(d.getAttribute('scale'), '-64');
  assert.equal(d.getAttribute('xChannelSelector'), 'R');
  assert.equal(d.getAttribute('yChannelSelector'), 'B');
  assert.equal(f.getAttribute('x'), '0%');
  assert.equal(f.getAttribute('width'), '100%');
  assert.equal(parseFilter(glassFilterMarkup('t0b', PRESETS.capsule)).querySelector('feDisplacementMap').getAttribute('scale'), '-48');
});

await test('色散版（chromatic）逐个原语照搬：贴图、三个通道各弯一点不一样的量、柔化、边缘遮罩、合回去', () => {
  const f = parseFilter(glassFilterMarkup('t1', PRESETS.button, { chromatic: true }));
  assert.equal(f.localName, 'filter');
  assert.equal(f.getAttribute('x'), '-35%');
  assert.equal(f.getAttribute('width'), '170%');
  assert.equal(f.getAttribute('color-interpolation-filters'), 'sRGB');
  const img = f.querySelector('feImage');
  assert.equal(img.getAttribute('href'), maps.STANDARD_MAP);
  assert.equal(img.getAttribute('preserveAspectRatio'), 'xMidYMid slice');
  // 红 = -64，绿 = 64 × (-1 - 2 × 0.05)，蓝 = 64 × (-1 - 2 × 0.1)
  assert.deepEqual(scalesOf(f).map((v) => +v.toFixed(4)), [-64, -70.4, -76.8]);
  for (const d of f.querySelectorAll('feDisplacementMap')) {
    assert.equal(d.getAttribute('xChannelSelector'), 'R');
    assert.equal(d.getAttribute('yChannelSelector'), 'B');
  }
  assert.equal(f.querySelector('feGaussianBlur').getAttribute('stdDeviation'), '0.3');
  assert.equal(f.querySelector('feFuncA[type="discrete"]').getAttribute('tableValues'), '0 0.1 1');
  const blends = [...f.querySelectorAll('feBlend')].map((b) => b.getAttribute('mode'));
  assert.deepEqual(blends, ['screen', 'screen']);
  const last = f.lastElementChild;
  assert.equal(last.localName, 'feComposite');
  assert.equal(last.getAttribute('operator'), 'over');
});

await test('色散版给 backdrop-filter 用：区域收回元素本身、没有遮罩链，三个通道和柔化照旧', () => {
  const f = parseFilter(glassFilterMarkup('t2', PRESETS.button, { backdrop: true, chromatic: true }));
  assert.equal(f.getAttribute('x'), '0%');
  assert.equal(f.getAttribute('width'), '100%');
  assert.equal(f.querySelectorAll('feComposite, feComponentTransfer, feOffset').length, 0);
  assert.deepEqual(scalesOf(f).map((v) => +v.toFixed(4)), [-64, -70.4, -76.8]);
  assert.equal(f.lastElementChild.localName, 'feGaussianBlur');
  assert.equal(f.lastElementChild.getAttribute('result'), 'ABERRATED_BLURRED');
});

await test('边上那道光：135° 起，跟着指针转（库里那条式子）', () => {
  assert.equal(rimGradient({ x: 0, y: 0 }, 'screen'),
    'linear-gradient(135deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.12) 33%, rgba(255, 255, 255, 0.4) 66%, rgba(255, 255, 255, 0) 100%)');
  assert.equal(rimGradient({ x: 0, y: 0 }, 'overlay'),
    'linear-gradient(135deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.32) 33%, rgba(255, 255, 255, 0.6) 66%, rgba(255, 255, 255, 0) 100%)');
  // x = 10、y = 20：角度 135 + 12，两档各加 |x| × 0.008 / 0.012，位置 33 + 6、66 + 8
  assert.equal(rimGradient({ x: 10, y: 20 }, 'screen'),
    'linear-gradient(147deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.2) 39%, rgba(255, 255, 255, 0.52) 74%, rgba(255, 255, 255, 0) 100%)');
  // 位置夹在 10%–90%
  assert.match(rimGradient({ x: 0, y: -200 }, 'screen'), / 10%, /);
  assert.match(rimGradient({ x: 0, y: 200 }, 'screen'), / 90%, /);
});

await test('弹性：朝指针挪 dx × 弹性 × 0.1 × 淡入，朝它那个方向拉长（库里那两条式子）', () => {
  const rect = { left: 0, top: 0, width: 100, height: 40 };
  const r = glassResponse({ x: 150, y: 20 }, rect, 0.35);
  // 离右边 50px → 淡入 0.75；dx = 100
  assert.equal(+r.fade.toFixed(6), 0.75);
  assert.equal(+r.tx.toFixed(6), 2.625);
  assert.equal(r.ty, 0);
  // 拉伸 = min(100 / 300, 1) × 0.35 × 0.75 = 0.0875
  assert.equal(+r.sx.toFixed(6), 1.02625);
  assert.equal(+r.sy.toFixed(6), 0.986875);
  assert.deepEqual(r.offset, { x: 100, y: 0 });
});

await test('离边缘 200px 以外一动不动；胶囊（弹性 0）只转光、不挪不拉；再怎么拉也不小于 0.8', () => {
  const rect = { left: 0, top: 0, width: 100, height: 40 };
  const far = glassResponse({ x: 100 + ACTIVATION_ZONE + 1, y: 20 }, rect, 0.35);
  assert.deepEqual({ tx: far.tx, ty: far.ty, sx: far.sx, sy: far.sy, fade: far.fade }, { tx: 0, ty: 0, sx: 1, sy: 1, fade: 0 });
  const cap = glassResponse({ x: 150, y: 20 }, rect, 0);
  assert.deepEqual({ tx: cap.tx, ty: cap.ty, sx: cap.sx, sy: cap.sy }, { tx: 0, ty: 0, sx: 1, sy: 1 });
  assert.equal(cap.offset.x, 100);
  const wild = glassResponse({ x: 50, y: 400 }, rect, 10);
  assert.ok(wild.sx >= 0.8 && wild.sy >= 0.8);
});

// ═══════════════════════════════════════════════════════════════
group('2. 挂层、拆层');

const $ = (s) => document.querySelector(s);
lgr.initLiquidGlassReact();

await test('该挂的都挂上：顶上三枚胶囊、对答案、保存设置、对话框里的「好」', () => {
  for (const s of ['.pdf-page-bar .pdf-bar-group', '.pdf-bar-group.is-end', '.app-nav', '.is-answer-action', '#settingsSave', '.deck-dialog-btn.is-primary']) {
    assert.ok($(s).classList.contains('lgr'), `${s} 没挂上`);
  }
  assert.ok($('.app-nav').classList.contains('lgr--capsule'));
  assert.ok($('#settingsSave').classList.contains('lgr--button'));
});

await test('不挂的：红色的「删除」（一整块红是回不来的意思）、笔迹工具栏、没点名的按钮', () => {
  assert.ok(!$('.deck-dialog-btn.is-danger').classList.contains('lgr'));
  assert.ok(!$('.ink-toolbar').classList.contains('lgr'));
  assert.ok(!$('#plain').classList.contains('lgr'));
});

await test('按钮上的层：挂在最后面，顺序是 身子（裁圆角的里面套着弯背后的）、影子、三层亮光、两道边', () => {
  const kids = [...$('#settingsSave').children].map((c) => c.className);
  assert.deepEqual(kids, ['lgr-lens', 'lgr-shadow', 'lgr-glow lgr-glow--1', 'lgr-glow lgr-glow--2', 'lgr-glow lgr-glow--3', 'lgr-rim lgr-rim--screen', 'lgr-rim lgr-rim--overlay']);
  assert.equal($('#settingsSave .lgr-lens').firstElementChild.className, 'lgr-warp');
  assert.equal($('#settingsSave').firstChild.nodeValue, '保存设置', '原来的字还在最前面');
  for (const c of $('#settingsSave').children) assert.equal(c.getAttribute('aria-hidden'), 'true');
});

await test('「练习 / 设置」里标出选中那一格的透镜也是玻璃：挂 lens 那一种，没有按钮的亮光、不弹、不按', () => {
  const lens = $('.app-nav .nav-glass-lens');
  assert.ok(lens.classList.contains('lgr'));
  assert.ok(lens.classList.contains('lgr--lens'));
  assert.ok(!lens.classList.contains('lgr--button'));
  const kids = [...lens.children].map((c) => c.className);
  assert.deepEqual(kids, ['lgr-lens', 'lgr-shadow', 'lgr-rim lgr-rim--screen', 'lgr-rim lgr-rim--overlay']);
  assert.equal($('.app-nav .nav-glass-lens .lgr-warp').style.getPropertyValue('--lgr-backdrop'), 'blur(7.2px) saturate(130%)');
  assert.ok(!lens.classList.contains('lgr--stack') && !lens.classList.contains('lgr--anchor'), '它本来就定了位、有 z-index（base.css）');
  lens.dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  assert.ok(!lens.hasAttribute('data-lgr-active'));
  window.dispatchEvent(new window.PointerEvent('pointerup', { pointerType: 'touch' }));
});

await test('胶囊没有亮光那三层（库里只有能点的才有）', () => {
  const kids = [...$('.app-nav').children].filter((c) => c.className.startsWith('lgr')).map((c) => c.className);
  assert.deepEqual(kids, ['lgr-lens', 'lgr-shadow', 'lgr-rim lgr-rim--screen', 'lgr-rim lgr-rim--overlay']);
});

await test('身子的滤镜和磨砂：按这一组的数写成变量，滤镜是真在页面里的那一段', () => {
  const warp = $('#settingsSave .lgr-warp');
  const id = warp.style.getPropertyValue('--lgr-filter').match(/url\(#(.+)\)/)[1];
  const filter = document.getElementById(id);
  assert.equal(filter.namespaceURI, SVG_NS);
  assert.ok(filter.closest('.lgr-defs'));
  assert.deepEqual(scalesOf(filter), [-64], '手在屏幕上时那一版只弯一次');
  const rich = document.getElementById(warp.style.getPropertyValue('--lgr-filter-rich').match(/url\(#(.+)\)/)[1]);
  assert.deepEqual(scalesOf(rich).map((v) => +v.toFixed(4)), [-64, -70.4, -76.8], '静止时那一版是库里原样的色散');
  assert.equal(rich.querySelectorAll('feComposite').length, 3, '连边缘遮罩那条链一起');
  assert.equal(warp.style.getPropertyValue('--lgr-backdrop'), 'blur(7.2px) saturate(130%)');
  assert.equal($('.app-nav > .lgr-lens .lgr-warp').style.getPropertyValue('--lgr-backdrop'), 'blur(6px) saturate(140%)');
});

await test('同一组数只造一段滤镜（两版各一段）：按钮共用，胶囊共用，透镜自己的；工具栏那四段按固定 id', () => {
  const idOf = (s, v = '--lgr-filter') => $(s).style.getPropertyValue(v);
  const nav = '.app-nav > .lgr-lens .lgr-warp';
  for (const v of ['--lgr-filter', '--lgr-filter-rich']) {
    assert.equal(idOf('#settingsSave .lgr-warp', v), idOf('.is-answer-action .lgr-warp', v));
    assert.equal(idOf(nav, v), idOf('.pdf-bar-group.is-end .lgr-warp', v));
    assert.notEqual(idOf('#settingsSave .lgr-warp', v), idOf(nav, v));
    assert.notEqual(idOf('.nav-glass-lens .lgr-warp', v), idOf(nav, v));
  }
  const all = [...document.querySelectorAll('.lgr-defs filter')];
  const named = all.filter((f) => /^lgr-(cap|bar|drop)-/.test(f.id));
  assert.deepEqual(named.map((f) => f.id).sort(),
    ['lgr-bar-lean', 'lgr-bar-rich', 'lgr-cap-lean', 'lgr-cap-rich', 'lgr-drop-lean', 'lgr-drop-rich']);
  assert.equal(all.length - named.length, 6, '三组数（按钮、胶囊、透镜），每组两版');
});

await test('没定位的定个位，定了位的自成一层（z-index 0），本来就有 z-index 的不动', () => {
  assert.ok($('.pdf-bar-group.is-end').classList.contains('lgr--anchor'));
  assert.ok($('.pdf-page-bar > .pdf-bar-group').classList.contains('lgr--stack'));
  assert.ok(!$('.app-nav').classList.contains('lgr--anchor'));
  assert.ok(!$('.app-nav').classList.contains('lgr--stack'));
});

await test('原来那两段折射（#lg-refract、#lg-refract-soft）换成库里的，id 不变', () => {
  const hard = document.getElementById('lg-refract');
  const soft = document.getElementById('lg-refract-soft');
  assert.equal(hard.getAttribute('data-lgr'), '1');
  assert.equal(hard.getAttribute('x'), '0%');
  assert.equal(hard.querySelector('feImage').getAttribute('href'), maps.STANDARD_MAP);
  assert.deepEqual(scalesOf(hard), [-48]);
  assert.deepEqual(scalesOf(soft), [-20]);
  assert.equal(hard.querySelectorAll('feComposite, feBlend').length, 0, '那颗球浮在正在写的那一页上，每一帧都要重做它');
  assert.equal(document.querySelectorAll('#lg-refract').length, 1);
});

await test('按钮的字被整个换掉：层在下一帧之前就补回来', async () => {
  const btn = $('#settingsSave');
  const before = rafCalls;
  btn.textContent = 'Save';
  await microtasks();
  assert.equal(btn.firstChild.nodeValue, 'Save');
  assert.equal(btn.querySelectorAll(':scope > .lgr-lens, :scope > .lgr-rim').length, 3);
  assert.equal(rafCalls, before, '补层不该等一帧');
});

await test('和玻璃无关的 DOM 变化（书页一次加进一大堆字）：不排帧、不翻整页', async () => {
  const before = rafCalls;
  const layer = document.createElement('div');
  for (let i = 0; i < 300; i++) layer.appendChild(document.createElement('span'));
  $('.churn').appendChild(layer);
  await microtasks();
  assert.equal(rafCalls, before);
});

await test('新开的对话框：下一帧挂上；按钮变成红色的删除：拆掉', async () => {
  const d = document.createElement('div');
  d.className = 'deck-dialog';
  d.innerHTML = '<button class="deck-dialog-btn">取消</button>';
  document.body.appendChild(d);
  await microtasks();
  flush();
  const btn = d.querySelector('button');
  assert.ok(btn.classList.contains('lgr'));
  btn.classList.add('is-danger');
  await microtasks();
  flush();
  assert.ok(!btn.classList.contains('lgr'));
  assert.equal(btn.querySelectorAll('[class^="lgr-"]').length, 0);
});

await test('文档库每本书右上角的「⋯」也是玻璃按钮：亮光、弹性都有，位移按它 30px 的个头收到 20，影子也收小', async () => {
  // 人说「把那个按钮也改成液态玻璃，当位于液态玻璃风格时」。
  const tile = document.createElement('div');
  tile.className = 'pdf-book';
  tile.innerHTML = '<button type="button" class="pdf-book-more" aria-label="书 的更多操作">'
    + '<svg class="pdf-book-more-icon" viewBox="0 0 24 24"><path d="M5.5 12h.01M12 12h.01M18.5 12h.01"/></svg></button>';
  document.body.appendChild(tile);
  await microtasks();
  flush();
  try {
    const more = tile.querySelector('.pdf-book-more');
    assert.ok(more.classList.contains('lgr') && more.classList.contains('lgr--button'));
    assert.equal(more.querySelectorAll(':scope > .lgr-glow').length, 3, '按钮才有的三层亮光');
    assert.ok(more.querySelector('svg.pdf-book-more-icon'), '三个点还在，层挂在它后面');
    const id = /url\(#([\w-]+)\)/.exec(more.querySelector('.lgr-warp').style.getPropertyValue('--lgr-filter'))[1];
    assert.deepEqual(scalesOf(document.getElementById(id)), [-20], '位移 20，不是按钮的 64');
    const rich = /url\(#([\w-]+)\)/.exec(more.querySelector('.lgr-warp').style.getPropertyValue('--lgr-filter-rich'))[1];
    assert.deepEqual(scalesOf(document.getElementById(rich)).map((v) => +v.toFixed(2)), [-20, -22, -24]);
    const lgrCss = read('../src/styles/liquid-glass-react.css');
    assert.match(lgrCss,
      /html\[data-glass="liquid"\] \.pdf-book-more\.lgr > \.lgr-shadow \{\s*box-shadow: 0 2px 8px rgba\(0, 0, 0, 0\.16\);/);
    // 十几颗跟着书架一起滚：不上色散，手在屏幕上时只磨不弯（平板上量过，不然滚起来每帧 33–50ms）。
    assert.match(lgrCss, /html\[data-glass="liquid"\] \.pdf-book-more \.lgr-warp \{ filter: var\(--lgr-filter, none\); \}/);
    assert.match(lgrCss, /html\[data-glass="liquid"\]\.lgr-busy \.pdf-book-more \.lgr-warp \{ filter: none; \}/);
  } finally {
    tile.remove();
    await microtasks();
    flush();
  }
});

await test('空桌面那张卡片挂成一整块玻璃：没有按钮那三层亮光；它里面的导入按钮照旧是按钮；那圈细线撤掉', async () => {
  const card = document.createElement('div');
  card.className = 'pdf-empty-card';
  card.innerHTML = '<h3 class="pdf-empty-title">一边做题，一边对答案</h3><button class="pdf-empty-btn primary">导入练习册</button>';
  document.body.appendChild(card);
  await microtasks();
  flush();
  try {
    assert.ok(card.classList.contains('lgr') && card.classList.contains('lgr--panel'));
    assert.equal(card.querySelectorAll(':scope > .lgr-glow').length, 0, '卡片不是按钮');
    assert.equal(card.querySelectorAll(':scope > .lgr-rim').length, 2);
    assert.ok(card.querySelector('.pdf-empty-btn').classList.contains('lgr--button'), '玻璃叠在玻璃上');
    assert.match(read('../src/styles/liquid-glass-react.css'),
      /html\[data-glass="liquid"\] \.pdf-empty-card\.lgr \{ border-color: transparent; \}/);
  } finally {
    card.remove();
    await microtasks();
    flush();
  }
  assert.ok(!card.classList.contains('lgr'), '拿走了就拆');
});

await test('换到毛玻璃、换到纸：全部拆干净（层、类、状态、变量），原来那两段折射放回来；换回液态玻璃再挂上', async () => {
  const root = document.documentElement;
  const toSkin = (skin, glass) => {
    root.setAttribute('data-skin', skin);
    if (glass) root.setAttribute('data-glass', glass);
    else root.removeAttribute('data-glass');
    window.dispatchEvent(new window.Event('skinchange'));
  };
  const clean = (label) => {
    // 只看 body 里：html 上的 lgr-busy 是「手在屏幕上」的记号，不是挂上去的层。
    assert.equal(document.body.querySelectorAll('.lgr, [class^="lgr-"]:not(.lgr-defs), [data-lgr-hover], [data-lgr-active]').length, 0, label);
    for (const el of document.querySelectorAll('button, nav, div')) {
      assert.ok(!/--lgr-/.test(el.getAttribute('style') || ''), `${label}：${el.className} 身上还留着变量`);
    }
    assert.ok(!root.classList.contains('lgr-busy'), `${label}：lgr-busy 摘掉`);
    for (const id of ['lg-refract', 'lg-refract-soft']) {
      const f = document.getElementById(id);
      assert.equal(f.querySelector('feImage').getAttribute('href'), 'old', `${label}：#${id} 是改写之前那一段`);
      assert.equal(f.getAttribute('data-lgr'), null);
      assert.equal(document.querySelectorAll(`#${id}`).length, 1);
    }
  };
  const upgraded = document.getElementById('lg-refract');
  root.classList.add('lgr-busy');
  try {
    toSkin('liquid-math', null);
    clean('毛玻璃（同一个 data-skin，没有 data-glass）');
    // 毛玻璃里手在屏幕上：没有要换的玻璃，不挂 lgr-busy。
    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    window.dispatchEvent(new window.PointerEvent('pointerup', { pointerType: 'touch' }));
    assert.ok(!root.classList.contains('lgr-busy'), '毛玻璃里按下去不挂 lgr-busy');
    toSkin('minimal', null);
    clean('纸');
  } finally {
    toSkin('liquid-math', 'liquid');
  }
  assert.ok($('#settingsSave').classList.contains('lgr'));
  assert.ok($('.app-nav').classList.contains('lgr'));
  assert.equal(document.getElementById('lg-refract'), upgraded, '换回来放回去的是库里那一段，不重造');
  assert.equal(upgraded.getAttribute('data-lgr'), '1');
});

// ═══════════════════════════════════════════════════════════════
group('3. 指针');

const answer = $('.is-answer-action');
for (const el of lgr.attachedGlass()) place(el, 2000, 2000, 10, 10); // 其他的都放远
place(answer, 400, 100, 80, 32);

await test('鼠标走近按钮：朝它挪、朝它拉长，边上的光跟着转；还没进去就不算悬停', () => {
  const rimBefore = answer.querySelector('.lgr-rim--screen').style.background;
  move(document.body, 'mouse', 560, 116);
  flush();
  assert.ok(parseFloat(answer.style.getPropertyValue('--lgr-tx')) > 0);
  assert.equal(parseFloat(answer.style.getPropertyValue('--lgr-ty')), 0);
  assert.ok(parseFloat(answer.style.getPropertyValue('--lgr-sx')) > 1);
  assert.notEqual(answer.querySelector('.lgr-rim--screen').style.background, rimBefore);
  assert.ok(!answer.hasAttribute('data-lgr-hover'));
});

await test('走进去：悬停（第一、三层亮光由样式表按这个亮起来）', () => {
  move(document.body, 'mouse', 430, 110);
  flush();
  assert.ok(answer.hasAttribute('data-lgr-hover'));
});

await test('挪到书页上（画布）：当作指针走了，按钮回原样', () => {
  move($('canvas'), 'mouse', 440, 300);
  flush();
  assert.equal(answer.style.getPropertyValue('--lgr-tx'), '0px');
  assert.equal(answer.style.getPropertyValue('--lgr-sx'), '1');
  assert.ok(!answer.hasAttribute('data-lgr-hover'));
});

await test('手指划过去：不理，一帧都不排', () => {
  const before = rafCalls;
  move(document.body, 'touch', 430, 110);
  assert.equal(rafCalls, before);
  assert.equal(answer.style.getPropertyValue('--lgr-tx'), '0px');
});

await test('笔落下写字：当作走了，不跟着伸缩', () => {
  move(document.body, 'pen', 470, 116);
  flush();
  assert.ok(parseFloat(answer.style.getPropertyValue('--lgr-tx')) > 0, '笔悬着是跟的');
  move(document.body, 'pen', 470, 116, 1);
  flush();
  assert.equal(answer.style.getPropertyValue('--lgr-tx'), '0px');
});

await test('离哪块玻璃都远：刚量过就不再量（笔悬在书页中间时一帧什么都不做）', () => {
  move(document.body, 'mouse', 900, 900);
  flush();
  const before = rafCalls;
  move(document.body, 'mouse', 905, 900);
  move(document.body, 'mouse', 910, 902);
  assert.equal(rafCalls, before);
});

await test('按下去（手指也算）：按着的时候标上，一松手就摘掉', () => {
  answer.dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  assert.ok(answer.hasAttribute('data-lgr-active'));
  window.dispatchEvent(new window.PointerEvent('pointerup', { pointerType: 'touch' }));
  assert.ok(!answer.hasAttribute('data-lgr-active'));
  answer.dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
  window.dispatchEvent(new window.PointerEvent('pointercancel', { pointerType: 'mouse' }));
  assert.ok(!answer.hasAttribute('data-lgr-active'));
});

await test('胶囊按不下去（库里只有能点的玻璃才有按下）', () => {
  const nav = $('.app-nav');
  nav.querySelector('button').dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  assert.ok(!nav.hasAttribute('data-lgr-active'));
  window.dispatchEvent(new window.PointerEvent('pointerup', { pointerType: 'touch' }));
});

await test('手在屏幕上：一按就挂 lgr-busy（换只弯一次的）；停下半秒摘掉（换回色散）', async () => {
  const root = document.documentElement;
  root.classList.remove('lgr-busy');
  document.body.dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  assert.ok(root.classList.contains('lgr-busy'));
  window.dispatchEvent(new window.PointerEvent('pointerup', { pointerType: 'touch' }));
  await new Promise((r) => setTimeout(r, lgr.IDLE_MS - 150));
  document.body.dispatchEvent(new window.PointerEvent('pointermove', { pointerType: 'touch', bubbles: true }));
  await new Promise((r) => setTimeout(r, lgr.IDLE_MS - 150));
  assert.ok(root.classList.contains('lgr-busy'), '还在动：从最后一下算起');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!root.classList.contains('lgr-busy'), '停下半秒：换回色散');
});

await test('手离开了、东西还在动（松手以后那一页还在翻）：等它演完再换回色散', async () => {
  const root = document.documentElement;
  const leaf = document.createElement('div');
  leaf.className = 'pdf-page-leaf';
  document.body.appendChild(leaf);
  window.dispatchEvent(new window.Event('wheel'));
  await new Promise((r) => setTimeout(r, lgr.IDLE_MS + 100));
  assert.ok(root.classList.contains('lgr-busy'), '那一页还在翻');
  leaf.remove();
  await new Promise((r) => setTimeout(r, 260));
  assert.ok(!root.classList.contains('lgr-busy'));
});

await test('减少动态：不挪不拉（光照转）', () => {
  motion.matches = true;
  move(document.body, 'mouse', 560, 116);
  flush();
  assert.equal(answer.style.getPropertyValue('--lgr-tx'), '0px');
  assert.equal(answer.style.getPropertyValue('--lgr-sx'), '1');
  motion.matches = false;
  move(document.body, 'mouse', 2000, 2000);
  flush();
});

// ═══════════════════════════════════════════════════════════════
group('4. 样子');

const css = read('../src/styles/liquid-glass-react.css');
/** 选择器正好是 selector 的那一条规则（不算列在别的选择器后面、合写的那种）。 */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 选择器正好是 selector 的那一条规则（不算和别的选择器合写、列在逗号后面的那种）。 */
const rule = (selector) => {
  for (let at = code.indexOf(`${selector} {`); at >= 0; at = code.indexOf(`${selector} {`, at + 1)) {
    const before = code.slice(0, at).trimEnd();
    if (before === '' || before.endsWith('}') || before.endsWith('{')) return code.slice(at, code.indexOf('}', at) + 1);
  }
  assert.fail(`找不到 ${selector}`);
};

await test('样式表只认液态玻璃（data-glass="liquid"）：毛玻璃和它同一个 data-skin，一条都不能吃到', () => {
  assert.ok(!/data-skin/.test(code), '按 data-skin 挑的规则毛玻璃也吃');
  // 碰到应用自己那些元素的规则都挂在 data-glass 底下；不挂的只碰 JS 挂上去的那几层（.lgr-*），毛玻璃里没有。
  for (const sel of code.match(/[^{}]+(?=\{)/g).map((x) => x.trim()).filter((x) => x && !x.startsWith('@'))) {
    for (const part of sel.split(',').map((x) => x.trim())) {
      assert.ok(part.startsWith('html[data-glass="liquid"]') || /^(html\.lgr-busy )?(\.lgr|\[data-lgr)/.test(part),`「${part}」没挂在 data-glass 底下`);
    }
  }
});

await test('完全透明：身子没有任何底色；元素自己的底、磨砂、影子都撤掉', () => {
  assert.match(rule('.lgr-warp'), /background:\s*none;/);
  assert.ok(!/--lgr-fill/.test(code), '不该再有铺在身子上的那层底色');
  // 合写的那一条：.lgr.lgr 和 #settingsSave.lgr（它原来的底色是 id 级的 !important）。
  const at = code.indexOf('html[data-glass="liquid"] #settingsSave.lgr {');
  assert.ok(at >= 0 && code.slice(code.lastIndexOf('}', at), at).includes('html[data-glass="liquid"] .lgr.lgr,'));
  const own = code.slice(at, code.indexOf('}', at) + 1);
  assert.match(own, /background:\s*transparent !important/);
  assert.match(own, /backdrop-filter:\s*none !important/);
  assert.match(own, /box-shadow:\s*none !important/);
  assert.match(own, /overflow:\s*visible !important/);
});

await test('透镜不是一层白：底和高光由 .lgr.lgr 撤掉（和 liquid.css 那条一样具体、排在它后面）；影子按它的个头收', () => {
  const liquid = read('../src/styles/liquid.css');
  assert.match(liquid, /html\[data-skin\] \.app-nav \.nav-glass-lens \{[^}]*background: var\(--lg-bubble\) !important/, '前提：liquid.css 那条还是白的');
  const main = read('../src/main.js');
  assert.ok(main.indexOf("import './styles/liquid-glass-react.css'") > main.indexOf("import './styles/liquid.css'"));
  assert.ok(code.includes('html[data-glass="liquid"] .lgr.lgr,'), '和 liquid.css 那条一样具体：html + 属性 + 两个类');
  assert.match(rule('html[data-glass="liquid"] .lgr--lens > .lgr-shadow'), /box-shadow:\s*0 4px 14px rgba\(0, 0, 0, 0\.18\)/);
});

await test('影子是库里那一圈（0 12px 40px、四分之一的黑），单独一层', () => {
  assert.match(code, /--lgr-shadow:\s*0 12px 40px rgba\(0, 0, 0, 0\.25\)/);
  assert.match(rule('.lgr-shadow'), /box-shadow:\s*var\(--lgr-shadow\)/);
  assert.match(rule('.lgr-shadow'), /z-index:\s*-1/);
});

await test('不用混合模式（有一层混合，整块玻璃就自成一组，身子看不到背后）', () => {
  assert.ok(!/mix-blend-mode/.test(code));
});

await test('两道边：1.5px 一圈，内容框和边框框异或，库里那三道内外影；淡的那道 0.2', () => {
  const rim = rule('.lgr-rim');
  assert.match(rim, /padding:\s*1\.5px/);
  assert.match(rim, /linear-gradient\(#000 0 0\) content-box, linear-gradient\(#000 0 0\)/);
  assert.match(rim, /mask-composite:\s*exclude/);
  assert.match(rim, /0 0 0 0\.5px rgba\(255, 255, 255, 0\.5\) inset/);
  assert.match(rim, /0 1px 3px rgba\(255, 255, 255, 0\.25\) inset/);
  assert.match(rim, /0 1px 4px rgba\(0, 0, 0, 0\.35\)/);
  assert.match(rule('.lgr-rim--screen'), /opacity:\s*0\.2/);
});

await test('亮光：库里那三层径向光，悬停 / 按着各亮多少也照库里', () => {
  assert.match(code, /\.lgr-glow--1 \{ background-image: radial-gradient\(circle at 50% 0%, rgba\(255, 255, 255, 0\.5\) 0%, rgba\(255, 255, 255, 0\) 50%\)/);
  assert.match(code, /\.lgr-glow--2 \{ background-image: radial-gradient\(circle at 50% 0%, rgba\(255, 255, 255, 1\) 0%, rgba\(255, 255, 255, 0\) 80%\)/);
  assert.match(code, /\.lgr-glow--3 \{ background-image: radial-gradient\(circle at 50% 0%, rgba\(255, 255, 255, 1\) 0%, rgba\(255, 255, 255, 0\) 100%\)/);
  assert.match(code, /\[data-lgr-active\] > \.lgr-glow--2 \{ opacity: 0\.5; \}/);
  assert.match(code, /\[data-lgr-hover\] > \.lgr-glow--3 \{ opacity: 0\.4; \}/);
  assert.match(code, /\[data-lgr-active\]:not\(\[data-lgr-hover\]\) > \.lgr-glow--3 \{ opacity: 0\.8; \}/);
});

await test('按下去 0.96，挪和拉 0.2 秒 ease-out 跟过去', () => {
  assert.match(code, /\.lgr--button\[data-lgr-active\]:not\(:disabled\) \{ scale: 0\.96 !important; \}/);
  const btn = rule('html[data-glass="liquid"] .lgr--button');
  assert.match(btn, /translate 0\.2s ease-out/);
  assert.match(btn, /scale 0\.2s ease-out/);
});

await test('放滤镜的那张 SVG 不能 display: none（Chromium 会找不到滤镜）', () => {
  assert.ok(!/display:\s*none/.test(rule('.lgr-defs')));
});

await test('停进顶栏的工具栏和三枚胶囊对齐：透明、同样的磨砂、同样的弯和影子', () => {
  const perched = css.slice(css.indexOf('html[data-glass="liquid"] .ink-toolbar.is-perched:not(.is-docked),'));
  const body = perched.slice(0, perched.indexOf('}') + 1);
  assert.match(body, /background:\s*transparent/);
  assert.match(body, /backdrop-filter:\s*blur\(6px\) saturate\(140%\) url\(#lgr-cap-rich\)/);
  assert.match(body, /box-shadow:\s*var\(--lgr-shadow\)/);
});

await test('静止用库里原样的色散，手在屏幕上（html.lgr-busy）换成只弯一次的', () => {
  assert.match(rule('.lgr-warp'), /filter:\s*var\(--lgr-filter-rich, var\(--lgr-filter, none\)\)/);
  assert.match(code, /html\.lgr-busy \.lgr-warp \{ filter: var\(--lgr-filter, none\); \}/);
});

await test('工具栏边上也弯：浮在书页上的（lgr-bar，先磨后弯）、收成球的、停进顶栏的（lgr-cap），各有静止 / 手在屏幕上两版', () => {
  const pairs = [
    ['html[data-glass="liquid"] .ink-toolbar:not(.is-perched):not(.is-docked):not(.is-dragging) {', 'var(--glass-blur) url(#lgr-bar-rich)', 'var(--glass-blur) url(#lgr-bar-lean)'],
    ['html[data-glass="liquid"] .ink-toolbar:not(.is-perched) .ink-token {', 'blur(3px) saturate(180%) url(#lgr-cap-rich)', 'blur(3px) saturate(180%) url(#lgr-cap-lean)'],
    ['html[data-glass="liquid"] .ink-toolbar.is-perched .ink-token {', 'blur(6px) saturate(140%) url(#lgr-cap-rich)', 'blur(6px) saturate(140%) url(#lgr-cap-lean)'],
  ];
  for (const [selector, still, busy] of pairs) {
    const at = code.indexOf(selector);
    assert.ok(at >= 0, `找不到 ${selector}`);
    assert.ok(code.slice(at, code.indexOf('}', at)).includes(`backdrop-filter: ${still};`), `${selector} 静止时是 ${still}`);
    const busySel = selector.replace('html[data-glass="liquid"]', 'html[data-glass="liquid"].lgr-busy');
    const bt = code.indexOf(busySel);
    assert.ok(bt >= 0, `找不到 ${busySel}`);
    assert.ok(code.slice(bt, code.indexOf('}', bt)).includes(`backdrop-filter: ${busy};`), `${busySel} 手在屏幕上时是 ${busy}`);
  }
});

await test('工具栏那几段滤镜：浮着的那条贴图按它细长的比例拉满（长边也弯），色散版给 backdrop 用、没有遮罩链', () => {
  const bar = document.getElementById('lgr-bar-rich');
  assert.equal(bar.querySelector('feImage').getAttribute('preserveAspectRatio'), 'none');
  assert.deepEqual(scalesOf(bar).map((v) => +v.toFixed(4)), [-32, -35.2, -38.4]);
  assert.equal(bar.querySelectorAll('feComposite, feComponentTransfer').length, 0);
  assert.equal(bar.getAttribute('x'), '0%');
  assert.deepEqual(scalesOf(document.getElementById('lgr-bar-lean')), [-32]);
  const cap = document.getElementById('lgr-cap-rich');
  assert.equal(cap.querySelector('feImage').getAttribute('preserveAspectRatio'), 'xMidYMid slice');
  assert.deepEqual(scalesOf(cap).map((v) => +v.toFixed(4)), [-48, -52.8, -57.6]);
  assert.deepEqual(scalesOf(document.getElementById('lgr-cap-lean')), [-48]);
});

await test('划着挑那块玻璃（lgr-drop-*）：凸的、按它自己的大小算——位移是边长的 0.16，三个通道 0.16 / 0.144 / 0.128', () => {
  const lean = document.getElementById('lgr-drop-lean');
  const rich = document.getElementById('lgr-drop-rich');
  for (const f of [lean, rich]) {
    assert.equal(f.getAttribute('primitiveUnits'), 'objectBoundingBox', '在顶栏里缩到 0.62、贴边时是 1：按像素给一个数，弯的程度跟着变');
    const img = f.querySelector('feImage');
    assert.deepEqual(['x', 'y', 'width', 'height'].map((a) => img.getAttribute(a)), ['0', '0', '1', '1']);
    assert.equal(f.getAttribute('x'), '0%', '给 backdrop-filter 用：区域就是它自己');
  }
  assert.deepEqual(scalesOf(lean), [0.16], '正的：中间放大（库里负的是把背后缩小，压在一个图标上会把它推偏）');
  assert.deepEqual(scalesOf(rich).map((v) => +v.toFixed(4)), [0.16, 0.144, 0.128]);
  assert.equal(rich.querySelectorAll('feComposite, feComponentTransfer').length, 0, '没有遮罩链');
  assert.ok(+rich.querySelector('feGaussianBlur').getAttribute('stdDeviation') < 0.01, '柔化按边长折过去，不是 0.3 个边长');
});

// ═══════════════════════════════════════════════════════════════
group('5. 接线');

await test('样式在 liquid.css 之后、纸之前', () => {
  const main = read('../src/main.js');
  const a = main.indexOf("import './styles/liquid.css'");
  const b = main.indexOf("import './styles/liquid-glass-react.css'");
  const c = main.indexOf("import './styles/paper.css'");
  assert.ok(a >= 0 && b > a && c > b);
});

await test('启动时在 initLiquidGlass 之后挂上', () => {
  const app = read('../src/core/app.js');
  const a = app.indexOf('initLiquidGlass();');
  const b = app.indexOf('initLiquidGlassReact();');
  assert.ok(a >= 0 && b > a);
});

await test('按下挂着玻璃的按钮，不再叠旧的鼓起和水波纹；别的按钮照旧', async () => {
  const { initLiquidGlass, destroyLiquidGlass } = await import('../src/ui/liquid-glass.js');
  initLiquidGlass();
  try {
    const glass = $('#settingsSave');
    glass.dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, clientX: 5, clientY: 5 }));
    assert.equal(glass.querySelectorAll('.liquid-ripple-wave').length, 0);
    assert.ok(!glass.classList.contains('liquid-bulge-press'));
    window.dispatchEvent(new window.PointerEvent('pointerup', { pointerType: 'touch' }));
    const plain = $('#plain');
    plain.dispatchEvent(new window.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, clientX: 5, clientY: 5 }));
    assert.equal(plain.querySelectorAll('.liquid-ripple-wave').length, 1);
    window.dispatchEvent(new window.PointerEvent('pointerup', { pointerType: 'touch' }));
  } finally {
    destroyLiquidGlass();
  }
});

await test('库的 MIT 声明原样留在贴图模块里', () => {
  const src = read('../src/ui/liquid-glass-maps.js');
  assert.match(src, /Copyright 2025 MAX ROVENSKY/);
  assert.match(src, /Permission is hereby granted, free of charge/);
  assert.match(maps.STANDARD_MAP, /^data:image\/jpeg;base64,/);
});

await test('拆掉：监听都还回去，层都收走', () => {
  lgr.destroyLiquidGlassReact();
  assert.equal(document.querySelectorAll('.lgr, [class^="lgr-"]:not(.lgr-defs)').length, 0);
  assert.equal(document.getElementById('lg-refract').querySelector('feImage').getAttribute('href'), 'old', '原来那段折射放回来');
  const before = rafCalls;
  move(document.body, 'mouse', 430, 110);
  assert.equal(rafCalls, before);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
