// PDF Module — a single independent viewing pane.
//
// One pane owns one document and one view state. Two panes share nothing but
// the DOM they are mounted into, which is what keeps their zoom, scrolling and
// page navigation from interfering.
//
// All state transitions go through the pure helpers in pdf-view-state.js; this
// file is only the binding between that state and a canvas.

import {
  FIT_MODES,
  applyFit,
  canGoNext,
  canGoPrevious,
  goToPage,
  nextPage,
  panBy,
  previousPage,
  refit,
  setZoom,
  ZOOM_MIN,
  zoomIn,
  zoomOut,
} from './pdf-view-state.js';
import { hydrateViewState } from './document-session.js';
import { InkSurface } from '../ink/ink-surface.js';
import { loadLayer, saveLayer } from '../ink/ink-store.js';
import Logger from '../core/logger.js';

/** A flick must travel this far, and finish this fast, to turn a page. */
const SWIPE_DISTANCE = 64;
const SWIPE_MAX_MS = 600;

/**
 * How far a finger travels before the sheet comes up under it.
 *
 * Ten pixels was too eager. Two fingers arriving for a pinch never land in the
 * same instant, and the first of them drifts further than ten pixels while the
 * second is still on its way down — so a zoom began by turning the page, and
 * the second finger then had to put it back. The gesture has to be committed to
 * a direction before it is read as a swipe, and a pinch does not travel this
 * far sideways in the few milliseconds between two fingers landing.
 */
const TURN_GRAB = 28;

/**
 * How far the crease must have travelled before the turn stands on release.
 *
 * Progress is measured against the crease, and the crease moves at half the
 * speed of the hand — it is the midpoint between the corner and the fingertip.
 * A third of the way is the hand about two thirds across the page, which is
 * where a page stops feeling lifted and starts feeling turned.
 */
const TURN_COMMIT = 0.32;

/** How far over the sheet goes at the end of a turn. */
const TURN_ANGLE = 170;

/**
 * Where on the trailing edge the page is picked up.
 *
 * A book does not turn the same way wherever you take hold of it. A hand at the
 * top corner peels the corner down, a hand at the bottom peels it up, and a
 * hand in the middle lifts the whole edge into one straight fold. The grab
 * decides which, and these are the bands: the outer sixths take the corner they
 * are nearest, and everything between them lifts the edge where it was held.
 */
const TURN_CORNER_BAND = 1 / 3;

/** Paper colour behind the reverse of the sheet. */
const TURN_BACK = '#f6f4f0';


export class PdfPane {
  /**
   * @param {HTMLElement} root element this pane renders into
   * @param {{onStateChange?: function, onFocus?: function}} handlers
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    this.doc = null;
    this.meta = null;
    this.state = null;
    this.pageSize = null;

    // Guards against out-of-order renders: page N's render can resolve after
    // page N+1's if the user pages quickly, which would paint a stale page.
    this._renderToken = 0;
    this._pendingRender = null;

    this._buildDom();

    // Ink lives on its own canvas and its own layer; the pane only tells it
    // what transform to draw under and which page's ink to hold.
    this.ink = new InkSurface(this.elInk, {
      onChange: () => this._scheduleInkSave(),
      onHistoryChange: () => this.handlers.onInkHistoryChange?.(this.ink),
      // A stroke starting here makes this the active pane, which is what makes
      // the shared toolbar push its tool, colour and width to THIS surface.
      onDrawStart: () => this.handlers.onFocus?.(),
    });
    this.ink.setEnabled(false); // enabled once a document is loaded
    this.minZoom = ZOOM_MIN;
    this._inkSaveTimer = null;
    this._inkPage = null;
    // Serialises page swaps so concurrent page turns cannot interleave.
    this._inkSwap = Promise.resolve();

    this._bindGestures();
  }

  _buildDom() {
    this.root.classList.add('pdf-pane');
    // The ink canvas is a SEPARATE element from the page canvas, and is a
    // sibling of the holder rather than a child: it stays viewport-sized so a
    // deep zoom does not allocate a page-sized bitmap, and nothing that draws
    // ink is ever handed the PDF canvas.
    this.root.innerHTML = `
      <div class="pdf-pane-empty" data-role="empty">
        <div class="pdf-pane-empty-icon">📄</div>
        <div class="pdf-pane-empty-text" data-i18n="pdf.paneEmpty">未打开文档</div>
      </div>
      <div class="pdf-pane-body" data-role="body" hidden>
        <div class="pdf-pane-viewport" data-role="viewport">
          <div class="pdf-pane-canvas-holder" data-role="holder"></div>
          <canvas class="pdf-ink-canvas" data-role="ink"></canvas>
        </div>
      </div>
    `;
    this.elEmpty = this.root.querySelector('[data-role="empty"]');
    this.elBody = this.root.querySelector('[data-role="body"]');
    this.elViewport = this.root.querySelector('[data-role="viewport"]');
    this.elHolder = this.root.querySelector('[data-role="holder"]');
    this.elInk = this.root.querySelector('[data-role="ink"]');
  }

  /** Viewport size in CSS pixels; drives fit modes and pan clamping. */
  _viewport() {
    const rect = this.elViewport.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }

  /**
   * The scale at which the whole page fits the pane — what 100% means here.
   *
   * A PDF's own 1:1 is a number about paper: it is 72dpi against whatever
   * density the screen happens to have, and on a tablet holding two documents
   * side by side it puts a page taller than the pane, so "100%" showed roughly
   * two thirds of a page and the rest had to be panned to. Reading is done a
   * page at a time, so the page IS the unit: 100% is the whole of it, and
   * anything above that is the reader leaning in.
   *
   * Returns null before a page has been measured, and callers fall back to the
   * document's own scale until then.
   */
  fitScale() {
    if (!this.pageSize?.width || !this.pageSize?.height) return null;
    const viewport = this._viewport();
    if (!viewport.width || !viewport.height) return null;
    return Math.min(viewport.width / this.pageSize.width,
                    viewport.height / this.pageSize.height);
  }

  /** The zoom as the reader sees it: 1 is the whole page, 2 is twice that. */
  displayZoom() {
    const base = this.fitScale();
    if (!base || !this.state) return this.state?.zoom ?? 1;
    return this.state.zoom / base;
  }

  _contentSize() {
    if (!this.pageSize) return { width: 0, height: 0 };
    return {
      width: this.pageSize.width * this.state.zoom,
      height: this.pageSize.height * this.state.zoom,
    };
  }

  /**
   * Who does what, on a tablet with a stylus.
   *
   * The three input kinds are given three jobs and no overlap, because a
   * gesture that could mean two things has to guess, and a guess that goes
   * wrong while someone is writing costs them work:
   *
   *   PEN     annotates. It never pans, never zooms, never turns a page.
   *   FINGER  one finger taps or turns the page; two pinch, zoom and pan.
   *   MOUSE   pans and wheel-zooms, so the app is still usable at a desk.
   *
   * One finger deliberately does NOT pan. With two-finger panning available
   * there is nothing it would add, and taking it away is what makes the page
   * turn unambiguous: no "only turn once the page has run out of room to pan"
   * rule, no threshold that behaves differently depending on zoom. A finger
   * dragged sideways turns the page, always.
   *
   * Everything runs off pointer events. The pinch used to be a separate pair
   * of touch listeners running alongside them, so a second finger started a
   * pinch while the first was still panning and both moved the page at once.
   */
  _bindGestures() {
    const vp = this.elViewport;

    /** Live touch points, by pointer id. A tablet reports a hand as several. */
    const touches = new Map();

    // ── mouse drag, for the desk ──
    let mouse = null;

    // ── one finger: a tap, or a page turn ──
    let swipe = null;

    // ── two fingers: zoom about the midpoint, and pan with it ──
    let pinch = null;

    const centre = () => {
      const pts = [...touches.values()];
      return {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
        d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
      };
    };

    const beginPinch = () => {
      const c = centre();
      pinch = { d: c.d || 1, x: c.x, y: c.y, zoom: this.state.zoom };
      // The finger that was swiping is now half a pinch. If it had already
      // picked a sheet up, lay it back down — the gesture has become a zoom,
      // and a page half-turned by a pinch is nobody's intention.
      if (swipe?.turning) this.endLiveTurn(false);
      swipe = null;
      vp.classList.remove('is-panning');
    };

    vp.addEventListener('pointerdown', (e) => {
      if (!this.doc) return;
      this.handlers.onFocus?.();

      // The pen belongs to the ink layer. Nothing here may move the page out
      // from under a stroke that is being drawn on it.
      if (e.pointerType === 'pen') return;

      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) { beginPinch(); return; }
        if (touches.size > 2) { pinch = null; swipe = null; return; }
        swipe = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          at: e.timeStamp || performance.now(),
        };
        return;
      }

      mouse = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { vp.setPointerCapture(e.pointerId); } catch (_) { /* unsupported */ }
      vp.classList.add('is-panning');
    });

    vp.addEventListener('pointermove', (e) => {
      if (!this.doc) return;

      if (e.pointerType === 'touch') {
        if (!touches.has(e.pointerId)) return;
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // One finger, moving sideways: the page comes up under it and stays
        // with it. The turn is not a thing that plays after the gesture, it IS
        // the gesture — let go halfway and the sheet is halfway over.
        if (touches.size === 1 && swipe && swipe.id === e.pointerId) {
          const dx = e.clientX - swipe.x;
          const dy = e.clientY - swipe.y;
          if (!swipe.turning) {
            // Wait until the hand has said which way it is going. A finger that
            // has moved further down than across is not turning a page.
            if (Math.abs(dx) >= TURN_GRAB && Math.abs(dx) > Math.abs(dy)) {
              const direction = dx < 0 ? 'next' : 'prev';
              // Where the page was FIRST touched decides which way it peels —
              // the top corner, the bottom corner, or straight across.
              if (this.beginLiveTurn(direction, { x: swipe.x, y: swipe.y })) {
                swipe.turning = direction;
              }
            }
          }
          if (swipe.turning) {
            e.preventDefault();
            this.dragLiveTurn({ x: e.clientX, y: e.clientY });
            return;
          }
        }

        if (touches.size !== 2 || !pinch) return;

        e.preventDefault();
        const c = centre();
        const ratio = c.d / pinch.d;

        // The point between the fingers, in the viewport's own pixels. Both the
        // zoom and the pan are worked out against it, so the page stays stuck to
        // the hand: whatever was between the fingers when the pinch started is
        // still between them at any zoom.
        const box = vp.getBoundingClientRect();
        const anchor = { x: c.x - box.left, y: c.y - box.top };

        // Re-rasterising a PDF page cannot happen once per frame — that is what
        // made the gesture stutter. The bitmap already on screen is scaled by a
        // GPU transform for the duration, and the page is rendered once, at the
        // end, at whatever zoom the fingers settled on.
        this._apply(setZoom(this.state, pinch.zoom * ratio), false, anchor);
        this._apply(
          panBy(this.state, c.x - pinch.x, c.y - pinch.y, this._viewport(), this._contentSize()),
          false,
        );
        this._previewZoom();
        pinch.x = c.x;
        pinch.y = c.y;
        return;
      }

      if (!mouse || e.pointerId !== mouse.id) return;
      const dx = e.clientX - mouse.x;
      const dy = e.clientY - mouse.y;
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      this._apply(panBy(this.state, dx, dy, this._viewport(), this._contentSize()), false);
    }, { passive: false });

    /**
     * A finger dragged sideways turns the page.
     *
     * Direction and speed only — no check for whether the page has room left
     * to pan, because one finger no longer pans. That rule existed to stop one
     * gesture meaning two things, and the two meanings are gone.
     */
    const maybeTurnPage = (from, e) => {
      const dx = e.clientX - from.x;
      const dy = e.clientY - from.y;
      const dt = (e.timeStamp || performance.now()) - from.at;
      if (Math.abs(dx) < SWIPE_DISTANCE) return false;
      if (Math.abs(dx) < Math.abs(dy) * 1.4) return false;   // not sideways enough
      if (dt > SWIPE_MAX_MS) return false;                   // a slow drag is not a flick

      if (dx < 0) {
        if (!this.canGoNext()) return false;
        this.turnPage('next');
        return true;
      }
      if (!this.canGoPrevious()) return false;
      this.turnPage('prev');
      return true;
    };

    const endTouch = (e) => {
      const from = swipe && swipe.id === e.pointerId ? swipe : null;
      touches.delete(e.pointerId);
      if (touches.size < 2 && pinch) {
        pinch = null;
        // The pinch is over: draw the page properly at the zoom it ended on.
        this._commitPreviewZoom();
      }
      if (touches.size < 2) pinch = null;
      if (!from) return;
      swipe = null;

      // A sheet already in the air: the finger has been carrying it, so the
      // only question left is whether it goes over or comes back.
      if (from.turning) {
        if (e.type !== 'pointerup') { this.endLiveTurn(false); return; }
        const dx = e.clientX - from.x;
        const dt = (e.timeStamp || performance.now()) - from.at;
        // Either it was carried most of the way, or it was thrown — a flick
        // should not have to cross half the page to count.
        const carried = this._live ? this._live.progress >= TURN_COMMIT : false;
        const flicked = Math.abs(dx) >= SWIPE_DISTANCE && dt <= SWIPE_MAX_MS;
        try {
          this.endLiveTurn(carried || flicked);
        } catch (_) {
          // A turn that fails must not leave a photograph of the old page lying
          // over the live one.
          this._live = null;
          vp.querySelectorAll('.pdf-page-leaf').forEach((n) => n.remove());
        }
        return;
      }

      if (e.type !== 'pointerup') return;
      try { maybeTurnPage(from, e); } catch (_) { /* a failed turn is not fatal */ }
    };

    const endPointer = (e) => {
      if (e.pointerType === 'touch') { endTouch(e); return; }
      if (!mouse || e.pointerId !== mouse.id) return;
      mouse = null;
      vp.classList.remove('is-panning');
      try { vp.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
    };

    vp.addEventListener('pointerup', endPointer);
    vp.addEventListener('pointercancel', endPointer);

    // Ctrl/⌘ + wheel zooms; plain wheel pans vertically.
    vp.addEventListener('wheel', (e) => {
      if (!this.doc) return;
      this.handlers.onFocus?.();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this._apply(e.deltaY < 0 ? zoomIn(this.state) : zoomOut(this.state), true);
      } else {
        const content = this._contentSize();
        const viewport = this._viewport();
        if (content.height <= viewport.height) return; // let the page scroll
        e.preventDefault();
        this._apply(panBy(this.state, 0, -e.deltaY, viewport, content), false);
      }
    }, { passive: false });
  }

  /**
   * Turns the page, with the sheet lifting and going over.
   *
   * The animation runs BEFORE the state changes and the new page renders
   * underneath it, so what turns away is the page that was actually there
   * rather than a re-render of it.
   */
  turnPage(direction) {
    // The same sheet the hand carries, released at once. With no hand to say
    // where it was taken hold of, the edge lifts in the middle and the page
    // folds straight across — the neutral one of the three.
    if (this.beginLiveTurn(direction)) {
      this.endLiveTurn(true);
      return;
    }
    // No sheet to lift — reduced motion, a page not yet drawn, or the end of
    // the book. The page still turns; it just does not perform.
    if (direction === 'next') this.next(); else this.previous();
  }

  /**
   * Photographs the page and lays the photograph over it.
   *
   * Everything the turn draws is drawn into this one canvas: the part of the
   * sheet still lying flat, the part folded back on itself, the shadow in the
   * crease. It has to be a canvas rather than transformed boxes because the
   * fold is a reflection about a line that is rarely vertical, and a box cannot
   * be reflected about a diagonal.
   */
  _makeLeaf(direction, vp, source, rect, box) {
    let sheet;
    try {
      sheet = document.createElement('canvas');
      sheet.width = source.width;
      sheet.height = source.height;
      sheet.getContext('2d').drawImage(source, 0, 0);
    } catch (_) {
      return null;                          // a tainted or zero-sized canvas
    }

    const leaf = document.createElement('div');
    leaf.className = 'pdf-page-leaf';
    leaf.dataset.direction = direction;
    leaf.style.left = `${rect.left - box.left}px`;
    leaf.style.top = `${rect.top - box.top}px`;
    leaf.style.width = `${rect.width}px`;
    leaf.style.height = `${rect.height}px`;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const view = document.createElement('canvas');
    view.width = Math.max(1, Math.round(rect.width * dpr));
    view.height = Math.max(1, Math.round(rect.height * dpr));
    view.style.width = '100%';
    view.style.height = '100%';
    leaf.appendChild(view);

    vp.appendChild(leaf);
    return { leaf, sheet, view, dpr, w: rect.width, h: rect.height };
  }

  /**
   * Which point of the trailing edge the hand has hold of.
   *
   * Reads only where the page was first touched: top band takes the top corner,
   * bottom band the bottom corner, and the middle keeps the height it was held
   * at, which is what turns the fold from a diagonal into a straight one.
   */
  _grabAnchor(direction, grabY, w, h) {
    // The trailing edge: a forward turn is picked up at the right, a backward
    // one at the left.
    const x = direction === 'next' ? w : 0;
    const t = h > 0 ? Math.max(0, Math.min(1, grabY / h)) : 0.5;
    if (t <= TURN_CORNER_BAND) return { x, y: 0, corner: 'top' };
    if (t >= 1 - TURN_CORNER_BAND) return { x, y: h, corner: 'bottom' };
    // Held in the middle: the edge lifts where it was held, and a level pull
    // makes the crease vertical — one straight fold across the whole page.
    return { x, y: grabY, corner: 'edge' };
  }

  /**
   * Draws the sheet folded so that `anchor` has been carried to `point`.
   *
   * The fold is the perpendicular bisector of the line between where the corner
   * started and where the hand has taken it — which is the whole geometry of a
   * page bending over: every point of the flap is as far past the crease as its
   * twin is short of it. So the flap is the page reflected in that line, and
   * the reverse of the paper is what the reflection shows.
   */
  _paintTurn(live, point) {
    const { view, sheet, dpr, w, h } = live;
    const ctx = view.getContext('2d');
    if (!ctx) return;
    const a = live.anchor;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    // The crease: through the midpoint, square to the travel.
    const dx = point.x - a.x;
    const dy = point.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) {
      ctx.drawImage(sheet, 0, 0, w, h);
      ctx.restore();
      return;
    }
    const nx = dx / len;
    const ny = dy / len;
    const mx = (a.x + point.x) / 2;
    const my = (a.y + point.y) / 2;
    const k = mx * nx + my * ny;          // the crease is { p : p·n = k }

    // Everything on the anchor's side of the crease has folded over.
    const anchorSide = Math.sign(a.x * nx + a.y * ny - k) || -1;
    const far = Math.hypot(w, h) * 2;
    // The half-plane still lying flat, as a polygon big enough to cover it.
    const halfPlane = (side) => {
      const cx = k * nx + side * far * nx;
      const cy = k * ny + side * far * ny;
      const ex = -ny * far;
      const ey = nx * far;
      ctx.beginPath();
      ctx.moveTo(cx + ex, cy + ey);
      ctx.lineTo(cx - ex, cy - ey);
      ctx.lineTo(cx - ex - side * far * nx * 2, cy - ey - side * far * ny * 2);
      ctx.lineTo(cx + ex - side * far * nx * 2, cy + ey - side * far * ny * 2);
      ctx.closePath();
    };

    // 1 ── the part of the page that has not moved.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    halfPlane(-anchorSide);
    ctx.clip();
    ctx.drawImage(sheet, 0, 0, w, h);
    ctx.restore();

    // 2 ── the flap: the sheet, reflected in the crease.
    //
    // Reflecting the anchor's half of the page lands it back ON the half that
    // has not moved, which is what folding a corner over actually does — the
    // paper comes back across the page rather than leaving the page. What shows
    // there is the BACK of a sheet.
    //
    // WHICH sheet is the difference between the two directions, and it is the
    // whole reason a book feels bound on one side:
    //
    //   FORWARD  the page being left is what folds away, so its own printing
    //            shows faintly through from the other side of the paper.
    //   BACKWARD the page arriving is what unfolds in, hinged on the same left
    //            edge — it is the back of a page that has not been read yet,
    //            and there is no bitmap of it to show through. Plain paper is
    //            not an approximation here, it is what the reader would see.
    //
    // The crease shading is drawn inside this same clip, in this same reflected
    // space, or it lands on the half the fold has left empty.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();                                   // never outside the page
    // Reflection about p·n = k:  p' = p - 2(p·n - k)n
    ctx.transform(
      1 - 2 * nx * nx, -2 * nx * ny,
      -2 * nx * ny, 1 - 2 * ny * ny,
      2 * k * nx, 2 * k * ny,
    );
    halfPlane(anchorSide);
    ctx.clip();
    ctx.fillStyle = TURN_BACK;
    ctx.fillRect(0, 0, w, h);
    // Nothing is printed on it.
    //
    // A little of the page used to show through from the other side, which is
    // true of real paper and looked like a mistake on a screen: mirrored
    // characters over half the pane read as a rendering fault, not as a sheet
    // seen from behind. The back is blank.

    // One hairline where the sheet doubles back. Not a shadow across the back —
    // just the edge, so the fold has somewhere to be rather than fading into
    // the page it is lying on.
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(k * nx - ny * far, k * ny + nx * far);
    ctx.lineTo(k * nx + ny * far, k * ny - nx * far);
    ctx.stroke();

    // No shading on the back of the sheet.
    //
    // There was a gradient down the fold here. Even softened it read as a smear
    // across the reverse of the page rather than as a crease, and the reverse of
    // a page is the one surface in the whole turn with nothing on it — paper
    // catching the light, not paper in shadow. The fold is legible from the
    // geometry alone: the crease is where the printing stops and the blank side
    // begins, which is exactly how it looks in the hand.
    ctx.restore();

    ctx.restore();
    live.point = point;
    live.progress = this._turnProgress(live, point);
  }

  /** How far across the page the crease has travelled, 0..1. */
  _turnProgress(live, point) {
    const span = live.w || 1;
    const travelled = Math.abs(point.x - live.anchor.x);
    return Math.max(0, Math.min(1, travelled / (span * 2)));
  }

  /**
   * Starts a turn that the hand carries.
   *
   * The page underneath changes AT ONCE, while the sheet still lies flat over
   * the viewport — the reader is looking at the photograph and cannot see it
   * happen — so what opens along the crease is the page being turned TO, not a
   * second copy of the one being left.
   *
   * @param {'next'|'prev'} direction
   * @param {{x:number,y:number}} [grab] where the hand took hold, in viewport px
   * @returns {boolean} whether a live turn is now running.
   */
  beginLiveTurn(direction, grab) {
    if (this._live) return true;
    if (direction === 'next' ? !this.canGoNext() : !this.canGoPrevious()) return false;

    const holder = this.elHolder;
    const vp = this.elViewport;
    if (!holder || !vp || typeof holder.animate !== 'function') return false;
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    } catch (_) { /* no matchMedia: animate */ }

    const source = holder.querySelector('canvas');
    if (!source || !source.width || !source.height) return false;

    const rect = holder.getBoundingClientRect();
    const box = vp.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    const made = this._makeLeaf(direction, vp, source, rect, box);
    if (!made) return false;

    this._live = { ...made, direction, holder, progress: 0 };
    const grabY = grab ? grab.y - rect.top : rect.height / 2;
    this._live.anchor = this._grabAnchor(direction, grabY, rect.width, rect.height);
    made.leaf.dataset.corner = this._live.anchor.corner;
    this._paintTurn(this._live, { ...this._live.anchor });

    if (direction === 'next') this.next(); else this.previous();
    return true;
  }

  /**
   * Holds the sheet where the hand has taken it.
   * @param {{x:number,y:number}} point in viewport pixels
   */
  dragLiveTurn(point) {
    const live = this._live;
    if (!live) return;
    // The fold is worked out in the page's own pixels, so the hand has to be
    // put into them too.
    const holder = live.holder.getBoundingClientRect();
    this._paintTurn(live, { x: point.x - holder.left, y: point.y - holder.top });
  }

  /**
   * Lets go: the rest of the way over, or back down flat and the page put back.
   *
   * Animated frame by frame, because the fold has to keep being computed as it
   * travels — the crease moves and turns the whole way, and no keyframe can
   * express that.
   */
  endLiveTurn(commit) {
    const live = this._live;
    if (!live) return;
    this._live = null;
    const { leaf, holder, direction, anchor } = live;

    if (!commit) {
      if (direction === 'next') this.previous(); else this.next();
    }

    const from = live.point || { ...anchor };
    // Over the far edge, or back to where it was picked up.
    const to = commit
      ? { x: anchor.x + (direction === 'next' ? -live.w * 2.1 : live.w * 2.1), y: from.y }
      : { ...anchor };
    const duration = commit ? 340 : 260;

    let raf = 0;
    const drop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      leaf.remove();
    };

    if (commit) {
      try {
        holder.animate?.(
          [{ opacity: 0.8 }, { opacity: 1 }],
          { duration: Math.min(260, duration), easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
        );
      } catch (_) { /* no WAAPI: the page simply appears */ }
    }

    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = () => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const live2 = { ...live, anchor };
      this._paintTurn(live2, {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      });
      if (t < 1) { raf = requestAnimationFrame(step); return; }
      drop();
    };

    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(step);
    else drop();

    setTimeout(drop, duration + 500);
  }

  /** Is a finger currently carrying a sheet? */
  get isTurning() { return !!this._live; }

  /**
   * Commits a new state.
   * @param {boolean} needsRepaint whether the page bitmap must be re-rendered
   *   (zoom/page changed) as opposed to merely re-positioned (pan).
   */
  /**
   * Lowest zoom this pane will go to.
   *
   * With two books side by side, fitting a page to half a tablet means zooming
   * well below 100%, and that is correct — the point is comparison. Alone, a
   * page has the whole screen and shrinking it below full size serves nothing,
   * so a single open document gets a 100% floor.
   */
  setMinZoom(minZoom) {
    // The floor is the whole page. Below it there is nothing left to see, and
    // above it is where reading happens — so the caller's number is treated as
    // a request for the document's own 1:1, and the page's own fit wins when it
    // is smaller, which on a split tablet it always is.
    const asked = Number(minZoom);
    const requested = Number.isFinite(asked) && asked > 0 ? asked : ZOOM_MIN;
    const whole = this.fitScale();
    this.minZoom = whole ? Math.min(requested, whole) : requested;
    if (this.state?.fitMode && this.state.fitMode !== FIT_MODES.NONE) return;
    if (!this.state) return;
    if (this.state.zoom < this.minZoom - 1e-6) {
      // Re-fit under the new floor rather than setting a bare zoom, so a
      // fit-to-width pane stays a fit-to-width pane.
      this._apply(
        this.state.fitMode === FIT_MODES.NONE
          ? setZoom(this.state, this.minZoom)
          : refit(this.state, this._viewport(), this.pageSize, this.minZoom),
        true,
      );
    } else {
      this._position();
    }
  }

  _apply(nextState, needsRepaint, anchor) {
    // The floor applies to a MANUAL zoom here. A fit clamps itself inside
    // applyFit and keeps its mode; forcing setZoom on it would drop the mode to
    // NONE and stop the pane responding to resizes at all.
    if (nextState && this.minZoom
        && nextState.fitMode === FIT_MODES.NONE
        && nextState.zoom < this.minZoom - 1e-6) {
      nextState = setZoom(nextState, this.minZoom);
    }
    // Zoom about a point, not about the top-left corner.
    //
    // Scroll offsets are measured from the page's origin, so leaving them alone
    // across a zoom change keeps the top-left corner fixed and throws whatever
    // you were reading off the bottom-right. Some document point has to be held
    // still instead, and WHICH one is the whole feel of the gesture: a button
    // press has no position, so it holds the middle of the frame, but a pinch
    // does — it holds the point between the two fingers, because that is the
    // thing the hand is pointing at. Holding the centre for a pinch is what
    // made the page slide out from under the fingers, and an annotation move
    // with it.
    if (nextState && this.state && nextState.zoom !== this.state.zoom) {
      nextState = this._anchorZoomToPoint(this.state, nextState, anchor);
    }
    if (nextState === this.state) return;
    const previousPage = this.state?.pageNumber;
    const pageChanged = nextState.pageNumber !== previousPage;
    this.state = nextState;
    if (pageChanged) {
      // Ink belongs to a page, so leaving one commits its strokes and arriving
      // at the next loads that page's own layer.
      this._swapInkPage(nextState.pageNumber);
    }
    if (needsRepaint || pageChanged) {
      this._render();
    } else {
      this._position();
    }
    this.handlers.onStateChange?.(this.state);
  }

  // ── ink ───────────────────────────────────────────────────────────────────

  /**
   * Keeps the ink transform aligned with the page.
   *
   * The holder is translated by (-scrollX, -scrollY) and its canvas is drawn at
   * pageSize x zoom, so a document point d lands at d*zoom - scroll. The ink
   * canvas is viewport-fixed, so it reproduces that mapping as
   * scale = zoom, offset = scroll / zoom.
   */
  _syncInk() {
    if (!this.state) return;
    const viewport = this._viewport();
    this.ink.resize(viewport.width, viewport.height, inkPixelRatio());
    // Ink is drawn in page space, so it has to sit under the SAME origin the
    // page does. Reading scroll directly would leave annotations pinned to the
    // top-left while a centred page moved out from under them.
    const { x, y } = this._origin();
    this.ink.setTransform(this.state.zoom, -x / this.state.zoom, -y / this.state.zoom);
  }

  /**
   * Moves ink to another page.
   *
   * Swaps are SERIALISED through a promise chain. Page changes arrive from
   * pointer events and are not awaited by the caller, so paging quickly used to
   * start several swaps at once. Because a save wrote whatever layer happened
   * to be installed to whatever page number the caller passed, an interleaved
   * pair could write one page's strokes onto another: paging 1→2→3 fast made
   * swap(2,3) save page 1's still-installed layer to page 2.
   *
   * Chaining makes each swap observe a settled state, and _inkPage is only
   * advanced once the new layer is actually installed, so the pair
   * (installed layer, its page) is never inconsistent.
   */
  _swapInkPage(toPage) {
    this._inkSwap = this._inkSwap
      .then(() => this._performInkSwap(toPage))
      .catch((error) => {
        // One failed swap must not break the chain for every later page turn.
        Logger.warn('INK', `page swap to ${toPage} failed: ${error.message}`);
      });
    return this._inkSwap;
  }

  async _performInkSwap(toPage) {
    // Commit the current layer to ITS OWN page before anything is replaced.
    await this._flushInkSave();
    if (!this.meta) {
      this._inkPage = toPage;
      return;
    }
    const layer = await loadLayer(this.meta.id, toPage);
    // Installed and recorded together — never one without the other.
    this.ink.loadLayer(layer);
    this._inkPage = toPage;
    this._syncInk();
  }

  /** Debounced so a long stroke sequence does not write on every sample. */
  _scheduleInkSave() {
    clearTimeout(this._inkSaveTimer);
    this._inkSaveTimer = setTimeout(() => this._flushInkSave(), 400);
    this.handlers.onDirtyChange?.(true);
  }

  /** True while an edit has been made but not yet written to storage. */
  hasUnsavedInk() {
    return this._inkSaveTimer !== null;
  }

  /**
   * Writes pending annotations now, instead of waiting out the autosave.
   *
   * Annotation is already saved on a 400ms debounce, so this is not what makes
   * the work durable — it is what lets someone SEE that it is. Closing a book
   * on a tablet you are about to put down should not require trusting an
   * invisible timer.
   */
  async saveNow() {
    await this._flushInkSave();
    this.handlers.onDirtyChange?.(false);
  }

  /**
   * Commits the current layer to the page it belongs to.
   *
   * Takes no page argument on purpose. It previously accepted one, which let a
   * caller name a page that did not match the installed layer — the exact
   * mismatch that wrote one page's strokes onto another. `_inkPage` is
   * maintained as "the page the installed layer came from", so reading it here
   * is the only way the two can be guaranteed to agree.
   */
  async _flushInkSave() {
    clearTimeout(this._inkSaveTimer);
    this._inkSaveTimer = null;
    if (!this.meta || !this._inkPage) { this.handlers.onDirtyChange?.(false); return; }
    // Captured together, so a swap completing mid-await cannot redirect them.
    const documentId = this.meta.id;
    const page = this._inkPage;
    const layer = this.ink.getLayer();
    try {
      await saveLayer(documentId, page, layer);
      this.handlers.onDirtyChange?.(false);
    } catch (_) {
      // Losing one autosave must not break drawing; the next one retries.
    }
  }

  async loadDocument(doc, meta, restoredView, isCurrent = () => true) {
    if (!isCurrent()) return false;
    this.doc = doc;
    this.meta = meta;
    // Built lazily on first answer lookup; cleared here so a newly opened
    // document never inherits the previous one's index. All four go
    // together: questionIndex and the two cross-document caches were being
    // left behind, so a second book opened into this pane was matched using
    // the first book's questions.
    this.answerIndex = null;
    this.questionIndex = null;
    this.outlineAlignment = null;
    this.answerComparability = undefined;
    // The pair verdict belongs to a PAIR, so a new book on either side voids
    // it. Carried over, it would gate the new pair with the old one's answer.
    this.pairVerdict = null;
    this.state = hydrateViewState(doc.numPages, restoredView);
    const pageSize = await doc.pageSize(this.state.pageNumber);
    if (!isCurrent() || this.doc !== doc) return false;
    this.pageSize = pageSize;
    // Show the body only once there is something in it.
    //
    // These two lines used to run BEFORE `_render()`, which meant the pane
    // committed to "a document is open" and then went to fetch the page. If
    // that render threw — a corrupt page, a document evicted from storage, a
    // restore for an id that no longer exists — the pane was left showing an
    // empty body: no page, and no "未打开文档" either, because the placeholder
    // had already been dismissed. A blank pane with a full toolbar above it.
    //
    // The placeholder is the honest state until a page actually exists, so the
    // swap only happens after the render resolves, and a failure puts it back.
    try {
      this.elBody.hidden = false;

      // The fit is computed HERE, after the body is on screen — never before.
      //
      // `_viewport()` measures the element, and a hidden element measures zero.
      // While `[hidden]` was being defeated by an author `display` rule the body
      // always had a size, so fitting before showing it happened to work; the
      // moment `hidden` started meaning hidden, every freshly opened document
      // fitted against a zero-width viewport and opened at a nonsense zoom.
      //
      // A restored session keeps its exact zoom; a fresh open shows the whole
      // page. Fitting to WIDTH put a page taller than the pane on screen from
      // the first moment, so the first thing a reader saw of a new book was the
      // top two thirds of page one.
      if (!restoredView) {
        this.state = applyFit(this.state, FIT_MODES.PAGE, this._viewport(), this.pageSize);
      }

      await this._render();
    } catch (error) {
      this.elBody.hidden = true;
      this.elEmpty.hidden = false;
      this.doc = null;
      throw error;
    }
    if (!isCurrent() || this.doc !== doc) return false;
    this.elEmpty.hidden = true;

    const inkPage = this.state.pageNumber;
    const inkLayer = await loadLayer(meta.id, inkPage);
    if (!isCurrent() || this.doc !== doc) return false;
    this._inkPage = inkPage;
    this.ink.setEnabled(true);
    this.ink.loadLayer(inkLayer);
    this._syncInk();

    this.handlers.onStateChange?.(this.state);
    return true;
  }

  unload() {
    // Commit ink before tearing down, or the last strokes drawn before closing
    // would be lost with the pending debounce.
    this._flushInkSave();
    if (this.doc) {
      try { this.doc.destroy(); } catch (_) { /* already gone */ }
    }
    this.doc = null;
    this.meta = null;
    this.state = null;
    this.pageSize = null;
    this._inkPage = null;
    // All belong to the document that just closed; keeping them would answer
    // a later lookup from the wrong book.
    this.answerIndex = null;
    this.questionIndex = null;
    this.outlineAlignment = null;
    this.answerComparability = undefined;
    // The pair verdict belongs to a PAIR, so a new book on either side voids
    // it. Carried over, it would gate the new pair with the old one's answer.
    this.pairVerdict = null;
    this.exerciseLabel = '';
    this._renderToken++;
    this.ink.setEnabled(false);
    this.ink.loadLayer(null);
    this.elHolder.innerHTML = '';
    this.elBody.hidden = true;
    this.elEmpty.hidden = false;
  }

  async _render() {
    if (!this.doc || !this.state) return;
    const token = ++this._renderToken;
    const { pageNumber, zoom } = this.state;

    try {
      this.pageSize = await this.doc.pageSize(pageNumber);
      const { canvas } = await this.doc.renderPage(pageNumber, zoom * devicePixelRatioSafe());
      // A newer render started while this one was in flight — discard it rather
      // than painting a page the user has already navigated away from.
      if (token !== this._renderToken) return;

      const content = this._contentSize();
      canvas.style.width = `${content.width}px`;
      canvas.style.height = `${content.height}px`;
      canvas.className = 'pdf-pane-canvas';
      // What zoom this bitmap is, so a pinch can scale it to stand in for the
      // zoom it has not been rendered at yet.
      this._renderedZoom = zoom;
      this._previewScale = 1;
      this.elHolder.replaceChildren(canvas);
      this._position();
    } catch (error) {
      if (token !== this._renderToken) return;
      this.elHolder.replaceChildren(errorNode(error));
    }
  }

  /** Applies pan without re-rasterising. Ink follows the same transform. */
  /**
   * Places the page under the viewport.
   *
   * A page smaller than the pane is CENTRED, on each axis independently.
   * Scroll offsets clamp to [0, content - viewport], which is 0 whenever the
   * page fits — so a page that did not fill the pane sat hard against the
   * top-left corner with all the empty space pushed to one side. Centring is
   * the difference between a document and a document shoved out of the way.
   */
  _position() {
    if (!this.state) return;
    const { x, y } = this._origin();
    const k = this._previewScale;
    this.elHolder.style.transform = k && k !== 1
      ? `translate(${x}px, ${y}px) scale(${k})`
      : `translate(${x}px, ${y}px)`;
    this._syncInk();
  }

  /**
   * Shows the current zoom by scaling the bitmap already on screen.
   *
   * A pinch changes zoom on every frame, and PDF.js cannot rasterise a page on
   * every frame — asking it to was what made the gesture stutter and lag behind
   * the fingers. The page on screen was rendered at some zoom; scaling it by the
   * ratio between that and the live one shows the right size immediately, for
   * the cost of a GPU transform.
   *
   * The ink is NOT previewed with it. It is redrawn from its own vectors at the
   * true zoom on the same frame, so it stays sharp and stays exactly where it
   * belongs on the page while the page under it is a stretched bitmap.
   */
  _previewZoom() {
    const rendered = this._renderedZoom;
    if (!rendered || !this.state) return;
    this._previewScale = this.state.zoom / rendered;
    this.elHolder.style.transformOrigin = 'top left';
    this._position();
  }

  /** Ends a previewed zoom by drawing the page for real, once. */
  _commitPreviewZoom() {
    if (this._previewScale === 1 || this._previewScale === undefined) return;
    this._previewScale = 1;
    this._render();
  }

  /**
   * Scales the rendered page while the pane is being resized.
   *
   * Re-fitting means re-rasterising, and PDF.js cannot rasterise a 372-page
   * book once per frame of a divider drag — so nothing was re-fitted until the
   * drag ended, and until then the page stayed at the zoom it had for the pane's
   * old width and spilled out of the new one.
   *
   * This is the cheap stand-in: a GPU transform that previews what the refit
   * will do, so the page tracks the divider live. `previewScale(null)` clears
   * it, and the real refit lands immediately after.
   */
  previewScale(factor) {
    const k = Number(factor);
    this._previewScale = Number.isFinite(k) && k > 0 ? k : 1;
    this.elHolder.style.transformOrigin = 'top left';
    this._position();
  }

  /**
   * Holds one point of the document still across a zoom change.
   *
   * `point` is in viewport pixels; without one, the middle of the frame is used,
   * which is the right answer for a zoom that came from a button and has no
   * position of its own.
   *
   * A fit is exempt: it deliberately resets scroll to the page origin, and
   * re-anchoring it would fight the thing the user just asked for.
   */
  _anchorZoomToPoint(before, after, point) {
    if (after.fitMode !== FIT_MODES.NONE) return after;
    const viewport = this._viewport();
    if (!viewport.width || !viewport.height || !this.pageSize) return after;

    const ax = Number.isFinite(point?.x) ? point.x : viewport.width / 2;
    const ay = Number.isFinite(point?.y) ? point.y : viewport.height / 2;

    // The document-space point currently under it.
    const docX = (before.scrollX + ax) / before.zoom;
    const docY = (before.scrollY + ay) / before.zoom;

    const content = {
      width: this.pageSize.width * after.zoom,
      height: this.pageSize.height * after.zoom,
    };
    const maxX = Math.max(0, content.width - viewport.width);
    const maxY = Math.max(0, content.height - viewport.height);
    const scrollX = Math.min(maxX, Math.max(0, docX * after.zoom - ax));
    const scrollY = Math.min(maxY, Math.max(0, docY * after.zoom - ay));

    if (scrollX === after.scrollX && scrollY === after.scrollY) return after;
    return { ...after, scrollX, scrollY };
  }

  /** The middle of the frame, for zooms that have no position of their own. */
  _anchorZoomToCentre(before, after) {
    return this._anchorZoomToPoint(before, after, null);
  }

  /** Where the page's top-left corner sits, in viewport pixels. */
  _origin() {
    const content = this._contentSize();
    const viewport = this._viewport();
    const slackX = viewport.width - content.width;
    const slackY = viewport.height - content.height;
    return {
      x: slackX > 0 ? slackX / 2 : -this.state.scrollX,
      y: slackY > 0 ? slackY / 2 : -this.state.scrollY,
    };
  }

  /** Re-fits after the pane's size changed (divider drag, rotation). */
  resize() {
    if (!this.doc || !this.state) return;
    const before = this.state;
    // No floor on a refit: the pane has changed size and the fit it is holding
    // has to stay a fit, at whatever zoom that now means.
    this.state = refit(this.state, this._viewport(), this.pageSize);
    if (this.state !== before) {
      this._render();
      this.handlers.onStateChange?.(this.state);
    } else {
      this._position();
    }
  }

  // ── commands used by the toolbar ──────────────────────────────────────────
  goToPage(n) { if (this.doc) this._apply(goToPage(this.state, n), true); }
  next() { if (this.doc) this._apply(nextPage(this.state), true); }
  previous() { if (this.doc) this._apply(previousPage(this.state), true); }
  zoomIn() { if (this.doc) this._apply(zoomIn(this.state), true); }
  zoomOut() { if (this.doc) this._apply(zoomOut(this.state), true); }
  fitWidth() {
    if (!this.doc) return;
    this._apply(applyFit(this.state, FIT_MODES.WIDTH, this._viewport(), this.pageSize), true);
  }
  fitPage() {
    if (!this.doc) return;
    this._apply(applyFit(this.state, FIT_MODES.PAGE, this._viewport(), this.pageSize), true);
  }

  canGoNext() { return !!this.doc && canGoNext(this.state); }
  canGoPrevious() { return !!this.doc && canGoPrevious(this.state); }
  isLoaded() { return !!this.doc; }
}

/**
 * Ink is vector and re-rasterised on every transform change, so it does not
 * need the page canvas's extra backing resolution — 1x keeps the viewport-sized
 * ink buffer small on high-DPR tablets while staying sharp at any zoom.
 */
function inkPixelRatio() {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(2, Math.max(1, dpr));
}


/** Capped: a 3x-DPR tablet at 6x zoom would otherwise allocate enormous canvases. */
function devicePixelRatioSafe() {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(2, Math.max(1, dpr));
}

function errorNode(error) {
  const div = document.createElement('div');
  div.className = 'pdf-pane-error';
  div.textContent = '页面渲染失败: ' + (error?.message || String(error));
  return div;
}
