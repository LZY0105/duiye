// Ink Module — the stroke collection for one page.
//
// An InkLayer is the Ink half of the "PDF Layer + Ink Layer" separation the
// spec mandates. It holds strokes and nothing else: it has no reference to a
// PDF document, page bitmap or canvas, so no ink operation — including erasing
// — can reach the PDF. The separation is structural, not a convention.
//
// Removal returns strokes together with the index they occupied. Undo then puts
// them back exactly where they were rather than appending, which is what keeps
// z-order stable across repeated undo/redo cycles.

import {
  boundsIntersect,
  deserializeStroke,
  isDrawable,
  serializeStroke,
} from './stroke.js';

export class InkLayer {
  constructor(strokes = []) {
    /** Painted back-to-front; later strokes sit on top. */
    this.strokes = strokes;
  }

  get length() {
    return this.strokes.length;
  }

  add(stroke) {
    if (!isDrawable(stroke)) return -1;
    this.strokes.push(stroke);
    return this.strokes.length - 1;
  }

  /** Re-inserts a stroke at a specific index (undo of an erase). */
  insertAt(index, stroke) {
    const at = Math.max(0, Math.min(this.strokes.length, index));
    this.strokes.splice(at, 0, stroke);
    return at;
  }

  /**
   * Removes strokes by id.
   * @returns {Array<{index:number, stroke:Object}>} ascending by original index
   */
  removeByIds(ids) {
    const wanted = new Set(ids);
    const removed = [];
    const kept = [];
    this.strokes.forEach((stroke, index) => {
      if (wanted.has(stroke.id)) removed.push({ index, stroke });
      else kept.push(stroke);
    });
    this.strokes = kept;
    return removed;
  }

  /** Restores entries produced by removeByIds, lowest index first. */
  restore(entries) {
    const ordered = [...entries].sort((a, b) => a.index - b.index);
    for (const { index, stroke } of ordered) this.insertAt(index, stroke);
  }

  /** Empties the layer, returning what was removed so it can be undone. */
  clear() {
    const removed = this.strokes.map((stroke, index) => ({ index, stroke }));
    this.strokes = [];
    return removed;
  }

  getById(id) {
    return this.strokes.find(s => s.id === id) || null;
  }

  getAll() {
    return this.strokes;
  }

  isEmpty() {
    return this.strokes.length === 0;
  }

  /** Strokes whose bounds overlap the given box; a cheap pre-filter. */
  candidatesInBounds(bounds) {
    if (!bounds) return this.strokes;
    return this.strokes.filter(s => boundsIntersect(s.bounds, bounds));
  }

  /** Union of every stroke's bounds, or null when empty. */
  bounds() {
    let out = null;
    for (const stroke of this.strokes) {
      if (!stroke.bounds) continue;
      if (!out) {
        out = { ...stroke.bounds };
        continue;
      }
      out.minX = Math.min(out.minX, stroke.bounds.minX);
      out.minY = Math.min(out.minY, stroke.bounds.minY);
      out.maxX = Math.max(out.maxX, stroke.bounds.maxX);
      out.maxY = Math.max(out.maxY, stroke.bounds.maxY);
    }
    return out;
  }

  serialize() {
    return { version: 1, strokes: this.strokes.map(serializeStroke) };
  }

  static deserialize(json) {
    const strokes = (json && Array.isArray(json.strokes) ? json.strokes : [])
      .map(deserializeStroke);
    return new InkLayer(strokes);
  }
}
