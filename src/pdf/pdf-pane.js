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
      swipe = null;                       // the finger that was swiping is now half a pinch
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
    const turning = this._liftPage(direction);
    if (direction === 'next') this.next(); else this.previous();
    turning?.();
  }

  /**
   * Lifts the current sheet so the next one can be revealed under it.
   *
   * Returns a function that plays the turn, or null when there is nothing to
   * animate. The split matters: the snapshot has to be taken BEFORE the page
   * state changes, and the turn has to start AFTER the new page has begun
   * rendering underneath, or the reader watches a page turn over to reveal
   * the page it just left.
   *
   * What turns is a photograph of the canvas, not the canvas itself. Rotating
   * the live one would rotate the ink layer and the PDF layer separately, and
   * anything rendered mid-turn would land on a sheet that is edge-on.
   *
   * The back of the sheet is hidden rather than drawn. A real book shows the
   * reverse of the leaf, which here would be the mirror image of the page just
   * left — legible, backwards, and wrong. Hiding it reads as the sheet passing
   * out of the light, which is what the eye expects at that angle anyway.
   */
  _liftPage(direction) {
    const holder = this.elHolder;
    const vp = this.elViewport;
    if (!holder || !vp || typeof holder.animate !== 'function') return null;
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    } catch (_) { /* no matchMedia: animate */ }

    const source = holder.querySelector('canvas');
    if (!source || !source.width || !source.height) return null;

    const rect = holder.getBoundingClientRect();
    const box = vp.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

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
    sheet.style.width = '100%';
    sheet.style.height = '100%';
    leaf.appendChild(sheet);

    // The shading that sells it: the leaf darkens along the spine as it lifts.
    const shade = document.createElement('div');
    shade.className = 'pdf-page-leaf-shade';
    leaf.appendChild(shade);

    vp.appendChild(leaf);

    return () => {
      // Forward turns about the LEFT edge, back turns about the right, so the
      // sheet always pivots on the spine the reader is moving away from.
      const next = direction === 'next';
      leaf.style.transformOrigin = next ? 'left center' : 'right center';
      const to = next ? -170 : 170;

      const turn = leaf.animate(
        [
          { transform: 'rotateY(0deg)', opacity: 1, offset: 0 },
          { transform: `rotateY(${to * 0.55}deg)`, opacity: 1, offset: 0.55 },
          { transform: `rotateY(${to}deg)`, opacity: 0, offset: 1 },
        ],
        { duration: 420, easing: 'cubic-bezier(0.4, 0.05, 0.25, 1)', fill: 'forwards' },
      );
      shade.animate(
        [{ opacity: 0 }, { opacity: 0.42, offset: 0.5 }, { opacity: 0 }],
        { duration: 420, easing: 'ease-in-out' },
      );
      // The page arriving underneath comes up to meet it.
      holder.animate(
        [{ opacity: 0.55, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }],
        { duration: 300, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
      );

      const done = () => leaf.remove();
      turn.addEventListener('finish', done);
      turn.addEventListener('cancel', done);
      // A belt-and-braces removal: an animation that never fires either event
      // — a backgrounded tab, a cancelled composite — must not leave a dead
      // page lying over the live one.
      setTimeout(done, 900);
    };
  }

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
