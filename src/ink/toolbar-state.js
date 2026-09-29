// Ink Module — floating toolbar state.
//
// Pure and DOM-free, like the other state machines in this codebase, because
// the acceptance criteria for the toolbar are mostly statements about state:
//
//   "Selected tool, quick color, and relevant parameters survive movement and
//    orientation change."
//   "Toolbar dragging does not draw Ink, pan the page, move the split divider,
//    or change the active document."
//
// Keeping tool state and placement state in ONE immutable object, with
// transitions that can only touch placement, makes the first provable and the
// second structural: there is no reference here to a document, a pane, a
// divider or an ink layer, so a drag cannot reach any of them.

import { INK_TOOLS, TOOL_DEFAULTS } from './stroke.js';
import { ERASER_MODES } from './ink-eraser.js';
import { SHAPE_KINDS, SHAPE_ORDER } from './shape-geometry.js';

/**
 * How far into the workspace a corner reaches, as a fraction of each axis.
 *
 * Large enough that aiming at a corner does not require precision with a
 * stylus in one hand, small enough that the middle of an edge is still an edge.
 */
export const CORNER_ZONE = 0.18;

export const EDGES = Object.freeze({
  LEFT: 'left',
  RIGHT: 'right',
  TOP: 'top',
  BOTTOM: 'bottom',
});

export const ORIENTATION = Object.freeze({
  VERTICAL: 'vertical',
  HORIZONTAL: 'horizontal',
});

/** Expanded ⇄ a compact token showing the active tool, per the drag sequence. */
export const TOOLBAR_PHASE = Object.freeze({
  EXPANDED: 'expanded',
  DRAGGING: 'dragging',
  /**
   * Parked in a corner as the same circular token used while dragging.
   * Distinct from DRAGGING because it is a resting state, and distinct from
   * EXPANDED because it must NOT expand on its own (spec §5.2).
   */
  DOCKED: 'docked',
});

export const CORNERS = Object.freeze({
  TOP_LEFT: 'top-left',
  TOP_RIGHT: 'top-right',
  BOTTOM_LEFT: 'bottom-left',
  BOTTOM_RIGHT: 'bottom-right',
});

/**
 * 顶上那一排（和「练习 / 设置」两个标签同一行）里，工具栏能停的两处空当：两个
 * 标签左边那一处、右边那一处。
 *
 * 停在那儿的时候它有两种样子，用的还是这里原有的两个阶段：
 *   · DOCKED：收成一颗球，塞在那处空当里；
 *   · EXPANDED：点开，整条横着躺在这一排里，把两边的胶囊挤开。
 * 怎么量空当、怎么挤，是页面那一层的事（src/pdf/top-row-dock.js）；这里只记它停
 * 在哪一处（perch：标签的哪一侧），和停在那一侧的哪儿（perchX：球心在这一排里的比
 * 例，0 在左头、1 在右头；没有就是那处空当的正中）。
 */
export const PERCHES = Object.freeze({
  LEFT: 'left',
  RIGHT: 'right',
});

/**
 * Corner snap zone, in CSS pixels.
 *
 * The spec leaves the dimension to implementation. 96px is two 48dp touch
 * targets — comfortably hittable while dragging with a thumb, without
 * swallowing so much of an edge that ordinary edge docking becomes hard to
 * reach. It is additionally capped at a quarter of each viewport dimension so
 * that on a small or split-screen window the four corners cannot consume the
 * entire drop area between them.
 */
export const CORNER_ZONE_PX = 96;

export function cornerZoneSize(viewport) {
  const width = Math.max(1, viewport?.width || 1);
  const height = Math.max(1, viewport?.height || 1);
  return {
    x: Math.min(CORNER_ZONE_PX, width * 0.25),
    y: Math.min(CORNER_ZONE_PX, height * 0.25),
  };
}

/**
 * The corner whose snap zone contains a point, or null.
 *
 * Corner zones are tested before edges everywhere this is used, which is how
 * "corner docking takes precedence over the adjacent edge-expansion rule when
 * their target zones overlap" is enforced — by evaluation order, not by
 * tie-breaking after the fact.
 */
export function cornerAt(point, viewport) {
  if (!point || !viewport) return null;
  const { x: zoneX, y: zoneY } = cornerZoneSize(viewport);
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const x = Math.min(width, Math.max(0, point.x));
  const y = Math.min(height, Math.max(0, point.y));

  const left = x <= zoneX;
  const right = x >= width - zoneX;
  const top = y <= zoneY;
  const bottom = y >= height - zoneY;

  if (top && left) return CORNERS.TOP_LEFT;
  if (top && right) return CORNERS.TOP_RIGHT;
  if (bottom && left) return CORNERS.BOTTOM_LEFT;
  if (bottom && right) return CORNERS.BOTTOM_RIGHT;
  return null;
}

export const CARDS = Object.freeze({
  NONE: null,
  TOOL: 'tool',
  COLOR: 'color',
  ERASER: 'eraser',
  LASSO: 'lasso',
  SHAPE: 'shape',
  OVERFLOW: 'overflow',
});

/**
 * The two shapes a lasso can take.
 *
 * FREE follows the hand. RECT is a dragged box — which is not a lesser lasso
 * but the right tool for the thing this app is full of: a worked solution laid
 * out in lines, where "everything between here and here" is a rectangle and
 * drawing round it by hand is just slower.
 */
export const LASSO_SHAPES = Object.freeze({
  FREE: 'free',
  RECT: 'rect',
});

/**
 * What counts as caught.
 *
 * TOUCH takes any stroke the loop crosses; INSIDE takes only strokes that fall
 * entirely within it. TOUCH is the forgiving default — a loop round a diagram
 * should take the diagram — but INSIDE is what you need to pull one line out
 * of a paragraph without dragging the descenders of the line above it.
 */
export const LASSO_MODES = Object.freeze({
  TOUCH: 'touch',
  INSIDE: 'inside',
});

/** The eraser is a toolbar selection but not a stroke tool. */
export const ERASER_TOOL = 'eraser';
/** Selection, not drawing: the lasso catches strokes and transforms them. */
export const LASSO_TOOL = 'lasso';
/**
 * 形状：拖出来一条直线或一个圆。
 *
 * 它画出来的是普普通通的笔迹——落进同一个层、同一段撤销、同一把橡皮——只是那些
 * 点不是手抖出来的，而是算出来的。所以它在这里和笔并列，而不是另立一套东西。
 * 几何和吸附规则在 shape-geometry.js，那里的数字是从视频里逐帧量的。
 */
export const SHAPE_TOOL = 'shape';

/** Four quick swatches, as observed in the reference layout. */
export const DEFAULT_SWATCHES = Object.freeze(['#111827', '#dc2626', '#2563eb', '#16a34a']);

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/**
 * What each drawing tool was last set to.
 *
 * A pen is not a marker with a different name: someone who sets the pen to 1.2
 * and the highlighter to 20 has said two things, and picking one up again
 * should bring back what they said about IT. Selecting a tool used to overwrite
 * the width and opacity with that tool's factory defaults, so every adjustment
 * survived exactly until the next time another tool was touched.
 *
 * Kept for the four stroke tools only: the eraser has its own `eraserWidth`,
 * and the lasso has no size at all.
 */
function toolMemory(initial = {}) {
  const remembered = {};
  for (const tool of Object.values(INK_TOOLS)) {
    const defaults = TOOL_DEFAULTS[tool] || TOOL_DEFAULTS[INK_TOOLS.PEN];
    const saved = initial?.[tool] || {};
    remembered[tool] = Object.freeze({
      width: Number.isFinite(saved.width) ? saved.width : defaults.width,
      opacity: Number.isFinite(saved.opacity) ? saved.opacity : defaults.opacity,
    });
  }
  return Object.freeze(remembered);
}

export function createToolbarState(initial = {}) {
  const tool = initial.tool || INK_TOOLS.PEN;
  const byTool = toolMemory(initial.byTool);
  // The live width and opacity start from what THIS tool was last set to, so a
  // restart comes back holding the same pen it was put down with.
  const defaults = byTool[tool] || TOOL_DEFAULTS[INK_TOOLS.PEN];
  return Object.freeze({
    /** Per-tool width and opacity; see toolMemory. */
    byTool,

    // ── placement ──
    edge: Object.values(EDGES).includes(initial.edge) ? initial.edge : EDGES.LEFT,
    offset: clamp01(initial.offset ?? 0.35),
    /**
     * 停在顶上那一排的哪一处空当，没停在那儿就是 null。见 PERCHES。
     *
     * 开机时停在那儿的，一律是收着的那颗球：点开的那一条会把两边的胶囊挤开，一
     * 开机就挤着，人还没伸手，顶上那一排先乱了。
     */
    perch: Object.values(PERCHES).includes(initial.perch) ? initial.perch : null,
    /** 球停在那一排里的哪儿（球心在这一排里的比例）。人放在哪儿就是哪儿，不再一律摆到空当正中。 */
    perchX: Object.values(PERCHES).includes(initial.perch) && Number.isFinite(initial.perchX)
      ? clamp01(initial.perchX) : null,
    /** Corner-docked state is restorable, so the phase comes from `initial`. */
    phase: (Object.values(PERCHES).includes(initial.perch)
      || (initial.corner && Object.values(CORNERS).includes(initial.corner)))
      ? TOOLBAR_PHASE.DOCKED
      : TOOLBAR_PHASE.EXPANDED,
    corner: Object.values(PERCHES).includes(initial.perch)
      ? null
      : (Object.values(CORNERS).includes(initial.corner) ? initial.corner : null),
    /** Transient token position while dragging, in viewport pixels. */
    dragPoint: null,
    /**
     * Set only while the bar has been folded away for something else — a deck
     * list it was covering. Holds the placement to give back, so a yield the
     * reader never asked for cannot become the placement they are left with.
     */
    yielded: null,
    /**
     * 顶上那一排收起来的时候，停在那一排里的工具栏借住在工作区左边（见 stepOffRow）。
     * 这里记着它在那一排里的位置，那一排拉回来就还回去；存盘写的也是这一份。
     */
    offRow: null,

    // ── ink tool state (must survive placement changes) ──
    tool,
    color: initial.color || DEFAULT_SWATCHES[0],
    width: Number.isFinite(initial.width) ? initial.width : defaults.width,
    opacity: Number.isFinite(initial.opacity) ? initial.opacity : defaults.opacity,
    eraserMode: initial.eraserMode === ERASER_MODES.REGION
      ? ERASER_MODES.REGION : ERASER_MODES.STROKE,
    eraserWidth: Number.isFinite(initial.eraserWidth) ? initial.eraserWidth : 8,
    lassoShape: initial.lassoShape === LASSO_SHAPES.RECT
      ? LASSO_SHAPES.RECT : LASSO_SHAPES.FREE,
    lassoMode: initial.lassoMode === LASSO_MODES.INSIDE
      ? LASSO_MODES.INSIDE : LASSO_MODES.TOUCH,
    /** 形状工具画哪一种。视频里的默认是直线（第一格，亮着的那个）。 */
    shapeKind: SHAPE_ORDER.includes(initial.shapeKind) ? initial.shapeKind : SHAPE_KINDS.LINE,
    /** 闭合形状的填充色；null 是「别填」，也是默认——视频里那一排选的正是它。 */
    shapeFill: typeof initial.shapeFill === 'string' && initial.shapeFill
      ? initial.shapeFill : null,
    swatches: Object.freeze([...(initial.swatches || DEFAULT_SWATCHES)]),

    openCard: CARDS.NONE,
    /** Overflow toggles; present but not promoted to core behaviour. */
    autoMinimize: !!initial.autoMinimize,
  });
}

const next = (state, patch) => Object.freeze({ ...state, ...patch });

export function orientationFor(edge) {
  return edge === EDGES.TOP || edge === EDGES.BOTTOM
    ? ORIENTATION.HORIZONTAL
    : ORIENTATION.VERTICAL;
}

export function orientationOf(state) {
  return orientationFor(state.edge);
}

// ── drag sequence ───────────────────────────────────────────────────────────

/**
 * Expanded → collapsed token. Any open card closes: a card anchored to the
 * toolbar cannot stay anchored while the toolbar is moving.
 */
export function startDrag(state, point) {
  if (state.phase === TOOLBAR_PHASE.DRAGGING) return state;
  return next(state, {
    phase: TOOLBAR_PHASE.DRAGGING,
    openCard: CARDS.NONE,
    // Picking the puck up leaves the corner; where it lands decides the rest.
    corner: null,
    // 从顶上那一排拿起来也一样：拿在手里的时候它不在任何一处。
    perch: null,
    perchX: null,
    dragPoint: point ? { x: point.x, y: point.y } : null,
    // 人把它拿在手里了：接下来落在哪儿是他定的，不再欠谁一个位置。留着那笔账
    // 的话，挡着它的面板一关，它会跳回拖动之前的地方——人刚放下的位置被当成了
    // 借来的；存盘时写下去的也是那个旧位置。
    yielded: null,
    // 顶上那一排收着时借住在左边的也一样：亲手挪过，那一排拉回来就不再把它送回去。
    offRow: null,
  });
}

/** Token follows the pointer. Only dragPoint changes. */
export function moveDrag(state, point) {
  if (state.phase !== TOOLBAR_PHASE.DRAGGING || !point) return state;
  return next(state, { dragPoint: { x: point.x, y: point.y } });
}

/**
 * Release → snap to a placement target.
 *
 * An EDGE release re-expands into the full bar. A CORNER release does not: the
 * bar stays the circular token it became when the drag started, parked in that
 * corner. The two are different destinations because they answer different
 * needs — an edge is where you want the tools to hand, a corner is where you
 * want them out of the way — and a corner has no room for a bar anyway: a
 * vertical bar in the top-left corner runs down over the page, which is the one
 * place the user is trying to clear.
 *
 * The docked puck expands on a tap, never on its own (§5.2).
 *
 * `edge` and `offset` are still written on a corner dock, so undocking has a
 * home to expand back onto without having to invent one.
 *
 * Only placement fields may change here. Every ink parameter is carried through
 * untouched, which is the acceptance requirement that selections survive
 * movement and reorientation.
 */
export function endDrag(state, point, viewport, { perch = null, perchX = null } = {}) {
  if (state.phase !== TOOLBAR_PHASE.DRAGGING) return state;
  // 松在顶上那一排里：收成一颗球，停在松手的那个地方。落在哪一侧、哪儿由页面那一层判
  // （它才知道那几枚胶囊在哪），这里只照办。edge / offset 不动——那是它在工作区里的
  // 家，之后从这一排拖回工作区时，落点会重新定它。
  if (Object.values(PERCHES).includes(perch)) {
    return next(state, {
      phase: TOOLBAR_PHASE.DOCKED,
      corner: null,
      perch,
      perchX: Number.isFinite(perchX) ? clamp01(perchX) : null,
      dragPoint: null,
    });
  }
  const release = point || state.dragPoint;
  if (!release || !viewport) {
    return next(state, { phase: TOOLBAR_PHASE.EXPANDED, perch: null, perchX: null, dragPoint: null });
  }
  const { edge, offset } = nearestEdge(release, viewport);
  const corner = cornerOf(release, viewport);
  return next(state, {
    phase: corner ? TOOLBAR_PHASE.DOCKED : TOOLBAR_PHASE.EXPANDED,
    corner,
    perch: null,
    perchX: null,
    edge,
    offset,
    dragPoint: null,
  });
}

/**
 * Docked puck → full bar, on the edge the dock was reached from.
 *
 * Only reachable from a deliberate tap. Nothing else undocks: a toolbar that
 * unfolded itself the moment the stylus passed near it would defeat the point
 * of parking it in the corner.
 */
export function undock(state) {
  if (state.phase !== TOOLBAR_PHASE.DOCKED) return state;
  // 点开也是人自己要它回来。让位时欠下的账就此结清：还留着的话，它以为自己
  // 还在让着，之后再开什么面板都不让了——横杠直接压在单子上。
  return next(state, { phase: TOOLBAR_PHASE.EXPANDED, corner: null, yielded: null });
}

/**
 * 展开的横杠 → 角上那颗球，没有拖动，也不欠谁。
 *
 * 这是「自动最小化」的那一步：人把横杠点开、挑好笔，然后把笔落到纸上——横杠
 * 的活已经干完了，该让开，直到他再要它。
 *
 * 和 yieldToCorner 不是一回事，虽然屏幕上看着一模一样。让开是暂时的，因为压住
 * 它的那块面板会关上；而「把笔落在纸上」不是一件会结束的事，没有哪一刻可以说
 * 「现在该还回去了」——真要还，还的那一下正好落在人写字的纸上。所以这里什么都
 * 不记：要它回来的是一次点按，和人自己亲手把球点开一样。
 *
 * 拖动途中不收（球正在人手里），已经让开的时候也不收（位置是借来的，再折一次
 * 会让那笔账指向一个角，而不是指向横杠真正的家）。
 */
export function dockToCorner(state, corner) {
  if (!Object.values(CORNERS).includes(corner)) return state;
  if (state.phase !== TOOLBAR_PHASE.EXPANDED) return state;
  if (state.yielded) return state;
  // 停在顶上那一排里的，收回那一排里那颗球（foldToPerch），不飞到工作区的角上去。
  if (state.perch) return state;
  return next(state, { phase: TOOLBAR_PHASE.DOCKED, corner, openCard: CARDS.NONE });
}

/**
 * 顶上那一排里点开的那一条 → 收回同一处空当里的那颗球。
 *
 * 人点它的把手收起来、或者开着「自动收起」时一落笔，都走这一步。卡片跟着关：它挂
 * 在横杠底下，横杠收了它就没处挂。
 */
export function foldToPerch(state) {
  if (!state.perch || state.phase !== TOOLBAR_PHASE.EXPANDED) return state;
  return next(state, { phase: TOOLBAR_PHASE.DOCKED, corner: null, openCard: CARDS.NONE });
}

/**
 * 顶上那一排此刻停不下它（专注模式把那一排收掉了、那两处空当都窄得放不下一颗
 * 球）：离开那一排，收成工作区角上的一颗球。
 *
 * 记成人自己停的那种（不是让位）：那一排什么时候回来说不准，回来了也不该替人把
 * 它搬回去。
 */
export function leavePerch(state, corner = CORNERS.TOP_RIGHT) {
  if (!state.perch) return state;
  return next(state, {
    phase: TOOLBAR_PHASE.DOCKED,
    corner: Object.values(CORNERS).includes(corner) ? corner : CORNERS.TOP_RIGHT,
    perch: null,
    perchX: null,
    openCard: CARDS.NONE,
  });
}

/**
 * 回到顶上那一排的那一处空当，收着。
 *
 * 只给「那一排暂时停不了、它被请到角上去」之后的那一步用：那一排回来了，它原样回去。
 * 人在这中间亲手挪过它的话，就不再回去——那时它在哪儿是人定的。
 */
export function perchAt(state, perch, perchX = null) {
  if (!Object.values(PERCHES).includes(perch)) return state;
  if (state.phase === TOOLBAR_PHASE.DRAGGING) return state;
  return next(state, {
    phase: TOOLBAR_PHASE.DOCKED,
    corner: null,
    perch,
    perchX: Number.isFinite(perchX) ? clamp01(perchX) : null,
    openCard: CARDS.NONE,
    yielded: null,
    offRow: null,
  });
}

/**
 * 顶上那一排被收起来了（往上一拉）：停在里面的工具栏不跟着一起消失，改借住在工作区左边——
 * 人说「工具栏位于上方时，如果收起上方菜单栏，则工具栏会从左边重新出现」。
 *
 *   · 点开着的那一条：贴左边竖着，上下停在它在工作区里的老地方（原来就贴左边的话用它的
 *     offset，别的边就居中）；
 *   · 收着的那颗球：停在左上角（它在左边的老地方偏下半截就停左下角）。
 *
 * 借的，不是搬家：它在那一排里的位置记在 offRow 里，那一排拉回来就还回去（backToRow），
 * 存盘写的也是那一排里的位置。人中间亲手拖过它就不再还（startDrag 清掉这笔账）。
 * 在左边点开、收起都照常，还回去时按那一刻是开着还是收着。
 */
export function stepOffRow(state) {
  if (!state.perch || state.phase === TOOLBAR_PHASE.DRAGGING) return state;
  const expanded = state.phase === TOOLBAR_PHASE.EXPANDED;
  const onLeft = state.edge === EDGES.LEFT;
  const offset = onLeft ? state.offset : 0.5;
  return next(state, {
    offRow: Object.freeze({
      perch: state.perch,
      perchX: state.perchX,
      edge: state.edge,
      offset: state.offset,
    }),
    perch: null,
    perchX: null,
    phase: expanded ? TOOLBAR_PHASE.EXPANDED : TOOLBAR_PHASE.DOCKED,
    corner: expanded ? null : (offset > 0.5 ? CORNERS.BOTTOM_LEFT : CORNERS.TOP_LEFT),
    edge: EDGES.LEFT,
    offset,
    openCard: CARDS.NONE,
  });
}

/**
 * 顶上那一排拉回来了：借住在左边的回那一排里原来的地方，开着的还开着、收着的还收着。
 * 让位那笔账一起结清——停在那一排里的不压着任何面板。
 */
export function backToRow(state) {
  const owed = state.offRow;
  if (!owed || state.phase === TOOLBAR_PHASE.DRAGGING) return state;
  return next(state, {
    perch: owed.perch,
    perchX: owed.perchX,
    edge: owed.edge,
    offset: owed.offset,
    phase: state.phase === TOOLBAR_PHASE.EXPANDED ? TOOLBAR_PHASE.EXPANDED : TOOLBAR_PHASE.DOCKED,
    corner: null,
    openCard: CARDS.NONE,
    yielded: null,
    offRow: null,
  });
}

/** 顶上那一排收着、它借住在左边。 */
export function isOffRow(state) {
  return !!state.offRow;
}

/** 停在顶上那一排里（球也好、点开的那一条也好）。 */
export function isPerched(state) {
  return !!state.perch;
}

/**
 * Folds the bar into a corner to get it off something else, remembering where
 * it was so it can be handed back.
 *
 * This is NOT docking. Docking is a choice the reader made with a drag, and it
 * is theirs to keep; this is the bar stepping aside for a panel that opened
 * over it, and it owes the reader their placement back the moment that panel
 * closes. The two look identical on screen — the same circle in the same
 * corner — and differ in the only way that matters: one is remembered, the
 * other is repaid.
 *
 * A drag is never interrupted: a reader with the token under their stylus is
 * placing it, and a panel opening underneath must not take it out of their
 * hand.
 */
export function yieldToCorner(state, corner) {
  if (!Object.values(CORNERS).includes(corner)) return state;
  if (state.phase === TOOLBAR_PHASE.DRAGGING) return state;
  // 停在顶上那一排里的，不在工作区上，压不着任何面板，也就没什么可让的。
  if (state.perch) return state;
  // Already stepped aside: only the corner may still change, and the debt
  // recorded the first time is the one that stands.
  if (state.yielded) {
    return state.corner === corner ? state : next(state, { corner });
  }
  return next(state, {
    phase: TOOLBAR_PHASE.DOCKED,
    corner,
    openCard: CARDS.NONE,
    yielded: Object.freeze({
      phase: state.phase,
      corner: state.corner,
      edge: state.edge,
      offset: state.offset,
    }),
  });
}

/** Gives back exactly the placement `yieldToCorner` borrowed. */
export function unyield(state) {
  const owed = state.yielded;
  if (!owed) return state;
  return next(state, {
    phase: owed.phase,
    corner: owed.corner,
    edge: owed.edge,
    offset: owed.offset,
    yielded: null,
  });
}

export function isYielded(state) {
  return !!state.yielded;
}

export function isDocked(state) {
  return state.phase === TOOLBAR_PHASE.DOCKED;
}

/**
 * Nearest edge to a point, plus how far along that edge it sits.
 * Ties resolve to the vertical edges, matching the default side placement.
 */
export function nearestEdge(point, viewport) {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const x = Math.min(width, Math.max(0, point.x));
  const y = Math.min(height, Math.max(0, point.y));

  // Corners first.
  //
  // Judging a corner by nearest edge alone cannot work: at a corner both edges
  // are equally close, so the result flips on a pixel and the bar lands on
  // whichever side won the rounding. A corner is its own destination — release
  // inside the zone and the bar goes to the END of the vertical edge, which
  // puts it in that corner and orients it the way a corner has room for.
  const zoneX = width * CORNER_ZONE;
  const zoneY = height * CORNER_ZONE;
  const nearLeft = x <= zoneX;
  const nearRight = x >= width - zoneX;
  const nearTop = y <= zoneY;
  const nearBottom = y >= height - zoneY;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    return {
      edge: nearLeft ? EDGES.LEFT : EDGES.RIGHT,
      offset: nearTop ? 0 : 1,
      corner: true,
    };
  }

  const distances = [
    { edge: EDGES.LEFT, distance: x, offset: y / height },
    { edge: EDGES.RIGHT, distance: width - x, offset: y / height },
    { edge: EDGES.TOP, distance: y, offset: x / width },
    { edge: EDGES.BOTTOM, distance: height - y, offset: x / width },
  ];
  distances.sort((a, b) => a.distance - b.distance);
  const best = distances[0];
  return { edge: best.edge, offset: clamp01(best.offset), corner: false };
}

/** Whether a release point would dock the bar into a corner. */
export function isCornerPoint(point, viewport) {
  if (!point || !viewport) return false;
  return nearestEdge(point, viewport).corner === true;
}

/**
 * WHICH corner a release point lands in, or null.
 *
 * Deliberately derived from the same CORNER_ZONE fractions `nearestEdge` uses,
 * rather than from `cornerAt`'s pixel zones. Two corner tests with two
 * different zone sizes would disagree on the band between them — the drag would
 * arm the magnet and then dock to an edge, or dock without ever showing the
 * pull. One definition, one answer.
 */
export function cornerOf(point, viewport) {
  if (!point || !viewport) return null;
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const x = Math.min(width, Math.max(0, point.x));
  const y = Math.min(height, Math.max(0, point.y));

  const zoneX = width * CORNER_ZONE;
  const zoneY = height * CORNER_ZONE;
  const left = x <= zoneX;
  const right = x >= width - zoneX;
  const top = y <= zoneY;
  const bottom = y >= height - zoneY;

  if (top && left) return CORNERS.TOP_LEFT;
  if (top && right) return CORNERS.TOP_RIGHT;
  if (bottom && left) return CORNERS.BOTTOM_LEFT;
  if (bottom && right) return CORNERS.BOTTOM_RIGHT;
  return null;
}

// ── tool state ──────────────────────────────────────────────────────────────

/**
 * Picks up a tool, in the state it was last put down in.
 *
 * NOT its factory defaults. Adopting the defaults meant a width the user had
 * chosen lasted only until they touched another tool and came back — every
 * adjustment silently undone by the act of using the eraser.
 */
export function selectTool(state, tool) {
  if (tool === ERASER_TOOL) {
    return next(state, { tool: ERASER_TOOL, openCard: CARDS.NONE });
  }
  if (tool === LASSO_TOOL) {
    return next(state, { tool: LASSO_TOOL, openCard: CARDS.NONE });
  }
  if (tool === SHAPE_TOOL) {
    // 形状有自己记得的粗细——它就是视频里那根「边框」滑杆。没记过的时候从钢笔
    // 那儿借一个默认值，而不是留着上一支工具的：拿荧光笔的 16 去画圆，出来的
    // 是一个环。
    const remembered = state.byTool?.[SHAPE_TOOL] || TOOL_DEFAULTS[INK_TOOLS.PEN];
    return next(state, {
      tool: SHAPE_TOOL,
      width: remembered.width,
      opacity: remembered.opacity,
      openCard: CARDS.NONE,
    });
  }
  if (!Object.values(INK_TOOLS).includes(tool)) return state;
  const remembered = state.byTool?.[tool] || TOOL_DEFAULTS[tool];
  return next(state, {
    tool,
    width: remembered.width,
    opacity: remembered.opacity,
    openCard: CARDS.NONE,
  });
}

/**
 * Files a change against the tool it was made for.
 *
 * The live value and the remembered one are written together, so there is no
 * window in which the toolbar is showing something it has not recorded.
 */
function remember(state, patch) {
  if (!Object.values(INK_TOOLS).includes(state.tool)) return next(state, patch);
  const current = state.byTool?.[state.tool] || TOOL_DEFAULTS[state.tool];
  return next(state, {
    ...patch,
    byTool: Object.freeze({
      ...state.byTool,
      [state.tool]: Object.freeze({ ...current, ...patch }),
    }),
  });
}

export function setColor(state, color) {
  if (!color || color === state.color) return state;
  return next(state, { color });
}

export function setWidth(state, width) {
  const value = Math.max(0.2, Math.min(40, Number(width) || state.width));
  return value === state.width ? state : remember(state, { width: value });
}

export function setOpacity(state, opacity) {
  const value = clamp01(opacity);
  return value === state.opacity ? state : remember(state, { opacity: value });
}

export function setEraserMode(state, mode) {
  const value = mode === ERASER_MODES.REGION ? ERASER_MODES.REGION : ERASER_MODES.STROKE;
  return next(state, { tool: ERASER_TOOL, eraserMode: value });
}

export function setLassoShape(state, shape) {
  const value = shape === LASSO_SHAPES.RECT ? LASSO_SHAPES.RECT : LASSO_SHAPES.FREE;
  return value === state.lassoShape ? state : next(state, { tool: LASSO_TOOL, lassoShape: value });
}

export function setLassoMode(state, mode) {
  const value = mode === LASSO_MODES.INSIDE ? LASSO_MODES.INSIDE : LASSO_MODES.TOUCH;
  return value === state.lassoMode ? state : next(state, { tool: LASSO_TOOL, lassoMode: value });
}

export function setEraserWidth(state, width) {
  const value = Math.max(1, Math.min(60, Number(width) || state.eraserWidth));
  return value === state.eraserWidth ? state : next(state, { eraserWidth: value });
}

export function setAutoMinimize(state, enabled) {
  return next(state, { autoMinimize: !!enabled });
}

export function setShapeKind(state, kind) {
  if (!SHAPE_ORDER.includes(kind)) return state;
  // 换形状顺手也把工具切过去：人是在形状那张卡片上点的，他要的显然是画那个。
  return kind === state.shapeKind && state.tool === SHAPE_TOOL
    ? state
    : next(state, { shapeKind: kind, tool: SHAPE_TOOL });
}

/** 填充色。空字符串是「别填」，那一排头一格就是它。 */
export function setShapeFill(state, colour) {
  const value = colour || null;
  return value === state.shapeFill ? state : next(state, { shapeFill: value });
}

export function isShape(state) {
  return state.tool === SHAPE_TOOL;
}

// ── cards ───────────────────────────────────────────────────────────────────

export function openCard(state, card) {
  // A card is anchored to the bar. There is no bar while dragging, and a puck
  // is too small to anchor one to without covering the corner it was parked in
  // to keep clear.
  if (state.phase !== TOOLBAR_PHASE.EXPANDED) return state;
  return next(state, { openCard: state.openCard === card ? CARDS.NONE : card });
}

export function closeCard(state) {
  return state.openCard === CARDS.NONE ? state : next(state, { openCard: CARDS.NONE });
}

export function isLasso(state) {
  return state.tool === LASSO_TOOL;
}

export function isEraser(state) {
  return state.tool === ERASER_TOOL;
}

/** The subset worth persisting; placement and tool choice both survive restart. */
export function serializeToolbarState(state) {
  // A yield is on loan. Writing the borrowed corner would let a list that
  // happened to be open at the last save decide where the bar lives next
  // launch — so what goes to disk is always the placement it is owed.
  // 顶上那一排收着时借住在左边的也是：写那一排里的位置（下次开机那一排还收着的话，
  // 它会再借住到左边去）。
  const placed = state.offRow
    ? { ...state.offRow, corner: null }
    : (state.yielded || state);
  return {
    edge: placed.edge,
    offset: placed.offset,
    corner: placed.corner,
    perch: placed.perch || null,
    perchX: placed.perch && Number.isFinite(placed.perchX) ? placed.perchX : null,
    tool: state.tool,
    color: state.color,
    width: state.width,
    opacity: state.opacity,
    // Every tool's own size and opacity, so they survive a restart and not just
    // a change of tool.
    byTool: Object.fromEntries(Object.entries(state.byTool || {})
      .map(([tool, v]) => [tool, { width: v.width, opacity: v.opacity }])),
    eraserMode: state.eraserMode,
    eraserWidth: state.eraserWidth,
    lassoShape: state.lassoShape,
    lassoMode: state.lassoMode,
    shapeKind: state.shapeKind,
    shapeFill: state.shapeFill,
    swatches: [...state.swatches],
    autoMinimize: state.autoMinimize,
  };
}
