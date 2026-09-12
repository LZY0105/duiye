// Scratch Module — the camera over an endless surface (F05).
//
// The paper has no size. What is finite is the VIEWPORT, and the camera says
// which part of the world it is looking at: a world centre and a zoom, and
// nothing else. Panning moves the centre, zooming changes the scale, and there
// is no extent to run out of in any of the four directions — negative
// coordinates are ordinary coordinates.
//
// Pure and DOM-free, so the coordinate round trip that everything else depends
// on can be proven in Node: a point picked on screen, turned into world space,
// and turned back must land where it started at any zoom and any offset. Ink,
// eraser radius and lasso hit tests all read the same transform, so if that
// round trip holds for one it holds for all three.
//
// The centre is stored rather than a corner because the viewport changes size —
// a divider drag, a rotation, entering and leaving focus — and a centre
// survives all of those while a corner slides.

/** The zoom range the specification fixes: 25% to 400%. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/** Steps for the +/- controls, so a press always lands on a round number. */
const ZOOM_STEPS = Object.freeze([0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]);

/** Space left around the ink when fitting it all into view, in screen pixels. */
export const FIT_PADDING = 32;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export function createCamera(initial = {}) {
  return Object.freeze({
    x: finite(initial?.x, 0),
    y: finite(initial?.y, 0),
    zoom: clamp(finite(initial?.zoom, 1), ZOOM_MIN, ZOOM_MAX),
  });
}

/** The origin at 100% — where a new pad starts, and where Return to origin goes. */
export const ORIGIN_CAMERA = createCamera();

const next = (camera, patch) => Object.freeze({ ...camera, ...patch });

/**
 * The ink layer's transform for this camera and viewport.
 *
 * `offset` is the world coordinate sitting at the viewport's top-left corner,
 * which is the convention ink-renderer already uses: screen = (world - offset)
 * * scale. Deriving it here rather than storing it is what keeps the camera
 * independent of how big the pane happens to be.
 */
export function transformFor(camera, viewport) {
  const w = Math.max(1, viewport?.width || 1);
  const h = Math.max(1, viewport?.height || 1);
  return {
    scale: camera.zoom,
    offsetX: camera.x - (w / 2) / camera.zoom,
    offsetY: camera.y - (h / 2) / camera.zoom,
  };
}

export function screenToWorld(camera, viewport, screenX, screenY) {
  const t = transformFor(camera, viewport);
  return { x: screenX / t.scale + t.offsetX, y: screenY / t.scale + t.offsetY };
}

export function worldToScreen(camera, viewport, worldX, worldY) {
  const t = transformFor(camera, viewport);
  return { x: (worldX - t.offsetX) * t.scale, y: (worldY - t.offsetY) * t.scale };
}

/** The world rectangle currently on screen — what the background has to draw. */
export function visibleWorld(camera, viewport) {
  const topLeft = screenToWorld(camera, viewport, 0, 0);
  const w = Math.max(1, viewport?.width || 1);
  const h = Math.max(1, viewport?.height || 1);
  return {
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: topLeft.x + w / camera.zoom,
    maxY: topLeft.y + h / camera.zoom,
  };
}

/**
 * Drags the paper by a screen distance.
 *
 * The world moves the way the hand does, so the centre moves against it —
 * dragging right reveals what was off to the left. Divided by the zoom, because
 * the same finger travel covers less world the further in you are, which is
 * what makes the paper feel stuck to the hand rather than geared to it.
 *
 * There is no clamp. That is the feature: pan far enough in any direction and
 * you are simply somewhere else on the same sheet.
 */
export function panByScreen(camera, dxScreen, dyScreen) {
  if (!dxScreen && !dyScreen) return camera;
  return next(camera, {
    x: camera.x - dxScreen / camera.zoom,
    y: camera.y - dyScreen / camera.zoom,
  });
}

/**
 * Zooms while holding one screen point still.
 *
 * Which point is the whole feel of the gesture: a pinch holds the point between
 * the fingers, because that is what the hand is pointing at, while a button
 * press has no position and holds the middle of the frame. Zooming about the
 * centre during a pinch is what makes the paper slide out from under the
 * fingers.
 */
export function zoomAbout(camera, factor, viewport, screenX, screenY) {
  const target = clamp(camera.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  if (target === camera.zoom) return camera;

  const w = Math.max(1, viewport?.width || 1);
  const h = Math.max(1, viewport?.height || 1);
  const px = Number.isFinite(screenX) ? screenX : w / 2;
  const py = Number.isFinite(screenY) ? screenY : h / 2;

  // The world point under the anchor now, and where the new zoom would put it.
  // The centre moves by the difference, so it does not move at all on screen.
  const before = screenToWorld(camera, viewport, px, py);
  const moved = next(camera, { zoom: target });
  const after = screenToWorld(moved, viewport, px, py);
  return next(moved, { x: moved.x + (before.x - after.x), y: moved.y + (before.y - after.y) });
}

export function setZoom(camera, zoom, viewport, screenX, screenY) {
  const target = clamp(finite(zoom, camera.zoom), ZOOM_MIN, ZOOM_MAX);
  return zoomAbout(camera, target / camera.zoom, viewport, screenX, screenY);
}

export function zoomIn(camera, viewport) {
  const step = ZOOM_STEPS.find(z => z > camera.zoom + 1e-6);
  return setZoom(camera, step === undefined ? ZOOM_MAX : step, viewport);
}

export function zoomOut(camera, viewport) {
  const below = ZOOM_STEPS.filter(z => z < camera.zoom - 1e-6);
  return setZoom(camera, below.length ? below[below.length - 1] : ZOOM_MIN, viewport);
}

/** Back to (0,0) at 100%. It moves the camera; it never touches the ink. */
export function returnToOrigin() {
  return ORIGIN_CAMERA;
}

/**
 * Frames everything that has been written.
 *
 * An empty pad has no extent to frame, so it goes to the origin at 100% — the
 * one answer that is not a guess.
 *
 * When the ink is larger than the minimum zoom can show, the camera centres on
 * it at ZOOM_MIN and reports `fitted: false`. Nothing is discarded and nothing
 * outlying is cropped away; the caller says the area is bigger than the screen
 * and can be panned through, which is true, rather than silently showing part
 * of it as though it were all of it.
 *
 * @returns {{camera: Object, fitted: boolean, empty: boolean}}
 */
export function fitToBounds(bounds, viewport, padding = FIT_PADDING) {
  if (!bounds || !Number.isFinite(bounds.minX)) {
    return { camera: ORIGIN_CAMERA, fitted: true, empty: true };
  }
  const w = Math.max(1, viewport?.width || 1);
  const h = Math.max(1, viewport?.height || 1);
  const centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };

  // Width and height in world units, never zero: a single dot still deserves a
  // sensible zoom rather than a division that runs away to infinity.
  const worldW = Math.max(1e-3, bounds.maxX - bounds.minX);
  const worldH = Math.max(1e-3, bounds.maxY - bounds.minY);
  // The padding is in SCREEN pixels, so it is taken off the viewport before the
  // ratio — that way the margin stays 32px whatever the resulting zoom is.
  const usableW = Math.max(1, w - padding * 2);
  const usableH = Math.max(1, h - padding * 2);

  const wanted = Math.min(usableW / worldW, usableH / worldH);
  const zoom = clamp(wanted, ZOOM_MIN, ZOOM_MAX);
  return {
    camera: createCamera({ ...centre, zoom }),
    fitted: wanted >= ZOOM_MIN,
    empty: false,
  };
}

/** Two cameras are the same when the reader could not tell them apart. */
export function sameCamera(a, b) {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 1e-6
    && Math.abs(a.y - b.y) < 1e-6
    && Math.abs(a.zoom - b.zoom) < 1e-9;
}

/** The reader's number: 100% is the world's own scale. */
export function displayZoom(camera) {
  return Math.round(camera.zoom * 100);
}

export function serializeCamera(camera) {
  return { x: camera.x, y: camera.y, zoom: camera.zoom };
}
