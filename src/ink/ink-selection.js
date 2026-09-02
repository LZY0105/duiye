// Ink Module — lasso selection and the transform applied to what it caught.
//
// Selection is a set of stroke ids and nothing else. It holds no geometry of
// its own: the outline drawn on screen is derived from the strokes every time
// it is needed, so a selection can never describe a shape the ink does not
// actually have.
//
// Transforms are applied to the stored POINTS, in document space, exactly once
// per gesture. They are not carried as a matrix on the stroke, because every
// other part of this module — hit-testing, bounds, erasing, serialisation —
// reads points directly, and a stroke whose visible position disagreed with its
// stored points would break all four.

import { recomputeBounds } from './stroke.js';

/**
 * Ids of every stroke the lasso caught.
 *
 * A stroke counts as selected when any part of it falls inside the loop, which
 * is the forgiving reading: a lasso drawn round a diagram should take the whole
 * diagram, not the strokes that happen to lie entirely within the line.
 */
export function selectInPolygon(layer, polygon, strokeIdsInRegion) {
  if (!layer || !Array.isArray(polygon) || polygon.length < 3) return [];
  return strokeIdsInRegion(layer, polygon, { requireFullyInside: false });
}

/** Bounding box of a set of strokes, in document space, or null. */
export function selectionBounds(layer, ids) {
  if (!layer || !ids || ids.length === 0) return null;
  const wanted = new Set(ids);
  let box = null;
  for (const stroke of layer.strokes) {
    if (!wanted.has(stroke.id) || !stroke.bounds) continue;
    if (!box) {
      box = { ...stroke.bounds };
      continue;
    }
    box.minX = Math.min(box.minX, stroke.bounds.minX);
    box.minY = Math.min(box.minY, stroke.bounds.minY);
    box.maxX = Math.max(box.maxX, stroke.bounds.maxX);
    box.maxY = Math.max(box.maxY, stroke.bounds.maxY);
  }
  return box;
}

/** Bounding box of a polygon, in the polygon's own space, or null. */
export function polygonBounds(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The same affine step applied to the lasso outline.
 *
 * The outline has to travel with what it caught. If it did not, the shape on
 * screen would stop describing the selection the moment the selection moved,
 * and the next press would test containment against a loop that is no longer
 * around anything.
 */
export function transformPolygon(polygon, transform) {
  if (!Array.isArray(polygon) || !transform) return polygon;
  return polygon.map(p => transformPoint(p, transform));
}

export function boundsCentre(box) {
  if (!box) return null;
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

export function pointInBounds(box, x, y, pad = 0) {
  if (!box) return false;
  return x >= box.minX - pad && x <= box.maxX + pad
    && y >= box.minY - pad && y <= box.maxY + pad;
}

/**
 * One affine step: rotate and scale about an origin, then translate.
 *
 * Rotation and scale share an origin and are applied together rather than in
 * sequence, which is what lets a single gesture turn and resize at once without
 * the two fighting over where the centre is.
 */
export function transformPoint(p, { origin, angle = 0, scale = 1, dx = 0, dy = 0 }) {
  const ox = origin ? origin.x : 0;
  const oy = origin ? origin.y : 0;
  const px = p.x - ox;
  const py = p.y - oy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    ...p,
    x: ox + (px * cos - py * sin) * scale + dx,
    y: oy + (px * sin + py * cos) * scale + dy,
  };
}

/**
 * Applies a transform to the selected strokes and records it as ONE step.
 *
 * The before/after point sets are snapshotted rather than the transform being
 * stored and inverted. Inverting is cheaper but drifts: undoing a rotate-scale
 * fifty times would not land back on the original coordinates, and ink that
 * creeps every time you change your mind is worse than the memory.
 *
 * Widths scale with the selection. A stroke enlarged with its line weight left
 * behind stops looking like the same mark.
 *
 * @returns {boolean} whether anything moved
 */
export function transformSelection(layer, history, ids, transform) {
  if (!layer || !ids || ids.length === 0 || !transform) return false;
  const { angle = 0, scale = 1, dx = 0, dy = 0 } = transform;
  const identity = angle === 0 && scale === 1 && dx === 0 && dy === 0;
  if (identity) return false;

  const wanted = new Set(ids);
  const before = [];
  const after = [];

  for (const stroke of layer.strokes) {
    if (!wanted.has(stroke.id)) continue;
    before.push({ id: stroke.id, points: stroke.points.map(p => ({ ...p })), width: stroke.width });
    stroke.points = stroke.points.map(p => transformPoint(p, transform));
    if (scale !== 1) stroke.width = Math.max(0.2, stroke.width * Math.abs(scale));
    recomputeBounds(stroke);
    after.push({ id: stroke.id, points: stroke.points.map(p => ({ ...p })), width: stroke.width });
  }

  if (before.length === 0) return false;
  history?.recordTransform(before, after);
  return true;
}

/** Point/width snapshot of the selected strokes, for one-step undo. */
export function snapshotStrokes(layer, ids) {
  if (!layer || !ids) return [];
  const wanted = new Set(ids);
  return layer.strokes
    .filter(st => wanted.has(st.id))
    .map(st => ({ id: st.id, points: st.points.map(p => ({ ...p })), width: st.width }));
}

/** Puts a snapshot back onto the layer. Used by undo and redo alike. */
export function restorePoints(layer, snapshots) {
  if (!layer || !snapshots) return;
  const byId = new Map(snapshots.map(s => [s.id, s]));
  for (const stroke of layer.strokes) {
    const snap = byId.get(stroke.id);
    if (!snap) continue;
    stroke.points = snap.points.map(p => ({ ...p }));
    if (Number.isFinite(snap.width)) stroke.width = snap.width;
    recomputeBounds(stroke);
  }
}
