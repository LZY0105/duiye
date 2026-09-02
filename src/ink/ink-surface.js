// Ink Module — the interactive ink surface.
//
// Binds an InkLayer to its OWN canvas, stacked above the PDF canvas. The two
// canvases are separate elements: ink drawing, erasing and clearing all target
// this one, so there is no code path by which ink can modify the page bitmap.
//
// Input arrives in screen pixels and is converted to document space before
// being stored, so what is persisted is independent of the zoom it was drawn
// at — the same reason zooming in later is lossless.

import { InkLayer } from './ink-layer.js';
import { InkHistory } from './ink-history.js';
import {
  INK_TOOLS,
  TOOL_DEFAULTS,
  appendPoint,
  createStroke,
  isDrawable,
} from './stroke.js';
import {
  ERASER_MODES,
  eraseArea,
  eraseStrokes,
  strokeIdsAlongPath,
  strokeIdsInRegion,
} from './ink-eraser.js';
import {
  boundsCentre,
  pointInBounds,
  selectInPolygon,
  selectionBounds,
  snapshotStrokes,
  transformSelection,
} from './ink-selection.js';
import {
  createTransform,
  drawLasso,
  drawStroke,
  renderLayer,
  screenToDocument,
} from './ink-renderer.js';

/** Whether a gesture actually changed anything worth recording. */
function moved(before, after) {
  if (!before || !after || before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) {
    const a = before[i].points;
    const b = after[i].points;
    if (a.length !== b.length) return true;
    for (let j = 0; j < a.length; j++) {
      if (Math.abs(a[j].x - b[j].x) > 1e-6 || Math.abs(a[j].y - b[j].y) > 1e-6) return true;
    }
  }
  return false;
}

/** Radius of the rotate/scale handle, in screen pixels. */
const SELECT_HANDLE = 9;

export const INPUT_MODES = Object.freeze({
  /** Draw with any pointer. */
  ANY: 'any',
  /** Draw only with a stylus; finger and mouse pan the page instead. */
  STYLUS_ONLY: 'stylus',
});

export class InkSurface {
  /**
   * @param {HTMLCanvasElement} canvas the ink canvas (never the PDF canvas)
   * @param {{onChange?: function, onHistoryChange?: function}} handlers
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;

    this.layer = new InkLayer();
    this.history = new InkHistory(this.layer, {
      onChange: () => this.handlers.onHistoryChange?.(this.history),
    });

    this.transform = createTransform(1, 0, 0);
    this.tool = INK_TOOLS.PEN;
    this.color = '#111827';
    this.width = TOOL_DEFAULTS[INK_TOOLS.PEN].width;
    // undefined means "use the tool's own default"; a number overrides it.
    this.opacity = undefined;
    this.eraserMode = ERASER_MODES.STROKE;
    this.eraserRadius = 8;
    this.inputMode = INPUT_MODES.ANY;
    this.enabled = true;
    this.erasing = false;

    this._active = null;      // in-progress stroke
    this._eraserPath = null;  // in-progress eraser drag, document space
    this._eraserDot = null;   // the eraser head while it is down, document space
    this._pointerId = null;

    // ── lasso ──
    this.selecting = false;   // the lasso tool is the active tool
    this.selection = [];      // ids, document order irrelevant
    this._loop = null;        // the lasso being drawn, document space
    this._grab = null;        // an in-progress move/rotate/scale of the selection

    this._bind();
  }

  // ── configuration ─────────────────────────────────────────────────────────

  setTool(tool) {
    if (tool === 'eraser') {
      this.erasing = true;
      this.selecting = false;
      this.clearSelection();
      return;
    }
    if (tool === 'lasso') {
      this.selecting = true;
      this.erasing = false;
      return;
    }
    this.erasing = false;
    // Leaving the lasso drops the selection: a highlighted set that no gesture
    // can act on any more is just decoration on the page.
    if (this.selecting) this.clearSelection();
    this.selecting = false;
    this.tool = tool;
    this.width = TOOL_DEFAULTS[tool]?.width ?? this.width;
  }

  clearSelection() {
    if (!this.selection.length && !this._loop) return;
    this.selection = [];
    this._loop = null;
    this._grab = null;
    this.render();
  }

  /** The selection's box in document space, recomputed on demand. */
  selectionBox() {
    return selectionBounds(this.layer, this.selection);
  }

  setEraser(mode) {
    this.erasing = true;
    this.eraserMode = mode === ERASER_MODES.REGION ? ERASER_MODES.REGION : ERASER_MODES.STROKE;
  }

  setColor(color) { this.color = color; }
  setWidth(width) { this.width = Math.max(0.2, Number(width) || this.width); }

  /**
   * Opacity for strokes drawn from now on.
   *
   * Applies to NEW strokes only — changing it must not reach back and repaint
   * existing ones, which would silently rewrite work the user already did.
   */
  setOpacity(opacity) {
    const value = Number(opacity);
    if (Number.isFinite(value)) this.opacity = Math.min(1, Math.max(0, value));
  }
  setInputMode(mode) { this.inputMode = mode; }
  setEnabled(enabled) { this.enabled = !!enabled; }

  /** Called by the host pane whenever its zoom or pan changes. */
  setTransform(scale, offsetX, offsetY) {
    this.transform = createTransform(scale, offsetX, offsetY);
    this.render();
  }

  /** Resizes the backing store to match the CSS box; contents are repainted. */
  resize(cssWidth, cssHeight, dpr = 1) {
    const w = Math.max(1, Math.floor(cssWidth * dpr));
    const h = Math.max(1, Math.floor(cssHeight * dpr));

    // Only touch the backing store when it actually changes size.
    //
    // Assigning canvas.width reallocates and clears the bitmap even when the
    // value is identical — and this is called from _syncInk on every position
    // change, which means every frame of a pan. A 1.6MP surface was being
    // thrown away and rebuilt, and every stroke repainted, sixty times a second
    // while dragging a page that had not resized at all.
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this._viewport = { width: cssWidth, height: cssHeight };
    // The repaint stays: the transform may have moved even when the size did not.
    this.render();
  }

  // ── layer lifecycle ───────────────────────────────────────────────────────

  /** Swaps in a page's ink; history starts clean for the new page. */
  loadLayer(layer) {
    this.layer = layer || new InkLayer();
    this.history = new InkHistory(this.layer, {
      onChange: () => this.handlers.onHistoryChange?.(this.history),
    });
    this.render();
    this.handlers.onHistoryChange?.(this.history);
  }

  getLayer() { return this.layer; }

  // ── rendering ─────────────────────────────────────────────────────────────

  render() {
    if (!this._viewport) return;
    renderLayer(this.ctx, this.layer, this.transform, this._viewport);
    // The in-progress stroke is drawn on top so it appears live, before it is
    // committed to the layer on pointerup.
    if (this._active && isDrawable(this._active)) {
      drawStroke(this.ctx, this._active, this.transform);
    }
    if (this._eraserDot) this._drawEraserDot();
    if (this._loop) drawLasso(this.ctx, this._loop, this.transform);
    if (this.selection.length) this._drawSelection();
  }

  /**
   * The selection frame and its one handle.
   *
   * A dashed box says what is caught; the handle in the corner is where rotate
   * and scale live. There is deliberately one handle rather than eight: this is
   * a stylus interface, eight 8px targets round a box is a precision task, and
   * the gesture people actually want on a diagram is "turn it and size it",
   * which one handle does in a single movement.
   */
  _drawSelection() {
    const box = this.selectionBox();
    if (!box) return;
    const t = this.transform;
    const x = (box.minX - t.offsetX) * t.scale;
    const y = (box.minY - t.offsetY) * t.scale;
    const w = (box.maxX - box.minX) * t.scale;
    const h = (box.maxY - box.minY) * t.scale;

    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(10, 96, 255, 0.9)';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(10, 96, 255, 0.06)';
    ctx.fillRect(x, y, w, h);

    // The handle, bottom-right of the box.
    ctx.beginPath();
    ctx.arc(x + w, y + h, SELECT_HANDLE, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(10, 96, 255, 0.95)';
    ctx.stroke();
    ctx.restore();
  }

  /** Screen-space position of the transform handle, or null. */
  _handleAt() {
    const box = this.selectionBox();
    if (!box) return null;
    const t = this.transform;
    return {
      x: (box.maxX - t.offsetX) * t.scale,
      y: (box.maxY - t.offsetY) * t.scale,
    };
  }

  /**
   * The eraser head, drawn where the pointer is.
   *
   * An eraser you cannot see is an eraser you aim by guessing: region erasing
   * used to draw a lasso outline that only told you where you had BEEN, never
   * what the next press would take. This is the head itself, at its real
   * radius, so the area about to be cleared is the area under the dot.
   */
  _drawEraserDot() {
    const { x, y } = this._eraserDot;
    const r = Math.max(2, this.eraserRadius * this.transform.scale);
    const px = x * this.transform.scale - this.transform.offsetX * this.transform.scale;
    const py = y * this.transform.scale - this.transform.offsetY * this.transform.scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.10)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
    ctx.stroke();
    ctx.restore();
  }

  // ── input ─────────────────────────────────────────────────────────────────

  _shouldDraw(e) {
    if (!this.enabled) return false;
    // Palm rejection: a hand resting on the tablet raises secondary touch
    // pointers, which must not each start their own stroke.
    if (e.pointerType === 'touch' && e.isPrimary === false) return false;
    if (this.inputMode === INPUT_MODES.STYLUS_ONLY) return e.pointerType === 'pen';
    return true;
  }

  _docPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return screenToDocument(this.transform, e.clientX - rect.left, e.clientY - rect.top);
  }

  /** Devices with no pressure report 0; treat that as neutral rather than zero width. */
  static _pressure(e) {
    if (e.pointerType === 'pen' && e.pressure > 0) return e.pressure;
    return 0.5;
  }

  _bind() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      // Not a drawing pointer: let the event bubble to the pane so the page can
      // be panned. The ink canvas covers the viewport, so swallowing events it
      // does not use would make the document immovable.
      if (!this._shouldDraw(e)) return;
      e.preventDefault();

      // Say so BEFORE the stroke is built.
      //
      // The next line stops propagation, and the pane's own pointerdown — the
      // one that marks this pane active — is upstream of it. So while ink was
      // claiming the pointer, drawing on a pane never made it the active pane:
      // the shared toolbar went on pushing tool, colour, width and eraser mode
      // to whichever pane was active before, and this surface kept whatever it
      // was last given. That is why selecting the highlighter or the eraser, or
      // changing colour, appeared to do nothing and every stroke came out as
      // the same marker.
      //
      // It has to run before `createStroke` reads this.tool/color/width below,
      // because the host answers by pushing the current tool state back to us.
      this.handlers.onDrawStart?.();

      // Claimed for ink — the pane must not also treat it as a pan drag.
      e.stopPropagation();
      this._pointerId = e.pointerId;
      c.setPointerCapture(e.pointerId);
      const pt = this._docPoint(e);

      if (this.selecting) {
        this._beginSelectionGesture(pt, e);
        return;
      }

      if (this.erasing) {
        // Both modes are a head you drag; they differ in what they take.
        // STROKE lifts a whole stroke it touches. REGION clears the area under
        // the head — press, a dot appears, and what the dot covers goes.
        //
        // REGION used to be a lasso: you drew a closed outline and everything
        // inside it vanished on release. That is a selection gesture, not an
        // eraser, and nothing showed what was about to be removed.
        this._eraserDot = pt;
        this._eraserPath = [pt];
        this._eraseAlong();
        this.render();
        return;
      }

      this._active = createStroke({
        tool: this.tool,
        color: this.color,
        width: this.width,
        opacity: this.opacity,
      });
      appendPoint(this._active, pt.x, pt.y, InkSurface._pressure(e));
      this.render();
    });

    c.addEventListener('pointermove', (e) => {
      if (this._pointerId !== e.pointerId) return;
      e.stopPropagation();
      const pt = this._docPoint(e);

      if (this._grab) {
        this._dragSelection(pt);
        return;
      }
      if (this._loop) {
        this._loop.push(pt);
        this.render();
        return;
      }

      if (this._eraserDot) {
        // The head follows the pointer and takes what it passes over, so the
        // erase is continuous rather than committed on release.
        this._eraserDot = pt;
        this._eraserPath.push(pt);
        this._eraseAlong();
        this.render();
        return;
      }
      if (!this._active) return;

      // Coalesced events keep fast strokes smooth without raising the sample
      // rate the rest of the time.
      const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      if (samples.length > 1) {
        for (const sample of samples) {
          const sp = this._docPoint(sample);
          appendPoint(this._active, sp.x, sp.y, InkSurface._pressure(sample));
        }
      } else {
        appendPoint(this._active, pt.x, pt.y, InkSurface._pressure(e));
      }
      this.render();
    });

    const finish = (e) => {
      if (this._pointerId !== e.pointerId) return;
      e.stopPropagation();
      try { c.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      this._pointerId = null;

      if (this._grab) {
        // ONE history entry for the whole gesture.
        //
        // The transform is applied incrementally, a delta per pointer event, so
        // recording each of those would put fifty steps on the undo stack for
        // one drag and make undo useless. The snapshot taken when the gesture
        // began is compared with where it ended, and that pair is the step.
        const before = this._grab.before;
        this._grab = null;
        const after = snapshotStrokes(this.layer, this.selection);
        if (before?.length && moved(before, after)) {
          this.history?.recordTransform(before, after);
          this.handlers.onChange?.(this.layer);
        }
        this.render();
        return;
      }
      if (this._loop) {
        const loop = this._loop;
        this._loop = null;
        this.selection = loop.length >= 3
          ? selectInPolygon(this.layer, loop, strokeIdsInRegion)
          : [];
        this.render();
        return;
      }

      if (this._eraserDot) {
        this._eraserDot = null;
        this._eraserPath = null;
        this.render();
        return;
      }

      if (this._eraserPath) {
        this._eraserPath = null;
        this.render();
        return;
      }

      const stroke = this._active;
      this._active = null;
      if (stroke && isDrawable(stroke)) {
        const index = this.layer.add(stroke);
        this.history.recordAdd(stroke, index);
        this.handlers.onChange?.(this.layer);
      }
      this.render();
    };

    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);
  }

  /** Erases along the current eraser drag, coalescing into one undo step. */
  /**
   * Applies the eraser at its current position.
   *
   * The two modes take different things, which is the whole distinction between
   * them: STROKE lifts any whole stroke the head touches, REGION takes only the
   * ink under the head and leaves the rest of the stroke behind, cut.
   */
  /**
   * Decides what a press means while the lasso tool is active.
   *
   * Three possibilities, resolved by where the press lands: on the handle it
   * rotates and scales; inside an existing selection it moves it; anywhere else
   * it starts a new loop and abandons the old selection.
   */
  _beginSelectionGesture(pt, e) {
    const handle = this._handleAt();
    if (handle && this.selection.length) {
      const sx = (pt.x - this.transform.offsetX) * this.transform.scale;
      const sy = (pt.y - this.transform.offsetY) * this.transform.scale;
      const near = Math.hypot(sx - handle.x, sy - handle.y) <= SELECT_HANDLE * 2.4;
      if (near) {
        const box = this.selectionBox();
        const origin = boundsCentre(box);
        this._grab = {
          mode: 'transform',
          before: snapshotStrokes(this.layer, this.selection),
          origin,
          startAngle: Math.atan2(pt.y - origin.y, pt.x - origin.x),
          startDistance: Math.max(1e-3, Math.hypot(pt.x - origin.x, pt.y - origin.y)),
          last: { angle: 0, scale: 1 },
        };
        return;
      }
    }

    const box = this.selectionBox();
    if (box && this.selection.length && pointInBounds(box, pt.x, pt.y)) {
      this._grab = { mode: 'move', last: pt, before: snapshotStrokes(this.layer, this.selection) };
      return;
    }

    this.selection = [];
    this._loop = [pt];
    this.render();
  }

  /**
   * Applies one increment of the live gesture.
   *
   * Increments, not absolutes: each move applies the delta since the last
   * event, so the strokes' own points are the running state and there is no
   * separate pending matrix that could disagree with them. It also means undo
   * gets one entry per event rather than one per gesture — which is why the
   * surface coalesces them below.
   */
  _dragSelection(pt) {
    const g = this._grab;
    if (!g) return;

    if (g.mode === 'move') {
      const dx = pt.x - g.last.x;
      const dy = pt.y - g.last.y;
      g.last = pt;
      if (transformSelection(this.layer, null, this.selection, { dx, dy })) {
        this.render();
      }
      return;
    }

    const angleNow = Math.atan2(pt.y - g.origin.y, pt.x - g.origin.x);
    const distNow = Math.max(1e-3, Math.hypot(pt.x - g.origin.x, pt.y - g.origin.y));
    const angle = (angleNow - g.startAngle) - g.last.angle;
    const scale = (distNow / g.startDistance) / g.last.scale;
    g.last = { angle: angleNow - g.startAngle, scale: distNow / g.startDistance };

    // Rotation and scale in ONE step about the selection's centre, which is
    // what makes turning and resizing a single continuous movement instead of
    // two that fight over the origin.
    if (transformSelection(this.layer, null, this.selection,
      { origin: g.origin, angle, scale })) {
      this.render();
    }
  }

  _eraseAlong() {
    if (this.eraserMode === ERASER_MODES.REGION) {
      const head = this._eraserDot;
      if (!head) return;
      if (eraseArea(this.layer, this.history, { x: head.x, y: head.y, radius: this.eraserRadius })) {
        this.handlers.onChange?.(this.layer);
        this.render();
      }
      return;
    }

    const ids = strokeIdsAlongPath(this.layer, this._eraserPath, this.eraserRadius);
    if (!ids.length) return;
    const removed = eraseStrokes(this.layer, this.history, ids);
    if (removed.length) {
      this.handlers.onChange?.(this.layer);
      this.render();
    }
  }

  // ── commands ──────────────────────────────────────────────────────────────

  undo() {
    if (!this.history.undo()) return false;
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  redo() {
    if (!this.history.redo()) return false;
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  /** Clears ink only. The PDF canvas is a different element entirely. */
  clear() {
    const removed = this.layer.clear();
    if (!removed.length) return false;
    this.history.recordClear(removed);
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  canUndo() { return this.history.canUndo(); }
  canRedo() { return this.history.canRedo(); }
  isEmpty() { return this.layer.isEmpty(); }
}
