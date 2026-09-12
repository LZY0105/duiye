// Ink Module —剪下来的那一片，暂时放在哪。
//
// 模块级的一份，两个分栏共用——而那正是剪切存在的理由：从这一页剪下来，翻到另
// 一页、或者换到另一栏、或者换到草稿纸上再放下。每个画布各存一份的话，剪切就
// 只能在它自己那一页里打转，那和「复制一份再删掉原来的」没有区别。
//
// 存的是序列化过的笔画，不是活的对象。存活对象会出两种事：粘贴两次得到同一条
// 笔画的两个引用（搬其中一个，另一个跟着走），以及被剪下来的那些笔画在原来那一
// 层里还被撤销栈牵着，clipboard 一留就谁也放不掉。序列化之后它是一份死数据，
// 谁粘贴谁复活一份新的。
//
// 不落盘。关掉 app 剪贴板就空了——这和系统剪贴板的脾气一致，而且一份跨会话存着
// 的笔画在下次打开时属于哪一页、该用哪个坐标系，都没有好答案。

import { deserializeStroke, recomputeBounds, serializeStroke } from './stroke.js';

/** 序列化过的笔画，外加它们当时的外接框（粘贴时用来对位）。 */
let held = null;

/**
 * 把这几条笔画收进来。
 *
 * @param {Array<Object>} strokes 活的笔画对象，这里只读不留
 */
export function putOnClipboard(strokes) {
  const list = (strokes || []).filter(Boolean);
  if (!list.length) { held = null; return false; }
  let minX = Infinity;
  let minY = Infinity;
  for (const s of list) {
    for (const pt of s.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
    }
  }
  held = {
    strokes: list.map(serializeStroke),
    // 左上角。粘贴时把整片挪到目标点，各条之间的相对位置照旧。
    originX: Number.isFinite(minX) ? minX : 0,
    originY: Number.isFinite(minY) ? minY : 0,
  };
  return true;
}

export function clipboardHasInk() {
  return !!held && held.strokes.length > 0;
}

/** 剪贴板里有几条。给界面上「粘贴 3 条」这种说法留的，现在没人用。 */
export function clipboardSize() {
  return held ? held.strokes.length : 0;
}

/**
 * 复活一份，落在指定的点上。
 *
 * 每次都是新的 id：粘贴两次得到两片互不相干的笔画，而不是同一片的两个引用。
 *
 * @param {number} x 目标点，文档坐标；整片的左上角会落在这里
 * @param {number} y
 * @returns {Array<Object>} 新的笔画，调用方负责放进层里
 */
export function takeFromClipboard(x = 0, y = 0) {
  if (!clipboardHasInk()) return [];
  const dx = x - held.originX;
  const dy = y - held.originY;
  return held.strokes.map((json) => {
    // id 不带过去：反序列化会认 json.id，而那是原件的号。
    const stroke = deserializeStroke({ ...json, id: undefined });
    for (const pt of stroke.points) { pt.x += dx; pt.y += dy; }
    // 挪完再算边界。留给调用方算的话，迟早有一条路忘了算，而边界错了的笔画
    // 不会画错，只会点不中、框不到——一种查起来很费劲的错。
    recomputeBounds(stroke);
    return stroke;
  });
}

/** 给测试用的，也给「清空剪贴板」这种以后可能要的动作留着。 */
export function clearClipboard() {
  held = null;
}
