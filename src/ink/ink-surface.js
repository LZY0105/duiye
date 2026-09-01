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
  eraseStrokes,
  strokeIdsAlongPath,
} from './ink-eraser.js';
import {
  createTransform,
  drawStroke,
  renderLayer,
  screenToDocument,
} from './ink-renderer.js';

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

    this._bind();
  }

  // ── configuration ─────────────────────────────────────────────────────────

  setTool(tool) {
    if (tool === 'eraser') {
      this.erasing = true;
      return;
    }
    this.erasing = false;
    this.tool = tool;
    this.width = TOOL_DEFAULTS[tool]?.width ?? this.width;
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
    this.canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._viewport = { width: cssWidth, height: cssHeight };
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
  _eraseAlong() {
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
