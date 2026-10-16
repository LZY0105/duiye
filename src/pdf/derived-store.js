// 书签成书做出来的新书，和它的母本之间的那根线。
//
// 「从母本更新」要知道三样：母本是哪一本、新书第 i 页是母本第几页、上次同步时从母本拷过来的是哪几笔（每笔的 id 和
// 指纹）。第三样是为了分清新书上的笔迹哪些是母本来的、哪些是人在新书上自己写的，见 bookmark-book.js 的 mergeFromSource。
//
// 分两处存：
//   - 前两样很小，放 localStorage（`ls_pdf_derived`，和书签同一处），同步读——工作区每次重画栏头都要问一句「这本有没有
//     母本」，菜单里那一项显不显示得当场知道。
//   - 第三样可以很大：平板上一本 29 页、每页几百上千笔的新书就有 650 KB。localStorage 一共就几兆，再做几本就把书签、
//     会话这些设置挤得存不进去——所以放 IndexedDB（`latexsnipper-derived`），和书、笔迹一样按磁盘算。
// 第一版把第三样也放在 localStorage 里（平板上已经有一本），读到时搬过去，搬完从 localStorage 里去掉。
//
// 一本书删掉时 forgetDerived：它是新书，线就断了；它是母本，从它做出来的那些新书也就没有母本可更新了，一并断掉。

import { openDB } from 'idb';

const KEY = 'ls_pdf_derived';
const DB_NAME = 'latexsnipper-derived';
const STORE = 'base';

/** 读一次就记在这里：不该每次重画栏头都解析一遍。 */
let cache = null;

/** 第三样存在哪儿：默认 IndexedDB；测试换成内存里的（Node 里没有 IndexedDB）。 */
let backend = null;
function idbBackend() {
  let ready = null;
  const db = () => (ready ||= openDB(DB_NAME, 1, {
    upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); },
  }));
  return {
    get: async (key) => (await db()).get(STORE, key),
    put: async (key, value) => { await (await db()).put(STORE, value, key); },
    delete: async (key) => { await (await db()).delete(STORE, key); },
  };
}
const bases = () => (backend ||= idbBackend());

/** 测试用：换一个存第三样的地方（{get, put, delete}，都返回 Promise）。传 null 换回 IndexedDB。 */
export function setDerivedBaseBackend(next) {
  backend = next;
}

function readAll() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    cache = {};
  }
  migrateInlineBases();
  return cache;
}

function writeAll(all) {
  cache = all;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch (_) { /* 存不下（隐私模式、满了）：这一次会话里照样能用 */ }
}

/** 第一版留在 localStorage 里的那几份第三样：搬进 IndexedDB，搬好了再从 localStorage 里去掉。 */
let migrating = null;
function migrateInlineBases() {
  if (migrating) return;
  const inline = Object.entries(cache).filter(([, link]) => link && link.base);
  if (!inline.length) return;
  migrating = (async () => {
    for (const [child, link] of inline) {
      try {
        await bases().put(child, link.base);
      } catch (_) {
        continue; // 搬不过去就先留着，下次再搬：总比丢了强
      }
      const all = readAll();
      if (!all[child]) continue;
      const { base: _moved, ...rest } = all[child];
      writeAll({ ...all, [child]: rest });
    }
  })().finally(() => { migrating = null; });
}

/**
 * @param {string} childId
 * @returns {{source: string, pages: number[], syncedAt: number}|null}
 *   `pages[i]` 是新书第 i+1 页对应的母本页码
 */
export function derivedFrom(childId) {
  const link = childId ? readAll()[childId] : null;
  if (!link || typeof link.source !== 'string' || !Array.isArray(link.pages)) return null;
  return { source: link.source, pages: link.pages.slice(), syncedAt: link.syncedAt || 0 };
}

/**
 * 上次同步时从母本拷来的那几笔：{ 新书页码: { 笔迹 id: 指纹 } }。还没搬进 IndexedDB 的（第一版）直接从 localStorage 给。
 * @returns {Promise<Object<string, Object<string, string>>>}
 */
export async function loadDerivedBase(childId) {
  const inline = readAll()[childId]?.base;
  if (inline) return { ...inline };
  try {
    return { ...((await bases().get(childId)) || {}) };
  } catch (_) {
    return {};
  }
}

/** 新书做好的那一刻记下。 */
export async function recordDerived(childId, { source, pages, base = {} }, now = Date.now()) {
  if (!childId || !source || !Array.isArray(pages)) return;
  writeAll({ ...readAll(), [childId]: { source, pages: pages.slice(), syncedAt: now } });
  await bases().put(childId, base);
}

/** 同步完：记下这一次从母本拷了哪几笔。 */
export async function updateDerivedBase(childId, base, now = Date.now()) {
  const all = readAll();
  if (!all[childId]) return;
  await bases().put(childId, base);
  const { base: _old, ...rest } = all[childId];
  writeAll({ ...readAll(), [childId]: { ...rest, syncedAt: now } });
}

/** 一本书没了：它是新书就断线；它是母本，从它做出来的新书都断线。 */
export function forgetDerived(resourceId) {
  if (!resourceId) return;
  const all = readAll();
  const next = {};
  const gone = [];
  for (const [child, link] of Object.entries(all)) {
    if (child === resourceId || link?.source === resourceId) { gone.push(child); continue; }
    next[child] = link;
  }
  if (!gone.length) return;
  writeAll(next);
  for (const child of gone) bases().delete(child).catch(() => { /* 留一份没人要的，不碍事 */ });
}

/** 测试用：丢掉内存里那一份，下一次重新从 localStorage 读。 */
export function resetDerivedCache() {
  cache = null;
}

/** 测试用：等正在搬的那一批搬完。 */
export function derivedMigration() {
  return migrating || Promise.resolve();
}
