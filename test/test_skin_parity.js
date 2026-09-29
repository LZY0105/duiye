#!/usr/bin/env node
// 三套皮肤（液态玻璃、毛玻璃、纸）是同一套界面：尺寸和排法一样，只换材质；换的那一下什么都不挪。
// 液态玻璃和毛玻璃是同一个 data-skin（liquid-math），差的是 data-glass="liquid" 上挂的那几层。
// 顺带钉住这一轮的几件小事：栏头收成胶囊、划的时候按下去那一格不陷着、找页面板那三页
// 能划、竖着划让给顶上那一排的收起。
//
//   1. 纸只换材质：liquid.css 两套一起用；paper.css 里没有一条改尺寸的声明（伪元素上的装饰、
//      大标题的宋体除外）；旧的那几条会改尺寸的纸规则（横杠 49 高、标签 36 高、按钮多 1px 的边、
//      650 的字重）都拆了；
//   2. 换皮肤那一下（settings.js 的 applySkin）：什么都不过渡、当场发 skinchange、不认识
//      的名字按默认的来；液态玻璃 ↔ 毛玻璃只换 data-glass，也算换；
//   3. 栏头：一枚按内容收着的胶囊；阶梯量的是「这一栏能给多宽」，不是胶囊自己；
//   4. 划与点：工具栏上划着挑的时候，一开始按下的那一格不陷着；找页面板那三页挂上会滑的
//      透镜；横着的透镜碰上竖着走的手指就放手；
//   5. 纸是纸，不是玻璃套皮：纸带、荧光笔、钢笔、叠纸的影子；拖着工具栏时不磨砂。

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
const $read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf-8');
const noComments = (css) => css.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'localStorage', 'Event', 'PointerEvent', 'MouseEvent',
  'HTMLElement', 'Element', 'MutationObserver', 'getComputedStyle']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
// 动画当场演完：这里测的是结果。
globalThis.requestAnimationFrame = (cb) => { cb(0); return 1; };
globalThis.cancelAnimationFrame = () => {};
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};

const liquid = $read('src/styles/liquid.css');
const paper = $read('src/styles/paper.css');

// ═══════════════════════════════════════════════════════════════
group('1. 纸只换材质');

await test('liquid.css 两套皮肤一起用：没有一条只挂在玻璃上', () => {
  assert.ok(!liquid.includes('html[data-skin="liquid-math"]'), '挂在玻璃上的那一条，纸就没有，一换皮肤它就变样');
  assert.ok((liquid.match(/html\[data-skin\] /g) || []).length > 150);
});

await test('paper.css 在 liquid.css 后面引入：同样具体、更晚，纸的材质才压得住', () => {
  const main = $read('src/main.js');
  const a = main.indexOf("import './styles/liquid.css';");
  const b = main.indexOf("import './styles/paper.css';");
  assert.ok(a > 0 && b > a);
});

await test('paper.css 里没有一条改尺寸的声明：只有颜色、底、边的颜色、影子、圆角、磨砂', () => {
  const material = /^(--[\w-]+|background|background-color|box-shadow|color|backdrop-filter|border-radius|border-color|border)$/;
  // 画在伪元素上的装饰（纸带）不占地方：absolute、不接手指，它可以有自己的位置和进出场。
  const decoration = /^(content|display|position|z-index|top|right|bottom|left|inset|pointer-events|animation)$/;
  // 大标题换宋体：它们不是能按的东西，旁边也没有谁按它们的宽度摆。
  const headings = ['.pdf-library-header strong', '.settings-title', '.guide-head h2', '.guide-chapter-title',
    '.deck-dialog-title', '.pdf-empty-title'];
  const bad = [];
  const body = noComments(paper);
  for (const block of body.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sels = block[1].split(',').map((x) => x.trim()).filter(Boolean);
    // 宋体那一份 @font-face 只是告诉 WebView 去哪儿找字，不是一条规则。
    if (sels.length === 1 && sels[0] === '@font-face') continue;
    const pseudo = sels.length > 0 && sels.every((x) => /::(before|after)$/.test(x));
    const heading = sels.length > 0 && sels.every((x) => headings.some((h) => x.endsWith(h)));
    for (const decl of block[2].split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim();
      const value = decl.slice(at + 1).trim();
      if (!prop) continue;
      if (material.test(prop)) {
        // border 只许写成 0（和玻璃一样没有边）——有宽度的边会让它胖一圈。
        if (prop === 'border' && value !== '0') bad.push(`${sels[0]} → ${prop}: ${value}`);
        continue;
      }
      if (pseudo && decoration.test(prop)) continue;
      if (heading && prop === 'font-family') continue;
      bad.push(`${sels[0]} → ${prop}: ${value}`);
    }
  }
  assert.deepEqual(bad, []);
});

await test('旧的那几条会改尺寸的纸规则都拆了', () => {
  const pdf = noComments($read('src/styles/pdf.css'));
  assert.ok(!/\[data-skin="minimal"\] \.app-nav \{[^}]*--app-nav-h/.test(pdf), '两个标签 36 高');
  assert.ok(!/\[data-skin="minimal"\] \.pdf-bar-btn \{[^}]*border:\s*1px/.test(pdf), '按钮多一圈 1px 的边');
  assert.ok(!/\[data-skin="minimal"\] #page-pdf\.active > \.pdf-page-bar/.test(pdf), '一整条白底横条的进出场');
  assert.ok(!/\[data-skin="minimal"\] \.pdf-workspace \{/.test(pdf), '工作区另一套内边距');
  const base = noComments($read('src/styles/base.css'));
  assert.ok(!/\[data-skin="minimal"\] \.app-nav button\.active \{[^}]*font-weight:\s*650/.test(base), '650 的字重让标签宽一截');
  assert.ok(!/\[data-skin="minimal"\] \.action-btn \{[^}]*border:\s*1px/.test(base));
  const ink = noComments($read('src/styles/ink-toolbar.css'));
  assert.ok(!ink.includes('[data-skin="minimal"]'), '笔迹栏的纸挪进了 paper.css，不在两处各写一套');
  const p = noComments(paper);
  const token = p.slice(p.indexOf('html[data-skin="minimal"] .ink-token {'));
  assert.ok(/border: 0;/.test(token.slice(0, token.indexOf('}'))), '收起来那颗球的边画成影子');
});

await test('纸里栏头上的「对答案」是钢笔线框出来的一格，不是一块墨（一整块实心的压在细线图标中间太重）', () => {
  const at = paper.indexOf('html[data-skin="minimal"] .pdf-slot-btn.is-answer-action {');
  assert.ok(at > 0);
  const rule = paper.slice(at, paper.indexOf('}', at));
  assert.ok(/background: transparent;/.test(rule) && /color: var\(--p-pen\);/.test(rule));
  assert.ok(/box-shadow: inset 0 0 0 1px/.test(rule), '一道线框');
  // liquid.css 里「按下去」那条（.pdf-slot-btn:active:not(:disabled)）更具体，会把字换成墨：这里按下去也得说一遍。
  const a = paper.indexOf('html[data-skin="minimal"] .pdf-slot-btn.is-answer-action:active:not(:disabled) {');
  assert.ok(a > 0 && /color: var\(--p-pen\);/.test(paper.slice(a, paper.indexOf('}', a))), '按下去还是钢笔色的字');
});

await test('写死的蓝跟着皮肤走：纸上它们是墨', () => {
  for (const f of ['src/styles/deck.css', 'src/styles/scratch.css']) {
    assert.ok(!/rgba\(37, 99, 235/.test(noComments($read(f))), f);
  }
});

// ═══════════════════════════════════════════════════════════════
group('2. 换皮肤那一下');

document.body.innerHTML = `
  <select id="setSkinSelect">
    <option value="liquid-math">液态玻璃</option>
    <option value="frosted">毛玻璃</option>
    <option value="minimal">纸</option>
  </select>`;
dom.window.localStorage.setItem('ls_skin', 'glass-v1');   // 老版本的名字
const { initSettings } = await import('../src/settings/settings.js');
const skinEvents = [];
window.addEventListener('skinchange', () => {
  skinEvents.push({
    skin: document.documentElement.getAttribute('data-skin'),
    glass: document.documentElement.getAttribute('data-glass'),
    reskinning: document.documentElement.classList.contains('is-reskinning'),
  });
});
initSettings();

await test('不认识的名字按默认的来：页面不能没穿衣服，下拉框不能是空的', () => {
  assert.equal(document.documentElement.getAttribute('data-skin'), 'liquid-math');
  assert.equal(document.documentElement.getAttribute('data-glass'), 'liquid', '默认是液态玻璃');
  assert.equal(document.getElementById('setSkinSelect').value, 'liquid-math');
  assert.equal(dom.window.localStorage.getItem('ls_skin'), 'liquid-math');
});

await test('换的那一下：先关掉过渡、再换、当场发 skinchange；之后放开', () => {
  skinEvents.length = 0;
  const sel = document.getElementById('setSkinSelect');
  sel.value = 'minimal';
  sel.dispatchEvent(new Event('change'));
  assert.equal(document.documentElement.getAttribute('data-skin'), 'minimal');
  assert.deepEqual(skinEvents, [{ skin: 'minimal', glass: null, reskinning: true }], '发的时候新皮肤已经挂上、过渡还关着');
  assert.ok(!document.documentElement.classList.contains('is-reskinning'), '两帧之后放开（这里的帧是当场走完的）');
  sel.dispatchEvent(new Event('change'));
  assert.equal(skinEvents.length, 1, '没换就不发');
});

await test('三套：液态玻璃 = liquid-math + data-glass="liquid"，毛玻璃 = liquid-math、不挂 data-glass；两者之间换也算换', () => {
  const root = document.documentElement;
  const sel = document.getElementById('setSkinSelect');
  const pick = (value) => { sel.value = value; sel.dispatchEvent(new Event('change')); };
  skinEvents.length = 0;
  pick('frosted');
  assert.equal(root.getAttribute('data-skin'), 'liquid-math');
  assert.ok(!root.hasAttribute('data-glass'));
  assert.equal(dom.window.localStorage.getItem('ls_skin'), 'frosted', '存的是下拉框里那个名字');
  pick('liquid-math');
  assert.equal(root.getAttribute('data-glass'), 'liquid');
  pick('frosted');
  assert.deepEqual(skinEvents, [
    { skin: 'liquid-math', glass: null, reskinning: true },
    { skin: 'liquid-math', glass: 'liquid', reskinning: true },
    { skin: 'liquid-math', glass: null, reskinning: true },
  ], 'data-skin 没变、data-glass 变了也发 skinchange（液态玻璃那几层靠它拆、挂）');
  pick('liquid-math');
});

await test('三套都在下拉框里，名字走词表：液态玻璃 / 毛玻璃 / 纸', async () => {
  const html = $read('index.html');
  const at = html.indexOf('<select class="set-select" id="setSkinSelect">');
  const select = html.slice(at, html.indexOf('</select>', at));
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)" data-i18n="([^"]+)">([^<]+)<\/option>/g)].map((m) => m.slice(1)), [
    ['liquid-math', 'skin.liquid', '液态玻璃'],
    ['frosted', 'skin.frosted', '毛玻璃'],
    ['minimal', 'skin.paper', '纸'],
  ]);
  const langs = {
    'zh-CN': ['液态玻璃', '毛玻璃', '纸'],
    'zh-TW': ['液態玻璃', '毛玻璃', '紙'],
    en: ['Liquid Glass', 'Frosted Glass', 'Paper'],
  };
  for (const [lang, names] of Object.entries(langs)) {
    const words = (await import(`../src/core/lang/${lang}.js`)).default;
    assert.deepEqual([words['skin.liquid'], words['skin.frosted'], words['skin.paper']], names, lang);
  }
});

await test('关掉过渡的那条规则：连伪元素一起，!important', () => {
  const base = $read('src/styles/base.css');
  assert.ok(/html\.is-reskinning \*,\s*html\.is-reskinning \*::before,\s*html\.is-reskinning \*::after \{ transition: none !important; \}/.test(base));
});

// ═══════════════════════════════════════════════════════════════
group('3. 栏头');

await test('栏头是一枚按内容收着的胶囊，摆在正中；切换条是一行字，不横贯整栏', () => {
  const at = liquid.indexOf('html[data-skin] .pdf-slot-toolbar {');
  const rule = noComments(liquid.slice(at, liquid.indexOf('}', at)));
  assert.ok(/width: fit-content;/.test(rule) && /align-self: center;/.test(rule));
  assert.ok(/max-width: calc\(100% - 2 \* var\(--slot-bar-gutter\)\);/.test(rule));
  assert.ok(!/border-bottom:\s*0\.5px/.test(rule), '底下不再划一道线');
  const s = liquid.indexOf('html[data-skin] .deck-strip {');
  const strip = noComments(liquid.slice(s, liquid.indexOf('}', s)));
  assert.ok(/width: fit-content;/.test(strip) && /background: transparent;/.test(strip));
});

await test('阶梯量的是这一栏能给多宽：胶囊收着的时候，它自己的宽度永远是「刚好」', async () => {
  const { PdfWorkspace } = await import('../src/pdf/pdf-workspace.js');
  const ws = Object.create(PdfWorkspace.prototype);
  ws._headerWanted = {};
  const slot = document.createElement('div');
  const bar = document.createElement('div');
  bar.className = 'pdf-slot-toolbar';
  bar.style.setProperty('--slot-bar-gutter', '10px');
  slot.appendChild(bar);
  document.body.appendChild(slot);
  let content = 640;
  Object.defineProperty(slot, 'clientWidth', { get: () => 585, configurable: true });
  // 胶囊按内容收着：放得下时它和内容一样宽，放不下时被 max-width 夹在 565。
  Object.defineProperty(bar, 'clientWidth', { get: () => Math.min(content, 565), configurable: true });
  Object.defineProperty(bar, 'scrollWidth', { get: () => content, configurable: true });
  ws.elSlots = { a: slot, b: null };
  ws._syncPaneHeaderFit();
  assert.ok(slot.classList.contains('is-snug'), '放不下：收第一级');
  content = 470;   // 收了一级之后只要 470
  ws._syncPaneHeaderFit();
  assert.ok(slot.classList.contains('is-snug'), '565 还没宽过 640 + 8：不回来');
  Object.defineProperty(slot, 'clientWidth', { get: () => 700, configurable: true });
  ws._syncPaneHeaderFit();
  assert.ok(!slot.classList.contains('is-snug'), '栏宽了（680 > 648）就回来——胶囊自己此刻才 470 宽，拿它量永远回不来');
  slot.remove();
});

await test('收了一级、宽度落地之后自己再量一次：胶囊被上限夹着，没有观察器会再叫它', async () => {
  // 真机上左栏 471 宽、内容 558：只收了第一级，「专注」「⋯」被挤出胶囊看不见。
  const { PdfWorkspace } = await import('../src/pdf/pdf-workspace.js');
  const ws = Object.create(PdfWorkspace.prototype);
  ws._headerWanted = {};
  const slot = document.createElement('div');
  const bar = document.createElement('div');
  bar.className = 'pdf-slot-toolbar';
  bar.style.setProperty('--slot-bar-gutter', '10px');
  slot.appendChild(bar);
  document.body.appendChild(slot);
  const needs = [640, 558, 450];
  const level = () => ['is-snug', 'is-snugger'].filter((c) => slot.classList.contains(c)).length;
  Object.defineProperty(slot, 'clientWidth', { get: () => 471, configurable: true });
  Object.defineProperty(bar, 'clientWidth', { get: () => Math.min(needs[level()], 451), configurable: true });
  Object.defineProperty(bar, 'scrollWidth', { get: () => needs[level()], configurable: true });
  let settling = false;
  bar.getAnimations = () => (settling ? [{ playState: 'running', transitionProperty: 'max-width' }] : []);
  ws.elSlots = { a: slot, b: null };
  ws._syncPaneHeaderFit();
  assert.ok(slot.classList.contains('is-snug') && !slot.classList.contains('is-snugger'), '收第一级');
  settling = true;
  ws._syncPaneHeaderFit();
  assert.ok(!slot.classList.contains('is-snugger'), '宽度还在过渡：不判');
  settling = false;
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(slot.classList.contains('is-snugger'), '落地之后自己又量了一次，收到放得下为止');
  slot.remove();
});

await test('最窄那一级按钮再收一点：472 宽的一栏书，两级都收了也要放得下「⋯」', () => {
  assert.ok(liquid.includes('html[data-skin] .pdf-ws-slot.is-snugger .pdf-slot-btn { min-width: 30px; padding-inline: 4px; }'));
  assert.ok(liquid.includes('html[data-skin] .pdf-ws-slot.is-snugger .pdf-slot-page { width: 34px; }'));
});

await test('收读数的时候，读数的最小宽度跟着归零（不然 − 和 + 之间空出一大截）', () => {
  assert.ok(/html\[data-skin\] \.pdf-ws-slot\.is-snugger \.pdf-slot-zoom \{ min-width: 0; \}/.test(liquid));
});

await test('草稿纸的「回原点」「适合全部」是图标，字在 aria-label 里；存好了只是一个小勾', () => {
  const ws = $read('src/pdf/pdf-workspace.js');
  assert.ok(/data-role="scratch-origin"><svg class="pdf-slot-icon"/.test(ws));
  assert.ok(/data-role="scratch-fit"><svg class="pdf-slot-icon"/.test(ws));
  assert.ok(/set\('scratch-origin', n => labelled\(n, t\('scratch\.origin'\)\)\);/.test(ws));
  assert.ok(/if \(state === SAVE_STATES\.SAVED\) n\.innerHTML = SAVED_ICON;/.test(ws));
  assert.ok(!/\[data-role="scratch-origin"\],\s*html\[data-skin\] \[data-role="scratch-fit"\] \{/.test(liquid), '那两枚灰胶囊的样式拆了');
});

await test('触摸屏上不留悬停：栏头、顶上那一排的悬停只给真能悬停的设备', () => {
  const plain = noComments(liquid);
  for (const sel of ['.pdf-slot-btn:hover', '.pdf-page-bar .pdf-bar-btn:hover', '.deck-arrow:hover']) {
    const at = plain.indexOf(`html[data-skin] ${sel}`);
    assert.ok(at > 0, sel);
    const before = plain.slice(0, at);
    assert.ok(before.lastIndexOf('@media (hover: hover) and (pointer: fine)') > before.lastIndexOf('}\n}'),
      `${sel} 在 hover 媒体查询里`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('4. 划与点');

await test('划着挑搬到了工具栏上：一开始按下去的那一格不陷着——这一条比「按下去」那两条（:active、按压鼓起）都具体', () => {
  const ink = noComments($read('src/styles/ink-toolbar.css'));
  const at = ink.indexOf('.ink-tools.is-scrubbing .ink-tool:active,');
  assert.ok(at > 0);
  const rule = ink.slice(at, ink.indexOf('}', at));
  assert.ok(rule.includes('.ink-tools.is-scrubbing .ink-tool.liquid-bulge-press'));
  assert.ok(rule.includes('.ink-swatches.is-scrubbing .ink-swatch:active'));
  assert.ok(/scale: 1;/.test(rule) && /box-shadow: none;/.test(rule));
  // 左边那枚胶囊不再划：它那一条拆了。
  assert.ok(!noComments(liquid).includes('.pdf-bar-group.is-scrubbing'));
});

const { initLiquidGlass, destroyLiquidGlass } = await import('../src/ui/liquid-glass.js');

function panelTabs() {
  document.body.innerHTML = `
    <div class="pdf-panel-tabs" role="tablist">
      <button class="pdf-panel-tab is-selected" data-tab="outline">目录</button>
      <button class="pdf-panel-tab" data-tab="thumbs">缩略图</button>
      <button class="pdf-panel-tab" data-tab="marks">书签</button>
    </div>`;
  const tabs = document.querySelector('.pdf-panel-tabs');
  tabs.getBoundingClientRect = () => ({ left: 100, right: 386, top: 50, bottom: 85, width: 286, height: 35 });
  const items = [...tabs.querySelectorAll('.pdf-panel-tab')];
  const clicks = items.map(() => 0);
  items.forEach((b, i) => {
    const left = 103 + i * 94;
    b.getBoundingClientRect = () => ({ left, right: left + 92, top: 53, bottom: 82, width: 92, height: 29 });
    b.addEventListener('click', () => {
      clicks[i]++;
      items.forEach((x) => x.classList.toggle('is-selected', x === b));
    });
  });
  const fire = (type, x, y, target = tabs) => target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 3, pointerType: 'touch', clientX: x, clientY: y, button: 0,
  }));
  return { tabs, items, clicks, fire };
}

await test('左边那枚胶囊里没有常亮的那一格：四个都是动作，亮只亮在按下、单子开着', () => {
  // 人说「新建纸张一直是蓝色，点别的按钮它也不会刷新」——看上去像被选中了、卡住了。
  const html = $read('index.html');
  const lead = html.slice(html.indexOf('<div class="pdf-page-bar">'), html.indexOf('pdf-bar-nav-slot'));
  assert.ok(!/is-accent/.test(lead), '按钮上不挂常亮的类');
  assert.ok(!/\.pdf-page-bar \.pdf-bar-btn\.is-accent/.test(noComments(liquid)), '样式表里也没有');
  const at = liquid.indexOf('html[data-skin] .pdf-page-bar .pdf-bar-btn[aria-expanded="true"] {');
  assert.ok(at > 0 && /var\(--lg-bubble\)/.test(liquid.slice(at, liquid.indexOf('}', at))), '单子开着的时候是一颗泡');
});

await test('找页面板那三页挂上会滑的透镜：横着划，松在哪一格就是哪一格', () => {
  const { tabs, clicks, fire, items } = panelTabs();
  initLiquidGlass();
  assert.ok(tabs.querySelector('.segmented-glass-lens'), '挂上了');
  fire('pointerdown', 149, 68, items[0]);
  for (const x of [155, 170, 220, 280, 330]) fire('pointermove', x, 69);
  fire('pointerup', 330, 69);
  assert.deepEqual(clicks, [0, 0, 1], '松在「书签」上');
  destroyLiquidGlass();
});

await test('竖着走的手指不归横着的透镜：它放手，也不替人点最近的那一格', () => {
  const { clicks, fire, items } = panelTabs();
  initLiquidGlass();
  fire('pointerdown', 149, 68, items[0]);
  for (const y of [72, 80, 92, 110]) fire('pointermove', 151, y);
  fire('pointerup', 151, 110);
  assert.deepEqual(clicks, [0, 0, 0]);
  destroyLiquidGlass();
});

await test('面板样式：选中的那块白由透镜来画，那一格自己不再铺一层', () => {
  assert.ok(liquid.includes('html[data-skin] .pdf-panel-tabs:has(.segmented-glass-lens) .pdf-panel-tab.is-selected {'));
  assert.ok(/html\[data-skin\] \.pdf-panel-tabs \{ position: relative; touch-action: none; \}/.test(liquid));
});

// ═══════════════════════════════════════════════════════════════
group('5. 纸是纸');

const paperPlain = noComments(paper);
const paperRule = (sel) => {
  const at = paperPlain.indexOf(`${sel} {`);
  return at < 0 ? null : paperPlain.slice(at, paperPlain.indexOf('}', at));
};

await test('拖着工具栏、收成球的时候不磨砂：玻璃的折射模糊在纸里整个拿掉，外壳是圆的', () => {
  // 人说「纸的状态下，工具栏在拖动时，背景有字，圆形周围会有个方形的模糊效果」：material.css 给拖动中的
  // 外壳和球加了一层折射模糊（所有皮肤都吃），纸给外壳的却是方角。
  const material = noComments($read('src/styles/material.css'));
  assert.ok(/\.ink-toolbar\.is-dragging,[\s\S]{0,240}backdrop-filter: url\(#lg-refract\)/.test(material), '那层模糊还在 material.css 里（所以这里要压）');
  const off = paperPlain.slice(paperPlain.indexOf('html[data-skin="minimal"] .ink-toolbar,\nhtml[data-skin="minimal"] .ink-toolbar.is-dragging,'));
  const block = off.slice(0, off.indexOf('}'));
  for (const sel of ['.ink-toolbar.is-dragging', '.ink-toolbar.is-docked', '.ink-token']) {
    assert.ok(block.includes(`html[data-skin="minimal"] ${sel}`), sel);
  }
  assert.ok(/backdrop-filter: none !important;/.test(block), '压过 material.css 那条');
  const shell = paperRule('html[data-skin="minimal"] .ink-toolbar.is-docked,\nhtml[data-skin="minimal"] .ink-toolbar.is-dragging');
  assert.ok(shell && /border-radius: 50%;/.test(shell) && /background: transparent;/.test(shell), '外壳让开，而且是圆的');
});

await test('工具栏两头是圆的：它是那颗球长出来的，展开的最后一帧不许从圆「啪」地变方', () => {
  // 顶上那一排里点开，是逐帧收放一道两头圆的裁切；裁切一撤，露出来的是工具栏自己的角。
  const dock = $read('src/pdf/top-row-dock.js');
  assert.ok(/clipPath = `inset\([^`]*round \$\{height \/ 2\}px\)`/.test(dock), '展开时的裁切两头是圆的');
  // 那么纸里工具栏自己的角也得是圆的：除了收成球（50%），paper.css 不给它别的圆角。
  for (const block of paperPlain.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sels = block[1].split(',').map((x) => x.trim());
    if (!sels.some((x) => /\.ink-toolbar(\.[\w-]+|:not\([^)]*\))*$/.test(x))) continue;
    const radius = /border-radius:\s*([^;]+)/.exec(block[2]);
    if (!radius) continue;
    assert.equal(radius[1].trim(), '50%', `${sels[0]} 的圆角是 ${radius[1]}——展开完会从圆变方`);
  }
  const ink = noComments($read('src/styles/ink-toolbar.css'));
  assert.ok(/\.ink-toolbar \{[^}]*border-radius: var\(--pill-radius, 999px\);/.test(ink), '工具栏本来的样子是两头圆的');
});

await test('宋体按字体文件自己的名字找（local()）：安卓上按族名找不到，会落回黑体', () => {
  const face = paperRule('@font-face');
  assert.ok(face && /font-family: "Duiye Serif";/.test(face) && /local\("Noto Serif CJK SC"\)/.test(face));
  assert.ok(/--p-serif: "Duiye Serif",/.test(paperRule('html[data-skin="minimal"]')));
});

await test('顶上那一排是一整条纸带：画在横杠的伪元素上，不占地方、不接手指，跟着横杠进出', () => {
  const band = paperRule('html[data-skin="minimal"] .pdf-page-bar::before');
  assert.ok(band, '有纸带');
  for (const re of [/content: '';/, /position: absolute;/, /z-index: -1;/, /pointer-events: none;/, /background: var\(--p-paper\);/]) {
    assert.ok(re.test(band), String(re));
  }
  assert.ok(/background: transparent !important;/.test(paperRule('html[data-skin="minimal"] .pdf-bar-group')), '胶囊不再各自起底');
  assert.ok(paperPlain.includes('html[data-skin="minimal"] #page-pdf.is-leaving .pdf-page-bar::before {'), '切页时纸带跟着按钮一起走');
});

await test('纸上只有一种颜色——钢笔：选中的标签是一道下划线，开着的是一层钢笔水，主要动作是一块章；没有黄、没有磨砂', () => {
  const tokens = paperRule('html[data-skin="minimal"]');
  assert.ok(/--lg-bubble: var\(--p-pen-wash\);/.test(tokens), '「泡」换成一层钢笔水');
  assert.ok(/--p-underline: linear-gradient\(var\(--p-pen\), var\(--p-pen\)\) 50% 100% \/ calc\(100% - 20px\) 2px no-repeat;/.test(tokens), '标签底下钢笔划的一道线');
  assert.ok(/--lg-seg-thumb: var\(--p-underline\);/.test(tokens), '找页面板那三页也是这道线');
  const lens = paperRule('html[data-skin="minimal"] .app-nav .nav-glass-lens');
  assert.ok(lens && /background: var\(--p-underline\) !important;/.test(lens), '两个标签的透镜就是那道线');
  assert.ok(/--lg-primary: var\(--p-pen\);/.test(tokens) && /--lg-primary-text: var\(--p-paper\);/.test(tokens), '主要动作是一块钢笔色的章');
  // 人说黄色的搭配太丑：原来「选中」是一道黄色的荧光笔。
  assert.ok(!/--p-mark|255, 20\d, \d+/.test(paperPlain), '荧光笔的黄拆干净了');
  assert.ok(/--lg-blur: none;/.test(tokens) && /--lg-chrome-blur: none;/.test(tokens));
  assert.ok(!/blur\(/.test(paperPlain), 'paper.css 里一个 blur 都没有');
});

await test('对话框：普通按钮的悬停、按下不盖到「主要」「危险」那两颗上', () => {
  assert.ok(paperPlain.includes('html[data-skin="minimal"] .deck-dialog-btn:not(.is-primary):not(.is-danger):active:not(:disabled) {'));
  assert.ok(!paperPlain.includes('html[data-skin="minimal"] .deck-dialog-btn:active:not(:disabled) {'), '不带 :not 的那种会把钢笔色、朱红按成浅灰');
});

await test('分隔条的纸只在 paper.css 里：pdf.css 只留边的宽度和不刻 φ', () => {
  const pdf = noComments($read('src/styles/pdf.css'));
  const rules = [...pdf.matchAll(/\[data-skin="minimal"\][^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
  assert.ok(rules && !/#dfe3e8|#ffffff|background|box-shadow/.test(rules), '旧的冷灰和白拆了：这里一条颜色都不写');
  assert.ok(/\[data-skin="minimal"\] \.pdf-ws-divider-grip::after \{ content: ''; \}/.test(pdf));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
