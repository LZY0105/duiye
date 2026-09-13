// PDF Module — the panel that drops over one column to help you find a page.
//
// Two faces of the same question. 目录 is the book's own bookmarks, which is
// the fastest way in when a book has them and is simply missing from plenty of
// scanned ones. 缩略图 is every page as a picture, which is always available
// because it IS the pages, and is how you find something you would recognise
// on sight but cannot name.
//
// They live together because they answer the same question, and a reader who
// draws a blank in one wants the other in the same breath rather than after
// hunting for a second button.
//
// It covers its own column and nothing else: the panel is a child of the slot,
// so the other book stays readable while you look. How much of the column it
// takes is dragged and remembered — see panel-state.js for why that is a
// fraction and not a pixel count.

import { PANEL_TABS, shouldClose, thumbWindow } from './panel-state.js';
import { t } from '../core/i18n.js';
import { bookmarkLabel, hasBookmark } from './bookmark-state.js';
import { loadLayer } from '../ink/ink-store.js';
import { createTransform, drawStroke } from '../ink/ink-renderer.js';

/**
 * How many rendered pages may be held at once.
 *
 * A thumbnail is a rasterised page. This reader's book is 827 of them, and
 * keeping every page ever scrolled past is how the thing that helps you find a
 * page becomes the reason the app runs out of memory. Pages outside the window
 * around what is on screen give their canvas back.
 */
const THUMB_KEEP_RADIUS = 24;

/** Long edge of a thumbnail, in CSS pixels, before the device ratio. */
const THUMB_LONG_EDGE = 132;

/**
 * How many pages may be rasterising at once.
 *
 * Not "as many as are on screen". pdf.js decodes and paints largely on the
 * main thread, so twenty pages started together do not finish sooner — they
 * finish at the same time, all at the end, after twenty pages' worth of work
 * during which nothing at all has appeared. A few at a time, nearest first,
 * puts something under the reader's eyes almost immediately and lets the rest
 * arrive while they are already looking.
 */
const THUMB_CONCURRENCY = 3;

/**
 * Device pixels per CSS pixel for a thumbnail.
 *
 * Two, and measured rather than assumed. It was dropped to 1.25 to buy speed —
 * a 2.56x cut in pixels — and on the device that bought nothing at all: pages
 * still arrived one every ~430ms, the same cadence as before, because the cost
 * here is pdf.js parsing the page (fonts, operator lists) and that does not
 * care what size you ask it to paint. So the sharpness is free, and taken.
 *
 * Past two, though, is genuinely wasted: it is a picture you glance at to
 * recognise a page, not one you read, and the cache holds 25 of them.
 */
const THUMB_MAX_DPR = 2;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export class PagePanel {
  /**
   * @param {HTMLElement} host  the slot element this panel belongs to
   * @param {{getState: function, onState: function, getDoc: function,
   *          getPageCount: function, getCurrentPage: function,
   *          onGoToPage: function, onOpenChange: function}} handlers
   */
  constructor(host, handlers = {}) {
    this.host = host;
    this.handlers = handlers;
    this.el = host.querySelector('[data-role="outline-panel"]');
    this.outline = null;
    /** page number → canvas, for the pages currently worth keeping. */
    this._thumbs = new Map();
    /** page number → the cell that shows it. */
    this._cells = new Map();
    /** Pages asked for but not started, re-sorted at the moment one starts. */
    this._queue = [];
    this._active = 0;
    this._observer = null;
    this._visible = new Set();
    this._built = false;
    this._drag = null;
    /** 拖动中的实时比例，只写 CSS 变量，松手才落到 state。 */
    this._live = null;
    this._renderToken = 0;
    if (this.el) this._build();
  }

  get isOpen() { return !!this.el && !this.el.hidden; }

  get _state() { return this.handlers.getState?.() || { tab: PANEL_TABS.OUTLINE, height: 0.42 }; }

  // ── shell ─────────────────────────────────────────────────────────────────

  _build() {
    if (this._built) return;
    this._built = true;
    this.el.classList.add('pdf-page-panel');
    this.el.innerHTML = `
      <div class="pdf-panel-tabs" role="tablist" aria-label="查找页面">
        <button type="button" class="pdf-panel-tab" role="tab" data-tab="${PANEL_TABS.OUTLINE}"
                aria-selected="false"></button>
        <button type="button" class="pdf-panel-tab" role="tab" data-tab="${PANEL_TABS.THUMBS}"
                aria-selected="false"></button>
        <button type="button" class="pdf-panel-tab" role="tab" data-tab="${PANEL_TABS.MARKS}"
                aria-selected="false"></button>
      </div>
      <div class="pdf-panel-body" data-role="panel-body"></div>
      <div class="pdf-panel-grip" data-role="panel-grip" role="separator"
           aria-orientation="horizontal" tabindex="0"
           aria-label="拖动以调整面板高度" title="拖动以调整面板高度"><span></span></div>
    `;
    this.body = this.el.querySelector('[data-role="panel-body"]');
    this.el.querySelector(`[data-tab="${PANEL_TABS.OUTLINE}"]`).textContent = t('panel.outline');
    this.el.querySelector(`[data-tab="${PANEL_TABS.THUMBS}"]`).textContent = t('panel.thumbs');
    this.el.querySelector(`[data-tab="${PANEL_TABS.MARKS}"]`).textContent = t('panel.marks');

    for (const tab of this.el.querySelectorAll('.pdf-panel-tab')) {
      tab.addEventListener('click', () => this._chooseTab(tab.dataset.tab));
    }
    this._bindGrip();

    // Escape closes it, wherever focus happens to be — the same way out the
    // deck list has. Two slabs that cover a column the same way should not
    // need to be dismissed differently.
    this._onKey = (e) => {
      if (e.key !== 'Escape' || !this.isOpen) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    };
    document.addEventListener('keydown', this._onKey, true);
  }

  _chooseTab(tab) {
    if (!tab) return;
    this.handlers.onState?.(s => s.selectTab(tab));
    this._paint();
  }

  open() {
    if (!this.el || !this.el.hidden) return;
    this.el.hidden = false;
    this._applyHeight();
    this._paint();
    this.handlers.onOpenChange?.(true);
  }

  close() {
    if (!this.el || this.el.hidden) return;
    this.el.hidden = true;
    // The grid and its observer go; the pictures stay.
    //
    // They used to go too, so every reopen rasterised the same pages again and
    // the reader waited through it again — for a book they had not changed and
    // a page they had not left. What is on screen only stops being true when
    // the book does, so that is when they are dropped: see reset().
    this._teardownGrid();
    this._trimThumbs();
    this.handlers.onOpenChange?.(false);
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  /**
   * The book changed, or went away — the one thing that makes every picture
   * in the cache a picture of something else.
   */
  reset() {
    this.outline = null;
    this.close();
    this._releaseThumbs();
    if (this.body) this.body.replaceChildren();
  }

  setOutline(outline) {
    this.outline = outline;
    if (this.isOpen) this._paint();
  }

  /** The marks changed under it; only the marks face has to be redrawn. */
  refreshMarks() {
    if (!this.isOpen) return;
    if (this._state.tab === PANEL_TABS.MARKS) this._paint();
    else if (this._state.tab === PANEL_TABS.THUMBS) this._syncMarkFlags();
  }

  /** Adds or removes the flag on cells without rebuilding the grid. */
  _syncMarkFlags() {
    const marks = this.handlers.getBookmarks?.() || [];
    for (const [n, cell] of this._cells) {
      const want = hasBookmark(marks, n);
      cell.classList.toggle('is-marked', want);
      const shot = cell.querySelector('.pdf-thumb-shot');
      if (!shot) continue;
      const flag = shot.querySelector('.pdf-thumb-flag');
      if (want && !flag) {
        const el = document.createElement('span');
        el.className = 'pdf-thumb-flag';
        el.setAttribute('aria-hidden', 'true');
        shot.appendChild(el);
      } else if (!want && flag) {
        flag.remove();
      }
    }
  }

  /** The reader turned a page elsewhere; the panel should agree. */
  syncCurrentPage() {
    if (!this.isOpen || this._state.tab !== PANEL_TABS.THUMBS) return;
    const page = this.handlers.getCurrentPage?.() || 1;
    for (const [n, cell] of this._cells) {
      cell.classList.toggle('is-current', n === page);
      cell.setAttribute('aria-current', n === page ? 'page' : 'false');
    }
  }

  destroy() {
    if (this._onKey) document.removeEventListener('keydown', this._onKey, true);
    this._onKey = null;
    this._observer?.disconnect();
    this._observer = null;
    this._releaseThumbs();
  }

  // ── height ────────────────────────────────────────────────────────────────

  _applyHeight({ measure = true } = {}) {
    if (!this.el) return;
    this.el.style.setProperty('--panel-height', `${this._state.height * 100}%`);
    // The top edge only moves when the chrome above it does, which a resize
    // never does — so the drag never pays for this read.
    if (measure) this._syncTop();
  }

  /**
   * Where the page starts, so the panel can hang over it without displacing it.
   *
   * The panel used to be a flex child of the column, which meant every pixel it
   * grew pushed the page down by one: dragging it bigger scrolled the thing you
   * were looking at out from under you, which is the opposite of what a "find
   * the page" panel is for. It floats instead, and the chrome above it is
   * measured rather than assumed — the toolbar and the switching strip have
   * both changed height twice already.
   */
  _syncTop() {
    const pane = this.host.querySelector('[data-role="pane"]:not([hidden])')
      || this.host.querySelector('[data-role="pane"]');
    if (!pane) return;
    this.el.style.setProperty('--panel-top', `${Math.max(0, pane.offsetTop)}px`);
  }

  /**
   * Drag the bottom edge to say how much of the column this may cover.
   *
   * On the panel's own element rather than on the window, and captured, so a
   * drag that wanders over the page underneath keeps resizing instead of
   * turning into a page pan halfway through.
   */
  _bindGrip() {
    const grip = this.el.querySelector('[data-role="panel-grip"]');
    if (!grip) return;

    // Measured ONCE, when the finger goes down. The column cannot change size
    // during its own drag, and asking for its box on every pointermove is a
    // forced reflow per event — read the layout, write a CSS variable, read it
    // again, forty times a second, with an 827-cell grid to re-lay each time.
    // That was the lag.
    let box = null;
    const fractionAt = (clientY) => {
      if (!box || !box.height) return this._state.height;
      return (clientY - box.top) / box.height;
    };

    // One paint per frame, whatever the pointer rate. Coalescing here is what
    // keeps a 240Hz stylus from asking for 240 layouts a second.
    let pending = 0;
    const paint = () => {
      pending = 0;
      const raw = this._live;
      const height = Math.min(0.85, Math.max(0.25, raw));
      this.el.style.setProperty('--panel-height', `${height * 100}%`);
      // Said while the finger is still down, not sprung on them after: the
      // panel stops shrinking at MIN, so without this the last stretch of the
      // pull would look like nothing was happening.
      this.el.classList.toggle('is-closing', shouldClose(raw));
    };

    grip.addEventListener('pointerdown', (e) => {
      this._drag = e.pointerId;
      box = this.host.getBoundingClientRect();
      this._live = this._state.height;
      grip.classList.add('is-dragging');
      // Rasterising pages while the panel is being resized is work thrown away
      // on the next frame, and it competes with the drag for the main thread.
      this.el.classList.add('is-resizing');
      try { grip.setPointerCapture(e.pointerId); } catch (_) { /* unsupported */ }
      e.preventDefault();
      e.stopPropagation();
    });

    grip.addEventListener('pointermove', (e) => {
      if (this._drag !== e.pointerId) return;
      e.preventDefault();
      this._live = fractionAt(e.clientY);
      // No state, no persist, no layout read — the drag writes one variable.
      // What the reader chose is committed once, when they let go.
      if (!pending) pending = requestAnimationFrame(paint);
    });

    const end = (e) => {
      if (this._drag !== e.pointerId) return;
      this._drag = null;
      if (pending) { cancelAnimationFrame(pending); pending = 0; }
      grip.classList.remove('is-dragging');
      this.el.classList.remove('is-closing', 'is-resizing');
      try { grip.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
      const raw = Number.isFinite(this._live) ? this._live : this._state.height;
      if (shouldClose(raw)) {
        // Pulled shut. The height it had before the pull is what it opens at
        // next time — the drag was a way out, not a new preference.
        this.close();
        return;
      }
      this.handlers.onState?.(s => s.setHeight(raw), { persist: true });
      this._applyHeight();
      // Dragged bigger, it may now be over the ink bar; dragged smaller, it may
      // have let go of it. Judged once, on release — not on every frame.
      this.handlers.onResize?.();
      // Catch up on whatever came into view while the grid was growing.
      for (const n of this._visible) this._want(n);
      this._pump();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);

    // The keyboard gets the same control, in steps. A grip that only answers a
    // pointer is a control the reader cannot reach with a keyboard at all.
    grip.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowUp' ? -0.05 : e.key === 'ArrowDown' ? 0.05 : 0;
      if (!step) return;
      e.preventDefault();
      this.handlers.onState?.(s => s.setHeight(this._state.height + step), { persist: true });
      this._applyHeight();
    });
  }

  // ── faces ─────────────────────────────────────────────────────────────────

  _paint() {
    if (!this.body) return;
    const tab = this._state.tab;
    for (const el of this.el.querySelectorAll('.pdf-panel-tab')) {
      const on = el.dataset.tab === tab;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-selected', String(on));
    }
    this.el.dataset.tab = tab;
    // The grid is rebuilt from scratch; the pictures in it are not. Switching
    // to the contents and back, or closing and reopening, must not cost the
    // reader the same rasterising twice.
    this._teardownGrid();
    if (tab === PANEL_TABS.THUMBS) this._paintThumbs();
    else if (tab === PANEL_TABS.MARKS) this._paintMarks();
    else this._paintOutline();
    this._applyHeight();
  }

  _paintOutline() {
    const outline = this.outline;
    if (!outline) {
      this.body.innerHTML = '<div class="pdf-outline-empty">正在加载目录…</div>';
      return;
    }
    if (!outline.available || outline.items.length === 0) {
      // Said plainly, and pointing at the face that never comes up empty.
      this.body.innerHTML = `<div class="pdf-outline-empty">${esc(t('pdf.noOutline'))}`
        + '<button type="button" class="pdf-outline-suggest" data-role="to-thumbs">'
        + '改用缩略图查找</button></div>';
      this.body.querySelector('[data-role="to-thumbs"]')
        ?.addEventListener('click', () => this._chooseTab(PANEL_TABS.THUMBS));
      return;
    }

    const list = document.createElement('ul');
    list.className = 'pdf-outline-list';
    const walk = (items) => {
      for (const item of items) {
        const li = document.createElement('li');
        li.className = 'pdf-outline-item';
        li.style.paddingInlineStart = `${item.depth * 12}px`;

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'pdf-outline-link';
        label.textContent = item.title || '(未命名)';
        if (item.pageNumber) {
          label.addEventListener('click', () => this.handlers.onGoToPage?.(item.pageNumber));
        } else {
          label.disabled = true;
          label.title = '该目录项没有可解析的目标页';
        }
        li.appendChild(label);
        list.appendChild(li);
        if (item.children.length) walk(item.children);
      }
    };
    walk(outline.items);
    this.body.replaceChildren(list);
  }

  /**
   * The reader's own marks, in reading order.
   *
   * Deliberately plain: a page number, whatever they called it, and a way to
   * take it off again. The book's table of contents is the other tab and the
   * pictures are the tab after that; this one is short by nature and is
   * scanned rather than browsed.
   */
  _paintMarks() {
    const marks = this.handlers.getBookmarks?.() || [];
    if (!marks.length) {
      this.body.innerHTML = `<div class="pdf-outline-empty">${esc(t('panel.noMarks'))}</div>`;
      return;
    }
    const current = this.handlers.getCurrentPage?.() || 0;
    const list = document.createElement('ul');
    list.className = 'pdf-mark-list';

    for (const mark of marks) {
      const li = document.createElement('li');
      li.className = 'pdf-mark-row';
      if (mark.page === current) li.classList.add('is-current');
      li.innerHTML = `
        <button type="button" class="pdf-mark-go">
          <span class="pdf-mark-page">${esc(mark.page)}</span>
          <span class="pdf-mark-label"></span>
        </button>
        <button type="button" class="pdf-mark-name" aria-label="${esc(t('panel.nameMark'))}"
                title="${esc(t('panel.nameMark'))}">✎</button>
        <button type="button" class="pdf-mark-drop" aria-label="${esc(t('panel.removeMark'))}"
                title="${esc(t('panel.removeMark'))}">×</button>`;
      li.querySelector('.pdf-mark-label').textContent = bookmarkLabel(mark);
      li.querySelector('.pdf-mark-go')
        .addEventListener('click', () => this.handlers.onGoToPage?.(mark.page));
      // 标一页是一下的事，起名字不是——所以按钮加书签时不问名字，名字在这里给。
      // 反过来做的话，每标一页都要先想一个名字，而多数书签是「就这儿」，没名字。
      li.querySelector('.pdf-mark-name')
        .addEventListener('click', async () => {
          await this.handlers.onNameBookmark?.(mark);
          this._paint();
        });
      li.querySelector('.pdf-mark-drop')
        .addEventListener('click', () => {
          this.handlers.onToggleBookmark?.(mark.page);
          this._paint();
        });
      list.appendChild(li);
    }
    this.body.replaceChildren(list);
  }

  /**
   * Every page, as a cell — but only the visible ones as a picture.
   *
   * The whole grid is laid out up front so the scrollbar tells the truth about
   * how long the book is and the reader can throw it to the middle. What each
   * cell costs until it is looked at is one empty box of the right shape.
   */
  _paintThumbs() {
    const total = this.handlers.getPageCount?.() || 0;
    if (!total) {
      this.body.innerHTML = '<div class="pdf-outline-empty">没有可显示的页面</div>';
      return;
    }
    const current = this.handlers.getCurrentPage?.() || 1;
    const ratio = this._pageRatio();
    const marks = this.handlers.getBookmarks?.() || [];

    const grid = document.createElement('ol');
    grid.className = 'pdf-thumb-grid';
    this._cells.clear();

    for (let n = 1; n <= total; n++) {
      const li = document.createElement('li');
      li.className = 'pdf-thumb-cell';
      if (n === current) li.classList.add('is-current');
      li.setAttribute('aria-current', n === current ? 'page' : 'false');
      li.dataset.page = String(n);
      const marked = hasBookmark(marks, n);
      if (marked) li.classList.add('is-marked');
      li.innerHTML = `
        <button type="button" class="pdf-thumb-hit" aria-label="第 ${esc(n)} 页">
          <span class="pdf-thumb-shot" style="aspect-ratio:${ratio}">${
            marked ? '<span class="pdf-thumb-flag" aria-hidden="true"></span>' : ''}</span>
          <span class="pdf-thumb-num">${esc(n)}</span>
        </button>`;
      li.querySelector('.pdf-thumb-hit')
        .addEventListener('click', () => this.handlers.onGoToPage?.(n));
      // Already painted, from before this panel was closed: hang it straight
      // back up. This is the whole point of keeping them.
      const kept = this._thumbs.get(n);
      if (kept) this._hang(kept, li);
      this._cells.set(n, li);
      grid.appendChild(li);
    }
    this.body.replaceChildren(grid);
    this._watchThumbs();

    // Land on the page being read rather than at page 1: the reader opened
    // this to go somewhere NEAR where they are far more often than to start
    // the book again.
    const cell = this._cells.get(current);
    if (cell) cell.scrollIntoView({ block: 'center' });
  }

  /** Page shape, taken from the first page and used for all of them. */
  _pageRatio() {
    const size = this.handlers.getPageSize?.();
    if (size && size.width > 0 && size.height > 0) {
      return `${size.width} / ${size.height}`;
    }
    return '1 / 1.414';   // A4 portrait, the safe guess for an exercise book
  }

  _watchThumbs() {
    this._observer?.disconnect();
    this._visible.clear();
    if (typeof IntersectionObserver !== 'function') {
      // No observer: ask for a first screenful so the panel is not empty, and
      // leave it at that rather than rasterising the whole book.
      for (const [n] of [...this._cells].slice(0, 12)) this._want(n);
      this._pump();
      return;
    }
    this._observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const n = Number(entry.target.dataset.page);
        if (entry.isIntersecting) { this._visible.add(n); this._want(n); }
        else { this._visible.delete(n); this._drop(n); }
      }
      this._evictThumbs();
      this._pump();
    }, { root: this.body, rootMargin: '240px 0px' });

    for (const cell of this._cells.values()) this._observer.observe(cell);
  }

  /** The page the reader is looking at, which is the one worth having first. */
  _anchor() {
    if (this._visible.size) {
      // The middle of what is on screen, not its first row: scrolling stops
      // with the eye in the middle of the band, not at the top of it.
      const seen = [...this._visible].sort((a, b) => a - b);
      return seen[Math.floor(seen.length / 2)];
    }
    return this.handlers.getCurrentPage?.() || 1;
  }

  /** Asks for a page. Cheap, idempotent, and safe to call on every scroll tick. */
  _want(page) {
    if (this._thumbs.has(page)) return;   // painted, or already on its way
    if (!this._queue.includes(page)) this._queue.push(page);
  }

  /** Withdraws a request that has not started yet. */
  _drop(page) {
    const at = this._queue.indexOf(page);
    if (at >= 0) this._queue.splice(at, 1);
  }

  /**
   * Starts the next few, nearest to the eye first.
   *
   * Sorted at the moment of starting rather than on insertion, because the
   * reader may have scrolled since a page was asked for — what mattered when
   * it joined the queue is not what matters now.
   */
  _pump() {
    // Mid-resize every cell is about to be a different size, so anything
    // painted now is painted for a layout that will not exist.
    if (this._drag !== null) return;
    if (!this._queue.length) return;
    const anchor = this._anchor();
    this._queue.sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor));
    while (this._active < THUMB_CONCURRENCY && this._queue.length) {
      const page = this._queue.shift();
      this._active += 1;
      this._renderThumb(page).finally(() => {
        this._active -= 1;
        this._pump();
      });
    }
  }

  async _renderThumb(page) {
    if (this._thumbs.has(page)) return;
    const doc = this.handlers.getDoc?.();
    const cell = this._cells.get(page);
    if (!doc || !cell || typeof doc.renderPage !== 'function') return;
    // Claimed before the await, so two observer callbacks in the same scroll
    // cannot both start rasterising the same page.
    this._thumbs.set(page, null);
    const token = this._renderToken;

    try {
      const size = this.handlers.getPageSize?.();
      const long = size && size.height > 0 ? Math.max(size.width, size.height) : 842;
      // Capped: past two device pixels per CSS pixel a 132px-wide picture of
      // a page gains nothing a reader can see, and costs the whole difference
      // in decode time.
      const dpr = Math.min(THUMB_MAX_DPR, window.devicePixelRatio || 1);
      const scale = Math.min(1, THUMB_LONG_EDGE / long) * dpr;
      // drawable：缩略图要把批注继续画在这张页面上，所以不能收零拷贝的
      // bitmaprenderer 画布 —— 那种画布之后拿不到 2d 上下文。缩略图只有一百多
      // 像素宽，多拷这一次可以忽略；整页尺寸下就不行了，所以这是个选项而不是
      // 默认。
      const { canvas } = await doc.renderPage(page, scale, { drawable: true });
      await this._inkOnto(canvas, page, scale, token);
      // The panel may have been closed, re-tabbed or given a new book while
      // this page was rasterising; anything painted now belongs to nothing.
      if (token !== this._renderToken || !this._cells.has(page)) return;
      this._thumbs.set(page, canvas);
      this._hang(canvas, cell);
    } catch (_) {
      // One page that will not rasterise is one grey box, not a broken panel.
      this._thumbs.delete(page);
      cell.querySelector('.pdf-thumb-shot')?.classList.add('is-failed');
    }
  }

  /**
   * Lays this page's handwriting over the page.
   *
   * Without it a thumbnail is a picture of the book, and the reader is looking
   * for THEIR page — the one with the working on it. A page you annotated and
   * a page you did not look identical, which is precisely the distinction the
   * grid is being scanned for.
   *
   * Drawn stroke by stroke rather than through renderLayer, because that one
   * clears the canvas before it starts — correct for the ink layer it was
   * written for, and here it would wipe the page out from underneath.
   *
   * Ink is stored in page space, so the transform is simply the scale the page
   * was rasterised at. Widths scale with it: a 2-unit pen on a thumbnail is a
   * faint line, which is what a 2-unit pen looks like when the page is that
   * small, and is the honest answer.
   */
  async _inkOnto(canvas, page, scale, token) {
    const docId = this.handlers.getInkDocId?.();
    if (!docId) return;
    let layer;
    try {
      layer = await loadLayer(docId, page);
    } catch (_) {
      return;   // one page without its ink is still a usable thumbnail
    }
    if (token !== this._renderToken) return;
    const strokes = layer?.getAll?.() || [];
    if (!strokes.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const transform = createTransform(scale, 0, 0);
    ctx.save();
    for (const stroke of strokes) drawStroke(ctx, stroke, transform);
    ctx.restore();
  }

  /** Puts a painted page into its cell. */
  _hang(canvas, cell) {
    const shot = cell.querySelector('.pdf-thumb-shot');
    if (!shot) return;
    canvas.className = 'pdf-thumb-canvas';
    // The flag is put back on top: replaceChildren would otherwise drop it,
    // and a marked page would stop saying so the moment it finished painting.
    const flag = shot.querySelector('.pdf-thumb-flag');
    shot.replaceChildren(canvas);
    if (flag) shot.appendChild(flag);
    shot.classList.add('is-loaded');
  }

  /** Gives back every page outside the band the reader is actually looking at. */
  _evictThumbs() {
    if (this._thumbs.size <= THUMB_KEEP_RADIUS * 2) return;
    const anchor = this._visible.size ? Math.min(...this._visible)
      : (this.handlers.getCurrentPage?.() || 1);
    const total = this.handlers.getPageCount?.() || 0;
    const keep = thumbWindow(anchor, total, THUMB_KEEP_RADIUS);
    for (const [page, canvas] of [...this._thumbs]) {
      if (page >= keep.from && page <= keep.to) continue;
      this._thumbs.delete(page);
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      const shot = this._cells.get(page)?.querySelector('.pdf-thumb-shot');
      if (shot) { shot.replaceChildren(); shot.classList.remove('is-loaded'); }
    }
  }

  /** Takes down the grid and stops the work, and keeps what was painted. */
  _teardownGrid() {
    this._renderToken++;
    this._observer?.disconnect();
    this._observer = null;
    this._visible.clear();
    this._queue.length = 0;
    this._cells.clear();
    // In-flight pages are recorded as null; without this they would look
    // painted for ever and never be asked for again.
    for (const [page, canvas] of [...this._thumbs]) {
      if (!canvas) this._thumbs.delete(page);
    }
  }

  /**
   * Down to a band worth carrying while nobody is looking.
   *
   * Keeping the full scrolling window closed would hold about fifty pages of
   * bitmap for a panel that is not on screen; keeping none is the reload the
   * reader complained about. A screenful or two around where they were is the
   * part they will actually see again first.
   */
  _trimThumbs() {
    const keep = thumbWindow(this.handlers.getCurrentPage?.() || 1,
      this.handlers.getPageCount?.() || 0, 12);
    for (const [page, canvas] of [...this._thumbs]) {
      if (page >= keep.from && page <= keep.to) continue;
      this._thumbs.delete(page);
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }

  _releaseThumbs() {
    this._teardownGrid();
    for (const canvas of this._thumbs.values()) {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
    this._thumbs.clear();
  }
}
