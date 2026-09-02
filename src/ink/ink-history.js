// Ink Module — operation-based undo/redo.
//
// History records what was DONE, not what the screen looked like. The previous
// implementation pushed a full-canvas ImageData per step, which meant undo
// depth was bounded by memory (a 2000x1500 canvas costs ~12 MB per snapshot),
// resolution-dependent, and impossible to reconcile with a vector layer.
//
// Each entry here is a few object references, so a deep stack is cheap and
// every step is exactly reversible: undo and redo are the same operation read
// in opposite directions, which is what keeps 100 cycles from drifting.

export const INK_OPS = Object.freeze({
  ADD: 'add',
  ERASE: 'erase',
  CLEAR: 'clear',
  /**
   * An area erase: originals removed, surviving fragments put back in their
   * place. One op, because it is one gesture — undoing half of it would leave
   * the stroke cut with nothing to show for it.
   */
  SPLIT: 'split',
});

const DEFAULT_LIMIT = 500;

export class InkHistory {
  /**
   * @param {import('./ink-layer.js').InkLayer} layer
   * @param {{limit?: number, onChange?: function}} options
   */
  constructor(layer, options = {}) {
    this.layer = layer;
    this.limit = Number(options.limit) || DEFAULT_LIMIT;
    this.onChange = options.onChange || null;
    this.undoStack = [];
    this.redoStack = [];
  }

  _changed() {
    this.onChange?.(this);
  }

  /**
   * Records an operation that has ALREADY been applied to the layer.
   * A new operation invalidates the redo branch, as everywhere else.
   */
  record(op) {
    this.undoStack.push(op);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._changed();
  }

  recordAdd(stroke, index) {
    this.record({ type: INK_OPS.ADD, index, stroke });
  }

  /** @param {Array<{index:number, stroke:Object}>} entries from InkLayer.removeByIds */
  recordErase(entries) {
    if (!entries.length) return;
    this.record({ type: INK_OPS.ERASE, entries });
  }

  /**
   * @param {Array<{index:number, stroke:Object}>} removed originals taken out
   * @param {Array<{index:number, stroke:Object}>} added fragments put back
   */
  recordSplit(removed, added) {
    if (!removed?.length) return;
    this.record({ type: INK_OPS.SPLIT, removed, added: added || [] });
  }

  recordClear(entries) {
    if (!entries.length) return;
    this.record({ type: INK_OPS.CLEAR, entries });
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return false;
    this._revert(op);
    this.redoStack.push(op);
    this._changed();
    return true;
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return false;
    this._apply(op);
    this.undoStack.push(op);
    this._changed();
    return true;
  }

  _revert(op) {
    switch (op.type) {
      case INK_OPS.ADD:
        this.layer.removeByIds([op.stroke.id]);
        break;
      case INK_OPS.ERASE:
      case INK_OPS.CLEAR:
        // Restored at their original indices, so z-order survives the round trip.
        this.layer.restore(op.entries);
        break;
      case INK_OPS.SPLIT:
        // Take the fragments out before putting the originals back, or the
        // restored indices land among strokes that should not be there.
        this.layer.removeByIds(op.added.map(e => e.stroke.id));
        this.layer.restore(op.removed);
        break;
      default:
        break;
    }
  }

  _apply(op) {
    switch (op.type) {
      case INK_OPS.ADD:
        this.layer.insertAt(op.index, op.stroke);
        break;
      case INK_OPS.ERASE:
      case INK_OPS.CLEAR:
        this.layer.removeByIds(op.entries.map(e => e.stroke.id));
        break;
      case INK_OPS.SPLIT:
        this.layer.removeByIds(op.removed.map(e => e.stroke.id));
        this.layer.restore(op.added);
        break;
      default:
        break;
    }
  }

  /** Drops history without touching the layer (e.g. after loading a page). */
  reset() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._changed();
  }

  get depth() {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}
