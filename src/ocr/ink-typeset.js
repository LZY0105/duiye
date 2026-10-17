// OCR —— 认出来的字和公式写成笔迹：排好 → 画到一块离屏画布上 → 抽成单线的笔画（skeleton.js）→ 一条条普通的钢笔笔迹。
//
// 公式交给 KaTeX 排（katex-ink.js）：结果单子上预览的就是 KaTeX，写出来的也得是它，不然单子上看着对、写出来变了样。
// KaTeX 用不了的地方（没有页面、拿不到它）退回自己的小排版（latex-layout.js）；文字照原样一行，用系统字体画。
//
// 为什么是笔迹而不是「贴一张图」或者「一段文字」：人要的是「转为批注笔迹出现在画布上」——和他自己写的东西一样能擦、
// 能套、能搬、能换色、导出时照样是矢量笔迹。抽中心线的路数对什么字都管用（中文、公式符号都行），不用另带一套字库。
//
// 将来有更好的写法（比如按真字体轮廓）只要 registerInkTypesetter 换掉这一个；调用方不用改。

import { layoutLatex, layoutText } from './latex-layout.js';
import { rasterizeFormula } from './katex-ink.js';
import { maskToPaths } from './skeleton.js';
import { INK_TOOLS, appendPoint, createStroke, recomputeBounds } from '../ink/stroke.js';

/** 排的时候一个 em 画多少像素。太小细化出来的线发抖，太大慢；72 是个中间的数。 */
export const RASTER_PX_PER_EM = 72;
/** 一行最宽画多少像素（再宽就按比例缩小这一行的像素密度）。 */
const MAX_ROW_PX = 4096;
/** 墨的阈值：字边缘的半透明像素，过了这个才算墨。 */
const INK_ALPHA = 110;
/** 截图里多深算「印着字」（亮度 0–255）：黑字、深灰字、彩色标题都算，浅灰的底纹不算。 */
const DARK_LUMA = 160;

const TEXT_FONT = '"HONOR Sans", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const MATH_FONT = '"KaTeX_Main", "Times New Roman", "Noto Serif CJK SC", serif';
const MATH_ITALIC_FONT = '"KaTeX_Math", "KaTeX_Main", "Times New Roman", serif';

let custom = null;

/**
 * 换一个排版器。`fn(items, style)` 返回 Promise<{strokes, width, height, groups?}>，和 typesetToStrokes 一样。传 null 换回默认的。
 */
export function registerInkTypesetter(fn) {
  custom = typeof fn === 'function' ? fn : null;
}

function fontFor(sizePx, italic, math) {
  if (!math) return `500 ${sizePx}px ${TEXT_FONT}`;
  return `${italic ? 'italic ' : ''}500 ${sizePx}px ${italic ? MATH_ITALIC_FONT : MATH_FONT}`;
}

/** 数学字体是网页字体，第一次用之前等它加载（等不到也照样排，退回系统字体）。 */
async function fontsReady() {
  const fonts = typeof document !== 'undefined' ? document.fonts : null;
  if (!fonts?.load) return;
  const wait = Promise.allSettled([
    fonts.load('500 72px "KaTeX_Main"'),
    fonts.load('italic 500 72px "KaTeX_Math"'),
  ]);
  await Promise.race([wait, new Promise((r) => setTimeout(r, 800))]);
}

function makeCanvas() {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(8, 8);
  // 没有 2D 画布的地方（jsdom）：别去要上下文——要了它只会在控制台喊一声「没实现」，结果还是没有。
  if (typeof document === 'undefined' || typeof CanvasRenderingContext2D === 'undefined') return null;
  return document.createElement('canvas');
}

/** 自己的小排版画一条（文字都走这里；公式在 KaTeX 用不了时也走这里）→ 黑白图。 */
function rasterizeLayout(ctx, canvas, item) {
  const math = item.kind === 'math';
  let px = RASTER_PX_PER_EM;
  const measure = (text, size, italic) => {
    ctx.font = fontFor(size * px, italic, math);
    return ctx.measureText(text).width / px;
  };
  let box = math ? layoutLatex(item.latex || item.text, measure) : layoutText(item.text, measure);
  if (!box.ops.length || box.w <= 0) return null;
  const pad = 0.25;
  if ((box.w + pad * 2) * px > MAX_ROW_PX) {
    px = Math.floor(MAX_ROW_PX / (box.w + pad * 2));
    box = math ? layoutLatex(item.latex || item.text, measure) : layoutText(item.text, measure);
  }
  const w = Math.ceil((box.w + pad * 2) * px);
  const h = Math.ceil((box.a + box.d + pad * 2) * px);
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.textBaseline = 'alphabetic';
  const ox = pad * px;
  const oy = (pad + box.a) * px;
  for (const op of box.ops) {
    if (op.type === 'text') {
      ctx.font = fontFor(op.size * px, op.italic, math);
      ctx.fillText(op.text, ox + op.x * px, oy + op.y * px);
    } else if (op.type === 'rule') {
      ctx.fillRect(ox + op.x * px, oy + op.y * px, Math.max(1, op.w * px), Math.max(2, op.h * px));
    } else if (op.type === 'path') {
      ctx.lineWidth = Math.max(2, op.width * px);
      ctx.beginPath();
      op.points.forEach(([x, y], i) => {
        const sx = ox + x * px;
        const sy = oy + y * px;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      });
      if (op.points.length === 1) ctx.lineTo(ox + op.points[0][0] * px + 0.01, oy + op.points[0][1] * px);
      ctx.stroke();
    }
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > INK_ALPHA ? 1 : 0;
  return { mask, width: w, height: h, pxPerEm: px };
}

/**
 * 一张黑白图 → 一条条笔迹。unit：图上一个像素是多少文档单位。坐标挪到墨的左上角：这一条的大小就是墨的大小，不带留白。
 */
function strokesFromMask(raster, unit, color, width) {
  const strokes = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of maskToPaths(raster.mask, raster.width, raster.height)) {
    const stroke = createStroke({ tool: INK_TOOLS.PEN, color, width, opacity: 1 });
    for (const [x, y] of path) {
      appendPoint(stroke, x * unit, y * unit, 0.5, 0);
      minX = Math.min(minX, x * unit); maxX = Math.max(maxX, x * unit);
      minY = Math.min(minY, y * unit); maxY = Math.max(maxY, y * unit);
    }
    if (stroke.points.length) strokes.push(stroke);
  }
  if (!strokes.length) return null;
  for (const stroke of strokes) {
    for (const pt of stroke.points) { pt.x -= minX; pt.y -= minY; }
  }
  return { strokes, width: maxX - minX, height: maxY - minY };
}

/**
 * 认出来的几条排成笔迹，一条一行，从 (0, 0) 往下排。
 *
 * @param {Array<{kind: 'text'|'math', text: string, latex?: string}>} items
 * @param {{em: number, color?: string, width?: number, lineGap?: number}} style
 *   `em` 一个字多高（文档单位）；`width` 笔迹多粗（文档单位，默认按字号）；`lineGap` 行和行之间空多少（em）
 * @returns {Promise<{strokes: Array, width: number, height: number, groups: Array<{strokes, box, em}>}>}
 *   笔迹的坐标从 (0, 0) 起，文档单位；groups 是每一条自己的那几笔和它的墨的外框（调用方按书上的大小一条条缩放、摆放）
 */
export async function typesetToStrokes(items, style) {
  if (custom) return custom(items, style);
  const em = Math.max(1, Number(style?.em) || 16);
  const color = style?.color || '#111827';
  const width = Number.isFinite(style?.width) ? style.width : Math.max(0.5, em * 0.075);
  const lineGap = Number.isFinite(style?.lineGap) ? style.lineGap : 0.45;
  const canvas = makeCanvas();
  const ctx = canvas?.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('TYPESET_NO_CANVAS');
  await fontsReady();

  const strokes = [];
  const groups = [];
  let top = 0;
  let widest = 0;
  for (const item of items || []) {
    const math = item.kind === 'math';
    // 公式先交给 KaTeX（和单子上的预览一个样）；KaTeX 用不了才退回自己的小排版。
    const raster = (math && await rasterizeFormula(item.latex || item.text)) || rasterizeLayout(ctx, canvas, item);
    const piece = raster && strokesFromMask(raster, em / raster.pxPerEm, color, width);
    if (!piece) continue;
    for (const stroke of piece.strokes) {
      for (const pt of stroke.points) pt.y += top;
      recomputeBounds(stroke);
    }
    groups.push({ strokes: piece.strokes, box: { minX: 0, minY: top, maxX: piece.width, maxY: top + piece.height }, em });
    strokes.push(...piece.strokes);
    widest = Math.max(widest, piece.width);
    top += piece.height + lineGap * em;
  }
  // 用完让出内存。
  canvas.width = 1;
  canvas.height = 1;
  return { strokes, width: widest, height: Math.max(0, top - lineGap * em), groups };
}

/**
 * 书上那一条印出来有多大、在哪儿：在截给识别的那张图里，找出（这一条的框里）深色像素的外框，换成文档坐标。
 * 圈外本来涂白了，所以没有框时，整张图的外框就是圈里印着的那些字。读不了像素（测试里的假图）就是 null。
 *
 * @param {?{image, scale: number, box: {minX: number, minY: number}}} capture 截给识别的那张图
 * @param {?{x, y, width, height}} box 这一条在图上的位置（像素），没有就看整张图
 * @returns {?{x: number, y: number, width: number, height: number}} 文档坐标
 */
export function printedExtent(capture, box = null) {
  const image = capture?.image;
  const scale = capture?.scale;
  if (!image || typeof image.getContext !== 'function' || !(scale > 0) || !capture.box) return null;
  const W = Math.floor(image.width) || 0;
  const H = Math.floor(image.height) || 0;
  const clamp = (v, hi) => Math.min(hi, Math.max(0, Math.round(v)));
  const x0 = clamp(box ? box.x : 0, W);
  const y0 = clamp(box ? box.y : 0, H);
  const x1 = clamp(box ? box.x + box.width : W, W);
  const y1 = clamp(box ? box.y + box.height : H, H);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  let data;
  try {
    data = image.getContext('2d')?.getImageData(x0, y0, x1 - x0, y1 - y0)?.data;
  } catch (_) {
    return null;
  }
  if (!data) return null;
  const w = x1 - x0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0, n = Math.floor(data.length / 4); i < n; i++) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    if (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] >= DARK_LUMA) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  return {
    x: capture.box.minX + (x0 + minX) / scale,
    y: capture.box.minY + (y0 + minY) / scale,
    width: (maxX - minX + 1) / scale,
    height: (maxY - minY + 1) / scale,
  };
}
