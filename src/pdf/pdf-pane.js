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
import { loadLayer, prefetchInk, saveLayer } from '../ink/ink-store.js';
import { notifyPeers, releaseLayer, shareLayer } from '../ink/ink-shared.js';
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
 * Travel before a one-finger drag is committed to panning or to turning.
 *
 * Smaller than TURN_GRAB on purpose: a pan should start under the hand rather
 * than after it, and a drag ruled a turn at 6px still waits until 28 before the
 * page actually lifts.
 */
const PAN_GRAB = 6;

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

/**
 * Paper colour behind the reverse of the sheet.
 *
 * The same white as the page. It was a shade warmer and darker, on the
 * reasoning that the back of a sheet catches less light — and over a white page
 * a slightly darker panel does not read as the back of anything, it reads as a
 * shadow lying across the page underneath. The fold is told by its crease.
 */
const TURN_BACK = '#ffffff';

/**
 * How many rasterised pages a pane keeps.
 *
 * Enough for the page being read, the one either side of it, and a couple more
 * behind — which covers turning back to check something and turning forward
 * again, the way a book is actually used. Bounded because these are bitmaps:
 * see CACHE_MAX_PIXELS for what is allowed in at all.
 */
const PAGE_CACHE_SIZE = 5;

/**
 * Biggest single bitmap worth keeping, in pixels (~24MB at four bytes each).
 *
 * One page may not take the whole budget below. A deep-zoom page would evict
 * everything else and then sit there unused, because a reader at that zoom is
 * studying one page rather than turning them.
 */
const CACHE_MAX_PIXELS = 6e6;

/**
 * Total the cache may hold, in pixels (~40MB at four bytes each).
 *
 * The count above is not a bound on its own — five pages at reading zoom is
 * about 36MB on this tablet, but five at 1.5x would be twice that. Whichever
 * limit bites first is the one that trims.
 */
const CACHE_TOTAL_PIXELS = 10e6;

/*
 * ── 「批注一多，放大缩小就卡」量过了，不是笔迹的问题 ──────────────────────
 *
 * 2026-09-13 在真机上按同一套动作（连按五次放大、等落地、再连按五次缩小）量
 * 帧间隔，同一栏、同一本书：
 *
 *     页 55（1078 笔 / 23077 个点）   p95 72.0ms   最坏 191ms   >50ms 39 帧
 *     页 100（零笔迹）                p95 74.6ms   最坏 177ms   >50ms 39 帧
 *
 * 一模一样。笔迹层一笔不画，也照样这么卡——代价在 PDF.js 每换一档缩放就把整页
 * 重新光栅化一次，那是主线程上 100–190ms 的活。
 *
 * 顺带也试过把铅笔按连续段成批画（原来每一笔都要在暂存画布上往返一趟、各建一个
 * createPattern）。四十笔从四十趟降到一趟，测试能证明，但真机上 p95 从 70.9ms
 * 变成 73.2ms —— 没有差别，所以那个改动撤掉了。逐笔搬运没有想象中贵：drawImage
 * 搬的是笔画的包围盒，不是整块画布。
 *
 * ── 后来是怎么治的（同日，同一台机器）──────────────────────────────────
 *
 * 当时猜的方向是上面那两条缓存上限。那条线没走 —— 它只能让「回到来过的缩放档」
 * 变便宜，而每到一个新档还是要在主线程上光栅化一次。真正的两刀在别处：
 *
 *   1. 光栅化搬进 worker（pdf-render-worker.js）。它没变快，但不再占主线程。
 *   2. worker 里留住最近 3 个 PDFPageProxy 不 cleanup。原来每渲完一页就清，等于
 *      同一页换个缩放就把那一页的图重解一遍 —— 扫描版教材上是半秒。
 *
 * 同一页连渲 6 个缩放级别，实测：
 *
 *     原来（主线程）  每次 488–544ms，合计 3111ms，帧间隔 p95 14ms、最坏 97ms
 *     现在（worker）  首次 602ms，之后 1–3ms，合计 610ms，p95 9ms、最坏 10ms
 *
 * 所以这两条上限没动，也不必动：位图缓存现在只负责「翻回来过的页」这件它本来就
 * 擅长的事，反复缩放已经不靠它了。
 */

/**
 * Hard ceiling on what a single rasterise may allocate (~32MB).
 *
 * `zoom * devicePixelRatio` at ZOOM_MAX on a 2x tablet asks for roughly
 * seventy million pixels of canvas, and that allocation does not fail
 * politely. Past this the scale is reduced and the smaller bitmap is stretched
 * to the same CSS size: softer at extreme zoom, which is a trade worth making
 * against a WebView that dies.
 */
const RASTER_MAX_PIXELS = 8e6;

/**
 * How long the screen must be still before neighbouring pages are drawn.
 *
 * Long enough to stay out of a fast run's way. This was tried at 90ms with two
 * pages ahead, on the theory that flipping quickly is when prefetching helps
 * most. It is the opposite: pdf.js has ONE worker, a page costs about half a
 * second on this tablet, and a reader flipping every 150ms cannot be kept ahead
 * of by any amount of prefetching. All the eager version achieved was to queue
 * the page the reader was actually waiting for behind two they had not asked
 * for — measured on the device at a median 1191ms per turn, against 8ms here,
 * and it starved the main thread badly enough to delay the ink reads and the
 * animation frames with it.
 *
 * So prefetching is for READING, where there is a pause between pages. A fast
 * run gets out of its own way instead, and says it is loading.
 */
const PREFETCH_DELAY = 260;

/**
 * How many pages ahead are drawn, in the direction the reader is going.
 *
 * One. Each page costs a worker slot the foreground render may need, and the
 * direction is the useful part, not the depth.
 */
const PREFETCH_AHEAD = 1;

/**
 * The most a page may be enlarged and still be turned with one finger.
 *
 * A little over the whole-page fit is still reading, not studying: at 110% or
 * 125% there is barely anywhere to slide the page to, and a sideways drag can
 * only sensibly mean "next page". Past this the reader has leaned in on a
 * particular working, one finger is how they move around it, and turning is
 * the ‹ › buttons' job.
 *
 * 1.3 is the reader's number, not the renderer's: `displayZoom()` counts from
 * the whole page, so this is exactly the 130% shown in the pane's toolbar.
 */
const TURN_MAX_ZOOM = 1.3;

/**
 * The longest a page will wait for its own annotations before showing anyway.
 *
 * Reads are 2-15ms on the tablet, so this is never reached in practice. It is
 * here so a page turn cannot be held hostage by the ink store: a reader must
 * never be stuck on one page because of what is written on the next.
 */
const INK_WAIT_MAX = 400;

/**
 * How long a page may take before the pane admits it is still working.
 *
 * Under this, saying nothing is right: a flicker of "loading" on a page that
 * arrives in 80ms is noise. Over it, the pane is showing the PREVIOUS page
 * under the new page's number, and staying silent about that is the thing the
 * tablet run objected to.
 */
const LOADING_GRACE = 140;

/**
 * How long a burst of zoom presses is gathered before the page is redrawn.
 *
 * Each press is shown at once by scaling the bitmap already on screen, exactly
 * as a pinch does; only the real rasterise waits. Tapping + four times is then
 * one render instead of four, and the four it is not doing were each blocking
 * the very thread that has to answer the next press.
 */
const ZOOM_SETTLE = 180;


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
    /** Rasterised pages, keyed by page and zoom. Insertion order is the LRU. */
    this._pageCache = new Map();
    this._prefetchTimer = null;
    this._zoomSettleTimer = null;
    /** True while a foreground rasterise is in flight, so prefetch stands off. */
    this._renderBusy = false;

    this._buildDom();

    // Ink lives on its own canvas and its own layer; the pane only tells it
    // what transform to draw under and which page's ink to hold.
    this.ink = new InkSurface(this.elInk, {
      onChange: () => this._scheduleInkSave(),
      onHistoryChange: () => this.handlers.onInkHistoryChange?.(this.ink),
      // A stroke starting here makes this the active pane, which is what makes
      // the shared toolbar push its tool, colour and width to THIS surface.
      onDrawStart: () => this.handlers.onFocus?.(),
      // 跨栏拖拽：这块画布不知道另一栏在哪，交给工作区去找。
      onDragOver: (at) => this.handlers.onInkDragOver?.(at),
      // 原样回传，不要折成布尔：落地的那一侧给的是一组把手，源那边要靠它把
      // 「撤销拖走」连到落下的那一份上。折成 true/false 的话，撤销之后两边
      // 各留一份。
      onDragDrop: (payload) => this.handlers.onInkDragDrop?.(payload) || null,
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

  /**
   * What the zoom would settle at if this pane were `width` wide.
   *
   * For previewing a divider drag with the number the release will actually
   * produce. Scaling the bitmap by how much the PANE grew is only right when
   * the fit is limited by width; a whole-page fit is usually limited by height,
   * which a sideways drag does not change at all — so the preview stretched the
   * page while the finger moved and the real refit snapped it back on release.
   * That snap is what a jump at the end of a drag looks like.
   *
   * Returns null when there is no fit to preview, i.e. the reader set the zoom
   * themselves and it is not the divider's to move.
   */
  fitZoomFor(width) {
    if (!this.state || !this.pageSize?.width || !this.pageSize?.height) return null;
    if (this.state.fitMode === FIT_MODES.NONE) return null;
    const height = this._viewport().height;
    if (!(width > 0) || !(height > 0)) return null;
    // Through applyFit rather than beside it, so the preview and the release
    // cannot drift apart.
    //
    // With ZOOM_MIN as the floor, NOT this.minZoom. The pane's floor is itself
    // the fit at the width it has right now (setMinZoom takes the smaller of
    // the caller's number and the whole-page scale), so asking about a NARROWER
    // pane clamped the answer straight back up to the current width's fit —
    // both widths priced the same, the factor came out 1, and there was no
    // preview at all. The release does not have that problem, because it
    // recomputes the floor from the new width first; so it moved, and the
    // still page jumped to meet it. A fit never lands below its own floor
    // anyway, which is why dropping it here changes nothing else.
    return applyFit(this.state, this.state.fitMode, { width, height },
                    this.pageSize, ZOOM_MIN).zoom;
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

          // A page bigger than its pane is read by sliding it, and until now it
          // could not be: one finger only ever turned pages, so zooming in with
          // two fingers showed a corner of the page and no way to reach the
          // rest of it. What the gesture means is decided ONCE, on the first
          // real movement, and does not change under the hand — deciding per
          // frame would turn a page the moment a pan ran out of room.
          //
          // Enlarged past TURN_MAX_ZOOM (130%), one finger only ever pans: a
          // turn there is the ‹ › buttons' job. At or below it, _roomToPan
          // decides — a page with nowhere to slide still turns.
          if (!swipe.turning && !swipe.mode && Math.hypot(dx, dy) >= PAN_GRAB) {
            swipe.mode = (this._zoomedPastTurning() || this._roomToPan(dx, dy)) ? 'pan' : 'turn';
            swipe.lx = e.clientX;
            swipe.ly = e.clientY;
          }
          if (swipe.mode === 'pan') {
            e.preventDefault();
            this._apply(
              panBy(this.state, e.clientX - swipe.lx, e.clientY - swipe.ly,
                    this._viewport(), this._contentSize()),
              false,
            );
            swipe.lx = e.clientX;
            swipe.ly = e.clientY;
            return;
          }

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
     * to pan, because at reading zoom one finger does not pan. Enlarged past
     * TURN_MAX_ZOOM it does nothing but pan, so a flick is not a turn either.
     */
    const maybeTurnPage = (from, e) => {
      if (this._zoomedPastTurning()) return false;
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
      // A drag that slid the page is finished. Without this the same gesture
      // would also be measured as a flick and turn the page it had just moved.
      if (from.mode === 'pan') return;
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
        // A wheel emits far faster than a page can be drawn, so these are
        // gathered the same way the buttons are.
        this._zoomTo(e.deltaY < 0 ? zoomIn(this.state) : zoomOut(this.state));
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
      const ctx = sheet.getContext('2d');
      ctx.drawImage(source, 0, 0);

      // The handwriting turns with the page it is written on.
      //
      // This photographed the PDF canvas and nothing else, and the ink lives on
      // a separate surface — so the sheet that curled away was the printed page
      // with every stroke stripped off it. On a worked page that is four
      // hundred strokes disappearing the instant the turn begins, which is
      // exactly what "the notes vanish when I flip pages" looks like from the
      // reading side. It was invisible while turns were slow and janky enough
      // to hide it.
      //
      // The ink surface spans the whole viewport in CSS pixels and the page
      // covers only part of it, so the page's own region is cut out and scaled
      // onto the sheet. drawImage clips a source rectangle that runs past the
      // edges, which is what happens whenever the page is zoomed past the pane.
      const ink = this.elInk;
      if (ink?.width && ink?.height && box.width > 0 && box.height > 0) {
        const kx = ink.width / box.width;
        const ky = ink.height / box.height;
        ctx.drawImage(
          ink,
          (rect.left - box.left) * kx, (rect.top - box.top) * ky,
          rect.width * kx, rect.height * ky,
          0, 0, sheet.width, sheet.height,
        );
      }
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
    /**
     * One side of the crease, as a polygon big enough to cover the page.
     *
     * It starts ON the crease and runs `far` in the direction asked for. It used
     * to start `far` out on that side and run `2 * far` back, which begins
     * beyond the page on one side and ends beyond it on the other — a polygon
     * covering the WHOLE plane, whichever side was asked for. Nothing was ever
     * clipped: the flap's paper was painted over the entire sheet, including the
     * part that had not moved and the part that should have been left clear for
     * the page arriving underneath. That is why a paused turn showed a blank
     * page, and why the fold read as a wash lying over everything.
     */
    const halfPlane = (side) => {
      const cx = k * nx;                  // the foot of the crease
      const cy = k * ny;
      const ex = -ny * far;               // along the crease
      const ey = nx * far;
      const ox = side * far * nx;         // and away from it, on one side only
      const oy = side * far * ny;
      ctx.beginPath();
      ctx.moveTo(cx + ex, cy + ey);
      ctx.lineTo(cx - ex, cy - ey);
      ctx.lineTo(cx - ex + ox, cy - ey + oy);
      ctx.lineTo(cx + ex + ox, cy + ey + oy);
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

  /**
   * Whether the page has anywhere left to go in the direction of this drag.
   *
   * Read along the drag's dominant axis, and against the direction of travel:
   * dragging the page RIGHT reveals what is off to its left, which needs the
   * view to be scrolled away from the left edge. Only consulted at the
   * whole-page fit, where there is no room on either axis, so nothing changes
   * for a reader who has not zoomed — a sideways swipe still turns the page.
   * Past TURN_MAX_ZOOM, `_zoomedPastTurning()` takes over and one finger only pans.
   */
  _roomToPan(dx, dy) {
    if (!this.state) return false;
    const v = this._viewport();
    const c = this._contentSize();
    const maxX = Math.max(0, c.width - v.width);
    const maxY = Math.max(0, c.height - v.height);
    const EDGE = 0.5;
    return Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? this.state.scrollX > EDGE : this.state.scrollX < maxX - EDGE)
      : (dy > 0 ? this.state.scrollY > EDGE : this.state.scrollY < maxY - EDGE);
  }

  /**
   * Whether the page is enlarged past the point where a swipe turns it.
   *
   * The gate for one-finger page turns. Up to TURN_MAX_ZOOM a sideways drag
   * turns the page; past it one finger only pans and the page is turned with
   * the ‹ › buttons. It was the whole-page fit exactly, which made a page
   * nudged to 110% unturnable by hand for no reason a reader would recognise.
   *
   * Keyed on the fit MODE as well as the number — a fit-to-width page taller
   * than its pane reads well above 1 but is still one swipe from turning,
   * because there is no width to slide it across; `_roomToPan` decides that
   * one. A manual zoom (pinch or the +/- buttons) drops the mode to NONE,
   * which is the state this is really asking about.
   */
  _zoomedPastTurning() {
    return this.state?.fitMode === FIT_MODES.NONE
      && (this.displayZoom() ?? 1) > TURN_MAX_ZOOM + 1e-3;
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

    // The PAGE's box, not the holder's.
    //
    // The holder is position:absolute inset:0 — it fills the pane, and the page
    // canvas sits inside it at whatever size the zoom makes it. Building the
    // sheet from the holder therefore stretched the page across the whole pane:
    // invisible while a page was bigger than the pane, and a 35% enlargement the
    // moment a whole page fitted inside one. What turns has to be the size the
    // page actually is.
    const rect = source.getBoundingClientRect();
    const box = vp.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    const made = this._makeLeaf(direction, vp, source, rect, box);
    if (!made) return false;

    // Held rather than re-measured: the element this came from is replaced when
    // the page under the sheet changes.
    const basis = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    this._live = { ...made, direction, holder, basis, progress: 0 };
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
    // put into them too — against the same box the sheet was cut from.
    const b = live.basis;
    this._paintTurn(live, { x: point.x - b.left, y: point.y - b.top });
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

    // Nothing is done to the page arriving underneath.
    //
    // It used to be faded up from 0.8, which dimmed the very thing the turn is
    // uncovering — the next page arrived shaded, as though the sheet leaving
    // cast something onto it. A page being turned to is just there.

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
    if (pageChanged && previousPage) {
      // Which way the reader is going, so the pages drawn ahead are the ones
      // they are about to reach rather than the ones they just left.
      this._pageStep = Math.sign(nextState.pageNumber - previousPage) || 1;
    }
    this.state = nextState;
    let inkReady = null;
    if (pageChanged) {
      // Ink belongs to a page, so leaving one commits its strokes and arriving
      // at the next loads that page's own layer.
      inkReady = this._swapInkPage(nextState.pageNumber);
    }
    if (needsRepaint || pageChanged) {
      // The page waits for its own annotations — see _render.
      this._render(inkReady);
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
    // At the scale the page is PAINTED at. During a pinch that is the live zoom
    // — the bitmap is the stand-in and the ink is already true — but during a
    // divider drag the zoom has not changed yet, and reading it left the
    // handwriting at its old size on a page that had changed size underneath
    // it: drifting off the words it belongs to, and drifting the opposite way
    // in each pane, because one was growing while the other shrank.
    const scale = this._drawnScale();
    this.ink.setTransform(scale, -x / scale, -y / scale);
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
    // The outgoing page and its layer are taken as a PAIR, here, synchronously,
    // and the surface is blanked in the same breath.
    //
    // The bitmap now lands in a single frame on a cached page, while ink is a
    // database round trip behind it. That left the previous page's annotations
    // drawn over the new page for as long as the read took — measured at 44ms
    // on the tablet, and over a second on a cold jump. Wrong ink on a page is
    // worse than no ink on it, and both read as "my notes disappeared".
    //
    // `_inkPage` is set to null at the same moment, which disowns the cleared
    // layer: a `_flushInkSave` arriving now — from the autosave timer, or from
    // unload — finds no page to write to and returns, instead of saving the
    // blank surface over the very strokes captured on the line above.
    const fromPage = this._inkPage;
    const outgoing = (this.meta && fromPage) ? this.ink.getLayer() : null;
    this._dropInk(this.meta?.id, fromPage);
    this._inkPage = null;
    clearTimeout(this._inkSaveTimer);
    this._inkSaveTimer = null;
    this.ink.loadLayer(null);

    this._inkSwap = this._inkSwap
      .then(() => this._performInkSwap(toPage, fromPage, outgoing))
      .catch((error) => {
        // One failed swap must not break the chain for every later page turn.
        Logger.warn('INK', `page swap to ${toPage} failed: ${error.message}`);
      });
    return this._inkSwap;
  }

  async _performInkSwap(toPage, fromPage, outgoing) {
    // Commit the layer that came off, to the page it came off — the pair the
    // caller captured together, so no interleaving can redirect either half.
    //
    // NOT awaited. The two touch different keys, and the pair is already
    // captured, so nothing about the incoming page's ink depends on the
    // outgoing page's write having finished. Awaiting it put a database write
    // in front of the read that decides whether the reader sees their notes,
    // and on a page turn that is the wrong way round.
    if (this.meta && fromPage && outgoing) {
      saveLayer(this.meta.id, fromPage, outgoing).catch(() => {
        // Losing one write must not break the chain; the next visit re-reads
        // what is stored, and the strokes are still in the layer object.
      });
    }
    if (!this.meta) {
      this._inkPage = toPage;
      return;
    }
    const layer = this._takeInk(this.meta.id, toPage, await loadLayer(this.meta.id, toPage));
    // Installed and recorded together — never one without the other.
    this.ink.loadLayer(layer);
    this._inkPage = toPage;
    this._syncInk();
  }

  /** Debounced so a long stroke sequence does not write on every sample. */
  _scheduleInkSave() {
    // 同一页也开在另一栏时，那一栏画的就是这同一层——它已经变了，只是还没重画。
    // 落盘可以攒 400ms 再写，重画不能：人一笔下去，另一边要立刻看见。
    notifyPeers(this.meta?.id, this._inkPage, this);
    clearTimeout(this._inkSaveTimer);
    this._inkSaveTimer = setTimeout(() => this._flushInkSave(), 400);
  }

  /**
   * 同一页的笔迹，两栏共用一份。
   *
   * 读出来的那一份交给登记处，换回「该用的那一份」：已经有人拿着同一页，就用他
   * 那一份。不然两边各拿各的副本，而存盘是整层盲写——后写的那一边会把先写的整个
   * 盖掉，人看到的是「我刚画的没了」，还是在另一栏里没的。
   */
  _takeInk(documentId, page, layer) {
    return shareLayer(documentId, page, layer, this, () => {
      // 另一栏改了这一层。这一栏手里是同一个对象，所以只要重画。
      this.ink.render();
    });
  }

  /** 不看这一页了。最后一个人走了，登记处才把它撤掉。 */
  _dropInk(documentId, page) {
    releaseLayer(documentId, page, this);
  }

  /** True while an edit has been made but not yet written to storage. */
  hasUnsavedInk() {
    return this._inkSaveTimer !== null;
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
    if (!this.meta || !this._inkPage) return;
    // Captured together, so a swap completing mid-await cannot redirect them.
    const documentId = this.meta.id;
    const page = this._inkPage;
    const layer = this.ink.getLayer();
    try {
      await saveLayer(documentId, page, layer);
    } catch (_) {
      // Losing one autosave must not break drawing; the next one retries.
    }
  }

  async loadDocument(doc, meta, restoredView, isCurrent = () => true) {
    if (!isCurrent()) return false;
    // Bitmaps are keyed by page and zoom, not by document, so anything left
    // over from a previous book would answer for this one — page 3 of the
    // exercise book shown as page 3 of the answer key. The workspace unloads
    // before it replaces, which already clears these; this is the guarantee
    // rather than the assumption, because the failure is silent and wrong.
    this._clearPageCache();
    // 同理：旧那一页的那一份共用的层也归还登记处。工作区换书前会先 unload，那里已
    // 经还过一次；这里是把「还过了」变成保证而不是假设——漏还的后果是那一页永远
    // 留在表里，下一个人翻到它拿到的是一份早就没人看的旧对象。
    this._dropInk(this.meta?.id, this._inkPage);
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
    const inkLayer = this._takeInk(meta.id, inkPage, await loadLayer(meta.id, inkPage));
    if (!isCurrent() || this.doc !== doc) {
      // 读这一层的工夫里这一栏换了人。登记是刚才领的，这里不还就永远挂着——而且
      // 挂的是这一栏，等于替一个已经不在的人占着位子。
      this._dropInk(meta.id, inkPage);
      return false;
    }
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
    // 这一页的那一份共用的层，也交还登记处。另一栏要是还停在同一页，它仍然拿着，
    // 表里那一项不会因为这一栏先走就作废。
    this._dropInk(this.meta?.id, this._inkPage);
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
    this._renderToken++;
    // Bitmaps of a book that is no longer open, and the timers that would go on
    // drawing more of them. Both belong to the document, not to the pane.
    this._clearPageCache();
    this._clearLoading();
    clearTimeout(this._zoomSettleTimer);
    this._zoomSettleTimer = null;
    this._renderedZoom = undefined;
    this._previewScale = 1;
    this.ink.setEnabled(false);
    this.ink.loadLayer(null);
    this.elHolder.innerHTML = '';
    this.elBody.hidden = true;
    this.elEmpty.hidden = false;
  }

  /** One page at one zoom, as it goes into and comes out of the cache. */
  _cacheKey(pageNumber, zoom) {
    return `${pageNumber}@${zoom.toFixed(4)}`;
  }

  /**
   * The cache, made on demand.
   *
   * A pane is not always built by its constructor: the workspace tests stand
   * one up from the prototype with only the fields they exercise, and this is
   * reached from `loadDocument`, which is the first thing they call. Same
   * lesson as `_syncOverlayState` — a thing that runs during setup and teardown
   * has to cope with the half of the object that is not there yet.
   */
  _cache() {
    if (!this._pageCache) this._pageCache = new Map();
    return this._pageCache;
  }

  /** Reads an entry and marks it most-recently-used. */
  _cacheTake(key) {
    const cache = this._cache();
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    cache.set(key, entry);                 // a Map keeps insertion order: LRU
    return entry;
  }

  /**
   * Keeps a rendered page, evicting the least recently used.
   *
   * Big bitmaps are declined rather than evicting three small ones to hold one
   * enormous one: at high zoom the reader is studying a page, not flipping
   * through, so a cache of deep zooms costs tens of megabytes to serve a turn
   * that is not coming.
   */
  _cachePut(key, entry) {
    if (!entry?.canvas) return;
    const pixels = entry.canvas.width * entry.canvas.height;
    if (pixels > CACHE_MAX_PIXELS) return;
    this._cache().set(key, { ...entry, pixels });
    this._evictDown();
  }

  /** Trims to both bounds — a page count, and a total the device can hold. */
  _evictDown() {
    const cache = this._cache();
    let total = 0;
    for (const entry of cache.values()) total += entry.pixels || 0;
    while (cache.size > 1
        && (cache.size > PAGE_CACHE_SIZE || total > CACHE_TOTAL_PIXELS)) {
      const oldest = cache.keys().next().value;
      const dropped = cache.get(oldest);
      cache.delete(oldest);
      total -= dropped?.pixels || 0;
      this._releaseCanvas(dropped?.canvas);
    }
  }

  /**
   * Hands an evicted bitmap's memory back now rather than eventually.
   *
   * Dropping the reference is enough for the collector in its own time, but
   * these are megabytes each on a device with few to spare, and its own time
   * tends to be the middle of the next page turn. Zeroing frees the backing
   * store at once.
   *
   * Never the canvas on screen. It can fall out of the cache while still being
   * the page the reader is looking at, and zeroing that one blanks the pane.
   */
  _releaseCanvas(canvas) {
    if (!canvas || canvas.parentNode) return;
    try { canvas.width = 0; canvas.height = 0; } catch (_) { /* not a real canvas */ }
  }

  _clearPageCache() {
    const cache = this._cache();
    for (const entry of cache.values()) this._releaseCanvas(entry.canvas);
    cache.clear();
    clearTimeout(this._prefetchTimer);
    this._prefetchTimer = null;
  }

  /** Installs a bitmap as the page on screen, at the zoom the state is at. */
  _showCanvas(canvas, zoom) {
    const content = this._contentSize();
    canvas.style.width = `${content.width}px`;
    canvas.style.height = `${content.height}px`;
    canvas.className = 'pdf-pane-canvas';
    // What zoom this bitmap stands for, so a pinch can scale it in place of a
    // zoom it has not been rasterised at yet.
    this._renderedZoom = zoom;
    this._previewScale = 1;
    this.elHolder.replaceChildren(canvas);
    this._position();
  }

  /**
   * Rasterises one page and returns it, without touching what is on screen.
   *
   * The scale is capped against a pixel budget: `zoom * dpr` at ZOOM_MAX on a
   * 2x tablet asks for a canvas of some seventy million pixels, which does not
   * fail politely. Capping costs sharpness at extreme zoom — the canvas is
   * still stretched to the full CSS size, so the geometry is unchanged — and
   * that is a far better trade than the tab dying.
   */
  async _rasterise(pageNumber, zoom) {
    const pageSize = await this.doc.pageSize(pageNumber);
    const wanted = zoom * devicePixelRatioSafe();
    const asked = pageSize.width * pageSize.height * wanted * wanted;
    const scale = asked > RASTER_MAX_PIXELS
      ? wanted * Math.sqrt(RASTER_MAX_PIXELS / asked)
      : wanted;
    const { canvas } = await this.doc.renderPage(pageNumber, scale);
    return { canvas, pageSize };
  }

  /**
   * Draws the current page.
   *
   * `inkReady` is the page's own annotations, still on their way. The bitmap
   * waits for them.
   *
   * A page and the notes written on it are one thing, and showing either
   * without the other is wrong in both directions. Before, the ink lingered
   * from the previous page and was briefly drawn over this one — wrong notes,
   * on the wrong page. Clearing it instead made that honest but no better to
   * look at: the page arrived in 5ms and its notes 60ms later, so every turn
   * flashed blank paper. Both readings of "the notes disappear when I turn the
   * page" are the same defect, which is that the two halves were raced against
   * each other at all.
   *
   * The wait is bounded. If the ink cannot be read the page must still turn —
   * navigation is not allowed to depend on the annotation store answering.
   */
  async _render(inkReady = null) {
    if (!this.doc || !this.state) return;
    // Drawing the page is exactly what a pending zoom settle was waiting to do,
    // and whatever asked for this render has superseded it. Left armed it fires
    // mid-await, resets the preview scale and starts a second render of the
    // same state — most visibly during a 整页 or 适合宽度 press that lands
    // inside the settle window.
    clearTimeout(this._zoomSettleTimer);
    this._zoomSettleTimer = null;
    const token = ++this._renderToken;
    const { pageNumber, zoom } = this.state;
    const key = this._cacheKey(pageNumber, zoom);

    // Already drawn, at this page and this zoom. Paging back and forth through
    // a chapter is the common case and it should cost nothing: the bitmap goes
    // straight back on screen in this frame, with no await to flash through.
    const hit = this._cacheTake(key);
    if (hit) {
      if (inkReady) await this._awaitInk(inkReady, token);
      if (token !== this._renderToken) return;
      this._clearLoading();
      this.pageSize = hit.pageSize;
      this._showCanvas(hit.canvas, zoom);
      this._schedulePrefetch();
      return;
    }

    try {
      this._renderBusy = true;
      this._markLoading();
      const { canvas, pageSize } = await this._rasterise(pageNumber, zoom);
      // A newer render started while this one was in flight — discard it rather
      // than painting a page the user has already navigated away from. It is
      // still worth keeping: it is exactly the page a reader who turned one too
      // far is about to come back to.
      if (token !== this._renderToken) {
        this._cachePut(key, { canvas, pageSize });
        return;
      }

      // A rasterise takes far longer than an ink read, so this has almost
      // always already resolved; it costs nothing to be sure.
      if (inkReady) await this._awaitInk(inkReady, token);
      if (token !== this._renderToken) return;

      this.pageSize = pageSize;
      this._showCanvas(canvas, zoom);
      this._cachePut(key, { canvas, pageSize });
      this._schedulePrefetch();
    } catch (error) {
      if (token !== this._renderToken) return;
      this.elHolder.replaceChildren(errorNode(error));
    } finally {
      this._renderBusy = false;
      this._clearLoading();
    }
  }

  /**
   * Says the pane is still working, once it has been working long enough to
   * be worth saying so.
   *
   * `_render` keeps the outgoing page on screen while it rasterises, which is
   * kinder than a white rectangle — but the page NUMBER has already changed,
   * so for as long as that takes the pane is showing one page under another
   * one's number and claiming nothing. On this tablet a cold page took a
   * second and a half. The grace period keeps the common, fast case silent.
   */
  /**
   * Waits for a page's annotations, but not indefinitely.
   *
   * The store answers in a couple of milliseconds from cache and a dozen or so
   * from the database. INK_WAIT_MAX is far past either, and exists only so a
   * page still turns if the annotation store stops answering — a reader must
   * never be stuck on a page because of what is written on the next one.
   */
  async _awaitInk(inkReady, token) {
    let timer;
    try {
      await Promise.race([
        inkReady,
        new Promise((resolve) => { timer = setTimeout(resolve, INK_WAIT_MAX); }),
      ]);
    } catch (_) {
      // A failed swap is the swap's own problem to log; the page still turns.
    } finally {
      clearTimeout(timer);
    }
    return token === this._renderToken;
  }

  _markLoading() {
    clearTimeout(this._loadingTimer);
    this._loadingTimer = setTimeout(() => {
      this._loadingTimer = null;
      this.root?.classList.add('is-page-loading');
    }, LOADING_GRACE);
  }

  _clearLoading() {
    clearTimeout(this._loadingTimer);
    this._loadingTimer = null;
    this.root?.classList.remove('is-page-loading');
  }

  /**
   * Draws the pages either side of this one, once the screen has settled.
   *
   * This is what makes a page turn instant rather than a second of blank paper:
   * by the time the finger arrives, the next page is already a bitmap. It runs
   * on a timer so it never competes with the page the reader is waiting for,
   * and only while the book is being READ — zoomed in past the whole page the
   * reader is studying one page, and rasterising its neighbours at that scale
   * buys nothing and costs a great deal of memory.
   */
  _schedulePrefetch() {
    clearTimeout(this._prefetchTimer);
    // The annotations either side, straight away.
    //
    // These are a few hundred bytes read from IndexedDB; they cost nothing and,
    // crucially, they do not touch the single pdf.js worker that the page
    // itself needs. So unlike the bitmaps below they are fetched eagerly — the
    // ink cache stays warm even through a fast run, where drawing pages ahead
    // is deliberately skipped.
    if (this.meta?.id && this.state) {
      const step = this._pageStep || 1;
      for (const page of [this.state.pageNumber + step, this.state.pageNumber - step]) {
        if (page >= 1 && page <= this.state.pageCount) prefetchInk(this.meta.id, page);
      }
    }
    if (this._zoomedPastTurning()) return;
    this._prefetchTimer = setTimeout(() => this._prefetchNeighbours(), PREFETCH_DELAY);
  }

  async _prefetchNeighbours() {
    this._prefetchTimer = null;
    if (!this.doc || !this.state || this._renderBusy) return;
    const doc = this.doc;
    const token = this._renderToken;
    const { pageNumber, zoom, pageCount } = this.state;

    // The way the reader is going first, and further that way than back.
    const step = this._pageStep || 1;
    const wanted = [];
    for (let i = 1; i <= PREFETCH_AHEAD; i++) wanted.push(pageNumber + step * i);
    wanted.push(pageNumber - step);

    for (const page of wanted) {
      if (page < 1 || page > pageCount) continue;
      // One at a time, and abandoned the moment the reader moves: a prefetch
      // that outlives its page is work done for a screen nobody is looking at,
      // and pdf.js is the same worker the foreground render needs.
      if (this.doc !== doc || this._renderToken !== token || this._renderBusy) return;
      const key = this._cacheKey(page, zoom);
      // The annotations too, and first: they are small and a database read is
      // what used to leave the page on screen without its notes.
      if (this.meta?.id) prefetchInk(this.meta.id, page);
      if (this._cache().has(key)) continue;
      try {
        const { canvas, pageSize } = await this._rasterise(page, zoom);
        if (this.doc !== doc || this._renderToken !== token) return;
        this._cachePut(key, { canvas, pageSize });
      } catch (_) {
        // A page that will not rasterise ahead of time is not an error worth
        // reporting; the reader will meet it properly if they turn to it.
        return;
      }
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
    // A divider preview supersedes a zoom preview, and the settle timer would
    // otherwise land in the middle of the drag: it resets the scale and starts
    // a render, and the next drag frame has to put the preview back. Rare —
    // it needs a zoom press and a divider grab inside 180ms — but the cure is
    // to drop the timer the moment something else takes over the transform.
    clearTimeout(this._zoomSettleTimer);
    this._zoomSettleTimer = null;
    const k = Number(factor);
    this._previewScale = Number.isFinite(k) && k > 0 ? k : 1;
    this.elHolder.style.transformOrigin = 'top left';
    this._position();
  }

  /**
   * 预览「这一栏此刻这么宽的话，适配之后是多大」。
   *
   * 定价基准是**屏幕上那张位图**，不是拖动开始时的栏宽——这是 `_previewScale`
   * 唯一说得通的基准，`_previewZoom` 用的也正是它（`state.zoom / _renderedZoom`）。
   *
   * 之前工作区算的是 `fitZoomFor(起点宽) → fitZoomFor(此刻宽)` 的比值再交给
   * `previewScale`。只要拖动途中落地一次真渲染，那个基准就废了：`_showCanvas`
   * 换掉位图并把 `_previewScale` 归 1，而下一帧又拿「相对起点」的比值去乘这张
   * 新位图——同一次缩放被乘了两遍，且每多渲染一次就再乘一遍。
   *
   * 真机上量到的就是这个。一栏从 889px 拖到 238px：页面边缘碰到栏边缘之前
   * （栏 407px）一切正常，之后页面缩得比栏还快——栏 302px 时页宽只剩 235px，
   * 栏 238px 时只剩 147px，两侧空出一大块。人看到的就是「边缘一碰就跳一下，
   * 然后越缩越不对」。
   *
   * 宽度也不再由调用方传进来：直接问自己的视口此刻多宽。栏宽含内边距，和视口
   * 差着几个像素，而那几个像素恰好在临界点附近决定按宽还是按高适配。
   */
  previewFitAt() {
    const rendered = this._renderedZoom;
    const target = this.fitZoomFor(this._viewport().width);
    if (!(rendered > 0) || !(target > 0)) { this.reposition(); return; }
    clearTimeout(this._zoomSettleTimer);
    this._zoomSettleTimer = null;
    this._previewScale = target / rendered;
    this.elHolder.style.transformOrigin = 'top left';
    this._position();
  }

  /**
   * A zoom step: shown at once, rasterised once the presses stop.
   *
   * The same stand-in a pinch uses — the bitmap already on screen is scaled to
   * the new zoom by the GPU, so the press answers in the frame it happened —
   * and only the real render is delayed. Rasterising on every press queued a
   * full page render behind each of them, so stepping 100% → 300% paid for five
   * renders and spent the whole way there watching an older one arrive. This is
   * the "zoom is slow" the tablet run reported.
   *
   * A pane with nothing drawn yet has nothing to scale, so it renders outright.
   */
  _zoomTo(nextState) {
    if (!(this._renderedZoom > 0)) { this._apply(nextState, true); return; }
    this._apply(nextState, false);
    this._previewZoom();
    clearTimeout(this._zoomSettleTimer);
    this._zoomSettleTimer = setTimeout(() => {
      this._zoomSettleTimer = null;
      this._commitPreviewZoom();
    }, ZOOM_SETTLE);
  }

  /**
   * Re-places the page for the size the pane is NOW, without re-rasterising.
   *
   * For the pane the divider is not allowed to re-zoom. A page smaller than its
   * pane is centred, and a pane changing width moves the centre — so a manually
   * zoomed page, left alone through a drag, stayed pinned where it was and slid
   * out of the middle as the pane grew around it, then jumped back the moment
   * the finger lifted. Nearly ninety pixels of it, on the tablet, and only on
   * whichever side was not on a fit: one gesture, two different animations.
   */
  reposition() {
    if (!this.state) return;
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

  /**
   * The zoom the page is actually PAINTED at, which is not always the one in
   * the state.
   *
   * A preview transform stands in for a zoom the bitmap has not been rasterised
   * at yet, so what reaches the screen is the canvas — drawn at `_renderedZoom`
   * — scaled by `_previewScale`. During a pinch those two multiply back to
   * `state.zoom` and this is exactly that. During a divider drag they do not:
   * the zoom has not changed yet, and the scale is the refit that the release
   * is going to land on.
   */
  _drawnScale() {
    const zoom = this.state?.zoom;
    if (!zoom) return 1;
    const rendered = this._renderedZoom;
    const k = this._previewScale;
    return rendered > 0 && k > 0 ? rendered * k : zoom;
  }

  /** The page's size on screen, at the scale it is being painted at. */
  _drawnSize() {
    if (!this.pageSize) return { width: 0, height: 0 };
    const scale = this._drawnScale();
    return {
      width: this.pageSize.width * scale,
      height: this.pageSize.height * scale,
    };
  }

  /**
   * Where the page's top-left corner sits, in viewport pixels.
   *
   * Measured against the size the page is DRAWN at, not the size its zoom
   * implies. The two differ only while a preview stands in for a refit — and
   * that is precisely when it matters. Centring by the old size left the page
   * off-centre by half the difference, and a divider drag grows one pane while
   * it shrinks the other, so the error ran one way on the left and the other
   * way on the right: the same drag, animated differently on each side of it.
   *
   * The scroll offset travels with the scale for the same reason. It is
   * measured in the page's own pixels at the zoom in the state, so a page
   * painted larger has to be offset further, or the preview and the refit
   * disagree by exactly the distance the reader had scrolled.
   */
  _origin() {
    const drawn = this._drawnSize();
    const viewport = this._viewport();
    const shown = this.state.zoom > 0 ? this._drawnScale() / this.state.zoom : 1;
    const slackX = viewport.width - drawn.width;
    const slackY = viewport.height - drawn.height;
    return {
      x: slackX > 0 ? slackX / 2 : -Math.min(this.state.scrollX * shown, -slackX),
      y: slackY > 0 ? slackY / 2 : -Math.min(this.state.scrollY * shown, -slackY),
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
  zoomIn() { if (this.doc) this._zoomTo(zoomIn(this.state)); }
  zoomOut() { if (this.doc) this._zoomTo(zoomOut(this.state)); }
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
