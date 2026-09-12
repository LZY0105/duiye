// Ink Module — 同一页的笔迹，两栏共用的那一份。
//
// 同一本书可以同时开在两栏里——这是这个 app 存在的理由之一，习题册和答案册对照
// 着看，而两栏也可以是同一本书的两页。翻到同一页时，两边画的是同一张纸。
//
// 原来不是。每一栏各自 loadLayer 得到一份**新反序列化**的副本，而存盘是整层盲
// 写。于是：两栏都停在第 7 页（各有那 2 笔）→ 左边画一笔、存成 3 笔 → 右边画一
// 笔，可它手里还是当初那 2 笔，加上自己的一笔存成 3 笔——把左边那一笔整个盖掉。
// 人看到的是「我刚画的没了」，而且是在另一栏里没的。
//
// 合并不是好办法：要知道「哪些是我删掉的」才能和别人的改动合起来，而那要求撤销
// 栈参与存盘。共用同一个对象就没有这个问题——左边加进去的那一笔本来就已经在右边
// 的层里了，右边只需要重画一次。
//
// 引用计数，因为「谁先走」不该决定这一页还在不在：两栏都翻走了，这一份才作废。
//
// 纯的，不碰 IndexedDB：谁拿到的层由调用方去 loadLayer，这里只管「这一页已经有
// 人拿着了吗」。所以它能在 Node 里单独测，而那正是这套规则最需要被钉住的地方。

import { inkKey } from './ink-store.js';

/** key → { layer, holders: Map<holder, 重画一下> }。没人拿着的 key 不留在表里。 */
const live = new Map();

/**
 * 把刚读出来的一层交上去，换回「该用的那一层」。
 *
 * 已经有人拿着同一页，就用他那一份，你读出来的这份丢掉；没人拿着，你这份就成为
 * 大家的那一份。
 *
 * @param {string} documentId
 * @param {number} page
 * @param {Object} layer     调用方刚读出来的 InkLayer
 * @param {Object} holder    拿着它的人，任意唯一值（分栏的 pane 自己）
 * @param {Function} [onPeerChange] 别人改了这一层时，叫你重画一下
 * @returns {Object} 该用的那一层
 */
export function shareLayer(documentId, page, layer, holder, onPeerChange) {
  if (!documentId || !page || !layer || !holder) return layer;
  const key = inkKey(documentId, page);
  let cell = live.get(key);
  if (!cell) {
    cell = { layer, holders: new Map() };
    live.set(key, cell);
  }
  cell.holders.set(holder, onPeerChange || null);
  return cell.layer;
}

/**
 * 不再看这一页了。
 *
 * 最后一个人走了才把它从表里拿掉——不然「谁先翻页」就决定了另一个人手里那份还算
 * 不算数。
 */
export function releaseLayer(documentId, page, holder) {
  if (!documentId || !page || !holder) return;
  const key = inkKey(documentId, page);
  const cell = live.get(key);
  if (!cell) return;
  cell.holders.delete(holder);
  if (!cell.holders.size) live.delete(key);
}

/**
 * 我改了这一层，让同看这一页的另一栏重画一遍。
 *
 * 只叫别人，不叫自己：改的那一方早就画过了，再叫一次是白画一帧。
 */
export function notifyPeers(documentId, page, holder) {
  if (!documentId || !page) return 0;
  const cell = live.get(inkKey(documentId, page));
  if (!cell) return 0;
  let told = 0;
  for (const [other, repaint] of cell.holders) {
    if (other === holder || !repaint) continue;
    told += 1;
    try { repaint(); } catch (_) { /* 一个人重画失败不该拖住其他人 */ }
  }
  return told;
}

/** 这一页现在几个人拿着。给测试，也给排查用。 */
export function holderCount(documentId, page) {
  return live.get(inkKey(documentId, page))?.holders.size || 0;
}

/** 整个表清空。测试之间用，真机上不该有人叫。 */
export function resetSharedInk() {
  live.clear();
}
