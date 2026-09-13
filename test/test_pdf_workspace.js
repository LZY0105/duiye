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

group('11. 同一本书可以同时开在两栏（A09）');

{
  const { PdfWorkspace } = await import('../src/pdf/pdf-workspace.js');
  const { openInSlot } = await import('../src/pdf/workspace-state.js');

  // 只给 _destinationSpec 用得着的那几样：它不碰 DOM，也不出文案。
  const wsWith = (state) => {
    const ws = Object.create(PdfWorkspace.prototype);
    // describeEntry 会去问「这一栏此刻装着什么」，空着就是空着。
    Object.assign(ws, { state, panes: {}, scratchPanes: {}, pads: {}, _names: {} });
    return ws;
  };

  // 一栏里已经有这本书
  const inA = openInSlot(createWorkspaceState(), SLOTS.PRIMARY,
    { kind: 'pdf', resourceId: 'book-x' }).state;

  check('已经开着的书再点一次，照样问开到哪一栏', () => {
    const spec = wsWith(inA)._destinationSpec('book-x');
    assert.equal(spec.openIn, SLOTS.PRIMARY, '认得出它在哪一栏');
    assert.equal(spec.options.length, 2, '两栏都给，回到它那儿也只是一下');
  });

  check('默认落在另一栏——看得见它在那儿还来点，多半是想对照', () => {
    assert.equal(wsWith(inA)._destinationSpec('book-x').preferred, SLOTS.SECONDARY);
  });

  check('没开过的书，默认还是空的那一栏', () => {
    const spec = wsWith(inA)._destinationSpec('book-y');
    assert.equal(spec.openIn, null, '它不在任何一栏');
    assert.equal(spec.preferred, SLOTS.SECONDARY, '空的那一栏');
  });

  check('选它已经在的那一栏，是回到它那儿，不是开第二份', () => {
    // 这一条是 openInSlot 的老规矩，这里钉住：一栏里同一份文件只能有一项，
    // 否则两个阅读位置会抢同一个页码。
    const { state, entry } = openInSlot(inA, SLOTS.PRIMARY,
      { kind: 'pdf', resourceId: 'book-x' });
    assert.equal(state.decks[SLOTS.PRIMARY].entries.length, 1, '还是一项');
    assert.equal(entry.resourceId, 'book-x');
  });

  check('选另一栏，两栏各有各的一项，各记各的页码', () => {
    const both = openInSlot(inA, SLOTS.SECONDARY,
      { kind: 'pdf', resourceId: 'book-x' }).state;
    const a = both.decks[SLOTS.PRIMARY].entries[0];
    const b = both.decks[SLOTS.SECONDARY].entries[0];
    assert.equal(a.resourceId, b.resourceId, '同一本书');
    assert.notEqual(a.id, b.id, '两条不同的 entry——页码和缩放是按 entry 记的');
  });

  check('两栏都已经有了，就没有「它在哪一栏」这回事，照常问', () => {
    const both = openInSlot(inA, SLOTS.SECONDARY,
      { kind: 'pdf', resourceId: 'book-x' }).state;
    const spec = wsWith(both)._destinationSpec('book-x');
    assert.equal(spec.openIn, null);
    assert.equal(spec.options.length, 2);
  });
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
// 目录抽取搬到了 pdf-extract.js —— 渲染 worker 和主线程回退路径共用同一份实现，
// 不共用的话两条路能对出不同的目录。规矩没变，所以这几条断言跟着搬到新家去查，
// 而不是放宽成「在任意文件里出现过」。
const pdfExtractSource = $read('src/pdf/pdf-extract.js');

ok(pdfDocSource.includes('NO_OUTLINE'), 'an explicit "no outline" result exists');
ok(
  /available:\s*false/.test(pdfExtractSource),
  'a document without bookmarks reports available: false',
);
ok(
  pdfExtractSource.includes('pdf.getOutline'),
  'the outline comes from the document itself',
);
ok(
  !/generateOutline|synthesi[sz]eOutline|buildOutlineFromPages/i
    .test(pdfDocSource + pdfExtractSource),
  'no code path force-generates a table of contents',
);

const workspaceSource = $read('src/pdf/pdf-workspace.js');
// The outline moved out of the workspace and into the find-a-page panel, where
// it now shares a home with the thumbnails and the bookmarks. The rules did
// not move: a book without a table of contents still says so, and an entry
// pointing nowhere is still shown but not offered.
const panelSource = $read('src/pdf/page-panel.js');
ok(
  panelSource.includes('pdf.noOutline'),
  'the UI states plainly when a document has no table of contents',
);
ok(
  /pageNumber\s*\)/.test(panelSource) && panelSource.includes('disabled = true'),
  'outline entries with an unresolvable destination are not navigable',
);
ok(
  panelSource.includes("t('panel.thumbs')") && panelSource.includes("t('panel.marks')"),
  'and the same panel offers the two ways in that need no table of contents',
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

// ═══════════════════════════════════════════════════════════════
group('9. Slot toolbar — what it carries, and what it no longer does');

const paneSource = $read('src/pdf/pdf-pane.js');

check('the 保存 button is gone, and the autosave that made it redundant is not', () => {
  // Annotations were already written on a 400ms debounce, flushed on every page
  // change and again on unload; the button only reported what had happened.
  assert.ok(!/data-role="save-ink"/.test(workspaceSource), 'no save button on the bar');
  assert.ok(!/saveNow/.test(workspaceSource + paneSource), 'and no handler left behind');
  assert.ok(/_scheduleInkSave\(\)/.test(paneSource), 'the debounce stays');
  assert.ok(/_flushInkSave\(\)/.test(paneSource), 'and so does the flush it ends in');
  const unload = paneSource.slice(paneSource.indexOf('  unload() {'));
  assert.ok(/_flushInkSave\(\)/.test(unload.slice(0, 400)),
    'closing a book still commits the strokes drawn just before it closed');
});

check('the 题号 field is gone, along with the state nothing read', () => {
  // `pane.exerciseLabel` was written by that input and cleared on unload, and
  // never read: answer lookup resolves questions from the page number and the
  // question index, not from a typed label.
  assert.ok(!/data-role="exercise-label"/.test(workspaceSource), 'no field on the bar');
  assert.ok(!/exerciseLabel/.test(workspaceSource + paneSource), 'and no dead field behind it');
  assert.ok(/questionsOnPage\(pane\.questionIndex, page\)/.test(workspaceSource),
    'answer lookup still asks the page, which is what it always used');
});

check('taking content out of a pane is behind the ⋯ menu, not on the bar', () => {
  // It was the last control on the bar, against the edge of the screen, and it
  // threw away the reading position of a book someone was working in.
  //
  // The action is now "remove from this pane" rather than "close": the resource
  // stays in its library and the pane falls to whatever was rotated underneath.
  // Its label comes from the language pack, so the wording is asserted there
  // rather than here.
  const chrome = workspaceSource.slice(workspaceSource.indexOf('function slotChrome'));
  assert.ok(/data-role="slot-more"/.test(chrome), 'the bar ends with the menu button');
  assert.ok(/data-role="slot-menu"/.test(chrome), 'and the menu is a panel of its own');
  assert.ok(!/pdf-slot-btn" data-role="close"/.test(chrome),
    'the ✕ is no longer one of the toolbar buttons');
  const menu = chrome.slice(chrome.indexOf('data-role="slot-menu"'),
    chrome.indexOf('pdf-outline-panel'));
  assert.ok(/data-role="close"/.test(menu), 'removing is an item inside it');
  assert.ok(/is-danger/.test(menu), 'and it is marked as the destructive one');
  assert.ok(/deck\.removeFromPane/.test(workspaceSource),
    'named in words from the language pack, not as a glyph');
  assert.ok(/_closeSlotMenus\(\)/.test(workspaceSource),
    'and a press anywhere else puts the menu away');
});

// ═══════════════════════════════════════════════════════════════
group('10. A document remembers where it was left');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const { rememberDocView, recallDocView, forgetDocView } = await import('../src/pdf/document-session.js');

check('a book reopens on the page it was left on', () => {
  // The session remembers a SLOT, which is right for "reopen the app". Closing
  // a book and opening it again is a different question, and it used to be
  // answered with page 1 of a book the reader was forty pages into.
  store.clear();
  assert.equal(recallDocView('book-a'), null, 'a book never opened has no place yet');

  rememberDocView('book-a', createViewState(400, { pageNumber: 42, zoom: 1.5 }));
  const back = recallDocView('book-a');
  assert.equal(back.pageNumber, 42, 'the page comes back');
  assert.equal(back.zoom, 1.5, 'and the zoom it was being read at');

  rememberDocView('book-b', createViewState(10, { pageNumber: 3 }));
  assert.equal(recallDocView('book-a').pageNumber, 42, 'one book does not overwrite another');

  forgetDocView('book-a');
  assert.equal(recallDocView('book-a'), null, 'and a deleted book is forgotten');
  assert.equal(recallDocView('book-b').pageNumber, 3, 'without taking its neighbour with it');
});

check('the remembered places are bounded, oldest first', () => {
  store.clear();
  for (let i = 0; i < 60; i++) {
    rememberDocView(`doc-${i}`, createViewState(10, { pageNumber: 2 }));
  }
  const kept = Object.keys(JSON.parse(store.get('ls_pdf_doc_views')));
  assert.ok(kept.length <= 48, `kept ${kept.length}, which must not grow without limit`);
  assert.ok(kept.includes('doc-59'), 'the most recent is still there');
  assert.ok(!kept.includes('doc-0'), 'and the oldest has been dropped');
});

// `_persist()` is called from `onStateChange`, which fires on every frame of a
// pan. saveSession() is one stringify of a few scalars and is meant to run
// there. Filing each book's place is not: it reads, parses, rewrites and stores
// a map of every document opened, once per pane. Hung off the same beat it
// tripled the storage traffic on the main thread, under a stylus sampling at
// 120Hz — the exact cost this release exists to remove.
{
  const { PdfWorkspace } = await import('../src/pdf/pdf-workspace.js');
  store.clear();
  let docViewWrites = 0;
  const realSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (k, v) => {
    if (k === 'ls_pdf_doc_views') docViewWrites++;
    return realSet(k, v);
  };

  const ws = Object.create(PdfWorkspace.prototype);
  Object.assign(ws, {
    state: assignDocument(createWorkspaceState(), SLOTS.PRIMARY, 'book-x'),
    panes: {
      [SLOTS.PRIMARY]: { state: createViewState(100, { pageNumber: 12 }) },
      [SLOTS.SECONDARY]: { state: null },
    },
  });

  for (let frame = 0; frame < 60; frame++) ws._persist();
  ok(docViewWrites === 0, 'sixty frames of panning do not write a book\'s place once',
    `wrote ${docViewWrites} times`);

  await new Promise((r) => setTimeout(r, 500));      // past DOC_VIEW_SETTLE
  ok(docViewWrites === 1, 'and once the hand stops, exactly one write',
    `wrote ${docViewWrites} times`);
  ok(recallDocView('book-x')?.pageNumber === 12, 'with the right page in it');

  // Closing does not wait for the debounce: it is the last chance to record.
  clearTimeout(ws._docViewTimer);
  ws.panes[SLOTS.PRIMARY].state = createViewState(100, { pageNumber: 44 });
  ws._rememberSlotView(SLOTS.PRIMARY);
  ok(recallDocView('book-x')?.pageNumber === 44, 'closing files it at once, unwaited');

  globalThis.localStorage.setItem = realSet;
}

check('a session restore still outranks the remembered place', () => {
  // Reopening the app must show the workspace as it was left, not each book at
  // wherever it was last read from the library.
  //
  // A third claimant sits between them now: when this pane's deck already holds
  // an entry for the resource, opening it is a RECALL, and that entry's own
  // page is where it should land — which is what keeps one PDF at two different
  // pages in the two panes. It outranks the library-wide place for the same
  // reason the restore does, and is itself outranked by the restore.
  // The chain lives in `_preparePdf` now — the half of the handoff that gets a
  // book onto the screen. `openDocument` is a thin wrapper over it.
  const open = workspaceSource.slice(workspaceSource.indexOf('async _preparePdf'));
  const chain = open.slice(0, 1600);
  const at = (needle) => chain.indexOf(needle);
  assert.ok(at('restoredView') > -1, 'the restored view is consulted');
  assert.ok(at('viewForEntry(entry.id)') > at('restoredView'),
    'the restored view is consulted first');
  assert.ok(at('recallDocView(entry.resourceId)') > at('viewForEntry(entry.id)'),
    'and this entry\'s own page outranks wherever the book was last read');
});

check('storage being unavailable loses the place, not the pane', () => {
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  assert.equal(recallDocView('anything'), null);
  rememberDocView('anything', createViewState(10, { pageNumber: 4 }));
  forgetDocView('anything');
  globalThis.localStorage = real;
});

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
