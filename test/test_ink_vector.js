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
  ERASER_MODES,
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

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
