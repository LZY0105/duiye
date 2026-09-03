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
  traceStroke(ctx, pts);
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
