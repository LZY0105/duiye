#!/usr/bin/env node
// UI details that only show up when something is driven, not inspected.
//
// Three things live here because each one is a behaviour a static read of the
// source cannot confirm: what the lasso actually paints, what the answer panel
// tells the reader to do next, and whether a row opens on a double-tap.

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
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
import { SLOTS } from '../src/pdf/workspace-state.js';
import { renderAnswerNotice } from '../src/pdf/answer-panel.js';
import { onDoubleTap } from '../src/ui/double-tap.js';

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

// ── environment ─────────────────────────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'PointerEvent', 'Event']) {
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

check('one finger turns the page and does not pan', () => {
  // The rule the tablet asked for: the hand taps, turns pages, and pinches.
  // Taking single-finger panning away is what makes the page turn
  // unambiguous — no threshold that means something different at each zoom.
  const code = $code('src/pdf/pdf-pane.js');
  assert.ok(/if \(e\.pointerType === 'pen'\) return;/.test(code),
    'the pen never reaches the page gestures');
  assert.ok(/touches\.size === 2/.test(code), 'two fingers are a pinch');
  // The gate that only turned the page once panning had run out of room went
  // with single-finger panning. It existed so one gesture did not mean two
  // things; there is only one meaning left.
  assert.ok(!/atEnd/.test(code) && !/atStart/.test(code),
    'the "only turn at the edge" rule is gone');

  // A single touch must not reach panBy. The only pan paths left are the
  // mouse drag, the two-finger pinch and the wheel.
  const single = code.slice(code.indexOf('if (e.pointerType === \'touch\')'));
  const beforePinch = single.slice(0, single.indexOf('touches.size !== 2'));
  assert.ok(!/panBy/.test(beforePinch), 'one finger must not pan');
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

check('the page turn animates like a leaf going over', () => {
  const code = $read('src/pdf/pdf-pane.js');
  assert.ok(/beginLiveTurn/.test(code) && /rotateY/.test(code), 'it turns, rather than sliding');
  assert.ok(/transformOrigin = next \? 'left center' : 'right center'/.test(code),
    'and pivots on the spine it is moving away from');
  assert.ok(/prefers-reduced-motion/.test(code), 'skipped when motion is not wanted');
  // The snapshot has to be taken before the page changes and played after.
  assert.ok(/beginLiveTurn\(direction\)[\s\S]{0,200}endLiveTurn\(true\)/.test(code),
    'the sheet that turns away must be the page that was there');
  const css = $read('src/styles/pdf.css');
  assert.ok(/\.pdf-pane-viewport \{ perspective:/.test(css),
    'perspective belongs to the page being turned over, not to the leaf');
  assert.ok(/\.pdf-page-strip \{[\s\S]*?backface-visibility: hidden/.test(css));
});

// ═══════════════════════════════════════════════════════════════
group('4b. The sheet follows the hand');

/** A pane with just enough of itself to carry a sheet. */
function turnablePane({ page = 5, pages = 10 } = {}) {
  const dom = new JSDOM('<!doctype html><div class="vp"><div class="holder"><canvas></canvas></div></div>');
  const doc = dom.window.document;
  const vp = doc.querySelector('.vp');
  const holder = doc.querySelector('.holder');
  const canvas = doc.querySelector('canvas');
  canvas.width = 40; canvas.height = 60;
  canvas.getContext = () => ({ drawImage() {} });
  for (const el of [vp, holder]) {
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 400 });
    el.animate = () => ({ addEventListener() {}, cancel() {} });
  }
  doc.createElement('canvas').getContext = () => ({ drawImage() {} });
  const origCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'canvas') el.getContext = () => ({ drawImage() {} });
    return el;
  };

  const pane = Object.create(PdfPane.prototype);
  pane.elViewport = vp;
  pane.elHolder = holder;
  pane.page = page;
  pane.canGoNext = () => pane.page < pages;
  pane.canGoPrevious = () => pane.page > 1;
  pane.next = () => { pane.page += 1; };
  pane.previous = () => { pane.page -= 1; };
  pane._viewport = () => ({ width: 300, height: 400 });

  const prevDoc = global.document; const prevWin = global.window;
  global.document = doc;
  global.window = dom.window;
  dom.window.matchMedia = () => ({ matches: false });
  return { pane, vp, doc, restore: () => { global.document = prevDoc; global.window = prevWin; } };
}

check('the page under the sheet changes the moment it lifts, not when it lands', () => {
  const t = turnablePane({ page: 5 });
  try {
    assert.equal(t.pane.beginLiveTurn('next'), true);
    assert.equal(t.pane.page, 6,
      'the destination has to be rendering underneath, or the gap at the spine shows the page being left');
    assert.equal(t.vp.querySelectorAll('.pdf-page-leaf').length, 1, 'and a sheet is over it');
  } finally { t.restore(); }
});

check('the sheet sits wherever the finger left it', () => {
  const t = turnablePane();
  try {
    t.pane.beginLiveTurn('next');
    const leaf = t.vp.querySelector('.pdf-page-leaf');
    const firstStrip = () => t.vp.querySelector('.pdf-page-strip').style.transform;
    t.pane.dragLiveTurn(0.25);
    const quarter = firstStrip();
    t.pane.dragLiveTurn(0.75);
    assert.notEqual(firstStrip(), quarter, 'it tracks, rather than playing');
    assert.ok(/rotateY\(-[\d.]/.test(firstStrip()), 'a forward turn goes over to the left');
    assert.ok(Number(leaf.querySelector('.pdf-page-leaf-shade').style.opacity) > 0,
      'and it is shaded along the fold while it is edge-on');
  } finally { t.restore(); }
});

check('the sheet bends: no two strips are at the same angle mid-turn', () => {
  const t = turnablePane();
  try {
    t.pane.beginLiveTurn('next');
    t.pane.dragLiveTurn(0.5);
    const strips = [...t.vp.querySelectorAll('.pdf-page-strip')];
    assert.ok(strips.length > 1, 'the sheet is cut into strips so it can curve');
    const angles = strips.map((el) => parseFloat((el.style.transform.match(/-?[\d.]+/) || [0])[0]));
    const spread = Math.max(...angles) - Math.min(...angles);
    assert.ok(spread > 1, `strips must differ to make a curve, got a spread of ${spread}`);
  } finally { t.restore(); }
});

check('it is flat when the page is down and flat again when it lands', () => {
  const t = turnablePane();
  try {
    t.pane.beginLiveTurn('next');
    const strips = () => [...t.vp.querySelectorAll('.pdf-page-strip')]
      .map((el) => parseFloat((el.style.transform.match(/-?[\d.]+/) || [0])[0]));
    const spread = (a) => Math.max(...a) - Math.min(...a);
    t.pane.dragLiveTurn(0.02);
    const early = spread(strips());
    t.pane.dragLiveTurn(0.5);
    const mid = spread(strips());
    t.pane.dragLiveTurn(0.99);
    const late = spread(strips());
    assert.ok(mid > early && mid > late,
      `the curl belongs in the middle of the turn: ${early} / ${mid} / ${late}`);
  } finally { t.restore(); }
});

check('the sheet lifts and leans rather than swinging on a hinge', () => {
  const t = turnablePane();
  try {
    t.pane.beginLiveTurn('next');
    t.pane.dragLiveTurn(0.5);
    const tf = t.vp.querySelector('.pdf-page-leaf').style.transform;
    assert.ok(/translateZ\([\d.]+px\)/.test(tf), 'it comes up out of the gutter');
    assert.ok(/rotateX\(-?[\d.]+deg\)/.test(tf) && /rotateZ\(-?[\d.]+deg\)/.test(tf),
      'and tips and twists as it goes');
  } finally { t.restore(); }
});

check('the strips are shaded by how far each has turned away', () => {
  const t = turnablePane();
  try {
    t.pane.beginLiveTurn('next');
    t.pane.dragLiveTurn(0.45);
    const shades = [...t.vp.querySelectorAll('.pdf-page-strip-shade')]
      .map((el) => Number(el.style.opacity));
    assert.ok(shades.some((o) => o > 0), 'a curve has to be lit to read as one');
    assert.ok(new Set(shades).size > 1, 'and lit unevenly, or it is a flat board again');
  } finally { t.restore(); }
});

check('a drag beyond the ends of the book picks nothing up', () => {
  const first = turnablePane({ page: 1 });
  try { assert.equal(first.pane.beginLiveTurn('prev'), false); } finally { first.restore(); }
  const last = turnablePane({ page: 10, pages: 10 });
  try { assert.equal(last.pane.beginLiveTurn('next'), false); } finally { last.restore(); }
});

check('letting go short of halfway puts the page back', () => {
  const t = turnablePane({ page: 5 });
  try {
    t.pane.beginLiveTurn('next');
    t.pane.dragLiveTurn(0.2);
    t.pane.endLiveTurn(false);
    assert.equal(t.pane.page, 5, 'an abandoned turn leaves the reader where they were');
  } finally { t.restore(); }
});

check('letting go past halfway keeps it', () => {
  const t = turnablePane({ page: 5 });
  try {
    t.pane.beginLiveTurn('next');
    t.pane.dragLiveTurn(0.8);
    t.pane.endLiveTurn(true);
    assert.equal(t.pane.page, 6);
  } finally { t.restore(); }
});

check('the reader is never left looking at a photograph of the old page', () => {
  const t = turnablePane({ page: 5 });
  try {
    t.pane.beginLiveTurn('next');
    t.pane.dragLiveTurn(0.5);
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

check('the pen still never turns a page', () => {
  const src = $code('src/pdf/pdf-pane.js');
  assert.ok(/pointerType === 'pen'\) return;/.test(src),
    'ink belongs to the pen; the page must not move under a stroke');
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

check('changing the active pane refits the bar, with no resize to ride on', () => {
  const src = $code('src/pdf/pdf-workspace.js');
  const body = src.slice(src.indexOf('_markActive(slot) {'));
  assert.ok(/_syncToolbarSize/.test(body.slice(0, 400)),
    'activation must refit, or the bar keeps the size the other pane earned it');
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

check('the library row is wired to it, and looks pressable', () => {
  const code = $read('src/pdf/pdf-workspace-ui.js');
  assert.ok(code.includes("onDoubleTap(row, openDoc, { ignore: '.pdf-library-actions' })"));
  assert.ok(/openingId === doc\.id/.test(code), 'a second activation mid-open is ignored');
  const css = $read('src/styles/pdf.css');
  const rule = css.match(/\.pdf-library-row\s*\{[^}]*cursor:\s*pointer[^}]*\}/);
  assert.ok(rule, 'a row that opens has to look like it can be pressed');
  assert.ok(/user-select:\s*none/.test(rule[0]), 'or the second tap selects the name instead');
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

check('the app tells the person holding it what it is licensed under', () => {
  const html = $read('index.html');
  assert.ok(/AGPL-3\.0/.test(html), 'AGPL-3.0 obliges the build to say so where it can be read');
  assert.ok(/LaTeXSnipper_mobile/.test(html), 'and to credit the work it derives from');
  assert.ok(/Math-answer-to-question-matching-model/.test(html), 'and the engine it vendors');
});

check('the version in the notice comes from the build, not a literal', () => {
  const js = $code('src/settings/settings.js');
  assert.ok(/__APP_VERSION__/.test(js),
    'a notice that names the wrong version is worse than one that names none');
  assert.ok(/aboutVersion/.test($read('index.html')));
});

check('the notices file no longer credits what was deleted', () => {
  const md = $read('THIRD_PARTY_NOTICES.md');
  const sections = md.split('\n').filter((l) => l.startsWith('## '));
  assert.ok(!sections.some((l) => /llama\.cpp|ONNX/i.test(l)),
    'crediting a dependency the build does not have is its own kind of wrong');
  assert.ok(/LaTeXSnipper Mobile base/.test(md), 'the base project is still credited');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
