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
  pointInPolygon,
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
  handleIndex,
  nearestIndex,
  polygonBounds,
  rectLoop,
  selectInPolygon,
  selectionBounds,
  transformPolygon,
  snapshotStrokes,
  transformSelection,
} from './ink-selection.js';
import {
  LASSO_STROKE,
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

/**
 * Radius of the rotate/scale handle, in screen pixels at 100% page zoom.
 *
 * It is sized against what it MANIPULATES, not pinned to an absolute number.
 * A control that holds still while the thing it belongs to grows and shrinks
 * does not read as attached to it, and the failure is worst in the shrinking
 * direction: scale a selection down to a quarter and a fixed dot ends up
 * larger than the ink it is supposed to be a corner of.
 *
 * Two influences, and the smaller wins:
 *   - the page zoom, damped by a square root, so it always responds across the
 *     whole practical range instead of moving 1:1 and running away at 4x;
 *   - the selection's own on-screen size, capped at HANDLE_SHARE of its
 *     shorter side, which is what makes it shrink with the selection.
 *
 * Then clamped, because it is still a touch target: it may not shrink below
 * something a stylus can land on, and it may not grow into a blob that hides
 * the ink underneath it.
 */
const SELECT_HANDLE = 9;
const HANDLE_MIN = 6;
const HANDLE_MAX = 20;
/** Never more than this fraction of the selection's shorter on-screen side. */
const HANDLE_SHARE = 0.18;
/** The hit target may not follow the dot all the way down. */
const HANDLE_HIT_MIN = 15;

/**
 * Minimum spacing between lasso samples, in document units.
 *
 * A hand-drawn loop only needs enough points to keep its curve; anything
 * closer than this is the stylus reporting that it has not moved yet.
 */
const LOOP_SPACING = 2;

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
    this.selectionLoop = null; // the closed loop that caught it, document space
    this._anchor = -1;        // which loop vertex carries the transform handle
    this._loopFrom = null;    // where a rectangle lasso started
    this.lassoShape = 'free';
    this.lassoInside = false; // require strokes to fall entirely inside
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

  /** Shape of the loop, and what counts as caught. */
  setLasso({ shape, mode } = {}) {
    if (shape === 'free' || shape === 'rect') this.lassoShape = shape;
    if (mode === 'touch' || mode === 'inside') this.lassoInside = mode === 'inside';
  }

  clearSelection() {
    if (!this.selection.length && !this._loop) return;
    this.selection = [];
    this.selectionLoop = null;
    this._anchor = -1;
    this._loop = null;
    this._loopFrom = null;
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
    // The tip ring marks where a freehand loop will close back to. A dragged
    // rectangle has no such point — it is already closed, and a ring on one of
    // its corners would only claim a meaning it does not have.
    if (this._loop) {
      drawLasso(this.ctx, this._loop, this.transform, {
        tip: this.lassoShape !== 'rect',
        closed: this.lassoShape === 'rect',
      });
    }
    if (this.selection.length) this._drawSelection();
  }

  /**
   * The selection outline: the loop the user drew, kept.
   *
   * Not a bounding box. The lasso IS the shape — you draw a line round the
   * working you meant and that line is what stays on screen, closed and
   * dashed. A box would answer a different question: it would show the extent
   * of what was caught rather than what you asked for, and around anything
   * diagonal or L-shaped it would claim a large area of blank page that is not
   * part of the selection at all.
   *
   * The loop travels with the ink under every move, rotation and scale, so it
   * never stops describing what it holds.
   *
   * One handle carries rotate and scale, pinned to a VERTEX of the loop — the
   * lower-right extreme to begin with, and thereafter whichever vertex the
   * user grabbed. Deliberately one handle rather than eight: this is a stylus
   * interface, eight 8px targets round a shape is a precision task, and the
   * gesture a diagram actually wants is "turn it and size it", which one handle
   * does in a single movement.
   */
  _drawSelection() {
    const loop = this.selectionLoop;
    if (!loop || loop.length < 3) return;

    // The SAME renderer that drew it while the hand was moving, so releasing
    // the stylus does not change how the loop looks. It only closes.
    drawLasso(this.ctx, loop, this.transform, { closed: true });

    const handle = this._handleAt();
    if (!handle) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    const r = this._handleRadius();
    ctx.arc(handle.x, handle.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    // The ring's weight goes with its size. A 2px outline on a 40px dot reads
    // as a thin hoop, and on a 12px one it swallows the white centre.
    ctx.lineWidth = Math.min(3, Math.max(1.5, r / 4.5));
    ctx.strokeStyle = LASSO_STROKE;
    ctx.stroke();
    ctx.restore();
  }

  /** Drawn radius of the handle at the current zoom, in screen pixels. */
  _handleRadius() {
    const zoom = this.transform?.scale || 1;
    // sqrt, not the zoom itself: 1:1 would double the dot every time the page
    // doubles, which is a blob at 4x and invisible at a quarter. Damped, it
    // still moves everywhere in between — which is the whole point.
    let r = SELECT_HANDLE * Math.sqrt(zoom);

    const box = polygonBounds(this.selectionLoop);
    if (box) {
      const w = (box.maxX - box.minX) * zoom;
      const h = (box.maxY - box.minY) * zoom;
      r = Math.min(r, Math.min(w, h) * HANDLE_SHARE);
    }
    return Math.min(HANDLE_MAX, Math.max(HANDLE_MIN, r));
  }

  /**
   * How close a press has to be to count as grabbing the handle.
   *
   * Tracks the drawn dot, so aim and appearance never part company — but with
   * a floor of its own. On a very small selection the dot is deliberately
   * tiny, and a hit target that shrank with it all the way down would leave a
   * handle that can be seen and not pressed.
   */
  _handleHitRadius() {
    return Math.max(HANDLE_HIT_MIN, this._handleRadius() * 2.4);
  }

  /** Document point → canvas pixel. */
  _toScreen(p) {
    const t = this.transform;
    return { x: (p.x - t.offsetX) * t.scale, y: (p.y - t.offsetY) * t.scale };
  }

  /**
   * Screen-space position of the transform handle, or null.
   *
   * Reads the pinned vertex rather than searching for one, so the handle moves
   * with the loop instead of hopping between its points as the shape turns.
   */
  _handleAt() {
    const loop = this.selectionLoop;
    if (loop && this._anchor >= 0 && this._anchor < loop.length) {
      return this._toScreen(loop[this._anchor]);
    }
    const box = this.selectionBox();
    return box ? this._toScreen({ x: box.maxX, y: box.maxY }) : null;
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
        this._beginSelectionGesture(pt);
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
        // A rectangle is not sampled: it is redrawn from the two corners, so
        // the box always has exactly four points however far the hand wandered
        // getting to the second one.
        if (this.lassoShape === 'rect') {
          this._loop = rectLoop(this._loopFrom, pt);
          this.render();
          return;
        }
        // Only sample where the hand actually went somewhere. A stylus reports
        // at 120Hz or better, so an unfiltered loop arrives with hundreds of
        // near-identical points — every one of which would then be rotated and
        // scaled on every frame of the next gesture, and tested on every press.
        const last = this._loop[this._loop.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) >= LOOP_SPACING) {
          this._loop.push(pt);
          this.render();
        }
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
        this._loopFrom = null;
        this.selection = loop.length >= 3
          ? selectInPolygon(this.layer, loop, strokeIdsInRegion, this.lassoInside)
          : [];
        // The loop is only kept when it caught something. An outline round
        // empty page is not a selection, and leaving it on screen would offer
        // a handle that transforms nothing.
        this.selectionLoop = this.selection.length ? loop : null;
        this._anchor = this.selectionLoop ? handleIndex(loop) : -1;
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

  /**
   * Decides what a press means while the lasso tool is active.
   *
   * Three possibilities, resolved by where the press lands: on the handle it
   * rotates and scales; inside an existing selection it moves it; anywhere else
   * it starts a new loop and abandons the old selection.
   */
  _beginSelectionGesture(pt) {
    const handle = this._handleAt();
    if (handle && this.selection.length) {
      const sx = (pt.x - this.transform.offsetX) * this.transform.scale;
      const sy = (pt.y - this.transform.offsetY) * this.transform.scale;
      // Measured against what is DRAWN, not against a constant. A hit radius
      // that ignored the zoom would drift away from the dot the user is aiming
      // at — generous at one zoom, unreachable at another.
      const near = Math.hypot(sx - handle.x, sy - handle.y) <= this._handleHitRadius();
      if (near) {
        // Pin the handle to the loop vertex nearest the press, for the whole
        // gesture. The handle is then under the finger that grabbed it and
        // stays there while the shape turns and grows, instead of sliding
        // around the outline as the down-right extreme changes.
        const pinned = nearestIndex(this.selectionLoop, pt.x, pt.y);
        if (pinned >= 0) this._anchor = pinned;

        // The loop's centre, not the ink's. The user is turning the shape
        // they drew, and pivoting about a point that shape is not centred on
        // makes the selection swing rather than rotate.
        const box = polygonBounds(this.selectionLoop) || this.selectionBox();
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

    // Inside the LOOP, not inside its bounding box: pressing in the empty
    // corner of a diagonal selection's box is a press on the page, and it
    // should start a new lasso rather than drag ink the user never enclosed.
    const loop = this.selectionLoop;
    if (this.selection.length && loop && pointInPolygon(pt.x, pt.y, loop)) {
      this._grab = { mode: 'move', last: pt, before: snapshotStrokes(this.layer, this.selection) };
      return;
    }

    this.selection = [];
    this.selectionLoop = null;
    this._anchor = -1;
    this._loopFrom = pt;
    this._loop = this.lassoShape === 'rect' ? rectLoop(pt, pt) : [pt];
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
        this.selectionLoop = transformPolygon(this.selectionLoop, { dx, dy });
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
    const step = { origin: g.origin, angle, scale };
    if (transformSelection(this.layer, null, this.selection, step)) {
      this.selectionLoop = transformPolygon(this.selectionLoop, step);
      this.render();
    }
  }

  /**
   * Applies the eraser at its current position, coalescing one drag into one
   * undo step.
   *
   * The two modes take different things, which is the whole distinction between
   * them: STROKE lifts any whole stroke the head touches, REGION takes only the
   * ink under the head and leaves the rest of the stroke behind, cut.
   */
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
