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
  nearPolygon,
  pointInPolygon,
  recomputeBounds,
  serializeStroke,
  strokeHitByPoint,
  strokeIntersectsPolygon,
} from '../src/ink/stroke.js';
import { InkLayer } from '../src/ink/ink-layer.js';
import { InkSurface } from '../src/ink/ink-surface.js';
import { INK_OPS, InkHistory } from '../src/ink/ink-history.js';
import {
  boundsCentre,
  handleIndex,
  nearestIndex,
  polygonBounds,
  rectLoop,
  selectInPolygon,
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
  drawStroke,
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

// 橡皮每次 pointermove 只把**新走的那一段**交给命中测试，不是整条轨迹。这条断言
// 守的是那个优化的正确性：逐段擦，和把整条路径一次擦，结果必须完全一样。
//
// 它成立的理由是「擦除只会让笔画变少」——走过的地方已经没有东西可擦了，所以重走
// 一遍必然一无所获。哪天橡皮变成了会添东西的工具，这条会先红。
check('逐段擦和整条擦，擦掉的是同一批笔画', () => {
  const build = () => {
    const layer = new InkLayer();
    for (let x = 0; x <= 200; x += 7) layer.add(strokeThrough([[x, -6], [x, 6]], { width: 1 }));
    for (let y = -40; y <= 40; y += 11) layer.add(strokeThrough([[-30, y], [-20, y]], { width: 1 }));
    return layer;
  };
  // 一条弯一点的轨迹，样本之间的间隔比笔画间距大——正是会漏掉东西的那种。
  const path = [];
  for (let i = 0; i <= 20; i++) path.push({ x: i * 10, y: Math.sin(i / 2) * 4 });

  const whole = build();
  eraseStrokes(whole, null, strokeIdsAlongPath(whole, path, 4));

  const piecewise = build();
  for (let i = 1; i < path.length; i++) {
    eraseStrokes(piecewise, null, strokeIdsAlongPath(piecewise, [path[i - 1], path[i]], 4));
  }
  // 第一个点本身也要测到（pointerdown 那一下）。
  eraseStrokes(piecewise, null, strokeIdsAlongPath(piecewise, [path[0]], 4));

  // 按几何比，不按 id：两次 build 出来的是两批新笔画，id 全局递增，跨层比 id
  // 永远不相等 —— 那会让这条断言变成一条永远红的假警报。
  const shape = (l) => l.getAll()
    .map(st => st.points.map(pt => `${pt.x},${pt.y}`).join(' '))
    .sort().join('|');
  assert.equal(shape(piecewise), shape(whole));
  assert.ok(whole.getAll().length < build().getAll().length, '这一趟必须真的擦掉了东西');
});

// 橡皮在一次 pointermove 里只许重画一遍。_eraseAlong 曾经自己也 render 一次，
// 而两个调用点在它返回之后又各 render 一次——同一帧把整层笔画重绘两遍，且恰好
// 发生在真擦到东西、那一帧本来就最重的时候。平板上 600 笔的页面实测，去掉这一
// 下之后帧间隔 p95 从 73ms 降到 45ms，超过 50ms 的帧从 22 个降到 2 个。
check('_eraseAlong 自己不重画', () => {
  const src = $read('src/ink/ink-surface.js');
  const body = src.slice(src.indexOf('  _eraseAlong() {'), src.indexOf('  // ── commands'));
  assert.ok(body.length > 0, '找不到 _eraseAlong');
  assert.ok(!/this\.render\(\)/.test(body), '_eraseAlong 里不该有 render');
  assert.ok(/onChange/.test(body), '但 onChange 还要照发——落盘和另一栏都靠它');
});

check('橡皮交给命中测试的永远只有一段', () => {
  const src = $read('src/ink/ink-surface.js');
  assert.ok(!/_eraserPath\.push\(/.test(src),
    '轨迹不再累积：累积的那版每次重走全程，是一条随手势变长而变慢的 O(n²)');
  assert.ok(/this\._eraserPath = \[previous, pt\]/.test(src),
    '每次只留上一点和这一点');
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
group('One gesture is one undo step');

check('a whole region-erase drag takes exactly one Undo', () => {
  // ERA-06 on the tablet: the eraser cuts on every pointermove, so one wipe
  // across a page recorded a separate split per event and needed dozens of
  // presses to take back.
  const layer = new InkLayer();
  // Densely sampled: the area eraser cuts by dropping the samples under its
  // head, so a two-point line has nothing for it to take.
  const pts = [];
  for (let x = 0; x <= 200; x += 2) pts.push([x, 0]);
  const line = strokeThrough(pts);
  layer.add(line);
  const history = new InkHistory(layer);

  history.beginBatch();
  for (let x = 40; x <= 120; x += 4) {
    eraseArea(layer, history, { x, y: 0, radius: 6 });
  }
  history.endBatch();

  assert.equal(history.undoStack.length, 1, 'one wipe, one step');
  assert.ok(layer.strokes.length >= 2, 'precondition: the wipe really cut the line');

  history.undo();
  assert.equal(layer.strokes.length, 1, 'one Undo brings the whole line back');
  assert.equal(layer.strokes[0].points.length, line.points.length, 'and brings it back whole');

  history.redo();
  assert.ok(layer.strokes.length >= 2, 'and Redo cuts it again, in one step');
});

check('a batch of one is recorded as itself, not as a wrapper', () => {
  const layer = new InkLayer();
  layer.add(strokeThrough([[0, 0], [5, 5], [10, 10]]));
  const history = new InkHistory(layer);
  history.beginBatch();
  eraseArea(layer, history, { x: 5, y: 5, radius: 40 });
  history.endBatch();
  assert.equal(history.undoStack.length, 1);
  assert.notEqual(history.undoStack[0].type, INK_OPS.BATCH, 'no pointless wrapper');
});

check('an empty batch records nothing at all', () => {
  const layer = new InkLayer();
  layer.add(strokeThrough([[0, 0], [5, 5], [10, 10]]));
  const history = new InkHistory(layer);
  history.beginBatch();
  eraseArea(layer, history, { x: 500, y: 500, radius: 2 });   // misses everything
  assert.equal(history.endBatch(), false);
  assert.equal(history.undoStack.length, 0, 'a gesture that changed nothing is not a step');
});

check('a batch cannot be opened twice, so an inner helper cannot close it', () => {
  const layer = new InkLayer();
  const history = new InkHistory(layer);
  assert.equal(history.beginBatch(), true);
  assert.equal(history.beginBatch(), false, 're-entry is ignored, not nested');
  history.cancelBatch();
  assert.equal(history.undoStack.length, 0);
});

check('undo puts the lasso outline back with the ink', () => {
  // LAS-10 on the tablet: the ink reverted and the orange loop stayed in the
  // transformed position, drawing a selection that no longer existed.
  const layer = new InkLayer();
  const st = boxStroke();
  layer.add(st);
  const history = new InkHistory(layer);

  const loopBefore = [{ x: -5, y: -5 }, { x: 15, y: -5 }, { x: 15, y: 15 }, { x: -5, y: 15 }];
  const before = snapshotStrokes(layer, [st.id]);
  transformSelection(layer, null, [st.id], { dx: 100, dy: 50 });
  const loopAfter = transformPolygon(loopBefore, { dx: 100, dy: 50 });
  history.recordTransform(before, snapshotStrokes(layer, [st.id]), { loopBefore, loopAfter });

  const undone = history.undo();
  assert.equal(undone.type, INK_OPS.TRANSFORM);
  assert.deepEqual(undone.loopBefore, loopBefore, 'the op carries the outline to restore');
  assert.equal(boundsCentre(selectionBounds(layer, [st.id])).x, 5, 'the ink came back');

  const redone = history.redo();
  assert.deepEqual(redone.loopAfter, loopAfter, 'and the other side of the step too');
});

check('undo and redo hand back the operation, so a caller can follow it', () => {
  const layer = new InkLayer();
  layer.add(strokeThrough([[0, 0], [5, 5]]));
  const history = new InkHistory(layer);
  history.recordErase(layer.removeByIds([layer.strokes[0].id]));
  const op = history.undo();
  assert.ok(op && op.type, 'undo returns what it reverted');
  assert.equal(history.undo(), null, 'and null when there is nothing left');
});

// ═══════════════════════════════════════════════════════════════
group('Enlarged ink — one filled outline, no string of beads');

/**
 * A 2D context that flattens every subpath and answers where the ink is.
 *
 * It computes the NONZERO WINDING NUMBER, not "inside any subpath". The
 * distinction is the whole point: the stroke is built as a union of quads and
 * discs, and canvas fills it under nonzero winding, so two overlapping pieces
 * that happen to wind opposite ways cancel to a hole. A union test cannot see
 * that; a winding test is what the browser actually does.
 */
function pathRecorder() {
  let cur = null;
  let sub = null;
  const subs = [];
  const rec = { fills: 0, strokes: 0, shape: null, arcs: 0, subpaths: 0 };

  const open = (x, y) => { sub = [{ x, y }]; subs.push(sub); cur = { x, y }; };
  const push = (x, y) => { if (!sub) open(x, y); else { sub.push({ x, y }); cur = { x, y }; } };

  Object.assign(rec, {
    save() {}, restore() {}, closePath() {}, clearRect() {}, setLineDash() {},
    set strokeStyle(_) {}, set fillStyle(_) {}, set lineWidth(_) {},
    set lineCap(_) {}, set lineJoin(_) {}, set globalAlpha(_) {},
    set globalCompositeOperation(_) {},
    beginPath() { subs.length = 0; sub = null; cur = null; },
    moveTo(x, y) { open(x, y); },
    lineTo(x, y) { push(x, y); },
    quadraticCurveTo(cx, cy, x, y) {
      const s0 = cur;
      for (let t = 1; t <= 8; t++) {
        const u = t / 8, v = 1 - u;
        push(v * v * s0.x + 2 * v * u * cx + u * u * x,
             v * v * s0.y + 2 * v * u * cy + u * u * y);
      }
    },
    arc(x, y, r, a0, a1, anticlockwise) {
      rec.arcs++;
      let d = a1 - a0;
      if (anticlockwise) { while (d > 0) d -= Math.PI * 2; }
      else { while (d < 0) d += Math.PI * 2; }
      const steps = Math.max(8, Math.ceil(Math.abs(d) / (Math.PI / 24)));
      for (let t = 0; t <= steps; t++) {
        const a = a0 + (d * t) / steps;
        push(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
    },
    fill() { rec.fills++; rec.shape = subs.map(p => p.slice()); rec.subpaths = subs.length; },
    stroke() { rec.strokes++; rec.shape = subs.map(p => p.slice()); rec.subpaths = subs.length; },
  });
  return rec;
}

/** Nonzero winding number of a point against every subpath, as canvas fills. */
function windingAt(shape, x, y) {
  let w = 0;
  for (const poly of shape) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      if (a.y <= y) {
        if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) w++;
      } else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) w--;
    }
  }
  return w;
}

const inked = (rec, x, y) => windingAt(rec.shape, x, y) !== 0;

/** A horizontal stroke of `n` samples from x=0 to x=100 at y=0. */
function flatStroke(n, tool = INK_TOOLS.MARKER) {
  const st = createStroke({ tool, color: '#dc2626' });
  for (let i = 0; i < n; i++) appendPoint(st, (i * 100) / (n - 1), 0, 0.5, 0);
  return st;
}

check('a stroke is ONE filled region, however many samples it holds', () => {
  // The beads came from stroking every segment on its own: 200 separately
  // antialiased capsules whose rims stack wherever they overlap. Invisible at
  // 6px wide, a chain of discs at 60.
  for (const n of [2, 20, 400]) {
    const rec = pathRecorder();
    drawStroke(rec, flatStroke(n), createTransform(1, 0, 0));
    assert.equal(rec.fills, 1, `${n} samples must still be one fill`);
    assert.equal(rec.strokes, 0, `${n} samples: no per-segment stroking`);
  }
});

check('the outline sits exactly half a line-width off the centre', () => {
  const rec = pathRecorder();
  const st = flatStroke(30);              // marker: width 6, so r = 3
  drawStroke(rec, st, createTransform(1, 0, 0));

  assert.ok(inked(rec, 50, 0), 'the centre line is ink');
  assert.ok(inked(rec, 50, 2.6), 'and so is just inside the edge');
  assert.ok(!inked(rec, 50, 3.6), 'just outside the edge is not');
  assert.ok(!inked(rec, 50, 20), 'and neither is the page');
});

check('the caps round the ends off instead of biting into them', () => {
  const rec = pathRecorder();
  drawStroke(rec, flatStroke(30), createTransform(1, 0, 0));
  assert.ok(inked(rec, 100, 0), 'the last sample is ink');
  assert.ok(inked(rec, 102, 0), 'and the cap carries it past the tip');
  assert.ok(!inked(rec, 104, 0), 'but only by the half-width');
  assert.ok(inked(rec, 0, 0), 'the first sample is ink');
  assert.ok(inked(rec, -2, 0), 'and its cap reaches back');
  assert.ok(!inked(rec, -4, 0));
});

check('enlarging the ink widens the mark, and it stays one region', () => {
  // What the user was looking at: a stroke scaled up with the lasso.
  const layer = new InkLayer();
  const st = flatStroke(40);
  layer.add(st);
  transformSelection(layer, null, [st.id], { origin: { x: 0, y: 0 }, scale: 4 });

  const rec = pathRecorder();
  drawStroke(rec, layer.strokes[0], createTransform(1, 0, 0));
  assert.equal(rec.fills, 1, 'still one region at four times the size');
  assert.equal(rec.strokes, 0, 'and still nothing stroked per segment');

  assert.ok(inked(rec, 200, 0), 'the middle of the enlarged stroke');
  assert.ok(inked(rec, 200, 11), 'and out to nearly the new half-width of 12');
  assert.ok(!inked(rec, 200, 13), 'but not past it');
});

check('every piece winds the same way, so no join can punch a hole', () => {
  // Nonzero winding ADDS signed turns. The discs that make the joins round
  // wind one way and the quads the other unless they are made to agree, and
  // where they overlap the sum is zero — a hole, worst exactly at a join.
  const rec = pathRecorder();
  drawStroke(rec, flatStroke(20), createTransform(1, 0, 0));
  const signs = new Set();
  for (const poly of rec.shape) {
    let area = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      area += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    }
    if (Math.abs(area) > 1e-9) signs.add(Math.sign(area));
  }
  assert.equal(signs.size, 1, 'quads and discs must wind the same way');

  // And the winding never cancels anywhere along the stroke.
  for (let x = 0; x <= 100; x += 2.5) {
    assert.notEqual(windingAt(rec.shape, x, 0), 0, `hole at x=${x}`);
  }
});

check('a hairpin stays solid where it doubles back', () => {
  // The defect the tablet run caught at 400%: tracing one long outline down
  // each side has to swing the smoothing from one side of the stroke to the
  // other at a reversal, and the swing fills as a blob hanging off the turn.
  const st = createStroke({ tool: INK_TOOLS.MARKER, color: '#dc2626' });
  for (let i = 0; i <= 20; i++) appendPoint(st, i * 3, 0, 0.5, 0);
  for (let i = 20; i >= 0; i--) appendPoint(st, i * 3, 1.2, 0.5, 0);

  const rec = pathRecorder();
  drawStroke(rec, st, createTransform(4, 0, 0));   // as seen at 400%
  assert.equal(rec.fills, 1);

  // Solid the whole way along, on the way out and on the way back.
  for (let x = 0; x <= 60; x += 3) {
    assert.ok(inked(rec, x * 4, 0), `gap on the outward leg at ${x}`);
    assert.ok(inked(rec, x * 4, 1.2 * 4), `gap on the return leg at ${x}`);
  }

  // And nothing hanging off the turn. The marker is 6 wide, so at 400% the
  // stroke reaches 12px beyond the last sample and no further.
  const tipX = 60 * 4;
  assert.ok(inked(rec, tipX + 10, 0), 'the cap rounds the turn');
  assert.ok(!inked(rec, tipX + 20, 0), 'a blob would reach far past the tip');
  assert.ok(!inked(rec, tipX + 40, 2), 'and further still, off to the side');
});

check('samples landing on one pixel are dropped, and the end never is', () => {
  // Pure economy: at 25% zoom four stored samples share a pixel and three of
  // them contribute nothing but arithmetic. It must not shorten the mark.
  const st = flatStroke(400);
  const zoomed = pathRecorder();
  drawStroke(zoomed, st, createTransform(0.25, 0, 0));
  assert.ok(inked(zoomed, 25, 0), 'the far end is still drawn');
  assert.ok(!inked(zoomed, 27, 0), 'and does not run past where it ends');

  const full = pathRecorder();
  drawStroke(full, st, createTransform(1, 0, 0));
  assert.ok(full.subpaths > zoomed.subpaths,
    'zoomed out costs fewer pieces than zoomed in');
});

check('a constant-width tool is still one stroked path, not an outline', () => {
  // The highlighter has no pressure to vary, so a plain stroke is both correct
  // and cheaper — and it already could not bead, being a single path.
  const rec = pathRecorder();
  const st = createStroke({ tool: INK_TOOLS.HIGHLIGHTER, color: '#facc15' });
  for (let i = 0; i < 20; i++) appendPoint(st, i * 5, 0, 0.5, 0);
  drawStroke(rec, st, createTransform(1, 0, 0));
  assert.equal(rec.strokes, 1);
  assert.equal(rec.fills, 0);
});

check('a hairpin does not collapse the outline', () => {
  // Where a stroke doubles back on itself the two directions cancel and the
  // offset is undefined. Nonzero winding fills the overlap solid, which is
  // what ink does — it must not punch a hole.
  const st = createStroke({ tool: INK_TOOLS.MARKER, color: '#000' });
  for (let i = 0; i < 10; i++) appendPoint(st, i * 5, 0, 0.5, 0);
  for (let i = 9; i >= 0; i--) appendPoint(st, i * 5, 0.2, 0.5, 0);
  const rec = pathRecorder();
  drawStroke(rec, st, createTransform(1, 0, 0));
  assert.equal(rec.fills, 1);
  assert.ok(rec.shape.every(sp => sp.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))),
    'no NaN may reach the path — one would erase the whole stroke');
});

// ═══════════════════════════════════════════════════════════════
group('Tool modes are mutually exclusive — no tool can disable another');

/**
 * A surface with no DOM behind it.
 *
 * The mode flags are plain fields and the branch that reads them is the one
 * under test, so a canvas would add nothing here except a reason for the test
 * not to run.
 */
function modeSurface() {
  const surface = Object.create(InkSurface.prototype);
  surface.tool = INK_TOOLS.PEN;
  surface.width = 2;
  surface.erasing = false;
  surface.selecting = false;
  surface.selection = [];
  surface.selectionLoop = null;
  surface._loop = null;
  surface._grab = null;
  surface._anchor = -1;
  surface._loopFrom = null;
  surface.render = () => {};
  return surface;
}

/** What a press would actually do, in the order pointerdown decides it. */
const modeOf = (s) => (s.selecting ? 'select' : s.erasing ? 'erase' : 'draw');

check('picking the eraser after the lasso ERASES', () => {
  // The regression. `setEraser()` is the call the toolbar makes for the
  // eraser — not `setTool('eraser')` — and it used to set `erasing` while
  // leaving `selecting` true from the lasso. pointerdown tests `selecting`
  // first, so every press ran the lasso and the eraser did nothing at all.
  const s = modeSurface();
  s.setTool('lasso');
  assert.equal(modeOf(s), 'select', 'precondition: the lasso is in hand');

  s.setEraser(ERASER_MODES.STROKE);
  assert.equal(s.selecting, false, 'the lasso must let go');
  assert.equal(modeOf(s), 'erase', 'a press must reach the eraser');
});

check('every order of every tool leaves exactly one mode live', () => {
  // Two flags with three writers cannot be kept consistent by remembering to,
  // so this walks every ordered pair of entry points.
  const enter = {
    pen: (s) => s.setTool(INK_TOOLS.PEN),
    highlighter: (s) => s.setTool(INK_TOOLS.HIGHLIGHTER),
    'eraser/setTool': (s) => s.setTool('eraser'),
    'eraser/setEraser': (s) => s.setEraser(ERASER_MODES.REGION),
    lasso: (s) => s.setTool('lasso'),
  };
  const expected = {
    pen: 'draw',
    highlighter: 'draw',
    'eraser/setTool': 'erase',
    'eraser/setEraser': 'erase',
    lasso: 'select',
  };

  for (const first of Object.keys(enter)) {
    for (const second of Object.keys(enter)) {
      const s = modeSurface();
      enter[first](s);
      enter[second](s);
      assert.equal(modeOf(s), expected[second], `${first} → ${second}`);
      assert.ok(!(s.erasing && s.selecting), `${first} → ${second}: both flags set`);
    }
  }
});

check('leaving the lasso drops the selection, whichever way you leave', () => {
  for (const leave of [
    (s) => s.setTool(INK_TOOLS.PEN),
    (s) => s.setTool('eraser'),
    (s) => s.setEraser(ERASER_MODES.STROKE),
  ]) {
    const s = modeSurface();
    s.setTool('lasso');
    s.selection = ['a', 'b'];
    s.selectionLoop = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
    s._anchor = 2;
    leave(s);
    assert.deepEqual(s.selection, [], 'a selection no gesture can act on is decoration');
    assert.equal(s.selectionLoop, null);
    assert.equal(s._anchor, -1);
  }
});

check('re-selecting the lasso keeps what is already selected', () => {
  // Only LEAVING drops it. Reopening the card, or the toolbar re-pushing its
  // state when the active pane changes, must not throw the selection away.
  const s = modeSurface();
  s.setTool('lasso');
  s.selection = ['a'];
  s.selectionLoop = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  s.setTool('lasso');
  assert.deepEqual(s.selection, ['a']);
});

check('the mode is written in one place and nowhere else', () => {
  const code = $code('src/ink/ink-surface.js');
  const writes = (code.match(/this\.(erasing|selecting) =/g) || []);
  assert.equal(writes.length, 2, 'both flags assigned once, inside _setMode');
  const setMode = code.match(/_setMode\(mode\) \{[\s\S]*?\n  \}/);
  assert.ok(setMode, '_setMode must exist');
  assert.ok(/this\.erasing = mode === 'erase'/.test(setMode[0]));
  assert.ok(/this\.selecting = mode === 'select'/.test(setMode[0]));
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

check('the transform handle sits ON the loop, not beside it', () => {
  // There is no bounding box drawn any more, so a handle at the box's corner
  // would float in blank page with nothing connecting it to the selection.
  const loop = ring(100, 100, 50);
  const h = loop[handleIndex(loop)];
  const r = Math.hypot(h.x - 100, h.y - 100);
  assert.ok(Math.abs(r - 50) < 1e-6, 'the handle must lie on the outline itself');
  assert.ok(h.x > 100 && h.y > 100, 'and on its lower-right, where a handle is looked for');

  const box = polygonBounds(loop);
  assert.ok(h.x < box.maxX && h.y < box.maxY, 'strictly inside the box corner');
  assert.equal(handleIndex([]), -1);
  assert.equal(handleIndex(null), -1);
});

check('the handle is pinned to a vertex, so a transform cannot make it hop', () => {
  // This is the bug the index exists to kill. Recomputing "furthest
  // down-right" every frame makes the handle jump between sample points while
  // the shape is being turned — it skates around the outline under a finger
  // that is holding still.
  const loop = ring(100, 100, 50, 32);
  const pinned = handleIndex(loop);

  let turned = loop;
  let searched = 0;
  for (let i = 0; i < 32; i++) {
    turned = transformPolygon(turned, {
      origin: { x: 100, y: 100 }, angle: Math.PI / 16, scale: 1.02,
    });
    if (handleIndex(turned) !== pinned) searched++;
  }
  assert.ok(searched > 8, 'a re-searched handle really does hop — otherwise this proves nothing');

  // The pinned one is the same physical point throughout: still on the loop,
  // and still the vertex it started as.
  const start = loop[pinned];
  const end = turned[pinned];
  const a0 = Math.atan2(start.y - 100, start.x - 100);
  const a1 = Math.atan2(end.y - 100, end.x - 100);
  const turnedBy = ((a1 - a0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  assert.ok(Math.abs(turnedBy - (2 * Math.PI * ((32 / 32) % 1))) < 1e-6
    || Math.abs(turnedBy) < 1e-6, 'a full turn brings the pinned vertex back to itself');
});

check('a grab pins the handle to the vertex under the finger', () => {
  const loop = ring(100, 100, 50, 24);
  const press = { x: 150, y: 100 };
  const i = nearestIndex(loop, press.x, press.y);
  const v = loop[i];
  assert.ok(Math.hypot(v.x - press.x, v.y - press.y) < 14, 'the nearest vertex, not any vertex');
  for (const p of loop) {
    assert.ok(
      Math.hypot(p.x - press.x, p.y - press.y) >= Math.hypot(v.x - press.x, v.y - press.y) - 1e-9,
      'and genuinely the nearest',
    );
  }
  assert.equal(nearestIndex([], 0, 0), -1);
});

check('the rectangle lasso is four corners, whichever way it was dragged', () => {
  const a = rectLoop({ x: 90, y: 80 }, { x: 10, y: 20 });
  const b = rectLoop({ x: 10, y: 20 }, { x: 90, y: 80 });
  assert.equal(a.length, 4, 'a box has four corners however far the hand wandered');
  assert.deepEqual(a, b, 'dragging up-left must give the same box as down-right');
  assert.deepEqual(polygonBounds(a), { minX: 10, minY: 20, maxX: 90, maxY: 80 });
  assert.equal(pointInPolygon(50, 50, a), true);
  assert.equal(pointInPolygon(5, 50, a), false);
  assert.deepEqual(rectLoop(null, { x: 1, y: 1 }), []);
});

check('完全包含 takes only what is wholly inside; 接触即选 takes what it crosses', () => {
  const layer = new InkLayer();
  const inside = strokeThrough([[20, 20], [30, 30]]);
  const crossing = strokeThrough([[40, 40], [200, 200]]);
  layer.add(inside);
  layer.add(crossing);
  const box = rectLoop({ x: 0, y: 0 }, { x: 100, y: 100 });

  const touch = selectInPolygon(layer, box, strokeIdsInRegion, false);
  assert.equal(touch.length, 2, 'the forgiving reading takes the stroke it crosses');

  const strict = selectInPolygon(layer, box, strokeIdsInRegion, true);
  assert.deepEqual(strict, [inside.id], 'the strict one leaves the trailing stroke behind');
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
  ok(code.includes('nearPolygon'), 'a press is tested against the loop, not a box');
});

check('the page that turns away takes its handwriting with it', () => {
  // The turn photographs the page into a sheet and folds the photograph. It
  // used to photograph the PDF canvas alone, and the ink is a separate surface
  // — so a worked page turned away blank of every stroke on it, for the whole
  // length of the animation. Both canvases go onto the sheet now.
  const code = $code('src/pdf/pdf-pane.js');
  const leaf = code.slice(code.indexOf('_makeLeaf('), code.indexOf('_grabAnchor('));
  ok(/drawImage\(source, 0, 0\)/.test(leaf), 'the printed page is photographed');
  ok(/drawImage\(\s*ink,/.test(leaf), 'and the ink surface with it');
  ok(/ink\.width \/ box\.width/.test(leaf),
    'the page-sized region of a viewport-sized ink surface is what gets cut out');
  ok(/drawImage\(source[\s\S]*drawImage\(\s*ink/.test(leaf),
    'the ink goes on top of the printed page, not under it');
});

check('a finished lasso can be grabbed from just outside its line', () => {
  // A freehand loop is drawn tight against the ink, so the region strictly
  // inside it is a sliver. Without a margin a stylus landing a few pixels
  // proud of the line throws the selection away and starts a new one.
  const ring = [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 },
  ];
  assert.equal(nearPolygon(20, 20, ring, 6), true, 'the middle is still a grab');
  assert.equal(nearPolygon(43, 20, ring, 6), true, 'and so is three units outside the edge');
  assert.equal(nearPolygon(43, 20, ring, 0), false, 'with no margin it is a miss, as before');
  assert.equal(nearPolygon(60, 20, ring, 6), false, 'well clear of it starts a new lasso');

  // The margin must not turn the loop into its bounding box: the empty corner
  // of an L is far from every edge and still belongs to the page.
  const L = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 80 },
    { x: 80, y: 80 }, { x: 80, y: 100 }, { x: 0, y: 100 },
  ];
  assert.equal(nearPolygon(10, 50, L, 12), true, 'the upright of the L is inside');
  assert.equal(nearPolygon(70, 20, L, 12), false,
    'the empty corner of the box is still NOT a grab');
  assert.equal(nearPolygon(28, 40, L, 12), true,
    'but just off the upright, where the ink is, still is');

  assert.equal(nearPolygon(1, 1, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 50), false,
    'two points are a line, not a loop, at any margin');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
