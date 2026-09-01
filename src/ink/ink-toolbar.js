// Ink Module — the floating toolbar (spec chapter 5–8).
//
// A Presentation/Ink control overlay. It edits Ink TOOL STATE and nothing else:
// it holds no reference to a PDF document, a page canvas or the dual-PDF
// divider, so dragging or reorienting it cannot move the page, change the split
// or touch stored stroke coordinates — the layer-safety rule in §11.3.
//
// The drag sequence follows §5.2 exactly:
//   Expanded → drag starts → collapsed active-tool token → moving
//            → released near a placement target → reoriented expanded toolbar
//
// It applies to whichever Ink surface is currently active, which is why the
// workspace marks the active pane visually (§11.2).

import {
  CARDS,
  DEFAULT_SWATCHES,
  EDGES,
  ERASER_TOOL,
  ORIENTATION,
  TOOLBAR_PHASE,
  closeCard,
  createToolbarState,
  endDrag,
  isEraser,
  moveDrag,
  openCard,
  orientationOf,
  selectTool,
  serializeToolbarState,
  setColor,
  setEraserMode,
  setEraserWidth,
  setOpacity,
  setWidth,
  startDrag,
} from './toolbar-state.js';
import { INK_TOOLS } from './stroke.js';
import { ERASER_MODES } from './ink-eraser.js';

const STORAGE_KEY = 'ls_ink_toolbar';

/**
 * Toolbar icons.
 *
 * These were `✒ ✏ 🖊 🖍 ◻` and a braille `⠿` for the grip. Three of those are
 * emoji, and Android WebView resolves emoji through the colour font: they
 * arrived pre-coloured, ignored `color`, so a selected tool could not tint to
 * the accent, and they sat on the glass as five different illustration styles.
 * The braille grip also read out as its dot pattern to a screen reader.
 *
 * Drawn instead on the same 24x24 grid, stroke width 2, round caps and joins
 * as the icons already inline in index.html, and filled from `currentColor` so
 * every state — muted, hovered, selected, disabled — tints in one place.
 *
 * The five tools have to be told apart at 22px by silhouette alone, so each
 * takes a different one: the pen a nib, the pencil a point, the marker a
 * square chisel with a collar, the highlighter a broad head-on tip over the
 * line it lays down, the eraser its own wedge.
 */
const ICON = {
  // A nib — matches the pen already used on the handwriting bar.
  pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  // A point, and no collar: the one detail that keeps it out of the marker.
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  // A square chisel nib and a collar ring.
  marker: '<path d="M4 20.5V17l9-9 3.5 3.5-9 9H4z"/><path d="M13 8l3-3a2.12 2.12 0 0 1 3 3l-3 3"/><path d="M15.5 5.5l3 3"/>',
  // Seen head-on, over the line it lays down.
  highlighter: '<path d="M8.5 3.5h7a1 1 0 0 1 1 1V11h-9V4.5a1 1 0 0 1 1-1z"/><path d="M7.5 11h9l-1.2 4.2a1 1 0 0 1-.96.7h-4.68a1 1 0 0 1-.96-.7L7.5 11z"/><path d="M4 20h16"/>',
  // The eraser already inline on the handwriting bar, unchanged.
  eraser: '<path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8L14.6 1.6c.8-.8 2-.8 2.8 0L21 5.2c.8.8.8 2 0 2.8L12 17"/><line x1="6" y1="20" x2="10" y2="20"/>',
  // Grip and overflow share one family of dots, so the two chrome affordances
  // read as chrome rather than as two more tools.
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
};

/** Dot icons are solid; the rest are strokes. One wrapper, so they align. */
const FILLED_ICONS = new Set(['grip', 'more']);

function icon(name, size = 22) {
  const filled = FILLED_ICONS.has(name);
  return `<svg class="ink-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
}

const TOOL_META = [
  { tool: INK_TOOLS.PEN, label: '钢笔', icon: 'pen' },
  { tool: INK_TOOLS.PENCIL, label: '铅笔', icon: 'pencil' },
  { tool: INK_TOOLS.MARKER, label: '马克笔', icon: 'marker' },
  { tool: INK_TOOLS.HIGHLIGHTER, label: '荧光笔', icon: 'highlighter' },
  { tool: ERASER_TOOL, label: '橡皮', icon: 'eraser' },
];

const metaFor = (tool) => TOOL_META.find(t => t.tool === tool) || TOOL_META[0];
const iconFor = (tool, size) => icon(metaFor(tool).icon, size);
const labelFor = (tool) => metaFor(tool).label;

/** Honour the OS reduced-motion setting, per §8.3. */
function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

export class InkToolbar {
  /**
   * @param {HTMLElement} host positioned container the toolbar floats inside
   * @param {{getSurface: function, onChange?: function, onClearInk?: function}} handlers
   *   getSurface() returns the ACTIVE InkSurface, or null when none is active.
   */
  constructor(host, handlers = {}) {
    this.host = host;
    this.handlers = handlers;
    this.state = createToolbarState(this._restore());

    this.root = document.createElement('div');
    this.root.className = 'ink-toolbar';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', '笔迹工具栏');
    host.appendChild(this.root);

    this.cardLayer = document.createElement('div');
    this.cardLayer.className = 'ink-card-layer';
    host.appendChild(this.cardLayer);

    if (prefersReducedMotion()) this.root.classList.add('no-motion');

    this._bindGlobalDismiss();
    this._installDragController();
    this.render();
    this._pushToSurface();
  }

  // ── persistence ───────────────────────────────────────────────────────────

  _restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeToolbarState(this.state)));
    } catch (_) { /* storage unavailable */ }
  }

  // ── state plumbing ────────────────────────────────────────────────────────

  /**
   * @param {{pushTools?: boolean, keepCard?: boolean}} [opts]
   *   `keepCard` leaves the open card's DOM in place. Continuous controls MUST
   *   set it: a slider fires `input` on every pixel of the drag, and rebuilding
   *   the card replaces the very `<input>` the pointer is dragging. The browser
   *   drops the drag with it, so the slider moved once and then went dead —
   *   which is why the width, opacity and eraser-size sliders could be clicked
   *   but never dragged. Same failure as the toolbar handle before it was
   *   rebound; the cure is the same: do not destroy what a gesture is holding.
   */
  _set(nextState, { pushTools = true, keepCard = false } = {}) {
    if (nextState === this.state) return;
    this.state = nextState;
    this._keepCard = keepCard;
    this.render();
    this._keepCard = false;
    this._persist();
    if (pushTools) this._pushToSurface();
    this.handlers.onChange?.(this.state);
  }

  /**
   * Applies the toolbar's tool state to the active Ink surface.
   *
   * Only ink PROPERTIES cross this boundary — never geometry. A tool card
   * "must change Ink tool parameters only; it must not rasterize existing
   * strokes or merge Ink into the PDF" (§6.1).
   */
  _pushToSurface() {
    const surface = this.handlers.getSurface?.();
    if (!surface) return;
    if (isEraser(this.state)) {
      surface.setEraser(this.state.eraserMode);
      surface.eraserRadius = this.state.eraserWidth;
      return;
    }
    surface.setTool(this.state.tool);
    surface.setColor(this.state.color);
    surface.setWidth(this.state.width);
    if (typeof surface.setOpacity === 'function') surface.setOpacity(this.state.opacity);
  }

  /** Re-applies tool state when the active pane changes. */
  syncToActiveSurface() {
    this._pushToSurface();
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render() {
    const { state } = this;
    const orientation = orientationOf(state);

    this.root.dataset.edge = state.edge;
    this.root.dataset.orientation = orientation;
    this.root.dataset.phase = state.phase;
    this.root.classList.toggle('is-dragging', state.phase === TOOLBAR_PHASE.DRAGGING);

    if (state.phase === TOOLBAR_PHASE.DRAGGING) {
      this._positionToken();
      // Build the token ONCE per drag, then only move it.
      //
      // This used to re-parse the whole innerHTML on every pointermove. A
      // stylus emits those at 120Hz or better, so each frame of a drag threw
      // away the token and built a new one — which is what made dragging the
      // toolbar feel heavy and lag behind the pen.
      if (!this.root.querySelector('.ink-token')) {
        this.root.innerHTML = `
          <div class="ink-token" aria-hidden="true">
            <span class="ink-token-glyph">${iconFor(state.tool, 24)}</span>
            <span class="ink-token-dot" style="background:${escapeAttr(state.color)}"></span>
          </div>`;
        this.cardLayer.replaceChildren();
      }
      return;
    }

    this._positionExpanded();
    // Four groups, separated by hairlines rather than by gap alone: grab,
    // choose a tool, choose a colour, everything else. On a bar this dense the
    // gap on its own left ten round controls reading as one undifferentiated
    // run, and the stylus had to hunt for the boundary between tool and colour.
    this.root.innerHTML = `
      <button type="button" class="ink-handle" data-role="handle"
              aria-label="移动工具栏" title="拖动以移动">${icon('grip', 20)}</button>
      <span class="ink-sep" aria-hidden="true"></span>
      <div class="ink-tools" role="group" aria-label="笔迹工具">
        ${TOOL_META.map(meta => `
          <button type="button" class="ink-tool${meta.tool === state.tool ? ' is-selected' : ''}"
                  data-tool="${meta.tool}" title="${meta.label}" aria-label="${meta.label}"
                  aria-pressed="${meta.tool === state.tool}">
            ${icon(meta.icon)}
          </button>`).join('')}
      </div>
      <span class="ink-sep" aria-hidden="true"></span>
      <div class="ink-swatches" role="group" aria-label="墨水颜色">
        ${state.swatches.map(color => `
          <button type="button" class="ink-swatch${sameColor(color, state.color) ? ' is-selected' : ''}"
                  data-swatch="${escapeAttr(color)}"
                  title="${escapeAttr(color)}" aria-label="颜色 ${escapeAttr(color)}"
                  aria-pressed="${sameColor(color, state.color)}">
            <span class="ink-swatch-fill" style="background:${escapeAttr(color)}"></span>
          </button>`).join('')}
        <button type="button" class="ink-swatch is-custom" data-role="color-card"
                title="更多颜色" aria-label="更多颜色">${icon('plus', 18)}</button>
      </div>
      <span class="ink-sep" aria-hidden="true"></span>
      <button type="button" class="ink-overflow" data-role="overflow"
              aria-label="更多设置" title="更多设置">${icon('more', 20)}</button>
    `;

    this._bindToolbar();
    if (!this._keepCard) this._renderCard();
  }

  _positionExpanded() {
    const { edge, offset } = this.state;
    const s = this.root.style;
    s.left = s.right = s.top = s.bottom = '';
    s.transform = '';
    if (edge === EDGES.LEFT || edge === EDGES.RIGHT) {
      s[edge] = '10px';
      s.top = `${offset * 100}%`;
      s.transform = 'translateY(-50%)';
    } else {
      s[edge] = '10px';
      s.left = `${offset * 100}%`;
      s.transform = 'translateX(-50%)';
    }
  }

  _positionToken() {
    const point = this.state.dragPoint;
    if (!point) return;
    const s = this.root.style;
    s.right = s.bottom = '';
    s.left = `${point.x}px`;
    s.top = `${point.y}px`;
    s.transform = 'translate(-50%, -50%)';
  }

  // ── events ────────────────────────────────────────────────────────────────

  _bindToolbar() {
    // No drag binding here. The handle is rebuilt on every render, so it is
    // the wrong owner for a gesture that outlives the render — see
    // _installDragController().
    this.root.querySelectorAll('[data-tool]').forEach((button) => {
      button.addEventListener('click', () => {
        const tool = button.dataset.tool;
        // Tapping the already-selected tool opens its settings card, which is
        // the demonstrated way to reach tool parameters.
        if (tool === this.state.tool) {
          this._set(openCard(this.state, tool === ERASER_TOOL ? CARDS.ERASER : CARDS.TOOL),
            { pushTools: false });
          return;
        }
        this._set(selectTool(this.state, tool));
      });
    });

    this.root.querySelectorAll('[data-swatch]').forEach((button) => {
      button.addEventListener('click', () => this._set(setColor(this.state, button.dataset.swatch)));
    });

    this.root.querySelector('[data-role="color-card"]')
      ?.addEventListener('click', () => this._set(openCard(this.state, CARDS.COLOR), { pushTools: false }));
    this.root.querySelector('[data-role="overflow"]')
      ?.addEventListener('click', () => this._set(openCard(this.state, CARDS.OVERFLOW), { pushTools: false }));
  }

  /**
   * Drag from the handle only.
   *
   * Bound ONCE, to owners that outlive a render.
   *
   * The previous version bound pointermove/up/cancel to the handle element and
   * took pointer capture on it. But the very first thing pointerdown does is
   * `_set(startDrag(...))`, and `_set` calls `render()`, which replaces
   * `root.innerHTML` — destroying the handle, its listeners and its capture
   * before the pointer had moved a pixel. Nothing was left to hear pointerup,
   * so `endDrag()` never ran: the toolbar stayed collapsed to its drag token,
   * with no handle and no tools, until the page was reloaded.
   *
   * So the two owners here are chosen for surviving that render:
   *   - `this.root` persists across renders (only its children are replaced),
   *     which makes it a safe holder for pointer capture;
   *   - `window` is the termination owner, so a lost capture, a pointer that
   *     leaves the window, or a root that is torn down entirely all still
   *     reach the same single cleanup path.
   *
   * Every phase stops propagation, so the gesture stays inside the toolbar and
   * cannot reach the ink surface (drawing), the pane (panning) or the divider
   * (resizing) — §5.2 requires that explicitly. The window listeners use the
   * capture phase so they can enforce it before anything else sees the event.
   */
  _installDragController() {
    this._drag = { pointerId: null };

    const toHostPoint = (e) => {
      const rect = this.host.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this._onDragStart = (e) => {
      if (this._drag.pointerId !== null) return;
      if (!e.target.closest?.('[data-role="handle"]')) return;
      e.preventDefault();
      e.stopPropagation();
      this._drag.pointerId = e.pointerId;
      // Capture on the root, not the handle: the handle is about to be
      // replaced by the render on the next line.
      try { this.root.setPointerCapture(e.pointerId); } catch (_) { /* unsupported */ }
      this._set(startDrag(this.state, toHostPoint(e)), { pushTools: false });
    };

    this._onDragMove = (e) => {
      if (this._drag.pointerId !== e.pointerId) return;
      e.stopPropagation();
      this._set(moveDrag(this.state, toHostPoint(e)), { pushTools: false });
    };

    /**
     * The one way a drag ends. Idempotent, because it is reachable from
     * pointerup, pointercancel and lostpointercapture — and lostpointercapture
     * fires as a consequence of the release this method itself performs.
     */
    this._onDragEnd = (e) => {
      if (this._drag.pointerId === null || this._drag.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const pointerId = this._drag.pointerId;
      this._drag.pointerId = null;
      try { this.root.releasePointerCapture(pointerId); } catch (_) { /* already released */ }
      const rect = this.host.getBoundingClientRect();
      this._set(
        endDrag(this.state, toHostPoint(e), { width: rect.width, height: rect.height }),
        { pushTools: false },
      );
    };

    this.root.addEventListener('pointerdown', this._onDragStart);
    window.addEventListener('pointermove', this._onDragMove, { capture: true });
    window.addEventListener('pointerup', this._onDragEnd, { capture: true });
    window.addEventListener('pointercancel', this._onDragEnd, { capture: true });
    window.addEventListener('lostpointercapture', this._onDragEnd, { capture: true });
  }

  /**
   * Releases every listener this toolbar owns outside its own subtree.
   *
   * This is the ONLY destroy(). There used to be a second one at the bottom of
   * the class, and since a later class method silently replaces an earlier one
   * of the same name, that second one was the method that actually ran. It
   * knew about the document listener and the DOM nodes but nothing about the
   * four pointer listeners `_installDragController()` puts on `window`, so
   * every destroyed toolbar stayed reachable from `window` — and a destroy
   * that landed mid-drag left a detached instance that a later pointerup could
   * still drive through `_set()`, into persistence and into `onChange`.
   *
   * Idempotent: destroying twice is a no-op, not a second round of removals.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // A destroy that lands mid-drag has to end the drag here. The listener
    // that would otherwise have ended it is removed on the next lines.
    if (this._drag && this._drag.pointerId !== null) {
      const pointerId = this._drag.pointerId;
      this._drag.pointerId = null;
      try { this.root.releasePointerCapture(pointerId); } catch (_) { /* already released */ }
    }

    this.root.removeEventListener('pointerdown', this._onDragStart);
    window.removeEventListener('pointermove', this._onDragMove, { capture: true });
    window.removeEventListener('pointerup', this._onDragEnd, { capture: true });
    window.removeEventListener('pointercancel', this._onDragEnd, { capture: true });
    window.removeEventListener('lostpointercapture', this._onDragEnd, { capture: true });
    document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);

    this.root.remove();
    this.cardLayer.remove();
  }

  _bindGlobalDismiss() {
    this._onDocumentPointerDown = (e) => {
      if (this.state.openCard === CARDS.NONE) return;
      if (this.root.contains(e.target) || this.cardLayer.contains(e.target)) return;
      this._set(closeCard(this.state), { pushTools: false });
    };
    document.addEventListener('pointerdown', this._onDocumentPointerDown, true);
  }

  // ── setting cards ─────────────────────────────────────────────────────────

  /**
   * Cards are absolutely positioned in an overlay layer, so opening one does
   * not re-layout or resize the workspace (§8.2).
   */
  _renderCard() {
    const { state } = this;
    if (state.openCard === CARDS.NONE) {
      this.cardLayer.replaceChildren();
      return;
    }

    const card = document.createElement('div');
    card.className = 'ink-card';
    card.dataset.edge = state.edge;

    if (state.openCard === CARDS.TOOL) card.innerHTML = this._toolCardHtml();
    else if (state.openCard === CARDS.ERASER) card.innerHTML = this._eraserCardHtml();
    else if (state.openCard === CARDS.COLOR) card.innerHTML = this._colorCardHtml();
    else card.innerHTML = this._overflowCardHtml();

    this.cardLayer.replaceChildren(card);
    this._anchorCard(card);
    this._bindCard(card);
  }

  /** Anchors the card adjacent to the toolbar, on the side with room. */
  _anchorCard(card) {
    const bar = this.root.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    const s = card.style;
    s.left = s.right = s.top = s.bottom = '';

    if (this.state.edge === EDGES.LEFT) {
      s.left = `${bar.right - host.left + 8}px`;
      s.top = `${Math.max(8, bar.top - host.top)}px`;
    } else if (this.state.edge === EDGES.RIGHT) {
      s.right = `${host.right - bar.left + 8}px`;
      s.top = `${Math.max(8, bar.top - host.top)}px`;
    } else if (this.state.edge === EDGES.TOP) {
      s.top = `${bar.bottom - host.top + 8}px`;
      s.left = `${Math.max(8, bar.left - host.left)}px`;
    } else {
      s.bottom = `${host.bottom - bar.top + 8}px`;
      s.left = `${Math.max(8, bar.left - host.left)}px`;
    }
  }

  _toolCardHtml() {
    const { state } = this;
    return `
      <div class="ink-card-title">${labelFor(state.tool)}</div>
      <div class="ink-preview"><span class="ink-preview-line"
        style="background:${escapeAttr(state.color)};height:${Math.max(1, state.width)}px;opacity:${state.opacity}"></span></div>
      <label class="ink-field">
        <span>粗细 <b data-role="width-readout">${state.width.toFixed(1)}</b> mm</span>
        <input type="range" min="0.2" max="20" step="0.1" value="${state.width}" data-role="width">
      </label>
      <label class="ink-field">
        <span>不透明度 <b data-role="opacity-readout">${Math.round(state.opacity * 100)}</b>%</span>
        <input type="range" min="0" max="100" step="1" value="${Math.round(state.opacity * 100)}" data-role="opacity">
      </label>
      <div class="ink-card-swatches">
        ${state.swatches.map(c => `<button type="button" class="ink-swatch${sameColor(c, state.color) ? ' is-selected' : ''}"
          data-swatch="${escapeAttr(c)}" style="background:${escapeAttr(c)}"></button>`).join('')}
      </div>`;
  }

  _eraserCardHtml() {
    const { state } = this;
    return `
      <div class="ink-card-title">橡皮</div>
      <div class="ink-seg">
        <button type="button" class="ink-seg-btn${state.eraserMode === ERASER_MODES.STROKE ? ' is-selected' : ''}"
                data-eraser-mode="${ERASER_MODES.STROKE}">笔划擦除</button>
        <button type="button" class="ink-seg-btn${state.eraserMode === ERASER_MODES.REGION ? ' is-selected' : ''}"
                data-eraser-mode="${ERASER_MODES.REGION}">区域擦除</button>
      </div>
      <label class="ink-field">
        <span>橡皮大小 <b data-role="eraser-readout">${state.eraserWidth.toFixed(1)}</b> mm</span>
        <input type="range" min="1" max="40" step="0.5" value="${state.eraserWidth}" data-role="eraser-width">
      </label>
      <button type="button" class="ink-danger" data-role="clear-ink">清空本页笔迹</button>
      <p class="ink-note">只会删除本页的手写笔迹，不会修改导入的 PDF。</p>`;
  }

  _colorCardHtml() {
    const { state } = this;
    const palette = [
      '#111827', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#ffffff',
      '#dc2626', '#ea580c', '#d97706', '#ca8a04', '#65a30d', '#16a34a',
      '#0d9488', '#0891b2', '#2563eb', '#4f46e5', '#7c3aed', '#c026d3',
    ];
    return `
      <div class="ink-card-title">颜色</div>
      <div class="ink-palette">
        ${palette.map(c => `<button type="button" class="ink-palette-dot${sameColor(c, state.color) ? ' is-selected' : ''}"
          data-swatch="${escapeAttr(c)}" style="background:${escapeAttr(c)}" aria-label="${escapeAttr(c)}"></button>`).join('')}
      </div>
      <label class="ink-field">
        <span>不透明度 <b data-role="opacity-readout">${Math.round(state.opacity * 100)}</b>%</span>
        <input type="range" min="0" max="100" step="1" value="${Math.round(state.opacity * 100)}" data-role="opacity">
      </label>
      <p class="ink-note">颜色与不透明度是笔迹属性，不会改变 PDF 本身。</p>`;
  }

  _overflowCardHtml() {
    return `
      <div class="ink-card-title">工具栏设置</div>
      <label class="ink-check">
        <input type="checkbox" data-role="auto-minimize" ${this.state.autoMinimize ? 'checked' : ''}>
        <span>自动最小化</span>
      </label>
      <p class="ink-note">拖动手柄可将工具栏移动到任意一边。</p>`;
  }

  _bindCard(card) {
    card.querySelectorAll('[data-swatch]').forEach((button) => {
      button.addEventListener('click', () => this._set(setColor(this.state, button.dataset.swatch)));
    });

    const width = card.querySelector('[data-role="width"]');
    width?.addEventListener('input', () => {
      this._set(setWidth(this.state, width.value), { keepCard: true });
      const out = card.querySelector('[data-role="width-readout"]');
      if (out) out.textContent = Number(width.value).toFixed(1);
    });

    card.querySelectorAll('[data-role="opacity"]').forEach((slider) => {
      slider.addEventListener('input', () => {
        this._set(setOpacity(this.state, Number(slider.value) / 100), { keepCard: true });
        const out = card.querySelector('[data-role="opacity-readout"]');
        if (out) out.textContent = String(Math.round(Number(slider.value)));
      });
    });

    card.querySelectorAll('[data-eraser-mode]').forEach((button) => {
      button.addEventListener('click', () => this._set(setEraserMode(this.state, button.dataset.eraserMode)));
    });

    const eraserWidth = card.querySelector('[data-role="eraser-width"]');
    eraserWidth?.addEventListener('input', () => {
      this._set(setEraserWidth(this.state, eraserWidth.value), { keepCard: true });
      const out = card.querySelector('[data-role="eraser-readout"]');
      if (out) out.textContent = Number(eraserWidth.value).toFixed(1);
    });

    // Scoped to Ink only. "Clear all content" from the reference must never be
    // copied with semantics that flatten or damage the imported PDF (§6.2).
    card.querySelector('[data-role="clear-ink"]')?.addEventListener('click', () => {
      this.handlers.onClearInk?.();
    });

    card.querySelector('[data-role="auto-minimize"]')?.addEventListener('change', (e) => {
      this._set({ ...this.state, autoMinimize: e.target.checked }, { pushTools: false });
    });
  }

  // destroy() lives with the drag controller it has to tear down; see above.
  // A second one here would override it, which is exactly the defect this
  // class shipped with.
}

function sameColor(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export { DEFAULT_SWATCHES, ORIENTATION };
