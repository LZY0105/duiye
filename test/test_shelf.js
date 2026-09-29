#!/usr/bin/env node
// 书架，和翻开一本书的那一下。
//
// 这里测三样东西，因为这三样是「一排书」里唯一会错的：
//
//   1. 顺序。人是靠位置记住自己的书的，所以顺序必须是可预期的、稳定的，而且
//      同样的输入永远给同样的结果。
//   2. 落点。翻开的那一下是从格子飞到「那一页会落在哪」——不是飞到那一栏。
//      双开、单开、被收起来的栏，差别全在这个矩形上。
//   3. 书签的名字。改名不是「顺手补一条书签」，清空不是「删掉这条书签」。

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
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event', 'PointerEvent',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'localStorage', 'URL']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}

const {
  SHELF_KINDS, shelfItems, BOOK_MIN_WIDTH, shelfSubtitle,
} = await import('../src/pdf/shelf-state.js');
const { readFileSync } = await import('node:fs');
const $read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf-8');
const { fitRect, OPEN_MS } = await import('../src/pdf/book-open.js');
const {
  createBookmarks, addBookmark, renameBookmark, bookmarkLabel,
} = await import('../src/pdf/bookmark-state.js');

const doc = (id, extra = {}) => ({
  id, name: id, pageCount: 100, sizeBytes: 1000, importedAt: 1000, ...extra,
});
const pad = (id, extra = {}) => ({ id, name: id, createdAt: 1000, ...extra });

// ═══════════════════════════════════════════════════════════════
group('1. 一排书的顺序');

await test('手边那几本在前，没读过的在后', async () => {
  const items = shelfItems(
    [doc('a', { importedAt: 3000 }), doc('b', { importedAt: 2000 }), doc('c', { importedAt: 1000 })],
    [],
    ['c', 'b'],
  );
  assert.deepEqual(items.map(i => i.id), ['c', 'b', 'a'],
    '读过的按远近排，没读过的那本落到最后——哪怕它是最新导入的');
});

await test('都没读过就按什么时候进来的，新的在前', async () => {
  const items = shelfItems(
    [doc('old', { importedAt: 1000 }), doc('new', { importedAt: 9000 })], [], [],
  );
  assert.deepEqual(items.map(i => i.id), ['new', 'old']);
});

await test('草稿纸和书摆在同一排，不分两块', async () => {
  const items = shelfItems([doc('book')], [pad('note', { createdAt: 5000 })], []);
  assert.deepEqual(items.map(i => i.kind), [SHELF_KINDS.PAD, SHELF_KINDS.DOC],
    '草稿纸更新，所以它在前；它不是另起一栏的另一类东西');
});

await test('时间戳一模一样时顺序也是定死的', async () => {
  // 位置比「对」更要紧：同一批导入的书每次刷新换一次位置，就没法靠位置记住了。
  const a = shelfItems([doc('x'), doc('y'), doc('z')], [], []);
  const b = shelfItems([doc('z'), doc('y'), doc('x')], [], []);
  assert.deepEqual(a.map(i => i.id), b.map(i => i.id),
    '输入的先后不该改变架子上的先后');
});

await test('架子上的条目是冻住的，画它的人改不动它', async () => {
  const items = shelfItems([doc('a')], [], []);
  assert.ok(Object.isFrozen(items) && Object.isFrozen(items[0]));
});

await test('一本书的下限只有一个数，CSS 用的就是它', async () => {
  // 「一行只摆几本」是 grid 做的。这里盯的是它俩没走散：CSS 里那个 minmax 的
  // 下限必须就是 BOOK_MIN_WIDTH，否则改了一个而另一个还是旧的，谁也说不清
  // 到底一行几本。
  const css = $read('src/styles/pdf.css');
  const rule = css.match(/\.pdf-shelf\s*\{[^}]*\}/);
  assert.ok(rule, '书架得有它自己的格子');
  const minmax = rule[0].match(/minmax\(min\((\d+)px/);
  assert.ok(minmax, '一行几本是 auto-fill + minmax 算出来的');
  assert.equal(Number(minmax[1]), BOOK_MIN_WIDTH,
    'CSS 和 shelf-state 对「一本至少多宽」得是同一个数');
  // 平板横屏 1200 去掉边距大约 1150，除下来是四本。
  assert.equal(Math.floor(1150 / BOOK_MIN_WIDTH), 4, '横屏平板一行四本');
});

await test('书脊上印的是它是什么，不是它多大', async () => {
  assert.equal(shelfSubtitle(shelfItems([doc('a')], [], [])[0]), '100 页');
  assert.equal(shelfSubtitle(shelfItems([], [pad('p')], [])[0]), '草稿纸');
});

// ═══════════════════════════════════════════════════════════════
group('2. 书落到哪一块');

const A4 = 1 / 1.414;

await test('落点跟书是同一个形状，所以半路上书不会被抻扁', async () => {
  const to = fitRect(A4, { left: 0, top: 0, width: 584, height: 620 });
  assert.ok(Math.abs(to.width / to.height - A4) < 0.001);
});

await test('一栏比书宽时，书居中，用满高度', async () => {
  const to = fitRect(A4, { left: 100, top: 50, width: 800, height: 400 });
  assert.equal(Math.round(to.height), 400, '高度是瓶颈');
  assert.equal(Math.round(to.width), Math.round(400 * A4));
  assert.equal(Math.round(to.left + to.width / 2), 500, '横着居中');
  assert.equal(Math.round(to.top), 50);
});

await test('一栏比书窄时反过来，用满宽度', async () => {
  const to = fitRect(A4, { left: 0, top: 0, width: 300, height: 900 });
  assert.equal(Math.round(to.width), 300);
  assert.equal(Math.round(to.height), Math.round(300 / A4));
  assert.equal(Math.round(to.top + to.height / 2), 450, '竖着居中');
});

await test('单开和双开只是同一条规矩喂了两个矩形', async () => {
  // 这正是「双文档也要适配」的全部内容：动画一行都不用改，换的是这个框。
  const half = fitRect(A4, { left: 6, top: 70, width: 584, height: 620 });
  const whole = fitRect(A4, { left: 6, top: 70, width: 1188, height: 620 });
  assert.equal(Math.round(half.height), Math.round(whole.height),
    '两种情形下高度都被栏高卡住，书一样大');
  assert.ok(whole.left > half.left, '整屏时书往右挪到中间去了');
});

await test('量出来的那个时长就是代码里的那个数', async () => {
  // 视频里第 164 帧起、第 210 帧止，48.64fps —— 946ms。
  assert.ok(Math.abs(OPEN_MS - 946) <= 10,
    `翻开用了 ${OPEN_MS}ms，和视频量到的 946ms 对不上`);
});

// ═══════════════════════════════════════════════════════════════
group('3. 书签自己的名字');

await test('给已经标过的那一页起名', async () => {
  const marks = addBookmark(createBookmarks([]), 12, { pageCount: 100 });
  const named = renameBookmark(marks, 12, '洛必达法则');
  assert.equal(named[0].label, '洛必达法则');
  assert.equal(bookmarkLabel(named[0]), '洛必达法则');
});

await test('没标过的页改名什么都不做，不会顺手补一条', async () => {
  const marks = addBookmark(createBookmarks([]), 12, { pageCount: 100 });
  const same = renameBookmark(marks, 40, '不该出现');
  assert.equal(same, marks, '连数组本身都该是原来那个');
  assert.equal(same.length, 1);
});

await test('名字清空是退回「第 N 页」，不是删掉这一页', async () => {
  let marks = addBookmark(createBookmarks([]), 7, { pageCount: 100 });
  marks = renameBookmark(marks, 7, '作业三');
  marks = renameBookmark(marks, 7, '');
  assert.equal(marks.length, 1, '书签还在');
  assert.equal(marks[0].label, '');
  assert.equal(bookmarkLabel(marks[0]), '第 7 页');
});

await test('名字没变就不换一个新数组，免得白存一次盘', async () => {
  const marks = renameBookmark(
    addBookmark(createBookmarks([]), 3, { label: '同一个', pageCount: 9 }), 3, '同一个');
  assert.equal(marks[0].label, '同一个');
  assert.equal(marks, renameBookmark(marks, 3, '同一个'));
});

await test('名字长过上限会被截断，而不是被拒绝', async () => {
  const marks = renameBookmark(
    addBookmark(createBookmarks([]), 1, { pageCount: 9 }), 1, 'x'.repeat(200));
  assert.equal(marks[0].label.length, 60);
});

await test('改完名之后单子还是按页码排的', async () => {
  let marks = createBookmarks([{ page: 5 }, { page: 1 }, { page: 9 }]);
  marks = renameBookmark(marks, 5, '中间那条');
  assert.deepEqual(marks.map(m => m.page), [1, 5, 9]);
});

// ═══════════════════════════════════════════════════════════════
group('4. 书架画出来是什么样');

const { BookShelf } = await import('../src/pdf/book-shelf.js');

function mountShelf(items, handlers = {}) {
  document.body.innerHTML = '<div class="pdf-shelf"></div>';
  const host = document.querySelector('.pdf-shelf');
  const shelf = new BookShelf(host, handlers);
  shelf.setItems(items);
  return { shelf, host };
}

await test('一本书一格，封面、名字、书脊都在', async () => {
  const items = shelfItems([doc('a', { name: '高等代数' })], [], []);
  const { host } = mountShelf(items);
  const tile = host.querySelector('.pdf-book');
  assert.ok(tile, '书架上得有书');
  assert.ok(tile.querySelector('.pdf-book-cover'), '封面');
  assert.ok(tile.querySelector('.pdf-book-edge'), '右边那一叠纸——没有它这就只是张卡片');
  assert.equal(tile.querySelector('.pdf-book-name').textContent, '高等代数');
});

await test('点一下就开，不用点两下', async () => {
  const opened = [];
  const items = shelfItems([doc('a')], [], []);
  const { host } = mountShelf(items, { onOpen: (item) => opened.push(item.id) });
  host.querySelector('.pdf-book-hit').click();
  assert.deepEqual(opened, ['a']);
});

await test('点角上的 ⋯ 不会把书也打开', async () => {
  const opened = [];
  const menued = [];
  const items = shelfItems([doc('a')], [], []);
  const { host } = mountShelf(items, {
    onOpen: (i) => opened.push(i.id),
    onMenu: (i) => menued.push(i.id),
  });
  host.querySelector('.pdf-book-more').dispatchEvent(
    new dom.window.Event('click', { bubbles: true }));
  assert.deepEqual(menued, ['a']);
  assert.deepEqual(opened, [], '⋯ 在书里面，但点它不是点书');
});

await test('角上的 ⋯ 是画出来的三个点，在按钮里几何居中——不是一个按字体中线摆的「⋯」字', async () => {
  // 人说「三个点与按钮的位置有点别扭，有点偏下」：原来是 textContent = '⋯'，平板上的中文字体中线比字框
  // 正中低，三个点落在圆按钮中心偏下三个像素。
  const items = shelfItems([doc('a')], [], []);
  const { host } = mountShelf(items, { onMenu: () => {} });
  const more = host.querySelector('.pdf-book-more');
  assert.equal(more.textContent.trim(), '', '按钮里没有字');
  const icon = more.querySelector('svg.pdf-book-more-icon');
  assert.ok(icon, '一枚图标');
  assert.equal(icon.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(icon.querySelector('path').getAttribute('d'), 'M5.5 12h.01M12 12h.01M18.5 12h.01', '和栏头那颗 ⋯ 同一种画法');
  assert.ok(more.getAttribute('aria-label'), '读屏念的名字还在');
  const css = $read('src/styles/pdf.css').replace(/\r\n/g, '\n');
  const at = css.indexOf('.pdf-book-more {');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /display: flex;/);
  assert.match(rule, /align-items: center;/);
  assert.match(rule, /justify-content: center;/);
  assert.ok(!/font-size|line-height/.test(rule.replace(/\/\*[\s\S]*?\*\//g, '')), '不再按字体摆');
});

await test('册别印在封面上，没有册别就不印', async () => {
  // 比的是 t() 的结果，不是「练习」两个字：这一架书是给五种语言的人看的，而角标
  // 是这一格上唯一一处说「它是什么」的地方。写死字面量的话，翻译一做这条就会挡路。
  const { t } = await import('../src/core/i18n.js');
  const { host } = mountShelf(shelfItems(
    [doc('a', { role: 'exercise' }), doc('b')], [], ['a', 'b']));
  const tiles = [...host.querySelectorAll('.pdf-book')].filter(e => e.dataset.id);
  assert.equal(tiles[0].querySelector('.pdf-book-tag')?.textContent, t('shelf.tagExercise'));
  assert.equal(tiles[1].querySelector('.pdf-book-tag'), null);
});

await test('说明书永远摆在第一格，接了它才有', async () => {
  const items = shelfItems([doc('a')], [], []);
  const withGuide = mountShelf(items, { onGuide: () => {} });
  const tiles = [...withGuide.host.querySelectorAll('.pdf-book')];
  assert.ok(tiles[0].classList.contains('is-guide'), '第一格是说明书');
  assert.equal(tiles[1].dataset.id, 'a', '书排在它后面');

  const without = mountShelf(items, {});
  assert.equal(without.host.querySelector('.pdf-book.is-guide'), null);
});

await test('一本书都没有时，说明书和「＋」还在', async () => {
  // 这是装完软件第一次进来看到的那一屏。
  const { host } = mountShelf([], { onGuide: () => {}, onAdd: () => {} });
  assert.ok(host.querySelector('.pdf-book.is-guide'), '说明书要在');
  assert.ok(host.querySelector('.pdf-book.is-add'), '「＋」也要在');
});

await test('点说明书那一格，开的是说明书不是书', async () => {
  let opened = 0;
  let guided = 0;
  const { host } = mountShelf(shelfItems([doc('a')], [], []), {
    onOpen: () => { opened++; },
    onGuide: () => { guided++; },
  });
  host.querySelector('.pdf-book.is-guide .pdf-book-hit').dispatchEvent(
    new dom.window.Event('click', { bubbles: true }));
  assert.equal(guided, 1);
  assert.equal(opened, 0);
});

await test('架子末尾留着一个「＋」，但只在有人接着它的时候', async () => {
  const items = shelfItems([doc('a')], [], []);
  const withAdd = mountShelf(items, { onAdd: () => {} });
  assert.ok(withAdd.host.querySelector('.pdf-book.is-add'));
  const without = mountShelf(items, {});
  assert.equal(without.host.querySelector('.pdf-book.is-add'), null);
});

await test('撤掉书架时排队没轮到的封面一起撤，挂上去的地址一起回收', async () => {
  const revoked = [];
  const realRevoke = dom.window.URL.revokeObjectURL;
  dom.window.URL.revokeObjectURL = (u) => revoked.push(u);
  try {
    const { shelf, host } = mountShelf(shelfItems([doc('a'), doc('b')], [], []));
    shelf._urls.push('blob:one', 'blob:two');
    shelf.destroy();
    assert.deepEqual(revoked, ['blob:one', 'blob:two'],
      '不回收就等于把这些图一直留在内存里');
    assert.equal(host.children.length, 0);
  } finally {
    dom.window.URL.revokeObjectURL = realRevoke;
  }
});

await test('组合借的书收在文件夹里，书架照样认得它的名字', async () => {
  // 组合摆在外面、那两本书收进了文件夹：它们不在这一屏上，没有格子。翻开组合时
  // 飞出去的是那两本的封面和名字——原来查的是格子，查不到就飞两张没字的白纸。
  document.body.innerHTML = '<div class="pdf-shelf"></div>';
  const host = document.querySelector('.pdf-shelf');
  const shelf = new BookShelf(host, {});
  const [inFolder] = shelfItems([doc('b', { name: '答案册' })], [], []);
  shelf.setItems(shelfItems([doc('a', { name: '高等代数' })], [], []), { companions: [inFolder] });
  assert.equal(shelf.nameOf('a'), '高等代数', '摆着的照旧从格子上读');
  assert.equal(shelf.nameOf('b'), '答案册', '没摆出来的也认得');
  assert.equal(host.querySelector('.pdf-book[data-id="b"]'), null, '认得，但不摆出来');
  assert.equal(shelf.coverUrl('b'), '', '封面还没到手时是空的，不是报错');
  shelf.destroy();
  assert.equal(shelf.nameOf('b'), '', '撤掉书架时一起忘掉');
});

await test('量不到那一格就不演——凭空长出来的书比直接切过去更难看', async () => {
  const { shelf } = mountShelf(shelfItems([doc('a')], [], []));
  assert.equal(shelf.tileRect('不存在的'), null);
});

// ═══════════════════════════════════════════════════════════════
group('5. 从书架上导入');

/** 一条 CSS 规则里的 z-index。 */
function zIndexOf(css, selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, selector + ' 这条规则不见了');
  const block = css.slice(at, css.indexOf('}', at));
  const m = block.match(/z-index:\s*(\d+)/);
  assert.ok(m, selector + ' 得有 z-index');
  return Number(m[1]);
}

await test('「这份文件是？」盖在书架上面，不是压在它底下', async () => {
  // 压在底下时它并非不存在：隔着 44px 的毛玻璃看得见一个灰白的影子，却点不着，
  // 因为指头落在书架上。于是那个 Promise 永远不落地，人看到的是「导入不起作用」。
  //
  // 以前导入按钮在顶上那条横杠里、书架多半是关着的，碰不到这一层；书架上有了
  // 「＋」之后，每一次导入都会碰到。
  const css = $read('src/styles/pdf.css');
  const role = zIndexOf(css, '.pdf-role-overlay');
  const library = zIndexOf(css, '.pdf-library');
  const flight = zIndexOf(css, '.pdf-book-flight');
  assert.ok(role > library, `问「这是什么」的那一层(${role})必须高过书架(${library})`);
  assert.ok(role > flight, `也要高过翻书那一下(${flight})`);
});

await test('导入的进度说给看得见的那一处', async () => {
  // 那条状态栏在顶上的横杠里，而书架正盖着它。导入一份几百兆的书要好几秒，
  // 这几秒里人只能看着一片安静，分不清是在忙还是坏了。
  const code = $read('src/pdf/pdf-workspace-ui.js');
  const fn = code.slice(code.indexOf('function setStatus('),
    code.indexOf('function setStatus(') + 900);
  assert.ok(/library-usage/.test(fn), '书架开着时，同一句话在它自己头上也说一遍');
});

await test('「＋」接到的是真的导入，不是一个空壳', async () => {
  const code = $read('src/pdf/pdf-workspace-ui.js');
  // 进了文件夹之后，「＋」先问一句「从本机导一份，还是从已有的里面挑」——但「从
  // 本机导」那一支走的还是 pickAndImport。一个入口两种去处，不是两套导入，所以
  // 这里认的是「它通到 pickAndImport」，不是那一行当初的写法。
  assert.ok(/onAdd: \(\) => .*pickAndImport\(DOC_ROLES\.EXERCISE\)/.test(code),
    '「＋」得真的走到导入');
  assert.ok(/handleImport\(Array\.from\(e\.target\.files/.test(code),
    '选完文件得真的走到导入');
});

await test('应用里每一个「导入」都走同一条路', async () => {
  // 四个入口：横杠单子那两项、书架上那张「＋」、空工作区卡片上那两颗按钮。
  // 它们原来各自去点隐藏的 <input>，于是同一个动作有两种表现——横杠上弹应用内面
  // 板，书架上弹系统选择器。人不会认为那是两个功能，只会觉得这个应用时好时坏。
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  const ws = $read('src/pdf/pdf-workspace.js');

  assert.ok(ui.includes('export async function pickAndImport('),
    '有一个共用的入口');
  assert.ok(/onAdd: \(\) => .*pickAndImport\(/.test(ui), '书架的「＋」走它');
  // 第五个入口：文件夹里那颗「放东西进来」。它也必须落到同一条路上——不然「在文
  // 件夹里导入」就会长成第二套导入，而两套迟早走岔。
  assert.ok(/async function addIntoFolder\([\s\S]*?pickAndImport\(/.test(ui),
    '文件夹里那颗「放东西进来」也走它');
  assert.ok(ui.includes('pickAndImport(role)'), '横杠单子那两项走它');
  assert.ok(ui.includes('workspace.onImport = (role) => pickAndImport(role)'),
    '空工作区那两颗也接到它身上');
  assert.ok(ws.includes('this.onImport(role)'), '——而工作区确实会去叫它');

  // 没人挂 onImport 时（测试里工作区是单独立起来的）要能退回文件框，不能哑掉。
  assert.ok(/typeof this\.onImport === 'function'/.test(ws),
    '没挂的时候退回隐藏文件框，而不是什么都不做');

  // 除了那一处回退和 change 监听，不该再有谁直接去点隐藏文件框。
  const clicks = (ui + ws).match(/data-role="file-(exercise|answer)"\]`?\)\?\.click\(\)/g) || [];
  assert.ok(clicks.length <= 2,
    `只剩两处回退，现在有 ${clicks.length} 处`);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(failed ? 1 : 0);
