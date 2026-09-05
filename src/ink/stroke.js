// Ink Module — vector stroke model.
//
// A stroke is a list of points in DOCUMENT space, never in screen space. That
// single decision is what makes zoom lossless: rendering re-rasterises the same
// geometry at whatever scale the pane is currently at, so a stroke drawn at
// 100% and inspected at 600% is as sharp as one drawn at 600%. The previous
// implementation stored whole ImageData framebuffers, which could only ever be
// resampled.
//
// Pure and DOM-free so geometry, bounds and hit-testing are testable in Node.

export const INK_TOOLS = Object.freeze({
  PEN: 'pen',
  PENCIL: 'pencil',
  MARKER: 'marker',
  HIGHLIGHTER: 'highlighter',
});

/**
 * Per-tool rendering behaviour. Width is a document-space base width.
 *
 * `grain` is what makes a pencil a pencil rather than a thin pale pen. Nothing
 * else here distinguishes them: before it, the two tools differed by 0.4 of a
 * unit of width and 0.15 of alpha, and on a stylus that reports no pressure
 * they drew the same line. See drawPencil in ink-renderer.js.
 */
export const TOOL_DEFAULTS = Object.freeze({
  [INK_TOOLS.PEN]: { width: 2, opacity: 1, pressureRange: 0.6, composite: 'source-over' },
  // Broader and paler than the pen, which is most of what tells the two apart
  // at a glance before the grain is close enough to see.
  [INK_TOOLS.PENCIL]: {
    width: 3, opacity: 0.82, pressureRange: 0.8, composite: 'source-over', grain: true,
  },
  [INK_TOOLS.MARKER]: { width: 6, opacity: 1, pressureRange: 0.2, composite: 'source-over' },
  // A highlighter must not darken where a single stroke overlaps itself, which
  // is why it is drawn as one flattened path rather than per-segment.
  [INK_TOOLS.HIGHLIGHTER]: { width: 16, opacity: 0.35, pressureRange: 0, composite: 'multiply' },
});

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `s${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function createStroke({ tool = INK_TOOLS.PEN, color = '#111827', width, opacity } = {}) {
  const defaults = TOOL_DEFAULTS[tool] || TOOL_DEFAULTS[INK_TOOLS.PEN];
  return {
    id: nextId(),
    tool,
    color,
    width: Number.isFinite(width) ? width : defaults.width,
    opacity: Number.isFinite(opacity) ? opacity : defaults.opacity,
    points: [],
    // Kept incrementally so hit-testing and repaint regions never rescan points.
    bounds: null,
  };
}

/** Half the maximum painted width, used to inflate bounds and hit tests. */
export function strokeRadius(stroke) {
  const defaults = TOOL_DEFAULTS[stroke.tool] || TOOL_DEFAULTS[INK_TOOLS.PEN];
  // Graphite scatters either side of the line it was drawn along, and the
  // widest pass sits about half a radius off centre. Bounds that did not know
  // that would leave the outermost grain outside the repaint region, so it
  // would survive an erase and reappear where a neighbouring stroke was
  // redrawn over it.
  const spread = defaults.grain ? 2 : 1;
  return Math.max(0.5, (stroke.width * spread) / 2);
}

function growBounds(bounds, x, y, pad) {
  if (!bounds) {
    return { minX: x - pad, minY: y - pad, maxX: x + pad, maxY: y + pad };
  }
  bounds.minX = Math.min(bounds.minX, x - pad);
  bounds.minY = Math.min(bounds.minY, y - pad);
  bounds.maxX = Math.max(bounds.maxX, x + pad);
  bounds.maxY = Math.max(bounds.maxY, y + pad);
  return bounds;
}

/**
 * Appends a sampled point.
 *
 * Points closer than a threshold are dropped: pointer events fire far faster
 * than the ink needs, and keeping every one bloats storage without changing
 * what is drawn.
 */
export function appendPoint(stroke, x, y, pressure = 0.5, minDistance = 0.6) {
  const p = Math.min(1, Math.max(0, Number(pressure) || 0));
  const last = stroke.points[stroke.points.length - 1];
  if (last) {
    const dx = x - last.x;
    const dy = y - last.y;
    if (dx * dx + dy * dy < minDistance * minDistance) return false;
  }
  stroke.points.push({ x, y, p });
  stroke.bounds = growBounds(stroke.bounds, x, y, strokeRadius(stroke));
  return true;
}

export function isEmptyStroke(stroke) {
  return !stroke || stroke.points.length === 0;
}

/** A single tap still leaves a dot; treat it as drawable. */
export function isDrawable(stroke) {
  return !!stroke && stroke.points.length >= 1;
}

export function recomputeBounds(stroke) {
  stroke.bounds = null;
  const pad = strokeRadius(stroke);
  for (const pt of stroke.points) {
    stroke.bounds = growBounds(stroke.bounds, pt.x, pt.y, pad);
  }
  return stroke.bounds;
}

export function boundsIntersect(a, b) {
  if (!a || !b) return false;
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function boundsContainPoint(bounds, x, y) {
  if (!bounds) return false;
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

/** Squared distance from a point to a segment; squared to avoid a sqrt per test. */
function distanceSqToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  let t = lenSq === 0 ? 0 : (wx * vx + wy * vy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return dx * dx + dy * dy;
}

/**
 * True when (x, y) is within `radius` of the stroke's painted body.
 * The stroke's own half-width counts, so a thick marker is easier to hit than
 * a fine pen — which is what a user expects from an eraser.
 */
export function strokeHitByPoint(stroke, x, y, radius = 0) {
  if (!isDrawable(stroke)) return false;
  const reach = radius + strokeRadius(stroke);
  if (!boundsContainPoint(inflate(stroke.bounds, radius), x, y)) return false;
  const reachSq = reach * reach;

  if (stroke.points.length === 1) {
    const only = stroke.points[0];
    const dx = x - only.x;
    const dy = y - only.y;
    return dx * dx + dy * dy <= reachSq;
  }
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    if (distanceSqToSegment(x, y, a.x, a.y, b.x, b.y) <= reachSq) return true;
  }
  return false;
}

function inflate(bounds, by) {
  if (!bounds) return null;
  return {
    minX: bounds.minX - by,
    minY: bounds.minY - by,
    maxX: bounds.maxX + by,
    maxY: bounds.maxY + by,
  };
}

/** True when any sampled point falls inside the polygon (even-odd rule). */
export function strokeIntersectsPolygon(stroke, polygon) {
  if (!isDrawable(stroke) || !Array.isArray(polygon) || polygon.length < 3) return false;
  for (const pt of stroke.points) {
    if (pointInPolygon(pt.x, pt.y, polygon)) return true;
  }
  return false;
}

export function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Plain-JSON form for persistence. Coordinates stay in document space. */
export function serializeStroke(stroke) {
  return {
    id: stroke.id,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    opacity: stroke.opacity,
    // Rounded to 0.01 document units: far finer than any display can show, and
    // roughly halves the stored size versus full float precision.
    points: stroke.points.map(pt => [round2(pt.x), round2(pt.y), round2(pt.p)]),
  };
}

export function deserializeStroke(json) {
  const stroke = {
    id: json.id || nextId(),
    tool: json.tool || INK_TOOLS.PEN,
    color: json.color || '#111827',
    width: Number(json.width) || TOOL_DEFAULTS[INK_TOOLS.PEN].width,
    opacity: Number.isFinite(json.opacity) ? json.opacity : 1,
    points: (json.points || []).map(p => (
      Array.isArray(p) ? { x: p[0], y: p[1], p: p[2] } : { x: p.x, y: p.y, p: p.p }
    )),
    bounds: null,
  };
  recomputeBounds(stroke);
  return stroke;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
