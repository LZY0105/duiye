#!/usr/bin/env node
// PDF workspace tests (spec P0-07).
//
// The view/layout state modules are pure and DOM-free precisely so the
// acceptance guarantees can be proven here in plain Node, without a canvas, a
// real PDF or a browser: independent page/zoom/scroll per pane, an adjustable
// divider, orientation adaptation, and a table of contents that is preserved
// but never fabricated.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIT_MODES,
  ZOOM_MAX,
  ZOOM_MIN,
  applyFit,
  canGoNext,
  canGoPrevious,
  createViewState,
  goToPage,
  nextPage,
  panBy,
  previousPage,
  refit,
  serializeViewState,
  setZoom,
  zoomIn,
  zoomOut,
} from '../src/pdf/pdf-view-state.js';

import {
  MAX_RATIO,
  swapSides,
  serializeWorkspaceState,
  MIN_RATIO,
  ORIENTATIONS,
  SLOTS,
  assignDocument,
  clearFocus,
  closeSlot,
  createWorkspaceState,
  isDualMode,
  openSlots,
  orientationForViewport,
  paneFractions,
  setDividerRatio,
  setOrientation,
  toggleFocus,
} from '../src/pdf/workspace-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const $read = (f) => readFileSync(join(ROOT, f), 'utf-8');

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function ok(c, l, d) { if (c) pass(l); else fail(l, d); }
function group(n) { console.log(`\n─── [${n}] ───`); }
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  PDF Workspace Tests — dual document, independent panes');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. View state — page navigation');

check('page number is clamped to the document', () => {
  const s = createViewState(10, { pageNumber: 999 });
  assert.equal(s.pageNumber, 10);
  assert.equal(createViewState(10, { pageNumber: -5 }).pageNumber, 1);
});

check('next/previous stop at the ends', () => {
  let s = createViewState(3);
  assert.equal(canGoPrevious(s), false);
  s = nextPage(nextPage(s));
  assert.equal(s.pageNumber, 3);
  assert.equal(canGoNext(s), false);
  assert.equal(nextPage(s).pageNumber, 3);
  s = previousPage(previousPage(previousPage(s)));
  assert.equal(s.pageNumber, 1);
});

check('changing page resets pan so a new page opens at its top-left', () => {
  let s = createViewState(5);
  s = panBy(s, -40, -60, { width: 100, height: 100 }, { width: 400, height: 400 });
  assert.ok(s.scrollX > 0 && s.scrollY > 0);
  s = goToPage(s, 2);
  assert.equal(s.scrollX, 0);
  assert.equal(s.scrollY, 0);
});

// ═══════════════════════════════════════════════════════════════
group('2. View state — zoom and fit');

check('zoom is clamped to the supported range', () => {
  assert.equal(setZoom(createViewState(1), 999).zoom, ZOOM_MAX);
  assert.equal(setZoom(createViewState(1), 0.001).zoom, ZOOM_MIN);
});

check('zoom in/out walk the step ladder and saturate', () => {
  let s = createViewState(1);           // zoom 1
  assert.equal(zoomIn(s).zoom, 1.25);
  assert.equal(zoomOut(s).zoom, 0.75);
  let hi = setZoom(s, ZOOM_MAX);
  assert.equal(zoomIn(hi).zoom, ZOOM_MAX);
  let lo = setZoom(s, ZOOM_MIN);
  assert.equal(zoomOut(lo).zoom, ZOOM_MIN);
});

check('manual zoom drops fit mode so a relayout cannot undo it', () => {
  const fitted = applyFit(createViewState(1), FIT_MODES.WIDTH,
    { width: 800, height: 600 }, { width: 400, height: 500 });
  assert.equal(fitted.fitMode, FIT_MODES.WIDTH);
  assert.equal(fitted.zoom, 2);
  const manual = setZoom(fitted, 1.5);
  assert.equal(manual.fitMode, FIT_MODES.NONE);
  // A later resize must NOT re-fit and stomp the user's choice.
  const after = refit(manual, { width: 1600, height: 600 }, { width: 400, height: 500 });
  assert.equal(after.zoom, 1.5);
});

check('fit-page uses the limiting dimension, fit-width uses width', () => {
  const viewport = { width: 800, height: 600 };
  const page = { width: 400, height: 800 };
  assert.equal(applyFit(createViewState(1), FIT_MODES.WIDTH, viewport, page).zoom, 2);
  assert.equal(applyFit(createViewState(1), FIT_MODES.PAGE, viewport, page).zoom, 0.75);
});

check('a remembered fit mode re-fits when the pane is resized', () => {
  const page = { width: 400, height: 500 };
  const fitted = applyFit(createViewState(1), FIT_MODES.WIDTH, { width: 800, height: 600 }, page);
  assert.equal(fitted.zoom, 2);
  // Divider dragged: the pane is now half as wide.
  assert.equal(refit(fitted, { width: 400, height: 600 }, page).zoom, 1);
});

check('pan is clamped so the page cannot be dragged off screen', () => {
  const viewport = { width: 100, height: 100 };
  const content = { width: 300, height: 300 };
  let s = createViewState(1);
  s = panBy(s, 500, 500, viewport, content);   // drag far right/down
  assert.equal(s.scrollX, 0);
  assert.equal(s.scrollY, 0);
  s = panBy(s, -500, -500, viewport, content); // drag far left/up
  assert.equal(s.scrollX, 200);
  assert.equal(s.scrollY, 200);
});

check('content smaller than the viewport cannot be panned at all', () => {
  const s = panBy(createViewState(1), -50, -50,
    { width: 500, height: 500 }, { width: 100, height: 100 });
  assert.equal(s.scrollX, 0);
  assert.equal(s.scrollY, 0);
});

// ═══════════════════════════════════════════════════════════════
group('3. Pane isolation — the core dual-workspace guarantee');

check('two panes never share state (page/zoom/scroll)', () => {
  const exercise = createViewState(50);
  const answers = createViewState(120);

  let left = goToPage(exercise, 17);
  left = setZoom(left, 2.5);
  left = panBy(left, -30, -40, { width: 100, height: 100 }, { width: 500, height: 500 });

  // The answer pane must be untouched by every one of those.
  assert.equal(answers.pageNumber, 1);
  assert.equal(answers.zoom, 1);
  assert.equal(answers.scrollX, 0);
  assert.equal(answers.scrollY, 0);
  assert.equal(answers.pageCount, 120);

  // And the reverse direction.
  const right = goToPage(answers, 99);
  assert.equal(left.pageNumber, 17);
  assert.equal(left.zoom, 2.5);
  assert.equal(right.pageNumber, 99);
});

check('state transitions are immutable — no in-place mutation to leak', () => {
  const before = createViewState(10);
  const after = goToPage(before, 5);
  assert.notEqual(before, after);
  assert.equal(before.pageNumber, 1, 'original must be unchanged');
  assert.ok(Object.isFrozen(before) && Object.isFrozen(after));
});

check('each pane clamps against its OWN page count', () => {
  const short = goToPage(createViewState(3), 100);
  const long = goToPage(createViewState(500), 100);
  assert.equal(short.pageNumber, 3);
  assert.equal(long.pageNumber, 100);
});

// ═══════════════════════════════════════════════════════════════
group('4. Workspace layout — divider, orientation, focus');

check('the divider travels the whole way, and 0 is a real ratio', () => {
  const s = createWorkspaceState();
  assert.equal(MIN_RATIO, 0, 'a pane may be collapsed entirely — that is how it is closed');
  assert.equal(MAX_RATIO, 1);
  assert.equal(setDividerRatio(s, -1).dividerRatio, MIN_RATIO, 'out of range still clamps');
  assert.equal(setDividerRatio(s, 2).dividerRatio, MAX_RATIO);
  assert.equal(setDividerRatio(s, 0.35).dividerRatio, 0.35);

  // 0 is falsy, and the old `Number(v) || 0.5` read it as "not supplied" and
  // snapped the divider back to centre — undoing the drag that closed a pane,
  // and reopening it on the next session restore.
  assert.equal(setDividerRatio(s, 0).dividerRatio, 0, '0 must survive as 0');
  assert.equal(createWorkspaceState({ dividerRatio: 0 }).dividerRatio, 0,
    'and must survive a restore');
  assert.equal(createWorkspaceState({}).dividerRatio, 0.5, 'a missing ratio still centres');
});

check('every ratio in range is a legal resting place', () => {
  const s = createWorkspaceState();
  // No preset stops and no detents: the divider rests where it is put.
  for (const r of [0, 0.04, 0.12, 0.28, 0.41, 0.5, 0.63, 0.77, 0.88, 0.96, 1]) {
    assert.equal(setDividerRatio(s, r).dividerRatio, r, `${r} must survive untouched`);
  }
});

check('a swapped pane keeps the width it had', () => {
  let s = createWorkspaceState();
  // paneFractions only honours the divider once BOTH panes hold a document.
  s = assignDocument(s, SLOTS.PRIMARY, 'exercise');
  s = assignDocument(s, SLOTS.SECONDARY, 'answer');
  s = setDividerRatio(s, 0.72);
  assert.equal(s.swapped, false, 'the natural order is primary-left');

  s = swapSides(s);
  assert.equal(s.swapped, true, 'the sides are exchanged');
  // The ratio belongs to the slot, and the slot takes its width across with
  // it. Mirroring it here would hand the space to the other document — the one
  // the user did NOT just make room for.
  assert.equal(s.dividerRatio, 0.72, 'the pane that was wide is still wide');
  assert.equal(paneFractions(s)[SLOTS.PRIMARY], 0.72);

  s = swapSides(s);
  assert.equal(s.swapped, false, 'swapping twice returns to the start');
  assert.equal(s.dividerRatio, 0.72);
});

check('a swap never moves a document between slots', () => {
  let s = createWorkspaceState();
  s = assignDocument(s, SLOTS.PRIMARY, 'exercise');
  s = assignDocument(s, SLOTS.SECONDARY, 'answer');
  const before = { ...s.documents };

  s = swapSides(s);

  // Only the SIDE changes. The slots keep their documents, which is what lets
  // the panes keep their rendered pages, ink and scroll position.
  assert.deepEqual({ ...s.documents }, before,
    'swapping is a layout change, not a re-seating of documents');
});

check('swapping at an extreme ratio is still an extreme', () => {
  let s = setDividerRatio(createWorkspaceState(), 0.05);
  s = swapSides(s);
  assert.equal(s.dividerRatio, 0.05, 'the sliver stays a sliver, on the other side');
  assert.ok(s.dividerRatio <= MAX_RATIO && s.dividerRatio >= MIN_RATIO);
});

check('swapped survives serialization', () => {
  let s = swapSides(createWorkspaceState());
  const restored = createWorkspaceState(serializeWorkspaceState(s));
  assert.equal(restored.swapped, true, 'the arrangement is remembered across restarts');
});

check('landscape lays out in a row, portrait stacks', () => {
  assert.equal(orientationForViewport(1280, 800), ORIENTATIONS.ROW);
  assert.equal(orientationForViewport(800, 1280), ORIENTATIONS.COLUMN);
  assert.equal(orientationForViewport(1000, 1000), ORIENTATIONS.ROW);
});

check('pane fractions follow the divider when two documents are open', () => {
  let s = createWorkspaceState();
  s = assignDocument(s, SLOTS.PRIMARY, 'exercise');
  s = assignDocument(s, SLOTS.SECONDARY, 'answers');
  s = setDividerRatio(s, 0.3);
  const f = paneFractions(s);
  assert.equal(f[SLOTS.PRIMARY], 0.3);
  assert.ok(Math.abs(f[SLOTS.SECONDARY] - 0.7) < 1e-9);
  assert.equal(isDualMode(s), true);
});

check('a single open document fills the workspace', () => {
  let s = assignDocument(createWorkspaceState(), SLOTS.SECONDARY, 'only');
  const f = paneFractions(s);
  assert.equal(f[SLOTS.SECONDARY], 1);
  assert.equal(f[SLOTS.PRIMARY], 0);
  assert.equal(isDualMode(s), false);
});

check('focus mode maximises one pane without closing the other', () => {
  let s = createWorkspaceState();
  s = assignDocument(s, SLOTS.PRIMARY, 'exercise');
  s = assignDocument(s, SLOTS.SECONDARY, 'answers');
  s = toggleFocus(s, SLOTS.PRIMARY);

  const f = paneFractions(s);
  assert.equal(f[SLOTS.PRIMARY], 1);
  assert.equal(f[SLOTS.SECONDARY], 0);
  // Still open — focus is not a close.
  assert.deepEqual(openSlots(s), [SLOTS.PRIMARY, SLOTS.SECONDARY]);
  assert.equal(isDualMode(s), false);

  s = toggleFocus(s, SLOTS.PRIMARY);
  assert.equal(s.focusedSlot, null);
  assert.equal(isDualMode(s), true);
});

check('closing the focused pane releases focus', () => {
  let s = createWorkspaceState();
  s = assignDocument(s, SLOTS.PRIMARY, 'a');
  s = assignDocument(s, SLOTS.SECONDARY, 'b');
  s = toggleFocus(s, SLOTS.SECONDARY);
  s = closeSlot(s, SLOTS.SECONDARY);
  assert.equal(s.focusedSlot, null, 'focus must not point at an empty pane');
  assert.deepEqual(openSlots(s), [SLOTS.PRIMARY]);
});

check('changing layout never touches which documents are open', () => {
  let s = createWorkspaceState();
  s = assignDocument(s, SLOTS.PRIMARY, 'exercise');
  s = assignDocument(s, SLOTS.SECONDARY, 'answers');
  const before = { ...s.documents };
  s = setDividerRatio(s, 0.25);
  s = setOrientation(s, ORIENTATIONS.COLUMN);
  s = toggleFocus(s, SLOTS.PRIMARY);
  s = clearFocus(s);
  assert.deepEqual({ ...s.documents }, before);
});

// ═══════════════════════════════════════════════════════════════
group('5. Session persistence');

check('view state serialises exactly the restorable scalars', () => {
  let s = createViewState(40, { pageNumber: 12 });
  s = setZoom(s, 1.75);
  const json = serializeViewState(s);
  assert.deepEqual(Object.keys(json).sort(),
    ['fitMode', 'pageNumber', 'scrollX', 'scrollY', 'zoom']);
  assert.equal(json.pageNumber, 12);
  assert.equal(json.zoom, 1.75);
});

check('a restored page beyond a shorter document is clamped, not broken', () => {
  // Session saved against a 200-page book, restored against a 10-page one.
  const restored = createViewState(10, { pageNumber: 180, zoom: 2 });
  assert.equal(restored.pageNumber, 10);
  assert.equal(restored.zoom, 2);
});

// ═══════════════════════════════════════════════════════════════
group('6. Outline — preserved, never fabricated');

const pdfDocSource = $read('src/pdf/pdf-document.js');

ok(pdfDocSource.includes('NO_OUTLINE'), 'an explicit "no outline" result exists');
ok(
  /available:\s*false/.test(pdfDocSource),
  'a document without bookmarks reports available: false',
);
ok(
  pdfDocSource.includes('pdf.getOutline'),
  'the outline comes from the document itself',
);
ok(
  !/generateOutline|synthesi[sz]eOutline|buildOutlineFromPages/i.test(pdfDocSource),
  'no code path force-generates a table of contents',
);

const workspaceSource = $read('src/pdf/pdf-workspace.js');
ok(
  workspaceSource.includes('pdf.noOutline'),
  'the UI states plainly when a document has no table of contents',
);
ok(
  /pageNumber\s*\)/.test(workspaceSource) && workspaceSource.includes('disabled = true'),
  'outline entries with an unresolvable destination are not navigable',
);

// ═══════════════════════════════════════════════════════════════
group('7. Module wiring');

for (const f of [
  'src/pdf/pdf-document.js',
  'src/pdf/pdf-library.js',
  'src/pdf/pdf-view-state.js',
  'src/pdf/workspace-state.js',
  'src/pdf/document-session.js',
  'src/pdf/pdf-pane.js',
  'src/pdf/pdf-workspace.js',
  'src/pdf/pdf-workspace-ui.js',
  'src/styles/pdf.css',
]) {
  ok(existsSync(join(ROOT, f)), `${f} exists`);
}

const appSource = $read('src/core/app.js');
ok(appSource.includes('initPdfWorkspace'), 'workspace is initialised from app start');
const html = $read('index.html');
ok(html.includes('id="page-pdf"'), 'the PDF page exists in index.html');
ok(html.includes('data-page="pdf"'), 'the PDF tab is reachable from the bottom nav');
ok($read('src/main.js').includes('styles/pdf.css'), 'pdf styles are bundled');

// pdf.js is a vendored global, not an npm import — the workspace must use it
// the same way the rest of the app does, or it will not exist at runtime.
ok(
  pdfDocSource.includes('window.pdfjsLib'),
  'the PDF module uses the vendored pdfjsLib global',
);
ok(
  !/from ['"]pdfjs-dist/.test(pdfDocSource),
  'the PDF module does not import pdfjs-dist (it is not bundled)',
);

// Images and documents stay on device.
const librarySource = $read('src/pdf/pdf-library.js');
ok(
  !/fetch\(|XMLHttpRequest|image_url/.test(librarySource),
  'the PDF library never uploads documents',
);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
