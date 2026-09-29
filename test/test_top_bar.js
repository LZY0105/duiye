#!/usr/bin/env node
// 顶上那一排，和进进出出的那几样东西。
//
// 「练习 / 设置」两个标签原来是底边一枚孤零零的胶囊，挪到了顶上那一排的正中。
// 这里钉四样：
//
//   1. 窄了先收字、再收标签的字，不让左右两枚胶囊伸进正中压住标签；宽了再回来，
//      回来要多留一点，免得卡在边界上一帧一个样（top-bar-fit.js）。
//   2. 切页时走掉的那一页淡出，不是当场消失；半路切回来，它不会卡在半透明里
//      （bootstrap.js 的 showPage）。
//   3. 菜单收起时也淡出：设置页的两个下拉、顶上那两张单子、栏里的 ⋯ 单子。
//   4. 这些都不挡正事：淡出的那一小段里点不到它，减少动态效果时直接换。

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'localStorage', 'Event', 'HTMLElement', 'Element',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}

let reducedMotion = false;
dom.window.matchMedia = (q) => ({
  matches: /prefers-reduced-motion/.test(q) ? reducedMotion : false,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

const { BAR_LADDER, fitTopBar, syncNavWidth } = await import('../src/pdf/top-bar-fit.js');
const { showPage, PAGE_LEAVE_MS } = await import('../src/core/bootstrap.js');

// ═══════════════════════════════════════════════════════════════
group('1. 窄了先收字，再收标签的字');

/**
 * 一排横杠，按「此刻挂着哪几级」摆好各自的位置。jsdom 没有排版，这里照着
 * pdf.css 的三格 grid 自己算：两边等宽、正中那一格是两个标签的宽度、格间 12px。
 *
 * 宽度取自 1200×736 的平板：左边那枚胶囊 366（收字后 174），「全部关闭」113
 * （收字后 44），两个标签 172（收字后 96）。
 */
function barAt(width) {
  document.body.className = '';
  document.body.innerHTML = `
    <nav class="app-nav"><button class="active" data-page="pdf">练习</button><button data-page="settings">设置</button></nav>
    <div class="pdf-page-bar">
      <div class="pdf-bar-group"></div>
      <span class="pdf-bar-nav-slot"></span>
      <div class="pdf-bar-trail"><span class="pdf-status"></span><div class="pdf-bar-group is-end"></div></div>
    </div>`;
  const q = (s) => document.querySelector(s);
  const bar = q('.pdf-page-bar');
  const state = { width };
  const has = (cls) => document.body.classList.contains(cls);
  const rect = (left, width_) => ({
    left, right: left + width_, width: width_, top: 10, bottom: 54, height: 44, x: left, y: 10,
  });
  const GAP = 12;
  const layout = () => {
    const barLeft = 10;
    const barW = state.width - 20;
    const navW = has('is-bar-tight') ? 96 : 172;
    const side = (barW - navW - 2 * GAP) / 2;
    return {
      bar: rect(barLeft, barW),
      lead: rect(barLeft, has('is-bar-compact') ? 174 : 366),
      slot: rect(barLeft + side + GAP, navW),
      nav: rect(barLeft + side + GAP, navW),
      end: (() => { const w = has('is-bar-compact') ? 44 : 113; return rect(barLeft + barW - w, w); })(),
    };
  };
  bar.getBoundingClientRect = () => layout().bar;
  q('.pdf-page-bar > .pdf-bar-group').getBoundingClientRect = () => layout().lead;
  q('.pdf-bar-nav-slot').getBoundingClientRect = () => layout().slot;
  q('.app-nav').getBoundingClientRect = () => layout().nav;
  q('.pdf-bar-group.is-end').getBoundingClientRect = () => layout().end;
  return { bar, state, nav: q('.app-nav') };
}

// 横杠的格间和内边距：pdf.css 里的值。
const realStyle = globalThis.getComputedStyle;
globalThis.getComputedStyle = (el) => (el.classList?.contains('pdf-page-bar')
  ? { columnGap: '12px', paddingLeft: '0px', paddingRight: '0px' }
  : realStyle(el));

/** 一直量到停下来，和 initTopBarFit 里那一圈一样。 */
function settle(bar, memo) {
  let steps = 0;
  while (fitTopBar(bar, memo) && steps < 5) steps++;
  return steps;
}
const levels = () => BAR_LADDER.filter((cls) => document.body.classList.contains(cls));

await test('平板横着（1200）：一格都不收', () => {
  const { bar } = barAt(1200);
  assert.equal(settle(bar, {}), 0);
  assert.deepEqual(levels(), []);
});

await test('竖过来（736）：左右两枚胶囊只留图标，标签不动', () => {
  const { bar } = barAt(736);
  settle(bar, {});
  assert.deepEqual(levels(), ['is-bar-compact'],
    '366 宽的胶囊放在 260 宽的那一格里，会伸进正中压住标签');
});

await test('再窄（480）：两个标签也只留图标', () => {
  const { bar } = barAt(480);
  settle(bar, {});
  assert.deepEqual(levels(), ['is-bar-compact', 'is-bar-tight']);
});

await test('宽回来，一级一级退回去', () => {
  const { bar, state } = barAt(480);
  const memo = {};
  settle(bar, memo);
  state.width = 736;
  settle(bar, memo);
  assert.deepEqual(levels(), ['is-bar-compact'], '标签的字先回来');
  state.width = 1200;
  settle(bar, memo);
  assert.deepEqual(levels(), [], '胶囊的字也回来了');
});

await test('刚好放得下不算放得下：回来要多留 8px', () => {
  // 退下来时左边那枚胶囊要 366。两边各分 (宽 − 20 − 172 − 24) / 2。
  const { bar, state } = barAt(736);
  const memo = {};
  settle(bar, memo);
  assert.deepEqual(levels(), ['is-bar-compact']);
  state.width = 20 + 172 + 24 + 2 * (366 + 4);   // 每边 370：只富余 4px
  settle(bar, memo);
  assert.deepEqual(levels(), ['is-bar-compact'], '差一点点就回来的话，下一帧又得退下去');
  state.width = 20 + 172 + 24 + 2 * (366 + 9);   // 每边 375
  settle(bar, memo);
  assert.deepEqual(levels(), []);
});

await test('不在屏幕上（切到设置页）：量到的是 0，什么都不改', () => {
  const { bar } = barAt(736);
  bar.getBoundingClientRect = () => ({ left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0 });
  assert.equal(fitTopBar(bar, {}), false);
  assert.deepEqual(levels(), []);
});

await test('没有记录（换了语言，记录作废）：先回去，放不下再退', () => {
  const { bar } = barAt(1200);
  document.body.classList.add('is-bar-compact');
  assert.equal(fitTopBar(bar, {}), true);
  assert.deepEqual(levels(), []);
});

await test('正中那一格按两个标签真实的宽度留', () => {
  const { nav } = barAt(1200);
  assert.equal(syncNavWidth(nav), 172);
  assert.equal(document.body.style.getPropertyValue('--app-nav-w'), '172px');
});

await test('收字只收掉看得见的字：按钮的名字还在（读屏照读）', () => {
  const css = $read('src/styles/pdf.css');
  assert.ok(/body\.is-bar-compact \.pdf-page-bar \.pdf-bar-btn \{\s*font-size: 0;/.test(css));
  assert.ok(/body\.is-bar-tight \.app-nav button \{\s*font-size: 0;/.test(css));
  assert.ok(!/is-bar-(compact|tight)[^{]*\{[^}]*display:\s*none/.test(css),
    'display: none 会把字从无障碍树里一起拿掉');
});

await test('液态玻璃里收字那两条也得说 font-size: 0：它自己的 14px 一样具体、又更晚', () => {
  // 真的出过：收字的那一级挂上了，按钮收成 40px 宽，字却还是 14px，挤在里面竖着排。
  const css = $read('src/styles/liquid.css');
  for (const sel of ['body.is-bar-compact .pdf-page-bar .pdf-bar-btn {', 'body.is-bar-tight .app-nav button {']) {
    const at = css.indexOf(sel);
    assert.ok(at > 0, sel);
    assert.ok(/font-size: 0;/.test(css.slice(at, css.indexOf('}', at))), sel);
  }
});

await test('横杠按钮不过渡字号和宽度：收完当场就量得到', () => {
  const css = $read('src/styles/pdf.css');
  const rule = css.slice(css.indexOf('.pdf-bar-btn,\r\n.pdf-page-bar button {') >= 0
    ? css.indexOf('.pdf-bar-btn,\r\n.pdf-page-bar button {')
    : css.indexOf('.pdf-bar-btn,\n.pdf-page-bar button {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.ok(!/transition:\s*all/.test(body), '过渡到一半的宽度量出来，会一口气退到底');
});

// ═══════════════════════════════════════════════════════════════
group('2. 切页：走掉的那一页淡出');

function pages() {
  document.body.className = '';
  document.body.innerHTML = `
    <nav class="app-nav"><button class="active" data-page="pdf">练习</button><button data-page="settings">设置</button></nav>
    <div id="app">
      <div class="page active" id="page-pdf"><div class="pdf-page-bar"></div></div>
      <div class="page" id="page-settings"><h1>设置</h1></div>
    </div>`;
  return {
    pdf: document.getElementById('page-pdf'),
    settings: document.getElementById('page-settings'),
    tab: (p) => document.querySelector(`.app-nav [data-page="${p}"]`),
  };
}

await test('走的那一页挂上 is-leaving 淡出，来的那一页当场就是当前页', () => {
  const { pdf, settings, tab } = pages();
  showPage('settings');
  assert.ok(settings.classList.contains('active'));
  assert.ok(!pdf.classList.contains('active'));
  assert.ok(pdf.classList.contains('is-leaving'), '原来它是当场消失的');
  assert.equal(pdf.inert, true, '淡出的那一小段里点不到它');
  assert.equal(document.body.dataset.page, 'settings', 'CSS 靠它分练习页和设置页');
  assert.ok(tab('settings').classList.contains('active') && !tab('pdf').classList.contains('active'));
});

await test('它自己的动画演完就收；页里别的动画结束不算', () => {
  const { pdf } = pages();
  showPage('settings');
  const child = pdf.querySelector('.pdf-page-bar');
  child.dispatchEvent(new dom.window.Event('animationend', { bubbles: true }));
  assert.ok(pdf.classList.contains('is-leaving'), '冒泡上来的是别人的 animationend');
  pdf.dispatchEvent(new dom.window.Event('animationend'));
  assert.ok(!pdf.classList.contains('is-leaving'));
  assert.equal(pdf.inert, false);
  assert.equal(pdf.style.getPropertyValue('--leave-top'), '');
});

await test('动画结束的事件没来（页面在后台），计时器也收得掉', async () => {
  const { pdf } = pages();
  showPage('settings');
  await wait(PAGE_LEAVE_MS + 120);
  assert.ok(!pdf.classList.contains('is-leaving'));
});

await test('半路切回来：它回到当前页，不会卡在淡出里', () => {
  const { pdf, settings } = pages();
  showPage('settings');
  showPage('pdf');
  assert.ok(pdf.classList.contains('active'));
  assert.ok(!pdf.classList.contains('is-leaving'), '一页不能同时是当前页又在淡出');
  assert.equal(pdf.inert, false);
  assert.ok(settings.classList.contains('is-leaving'), '这回走的是设置页');
});

await test('钉在它原来的位置上：滚过的距离也算', () => {
  const { settings } = pages();
  showPage('settings');
  Object.defineProperty(window, 'scrollY', { value: 240, configurable: true });
  showPage('pdf');
  assert.equal(settings.style.getPropertyValue('--leave-top'), '-240px');
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
});

await test('减少动态效果：直接换，不演', () => {
  reducedMotion = true;
  try {
    const { pdf } = pages();
    showPage('settings');
    assert.ok(!pdf.classList.contains('is-leaving'));
  } finally { reducedMotion = false; }
});

await test('样式：淡出的那页不占文档流、点不到；练习页淡出时不散架', () => {
  const css = $read('src/styles/base.css');
  const rule = css.slice(css.indexOf('.page.is-leaving {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.ok(/position: fixed;/.test(body), '不然来的那页会被它挤到下面去');
  assert.ok(/top: var\(--leave-top/.test(body));
  assert.ok(/pointer-events: none;/.test(body));
  assert.ok(/animation: pageFadeOut/.test(body));
  const pdf = css.slice(css.indexOf('#page-pdf.is-leaving {'));
  assert.ok(/display: flex !important;/.test(pdf.slice(0, pdf.indexOf('}'))),
    '练习页平时是 flex，淡出时变成 block 会当场散架');
  assert.ok(/@keyframes pageFadeOut/.test(css));
});

// ═══════════════════════════════════════════════════════════════
group('3. 菜单收起时淡出');

await test('设置页的两个下拉：收起时淡出，不是当场消失', () => {
  const css = $read('src/styles/base.css');
  const rule = css.slice(css.indexOf('.set-select-dropdown {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.ok(/transition-behavior: allow-discrete;/.test(body),
    'display 从 block 变 none 的那一下要推迟到淡出结束');
  assert.ok(/transition-property: opacity, translate, display;/.test(body));
  assert.ok(/pointer-events: none;/.test(body), '淡出的那一小段里点不到');
  assert.ok(/\.set-select-dropdown\.show \{[^}]*pointer-events: auto;/.test(css));
});

await test('装着下拉的那张卡片，等下拉淡完再落回去', () => {
  // 不然下一张卡片会盖在正在淡出的列表上。
  const css = $read('src/styles/base.css');
  assert.ok(/\.set-group \{ transition: z-index 0s linear 0\.2s; \}/.test(css));
  assert.ok(/\.set-group:has\(\.set-select-dropdown\.show\) \{ z-index: 60; transition-delay: 0s; \}/.test(css),
    '抬起来是立刻的');
});

await test('顶上那两张单子、栏里的 ⋯ 单子：同一种淡出', () => {
  const css = $read('src/styles/pdf.css');
  const start = css.indexOf('.pdf-bar-menu,\r\n.pdf-slot-menu {') >= 0
    ? css.indexOf('.pdf-bar-menu,\r\n.pdf-slot-menu {')
    : css.indexOf('.pdf-bar-menu,\n.pdf-slot-menu {');
  assert.ok(start > 0, '两张单子共用一条过渡');
  const body = css.slice(start, css.indexOf('}', start));
  assert.ok(/transition-behavior: allow-discrete;/.test(body));
  assert.ok(/\.pdf-bar-menu\[hidden\],\s*\.pdf-slot-menu\[hidden\] \{[^}]*display: none;[^}]*opacity: 0;[^}]*pointer-events: none;/.test(css));
});

await test('JS 那边照旧当场改状态，不等动画', () => {
  // 退场只是样子：aria-expanded、谁开着，在按下的那一刻就对了。
  const select = $read('src/ui/custom-select.js');
  const close = select.slice(select.indexOf('function closeOpen()'));
  assert.ok(/list\.classList\.remove\('show'\);/.test(close.slice(0, close.indexOf('\n}'))));
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  assert.ok(/menu\.hidden = true;/.test(ui));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
