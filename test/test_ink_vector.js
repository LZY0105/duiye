#!/usr/bin/env node
// Vector Ink tests (spec P0-08).
//
// The four acceptance criteria are:
//   1. no stroke distortion at high zoom  → geometry is stored, not pixels
//   2. erasing does not damage the PDF    → erase removes data from the ink layer
//   3. save/reopen and keep editing       → round-trips as editable strokes
//   4. 100 undo/redo cycles stay consistent
//
// The model, layer, history and eraser are pure so all four are provable here
// without a canvas or a DOM.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INK_TOOLS,
  appendPoint,
  createStroke,
  deserializeStroke,
  isDrawable,
  pointInPolygon,
  recomputeBounds,
  serializeStroke,
  strokeHitByPoint,
  strokeIntersectsPolygon,
} from '../src/ink/stroke.js';
import { InkLayer } from '../src/ink/ink-layer.js';
import { InkHistory } from '../src/ink/ink-history.js';
import {
  boundsCentre,
  polygonBounds,
  selectionBounds,
  transformPolygon,
  snapshotStrokes,
  transformSelection,
} from '../src/ink/ink-selection.js';
import {
  ERASER_MODES,
  eraseArea,
  eraseStrokes,
  strokeIdsAlongPath,
  strokeIdsAtPoint,
  strokeIdsInRegion,
} from '../src/ink/ink-eraser.js';
import {
  createTransform,
  documentToScreen,
  screenToDocument,
} from '../src/ink/ink-renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const $read = (f) => readFileSync(join(ROOT, f), 'utf-8');

/**
 * Source text with comments removed.
 *
 * Every "this file must not contain X" assertion below runs against this, not
 * the raw source: the comments explaining what the old bitmap implementation
 * did quote the very identifiers being banned, and matching prose instead of
 * code makes the guard useless.
 */
const $code = (f) => $read(f)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function ok(c, l, d) { if (c) pass(l); else fail(l, d); }
function group(n) { console.log(`\n─── [${n}] ───`); }
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

/** Builds a stroke through the given document-space points. */
function strokeThrough(points, opts = {}) {
  const s = createStroke(opts);
  for (const [x, y] of points) appendPoint(s, x, y, 0.5, 0);
  return s;
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Vector Ink Tests — strokes, layers, erasers, history');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. Stroke model — vector, not pixels');

check('a stroke stores points, never image data', () => {
  const s = strokeThrough([[0, 0], [10, 10], [20, 5]]);
  assert.equal(s.points.length, 3);
  assert.deepEqual(s.points[1], { x: 10, y: 10, p: 0.5 });
  assert.ok(!('imageData' in s));
});

check('bounds are maintained incrementally and account for width', () => {
  const s = strokeThrough([[10, 10], [20, 30]], { width: 4 });
  assert.equal(s.bounds.minX, 8);   // 10 - halfWidth(2)
  assert.equal(s.bounds.maxY, 32);  // 30 + 2
  const before = { ...s.bounds };
  recomputeBounds(s);
  assert.deepEqual({ ...s.bounds }, before, 'recompute must agree with incremental');
});

check('duplicate samples below the distance threshold are dropped', () => {
  const s = createStroke();
  assert.equal(appendPoint(s, 0, 0, 0.5), true);
  assert.equal(appendPoint(s, 0.1, 0.1, 0.5), false, 'too close, should be skipped');
  assert.equal(appendPoint(s, 5, 5, 0.5), true);
  assert.equal(s.points.length, 2);
});

check('a single tap is still drawable (a dot, not nothing)', () => {
  const s = createStroke();
  appendPoint(s, 3, 4, 0.5);
  assert.equal(isDrawable(s), true);
});

// ═══════════════════════════════════════════════════════════════
group('2. Lossless zoom — criterion 1');

check('document→screen→document round-trips at any scale', () => {
  for (const scale of [0.25, 1, 2.5, 6]) {
    const t = createTransform(scale, 13.5, -7.25);
    const screen = documentToScreen(t, 123.75, 456.5);
    const back = screenToDocument(t, screen.x, screen.y);
    assert.ok(Math.abs(back.x - 123.75) < 1e-9, `x at scale ${scale}`);
    assert.ok(Math.abs(back.y - 456.5) < 1e-9, `y at scale ${scale}`);
  }
});

check('stored geometry is independent of the zoom it was drawn at', () => {
  // Same screen gesture, captured at 1x and at 6x, must store the same doc-space
  // stroke — that is what makes a later zoom re-render sharp rather than resampled.
  const gesture = [[100, 200], [140, 260], [180, 300]];
  const at1x = createTransform(1, 0, 0);
  const at6x = createTransform(6, 0, 0);

  const drawnAt1x = strokeThrough(gesture.map(([x, y]) => {
    const d = screenToDocument(at1x, x, y);
    return [d.x, d.y];
  }));
  const drawnAt6x = strokeThrough(gesture.map(([x, y]) => {
    const d = screenToDocument(at6x, x * 6, y * 6);
    return [d.x, d.y];
  }));

  drawnAt1x.points.forEach((pt, i) => {
    assert.ok(Math.abs(pt.x - drawnAt6x.points[i].x) < 1e-9);
    assert.ok(Math.abs(pt.y - drawnAt6x.points[i].y) < 1e-9);
  });
});

check('serialisation keeps enough precision to be invisible on screen', () => {
  const s = strokeThrough([[10.123456, 20.987654]]);
  const back = deserializeStroke(serializeStroke(s));
  // Rounded to 0.01 document units; at 6x zoom that is 0.06 device px.
  assert.ok(Math.abs(back.points[0].x - 10.123456) <= 0.005);
  assert.ok(Math.abs(back.points[0].y - 20.987654) <= 0.005);
});

// ═══════════════════════════════════════════════════════════════
group('3. Layer — ordering and z-order stability');

check('strokes keep insertion (paint) order', () => {
  const layer = new InkLayer();
  const a = strokeThrough([[0, 0]]);
  const b = strokeThrough([[1, 1]]);
  const c = strokeThrough([[2, 2]]);
  [a, b, c].forEach(s => layer.add(s));
  assert.deepEqual(layer.getAll().map(s => s.id), [a.id, b.id, c.id]);
});

check('removal reports the original index so undo can restore z-order', () => {
  const layer = new InkLayer();
  const strokes = [0, 1, 2, 3].map(i => strokeThrough([[i, i]]));
  strokes.forEach(s => layer.add(s));
  const removed = layer.removeByIds([strokes[1].id, strokes[2].id]);
  assert.deepEqual(removed.map(r => r.index), [1, 2]);
  layer.restore(removed);
  assert.deepEqual(layer.getAll().map(s => s.id), strokes.map(s => s.id));
});

check('layer bounds are the union of stroke bounds', () => {
  const layer = new InkLayer();
  layer.add(strokeThrough([[0, 0]], { width: 2 }));      // radius 1
  layer.add(strokeThrough([[100, 50]], { width: 2 }));
  const b = layer.bounds();
  assert.equal(b.minX, -1);
  assert.equal(b.maxX, 101);
  assert.equal(b.maxY, 51);
});

check('a hairline stroke still has a hittable body', () => {
  // Bounds are inflated by a minimum half-width, so a 0-width stroke is not a
  // zero-area target the eraser could never touch.
  const s = strokeThrough([[10, 10]], { width: 0 });
  assert.equal(s.bounds.minX, 9.5);
  assert.equal(s.bounds.maxX, 10.5);
  assert.equal(strokeHitByPoint(s, 10.2, 10, 0), true);
});

// ═══════════════════════════════════════════════════════════════
group('4. Erasers — criterion 2');

check('stroke eraser removes a whole stroke it touches', () => {
  const layer = new InkLayer();
  const line = strokeThrough([[0, 0], [100, 0]], { width: 2 });
  const far = strokeThrough([[0, 500], [100, 500]], { width: 2 });
  layer.add(line);
  layer.add(far);

  assert.deepEqual(strokeIdsAtPoint(layer, 50, 0, 5), [line.id]);
  assert.deepEqual(strokeIdsAtPoint(layer, 50, 300, 5), []);
});

check('a fast eraser swipe does not skip strokes between samples', () => {
  const layer = new InkLayer();
  // Vertical strokes every 10 units; a swipe sampled only at the ends would
  // miss every one in between.
  const ids = [];
  for (let x = 0; x <= 100; x += 10) {
    const s = strokeThrough([[x, -5], [x, 5]], { width: 1 });
    layer.add(s);
    ids.push(s.id);
  }
  const hit = strokeIdsAlongPath(layer, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 3);
  assert.equal(hit.length, ids.length, 'every crossed stroke must be hit');
});

check('region eraser removes strokes inside a lasso', () => {
  const layer = new InkLayer();
  const inside = strokeThrough([[10, 10], [20, 20]]);
  const outside = strokeThrough([[200, 200], [210, 210]]);
  layer.add(inside);
  layer.add(outside);

  const box = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
  assert.deepEqual(strokeIdsInRegion(layer, box), [inside.id]);
});

check('requireFullyInside excludes strokes that trail outside the lasso', () => {
  const layer = new InkLayer();
  const straddling = strokeThrough([[10, 10], [400, 400]]);
  layer.add(straddling);
  const box = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
  assert.deepEqual(strokeIdsInRegion(layer, box), [straddling.id]);
  assert.deepEqual(strokeIdsInRegion(layer, box, { requireFullyInside: true }), []);
});

check('point-in-polygon handles concave shapes', () => {
  // An L shape; the notch must read as outside.
  const L = [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 },
    { x: 10, y: 10 }, { x: 10, y: 40 }, { x: 0, y: 40 },
  ];
  assert.equal(pointInPolygon(5, 5, L), true);
  assert.equal(pointInPolygon(30, 30, L), false);
});

check('erasing is a data removal, recorded for undo', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  const s = strokeThrough([[0, 0], [10, 10]]);
  layer.add(s);

  const removed = eraseStrokes(layer, history, [s.id]);
  assert.equal(removed.length, 1);
  assert.equal(layer.length, 0);
  assert.equal(history.canUndo(), true);
  history.undo();
  assert.equal(layer.length, 1, 'erase must be reversible');
});

// The eraser must never composite onto a shared canvas — that is how a bitmap
// eraser destroys the page underneath it.
const eraserCode = $code('src/ink/ink-eraser.js');
ok(
  !/destination-out|clearRect|fillStyle|globalCompositeOperation/.test(eraserCode),
  'eraser never paints — it only removes strokes from the ink layer',
);
ok(
  !/pdf|canvas/i.test(eraserCode),
  'eraser code holds no reference to a PDF or a canvas',
);

// ═══════════════════════════════════════════════════════════════
group('5. History — criterion 4');

check('undo/redo of a single add', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  const s = strokeThrough([[0, 0], [5, 5]]);
  history.recordAdd(s, layer.add(s));

  assert.equal(layer.length, 1);
  history.undo();
  assert.equal(layer.length, 0);
  history.redo();
  assert.equal(layer.length, 1);
  assert.equal(layer.getAll()[0].id, s.id);
});

check('a new operation clears the redo branch', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  const a = strokeThrough([[0, 0]]);
  history.recordAdd(a, layer.add(a));
  history.undo();
  assert.equal(history.canRedo(), true);

  const b = strokeThrough([[9, 9]]);
  history.recordAdd(b, layer.add(b));
  assert.equal(history.canRedo(), false);
});

check('100 undo/redo cycles leave state exactly consistent', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);

  // Build a mixed history: adds, a region erase, more adds, a clear.
  const created = [];
  for (let i = 0; i < 12; i++) {
    const s = strokeThrough([[i * 10, 0], [i * 10, 20]]);
    created.push(s);
    history.recordAdd(s, layer.add(s));
  }
  const box = [{ x: 25, y: -5 }, { x: 65, y: -5 }, { x: 65, y: 25 }, { x: 25, y: 25 }];
  eraseStrokes(layer, history, strokeIdsInRegion(layer, box));
  for (let i = 0; i < 5; i++) {
    const s = strokeThrough([[500 + i, 100], [510 + i, 120]]);
    history.recordAdd(s, layer.add(s));
  }

  const snapshot = () => layer.getAll().map(s => s.id).join(',');
  const settled = snapshot();
  const depth = history.depth.undo;

  for (let cycle = 0; cycle < 100; cycle++) {
    let undone = 0;
    while (history.undo()) undone++;
    assert.equal(layer.length, 0, `cycle ${cycle}: full undo must empty the layer`);
    assert.equal(undone, depth, `cycle ${cycle}: undo count must match history depth`);

    let redone = 0;
    while (history.redo()) redone++;
    assert.equal(redone, depth, `cycle ${cycle}: redo count must match`);
    assert.equal(snapshot(), settled, `cycle ${cycle}: state (and z-order) must match`);
  }
});

check('history stores operations, never framebuffers', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  const s = strokeThrough([[0, 0], [1, 1]]);
  history.recordAdd(s, layer.add(s));
  const op = history.undoStack[0];
  assert.equal(op.type, 'add');
  assert.ok(op.stroke && Array.isArray(op.stroke.points));
  assert.ok(!('imageData' in op) && !('snapshot' in op));
});

check('history depth is bounded so long sessions cannot grow without limit', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer, { limit: 10 });
  for (let i = 0; i < 50; i++) {
    const s = strokeThrough([[i, i]]);
    history.recordAdd(s, layer.add(s));
  }
  assert.equal(history.depth.undo, 10);
});

// ═══════════════════════════════════════════════════════════════
group('6. Persistence — criterion 3');

check('a layer round-trips through serialisation as editable strokes', () => {
  const layer = new InkLayer();
  const pen = strokeThrough([[0, 0], [10, 10], [20, 30]], { tool: INK_TOOLS.PEN, color: '#123456', width: 3 });
  const hl = strokeThrough([[5, 5], [50, 5]], { tool: INK_TOOLS.HIGHLIGHTER });
  layer.add(pen);
  layer.add(hl);

  const restored = InkLayer.deserialize(JSON.parse(JSON.stringify(layer.serialize())));
  assert.equal(restored.length, 2);
  assert.equal(restored.getAll()[0].tool, INK_TOOLS.PEN);
  assert.equal(restored.getAll()[0].color, '#123456');
  assert.equal(restored.getAll()[0].width, 3);
  assert.equal(restored.getAll()[1].tool, INK_TOOLS.HIGHLIGHTER);

  // Still editable: bounds are rebuilt, so hit-testing and erasing work.
  assert.ok(restored.getAll()[0].bounds);
  const hit = strokeIdsAtPoint(restored, 10, 10, 4);
  assert.equal(hit.length >= 1, true, 'restored strokes must be erasable');
});

check('erasing after a reload removes the restored stroke', () => {
  const layer = new InkLayer();
  layer.add(strokeThrough([[0, 0], [100, 0]], { width: 2 }));
  const restored = InkLayer.deserialize(JSON.parse(JSON.stringify(layer.serialize())));
  const history = new InkHistory(restored);
  eraseStrokes(restored, history, strokeIdsAtPoint(restored, 50, 0, 5));
  assert.equal(restored.length, 0);
  history.undo();
  assert.equal(restored.length, 1);
});

// ═══════════════════════════════════════════════════════════════
group('7. Layer separation and wiring');

for (const f of [
  'src/ink/stroke.js',
  'src/ink/ink-layer.js',
  'src/ink/ink-history.js',
  'src/ink/ink-eraser.js',
  'src/ink/ink-renderer.js',
  'src/ink/ink-store.js',
  'src/ink/ink-surface.js',
]) {
  ok(existsSync(join(ROOT, f)), `${f} exists`);
}

const paneSource = $read('src/pdf/pdf-pane.js');
ok(
  paneSource.includes('data-role="ink"') && paneSource.includes('new InkSurface'),
  'the PDF pane hosts a dedicated ink canvas',
);
ok(
  /pdf-ink-canvas/.test($read('src/styles/pdf.css')),
  'the ink canvas is a separate styled element above the page',
);

// The ink surface must only ever be handed the ink canvas.
const surfaceCode = $code('src/ink/ink-surface.js');
ok(
  !/elHolder|pdf-pane-canvas\b|renderPage/.test(surfaceCode),
  'the ink surface never references the PDF canvas or page rendering',
);
ok(
  surfaceCode.includes('clear()') && !/putImageData|getImageData/.test(surfaceCode),
  'clearing ink is a layer operation, not a framebuffer operation',
);

// The old bitmap approach must not come back.
for (const name of ['ink-layer', 'ink-history', 'stroke']) {
  ok(
    !/getImageData|putImageData|ImageData/.test($code(`src/ink/${name}.js`)),
    `${name} stores vectors, never ImageData snapshots`,
  );
}

// ═══════════════════════════════════════════════════════════════
group('Area erasing — the head takes only what it covers');

const lineStroke = () => {
  const st = createStroke({ tool: INK_TOOLS.PEN, color: '#000', width: 2 });
  for (let x = 0; x <= 100; x += 5) appendPoint(st, x, 50, 0.5);
  return st;
};

check('a head crossing the middle cuts the stroke in two', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  layer.add(lineStroke());

  assert.equal(eraseArea(layer, history, { x: 50, y: 50, radius: 12 }), true);
  assert.equal(layer.strokes.length, 2, 'the stroke must survive as two fragments');

  const [a, b] = layer.strokes;
  assert.ok(a.points[a.points.length - 1].x < 50, 'the first fragment stops before the head');
  assert.ok(b.points[0].x > 50, 'the second resumes after it');
  // This is the whole difference from the stroke eraser: the ink outside the
  // head is still there.
  assert.ok(a.points.length >= 2 && b.points.length >= 2);
});

check('fragments carry the original ink and REAL bounds', () => {
  const layer = new InkLayer();
  layer.add(lineStroke());
  eraseArea(layer, new InkHistory(layer), { x: 50, y: 50, radius: 12 });

  for (const f of layer.strokes) {
    assert.equal(f.tool, INK_TOOLS.PEN);
    assert.equal(f.color, '#000');
    assert.equal(f.width, 2);
    // candidatesInBounds pre-filters on bounds and boundsIntersect(null, ...) is
    // false, so a fragment without them would paint but be unhittable — never
    // selectable, erasable or cuttable again.
    assert.ok(f.bounds, 'a fragment must have bounds');
    assert.ok(f.bounds.maxX >= f.bounds.minX);
  }
});

check('one cut is one undo, and redo puts it back', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  layer.add(lineStroke());
  const before = layer.strokes[0].points.length;

  eraseArea(layer, history, { x: 50, y: 50, radius: 12 });
  assert.equal(layer.strokes.length, 2);

  history.undo();
  assert.equal(layer.strokes.length, 1, 'undo restores ONE stroke, not two halves');
  assert.equal(layer.strokes[0].points.length, before, 'and all of its points');

  history.redo();
  assert.equal(layer.strokes.length, 2);
});

check('a head that misses everything changes nothing', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  layer.add(lineStroke());
  assert.equal(eraseArea(layer, history, { x: 50, y: 400, radius: 12 }), false);
  assert.equal(layer.strokes.length, 1);
  assert.equal(history.canUndo(), false, 'a no-op must not consume an undo step');
});

check('a head covering the whole stroke removes it outright', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  layer.add(lineStroke());
  assert.equal(eraseArea(layer, history, { x: 50, y: 50, radius: 400 }), true);
  assert.equal(layer.strokes.length, 0, 'nothing survived the head');
  history.undo();
  assert.equal(layer.strokes.length, 1, 'and it comes back whole');
});

// ═══════════════════════════════════════════════════════════════
group('Lasso selection — move, rotate and scale what was caught');

const boxStroke = () => {
  const st = createStroke({ tool: INK_TOOLS.PEN, color: '#000', width: 2 });
  appendPoint(st, 0, 0, 0.5);
  appendPoint(st, 10, 0, 0.5);
  appendPoint(st, 10, 10, 0.5);
  appendPoint(st, 0, 10, 0.5);
  return st;
};

check('a selection box is derived from the strokes, never stored', () => {
  const layer = new InkLayer();
  const st = boxStroke();
  layer.add(st);
  const box = selectionBounds(layer, [st.id]);
  assert.ok(box, 'a selection must have a box');
  assert.deepEqual(boundsCentre(box), { x: 5, y: 5 });
  // Moving the ink moves the box, because the box is not state.
  transformSelection(layer, null, [st.id], { dx: 100, dy: 50 });
  assert.deepEqual(boundsCentre(selectionBounds(layer, [st.id])), { x: 105, y: 55 });
});

check('rotate and scale happen together, about the selection centre', () => {
  const layer = new InkLayer();
  const st = boxStroke();
  layer.add(st);
  transformSelection(layer, null, [st.id], { dx: 100, dy: 50 });

  const origin = boundsCentre(selectionBounds(layer, [st.id]));
  transformSelection(layer, null, [st.id], { origin, angle: Math.PI / 2, scale: 2 });

  // (100,50) is (-5,-5) from the centre; a quarter turn takes it to (5,-5),
  // doubling takes it to (10,-10), which lands at (115,45).
  const p = layer.strokes[0].points[0];
  assert.ok(Math.abs(p.x - 115) < 1e-6, `x was ${p.x}`);
  assert.ok(Math.abs(p.y - 45) < 1e-6, `y was ${p.y}`);
});

check('line weight scales with the ink', () => {
  const layer = new InkLayer();
  const st = boxStroke();
  layer.add(st);
  transformSelection(layer, null, [st.id], { origin: { x: 5, y: 5 }, scale: 2 });
  // A mark enlarged with its weight left behind stops being the same mark.
  assert.equal(layer.strokes[0].width, 4);
});

check('a whole gesture is one undo step', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  const st = boxStroke();
  layer.add(st);

  // What the surface does: snapshot once, apply many increments, record once.
  const before = snapshotStrokes(layer, [st.id]);
  for (let i = 0; i < 20; i++) transformSelection(layer, null, [st.id], { dx: 1, dy: 0 });
  history.recordTransform(before, snapshotStrokes(layer, [st.id]));

  assert.equal(history.undoStack.length, 1, 'twenty increments, one step');
  assert.equal(layer.strokes[0].points[0].x, 20);
  history.undo();
  assert.equal(layer.strokes[0].points[0].x, 0, 'undo returns to the start of the gesture');
  history.redo();
  assert.equal(layer.strokes[0].points[0].x, 20);
});

check('an identity transform is not a change', () => {
  const layer = new InkLayer();
  const st = boxStroke();
  layer.add(st);
  assert.equal(transformSelection(layer, null, [st.id], { dx: 0, dy: 0 }), false);
  assert.equal(transformSelection(layer, null, [], { dx: 5 }), false);
});

check('bounds are rebuilt after a transform, so the ink stays hittable', () => {
  const layer = new InkLayer();
  const st = boxStroke();
  layer.add(st);
  transformSelection(layer, null, [st.id], { dx: 500, dy: 500 });
  const b = layer.strokes[0].bounds;
  assert.ok(b.minX > 400, 'stale bounds would leave the stroke hittable where it no longer is');
  assert.ok(strokeHitByPoint(layer.strokes[0], 500, 500, 4));
});

// ═══════════════════════════════════════════════════════════════
group('The lasso outline is the loop that was drawn');

/** A hand-drawn ring, sampled the way a stylus samples one. */
const ring = (cx, cy, r, n = 24) => {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
};

check('an open loop still encloses: the ends do not have to meet', () => {
  // A hand never closes a lasso exactly. Refusing to select because the ends
  // missed by a few pixels would make the tool feel broken, not precise.
  const arc = ring(50, 50, 20).slice(0, 22);
  assert.equal(pointInPolygon(50, 50, arc), true, 'the middle is inside');
  assert.equal(pointInPolygon(200, 50, arc), false, 'far away is not');
});

check('containment follows the drawn shape, not its bounding box', () => {
  // An L. Its bounding box corner is empty page, and a box-based selection
  // would claim it.
  const L = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 80 },
    { x: 80, y: 80 }, { x: 80, y: 100 }, { x: 0, y: 100 },
  ];
  const box = polygonBounds(L);
  assert.deepEqual(box, { minX: 0, minY: 0, maxX: 80, maxY: 100 });
  assert.equal(pointInPolygon(10, 50, L), true, 'the upright of the L is inside');
  assert.equal(pointInPolygon(70, 20, L), false, 'the empty corner of the box is NOT');
});

check('the outline travels with the ink it caught', () => {
  const layer = new InkLayer();
  const st = boxStroke();
  layer.add(st);
  let loop = ring(5, 5, 40);

  // Move: outline and ink move by the same delta.
  transformSelection(layer, null, [st.id], { dx: 100, dy: 50 });
  loop = transformPolygon(loop, { dx: 100, dy: 50 });
  assert.deepEqual(boundsCentre(polygonBounds(loop)), { x: 105, y: 55 });
  assert.equal(pointInPolygon(105, 55, loop), true, 'it still holds what it holds');

  // Rotate and scale about the OUTLINE's centre — what the user is turning.
  const origin = boundsCentre(polygonBounds(loop));
  const step = { origin, angle: Math.PI / 2, scale: 2 };
  transformSelection(layer, null, [st.id], step);
  loop = transformPolygon(loop, step);

  const after = polygonBounds(loop);
  assert.ok(Math.abs((after.maxX - after.minX) - 160) < 1e-6, 'the loop doubled');
  assert.deepEqual(boundsCentre(after), origin, 'and turned about its own centre');
  const inkCentre = boundsCentre(selectionBounds(layer, [st.id]));
  assert.equal(pointInPolygon(inkCentre.x, inkCentre.y, loop), true,
    'the ink must still be inside its own outline');
});

check('an empty polygon has no bounds and holds nothing', () => {
  assert.equal(polygonBounds([]), null);
  assert.equal(polygonBounds(null), null);
  assert.equal(pointInPolygon(0.5, 0.5, [{ x: 0, y: 0 }, { x: 1, y: 1 }]), false,
    'two points are a line, not a loop');
  assert.deepEqual(transformPolygon(null, { dx: 1 }), null);
});

check('the surface keeps the loop and draws it, rather than a box', () => {
  const code = $code('src/ink/ink-surface.js');
  ok(code.includes('selectionLoop'), 'the loop is kept after it closes');
  ok(!/strokeRect/.test(code), 'no bounding-box marquee survives');
  ok(code.includes('transformPolygon'), 'the outline is transformed with the ink');
  ok(code.includes('pointInPolygon'), 'a press inside is tested against the loop');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
