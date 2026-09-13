// Ink Module — stroke eraser and region eraser.
//
// Both erasers work by REMOVING STROKES from the ink layer. Neither paints
// anything, and in particular neither paints white or composites in
// 'destination-out' over a shared canvas — which is how a bitmap eraser would
// have to work, and is exactly how a PDF page underneath gets destroyed.
//
// Because erasing is a data operation on the ink layer, it is reversible (the
// removed strokes are handed to history) and it structurally cannot touch the
// PDF: this module has no reference to one.

import {
  strokeHitByPoint,
  strokeIntersectsPolygon,
  pointInPolygon,
  recomputeBounds,
} from './stroke.js';

export const ERASER_MODES = Object.freeze({
  /** Removes any whole stroke the eraser tip touches. */
  STROKE: 'stroke',
  /** Removes every stroke inside a lassoed region. */
  REGION: 'region',
});

/**
 * Ids of strokes whose body is within `radius` of (x, y).
 * Coordinates are document-space, matching how strokes are stored.
 */
export function strokeIdsAtPoint(layer, x, y, radius = 6) {
  const probe = {
    minX: x - radius, minY: y - radius,
    maxX: x + radius, maxY: y + radius,
  };
  return layer.candidatesInBounds(probe)
    .filter(stroke => strokeHitByPoint(stroke, x, y, radius))
    .map(stroke => stroke.id);
}

/**
 * Ids of strokes touched anywhere along an eraser drag.
 *
 * The path between two pointer samples is walked rather than only its
 * endpoints: a fast swipe can jump tens of pixels between events, and testing
 * only the samples leaves untouched strokes behind in the gaps.
 */
/**
 * 把一条采样稀疏的路径补成一串首尾相接的点。
 *
 * 两种橡皮共用这一份。指针事件之间的间隔取决于手划得多快 —— 真机上量过，快速
 * 划一道时相邻两个 pointermove 差 20 个 CSS 像素上下；而橡皮头的半径比这小。
 * 只在事件落点上擦，中间那段就是没擦到的缝，手越快缝越宽。
 *
 * 步长取半径的 0.75，保证相邻两个圆盘互相重叠，路径上不留空隙。
 */
function* walkPath(points, radius) {
  const step = Math.max(1, radius * 0.75);
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const previous = i > 0 ? points[i - 1] : null;
    if (previous) {
      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      const distance = Math.hypot(dx, dy);
      const samples = Math.floor(distance / step);
      for (let s = 1; s <= samples; s++) {
        const t = s / (samples + 1);
        yield { x: previous.x + dx * t, y: previous.y + dy * t };
      }
    }
    yield current;
  }
}

export function strokeIdsAlongPath(layer, points, radius = 6) {
  const hits = new Set();
  if (!Array.isArray(points) || points.length === 0) return [];
  for (const p of walkPath(points, radius)) {
    for (const id of strokeIdsAtPoint(layer, p.x, p.y, radius)) hits.add(id);
  }
  return [...hits];
}

/**
 * 区域橡皮：沿着这一段路径一路挖过去，而不是只在落点挖一个洞。
 *
 * 以前这里只拿当前指针位置调一次 eraseArea。慢慢擦看不出问题——事件密，洞挨着
 * 洞；快速扫过去就会一段擦掉一段留着，正是「有些笔记擦不到」。整笔模式一直是
 * 沿路径测的，区域模式漏了。
 *
 * @returns {boolean} 这一段有没有真的改动过什么
 */
export function eraseAreaAlongPath(layer, history, points, radius) {
  if (!Array.isArray(points) || points.length === 0) return false;
  let changed = false;
  for (const p of walkPath(points, radius)) {
    if (eraseArea(layer, history, { x: p.x, y: p.y, radius })) changed = true;
  }
  return changed;
}

/**
 * Ids of strokes inside a lassoed polygon.
 *
 * `requireFullyInside` decides whether a stroke crossing the boundary counts.
 * The default (false) matches what erasing a scribbled region feels like:
 * anything you drew a loop around goes, even if it trails outside.
 */
export function strokeIdsInRegion(layer, polygon, { requireFullyInside = false } = {}) {
  if (!Array.isArray(polygon) || polygon.length < 3) return [];

  const xs = polygon.map(p => p.x);
  const ys = polygon.map(p => p.y);
  const probe = {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys),
  };

  return layer.candidatesInBounds(probe).filter((stroke) => {
    if (!requireFullyInside) return strokeIntersectsPolygon(stroke, polygon);
    return stroke.points.length > 0
      && stroke.points.every(pt => pointInPolygon(pt.x, pt.y, polygon));
  }).map(stroke => stroke.id);
}

/**
 * Applies an erase and records it, in one place so every eraser path stays
 * undoable. Returns the removed entries (empty when nothing was hit).
 */
export function eraseStrokes(layer, history, ids) {
  if (!ids || ids.length === 0) return [];
  const removed = layer.removeByIds(ids);
  if (removed.length && history) history.recordErase(removed);
  return removed;
}

/**
 * Area erase: takes only the ink the eraser head actually covered.
 *
 * REGION used to mean "remove every whole stroke the head touched", which is
 * the stroke eraser wearing a different name — clip one corner of a long
 * underline and the entire underline vanished. An area eraser has to cut, so a
 * stroke that is crossed in the middle comes back as two strokes with a gap
 * where the head passed.
 *
 * The cut is per POINT: a sample inside the head is dropped, and each surviving
 * run becomes its own stroke carrying the original's tool, colour, width and
 * opacity. Runs shorter than two points are discarded — a single point is not a
 * line, and keeping it would leave invisible debris behind that still costs
 * hit-testing.
 *
 * The whole gesture is one history entry, because undoing half of a cut would
 * leave the stroke severed with nothing to show for it.
 *
 * @param {InkLayer} layer
 * @param {InkHistory} history
 * @param {{x:number, y:number, radius:number}} head eraser head, document space
 * @returns {boolean} whether anything changed
 */
export function eraseArea(layer, history, head) {
  if (!layer || !head || !(head.radius > 0)) return false;
  const { x, y, radius } = head;

  const probe = {
    minX: x - radius, minY: y - radius,
    maxX: x + radius, maxY: y + radius,
  };
  const candidates = layer.candidatesInBounds(probe)
    .filter(stroke => strokeHitByPoint(stroke, x, y, radius));
  if (candidates.length === 0) return false;

  const cuts = [];
  for (const stroke of candidates) {
    const runs = surviveOutside(stroke, x, y, radius);
    // Untouched: every point survived in one run. Nothing to do.
    if (runs.length === 1 && runs[0].length === stroke.points.length) continue;
    cuts.push({ stroke, runs });
  }
  if (cuts.length === 0) return false;

  const removed = layer.removeByIds(cuts.map(c => c.stroke.id));
  const added = [];
  // Re-inserted lowest index first so each fragment lands where its original
  // was, and z-order survives the cut.
  for (const entry of [...removed].sort((a, b) => a.index - b.index)) {
    const cut = cuts.find(c => c.stroke.id === entry.stroke.id);
    let at = entry.index;
    for (const run of cut.runs) {
      const fragment = fragmentOf(cut.stroke, run);
      const index = layer.insertAt(at, fragment);
      added.push({ index, stroke: fragment });
      at = index + 1;
    }
  }

  history?.recordSplit(removed, added);
  return true;
}

/** Runs of consecutive points that the head did not cover. */
function surviveOutside(stroke, x, y, radius) {
  const reach = radius + halfWidthOf(stroke);
  const reach2 = reach * reach;
  const runs = [];
  let run = [];
  for (const p of stroke.points) {
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy <= reach2) {
      if (run.length) { runs.push(run); run = []; }
    } else {
      run.push(p);
    }
  }
  if (run.length) runs.push(run);
  return runs.filter(r => r.length >= 2);
}

function fragmentOf(stroke, points) {
  const fragment = {
    ...stroke,
    id: `${stroke.id}~${Math.random().toString(36).slice(2, 8)}`,
    points: points.map(p => ({ ...p })),
    bounds: null,
  };
  // Bounds MUST be rebuilt, not inherited and not left null. `candidatesInBounds`
  // pre-filters on them and `boundsIntersect(null, …)` is false, so a fragment
  // without them would draw on screen while being invisible to hit-testing — it
  // could never be selected, erased or cut again.
  recomputeBounds(fragment);
  return fragment;
}

function halfWidthOf(stroke) {
  return Math.max(0.5, (Number(stroke.width) || 1) / 2);
}
