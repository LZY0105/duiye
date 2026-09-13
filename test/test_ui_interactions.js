#!/usr/bin/env node
// UI details that only show up when something is driven, not inspected.
//
// Three things live here because each one is a behaviour a static read of the
// source cannot confirm: what the lasso actually paints, what the answer panel
// tells the reader to do next, and whether a row opens on a double-tap.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { LASSO_STROKE, createTransform, drawLasso } from '../src/ink/ink-renderer.js';
import {
  LASSO_MODES, LASSO_SHAPES, LASSO_TOOL,
  createToolbarState, serializeToolbarState, setLassoMode, setLassoShape,
} from '../src/ink/toolbar-state.js';
import { INPUT_MODES, InkSurface } from '../src/ink/ink-surface.js';
import { InkToolbar } from '../src/ink/ink-toolbar.js';
import { PdfWorkspace } from '../src/pdf/pdf-workspace.js';
import { PdfPane } from '../src/pdf/pdf-pane.js';
import { SLOTS, CLOSE_THRESHOLD } from '../src/pdf/workspace-state.js';
import { renderAnswerNotice } from '../src/pdf/answer-panel.js';
import { onDoubleTap } from '../src/ui/double-tap.js';
import { initChromeHiding } from '../src/pdf/pdf-workspace-ui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const $read = (f) => readFileSync(join(ROOT, f), 'utf-8');
/** Source with comments stripped, so prose about a banned identifier is not a match. */
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
/** For the few checks that have to let a timer run before they can look. */
async function checkAsync(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── environment ─────────────────────────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'PointerEvent', 'Event', 'getComputedStyle', 'localStorage', 'AbortController', 'AbortSignal']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, {
    value: dom.window[key], configurable: true, writable: true,
  });
}

/**
 * A canvas context that records what was asked of it.
 *
 * There is no way to look at a canvas from Node, and asserting on the source
 * text instead would only prove the colour is written down somewhere — not
 * that it is the colour the loop is stroked with, or that a fill was never
 * issued. The recorder answers both.
 */
function recordingCtx() {
  const calls = [];
  const state = {};
  const record = (name) => (...args) => calls.push({ name, args });
  const ctx = {
    calls,
    state,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    setLineDash: (d) => { state.dash = d; calls.push({ name: 'setLineDash', args: [d] }); },
  };
  // Style properties are assigned, not called, so they are captured on write.
  for (const prop of ['strokeStyle', 'fillStyle', 'lineWidth', 'lineJoin', 'lineCap']) {
    let value;
    Object.defineProperty(ctx, prop, {
      get: () => value,
      set: (v) => { value = v; calls.push({ name: `set:${prop}`, args: [v] }); },
    });
  }
  return ctx;
}

const named = (ctx, name) => ctx.calls.filter(c => c.name === name);
const lastSet = (ctx, prop) => {
  const c = named(ctx, `set:${prop}`);
  return c.length ? c[c.length - 1].args[0] : undefined;
};

/** WCAG relative-contrast against white, for the colour assertions below. */
function contrastOnWhite(hex) {
  const h = hex.replace('#', '');
  const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [0, 2, 4].map(i => channel(parseInt(h.slice(i, i + 2), 16) / 255));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (L + 0.05);
}

const T = createTransform(1, 0, 0);
const LOOP = [
  { x: 10, y: 10 }, { x: 60, y: 12 }, { x: 64, y: 70 }, { x: 12, y: 66 },
];

console.log('═══════════════════════════════════════════════════════════════');
console.log('  UI interactions — lasso paint, answer notice, double-tap');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. The lasso is a drawn gold line, and nothing else');

check('the loop is stroked in the app gold, dashed', () => {
  const ctx = recordingCtx();
  drawLasso(ctx, LOOP, T);
  assert.equal(lastSet(ctx, 'strokeStyle'), LASSO_STROKE);
  assert.equal(LASSO_STROKE, '#d97706', 'the same gold as --math-gold in base.css');
  assert.ok(Array.isArray(ctx.state.dash) && ctx.state.dash.length === 2, 'it must be dashed');
  assert.equal(named(ctx, 'stroke').length, 1);
});

check('nothing is filled — the ink underneath must not be tinted', () => {
  const ctx = recordingCtx();
  drawLasso(ctx, LOOP, T, { closed: true });
  assert.equal(named(ctx, 'fill').length, 0, 'a fill would tint the very ink being selected');
});

check('the line follows every point of the loop, in order', () => {
  const ctx = recordingCtx();
  drawLasso(ctx, LOOP, T);
  const moves = named(ctx, 'moveTo');
  const lines = named(ctx, 'lineTo');
  assert.equal(moves.length, 1, 'one pen-down');
  assert.equal(lines.length, LOOP.length - 1, 'and a segment to every other point');
  assert.deepEqual(moves[0].args, [10, 10]);
  assert.deepEqual(lines[lines.length - 1].args, [12, 66]);
});

check('it closes only once the gesture has ended', () => {
  const live = recordingCtx();
  drawLasso(live, LOOP, T, { tip: true });
  assert.equal(named(live, 'closePath').length, 0, 'an open loop is still being drawn');

  const settled = recordingCtx();
  drawLasso(settled, LOOP, T, { closed: true });
  assert.equal(named(settled, 'closePath').length, 1, 'a released loop closes');
});

check('a ring rides the tip while the loop is open, and only then', () => {
  const live = recordingCtx();
  drawLasso(live, LOOP, T, { tip: true });
  const arcs = named(live, 'arc');
  assert.equal(arcs.length, 1, 'one ring');
  assert.deepEqual(arcs[0].args.slice(0, 2), [12, 66], 'it sits on the last point drawn');

  const settled = recordingCtx();
  drawLasso(settled, LOOP, T, { closed: true });
  assert.equal(named(settled, 'arc').length, 0, 'a closed loop has no tip to mark');
});

check('a loop of fewer than two points draws nothing at all', () => {
  const ctx = recordingCtx();
  drawLasso(ctx, [{ x: 1, y: 1 }], T);
  drawLasso(ctx, [], T);
  drawLasso(ctx, null, T);
  assert.equal(ctx.calls.length, 0);
});

check('the surface paints the live loop and the settled one the same way', () => {
  // Same renderer for both, so releasing the stylus cannot change how the
  // selection looks — it only closes.
  const code = $read('src/ink/ink-surface.js');
  assert.ok(/drawLasso\(this\.ctx, this\._loop, this\.transform, \{/.test(code),
    'the live loop goes through it');
  assert.ok(/drawLasso\(this\.ctx, loop, this\.transform, \{ closed: true \}\)/.test(code),
    'and so does the settled one');
  assert.equal((code.match(/drawLasso\(/g) || []).length, 2,
    'two call sites, one renderer — no second way of drawing a loop');
  // A dragged box is already closed, so it gets no tip ring to close back to.
  assert.ok(/tip: this\.lassoShape !== 'rect'/.test(code));
  assert.ok(!/rgba\(10, 96, 255/.test(code), 'the blue marquee is gone');
});

// ═══════════════════════════════════════════════════════════════
group('2. The answer notice says what to do about it');

check('a notice with a hint renders both lines', () => {
  const host = document.createElement('div');
  renderAnswerNotice(host, '习题册中没有识别到编号题目', { hint: '请检查答案是否上传正确' });
  const notice = host.querySelector('.answer-notice');
  const hint = host.querySelector('.answer-notice-hint');
  assert.ok(notice, 'the reason');
  assert.ok(hint, 'and the remedy');
  assert.equal(notice.textContent, '习题册中没有识别到编号题目');
  assert.equal(hint.textContent, '请检查答案是否上传正确');
});

check('a notice without a hint gains no empty element', () => {
  const host = document.createElement('div');
  renderAnswerNotice(host, '请在另一侧打开答案册');
  assert.equal(host.querySelector('.answer-notice-hint'), null);
});

check('both lines are escaped, not interpreted', () => {
  const host = document.createElement('div');
  renderAnswerNotice(host, '<img src=x onerror=1>', { hint: '<b>x</b>' });
  assert.equal(host.querySelector('img'), null, 'a document name is not markup');
  assert.equal(host.querySelector('.answer-notice-hint b'), null);
});

check('the blocked-index notice is the one that carries the hint', () => {
  const code = $read('src/pdf/pdf-workspace.js');
  assert.ok(
    code.includes("notice(blocked, '请检查答案是否上传正确')"),
    'every describeUnusable branch means a book did not index',
  );
});

check('every notice can be dismissed, not only the ones with answers in them', () => {
  const code = $read('src/pdf/pdf-workspace.js');
  assert.equal(
    (code.match(/renderAnswerNotice\(/g) || []).length, 1,
    'one call site, so no branch can quietly ship an undismissable panel',
  );
  assert.ok(/onDismiss: \(\) => this\.hideAnswers\(slot\)/.test(code));
  // Six messages, all through the same helper.
  assert.ok((code.match(/\bnotice\(/g) || []).length >= 6);
});

check('the close button dismisses the notice', () => {
  const host = document.createElement('div');
  let dismissed = 0;
  renderAnswerNotice(host, '习题册中没有识别到编号题目', {
    hint: '请检查答案是否上传正确',
    onDismiss: () => { dismissed++; },
  });
  const close = host.querySelector('[data-role="close-answers"]');
  assert.ok(close, 'a panel that reports a failure needs a way out');
  assert.ok(close.getAttribute('aria-label'), 'and a name, for a reader who cannot see the ✕');
  close.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(dismissed, 1);
});

check('the notice and the answer header share one close button', () => {
  // Two hand-written copies of the same control drift; this one is built once.
  const code = $read('src/pdf/answer-panel.js');
  assert.equal((code.match(/class="answer-close"/g) || []).length, 1);
  assert.ok(/closeButtonHtml\('完成，收起答案'\)/.test(code));
});

check('the per-page notice carries the advice too', () => {
  // ANS-02 on the tablet: the page that reported "no numbered question" showed
  // the reason with no guidance under it. From the reader's side that case and
  // the whole-book one are the same situation, and have the same first check.
  const code = $read('src/pdf/pdf-workspace.js');
  assert.ok(
    code.includes("notice(`第 ${page} 页没有识别到编号题目`, '请检查答案是否上传正确')"),
    'the per-page notice must say what to do about it',
  );
});

check('opening 显示答案 navigates, not only the small pill', () => {
  // ANS-05 / ANS-06: the pill in the header was the only control that took the
  // reader to the answer page, sitting beside a much larger control that says
  // "show the answer" and did nothing but expand a panel.
  const code = $read('src/pdf/answer-panel.js');
  assert.ok(/\.answer-reveal'\)\?\.addEventListener\('toggle'/.test(code),
    'opening the disclosure must reveal for real');
  assert.ok(/if \(e\.target\.open\) onReveal\?\.\(match\)/.test(code),
    'and only on opening it, never on closing');
});

check('a settings card keeps its own gestures off the page', () => {
  // ERA-03: dragging the eraser-size slider panned the PDF, turned the page,
  // and dismissed the card out from under the finger still holding the slider.
  const code = $read('src/ink/ink-toolbar.js');
  assert.ok(/for \(const type of \['pointerdown', 'pointermove', 'pointerup'\]\)/.test(code),
    'the card must stop its pointer events reaching the page');
  assert.ok(/slider\.style\.touchAction = 'none'/.test(code),
    'and a range input must claim the gesture so the WebView cannot call it a swipe');
});

check('the hint is styled in the gold, not in an error red', () => {
  const css = $read('src/styles/pdf.css');
  const rule = css.match(/\.answer-notice-hint\s*\{[^}]*\}/);
  assert.ok(rule, 'the hint must be styled');
  assert.ok(/var\(--math-gold-ink\)/.test(rule[0]), 'advice, not a failure');
  assert.ok(/font-weight:\s*600/.test(rule[0]), 'and heavy enough to be seen');

  // The text variant has to be readable, not merely gold.
  const base = $read('src/styles/base.css');
  const ink = base.match(/--math-gold-ink:\s*(#[0-9a-f]{6})/i);
  assert.ok(ink, '--math-gold-ink must be defined');
  assert.ok(contrastOnWhite(ink[1]) >= 4.5,
    `${ink[1]} is ${contrastOnWhite(ink[1]).toFixed(2)}:1 on white — advice nobody can read`);

  // And the loop's own gold still clears the 3:1 a graphic needs.
  assert.ok(contrastOnWhite(LASSO_STROKE) >= 3,
    'the lasso line has to be visible on a white page');
});

// ═══════════════════════════════════════════════════════════════
group('3. The lasso has a card of its own');

check('re-tapping the lasso opens its card, the way every other tool does', () => {
  const code = $read('src/ink/ink-toolbar.js');
  assert.ok(/tool === LASSO_TOOL \? CARDS\.LASSO/.test(code));
  assert.ok(/_lassoCardHtml/.test(code), 'and the card exists');
});

check('the card offers the two shapes and the two ways of catching', () => {
  const state = createToolbarState();
  assert.equal(state.lassoShape, LASSO_SHAPES.FREE, 'freehand is the default');
  assert.equal(state.lassoMode, LASSO_MODES.TOUCH, 'and the forgiving reading');

  const rect = setLassoShape(state, LASSO_SHAPES.RECT);
  assert.equal(rect.lassoShape, LASSO_SHAPES.RECT);
  assert.equal(rect.tool, LASSO_TOOL, 'choosing a lasso setting selects the lasso');

  const strict = setLassoMode(state, LASSO_MODES.INSIDE);
  assert.equal(strict.lassoMode, LASSO_MODES.INSIDE);
  assert.equal(strict.tool, LASSO_TOOL);

  assert.equal(setLassoShape(state, 'nonsense').lassoShape, LASSO_SHAPES.FREE);
  assert.equal(setLassoMode(state, 'nonsense').lassoMode, LASSO_MODES.TOUCH);
});

check('both settings survive a restart', () => {
  const chosen = setLassoMode(
    setLassoShape(createToolbarState(), LASSO_SHAPES.RECT), LASSO_MODES.INSIDE,
  );
  const back = createToolbarState(serializeToolbarState(chosen));
  assert.equal(back.lassoShape, LASSO_SHAPES.RECT);
  assert.equal(back.lassoMode, LASSO_MODES.INSIDE);
});

check('the settings reach the surface, and the surface takes only valid ones', () => {
  const code = $read('src/ink/ink-toolbar.js');
  assert.ok(/surface\.setLasso\(\{/.test(code), 'the card must actually do something');

  const surface = Object.create(InkSurface.prototype);
  surface.lassoShape = 'free';
  surface.lassoInside = false;
  surface.setLasso({ shape: 'rect', mode: 'inside' });
  assert.equal(surface.lassoShape, 'rect');
  assert.equal(surface.lassoInside, true);
  surface.setLasso({ shape: 'circle', mode: 'whatever' });
  assert.equal(surface.lassoShape, 'rect', 'a value it does not know is ignored, not stored');
  assert.equal(surface.lassoInside, true);
});

/** A surface with a selection of the given document size, at the given zoom. */
function sized(zoom, w, h) {
  const surface = Object.create(InkSurface.prototype);
  surface.transform = { scale: zoom, offsetX: 0, offsetY: 0 };
  surface.selectionLoop = w
    ? [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
    : null;
  return surface;
}

check('the handle scales with the page zoom, everywhere in the useful range', () => {
  const r = (zoom) => sized(zoom, 200, 150)._handleRadius();
  assert.equal(r(1), 9, 'at 100% it is the size it always was');

  // Monotonic across the whole practical range. The earlier version clamped
  // outside 0.78x–1.78x, so it was frozen for most of the zooms anyone uses,
  // which is the same complaint in a narrower band.
  let last = 0;
  for (const z of [0.5, 0.75, 1, 1.5, 2, 3, 4]) {
    const v = r(z);
    assert.ok(v > last, `must still be growing at ${z}x`);
    last = v;
  }
  assert.ok(r(4) < r(1) * 4, 'damped — 1:1 would be a blob at 4x');
  assert.equal(r(64), 20, 'and it stops before it hides the ink');
  assert.equal(r(0.001), 6, 'and before a stylus cannot land on it');
});

check('the handle shrinks with the SELECTION, not only with the page', () => {
  // This is the one that actually goes wrong without it: scale a selection
  // down and a fixed dot ends up larger than the ink it is a corner of.
  const r = (w, h) => sized(1, w, h)._handleRadius();
  assert.equal(r(200, 150), 9, 'a normal selection is unaffected');
  assert.ok(r(50, 38) < 9, 'a small one gets a smaller handle');

  for (const [w, h] of [[200, 150], [50, 38], [24, 18], [10, 8]]) {
    const diameter = r(w, h) * 2;
    assert.ok(diameter <= Math.min(w, h) || r(w, h) === 6,
      `${w}x${h}: the dot must not outgrow what it is a handle for`);
  }
});

check('the hit target follows the dot, but never all the way down', () => {
  const big = sized(1, 200, 150);
  assert.equal(big._handleHitRadius(), big._handleRadius() * 2.4, 'aim tracks appearance');

  const tiny = sized(1, 10, 8);
  assert.ok(tiny._handleRadius() < big._handleRadius());
  assert.equal(tiny._handleHitRadius(), 15,
    'a handle that can be seen and not pressed is worse than one drawn large');

  const code = $read('src/ink/ink-surface.js');
  assert.ok(!/SELECT_HANDLE \* 2\.4/.test(code), 'the fixed hit radius is gone');
  assert.ok(/_handleHitRadius\(\)/.test(code), 'one place decides what counts as a grab');
});

check('the ring keeps its weight in proportion', () => {
  // A 2px outline on a 40px dot reads as a thin hoop; on a 12px one it
  // swallows the white centre.
  const code = $read('src/ink/ink-surface.js');
  assert.ok(/ctx\.lineWidth = Math\.min\(3, Math\.max\(1\.5, r \/ 4\.5\)\)/.test(code));
});

check('the object-type row from the reference is deliberately absent', () => {
  // The reference offers 手写 / 图片 / 文本框 / 图形. This app holds one kind
  // of object, so those are four toggles that can only have one answer.
  const code = $read('src/ink/ink-toolbar.js');
  for (const dead of ['图片', '文本框', '图形']) {
    assert.ok(!code.includes(dead), `${dead} cannot be selected in this app`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('4. Tablet input — the pen writes, the hand handles the book');

check('a finger never leaves a mark; a pen always may', () => {
  const surface = Object.create(InkSurface.prototype);
  surface.enabled = true;
  surface.inputMode = INPUT_MODES.NO_FINGER;
  const may = (type, isPrimary = true) => surface._shouldDraw({ pointerType: type, isPrimary });

  assert.equal(may('pen'), true, 'the stylus annotates');
  assert.equal(may('touch'), false, 'the hand does not — it rests on the glass while writing');
  assert.equal(may('mouse'), true, 'and a mouse still draws, because a desk has no pen');
});

check('no-finger is the default, so a tablet behaves without being told', () => {
  const code = $read('src/ink/ink-surface.js');
  assert.ok(/this\.inputMode = INPUT_MODES\.NO_FINGER;/.test(code));
  assert.ok(/NO_FINGER: 'no-finger'/.test($read('src/ink/ink-surface.js')));
});

check('a resting palm still cannot draw, whatever the mode', () => {
  const surface = Object.create(InkSurface.prototype);
  surface.enabled = true;
  surface.inputMode = INPUT_MODES.ANY;
  assert.equal(
    surface._shouldDraw({ pointerType: 'touch', isPrimary: false }), false,
    'a hand on the tablet raises secondary touch points; none may start a stroke',
  );
});

check('one finger slides a page too big for its pane, and turns one that fits', () => {
  // A page zoomed past its pane has to be reachable, and the only hand on the
  // tablet is one finger. So the gesture means whichever of the two the page
  // has room for — decided once, at the start, and not again under the hand.
  const code = $code('src/pdf/pdf-pane.js');
  assert.ok(/if \(e\.pointerType === 'pen'\) return;/.test(code),
    'the pen never reaches the page gestures');
  assert.ok(/touches\.size === 2/.test(code), 'two fingers are a pinch');
  assert.ok(/swipe\.mode = \(this\._zoomedPastTurning\(\) \|\| this\._roomToPan\(dx, dy\)\) \? 'pan' : 'turn'/.test(code),
    'the reading is taken once and kept');
});

/** A pane with a page of `content` in a viewport of `view`, scrolled to `at`. */
function pannablePane({ view, content, at, zoom = 1, fitMode = 'page' }) {
  const pane = Object.create(PdfPane.prototype);
  pane.state = { scrollX: at.x, scrollY: at.y, zoom, fitMode };
  pane.pageSize = { width: content.width, height: content.height };
  pane._viewport = () => view;
  pane._contentSize = () => content;
  return pane;
}

check('a swipe turns the page up to 130%, and only pans past it', () => {
  // Asked for on the tablet. The gate was the whole-page fit exactly, which
  // made a page nudged to 110% unturnable by hand — the reader has barely
  // zoomed, there is almost nowhere to slide the page to, and a sideways drag
  // can only mean "next page". Past 130% they are studying one working, one
  // finger is how they move around it, and the ‹ › buttons turn.
  const view = { width: 580, height: 610 };
  const page = { width: 580, height: 610 };      // fitScale 1, so zoom IS displayZoom
  const at = (zoom, fitMode = 'none') =>
    pannablePane({ view, content: page, at: { x: 0, y: 0 }, zoom, fitMode });

  assert.equal(at(1, 'page')._zoomedPastTurning(), false, 'a page shown whole turns');
  assert.equal(at(1.1)._zoomedPastTurning(), false, '110% still turns');
  assert.equal(at(1.29)._zoomedPastTurning(), false, 'and just under the line');
  assert.equal(at(1.3)._zoomedPastTurning(), false, 'the line itself is inclusive — 130% turns');
  assert.equal(at(1.31)._zoomedPastTurning(), true, 'just past it, one finger only pans');
  assert.equal(at(2)._zoomedPastTurning(), true, 'and well past it');
  assert.equal(at(0.6)._zoomedPastTurning(), false, 'zooming OUT never stops a turn');

  // A fit is not a manual zoom. 适合宽度 can read well above 130% on a tall
  // page, but there is no width to slide across, so the swipe still turns —
  // _roomToPan is what decides that one.
  assert.equal(at(1.8, 'width')._zoomedPastTurning(), false,
    'a fit-to-width page is not "zoomed in" however large the number reads');
});

check('a page that fits its pane has nowhere to slide, so the swipe turns it', () => {
  const pane = pannablePane({
    view: { width: 580, height: 610 },
    content: { width: 432, height: 610 },
    at: { x: 0, y: 0 },
  });
  assert.equal(pane._roomToPan(-40, 0), false, 'nothing to the right of it');
  assert.equal(pane._roomToPan(40, 0), false, 'nor to the left');
  assert.equal(pane._roomToPan(0, -40), false, 'nor below');
});

check('a page zoomed past its pane slides, until it reaches the edge', () => {
  const view = { width: 580, height: 610 };
  const content = { width: 1200, height: 1700 };

  const middle = pannablePane({ view, content, at: { x: 300, y: 400 } });
  assert.ok(middle._roomToPan(-40, 0), 'room to carry on right');
  assert.ok(middle._roomToPan(40, 0), 'and back to the left');
  assert.ok(middle._roomToPan(0, -40), 'and down');
  assert.ok(middle._roomToPan(0, 40), 'and up');

  const hardLeft = pannablePane({ view, content, at: { x: 0, y: 400 } });
  assert.equal(hardLeft._roomToPan(40, 0), false,
    'at the left edge, a rightward drag has nothing to reveal — that swipe turns the page');
  assert.ok(hardLeft._roomToPan(-40, 0), 'the other way still slides');

  const hardRight = pannablePane({ view, content, at: { x: 620, y: 400 } });
  assert.equal(hardRight._roomToPan(-40, 0), false, 'and the same at the right edge');
});

check('the axis the hand chose is the axis that is asked about', () => {
  // Mostly-sideways on a page with vertical room only must not be read as a
  // pan, or a swipe meant to turn the page would slide it up instead.
  const pane = pannablePane({
    view: { width: 580, height: 610 },
    content: { width: 432, height: 1700 },
    at: { x: 0, y: 400 },
  });
  assert.equal(pane._roomToPan(-60, 10), false, 'sideways asks about sideways');
  assert.ok(pane._roomToPan(10, -60), 'and up-and-down about up-and-down');
});

check('a drag that slid the page does not also turn it', () => {
  const code = $code('src/pdf/pdf-pane.js');
  const end = code.slice(code.indexOf('if (e.type !== \'pointerup\') return;'));
  assert.ok(/from\.mode === 'pan'/.test(end.slice(0, 400)),
    'the same gesture would otherwise be measured as a flick as well');
});

check('the divider preview is priced by the fit, not by how much the pane grew', () => {
  // A whole-page fit is usually limited by HEIGHT, and a sideways drag does not
  // change the height — so scaling the bitmap by the pane's width ratio showed
  // a page that was not going to be there when the finger lifted.
  const pane = Object.create(PdfPane.prototype);
  pane.state = { zoom: 0.725, fitMode: 'page', scrollX: 0, scrollY: 0 };
  pane.pageSize = { width: 595, height: 842 };
  pane.minZoom = 0.725;
  pane._viewport = () => ({ width: 582, height: 611 });

  // Wide enough that height binds: the page does not care how wide the pane is.
  assert.equal(pane.fitZoomFor(582), pane.fitZoomFor(495),
    'between these two widths the fit is the same, so the preview must not move');
  const widthRatio = 495 / 582;
  assert.ok(Math.abs(widthRatio - 1) > 0.1, 'while the pane itself changed by 15%');

  // Narrow enough that width binds: now it tracks, and by the width.
  const narrow = pane.fitZoomFor(370);
  assert.ok(narrow < pane.fitZoomFor(582), 'a pane too narrow for the page shrinks it');
  assert.ok(Math.abs(narrow - 370 / 595) < 1e-9, 'and exactly to what fits');
});

check('the floor of the pane it has now does not price the pane it would have', () => {
  // minZoom is itself the whole-page scale at the CURRENT width, so clamping a
  // hypothetical narrower fit against it returned the current fit for every
  // width — the factor came out 1 and there was no preview at all.
  const pane = Object.create(PdfPane.prototype);
  pane.state = { zoom: 0.49, fitMode: 'page', scrollX: 0, scrollY: 0 };
  pane.pageSize = { width: 595, height: 842 };
  pane.minZoom = 0.49;                       // == the fit at 293px wide
  pane._viewport = () => ({ width: 293, height: 611 });
  assert.ok(pane.fitZoomFor(126) < pane.minZoom,
    'a narrower pane must be allowed to price below the floor it has today');
  assert.ok(pane.fitZoomFor(126) < pane.fitZoomFor(293), 'so the two differ');
});

check('a manual zoom is not the divider\u2019s to move', () => {
  const pane = Object.create(PdfPane.prototype);
  pane.state = { zoom: 2, fitMode: 'none', scrollX: 0, scrollY: 0 };
  pane.pageSize = { width: 595, height: 842 };
  pane.minZoom = 0.25;
  pane._viewport = () => ({ width: 582, height: 611 });
  assert.equal(pane.fitZoomFor(370), null, 'there is no fit to preview');
});

check('the divider records its starting widths before it claims the pointer', () => {
  const code = $code('src/pdf/pdf-workspace.js');
  const down = code.slice(code.indexOf("elDivider.addEventListener('pointerdown'"));
  const base = down.indexOf('_dragBaseWidth');
  const capture = down.indexOf('setPointerCapture');
  assert.ok(base > -1 && capture > -1);
  assert.ok(base < capture,
    'setPointerCapture throws on a pointer it cannot claim, and everything after '
    + 'it was skipped — leaving the drag running with no width to scale from');
  assert.ok(/try \{ this\.elDivider\.setPointerCapture/.test(down),
    'and the claim itself is allowed to fail');
});

/** A pane mid-preview: rendered at `rendered`, painted at `rendered * k`. */
function previewingPane({ view, page, zoom, rendered, k, scroll = { x: 0, y: 0 } }) {
  const pane = Object.create(PdfPane.prototype);
  pane.state = { zoom, fitMode: 'page', scrollX: scroll.x, scrollY: scroll.y };
  pane.pageSize = page;
  pane._renderedZoom = rendered;
  pane._previewScale = k;
  pane._viewport = () => view;
  return pane;
}

check('a previewed page is centred by the size it is painted at', () => {
  // The whole of the left/right difference. A divider drag grows one pane and
  // shrinks the other, and the page was centred by the size its ZOOM implied
  // rather than the size on screen — so the error was half the difference, one
  // way on the left and the other way on the right. Two panes, one drag, two
  // visibly different animations.
  const view = { width: 400, height: 800 };
  const page = { width: 200, height: 300 };

  const shrinking = previewingPane({ view, page, zoom: 1, rendered: 1, k: 0.5 });
  assert.equal(shrinking._drawnSize().width, 100, 'painted at half');
  assert.equal(shrinking._origin().x, 150, 'and centred at half: (400-100)/2');

  const growing = previewingPane({ view, page, zoom: 1, rendered: 1, k: 1.5 });
  assert.equal(growing._drawnSize().width, 300);
  assert.equal(growing._origin().x, 50, '(400-300)/2');

  // Both panes are the same distance from centre, which is what makes the two
  // sides of the divider look like one gesture.
  const off = (p) => p._origin().x + p._drawnSize().width / 2 - view.width / 2;
  assert.equal(off(shrinking), 0);
  assert.equal(off(growing), 0);
});

check('with nothing previewed the origin is exactly what it always was', () => {
  const view = { width: 400, height: 800 };
  const page = { width: 200, height: 300 };
  const plain = previewingPane({ view, page, zoom: 2, rendered: 2, k: 1 });
  assert.equal(plain._drawnScale(), 2, 'the zoom in the state');
  assert.deepEqual(plain._origin(), { x: 0, y: 100 }, 'wider than the pane, shorter than it');
});

check('a pinch is not previewed twice', () => {
  // During a pinch the zoom in the state is already live and the transform is
  // standing in for a bitmap drawn at the old one, so the painted scale IS the
  // state's zoom — this must not scale it a second time.
  const pane = previewingPane({
    view: { width: 400, height: 800 },
    page: { width: 200, height: 300 },
    zoom: 3, rendered: 1.5, k: 2,
  });
  assert.equal(pane._drawnScale(), 3, 'rendered x preview = the live zoom');
  assert.equal(pane._drawnSize().width, 600);
});

check('the scroll offset travels with the painted scale', () => {
  // Scroll is measured in the page's pixels at the zoom in the state. A page
  // painted larger has to be offset further, or the preview and the refit
  // disagree by exactly the distance the reader had scrolled.
  const pane = previewingPane({
    view: { width: 400, height: 500 },
    page: { width: 200, height: 300 },
    zoom: 3, rendered: 3, k: 1.5, scroll: { x: 60, y: 90 },
  });
  assert.equal(pane._origin().x, -90, '60 x 1.5');
  assert.equal(pane._origin().y, -135, '90 x 1.5');
});

check('a page previewed smaller cannot be scrolled past its own end', () => {
  const pane = previewingPane({
    view: { width: 400, height: 500 },
    page: { width: 200, height: 300 },
    zoom: 3, rendered: 3, k: 0.8, scroll: { x: 200, y: 400 },
  });
  // painted 480x720; the most it can be pushed is 80 across and 220 up
  assert.ok(Math.abs(pane._origin().x + 80) < 1e-6);
  assert.ok(Math.abs(pane._origin().y + 220) < 1e-6);
});

check('ink is transformed at the scale the page is painted at', () => {
  const code = $code('src/pdf/pdf-pane.js');
  const at = code.indexOf('  _syncInk() {');
  const sync = code.slice(at, at + 500);
  assert.ok(/const scale = this\._drawnScale\(\);/.test(sync)
    && /setTransform\(scale, -x \/ scale, -y \/ scale\)/.test(sync),
    'reading state.zoom left the handwriting at its old size on a page that '
    + 'had changed size under it — drifting the opposite way in each pane');
});

check('an animated ratio change previews the refit too, frame by frame', () => {
  const code = $code('src/pdf/pdf-workspace.js');
  for (const fn of ['animateToRatio(targetRatio)', 'animateToFocus(slot)']) {
    const at = code.indexOf(fn);
    assert.ok(at > -1, fn);
    const body = code.slice(at, at + 700);
    assert.ok(/_trackPaneFits\(380\)/.test(body), fn + ' tracks the panes');
    assert.ok(/_stopTrackingPaneFits\(\)/.test(body), fn + ' hands back to the real refit');
  }
  assert.ok(/requestAnimationFrame/.test(code),
    'a CSS transition has no pointer frames to hang the preview on');
});

check('a pane the divider must not re-zoom is still re-placed', () => {
  // A manual zoom is not the divider's to change. Its page still has to sit in
  // the middle of a pane whose middle is moving — left out of the loop, it
  // stayed pinned where it was, drifted 88px off centre as the pane grew, and
  // snapped back when the finger lifted. Only on the side that was not on a
  // fit, which is what made the two sides look like different gestures.
  const code = $code('src/pdf/pdf-workspace.js');
  const at = code.indexOf('_previewPaneFits(base) {');
  const body = code.slice(at, at + 900);
  assert.ok(/fitMode === FIT_MODES\.NONE \|\| !\(from > 1\)\) \{\s*pane\.reposition\?\.\(\);/.test(body),
    'reposition, not skip');
  assert.ok(/reposition\(\) \{/.test($code('src/pdf/pdf-pane.js')), 'and the pane offers it');
});

check('the preview is not dropped before the render that replaces it arrives', () => {
  // Resetting the transform and then asking PDF.js to rasterise leaves a gap:
  // for as long as the raster takes, the page is back at the size it had
  // before the drag. The preview is priced off the bitmap on screen, so it can
  // simply stay up — and _render clears it in the frame that swaps the canvas.
  const code = $code('src/pdf/pdf-workspace.js');
  const release = code.slice(code.indexOf('_stopTrackingPaneFits();'), code.indexOf('_stopTrackingPaneFits();') + 300);
  assert.ok(!/previewScale\?\.\(1\)/.test(release), 'nothing is reset on the way out');
  assert.ok(/_previewScale = 1;/.test($code('src/pdf/pdf-pane.js')), 'the render does it instead');
  // Except for a pane that is going away: no refit is coming for that one.
  // Dragging the divider to an edge now COLLAPSES the pane rather than closing
  // it — the deck is untouched and a restore control takes its place — but the
  // preview still has to be released, because a collapsed pane is not going to
  // be re-rendered either.
  const at = code.indexOf('if (collapsing) {');
  const collapsing = code.slice(at, at + 300);
  assert.ok(/_clearPaneFitPreviews\(\)/.test(collapsing), 'a pane being put away is let go of');
  assert.ok(/collapsePane\(/.test(collapsing), 'and it is collapsed, not closed');
});

check('the drag and the transition price the fit the same way', () => {
  // One previewer, called from both, because two would be two chances for the
  // left and the right to disagree.
  const code = $code('src/pdf/pdf-workspace.js');
  const priced = code.match(/pane\.previewScale\(was && will \? will \/ was : now \/ from\)/g);
  assert.equal((priced || []).length, 1, 'the fit is priced in exactly one place');
});

/** A workspace whose grip is a 9x54 pill centred at (600, 400) — the tablet's. */
function workspaceWithGrip() {
  const ws = Object.create(PdfWorkspace.prototype);
  ws.elGrip = { getBoundingClientRect: () => ({ left: 595.5, right: 604.5, top: 373, bottom: 427, height: 54 }) };
  return ws;
}

check('the divider is taken hold of by its grip, not by the whole line', () => {
  // The strip runs the full height of the workspace, and on the way down it
  // crosses the band the dock is swiped away from. So a swipe to put the bars
  // away also grabbed the divider and the columns changed width on the way
  // past: one finger, one intention, two gestures.
  const ws = workspaceWithGrip();
  assert.ok(ws._onDividerGrip(600, 400), 'the middle of the pill');
  assert.ok(ws._onDividerGrip(600, 373), 'its top edge');
  assert.ok(ws._onDividerGrip(600, 427), 'its bottom edge');

  // The band above the dock, which is where the dock gesture starts.
  assert.equal(ws._onDividerGrip(600, 600), false, 'the dock is swiped away from here');
  assert.equal(ws._onDividerGrip(600, 640), false);
  // And the top of the line, which crosses the import row's own band.
  assert.equal(ws._onDividerGrip(600, 100), false);
});

check('the grip is reachable by a finger, not only by a pixel', () => {
  const ws = workspaceWithGrip();
  // 9px wide and 54 tall is a mark saying where the target is, not the target.
  assert.ok(ws._onDividerGrip(600, 373 - 20), 'a little above still counts');
  assert.ok(ws._onDividerGrip(600, 427 + 20), 'and a little below');
  assert.ok(ws._onDividerGrip(595.5 - 20, 400), 'and to either side');
  assert.ok(ws._onDividerGrip(604.5 + 20, 400));
  // But the reach is finite, or we are back to grabbing the whole line.
  assert.equal(ws._onDividerGrip(600, 427 + 40), false);
  const box = 54 + 2 * 22;
  assert.ok(box < 120, 'and the whole target stays well clear of the dock band');
});

check('a press that is not on the grip is left completely alone', () => {
  const code = $code('src/pdf/pdf-workspace.js');
  const at = code.indexOf("elDivider.addEventListener('pointerdown'");
  const down = code.slice(at, at + 1400);
  const guard = down.indexOf('_onDividerGrip');
  assert.ok(guard > -1, 'the guard is there');
  assert.ok(guard < down.indexOf('dragging = true'), 'and it comes first');
  assert.ok(guard < down.indexOf('preventDefault'),
    'no preventDefault and no capture on a press that was not ours, or the '
    + 'gesture it did belong to never sees the rest of itself');
});

check('a workspace with no grip yet does not take the press', () => {
  const ws = Object.create(PdfWorkspace.prototype);
  assert.equal(ws._onDividerGrip(600, 400), false, 'nothing to be on');
  ws.elGrip = { getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, height: 0 }) };
  assert.equal(ws._onDividerGrip(0, 0), false, 'nor a grip with no box');
});

check('the swap button and the grip do not share any pixels', () => {
  const css = $read('src/styles/material.css');
  const rule = css.slice(css.indexOf('.pdf-ws-swap {'), css.indexOf('.pdf-ws-swap[hidden]'));
  const top = /top:\s*calc\(50% - (\d+)px\)/.exec(rule);
  const size = /height:\s*(\d+)px/.exec(rule);
  assert.ok(top && size);
  // Button centred `top` above the middle; grip 60 tall while held, so its top
  // edge is 30 above the middle and its reach another 22 above that.
  const buttonBottom = Number(top[1]) - Number(size[1]) / 2;
  assert.ok(buttonBottom > 30 + 22,
    `the button's lower edge sits ${buttonBottom}px above centre and has to clear `
    + 'the grip and the reach around it — at 46 they overlapped, and the ring '
    + 'the button grows when the swap is armed closed the gap entirely');
});

check('a button that can act on your documents is a button you can see', () => {
  // Opacity does not remove an element from hit-testing, and the rule meant to
  // bring this one back on touch screens — @media (hover: none) — does not
  // match the tablet, whose stylus reports hover. So what shipped was an
  // invisible 30px button on the line between two documents that exchanged
  // them when a finger aimed past it landed on it.
  const css = $code('src/styles/material.css');   // the prose below mentions the old value
  const rule = css.slice(css.indexOf('.pdf-ws-swap {'), css.indexOf('.pdf-ws-swap[hidden]'));
  const rest = /opacity:\s*([\d.]+)/.exec(rule);
  assert.ok(rest && Number(rest[1]) > 0.3, `visible at rest, got ${rest && rest[1]}`);
  assert.ok(!/pointer-events:\s*none/.test(rule), 'and pressable, since it can be seen');
  assert.ok(/is-dragging \.pdf-ws-swap/.test($read('src/styles/material.css')),
    'and it comes up to full while the divider is held');
  assert.ok(!/\(hover: none\)[\s\S]{0,60}pdf-ws-swap/.test($read('src/styles/mobile.css')),
    'the media-query rescue is gone, because it never fired');
});

check('the swap button never starts a resize as well', () => {
  const code = $code('src/pdf/pdf-workspace.js');
  const at = code.indexOf("elDivider.addEventListener('pointerdown'");
  const down = code.slice(at, at + 1400);
  const swap = down.indexOf('data-role="swap"');
  assert.ok(swap > -1 && swap < down.indexOf('_onDividerGrip'),
    'it sits just above the grip and the grip reaches up under it');
});

check('the divider follows the finger the whole way, with nothing pulling at it', () => {
  // Inside 4% of either end the divider used to stop tracking and jump to the
  // edge, and 4% of this workspace is 48px — an ordinary amount of resizing.
  // A narrow column was not something you could ask for: asking for it shut
  // the pane instead.
  const code = $code('src/pdf/pdf-workspace.js');
  const at = code.indexOf('const ratioFromEvent');
  const body = code.slice(at, code.indexOf('elDivider.addEventListener'));
  assert.ok(!/raw = 0;/.test(body) && !/raw = 1;/.test(body), 'no snap to either end');
  assert.ok(/return clamp\(raw, MIN_RATIO, MAX_RATIO\);/.test(body),
    'the ratio is where the finger is');
});

check('closing a pane means taking the divider to the edge of the workspace', () => {
  // Still reachable, and now only on purpose.
  assert.ok(CLOSE_THRESHOLD > 0, 'the gesture is still there');
  assert.ok(CLOSE_THRESHOLD * 1200 < 8,
    `on a 1200px workspace that is ${CLOSE_THRESHOLD * 1200}px from the edge, `
    + 'which nobody reaches by accident');
});

check('every file the service worker pre-caches actually exists', () => {
  // The list went stale in silence. It named the ONNX runtime and the
  // formula-recognition models long after both were deleted, and because each
  // entry is cached with its own catch, thirteen of seventeen failed on every
  // install and the only trace was a console warning nobody was reading.
  const sw = $code('public/sw.js');
  const block = sw.slice(sw.indexOf('PRE_CACHE = ['), sw.indexOf('];', sw.indexOf('PRE_CACHE = [')));
  const paths = [...block.matchAll(/'(\/[^']*)'/g)].map(m => m[1]);
  assert.ok(paths.length > 0, 'the list is found');

  const missing = paths.filter((p) => {
    const file = p === '/' ? 'index.html' : join('public', p);
    try { statSync(join(ROOT, file)); return false; } catch (_) { return true; }
  });
  assert.deepEqual(missing, [], 'a pre-cache entry that 404s is a warning nobody sees');
});

check('the fetch handler is cache-first about things that never change', () => {
  const sw = $code('public/sw.js');   // the prose above still names what was removed
  assert.ok(/startsWith\('\/vendor\/'\)/.test(sw),
    'the vendored libraries, character maps and fonts are pinned into the repo, '
    + 'so the cached copy is always right');
  assert.ok(!/\/models\/|\/ort\//.test(sw), 'and neither of those directories exists any more');
});

check('the swap button is pulled from where it already sits, not from zero', () => {
  // 它靠 transform: translateX(-50%) 居中在分隔条上，而内联 transform 会整个替换
  // 这个属性——所以手指一落下，按钮就往右跳了自己一半的宽度，松手再弹回来。
  const code = $code('src/pdf/pdf-workspace.js');
  const at = code.indexOf('const pull = Math.sign(d)');
  const body = code.slice(at, at + 300);
  assert.ok(/calc\(-50% \+ \$\{pull\}px\)/.test(body),
    'the pull composes with the centring instead of overwriting it');
  assert.ok(/translateY\(calc\(-50%/.test(body) && /translateX\(calc\(-50%/.test(body),
    'both orientations centre on their own axis, so both need it');

  const css = $read('src/styles/material.css');
  const rule = css.slice(css.indexOf('.pdf-ws-swap {'), css.indexOf('.pdf-ws-swap[hidden]'));
  assert.ok(/transform:\s*translateX\(-50%\)/.test(rule),
    'and this is the centring the drag has to preserve');
});

check('nothing is a circle inside a square', () => {
  // 收起后工具栏只剩一枚圆形令牌，外壳却仍是 8px 圆角的方块，一个圆被裹在方里。
  // 形状规则：浮起来单独做一件事的是圆，盛放内容的是圆角方块，两者不叠在同一个
  // 东西上。
  const css = $read('src/styles/ink-toolbar.css');
  const docked = css.slice(css.indexOf('[data-skin="minimal"] .ink-toolbar.is-docked'));
  assert.ok(/background:\s*transparent/.test(docked.slice(0, 260)),
    'the shell steps out of the way when only the round token is left');
  assert.ok(/box-shadow:\s*none/.test(docked.slice(0, 260)),
    'shell included its shadow, which would otherwise outline the square');
});

check('the pinch runs on pointer events, not a second touch stream', () => {
  // It used to be a pair of touch listeners alongside the pointer ones, so a
  // second finger started a pinch while the first was still panning and both
  // moved the page at once.
  const code = $code('src/pdf/pdf-pane.js');
  for (const dead of ["'touchstart'", "'touchmove'", "'touchend'", 'touchDistance']) {
    assert.ok(!code.includes(dead), `${dead} must be gone — one input stream only`);
  }
});

check('the page turn folds over on a crease, like a leaf going over', () => {
  const code = $read('src/pdf/pdf-pane.js');
  assert.ok(/beginLiveTurn/.test(code) && /reflection/i.test(code),
    'it folds over on a crease, rather than sliding');
  assert.ok(/direction === 'next' \? w : 0/.test(code),
    'and is picked up at the edge it is being pulled from');
  assert.ok(/prefers-reduced-motion/.test(code), 'skipped when motion is not wanted');
  // The snapshot has to be taken before the page changes and played after.
  assert.ok(/beginLiveTurn\(direction\)[\s\S]{0,200}endLiveTurn\(true\)/.test(code),
    'the sheet that turns away must be the page that was there');
  const css = $read('src/styles/pdf.css');
  assert.ok(!/perspective:/.test(css.slice(css.indexOf('.pdf-pane-viewport'), css.indexOf('.pdf-page-leaf'))),
    'the fold is drawn, so nothing here needs a vanishing point any more');
});

// ═══════════════════════════════════════════════════════════════
group('4b. The sheet follows the hand, and folds where it is held');

/** Records what the turn draws, so the geometry can be read back. */
function recordingContext() {
  const calls = [];
  const ctx = {
    calls,
    canvas: { width: 0, height: 0 },
    globalAlpha: 1,
    fillStyle: '',
    setTransform: (...a) => calls.push(['setTransform', ...a]),
    transform: (...a) => calls.push(['transform', ...a]),
    clearRect: () => calls.push(['clearRect']),
    drawImage: (...a) => calls.push(['drawImage', a.length]),
    fillRect: () => calls.push(['fillRect']),
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    scale: (...a) => calls.push(['scale', ...a]),
    clip: () => calls.push(['clip']),
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, closePath: () => {}, rect: () => {},
    stroke: () => calls.push(['stroke']),
    strokeStyle: '', lineWidth: 1,
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return ctx;
}

/** A pane with just enough of itself to turn a page. */
function turnablePane({ page = 5, pages = 10, w = 300, h = 400, pageW = null } = {}) {
  const dom = new JSDOM('<!doctype html><div class="vp"><div class="holder"><canvas></canvas></div></div>');
  const doc = dom.window.document;
  const vp = doc.querySelector('.vp');
  const holder = doc.querySelector('.holder');
  const src = doc.querySelector('canvas');
  src.width = 40; src.height = 60;
  const ctx = recordingContext();
  const rect = { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  for (const el of [vp, holder]) {
    el.getBoundingClientRect = () => rect;
    el.animate = () => ({ addEventListener() {}, cancel() {} });
  }
  // The holder fills the pane; the page canvas inside it is only as wide as the
  // page. They are the same box only when the page happens to fill the pane.
  const pw = pageW ?? w;
  const pageRect = { left: (w - pw) / 2, top: 0, right: (w + pw) / 2, bottom: h, width: pw, height: h };
  src.getBoundingClientRect = () => pageRect;
  const origCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'canvas') el.getContext = () => ctx;
    return el;
  };
  src.getContext = () => ctx;

  const pane = Object.create(PdfPane.prototype);
  pane.elViewport = vp;
  pane.elHolder = holder;
  pane.page = page;
  pane.canGoNext = () => pane.page < pages;
  pane.canGoPrevious = () => pane.page > 1;
  pane.next = () => { pane.page += 1; };
  pane.previous = () => { pane.page -= 1; };
  pane._viewport = () => ({ width: w, height: h });

  const prevDoc = global.document; const prevWin = global.window;
  global.document = doc; global.window = dom.window;
  dom.window.matchMedia = () => ({ matches: false });
  dom.window.devicePixelRatio = 1;
  return { pane, vp, doc, ctx, w, h, restore: () => { global.document = prevDoc; global.window = prevWin; } };
}

check('the page under the sheet changes the moment it lifts, not when it lands', () => {
  const t = turnablePane({ page: 5 });
  try {
    assert.equal(t.pane.beginLiveTurn('next', { x: 290, y: 200 }), true);
    assert.equal(t.pane.page, 6,
      'the destination has to be under the sheet, or the crease opens on the page being left');
    assert.equal(t.vp.querySelectorAll('.pdf-page-leaf').length, 1, 'and a sheet is over it');
  } finally { t.restore(); }
});

check('held at the top, the page peels from the top corner', () => {
  const t = turnablePane({ h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 20 });
    assert.equal(t.pane._live.anchor.corner, 'top');
    assert.equal(t.pane._live.anchor.y, 0, 'the corner it turns about is the top one');
    assert.equal(t.pane._live.anchor.x, 300, 'on the edge it is being pulled from');
  } finally { t.restore(); }
});

check('held at the bottom, it peels from the bottom corner', () => {
  const t = turnablePane({ h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 380 });
    assert.equal(t.pane._live.anchor.corner, 'bottom');
    assert.equal(t.pane._live.anchor.y, 400);
  } finally { t.restore(); }
});

check('held in the middle, the whole edge lifts instead of a corner', () => {
  const t = turnablePane({ h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 200 });
    assert.equal(t.pane._live.anchor.corner, 'edge');
    assert.equal(t.pane._live.anchor.y, 200, 'it lifts where it was held');
  } finally { t.restore(); }
});

check('a backward turn is picked up at the other edge', () => {
  const t = turnablePane({ page: 5 });
  try {
    t.pane.beginLiveTurn('prev', { x: 10, y: 30 });
    assert.equal(t.pane._live.anchor.x, 0);
    assert.equal(t.pane.page, 4);
  } finally { t.restore(); }
});

// The book is bound on one side, so the same edge is the hinge whichever way
// the reader is going. Going forward the sheet that folds is the one being
// left, and its printing shows faintly through the back of the paper. Going
// back the sheet that folds is the one arriving — there is no bitmap of it,
// and a reader would not see printing through the back of a page they have not
// reached yet. Drawing the OLD page there put the page just left onto the back
// of the page coming in, which is the wrong sheet entirely.
check('the back of the fold is blank paper, whichever way it goes', () => {
  // Printing showing faintly through from the other side is true of paper and
  // looked like a fault on a screen: mirrored characters across half the pane
  // read as broken rendering, not as a sheet seen from behind.
  for (const dir of ['next', 'prev']) {
    const t = turnablePane({ page: 5 });
    try {
      t.pane.beginLiveTurn(dir, { x: dir === 'next' ? 290 : 10, y: 200 });
      t.ctx.calls.length = 0;
      t.pane.dragLiveTurn({ x: dir === 'next' ? 140 : 160, y: 200 });
      const draws = t.ctx.calls.filter((c) => c[0] === 'drawImage').length;
      assert.equal(draws, 1, `${dir}: only the page still lying flat is drawn`);
      assert.ok(t.ctx.calls.some((c) => c[0] === 'stroke'),
        `${dir}: the crease is a hairline, so the fold has an edge`);
    } finally { t.restore(); }
  }
});

check('a backward turn folds in a blank back, not the page being left', () => {
  const t = turnablePane({ page: 5 });
  try {
    t.pane.beginLiveTurn('prev', { x: 10, y: 200 });
    t.ctx.calls.length = 0;
    t.pane.dragLiveTurn({ x: 160, y: 200 });
    const draws = t.ctx.calls.filter((c) => c[0] === 'drawImage').length;
    const fills = t.ctx.calls.filter((c) => c[0] === 'fillRect').length;
    assert.ok(fills > 0, 'the arriving sheet still has a paper-coloured back');
    assert.equal(draws, 1,
      'only the page still lying flat is drawn; the fold carries no borrowed printing');
  } finally { t.restore(); }
});

check('the flap is the page reflected in the crease, not a copy slid sideways', () => {
  const t = turnablePane({ w: 300, h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 200 });
    t.ctx.calls.length = 0;
    // A level pull from a mid-height anchor: the crease is vertical, so the
    // reflection is a plain horizontal mirror — a = -1, d = 1.
    t.pane.dragLiveTurn({ x: 100, y: 200 });
    const m = t.ctx.calls.find((c) => c[0] === 'transform');
    assert.ok(m, 'the flap has to be transformed, or it is not folded at all');
    assert.ok(Math.abs(m[1] + 1) < 1e-6, `expected a horizontal mirror, got a=${m[1]}`);
    assert.ok(Math.abs(m[4] - 1) < 1e-6, `expected d=1, got ${m[4]}`);
    assert.ok(Math.abs(m[2]) < 1e-6 && Math.abs(m[3]) < 1e-6, 'and no shear');
  } finally { t.restore(); }
});

check('a diagonal pull from a corner gives a diagonal crease', () => {
  const t = turnablePane({ w: 300, h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 380 });
    t.ctx.calls.length = 0;
    t.pane.dragLiveTurn({ x: 120, y: 150 });
    const m = t.ctx.calls.find((c) => c[0] === 'transform');
    assert.ok(m, 'the flap is transformed');
    assert.ok(Math.abs(m[2]) > 1e-3,
      'a crease that is not vertical must shear the reflection');
  } finally { t.restore(); }
});

check('the sheet is the size of the page, not the size of the pane', () => {
  // The holder is position:absolute inset:0, so it is as wide as the pane. The
  // page inside it is only as wide as the page. Cutting the sheet from the
  // holder stretched the page across the pane — invisible while a page was
  // bigger than its pane, and a visible enlargement the moment a whole page
  // fitted inside one.
  const t = turnablePane({ w: 600, h: 400, pageW: 300 });
  try {
    assert.equal(t.pane.beginLiveTurn('next', { x: 440, y: 200 }), true);
    const leaf = t.vp.querySelector('.pdf-page-leaf');
    assert.equal(leaf.style.width, '300px', 'the sheet is the page, not the pane');
    assert.equal(leaf.style.left, '150px', 'and it sits where the page sits');
    assert.equal(t.pane._live.anchor.x, 300, 'the trailing edge is the page edge');
  } finally { t.restore(); }
});

check('a drag beyond the ends of the book picks nothing up', () => {
  const first = turnablePane({ page: 1 });
  try { assert.equal(first.pane.beginLiveTurn('prev', { x: 10, y: 10 }), false); } finally { first.restore(); }
  const last = turnablePane({ page: 10, pages: 10 });
  try { assert.equal(last.pane.beginLiveTurn('next', { x: 290, y: 10 }), false); } finally { last.restore(); }
});

check('letting go short of the commit point puts the page back', () => {
  const t = turnablePane({ page: 5 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 200 });
    t.pane.dragLiveTurn({ x: 250, y: 200 });
    t.pane.endLiveTurn(false);
    assert.equal(t.pane.page, 5, 'an abandoned turn leaves the reader where they were');
  } finally { t.restore(); }
});

check('letting go past it keeps the turn', () => {
  const t = turnablePane({ page: 5 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 200 });
    t.pane.dragLiveTurn({ x: 40, y: 200 });
    t.pane.endLiveTurn(true);
    assert.equal(t.pane.page, 6);
  } finally { t.restore(); }
});

check('progress is measured by the crease, which moves at half the hand', () => {
  const t = turnablePane({ w: 300, h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 200 });
    t.pane.dragLiveTurn({ x: 0, y: 200 });   // hand all the way across
    assert.ok(Math.abs(t.pane._live.progress - 0.5) < 0.02,
      `the crease is at the middle when the hand reaches the far edge, got ${t.pane._live.progress}`);
  } finally { t.restore(); }
});

check('the reader is never left looking at a photograph of the old page', () => {
  const t = turnablePane({ page: 5 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 200 });
    t.pane.dragLiveTurn({ x: 100, y: 200 });
    t.pane.endLiveTurn(true);
    assert.equal(t.pane.isTurning, false, 'the turn is over');
  } finally { t.restore(); }
});

check('a second finger lays the sheet back down', () => {
  const src = $code('src/pdf/pdf-pane.js');
  const begin = src.slice(src.indexOf('const beginPinch'), src.indexOf('vp.addEventListener'));
  assert.ok(/endLiveTurn\(false\)/.test(begin),
    'a gesture that becomes a pinch must not leave a page half over');
});

check('where the page was first touched is what decides the fold', () => {
  const src = $code('src/pdf/pdf-pane.js');
  assert.ok(/beginLiveTurn\(direction, \{ x: swipe\.x, y: swipe\.y \}\)/.test(src),
    'the grab point, not the current point, picks the corner');
});

check('the pen still never turns a page', () => {
  const src = $code('src/pdf/pdf-pane.js');
  assert.ok(/pointerType === 'pen'\) return;/.test(src),
    'ink belongs to the pen; the page must not move under a stroke');
});

// ═══════════════════════════════════════════════════════════════
group('4c. A pinch zooms where the fingers are');

/** A pane with just enough of itself to answer a zoom anchoring question. */
function zoomablePane({ zoom = 1, scrollX = 0, scrollY = 0, page = { width: 600, height: 800 } } = {}) {
  const pane = Object.create(PdfPane.prototype);
  pane.pageSize = page;
  pane.state = { zoom, scrollX, scrollY, fitMode: 'none' };
  pane._viewport = () => ({ width: 400, height: 500 });
  return pane;
}

/** Where a document point lands on screen, given a view state. */
const onScreen = (st, doc) => ({
  x: doc.x * st.zoom - st.scrollX,
  y: doc.y * st.zoom - st.scrollY,
});

check('the point between the fingers does not move when the zoom changes', () => {
  const pane = zoomablePane({ zoom: 1, scrollX: 120, scrollY: 90 });
  const before = pane.state;
  const finger = { x: 90, y: 380 };           // nowhere near the middle
  // What the reader has under their fingers right now.
  const doc = { x: (before.scrollX + finger.x) / before.zoom,
                y: (before.scrollY + finger.y) / before.zoom };

  const after = pane._anchorZoomToPoint(before, { ...before, zoom: 2.4 }, finger);
  const landed = onScreen(after, doc);
  assert.ok(Math.abs(landed.x - finger.x) < 0.5,
    `x moved ${Math.abs(landed.x - finger.x)}px out from under the fingers`);
  assert.ok(Math.abs(landed.y - finger.y) < 0.5,
    `y moved ${Math.abs(landed.y - finger.y)}px out from under the fingers`);
});

check('zooming out holds the same point too', () => {
  const pane = zoomablePane({ zoom: 3, scrollX: 900, scrollY: 1200 });
  const before = pane.state;
  const finger = { x: 310, y: 120 };
  const doc = { x: (before.scrollX + finger.x) / before.zoom,
                y: (before.scrollY + finger.y) / before.zoom };
  const after = pane._anchorZoomToPoint(before, { ...before, zoom: 1.6 }, finger);
  const landed = onScreen(after, doc);
  assert.ok(Math.abs(landed.x - finger.x) < 0.5 && Math.abs(landed.y - finger.y) < 0.5,
    'a pinch closed on a point keeps that point');
});

check('a zoom with no point of its own still holds the middle', () => {
  const pane = zoomablePane({ zoom: 1, scrollX: 200, scrollY: 300 });
  const before = pane.state;
  const mid = { x: 200, y: 250 };
  const doc = { x: (before.scrollX + mid.x) / before.zoom,
                y: (before.scrollY + mid.y) / before.zoom };
  const after = pane._anchorZoomToCentre(before, { ...before, zoom: 2 });
  const landed = onScreen(after, doc);
  assert.ok(Math.abs(landed.x - mid.x) < 0.5 && Math.abs(landed.y - mid.y) < 0.5,
    'the button zoom is unchanged: it holds the centre of the frame');
});

check('the pinch passes the midpoint, and does not re-rasterise per frame', () => {
  const src = $code('src/pdf/pdf-pane.js');
  const pinch = src.slice(src.indexOf('const ratio = c.d / pinch.d'), src.indexOf('pinch.x = c.x'));
  assert.ok(/anchor = \{ x: c\.x - box\.left, y: c\.y - box\.top \}/.test(pinch),
    'the zoom has to be told where the fingers are');
  assert.ok(/setZoom\(this\.state, pinch\.zoom \* ratio\), false, anchor\)/.test(pinch),
    'and must not ask for a repaint on every frame of the gesture');
  assert.ok(/_previewZoom\(\)/.test(pinch), 'the bitmap on screen stands in until the fingers lift');
});

check('the page is drawn for real once the fingers lift', () => {
  const src = $code('src/pdf/pdf-pane.js');
  assert.ok(/_commitPreviewZoom\(\)/.test(src.slice(src.indexOf('const endTouch'))),
    'a previewed zoom that is never committed leaves a stretched bitmap on screen');
});

// ═══════════════════════════════════════════════════════════════
group('5. The toolbar is sized against its column');

/** A toolbar with just enough of itself to answer fitTo(). */
function sizedBar(naturalLength) {
  const bar = Object.create(InkToolbar.prototype);
  const props = new Map();
  const stub = {
    style: { setProperty: (k, v) => props.set(k, v) },
    offsetHeight: naturalLength,
    offsetWidth: 60,
  };
  bar.root = stub;
  bar.cardLayer = { style: { setProperty: () => {} } };
  bar.state = { edge: 'left' };
  bar._scale = 1;
  bar._safe = { top: 0, bottom: 0 };
  bar._clampIntoHost = () => {};
  bar.scale = () => Number(props.get('--ink-scale') ?? 1);
  return bar;
}

check('a bar longer than the workspace is scaled until it fits', () => {
  // A vertical bar is about thirteen touch targets long: 583px at 44 each.
  // A tablet in landscape, minus the page bar above the workspace, leaves
  // well under that — and the grip is at one end of the bar.
  const bar = sizedBar(583);
  bar.fitTo({ height: 560, column: 2000 });
  assert.ok(bar.scale() < 1, 'it must give ground');
  assert.ok(583 * bar.scale() <= 560 - 24, 'and end up inside the height, with margin');

  // A workspace tall enough asks for nothing.
  const roomy = sizedBar(583);
  roomy.fitTo({ height: 900, column: 2000 });
  assert.equal(roomy.scale(), 1);
});

check('a bar that already fits is left alone', () => {
  const bar = sizedBar(400);
  bar.fitTo({ height: 900, column: 2000 });
  assert.equal(bar.scale(), 1, 'nothing is gained by shrinking a bar that fits');
});

check('it follows the column, so the tools belong to the pane they serve', () => {
  const wide = sizedBar(400);
  wide.fitTo({ height: 1200, column: 900 });
  const half = sizedBar(400);
  half.fitTo({ height: 1200, column: 300 });
  assert.ok(half.scale() < wide.scale(), 'a narrower column gets a smaller bar');
});

check('it never shrinks past what a finger can hit', () => {
  const bar = sizedBar(583);
  bar.fitTo({ height: 120, column: 40 });
  assert.ok(bar.scale() >= 0.72, 'below 32px the honest answer is fewer tools, not smaller ones');
});

// The acceptance run on the tablet found the bar sized against the wrong pane:
// it floated over a 312px column while the 856px one was active, and kept the
// size the wide pane had earned it.
function workspaceOver(barLeft, barWidth, { swapped = false, active = SLOTS.PRIMARY } = {}) {
  const ws = Object.create(PdfWorkspace.prototype);
  ws.activeSlot = active;
  ws.state = { swapped };
  ws.toolbar = { root: { getBoundingClientRect: () => ({ left: barLeft, width: barWidth }) } };
  return ws;
}
const ROOT_RECT = { left: 0, width: 1200 };

check('the bar is measured against the column it floats over, not the active one', () => {
  // Left column a quarter of the workspace, right one three quarters, and the
  // wide one active — the situation the tablet run reproduced.
  const fractions = { [SLOTS.PRIMARY]: 0.26, [SLOTS.SECONDARY]: 0.74 };
  const ws = workspaceOver(10, 50, { active: SLOTS.SECONDARY });
  assert.equal(
    Math.round(ws._toolbarColumnWidth(fractions, ROOT_RECT)),
    Math.round(1200 * 0.26),
    'a bar resting on the narrow column is sized by the narrow column',
  );
});

check('swapping the panes does not swap which column the bar is measured by', () => {
  const fractions = { [SLOTS.PRIMARY]: 0.26, [SLOTS.SECONDARY]: 0.74 };
  // Swapped, so the SECONDARY slot is the one drawn on the left.
  const ws = workspaceOver(10, 50, { swapped: true, active: SLOTS.PRIMARY });
  assert.equal(
    Math.round(ws._toolbarColumnWidth(fractions, ROOT_RECT)),
    Math.round(1200 * 0.74),
    'the left-hand column is whichever slot is drawn there',
  );
});

check('a bar with no box yet falls back to the active pane', () => {
  const fractions = { [SLOTS.PRIMARY]: 0.3, [SLOTS.SECONDARY]: 0.7 };
  const ws = workspaceOver(0, 0, { active: SLOTS.SECONDARY });
  assert.equal(Math.round(ws._toolbarColumnWidth(fractions, ROOT_RECT)), Math.round(1200 * 0.7));
});

check('a bar whose active column has gone is fitted to the workspace, not to nothing', () => {
  // One file on screen: the other column is at zero share, and it can be the
  // ACTIVE one — tapping 专注 on the right pane does not move the cursor off
  // the left. A fallback of "the active column's share" is zero there, and a
  // bar fitted to a column 0px wide has nothing to lay out in.
  const fractions = { [SLOTS.PRIMARY]: 0, [SLOTS.SECONDARY]: 1 };
  const ws = workspaceOver(0, 0, { active: SLOTS.PRIMARY });
  assert.equal(ws._toolbarColumnWidth(fractions, ROOT_RECT), 1200,
    'with nothing to rest on, the bar gets the whole workspace');
});

check('changing the active pane refits the bar, with no resize to ride on', () => {
  const src = $code('src/pdf/pdf-workspace.js');
  const body = src.slice(src.indexOf('_markActive(slot) {'));
  assert.ok(/_syncToolbarSize/.test(body.slice(0, 400)),
    'activation must refit, or the bar keeps the size the other pane earned it');
});

check('the bar keeps clear of every header it can see, not just the active one', () => {
  // Measured on the tablet: focusing the RIGHT column while the LEFT one was
  // active took the left column out of the flow, its header measured 0, and
  // the bar was told the top 40px were free. It sprang 76px upward in one
  // frame — at the end of an animation that was never about it.
  const head = (h) => ({ hidden: false, offsetHeight: h });
  const slotWith = (h, { hidden = false, width = 600 } = {}) => ({
    hidden,
    offsetWidth: width,
    querySelector: (sel) => (sel === '.pdf-slot-toolbar' ? head(h) : null),
  });

  const ws = Object.create(PdfWorkspace.prototype);
  ws.activeSlot = SLOTS.PRIMARY;
  ws.state = { orientation: 'row', swapped: false };
  ws.root = { getBoundingClientRect: () => ({ left: 0, width: 1200, height: 700 }) };
  const safe = [];
  ws.toolbar = {
    root: { getBoundingClientRect: () => ({ left: 900, width: 50 }) },
    setSafeArea: (top) => safe.push(top),
    fitTo: () => {},
  };

  // The active column is the one that has just left the screen.
  ws.elSlots = {
    [SLOTS.PRIMARY]: slotWith(40, { hidden: true, width: 0 }),
    [SLOTS.SECONDARY]: slotWith(40),
  };
  ws._syncToolbarSize({ [SLOTS.PRIMARY]: 0, [SLOTS.SECONDARY]: 1 });
  assert.equal(safe.pop(), 40, 'the header still on screen is still in the way');

  // Nothing on screen at all is the only way to get zero.
  ws.elSlots = {
    [SLOTS.PRIMARY]: slotWith(40, { hidden: true, width: 0 }),
    [SLOTS.SECONDARY]: slotWith(40, { hidden: true, width: 0 }),
  };
  ws._syncToolbarSize({ [SLOTS.PRIMARY]: 0, [SLOTS.SECONDARY]: 0 });
  assert.equal(safe.pop(), 0);
});

check('回来先看见书架，但只在桌上是空的时候', () => {
  const code = $code('src/pdf/pdf-workspace-ui.js');
  assert.ok(/if \(workspace\.isEmpty\(\)\) openLibrary\(\);/.test(code),
    '上次还开着书就接着读，全关了才回书架');
  assert.ok(/workspace\.onEmpty = \(\) => openLibrary\(\)/.test(code),
    '关掉最后一份之后，书架自己回来');
});

check('横向不挡路的菜单栏，不该把工具栏顶起来', () => {
  // 真机上量到的：那条菜单栏是居中的一颗胶囊，横跨 360–840；而工具栏靠在最左边
  // 的 10–63。两者横向根本不相交，可安全区原来是按整条底边算的——菜单栏一升起来
  // 工具栏就被顶上去、还缩短了一截，而它从头到尾没被挡住过一个像素。
  const ws = Object.create(PdfWorkspace.prototype);
  ws.elSlots = { [SLOTS.PRIMARY]: null, [SLOTS.SECONDARY]: null };
  const host = { left: 0, right: 1200, top: 64, bottom: 736, width: 1200, height: 672 };

  const withDockAndBar = (dock, bar) => {
    const realQuery = globalThis.document.querySelector;
    globalThis.document.querySelector = (sel) => (sel === '.bottom-nav'
      ? { getBoundingClientRect: () => dock } : realQuery.call(globalThis.document, sel));
    ws.toolbar = { rect: () => bar };
    try { return ws._toolbarSafeArea(host); } finally {
      globalThis.document.querySelector = realQuery;
    }
  };

  // 菜单栏升起来，盖住工作区底下 78px
  const dockOut = { left: 360, right: 840, top: 658, bottom: 830, height: 172 };

  const aside = withDockAndBar(dockOut, { left: 10, right: 63 });
  assert.equal(aside.bottom, 0, '在最左边的工具栏，居中的菜单栏碰不到它');

  const over = withDockAndBar(dockOut, { left: 400, right: 460 });
  assert.equal(Math.round(over.bottom), 78, '横着压在它上面的才算数');

  // 挨着边界的两种：擦过和差一点
  assert.ok(withDockAndBar(dockOut, { left: 300, right: 370 }).bottom > 0, '压住一点也是压住');
  assert.equal(withDockAndBar(dockOut, { left: 300, right: 360 }).bottom, 0, '刚好挨上不算');
});

check('判的是横向，不是纵向——否则会来回摆', () => {
  // 被顶上去之后纵向就不相交了。拿纵向去判的话：顶上去 → 不冲突了 → 落回来 →
  // 又冲突，一帧一个样。横向不随这个动作改变。
  const src = $code('src/pdf/pdf-workspace.js');
  const fn = src.slice(src.indexOf('_toolbarSafeArea(rect) {'));
  const body = fn.slice(0, fn.indexOf('syncToolbarSafeArea()'));
  assert.ok(/box\.right > bar\.left && box\.left < bar\.right/.test(body),
    '横向相交');
  assert.ok(!/box\.bottom > bar\.top/.test(body), '不能拿纵向去判');
});

check('a layout change asks again whether the bar is in the way', () => {
  // The bar folds when a panel opens and comes back when it closes — but the
  // panel can hold still while the layout moves out from under it. Focusing the
  // other pane takes the column holding an open table of contents off the
  // screen; nothing opened, nothing closed, and the bar stayed folded in a
  // corner with nothing on screen left to close.
  const src = $code('src/pdf/pdf-workspace.js');
  const bands = src.slice(src.indexOf('_syncPaneWidthBands(fractions) {'));
  const body = bands.slice(0, bands.indexOf('_settleHeaderFit() {'));
  assert.ok(/_reviewToolbarConflict\(\)/.test(body),
    'every layout settle re-asks the question');

  const watch = src.slice(src.indexOf('_watchSlotSizes() {'));
  assert.ok(/_reviewToolbarConflict\(\)/.test(watch.slice(0, watch.indexOf('// ── state'))),
    'and so does a size change with no state change behind it — a rotation');
});

check('moving the bar refits it, because a move can change its column', () => {
  const src = $code('src/pdf/pdf-workspace.js');
  assert.ok(/onChange:\s*\(\)\s*=>\s*this\._syncToolbarSize/.test(src),
    'the toolbar reports its own moves; the workspace has to listen');
});

// ═══════════════════════════════════════════════════════════════
group('6. The slot toolbar sheds chrome until it fits');

/** A slot whose toolbar reports a width that shrinks as rungs are applied. */
function slotWithHeader(have, needs) {
  const classes = new Set();
  const el = {
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
    querySelector: () => bar,
  };
  const bar = {
    get clientWidth() { return have; },
    // needs[n] is what the bar wants with n rungs applied.
    get scrollWidth() {
      const n = ['is-snug', 'is-snugger'].filter((c) => classes.has(c)).length;
      return Math.max(needs[n], have);
    },
  };
  return { el, classes };
}

function fitHeader(slot, passes = 4) {
  const ws = Object.create(PdfWorkspace.prototype);
  ws._headerWanted = {};
  ws.elSlots = { [SLOTS.PRIMARY]: slot.el, [SLOTS.SECONDARY]: null };
  for (let i = 0; i < passes; i++) ws._syncPaneHeaderFit();
  return ws;
}

check('a 50:50 pane sheds enough that the answer button stops scrolling away', () => {
  // Measured on the tablet: 774 natural, 651 with captions gone and the spacing
  // tightened, 561 once the two readouts go. A 50:50 column is 584.
  const slot = slotWithHeader(584, [774, 651, 561]);
  fitHeader(slot);
  assert.ok(slot.classes.has('is-snug') && slot.classes.has('is-snugger'),
    'both rungs are needed at 584 — the first alone still wants 651');
});

check('it stops at the first rung that fits, rather than stripping everything', () => {
  const slot = slotWithHeader(700, [774, 651, 561]);
  fitHeader(slot);
  assert.ok(slot.classes.has('is-snug'), 'one rung is needed at 700');
  assert.ok(!slot.classes.has('is-snugger'), 'and one is enough, so the readouts stay');
});

check('a pane with room keeps all of its chrome', () => {
  const slot = slotWithHeader(900, [774, 651, 561]);
  fitHeader(slot);
  assert.equal(slot.classes.size, 0, 'nothing is hidden from a bar that fits');
});

check('widening a pane puts back what narrowing it took away', () => {
  const slot = slotWithHeader(584, [774, 651, 561]);
  const ws = fitHeader(slot);
  assert.ok(slot.classes.has('is-snugger'), 'narrow first');

  // Now give it the room back. The margin matters: coming back at exactly the
  // width it left at would sit on the boundary and flicker.
  ws.elSlots[SLOTS.PRIMARY] = slot.el;
  const wide = { ...slot };
  let have = 900;
  Object.defineProperty(slot.el.querySelector(), 'clientWidth', { get: () => have, configurable: true });
  for (let i = 0; i < 6; i++) ws._syncPaneHeaderFit();
  assert.equal(slot.classes.size, 0, 'everything comes back once there is room for it');
  void wide;
});

check('a rung is not judged while the last one is still closing', () => {
  // Shedding a rung collapses its widths over a quarter second. Until that
  // lands the bar still measures as though nothing had gone, so a ladder that
  // looked again straight away would strip itself bare in three frames — and
  // would record what it "wanted" from a width caught mid-flight, which is the
  // number that decides whether the chrome ever comes back.
  const slot = slotWithHeader(584, [774, 651, 561]);
  const bar = slot.el.querySelector();
  let moving = true;
  bar.getAnimations = () => (moving
    ? [{ playState: 'running', transitionProperty: 'max-width' }]
    : []);

  const ws = Object.create(PdfWorkspace.prototype);
  ws._headerWanted = {};
  ws.elSlots = { [SLOTS.PRIMARY]: slot.el, [SLOTS.SECONDARY]: null };

  moving = false;
  ws._syncPaneHeaderFit();
  assert.equal(slot.classes.size, 1, 'the first rung goes on');

  moving = true;
  for (let i = 0; i < 6; i++) ws._syncPaneHeaderFit();
  assert.equal(slot.classes.size, 1, 'and nothing follows it while it is moving');

  moving = false;
  ws._syncPaneHeaderFit();
  assert.equal(slot.classes.size, 2, 'once it has landed the ladder carries on');
});

check('a fade or a hover tint is not a reason to wait', () => {
  const slot = slotWithHeader(584, [774, 651, 561]);
  slot.el.querySelector().getAnimations = () => [
    { playState: 'running', transitionProperty: 'background-color' },
    { playState: 'running', transitionProperty: 'opacity' },
  ];
  const ws = Object.create(PdfWorkspace.prototype);
  ws._headerWanted = {};
  ws.elSlots = { [SLOTS.PRIMARY]: slot.el, [SLOTS.SECONDARY]: null };
  for (let i = 0; i < 4; i++) ws._syncPaneHeaderFit();
  assert.equal(slot.classes.size, 2, 'only the transitions that move width hold it up');
});

check('a column that is animating sheds chrome frame by frame, not at the end', () => {
  // The bar used to be left alone for the whole 380ms and measured once, when
  // it was over. So a column collapsing from full screen to half spent the
  // animation overflowing — the tail buttons pushed out past its own edge —
  // and then everything landed in ONE frame: a 45px jump, measured on the
  // tablet. The width during the animation is not a guess; the column really
  // is that wide at that moment, so it can be priced then.
  const slot = slotWithHeader(0, [774, 651, 561]);
  let have = 1188;
  Object.defineProperty(slot.el.querySelector(), 'clientWidth',
    { get: () => have, configurable: true });

  const ws = Object.create(PdfWorkspace.prototype);
  ws._headerWanted = {};
  ws.elSlots = {
    [SLOTS.PRIMARY]: slot.el,
    [SLOTS.SECONDARY]: { classList: { contains: () => false, add: () => {}, remove: () => {} }, querySelector: () => null },
  };
  let previews = 0;
  ws._previewPaneFits = () => { previews++; };

  const queue = [];
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => queue.push(fn);
  globalThis.cancelAnimationFrame = () => {};

  const rungsAt = [];
  try {
    ws._trackPaneFits(380);
    // Walk the column down the way the CSS transition does, a frame at a time.
    for (const width of [1188, 900, 700, 640, 600, 584, 584, 584]) {
      have = width;
      queue.shift()?.();
      rungsAt.push([width, ['is-snug', 'is-snugger'].filter((c) => slot.classes.has(c)).length]);
    }
  } finally {
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = caf;
  }

  const first = rungsAt.find(([, n]) => n > 0);
  assert.ok(first, 'a bar wanting 774 in a 584 column has to shed something');
  assert.ok(first[0] > 584,
    `the first rung goes on at ${first?.[0]}px, while the column is still on its
     way — not after it has landed`);
  assert.equal(rungsAt[rungsAt.length - 1][1], 2, 'and it arrives fully settled');
  assert.ok(previews >= 8, 'the pages are still re-priced on every frame too');
});

check('one rung per frame, so an animation cannot thrash the bar', () => {
  // The whole-ladder settle is for the ends of things. Per frame it is the
  // drag rule: measure, step once, look again next frame.
  const src = $code('src/pdf/pdf-workspace.js');
  const step = src.slice(src.indexOf('_trackPaneFits(duration) {'));
  const body = step.slice(0, step.indexOf('animateToRatio'));
  assert.ok(/this._syncPaneHeaderFit()/.test(body), 'the tracker prices the bar');
  assert.ok(!/this._settleHeaderFit()/.test(body),
    'but one rung at a time — climbing the whole ladder every frame is the drag cost times two');
});

check('what a rung takes away slides shut, and comes back by fading in', () => {
  const css = $read('src/styles/pdf.css');
  const base = css.slice(css.indexOf('.pdf-slot-btn-text,'));
  assert.ok(/transition: max-width [\d.]+s[^;]*opacity/.test(base.slice(0, 400)),
    'coming back is a fade — the caption appears where its room already is');

  // Going the other way the caption is dropped outright. It is collapsed at the
  // moment the bar runs out of room, and at that moment flex has already
  // squeezed it to nothing; animating the opacity there makes it spring BACK
  // into view for a moment as the pressure releases.
  const shut = css.slice(css.indexOf('.pdf-ws-slot.is-snug .pdf-slot-title,'));
  const rule = shut.slice(0, shut.indexOf('}'));
  assert.ok(/transition:[^;]*max-width/.test(rule), 'the room it took still closes gradually');
  assert.ok(!/opacity/.test(rule), 'but the text itself does not linger on the way out');
});

check('no rung ever hides something you can press', () => {
  const css = $read('src/styles/material.css');
  const from = css.indexOf('.pdf-ws-slot.is-snug');
  const block = css.slice(from, css.indexOf('.pdf-ws-slot', css.indexOf('is-snugger') + 40));
  assert.ok(!/data-role="(answers|focus|close|outline|prev|next|zoom-in|zoom-out)"/.test(block),
    'captions and readouts may go; tap targets may not');
  assert.ok(/is-snug \.pdf-slot-btn-text/.test(block), 'the captions are what goes first');
});

check('every size on the bar goes through the one multiplier', () => {
  const css = $read('src/styles/ink-toolbar.css');
  assert.ok(/--ink-hit: calc\(44px \* var\(--ink-scale\)\)/.test(css));
  // Including the desktop override, which would otherwise spring a fitted bar
  // back to full size the moment it is opened with a mouse.
  const fine = css.match(/@media \(pointer: fine\) \{[\s\S]*?\n\}/);
  assert.ok(fine && /var\(--ink-scale\)/.test(fine[0]),
    'the pointer:fine override must scale too');
  assert.ok(!/--ink-hit: \d+px;/.test(css), 'no absolute hit size may survive');
});

// ═══════════════════════════════════════════════════════════════
group('6. A double-tap opens the row');

const tap = (el, { x = 50, y = 50, target = el } = {}) => {
  const e = new dom.window.PointerEvent('pointerup', {
    bubbles: true, clientX: x, clientY: y,
  });
  target.dispatchEvent(e);
};

function row() {
  const el = document.createElement('div');
  el.innerHTML = '<div class="body">名称</div><div class="acts"><button>打开</button></div>';
  document.body.appendChild(el);
  let opened = 0;
  const off = onDoubleTap(el, () => { opened++; }, { ignore: '.acts' });
  return { el, off, count: () => opened };
}

check('two quick taps open it; one does not', () => {
  const r = row();
  tap(r.el);
  assert.equal(r.count(), 0, 'a single tap is not an open');
  tap(r.el);
  assert.equal(r.count(), 1, 'the second tap opens it');
  r.off();
});

check('a third tap does not open it again', () => {
  // The pair is consumed, so three taps are one open — not two.
  const r = row();
  tap(r.el); tap(r.el); tap(r.el);
  assert.equal(r.count(), 1);
  tap(r.el);
  assert.equal(r.count(), 2, 'but the fourth completes a new pair');
  r.off();
});

check('two taps far apart on the row are two taps, not a double', () => {
  const r = row();
  tap(r.el, { x: 20, y: 20 });
  tap(r.el, { x: 400, y: 20 });
  assert.equal(r.count(), 0, 'the hand does not move 380px between a double-tap');
  r.off();
});

check('a slow second tap is not a double-tap', async () => {
  const r = row();
  tap(r.el);
  const real = Date.now;
  try {
    Date.now = () => real() + 5000;
    tap(r.el);
  } finally {
    Date.now = real;
  }
  assert.equal(r.count(), 0);
  r.off();
});

check('taps on the buttons never reach the row', () => {
  // Otherwise a double-tap on 打开 would open the same document twice, into
  // both panes.
  const r = row();
  const button = r.el.querySelector('button');
  tap(r.el, { target: button });
  tap(r.el, { target: button });
  assert.equal(r.count(), 0);
  r.off();
});

check('the listener can be taken back', () => {
  const r = row();
  r.off();
  tap(r.el); tap(r.el);
  assert.equal(r.count(), 0);
});

check('onDoubleTap survives being handed nothing', () => {
  assert.equal(typeof onDoubleTap(null, () => {}), 'function');
  assert.equal(typeof onDoubleTap(document.createElement('div'), null), 'function');
});

check('one tap opens a book, and a second one mid-open is ignored', () => {
  // The library was a list of rows and a row took a DOUBLE tap, because a row
  // also carried three buttons and one tap had to be able to mean "not those".
  // A book on a shelf carries nothing: tapping it is the only thing it does, so
  // it opens on the first tap and everything else moved into its ⋯.
  const code = $code('src/pdf/pdf-workspace-ui.js');
  assert.ok(!/onDoubleTap/.test(code), 'no double-tap left on the shelf');
  assert.ok(/openingId === item\.id/.test(code),
    'a second activation while the first is still in flight is ignored');

  const shelf = $code('src/pdf/book-shelf.js');
  assert.ok(/addEventListener\('click', \(\) => this\.onOpen/.test(shelf),
    'the whole book is the target, not a button inside it');
  assert.ok(/e\.stopPropagation\(\)/.test(shelf),
    'and a tap on the ⋯ is a tap on IT, not on the book around it');

  const css = $read('src/styles/pdf.css');
  const rule = css.match(/\.pdf-book-hit\s*\{[^}]*\}/);
  assert.ok(rule && /cursor:\s*pointer/.test(rule[0]),
    'a book that opens has to look like it can be pressed');
});

// ═══════════════════════════════════════════════════════════════
group('6b. 缩放时报一下当前比例');

/** 一栏，和它那块只在缩放时露面的牌子。 */
function zoomSlot() {
  document.body.innerHTML =
    '<div class="pdf-ws-slot"><div data-role="zoom-badge"></div></div>';
  const el = document.querySelector('.pdf-ws-slot');
  const ws = Object.create(PdfWorkspace.prototype);
  ws.elSlots = { [SLOTS.PRIMARY]: el };
  return { ws, badge: el.querySelector('[data-role="zoom-badge"]') };
}

const shown = (badge) => badge.classList.contains('is-visible');

check('比例变了就报，报的是变成了多少', () => {
  const { ws, badge } = zoomSlot();
  ws._flashZoom(SLOTS.PRIMARY, 100, 'e1');
  assert.ok(!shown(badge), '刚打开不是一次缩放');
  ws._flashZoom(SLOTS.PRIMARY, 122, 'e1');
  assert.ok(shown(badge));
  assert.equal(badge.textContent, '122%');
});

check('翻页、落笔不报——那些也走同一条路', () => {
  // _syncSlotChrome 在翻页、撤销、笔迹变化时都会被叫到。比例没变就不该出声，
  // 否则这块牌子会在人根本没缩放的时候一直冒出来。
  const { ws, badge } = zoomSlot();
  ws._flashZoom(SLOTS.PRIMARY, 100, 'e1');
  ws._flashZoom(SLOTS.PRIMARY, 122, 'e1');
  badge.classList.remove('is-visible');
  ws._flashZoom(SLOTS.PRIMARY, 122, 'e1');
  assert.ok(!shown(badge), '同一个数不该再报一遍');
});

check('换一本书不报——那不是一次缩放，是一次打开', () => {
  // 新书有自己的比例，几乎必然和上一本不同。把它当成缩放，就会变成每次切换
  // 都在页面正中间闪一个数。
  const { ws, badge } = zoomSlot();
  ws._flashZoom(SLOTS.PRIMARY, 122, 'e1');
  ws._flashZoom(SLOTS.PRIMARY, 100, 'e2');
  assert.ok(!shown(badge));
  ws._flashZoom(SLOTS.PRIMARY, 140, 'e2');
  assert.ok(shown(badge), '换过去之后再缩放，照报');
});

check('两栏各报各的', () => {
  document.body.innerHTML =
    '<div class="a"><div data-role="zoom-badge"></div></div>'
    + '<div class="b"><div data-role="zoom-badge"></div></div>';
  const ws = Object.create(PdfWorkspace.prototype);
  ws.elSlots = {
    [SLOTS.PRIMARY]: document.querySelector('.a'),
    [SLOTS.SECONDARY]: document.querySelector('.b'),
  };
  const a = document.querySelector('.a [data-role="zoom-badge"]');
  const b = document.querySelector('.b [data-role="zoom-badge"]');
  ws._flashZoom(SLOTS.PRIMARY, 100, 'e1');
  ws._flashZoom(SLOTS.SECONDARY, 100, 'e2');
  ws._flashZoom(SLOTS.PRIMARY, 150, 'e1');
  assert.ok(shown(a) && a.textContent === '150%');
  assert.ok(!shown(b), '缩放是这一栏自己的事');
});

check('没有装东西的栏不报', () => {
  const { ws, badge } = zoomSlot();
  ws._flashZoom(SLOTS.PRIMARY, 122, 'e1');
  badge.classList.remove('is-visible');
  ws._flashZoom(SLOTS.PRIMARY, null, null);
  assert.ok(!shown(badge));
});

check('横杠上那个读数和这块牌子是同一个数算出来的', () => {
  // 算两遍的话，它们迟早会在某个边界上各说各的——而人会同时看到两个数。
  const src = $code('src/pdf/pdf-workspace.js');
  const at = src.indexOf('const zoomPercent =');
  assert.ok(at > 0, '读数只该算一次');
  const after = src.slice(at, at + 500);
  assert.ok(/zoom-label[\s\S]*zoomPercent/.test(after), '横杠上的小字用它');
  assert.ok(/_flashZoom\(slot, zoomPercent/.test(after), '牌子也用它');
});

// ═══════════════════════════════════════════════════════════════
group('7. What the launcher shows, and what the licence obliges');

check('the launcher says what the app is called', () => {
  const xml = $read('android/app/src/main/res/values/strings.xml');
  assert.ok(/<string name="app_name">对页<\/string>/.test(xml),
    'the home screen said LaTeXSnipper while every screen inside said 对页');
  assert.ok(/<string name="title_activity_main">对页<\/string>/.test(xml));
});

check('every density has a launcher icon, and none of them is a placeholder', () => {
  const { statSync } = require('node:fs');
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      const p = join(ROOT, 'android/app/src/main/res/mipmap-' + d, f);
      assert.ok(statSync(p).size > 400, `${d}/${f} is too small to be a real icon`);
    }
  }
});

check('the adaptive icon stands on the icon gradient, not a white card', () => {
  for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const xml = $read('android/app/src/main/res/mipmap-anydpi-v26/' + f);
    assert.ok(/@drawable\/ic_launcher_bg/.test(xml), `${f} still points at the old background`);
  }
  const bg = $read('android/app/src/main/res/drawable/ic_launcher_bg.xml');
  assert.ok(/#2F74FF/i.test(bg) && /#0A4FDC/i.test(bg),
    'the launcher ground is the same gradient as public/icon.svg');
});

check('the app tells the person holding it what it is licensed under — in every language', () => {
  // 这段声明原来写死在 index.html 里，换语言时它不动。现在走词表，所以它同时变成
  // 了五处——而「某一种语言的包漏掉了许可声明」是这种做法真正的风险：界面看着好
  // 好的，拿到包的人却读不到他该读的东西。所以五份都要查。
  const html = $read('index.html');
  for (const key of ['about.licence', 'about.derived', 'about.rewritten', 'about.source']) {
    assert.ok(html.includes(`data-i18n="${key}"`), `the notice still carries ${key}`);
  }
  assert.ok(/data-i18n-html/.test(html),
    'the paragraphs carry links, so they must be written as HTML');

  for (const lang of ['zh-CN', 'zh-TW', 'en']) {
    const pack = $read(`src/core/lang/${lang}.js`);
    assert.ok(/MIT/.test(pack), `${lang}: 拿到包的人有权在界面上读到它的许可证`);
    assert.ok(/LaTeXSnipper_mobile/.test(pack), `${lang}: and to credit the work it derives from`);
    assert.ok(/Math-answer-to-question-matching-model/.test(pack), `${lang}: and the engine it vendors`);
    assert.ok(/github\.com\/LZY0105\/duiye/.test(pack), `${lang}: and where the source can be had`);
  }
});

check('the version in the notice comes from the build, not a literal', () => {
  const js = $code('src/settings/settings.js');
  assert.ok(/__APP_VERSION__/.test(js),
    'a notice that names the wrong version is worse than one that names none');
  assert.ok(/aboutVersion/.test($read('index.html')));
});

check('换了许可证，旧的那一份原文仍然留着', () => {
  // AGPL 不是「以前用过的东西」——分界点之前的每一个版本现在仍然适用它，而那些
  // 版本就在这个仓库的历史里。原文一删，那些版本就成了没有许可证的代码。
  assert.ok(existsSync(join(ROOT, 'LICENSE.AGPL-3.0')),
    'LICENSE.AGPL-3.0 管着分界点之前的所有版本，不能删');
  assert.ok(/GNU AFFERO GENERAL PUBLIC LICENSE/.test($read('LICENSE.AGPL-3.0')),
    '而且要是原文，不是一句说明');
  assert.ok(/MIT License/.test($read('LICENSE')), '现在的 LICENSE 是 MIT');
  assert.ok(existsSync(join(ROOT, 'docs/许可证变更.md')),
    '分界点在哪、凭什么可以改，要写下来——这是将来唯一拿得出的东西');
});

check('the notices file no longer credits what was deleted', () => {
  const md = $read('THIRD_PARTY_NOTICES.md');
  const sections = md.split('\n').filter((l) => l.startsWith('## '));
  assert.ok(!sections.some((l) => /llama\.cpp|ONNX/i.test(l)),
    'crediting a dependency the build does not have is its own kind of wrong');
  assert.ok(/LaTeXSnipper Mobile base/.test(md), 'the base project is still credited');
});

// ── the two bars, put away and brought back ─────────────────────────────────

group('12. Hiding the bars, and getting them back');

/**
 * The page as initChromeHiding finds it, with both bars where they really sit.
 *
 * JSDOM has no layout, so every box is 0x0 and every hit test would miss. The
 * rectangles are stated instead — taken from the tablet, at the sizes the
 * gesture actually has to cope with.
 */
function chromePage({ topHidden = false, bottomHidden = false } = {}) {
  document.body.className = '';
  // initChromeHiding restores what was hidden last time, and localStorage is
  // one object for the whole run — without this a scenario starts wherever the
  // previous one left the bars, and a check on where they ended up is really a
  // check on what ran before it.
  try { localStorage.clear(); } catch (_) { /* not available */ }
  document.body.innerHTML = [
    '<div class="bar-peek" data-role="bar-peek"></div>',
    '<div class="dock-peek" data-role="dock-peek"></div>',
    '<div class="page" id="page-pdf">',
    '  <div class="pdf-page-bar"></div>',
    '</div>',
    '<nav class="bottom-nav">',
    '  <button class="active" data-page="pdf"><svg></svg><span>课本</span></button>',
    '  <button data-page="settings"><svg></svg><span>设置</span></button>',
    '</nav>',
  ].join('\n');

  const root = document.getElementById('page-pdf');
  const q = (sel) => document.querySelector(sel);
  const box = (el, r) => { el.getBoundingClientRect = () => ({
    left: r[0], top: r[1], right: r[2], bottom: r[3],
    width: r[2] - r[0], height: r[3] - r[1], x: r[0], y: r[1],
  }); };

  box(q('.pdf-page-bar'), topHidden ? [0, -44, 1200, 0] : [0, 8, 1200, 52]);
  box(q('.bar-peek'), topHidden ? [0, 0, 1148, 64] : [0, 0, 0, 0]);
  box(q('.bottom-nav'), bottomHidden ? [0, 700, 1200, 766] : [0, 634, 1200, 700]);
  // 200px, centred on a 1200px viewport — the handle the dock is called back
  // from. It used to run 200-1000, and everything it covered stopped being page.
  box(q('[data-role="dock-peek"]'), bottomHidden ? [500, 620, 700, 700] : [0, 0, 0, 0]);
  // Measured off the tablet: the capsules fill the bar but for five pixels
  // either side, which is the whole reason the bar is not a grab any more.
  box(q('[data-page="pdf"]'), [365, 640, 600, 696]);
  box(q('[data-page="settings"]'), [600, 640, 835, 696]);

  if (topHidden) document.body.classList.add('is-top-hidden');
  if (bottomHidden) document.body.classList.add('is-bottom-hidden');
  // The last scenario's listeners come off first. Left on, they would handle
  // every gesture twice — which is exactly the fault initChromeHiding's
  // teardown exists to prevent in the app, so the tests would be papering over
  // the thing they are meant to catch.
  chromeOff?.();
  chromeOff = initChromeHiding(root);
  return root;
}
let chromeOff = null;

/**
 * A finger going down at (x,y), travelling `dy`, and lifting.
 *
 * `on` is what it comes down on, which is half of what the handler decides
 * from: a press on a capsule and a press on the glass beside it are the same
 * coordinates as far as a box test goes, and must not be the same gesture.
 */
function swipe(x, y, dy, { steps = 8, on = null, pointerType = 'touch' } = {}) {
  const target = on || document;
  const fire = (type, cy) => target.dispatchEvent(new window.PointerEvent(type, {
    clientX: x, clientY: cy, pointerId: 1, pointerType, isPrimary: true,
    bubbles: true, cancelable: true,
  }));
  fire('pointerdown', y);
  for (let i = 1; i <= steps; i++) fire('pointermove', y + (dy * i) / steps);
  fire('pointerup', y + dy);
}

const capsule = (page) => document.querySelector(`[data-page="${page}"]`);

const hidden = (which) => document.body.classList.contains('is-' + which + '-hidden');

check('dragging the import row up puts it away', () => {
  chromePage();
  swipe(600, 30, -60);
  assert.ok(hidden('top'), 'a deliberate upward drag on the row is how it goes');
  assert.ok(!hidden('bottom'), 'and it does not take the dock with it');
});

check('dragging down from the top brings the import row back', () => {
  chromePage({ topHidden: true });
  swipe(600, 30, 80);
  assert.ok(!hidden('top'), 'the strip above the pane toolbar is what catches this');
});

check('the row comes back from a press anywhere along the strip', () => {
  for (const x of [40, 600, 1100]) {
    chromePage({ topHidden: true });
    swipe(x, 30, 80);
    assert.ok(!hidden('top'), 'a press at x=' + x + ' should reach it too');
  }
});

check('dragging the dock down puts it away, and a swipe up brings it back', () => {
  chromePage();
  swipe(600, 600, 70);
  assert.ok(hidden('bottom'), 'the dock goes down');
  assert.ok(!hidden('top'), 'and the row above stays');

  chromePage({ bottomHidden: true });
  swipe(600, 670, -70);
  assert.ok(!hidden('bottom'), 'and comes back up');
});

check('a wandering tap on the dock is not a drag', () => {
  chromePage();
  swipe(600, 600, 9, { steps: 3 });
  assert.ok(!hidden('bottom'),
    'a finger resting on 课本 moves a few pixels before it lifts — that is a press');
});

check('a sideways swipe along the dock is not a drag either', () => {
  chromePage();
  const fire = (type, x, y) => document.dispatchEvent(new window.PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true,
    bubbles: true, cancelable: true,
  }));
  fire('pointerdown', 400, 660);
  for (let i = 1; i <= 8; i++) fire('pointermove', 400 + i * 25, 660 + i * 2);
  fire('pointerup', 600, 676);
  assert.ok(!hidden('bottom'), 'a thumb sliding across the dock is not reaching for it');
});

check('a drag that changes its mind leaves the bar where it was', () => {
  chromePage();
  const fire = (type, y) => document.dispatchEvent(new window.PointerEvent(type, {
    clientX: 600, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true,
    bubbles: true, cancelable: true,
  }));
  fire('pointerdown', 30);
  for (const y of [22, 14, 8, 16, 24, 30]) fire('pointermove', y);
  fire('pointerup', 30);
  assert.ok(!hidden('top'), 'pulled a little way and put back is not putting it away');
});

check('the drag that moved a bar does not also press the button under it', () => {
  chromePage();
  let pressed = 0;
  capsule('pdf').addEventListener('click', () => { pressed++; });
  swipe(120, 600, 70);
  assert.ok(hidden('bottom'), 'the dock went away');
  capsule('pdf').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 0, 'the click the drag ends on is swallowed, once');
});

check('the gesture is the only way, and there is no button left to press', () => {
  // The chevron in the corner did the same job as the swipe, floated over the
  // page it was making room for, and was the one control on this screen that
  // was not about reading. Removing it means the swipe has to be right — which
  // is what the rest of this group is for.
  const root = chromePage({ topHidden: true, bottomHidden: true });
  assert.equal(root.querySelector('[data-role="chrome-toggle"]'), null,
    'no button in the markup');
  assert.ok(!/chrome-toggle/.test($read('index.html')), 'nor in the page');
  assert.ok(!/pdf-chrome-toggle/.test($read('src/styles/pdf.css')), 'nor in the stylesheet');
  assert.ok(!/chrome-toggle|syncToggle/.test($read('src/pdf/pdf-workspace-ui.js')),
    'and nothing left listening for it');

  swipe(600, 40, 70);
  assert.ok(!hidden('top'), 'the top edge brings the row back');
});

check('the strip that wakes the row has the whole width of the edge', () => {
  const css = $read('src/styles/pdf.css');
  const rule = css.slice(css.indexOf('.bar-peek {'), css.indexOf('body.is-top-hidden .bar-peek'));
  assert.ok(/right:\s*0;/.test(rule),
    'it stopped 52px short to clear the collapse button, which is gone');
});

check('a drag that starts on a capsule leaves the dock alone', () => {
  chromePage();
  swipe(500, 660, 70, { on: capsule('pdf') });
  assert.ok(!hidden('bottom'), 'a finger on 课本 is reaching for 课本, not for the dock');
  chromePage();
  swipe(700, 660, 70, { on: capsule('settings').querySelector('span') });
  assert.ok(!hidden('bottom'), 'and the label inside it counts as the capsule');
});

check('nothing inside the dock takes hold of it, not even the glass', () => {
  // Five pixels of bar either side of the capsules is not something to defend:
  // a finger there is on the capsule as far as the eye goes, and both firing at
  // once is what made the boundary unusable.
  for (const [x, label] of [[365, 'the sliver at the left end'],
                            [500, 'over 课本'],
                            [835, 'the sliver at the right end']]) {
    chromePage();
    swipe(x, 668, 70);
    assert.ok(!hidden('bottom'), label);
  }
});

check('the band above the dock is what moves it', () => {
  chromePage();
  swipe(500, 600, 70);
  assert.ok(hidden('bottom'), 'and it reaches 76px up, so it is worth aiming at');
});

check('a drag that starts above the dock still moves it', () => {
  chromePage();
  swipe(500, 610, 70);
  assert.ok(hidden('bottom'), 'the reach above the dock is over the page, not over a capsule');
});

/*
 * The way back to the dock, and the writing it used to eat.
 *
 * The peek strip is z-index 999 and takes pointer events while the dock is
 * away, so everything it covers stops being page: a press there lands on the
 * strip and never reaches the ink canvas. It ran 200-1000 across the bottom of
 * a 1200px workspace, which is why a line of working along the foot of a page
 * could not be written, and why trying kept pulling the dock back out from
 * under the hand. It is now a 200px handle in the middle — over the divider
 * and its gutter in a split workspace, which costs neither page any room.
 */
check('a stylus writing along the bottom does not summon the dock', () => {
  chromePage({ bottomHidden: true });
  swipe(250, 660, -70, { pointerType: 'pen' });
  assert.ok(hidden('bottom'), 'left of the handle, the pen is writing and nothing else');

  chromePage({ bottomHidden: true });
  swipe(950, 660, -70, { pointerType: 'pen' });
  assert.ok(hidden('bottom'), 'and the same to the right of it');
});

check('a stylus calls the dock back from the middle', () => {
  chromePage({ bottomHidden: true });
  swipe(600, 660, -70, { pointerType: 'pen' });
  assert.ok(!hidden('bottom'), 'the centre is the handle, and the pen still reaches it');
});

check('the hand uses the same handle, and nothing beyond it', () => {
  chromePage({ bottomHidden: true });
  swipe(600, 660, -70);
  assert.ok(!hidden('bottom'), 'a finger on the handle brings it back');

  // The other end of the old strip is page again, for the hand as well. This
  // is the deliberate narrowing: what the strip covers, nobody can write on.
  chromePage({ bottomHidden: true });
  swipe(250, 660, -70);
  assert.ok(hidden('bottom'), 'and away from the handle it no longer answers');
});

check('putting the dock away is unchanged, for the pen as much as the hand', () => {
  // The narrowing is on the way BACK only. Hiding keeps the whole 76px band
  // above the dock, so a deliberate downward drag still works from anywhere.
  chromePage();
  swipe(500, 600, 70, { pointerType: 'pen' });
  assert.ok(hidden('bottom'), 'a pen drag down still puts it away');

  chromePage();
  swipe(250, 600, 70, { pointerType: 'pen' });
  assert.ok(hidden('bottom'), 'from off to one side as much as from the middle');

  chromePage();
  swipe(250, 600, 70);
  assert.ok(hidden('bottom'), 'and the hand is untouched');
});

check('a press on an import button does not move the row', () => {
  chromePage();
  const btn = document.createElement('button');
  btn.textContent = '导入练习册';
  document.querySelector('.pdf-page-bar').appendChild(btn);
  swipe(120, 30, -60, { on: btn });
  assert.ok(!hidden('top'), 'the same rule, at the other end of the screen');
});

await checkAsync('the dock is marked as moving while it travels, and only while', async () => {
  chromePage();
  const during = [];
  // The grab is the band above the dock, which is the page — so the reading is
  // taken from the document, where the gesture actually travels.
  const watch = () => during.push(document.body.classList.contains('is-bottom-moving'));
  document.addEventListener('pointermove', watch);
  swipe(120, 600, 70);
  document.removeEventListener('pointermove', watch);
  assert.ok(during.slice(-1)[0], 'it is marked from the moment it starts travelling');
  assert.ok(document.body.classList.contains('is-bottom-moving'),
    'and still on its way when the finger lets go');
  assert.ok(!document.body.classList.contains('is-top-moving'),
    'the row at the other end is standing still, so it stays usable');
  await wait(500);
  assert.ok(!document.body.classList.contains('is-bottom-moving'),
    'once it has arrived the capsules come back');
});

check('a bar sent away is marked moving whichever edge it left by', () => {
  chromePage();
  swipe(600, 600, 70);
  assert.ok(document.body.classList.contains('is-bottom-moving'), 'the dock');
  chromePage();
  swipe(600, 40, -70);
  assert.ok(document.body.classList.contains('is-top-moving'), 'and the row');
});

check('a bar in motion has nothing on it that can be pressed', () => {
  const css = $read('src/styles/pdf.css');
  assert.ok(/body\.is-bottom-moving \.bottom-nav > button[\s\S]{0,160}?pointer-events:\s*none/.test(css),
    'a capsule arriving under a thumb must not register as a press');
  assert.ok(/body\.is-top-moving \.pdf-page-bar button/.test(css), 'and the same for the row');
  const moving = css.slice(css.indexOf('body.is-bottom-moving'));
  assert.ok(!/^body\.is-bottom-moving \.bottom-nav\s*\{/m.test(moving),
    'the bar itself keeps its events — it has to answer the finger carrying it');
});

check('building the workspace twice does not handle every gesture twice', () => {
  chromePage();
  // A second set of listeners, left on, would arm two swallows per drag — and
  // the second one eats the user's next real tap. This is the fault behind
  // capsules that work, then do not, then do.
  const off = initChromeHiding(document.getElementById('page-pdf'));
  let pressed = 0;
  capsule('pdf').addEventListener('click', () => { pressed++; });
  off();
  swipe(120, 600, 70);
  capsule('pdf').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 0, 'the drag it ends on is still swallowed once');
  capsule('pdf').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 1, 'and the tap after it is not');
});

check('the strip is inert while the row is showing', () => {
  const css = $read('src/styles/pdf.css');
  const block = css.slice(css.indexOf('.bar-peek {'), css.indexOf('body.is-top-hidden .bar-peek'));
  assert.ok(/pointer-events:\s*none/.test(block),
    'it must not sit over the page when there is nothing to bring back');
  assert.ok(/body\.is-top-hidden \.bar-peek \{ pointer-events: auto/.test(css));
  assert.ok(/touch-action:\s*none/.test(block),
    'and it has to refuse the gesture to the WebView, which is the whole point');
});

check('a panel that floats over a document does not let the document through', () => {
  // backdrop-filter is a compositing effect and it comes back empty over the
  // page on this tablet, so a 0.42 fill was a 0.42 fill: ruled lines and
  // formulae ran straight through the settings panel at full contrast.
  const css = $read('src/styles/ink-toolbar.css');
  const card = css.slice(css.indexOf('[data-skin="liquid-math"] .ink-card {'));
  const bg = /--glass-bg:\s*rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/.exec(card);
  assert.ok(bg, 'the card sets its own fill');
  assert.ok(Number(bg[1]) >= 0.9,
    'a card that is read needs a floor the blur is not required to reach, got ' + bg[1]);

  const well = css.slice(css.indexOf('.ink-preview {'), css.indexOf('.ink-preview-line'));
  assert.ok(/background:\s*#fff;/.test(well),
    'and the stroke sample is paper, not a window onto the page behind it');
});

check('nothing offers to update itself unless it was asked to', () => {
  const code = $code('src/update-checker.js');
  assert.ok(/PREF_AUTO\) !== 'true'\) return;/.test(code),
    'opt-in: a changelog took the screen from whatever was on it, including a '
    + 'dialog the reader was in the middle of answering');
  assert.ok(!/=== 'false'/.test(code), 'the opt-out rule is gone');
  assert.ok(/github\.com\/repos\/LZY0105\/duiye/.test(code),
    'and it asks about THIS project — it used to query the upstream repo it '
    + 'was forked from, so "check for update" checked somebody else’s releases');
  assert.ok(!/innerHTML/.test(code),
    'release notes come from the network and must never reach innerHTML');
  const settings = $code('src/settings/settings.js');
  assert.ok(/localStorage\.getItem\('latexsnipper-autoUpdate'\) === 'true'/.test(settings),
    'and the switch shows the same rule the checker follows');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
