// PDF 模块 —— 文件夹：书架上的分类。
//
// 一个文件夹只有两样东西：一个名字，和「哪几份东西在里面」。
//
// **一层，不嵌套。** 文件夹里放的是书，不是文件夹。嵌套看上去只是多写几行，代价
// 却是整套东西都要跟着变：书架要有面包屑、移动那张单子要能往下钻、删一个文件夹要
// 决定里面的文件夹怎么办、而「我那本书在哪」从一个位置变成一条路径。这个应用里一
// 个人的书是几十本的量级，一层足够把它们分开；真到了不够的那天，再加一层也不迟。
//
// **归属记在文件夹这一侧，不记在书上。** 一份文件属于哪个文件夹，是 members 这张
// 表里的一行（资源 id → 文件夹 id）。记在书上要动三个仓库（PDF、草稿纸、笔记本）
// 的结构，而它们各自的字段是各自的事；记在这里，加这个功能不用碰任何一份已有数据，
// 删掉这个功能也不会留下一堆没人认识的字段。
//
// 组合也能放进文件夹：对人来说它也是架子上的一格。
//
// DOM-free，和 combo-state、shelf-state 一样：分类是数据的性质，不是渲染的性质。

/** 名字多长。只是防呆，不是设计上的限制。 */
export const FOLDER_LIMITS = Object.freeze({ NAME: 40 });

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * 一个文件夹。
 *
 * @param {Object} initial
 * @param {string} initial.id
 * @param {string} initial.name
 */
export function createFolder(initial = {}) {
  return Object.freeze({
    id: str(initial.id),
    name: str(initial.name).slice(0, FOLDER_LIMITS.NAME),
    createdAt: Number.isFinite(initial.createdAt) ? initial.createdAt : 0,
    updatedAt: Number.isFinite(initial.updatedAt) ? initial.updatedAt : 0,
  });
}

/** 新建一个文件夹该叫什么：「新建文件夹」「新建文件夹 2」…… */
export function nextFolderName(folders, base) {
  const taken = new Set((folders || []).map(f => f.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
  return base;
}

/**
 * 把一份东西放进某个文件夹，或者拿出来（folderId 给 null）。
 *
 * 一份东西同时只在一个文件夹里。这不是限制，是「文件夹」这个词的意思——一本书同
 * 时摆在两个格子里，人再也说不出它在哪。
 */
export function assignTo(members, id, folderId) {
  const key = str(id);
  if (!key) return members || {};
  const next = { ...(members || {}) };
  if (folderId) next[key] = str(folderId);
  else delete next[key];
  return Object.freeze(next);
}

/** 这份东西在哪个文件夹里。不在任何一个就是 null。 */
export function folderOf(members, id) {
  const value = (members || {})[str(id)];
  return value || null;
}

/** 这个文件夹里有几份东西。书脊那一行印它。 */
export function countIn(members, folderId) {
  if (!folderId) return 0;
  let n = 0;
  for (const value of Object.values(members || {})) if (value === folderId) n += 1;
  return n;
}

/** 这个文件夹里都有谁。 */
export function idsIn(members, folderId) {
  if (!folderId) return [];
  return Object.entries(members || {})
    .filter(([, value]) => value === folderId)
    .map(([id]) => id);
}

/**
 * 把已经不存在的东西从归属表里摘掉。
 *
 * 书会被删。删掉之后它那一行还留在这里，文件夹上印的份数就会多出几本不存在的书，
 * 而那个数正是人判断「这个文件夹里还有没有东西」的依据。
 *
 * @param {function(string): boolean} exists
 */
export function pruneMembers(members, exists, folders) {
  if (typeof exists !== 'function') return { members: members || {}, changed: false };
  const alive = new Set((folders || []).map(f => f.id));
  let changed = false;
  const next = {};
  for (const [id, folderId] of Object.entries(members || {})) {
    // 两头都要在：东西还在，装它的那个文件夹也还在。文件夹被删掉之后，里面的
    // 东西回到外面那一排，而不是跟着消失。
    if (!exists(id) || !alive.has(folderId)) { changed = true; continue; }
    next[id] = folderId;
  }
  return { members: changed ? Object.freeze(next) : (members || {}), changed };
}

export function serializeFolders(state) {
  return {
    version: 1,
    folders: (state?.folders || []).map(f => ({
      id: f.id, name: f.name, createdAt: f.createdAt, updatedAt: f.updatedAt,
    })),
    members: { ...(state?.members || {}) },
  };
}

export function deserializeFolders(json) {
  const folders = (Array.isArray(json?.folders) ? json.folders : [])
    .map(createFolder)
    .filter(f => f.id && f.name);
  const known = new Set(folders.map(f => f.id));
  const members = {};
  for (const [id, folderId] of Object.entries(json?.members || {})) {
    if (!id || !known.has(folderId)) continue;
    members[id] = folderId;
  }
  return { folders: Object.freeze(folders), members: Object.freeze(members) };
}
