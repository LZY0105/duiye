#!/usr/bin/env node
// 笔记本（记笔记）的回归测试。
//
// 这个功能最重要的一条设计决定是：**笔记本不是一种新的阅读器，它是一份文档。**
//
// PdfPane 已经会翻页、缩放、适合宽度/整页、按页缓存位图、预取前后页、把笔迹层对
// 齐到页上、把页码记进会话；找页面板会画缩略图，书签会记页，封面会画第一页。这
// 一整套东西问的不是「你是不是 PDF」，而是 pdf-document.js 定下的那几个问题。所
// 以 note-document.js 回答那几个问题，其余一行不改。
//
// 这条决定可以被静默地毁掉：任何一处「因为笔记本特殊，所以这里分一下」的改动，
// 都会让它慢慢长成第二个阅读器，而两个阅读器只会有一个被维护。下面几组断言守的
// 就是这个。
//
// 另外三件能静默坏掉的事：
//
//   1. 加页只能往后加。往中间插会把后面每一页的页码整体推后，而笔迹是按页码存
//      的 —— 写过的东西集体错位一页，没有任何地方会报错。
//   2. 减页要连笔迹一起删。留着就是永远不会被看见、也删不掉的存储。
//   3. 笔记本不能参与对题。它没有文字层，硬配对只会让匹配引擎拿着一页空的去猜。

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENTRY_KINDS, createEntry, isPagedKind, kindKeyFor } from '../src/pdf/deck-state.js';
import { SHELF_KINDS, shelfItems, shelfSubtitle } from '../src/pdf/shelf-state.js';
import { NOTE_PAGE, noteMeta, openNoteDocument } from '../src/note/note-document.js';
import { PATTERNS, TONES, createScratchStyle } from '../src/scratch/scratch-style.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const $read = (f) => readFileSync(join(ROOT, f), 'utf-8');
const $code = (f) => $read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const ok = (c, l, d) => { if (c) pass(l); else fail(l, d); };
const group = (n) => console.log(`\n─── [${n}] ───`);
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}
async function checkAsync(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Notebook Tests');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. 文件在位');

for (const f of ['src/note/note-store.js', 'src/note/note-document.js']) {
  ok(existsSync(join(ROOT, f)), `${f} exists`);
}

// ═══════════════════════════════════════════════════════════════
group('2. 一本笔记本就是一份文档');

const docSurface = ['numPages', 'getOutline', 'renderPage', 'pageText', 'extractText', 'pageSize', 'destroy'];

// 画布在 Node 里没有，所以 renderPage 单独在下一组里用假的 document 测。
const doc = openNoteDocument({ id: 'n1', pageCount: 12, style: createScratchStyle() });
for (const name of docSurface) {
  ok(typeof doc[name] === 'function' || name === 'numPages',
    `笔记本文档提供 ${name}`);
}
check('numPages 就是它有多少页', () => { assert.equal(doc.numPages, 12); });

check('outline 这个属性在，而且说的是「没有目录」', () => {
  assert.equal(doc.outline.available, false);
  assert.deepEqual(doc.outline.items, []);
});

await checkAsync('getOutline 也一样 —— 空白本子不会被编出一个目录来', async () => {
  const outline = await doc.getOutline();
  assert.equal(outline.available, false);
});

await checkAsync('每一页都是 A4，和 PDF 用同一套单位', async () => {
  assert.deepEqual(await doc.pageSize(1), { width: 595, height: 842 });
  assert.deepEqual(await doc.pageSize(12), { width: 595, height: 842 });
  assert.equal(NOTE_PAGE.width, 595);
});

await checkAsync('越界的页号抛的是和 PDF 同一个错', async () => {
  for (const bad of [0, 13, 1.5, NaN, null]) {
    await assert.rejects(() => doc.pageSize(bad), /PDF_PAGE_OUT_OF_RANGE/);
  }
});

await checkAsync('纸上没有文字层，而且如实说没有', async () => {
  assert.deepEqual(await doc.pageText(1), { lines: [], empty: true });
  assert.deepEqual(await doc.extractText(), []);
});

check('meta 的字段名和 pdf-library 写进去的那份一致', () => {
  const meta = noteMeta({ id: 'n1', name: '笔记本 01', pageCount: 12, createdAt: 7 });
  for (const key of ['id', 'name', 'pageCount', 'hasOutline', 'role', 'importedAt', 'sizeBytes']) {
    assert.ok(key in meta, `meta 缺 ${key}`);
  }
  assert.equal(meta.pageCount, 12);
  assert.equal(meta.hasOutline, false);
  // 空白页真的不占存储。算进「文档库用了多少空间」是在说谎。
  assert.equal(meta.sizeBytes, 0);
  assert.equal(meta.isNote, true);
});

// ═══════════════════════════════════════════════════════════════
group('3. 每一页画出来都一样，而且真的画了东西');

await checkAsync('renderPage 按缩放给出画布，格子逐页相同', async () => {
  // 最小的假画布：只记下画了些什么，不真的光栅化。
  const calls = [];
  const fakeCtx = new Proxy({}, {
    get(_, prop) {
      if (prop === 'canvas') return undefined;
      return (...args) => { calls.push([String(prop), ...args]); };
    },
    set() { calls.push(['set']); return true; },
  });
  const created = [];
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = { width: 0, height: 0, getContext: () => fakeCtx };
      created.push(canvas);
      return canvas;
    },
  };
  try {
    const lined = openNoteDocument({
      id: 'n2', pageCount: 3,
      style: createScratchStyle({ patternId: PATTERNS.RULED, paperTone: TONES.IVORY }),
    });
    const a = await lined.renderPage(1, 2);
    assert.equal(a.width, 595 * 2);
    assert.equal(a.height, 842 * 2);
    assert.equal(a.canvas.width, 595 * 2);
    // 真的画了纸色和横线，不是给了一张空画布。
    assert.ok(calls.some(c => c[0] === 'fillRect'), '没有填纸色');
    assert.ok(calls.some(c => c[0] === 'stroke' || c[0] === 'fill'), '没有画导线');

    // 第 3 页和第 1 页画的东西一模一样 —— 真本子每页都是新的一页横线，
    // 不是一卷纸裁开。
    const firstPage = calls.slice();
    calls.length = 0;
    await lined.renderPage(3, 2);
    assert.deepEqual(calls.map(c => c[0]), firstPage.map(c => c[0]));

    // 每次都是新画布：PdfPane 把它直接放进 DOM，共用一张就是同一张纸
    // 同时出现在两个地方。
    assert.ok(created.length >= 2 && created[0] !== created[1]);
  } finally {
    delete globalThis.document;
  }
});

// ═══════════════════════════════════════════════════════════════
group('4. 摞里的一项：笔记本和书走同一条装载路径');

check('NOTE 是一种「分页」的东西，SCRATCH 不是', () => {
  assert.equal(isPagedKind(ENTRY_KINDS.NOTE), true);
  assert.equal(isPagedKind(ENTRY_KINDS.PDF), true);
  assert.equal(isPagedKind(ENTRY_KINDS.SCRATCH), false);
});

check('createEntry 收下 note，认不得的退成 pdf', () => {
  assert.equal(createEntry({ kind: 'note', resourceId: 'n1' }).kind, ENTRY_KINDS.NOTE);
  assert.equal(createEntry({ kind: 'scratch', resourceId: 'p1' }).kind, ENTRY_KINDS.SCRATCH);
  // 未来版本写的 kind 读回来退成 PDF：它会去 pdf-library 里找一个不存在的 id
  // 然后干净地开不开，好过被塞进一个不会翻页的面板。
  assert.equal(createEntry({ kind: 'hologram', resourceId: 'x' }).kind, ENTRY_KINDS.PDF);
});

const workspaceCode = $code('src/pdf/pdf-workspace.js');
ok(
  /_preparePdf[\s\S]{0,2000}?ENTRY_KINDS\.NOTE/.test(workspaceCode),
  '笔记本走的是 _preparePdf，不是另起一条装载路径',
);
ok(
  !/_prepareNote\s*\(/.test(workspaceCode),
  '——所以没有 _prepareNote 这种东西',
);
ok(
  !/class NotePane|new NotePane/.test(workspaceCode),
  '也没有第二个阅读器',
);

// ═══════════════════════════════════════════════════════════════
group('5. 笔记本不参与对题');

// 对题靠的是文字层，而纸上只有手写的笔迹。让它配对，只会让匹配引擎拿着一页空的
// 去猜，然后给出一个看着像答案的东西。三道门各挡一边：
ok(
  /entry\.kind !== ENTRY_KINDS\.PDF/.test(workspaceCode),
  '找答案册时只在 PDF 里找',
);
check('本子的角色永远是「未指定」，所以「对照本页答案」不会出现在它身上', () => {
  // 那个按钮的条件是 meta.role === EXERCISE。
  assert.equal(noteMeta({ id: 'n1', pageCount: 3 }).role, 'unspecified');
});
ok(
  /role === DOC_ROLES\.EXERCISE/.test(workspaceCode),
  '——而它确实是按角色判的',
);
ok(
  /!isPad && !isNote/.test($code('src/pdf/pdf-workspace-ui.js')),
  '书架菜单也不给本子「标为练习册 / 答案册」：那是个永远不起作用的角色',
);

// ═══════════════════════════════════════════════════════════════
group('6. 加页只能往后，减页要连笔迹一起删');

const storeCode = $code('src/note/note-store.js');
ok(
  /addNotePages[\s\S]{0,400}?current\.pageCount \+ add/.test(storeCode),
  '加页是加在末尾',
);
ok(
  !/insertNotePage|splice/.test(storeCode),
  '没有插页 —— 插一页会让后面每一页上写过的东西集体错位',
);
ok(
  /removeNotePages[\s\S]{0,600}?deletePageInk\(id, page\)/.test(storeCode),
  '减页时那几页的笔迹真的删掉了',
);
ok(
  /Math\.max\(1, current\.pageCount - drop\)/.test(storeCode),
  '——但至少留一页：零页的本子不是本子',
);

const inkCode = $code('src/ink/ink-store.js');
ok(
  /export async function deletePageInk\(/.test(inkCode),
  'ink-store 提供了「忘掉某一页」这个原语',
);

// ═══════════════════════════════════════════════════════════════
group('7. 书架上的第三种东西');

check('笔记本和书、草稿纸摆在一排', () => {
  const items = shelfItems(
    [{ id: 'd1', name: '习题册', pageCount: 478, importedAt: 1 }],
    [{ id: 'p1', name: '草稿 01', createdAt: 2 }],
    [],
    [{ id: 'n1', name: '笔记本 01', pageCount: 20, createdAt: 3 }],
  );
  assert.equal(items.length, 3);
  const note = items.find(i => i.id === 'n1');
  assert.equal(note.kind, SHELF_KINDS.NOTE);
  assert.equal(note.pageCount, 20);
  // 空白页不占存储。
  assert.equal(note.sizeBytes, 0);
});

check('书脊上印的是页数 —— 那正是「这本厚不厚」的答案', () => {
  assert.equal(shelfSubtitle({ kind: SHELF_KINDS.NOTE, pageCount: 20 }), '20 页');
  assert.equal(shelfSubtitle({ kind: SHELF_KINDS.PAD }), '草稿纸');
});

check('没有笔记本时书架照样是原来那样', () => {
  const items = shelfItems([{ id: 'd1', name: '书', pageCount: 3, importedAt: 1 }], [], []);
  assert.equal(items.length, 1);
});

const coverCode = $code('src/pdf/book-cover.js');
ok(
  /SHELF_KINDS\.NOTE[\s\S]{0,120}?renderNoteCover/.test(coverCode),
  '封面就是它的第一页',
);
const coverStoreCode = $code('src/pdf/cover-store.js');
ok(
  /pageCount/.test(coverStoreCode) && /style/.test(coverStoreCode),
  '换了纸或者加了页，封面缓存会自己作废',
);

// ═══════════════════════════════════════════════════════════════
group('8. 一个按钮，两个模式');

const dialogCode = $code('src/pdf/deck-dialogs.js');
ok(
  /export const PAPER_MODES = Object\.freeze\(\{ SCRATCH: 'scratch', NOTE: 'note' \}\)/
    .test(dialogCode),
  '草稿纸和笔记本是同一个对话框的两个模式',
);
ok(
  /export function createPaperDialog\(/.test(dialogCode)
  && !/export function createScratchpadDialog\(/.test(dialogCode),
  '——不是两个对话框：那样纸张选择器和目的地选择器要各维护一份',
);
ok(
  /pagesField\.hidden = !note/.test(dialogCode),
  '「几页」只在笔记本模式下出现 —— 一张没有边界的纸没有页数',
);
ok(
  /if \(!touched\) input\.value = proposed\[current\]/.test(dialogCode),
  '切换模式换默认名，但人自己改过的名字不动',
);

const uiCode = $code('src/pdf/pdf-workspace-ui.js');
ok(
  /workspace\.createPaper\(\)/.test(uiCode),
  '横杠上只有一个按钮，开的是那个两模式对话框',
);
const indexHtml = $read('index.html');
ok(
  (indexHtml.match(/data-role="new-scratch"/g) || []).length === 1,
  '——横杠上没有第二个新建按钮',
);

// ═══════════════════════════════════════════════════════════════
group('9. 纸张样式：一份实现，两种纸');

const panelCode = $code('src/scratch/scratch-style-panel.js');
ok(
  /save = setScratchpadStyle/.test(panelCode),
  '样式面板的写入口可以换，默认还是草稿纸',
);
ok(
  /const saved = await save\(resourceId, draft/.test(panelCode),
  '——而它确实用的是那个入口',
);
ok(
  /save: setNotebookStyle/.test(workspaceCode),
  '笔记本换的就是这个入口，面板本身没有第二份',
);
ok(
  /openNoteStylePanel[\s\S]{0,900}?_preparePdf\(slot, entry, at\)/.test(workspaceCode),
  '改完样式整份重开：每一页的位图都已经缓存过了，不重开屏幕上还是旧纸',
);
// ═══════════════════════════════════════════════════════════════
group('10. 「不是草稿纸就是 PDF」—— 加进第三种之后全错了');

// 笔记本刚接上去的时候，浏览器里跑一遍抓到四个这样的地方。它们的共同点是：
// 都不报错，都只是悄悄少做一件事。逐条钉住。

const sessionCode = $code('src/pdf/document-session.js');
ok(
  /ENTRY_KINDS\.NOTE[\s\S]{0,120}?getNotebook\(entry\.resourceId\)/.test(sessionCode),
  '会话恢复认得笔记本 —— 不认的话它被当成「已删除」从摞里剔掉，重启就少一本',
);
ok(
  /getNotebook: resolvers\.getNotebook \|\| getNotebook/.test(sessionCode),
  '——而这个解析器和另外两个一样是可注入的，失败路径在 Node 里测得到',
);

ok(
  /_rememberSlotView\(slot\) \{[\s\S]{0,500}?isPagedKind\(entry\?\.kind\)/.test(workspaceCode),
  '读到哪一页会被记住 —— 只认 PDF 的话，本子换走再换回来永远回到第 1 页',
);
ok(
  /views\[entry\.id\] = view/.test(workspaceCode)
  && /if \(!isPagedKind\(entry\?\.kind\)\) continue;/.test(workspaceCode),
  '——而且那个位置真的进了存盘',
);

ok(
  /_bookmarksIn\(slot\) \{[\s\S]{0,200}?isPagedKind\(entry\?\.kind\)\) return \[\]/
    .test(workspaceCode),
  '本子的页也能记书签 —— 它和书一样是一页一页的',
);
ok(
  /getInkDocId: \(\) => \{[\s\S]{0,400}?isPagedKind\(entry\?\.kind\)/.test(workspaceCode),
  '缩略图上有本子的笔迹 —— 漏掉的话是「有纸没字」，而且不报错',
);

// 类型标签原来在三处 UI 各写了一遍「不是草稿纸就是 PDF」，于是笔记本三处都被
// 标成 PDF。同一个问题只该有一个答案。
const deckStateCode = $code('src/pdf/deck-state.js');
ok(
  /export function kindKeyFor\(kind\)/.test(deckStateCode),
  '类型标签有一份共用的答案',
);
check('——而它对三种都给对', () => {
  
  assert.equal(kindKeyFor(ENTRY_KINDS.NOTE), 'deck.note');
  assert.equal(kindKeyFor(ENTRY_KINDS.SCRATCH), 'deck.scratch');
  assert.equal(kindKeyFor(ENTRY_KINDS.PDF), 'deck.pdf');
  assert.equal(kindKeyFor(undefined), 'deck.pdf');
});
for (const f of ['src/pdf/deck-strip.js', 'src/pdf/deck-organizer.js', 'src/pdf/deck-dialogs.js']) {
  ok(
    !/ENTRY_KINDS\.SCRATCH \? t\('deck\.scratch'\) : t\('deck\.pdf'\)/.test($code(f)),
    `${f} 不再自己判类型标签`,
  );
}

// 对题是唯一一处「只有 PDF」仍然正确的地方：答案册要有文字层。
ok(
  /_soleAnswerInDecks[\s\S]{0,400}?entry\.kind !== ENTRY_KINDS\.PDF/.test(workspaceCode),
  '找答案册时仍然只看 PDF —— 那一处不是漏网，是本来就该这样',
);

// ═══════════════════════════════════════════════════════════════
group('11. 三种语言的文案都补齐了');

for (const lang of ['zh-CN', 'zh-TW', 'en']) {
  const src = $read(`src/core/lang/${lang}.js`);
  const missing = ['deck.note', 'note.newTitle', 'note.pages', 'note.new', 'note.addPage',
    'note.style', 'note.deleteTitle', 'note.deleteBody', 'paper.scratchNote', 'paper.noteNote']
    .filter(k => !src.includes(`"${k}"`));
  ok(missing.length === 0, `${lang} 有全部笔记本文案`, missing.join(', '));
  // 用量那行多了一个占位符，三种语言都得跟着改，否则它会原样印出 {{notes}}。
  ok(new RegExp('shelf\.usage[^\n]*\{\{notes\}\}').test(src),
    `${lang} 的用量行把笔记本也数进去了`);
}


console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
if (FAIL > 0) process.exit(1);
console.log('PASS: a notebook is a document, and stays one');
