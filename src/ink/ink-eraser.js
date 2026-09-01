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

import { strokeHitByPoint, strokeIntersectsPolygon, pointInPolygon } from './stroke.js';

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
export function strokeIdsAlongPath(layer, points, radius = 6) {
  const hits = new Set();
  if (!Array.isArray(points) || points.length === 0) return [];

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
        for (const id of strokeIdsAtPoint(layer, previous.x + dx * t, previous.y + dy * t, radius)) {
          hits.add(id);
        }
      }
    }
    for (const id of strokeIdsAtPoint(layer, current.x, current.y, radius)) hits.add(id);
  }
  return [...hits];
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
