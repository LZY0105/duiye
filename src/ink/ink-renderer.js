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
 * Paints one stroke.
 *
 * A pen/pencil/marker is drawn segment by segment so pressure can vary the
 * width along the stroke. A highlighter is drawn as a single constant-width
 * path instead: per-segment drawing would overlap translucent caps at every
 * joint and leave visible dark beads along the line.
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

  // Pressure-varying width has to be stroked per curve, since a single path
  // can only carry one lineWidth.
  let start = points[0];
  for (let i = 1; i < points.length; i++) {
    const control = points[i];
    const end = i < points.length - 1 ? midpoint(points[i], points[i + 1]) : points[i];
    ctx.lineWidth = Math.max(0.4, widthAt(stroke, control.p) * transform.scale);
    const s = toScreen(start);
    const c = toScreen(control);
    const e = toScreen(end);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.quadraticCurveTo(c.x, c.y, e.x, e.y);
    ctx.stroke();
    start = end;
  }
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

/** Outline preview for the region eraser's lasso, drawn above the ink. */
export function drawLasso(ctx, polygon, transform) {
  if (!Array.isArray(polygon) || polygon.length < 2) return;
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ef4444';
  ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
  ctx.beginPath();
  const first = documentToScreen(transform, polygon[0].x, polygon[0].y);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < polygon.length; i++) {
    const pt = documentToScreen(transform, polygon[i].x, polygon[i].y);
    ctx.lineTo(pt.x, pt.y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
