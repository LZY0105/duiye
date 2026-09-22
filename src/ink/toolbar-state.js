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
    /** Corner-docked state is restorable, so the phase comes from `initial`. */
    phase: initial.corner && Object.values(CORNERS).includes(initial.corner)
      ? TOOLBAR_PHASE.DOCKED
      : TOOLBAR_PHASE.EXPANDED,
    corner: Object.values(CORNERS).includes(initial.corner) ? initial.corner : null,
    /** Transient token position while dragging, in viewport pixels. */
    dragPoint: null,
    /**
     * Set only while the bar has been folded away for something else — a deck
     * list it was covering. Holds the placement to give back, so a yield the
     * reader never asked for cannot become the placement they are left with.
     */
    yielded: null,

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
    dragPoint: point ? { x: point.x, y: point.y } : null,
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
export function endDrag(state, point, viewport) {
  if (state.phase !== TOOLBAR_PHASE.DRAGGING) return state;
  const release = point || state.dragPoint;
  if (!release || !viewport) {
    return next(state, { phase: TOOLBAR_PHASE.EXPANDED, dragPoint: null });
  }
  const { edge, offset } = nearestEdge(release, viewport);
  const corner = cornerOf(release, viewport);
  return next(state, {
    phase: corner ? TOOLBAR_PHASE.DOCKED : TOOLBAR_PHASE.EXPANDED,
    corner,
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
  return next(state, { phase: TOOLBAR_PHASE.EXPANDED, corner: null });
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
  return next(state, { phase: TOOLBAR_PHASE.DOCKED, corner, openCard: CARDS.NONE });
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
  const placed = state.yielded || state;
  return {
    edge: placed.edge,
    offset: placed.offset,
    corner: placed.corner,
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
    swatches: [...state.swatches],
    autoMinimize: state.autoMinimize,
  };
}
