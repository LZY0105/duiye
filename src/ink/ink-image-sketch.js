// Ink Module —— 一张贴在页上的图片被拖到另一栏时，那一栏先画的「简笔画」：照片的色调（几块淡淡的颜色）加轮廓（几道线）。
//
// 人说「照片跨页拖动时，另一页的显示位置关系逻辑和笔迹一致，但是显示是先根据照片的色调和轮廓先生成一张抽象的简笔画，
// 用户放手才完整加载」。所以拖着的那一会儿，对面那一栏照笔迹那一套换算摆位置（showDragGhost），画的却是这一张：
//   - 色调：照片缩到 TONE_SIDE 见方，归成 TONE_COLORS 种颜色、去掉零星的杂点、往白里调淡；铺开来是几块柔和的颜色；
//   - 轮廓：照片缩到 EDGE_SIDE 见方找边（先糊一下去掉噪点，Sobel 量陡不陡，只留梯度方向上最陡的那一线，高低两道门槛
//     连起来），细成一像素宽、拆成一条条线、抽稀、磨圆，只留最长的那些，拿照片里最深的那种颜色描。
// 松手那一下（adoptStrokes）才把真的照片放进那一页，简笔画在上面淡掉（ink-surface.js 的 _reveal）。
//
// 量像素、归颜色、找线那一段（sketchFromPixels）是纯数组运算，不碰画布，能在 Node 里单独测；sketchFor 拿解好的图在一块
// 小画布上读出像素再交给它。每张图算一次、记着：拖的时候一秒画一百多帧，只有头一帧算。

import { thin, tracePaths, simplifyPath } from '../ocr/skeleton.js';
import { imageFor } from './ink-image.js';

/** 找轮廓用的那一份，长边多少像素。 */
const EDGE_SIDE = 160;
/** 色调那一份，长边多少像素：铺开来是几块柔和的颜色，不是一张糊了的照片。 */
const TONE_SIDE = 28;
/** 色调归成几种颜色。 */
const TONE_COLORS = 5;
/** 色调那一小张放大几倍再交出去（放大时把每一块的边磨圆，见 tonesOf）。 */
const TONE_UP = 4;
/** 色调往白里调多少（0..1）：淡一点，轮廓线才压得住。 */
const TONE_LIGHTEN = 0.42;
/** 最陡的这么多像素（占整张的比例）才可能是轮廓：图平的、图花的，留下来的线差不多一样多。 */
const EDGE_KEEP = 0.07;
/** 再平的图也不把噪点当轮廓：梯度（0..255 的灰度上 Sobel 的幅值除以 4）至少这么大。 */
const EDGE_FLOOR = 10;
/** 比长边的这么多还短的线不要：抽象，不是描图。 */
const PATH_MIN = 0.05;
/** 最多留这么多条（最长的那些）。 */
const PATH_MAX = 48;
/** 轮廓线的颜色最亮到这么亮（0..255 的亮度）：照片里最深的那种颜色还嫌浅，就按比例压暗，色相不变。 */
const INK_MAX_LUMA = 64;
/** 记着几张。 */
const SKETCH_MAX = 8;

const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clampIndex = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);

/** RGBA → 三个通道（透明的地方当白纸：图是垫在纸上的）。 */
function opaque(rgba, n) {
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgba[i * 4 + c] * a + 255 * (1 - a);
  }
  return rgb;
}

/** 糊一下（1 4 6 4 1，横竖各一遍，边上照边上的像素算）：JPEG 的毛边、纸纹不当轮廓。 */
function blur(src, w, h) {
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -2; j <= 2; j++) s += k[j + 2] * src[y * w + clampIndex(x + j, w)];
      tmp[y * w + x] = s / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -2; j <= 2; j++) s += k[j + 2] * tmp[clampIndex(y + j, h) * w + x];
      out[y * w + x] = s / 16;
    }
  }
  return out;
}

/**
 * 轮廓在哪（一张 1/0 的掩码）：Sobel 量陡不陡，顺着梯度方向只留最陡的那一线（不然一道边是好几像素宽的一条带），
 * 最陡的 EDGE_KEEP 那一截以上算「一定是」，一半以上的、连着「一定是」的也算（一道边中间淡了一段不至于断开）。
 */
function edgeMask(gray, w, h) {
  const n = w * h;
  const mag = new Float32Array(n);
  const dir = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = gray[i - w - 1]; const b = gray[i - w]; const c = gray[i - w + 1];
      const d = gray[i - 1]; const f = gray[i + 1];
      const g = gray[i + w - 1]; const hh = gray[i + w]; const k = gray[i + w + 1];
      const gx = (c + 2 * f + k) - (a + 2 * d + g);
      const gy = (g + 2 * hh + k) - (a + 2 * b + c);
      mag[i] = Math.hypot(gx, gy) / 4;
      const deg = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
      dir[i] = deg < 22.5 || deg >= 157.5 ? 0 : deg < 67.5 ? 1 : deg < 112.5 ? 2 : 3;
    }
  }
  // 顺着梯度方向的两个邻居：横、斜下、竖、斜上。
  const STEP = [1, w + 1, w, w - 1];
  const ridge = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (!m) continue;
      const s = STEP[dir[i]];
      // 一边 >=、一边 >：两个一样陡的挨着时只留一个，不会一道边留两像素宽。
      if (m >= mag[i + s] && m > mag[i - s]) ridge[i] = m;
    }
  }
  const sorted = Float32Array.from(mag).sort();
  const high = Math.max(EDGE_FLOOR, sorted[Math.min(n - 1, Math.floor(n * (1 - EDGE_KEEP)))]);
  const low = high * 0.5;
  const mask = new Uint8Array(n);
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (ridge[i] >= high && !mask[i]) { mask[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!mask[j] && ridge[j] >= low) { mask[j] = 1; stack.push(j); }
      }
    }
  }
  return mask;
}

function pathLength(path) {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return len;
}

/** 磨圆（Chaikin 切角一遍）：抽稀以后的折线是一段一段的直棍，切一遍才像手画的线。头尾不动；首尾相接的圈接着切。 */
function chaikin(path) {
  if (path.length < 3) return path;
  const [hx, hy] = path[0];
  const [tx, ty] = path[path.length - 1];
  const closed = Math.abs(hx - tx) < 1e-6 && Math.abs(hy - ty) < 1e-6;
  const out = closed ? [] : [path[0]];
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
  }
  if (closed) out.push(out[0]);
  else out.push(path[path.length - 1]);
  return out;
}

/** 轮廓：一条条线，坐标是占整张图的比例（0..1），最长的在前。 */
function contoursOf(rgb, w, h) {
  const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = lumaOf(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  const traced = tracePaths(thin(edgeMask(blur(gray, w, h), w, h), w, h), w, h);
  const min = Math.max(4, PATH_MIN * Math.max(w, h));
  return traced
    .map((path) => simplifyPath(path, 0.8))
    .filter((path) => path.length >= 2)
    .map((path) => ({ path, len: pathLength(path) }))
    .filter((e) => e.len >= min)
    .sort((a, b) => b.len - a.len)
    .slice(0, PATH_MAX)
    .map((e) => chaikin(e.path).map(([x, y]) => ({ x: x / w, y: y / h })));
}

/**
 * 色调：缩到 TONE_SIDE 见方（每一格是它盖住的那些像素的平均），归成 TONE_COLORS 种颜色（k-means，按亮度分位起头，
 * 每次算出来都一样），一格周围九格里有一种颜色占了一大半就随它（零星的杂点抹掉），放大 TONE_UP 倍把每一块的边磨圆，
 * 再往白里调淡。
 * @returns {{width: number, height: number, data: Uint8ClampedArray, centers: Array<number[]>}}
 */
function tonesOf(rgb, w, h) {
  const k = Math.min(1, TONE_SIDE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * k));
  const th = Math.max(1, Math.round(h * k));
  const m = tw * th;
  const sum = new Float64Array(m * 3);
  const count = new Uint32Array(m);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(th - 1, Math.floor((y * th) / h));
    for (let x = 0; x < w; x++) {
      const t = ty * tw + Math.min(tw - 1, Math.floor((x * tw) / w));
      const i = (y * w + x) * 3;
      sum[t * 3] += rgb[i]; sum[t * 3 + 1] += rgb[i + 1]; sum[t * 3 + 2] += rgb[i + 2];
      count[t]++;
    }
  }
  const px = new Float32Array(m * 3);
  for (let t = 0; t < m; t++) for (let c = 0; c < 3; c++) px[t * 3 + c] = sum[t * 3 + c] / Math.max(1, count[t]);

  // k-means：按亮度排好，每一段的中位数起头。
  const kk = Math.min(TONE_COLORS, m);
  const order = Array.from({ length: m }, (_, t) => t)
    .sort((a, b) => lumaOf(px[a * 3], px[a * 3 + 1], px[a * 3 + 2]) - lumaOf(px[b * 3], px[b * 3 + 1], px[b * 3 + 2]));
  const centers = Array.from({ length: kk }, (_, c) => {
    const t = order[Math.min(m - 1, Math.floor(((c + 0.5) * m) / kk))];
    return [px[t * 3], px[t * 3 + 1], px[t * 3 + 2]];
  });
  const label = new Uint8Array(m);
  for (let round = 0; round < 8; round++) {
    for (let t = 0; t < m; t++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const dr = px[t * 3] - centers[c][0];
        const dg = px[t * 3 + 1] - centers[c][1];
        const db = px[t * 3 + 2] - centers[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      label[t] = best;
    }
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (let t = 0; t < m; t++) {
      const a = acc[label[t]];
      a[0] += px[t * 3]; a[1] += px[t * 3 + 1]; a[2] += px[t * 3 + 2]; a[3]++;
    }
    acc.forEach((a, c) => { if (a[3]) centers[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }

  // 九格里过半的那种颜色。
  const smooth = label.slice();
  const votes = new Uint8Array(kk);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      votes.fill(0);
      let cells = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue;
          votes[label[ny * tw + nx]]++;
          cells++;
        }
      }
      for (let c = 0; c < kk; c++) if (votes[c] * 2 > cells) smooth[y * tw + x] = c;
    }
  }

  // 放大 TONE_UP 倍、每一块的边磨圆：每种颜色占的那几格先糊一下（1 2 1），放大时逐点插值，哪种占得多就是哪种。
  // 直接拿那几十格去放大，一块一块是台阶状的方格（糊开了也看得出格子）；这样放出来是一片一片平涂、边是圆的。
  const member = centers.map((_, c) => {
    const raw = new Float32Array(m);
    for (let t = 0; t < m; t++) raw[t] = smooth[t] === c ? 1 : 0;
    const out = new Float32Array(m);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        let s = 0;
        let wsum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue;
            const wgt = (dx ? 1 : 2) * (dy ? 1 : 2);
            s += raw[ny * tw + nx] * wgt;
            wsum += wgt;
          }
        }
        out[y * tw + x] = s / wsum;
      }
    }
    return out;
  });
  const paint = centers.map((center) => center.map((v) => Math.round(v + (255 - v) * TONE_LIGHTEN)));
  const ow = tw * TONE_UP;
  const oh = th * TONE_UP;
  const data = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const fy = Math.min(th - 1, Math.max(0, (y + 0.5) / TONE_UP - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(th - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < ow; x++) {
      const fx = Math.min(tw - 1, Math.max(0, (x + 0.5) / TONE_UP - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(tw - 1, x0 + 1);
      const tx = fx - x0;
      let best = 0;
      let bestV = -1;
      for (let c = 0; c < kk; c++) {
        const g = member[c];
        const v = (g[y0 * tw + x0] * (1 - tx) + g[y0 * tw + x1] * tx) * (1 - ty)
          + (g[y1 * tw + x0] * (1 - tx) + g[y1 * tw + x1] * tx) * ty;
        if (v > bestV) { bestV = v; best = c; }
      }
      const o = (y * ow + x) * 4;
      data[o] = paint[best][0];
      data[o + 1] = paint[best][1];
      data[o + 2] = paint[best][2];
      data[o + 3] = 255;
    }
  }
  return { width: ow, height: oh, data, centers };
}

/** 轮廓线的颜色：照片里最深的那种颜色；还嫌浅就按比例压暗（色相不变）。 */
function inkOf(centers) {
  let darkest = [0, 0, 0];
  let lowest = Infinity;
  for (const c of centers) {
    const l = lumaOf(c[0], c[1], c[2]);
    if (l < lowest) { lowest = l; darkest = c; }
  }
  const k = lowest > INK_MAX_LUMA ? INK_MAX_LUMA / lowest : 1;
  const [r, g, b] = darkest.map((v) => Math.round(v * k));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * 一张图的像素 → 它的简笔画。纯数组运算。
 *
 * @param {Uint8ClampedArray|Uint8Array|number[]} rgba 一行一行、每像素四个数
 * @param {number} width
 * @param {number} height
 * @returns {{tones: {width: number, height: number, data: Uint8ClampedArray},
 *   paths: Array<Array<{x: number, y: number}>>, ink: string}|null}
 *   tones 是色调那一小张（不透明）；paths 是轮廓线，坐标是占整张图的比例；ink 是描线的颜色
 */
export function sketchFromPixels(rgba, width, height) {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!(w > 0) || !(h > 0) || !rgba || rgba.length < w * h * 4) return null;
  const rgb = opaque(rgba, w * h);
  const tones = tonesOf(rgb, w, h);
  const paths = w >= 3 && h >= 3 ? contoursOf(rgb, w, h) : [];
  return {
    tones: { width: tones.width, height: tones.height, data: tones.data },
    paths,
    ink: inkOf(tones.centers),
  };
}

// ── 每张图算一次 ─────────────────────────────────────────────────────────────

/** id → 简笔画（算不出来记 null，不再算）。插入顺序就是最近用过的顺序。 */
const sketches = new Map();

function makeCanvas(width, height) {
  if (typeof document !== 'undefined' && typeof document.defaultView?.CanvasRenderingContext2D === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  return null;
}

function build(image) {
  const w0 = image.width || image.naturalWidth || 0;
  const h0 = image.height || image.naturalHeight || 0;
  if (!w0 || !h0) return null;
  const k = Math.min(1, EDGE_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  const canvas = makeCanvas(w, h);
  const ctx = canvas?.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, w, h);
  const sketch = sketchFromPixels(ctx.getImageData(0, 0, w, h).data, w, h);
  canvas.width = 0;
  canvas.height = 0;
  if (!sketch) return null;
  const tones = makeCanvas(sketch.tones.width, sketch.tones.height);
  const tctx = tones?.getContext('2d');
  if (!tctx) return null;
  const data = tctx.createImageData(sketch.tones.width, sketch.tones.height);
  data.data.set(sketch.tones.data);
  tctx.putImageData(data, 0, 0);
  return { tones, paths: sketch.paths, ink: sketch.ink };
}

/**
 * 画的时候问：这张图的简笔画。图解好了就当场算（头一回）、记着；还没解好回 null（调用方先画一块淡灰占位，解好了
 * 画布会重画，那时再来问）。
 * @returns {{tones: object, paths: Array<Array<{x: number, y: number}>>, ink: string}|null}
 */
export function sketchFor(id) {
  if (!id) return null;
  if (sketches.has(id)) {
    const known = sketches.get(id);
    sketches.delete(id);
    sketches.set(id, known);
    return known;
  }
  const image = imageFor(id);
  if (!image) return null;
  let sketch = null;
  try { sketch = build(image); } catch (_) { sketch = null; }
  rememberSketch(id, sketch);
  return sketch;
}

/**
 * 趁空先把这几张的简笔画算好：按住选区开始搬的时候叫它。拖到对面那一栏的头一帧就不用当场算（平板上一张二三十
 * 毫秒，正好在拖的半路卡一下）。
 */
export function warmSketches(ids) {
  const todo = (ids || []).filter((id) => id && !sketches.has(id));
  if (!todo.length) return;
  const later = typeof globalThis.requestIdleCallback === 'function'
    ? (fn) => globalThis.requestIdleCallback(fn, { timeout: 400 })
    : (fn) => setTimeout(fn, 50);
  later(() => { for (const id of todo) sketchFor(id); });
}

/** 记一张（测试拿它放一张现成的进来；没有画布的地方 sketchFor 算不出来）。 */
export function rememberSketch(id, sketch) {
  if (!id) return;
  sketches.delete(id);
  sketches.set(id, sketch);
  for (const key of sketches.keys()) {
    if (sketches.size <= SKETCH_MAX) break;
    sketches.delete(key);
  }
}

/**
 * 把一张简笔画画进那个平行四边形（tl、tr、bl 是图的左上、右上、左下角在屏幕上的位置）：先铺色调（放大时让它糊开，
 * 一块一块的颜色才是柔和的），再描轮廓——线在屏幕上算，多粗不跟着图被拉扁拉长，看着是一支笔画的。外面再描一圈淡淡
 * 的边：色调很淡的图铺在白纸上，不描一圈看不出它有多大。
 */
export function paintSketch(ctx, sketch, tl, tr, bl, alpha = 1) {
  const ux = tr.x - tl.x;
  const uy = tr.y - tl.y;
  const vx = bl.x - tl.x;
  const vy = bl.y - tl.y;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.transform(ux, uy, vx, vy, tl.x, tl.y);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(sketch.tones, 0, 0, 1, 1);
  ctx.restore();
  const side = Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy));
  ctx.strokeStyle = sketch.ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.min(2.4, Math.max(1.1, side / 260));
  ctx.beginPath();
  for (const path of sketch.paths) {
    path.forEach((pt, i) => {
      const x = tl.x + ux * pt.x + vx * pt.y;
      const y = tl.y + uy * pt.x + vy * pt.y;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
  }
  ctx.stroke();
  ctx.globalAlpha = alpha * 0.45;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(tr.x + vx, tr.y + vy);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}
