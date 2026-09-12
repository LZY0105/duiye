// Scratch Module — one scratchpad, filling its pane (F05, F06, F10, F11).
//
// The counterpart of PdfPane, and deliberately the same shape: the workspace
// holds one or the other in a slot and drives both through isLoaded, resize,
// unload and a handful of commands. What differs is everything underneath —
// there is no page, no page count, no outline, no answer lookup and no fit
// mode, because there is no page.
//
// The surface is BORDERLESS (V2.1). No inset paper card, no page shadow, no
// fixed aspect ratio, no reserved strip at the bottom for stacked edges: the
// pane's whole drawable area is one continuous sheet, and panning can never
// reveal an outside edge because there is no outside.
//
// Two canvases, stacked, sharing one camera:
//   background   the paper tone and its guides, redrawn for the visible region
//   ink          the existing InkSurface, unchanged, driven by the same transform
//
// The ink canvas is viewport-sized whatever the zoom, so the backing bitmap is
// bounded by the screen rather than by how far the reader has written. That is
// what makes "infinite" a property of the coordinate system rather than of any
// allocation.

import { InkSurface } from '../ink/ink-surface.js';
import { loadLayer, saveLayer } from '../ink/ink-store.js';
import { notifyPeers, releaseLayer, shareLayer } from '../ink/ink-shared.js';
import {
  createCamera,
  displayZoom,
  fitToBounds,
  panByScreen,
  returnToOrigin,
  sameCamera,
  serializeCamera,
  transformFor,
  zoomAbout,
  zoomIn,
  zoomOut,
} from './scratch-camera.js';
import { drawScratchBackground } from './scratch-background.js';
import { createScratchStyle } from './scratch-style.js';
import { SCRATCH_PAGE, setScratchpadCamera } from './scratch-store.js';

/**
 * What the save indicator can say.
 *
 * SAVING is a real state and is shown as one. A pad that is still being written
 * must not display Saved — the specification is explicit that only a committed
 * write earns that word, and a failure has to stay visible and retryable rather
 * than being logged where nobody will look.
 */
export const SAVE_STATES = Object.freeze({
  SAVED: 'saved',
  UNSAVED: 'unsaved',
  SAVING: 'saving',
  FAILED: 'failed',
});

/** How long after a completed stroke the ink is written. */
const INK_SAVE_DEBOUNCE = 500;

/** And how long after the camera settles it is filed. */
const CAMERA_SETTLE = 400;

/** Travel before a one-finger drag becomes a pan rather than a wandering tap. */
const PAN_GRAB = 4;

export class ScratchPane {
  /**
   * @param {HTMLElement} root element this pane renders into
   * @param {{onStateChange?: function, onFocus?: function,
   *          onInkHistoryChange?: function, onSaveStateChange?: function}} handlers
   */
  constructor(root, handlers = {}, services = {}) {
    this.root = root;
    this.handlers = handlers;
    // Injectable so the save/failure paths — which are the ones that must never
    // lose someone's working — can be exercised without a database.
    this._store = {
      loadLayer: services.loadLayer || loadLayer,
      saveLayer: services.saveLayer || saveLayer,
      setScratchpadCamera: services.setScratchpadCamera || setScratchpadCamera,
    };
    this.pad = null;
    this.camera = createCamera();
    this.saveState = SAVE_STATES.SAVED;

    this._inkSaveTimer = null;
    this._cameraTimer = null;
    this._loadToken = 0;
    /** Serialises writes so a slow save cannot be overtaken by a later one. */
    this._writes = Promise.resolve();
    /**
     * The revision an in-flight save is committing.
     *
     * An acknowledgement belongs only to the ink it captured: a write that
     * started before the last three strokes cannot mark them saved. Compared on
     * completion, and anything newer leaves the pad unsaved — which is the
     * difference between "saved" and "a save finished".
     */
    this._inkRevision = 0;
    this._savingRevision = -1;

    this._buildDom();

    this.ink = new InkSurface(this.elInk, {
      onChange: () => this._inkChanged(),
      onHistoryChange: () => this.handlers.onInkHistoryChange?.(this.ink),
      onDrawStart: () => this.handlers.onFocus?.(),
    });
    this.ink.setEnabled(false);

    this._bindGestures();
  }

  _buildDom() {
    this.root.classList.add('scratch-pane');
    // No paper card and no inner margin: the viewport IS the sheet. The two
    // canvases are siblings filling it, so nothing about the layout implies an
    // edge the surface does not have.
    this.root.innerHTML = `
      <div class="scratch-viewport" data-role="viewport">
        <canvas class="scratch-paper" data-role="paper" aria-hidden="true"></canvas>
        <canvas class="pdf-ink-canvas scratch-ink" data-role="ink"></canvas>
      </div>
    `;
    this.elViewport = this.root.querySelector('[data-role="viewport"]');
    this.elPaper = this.root.querySelector('[data-role="paper"]');
    this.elInk = this.root.querySelector('[data-role="ink"]');
    this.paperCtx = this.elPaper.getContext('2d');
  }

  isLoaded() { return !!this.pad; }

  /** The pad's name, for the switching strip and the style panel's title. */
  get name() { return this.pad?.name || ''; }

  _viewport() {
    const rect = this.elViewport.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }

  // ── loading ───────────────────────────────────────────────────────────────

  /**
   * Shows a pad.
   *
   * `isCurrent` lets a superseded load stop before it touches the pane, exactly
   * as PdfPane's does: switching quickly between two pads must not leave the
   * slower load's ink on screen under the faster one's name.
   */
  async loadPad(pad, { isCurrent = () => true } = {}) {
    const token = ++this._loadToken;
    const mine = () => isCurrent() && this._loadToken === token;

    // Whatever is on screen is committed before it is replaced. The debounce
    // would otherwise lose the last half-second of writing — and a write that
    // FAILS stops the load, because installing the next pad would release the
    // only copy of the strokes that did not get saved.
    if (this.pad && !(await this.flush())) return false;
    if (!mine()) return false;

    // 手里那本先还给登记处，再去领新的那本。
    this._dropInk(this.pad?.id);
    this.pad = pad;
    this.camera = createCamera(pad.camera);
    this.style = createScratchStyle(pad.style);

    const layer = this._takeInk(pad.id, await this._store.loadLayer(pad.id, SCRATCH_PAGE));
    if (!mine()) {
      // 读的工夫里这一栏换了人。刚领的那一份不还就永远挂着。
      this._dropInk(pad.id);
      return false;
    }

    this.ink.setEnabled(true);
    this.ink.loadLayer(layer);
    this._inkRevision = 0;
    this._savingRevision = -1;
    this._setSaveState(SAVE_STATES.SAVED);
    this.resize();
    this.handlers.onStateChange?.(this);
    return true;
  }

  /**
   * Puts the pad away, committing anything outstanding first.
   *
   * Deliberately not awaited by every caller: the write is started here and
   * chained, so a pane can be torn down without the UI waiting on storage — but
   * the write itself is never skipped, and `flush()` is available to anyone who
   * needs to know it landed before going on.
   */
  unload() {
    this._loadToken += 1;
    this.flush();
    this._dropInk(this.pad?.id);
    clearTimeout(this._cameraTimer);
    this._cameraTimer = null;
    this.pad = null;
    this.ink.setEnabled(false);
    this.ink.loadLayer(null);
    if (this.paperCtx) {
      this.paperCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.paperCtx.clearRect(0, 0, this.elPaper.width, this.elPaper.height);
    }
  }

  // ── saving ────────────────────────────────────────────────────────────────

  _setSaveState(state) {
    if (this.saveState === state) return;
    this.saveState = state;
    this.handlers.onSaveStateChange?.(state, this);
  }

  hasUnsavedInk() {
    return this.saveState === SAVE_STATES.UNSAVED
      || this.saveState === SAVE_STATES.FAILED
      || this._inkSaveTimer !== null;
  }

  /**
   * 同一本草稿纸的笔迹，两栏共用一份。
   *
   * 和 PDF 那边同一套规则、同一张表（草稿纸的 id 就是文件 id，页恒为
   * SCRATCH_PAGE）。不共用的话两边各拿各的副本，而存盘是整层盲写——后写的那一边
   * 会把先写的整个盖掉。
   */
  _takeInk(padId, layer) {
    return shareLayer(padId, SCRATCH_PAGE, layer, this, () => {
      // 另一栏改了这一层。这一栏手里是同一个对象，所以只要重画。
      this.ink.render();
    });
  }

  /** 不看这本了。最后一个人走了，登记处才把它撤掉。 */
  _dropInk(padId) {
    releaseLayer(padId, SCRATCH_PAGE, this);
  }

  _inkChanged() {
    // 同一本草稿纸也开在另一栏时，那一栏画的就是这同一层。落盘可以攒着写，重画
    // 不能：人一笔下去，另一边要立刻看见。
    notifyPeers(this.pad?.id, SCRATCH_PAGE, this);
    this._inkRevision += 1;
    this._setSaveState(SAVE_STATES.UNSAVED);
    clearTimeout(this._inkSaveTimer);
    this._inkSaveTimer = setTimeout(() => { this._inkSaveTimer = null; this.flush(); },
      INK_SAVE_DEBOUNCE);
    this.handlers.onStateChange?.(this);
  }

  /**
   * Commits the ink now, and says whether it worked.
   *
   * The result is REPORTED rather than swallowed. A switch, a move, a removal
   * or a deletion asks for this first and is entitled to be told it failed, so
   * it can stop and offer a retry instead of releasing the only unsaved copy of
   * someone's working.
   *
   * Writes are chained rather than run concurrently: two saves of the same pad
   * racing can commit in either order, and the loser would be the newer one.
   *
   * @returns {Promise<boolean>} whether the pad is now committed
   */
  flush() {
    clearTimeout(this._inkSaveTimer);
    this._inkSaveTimer = null;
    if (!this.pad) return Promise.resolve(true);
    if (this.saveState === SAVE_STATES.SAVED) return Promise.resolve(true);

    const pad = this.pad;
    const revision = this._inkRevision;
    this._savingRevision = revision;
    this._setSaveState(SAVE_STATES.SAVING);

    this._writes = this._writes.then(async () => {
      try {
        await this._store.saveLayer(pad.id, SCRATCH_PAGE, this.ink.getLayer());
        // Only the revision this write captured is acknowledged. Strokes drawn
        // while it was in flight are still unsaved, and saying otherwise is how
        // a "Saved" indicator comes to be lying.
        if (this.pad === pad && this._inkRevision === revision) {
          this._setSaveState(SAVE_STATES.SAVED);
        } else if (this.pad === pad) {
          this._setSaveState(SAVE_STATES.UNSAVED);
        }
        return true;
      } catch (_) {
        // The layer object still holds every stroke; nothing has been released.
        // The state stays visible and retryable rather than being logged away.
        if (this.pad === pad) this._setSaveState(SAVE_STATES.FAILED);
        return false;
      }
    });
    return this._writes;
  }

  /** The explicit Retry, after a failure. */
  retrySave() {
    if (this.saveState === SAVE_STATES.FAILED) this._setSaveState(SAVE_STATES.UNSAVED);
    return this.flush();
  }

  /**
   * Files where the pad is being looked at.
   *
   * Debounced, and separate from the ink: a camera changes on every frame of a
   * pan, and losing one costs a scroll position rather than any content — so it
   * must never be allowed to compete with the write that carries the strokes.
   */
  _scheduleCameraSave() {
    if (!this.pad) return;
    clearTimeout(this._cameraTimer);
    this._cameraTimer = setTimeout(() => {
      this._cameraTimer = null;
      const pad = this.pad;
      if (!pad) return;
      const camera = serializeCamera(this.camera);
      this._writes = this._writes
        .then(() => this._store.setScratchpadCamera(pad.id, camera))
        .then((updated) => { if (updated && this.pad?.id === pad.id) this.pad = updated; })
        .catch(() => { /* a lost reading position is not worth reporting */ });
    }, CAMERA_SETTLE);
  }

  // ── camera ────────────────────────────────────────────────────────────────

  /**
   * Moves the camera and repaints, without touching a single stroke.
   *
   * Everything that changes what is on screen goes through here, so there is
   * exactly one place where the background and the ink are told about a new
   * transform — which is what stops the guides drifting away from the writing
   * that sits on them.
   */
  _setCamera(camera, { persist = true } = {}) {
    if (sameCamera(camera, this.camera)) return;
    this.camera = camera;
    this._syncTransform();
    if (persist) this._scheduleCameraSave();
    this.handlers.onStateChange?.(this);
  }

  _syncTransform() {
    const viewport = this._viewport();
    const dpr = pixelRatio();

    const w = Math.max(1, Math.floor(viewport.width * dpr));
    const h = Math.max(1, Math.floor(viewport.height * dpr));
    // Assigning width reallocates and clears the bitmap even when the value is
    // unchanged, and this runs on every frame of a pan.
    if (this.elPaper.width !== w || this.elPaper.height !== h) {
      this.elPaper.width = w;
      this.elPaper.height = h;
      this.elPaper.style.width = `${viewport.width}px`;
      this.elPaper.style.height = `${viewport.height}px`;
    }
    drawScratchBackground(this.paperCtx, {
      style: this.style,
      camera: this.camera,
      viewport,
      dpr,
    });

    this.ink.resize(viewport.width, viewport.height, dpr);
    const t = transformFor(this.camera, viewport);
    this.ink.setTransform(t.scale, t.offsetX, t.offsetY);
  }

  /** Called when the pane changes size: the world centre and zoom are kept. */
  resize() {
    if (!this.pad) return;
    this._syncTransform();
  }

  /**
   * Applies a new style, repainting the paper and nothing else.
   *
   * Ink is not touched, not rescaled and not reflowed — a style is a backdrop.
   * Used for the panel's live preview as well as for the committed value, which
   * is why it takes a style rather than reading one from the record.
   */
  previewStyle(style) {
    this.style = createScratchStyle(style);
    if (this.pad) this._syncTransform();
  }

  /** After a committed style write, so the pad record and the pane agree. */
  applyPad(pad) {
    if (!pad || this.pad?.id !== pad.id) return;
    this.pad = pad;
    this.previewStyle(pad.style);
  }

  // ── commands ──────────────────────────────────────────────────────────────

  returnToOrigin() { this._setCamera(returnToOrigin()); }

  /**
   * Frames everything written on the pad.
   *
   * @returns {{fitted: boolean, empty: boolean}} so the caller can say when the
   *   ink covers more ground than the minimum zoom can show. Nothing outlying is
   *   discarded to make it fit — the reader is told they can pan through it.
   */
  fitAllInk() {
    const result = fitToBounds(this.ink.getLayer()?.bounds() || null, this._viewport());
    this._setCamera(result.camera);
    return { fitted: result.fitted, empty: result.empty };
  }

  zoomIn() { this._setCamera(zoomIn(this.camera, this._viewport())); }
  zoomOut() { this._setCamera(zoomOut(this.camera, this._viewport())); }
  displayZoom() { return displayZoom(this.camera); }

  undo() { this.ink.undo(); }
  redo() { this.ink.redo(); }
  canUndo() { return this.ink.canUndo(); }
  canRedo() { return this.ink.canRedo(); }

  // ── gestures ──────────────────────────────────────────────────────────────

  /**
   * Who does what, on a tablet with a stylus.
   *
   *   PEN     writes. It never pans and never zooms — the ink surface claims it
   *           before these listeners are reached.
   *   FINGER  one pans, two pinch and pan together.
   *   MOUSE   drags to pan, wheel zooms, so a desk still works.
   *
   * A one-finger drag pans here, where on a PDF it turns the page. There is no
   * page to turn: sliding the paper is the only thing a finger could mean, and
   * making it mean anything else would put a boundary on a surface that has
   * none.
   *
   * A second touch arriving must never become a stroke. The ink surface refuses
   * non-primary touches outright, and in the tablet default a finger cannot draw
   * at all — so the hand resting on the glass while the other writes is silent.
   */
  _bindGestures() {
    const vp = this.elViewport;
    const touches = new Map();
    let mouse = null;
    let pan = null;
    let pinch = null;

    const centre = () => {
      const pts = [...touches.values()];
      return {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
        d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
      };
    };

    const local = (e) => {
      const box = vp.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };

    vp.addEventListener('pointerdown', (e) => {
      if (!this.pad) return;
      this.handlers.onFocus?.();
      if (e.pointerType === 'pen') return;              // the ink surface owns it

      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          const c = centre();
          pinch = { d: c.d || 1, x: c.x, y: c.y };
          pan = null;                                   // the gesture became a zoom
          return;
        }
        if (touches.size > 2) { pinch = null; pan = null; return; }
        pan = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
        return;
      }

      mouse = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { vp.setPointerCapture(e.pointerId); } catch (_) { /* unsupported */ }
      vp.classList.add('is-panning');
    });

    vp.addEventListener('pointermove', (e) => {
      if (!this.pad) return;

      if (e.pointerType === 'touch') {
        if (!touches.has(e.pointerId)) return;
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (touches.size === 1 && pan && pan.id === e.pointerId) {
          const dx = e.clientX - pan.x;
          const dy = e.clientY - pan.y;
          if (!pan.moved && Math.hypot(dx, dy) < PAN_GRAB) return;
          pan.moved = true;
          e.preventDefault();
          this._setCamera(panByScreen(this.camera, dx, dy));
          pan.x = e.clientX;
          pan.y = e.clientY;
          return;
        }

        if (touches.size !== 2 || !pinch) return;
        e.preventDefault();
        const c = centre();
        const box = vp.getBoundingClientRect();
        // Zoom about the point between the fingers, then carry the paper along
        // with their midpoint — the two together are what keep whatever was
        // between the fingers between the fingers.
        this._setCamera(zoomAbout(this.camera, c.d / pinch.d, this._viewport(),
          c.x - box.left, c.y - box.top));
        this._setCamera(panByScreen(this.camera, c.x - pinch.x, c.y - pinch.y));
        pinch.d = c.d || pinch.d;
        pinch.x = c.x;
        pinch.y = c.y;
        return;
      }

      if (!mouse || e.pointerId !== mouse.id) return;
      const dx = e.clientX - mouse.x;
      const dy = e.clientY - mouse.y;
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      this._setCamera(panByScreen(this.camera, dx, dy));
    }, { passive: false });

    const end = (e) => {
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId);
        if (touches.size < 2) pinch = null;
        if (pan && pan.id === e.pointerId) pan = null;
        return;
      }
      if (!mouse || e.pointerId !== mouse.id) return;
      mouse = null;
      vp.classList.remove('is-panning');
      try { vp.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);

    vp.addEventListener('wheel', (e) => {
      if (!this.pad) return;
      this.handlers.onFocus?.();
      e.preventDefault();
      const p = local(e);
      if (e.ctrlKey || e.metaKey) {
        this._setCamera(zoomAbout(this.camera, e.deltaY < 0 ? 1.1 : 1 / 1.1,
          this._viewport(), p.x, p.y));
      } else {
        this._setCamera(panByScreen(this.camera, -e.deltaX, -e.deltaY));
      }
    }, { passive: false });
  }
}

/**
 * Ink and guides are both vector and re-rasterised on every transform change,
 * so neither needs more backing resolution than the screen has — capped at 2x
 * to keep a viewport-sized bitmap small on high-DPR tablets.
 */
function pixelRatio() {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(2, Math.max(1, dpr));
}
