// PDF 模块 —— 文件夹存在哪儿。
//
// 和组合（combo-store）一样放 localStorage：一个文件夹是一个名字加一串 id，几十
// 个也就几 KB。放同一个地方还有第二个好处——「哪本书在哪个文件夹」和「哪本书最后
// 读到第几页」是隔壁邻居，两者永远同生共死，不会出现「文件夹还在、书的记录已经被
// 清掉」这种半截状态。
//
// 文件本身一个字节都不动：这里存的只是归属，删掉这个文件就等于把所有东西倒回外面
// 那一排，没有任何一份 PDF、草稿纸、笔记本会受影响。

import {
  assignTo,
  createFolder,
  deserializeFolders,
  folderOf as folderOfIn,
  nextFolderName,
  pruneMembers,
  serializeFolders,
} from './folder-state.js';
import Logger from '../core/logger.js';

const STORAGE_KEY = 'ls_pdf_folders';

/** 上限。到顶之后让调用方去说一句话，而不是悄悄不建。 */
export const FOLDER_MAX = 60;

export const FOLDER_ERRORS = Object.freeze({
  FULL: 'FOLDER_FULL',
  NOT_FOUND: 'FOLDER_NOT_FOUND',
  EMPTY_NAME: 'FOLDER_EMPTY_NAME',
});

function readAll() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return { folders: [], members: {} };
    return deserializeFolders(JSON.parse(text));
  } catch (error) {
    // 读不出来就当没有，而不是让整个书架打不开。
    Logger.warn('PDF', `文件夹读取失败：${error?.message || error}`);
    return { folders: [], members: {} };
  }
}

function writeAll(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeFolders(state)));
    return true;
  } catch (error) {
    Logger.error('PDF', `文件夹保存失败：${error?.message || error}`);
    return false;
  }
}

/** 全部文件夹，新建的在后——人按自己建的顺序去记它们的位置。 */
export function listFolders() {
  return readAll().folders.slice().sort((a, b) => (a.createdAt - b.createdAt)
    || (a.id < b.id ? -1 : 1));
}

/** 「哪份东西在哪个文件夹」那张表。 */
export function folderMembers() {
  return readAll().members;
}

export function getFolder(id) {
  return readAll().folders.find(f => f.id === id) || null;
}

export function folderOf(id) {
  return folderOfIn(readAll().members, id);
}

/**
 * 新建一个文件夹。
 *
 * 不给名字就自己取一个不重名的：人点「新建文件夹」的那一刻想的是「我要个格子」，
 * 先给他格子，名字可以回头改。
 */
export function addFolder(name, now = Date.now()) {
  const state = readAll();
  if (state.folders.length >= FOLDER_MAX) throw new Error(FOLDER_ERRORS.FULL);
  const folder = createFolder({
    id: `fld_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: (name || '').trim() || nextFolderName(state.folders, '新建文件夹'),
    createdAt: now,
    updatedAt: now,
  });
  writeAll({ folders: [...state.folders, folder], members: state.members });
  return folder;
}

export function renameFolder(id, name) {
  const clean = (name || '').trim();
  if (!clean) throw new Error(FOLDER_ERRORS.EMPTY_NAME);
  const state = readAll();
  const at = state.folders.findIndex(f => f.id === id);
  if (at < 0) throw new Error(FOLDER_ERRORS.NOT_FOUND);
  const folders = state.folders.slice();
  folders[at] = createFolder({ ...folders[at], name: clean, updatedAt: Date.now() });
  writeAll({ folders, members: state.members });
  return folders[at];
}

/**
 * 删掉一个文件夹。
 *
 * 里面的东西**回到外面那一排**，不跟着删。文件夹是个格子，不是个箱子——把格子拿
 * 走不该把书也带走，而「删文件夹会不会把我的书删了」这个问题，人不该需要问。
 */
export function deleteFolder(id) {
  const state = readAll();
  const folders = state.folders.filter(f => f.id !== id);
  if (folders.length === state.folders.length) return false;
  const members = {};
  for (const [key, value] of Object.entries(state.members)) {
    if (value !== id) members[key] = value;
  }
  writeAll({ folders, members });
  return true;
}

/** 把一份东西放进某个文件夹；folderId 给空就是拿回外面那一排。 */
export function moveToFolder(resourceId, folderId) {
  const state = readAll();
  if (folderId && !state.folders.some(f => f.id === folderId)) {
    throw new Error(FOLDER_ERRORS.NOT_FOUND);
  }
  writeAll({ folders: state.folders, members: assignTo(state.members, resourceId, folderId) });
  return true;
}

/**
 * 把已经不存在的东西从归属表里摘掉，并落盘。
 *
 * 书架每次摊开都会叫它一次：那是唯一一处同时知道「现在还有哪些东西」的地方。
 */
export function pruneFolders(exists) {
  const state = readAll();
  const { members, changed } = pruneMembers(state.members, exists, state.folders);
  if (changed) writeAll({ folders: state.folders, members });
  return { folders: state.folders, members };
}

/** 测试和「清空数据」用。 */
export function clearFolders() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* 没有就没有 */ }
}
