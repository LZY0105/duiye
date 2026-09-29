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
  cornerOf,
  createToolbarState,
  dockToCorner,
  endDrag,
  backToRow,
  foldToPerch,
  isCornerPoint,
  isDocked,
  isEraser,
  isShape,
  isYielded,
  leavePerch,
  moveDrag,
  nearestEdge,
  openCard,
  orientationOf,
  perchAt,
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
  stepOffRow,
  yieldToCorner,
  undock,
  unyield,
} from './toolbar-state.js';
import { currentLang, onLangChange, t } from '../core/i18n.js';
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

/** 一张卡片退场演多久。和 ink-toolbar.css 里 ink-card-out 同一个数。 */
const CARD_LEAVE_MS = 150;

/**
 * 停在顶上那一排里时：点开、收起各演多久，和它最多缩到多小。
 *
 * 那一排比工作区挤得多，所以能比平时（MIN_SCALE）再小一点：挤到 0.62，按钮还有
 * 27px，手上那支笔点得中；再小就不在那一排里点开，挂到那一排下面去。
 */
const PERCH_OPEN_MS = 460;
const PERCH_CLOSE_MS = 340;
const PERCH_MIN_SCALE = 0.62;
/** 松手后球落进顶上那一排那一下：从它此刻画着的地方滑到停着的地方。不回弹——回弹会顶到标签上。 */
const PERCH_LAND_MS = 360;

/**
 * 顶上那一排收起 / 拉回时，停在里面的工具栏借住到左边、再回去（_stepOffRow / _returnToRow）。
 *
 * ROW_MS 和那一排自己滑的那一段同长、同一条曲线（pdf.css 的 .pdf-page-bar、
 * pdf-workspace-ui.js 的 ROW_SLIDE_MS）：跟着它走掉的替身、跟着它落回来的那一颗，和它是同
 * 一个动作。
 *
 * 一先一后，不同时：走的那一个整个走完，来的那一个才出现。人说「向下拉时，工具栏还没完全退出，
 * 顶部的就加载出来了」——原来拉回时左边那一个往外滑、顶上那一个同时就长出来了，屏幕上有两个。
 * 走的那一个已经看不见了（跟手拉到头才松手，它早就跟着那一排淡没了），来的那一个只隔一小口气
 * （ENTER_GAP）就来。出去比进来快：离开不值得和到来一样多的时间（和点开 / 收起同一条规矩）。
 */
const ROW_MS = 320;
const ROW_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const OFF_ROW_ENTER_MS = 420;
const OFF_ROW_LEAVE_MS = 220;
const OFF_ROW_ENTER_GAP = 60;
/** 回到那一排里的球长出来那一下。 */
const OFF_ROW_POP_MS = 240;

/**
 * 工具、颜色上按住划着挑（_installScrub）。
 *
 * SCRUB_START 和顶上那一排的收起手势、两个标签的划动是同一个数：手指按着会晃几像素，过了这么远
 * 才是有意在划。SCRUB_ESCAPE：抬手时离横杠这么远（横躺的看上下、竖着的看左右），算划出去了、
 * 反悔了。透镜从选中那一格浮起来追到手指底下用 SCRUB_CATCH_MS，松手落回去用 SCRUB_SETTLE_MS。
 */
const SCRUB_START = 10;
const SCRUB_ESCAPE = 44;
const SCRUB_CATCH_MS = 160;
const SCRUB_SETTLE_MS = 220;
const SCRUB_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

const clampNumber = (v, lo, hi) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
    /** 工作区最后一次告诉它的约束（可用高度、所在那一栏多宽）。见 fitTo。 */
    this._fit = null;
    /** 这条横杠的长度怎么随缩放变，按结构缓存。见 _lengthModel。 */
    this._model = null;
    /** 横杠现在这一份 DOM 是按什么结构搭的。见 render。 */
    this._barSignature = null;
    /** 上一次画出来的是哪个阶段——从球变回横杠的那一下要特殊对待。 */
    this._shownPhase = null;
    /**
     * 顶上那一排（页面那一层给的，见 setPerchHost）。没有它，工具栏就不知道那一排
     * 在哪，也就停不进去。
     */
    this._perchHost = null;
    /** 点开着的那一条上一次摆在哪、缩放多少。收起那一段要从这儿开始收。 */
    this._perchLayout = null;
    /** 正在演点开 / 收起：这段时间里邻居由动画逐帧摆，重摆位置时别去动它们。 */
    this._perchAnimating = false;
    /** 专注模式把那一排收掉时它被请到角上，记着是从哪一处来的，好回去。 */
    this._perchMemo = null;

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
    this._installScrub();
    // 语言换了，横杠上的提示和读屏念的名字都要跟着换。原来没人通知它：整条横杠
    // 的名字停在开机那一刻的语言里，按钮上的要等人下一次点它才换。
    this._offLang = onLangChange(() => {
      this.root.setAttribute('aria-label', t('ink.toolbarLabel'));
      this.render();
    });
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
   *
   *   `persist: false` 不落盘：滑杆每拖一个像素都来一次，localStorage 在平板
   *   上是同步写盘的。松手（change）时再存一次就够了。
   *
   *   `quiet: true` 连工作区也不惊动：拖着球走的那一路，每一帧都去量一遍安全
   *   区、再算一遍缩放，量的还是一颗球——见 fitTo。
   */
  _set(nextState, { pushTools = true, keepCard = false, persist = true, quiet = false } = {}) {
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
    if (persist) this._persist();
    if (pushTools) this._pushToSurface();
    if (!quiet) this.handlers.onChange?.(this.state);
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
    // 只记下约束，算不算、什么时候算由 _applyFit 决定：收成球、正被拖着的时候
    // 屏幕上根本没有一条横杠可量。
    this._fit = { height: Number(height) || 0, column: Number(column) || 0 };
    this._applyFit();
    // 不管缩放变没变都重新摆一次。工作区从看不见变回看得见、栏头换了语言变了
    // 高度——这些时候缩放一点没变，可位置得重新夹；原来只在缩放变了才夹，于是
    // 横杠要等人点下一个工具才回到该在的地方。夹一次只是读几个尺寸，不贵。
    if (this.state.phase === TOOLBAR_PHASE.EXPANDED) this._reflow();
  }

  /**
   * 横杠被外面挪了一下（缩放变了、菜单栏把它顶上去了）：重新摆它，也重新贴那
   * 张开着的卡片。
   *
   * 卡片是在打开的那一刻按横杠的位置摆的，之后就没人管它了。开着笔的卡片把底下
   * 的菜单栏拉上来，横杠被顶上去 86px，卡片留在原地——两样东西就这么分开了；拖
   * 分栏让横杠缩一圈，卡片和横杠之间的缝也跟着变宽。
   */
  _reflow() {
    // 停在顶上那一排里的，不按工作区的边摆，问那一排。
    if (this._perchedView()) { this._reflowPerch(); return; }
    // 上一次重画时工作区不在屏幕上，位置没摆（见 render）：先补摆，再夹。只夹不
    // 摆的话，夹的只是沿着边的那一个方向；贴哪条边的那 10px 没人写，一根从没在屏
    // 幕上摆过的横杠会落在工作区左上角。
    if (this._unplaced && this.state.phase === TOOLBAR_PHASE.EXPANDED
        && this.host?.clientWidth && this.host?.clientHeight) {
      this._unplaced = false;
      this._positionExpanded();
    }
    this._clampIntoHost();
    const card = this._liveCard();
    if (card && this.state.phase === TOOLBAR_PHASE.EXPANDED) this._anchorCard(card);
  }

  /**
   * 按记下的约束把横杠缩到合适的大小。改了就返回 true。
   *
   * 三条规矩，每一条都是被真机上的一次「跳一下」逼出来的：
   *
   *   **只在展开的时候算。** 原来收成球、拖着走的时候也算，量到的是那颗 48px
   *   的球，于是缩放被放回 1；点开之后横杠按满尺寸画出来，下一次换工具再量又缩
   *   回去——「缩小之后展开，换个工具，工具栏大小变了，跳一下」。
   *
   *   **竖着的跟高比，横着的跟宽比。** 原来一律拿长度去和高度比。贴在底边的那
   *   一条，长度是横着的，菜单栏一升起来可用高度少了 86px，它就被缩小了——而它
   *   要做的只是往上让，不是变短。
   *
   *   **同样的输入，同样的答案。** 原来是「量出来的长度 ÷ 当前缩放 = 满尺寸的
   *   长度」，可两头的内边距、三道分隔线不跟着缩，这个除法每算一次就偏一点，
   *   每换一次工具缩放就再挪一点。现在长度来自 _lengthModel，和当前缩放无关。
   */
  _applyFit() {
    const fit = this._fit;
    if (!fit || this.state.phase !== TOOLBAR_PHASE.EXPANDED) return false;
    // 停在顶上那一排里的，大小由那一排给多少地方定（_positionPerchedBar），不跟工作区的栏宽走。
    if (this._perchedView()) return false;
    const model = this._lengthModel();
    if (!model) return false;

    const vertical = this.state.edge === EDGES.LEFT || this.state.edge === EDGES.RIGHT;
    // 竖着的那一条能占的高度，是扣掉顶上分栏横杠、底下菜单栏之后剩下的；横着的
    // 那一条沿着整个工作区的宽度躺，菜单栏只会把它往上顶，不会让它变短。
    const along = vertical
      ? fit.height - this._safe.top - this._safe.bottom
      : (this.host?.clientWidth || 0);

    let scale = 1;
    if (along > 0) {
      // 24px of margin, so the bar never sits flush against either end.
      scale = Math.min(scale, (along - 24 - model.fixed) / model.perScale);
    }
    if (fit.column > 0) {
      // A column is comfortable for the full-size bar at about 420px; below
      // that the tools scale with it.
      scale = Math.min(scale, fit.column / 420);
    }

    scale = Math.min(1, Math.max(MIN_SCALE, scale));
    if (Math.abs(scale - this._scale) < 0.005) return false;
    this._scale = scale;
    this.root.style.setProperty('--ink-scale', String(scale));
    this.cardLayer.style.setProperty('--ink-scale', String(scale));
    return true;
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
    // 停在顶上那一排里的，不在工作区里，栏头挡不着它——除非那一排挤不下、它挂到了栏头
    // 下面，那时栏头变高它得跟着往下让。
    if (this._perchedView()) {
      if (this.root.classList.contains('is-perch-hanging')) this._reflowPerch();
      return;
    }
    // 收起成球的时候 _clampIntoHost 是直接返回的（球是靠两条边钉住的，往上面写
    // top 会把它拉长），所以球要走自己那条路重新摆一次。菜单栏升起来时球也在下
    // 角，一样会被盖住。
    if (this.state.phase === TOOLBAR_PHASE.DOCKED) {
      this._positionDocked();
      return;
    }
    // 竖着的那一条能占的高度跟着这两条带子变，所以先重新定大小，再摆位置。
    this._applyFit();
    this._reflow();
  }

  /**
   * 这条横杠沿着它自己那条边有多长：`fixed + perScale × 缩放`。
   *
   * Measured from the DOM rather than counted, so adding a tool or a swatch
   * cannot leave a stale number here — the arithmetic that produced 583px was
   * only correct for the toolbar as it stood the day it was written.
   *
   * 在满尺寸和最小尺寸各量一次，而不是「量一次再除以当前缩放」：两头的内边距、
   * 分隔线和描边不随缩放变，除法会把它们也算成会缩的，每算一次偏一点。两次测量
   * 把会缩的和不会缩的分开，结果和当前缩放无关，算多少遍都是同一个数。
   *
   * 结构（横竖、色板、语言）不变就不重量——量一次要强制两次排版。
   */
  _lengthModel() {
    const key = `${this._barSignature}|${typeof window !== 'undefined' ? window.innerHeight : 0}`;
    if (this._model && this._model.key === key) return this._model;
    const root = this.root;
    const vertical = this.state.edge === EDGES.LEFT || this.state.edge === EDGES.RIGHT;
    const read = () => (vertical ? root.offsetHeight : root.offsetWidth) || 0;
    // 量的时候不让任何尺寸过渡插进来：内边距正在从 0 往 5px 走的那一帧，量到的
    // 是一条还没长好的横杠。
    const instant = root.classList?.contains('is-instant');
    root.classList?.add('is-instant');
    root.style.setProperty('--ink-scale', '1');
    const full = read();
    root.style.setProperty('--ink-scale', String(MIN_SCALE));
    const small = read();
    root.style.setProperty('--ink-scale', String(this._scale));
    if (!instant) root.classList?.remove('is-instant');
    if (!full) return null;

    let perScale = (full - small) / (1 - MIN_SCALE);
    let fixed = full - perScale;
    // 量不出差别——没有排版的环境，或者真的什么都不随缩放变——就当整条都跟着
    // 缩。这是改之前的假设，也是最保守的答案。
    if (!(perScale > 0) || fixed < 0) {
      perScale = full;
      fixed = 0;
    }
    this._model = { key, fixed, perScale };
    return this._model;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render() {
    const { state } = this;
    // 停在顶上那一排里的那一条永远是横躺的，不管它在工作区里原来贴的是哪条边。
    const perchedView = this._perchedView();
    const orientation = perchedView ? ORIENTATION.HORIZONTAL : orientationOf(state);
    // 从球（或者拖在手里的那一颗）变回横杠的这一下：它的内边距要从 0 长到 5px，
    // 那段过渡不能让它跑——紧接着就要量它、摆它、定它的大小。
    const entering = state.phase === TOOLBAR_PHASE.EXPANDED
      && this._shownPhase !== TOOLBAR_PHASE.EXPANDED;
    this._shownPhase = state.phase;

    this.root.dataset.edge = state.edge;
    this.root.dataset.orientation = orientation;
    this.root.dataset.phase = state.phase;
    if (state.corner) this.root.dataset.corner = state.corner;
    else delete this.root.dataset.corner;
    this.root.classList.toggle('is-dragging', state.phase === TOOLBAR_PHASE.DRAGGING);
    this.root.classList.toggle('is-docked', state.phase === TOOLBAR_PHASE.DOCKED);
    this.root.classList.toggle('is-perched', perchedView);
    // 顶上那一排收着、它借住在左边：进出都由它自己演（_stepOffRow / _returnToRow），工作区
    // 补的那一段滑动别再挪它（pdf-workspace-ui.js 的 slideWorkspace）。
    this.root.classList.toggle('is-off-row', !!state.offRow);
    // 停在哪一处：切页时它朝着两个标签那边收（pdf.css），左右两处方向相反。
    if (perchedView) this.root.dataset.perch = state.perch;
    else delete this.root.dataset.perch;
    if (!perchedView) this._clearPerchStyles();

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

    // 工作区此刻不在屏幕上（切到设置页、在那里换了语言）：DOM 照样重搭，位置不
    // 动。_positionExpanded 会先写一个没夹过的百分比，而夹它的那一步量不到尺寸
    // 会直接返回——于是回到练习页时横杠停在那个百分比上（偏上一截），等人点一下
    // 工具重画一次才跳回去。位置留到工作区回到屏幕上、尺寸观察器叫 fitTo 时再摆。
    const placed = !!(this.host?.clientWidth && this.host?.clientHeight);
    if (placed && !perchedView) this._positionExpanded();
    // 没摆的这一次记下来，回到屏幕上时由 _reflow 补上。
    this._unplaced = !placed;
    if (entering) this._settleInstantly();

    // 只有结构变了才重搭：横竖、色板、语言。换工具、换颜色、拖粗细滑杆，变的
    // 只是哪一格亮着——原来每一下都把整条横杠连同每一个图标拆了重搭，而选中的
    // 那一格底下那片「镜片」带着一段 220ms 的入场动画，重搭一次就重播一次。拖滑
    // 杆的时候一秒钟重播几十次，就是「拖粗细的时候图标在闪」。
    const signature = `${orientation}|${state.swatches.join(',')}|${currentLang()}`;
    if (signature === this._barSignature && this.root.querySelector('.ink-tools')) {
      this._syncBar();
      if (placed) this._placeExpanded();
      if (this._keepCard) this._syncCard();
      else this._renderCard();
      return;
    }
    this._barSignature = signature;

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
    if (placed) {
      // 大小先定下来，再摆位置：摆位置要量它有多长。Placement was computed from
      // the PREVIOUS contents, so the bar's real size is only known now. Clamp
      // once it exists. 停在顶上那一排里的，按那一排摆（_placeExpanded 分开两条路）。
      this._placeExpanded();
    }
    // 卡片：要么重建，要么就地刷一遍。两条路都得有人走——见 _syncCard。
    if (this._keepCard) this._syncCard();
    else this._renderCard();
  }

  /**
   * 横杠不重搭，只把「选中的是哪一个」刷一遍。和 _syncCard 是同一个道理。
   *
   * 新选中的那一格加上 is-selected，它的镜片是新长出来的，入场动画照常播一次；
   * 没换的那一格什么都不动，也就没有东西可重播。
   */
  _syncBar() {
    const { state } = this;
    for (const button of this.root.querySelectorAll('[data-tool]')) {
      const on = button.dataset.tool === state.tool;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-pressed', String(on));
    }
    for (const button of this.root.querySelectorAll('.ink-swatches [data-swatch]')) {
      const on = sameColor(button.dataset.swatch, state.color);
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  /**
   * 这一下和下一帧不跑尺寸过渡。
   *
   * 从球展开、拖完落到边上、让开之后还回来——三条路都是「内边距从 0 长到
   * 5px」，原来只有前两条记得关掉过渡，拖完落边那一条没有：落下那一刻量到的是
   * 一条短了 10px 的横杠，夹到边上时位置差 5px，下一次换工具重新量，它就挪一下。
   */
  _settleInstantly() {
    const root = this.root;
    root.classList.add('is-instant');
    if (typeof requestAnimationFrame !== 'function') return;
    if (this._instantFrame) cancelAnimationFrame(this._instantFrame);
    // 两帧：第一帧样式才生效，第二帧再放开过渡，中间没有一帧是在「长」。
    this._instantFrame = requestAnimationFrame(() => {
      this._instantFrame = requestAnimationFrame(() => {
        this._instantFrame = 0;
        root.classList.remove('is-instant');
      });
    });
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
      this._barSignature = null;
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
    // 停在顶上那一排里的那颗球：塞在那处空当里，不在工作区的角上。
    if (this._perchedView()) { this._positionPerchedBall(); return; }
    const s = this.root.style;
    s.position = '';
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
    // 停在顶上那一排里的，不在工作区上，压不着哪块面板。
    if (this.state.perch) return;
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
    // 它原本停着的地方，相对工作区记下来。还位之前要问的是「回到这儿会不会又被
    // 哪块面板压住」——而不是「屏幕上还有没有面板开着」。
    const home = this.rect();
    const base = this.host?.getBoundingClientRect?.();
    this._home = home && base && home.width
      ? { left: home.left - base.left, top: home.top - base.top, width: home.width, height: home.height }
      : null;

    let landed = false;
    for (const corner of candidates) {
      this._set(yieldToCorner(this.state, corner), { pushTools: false });
      landed = true;
      if (!avoid || !overlaps(this.rect(), avoid)) break;
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
    // 缩放是写在横杠行内的变量，上面那一句整个换掉了行内样式：不补回去，替身里的按钮按满尺寸
    // 画，挤在一条按缩放后的大小量出来的盒子里。
    const scale = this.root.style.getPropertyValue('--ink-scale');
    if (scale) clone.style.setProperty('--ink-scale', scale);
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

  /**
   * 让开之前它停在哪儿，屏幕坐标；没让开或者没记下来就是 null。
   *
   * 记的是相对工作区的位置，取的时候再加上工作区此刻在哪——分栏线怎么拖都不
   * 挪它（横杠挂在工作区的边上，不在哪一栏里）。
   */
  homeRect() {
    if (!isYielded(this.state) || !this._home) return null;
    const base = this.host?.getBoundingClientRect?.();
    if (!base) return null;
    const left = base.left + this._home.left;
    const top = base.top + this._home.top;
    return {
      left, top, width: this._home.width, height: this._home.height,
      right: left + this._home.width, bottom: top + this._home.height, x: left, y: top,
    };
  }

  /** Hands back the placement a `yieldTo` borrowed, unfolding on the way. */
  restoreFromYield() {
    if (!isYielded(this.state)) return;
    this._home = null;
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
    // 停在顶上那一排里点开着的：收回那一排里的那颗球，不飞到工作区的角上去。
    if (this.state.perch) { this._foldPerch(); return; }

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
    const bar = this.rect();
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
    this._home = null;
    // 人亲手拿起来了：之后它落在哪儿是人定的，专注模式结束也不再把它送回那一排。
    this._perchMemo = null;
    // 收起 / 拉回那几段还没演完的也作罢：它现在在人手里。
    this._cancelRowMoves();
    const host = this._perchHost;
    const side = this.state.perch || null;
    if (side) {
      this._perchAnimating = false;
      this._clearPerchStyles();
    }
    // 拿起来之后，球和被它推着的标签都归顶上那一排那一层摆（top-row-dock.js 的
    // beginDrag）：在那一排附近，球贴着那一排走、碰上标签就推着它走；离开了就跟着手
    // 指——两样由同一个数算出来，才不会一个先到一个后到。从那一排里拿起来的，接着往原来
    // 那一侧推（点开着的那一条拿起来时，标签从横杠推到的地方滑回球推到的地方）。
    // 没有那一排（测试、没给）就照旧：标签回家，球自己跟着手指。
    this._rowDrag = host?.beginDrag?.(this.root, { side }) || null;
    if (!this._rowDrag && side) {
      host?.release?.({ animate: this.state.phase === TOOLBAR_PHASE.EXPANDED });
    }
    const base = this.host?.getBoundingClientRect?.() || { left: 0, top: 0 };
    const cx = (base.left || 0) + point.x;
    const cy = (base.top || 0) + point.y;
    // A puck is already the shape it would fold into. Taking a picture of one
    // circle to shrink it into another circle is motion that says nothing.
    if (isDocked(this.state)) {
      // 停着的那颗球从原地滑到手指底下，不是一下子跳过去。
      const from = this.root.getBoundingClientRect();
      this._set(startDrag(this.state, point), { pushTools: false });
      this._rowDrag?.start(cx, cy, from);
      return;
    }
    this._clearGhosts();
    const from = this.root.getBoundingClientRect();
    const ghost = this._ghost(from);
    this._set(startDrag(this.state, point), { pushTools: false });
    this._rowDrag?.start(cx, cy);
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

  /**
   * Where the bar is on screen, for callers deciding whether it is in the way.
   *
   * **停稳之后的位置，不是这一帧画在哪儿。** getBoundingClientRect 把正在播的
   * 动画也算进去：从球展开、拖完落边，横杠头几百毫秒是从球的位置、按球的大小
   * 飞过来的。拿那一帧去判「底下的菜单栏挡没挡住它」，判的是那颗球——球不挡，
   * 于是横杠落在菜单栏上；等下一次换工具再判，这回判的是整条横杠，它就被顶上去
   * 80px、再缩一圈。那就是「和菜单栏打过交道之后，换个工具就跳一下」。
   *
   * 这里用 offsetLeft/offsetTop（不含任何 transform），再把定位本身带的那半个
   * 自身长度补回去——那是它停着时的样子，不是飞行中的样子。
   */
  rect() {
    const el = this.root;
    const parent = el.offsetParent;
    if (!parent || parent !== this.host || typeof parent.getBoundingClientRect !== 'function') {
      return el.getBoundingClientRect();
    }
    const base = parent.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = base.left + (parent.clientLeft || 0) + el.offsetLeft;
    let top = base.top + (parent.clientTop || 0) + el.offsetTop;
    const { phase, edge } = this.state;
    if (phase === TOOLBAR_PHASE.DRAGGING) {
      left -= width / 2;
      top -= height / 2;
    } else if (phase === TOOLBAR_PHASE.EXPANDED) {
      if (edge === EDGES.LEFT || edge === EDGES.RIGHT) top -= height / 2;
      else left -= width / 2;
    }
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }

  /** Puck → bar, unfolding out of the corner it was parked in. */
  _undock() {
    if (!isDocked(this.state)) return;
    // 停在顶上那一排里的那颗球：就地长开，把两边挤开（见 _openPerch）。
    if (this.state.perch && this._perchHost?.available?.()) { this._openPerch(); return; }
    // 正在让位时被点开：是人要它回来，哪怕那块面板还开着。告诉工作区一声，好让
    // 这几块已经开着的面板不再把它赶回角上——赶回去等于不让人用它。
    const reclaimed = isYielded(this.state);
    this._home = null;
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
    if (reclaimed) this.handlers.onReclaim?.();
    this._absorb(from, false);
    requestAnimationFrame(() => {
      this.root.classList.remove('is-instant');
      this._clampIntoHost();
    });
  }

  // ── 顶上那一排 ──────────────────────────────────────────────────────────────

  /**
   * 页面那一层的「顶上那一排」（src/pdf/top-row-dock.js）。
   *
   * 给了它，工具栏就能拖进那一排里停着：收成一颗球塞在两枚胶囊之间的空当里，点开
   * 就整条横躺在那一排里，把两边挤开。没给（测试、没有那一排的地方）就当那一排不存
   * 在，一切照旧。那一排在哪、有多宽、怎么挤，都问它；工具栏自己只管里面装什么。
   */
  setPerchHost(host) {
    this._offPerch?.();
    this._perchHost = host || null;
    this._offPerch = host?.onChange?.((info) => this._onPerchChange(info)) || null;
    this._liftOffTopEdge();
    // 开机时那一排就是收着的（上次收起来之后关的）：停在那一排里的直接借住到左边，不演。
    if (this.state.perch && host?.away?.()) { this._stepOffRow({ animate: false }); return; }
    this.render();
  }

  /**
   * 工具栏原来能横着贴在工作区顶边——两栏栏头底下那一条。那个位置现在归顶上那一排：
   * 「工具栏不该停在文件栏顶上展开，靠近顶上就吸进那一排的空当里」。还停在那儿的（老
   * 的存档、放下它的时候那一排正收着），那一排一接得住，就挪进去收成一颗球，停在它原
   * 来那一段的正上方。
   */
  _liftOffTopEdge() {
    const { state } = this;
    const host = this._perchHost;
    if (!host?.spotFor || state.perch || state.corner || state.yielded) return;
    if (state.phase !== TOOLBAR_PHASE.EXPANDED || state.edge !== EDGES.TOP) return;
    const base = this.host?.getBoundingClientRect?.();
    if (!base?.width) return;
    const spot = host.spotFor(base.left + state.offset * base.width);
    if (spot) this._set(perchAt(state, spot.perch, spot.at), { pushTools: false });
  }

  /** 此刻是按「停在顶上那一排里」来画的吗（拖在手里的时候不是）。 */
  _perchedView() {
    return !!this.state.perch && !!this._perchHost && this.state.phase !== TOOLBAR_PHASE.DRAGGING;
  }

  /** 停在那一排里、而且点开着。 */
  _isPerchedOpen() {
    return this._perchedView() && this.state.phase === TOOLBAR_PHASE.EXPANDED;
  }

  _clearPerchStyles() {
    const s = this.root.style;
    s.clipPath = '';
    s.removeProperty('--perch-reveal');
    this.root.classList.remove('is-perch-animating', 'is-perch-hanging');
  }

  /**
   * 横躺着的这一条有多宽、多高：「不随缩放变的 + 随缩放变的 × 缩放」，宽高各一份。
   * 和 _lengthModel 同一个量法（满尺寸、最小尺寸各量一次）；结构不变就不重量。
   */
  _perchModel() {
    const key = `${this._barSignature}|perch`;
    if (this._pmodel && this._pmodel.key === key) return this._pmodel;
    const root = this.root;
    const instant = root.classList.contains('is-instant');
    root.classList.add('is-instant');
    const read = () => ({ w: root.offsetWidth || 0, h: root.offsetHeight || 0 });
    root.style.setProperty('--ink-scale', '1');
    const full = read();
    root.style.setProperty('--ink-scale', String(PERCH_MIN_SCALE));
    const small = read();
    root.style.setProperty('--ink-scale', String(this._scale));
    if (!instant) root.classList.remove('is-instant');
    if (!full.w || !full.h) return null;
    const span = 1 - PERCH_MIN_SCALE;
    let wPer = (full.w - small.w) / span;
    let hPer = (full.h - small.h) / span;
    let wFixed = full.w - wPer;
    let hFixed = full.h - hPer;
    if (!(wPer > 0) || wFixed < 0) { wPer = full.w; wFixed = 0; }
    if (!(hPer > 0) || hFixed < 0) { hPer = full.h; hFixed = 0; }
    this._pmodel = { key, wFixed, wPer, hFixed, hPer };
    return this._pmodel;
  }

  /** 收着的那颗球：塞在那处空当的正中。 */
  _positionPerchedBall() {
    const box = this._perchHost?.ballBox?.(this.state.perch, undefined, this.state.perchX);
    if (!box) { this._unplacedPerch = true; return; }
    this._unplacedPerch = false;
    const s = this.root.style;
    s.position = 'fixed';
    s.right = s.bottom = '';
    s.transform = '';
    s.left = `${box.left}px`;
    s.top = `${box.top}px`;
    this._perchLayout = null;
    // 状态字别伸到球底下；标签在家。
    this._perchHost.settle?.(this.state.perch, { left: box.left, right: box.right });
  }

  /** 点开的那一条：摆在这一排里（这一排挤不下时挂在它下面），缩放按给得出的地方定。 */
  _positionPerchedBar() {
    const host = this._perchHost;
    const s = this.root.style;
    s.position = 'fixed';
    s.right = s.bottom = '';
    s.transform = '';
    const model = this._perchModel();
    const layout = model
      ? host?.layout?.(this.state.perch, model, { minScale: PERCH_MIN_SCALE, at: this.state.perchX })
      : null;
    if (!layout) { this._unplacedPerch = true; this._perchLayout = null; return null; }
    this._unplacedPerch = false;
    if (!layout.inRow) this._hangBelowHeaders(layout, model);
    this._scale = layout.scale;
    this.root.style.setProperty('--ink-scale', String(layout.scale));
    this.cardLayer.style.setProperty('--ink-scale', String(layout.scale));
    s.left = `${layout.left}px`;
    s.top = `${layout.top}px`;
    this.root.classList.toggle('is-perch-hanging', !layout.inRow);
    this._perchLayout = layout;
    // 正在演点开 / 收起的时候，邻居由那一段逐帧摆，这里不插手。
    if (!this._perchAnimating) {
      host.settle?.(this.state.perch, layout.inRow
        ? { left: layout.left, right: layout.left + layout.width }
        : null);
    }
    return layout;
  }

  /**
   * 那一排挤不下（竖着拿、分屏）：点开的那一条挂到工作区顶上、栏头下面——和平时贴
   * 在顶边的那一条同一个位置，栏头上的按钮不许被它盖住（_safe.top 就是那几条栏头有
   * 多高）。宽度按工作区给，以球为中心，别出工作区。原地改 layout。
   */
  _hangBelowHeaders(layout, model) {
    const host = this.host?.getBoundingClientRect?.();
    if (!host || !host.width) return;
    const M = 8;
    const room = host.width - M * 2;
    const widthAt = (k) => model.wFixed + model.wPer * k;
    const fitScale = (room - model.wFixed) / (model.wPer || 1);
    const scale = Math.max(MIN_SCALE, Math.min(layout.scale, fitScale, 1));
    const width = Math.min(widthAt(scale), room);
    const center = layout.left + layout.width / 2;
    layout.scale = scale;
    layout.width = width;
    layout.height = model.hFixed + model.hPer * scale;
    layout.left = Math.min(Math.max(center - width / 2, host.left + M), host.right - M - width);
    layout.top = host.top + this._safe.top + M;
  }

  /** 展开着的那一条摆到位：停在顶上那一排里的问那一排，别的照工作区的边夹。 */
  _placeExpanded() {
    if (this._perchedView()) { this._positionPerchedBar(); return; }
    this._applyFit();
    this._clampIntoHost();
  }

  /** 那一排变了（窗口、语言、那几枚胶囊的宽度）：原地重摆，不演。 */
  _reflowPerch() {
    if (!this._perchedView()) return;
    if (this.state.phase === TOOLBAR_PHASE.DOCKED) this._positionPerchedBall();
    else if (!this._perchAnimating) this._positionPerchedBar();
    const card = this._liveCard();
    if (card && this.state.phase === TOOLBAR_PHASE.EXPANDED) this._anchorCard(card);
  }

  /**
   * 点开停在这一排里的那颗球：整条从球那儿往两边长开，碰上邻居才推，推着走。
   *
   * `replay`：本来就是点开的（书架关了、从设置页回来），把「长开」再演一遍——横杠
   * 刚才整个看不见，一下子整条出现、标签一下子跳开，不如从球那儿长出来。
   */
  _openPerch({ replay = false } = {}) {
    const host = this._perchHost;
    if (!host) return;
    // 从球那儿长：球此刻在哪就从哪儿长；量不到（它刚才整个看不见）就按球该在的位置。
    const ball = host.ballBox?.(this.state.perch, undefined, this.state.perchX) || null;
    const measured = replay ? null : this.root.getBoundingClientRect();
    const from = measured?.width ? measured : ball;
    this._perchAnimating = true;
    // 整段都不许尺寸过渡：从球变回横杠，内边距要从 0 长到 5px，那一段要是跑起来，
    // 横杠在这 0.2 秒里比量出来的窄一截，露出来那一截的边和它自己的边就对不上了。
    // 演完再放开（onDone）。
    const settle = () => this.root.classList.remove('is-instant');
    this.root.classList.add('is-instant');
    if (!replay) this._set(undock(this.state), { pushTools: false });
    else this._positionPerchedBar();
    const layout = this._perchLayout;
    if (!layout || !from?.width) {
      this._perchAnimating = false;
      settle();
      this._reflowPerch();
      return;
    }
    if (!layout.inRow) {
      // 这一排挤不下，挂在它下面：不推谁，从球那儿展开就是。
      this._perchAnimating = false;
      host.settle?.(this.state.perch, null);
      this._absorb(from, false, UNFOLD_MS);
      settle();
      return;
    }
    const box = {
      left: layout.left, top: layout.top, width: layout.width, height: layout.height,
      right: layout.left + layout.width, bottom: layout.top + layout.height,
    };
    host.play({
      perch: this.state.perch,
      root: this.root,
      box,
      from: { left: from.left, right: from.left + from.width },
      to: { left: box.left, right: box.right },
      fromHeight: from.height,
      toHeight: box.height,
      duration: PERCH_OPEN_MS,
      opening: true,
      onDone: () => { this._perchAnimating = false; settle(); },
    });
  }

  /**
   * 点开的那一条收回那颗球：两条边往球那儿收，被推开的标签跟着那条边回家。
   *
   * 状态演完才改：演的这一段里横杠还得是横杠（它要被一截一截地收起来），改早了，
   * 下一次重画就把它换成球了。
   */
  _foldPerch() {
    if (!this._isPerchedOpen()) return;
    const host = this._perchHost;
    if (this.state.openCard !== CARDS.NONE) this._set(closeCard(this.state), { pushTools: false });
    const layout = this._perchLayout;
    const ball = host?.ballBox?.(this.state.perch, undefined, this.state.perchX);
    const finish = () => {
      this._perchAnimating = false;
      this._clearPerchStyles();
      // 变回球的那一下内边距不过渡：过渡的话，球会在它的位置上往里挪 5px 再停住。
      this.root.classList.add('is-instant');
      this._set(foldToPerch(this.state), { pushTools: false });
      const loosen = () => this.root.classList.remove('is-instant');
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(loosen); else loosen();
    };
    if (!layout || !ball) { finish(); return; }
    if (!layout.inRow) {
      // 挂在下面的那一条：和收进角上一样，整条缩回那颗球。
      this._clearGhosts();
      const from = this.root.getBoundingClientRect();
      const ghost = this._ghost(from);
      finish();
      this._playFold(ghost, from, this.root.getBoundingClientRect());
      return;
    }
    this._perchAnimating = true;
    host.play({
      perch: this.state.perch,
      root: this.root,
      box: {
        left: layout.left, top: layout.top, width: layout.width, height: layout.height,
        right: layout.left + layout.width, bottom: layout.top + layout.height,
      },
      from: { left: layout.left, right: layout.left + layout.width },
      to: { left: ball.left, right: ball.right },
      fromHeight: layout.height,
      toHeight: ball.height,
      duration: PERCH_CLOSE_MS,
      opening: false,
      onDone: finish,
    });
  }

  /**
   * 那一排说它变了。
   *
   *   · 专注模式把那一排收掉了：请到工作区右上角，记下是从哪一处来的；
   *   · 专注结束、它还原样待在那个角上：回原处去；
   *   · 书架关了、从设置页回来（shown）：点开着的那一条从球那儿再长开一次；
   *   · 别的（尺寸、语言）：原地重摆。
   */
  _onPerchChange(info = {}) {
    const host = this._perchHost;
    if (!host || this._destroyed) return;
    const { state } = this;
    if (state.phase === TOOLBAR_PHASE.DRAGGING) return;

    // 顶上那一排往上收起来了：停在里面的跟着它走掉，从左边出来；拉回来时回原处。
    if (info.away === true && state.perch) { this._stepOffRow(); return; }
    if (info.away === false && state.offRow) { this._returnToRow(); return; }

    const focus = typeof document !== 'undefined'
      && !!document.body?.classList.contains('is-scratch-focus');

    if (state.perch && focus) {
      this._perchMemo = { perch: state.perch, perchX: state.perchX };
      this._perchAnimating = false;
      this._clearPerchStyles();
      host.release?.({ animate: false });
      this._set(leavePerch(state, CORNERS.TOP_RIGHT), { pushTools: false });
      return;
    }
    if (!state.perch && this._perchMemo && !focus && host.available?.()) {
      const memo = this._perchMemo;
      this._perchMemo = null;
      if (state.phase === TOOLBAR_PHASE.DOCKED && state.corner === CORNERS.TOP_RIGHT) {
        this._set(perchAt(state, memo.perch, memo.perchX), { pushTools: false });
      }
      return;
    }
    if (!state.perch) {
      this._liftOffTopEdge();
      return;
    }
    if (info.shown === true && state.phase === TOOLBAR_PHASE.EXPANDED) {
      this._openPerch({ replay: true });
      return;
    }
    if (info.shown === false) return;
    this._reflowPerch();
  }

  /**
   * 顶上那一排往上收起来了：停在里面的工具栏借住到工作区左边（stepOffRow）。
   *
   * 人说「工具栏位于上方时，如果收起上方菜单栏，则工具栏会从左边重新出现，记得做动画和适配」。
   * 原来它跟着那一排往上滑、淡到看不见，那一排收着的时候就一直找不到它。
   *
   * 两段动画，一先一后：
   *   · 走：它此刻在那一排里画着的样子留一张替身，跟着那一排接着往上走、淡掉——同一段时间、
   *     同一条曲线，从那一排此刻走到的地方接着走（跟手拉到一半松开也对得上）；
   *   · 来：真的那一个已经摆在左边，等替身走完，从工作区左边外面滑进来。拉到头才松手的，它早
   *     就跟着那一排淡没了，没有替身，只隔一小口气就来。
   *
   * 适配：点开着的那一条贴左边竖着，大小和位置走平时贴边的那一套（_placeExpanded：按工作区的
   * 高度、那一栏的宽度缩放，不盖栏头，整条夹在工作区里）；收着的是左上角那颗球（栏头底下）。
   *
   * @param {{animate?: boolean}} [opts] 开机时那一排本来就收着：不演，直接摆好。
   */
  _stepOffRow({ animate = true } = {}) {
    const host = this._perchHost;
    const { state } = this;
    if (!state.perch) return;
    const moving = animate && !prefersReducedMotion() && typeof this.root.animate === 'function';
    this._clearGhosts();
    this._cancelRowMoves();
    const from = moving ? this.root.getBoundingClientRect() : null;
    const opacity = moving ? Number(getComputedStyle(this.root).opacity) : 0;
    // 已经跟着那一排淡没了（拉到头才松手）：没有什么可接着演的。
    const ghost = moving && opacity > 0.02 ? this._ghost(from) : null;
    const progress = host?.progress?.() ?? 1;
    const travel = host?.travel?.() || from?.bottom || 0;
    // 那一排里正在演的点开 / 收起就此打住；被推开的标签回家——它这时候正跟着那一排往上走。
    this._perchAnimating = false;
    this._clearPerchStyles();
    host?.release?.({ animate: moving });
    this._set(stepOffRow(state), { pushTools: false });
    if (ghost) {
      ghost.style.opacity = String(opacity);
      ghost.style.transition = 'none';
      const rest = Math.max(0, travel * (1 - progress)) + 4;
      const up = ghost.animate(
        [{ translate: '0 0', opacity }, { translate: `0 ${-rest}px`, opacity: 0 }],
        { duration: ROW_MS, easing: ROW_EASE, fill: 'forwards' },
      );
      const drop = () => ghost.remove();
      if (up.finished) up.finished.then(drop, drop); else up.onfinish = drop;
    }
    if (moving) this._enterFromLeft({ delay: ghost ? ROW_MS : OFF_ROW_ENTER_GAP });
  }

  /** 收起 / 拉回那几段还没演完的（滑进来、等着出现、等着长开）：就此作罢。 */
  _cancelRowMoves() {
    if (this._reopenTimer) clearTimeout(this._reopenTimer);
    this._reopenTimer = 0;
    this._appear?.cancel();
    this._appear = null;
    this._slideIn?.cancel();
    this._slideIn = null;
  }

  /**
   * 从工作区左边外面滑进来：借住到左边的那一下。它已经摆在终点（_stepOffRow 里的 _set），这里
   * 只演路上那一段——用单独的 translate，不碰 transform：贴边那一条平时靠 translateY(-50%) 放自己。
   * 起步前那一段（delay：等走的那一个走完）停在外面（fill: backwards），不先在终点闪一下。
   * 工作区是裁边的，看上去就是从它左边那条边里滑出来。
   */
  _enterFromLeft({ delay = OFF_ROW_ENTER_GAP } = {}) {
    const el = this.root;
    const to = el.getBoundingClientRect();
    const base = this.host?.getBoundingClientRect?.();
    if (!to.width || !base) return;
    const dx = -(to.right - base.left + 12);
    const anim = el.animate(
      [{ translate: `${dx}px 0` }, { translate: '0 0' }],
      { duration: OFF_ROW_ENTER_MS, delay, easing: ROW_EASE, fill: 'backwards' },
    );
    this._slideIn = anim;
    const clear = () => { if (this._slideIn === anim) this._slideIn = null; };
    if (anim.finished) anim.finished.then(clear, clear); else anim.onfinish = clear;
  }

  /**
   * 顶上那一排拉回来了：借住在左边的回那一排里原来的地方（backToRow）。
   *
   * 一先一后（人说「向下拉时，工具栏还没完全退出，顶部的就加载出来了」）：
   *   · 先走：左边那一个留一张替身，往左滑出去；
   *   · 走完再来：收着的，那一排里的球在原处长出来；点开着的，先按收着的球摆回去（看不见），
   *     等左边那一条走完，再从球那儿长开、把两边挤开——和点那颗球时一样（_openPerch）。
   *   · 甩下来就松手、那一排还在往下落的：它看不见地跟着那一排一起落，出来的时候正好在那一排里。
   *
   * 人中间亲手拖过它的话，offRow 已经清了，这里不会被叫到：它在哪儿是人定的。
   */
  _returnToRow({ animate = true } = {}) {
    const host = this._perchHost;
    const { state } = this;
    // 改排版之前记下的那一份（rowWillMove）：只认这一次的。
    const before = this._beforeRowMove;
    this._beforeRowMove = null;
    if (!state.offRow || !host?.available?.()) return;
    const moving = animate && !prefersReducedMotion() && typeof this.root.animate === 'function';
    this._clearGhosts();
    this._cancelRowMoves();
    const expanded = state.phase === TOOLBAR_PHASE.EXPANDED;
    const back = backToRow(state);
    // 从左边那一条（或那颗球）变回那一排里的样子：位置、内边距、圆角一下子到位，不许哪一段
    // 过渡插进来——路上那一段由下面的动画演。
    this.root.classList.add('is-instant');
    if (!moving) {
      this._set(back, { pushTools: false });
      if (expanded) this._openPerch({ replay: true });
      else this._settleInstantly();
      return;
    }

    // 替身从人眼里它原来的样子出发：这一刻排版已经改了——工作区往下让出那一排、变矮了，左边
    // 这一个已经被挪下去、缩了一圈（平板上量到 54×624 在 96 → 50×570 在 150）。
    const from = before?.rect || this.root.getBoundingClientRect();
    const ghost = this._ghost(from);
    if (ghost && before?.scale) ghost.style.setProperty('--ink-scale', before.scale);
    const progress = host.progress?.() ?? 0;
    const travel = host.travel?.() || 0;

    // 点开着的先按收着的球摆回去：直接按点开的样子摆，它会在左边那一条还没走的时候就在顶上长开。
    this._set(expanded ? foldToPerch(back) : back, { pushTools: false });
    this._settleInstantly();
    if (ghost) {
      ghost.style.transition = 'none';
      const out = ghost.animate(
        [{ translate: '0 0' }, { translate: `${-(from.right + 16)}px 0` }],
        { duration: OFF_ROW_LEAVE_MS, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
      );
      const drop = () => ghost.remove();
      if (out.finished) out.finished.then(drop, drop); else out.onfinish = drop;
    }
    // 左边那一个走完才出来。
    const wait = ghost ? OFF_ROW_LEAVE_MS : OFF_ROW_ENTER_GAP;
    if (progress > 0.05 && travel > 0) {
      // 那一排还在往下落（甩下来就松手）：看不见地跟着它一起落，出来的时候正好在那一排里。
      this.root.animate(
        [{ translate: `0 ${-travel * progress}px` }, { translate: '0 0' }],
        { duration: ROW_MS, easing: ROW_EASE },
      );
    }
    if (!expanded) {
      // 球在原处长出来，不是一下子冒出来。
      this._appear = this.root.animate(
        [{ opacity: 0, scale: '0.6' }, { opacity: 1, scale: '1' }],
        { duration: OFF_ROW_POP_MS, delay: wait, easing: ROW_EASE, fill: 'backwards' },
      );
      return;
    }
    // 点开着的：球先藏着，左边那一条走完，从球那儿长开。
    this._appear = this.root.animate([{ opacity: 0 }, { opacity: 0 }], { duration: wait + 40 });
    this._reopenTimer = setTimeout(() => {
      this._reopenTimer = 0;
      this._appear?.cancel();
      this._appear = null;
      const now = this.state;
      // 这中间人点过它、拖走了它，或者那一排又收起来了：不替人长开。
      if (this._destroyed || now.phase !== TOOLBAR_PHASE.DOCKED || now.perch !== back.perch) return;
      if (!host.available?.() || host.away?.()) return;
      this._openPerch();
    }, wait);
  }

  /**
   * 顶上那一排马上要收起 / 拉回（pdf-workspace-ui.js 的 setHidden 在改排版之前叫这一声）。
   *
   * 借住在左边、马上要回那一排的这一个，先记下它此刻画在哪、按多大缩放画的：排版一改，工作区
   * 往下让出那一排、变矮，它会先被挪下去、缩一圈，再由 _returnToRow 送回那一排——替身得从改
   * 之前的样子出发，不然人看到的是它先往下一跳、一缩，再往左出去。
   *
   * @param {boolean} hidden 那一排要去的样子：true 收起，false 拉回
   */
  rowWillMove(hidden) {
    this._beforeRowMove = !hidden && this.state.offRow
      ? {
        rect: this.root.getBoundingClientRect(),
        scale: this.root.style.getPropertyValue('--ink-scale'),
      }
      : null;
  }

  _positionExpanded() {
    const { edge, offset } = this.state;
    const s = this.root.style;
    s.position = '';
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
    if (this._perchedView()) return;
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

  /**
   * 拖在手里那颗球：跟着笔，用视口坐标（fixed）。
   *
   * 原来是按工作区摆的（absolute），而工作区是 overflow: hidden 的——球一拖出工作区
   * 就被切掉。以前拖出去没有意义，现在上面那一排也能停，球得看得见地飞到那儿去。
   * 状态里记的还是相对工作区的点（落在哪条边、哪个角照旧按工作区算），这里只在画
   * 的时候换成视口坐标。
   */
  _positionToken() {
    const point = this.state.dragPoint;
    if (!point) return;
    const s = this.root.style;
    s.position = 'fixed';
    s.right = s.bottom = '';
    s.transform = 'translate(-50%, -50%)';
    // 拖动那一路已经接手了：球在哪儿由它摆（在顶上那一排附近要贴着那一排走）。
    if (this._rowDrag?.live) return;
    const base = this.host?.getBoundingClientRect?.() || { left: 0, top: 0 };
    s.left = `${(base.left || 0) + point.x}px`;
    s.top = `${(base.top || 0) + point.y}px`;
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
      // 另一根手指正在工具上划着挑：这一下不是来拿横杠的，拿起来会把它正划着的那一排换成球。
      if (this._scrub?.started) return;
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
      // 顶上那一排里点开着的那一条，把手也是「点一下收起、拖动才是拿起来」——和
      // 那颗球一样，先等着看这一下是点还是拖。
      this._drag.fromDocked = isDocked(this.state) || this._isPerchedOpen();
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

      // 球跟着笔走，就这一件事。原来每一帧都要写一次 localStorage、再让工作区
      // 量一遍安全区和缩放——量的还是这颗球。
      this._set(moveDrag(this.state, point), { pushTools: false, persist: false, quiet: true });

      // 顶上那一排附近：球被那一排接住，贴着它走、碰上标签就推着标签走——球自己就是
      // 「松手会停在这儿」的预告，不用再另亮一圈虚影。
      this._rowDrag?.move(e.clientX, e.clientY);
      const inRow = !!this._rowDrag?.inRow;

      // Magnetism has to be visible before the finger lifts, or it is just a
      // surprise on release. Inside a corner zone the token swells and its cast
      // deepens — the language of something being pulled toward a magnet.
      //
      // 上面那两个角不算：松在那儿，球是进顶上那一排的（那一排接得住的时候）。
      const rect = this.host.getBoundingClientRect();
      const corner = inRow ? null : cornerOf(point, { width: rect.width, height: rect.height });
      const toRow = !!corner && corner.startsWith('top') && !!this._perchHost?.spotFor?.(e.clientX);
      this.root.classList.toggle('is-corner-armed', !!corner && !toRow);
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
        // 顶上那一排里点开着的那一条：点一下把手就收回那颗球。
        if (fromDocked && this._isPerchedOpen()) {
          this._foldPerch();
          return;
        }
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

      // 松在顶上那一排里：收成球，就停在松手的那个地方（标签被推到哪儿就在哪儿）。
      const landing = this._rowDrag?.end() || null;
      this._rowDrag = null;
      this._perchHost?.preview?.(null);
      this.root.classList.remove('is-corner-armed');
      if (landing) {
        this._set(endDrag(this.state, point, viewport, { perch: landing.perch, perchX: landing.at }),
          { pushTools: false });
        this._absorb(from, false, PERCH_LAND_MS);
        return;
      }
      // 松在离顶上近的地方（会贴上工作区顶边、或者进上面那两个角）：不在栏头底下横着展开，
      // 飞进顶上那一排，停在正上方。
      const aim = nearestEdge(point, viewport);
      const topward = aim.edge === EDGES.TOP || (aim.corner && aim.offset === 0);
      const spot = topward ? this._perchHost?.spotFor?.((rect.left || 0) + point.x) : null;
      if (spot) {
        this._set(endDrag(this.state, point, viewport, { perch: spot.perch, perchX: spot.at }),
          { pushTools: false });
        this._absorb(from, false, PERCH_LAND_MS);
        return;
      }
      this._set(endDrag(this.state, point, viewport), { pushTools: false });
      this._absorb(from, corner);
    };

    // The puck is a button, so it answers the keys a button answers.
    this._onKeyDown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      // 顶上那一排里点开着的那一条：在把手上按确定，收回那颗球——和点一下一样。
      if (this._isPerchedOpen() && e.target?.closest?.('[data-role="handle"]')) {
        e.preventDefault();
        this._foldPerch();
        return;
      }
      if (!isDocked(this.state)) return;
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
   * 工具、颜色：点和划都行。
   *
   * 人说「工具栏也要支持滑动」（顶上左边那枚胶囊的划动同时拆了，见 liquid-glass.js），又说「工具栏
   * 滑动时记得做玻璃折射」。按住一支笔顺着横杠划过去，手指底下浮起一块玻璃，跟着手指走，把底下
   * 的图标弯过去；松手就拿那一支——和点它一样，只是不用一格一格地点。颜色那一排一样。
   *
   *   · 点：什么都不插手，按钮自己的 click 照常到（再点一下选中的那支，照旧开它的卡片）。
   *   · 顺着横杠划（横躺的左右、竖着的上下）：过了 SCRUB_START 才算。那块玻璃从选中那一格浮起来、
   *     追到手指底下（SCRUB_CATCH_MS），之后直接跟手；选中那一格的镜片和蓝色让给它，底下那一格
   *     变蓝。竖着的那一条工具多到要滚的时候，划到头上 / 底下它自己往那边滚。
   *   · 松手：落在哪一格拿哪一格。落在原来那一支上什么都不变，也不开卡片——那是点的事。玻璃滑到
   *     那一格上、缩回镜片那么大、淡掉，那一格自己的镜片同时长出来（SCRUB_SETTLE_MS）。
   *   · 横着划过竖着的那一条、竖着划过横躺的那一条：不是在挑，放手。
   *   · 划到横杠外面老远（SCRUB_ESCAPE）再松手、或者系统把手势收走：算反悔，什么都不拿。
   *
   * 那块玻璃不在横杠里面，挂在 body 上、浮在横杠上面。横杠自己带 backdrop-filter，它里面再有一块
   * 会折射的东西，看得见的「背后」只有横杠自己那层半透明的底——弯出来的图标和原来的图标叠成两个
   * （浏览器里实测过）。浮在外面，它看见的是已经合成好的横杠连同图标，弯的就是真的背后。
   *
   * 按下那一刻才往 window 上挂跟手的监听，抬手就摘：平时写字时每一下 pointermove 都不多走一步。
   * root 上那两个（按下、吞掉划完之后补来的那一下点击）绑一次——root 不会被重画换掉。
   */
  _installScrub() {
    this._scrub = null;
    this._scrubSwallow = false;
    /** 正在落回去、还没摘掉的那几块玻璃（拆掉工具栏时一起摘）。 */
    this._scrubDrops = new Set();

    const reduced = () => this.root.classList.contains('no-motion') || prefersReducedMotion();
    const selectorFor = (s) => (s.kind === 'tool' ? '[data-tool]' : '[data-swatch]');
    /** 这一组里能挑的那几格。「更多颜色」那一格是动作，不算（它没有 data-swatch）。 */
    const itemsOf = (s) => [...s.group.querySelectorAll(selectorFor(s))];

    /** 顺着横杠离手指最近的那一格。 */
    const itemAt = (s, x, y) => {
      let best = null;
      let bestDistance = Infinity;
      for (const item of itemsOf(s)) {
        const r = item.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const [a, b, p] = s.vertical ? [r.top, r.bottom, y] : [r.left, r.right, x];
        const d = p < a ? a - p : p > b ? p - b : 0;
        if (d < bestDistance) { bestDistance = d; best = item; }
      }
      return best;
    };

    const mark = (s, item) => {
      if (item === s.target) return;
      s.target?.classList.remove('is-scrub-target');
      s.target = item;
      item?.classList.add('is-scrub-target');
    };

    /** 玻璃和选中那一格的镜片一样大（镜片四边各缩 3px），浮起来时再放大（样式表）。 */
    const sizeOf = (item) => {
      const r = item.getBoundingClientRect();
      return Math.max(0, Math.min(r.width, r.height) - 6);
    };
    const centreOf = (item) => {
      const r = item.getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    };
    const place = (drop, x, y, size) => {
      drop.style.width = `${size}px`;
      drop.style.height = `${size}px`;
      drop.style.translate = `${x - size / 2}px ${y - size / 2}px`;
    };

    /** 竖着的那一条工具多到要滚：手指划到它头上 / 底下那一截，往那边滚一点。 */
    const autoScroll = (s, y) => {
      const g = s.group;
      if (!s.vertical || !(g.scrollHeight > g.clientHeight + 1)) return;
      const r = g.getBoundingClientRect();
      const EDGE = 18;
      const over = y < r.top + EDGE ? y - (r.top + EDGE) : y > r.bottom - EDGE ? y - (r.bottom - EDGE) : 0;
      if (over) g.scrollTop += clampNumber(over, -14, 14);
    };

    /** 玻璃跟着手指：顺着横杠在头一格和末一格的中心之间，横过来对齐那一排的中线。 */
    const follow = (s, x, y) => {
      autoScroll(s, y);
      const target = itemAt(s, x, y);
      mark(s, target);
      if (!target || !s.drop) return;
      const items = itemsOf(s);
      const first = centreOf(items[0]);
      const last = centreOf(items[items.length - 1]);
      const c = centreOf(target);
      const size = sizeOf(target);
      const g = s.group.getBoundingClientRect();
      let cx = c.x;
      let cy = c.y;
      if (s.vertical) cy = clampNumber(clampNumber(y, first.y, last.y), g.top + size / 2, g.bottom - size / 2);
      else cx = clampNumber(x, first.x, last.x);
      // 追上手指之后就直接跟手，不再过渡——过渡会让它慢半拍地追着手指跑。
      if (s.catchUntil && nowMs() >= s.catchUntil) {
        s.catchUntil = 0;
        s.drop.style.transition = reduced() ? 'none' : `scale ${SCRUB_CATCH_MS}ms ${SCRUB_EASE}, opacity 120ms ease`;
      }
      place(s.drop, cx, cy, size);
    };

    const listen = (on) => {
      const method = on ? 'addEventListener' : 'removeEventListener';
      window[method]('pointermove', this._onScrubMove, { capture: true });
      window[method]('pointerup', this._onScrubEnd, { capture: true });
      window[method]('pointercancel', this._onScrubEnd, { capture: true });
      window[method]('lostpointercapture', this._onScrubEnd, { capture: true });
    };
    const untrack = () => {
      this._scrub = null;
      listen(false);
    };

    const begin = (s, e) => {
      s.started = true;
      // 捕获在 root 上：抬手后浏览器补的那一下点击落在横杠自己身上，不会落到哪一格上。
      try { this.root.setPointerCapture(s.pointerId); } catch (_) { /* not capturable */ }
      s.group.classList.add('is-scrubbing');
      // 按下去时那一格放出的那道水波纹（liquid-glass.js 的按压反馈）：划起来就不要了。它一路扩散，
      // 这一排玻璃就一路每帧重合成（见 ink-toolbar.css 划着的那几条）。
      for (const wave of s.group.querySelectorAll('.liquid-ripple-wave')) wave.remove();
      const drop = document.createElement('div');
      drop.className = 'ink-scrub-drop';
      drop.setAttribute('aria-hidden', 'true');
      document.body.appendChild(drop);
      s.drop = drop;
      // 从选中那一格浮起来：先落在它上面、和它的镜片一样大，再追到手指底下。这一组里没有选中的
      // （用的是自己调的颜色）就在手指底下浮出来。
      const from = s.group.querySelector(`${selectorFor(s)}.is-selected`);
      const catchUp = !!from && !reduced();
      drop.style.transition = 'none';
      if (catchUp) {
        const c = centreOf(from);
        place(drop, c.x, c.y, sizeOf(from));
      } else {
        follow(s, e.clientX, e.clientY);
      }
      void drop.offsetWidth; // 先按这个样子排一次，下面的过渡才有起点
      if (reduced()) drop.style.transition = 'none';
      else if (catchUp) {
        drop.style.transition = `translate ${SCRUB_CATCH_MS}ms ${SCRUB_EASE}, `
          + `scale ${SCRUB_CATCH_MS}ms ${SCRUB_EASE}, opacity 120ms ease`;
        s.catchUntil = nowMs() + SCRUB_CATCH_MS;
      } else {
        drop.style.transition = `scale ${SCRUB_CATCH_MS}ms ${SCRUB_EASE}, opacity 120ms ease`;
      }
      drop.classList.add('is-on');
      if (catchUp) follow(s, e.clientX, e.clientY);
    };

    /** 松手（或者反悔）之后，那块玻璃落回拿着的那一格上、淡掉，然后摘掉。 */
    const settle = (s) => {
      const drop = s.drop;
      if (!drop) return;
      const home = s.group.isConnected ? s.group.querySelector(`${selectorFor(s)}.is-selected`) : null;
      if (reduced()) { drop.remove(); return; }
      drop.style.transition = `translate ${SCRUB_SETTLE_MS}ms ${SCRUB_EASE}, `
        + `scale ${SCRUB_SETTLE_MS}ms ${SCRUB_EASE}, opacity ${SCRUB_SETTLE_MS}ms ease`;
      if (home) {
        const c = centreOf(home);
        place(drop, c.x, c.y, sizeOf(home));
      }
      drop.classList.remove('is-on');
      this._scrubDrops.add(drop);
      setTimeout(() => { drop.remove(); this._scrubDrops.delete(drop); }, SCRUB_SETTLE_MS + 40);
    };

    const finish = (s, e, commit) => {
      untrack();
      let picked = null;
      if (commit) {
        const bar = this.root.getBoundingClientRect();
        const away = s.vertical
          ? e.clientX < bar.left - SCRUB_ESCAPE || e.clientX > bar.right + SCRUB_ESCAPE
          : e.clientY < bar.top - SCRUB_ESCAPE || e.clientY > bar.bottom + SCRUB_ESCAPE;
        if (!away) picked = itemAt(s, e.clientX, e.clientY) || s.target;
      }
      try { this.root.releasePointerCapture(s.pointerId); } catch (_) { /* never taken */ }
      // 抬手后浏览器补的那一下点击：不该再按到哪一格（捕获不住的时候它会落在按下的那一格上）。
      this._scrubSwallow = true;
      clearTimeout(this._scrubSwallowTimer);
      this._scrubSwallowTimer = setTimeout(() => { this._scrubSwallow = false; }, 350);
      if (picked?.isConnected && s.group.isConnected && this.state.phase === TOOLBAR_PHASE.EXPANDED) {
        if (s.kind === 'tool') {
          if (picked.dataset.tool !== this.state.tool) this._set(selectTool(this.state, picked.dataset.tool));
        } else if (!sameColor(picked.dataset.swatch, this.state.color)) {
          this._set(setColor(this.state, picked.dataset.swatch));
        }
      }
      // 先换工具、再摘掉划着的那两个类：拿到的那一格从「手指底下那一格」直接变成「选中的那一格」，
      // 蓝色一直在。先摘的话，换工具时一重算样式，它会先灰一下、再按 0.2 秒渐变蓝回来。
      mark(s, null);
      s.group.classList.remove('is-scrubbing');
      settle(s);
    };

    this._onScrubDown = (e) => {
      if (this._scrub || this._drag?.pointerId != null) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.state.phase !== TOOLBAR_PHASE.EXPANDED || this._perchAnimating) return;
      const group = e.target?.closest?.('.ink-tools, .ink-swatches');
      if (!group || !this.root.contains(group)) return;
      this._scrub = {
        pointerId: e.pointerId,
        group,
        kind: group.classList.contains('ink-tools') ? 'tool' : 'swatch',
        vertical: this.root.dataset.orientation === ORIENTATION.VERTICAL,
        x: e.clientX,
        y: e.clientY,
        started: false,
        target: null,
        drop: null,
        catchUntil: 0,
      };
      // 这里不捕获：捕获了，点一下的那个 click 也会被改道到横杠身上，按钮就收不到了。等它证明
      // 自己是在划，再捕获。
      listen(true);
    };

    this._onScrubMove = (e) => {
      const s = this._scrub;
      if (!s || e.pointerId !== s.pointerId) return;
      if (!s.started) {
        const along = Math.abs(s.vertical ? e.clientY - s.y : e.clientX - s.x);
        const across = Math.abs(s.vertical ? e.clientX - s.x : e.clientY - s.y);
        if (Math.max(along, across) < SCRUB_START) return;
        if (across > along || !s.group.isConnected || this.state.phase !== TOOLBAR_PHASE.EXPANDED) {
          untrack();
          return;
        }
        begin(s, e);
      } else {
        follow(s, e.clientX, e.clientY);
      }
      // 划起来以后这一路手势只归这里：不让它再去画线、拖书页、拉分栏。
      e.stopPropagation();
    };

    this._onScrubEnd = (e) => {
      const s = this._scrub;
      if (!s || e.pointerId !== s.pointerId) return;
      // 手指按下时，浏览器先把指针隐式地交给按下的那一格；开始划、改由横杠接住的那一刻，那一格会收到
      // 一个 lostpointercapture——那不是手势被收走。平板上就是这一下把刚开始的划动当场取消了（电脑上
      // 的合成事件没有隐式捕获，看不出来）。只有横杠自己丢了捕获才算。
      if (e.type === 'lostpointercapture' && e.target !== this.root) return;
      if (!s.started) { untrack(); return; }
      // 松手、被收走这两下不拦（划的过程中那些移动才拦，见 _onScrubMove）：别人挂在 window 上收尾的
      // 监听要听到它。liquid-glass.js 按下时给那一格挂上「鼓起」（liquid-bulge-press：缩一点、一圈影子
      // 和高光边），就是在 window 的冒泡阶段听 pointerup 摘掉的——原来这里拦了，每划一次，按下的那一格
      // 就留一圈，划几次一排全是圈（平板上看到的）。
      finish(s, e, e.type === 'pointerup');
    };

    this._onScrubClick = (e) => {
      if (!this._scrubSwallow) return;
      this._scrubSwallow = false;
      e.preventDefault();
      e.stopPropagation();
    };

    /** 拆掉工具栏的时候：划到一半的那一路收掉，玻璃都摘掉。 */
    this._stopScrub = () => {
      const s = this._scrub;
      if (s) {
        untrack();
        s.group.classList.remove('is-scrubbing');
        s.target?.classList.remove('is-scrub-target');
        s.drop?.remove();
      }
      for (const drop of this._scrubDrops) drop.remove();
      this._scrubDrops.clear();
      clearTimeout(this._scrubSwallowTimer);
      this._scrubSwallow = false;
    };

    this.root.addEventListener('pointerdown', this._onScrubDown);
    this.root.addEventListener('click', this._onScrubClick, true);
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
    this._cancelRowMoves();

    // A destroy that lands mid-drag has to end the drag here. The listener
    // that would otherwise have ended it is removed on the next lines.
    if (this._drag && this._drag.pointerId !== null) {
      const pointerId = this._drag.pointerId;
      this._drag.pointerId = null;
      try { this.root.releasePointerCapture(pointerId); } catch (_) { /* already released */ }
    }

    // 划到一半被拆：跟手的监听摘掉，浮在 body 上的那块玻璃也摘掉——它不在横杠里，横杠走了它不会跟着走。
    this._stopScrub?.();
    this.root.removeEventListener('pointerdown', this._onScrubDown);
    this.root.removeEventListener('click', this._onScrubClick, true);

    this.root.removeEventListener('pointerdown', this._onDragStart);
    this.root.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('click', this._onClickCapture, { capture: true });
    clearTimeout(this._swallowTimer);
    window.removeEventListener('pointermove', this._onDragMove, { capture: true });
    window.removeEventListener('pointerup', this._onDragEnd, { capture: true });
    window.removeEventListener('pointercancel', this._onDragEnd, { capture: true });
    window.removeEventListener('lostpointercapture', this._onDragEnd, { capture: true });
    document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
    this._offLang?.();
    this._offLang = null;
    this._offPerch?.();
    this._offPerch = null;
    // 拖到一半被拆：那一路收掉。走之前把被它推开的标签放回家：它不在了，没人再来摆它们。
    this._rowDrag?.cancel();
    this._rowDrag = null;
    if (this.state.perch) this._perchHost?.release?.({ animate: false });
    this._perchHost?.preview?.(null);

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
    const card = this._liveCard();
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

  /**
   * 卡片：开、换、关。
   *
   * 换一张（笔的卡片换成颜色卡片、钢笔的换成荧光笔的）和关掉，走掉的那一张都有
   * 一小段退场，不是当场消失。原来是 replaceChildren 一下换掉：新的那张带着入场
   * 动画浮上来，旧的那张凭空没了——一半有动作一半没有，看着像闪了一下。
   *
   * 同一张卡片重建（换了语言、横竖变了）不算换：原地换掉，也不重播入场——那不是
   * 来了一张新卡片，演一遍进场只会让它闪一下。
   */
  _renderCard() {
    const { state } = this;
    const live = this._liveCard();
    if (state.openCard === CARDS.NONE) {
      if (live) this._dismissCard(live);
      return;
    }

    const card = document.createElement('div');
    card.className = 'ink-card';
    // 停在顶上那一排里的那一条是横躺着的，卡片挂在它下面。
    card.dataset.edge = this._perchedView() ? EDGES.TOP : state.edge;
    // 哪一张：工具卡片按工具分，钢笔的和荧光笔的是两张。
    card.dataset.card = state.openCard === CARDS.TOOL ? `tool:${state.tool}` : state.openCard;

    if (state.openCard === CARDS.TOOL) card.innerHTML = this._toolCardHtml();
    else if (state.openCard === CARDS.ERASER) card.innerHTML = this._eraserCardHtml();
    else if (state.openCard === CARDS.LASSO) card.innerHTML = this._lassoCardHtml();
    else if (state.openCard === CARDS.SHAPE) card.innerHTML = this._shapeCardHtml();
    else if (state.openCard === CARDS.COLOR) card.innerHTML = this._colorCardHtml();
    else card.innerHTML = this._overflowCardHtml();

    if (live && live.dataset.card === card.dataset.card) {
      card.classList.add('is-instant');
      live.replaceWith(card);
    } else {
      if (live) this._dismissCard(live);
      // 放在最前面：别处 querySelector('.ink-card') 先找到的是它，而不是正在退场的
      // 那一张。退场的那张在它后面，画在它上面淡出——两张叠着交接，不留空档。
      this.cardLayer.prepend(card);
    }
    this._anchorCard(card);
    this._bindCard(card);
  }

  /** 眼下开着的那一张。正在退场的不算：它已经不归谁管了。 */
  _liveCard() {
    return this.cardLayer?.querySelector?.('.ink-card:not(.is-leaving)') || null;
  }

  /**
   * 一张卡片退场：淡出、往上收一点，演完再拿掉。
   *
   * 演的这一小段里它点不到、读屏也跳过它（inert）。动画结束的事件没来（页面在
   * 后台、减少动态效果）也照样拿得掉：计时器兜底。
   */
  _dismissCard(card) {
    let reduced = false;
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { /* 当作没开 */ }
    if (reduced) { card.remove(); return; }
    card.classList.add('is-leaving');
    card.inert = true;
    card.setAttribute('aria-hidden', 'true');
    let timer = 0;
    const done = (e) => {
      if (e && e.target !== card) return;
      clearTimeout(timer);
      card.removeEventListener('animationend', done);
      card.remove();
    };
    card.addEventListener('animationend', done);
    timer = setTimeout(done, CARD_LEAVE_MS + 60);
  }

  /** Anchors the card adjacent to the toolbar, on the side with room. */
  _anchorCard(card) {
    // 停稳之后的位置：刚展开、刚落边就点开卡片，横杠还在飞，卡片不该贴着半空。
    const bar = this.rect();
    const host = this.host.getBoundingClientRect();
    const s = card.style;
    s.left = s.right = s.top = s.bottom = '';
    // 停在顶上那一排里的那一条：卡片挂在它下面，落在工作区最上沿之下（那一排在工作
    // 区外面，算出来是负的，卡片层又是按工作区切的——不夹的话它会被切掉一截）。
    const edge = this._perchedView() ? EDGES.TOP : this.state.edge;

    if (edge === EDGES.TOP && this._perchedView()) {
      s.top = `${Math.max(8, bar.bottom - host.top + 8)}px`;
      s.left = `${Math.max(8, bar.left - host.left)}px`;
      return;
    }
    if (edge === EDGES.LEFT) {
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

    // 滑杆拖着的时候一秒钟来几十次 input，每一次都写一遍 localStorage 是白写：
    // 拖到一半的值没人要。松手时 change 来一次，那时再存。
    const persistOnRelease = (slider) => slider.addEventListener('change', () => this._persist());

    const width = card.querySelector('[data-role="width"]');
    width?.addEventListener('input', () => {
      this._set(setWidth(this.state, width.value), { keepCard: true, persist: false });
      const out = card.querySelector('[data-role="width-readout"]');
      if (out) out.textContent = Number(width.value).toFixed(1);
    });
    if (width) persistOnRelease(width);

    card.querySelectorAll('[data-role="opacity"]').forEach((slider) => {
      slider.addEventListener('input', () => {
        this._set(setOpacity(this.state, Number(slider.value) / 100), { keepCard: true, persist: false });
        const out = card.querySelector('[data-role="opacity-readout"]');
        if (out) out.textContent = String(Math.round(Number(slider.value)));
      });
      persistOnRelease(slider);
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
      this._set(setEraserWidth(this.state, eraserWidth.value), { keepCard: true, persist: false });
      const out = card.querySelector('[data-role="eraser-readout"]');
      if (out) out.textContent = Number(eraserWidth.value).toFixed(1);
    });
    if (eraserWidth) persistOnRelease(eraserWidth);

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
