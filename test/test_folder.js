#!/usr/bin/env node
// 文件夹：书架上的分类，以及自由组合。
//
// 这个文件盯的是三件「做错了当场看不出来」的事：
//
//   **一、删掉一个文件夹，里面的东西不能跟着没。** 文件夹是个格子，不是个箱子。
//   这件事错了，用户损失的是文件本身，而且他要等到下一次去找那本书才会发现。
//
//   **二、进了文件夹之后，外面那些书不能还摆在架子上。** 「分类」这个功能的全部
//   意义就是屏幕上少几样东西；分完类还是全都在，人只会觉得这个按钮没反应。
//
//   **三、拼到一半的组合，退出前必须问一声。** 它没有存在任何地方。
//
// 剩下的断言是围着这三件事的护栏：归属表里不能留下指着不存在的东西的行、同一份
// 东西不能同时在两个文件夹里、改名不能把别的字段冲掉。

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}
/**
 * 这些都是开对话框的。每一个都拿到一个干净的 document——上一个测试要是中途断了，
 * 它那张单子还盖在 body 上，而下一个测试的 querySelector 会先摸到它，于是一个失败
 * 变成一串失败，真正坏掉的那一处反而看不出来。
 */
async function testAsync(name, fn) {
  document.body.replaceChildren();
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
for (const key of [
  'window', 'document', 'localStorage', 'Event', 'PointerEvent',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
]) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const {
  FOLDER_LIMITS, assignTo, countIn, createFolder, deserializeFolders, folderOf,
  idsIn, nextFolderName, pruneMembers, serializeFolders,
} = await import('../src/pdf/folder-state.js');
const {
  FOLDER_ERRORS, FOLDER_MAX, addFolder, clearFolders, deleteFolder, folderMembers,
  getFolder, listFolders, moveToFolder, pruneFolders, renameFolder,
} = await import('../src/pdf/folder-store.js');
const { SHELF_KINDS, shelfItems, shelfSubtitle } = await import('../src/pdf/shelf-state.js');
const { chooseFolder, pickResources } = await import('../src/pdf/deck-dialogs.js');
const { openComboBuilder } = await import('../src/pdf/combo-builder.js');
const { SLOTS } = await import('../src/pdf/workspace-state.js');
const { ENTRY_KINDS } = await import('../src/pdf/deck-state.js');
const { initI18n, setLang } = await import('../src/core/i18n.js');
await initI18n();
// 下面的断言写的是简体中文的文案。不钉住的话语言跟着 navigator.language 走，而 Node
// 的 navigator 跟系统：中文系统上过，CI 那台英文 Linux 上就挂。
await setLang('zh-CN');

/** 点一下。jsdom 里 click() 就够——这些控件收的都是 click。 */
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
/** 等一个微任务轮次，让对话框里那些 await 走完。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

// ═══════════════════════════════════════════════════════════════
group('文件夹这个东西本身');

test('名字会修剪，也有个头', () => {
  const f = createFolder({ id: ' a ', name: `  高代${'长'.repeat(80)}  ` });
  assert.equal(f.id, 'a');
  assert.equal(f.name.length, FOLDER_LIMITS.NAME);
  assert.ok(Object.isFrozen(f));
});

test('重名就往后排号', () => {
  const folders = [{ name: '新建文件夹' }, { name: '新建文件夹 2' }];
  assert.equal(nextFolderName([], '新建文件夹'), '新建文件夹');
  assert.equal(nextFolderName(folders, '新建文件夹'), '新建文件夹 3');
});

test('放进去、拿出来，都是同一张表上的一行', () => {
  let members = assignTo({}, 'doc-1', 'fld-a');
  assert.equal(folderOf(members, 'doc-1'), 'fld-a');
  members = assignTo(members, 'doc-1', null);
  assert.equal(folderOf(members, 'doc-1'), null);
  assert.equal(Object.keys(members).length, 0, '拿出来是删掉那一行，不是写个空值');
});

test('一份东西同时只在一个文件夹里', () => {
  let members = assignTo({}, 'doc-1', 'fld-a');
  members = assignTo(members, 'doc-1', 'fld-b');
  assert.equal(folderOf(members, 'doc-1'), 'fld-b');
  assert.equal(countIn(members, 'fld-a'), 0, '换了格子，原来那个就空了');
  assert.deepEqual(idsIn(members, 'fld-b'), ['doc-1']);
});

test('东西没了，它那一行也不留', () => {
  const members = { 'doc-1': 'fld-a', 'doc-2': 'fld-a' };
  const folders = [{ id: 'fld-a' }];
  const { members: next, changed } = pruneMembers(members, (id) => id === 'doc-1', folders);
  assert.equal(changed, true);
  assert.equal(countIn(next, 'fld-a'), 1, '印在文件夹上的份数得是真的');
});

test('文件夹没了，里面的东西回到外面那一排', () => {
  const members = { 'doc-1': 'fld-gone' };
  const { members: next } = pruneMembers(members, () => true, []);
  assert.equal(folderOf(next, 'doc-1'), null, '不是把 doc-1 也抹掉');
});

test('存下来再读回来，还是那一套', () => {
  const state = {
    folders: [createFolder({ id: 'f1', name: '高代', createdAt: 5, updatedAt: 6 })],
    members: { 'doc-1': 'f1', 'doc-2': 'f-不存在' },
  };
  const back = deserializeFolders(JSON.parse(JSON.stringify(serializeFolders(state))));
  assert.equal(back.folders.length, 1);
  assert.equal(back.folders[0].name, '高代');
  assert.equal(folderOf(back.members, 'doc-1'), 'f1');
  assert.equal(folderOf(back.members, 'doc-2'), null, '指着不存在的文件夹那一行，读回来时就该扔掉');
});

// ═══════════════════════════════════════════════════════════════
group('存在哪儿');

test('不给名字就自己取一个', () => {
  clearFolders();
  const a = addFolder('');
  const b = addFolder('');
  assert.equal(a.name, '新建文件夹');
  assert.equal(b.name, '新建文件夹 2');
  assert.equal(listFolders().length, 2);
});

test('改名只改名字', () => {
  clearFolders();
  const f = addFolder('高代');
  moveToFolder('doc-1', f.id);
  const renamed = renameFolder(f.id, '  线性代数  ');
  assert.equal(renamed.name, '线性代数');
  assert.equal(renamed.id, f.id);
  assert.equal(folderMembers()['doc-1'], f.id, '改个名字，里面的东西一样都不能动');
  assert.throws(() => renameFolder(f.id, '   '), /EMPTY_NAME/);
  assert.throws(() => renameFolder('没有这个', 'x'), /NOT_FOUND/);
});

test('删掉文件夹，里面的东西一份不少地回到外面', () => {
  clearFolders();
  const f = addFolder('高代');
  const other = addFolder('数分');
  moveToFolder('doc-1', f.id);
  moveToFolder('doc-2', f.id);
  moveToFolder('doc-3', other.id);

  assert.equal(deleteFolder(f.id), true);
  const members = folderMembers();
  assert.equal(members['doc-1'], undefined, 'doc-1 回到了外面那一排');
  assert.equal(members['doc-2'], undefined);
  assert.equal(members['doc-3'], other.id, '别的文件夹一点都不受影响');
  assert.equal(getFolder(f.id), null);
  assert.equal(deleteFolder(f.id), false, '删第二次是「没这个东西」，不是出错');
});

test('往一个不存在的文件夹里放东西会被拦下', () => {
  clearFolders();
  assert.throws(() => moveToFolder('doc-1', 'fld-不存在'), /NOT_FOUND/);
  assert.equal(folderMembers()['doc-1'], undefined);
});

test('建满了会说一声，而不是悄悄不建', () => {
  clearFolders();
  for (let i = 0; i < FOLDER_MAX; i++) addFolder(`f${i}`);
  assert.throws(() => addFolder('再来一个'), new RegExp(FOLDER_ERRORS.FULL));
  assert.equal(listFolders().length, FOLDER_MAX);
});

test('修剪会落盘，不是只在内存里算一遍', () => {
  clearFolders();
  const f = addFolder('高代');
  moveToFolder('doc-活着', f.id);
  moveToFolder('doc-没了', f.id);
  pruneFolders((id) => id === 'doc-活着');
  assert.equal(folderMembers()['doc-没了'], undefined, '下次打开书架时它不该又冒出来');
  assert.equal(folderMembers()['doc-活着'], f.id);
});

// ═══════════════════════════════════════════════════════════════
group('架子上摆什么');

const DOCS = [
  { id: 'd1', name: '谢惠民', pageCount: 100, importedAt: 3 },
  { id: 'd2', name: '裴礼文', pageCount: 200, importedAt: 2 },
  { id: 'd3', name: '数分', pageCount: 300, importedAt: 1 },
];

test('外面那一层：只有没归档的，加上几个文件夹', () => {
  const items = shelfItems(DOCS, [], [], [], [], {
    folders: [{ id: 'f1', name: '高代', createdAt: 1 }],
    members: { d1: 'f1', d2: 'f1' },
    openFolderId: null,
  });
  const ids = items.map(i => i.id);
  assert.deepEqual(ids, ['f1', 'd3'], '两本收进文件夹的书不该还摆在外面');
  assert.equal(items[0].kind, SHELF_KINDS.FOLDER);
  assert.equal(items[0].folderSize, 2);
});

test('进了文件夹：只有它里面的，而且没有文件夹套文件夹', () => {
  const items = shelfItems(DOCS, [], [], [], [], {
    folders: [{ id: 'f1', name: '高代', createdAt: 1 }],
    members: { d1: 'f1', d2: 'f1' },
    openFolderId: 'f1',
  });
  assert.deepEqual(items.map(i => i.id), ['d1', 'd2']);
  assert.equal(items.some(i => i.kind === SHELF_KINDS.FOLDER), false, '一层就是一层');
});

test('不给 view 的时候，架子还是原来那个架子', () => {
  // 书架在别处还有调用方（测试、以后的别的入口）。加了个参数就让老的调用方少一半
  // 东西，那是把一个新功能变成一次回归。
  const items = shelfItems(DOCS, [], [], [], []);
  assert.deepEqual(items.map(i => i.id), ['d1', 'd2', 'd3']);
});

test('组合排在文件夹前面，文件夹排在书前面', () => {
  const items = shelfItems(DOCS, [], [], [], [
    { id: 'c1', name: '考前那套', slots: { a: { entries: [{ kind: 'pdf', resourceId: 'd1' }], active: 0 }, b: { entries: [], active: -1 } }, updatedAt: 9 },
  ], {
    folders: [{ id: 'f1', name: '高代', createdAt: 1 }],
    members: { d1: 'f1' },
    openFolderId: null,
  });
  assert.deepEqual(items.map(i => i.kind),
    [SHELF_KINDS.COMBO, SHELF_KINDS.FOLDER, SHELF_KINDS.DOC, SHELF_KINDS.DOC]);
});

test('文件夹的书脊那一行印的是份数，空的也印', () => {
  assert.equal(shelfSubtitle({ kind: SHELF_KINDS.FOLDER, folderSize: 3 }), '3 项');
  assert.equal(shelfSubtitle({ kind: SHELF_KINDS.FOLDER, folderSize: 0 }), '0 项');
});

// ═══════════════════════════════════════════════════════════════
group('「移动到文件夹」那张单子');

const openDialog = () => document.querySelector('.deck-folder-dialog');
const rowsOf = () => [...openDialog().querySelectorAll('.deck-folder-row')];
const confirmOf = () => openDialog().querySelector('[data-role="confirm"]');

await testAsync('顶上一句话说它现在在哪——一句话，不是一个能点的格子', async () => {
  // 用户在机上指出来的：「不在文件夹里」原来是列表第一行，长得和文件夹一样、能点
  // 能选，却不是一个文件夹。它该是一句提示。
  const p = chooseFolder({ itemName: '谢惠民', folders: [{ id: 'f1', name: '高代', count: 2 }] });
  await tick();
  const where = openDialog().querySelector('[data-role="where"]');
  assert.equal(where.tagName, 'P', '一句话');
  assert.equal(where.textContent, '「谢惠民」现在不在任何文件夹里');
  assert.equal(where.closest('button'), null, '不在任何按钮里，点不动');
  const rows = rowsOf();
  assert.equal(rows.length, 1, '列表里只有真的文件夹');
  assert.equal(rows[0].querySelector('.deck-folder-name').textContent, '高代');
  assert.equal(rows[0].querySelector('.deck-folder-count').textContent, '2 项');
  assert.equal(confirmOf().disabled, true, '还没挑，「移动」按不下去');
  click(openDialog().querySelector('[data-role="cancel"]'));
  assert.equal(await p, null);
});

await testAsync('挑一个再按「移动」，回的是那一个', async () => {
  const p = chooseFolder({ itemName: '谢惠民', folders: [{ id: 'f1', name: '高代', count: 0 }] });
  await tick();
  click(rowsOf()[0]);
  assert.ok(rowsOf()[0].classList.contains('is-selected'), '选中的那一行要看得出来');
  assert.equal(confirmOf().disabled, false);
  click(confirmOf());
  assert.deepEqual(await p, { folderId: 'f1' });
});

await testAsync('本来就在某个文件夹里：那句话说在哪，那一行亮着；挑别的才能移', async () => {
  const p = chooseFolder({
    itemName: '谢惠民',
    folders: [{ id: 'f1', name: '高代' }, { id: 'f2', name: '数分' }],
    current: 'f1',
  });
  await tick();
  assert.equal(openDialog().querySelector('[data-role="where"]').textContent, '「谢惠民」现在在「高代」里');
  assert.ok(rowsOf()[0].classList.contains('is-selected'), '它在的那个先亮着');
  assert.equal(confirmOf().disabled, true, '挪到它本来就在的地方，等于什么都没做');
  click(rowsOf()[1]);
  assert.equal(confirmOf().disabled, false);
  click(confirmOf());
  assert.deepEqual(await p, { folderId: 'f2' });
});

await testAsync('取消什么都不动', async () => {
  const p = chooseFolder({ folders: [{ id: 'f1', name: '高代' }], current: null });
  await tick();
  click(rowsOf()[0]);
  click(openDialog().querySelector('[data-role="cancel"]'));
  assert.equal(await p, null);
  assert.equal(document.querySelector('.deck-folder-dialog'), null, '单子要收干净');
});

await testAsync('一个文件夹都没有：一句话告诉他去哪儿建，不摊一张空单子', async () => {
  const p = chooseFolder({ itemName: '谢惠民', folders: [] });
  await tick();
  assert.equal(rowsOf().length, 0);
  const none = openDialog().querySelector('.deck-folder-empty');
  assert.ok(none && /新建文件夹/.test(none.textContent), '说的是去点「新建文件夹」');
  assert.equal(none.closest('button'), null);
  assert.equal(confirmOf().disabled, true);
  click(openDialog().querySelector('[data-role="cancel"]'));
  await p;
});

await testAsync('新建一个：当场建出来、当场选中、当场在改名', async () => {
  let made = 0;
  const p = chooseFolder({
    folders: [],
    onCreate: () => { made += 1; return { id: 'f-new', name: '新建文件夹' }; },
  });
  await tick();
  click(openDialog().querySelector('[data-role="new"]'));
  await tick();
  assert.equal(made, 1);
  const row = openDialog().querySelector('[data-folder-id="f-new"]');
  assert.ok(row, '新建的那个要出现在单子上');
  assert.ok(row.classList.contains('is-selected'), '他建这个格子就是为了装手上这一份');
  assert.ok(row.querySelector('.deck-folder-input'), '建完就在改名，不用再点一次');
  click(openDialog().querySelector('[data-role="cancel"]'));
  await p;
});

await testAsync('改完名字按回车，名字就是新的那个', async () => {
  const names = [];
  const p = chooseFolder({
    folders: [],
    onCreate: () => ({ id: 'f-new', name: '新建文件夹' }),
    onRename: (id, name) => names.push([id, name]),
  });
  await tick();
  click(openDialog().querySelector('[data-role="new"]'));
  await tick();
  const input = openDialog().querySelector('.deck-folder-input');
  input.value = '  高等代数  ';
  key(input, 'Enter');
  assert.deepEqual(names, [['f-new', '高等代数']]);
  assert.equal(openDialog().querySelector('[data-folder-id="f-new"] .deck-folder-name').textContent, '高等代数');
  click(openDialog().querySelector('[data-role="confirm"]'));
  assert.deepEqual(await p, { folderId: 'f-new' });
});

await testAsync('名字清空了就留着原来那个，不留一个没名字的格子', async () => {
  const names = [];
  const p = chooseFolder({
    folders: [],
    onCreate: () => ({ id: 'f-new', name: '新建文件夹' }),
    onRename: (id, name) => names.push(name),
  });
  await tick();
  click(openDialog().querySelector('[data-role="new"]'));
  await tick();
  const input = openDialog().querySelector('.deck-folder-input');
  input.value = '   ';
  key(input, 'Enter');
  assert.deepEqual(names, []);
  assert.equal(openDialog().querySelector('[data-folder-id="f-new"] .deck-folder-name').textContent, '新建文件夹');
  click(openDialog().querySelector('[data-role="cancel"]'));
  await p;
});

// ═══════════════════════════════════════════════════════════════
group('挑几份');

await testAsync('一份没挑的时候，确认是按不下去的', async () => {
  const p = pickResources({ title: '挑几份', items: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  await tick();
  const dialog = document.querySelector('.deck-pick-dialog');
  assert.equal(dialog.querySelector('[data-role="confirm"]').disabled, true);
  click(dialog.querySelector('[data-role="cancel"]'));
  assert.equal(await p, null);
});

await testAsync('点一下选中，再点一下取消，选了几份印在按钮上', async () => {
  const p = pickResources({
    title: '挑几份',
    items: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    confirm: '放进来',
  });
  await tick();
  const dialog = document.querySelector('.deck-pick-dialog');
  const rows = [...dialog.querySelectorAll('.deck-pick-row')];
  const confirm = dialog.querySelector('[data-role="confirm"]');
  click(rows[0]);
  click(rows[1]);
  assert.equal(confirm.textContent, '放进来（2）');
  click(rows[1]);
  assert.equal(confirm.textContent, '放进来（1）');
  assert.equal(rows[1].classList.contains('is-selected'), false);
  click(confirm);
  assert.deepEqual(await p, ['a']);
});

await testAsync('一样东西都没有的时候也要说一句话', async () => {
  const p = pickResources({ title: '挑几份', items: [], empty: '已经没有了' });
  await tick();
  const dialog = document.querySelector('.deck-pick-dialog');
  assert.equal(dialog.querySelector('.organizer-empty').textContent, '已经没有了');
  click(dialog.querySelector('[data-role="cancel"]'));
  await p;
});

// ═══════════════════════════════════════════════════════════════
group('自由组合');

const ITEMS = [
  { id: 'd1', kind: ENTRY_KINDS.PDF, name: '谢惠民' },
  { id: 'd2', kind: ENTRY_KINDS.PDF, name: '答案' },
  { id: 'p1', kind: ENTRY_KINDS.SCRATCH, name: '草稿一' },
];
const builderEl = () => document.querySelector('.organizer.builder');
const columnOf = (slot) => builderEl().querySelector(`.organizer-column[data-slot="${slot}"]`);
const namesIn = (slot) => [...columnOf(slot).querySelectorAll('.organizer-name')].map(n => n.textContent);
const addBtns = () => [...builderEl().querySelectorAll('[data-role="add"]')];
const btn = (role) => builderEl().querySelector(`[data-role="${role}"]`);
/** 存下来就当成功，并把交上来的草稿记下来。 */
const saveOk = (bag) => (draft) => { bag.push(draft); return { ok: true, combo: { id: 'c-new', ...draft } }; };
/** 退出并确认——拼了东西的单子要问一声才走。 */
async function leaveForGood() {
  click(btn('exit'));
  await tick();
  const go = builderEl()?.querySelector('.builder-confirm [data-role="go"]');
  if (go) click(go);
}

await testAsync('一本都没摆的时候存不出东西来', async () => {
  const p = openComboBuilder({ items: ITEMS, pick: async () => null, askName: async () => 'x', save: saveOk([]) });
  await tick();
  assert.equal(btn('save').disabled, true);
  assert.equal(btn('undo').disabled, true);
  // 什么都没拼，退出就是退出，不问。
  click(btn('exit'));
  assert.equal(await p, null);
});

await testAsync('挑一份放左栏，栏头就说它', async () => {
  const p = openComboBuilder({ items: ITEMS, pick: async () => ['d1'], askName: async () => null, save: saveOk([]) });
  await tick();
  click(addBtns()[0]);
  await tick();
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民']);
  assert.equal(columnOf(SLOTS.PRIMARY).querySelector('[data-role="what"]').textContent, '谢惠民',
    '栏头说的是「这一栏打开时会显示哪一本」');
  assert.deepEqual(namesIn(SLOTS.SECONDARY), []);
  assert.equal(btn('save').disabled, false);
  await leaveForGood();
  await p;
});

await testAsync('拿走一份，撤销能把它拿回来，一路退回空的那一刻', async () => {
  const p = openComboBuilder({ items: ITEMS, pick: async () => ['d1'], askName: async () => null, save: saveOk([]) });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(columnOf(SLOTS.PRIMARY).querySelector('[data-role="remove"]'));
  assert.deepEqual(namesIn(SLOTS.PRIMARY), []);
  click(btn('undo'));
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民']);
  click(btn('undo'));
  assert.deepEqual(namesIn(SLOTS.PRIMARY), []);
  assert.equal(btn('undo').disabled, true);
  click(btn('exit'));
  assert.equal(await p, null);
});

await testAsync('每一行都能直接挪到另一栏，挪完也能撤销', async () => {
  // 「整理内容」那张单子每一行都有「移动到…」；照着它做的这一张也得有。原来挑错
  // 了边只能拿走再去另一栏重挑一遍。
  const p = openComboBuilder({ items: ITEMS, pick: async () => ['d1', 'd2'], askName: async () => null, save: saveOk([]) });
  await tick();
  click(addBtns()[0]);
  await tick();
  const across = columnOf(SLOTS.PRIMARY).querySelectorAll('[data-role="across"]')[1];
  assert.equal(across.textContent, '移到右栏', '按钮上写的是要去的那一栏');
  click(across);
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民']);
  assert.deepEqual(namesIn(SLOTS.SECONDARY), ['答案']);
  assert.equal(columnOf(SLOTS.SECONDARY).querySelector('[data-role="what"]').textContent, '答案');
  click(btn('undo'));
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民', '答案']);
  assert.deepEqual(namesIn(SLOTS.SECONDARY), []);
  await leaveForGood();
  await p;
});

await testAsync('挪过去排在那一栏最后，不把那一栏露在外面的那本换掉', async () => {
  const picks = [['d1', 'd2'], ['p1']];
  const p = openComboBuilder({ items: ITEMS, pick: async () => picks.shift(), askName: async () => null, save: saveOk([]) });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(addBtns()[1]);
  await tick();
  click(columnOf(SLOTS.PRIMARY).querySelectorAll('[data-role="across"]')[1]);
  assert.deepEqual(namesIn(SLOTS.SECONDARY), ['草稿一', '答案']);
  await leaveForGood();
  await p;
});

await testAsync('同一本书能左右各放一份——「同一本也能开两栏」', async () => {
  // 题在前面、答案在后面的习题册，本来就是左右各开一份。原来这张单子把另一栏里
  // 有的书藏起来，于是这件事在这里做不出来。同一栏里还是不重复。
  const asked = [];
  const p = openComboBuilder({
    items: ITEMS,
    pick: async ({ slot, position, inThis, inOther }) => {
      asked.push({ slot, position, inThis: [...inThis], inOther: [...inOther] });
      return ['d1'];
    },
    askName: async () => null,
    save: saveOk([]),
  });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(addBtns()[1]);
  await tick();
  assert.deepEqual(asked[1], { slot: SLOTS.SECONDARY, position: '右栏', inThis: [], inOther: ['d1'] },
    '问的是位置，并且告诉挑东西那张单子「另一栏里已经有 d1」');
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民']);
  assert.deepEqual(namesIn(SLOTS.SECONDARY), ['谢惠民']);
  click(addBtns()[0]);
  await tick();
  assert.deepEqual(asked[2].inThis, ['d1'], '同一栏里已经有的，下一次不再列');
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民'], '同一栏里不放两份');
  await leaveForGood();
  await p;
});

await testAsync('左右各一份时，把一份挪过去不会在那一栏变出第二份', async () => {
  const p = openComboBuilder({ items: ITEMS, pick: async () => ['d1'], askName: async () => null, save: saveOk([]) });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(addBtns()[1]);
  await tick();
  click(columnOf(SLOTS.PRIMARY).querySelector('[data-role="across"]'));
  assert.deepEqual(namesIn(SLOTS.PRIMARY), []);
  assert.deepEqual(namesIn(SLOTS.SECONDARY), ['谢惠民']);
  await leaveForGood();
  await p;
});

await testAsync('竖着拿平板时，单子上说的是上栏、下栏', async () => {
  const p = openComboBuilder({
    items: ITEMS,
    positions: [{ slot: SLOTS.PRIMARY, position: '上栏' }, { slot: SLOTS.SECONDARY, position: '下栏' }],
    pick: async () => ['d1'],
    askName: async () => null,
    save: saveOk([]),
  });
  await tick();
  assert.deepEqual([...builderEl().querySelectorAll('[data-role="where"]')].map(n => n.textContent), ['上栏', '下栏']);
  click(addBtns()[0]);
  await tick();
  assert.equal(columnOf(SLOTS.PRIMARY).querySelector('[data-role="across"]').textContent, '移到下栏');
  await leaveForGood();
  await p;
});

await testAsync('保存并打开：草稿在单子还开着的时候就落盘，交出来的是存好的那一个', async () => {
  const picks = [['d1'], ['d2']];
  const saved = [];
  const p = openComboBuilder({
    items: ITEMS,
    pick: async () => picks.shift(),
    askName: async (suggested) => {
      assert.equal(suggested, '谢惠民 · 答案', '名字先给个建议，人可以改');
      return '对答案';
    },
    save: saveOk(saved),
  });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(addBtns()[1]);
  await tick();
  click(btn('save'));
  const combo = await p;
  assert.equal(saved.length, 1);
  const draft = saved[0];
  assert.equal(combo.id, 'c-new', '交出来的是存好的那一个，调用方拿它去打开');
  assert.equal(draft.name, '对答案');
  assert.equal(draft.dividerRatio, 0.5, '从零拼的一套默认对半分，不借当前那两栏拖出来的比例');
  assert.equal(draft.swapped, false, '这张单子上的左右就是屏幕上的左右');
  assert.deepEqual(draft.slots[SLOTS.PRIMARY], { entries: [{ kind: ENTRY_KINDS.PDF, resourceId: 'd1' }], active: 0 });
  assert.deepEqual(draft.slots[SLOTS.SECONDARY], { entries: [{ kind: ENTRY_KINDS.PDF, resourceId: 'd2' }], active: 0 });
  assert.equal(document.querySelector('.organizer.builder'), null, '单子要收干净');
});

await testAsync('存不进去（组合满了）：单子不关，拼好的还在，那句话就在按钮上面', async () => {
  // 原来是先关单子再存。存不进去时人拼的东西已经没了，手上只剩一句「没能保存」。
  let tries = 0;
  const p = openComboBuilder({
    items: ITEMS,
    pick: async () => ['d1'],
    askName: async () => '对答案',
    save: () => (++tries === 1 ? { ok: false, message: '组合存满了' } : { ok: true, combo: { id: 'c2' } }),
  });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(btn('save'));
  await tick();
  await tick();
  assert.ok(builderEl(), '单子还在');
  const error = builderEl().querySelector('[data-role="error"]');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, '组合存满了');
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民'], '拼好的一样不少');
  // 腾出位置再按一次就进去了；那句话说的是上一次，下一次改动就收起来。
  click(btn('save'));
  const combo = await p;
  assert.equal(combo.id, 'c2');
});

await testAsync('名字那一步取消了，人回到单子上，拼好的东西还在', async () => {
  let asked = 0;
  const p = openComboBuilder({
    items: ITEMS,
    pick: async () => ['d1'],
    askName: async () => { asked += 1; return null; },
    save: saveOk([]),
  });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(btn('save'));
  await tick();
  assert.equal(asked, 1);
  assert.ok(builderEl(), '一次「算了」不该罚掉他半分钟的活');
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民']);
  await leaveForGood();
  assert.equal(await p, null);
});

await testAsync('「保存并打开」连点两下，名字也只问一次', async () => {
  let asked = 0;
  let answer;
  const p = openComboBuilder({
    items: ITEMS,
    pick: async () => ['d1'],
    askName: () => { asked += 1; return new Promise((r) => { answer = r; }); },
    save: saveOk([]),
  });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(btn('save'));
  click(btn('save'));
  await tick();
  assert.equal(asked, 1);
  answer('对答案');
  const combo = await p;
  assert.equal(combo.name, '对答案');
});

await testAsync('挑东西那张单子开着时按 Escape，收起的是它，不是这一整套', async () => {
  // Escape 两张单子都在听。原来两张都会响应：挑东西那张收起，底下这张同时退掉——
  // 第一次挑东西时这张还是空的，于是一下 Escape 就把整个「自由组合」关了。
  let answer;
  const p = openComboBuilder({
    items: ITEMS,
    pick: () => new Promise((r) => { answer = r; }),
    askName: async () => null,
    save: saveOk([]),
  });
  await tick();
  click(addBtns()[0]);
  await tick();
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.ok(builderEl(), '这一下是压在上面那张的');
  assert.equal(builderEl().querySelector('.builder-confirm'), null, '也没有冒出「退出吗」');
  answer(null);
  await tick();
  // 上面那张收了，Escape 才又是这一张的。
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await p, null);
});

await testAsync('拼了一半要退出，先问一声；说「再想想」就还留在这儿', async () => {
  const p = openComboBuilder({ items: ITEMS, pick: async () => ['d1'], askName: async () => null, save: saveOk([]) });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(btn('exit'));
  await tick();
  const bar = builderEl().querySelector('.builder-confirm');
  assert.ok(bar, '它没有存在任何地方，关掉就没了');
  click(bar.querySelector('[data-role="stay"]'));
  await tick();
  assert.ok(builderEl(), '说了「再想想」就得还在');
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民']);
  await leaveForGood();
  assert.equal(await p, null);
});

await testAsync('「退出」点两下、或者点完再按 Escape，都不会摞出两条问话', async () => {
  const p = openComboBuilder({ items: ITEMS, pick: async () => ['d1'], askName: async () => null, save: saveOk([]) });
  await tick();
  click(addBtns()[0]);
  await tick();
  click(btn('exit'));
  click(btn('exit'));
  assert.equal(builderEl().querySelectorAll('.builder-confirm').length, 1);
  // 问着「退出吗」的时候按 Escape，是「算了，不退」。
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(builderEl().querySelectorAll('.builder-confirm').length, 0);
  assert.ok(builderEl());
  await leaveForGood();
  assert.equal(await p, null);
});

await testAsync('会换掉两栏里现在开着的东西时，那句提醒贴在按钮上面', async () => {
  // 用户定下的规矩：用一个组合会覆盖当前打开的书，点的时候要提醒。「保存并打开」
  // 也是在用组合。
  const note = '现在开着的 甲 和 乙 会被换掉。';
  const p = openComboBuilder({ items: ITEMS, pick: async () => ['d1'], askName: async () => null, save: saveOk([]), replaceNote: note });
  await tick();
  const replace = () => builderEl().querySelector('[data-role="replace"]');
  assert.equal(replace().hidden, true, '一本都没摆的时候按钮按不下去，提醒也不必出现');
  click(addBtns()[0]);
  await tick();
  assert.equal(replace().hidden, false);
  assert.equal(replace().textContent, note);
  await leaveForGood();
  await p;
});

await testAsync('两栏都空着的时候，不提醒「会换掉」', async () => {
  const p = openComboBuilder({ items: ITEMS, pick: async () => ['d1'], askName: async () => null, save: saveOk([]) });
  await tick();
  click(addBtns()[0]);
  await tick();
  assert.equal(builderEl().querySelector('[data-role="replace"]').hidden, true);
  await leaveForGood();
  await p;
});


// ── 拖动：和「整理内容」同一份手势 ──────────────────────────────────────────
//
// 用户要的：「支持拖动改变书在左栏还是右栏或者上下层显示，互动像整理内容那个一样」。
// 用的就是整理内容那一份（list-drag.js），这里只验自由组合这一头：落下之后摆法对
// 不对、能不能撤销、栏头说的是不是新的那一本。

/** jsdom 不排版：把两列摆成左右并排，每行 64 高、隔 70。每次重画之后都要再摆一次。 */
function layoutBuilder() {
  const lists = [...builderEl().querySelectorAll('[data-role="builder-list"]')];
  lists.forEach((list, i) => {
    const left = i * 320;
    list.getBoundingClientRect = () => ({ left, right: left + 300, top: 0, bottom: 400, width: 300, height: 400 });
    [...list.querySelectorAll('.organizer-row')].forEach((row, r) => {
      const top = 20 + r * 70;
      row.getBoundingClientRect = () => ({ left, right: left + 300, top, bottom: top + 64, width: 300, height: 64 });
    });
  });
}

let pclock = 5000;
function ptr(el, type, { x = 100, y = 40, id = 1 } = {}) {
  pclock += 16;
  const e = new dom.window.PointerEvent(type, { pointerId: id, clientX: x, clientY: y, isPrimary: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerType', { value: 'mouse', configurable: true });
  Object.defineProperty(e, 'timeStamp', { value: pclock, configurable: true });
  el.dispatchEvent(e);
}

/** 抓住某一栏第 n 行的把手，拖到 (x, y) 放下。 */
function dragRow(slot, n, x, y) {
  layoutBuilder();
  const handle = columnOf(slot).querySelectorAll('[data-role="handle"]')[n];
  assert.ok(handle, `${slot} 第 ${n} 行有把手`);
  const panel = builderEl();
  ptr(handle, 'pointerdown', { x: 10, y: 50 });
  ptr(panel, 'pointermove', { x: (x + 10) / 2, y: (y + 50) / 2 });
  ptr(panel, 'pointermove', { x, y });
  ptr(panel, 'pointerup', { x, y });
}

/** 包在对象里还回去：async 函数直接 return 一个 Promise，外面的 await 会一直等它——也就是等单子关掉。 */
async function builderWith(left, right = []) {
  const picks = [left, right];
  const p = openComboBuilder({ items: ITEMS, pick: async () => picks.shift(), askName: async () => null, save: saveOk([]) });
  await tick();
  if (left.length) { click(addBtns()[0]); await tick(); }
  if (right.length) { click(addBtns()[1]); await tick(); }
  return { done: p };
}

await testAsync('每一行都有和整理内容一样的把手', async () => {
  const { done: p } = await builderWith(['d1', 'd2']);
  const handles = columnOf(SLOTS.PRIMARY).querySelectorAll('.organizer-handle[data-role="handle"]');
  assert.equal(handles.length, 2);
  assert.equal(handles[0].getAttribute('aria-label'), '按住拖动');
  await leaveForGood();
  await p;
});

await testAsync('按住把手拖到另一栏：书换了栏，撤销能拖回来', async () => {
  const { done: p } = await builderWith(['d1', 'd2']);
  dragRow(SLOTS.PRIMARY, 1, 400, 30);            // 答案 → 右栏
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民']);
  assert.deepEqual(namesIn(SLOTS.SECONDARY), ['答案']);
  assert.equal(columnOf(SLOTS.SECONDARY).querySelector('[data-role="what"]').textContent, '答案');
  click(btn('undo'));
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民', '答案']);
  assert.deepEqual(namesIn(SLOTS.SECONDARY), []);
  await leaveForGood();
  await p;
});

await testAsync('在同一栏里拖上拖下换层：拖到顶上，它就是打开时显示的那一本', async () => {
  const { done: p } = await builderWith(['d1', 'd2', 'p1']);
  dragRow(SLOTS.PRIMARY, 2, 100, 5);             // 草稿一 → 最上面
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['草稿一', '谢惠民', '答案']);
  assert.equal(columnOf(SLOTS.PRIMARY).querySelector('[data-role="what"]').textContent, '草稿一',
    '栏头说的是打开时露在外面的那一本');
  dragRow(SLOTS.PRIMARY, 0, 100, 200);           // 草稿一 → 放到最下面
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民', '答案', '草稿一']);
  await leaveForGood();
  await p;
});

await testAsync('落点那一行说的是整理内容那句话', async () => {
  const { done: p } = await builderWith(['d1'], ['d2']);
  layoutBuilder();
  const handle = columnOf(SLOTS.PRIMARY).querySelector('[data-role="handle"]');
  ptr(handle, 'pointerdown', { x: 10, y: 50 });
  ptr(builderEl(), 'pointermove', { x: 400, y: 90 });   // 右栏「答案」下面
  const gap = builderEl().querySelector('.organizer-gap');
  assert.ok(gap, '有一条落点线');
  assert.equal(gap.textContent, '在「答案」之后（下层）');
  ptr(builderEl(), 'pointermove', { x: 400, y: 5 });    // 右栏最上面
  assert.equal(builderEl().querySelector('.organizer-gap').textContent, '作为该栏第一项');
  ptr(builderEl(), 'pointercancel', { x: 400, y: 5 });
  await leaveForGood();
  await p;
});

await testAsync('左右各一份时，把这一份拖过去：合成一份，放在落点', async () => {
  const { done: p } = await builderWith(['d1'], ['d1', 'd2']);
  dragRow(SLOTS.PRIMARY, 0, 400, 200);           // 左边的谢惠民 → 右栏最下面
  assert.deepEqual(namesIn(SLOTS.PRIMARY), []);
  assert.deepEqual(namesIn(SLOTS.SECONDARY), ['答案', '谢惠民'], '同一栏里不放两份');
  await leaveForGood();
  await p;
});

await testAsync('拖到单子外面放下，什么都不变，也不多一步撤销', async () => {
  const { done: p } = await builderWith(['d1', 'd2']);
  dragRow(SLOTS.PRIMARY, 0, 900, 900);
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民', '答案']);
  dragRow(SLOTS.PRIMARY, 0, 100, 5);             // 原地放下
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民', '答案']);
  click(btn('undo'));
  assert.deepEqual(namesIn(SLOTS.PRIMARY), [], '一下撤销就退回挑之前——没动的两次拖不占撤销栈');
  await leaveForGood();
  await p;
});

await testAsync('拖着的时候按 Escape：只放弃这次拖动，单子还在', async () => {
  const { done: p } = await builderWith(['d1', 'd2']);
  layoutBuilder();
  const handle = columnOf(SLOTS.PRIMARY).querySelectorAll('[data-role="handle"]')[1];
  ptr(handle, 'pointerdown', { x: 10, y: 50 });
  ptr(builderEl(), 'pointermove', { x: 400, y: 30 });
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(builderEl(), '单子还在');
  assert.equal(builderEl().querySelector('.builder-confirm'), null, '这一下不是「退出」');
  assert.equal(builderEl().querySelector('.organizer-row.is-ghost'), null, '拖着的那一行收干净了');
  ptr(builderEl(), 'pointerup', { x: 400, y: 30 });
  assert.deepEqual(namesIn(SLOTS.PRIMARY), ['谢惠民', '答案'], '放弃的拖动不算数');
  await leaveForGood();
  await p;
});


// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
