// PDF 模块 —— 组合存在哪儿。
//
// 和会话（document-session.js）一样放 localStorage，不放 IndexedDB：一个组合是
// 十几个字符串和两个小数，十个组合也不到几 KB。放同一个地方还有第二个好处——
// 组合要读的那份「每本书最后停在哪一页」就在隔壁，两者永远同生共死，不会出现
// 「组合还在、页码记录已经被清掉」这种半截状态。
//
// 缩略图不在这里，在 cover-store 的 IndexedDB 里，和书的封面同一个柜子：它是
// 二进制，而且可以随时重画。丢了不影响组合能不能用。

import {
  comboSize,
  createCombo,
  deserializeCombo,
  serializeCombo,
} from './combo-state.js';
import Logger from '../core/logger.js';

const STORAGE_KEY = 'ls_pdf_combos';

/** 上限。到顶之后不再悄悄顶掉最旧的一个，而是让调用方去说一句话。 */
export const COMBO_MAX = 24;

export const COMBO_ERRORS = Object.freeze({
  EMPTY: 'COMBO_EMPTY',
  FULL: 'COMBO_FULL',
  NOT_FOUND: 'COMBO_NOT_FOUND',
});

function readAll() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return [];
    const json = JSON.parse(text);
    const list = Array.isArray(json?.combos) ? json.combos : [];
    return list.map(deserializeCombo).filter((c) => c.id && comboSize(c));
  } catch (error) {
    // 读不出来就当没有，而不是让整个书架打不开。
    Logger.warn('PDF', `组合读取失败：${error?.message || error}`);
    return [];
  }
}

function writeAll(combos) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      combos: combos.map(serializeCombo),
    }));
    return true;
  } catch (error) {
    Logger.error('PDF', `组合保存失败：${error?.message || error}`);
    return false;
  }
}

/** 全部组合，新的在前。 */
export function listCombos() {
  return readAll().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getCombo(id) {
  return readAll().find((c) => c.id === id) || null;
}

/**
 * 存一个新组合。
 *
 * id 在这里发，不由调用方给：一个组合的身份是这一层的事。
 */
export function saveCombo({ name, slots, dividerRatio, orientation, swapped }) {
  const now = Date.now();
  const combo = createCombo({
    id: `combo_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    slots,
    dividerRatio,
    orientation,
    swapped,
    createdAt: now,
    updatedAt: now,
  });
  if (!comboSize(combo)) throw new Error(COMBO_ERRORS.EMPTY);

  const all = readAll();
  if (all.length >= COMBO_MAX) throw new Error(COMBO_ERRORS.FULL);
  all.push(combo);
  writeAll(all);
  return combo;
}

/** 改名。改名不动 updatedAt 之外的任何东西，摆法还是那一套。 */
export function renameCombo(id, name) {
  const all = readAll();
  const at = all.findIndex((c) => c.id === id);
  if (at < 0) throw new Error(COMBO_ERRORS.NOT_FOUND);
  all[at] = createCombo({ ...all[at], name, updatedAt: Date.now() });
  writeAll(all);
  return all[at];
}

export function deleteCombo(id) {
  const all = readAll();
  const left = all.filter((c) => c.id !== id);
  if (left.length === all.length) return false;
  writeAll(left);
  return true;
}

/**
 * 把一个组合换成修剪过的那份。
 *
 * 书被删掉之后组合里会留下指向空处的条目，pruneCombo 负责摘，这里负责落盘。
 * 摘空了就整条删掉——一个一本书都没有的组合点开什么也不会发生，留着只是在书架
 * 上占一格并让人以为它坏了。
 */
export function replaceCombo(combo) {
  const all = readAll();
  const at = all.findIndex((c) => c.id === combo.id);
  if (at < 0) return false;
  if (!comboSize(combo)) {
    all.splice(at, 1);
  } else {
    all[at] = createCombo({ ...combo, updatedAt: combo.updatedAt || Date.now() });
  }
  writeAll(all);
  return true;
}

/** 测试和「清空数据」用。 */
export function clearCombos() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* 没有就没有 */ }
}
