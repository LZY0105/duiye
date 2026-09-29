// 导出 —— 把批注过的东西做成一份 PDF。
//
// 三样东西能导出：导入的书（PDF）、笔记本、草稿纸。这个文件只管「做」：拿到原文件
// 的字节、每一页的笔迹、纸的样子，交回一份 PDF 的字节。去哪儿拿这些东西在
// export-document.js，做好之后存到哪儿、存之前要不要先问权限在 export-permission.js
// 和 pdf-files.js。这里不碰 DOM，所以「导出来的东西对不对」在 Node 里就能测清楚。
//
// **书是加画，不是重画。** 原文件读进来，一个对象都不丢：文字还能选、能搜，目录、链
// 接、插图都在。有笔迹的那几页，在页面原有的内容后面再接一段——就是屏幕上那一层笔
// 迹，照着 ink-renderer.js 的画法一笔一笔翻成 PDF 的路径。没写过字的页原样不动。
//
// 笔迹存的是矢量，导出来的也是矢量：放大到多少倍都和原页一样清楚，一整本书的批注
// 加起来也就多出几十 K。
//
// 唯一的例外是加密的 PDF。pdf-lib 解不了密，硬往里写的话，新接上的那一段会被阅读
// 器当成密文去解，出来一片乱码。那种书走 buildRasterPdf：每一页画成图、叠上笔迹、
// 拼成一份新的 PDF。样子一样，只是字不能再选了。

import { INK_TOOLS, TOOL_DEFAULTS } from '../ink/stroke.js';
import { widthAt } from '../ink/ink-renderer.js';

/** 做不出来时的原因。调用方按这个决定是换一条路，还是告诉人。 */
export const EXPORT_ERRORS = Object.freeze({
  /** 原文件加了密：换 buildRasterPdf。 */
  ENCRYPTED: 'EXPORT_ENCRYPTED',
  /** pdf-lib 读不懂这份文件（pdf.js 读得懂的它不一定读得懂）：也换 buildRasterPdf。 */
  UNREADABLE: 'EXPORT_UNREADABLE',
  /** 草稿纸上一笔都没有：没有「范围」可言，也就没有一页可做。 */
  EMPTY: 'EXPORT_EMPTY',
  NOT_FOUND: 'EXPORT_NOT_FOUND',
});

let pdfLib = null;
/**
 * pdf-lib 按需才加载。
 *
 * 它压缩之后也有几百 K，而导出是一件一天做不了几次的事——没理由让每一次开机都先
 * 把它读一遍。Vite 会把它单独切成一块，第一次点「导出」时才去拿。
 */
function lib() {
  if (!pdfLib) pdfLib = import('pdf-lib');
  return pdfLib;
}

// ── 颜色 ────────────────────────────────────────────────────────────────────

/**
 * CSS 颜色 → 0..1 的 r g b a。
 *
 * 色板和自选色都是 #rrggbb，形状的填充可能带透明度（#rrggbbaa 或 rgba()）。认不出
 * 来的一律当黑色、不透明：一笔画出来是黑的，总好过这一笔没了。
 */
export function parseColor(css) {
  const s = String(css || '').trim().toLowerCase();
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      const at = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
      return { r: at(0), g: at(2), b: at(4), a: h.length === 8 ? at(6) : 1 };
    }
  }
  const fn = s.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    const channel = (v) => (v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v)) / 255;
    const alpha = (v) => (v === undefined ? 1 : v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v));
    const [r, g, b] = parts.slice(0, 3).map(channel);
    const a = alpha(parts[3]);
    if ([r, g, b, a].every(Number.isFinite)) {
      return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a) };
    }
  }
  if (s === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return { r: 0, g: 0, b: 0, a: 1 };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ── 坐标 ────────────────────────────────────────────────────────────────────

/**
 * 页面坐标 → 屏幕上那一页的坐标，和 pdf.js 1 倍视口给的一模一样。
 *
 * 书页上的笔迹记在 pdf.js `getViewport({ scale: 1 })` 的坐标里：左上角是原点，y 朝
 * 下，页面的 /Rotate 已经转过了，裁切框的偏移也扣掉了。导出时要把它放回 PDF 自己的
 * 坐标系（左下角原点、y 朝上、不转），就得用和 pdf.js **同一个**变换的逆。这里照抄
 * pdf.js 4.2 的 PageViewport（scale 1、不偏移、不翻转），不是自己另推一套——差一点，
 * 批注就会整片挪位，而且只在转过、裁过的那些页上挪，最难发现。
 *
 * @param {number[]} view [x0, y0, x1, y1]，pdf.js 的 page.view
 * @param {number} rotate 0/90/180/270
 * @returns {number[]} [a, b, c, d, e, f]
 */
export function viewportTransform(view, rotate = 0) {
  const [x0, y0, x1, y1] = view;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let r = rotate % 360;
  if (r < 0) r += 360;
  let a; let b; let c; let d;
  switch (r) {
    case 180: a = -1; b = 0; c = 0; d = 1; break;
    case 90: a = 0; b = 1; c = 1; d = 0; break;
    case 270: a = 0; b = -1; c = -1; d = 0; break;
    default: a = 1; b = 0; c = 0; d = -1; break;
  }
  const ox = a === 0 ? Math.abs(cy - y0) : Math.abs(cx - x0);
  const oy = a === 0 ? Math.abs(cx - x0) : Math.abs(cy - y0);
  return [a, b, c, d, ox - a * cx - c * cy, oy - b * cx - d * cy];
}

/** 仿射变换的逆，和 pdf.js 的 Util.inverseTransform 同一个公式。 */
export function invertTransform([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** pdf.js 的 Util.normalizeRect：两个角谁在左下都行。 */
function normalizeRect([x0, y0, x1, y1]) {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/**
 * 一页的 view 和 rotate，按 pdf.js 的规矩从 pdf-lib 的页面上读出来。
 *
 * 规矩：MediaBox 缺了或者是空的就当 Letter；CropBox 缺了就是 MediaBox；两者不同时
 * 取交集，交集是空的就退回 MediaBox。/Rotate 不是 90 的倍数就当 0。每一条都和
 * pdf.js core/document.js 里对应的那几行对过——屏幕上的页就是按它们量出来的。
 */
export function pageViewOf(page) {
  const context = page.node.context;
  const numbers = (array) => {
    if (!array || typeof array.size !== 'function' || array.size() !== 4) return null;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const v = context.lookup(array.get(i));
      const n = typeof v?.asNumber === 'function' ? v.asNumber() : NaN;
      if (!Number.isFinite(n)) return null;
      out.push(n);
    }
    return out;
  };
  const valid = (box) => (box && box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : null);

  let media = numbers(page.node.MediaBox?.());
  media = valid(media && normalizeRect(media)) || [0, 0, 612, 792];
  let crop = numbers(page.node.CropBox?.());
  crop = valid(crop && normalizeRect(crop)) || media;

  let view = media;
  if (crop !== media && crop.some((v, i) => v !== media[i])) {
    const box = [
      Math.max(crop[0], media[0]), Math.max(crop[1], media[1]),
      Math.min(crop[2], media[2]), Math.min(crop[3], media[3]),
    ];
    if (box[2] - box[0] > 0 && box[3] - box[1] > 0) view = box;
  }

  let rotate = page.node.Rotate?.()?.asNumber?.() || 0;
  if (rotate % 90 !== 0) rotate = 0;
  else if (rotate >= 360) rotate %= 360;
  else if (rotate < 0) rotate = ((rotate % 360) + 360) % 360;
  return { view, rotate };
}

// ── 笔迹 → 路径算子 ─────────────────────────────────────────────────────────

/** 坐标保留到 0.01 点：打印机的一个点是 1/600 英寸，这已经细过它十倍。 */
const num = (v) => {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
};
/** 变换矩阵多留两位：它乘的是整页的坐标，一点误差会被放大到页边上。 */
const mat = (v) => {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1e4) / 1e4;
  return String(Object.is(r, -0) ? 0 : r);
};

/** 单位圆的四段贝塞尔逼近用的那个常数。 */
const KAPPA = 0.5522847498;

/**
 * 一个整圆，四段三次贝塞尔。
 *
 * 绕的方向和 canvas 的 arc(…, 0, 2π) 一样（角度增大的方向）。这不是细节：笔画是按
 * 非零环绕规则整体填一次的，圆和两段之间那些四边形必须绕同一个方向，反了的话重叠
 * 处的环绕数互相抵消，接头上就是一个洞——ink-renderer.js 的 traceStroke 为这件事写
 * 了一整段注释。
 */
function circle(out, x, y, r) {
  const k = KAPPA * r;
  out.push(
    `${num(x + r)} ${num(y)} m`,
    `${num(x + r)} ${num(y + k)} ${num(x + k)} ${num(y + r)} ${num(x)} ${num(y + r)} c`,
    `${num(x - k)} ${num(y + r)} ${num(x - r)} ${num(y + k)} ${num(x - r)} ${num(y)} c`,
    `${num(x - r)} ${num(y - k)} ${num(x - k)} ${num(y - r)} ${num(x)} ${num(y - r)} c`,
    `${num(x + k)} ${num(y - r)} ${num(x + r)} ${num(y - k)} ${num(x + r)} ${num(y)} c`,
    'h',
  );
}

/**
 * 一道变粗细的笔画：每一段一个四边形、每个采样点一个圆，合成一条路径填一次。
 *
 * 和 ink-renderer.js 的 traceStroke 一模一样的构造，理由也一样：全是凸的小块拼起来，
 * 不会在急转弯处鼓出一个包；一次填完，半透明的笔迹在自己重叠的地方也不会变深。
 */
function tracePieces(out, pts) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    out.push(
      `${num(a.x + nx * a.r)} ${num(a.y + ny * a.r)} m`,
      `${num(a.x - nx * a.r)} ${num(a.y - ny * a.r)} l`,
      `${num(b.x - nx * b.r)} ${num(b.y - ny * b.r)} l`,
      `${num(b.x + nx * b.r)} ${num(b.y + ny * b.r)} l`,
      'h',
    );
  }
  for (const p of pts) circle(out, p.x, p.y, p.r);
}

/**
 * 等宽的笔（荧光笔）：过采样点中点的二次曲线，描一次边。
 *
 * PDF 只有三次曲线，二次的按精确公式升一阶：两个控制点各在「端点到二次控制点」的三
 * 分之二处。和屏幕上那条是同一条曲线，不是近似。
 */
function smoothLine(out, pts) {
  out.push(`${num(pts[0].x)} ${num(pts[0].y)} m`);
  if (pts.length === 2) {
    out.push(`${num(pts[1].x)} ${num(pts[1].y)} l`);
    return;
  }
  let cur = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const q = pts[i];
    const end = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    const c1 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) };
    const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
    out.push(`${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(end.x)} ${num(end.y)} c`);
    cur = end;
  }
  const last = pts[pts.length - 1];
  out.push(`${num(last.x)} ${num(last.y)} l`);
}

/**
 * 铅笔的纸纹，平均下来盖掉多少。
 *
 * 屏幕上的铅笔是先画实心、再拿一张噪点图「抠」掉一部分（ink-renderer.js 的
 * drawPencil）。那张图每个点抠掉 0.85·n^2.1（n 均匀分布），平均是 0.85/3.1 ≈ 0.27。
 * PDF 里不画颗粒——颗粒要么是一大张图、要么是几十万个小方块——但颜色的深浅要对：
 * 实心的铅笔比屏幕上黑一截，一眼就看得出不是同一支笔。所以透明度乘上剩下的那 0.73。
 */
const GRAIN_COVER = 0.73;

/** 采样点：去掉落在同一处的，最后一个一定留着（那是这一笔停下的地方）。 */
function samplesOf(stroke) {
  const out = [];
  const pts = stroke.points;
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    if (!Number.isFinite(pt?.x) || !Number.isFinite(pt?.y)) continue;
    const r = Math.max(0.2, widthAt(stroke, Number.isFinite(pt.p) ? pt.p : 0.5) / 2);
    const last = out[out.length - 1];
    if (last && i < pts.length - 1
      && Math.abs(pt.x - last.x) < 0.1 && Math.abs(pt.y - last.y) < 0.1) continue;
    out.push({ x: pt.x, y: pt.y, r });
  }
  return out;
}

/**
 * 一组笔迹 → 一段内容流，外加它要用到的那几种「透明度 / 混合」状态。
 *
 * 状态在这里只留一个占位符（`/@GS0`）：它真正叫什么，要等把它挂到页面的资源上才知
 * 道——那个名字不能和原书里已有的撞上，得由 pdf-lib 去挑。
 *
 * @param {Array} strokes ink-layer 里的笔迹，笔迹自己的坐标
 * @param {number[]} matrix 笔迹坐标 → PDF 坐标
 * @returns {{content: string, states: Map<string, {alpha: number, blend: string|null}>}}
 */
export function inkOps(strokes, matrix) {
  const out = [];
  const states = new Map();
  const keyOf = new Map();
  /** 这一笔要的透明度和混合模式；完全不透明、正常混合就不用设。 */
  const gs = (alpha, blend) => {
    const a = Math.round(clamp01(alpha) * 1000) / 1000;
    if (a >= 1 && !blend) return;
    const key = `${a}|${blend || ''}`;
    if (!keyOf.has(key)) {
      const token = `/@GS${keyOf.size}`;
      keyOf.set(key, token);
      states.set(token, { alpha: a, blend: blend || null });
    }
    out.push(`${keyOf.get(key)} gs`);
  };
  const rgb = (c, op) => `${mat(c.r)} ${mat(c.g)} ${mat(c.b)} ${op}`;

  out.push('q', `${matrix.map(mat).join(' ')} cm`);
  let painted = 0;
  for (const stroke of strokes || []) {
    const pts = Array.isArray(stroke?.points) ? stroke.points : [];
    if (!pts.length) continue;
    const defaults = TOOL_DEFAULTS[stroke.tool] || TOOL_DEFAULTS[INK_TOOLS.PEN];
    const color = parseColor(stroke.color);
    const opacity = Number.isFinite(stroke.opacity) ? clamp01(stroke.opacity) : defaults.opacity;
    const blend = defaults.composite === 'multiply' ? 'Multiply' : null;
    out.push('q');

    // 填充画在描边底下，和屏幕上一样（见 drawStroke）。
    if (stroke.fill && pts.length > 2) {
      const fill = parseColor(stroke.fill);
      out.push('q');
      gs(opacity * fill.a, blend);
      out.push(rgb(fill, 'rg'));
      out.push(`${num(pts[0].x)} ${num(pts[0].y)} m`);
      for (let i = 1; i < pts.length; i++) out.push(`${num(pts[i].x)} ${num(pts[i].y)} l`);
      out.push('h', 'f', 'Q');
    }

    if (pts.length === 1) {
      // 点一下是一个点，不是一条长度为零的线。
      gs(opacity * color.a, blend);
      out.push(rgb(color, 'rg'));
      const p = pts[0];
      circle(out, p.x, p.y, Math.max(0.2, widthAt(stroke, Number.isFinite(p.p) ? p.p : 0.5) / 2));
      out.push('f');
    } else if (!defaults.pressureRange) {
      // 等宽：一条线，一次描边。荧光笔走这里——正片叠底，而且整条只画一次，所以
      // 它压过自己的地方不会更深，压过字的地方字还是清楚的。
      gs(opacity * color.a, blend);
      out.push(rgb(color, 'RG'), `${num(Math.max(0.2, stroke.width))} w`, '1 J', '1 j');
      smoothLine(out, pts.map((p) => ({ x: p.x, y: p.y })).filter((p) => Number.isFinite(p.x + p.y)));
      out.push('S');
    } else {
      const samples = samplesOf(stroke);
      if (!samples.length) { out.push('Q'); continue; }
      out.push(rgb(color, 'rg'));
      if (defaults.grain) {
        // 铅笔：外圈宽而淡，内芯标称宽度——和 drawPencil 的两遍一样，只是不打孔。
        out.push('q');
        gs(opacity * color.a * 0.30 * GRAIN_COVER, blend);
        tracePieces(out, samples.map((p) => ({ ...p, r: p.r * 1.45 })));
        out.push('f', 'Q');
        gs(opacity * color.a * 0.95 * GRAIN_COVER, blend);
        tracePieces(out, samples);
        out.push('f');
      } else {
        gs(opacity * color.a, blend);
        tracePieces(out, samples);
        out.push('f');
      }
    }
    out.push('Q');
    painted++;
  }
  out.push('Q');
  return { content: painted ? out.join('\n') : '', states };
}

/**
 * 把一组笔迹接到一页的内容后面。
 *
 * pdf-lib 的 addContentStream 会先把原来的内容整个包进 `q … Q`，所以原书里没配对的
 * 坐标变换、裁剪不会漏到这一段来——笔迹不会因为原书某页最后留了一个 cm 而整片挪走。
 *
 * @returns {boolean} 真的画了东西
 */
function stampInk(doc, page, strokes, matrix) {
  const { content, states } = inkOps(strokes, matrix);
  if (!content) return false;
  let text = content;
  for (const [token, spec] of states) {
    const dict = doc.context.obj({
      Type: 'ExtGState',
      ca: spec.alpha,
      CA: spec.alpha,
      ...(spec.blend ? { BM: spec.blend } : {}),
    });
    const name = page.node.newExtGState('DyInk', dict);
    text = text.split(`${token} gs`).join(`${name.toString()} gs`);
  }
  page.node.addContentStream(doc.context.register(doc.context.flateStream(text)));
  return true;
}

/** 纸：有纹样就铺那张图，没有就只刷纸色；白纸什么都不画。 */
async function preparePaper(doc, paper) {
  const image = paper?.png ? await doc.embedPng(paper.png) : null;
  const color = paper?.color || null;
  const white = !color || (color.r > 0.995 && color.g > 0.995 && color.b > 0.995);
  return { image, color: white ? null : color };
}

function paintPaper(page, size, paper, rgb) {
  if (paper.image) {
    page.drawImage(paper.image, { x: 0, y: 0, width: size.width, height: size.height });
  } else if (paper.color) {
    page.drawRectangle({
      x: 0, y: 0, width: size.width, height: size.height,
      color: rgb(paper.color.r, paper.color.g, paper.color.b), borderWidth: 0,
    });
  }
}

/** 写进文件信息里的「谁做的」。原书自己的标题、作者一个字都不改。 */
const PRODUCER = '对页 Duìyè';

/**
 * 一本书：原文件加上笔迹。
 *
 * @param {{bytes: Uint8Array|ArrayBuffer,
 *          pages: Array<{pageNumber: number, strokes: Array}>,
 *          onProgress?: function(number, number)}} input
 * @returns {Promise<Uint8Array>}
 */
export async function buildBookPdf({ bytes, pages, onProgress }) {
  const { PDFDocument } = await lib();
  let doc;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch (error) {
    throw new Error(EXPORT_ERRORS.UNREADABLE, { cause: error });
  }
  if (doc.isEncrypted) throw new Error(EXPORT_ERRORS.ENCRYPTED);

  const all = doc.getPages();
  const todo = (pages || []).filter((p) => p?.strokes?.length && all[p.pageNumber - 1]);
  let done = 0;
  for (const { pageNumber, strokes } of todo) {
    const page = all[pageNumber - 1];
    const { view, rotate } = pageViewOf(page);
    stampInk(doc, page, strokes, invertTransform(viewportTransform(view, rotate)));
    onProgress?.(++done, todo.length);
  }
  try {
    // 对象流不开：开了要把整本书的对象重新压一遍，一本几百兆的书在平板上要多等好
    // 一会儿；不开，原来那些大块的图原样拷过去。
    return await doc.save({ useObjectStreams: false, objectsPerTick: 64 });
  } catch (error) {
    throw new Error(EXPORT_ERRORS.UNREADABLE, { cause: error });
  }
}

/**
 * 一本笔记本：每一页铺纸、画笔迹。
 *
 * 一页都不跳过，包括还没写的：导出来的是「这本本子」，页数和页码都该和屏幕上一样，
 * 不然第 7 页上写的「见第 5 页」就指不到地方了。
 *
 * @param {{pageCount: number, size: {width: number, height: number},
 *          paper?: {color?: object, png?: Uint8Array},
 *          strokesFor: function(number): Promise<Array>,
 *          onProgress?: function(number, number)}} input
 */
export async function buildNotebookPdf({ pageCount, size, paper, strokesFor, onProgress }) {
  const { PDFDocument, rgb } = await lib();
  const doc = await PDFDocument.create();
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  const ready = await preparePaper(doc, paper);
  const count = Math.max(1, Math.floor(Number(pageCount) || 1));
  // 本子页的坐标就是 pdf.js 给一页没转过、没裁过的纸的坐标：左上角原点、y 朝下。
  const matrix = invertTransform(viewportTransform([0, 0, size.width, size.height], 0));
  for (let n = 1; n <= count; n++) {
    const page = doc.addPage([size.width, size.height]);
    paintPaper(page, size, ready, rgb);
    const strokes = await strokesFor(n);
    if (strokes?.length) stampInk(doc, page, strokes, matrix);
    onProgress?.(n, count);
  }
  return doc.save();
}

/**
 * 一张草稿纸该做成多大的一页：所有笔迹的范围，四周留一点白。
 *
 * PDF 一页的边不能超过 14400 点（200 英寸）——大多数阅读器过了这个数就不肯开。画得
 * 更开的草稿纸整体缩小放进去，而不是切掉一块。
 *
 * @returns {{x0: number, y0: number, x1: number, y1: number,
 *            width: number, height: number, scale: number}|null} 没有笔迹是 null
 */
export function scratchPageBox(strokes, { margin = 24, maxSide = 14400 } = {}) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const stroke of strokes || []) {
    const pts = Array.isArray(stroke?.points) ? stroke.points : [];
    const pad = Math.max(1, (stroke.width || 2) * (TOOL_DEFAULTS[stroke.tool]?.grain ? 1.5 : 1));
    for (const p of pts) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
      minX = Math.min(minX, p.x - pad); minY = Math.min(minY, p.y - pad);
      maxX = Math.max(maxX, p.x + pad); maxY = Math.max(maxY, p.y + pad);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const x0 = minX - margin; const y0 = minY - margin;
  const x1 = maxX + margin; const y1 = maxY + margin;
  const w = x1 - x0; const h = y1 - y0;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { x0, y0, x1, y1, width: w * scale, height: h * scale, scale };
}

/**
 * 一张草稿纸：一页，大小按笔迹来（见 scratchPageBox）。
 *
 * @param {{strokes: Array, box: object, paper?: object}} input
 */
export async function buildScratchPdf({ strokes, box, paper }) {
  if (!box) throw new Error(EXPORT_ERRORS.EMPTY);
  const { PDFDocument, rgb } = await lib();
  const doc = await PDFDocument.create();
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  const ready = await preparePaper(doc, paper);
  const size = { width: box.width, height: box.height };
  const page = doc.addPage([size.width, size.height]);
  paintPaper(page, size, ready, rgb);
  const k = box.scale;
  stampInk(doc, page, strokes, [k, 0, 0, -k, -k * box.x0, k * box.y1]);
  return doc.save();
}

/**
 * 退路：每一页画成一张图，拼成一份新的 PDF。
 *
 * 加密的书、pdf-lib 读不懂的书都走这里。画图和叠笔迹要用到画布，所以那一步由调用方
 * 给（export-document.js 的 rasterBookPage）；这里只管把图一页一页装进去。
 *
 * @param {{pageCount: number,
 *          rasterPage: function(number): Promise<{width: number, height: number, jpeg: Uint8Array}>,
 *          onProgress?: function(number, number)}} input
 */
export async function buildRasterPdf({ pageCount, rasterPage, onProgress }) {
  const { PDFDocument } = await lib();
  const doc = await PDFDocument.create();
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  for (let n = 1; n <= pageCount; n++) {
    const { width, height, jpeg } = await rasterPage(n);
    const page = doc.addPage([width, height]);
    const image = await doc.embedJpg(jpeg);
    page.drawImage(image, { x: 0, y: 0, width, height });
    onProgress?.(n, pageCount);
  }
  return doc.save();
}

/**
 * 导出文件叫什么。
 *
 * 文件系统不认的字符换成空格，开头的点去掉（那会变成隐藏文件，连本应用自己的「本机
 * PDF」单子都会把它滤掉），太长的截短。书的名字后面加一个后缀（「（批注）」），免得
 * 和原来那份 PDF 同名、被人当成一份。
 */
export function exportFileName(name, suffix = '') {
  const clean = String(name || '')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return `${clean || 'Duiye'}${suffix}.pdf`;
}
