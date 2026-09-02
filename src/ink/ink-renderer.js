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

/** Width at a sample, blending the tool's base width with pen pressure. */
function widthAt(stroke, pressure) {
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
 * The two sides of a variable-width stroke, as one closed path.
 *
 * This replaces stroking each segment on its own with its own lineWidth, which
 * is the only way a plain `stroke()` can vary width along a line — and which
 * put a round cap at both ends of every segment. At ordinary size the caps
 * overlap sub-pixel and nobody sees them; magnify the ink and every one of
 * them appears, because each was antialiased separately and the rims stack
 * where they overlap. That is the string of beads down an enlarged stroke.
 *
 * An outline has no seams to stack: it is one region, filled once. It is also
 * one draw call per stroke instead of one per sample, which is worth more than
 * the arithmetic it costs on a page carrying a few hundred marks.
 *
 * Both sides are smoothed through sample midpoints, the same quadratic
 * smoothing the centre line used, so the silhouette curves rather than
 * faceting. Nonzero winding fills a stroke that doubles back on itself solid,
 * which is what ink does.
 */
function traceOutline(ctx, pts) {
  const n = pts.length;
  // Direction at each sample: the average of the segments meeting there, so
  // the offset follows the corner instead of jumping across it.
  const dirs = new Array(n);
  for (let i = 0; i < n; i++) {
    const back = i > 0 ? norm(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) : null;
    const fwd = i < n - 1 ? norm(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) : null;
    let d = back && fwd ? norm(back.x + fwd.x, back.y + fwd.y) : (fwd || back);
    // A hairpin averages to nothing; keep going the way we came.
    if (!d) d = back || fwd || { x: 1, y: 0 };
    dirs[i] = d;
  }

  const side = (i, sign) => ({
    x: pts[i].x - dirs[i].y * pts[i].r * sign,
    y: pts[i].y + dirs[i].x * pts[i].r * sign,
  });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const run = (sign, order) => {
    let prev = side(order[0], sign);
    ctx.lineTo(prev.x, prev.y);
    for (let k = 1; k < order.length - 1; k++) {
      const c = side(order[k], sign);
      const e = mid(c, side(order[k + 1], sign));
      ctx.quadraticCurveTo(c.x, c.y, e.x, e.y);
      prev = e;
    }
    const last = side(order[order.length - 1], sign);
    ctx.lineTo(last.x, last.y);
  };

  const forward = [];
  for (let i = 0; i < n; i++) forward.push(i);
  const backward = forward.slice().reverse();

  const head = side(0, 1);
  ctx.beginPath();
  ctx.moveTo(head.x, head.y);
  run(1, forward);
  // Round caps, each turning onto the other side.
  //
  // Both sweep anticlockwise — decreasing angle — and that is not a symmetry
  // to trust by eye. The far cap has to pass in FRONT of the tip and the near
  // one BEHIND the start; taking the other arc direction sends each of them
  // the long way round, back through the stroke, and the fill then eats a bite
  // out of the end it was supposed to round off.
  const tip = pts[n - 1];
  const tipDir = dirs[n - 1];
  ctx.arc(tip.x, tip.y, tip.r,
    Math.atan2(tipDir.x, -tipDir.y), Math.atan2(-tipDir.x, tipDir.y), true);
  run(-1, backward);
  const tail = pts[0];
  ctx.arc(tail.x, tail.y, tail.r,
    Math.atan2(-dirs[0].x, dirs[0].y), Math.atan2(dirs[0].x, -dirs[0].y), true);
  ctx.closePath();
  ctx.fill();
}

/**
 * Paints one stroke.
 *
 * A constant-width tool is one stroked path. A pressure-varying one is an
 * outline, filled once — see traceOutline for why it is not stroked segment by
 * segment any more.
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
  traceOutline(ctx, pts);
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
