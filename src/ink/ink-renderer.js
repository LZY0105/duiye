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
  // How far along the mark this sample is, in DOCUMENT units — summed over
  // every point, including the ones decimation drops, so it is the same number
  // at every zoom. It is what the pencil's grain is a function of, and grain
  // measured any other way would be re-sprinkled each time the page changed
  // scale instead of staying on the paper.
  let travelled = 0;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (i > 0) travelled += Math.hypot(pt.x - points[i - 1].x, pt.y - points[i - 1].y);
    const x = (pt.x - transform.offsetX) * transform.scale;
    const y = (pt.y - transform.offsetY) * transform.scale;
    const r = Math.max(0.2, widthAt(stroke, pt.p) * transform.scale / 2);
    const last = out[out.length - 1];
    // The final sample is always kept: it is where the stroke ends, and
    // dropping it would shorten the mark.
    if (last && i < points.length - 1
      && Math.abs(x - last.x) < minGap && Math.abs(y - last.y) < minGap) continue;
    out.push({ x, y, r, s: travelled });
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

/** A hash in [0, 1), stable for a given number. */
function hash01(n) {
  const v = Math.sin(n * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Value noise in [0, 1) with a period of 1 in `t`, in two octaves.
 *
 * Deterministic, not random, and that is the first requirement: the page is
 * repainted on every pan, every zoom step and every page turn, and grain drawn
 * from Math.random would reshuffle its graphite on each of them. The mark has
 * to keep the grain it was made with.
 *
 * Interpolated between lattice points, and that is the second. The first
 * version of this hashed `t` directly — `sin(seed * 127.1 + t * 311.7)` — which
 * has no period at all: at the spacing samples are stored at, that expression
 * turns over six times BETWEEN consecutive samples. What came out was white
 * noise at the sampling frequency, finer than the line was wide, and it
 * averaged straight back out to a smooth line. Grain is a low frequency; it has
 * to be built as one.
 */
function grainNoise(seed, t) {
  const lattice = (u) => {
    const i = Math.floor(u);
    const f = u - i;
    const w = f * f * (3 - 2 * f);   // smoothstep, so it is grain and not a sawtooth
    const a = hash01(seed + i * 57.31);
    const b = hash01(seed + (i + 1) * 57.31);
    return a + (b - a) * w;
  };
  // A coarse swing for where the pencil bore down, and a finer one for the
  // tooth of the paper inside it.
  return 0.68 * lattice(t) + 0.32 * lattice(t * 3.7 + 19.4);
}

/** A stable number per stroke, so two pencil lines do not share a grain. */
function strokeSeed(stroke) {
  const id = String(stroke.id || '');
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  }
  return ((h >>> 0) % 100003) / 1000;
}

/**
 * The three passes a pencil mark is made of.
 *
 * A thin dark core inside a broad pale skirt, which is what graphite looks
 * like: the point deposits most of its powder along the line it travelled and
 * scatters the rest either side. Three even passes read as one soft pen at
 * reading size, where the whole mark is three device pixels wide and there is
 * no room for texture — the contrast BETWEEN the passes is what survives.
 *
 * `alpha` multiplies the stroke's own; `across` displaces the pass sideways in
 * radii; `width` scales it; `bite` is how deeply the noise is allowed to thin
 * it — 0 draws an even line, 1 lets it break up entirely.
 */
const PENCIL_PASSES = Object.freeze([
  { phase: 0.0, alpha: 0.18, across: -0.10, width: 1.50, bite: 0.20 },
  { phase: 5.3, alpha: 0.36, across: 0.14, width: 1.00, bite: 0.38 },
  // The point itself, and the one allowed to run out. A pencil skips where the
  // paper does not take it, and that break along the line is the cue the eye
  // reads as graphite long before it can see the tooth.
  { phase: 11.9, alpha: 0.85, across: 0.00, width: 0.50, bite: 0.78 },
]);

/**
 * How far the mark travels, in document units, per swing of the grain.
 *
 * Roughly four times the width of the line, so the grain varies over a
 * distance the eye reads as texture rather than as a fuzzy edge.
 */
const GRAIN_PERIOD = 6;

/**
 * A pencil mark: the same line laid down three times, each wandering.
 *
 * Graphite is not a fluid. It is a powder scraped onto the tooth of the paper,
 * so a pencil line is dark where the tooth caught and pale where it did not,
 * and its edge is ragged rather than cut. It is never the even deposit a pen
 * leaves — which is exactly what this tool used to draw, a pen 0.4 units
 * thinner and 15% paler, indistinguishable from the real one on a stylus that
 * reports no pressure.
 *
 * Each pass is ONE path filled ONCE, for the reason traceStroke gives at
 * length: a translucent pass filled piece by piece double-darkens itself at
 * every join and comes apart into beads. So the passes are what stack, and
 * their stacking is the mark — solid where all three agree, broken at the
 * edges where they do not.
 *
 * The wander is measured in DOCUMENT units, not screen pixels, so it belongs
 * to the paper: zooming in shows the same grain larger, the way looking closer
 * at a page does, instead of re-sprinkling it at the new scale.
 */
function drawPencil(ctx, stroke, pts, alpha) {
  const seed = strokeSeed(stroke);

  // The direction of travel at each sample, for displacing a pass across the
  // line. Taken from the neighbours rather than the segment, so a pass does
  // not kink where two segments meet.
  const normals = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const d = norm(b.x - a.x, b.y - a.y);
    return d ? { x: -d.y, y: d.x } : { x: 0, y: 0 };
  });

  for (const pass of PENCIL_PASSES) {
    const shifted = pts.map((p, i) => {
      const n = grainNoise(seed + pass.phase, p.s / GRAIN_PERIOD);
      const off = pass.across * p.r * (0.55 + 0.9 * n);
      return {
        x: p.x + normals[i].x * off,
        y: p.y + normals[i].y * off,
        r: Math.max(0.15, p.r * pass.width * (1 - pass.bite * n)),
      };
    });
    ctx.globalAlpha = alpha * pass.alpha;
    traceStroke(ctx, shifted);
  }
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
    const r0 = Math.max(0.4, widthAt(stroke, points[0].p) * transform.scale / 2);
    if (defaults.grain) {
      // Even a full stop is graphite: a core with a lighter halo, not a disc.
      const n = grainNoise(strokeSeed(stroke), 0);
      for (const pass of PENCIL_PASSES) {
        ctx.globalAlpha = stroke.opacity * pass.alpha;
        ctx.beginPath();
        ctx.arc(p0.x + pass.across * r0 * n, p0.y + pass.across * r0 * (1 - n),
          Math.max(0.2, r0 * pass.width * (1 - pass.bite * n)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.arc(p0.x, p0.y, r0, 0, Math.PI * 2);
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
  if (defaults.grain) drawPencil(ctx, stroke, pts, stroke.opacity);
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
