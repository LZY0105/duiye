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

import { restorePoints } from './ink-selection.js';

export const INK_OPS = Object.freeze({
  /**
   * Several operations that happened as one gesture and must undo as one.
   *
   * The region eraser is why this exists: it cuts on every pointermove, so one
   * drag across a page recorded dozens of separate splits and needed dozens of
   * presses to take back. What the user did was one wipe.
   */
  BATCH: 'batch',
  ADD: 'add',
  ERASE: 'erase',
  CLEAR: 'clear',
  /**
   * An area erase: originals removed, surviving fragments put back in their
   * place. One op, because it is one gesture — undoing half of it would leave
   * the stroke cut with nothing to show for it.
   */
  SPLIT: 'split',
  /** A lasso selection moved, rotated or resized. */
  TRANSFORM: 'transform',
  /**
   * 一片选中的笔画换了颜色。
   *
   * 不能拿「擦掉再画一遍」凑：那会换掉它们的 id 和层序，于是撤销之后回来的是
   * 另外几条笔画——同一个样子，不同的身份，而选区、剪贴板、正在进行的搬动都是
   * 按 id 认人的。
   */
  RESTYLE: 'restyle',
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
    /** Open transaction: ops land here instead of the stack while it exists. */
    this._batch = null;
  }

  /**
   * Opens a transaction. Everything recorded until `endBatch` becomes ONE
   * undo step. Re-entrant calls are ignored rather than nested, so an inner
   * helper that also batches cannot close the outer gesture's transaction.
   */
  beginBatch() {
    if (this._batch) return false;
    this._batch = [];
    return true;
  }

  /**
   * Closes the transaction and records it as one step.
   *
   * A batch of one is recorded as the operation itself: wrapping a single
   * split in a batch would leave a step that is harder to reason about in the
   * stack, for no gain.
   */
  endBatch() {
    const ops = this._batch;
    this._batch = null;
    if (!ops || ops.length === 0) return false;
    if (ops.length === 1) this.record(ops[0]);
    else this.record({ type: INK_OPS.BATCH, ops });
    return true;
  }

  /** Abandons an open transaction without recording it. */
  cancelBatch() {
    this._batch = null;
  }

  _changed() {
    this.onChange?.(this);
  }

  /**
   * Records an operation that has ALREADY been applied to the layer.
   * A new operation invalidates the redo branch, as everywhere else.
   */
  record(op) {
    if (this._batch) { this._batch.push(op); return; }
    this.undoStack.push(op);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._changed();
  }

  recordAdd(stroke, index) {
    this.record({ type: INK_OPS.ADD, index, stroke });
  }

  /**
   * @param {Array<{index:number, stroke:Object}>} entries from InkLayer.removeByIds
   * @param {{onUndo?: function, onRedo?: function}} [paired] 这一步的「另一半」
   *
   * 绝大多数擦除没有另一半：擦掉就是擦掉。有另一半的只有一种——把一片笔迹拖到了
   * 另一栏：那边加上、这边擦掉，是同一件事的两面。少了这一对回调，在这边撤销会
   * 把笔迹放回来、而那边那份还在，于是一次撤销之后内容变成了两份。
   *
   * 回调而不是「目标图层」的引用：历史不该知道有别的画布这回事，它只知道这一步
   * 还有一件事要一起做。跨文档那点耦合留在真正跨文档的那个地方（ink-surface 的
   * _handOff），不渗进这里。
   */
  recordErase(entries, paired = null) {
    if (!entries.length) return;
    this.record({
      type: INK_OPS.ERASE,
      entries,
      onUndo: paired?.onUndo || null,
      onRedo: paired?.onRedo || null,
    });
  }

  /**
   * @param {Array<{index:number, stroke:Object}>} removed originals taken out
   * @param {Array<{index:number, stroke:Object}>} added fragments put back
   */
  recordSplit(removed, added) {
    if (!removed?.length) return;
    this.record({ type: INK_OPS.SPLIT, removed, added: added || [] });
  }

  /**
   * @param {Array<{id:string, points:Array, width:number}>} before
   * @param {Array<{id:string, points:Array, width:number}>} after
   */
  /**
   * @param {Array<{id:string, points:Array, width:number}>} before
   * @param {Array<{id:string, points:Array, width:number}>} after
   * @param {{loopBefore?: Array, loopAfter?: Array}} [outline]
   *   The lasso outline on either side of the transform. It is carried on the
   *   op so undo can put the ink and the shape drawn round it back together:
   *   reverting the points alone left the orange loop sitting where the ink no
   *   longer was, describing a selection that had ceased to exist.
   */
  recordTransform(before, after, outline = {}) {
    if (!before?.length) return;
    this.record({
      type: INK_OPS.TRANSFORM,
      before,
      after,
      loopBefore: outline.loopBefore || null,
      loopAfter: outline.loopAfter || null,
    });
  }

  /**
   * @param {Array<{id:string, color:string}>} before 各自原来的颜色
   * @param {string} color 新的颜色
   */
  recordRestyle(before, color) {
    if (!before?.length) return;
    this.record({ type: INK_OPS.RESTYLE, before, color });
  }

  /**
   * 填充换了。和换色是同一种操作——改的是样子不是形——只是改的那一样不同，所以
   * 同一个 type，带一个 field。
   *
   * @param {Array<{id:string, fill:?string}>} before 各自原来的填充（null 是没填）
   * @param {?string} fill 新的填充
   */
  recordRefill(before, fill) {
    if (!before?.length) return;
    this.record({ type: INK_OPS.RESTYLE, field: 'fill', before, fill });
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

  /** @returns {object|null} the operation that was reverted, for the caller. */
  undo() {
    const op = this.undoStack.pop();
    if (!op) return null;
    this._revert(op);
    this.redoStack.push(op);
    this._changed();
    return op;
  }

  /** @returns {object|null} the operation that was re-applied. */
  redo() {
    const op = this.redoStack.pop();
    if (!op) return null;
    this._apply(op);
    this.undoStack.push(op);
    this._changed();
    return op;
  }

  _revert(op) {
    switch (op.type) {
      case INK_OPS.BATCH:
        // Backwards: the last thing done is the first thing taken back.
        for (let i = op.ops.length - 1; i >= 0; i--) this._revert(op.ops[i]);
        break;
      case INK_OPS.ADD:
        this.layer.removeByIds([op.stroke.id]);
        break;
      case INK_OPS.ERASE:
      case INK_OPS.CLEAR:
        // Restored at their original indices, so z-order survives the round trip.
        this.layer.restore(op.entries);
        // 有「另一半」的擦除，另一半也要跟着回去——见 recordErase。
        try { op.onUndo?.(); } catch (_) { /* 那一栏可能已经关掉了 */ }
        break;
      case INK_OPS.SPLIT:
        // Take the fragments out before putting the originals back, or the
        // restored indices land among strokes that should not be there.
        this.layer.removeByIds(op.added.map(e => e.stroke.id));
        this.layer.restore(op.removed);
        break;
      case INK_OPS.TRANSFORM:
        restorePoints(this.layer, op.before);
        break;
      case INK_OPS.RESTYLE:
        for (const entry of op.before) {
          const stroke = this.layer.getById(entry.id);
          if (!stroke) continue;
          if (op.field === 'fill') stroke.fill = entry.fill;
          else stroke.color = entry.color;
        }
        break;
      default:
        break;
    }
  }

  _apply(op) {
    switch (op.type) {
      case INK_OPS.BATCH:
        // Forwards, in the order the gesture actually happened.
        for (const inner of op.ops) this._apply(inner);
        break;
      case INK_OPS.ADD:
        this.layer.insertAt(op.index, op.stroke);
        break;
      case INK_OPS.ERASE:
      case INK_OPS.CLEAR:
        this.layer.removeByIds(op.entries.map(e => e.stroke.id));
        try { op.onRedo?.(); } catch (_) { /* 同上 */ }
        break;
      case INK_OPS.SPLIT:
        this.layer.removeByIds(op.removed.map(e => e.stroke.id));
        this.layer.restore(op.added);
        break;
      case INK_OPS.TRANSFORM:
        restorePoints(this.layer, op.after);
        break;
      case INK_OPS.RESTYLE:
        for (const { id } of op.before) {
          const stroke = this.layer.getById(id);
          if (!stroke) continue;
          if (op.field === 'fill') stroke.fill = op.fill;
          else stroke.color = op.color;
        }
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
