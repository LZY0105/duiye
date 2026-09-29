// Ink Module — vector renderer.
//
// Draws an InkLayer onto a 2D context under a document→screen transform. The
// strokes themselves are never resampled: at 600% zoom this rasterises the same
// geometry at 600%, so the ink is as crisp as the page behind it. That is the
// whole point of storing vectors rather than an ImageData snapshot.
//
// The renderer only ever draws onto the canvas it is handed — the ink canvas —
// and never receives the PDF canvas, so painting ink cannot disturb the page.

import { INK_TOOLS, TOOL_DEFAULTS } from './stroke.js';

/**
 * @typedef {{scale:number, offsetX:number, offsetY:number}} InkTransform
 * Document→screen mapping: screenX = (docX - offsetX) * scale.
 */

export function createTransform(scale = 1, offsetX = 0, offsetY = 0) {
  return { scale, offsetX, offsetY };
}

export function documentToScreen(transform, x, y) {
  return {
    x: (x - transform.offsetX) * transform.scale,
    y: (y - transform.offsetY) * transform.scale,
  };
}

/** Screen→document, used to place incoming pointer samples. */
export function screenToDocument(transform, x, y) {
  return {
    x: x / transform.scale + transform.offsetX,
    y: y / transform.scale + transform.offsetY,
  };
}

/**
 * Width at a sample, blending the tool's base width with pen pressure.
 *
 * 导出 PDF 时也用它（src/export/pdf-export.js）：导出来的每一笔和屏幕上那一笔必须是
 * 同一个粗细，所以两边问同一个函数，而不是各算各的。
 */
export function widthAt(stroke, pressure) {
  const defaults = TOOL_DEFAULTS[stroke.tool] || TOOL_DEFAULTS[INK_TOOLS.PEN];
  const range = defaults.pressureRange;
  if (!range) return stroke.width;
  // pressure 0.5 is neutral, so a device reporting no pressure draws base width.
  const factor = 1 + (pressure - 0.5) * 2 * range;
  return Math.max(0.2, stroke.width * factor);
}

/**
 * Screen-space centres and half-widths for a stroke, with samples that land on
 * the same pixel dropped.
 *
 * The decimation is pure economy and never changes what is drawn: pointer
 * samples are stored in document space at 0.6-unit spacing, so a page viewed
 * at 25% has four of them per pixel and three of every four contribute nothing
 * but arithmetic.
 */
function screenSamples(stroke, transform, points) {
  const out = [];
  const minGap = 0.55;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const x = (pt.x - transform.offsetX) * transform.scale;
    const y = (pt.y - transform.offsetY) * transform.scale;
    const r = Math.max(0.2, widthAt(stroke, pt.p) * transform.scale / 2);
    const last = out[out.length - 1];
    // The final sample is always kept: it is where the stroke ends, and
    // dropping it would shorten the mark.
    if (last && i < points.length - 1
      && Math.abs(x - last.x) < minGap && Math.abs(y - last.y) < minGap) continue;
    out.push({ x, y, r });
  }
  return out;
}

const norm = (x, y) => {
  const len = Math.hypot(x, y);
  return len < 1e-9 ? null : { x: x / len, y: y / len };
};

/**
 * A variable-width stroke, as the UNION of local pieces in one path.
 *
 * Two earlier attempts at this are worth recording, because each fixed a real
 * defect and introduced the next one.
 *
 * Stroking each segment separately was the original. It varies width — a
 * canvas path carries only one lineWidth — but puts a round cap on both ends
 * of every segment, each antialiased on its own, and the rims stack wherever
 * they overlap. Enlarged ink came apart into a string of beads.
 *
 * Tracing one long outline down each side fixed the beads and then broke on
 * hairpins. Where a stroke doubles back, the two sides swap over, and the
 * quadratic smoothing that joins the offset points has to run from one side of
 * the stroke to the other. It swings wide doing it, and the swing fills as a
 * large circular blob hanging off the turn — the artifact the acceptance run
 * caught at 400%.
 *
 * The construction here is local, so no smoothing ever crosses a turn and no
 * single arc has to serve two directions. Per SEGMENT, the quad joining the
 * two circles' tangent lines; per SAMPLE, the circle itself. Discs supply
 * round joins in the middle and round caps at the ends by construction, and a
 * geometry that is only ever a union of convex pieces cannot bulge: every
 * piece is inside the stroke by definition.
 *
 * All of it goes into ONE path filled once under nonzero winding, so the
 * overlaps that make the joins work cost nothing — no seam, no double-darkened
 * translucent ink, and one draw call for the whole mark.
 */
function traceStroke(ctx, pts) {
  const n = pts.length;
  ctx.beginPath();

  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const d = norm(b.x - a.x, b.y - a.y);
    // Two samples on the same spot contribute nothing but a disc, which the
    // loop below adds anyway.
    if (!d) continue;
    const nx = -d.y;
    const ny = d.x;
    // Wound to match a default-direction arc — see the discs below.
    ctx.moveTo(a.x + nx * a.r, a.y + ny * a.r);
    ctx.lineTo(a.x - nx * a.r, a.y - ny * a.r);
    ctx.lineTo(b.x - nx * b.r, b.y - ny * b.r);
    ctx.lineTo(b.x + nx * b.r, b.y + ny * b.r);
    ctx.closePath();
  }

  // The discs wind the SAME way as the quads, and that is load-bearing.
  //
  // Nonzero winding adds signed turns: two pieces overlapping with opposite
  // winding cancel to zero and leave a hole — worst exactly at a join, which
  // is where the discs exist to help. The quads' orientation is stable in
  // either direction of travel, because it comes from the segment direction
  // twice over, once in the normal and once in the vertex order; so it is the
  // quads that are ordered to match a plain arc rather than the other way
  // round. Sweeping the arc backwards to match instead would mean writing
  // `arc(…, 0, 2π, true)`, whose sweep is zero or full depending on how the
  // engine reads a full turn in reverse — a disc that silently vanishes.
  for (let i = 0; i < n; i++) {
    ctx.moveTo(pts[i].x + pts[i].r, pts[i].y);
    ctx.arc(pts[i].x, pts[i].y, pts[i].r, 0, Math.PI * 2);
  }

  ctx.fill();
}

/**
 * 纸的纹理。
 *
 * 铅笔不是流体。石墨是被刮到纸的纹理上去的粉末，所以一道铅笔线不是均匀的一条，
 * 而是密密的一片颗粒：纹理凸起处着色深，凹陷处根本没碰到。这一点没法靠改变笔画
 * 的宽度做出来——上一次就是那么试的，无论怎么调，出来的仍是一条边缘起伏的实线。
 * 要的是真正的纹理。
 *
 * 做法：生成一张噪点贴图，把它当作橡皮，从已经画好的实心笔画上"抠掉"一部分。
 * 抠出来的孔就是纸没有吃到石墨的地方。
 *
 * 贴图只生成一次，且由固定种子生成——每次重绘、每台设备都必须是同一张，否则页面
 * 一平移一缩放，笔迹上的颗粒就会重新洗牌，整篇字会在纸上爬。
 */
const GRAIN_TILE = 96;
let grainTile = null;

/** 一个固定种子的伪随机数发生器。刻意不用 Math.random。 */
function seeded(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

function buildGrainTile() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = GRAIN_TILE;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) return null;

  const img = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  const rnd = seeded(0x9e3779b9);
  for (let i = 0; i < img.data.length; i += 4) {
    // 只有 alpha 有意义：这张图是拿来打孔的，颜色无关。
    // 偏置成"多数地方少抠、少数地方抠得狠"，纸的纹理就是这个分布：
    // 大部分是吃到石墨的凸起，其间散着没吃到的凹陷。
    const n = rnd();
    img.data[i + 3] = Math.round(255 * Math.pow(n, 2.1) * 0.85);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** 供打孔用的图案，并让颗粒随页面缩放——它属于纸，不属于屏幕。 */
function grainPattern(ctx, scale) {
  if (grainTile === null) grainTile = buildGrainTile() || false;
  if (!grainTile) return null;
  const pattern = ctx.createPattern(grainTile, 'repeat');
  if (pattern && typeof DOMMatrix === 'function' && pattern.setTransform) {
    const k = Math.max(0.35, Math.min(4, scale));
    try { pattern.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0])); } catch (_) { /* 旧引擎 */ }
  }
  return pattern;
}

/** 画笔画时借用的一块暂存画布，按视口大小复用，不逐笔新建。 */
let scratch = null;
function scratchFor(width, height) {
  if (typeof document === 'undefined') return null;
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  return scratch;
}

/** 笔画在屏幕上的包围盒，外扩一点以容下最外层的柔边。 */
function boundsOf(pts, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r);
    x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r);
  }
  return { x: x0 - pad, y: y0 - pad, w: (x1 - x0) + pad * 2, h: (y1 - y0) + pad * 2 };
}

/**
 * 一道铅笔痕。
 *
 * 两遍实心，再打一次孔：
 *   · 外圈，更宽更淡——石墨散到线两侧的那一点，也就是铅笔边缘发毛的来源；
 *   · 内芯，标称宽度，重一些；
 *   · 然后用噪点图案整体抠一遍，纸没吃到的地方就空出来。
 *
 * 全程在一块暂存画布上完成，最后整块贴回来。必须如此：打孔用的是
 * destination-out，若直接画在笔迹层上，它会把这道笔画底下已经画好的所有东西
 * 一起抠掉。
 *
 * 环境不支持时（Node 里的测试、老引擎）退回普通的实心描边——宁可画得朴素，
 * 不可画不出来。
 */
function drawPencil(ctx, stroke, pts, alpha, scale) {
  const target = ctx.canvas;
  const pad = 2;
  const box = boundsOf(pts, pad);
  const pane = scratchFor(target ? target.width : 0, target ? target.height : 0);
  const pattern = pane && pane.getContext ? grainPattern(pane.getContext('2d'), scale) : null;
  if (!pane || !pattern) {                    // 画不了纹理就老老实实画实心
    ctx.globalAlpha = alpha;
    traceStroke(ctx, pts);
    return;
  }

  const s = pane.getContext('2d');
  s.save();
  s.clearRect(box.x, box.y, box.w, box.h);
  s.fillStyle = stroke.color;

  // 外圈：宽而淡
  s.globalAlpha = alpha * 0.30;
  traceStroke(s, pts.map(p => ({ ...p, r: p.r * 1.45 })));

  // 内芯
  s.globalAlpha = alpha * 0.95;
  traceStroke(s, pts);

  // 抠孔。alpha 恒为 1——深浅由图案自己的 alpha 决定。
  s.globalCompositeOperation = 'destination-out';
  s.globalAlpha = 1;
  s.fillStyle = pattern;
  s.fillRect(box.x, box.y, box.w, box.h);
  s.restore();

  ctx.globalAlpha = 1;
  ctx.drawImage(pane, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
}

/**
 * Paints one stroke.
 *
 * A constant-width tool is one stroked path. A pressure-varying one is a union
 * of local pieces filled once — see traceStroke for why it is neither stroked
 * segment by segment nor traced as one long outline.
 */
export function drawStroke(ctx, stroke, transform) {
  const points = stroke.points;
  if (!points || points.length === 0) return;

  const defaults = TOOL_DEFAULTS[stroke.tool] || TOOL_DEFAULTS[INK_TOOLS.PEN];
  ctx.save();
  ctx.globalAlpha = stroke.opacity;
  ctx.globalCompositeOperation = defaults.composite || 'source-over';
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 填充。只有形状带得上 fill，手写笔迹永远是 null。
  //
  // 填在描边**底下**：反过来的话，那一圈描边会被填充盖掉一半宽度，同一个粗细
  // 在填了色和没填色的形状上看起来就不一样粗。
  if (stroke.fill && points.length > 2) {
    ctx.save();
    ctx.fillStyle = stroke.fill;
    ctx.beginPath();
    const start = documentToScreen(transform, points[0].x, points[0].y);
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < points.length; i++) {
      const p = documentToScreen(transform, points[i].x, points[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // A single tap is a dot, not a zero-length line.
  if (points.length === 1) {
    const p0 = documentToScreen(transform, points[0].x, points[0].y);
    ctx.beginPath();
    ctx.arc(p0.x, p0.y, Math.max(0.4, widthAt(stroke, points[0].p) * transform.scale / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Quadratic-bezier smoothing through sample midpoints. Sampled pointer input
  // is polygonal, and joining the raw samples with straight segments leaves
  // visible corners on slow, curved handwriting. Each sample becomes the
  // control point of a curve running between its neighbouring midpoints, which
  // is the same smoothing the previous bitmap implementation applied — kept
  // here so moving to vectors did not cost stroke quality.
  const toScreen = (pt) => documentToScreen(transform, pt.x, pt.y);
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (a.p + b.p) / 2 });

  const constantWidth = !defaults.pressureRange;
  if (constantWidth) {
    ctx.lineWidth = Math.max(0.4, stroke.width * transform.scale);
    ctx.beginPath();
    const first = toScreen(points[0]);
    ctx.moveTo(first.x, first.y);
    if (points.length === 2) {
      const only = toScreen(points[1]);
      ctx.lineTo(only.x, only.y);
    } else {
      for (let i = 1; i < points.length - 1; i++) {
        const control = toScreen(points[i]);
        const end = toScreen(midpoint(points[i], points[i + 1]));
        ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
      }
      const last = toScreen(points[points.length - 1]);
      ctx.lineTo(last.x, last.y);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Pressure-varying width: one filled outline, not one stroked curve per
  // sample. A single path can only carry one lineWidth, which is what forced
  // the old per-segment loop and its string of overlapping caps.
  const pts = screenSamples(stroke, transform, points);
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, Math.max(0.4, pts[0].r), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  if (defaults.grain) drawPencil(ctx, stroke, pts, stroke.opacity, transform.scale);
  else traceStroke(ctx, pts);
  ctx.restore();
}

/**
 * Repaints the whole layer.
 *
 * The canvas is cleared first — this canvas holds only ink, so clearing it can
 * never remove page content.
 */
export function renderLayer(ctx, layer, transform, viewport) {
  ctx.clearRect(0, 0, viewport.width, viewport.height);
  for (const stroke of layer.getAll()) {
    if (!isVisible(stroke, transform, viewport)) continue;
    drawStroke(ctx, stroke, transform);
  }
}

/** Skips strokes entirely outside the viewport; a long page is mostly off-screen. */
function isVisible(stroke, transform, viewport) {
  if (!stroke.bounds) return true;
  const topLeft = documentToScreen(transform, stroke.bounds.minX, stroke.bounds.minY);
  const bottomRight = documentToScreen(transform, stroke.bounds.maxX, stroke.bounds.maxY);
  return bottomRight.x >= 0 && topLeft.x <= viewport.width
    && bottomRight.y >= 0 && topLeft.y <= viewport.height;
}

/**
 * The lasso's line — the app's gold, `--math-gold` in base.css.
 *
 * Gold rather than the accent blue or the eraser's red: the loop is drawn
 * ACROSS the user's own ink, so it has to be a hue nothing else on the page
 * uses. Blue is the accent every control already wears, and red is the eraser,
 * which is the one thing a selection must never be mistaken for.
 */
export const LASSO_STROKE = '#d97706';
const LASSO_DASH = [7, 5];
/** 形状吸附时那两条虚线，比套索细一档。见 drawShapeGuides。 */
const SHAPE_GUIDE_DASH = [5, 4];
/** 角度标签的字号，和直角符号那一小段的长度，都按屏幕像素给。 */
const SHAPE_LABEL_PX = 12;
const SHAPE_RIGHT_MARK = 11;

/**
 * The lasso loop: the line the hand actually drew, dashed, and nothing else.
 *
 * No fill and no bounding box. A fill tints whatever it is drawn over —
 * including the ink being selected, which is the one thing that must stay
 * legible — and a box describes the extent of what was caught rather than what
 * was asked for, claiming blank page around anything diagonal.
 *
 * The same function draws it while it is being drawn and after it has closed,
 * so the loop does not change appearance at the moment of release. It only
 * gains its closing line and loses the tip.
 *
 * @param {{closed?: boolean, tip?: boolean}} [opts]
 */
export function drawLasso(ctx, polygon, transform, { closed = false, tip = false } = {}) {
  if (!Array.isArray(polygon) || polygon.length < 2) return;
  ctx.save();
  ctx.setLineDash(LASSO_DASH);
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = LASSO_STROKE;
  ctx.beginPath();
  const first = documentToScreen(transform, polygon[0].x, polygon[0].y);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < polygon.length; i++) {
    const pt = documentToScreen(transform, polygon[i].x, polygon[i].y);
    ctx.lineTo(pt.x, pt.y);
  }
  if (closed) ctx.closePath();
  ctx.stroke();

  // While the loop is open, a small ring rides the tip. It is what says the
  // gesture is still live and where it will close back to.
  if (tip) {
    const last = documentToScreen(
      transform, polygon[polygon.length - 1].x, polygon[polygon.length - 1].y,
    );
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(last.x, last.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.restore();
}


/**
 * 形状吸附时的辅助线：琥珀色虚线，和套索同一个色。
 *
 * 同一个金色是故意的。这页上的深色是人的笔迹，蓝色是各种控件，红色是橡皮——
 * 金色在这个应用里只有一个意思：「这是软件替你摆的一条线，不是你画的东西」。
 * 套索的轮廓、选区的把手、形状的十字，说的都是这句话。
 *
 * 虚线比套索的 [7,5] 细一档（[5,4]），照着视频量的：实 8 空 6，在它那个分辨率
 * 上折过来差不多就是这个数。
 */
export function drawShapeGuides(ctx, guides, transform) {
  if (!Array.isArray(guides) || !guides.length) return;
  ctx.save();
  ctx.setLineDash(SHAPE_GUIDE_DASH);
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = LASSO_STROKE;
  ctx.beginPath();
  for (const line of guides) {
    const a = documentToScreen(transform, line.x1, line.y1);
    const b = documentToScreen(transform, line.x2, line.y2);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * 形状松手之后那几颗圆点：实心，压在形状自己身上。
 *
 * 和选区那颗把手不一样——那是白心金边的一个环，这是实心的一小颗。视频里就是实
 * 心的，而且两者确实该长得不一样：选区的把手只有一颗、管旋转和缩放；形状这几颗
 * 是一组，各管一条边。
 */
export function drawShapeHandles(ctx, handles, transform, radius) {
  if (!Array.isArray(handles) || !handles.length) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = LASSO_STROKE;
  for (const handle of handles) {
    const at = documentToScreen(transform, handle.x, handle.y);
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}


/**
 * 顶点旁边那个角度标签，和正好 90° 时那个直角符号。
 *
 * 视频第 2724 帧：矩形一被选中，四个角上各一个「90°」，外加四个直角符号；拖走一
 * 个角之后当场变成 83°/92°/95°/90°，直角符号只留在还是 90° 的那个角上。
 *
 * 字号不跟着缩放走。它是**说明**，不是画在纸上的东西——把页面放到 400%，人要的是
 * 更大的图，不是更大的「90°」三个字；缩到 50% 也还得看得清。
 */
export function drawShapeLabels(ctx, labels, transform) {
  if (!Array.isArray(labels) || !labels.length) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = LASSO_STROKE;
  ctx.fillStyle = LASSO_STROKE;
  ctx.lineWidth = 1.4;
  ctx.font = `${SHAPE_LABEL_PX}px system-ui, -apple-system, "PingFang SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const label of labels) {
    const v = documentToScreen(transform, label.vertex.x, label.vertex.y);
    if (label.right) {
      // 直角符号画在角里：沿两条臂各走一小段，把那个小方块补齐。
      const d = SHAPE_RIGHT_MARK;
      const a = { x: v.x + label.arm1.x * d, y: v.y + label.arm1.y * d };
      const b = { x: v.x + label.arm2.x * d, y: v.y + label.arm2.y * d };
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + label.arm2.x * d, a.y + label.arm2.y * d);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const at = documentToScreen(transform, label.x, label.y);
    ctx.fillText(`${Math.round(label.degrees)}°`, at.x, at.y);
  }
  ctx.restore();
}
