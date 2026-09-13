// Note Module —— 笔记本资源。
//
// 笔记本和草稿纸是同一件事的两种模式，对话框里并排摆着，纸张样式也共用同一套
// （scratch-style.js 的八种格子、四种纸色）。它们只差一件事，而那件事决定了别的
// 全部：
//
//   草稿纸是一张没有边界的纸，一页，靠平移缩放去看它的任意一处；
//   笔记本是一叠有边界的纸，N 页，像课本一样一页一页翻。
//
// 所以笔记本不是「能翻页的草稿纸」，它是一份**文档**。见 note-document.js：它把
// 自己装成 pdf-document 的形状，于是 PdfPane、找页面板、书签、封面、会话恢复整套
// 东西一行都不用改就能用在它身上。这里只管那份记录本身。
//
// 笔迹同样不存在这里，走的是和 PDF 一模一样的路：ink-store 里按 (笔记本 id, 页码)
// 存。所以「写完关掉再打开还在」这条保证是继承来的，不是重写的一份。

import { openDB } from 'idb';
import { deleteDocumentInk, deletePageInk } from '../ink/ink-store.js';
import { createScratchStyle, serializeStyle } from '../scratch/scratch-style.js';

const DB_NAME = 'duiye-note';
const DB_VERSION = 1;
const STORE = 'notebooks';

export const NOTE_ERRORS = Object.freeze({
  NOT_FOUND: 'NOTE_NOT_FOUND',
  STALE_REVISION: 'NOTE_STALE_REVISION',
});

/** 和草稿纸同一个上限，因为它们在同一个对话框里。 */
export const NAME_MAX = 60;

/**
 * 一本笔记本最多多少页。
 *
 * 页是空的 —— 一页不占存储，只占一个页码。所以这个上限不是为了省地方，是为了
 * 让「找页面」那个网格还能用手翻完：一千页的缩略图网格，人找不到自己那一页。
 */
export const PAGE_MAX = 999;

/** 新建时默认给多少页。一本练习本的量级，不够可以随时在末尾加。 */
export const PAGE_DEFAULT = 20;

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      },
    });
  }
  return dbPromise;
}

function escapeForRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function newId() {
  return 'note_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

export function clampPageCount(value, fallback = PAGE_DEFAULT) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(PAGE_MAX, n);
}

export function trimName(name, fallback = '') {
  const text = String(name ?? '').trim().slice(0, NAME_MAX);
  return text || fallback;
}

function normalise(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name || '',
    style: createScratchStyle(record.style),
    pageCount: clampPageCount(record.pageCount, 1),
    createdAt: record.createdAt || 0,
    updatedAt: record.updatedAt || 0,
    /** 每次提交写入都 +1；样式面板靠它拦住「面板开着的时候本子被别处改了」。 */
    revision: Number(record.revision) || 1,
  };
}

/**
 * 下一个默认名字：笔记本 01、02、03……
 *
 * 前缀由调用方按界面语言给，编号从现有的名字里数出来而不是存一个计数器 —— 删掉
 * 一本就把那个号让出来，新装的应用从 01 开始。和草稿纸是同一套规矩。
 */
export async function nextNotebookName(prefix) {
  const label = prefix || 'Notebook';
  const books = await listNotebooks();
  const used = new Set();
  const pattern = new RegExp(`^${escapeForRegExp(label)}\\s*(\\d+)$`, 'i');
  for (const book of books) {
    const hit = pattern.exec(book.name || '');
    if (hit) used.add(Number(hit[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `${label} ${String(n).padStart(2, '0')}`;
}

export async function createNotebook({ name, style, pageCount, namePrefix } = {}) {
  const now = Date.now();
  const record = {
    id: newId(),
    name: trimName(name, await nextNotebookName(namePrefix)),
    style: serializeStyle(style || createScratchStyle()),
    pageCount: clampPageCount(pageCount),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  const db = await getDB();
  await db.put(STORE, record);
  return normalise(record);
}

/** 每一本，新的在前。 */
export async function listNotebooks() {
  const db = await getDB();
  const all = await db.getAll(STORE);
  return all.map(normalise).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getNotebook(id) {
  if (!id) return null;
  const db = await getDB();
  return normalise(await db.get(STORE, id));
}

async function patch(id, fields, expectedRevision) {
  const db = await getDB();
  const stored = await db.get(STORE, id);
  if (!stored) throw new Error(NOTE_ERRORS.NOT_FOUND);
  if (expectedRevision != null && Number(stored.revision || 1) !== Number(expectedRevision)) {
    const error = new Error(NOTE_ERRORS.STALE_REVISION);
    error.current = normalise(stored);
    throw error;
  }
  const record = {
    ...stored,
    ...fields,
    updatedAt: Date.now(),
    revision: Number(stored.revision || 1) + 1,
  };
  await db.put(STORE, record);
  return normalise(record);
}

export async function renameNotebook(id, name) {
  const current = await getNotebook(id);
  if (!current) throw new Error(NOTE_ERRORS.NOT_FOUND);
  return patch(id, { name: trimName(name, current.name) });
}

/**
 * 改纸张样式。
 *
 * 写回已经存着的值不算一次写入 —— 否则在没改过的面板上点「应用」会白白把
 * revision 顶掉，让别处捕获的那个作废，而什么都没变。和草稿纸同一条规矩。
 */
export async function setNotebookStyle(id, style, { expectedRevision } = {}) {
  const current = await getNotebook(id);
  if (!current) throw new Error(NOTE_ERRORS.NOT_FOUND);
  const next = createScratchStyle(style);
  const a = serializeStyle(current.style);
  const b = serializeStyle(next);
  if (JSON.stringify(a) === JSON.stringify(b)) return current;
  return patch(id, { style: b }, expectedRevision);
}

/**
 * 在末尾加几页。
 *
 * 只能往后加，不能往中间插。插页会把后面每一页的页码整体推后一位，而笔迹是按页
 * 码存的 —— 于是所有写过的内容会集体错位一页，而且没有任何地方会报错。真要支持
 * 插页，得先让笔迹跟着页搬家；在那之前，「只能往后加」是诚实的做法。
 */
export async function addNotePages(id, count = 1) {
  const current = await getNotebook(id);
  if (!current) throw new Error(NOTE_ERRORS.NOT_FOUND);
  const add = Math.max(1, Math.floor(Number(count) || 1));
  const next = clampPageCount(current.pageCount + add, current.pageCount);
  if (next === current.pageCount) return current;      // 已经到上限
  return patch(id, { pageCount: next });
}

/**
 * 删掉最后几页，连同写在上面的笔迹。
 *
 * 只删末尾，理由同上。笔迹在这里是真的删掉 —— 一本本子的页数减少之后，那几页
 * 再也没有入口，留着笔迹只是占地方而且永远不会被人看见。
 */
export async function removeNotePages(id, count = 1) {
  const current = await getNotebook(id);
  if (!current) throw new Error(NOTE_ERRORS.NOT_FOUND);
  const drop = Math.max(1, Math.floor(Number(count) || 1));
  const next = Math.max(1, current.pageCount - drop);
  if (next === current.pageCount) return current;      // 只剩一页了
  for (let page = next + 1; page <= current.pageCount; page++) {
    try { await deletePageInk(id, page); } catch (_) { /* 那一页本来就没写过 */ }
  }
  return patch(id, { pageCount: next });
}

export async function deleteNotebook(id) {
  if (!id) return;
  await deleteDocumentInk(id);
  const db = await getDB();
  await db.delete(STORE, id);
}
