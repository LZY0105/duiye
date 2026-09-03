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

/** How far a finger travels before the sheet comes up under it. */
const TURN_GRAB = 10;

/** How far across the page a slow drag must get before the turn stands. */
const TURN_COMMIT = 0.5;

/** How far over the sheet goes at the end of a turn. */
const TURN_ANGLE = 170;

/**
 * How many hinged strips the sheet is cut into.
 *
 * A page does not pivot on a hinge, it bends. One plane rotating about the
 * spine is a board, and it reads as one. Eight strips, each hinged on the last,
 * is enough to see a curve and few enough to transform on every frame.
 */
const TURN_STRIPS = 8;

/** Degrees of extra spread between spine and free edge at the height of the curl. */
const TURN_BEND = 30;

/** How far the sheet lifts off the page, in px, at the height of the curl. */
const TURN_LIFT = 14;

/** Where the sheet starts fading, since its back is never drawn. */
const TURN_FADE_FROM = 0.72;

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
              if (this.beginLiveTurn(direction)) {
                swipe.turning = direction;
                // Where the finger was when the sheet came up, so the page does
                // not jump the first ten pixels into the reader's hand.
                swipe.from = e.clientX;
                swipe.span = Math.max(1, this._viewport().width * 0.6);
              }
            }
          }
          if (swipe.turning) {
            e.preventDefault();
            const travelled = (e.clientX - swipe.from) * (swipe.turning === 'next' ? -1 : 1);
            this.dragLiveTurn(travelled / swipe.span);
            return;
          }
        }

        if (touches.size !== 2 || !pinch) return;

        e.preventDefault();
        const c = centre();
        const ratio = c.d / pinch.d;
        // Zoom first, then pan by how far the two fingers travelled together,
        // so the page follows the hand rather than only growing under it.
        this._apply(setZoom(this.state, pinch.zoom * ratio), true);
        this._apply(
          panBy(this.state, c.x - pinch.x, c.y - pinch.y, this._viewport(), this._contentSize()),
          false,
        );
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
    // The same sheet the finger carries, released at once. A page turned from
    // the button has no reason to bend differently from one turned by hand.
    if (this.beginLiveTurn(direction)) {
      this.endLiveTurn(true);
      return;
    }
    // No sheet to lift — reduced motion, a page not yet drawn, or the end of
    // the book. The page still turns; it just does not perform.
    if (direction === 'next') this.next(); else this.previous();
  }

  /**
   * Photographs the sheet on screen and parks it over the viewport.
   *
   * Shared by the two ways a page turns: the canned animation a button fires,
   * and the one a finger drags. Both need the same thing — the page that is on
   * screen now, frozen, sitting exactly where it was.
   */
  _makeLeaf(direction, vp, source, rect, box) {
    const leaf = document.createElement('div');
    leaf.className = 'pdf-page-leaf';
    leaf.dataset.direction = direction;
    leaf.style.left = `${rect.left - box.left}px`;
    leaf.style.top = `${rect.top - box.top}px`;
    leaf.style.width = `${rect.width}px`;
    leaf.style.height = `${rect.height}px`;

    const next = direction === 'next';
    const stripW = rect.width / TURN_STRIPS;
    const srcW = source.width / TURN_STRIPS;
    const strips = [];

    // Each strip hangs off the one before it, hinged at the edge they share, so
    // rotating them in turn bends the sheet instead of tilting it.
    let parent = leaf;
    for (let i = 0; i < TURN_STRIPS; i += 1) {
      const strip = document.createElement('div');
      strip.className = 'pdf-page-strip';
      // The first strip sits on the spine; every later one starts at its
      // parent's far edge. Half a pixel of overlap keeps the seams from
      // showing as hairlines when the sheet is edge-on.
      strip.style.width = `${stripW + 0.5}px`;
      strip.style.height = '100%';
      strip.style.transformOrigin = next ? 'left center' : 'right center';
      if (i > 0) strip.style[next ? 'left' : 'right'] = `${stripW}px`;

      let slice;
      try {
        slice = document.createElement('canvas');
        slice.width = Math.max(1, Math.round(srcW));
        slice.height = source.height;
        slice.getContext('2d').drawImage(
          source,
          Math.round((next ? i : TURN_STRIPS - 1 - i) * srcW), 0,
          Math.max(1, Math.round(srcW)), source.height,
          0, 0, slice.width, slice.height,
        );
      } catch (_) {
        leaf.remove();
        return null;                        // a tainted or zero-sized canvas
      }
      slice.style.width = '100%';
      slice.style.height = '100%';
      strip.appendChild(slice);

      // Its own shading, so the curve is lit rather than merely drawn: a strip
      // turned further from the reader takes more shadow than its neighbour.
      const face = document.createElement('div');
      face.className = 'pdf-page-strip-shade';
      strip.appendChild(face);

      parent.appendChild(strip);
      strips.push({ strip, face });
      parent = strip;
    }

    // The shading that sells the fold: the leaf darkens along the spine.
    const shade = document.createElement('div');
    shade.className = 'pdf-page-leaf-shade';
    leaf.appendChild(shade);

    vp.appendChild(leaf);
    return { leaf, shade, strips };
  }

  /**
   * Puts the sheet where a turn of `p` (0..1) leaves it.
   *
   * The whole angle is shared out across the strips, but not evenly: a cosine
   * term takes degrees from the strips near the spine and gives them to the ones
   * near the free edge, which is what makes the sheet bow. It sums to zero, so
   * the sheet still arrives at exactly the angle it was asked for.
   *
   * The bow itself rises and falls with sin(pi*p) — flat when the page is down,
   * deepest as it passes edge-on, flat again as it lands. So does the lift off
   * the page and the twist, which together stop the turn reading as a hinge.
   */
  _paintTurn(live, p) {
    const { leaf, shade, strips, direction } = live;
    const next = direction === 'next';
    const sign = next ? -1 : 1;
    const swell = Math.sin(Math.PI * p);

    const total = TURN_ANGLE * p;
    const bend = TURN_BEND * swell;
    let cumulative = 0;

    for (let i = 0; i < strips.length; i += 1) {
      // cos over the strips averages to zero, so this redistributes the angle
      // without changing where the sheet ends up.
      const share = total / strips.length
        + bend * Math.cos((Math.PI * (i + 0.5)) / strips.length) / strips.length * 2;
      cumulative += share;
      strips[i].strip.style.transform = `rotateY(${sign * share}deg)`;
      // Light falls off as a strip turns away; near edge-on it is almost gone.
      const lit = Math.abs(Math.sin((cumulative * Math.PI) / 180));
      strips[i].face.style.opacity = String(Math.min(0.82, lit * 0.78));
    }

    // The sheet lifts, tips and twists as a whole — a page comes up out of the
    // gutter and leans, it does not swing on a door hinge.
    leaf.style.transform =
      `translateZ(${TURN_LIFT * swell}px) rotateX(${-2.4 * swell}deg) rotateZ(${sign * -1.5 * swell}deg)`;
    shade.style.opacity = String(0.42 * swell);
    // Its back is never drawn, so it goes out before the reverse would show.
    leaf.style.opacity = p <= TURN_FADE_FROM
      ? '1'
      : String(Math.max(0, 1 - (p - TURN_FADE_FROM) / (1 - TURN_FADE_FROM)));
  }

  /**
   * Starts a turn that the finger carries.
   *
   * The page underneath changes AT ONCE, while the leaf still lies flat over the
   * viewport at zero degrees. The reader cannot see it happen — they are looking
   * at the photograph — and it means the sliver opening at the spine shows the
   * page being turned TO, instead of a second copy of the one being left. A drag
   * that is abandoned puts the page back the same way, under a leaf on its way
   * back down.
   *
   * @returns {boolean} whether a live turn is now running.
   */
  beginLiveTurn(direction) {
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

    this._live = { ...made, direction, holder, width: rect.width || 1, progress: 0 };
    this._paintTurn(this._live, 0);
    if (direction === 'next') this.next(); else this.previous();
    return true;
  }

  /** Holds the sheet wherever the finger has carried it, 0..1. */
  dragLiveTurn(progress) {
    const live = this._live;
    if (!live) return;
    const p = Math.max(0, Math.min(1, progress));
    live.progress = p;
    this._paintTurn(live, p);
  }

  /**
   * Lets go of the sheet: over the rest of the way, or back down flat and the
   * page put back as it was.
   *
   * Animated frame by frame rather than handed to the compositor, because the
   * strips have to keep bending on the way out. A single keyframed transform
   * would stiffen the sheet into a board again for the last part of the turn,
   * which is the half the reader is actually watching.
   */
  endLiveTurn(commit) {
    const live = this._live;
    if (!live) return;
    this._live = null;
    const { leaf, holder, direction, progress } = live;

    if (!commit) {
      // Put the page back BEFORE the sheet moves, so the swap happens behind a
      // leaf that is still covering it.
      if (direction === 'next') this.previous(); else this.next();
    }

    const to = commit ? 1 : 0;
    const from = progress;
    // What is left of the journey, at the pace the whole of it would have gone.
    const duration = Math.max(140, Math.round(460 * Math.abs(to - from)));
    let raf = 0;
    const drop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      leaf.remove();
    };

    if (commit) {
      try {
        // The page arriving underneath comes up to meet it.
        holder.animate?.(
          [{ opacity: 0.72, transform: 'scale(0.99)' }, { opacity: 1, transform: 'none' }],
          { duration: Math.min(300, duration), easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
        );
      } catch (_) { /* no WAAPI: the page simply appears */ }
    }

    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = () => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const t = Math.min(1, (now - started) / duration);
      // Eased out: a released page falls quickly and settles, it does not coast.
      const eased = 1 - Math.pow(1 - t, 3);
      this._paintTurn(live, from + (to - from) * eased);
      if (t < 1) { raf = requestAnimationFrame(step); return; }
      drop();
    };

    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(step);
    else drop();

    // A leaf left lying over the live page is worse than a turn that does not
    // animate, so it comes off on a timer no matter what the frames do.
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
    const floor = Number(minZoom);
    this.minZoom = Number.isFinite(floor) && floor > 0 ? floor : ZOOM_MIN;
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

  _apply(nextState, needsRepaint) {
    // The floor applies to a MANUAL zoom here. A fit clamps itself inside
    // applyFit and keeps its mode; forcing setZoom on it would drop the mode to
    // NONE and stop the pane responding to resizes at all.
    if (nextState && this.minZoom
        && nextState.fitMode === FIT_MODES.NONE
        && nextState.zoom < this.minZoom - 1e-6) {
      nextState = setZoom(nextState, this.minZoom);
    }
    // Zoom about the middle of the frame, not the top-left corner.
    //
    // Scroll offsets are measured from the page's origin, so leaving them alone
    // across a zoom change keeps the top-left corner fixed and throws whatever
    // you were reading off the bottom-right. The document point under the
    // centre of the viewport is held instead, which is where attention is.
    if (nextState && this.state && nextState.zoom !== this.state.zoom) {
      nextState = this._anchorZoomToCentre(this.state, nextState);
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
      // A restored session keeps its exact zoom; a fresh open fits to width.
      if (!restoredView) {
        this.state = applyFit(this.state, FIT_MODES.WIDTH, this._viewport(), this.pageSize, this.minZoom);
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
   * Re-centres a zoom change on the point that was in the middle of the frame.
   *
   * A fit is exempt: it deliberately resets scroll to the page origin, and
   * re-anchoring it would fight the thing the user just asked for.
   */
  _anchorZoomToCentre(before, after) {
    if (after.fitMode !== FIT_MODES.NONE) return after;
    const viewport = this._viewport();
    if (!viewport.width || !viewport.height || !this.pageSize) return after;

    // The document-space point currently under the centre of the viewport.
    const docX = (before.scrollX + viewport.width / 2) / before.zoom;
    const docY = (before.scrollY + viewport.height / 2) / before.zoom;

    const content = {
      width: this.pageSize.width * after.zoom,
      height: this.pageSize.height * after.zoom,
    };
    const maxX = Math.max(0, content.width - viewport.width);
    const maxY = Math.max(0, content.height - viewport.height);
    const scrollX = Math.min(maxX, Math.max(0, docX * after.zoom - viewport.width / 2));
    const scrollY = Math.min(maxY, Math.max(0, docY * after.zoom - viewport.height / 2));

    if (scrollX === after.scrollX && scrollY === after.scrollY) return after;
    return { ...after, scrollX, scrollY };
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
    this.state = refit(this.state, this._viewport(), this.pageSize, this.minZoom);
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
