// Ink Module —— 浮在笔迹画布旁边的那几样（套索那条小条、识别的进度小条和结果单子）摆的时候，躲开浮在书页上的笔迹工具栏。
//
// 工具栏是另一层（z-index 比书页那一栏高），贴在左边、右边，或者被人拖到书页中间。条和单子是按圈居中摆的，圈在页边的时候
// 正好落到工具栏底下：平板上看到的是结果单子左边一截被工具栏盖住，标题「认出 1 条」只露出「1 条」，套索条的「复制」也只
// 剩半个字。所以摆好以后再看一眼：压到工具栏了，就横着挪到它右边或左边——哪边放得下、挪得少用哪边；两边都放不下就不动。

/** 眼下浮在书页上的那几样（屏幕坐标）。工具栏收进顶上那一排时它不在书页上，自然压不到。 */
function obstacleRects() {
  if (typeof document === 'undefined') return [];
  const rects = [];
  for (const el of document.querySelectorAll('.ink-toolbar')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) rects.push(r);
  }
  return rects;
}

/**
 * 摆在 host 里 (left, top)、w × h 的一块：压到工具栏就横着挪开。
 * @param {Element} host 条和单子挂在哪（它们的坐标相对它）
 * @param {{width: number}} viewport host 有多宽
 * @returns {number} 挪过以后的 left
 */
export function avoidFloatingObstacles(host, left, top, w, h, viewport, edge = 8) {
  if (!host?.getBoundingClientRect || !(w > 0) || !(h > 0)) return left;
  const hostRect = host.getBoundingClientRect();
  const width = viewport?.width || hostRect.width;
  let x = left;
  for (const o of obstacleRects()) {
    const ox0 = o.left - hostRect.left;
    const ox1 = o.right - hostRect.left;
    const oy0 = o.top - hostRect.top;
    const oy1 = o.bottom - hostRect.top;
    if (!(top < oy1 && top + h > oy0 && x < ox1 && x + w > ox0)) continue;
    const toRight = ox1 + edge;
    const toLeft = ox0 - edge - w;
    const rightFits = toRight + w <= width - edge;
    const leftFits = toLeft >= edge;
    if (rightFits && (!leftFits || toRight - x <= x - toLeft)) x = toRight;
    else if (leftFits) x = toLeft;
  }
  return x;
}
