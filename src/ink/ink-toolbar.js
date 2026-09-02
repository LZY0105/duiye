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
  CORNERS,
  DEFAULT_SWATCHES,
  EDGES,
  ERASER_TOOL,
  LASSO_MODES,
  LASSO_SHAPES,
  LASSO_TOOL,
  ORIENTATION,
  TOOLBAR_PHASE,
  closeCard,
  createToolbarState,
  endDrag,
  isCornerPoint,
  isDocked,
  isEraser,
  moveDrag,
  openCard,
  orientationOf,
  selectTool,
  serializeToolbarState,
  setColor,
  setEraserMode,
  setEraserWidth,
  setLassoMode,
  setLassoShape,
  setOpacity,
  setWidth,
  startDrag,
  undock,
} from './toolbar-state.js';
import { INK_TOOLS } from './stroke.js';
import { ERASER_MODES } from './ink-eraser.js';

const STORAGE_KEY = 'ls_ink_toolbar';

/**
 * How far a pointer may travel and still count as a tap, in CSS pixels.
 *
 * The docked puck has two gestures on one target — tap to expand, drag to
 * move — so one has to be told from the other. 6px is about the wobble a stylus
 * makes while the tip is pressed and lifted; below it, the user meant to tap.
 */
const TAP_SLOP = 6;

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
  // A dashed loop closing on itself, with the tail that says it was drawn by
  // hand rather than dropped as a rectangle.
  lasso: '<path stroke-dasharray="3 3" d="M12 4c4.4 0 8 2.4 8 5.5S16.4 15 12 15s-8-2.4-8-5.5S7.6 4 12 4z"/><path d="M8.5 14.3c-.6 1.6-.4 3.2.6 4.3"/><circle cx="9.6" cy="19.4" r="1.6"/>',
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
  { tool: LASSO_TOOL, label: '套索', icon: 'lasso' },
];

const metaFor = (tool) => TOOL_META.find(t => t.tool === tool) || TOOL_META[0];
const iconFor = (tool, size) => icon(metaFor(tool).icon, size);
const labelFor = (tool) => metaFor(tool).label;

const clampNumber = (v, lo, hi) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));

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
    if (this.state.tool === LASSO_TOOL) {
      surface.setTool(LASSO_TOOL);
      surface.setLasso({
        shape: this.state.lassoShape,
        mode: this.state.lassoMode,
      });
      return;
    }
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
    if (state.corner) this.root.dataset.corner = state.corner;
    else delete this.root.dataset.corner;
    this.root.classList.toggle('is-dragging', state.phase === TOOLBAR_PHASE.DRAGGING);
    this.root.classList.toggle('is-docked', state.phase === TOOLBAR_PHASE.DOCKED);

    if (state.phase === TOOLBAR_PHASE.DRAGGING) {
      this._positionToken();
      this._renderToken();
      return;
    }

    // Parked in a corner: the circle the drag collapsed it into simply stays.
    //
    // Nothing is rebuilt, so the token that travelled under the stylus is the
    // same element that comes to rest — the motion is one continuous circle
    // rather than a shape swapped for another shape at the end of the gesture.
    if (state.phase === TOOLBAR_PHASE.DOCKED) {
      this._renderToken();
      this._positionDocked();
      this.cardLayer.replaceChildren();
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
    // Placement was computed from the PREVIOUS contents, so the bar's real size
    // is only known now. Clamp once it exists.
    this._clampIntoHost();
    if (!this._keepCard) this._renderCard();
  }

  /**
   * The circular token, built ONCE and thereafter only moved and relabelled.
   *
   * This used to re-parse the whole innerHTML on every pointermove. A stylus
   * emits those at 120Hz or better, so each frame of a drag threw away the
   * token and built a new one — which is what made dragging the toolbar feel
   * heavy and lag behind the pen.
   *
   * Keeping the element also carries it across the DRAGGING → DOCKED boundary
   * unbroken: its entry animation does not replay on arrival, and the browser
   * has one continuously-placed circle to move rather than two that alternate.
   */
  _renderToken() {
    const docked = this.state.phase === TOOLBAR_PHASE.DOCKED;
    let token = this.root.querySelector('.ink-token');
    if (!token) {
      this.root.innerHTML = `
        <div class="ink-token">
          <span class="ink-token-glyph"></span>
          <span class="ink-token-dot"></span>
        </div>`;
      token = this.root.querySelector('.ink-token');
      this.cardLayer.replaceChildren();
    }

    // The glyph tracks the active tool: saying which tool is in hand while the
    // bar is not there to show it is the token's whole job.
    const glyph = token.querySelector('.ink-token-glyph');
    if (glyph.dataset.tool !== this.state.tool) {
      glyph.dataset.tool = this.state.tool;
      glyph.innerHTML = iconFor(this.state.tool, 24);
    }
    token.querySelector('.ink-token-dot').style.background = this.state.color;

    // Docked, the puck is the only control the toolbar has left, so it takes
    // the button semantics. In flight it is scenery attached to the pointer,
    // and announcing a button that cannot be reached would be a lie.
    if (docked) {
      token.dataset.role = 'handle';
      token.removeAttribute('aria-hidden');
      token.setAttribute('role', 'button');
      token.setAttribute('tabindex', '0');
      token.setAttribute('aria-label', '展开笔迹工具栏');
      token.setAttribute('title', '点按展开 · 拖动可移动');
    } else {
      delete token.dataset.role;
      token.setAttribute('aria-hidden', 'true');
      token.removeAttribute('role');
      token.removeAttribute('tabindex');
      token.removeAttribute('aria-label');
      token.removeAttribute('title');
    }
  }

  /**
   * Pins the puck into its corner.
   *
   * Both axes are anchored directly, with no percentage and no translate: a
   * corner is the one placement the edge-fraction machinery cannot describe,
   * and anchoring to the two sides that meet there is what keeps the puck in
   * the corner when the workspace resizes or the split divider moves.
   */
  _positionDocked() {
    const s = this.root.style;
    s.left = s.right = s.top = s.bottom = '';
    s.transform = '';
    const M = '10px';
    const corner = this.state.corner || CORNERS.TOP_LEFT;
    if (corner === CORNERS.TOP_LEFT) { s.left = M; s.top = M; }
    else if (corner === CORNERS.TOP_RIGHT) { s.right = M; s.top = M; }
    else if (corner === CORNERS.BOTTOM_LEFT) { s.left = M; s.bottom = M; }
    else { s.right = M; s.bottom = M; }
  }

  /** Puck → bar, unfolding out of the corner it was parked in. */
  _undock() {
    if (!isDocked(this.state)) return;
    const from = this.root.getBoundingClientRect();
    this._set(undock(this.state), { pushTools: false });
    this._absorb(from, false);
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

  /**
   * Keeps the whole bar — and above all its handle — inside the workspace.
   *
   * Placement is an edge plus a fraction along it, applied as a percentage with
   * a -50% translate, so the fraction addresses the bar's CENTRE. Nothing
   * accounted for the bar's own length: a tall vertical bar at offset 0.13 in a
   * 730px host puts its centre at 94px and its top at -126px, and the drag
   * handle — which lives at the top — ends up above the viewport.
   *
   * The result was a toolbar that could not be dragged, because the only thing
   * you may drag it by was off screen. It was reachable by luck, depending on
   * how tall the bar happened to be and where it was last released.
   */
  _clampIntoHost() {
    const host = this.host;
    if (!host) return;
    const hostW = host.clientWidth;
    const hostH = host.clientHeight;
    const barW = this.root.offsetWidth;
    const barH = this.root.offsetHeight;
    if (!hostW || !hostH || !barW || !barH) return;

    const M = 8;   // never flush against the edge; the rim needs room to read
    const s = this.root.style;
    const vertical = this.state.edge === EDGES.LEFT || this.state.edge === EDGES.RIGHT;

    if (vertical) {
      const half = barH / 2;
      // A bar taller than the host cannot be fully shown; centre it and let it
      // overflow evenly rather than hiding one end.
      const centre = barH + M * 2 >= hostH
        ? hostH / 2
        : clampNumber(this.state.offset * hostH, half + M, hostH - half - M);
      s.top = `${centre}px`;
      s.transform = 'translateY(-50%)';
    } else {
      const half = barW / 2;
      const centre = barW + M * 2 >= hostW
        ? hostW / 2
        : clampNumber(this.state.offset * hostW, half + M, hostW - half - M);
      s.left = `${centre}px`;
      s.transform = 'translateX(-50%)';
    }
  }

  /**
   * Plays the token being pulled into its dock and unfolding there.
   *
   * FLIP, and transform-only: the bar is already laid out where it belongs, so
   * this animates it FROM where the token was — a translate for the travel and
   * a scale for the difference between a 3rem circle and a full bar. The
   * resting position is therefore correct whether or not a single frame is ever
   * painted, which matters at the end of a gesture the user may have finished
   * by lifting the stylus clear of the screen.
   *
   * A corner release lands harder: same motion, given a spring that overshoots
   * slightly, so "absorbed into the corner" reads differently from "placed on
   * an edge".
   */
  _absorb(from, corner) {
    const el = this.root;
    if (!from || typeof el.animate !== 'function' || prefersReducedMotion()) return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height || !from.width || !from.height) return;

    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    const sx = Math.max(0.15, from.width / to.width);
    const sy = Math.max(0.15, from.height / to.height);

    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.9 },
        { transform: 'none', opacity: 1 },
      ],
      {
        duration: corner ? 420 : 320,
        easing: corner
          ? 'cubic-bezier(0.22, 1.2, 0.36, 1)'
          : 'cubic-bezier(0.32, 0.72, 0, 1)',
        // ADDED to the bar's own transform, never replacing it.
        //
        // A docked bar rests on translateY(-50%) — the edge offset addresses its
        // centre. Animating `transform` outright overrode that for the length of
        // the animation and, because the last keyframe is `none`, landed the bar
        // half its own height away from where it belongs; when the animation
        // stopped applying, the element snapped back to its real position. That
        // snap was the jump after every drag.
        composite: 'add',
      },
    );
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
          const card = tool === ERASER_TOOL ? CARDS.ERASER
            : tool === LASSO_TOOL ? CARDS.LASSO
              : CARDS.TOOL;
          this._set(openCard(this.state, card), { pushTools: false });
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
    this._drag = { pointerId: null, start: null, started: false, fromDocked: false };

    const toHostPoint = (e) => {
      const rect = this.host.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this._onDragStart = (e) => {
      if (this._drag.pointerId !== null) return;
      if (!e.target.closest?.('[data-role="handle"]')) return;
      e.preventDefault();
      e.stopPropagation();
      const point = toHostPoint(e);
      this._drag.pointerId = e.pointerId;
      this._drag.start = point;
      this._drag.fromDocked = isDocked(this.state);
      this._drag.started = false;
      // Capture on the root, not the handle: the handle is about to be
      // replaced by the render on the next line.
      try { this.root.setPointerCapture(e.pointerId); } catch (_) { /* unsupported */ }

      // A docked puck waits to find out what the gesture is.
      //
      // Tap expands it, drag moves it, and both begin with the same press. If
      // the drag started here, a tap would yank the puck out of its corner to
      // sit under the fingertip and then throw it back. The expanded bar has no
      // such ambiguity — its handle does nothing but drag — so that one starts
      // at once and stays glued to the pen from the first pixel.
      if (this._drag.fromDocked) return;
      this._drag.started = true;
      this._set(startDrag(this.state, point), { pushTools: false });
    };

    this._onDragMove = (e) => {
      if (this._drag.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const point = toHostPoint(e);

      if (!this._drag.started) {
        const from = this._drag.start;
        if (Math.hypot(point.x - from.x, point.y - from.y) < TAP_SLOP) return;
        this._drag.started = true;
        this._set(startDrag(this.state, point), { pushTools: false });
      }

      this._set(moveDrag(this.state, point), { pushTools: false });

      // Magnetism has to be visible before the finger lifts, or it is just a
      // surprise on release. Inside a corner zone the token swells and its cast
      // deepens — the language of something being pulled toward a magnet.
      const rect = this.host.getBoundingClientRect();
      const armed = isCornerPoint(point, { width: rect.width, height: rect.height });
      this.root.classList.toggle('is-corner-armed', armed);
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
      const { started, fromDocked } = this._drag;
      this._drag.pointerId = null;
      this._drag.started = false;
      try { this.root.releasePointerCapture(pointerId); } catch (_) { /* already released */ }

      // Never travelled, so it was a tap — and on a docked puck a tap expands.
      if (!started) {
        if (fromDocked) this._undock();
        return;
      }

      const rect = this.host.getBoundingClientRect();
      const point = toHostPoint(e);
      const viewport = { width: rect.width, height: rect.height };
      const corner = isCornerPoint(point, viewport);
      // Where the token is right now, before the expanded bar replaces it.
      const from = this.root.getBoundingClientRect();

      this.root.classList.remove('is-corner-armed');
      this._set(endDrag(this.state, point, viewport), { pushTools: false });
      this._absorb(from, corner);
    };

    // The puck is a button, so it answers the keys a button answers.
    this._onKeyDown = (e) => {
      if (!isDocked(this.state)) return;
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();
      this._undock();
    };

    this.root.addEventListener('pointerdown', this._onDragStart);
    this.root.addEventListener('keydown', this._onKeyDown);
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
    this.root.removeEventListener('keydown', this._onKeyDown);
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
    else if (state.openCard === CARDS.LASSO) card.innerHTML = this._lassoCardHtml();
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

  /**
   * The lasso card.
   *
   * Two questions, and only two: what shape the loop takes, and what counts as
   * caught. The reference this is modelled on offers a third — which KINDS of
   * object to select, across handwriting, images, text boxes and shapes — and
   * that row is left out rather than copied, because this app holds one kind of
   * object. Four toggles that can only ever have one answer are not a setting,
   * they are furniture.
   *
   * The preview is the mark itself, at the size it is drawn, so the choice is
   * made by looking rather than by reading two labels.
   */
  _lassoCardHtml() {
    const { state } = this;
    const free = state.lassoShape !== LASSO_SHAPES.RECT;
    return `
      <div class="ink-card-title">套索</div>
      <div class="ink-lasso-preview" aria-hidden="true">
        <svg viewBox="0 0 72 48" width="72" height="48" fill="none"
             stroke="var(--math-gold, #d97706)" stroke-width="2"
             stroke-linecap="round" stroke-dasharray="5 4">
          ${free
            ? '<path d="M36 8c14 0 25 7 25 16S50 40 36 40 11 33 11 24 22 8 36 8z"/>'
            : '<rect x="11" y="9" width="50" height="30" rx="2"/>'}
        </svg>
      </div>
      <div class="ink-seg">
        <button type="button" class="ink-seg-btn${free ? ' is-selected' : ''}"
                data-lasso-shape="${LASSO_SHAPES.FREE}">自由套索</button>
        <button type="button" class="ink-seg-btn${free ? '' : ' is-selected'}"
                data-lasso-shape="${LASSO_SHAPES.RECT}">矩形套索</button>
      </div>
      <div class="ink-card-label">选中方式</div>
      <div class="ink-seg">
        <button type="button" class="ink-seg-btn${state.lassoMode === LASSO_MODES.TOUCH ? ' is-selected' : ''}"
                data-lasso-mode="${LASSO_MODES.TOUCH}">接触即选</button>
        <button type="button" class="ink-seg-btn${state.lassoMode === LASSO_MODES.INSIDE ? ' is-selected' : ''}"
                data-lasso-mode="${LASSO_MODES.INSIDE}">完全包含</button>
      </div>
      <p class="ink-note">圈中后可拖动移动，拖右下角的圆点可同时旋转和缩放。</p>`;
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

    card.querySelectorAll('[data-lasso-shape]').forEach((button) => {
      button.addEventListener('click', () => this._set(setLassoShape(this.state, button.dataset.lassoShape)));
    });

    card.querySelectorAll('[data-lasso-mode]').forEach((button) => {
      button.addEventListener('click', () => this._set(setLassoMode(this.state, button.dataset.lassoMode)));
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
