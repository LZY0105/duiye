#!/usr/bin/env node
// Infinite scratch surface tests (F05, F11).
//
// Two things are proven here, both without a browser.
//
// The camera: a point picked on screen, turned into world space and turned back
// lands where it started, at any zoom and any distance from the origin —
// including a long way into negative coordinates. Ink, eraser radius and lasso
// hit tests all read that one transform, so the round trip holding for a point
// is the whole coordinate guarantee.
//
// The background: guides are anchored to the world origin and drawn only for
// the visible region, so panning cannot make them drift under the strokes
// written on them, and zooming out thins the grid by whole powers of two
// instead of shifting it.

import assert from 'node:assert/strict';

import {
  FIT_PADDING,
  ORIGIN_CAMERA,
  ZOOM_MAX,
  ZOOM_MIN,
  createCamera,
  displayZoom,
  fitToBounds,
  panByScreen,
  sameCamera,
  screenToWorld,
  transformFor,
  visibleWorld,
  worldToScreen,
  zoomAbout,
  zoomIn,
  zoomOut,
  setZoom,
} from '../src/scratch/scratch-camera.js';

import { drawScratchBackground } from '../src/scratch/scratch-background.js';
import { PATTERNS, TONES, createScratchStyle, guideSpacing, paperColor } from '../src/scratch/scratch-style.js';

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function group(n) { console.log(`\n─── [${n}] ───`); }
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

const VIEW = { width: 1280, height: 800 };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Scratch Surface Tests — four directions, no edge, one transform');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. The camera and its coordinates');

check('a new pad looks at the origin at 100%', () => {
  assert.deepEqual({ ...ORIGIN_CAMERA }, { x: 0, y: 0, zoom: 1 });
  assert.equal(displayZoom(ORIGIN_CAMERA), 100);
});

check('the world centre is at the centre of the viewport', () => {
  const p = worldToScreen(ORIGIN_CAMERA, VIEW, 0, 0);
  assert.ok(near(p.x, VIEW.width / 2) && near(p.y, VIEW.height / 2));
});

check('screen → world → screen is the identity, everywhere it is asked', () => {
  const cameras = [
    createCamera(),
    createCamera({ x: 940, y: -1320, zoom: 0.25 }),
    createCamera({ x: -18400, y: 27311.5, zoom: 4 }),
    createCamera({ x: -7.25, y: 0.5, zoom: 1.37 }),
  ];
  for (const camera of cameras) {
    for (const [sx, sy] of [[0, 0], [1280, 800], [640, 400], [3, 797], [1279.5, 0.25]]) {
      const w = screenToWorld(camera, VIEW, sx, sy);
      const back = worldToScreen(camera, VIEW, w.x, w.y);
      assert.ok(near(back.x, sx, 1e-6) && near(back.y, sy, 1e-6),
        `${sx},${sy} at zoom ${camera.zoom} came back as ${back.x},${back.y}`);
    }
  }
});

check('negative coordinates are ordinary coordinates', () => {
  const camera = createCamera({ x: -5000, y: -9000, zoom: 0.5 });
  const world = visibleWorld(camera, VIEW);
  assert.ok(world.minX < -5000 && world.maxX > -5000);
  assert.ok(world.minY < -9000 && world.maxY > -9000);
  const p = worldToScreen(camera, VIEW, -5000, -9000);
  assert.ok(near(p.x, 640) && near(p.y, 400), 'the centre is where it is looking');
});

check('travelling twenty viewports in each direction runs into nothing', () => {
  let camera = createCamera();
  const step = VIEW.width;                       // one screen at a time
  for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
    let c = camera;
    for (let i = 0; i < 20; i++) c = panByScreen(c, dx, dy);
    const travelled = Math.abs(dx ? c.x : c.y);
    assert.ok(near(travelled, 20 * step), `${travelled} world units travelled`);
    assert.equal(c.zoom, 1, 'panning never changes the zoom');
  }
});

check('a pan moves the paper with the hand, not against it', () => {
  const camera = panByScreen(createCamera(), 100, 0);
  // Dragging right reveals what was off to the left, so the centre moves left.
  assert.equal(camera.x, -100);
});

check('panning covers less world the further in you are', () => {
  const far = panByScreen(createCamera({ zoom: 0.5 }), 100, 0);
  const close = panByScreen(createCamera({ zoom: 4 }), 100, 0);
  assert.equal(far.x, -200);
  assert.equal(close.x, -25, 'the paper stays stuck to the hand at every zoom');
});

// ═══════════════════════════════════════════════════════════════
group('2. Zoom');

check('the range is 25% to 400% and nothing outside it', () => {
  assert.equal(ZOOM_MIN, 0.25);
  assert.equal(ZOOM_MAX, 4);
  assert.equal(setZoom(createCamera(), 0.01, VIEW).zoom, ZOOM_MIN);
  assert.equal(setZoom(createCamera(), 99, VIEW).zoom, ZOOM_MAX);
  assert.equal(createCamera({ zoom: 100 }).zoom, ZOOM_MAX);
});

check('a pinch holds the point between the fingers still', () => {
  const camera = createCamera({ x: 300, y: -120, zoom: 1 });
  const anchor = { x: 210, y: 675 };            // nowhere near the centre
  const before = screenToWorld(camera, VIEW, anchor.x, anchor.y);

  let zoomed = zoomAbout(camera, 2.4, VIEW, anchor.x, anchor.y);
  let after = worldToScreen(zoomed, VIEW, before.x, before.y);
  assert.ok(near(after.x, anchor.x, 1e-6) && near(after.y, anchor.y, 1e-6),
    'the world point under the fingers has not moved on screen');

  // And back out again about the same point.
  zoomed = zoomAbout(zoomed, 1 / 2.4, VIEW, anchor.x, anchor.y);
  assert.ok(sameCamera(zoomed, camera), 'zooming in and out returns to where it was');
});

check('a button press with no position of its own holds the middle', () => {
  const camera = createCamera({ x: 40, y: 90, zoom: 1 });
  const zoomed = zoomIn(camera, VIEW);
  assert.ok(zoomed.zoom > camera.zoom);
  assert.ok(near(zoomed.x, camera.x) && near(zoomed.y, camera.y),
    'the centre stays the centre');
});

check('stepping in and out lands on round numbers', () => {
  let c = createCamera();
  c = zoomIn(c, VIEW); assert.equal(c.zoom, 1.5);
  c = zoomIn(c, VIEW); assert.equal(c.zoom, 2);
  c = zoomOut(c, VIEW); assert.equal(c.zoom, 1.5);
  c = zoomOut(zoomOut(zoomOut(zoomOut(c, VIEW), VIEW), VIEW), VIEW);
  assert.equal(c.zoom, ZOOM_MIN, 'and stop at the end rather than wrapping');
});

check('zooming at the limit is a no-op, not a jitter', () => {
  const at = createCamera({ x: 12, y: 34, zoom: ZOOM_MAX });
  assert.equal(zoomAbout(at, 2, VIEW, 10, 10), at, 'the same object comes back');
});

// ═══════════════════════════════════════════════════════════════
group('3. Return to origin, and fit all ink');

check('return to origin centres (0,0) at 100%', () => {
  const camera = createCamera({ x: 9000, y: -4000, zoom: 3.5 });
  const home = fitToBounds(null, VIEW).camera;
  assert.deepEqual({ ...home }, { x: 0, y: 0, zoom: 1 });
  assert.notEqual(camera.x, home.x);
});

check('an empty pad fits to the origin at 100%, and says it is empty', () => {
  const r = fitToBounds(null, VIEW);
  assert.equal(r.empty, true);
  assert.equal(r.fitted, true);
  assert.deepEqual({ ...r.camera }, { x: 0, y: 0, zoom: 1 });
});

check('fitting frames the ink and leaves a margin round it', () => {
  const bounds = { minX: -200, minY: -100, maxX: 200, maxY: 100 };
  const r = fitToBounds(bounds, VIEW);
  assert.equal(r.fitted, true);
  assert.ok(near(r.camera.x, 0) && near(r.camera.y, 0), 'centred on the ink');

  const topLeft = worldToScreen(r.camera, VIEW, bounds.minX, bounds.minY);
  const bottomRight = worldToScreen(r.camera, VIEW, bounds.maxX, bounds.maxY);
  assert.ok(topLeft.x >= FIT_PADDING - 1e-6 && topLeft.y >= FIT_PADDING - 1e-6,
    'nothing is against the edge');
  assert.ok(bottomRight.x <= VIEW.width - FIT_PADDING + 1e-6);
  assert.ok(bottomRight.y <= VIEW.height - FIT_PADDING + 1e-6);
});

check('ink off in one corner is framed there, not at the origin', () => {
  const bounds = { minX: 4000, minY: -9000, maxX: 4400, maxY: -8800 };
  const r = fitToBounds(bounds, VIEW);
  assert.ok(near(r.camera.x, 4200) && near(r.camera.y, -8900));
});

check('a single dot gets a sensible zoom rather than an infinite one', () => {
  const r = fitToBounds({ minX: 7, minY: 7, maxX: 7, maxY: 7 }, VIEW);
  assert.equal(r.camera.zoom, ZOOM_MAX, 'clamped, not runaway');
  assert.ok(Number.isFinite(r.camera.x) && Number.isFinite(r.camera.y));
});

check('ink too large for the minimum zoom is reported, never cropped away', () => {
  const bounds = { minX: -40000, minY: -30000, maxX: 40000, maxY: 30000 };
  const r = fitToBounds(bounds, VIEW);
  assert.equal(r.fitted, false, 'the caller must say the area can be panned through');
  assert.equal(r.camera.zoom, ZOOM_MIN, 'and it shows as much of it as it can');
  assert.ok(near(r.camera.x, 0) && near(r.camera.y, 0), 'centred on what there is');
});

// ═══════════════════════════════════════════════════════════════
group('4. Guides are drawn on the same camera as the ink');

/**
 * A context that records what was asked of it, in CSS pixels.
 *
 * `segments` carries the colour each line was drawn in, which is how the
 * level-of-detail tests tell a full-strength guide from one that is fading in.
 */
function recordingContext() {
  const calls = {
    moveTo: [], lineTo: [], rect: [], fillRect: [], strokes: [], fills: [], segments: [],
  };
  let strokeStyle = null;
  let fillStyle = null;
  let cursor = null;
  return {
    calls,
    get strokeStyle() { return strokeStyle; },
    set strokeStyle(v) { strokeStyle = v; },
    get fillStyle() { return fillStyle; },
    set fillStyle(v) { fillStyle = v; },
    lineWidth: 1,
    lineCap: 'butt',
    setTransform() {}, scale() {}, save() {}, restore() {}, setLineDash() {},
    beginPath() {},
    closePath() {},
    moveTo(x, y) { calls.moveTo.push([x, y]); cursor = [x, y]; },
    lineTo(x, y) {
      calls.lineTo.push([x, y]);
      if (cursor) {
        calls.segments.push({ x0: cursor[0], y0: cursor[1], x1: x, y1: y, style: strokeStyle });
      }
    },
    rect(x, y, w, h) { calls.rect.push([x, y, w, h]); },
    fillRect(x, y, w, h) { calls.fillRect.push([x, y, w, h, fillStyle]); },
    stroke() { calls.strokes.push(strokeStyle); },
    fill() { calls.fills.push(fillStyle); },
  };
}

/** The alpha a recorded rgba() colour was drawn at. */
const alphaOf = (style) => Number(/([\d.]+)\)\s*$/.exec(style || '')?.[1] ?? 0);

const draw = (style, camera, viewport = VIEW) => {
  const ctx = recordingContext();
  drawScratchBackground(ctx, { style: createScratchStyle(style), camera, viewport, dpr: 2 });
  return ctx.calls;
};

check('plain paper is a fill and nothing else', () => {
  const calls = draw({ patternId: PATTERNS.PLAIN, paperTone: TONES.IVORY }, ORIGIN_CAMERA);
  assert.equal(calls.fillRect.length, 1, 'the paper itself');
  assert.equal(calls.fillRect[0][4], paperColor({ paperTone: TONES.IVORY }));
  assert.equal(calls.moveTo.length, 0, 'no guides to draw');
  assert.equal(calls.rect.length, 0);
});

check('every pattern paints the paper first, edge to edge', () => {
  for (const patternId of Object.values(PATTERNS)) {
    const calls = draw({ patternId }, ORIGIN_CAMERA);
    assert.deepEqual(calls.fillRect[0].slice(0, 4), [0, 0, VIEW.width, VIEW.height],
      `${patternId} fills the viewport`);
  }
});

check('no guide is ever drawn at a coordinate that is not a number', () => {
  for (const patternId of Object.values(PATTERNS)) {
    for (const zoom of [ZOOM_MIN, 0.4, 1, 2.5, ZOOM_MAX]) {
      const camera = createCamera({ x: -3312.5, y: 918.25, zoom });
      const calls = draw({ patternId }, camera);
      for (const list of [calls.moveTo, calls.lineTo, calls.rect]) {
        for (const args of list) {
          for (const n of args) {
            assert.ok(Number.isFinite(n), `${patternId} at ${zoom} emitted ${n}`);
          }
        }
      }
    }
  }
});

check('a ruled line sits exactly where the camera says the world line is', () => {
  const style = createScratchStyle({ patternId: PATTERNS.RULED });
  const camera = createCamera({ x: 137.5, y: -62.25, zoom: 1.75 });
  const calls = draw(style, camera);
  const spacing = guideSpacing(style);

  // Every horizontal guide must land on the screen y of a world multiple.
  const expected = new Set();
  const world = visibleWorld(camera, VIEW);
  for (let k = Math.ceil(world.minY / spacing); k * spacing <= world.maxY; k++) {
    expected.add(Math.round(worldToScreen(camera, VIEW, 0, k * spacing).y * 100) / 100);
  }
  assert.ok(expected.size > 3, 'there are lines to check');
  for (const [, y] of calls.moveTo) {
    assert.ok(expected.has(Math.round(y * 100) / 100), `a guide appeared at y=${y}`);
  }
});

check('guides are anchored to the world origin, so a pan cannot shift them', () => {
  const style = { patternId: PATTERNS.SQUARE };
  const spacing = guideSpacing(createScratchStyle(style));
  // Pan by a whole number of grid cells: the picture must be identical.
  const a = draw(style, createCamera({ x: 0, y: 0, zoom: 1 }));
  const b = draw(style, createCamera({ x: spacing * 7, y: spacing * 3, zoom: 1 }));
  assert.deepEqual(
    a.moveTo.map(p => p.map(v => Math.round(v * 1000))),
    b.moveTo.map(p => p.map(v => Math.round(v * 1000))),
    'the grid is a property of the world, not of where you are standing',
  );
});

/**
 * The world x of every vertical guide the renderer drew at full strength.
 *
 * Read back through the camera rather than counted: what matters is not how
 * many lines there are — zooming out shows more world, so of course there are
 * more — but that the ones drawn are always the same world lines, spaced
 * readably on screen.
 */
function fullStrengthColumns(style, camera) {
  const calls = draw(style, camera);
  // The firmest colour used is the full-strength one; anything drawn fainter is
  // the finer family fading in, and is not part of the grid being measured.
  const strongest = Math.max(...calls.segments.map(s => alphaOf(s.style)));
  const columns = new Set();
  for (const seg of calls.segments) {
    if (alphaOf(seg.style) < strongest - 1e-9) continue;
    if (Math.abs(seg.x1 - seg.x0) > 1e-6) continue;          // horizontals
    columns.add(Math.round(screenToWorld(camera, VIEW, seg.x0, seg.y0).x * 1e6) / 1e6);
  }
  return [...columns];
}

check('the grid stays readable on screen at every zoom, and never shifts', () => {
  const style = { patternId: PATTERNS.SQUARE };
  const spacing = guideSpacing(createScratchStyle(style));

  let previous = null;
  for (const zoom of [ZOOM_MAX, 3, 2, 1.5, 1, 0.75, 0.5, 0.35, ZOOM_MIN]) {
    const camera = createCamera({ zoom });
    const columns = fullStrengthColumns(style, camera).sort((a, b) => a - b);
    assert.ok(columns.length > 2, `there are guides at ${zoom}`);

    // Every guide is a line of the base grid: the grid thins, it never moves.
    for (const x of columns) {
      const k = x / spacing;
      assert.ok(Math.abs(k - Math.round(k)) < 1e-6,
        `a guide at world ${x} is not on the ${spacing}-unit grid`);
    }

    // And what is left is far enough apart on screen to read as a guide.
    const gapWorld = columns[1] - columns[0];
    const gapScreen = gapWorld * zoom;
    assert.ok(gapScreen >= 10.9,
      `at ${zoom} the guides are ${gapScreen.toFixed(1)}px apart, which is a tint`);

    // Thinning is by doubling, so a coarser level is a subset of a finer one.
    if (previous && gapWorld > previous.gapWorld) {
      const ratio = gapWorld / previous.gapWorld;
      assert.ok(Math.abs(ratio - Math.round(ratio)) < 1e-6 && Math.log2(ratio) % 1 === 0,
        `spacing went from ${previous.gapWorld} to ${gapWorld}, which is not a doubling`);
    }
    previous = { gapWorld };
  }
});

check('a grid never runs away with the main thread, however far out', () => {
  for (const zoom of [ZOOM_MIN, 0.3, 0.5]) {
    const calls = draw({ patternId: PATTERNS.MIZI, spacingPreset: 'compact' },
      createCamera({ zoom }));
    assert.ok(calls.moveTo.length < 3000,
      `${calls.moveTo.length} segments at ${zoom} is bounded`);
  }
});

check('the Cartesian axes are drawn once, at the origin, and only when in view', () => {
  const style = { patternId: PATTERNS.CARTESIAN };
  const atOrigin = draw(style, createCamera({ x: 0, y: 0, zoom: 1 }));
  const axisColours = atOrigin.strokes.filter(s => /0\.(2[5-9]|[3-9])/.test(s || ''));
  assert.ok(axisColours.length >= 1, 'the axes are stroked in their own, firmer colour');

  // A long way from the origin there are no axes at all — the origin is a
  // place, not a corner of the screen.
  const away = draw(style, createCamera({ x: 90000, y: 90000, zoom: 1 }));
  assert.ok(away.moveTo.length > 0, 'there is still a grid');
  assert.equal(away.strokes.length, atOrigin.strokes.length - 2,
    'and exactly two fewer strokes: the two axes');
});

check('dots are drawn as one path of marks, not thousands of arcs', () => {
  const calls = draw({ patternId: PATTERNS.DOTS }, ORIGIN_CAMERA);
  assert.ok(calls.rect.length > 100, 'there are dots');
  assert.ok(calls.fills.length <= 4, 'and only a handful of fill calls to place them');
});

check('the two handwriting grids keep their cell walls and drop the inner guides first', () => {
  // Zoomed out far enough that a cell is small, the walls survive and the
  // dashed centre lines and diagonals go. A 田字格 with lines missing out of the
  // middle of each cell is still a 田字格; one with holes in the walls is not.
  const tight = draw({ patternId: PATTERNS.MIZI, spacingPreset: 'compact' },
    createCamera({ zoom: ZOOM_MIN }));
  const roomy = draw({ patternId: PATTERNS.MIZI, spacingPreset: 'spacious' },
    createCamera({ zoom: 2 }));
  assert.ok(tight.moveTo.length > 0, 'the walls are still there');
  assert.ok(roomy.strokes.length > tight.strokes.length,
    'the inner guides come back once there is room for them');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
