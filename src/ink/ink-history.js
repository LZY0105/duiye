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
