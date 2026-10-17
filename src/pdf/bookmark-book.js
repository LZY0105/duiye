// 书签成书 —— 新书上的书签。
//
// 从一本书的书签页里挑几页做成一本新书，新书的第 1、2、3……页对的是原书的第 37、76、89……页。新书每一页都标上
// 书签，名字说清楚它从哪儿来：原来有名字的照抄、后面跟「原第 N 页」，没名字的就是「原第 N 页」。这样新书的书签
// 那一页就是一张目录，翻回原书也知道去哪一页找。
//
// 还有「从母本更新」那一页笔迹怎么合（mergeFromSource）。
//
// 不碰 DOM，文案由调用方给（i18n 在界面层）。

import { LABEL_MAX, createBookmarks } from './bookmark-state.js';
import { serializeStroke } from '../ink/stroke.js';

/**
 * 新书上的书签：第 i 页（从 1 数）对原书的 pages[i-1]。
 *
 * 名字超过书签名的上限（LABEL_MAX）时截的是原来那个名字，不是「原第 N 页」那半句——那半句是新书和原书之间唯一
 * 的线索，截掉了就对不回去了。
 *
 * @param {ReadonlyArray<{page: number, label: string}>} marks 原书的书签
 * @param {number[]} pages 挑中的原书页码，按新书的次序
 * @param {{named: function(string, number): string, unnamed: function(number): string}} words
 *   `named(label, page)` 有名字的那种怎么说，`unnamed(page)` 没名字的那种
 * @returns {ReadonlyArray<{page: number, label: string}>}
 */
export function bookmarksForNewBook(marks, pages, { named, unnamed }) {
  const byPage = new Map((marks || []).map((m) => [m.page, m]));
  const out = (pages || []).map((from, i) => {
    const label = byPage.get(from)?.label || '';
    if (!label) return { page: i + 1, label: unnamed(from) };
    const room = LABEL_MAX - named('', from).length;
    const fits = label.length <= room ? label : `${label.slice(0, Math.max(1, room - 1))}…`;
    return { page: i + 1, label: named(fits, from) };
  });
  return createBookmarks(out);
}

// ── 从母本更新 ────────────────────────────────────────────────────────────────

/** 一笔画出来长什么样的指纹：存盘的那几样（点、颜色、粗细……）拼起来算一个短串。 */
export function strokePrint(stroke) {
  const text = JSON.stringify(serializeStroke(stroke));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}.${text.length.toString(36)}`;
}

/** 上次同步时记下的那份：{ 笔迹 id: 指纹 }。新书刚做好时就是母本那一页当时的样子。 */
export function syncBaseOf(strokes) {
  const base = {};
  for (const stroke of strokes || []) base[stroke.id] = strokePrint(stroke);
  return base;
}

/**
 * 新书的一页从母本对应那一页更新：三方合并，比的是「上次同步时的样子」（base）、母本现在、新书现在。
 *
 *   - 母本来的一笔（上次拷过来的那几笔，按 id 认）：
 *       母本改了它 → 换成母本的；母本没改 → 留新书上的（人在新书上搬过、换过色的不被挪回去）；
 *       母本擦了它 → 新书上也去掉；人在新书上擦了它 → 不再加回来。
 *   - 母本上次之后新写的 → 加进来。
 *   - 人在新书上自己写的 → 不动，叠在母本的上面（写的先后就是这样）。
 *
 * @param {Array} parent 母本那一页现在的笔迹
 * @param {Array} child 新书这一页现在的笔迹
 * @param {Object<string, string>} base 上次同步时母本那一页的 { id: 指纹 }
 * @returns {{strokes: Array, base: Object<string, string>, changed: boolean}}
 *   `strokes` 新书这一页该有的笔迹；`base` 这一次的样子，下次同步拿来比；`changed` 和新书现在的不一样
 */
export function mergeFromSource(parent, child, base = {}) {
  const was = base || {};
  const mine = new Map((child || []).map((s) => [s.id, s]));
  const theirs = new Set((parent || []).map((s) => s.id));
  const strokes = [];
  for (const stroke of parent || []) {
    const known = Object.prototype.hasOwnProperty.call(was, stroke.id);
    const held = mine.get(stroke.id);
    if (!known) {
      // 上次之后母本新写的；新书上碰巧也有同一笔（拖过来的），以母本的为准。
      strokes.push(stroke);
    } else if (held) {
      strokes.push(strokePrint(stroke) === was[stroke.id] ? held : stroke);
    }
    // known 而新书上没有：人在新书上擦掉了，不加回来。
  }
  for (const stroke of child || []) {
    const fromParent = Object.prototype.hasOwnProperty.call(was, stroke.id) || theirs.has(stroke.id);
    if (!fromParent) strokes.push(stroke);
  }
  const changed = strokes.length !== (child || []).length
    || strokes.some((s, i) => s !== child[i] && (s.id !== child[i].id || strokePrint(s) !== strokePrint(child[i])));
  return { strokes, base: syncBaseOf(parent), changed };
}
