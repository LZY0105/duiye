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
  OVERFLOW: 'overflow',
});

/** The eraser is a toolbar selection but not a stroke tool. */
export const ERASER_TOOL = 'eraser';

/** Four quick swatches, as observed in the reference layout. */
export const DEFAULT_SWATCHES = Object.freeze(['#111827', '#dc2626', '#2563eb', '#16a34a']);

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

export function createToolbarState(initial = {}) {
  const tool = initial.tool || INK_TOOLS.PEN;
  const defaults = TOOL_DEFAULTS[tool] || TOOL_DEFAULTS[INK_TOOLS.PEN];
  return Object.freeze({
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

    // ── ink tool state (must survive placement changes) ──
    tool,
    color: initial.color || DEFAULT_SWATCHES[0],
    width: Number.isFinite(initial.width) ? initial.width : defaults.width,
    opacity: Number.isFinite(initial.opacity) ? initial.opacity : defaults.opacity,
    eraserMode: initial.eraserMode === ERASER_MODES.REGION
      ? ERASER_MODES.REGION : ERASER_MODES.STROKE,
    eraserWidth: Number.isFinite(initial.eraserWidth) ? initial.eraserWidth : 8,
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
    dragPoint: point ? { x: point.x, y: point.y } : null,
  });
}

/** Token follows the pointer. Only dragPoint changes. */
export function moveDrag(state, point) {
  if (state.phase !== TOOLBAR_PHASE.DRAGGING || !point) return state;
  return next(state, { dragPoint: { x: point.x, y: point.y } });
}

/**
 * Release → snap to the nearest edge and re-expand.
 *
 * Only `edge`, `offset`, `phase` and `dragPoint` may change here. Every ink
 * parameter is carried through untouched, which is the acceptance requirement
 * that selections survive movement and reorientation.
 */
export function endDrag(state, point, viewport) {
  if (state.phase !== TOOLBAR_PHASE.DRAGGING) return state;
  const release = point || state.dragPoint;
  if (!release || !viewport) {
    return next(state, { phase: TOOLBAR_PHASE.EXPANDED, dragPoint: null });
  }
  const { edge, offset } = nearestEdge(release, viewport);
  return next(state, {
    phase: TOOLBAR_PHASE.EXPANDED,
    edge,
    offset,
    dragPoint: null,
  });
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

  const distances = [
    { edge: EDGES.LEFT, distance: x, offset: y / height },
    { edge: EDGES.RIGHT, distance: width - x, offset: y / height },
    { edge: EDGES.TOP, distance: y, offset: x / width },
    { edge: EDGES.BOTTOM, distance: height - y, offset: x / width },
  ];
  distances.sort((a, b) => a.distance - b.distance);
  const best = distances[0];
  return { edge: best.edge, offset: clamp01(best.offset) };
}

// ── tool state ──────────────────────────────────────────────────────────────

/** Selecting a stroke tool adopts that tool's default width. */
export function selectTool(state, tool) {
  if (tool === ERASER_TOOL) {
    return next(state, { tool: ERASER_TOOL, openCard: CARDS.NONE });
  }
  if (!Object.values(INK_TOOLS).includes(tool)) return state;
  const defaults = TOOL_DEFAULTS[tool];
  return next(state, {
    tool,
    width: defaults.width,
    opacity: defaults.opacity,
    openCard: CARDS.NONE,
  });
}

export function setColor(state, color) {
  if (!color || color === state.color) return state;
  return next(state, { color });
}

export function setWidth(state, width) {
  const value = Math.max(0.2, Math.min(40, Number(width) || state.width));
  return value === state.width ? state : next(state, { width: value });
}

export function setOpacity(state, opacity) {
  const value = clamp01(opacity);
  return value === state.opacity ? state : next(state, { opacity: value });
}

export function setEraserMode(state, mode) {
  const value = mode === ERASER_MODES.REGION ? ERASER_MODES.REGION : ERASER_MODES.STROKE;
  return next(state, { tool: ERASER_TOOL, eraserMode: value });
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
  if (state.phase === TOOLBAR_PHASE.DRAGGING) return state;
  return next(state, { openCard: state.openCard === card ? CARDS.NONE : card });
}

export function closeCard(state) {
  return state.openCard === CARDS.NONE ? state : next(state, { openCard: CARDS.NONE });
}

export function isEraser(state) {
  return state.tool === ERASER_TOOL;
}

/** The subset worth persisting; placement and tool choice both survive restart. */
export function serializeToolbarState(state) {
  return {
    edge: state.edge,
    offset: state.offset,
    tool: state.tool,
    color: state.color,
    width: state.width,
    opacity: state.opacity,
    eraserMode: state.eraserMode,
    eraserWidth: state.eraserWidth,
    swatches: [...state.swatches],
    autoMinimize: state.autoMinimize,
  };
}
