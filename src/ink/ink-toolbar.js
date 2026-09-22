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
  SHAPE_TOOL,
  ORIENTATION,
  TOOLBAR_PHASE,
  closeCard,
  createToolbarState,
  dockToCorner,
  endDrag,
  isCornerPoint,
  isDocked,
  isEraser,
  isShape,
  isYielded,
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
  setShapeFill,
  setShapeKind,
  setWidth,
  startDrag,
  yieldToCorner,
  undock,
  unyield,
} from './toolbar-state.js';
import { t } from '../core/i18n.js';
import { INK_TOOLS } from './stroke.js';
import { ERASER_MODES } from './ink-eraser.js';
import { SHAPE_ORDER } from './shape-geometry.js';

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
 * How far the bar may be scaled down before the buttons stop being targets.
 *
 * 0.72 of 44px is 32px — small for a finger, still usable with the stylus the
 * tablet ships with, and the point below which the honest answer is to show
 * fewer tools rather than smaller ones.
 */
const MIN_SCALE = 0.72;

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
  // 一个圆压着一条斜线：这支工具的两头，一头是闭合的图形，一头是线。
  shape: '<circle cx="9.5" cy="9.5" r="5.5"/><path d="M5 20L20 5"/>',
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

// 工具的名字存的是词条键，不是文字本身。
//
// 这张表是模块级常量，只求值一次；若在这里就把 t() 的结果写死，切到别的语言之后
// 工具栏会一直停在启动时的那一门语言上。取键、用时再译。
const TOOL_META = [
  { tool: INK_TOOLS.PEN, key: 'ink.pen', icon: 'pen' },
  { tool: INK_TOOLS.PENCIL, key: 'ink.pencil', icon: 'pencil' },
  { tool: INK_TOOLS.MARKER, key: 'ink.marker', icon: 'marker' },
  { tool: INK_TOOLS.HIGHLIGHTER, key: 'ink.highlighter', icon: 'highlighter' },
  { tool: ERASER_TOOL, key: 'ink.eraser', icon: 'eraser' },
  { tool: LASSO_TOOL, key: 'ink.lasso', icon: 'lasso' },
  { tool: SHAPE_TOOL, key: 'ink.shape', icon: 'shape' },
];

/**
 * 面板上那十个形状的图标，照着视频里那张面板画的。
 *
 * 顺序也照抄：上一排是开着口的（线、箭头、双箭头、直角、弧），下一排是闭合的
 * （圆、三角、方、五边、星）。五边形和星形的坐标是按正多边形算出来的，和
 * shape-geometry 里画真家伙用的是同一套公式——图标和画出来的东西不该长得不一样。
 */
const SHAPE_ICON = Object.freeze({
  line: '<path d="M6 26L26 6"/>',
  arrow: '<path d="M6 26L26 6"/><path d="M17.5 6H26v8.5"/>',
  darrow: '<path d="M6 26L26 6"/><path d="M17.5 6H26v8.5"/><path d="M14.5 26H6v-8.5"/>',
  corner: '<path d="M7 26V7h19"/>',
  arc: '<path d="M6 25A19 19 0 0 1 25 6"/>',
  circle: '<circle cx="16" cy="16" r="10.5"/>',
  // 正三角形：底 22，高 22×√3/2 ≈ 19。画成底高相等的那种，图标说的就是另一个
  // 形状了——而这支工具吸住的时候给的正是正三角形。
  triangle: '<path d="M16 6.5L27 25.5H5Z"/>',
  rect: '<rect x="6.5" y="8.5" width="19" height="15" rx="1"/>',
  pentagon: '<path d="M16.0 4.5L26.9 12.4L22.8 25.3L9.2 25.3L5.1 12.4Z"/>',
  star: '<path d="M16.0 3.5L18.8 12.1L27.9 12.1L20.5 17.5L23.3 26.1L16.0 20.8L8.7 26.1L11.5 17.5L4.1 12.1L13.2 12.1Z"/>',
});

const metaFor = (tool) => TOOL_META.find(t => t.tool === tool) || TOOL_META[0];
const iconFor = (tool, size) => icon(metaFor(tool).icon, size);
/** 工具的显示名。每次调用都重新翻译，所以切换语言后无需重建这张表。 */
const labelFor = (tool) => t(metaFor(tool).key);

/**
 * How long the bar takes to fold away, and to come back.
 *
 * Slower than the drag's own 320ms on purpose. A drag is motion the reader is
 * already making, and it only has to keep up with them; this one they did not
 * ask for, so it has to be legible instead — long enough to read as the bar
 * folding up and travelling to a corner, short enough that a menu still feels
 * like it opened at once. The unfold is given slightly longer because it ends
 * on the shape the reader has to use, and arriving is worth more time than
 * leaving.
 */
const FOLD_MS = 420;
const UNFOLD_MS = 460;

/** Picking the bar up is the reader's own gesture, so the fold keeps up with it. */
const DRAG_FOLD_MS = 200;

const clampNumber = (v, lo, hi) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));

/**
 * Do two on-screen rectangles share any area?
 *
 * Touching edges do not count: a bar that ends exactly where a panel begins is
 * not covering it, and treating that as a collision would send the bar into a
 * corner for nothing.
 */
export function overlaps(a, b) {
  if (!a || !b) return false;
  if (!a.width || !a.height || !b.width || !b.height) return false;
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

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
    /** Current size multiplier; 1 is the full 44px touch target. */
    this._scale = 1;
    /**
     * Bands at the top and bottom of the host the bar may not enter.
     *
     * The host is the whole workspace, and the top of it is the pane's own
     * toolbar. A bar centred in the host therefore lay across ‹ and ☰ — two
     * controls it hid and a stylus could not reach past it. The host says how
     * much room to leave; the bar does not guess.
     */
    this._safe = { top: 0, bottom: 0 };
    /**
     * 人上一次亲手把球停在哪个角。
     *
     * 点开之后 state.corner 就没了，而「自动最小化」要收回那个角，所以这笔记
     * 在横杠自己身上，跨过展开这一步。开机第一次的值从存下来的位置里来——它本
     * 来就是球的话，那个角就是他上次放的地方。
     */
    this._homeCorner = this.state.corner || null;

    this.root = document.createElement('div');
    this.root.className = 'ink-toolbar';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', t('ink.toolbarLabel'));
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
    // 人自己把球停在哪个角，记着。点开之后 state.corner 就清空了（展开的横杠
    // 没有角），而「自动最小化」要把它收回**他放它的那个角**——收到别处去，
    // 等于每画一笔就让他重新找一次。让开借走的那个角不算数：那个位置不是他
    // 挑的，是一块面板逼出来的。
    if (isDocked(nextState) && nextState.corner && !isYielded(nextState)) {
      this._homeCorner = nextState.corner;
    }
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
      // 选中一片之后那条小条上的换色用的就是这排色——和笔用的是同一排，不另立
      // 一套。人刚用某个色写完，圈起来想改成另一个，手会往同一组颜色上去找。
      surface.setSwatches?.(this.state.swatches);
      return;
    }
    if (isEraser(this.state)) {
      surface.setEraser(this.state.eraserMode);
      surface.eraserRadius = this.state.eraserWidth;
      return;
    }
    if (isShape(this.state)) {
      // 形状要颜色、粗细和填充——视频里那张卡片上「边框」和「填充」两栏正是这
      // 几样。
      surface.setShape?.(this.state.shapeKind, this.state.shapeFill);
      surface.setColor(this.state.color);
      surface.setWidth(this.state.width);
      if (typeof surface.setOpacity === 'function') surface.setOpacity(this.state.opacity);
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

  /**
   * Sizes the bar against the column it is serving.
   *
   * Two separate demands, and the smaller wins:
   *
   *   It must FIT. A vertical bar is about thirteen touch targets long, and at
   *   44px each that is 583px — longer than the workspace on a tablet held in
   *   landscape with any chrome above it. A bar whose ends are off screen is a
   *   bar with tools that cannot be reached, and the grip is at one of those
   *   ends.
   *
   *   It must belong. The bar floats over one column, so it is measured
   *   against that column: drag the divider and the tools follow, instead of
   *   staying the size they were for a pane twice as wide.
   *
   * The floor is 32px rather than 44 because at that point the alternative is
   * not a larger button, it is a button off the bottom of the screen. It is
   * clamped, not free, so a very narrow column cannot shrink the tools to
   * something no finger can hit.
   */
  fitTo({ height, column } = {}) {
    const natural = this._naturalLength();
    let scale = 1;

    // The height it may use is the height it is allowed to occupy, not the
    // height of the host: budgeting against the whole workspace sized the bar
    // for room the pane's toolbar was already standing in.
    height = Math.max(0, height - this._safe.top - this._safe.bottom);
    if (height > 0 && natural > 0) {
      // 24px of margin, so the bar never sits flush against either end.
      scale = Math.min(scale, (height - 24) / natural);
    }
    if (column > 0) {
      // A column is comfortable for the full-size bar at about 420px; below
      // that the tools scale with it.
      scale = Math.min(scale, column / 420);
    }

    scale = Math.min(1, Math.max(MIN_SCALE, scale));
    if (Math.abs(scale - this._scale) < 0.01) return;
    this._scale = scale;
    this.root.style.setProperty('--ink-scale', String(scale));
    this.cardLayer.style.setProperty('--ink-scale', String(scale));
    this._clampIntoHost();
  }

  /**
   * Declares the bands at the top and bottom of the host the bar must stay out
   * of, in CSS pixels. Re-clamps and re-fits at once, so a header that changes
   * height moves the bar rather than waiting for the next drag.
   */
  setSafeArea(top = 0, bottom = 0) {
    const t = Math.max(0, Number(top) || 0);
    const b = Math.max(0, Number(bottom) || 0);
    if (t === this._safe.top && b === this._safe.bottom) return;
    this._safe = { top: t, bottom: b };
    // 收起成球的时候 _clampIntoHost 是直接返回的（球是靠两条边钉住的，往上面写
    // top 会把它拉长），所以球要走自己那条路重新摆一次。菜单栏升起来时球也在下
    // 角，一样会被盖住。
    if (this.state.phase === TOOLBAR_PHASE.DOCKED) this._positionDocked();
    else this._clampIntoHost();
  }

  /**
   * How long the bar wants to be, in CSS pixels, at full size.
   *
   * Measured from the DOM rather than counted, so adding a tool or a swatch
   * cannot leave a stale number here — the arithmetic that produced 583px was
   * only correct for the toolbar as it stood the day it was written.
   */
  _naturalLength() {
    const vertical = this.state.edge === EDGES.LEFT || this.state.edge === EDGES.RIGHT;
    const measured = vertical ? this.root.offsetHeight : this.root.offsetWidth;
    if (!measured) return 0;
    return measured / (this._scale || 1);
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
              aria-label="${escapeAttr(t('ink.moveToolbar'))}"
              title="${escapeAttr(t('ink.dragToMove'))}">${icon('grip', 20)}</button>
      <span class="ink-sep" aria-hidden="true"></span>
      <div class="ink-tools" role="group" aria-label="${escapeAttr(t('ink.tools'))}">
        ${TOOL_META.map(meta => `
          <button type="button" class="ink-tool${meta.tool === state.tool ? ' is-selected' : ''}"
                  data-tool="${meta.tool}" title="${escapeAttr(t(meta.key))}"
                  aria-label="${escapeAttr(t(meta.key))}"
                  aria-pressed="${meta.tool === state.tool}">
            ${icon(meta.icon)}
          </button>`).join('')}
      </div>
      <span class="ink-sep" aria-hidden="true"></span>
      <div class="ink-swatches" role="group" aria-label="${escapeAttr(t('ink.inkColour'))}">
        ${state.swatches.map(color => `
          <button type="button" class="ink-swatch${sameColor(color, state.color) ? ' is-selected' : ''}"
                  data-swatch="${escapeAttr(color)}"
                  title="${escapeAttr(color)}"
                  aria-label="${escapeAttr(t('ink.colourNamed', { colour: color }))}"
                  aria-pressed="${sameColor(color, state.color)}">
            <span class="ink-swatch-fill" style="background:${escapeAttr(color)}"></span>
          </button>`).join('')}
        <button type="button" class="ink-swatch is-custom" data-role="color-card"
                title="${escapeAttr(t('ink.moreColours'))}"
                aria-label="${escapeAttr(t('ink.moreColours'))}">${icon('plus', 18)}</button>
      </div>
      <span class="ink-sep" aria-hidden="true"></span>
      <button type="button" class="ink-overflow" data-role="overflow"
              aria-label="${escapeAttr(t('ink.moreSettings'))}"
              title="${escapeAttr(t('ink.moreSettings'))}">${icon('more', 20)}</button>
    `;

    this._bindToolbar();
    // Placement was computed from the PREVIOUS contents, so the bar's real size
    // is only known now. Clamp once it exists.
    this._clampIntoHost();
    // 卡片：要么重建，要么就地刷一遍。两条路都得有人走——见 _syncCard。
    if (this._keepCard) this._syncCard();
    else this._renderCard();
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
    // 颜色点只对"会留下颜色"的工具有意义。橡皮和套索没有颜色，给它们点一颗红点
    // 是在说一件不存在的事，而且那颗点就压在图标的边上。
    const dot = token.querySelector('.ink-token-dot');
    const colourful = Object.values(INK_TOOLS).includes(this.state.tool);
    dot.hidden = !colourful;
    if (colourful) dot.style.background = this.state.color;

    // Docked, the puck is the only control the toolbar has left, so it takes
    // the button semantics. In flight it is scenery attached to the pointer,
    // and announcing a button that cannot be reached would be a lie.
    if (docked) {
      token.dataset.role = 'handle';
      token.removeAttribute('aria-hidden');
      token.setAttribute('role', 'button');
      token.setAttribute('tabindex', '0');
      token.setAttribute('aria-label', t('ink.expandToolbar'));
      token.setAttribute('title', t('ink.tapToExpand'));
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
    // 下面那两个角要把菜单栏让出来：球收在下角，而菜单栏正是从下面升上来的。
    // 上面两个角同理，让的是分栏自己的横杠。
    const top = `${this._safe.top + 10}px`;
    const bottom = `${this._safe.bottom + 10}px`;
    if (corner === CORNERS.TOP_LEFT) { s.left = M; s.top = top; }
    else if (corner === CORNERS.TOP_RIGHT) { s.right = M; s.top = top; }
    else if (corner === CORNERS.BOTTOM_LEFT) { s.left = M; s.bottom = bottom; }
    else { s.right = M; s.bottom = bottom; }
  }

  /**
   * Steps the bar aside into one of `corners`, folding it into the puck and
   * flying it there.
   *
   * The candidates are tried in order and the first whose puck actually clears
   * `avoid` wins, because the corner nearest the panel is the natural one to
   * ask for and the one a long panel is most likely to still be covering.
   * Each candidate is measured after layout rather than predicted, so the
   * answer holds whatever the puck's size turns out to be.
   *
   * Only the travel is animated; the resting placement is already correct
   * before the first frame, which is what makes this safe to interrupt.
   */
  yieldTo(corners, avoid = null) {
    if (isYielded(this.state)) return;
    // Bottom corners only, whatever the caller asked for.
    //
    // "Sometimes it goes to the top corner" — an earlier version offered the
    // top corner as a last resort when a long list covered both bottom ones,
    // and where the bar ended up depended on how tall that list happened to
    // be. Stepping aside has to land in the same place every time or it is not
    // a place, it is a scatter. The rule is the floor of the column, and this
    // is where it is enforced rather than trusted.
    const candidates = (Array.isArray(corners) ? corners : [corners])
      .filter(c => c === CORNERS.BOTTOM_LEFT || c === CORNERS.BOTTOM_RIGHT);
    if (!candidates.length) return;

    // Nothing from a previous fold may still be in the air: two stills over
    // one bar is the one way this can look like a duplicate rather than a move.
    this._clearGhosts();
    const from = this.root.getBoundingClientRect();
    // Taken BEFORE the swap, while there is still a bar to take a picture of.
    const ghost = this._ghost(from);

    let landed = false;
    for (const corner of candidates) {
      this._set(yieldToCorner(this.state, corner), { pushTools: false });
      landed = true;
      if (!avoid || !overlaps(this.root.getBoundingClientRect(), avoid)) break;
    }
    // Every corner was still covered: the first is as good as any, and the bar
    // being small and in a corner already beats it lying across the panel.
    if (!landed) { ghost?.remove(); return; }
    this._playFold(ghost, from, this.root.getBoundingClientRect());
  }

  /**
   * A still of the bar, parked over the real one and owning no events.
   *
   * Returns null when there is nothing worth animating — no layout, or a
   * reader who has asked for less motion.
   */
  _ghost(from) {
    if (!from?.width || !from.height) return null;
    if (prefersReducedMotion() || typeof this.root.animate !== 'function') return null;
    const clone = this.root.cloneNode(true);
    clone.removeAttribute('id');
    clone.setAttribute('aria-hidden', 'true');
    clone.dataset.role = 'toolbar-ghost';
    // Fixed, in viewport coordinates, on the body: the bar's own ancestors
    // carry transforms, and a fixed child of a transformed element is measured
    // against that element instead of the viewport.
    clone.style.cssText = `position: fixed; margin: 0; left: ${from.left}px; top: ${from.top}px;`
      + ` width: ${from.width}px; height: ${from.height}px; right: auto; bottom: auto;`
      + ' transform: none; pointer-events: none; z-index: 59;';
    document.body.appendChild(clone);
    return clone;
  }

  /**
   * The bar folding into the corner, as one object rather than two.
   *
   * `render()` swaps the bar's contents for the puck within a single frame, so
   * the element itself can never be caught shrinking: by the time there is
   * anything to animate, the tools are already gone and all that is left to
   * scale is a circle — which stretches into an ellipse and reads as a glitch,
   * not as folding. So what travels is the still: it shrinks and fades into the
   * puck's box while the real puck is held back and brought up underneath it.
   * One thing folds up; nothing vanishes and nothing appears.
   */
  _playFold(ghost, from, to, { duration = FOLD_MS, holdBack = true } = {}) {
    if (!ghost) return;
    if (!to?.width || !to.height) { ghost.remove(); return; }

    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    const sx = to.width / from.width;
    const sy = to.height / from.height;

    const travel = ghost.animate(
      [
        { transform: 'none', opacity: 1, borderRadius: '26px' },
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0, borderRadius: '50%' },
      ],
      { duration, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' },
    );

    // The puck comes up as the still goes out, over the same stretch of time,
    // so the two are never both fully there and never both gone.
    //
    // Not while dragging, though: there the token is under the reader's pen and
    // has to be there from the first pixel. The still simply dissolves behind
    // it instead.
    if (holdBack) {
      this._fade = this.root.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: duration * 0.45, delay: duration * 0.55, easing: 'linear', fill: 'backwards' },
      );
    }

    const done = () => ghost.remove();
    if (travel.finished) travel.finished.then(done, done);
    else travel.onfinish = done;
  }

  /** Hands back the placement a `yieldTo` borrowed, unfolding on the way. */
  restoreFromYield() {
    if (!isYielded(this.state)) return;
    const from = this.root.getBoundingClientRect();
    // A fold still in the air has nothing left to finish; the bar is coming
    // back and the still would only fade out on top of it.
    this._clearGhosts();
    // Same reason as _undock(): the bar must be at full size before
    // _clampIntoHost() measures it, or it centres a bar still growing.
    this.root.classList.add('is-instant');
    this._set(unyield(this.state), { pushTools: false });
    this._absorb(from, false, UNFOLD_MS);
    requestAnimationFrame(() => {
      this.root.classList.remove('is-instant');
      this._clampIntoHost();
    });
  }

  /**
   * 笔落到纸上了：如果人要求过，就把横杠收起来。
   *
   * 「自动最小化」原来是一颗只会记住自己被勾上的复选框——设置在，行为从来不
   * 在。这里补的就是那个行为：点开横杠、挑一支笔、开始写，横杠回到它出来的那
   * 个角上变回一颗球。
   *
   * 收的是真的（dockToCorner），不是让开（yieldTo）：没有谁欠它一个位置，也没
   * 有哪一刻该把它还回来。要它回来就点那颗球，和平时一样。
   *
   * 已经是球、正在被拖、或者正为某块面板让着的时候，这里什么都不做——前两种
   * 是人手上的事，第三种的位置是借来的，把借条改写成「他自己收的」，面板关掉
   * 之后横杠就再也回不到原处了。
   */
  minimizeOnDraw() {
    if (!this.state.autoMinimize) return;
    if (this.state.phase !== TOOLBAR_PHASE.EXPANDED) return;
    if (isYielded(this.state)) return;

    const corner = this._minimizeCorner();
    // 上一次折叠留在半空中的那张静像先收掉：一根横杠上同时挂两张，是这一下唯
    // 一会被看成「多出来一个」而不是「一个东西在动」的情形。
    this._clearGhosts();
    const from = this.root.getBoundingClientRect();
    const ghost = this._ghost(from);
    const before = this.state;
    this._set(dockToCorner(this.state, corner), { pushTools: false });
    if (this.state === before) { ghost?.remove(); return; }
    this._playFold(ghost, from, this.root.getBoundingClientRect());
  }

  /** 自动最小化该往哪个角收。 */
  _minimizeCorner() {
    // 它自己出来的那个角。人是从那儿把它点开的，那儿就是他再去找它的地方。
    if (this._homeCorner) return this._homeCorner;
    // 从来没当过球（一直贴在某条边上）：落到自己这半边的下角，和「为面板让
    // 开」用的是同一条规矩——见 pdf-workspace 的 _cornerFor。
    const host = this.host?.getBoundingClientRect?.();
    if (!host || !host.width) return CORNERS.BOTTOM_RIGHT;
    const bar = this.root.getBoundingClientRect();
    const mid = (bar.left + bar.right) / 2;
    return mid < host.left + host.width / 2 ? CORNERS.BOTTOM_LEFT : CORNERS.BOTTOM_RIGHT;
  }

  /**
   * Picking the bar up: the same fold, quicker, and with nothing held back.
   *
   * The bar used to become the token in the frame the pointer went down —
   * "suddenly become one", with no shrink to watch. It is the same swap the
   * deck list triggers and it gets the same treatment, only faster: a drag is
   * a gesture the reader is making, and anything that lags behind their pen
   * reads as the app being slow rather than as the bar folding up.
   */
  _beginDrag(point) {
    // A puck is already the shape it would fold into. Taking a picture of one
    // circle to shrink it into another circle is motion that says nothing.
    if (isDocked(this.state)) {
      this._set(startDrag(this.state, point), { pushTools: false });
      return;
    }
    this._clearGhosts();
    const from = this.root.getBoundingClientRect();
    const ghost = this._ghost(from);
    this._set(startDrag(this.state, point), { pushTools: false });
    this._playFold(ghost, from, this.root.getBoundingClientRect(),
      { duration: DRAG_FOLD_MS, holdBack: false });
  }

  /** Drops any still left in the air, so two folds cannot stack up. */
  _clearGhosts() {
    for (const el of document.querySelectorAll('[data-role="toolbar-ghost"]')) el.remove();
    // Only the fade this fold started. `getAnimations()` returns everything
    // running on the bar — the travel from a drag, the settle after a resize,
    // any CSS transition mid-flight — and cancelling all of it to clean up
    // after ourselves stopped motion that had nothing to do with the fold.
    this._fade?.cancel();
    this._fade = null;
    this.root.style.opacity = '';
  }

  isYielded() { return isYielded(this.state); }

  /** Where the bar is on screen, for callers deciding whether it is in the way. */
  rect() { return this.root.getBoundingClientRect(); }

  /** Puck → bar, unfolding out of the corner it was parked in. */
  _undock() {
    if (!isDocked(this.state)) return;
    const from = this.root.getBoundingClientRect();
    // Expand at full size with the padding/border-radius transition suppressed.
    //
    // `.is-docked` sets `padding: 0`; leaving it, those transition over 200ms.
    // `_clampIntoHost()` runs inside the `render()` below and measures
    // `offsetHeight` — mid-transition that reads a bar still growing, so it
    // centres a too-short bar. The next render (the first tool tap) re-measures
    // the settled height and nudges the bar ~5px down: the "slight downward
    // jump". Snapping to full size makes that first measurement the real one;
    // `_absorb()` still animates the visible travel from the puck.
    this.root.classList.add('is-instant');
    this._set(undock(this.state), { pushTools: false });
    this._absorb(from, false);
    requestAnimationFrame(() => {
      this.root.classList.remove('is-instant');
      this._clampIntoHost();
    });
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
    // Only the expanded bar is placed by an edge and a fraction along it. A
    // puck is anchored to the two sides of its corner and a drag token follows
    // the pointer, and writing `top` on either of those is not a nudge — it is
    // a second anchor. `bottom: 10px` from the corner plus a `top` from here
    // stretched the puck to the full height of the column and then translated
    // it half its own height off the screen: the bar did not fold away, it
    // vanished.
    //
    // It reached here through fitTo(), which re-clamps after a scale change and
    // is called from onChange on the very _set() that docked the bar — so
    // whether the bar survived stepping aside came down to whether its scale
    // happened to change, which is why it did it some of the time.
    if (this.state.phase !== TOOLBAR_PHASE.EXPANDED) return;
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
      // The band the bar is allowed to occupy, once the pane's own chrome has
      // been left alone.
      const lo = this._safe.top + M;
      const hi = hostH - this._safe.bottom - M;
      const free = hi - lo;
      // A bar taller than the band cannot be fully shown; centre it in what
      // there is and let it overflow evenly rather than hiding one end.
      const centre = barH >= free
        ? lo + free / 2
        : clampNumber(this.state.offset * hostH, lo + half, hi - half);
      s.top = `${centre}px`;
      s.transform = 'translateY(-50%)';
    } else {
      const half = barW / 2;
      const centre = barW + M * 2 >= hostW
        ? hostW / 2
        : clampNumber(this.state.offset * hostW, half + M, hostW - half - M);
      s.left = `${centre}px`;
      s.transform = 'translateX(-50%)';
      // 横着躺的那一条也要让开那两条带子。
      //
      // 这一支原来只夹左右——竖着的那条早就认 _safe，横着的这条没有。于是贴在
      // 底边的工具栏会被升起来的菜单栏盖掉半截，而那正是最容易撞上的摆法。
      //
      // 只改它自己那一侧的那一个属性：贴底边的改 bottom，贴顶边的改 top。两边
      // 都写就是给同一个元素钉了两条边，那会把它拉长——收起来的球被拉成整栏高
      // 的一条，就是这么来的。
      if (this.state.edge === EDGES.BOTTOM) s.bottom = `${this._safe.bottom + M}px`;
      else s.top = `${this._safe.top + M}px`;
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
  _absorb(from, corner, duration = null) {
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
        duration: duration ?? (corner ? 420 : 320),
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
              : tool === SHAPE_TOOL ? CARDS.SHAPE
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
    this._swallowClick = false;
    /** Swallow even a click that lands on the toolbar itself. See the undock tap. */
    this._swallowInside = false;

    const toHostPoint = (e) => {
      const rect = this.host.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this._onDragStart = (e) => {
      if (this._drag.pointerId !== null) return;
      if (!e.target.closest?.('[data-role="handle"]')) return;
      e.preventDefault();
      e.stopPropagation();
      // Arm the swallow for the click the browser synthesises afterwards.
      //
      // preventDefault on pointerdown does not suppress it, and the element it
      // was aimed at is destroyed by the render this gesture triggers. A click
      // whose target has gone is retargeted to whatever is underneath — which,
      // for a puck parked in the top-left, is the import button, so tapping
      // the toolbar opened the system file picker.
      this._swallowClick = true;
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
      this._beginDrag(point);
    };

    this._onDragMove = (e) => {
      if (this._drag.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const point = toHostPoint(e);

      if (!this._drag.started) {
        const from = this._drag.start;
        if (Math.hypot(point.x - from.x, point.y - from.y) < TAP_SLOP) return;
        this._drag.started = true;
        this._beginDrag(point);
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

      // The synthesised click follows within a frame or two. If none arrives —
      // a cancelled gesture, a stylus lifted outside — the arming has to
      // expire, or it would swallow whatever the user pressed minutes later.
      clearTimeout(this._swallowTimer);
      this._swallowTimer = setTimeout(() => {
        this._swallowClick = false;
        this._swallowInside = false;
      }, 400);

      // Never travelled, so it was a tap — and on a docked puck a tap expands.
      if (!started) {
        if (fromDocked) {
          // Expanding puts a whole bar of controls under a finger that is
          // still down. The click that follows lands INSIDE the toolbar, on a
          // button that did not exist when the press began — so this is the
          // one case where a click inside must be swallowed too.
          this._swallowInside = true;
          this._undock();
        }
        return;
      }

      const rect = this.host.getBoundingClientRect();
      const viewport = { width: rect.width, height: rect.height };

      // Where the pointer WAS, not where the event says it is.
      //
      // pointercancel is delivered when the system takes the gesture away —
      // and Android hands it over carrying stale or zero coordinates. Read as
      // a release, (0, 0) is the top-left corner of the workspace, so a bar
      // dragged from anywhere docked itself into the top-left instead of
      // where the finger actually let go. The last position the drag itself
      // recorded is the truthful one.
      const cancelled = e.type === 'pointercancel' || e.type === 'lostpointercapture';
      const tracked = this.state.dragPoint;
      const point = (cancelled && tracked) ? tracked : toHostPoint(e);
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

    /**
     * Kills only the click that has been retargeted off the toolbar.
     *
     * Narrow on purpose. Swallowing the next click unconditionally also eats
     * the tool button the user presses straight after moving the bar, which
     * is a far more common gesture than the one being defended against.
     * A click that still lands inside the toolbar found its target and is
     * exactly the click that must go through.
     */
    this._onClickCapture = (e) => {
      if (!this._swallowClick) return;
      this._swallowClick = false;
      // Set only by the tap that expands a docked puck; see there.
      const alsoInside = this._swallowInside;
      this._swallowInside = false;
      // A toolbar that is no longer in the document has no business
      // suppressing anything. This listener lives on `window` and outlives a
      // subtree that was replaced rather than destroyed, and it is the one
      // listener here whose effect is not scoped by a pointer id.
      if (!this.root.isConnected) return;
      if (!alsoInside
          && (this.root.contains(e.target) || this.cardLayer.contains(e.target))) return;
      e.preventDefault();
      e.stopPropagation();
    };

    this.root.addEventListener('pointerdown', this._onDragStart);
    this.root.addEventListener('keydown', this._onKeyDown);
    // Capture phase on the window, so it is seen before any control it might
    // have been retargeted onto.
    window.addEventListener('click', this._onClickCapture, { capture: true });
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
    window.removeEventListener('click', this._onClickCapture, { capture: true });
    clearTimeout(this._swallowTimer);
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
  /**
   * 卡片不重建，只把「现在选的是哪一个」重新刷一遍。
   *
   * 挑一个形状、挑一个颜色，变的只是哪一格亮着。整张卡片重建也能得到对的结果，
   * 但 `.ink-card` 带着一段 200ms 的入场动画，重建等于让它**重播一次**——人看
   * 到的就是「闪一下才更新」。何况重建还会把人正按着的滑杆从手指底下换掉。
   *
   * 所以这里只动 class 和那条预览线的内联样式。卡片的结构一个字节都不重排，
   * 动画自然也就无从重播。
   */
  _syncCard() {
    const card = this.cardLayer.querySelector('.ink-card');
    if (!card) return;
    const { state } = this;
    const mark = (selector, isOn) => {
      for (const el of card.querySelectorAll(selector)) {
        el.classList.toggle('is-selected', isOn(el));
      }
    };
    mark('[data-shape-kind]', el => el.dataset.shapeKind === state.shapeKind);
    mark('[data-shape-fill]', el => sameColor(el.dataset.shapeFill || '', state.shapeFill || ''));
    mark('[data-swatch]', el => sameColor(el.dataset.swatch, state.color));

    // 笔的那张卡片上有一条预览线，颜色粗细透明度都画在它身上。它不是「选中」，
    // 是一个值，所以单独写一句。
    const preview = card.querySelector('.ink-preview-line');
    if (preview) {
      preview.style.background = state.color;
      preview.style.height = `${Math.max(1, state.width)}px`;
      preview.style.opacity = state.opacity;
    }
    const width = card.querySelector('[data-role="width-readout"]');
    if (width) width.textContent = state.width.toFixed(1);
    const opacity = card.querySelector('[data-role="opacity-readout"]');
    if (opacity) opacity.textContent = String(Math.round(state.opacity * 100));
  }

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
    else if (state.openCard === CARDS.SHAPE) card.innerHTML = this._shapeCardHtml();
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
        <span>${t('ink.width')} <b data-role="width-readout">${state.width.toFixed(1)}</b> mm</span>
        <input type="range" min="0.2" max="20" step="0.1" value="${state.width}" data-role="width">
      </label>
      <label class="ink-field">
        <span>${t('ink.opacity')} <b data-role="opacity-readout">${Math.round(state.opacity * 100)}</b>%</span>
        <input type="range" min="0" max="100" step="1" value="${Math.round(state.opacity * 100)}" data-role="opacity">
      </label>
      <div class="ink-card-swatches">
        ${state.swatches.map(c => `<button type="button" class="ink-swatch${sameColor(c, state.color) ? ' is-selected' : ''}"
          data-swatch="${escapeAttr(c)}" style="background:${escapeAttr(c)}"></button>`).join('')}
      </div>`;
  }

  /**
   * 形状卡片：挑一种形状，再定边框的粗细和颜色。
   *
   * 照着视频里那张面板收的：上面一排形状（它那张有十个，这里先只有直线和圆），
   * 底下是「边框」——一根粗细滑杆加一排颜色。选中的那一个在视频里是金色的，这里
   * 也是金色，用的还是套索、选区把手那同一支金。
   *
   * 粗细和颜色走的是工具栏自己那两个部件（data-role="width"、data-swatch），
   * 所以它们不需要单独接线，也天然和笔共用同一排色——人刚用某个色写完字，换成
   * 形状去画个圈，手会往同一组颜色上去找。
   */
  _shapeCardHtml() {
    const { state } = this;
    const pick = (kind) => `
      <button type="button" class="ink-shape-btn${state.shapeKind === kind ? ' is-selected' : ''}"
              data-shape-kind="${kind}" aria-label="${escapeAttr(t(`ink.shape.${kind}`))}"
              title="${escapeAttr(t(`ink.shape.${kind}`))}">
        <svg viewBox="0 0 32 32" width="26" height="26" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true">${SHAPE_ICON[kind]}</svg>
      </button>`;
    const row = (kinds) => `<div class="ink-shape-row">${kinds.map(pick).join('')}</div>`;
    // 「无」那一格画的是一个打叉的圈，和视频里填充那一排头一个一样：它不是一种
    // 颜色，是「别填」。
    const fill = (colour) => `
      <button type="button" class="ink-swatch${colour ? '' : ' is-none'}${sameColor(colour || '', state.shapeFill || '') ? ' is-selected' : ''}"
              data-shape-fill="${escapeAttr(colour || '')}"
              aria-label="${escapeAttr(colour || t('ink.shapeNoFill'))}"
              ${colour ? `style="background:${escapeAttr(colour)}"` : ''}></button>`;
    return `
      <div class="ink-card-title">${t('ink.shape')}</div>
      ${row(SHAPE_ORDER.slice(0, 5))}
      ${row(SHAPE_ORDER.slice(5))}
      <div class="ink-card-label">${t('ink.shapeBorder')}</div>
      <label class="ink-field">
        <span>${t('ink.width')} <b data-role="width-readout">${state.width.toFixed(1)}</b> mm</span>
        <input type="range" min="0.2" max="20" step="0.1" value="${state.width}" data-role="width">
      </label>
      <div class="ink-card-swatches">
        ${state.swatches.map(c => `<button type="button" class="ink-swatch${sameColor(c, state.color) ? ' is-selected' : ''}"
          data-swatch="${escapeAttr(c)}" style="background:${escapeAttr(c)}"></button>`).join('')}
      </div>
      <div class="ink-card-label">${t('ink.shapeFill')}</div>
      <div class="ink-card-swatches">
        ${[null, ...state.swatches].map(fill).join('')}
      </div>
      <p class="ink-note">${t('ink.shapeNote')}</p>`;
  }

  _eraserCardHtml() {
    const { state } = this;
    return `
      <div class="ink-card-title">${t('ink.eraser')}</div>
      <div class="ink-seg">
        <button type="button" class="ink-seg-btn${state.eraserMode === ERASER_MODES.STROKE ? ' is-selected' : ''}"
                data-eraser-mode="${ERASER_MODES.STROKE}">${t('ink.eraseStroke')}</button>
        <button type="button" class="ink-seg-btn${state.eraserMode === ERASER_MODES.REGION ? ' is-selected' : ''}"
                data-eraser-mode="${ERASER_MODES.REGION}">${t('ink.eraseRegion')}</button>
      </div>
      <label class="ink-field">
        <span>${t('ink.eraserSize')} <b data-role="eraser-readout">${state.eraserWidth.toFixed(1)}</b> mm</span>
        <input type="range" min="1" max="40" step="0.5" value="${state.eraserWidth}" data-role="eraser-width">
      </label>
      <button type="button" class="ink-danger" data-role="clear-ink">${t('ink.clearPage')}</button>
      <p class="ink-note">${t('ink.clearNote')}</p>`;
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
      <div class="ink-card-title">${t('ink.lasso')}</div>
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
                data-lasso-shape="${LASSO_SHAPES.FREE}">${t('ink.lassoFree')}</button>
        <button type="button" class="ink-seg-btn${free ? '' : ' is-selected'}"
                data-lasso-shape="${LASSO_SHAPES.RECT}">${t('ink.lassoRect')}</button>
      </div>
      <div class="ink-card-label">${t('ink.selectMode')}</div>
      <div class="ink-seg">
        <button type="button" class="ink-seg-btn${state.lassoMode === LASSO_MODES.TOUCH ? ' is-selected' : ''}"
                data-lasso-mode="${LASSO_MODES.TOUCH}">${t('ink.lassoTouch')}</button>
        <button type="button" class="ink-seg-btn${state.lassoMode === LASSO_MODES.INSIDE ? ' is-selected' : ''}"
                data-lasso-mode="${LASSO_MODES.INSIDE}">${t('ink.lassoInside')}</button>
      </div>
      <p class="ink-note">${t('ink.lassoNote')}</p>`;
  }

  _colorCardHtml() {
    const { state } = this;
    const palette = [
      '#111827', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#ffffff',
      '#dc2626', '#ea580c', '#d97706', '#ca8a04', '#65a30d', '#16a34a',
      '#0d9488', '#0891b2', '#2563eb', '#4f46e5', '#7c3aed', '#c026d3',
    ];
    return `
      <div class="ink-card-title">${t('ink.colour')}</div>
      <div class="ink-palette">
        ${palette.map(c => `<button type="button" class="ink-palette-dot${sameColor(c, state.color) ? ' is-selected' : ''}"
          data-swatch="${escapeAttr(c)}" style="background:${escapeAttr(c)}" aria-label="${escapeAttr(c)}"></button>`).join('')}
      </div>
      <label class="ink-field">
        <span>${t('ink.opacity')} <b data-role="opacity-readout">${Math.round(state.opacity * 100)}</b>%</span>
        <input type="range" min="0" max="100" step="1" value="${Math.round(state.opacity * 100)}" data-role="opacity">
      </label>
      <p class="ink-note">${t('ink.colourNote')}</p>`;
  }

  _overflowCardHtml() {
    return `
      <div class="ink-card-title">${t('ink.toolbarSettings')}</div>
      <label class="ink-check">
        <input type="checkbox" data-role="auto-minimize" ${this.state.autoMinimize ? 'checked' : ''}>
        <span>${t('ink.autoMinimise')}</span>
      </label>
      <p class="ink-note">${t('ink.dragNote')}</p>`;
  }

  _bindCard(card) {
    // A card is a control surface floating over a document.
    //
    // Its pointer events used to reach the page underneath, so dragging the
    // eraser-size slider panned the PDF and, past the swipe threshold, turned
    // the page — and the pan dismissed the card out from under the finger
    // still holding the slider. The card takes its own gestures and gives the
    // page nothing.
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      card.addEventListener(type, (e) => e.stopPropagation());
    }
    // Range inputs need the browser's own drag handling, so the gesture is
    // claimed rather than cancelled: `none` stops the WebView deciding
    // mid-drag that a mostly-horizontal movement was a page swipe.
    card.querySelectorAll('input[type="range"]').forEach((slider) => {
      slider.style.touchAction = 'none';
    });

    // 换颜色同理：卡片不重建，那条预览线和那一圈高亮由 _syncCard 就地改。
    card.querySelectorAll('[data-swatch]').forEach((button) => {
      button.addEventListener('click', () => this._set(
        setColor(this.state, button.dataset.swatch), { keepCard: true },
      ));
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

    // 挑形状、挑填充色：keepCard，靠 _syncCard 就地把高亮挪过去。
    //
    // 这里先后错过两次，两次都被人在机上看出来了，所以两条都写下来：
    //
    // 一开始传 keepCard 但没有 _syncCard，于是形状真的换了、笔落下去也确实是新
    // 形状，卡片上那个高亮却留在旧的那一格——看着像没点上。
    //
    // 改成重建卡片之后高亮是对了，但 `.ink-card` 带着一段 200ms 的入场动画，重
    // 建等于重播它一次——「闪一下才更新」。
    //
    // 两样都要：不重建（所以不闪），但把选中的那一格刷过去（所以看得见）。
    card.querySelectorAll('[data-shape-fill]').forEach((button) => {
      button.addEventListener('click', () => this._set(
        setShapeFill(this.state, button.dataset.shapeFill), { keepCard: true },
      ));
    });

    card.querySelectorAll('[data-shape-kind]').forEach((button) => {
      button.addEventListener('click', () => this._set(
        setShapeKind(this.state, button.dataset.shapeKind), { keepCard: true },
      ));
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
