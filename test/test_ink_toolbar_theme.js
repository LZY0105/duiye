#!/usr/bin/env node
// Floating toolbar + theme tests (spec P0-11, UI acceptance criteria §12).
//
// The toolbar's acceptance criteria are mostly statements about STATE —
// "selected tool, quick color and relevant parameters survive movement and
// orientation change", "dragging does not draw Ink, pan the page, move the
// split divider, or change the active document" — so the state machine is pure
// and those claims are checked here directly rather than by eye.
//
// Theme requires a persistent three-state preference that keeps following the
// OS, which the previous two-state implementation could not express.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARDS, EDGES, ERASER_TOOL, ORIENTATION, TOOLBAR_PHASE,
  closeCard, createToolbarState, endDrag, isEraser, moveDrag, nearestEdge,
  openCard, orientationFor, orientationOf, selectTool, serializeToolbarState,
  setColor, setEraserMode, setEraserWidth, setOpacity, setWidth, startDrag,
} from '../src/ink/toolbar-state.js';
import { INK_TOOLS, TOOL_DEFAULTS } from '../src/ink/stroke.js';
import { ERASER_MODES } from '../src/ink/ink-eraser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const $read = (f) => readFileSync(join(ROOT, f), 'utf-8');
const $code = (f) => $read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function ok(c, l, d) { if (c) pass(l); else fail(l, d); }
function group(n) { console.log(`\n─── [${n}] ───`); }
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

const VIEWPORT = { width: 1000, height: 800 };

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Floating Toolbar + Theme Tests');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. Orientation follows placement');

check('side edges are vertical, top/bottom horizontal', () => {
  assert.equal(orientationFor(EDGES.LEFT), ORIENTATION.VERTICAL);
  assert.equal(orientationFor(EDGES.RIGHT), ORIENTATION.VERTICAL);
  assert.equal(orientationFor(EDGES.TOP), ORIENTATION.HORIZONTAL);
  assert.equal(orientationFor(EDGES.BOTTOM), ORIENTATION.HORIZONTAL);
});

check('release snaps to the nearest edge', () => {
  assert.equal(nearestEdge({ x: 5, y: 400 }, VIEWPORT).edge, EDGES.LEFT);
  assert.equal(nearestEdge({ x: 995, y: 400 }, VIEWPORT).edge, EDGES.RIGHT);
  assert.equal(nearestEdge({ x: 500, y: 5 }, VIEWPORT).edge, EDGES.TOP);
  assert.equal(nearestEdge({ x: 500, y: 795 }, VIEWPORT).edge, EDGES.BOTTOM);
});

check('offset records how far along the edge the toolbar sits', () => {
  const { offset } = nearestEdge({ x: 5, y: 200 }, VIEWPORT);
  assert.ok(Math.abs(offset - 0.25) < 1e-9);
});

check('a release outside the viewport is clamped, not lost', () => {
  const r = nearestEdge({ x: -50, y: 2000 }, VIEWPORT);
  assert.equal(r.edge, EDGES.LEFT);
  assert.ok(r.offset >= 0 && r.offset <= 1);
});

// ═══════════════════════════════════════════════════════════════
group('2. The drag sequence (§5.2)');

check('expanded → drag → token → release → expanded', () => {
  let s = createToolbarState();
  assert.equal(s.phase, TOOLBAR_PHASE.EXPANDED);

  s = startDrag(s, { x: 100, y: 100 });
  assert.equal(s.phase, TOOLBAR_PHASE.DRAGGING, 'drag start collapses to a token');

  s = moveDrag(s, { x: 480, y: 30 });
  assert.deepEqual(s.dragPoint, { x: 480, y: 30 }, 'the token follows the pointer');

  s = endDrag(s, { x: 480, y: 10 }, VIEWPORT);
  assert.equal(s.phase, TOOLBAR_PHASE.EXPANDED, 'release restores the expanded bar');
  assert.equal(s.edge, EDGES.TOP);
  assert.equal(orientationOf(s), ORIENTATION.HORIZONTAL, 'and reorients for the new edge');
});

check('dragging closes any open card', () => {
  let s = openCard(createToolbarState(), CARDS.COLOR);
  assert.equal(s.openCard, CARDS.COLOR);
  s = startDrag(s, { x: 10, y: 10 });
  assert.equal(s.openCard, CARDS.NONE, 'a card anchored to the bar cannot follow it');
});

check('a card cannot be opened mid-drag', () => {
  const s = startDrag(createToolbarState(), { x: 10, y: 10 });
  assert.equal(openCard(s, CARDS.TOOL).openCard, CARDS.NONE);
});

check('moveDrag and endDrag are no-ops when not dragging', () => {
  const s = createToolbarState();
  assert.equal(moveDrag(s, { x: 1, y: 1 }), s);
  assert.equal(endDrag(s, { x: 1, y: 1 }, VIEWPORT), s);
});

// ═══════════════════════════════════════════════════════════════
group('3. Selections survive movement and reorientation (§12)');

check('tool, colour, width and opacity are preserved across a full drag', () => {
  let s = createToolbarState({ edge: EDGES.LEFT });
  s = selectTool(s, INK_TOOLS.MARKER);
  s = setColor(s, '#dc2626');
  s = setWidth(s, 7.5);
  s = setOpacity(s, 0.42);

  const before = {
    tool: s.tool, color: s.color, width: s.width,
    opacity: s.opacity, swatches: [...s.swatches],
  };

  s = startDrag(s, { x: 20, y: 400 });
  s = moveDrag(s, { x: 900, y: 700 });
  s = endDrag(s, { x: 500, y: 790 }, VIEWPORT);

  assert.equal(s.edge, EDGES.BOTTOM, 'placement changed');
  assert.equal(orientationOf(s), ORIENTATION.HORIZONTAL, 'orientation changed');
  assert.equal(s.tool, before.tool, 'tool must survive');
  assert.equal(s.color, before.color, 'colour must survive');
  assert.equal(s.width, before.width, 'width must survive');
  assert.equal(s.opacity, before.opacity, 'opacity must survive');
  assert.deepEqual([...s.swatches], before.swatches, 'swatches must survive');
});

check('eraser mode and width survive a drag too', () => {
  let s = setEraserWidth(setEraserMode(createToolbarState(), ERASER_MODES.REGION), 12);
  s = endDrag(moveDrag(startDrag(s, { x: 5, y: 5 }), { x: 990, y: 400 }),
    { x: 990, y: 400 }, VIEWPORT);
  assert.equal(s.edge, EDGES.RIGHT);
  assert.equal(s.eraserMode, ERASER_MODES.REGION);
  assert.equal(s.eraserWidth, 12);
  assert.equal(isEraser(s), true);
});

check('drag transitions touch placement only — nothing else', () => {
  const before = createToolbarState();
  const after = endDrag(startDrag(before, { x: 10, y: 10 }), { x: 990, y: 10 }, VIEWPORT);
  const placementKeys = new Set(['edge', 'offset', 'phase', 'dragPoint', 'openCard']);
  for (const key of Object.keys(before)) {
    if (placementKeys.has(key)) continue;
    assert.deepEqual(after[key], before[key], `${key} must not change during a drag`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('4. Tool and parameter state');

check('selecting a tool adopts that tool\'s defaults', () => {
  const s = selectTool(createToolbarState(), INK_TOOLS.HIGHLIGHTER);
  assert.equal(s.tool, INK_TOOLS.HIGHLIGHTER);
  assert.equal(s.width, TOOL_DEFAULTS[INK_TOOLS.HIGHLIGHTER].width);
  assert.equal(s.opacity, TOOL_DEFAULTS[INK_TOOLS.HIGHLIGHTER].opacity);
});

check('the eraser is selectable as a tool but is not a stroke tool', () => {
  const s = selectTool(createToolbarState(), ERASER_TOOL);
  assert.equal(isEraser(s), true);
  assert.equal(Object.values(INK_TOOLS).includes(s.tool), false);
});

check('width and opacity are clamped to sane ranges', () => {
  assert.equal(setWidth(createToolbarState(), 9999).width, 40);
  assert.equal(setWidth(createToolbarState(), -5).width, 0.2);
  assert.equal(setOpacity(createToolbarState(), 5).opacity, 1);
  assert.equal(setOpacity(createToolbarState(), -1).opacity, 0);
});

check('cards toggle and close', () => {
  let s = openCard(createToolbarState(), CARDS.TOOL);
  assert.equal(s.openCard, CARDS.TOOL);
  s = openCard(s, CARDS.TOOL);
  assert.equal(s.openCard, CARDS.NONE, 'reopening the same card closes it');
  s = closeCard(openCard(s, CARDS.COLOR));
  assert.equal(s.openCard, CARDS.NONE);
});

check('state serialises placement and tool choice for restart', () => {
  const s = setColor(selectTool(createToolbarState({ edge: EDGES.BOTTOM }), INK_TOOLS.PENCIL), '#2563eb');
  const json = serializeToolbarState(s);
  assert.equal(json.edge, EDGES.BOTTOM);
  assert.equal(json.tool, INK_TOOLS.PENCIL);
  assert.equal(json.color, '#2563eb');
  const restored = createToolbarState(json);
  assert.equal(restored.edge, EDGES.BOTTOM);
  assert.equal(restored.tool, INK_TOOLS.PENCIL);
  assert.equal(restored.color, '#2563eb');
});

// ═══════════════════════════════════════════════════════════════
group('5. Layer safety (§11.3, §12)');

const toolbarStateCode = $code('src/ink/toolbar-state.js');
const toolbarCode = $code('src/ink/ink-toolbar.js');

ok(
  !/pdf|divider|document|viewport\s*=|pane/i.test(toolbarStateCode),
  'toolbar state holds no reference to a PDF, pane, divider or document',
);
ok(
  !/renderPage|elHolder|pdf-pane-canvas|dividerRatio|openDocument/.test(toolbarCode),
  'the toolbar cannot render pages, move the divider or change the document',
);
ok(
  /stopPropagation/.test(toolbarCode),
  'the drag gesture is contained so it cannot draw ink or pan the page',
);
ok(
  /setTool|setColor|setWidth|setOpacity|setEraser/.test(toolbarCode),
  'the toolbar changes ink tool properties only',
);
ok(
  !/clearRect|putImageData|getImageData|flatten|rasteri/i.test(toolbarCode),
  'no card rasterises strokes or merges ink into the PDF',
);
ok(
  /onClearInk/.test(toolbarCode) && /清空本页笔迹/.test($read('src/ink/ink-toolbar.js')),
  'the clear action is scoped to ink on the current page',
);

const workspaceCode = $code('src/pdf/pdf-workspace.js');
ok(
  /onClearInk:\s*\(\)\s*=>\s*\{[\s\S]{0,200}?ink\.clear\(\)/.test(workspaceCode),
  'the workspace routes clear to the ink layer, never to the document',
);
ok(
  /getSurface:\s*\(\)\s*=>\s*this\.panes\[this\.activeSlot\]/.test(workspaceCode),
  'one shared toolbar applies to the explicitly active pane (§11.2)',
);

// ═══════════════════════════════════════════════════════════════
group('6. Motion and overlay rules (§8.2)');

const toolbarCss = $read('src/styles/ink-toolbar.css');
ok(toolbarCss.includes('position: absolute'), 'the toolbar is an overlay, not part of the layout');
ok(
  /prefers-reduced-motion/.test(toolbarCss) && /prefers-reduced-motion/.test(toolbarCode),
  'reduced-motion is respected in both CSS and JS',
);
ok(
  /pointer-events:\s*none/.test(toolbarCss),
  'the card layer is inert so stylus input still reaches the ink surface',
);
ok(
  !/width:\s*100%|flex:\s*1/.test(toolbarCss.split('.ink-card-layer')[1] || ''),
  'opening a card does not resize the workspace',
);

// ═══════════════════════════════════════════════════════════════
group('7. The app is light-only');

// Dark mode was removed. These checks are here so it cannot creep back one
// stylesheet at a time: a `[data-theme="dark"]` block that nothing can ever
// match is dead weight that still has to be maintained, and a half-restored
// dark mode (some surfaces flipped, some not) is worse than none.

ok(!existsSync(join(ROOT, 'src/ui/theme.js')), 'the theme module is gone');

for (const f of [
  'src/styles/base.css', 'src/styles/ocr.css', 'src/styles/pdf.css',
  'src/styles/ink-toolbar.css', 'src/styles/mobile.css', 'src/styles/material.css',
]) {
  const css = $read(f);
  // The word may still appear in prose; a selector may not.
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(
    !/\[data-theme\s*=\s*["']?dark/.test(selectors),
    `${f} carries no dark-theme selector`,
  );
}

ok(
  !/prefers-color-scheme/.test($read('src/styles/base.css')),
  'no stylesheet follows the OS colour scheme',
);
ok(
  !$read('index.html').includes('id="themeToggle"'),
  'the theme toggle is gone from the markup',
);

group('8. Wiring');

for (const f of ['src/ink/toolbar-state.js', 'src/ink/ink-toolbar.js', 'src/styles/ink-toolbar.css']) {
  ok(existsSync(join(ROOT, f)), `${f} exists`);
}
ok($read('src/main.js').includes('styles/ink-toolbar.css'), 'toolbar styles are bundled');
ok(workspaceCode.includes('new InkToolbar'), 'the workspace mounts the floating toolbar');
ok(
  /\.pdf-workspace\s*\{[^}]*position:\s*relative/s.test($read('src/styles/pdf.css')),
  'the workspace anchors the floating overlay',
);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
