// PDF 模块 —— 从 pdf.js 文档里取东西的纯逻辑。
//
// 这一份代码有两个运行环境：主线程，和渲染 worker（pdf-render-worker.js）。所以
// 它只认 pdf.js 的文档对象，不碰 document、不碰 canvas，也不碰任何只有窗口里才
// 有的东西。
//
// 为什么非要共用一份：抽出来的文本是匹配引擎的输入。worker 一份实现、主线程回退
// 路径再一份实现，两边哪怕只差一个换行分组的容差，同一本书在两条路径下就会对出
// 不同的题，而且没有任何地方会报错。宁可多一个文件，也不要两份「差不多」的抽取。

/** 目录抽取的「确实没有」这个答案，和「还没抽」区分开。 */
export const NO_OUTLINE = Object.freeze({ available: false, items: [] });

/**
 * 归行时容忍的基线漂移，单位是 PDF 单位。
 *
 * 大到能把上标和它所在的行留在一起，小到不会把相邻两行并成一行。
 */
const LINE_TOLERANCE = 2.5;

/**
 * 把 pdf.js 的原始目录树转成我们自己的形状。
 *
 * 规矩：书里有目录就照原样保留，书里没有就绝不替它生成一个。没有书签的文档因此
 * 得到 `available: false` 和一个空列表 —— 调用方要如实显示「本文档没有目录」，
 * 而不是拿页码或者正文标题拼一个出来。
 *
 * 目的地能被 pdf.js 解析的，解析成 1 起始的页码；解析不了的保留
 * `pageNumber: null`，显示成不可跳转，而不是悄悄指向第 1 页。
 */
export async function extractOutline(pdf) {
  let raw;
  try {
    raw = await pdf.getOutline();
  } catch (_) {
    return NO_OUTLINE;
  }
  if (!Array.isArray(raw) || raw.length === 0) return NO_OUTLINE;

  const resolvePage = async (dest) => {
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const index = await pdf.getPageIndex(explicit[0]);
      return index + 1;
    } catch (_) {
      return null;
    }
  };

  const convert = async (nodes, depth) => {
    const out = [];
    for (const node of nodes) {
      const pageNumber = node.dest ? await resolvePage(node.dest) : null;
      out.push({
        title: String(node.title || '').trim(),
        pageNumber,
        depth,
        children: Array.isArray(node.items) && node.items.length
          ? await convert(node.items, depth + 1)
          : [],
      });
    }
    return out;
  };

  return { available: true, items: await convert(raw, 0) };
}

/**
 * 把 pdf.js 的文本片段归成一行一行。
 *
 * 返回行而不是一整块。pdf.js 吐出来的是带位置的碎片，顺序没有任何保证，所以按
 * 基线 y 坐标归行、行内再从左到右排 —— 不这么做的话，「1. 解方程」和它在同一视
 * 觉行上的答案，会和页面别处的文字交错着到达。
 *
 * @param {Array<{text: string, x: number, y: number}>} fragments
 * @returns {{lines: string[], empty: boolean}}
 */
export function textLinesFrom(fragments) {
  const rows = [];
  for (const fragment of fragments || []) {
    const text = typeof fragment?.text === 'string' ? fragment.text : '';
    if (!text) continue;
    const x = Number(fragment.x) || 0;
    const y = Number(fragment.y) || 0;
    const row = rows.find(r => Math.abs(r.y - y) <= LINE_TOLERANCE);
    if (row) row.parts.push({ x, text });
    else rows.push({ y, parts: [{ x, text }] });
  }

  const lines = rows
    .sort((a, b) => b.y - a.y)                  // PDF 的 y 轴向上
    .map(row => row.parts
      .sort((a, b) => a.x - b.x)
      .map(p => p.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);

  return { lines, empty: lines.length === 0 };
}

/**
 * pdf.js 的 textContent item 转成 textLinesFrom 吃的形状。
 *
 * 单独一步，是因为 worker 要把这个结果 postMessage 回主线程，而 pdf.js 的 item
 * 带着 transform 数组和一堆用不上的字段。只留三个数，跨线程搬运的量小一个量级。
 */
export function fragmentsFrom(items) {
  const out = [];
  for (const item of items || []) {
    const text = typeof item?.str === 'string' ? item.str : '';
    if (!text) continue;
    out.push({
      text,
      x: item.transform ? item.transform[4] : 0,
      y: item.transform ? item.transform[5] : 0,
    });
  }
  return out;
}
