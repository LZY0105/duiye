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
  // The reference offers a row of object types: 手写 / 图片 / 文本框 / 图形.
  // This app has no images and no text boxes, so two of those four toggles
  // could only ever have one answer.
  //
  // 形状 is now a TOOL — it draws strokes into the same layer as the pen, and
  // it is chosen from the same column as the pen. That is not the same thing
  // as an object-type row, which asks "which kind of thing am I selecting?"
  // before anything has been drawn. So the check is against the row, not
  // against the word: a comment that happens to mention 图形 is not a toggle.
  const code = $read('src/ink/ink-toolbar.js');
  for (const dead of ['图片', '文本框']) {
    assert.ok(!code.includes(dead), `${dead} cannot be selected in this app`);
  }
  assert.ok(!/data-object|objectType|对象类型/.test(code), 'no object-type selector');
  assert.ok(/tool: SHAPE_TOOL/.test(code), '形状 is a tool, in the same column as the pen');
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

check('抓住指针那一步失败，也不能把后面的步骤一起跳掉', () => {
  // setPointerCapture 会在拿不到这个指针时抛异常。它裸着写的时候，后面所有语句
  // 都被跳过——拖动照跑，但状态没建起来。所以它必须在 try 里。
  //
  // 这条原来盯的是「起点宽度要记在 capture 之前」。那份起点宽度已经没有了：
  // 预览改成对着屏幕上那张位图定价（pdf-pane.js 的 previewFitAt），起点宽度不
  // 再参与计算。但「capture 允许失败」这条约束还在，就留这一半。
  const code = $code('src/pdf/pdf-workspace.js');
  const down = code.slice(code.indexOf("elDivider.addEventListener('pointerdown'"));
  assert.ok(/try \{ this\.elDivider\.setPointerCapture/.test(down),
    'the claim itself is allowed to fail');
  assert.ok(!/_dragBaseWidth/.test(code),
    '起点宽度不该再有人记——留着只会让人以为它还参与计算');
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
  // 名字带前括号就够了：animateToRatio 后来多了一个「要不要那块百分比牌子」的
  // 参数，把整个签名写死在这里，等于每加一个参数就假报一次失败。
  for (const fn of ['animateToRatio(targetRatio', 'animateToFocus(slot)']) {
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
  const at = code.indexOf('_previewPaneFits() {');
  const body = code.slice(at, at + 900);
  assert.ok(/fitMode === FIT_MODES\.NONE\) \{\s*pane\.reposition\?\.\(\);/.test(body),
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

check('预览按屏幕上那张位图定价，不按拖动起点', () => {
  // 这是整件事的不变量：previewScale 乘的是**已渲染的位图**，所以唯一说得通的
  // 分母是那张位图自己的 zoom。
  //
  // 原来算的是「起点宽对应的 zoom → 此刻宽对应的 zoom」。那个基准只在整段拖动
  // 一次真渲染都不落地时才成立，而它会落地：_showCanvas 换掉位图并把
  // _previewScale 归 1，下一帧又拿相对起点的比值去乘新位图——同一次缩放乘两遍，
  // 每多渲染一次再乘一遍。
  //
  // 真机上量到的：一栏 889px 拖到 238px，页面边缘碰到栏边缘（栏 407px）之前正常，
  // 之后页面缩得比栏还快——栏 302px 时页宽 235px，栏 238px 时只剩 147px。
  const pane = $code('src/pdf/pdf-pane.js');
  const at = pane.indexOf('previewFitAt() {');
  assert.ok(at > -1, 'pane 提供 previewFitAt');
  const body = pane.slice(at, at + 420);
  assert.ok(/this\._previewScale = target \/ rendered;/.test(body),
    '分母必须是位图的 zoom');
  assert.ok(/const rendered = this\._renderedZoom;/.test(body),
    '而 _renderedZoom 就是「这张位图代表哪个 zoom」');

  // 工作区只负责挑栏，不负责算比值——两处都调同一个方法，左右两边就不会算出
  // 两个不同的答案。
  const ws = $code('src/pdf/pdf-workspace.js');
  assert.equal((ws.match(/pane\.previewFitAt\(\)/g) || []).length, 1,
    '定价只有一处');
  assert.equal((ws.match(/this\._previewPaneFits\(\)/g) || []).length, 2,
    '拖动与动画两条路都走它');
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
  // 纸的规则都在 paper.css（原来在 ink-toolbar.css 末尾）。
  const css = $read('src/styles/paper.css');
  const docked = css.slice(css.indexOf('html[data-skin="minimal"] .ink-toolbar.is-docked,'));
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
      t.pane.dragLiveTurn({ x: dir === 'next' ? 140 : 160, y: 200 });
      const leaf = t.vp.querySelector('.pdf-page-leaf');
      assert.equal(leaf.querySelectorAll('canvas').length, 1, dir + ': the only printing is the page itself');
      const back = leaf.querySelector('.pdf-fold-back');
      assert.ok(back && back.children.length === 0, dir + ': the folded-over part is a blank sheet');
      assert.equal(leaf.querySelector('.pdf-fold-crease').style.opacity, '1',
        dir + ': the crease is a hairline, so the fold has an edge');
    } finally { t.restore(); }
  }
});

check('a backward turn folds in a blank back, not the page being left', () => {
  const t = turnablePane({ page: 5 });
  try {
    t.pane.beginLiveTurn('prev', { x: 10, y: 200 });
    t.pane.dragLiveTurn({ x: 160, y: 200 });
    const leaf = t.vp.querySelector('.pdf-page-leaf');
    const back = leaf.querySelector('.pdf-fold-back');
    assert.ok(back.style.background, 'the arriving sheet still has a paper-coloured back');
    assert.equal(back.querySelectorAll('canvas').length, 0, 'the fold carries no borrowed printing');
  } finally { t.restore(); }
});

check('the flap is the page reflected in the crease, not a copy slid sideways', () => {
  const t = turnablePane({ w: 300, h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 200 });
    // A level pull from a mid-height anchor: the crease is vertical, so the
    // reflection is a plain horizontal mirror — a = -1, d = 1.
    t.pane.dragLiveTurn({ x: 100, y: 200 });
    const m = t.pane._live.fold.reflect;
    assert.ok(Math.abs(m[0] + 1) < 1e-6, `expected a horizontal mirror, got a=${m[0]}`);
    assert.ok(Math.abs(m[3] - 1) < 1e-6, `expected d=1, got ${m[3]}`);
    assert.ok(Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6, 'and no shear');
    const back = t.vp.querySelector('.pdf-fold-back');
    assert.match(back.style.transform, /^matrix\(/, 'the blank back is carried over by that reflection');
  } finally { t.restore(); }
});

check('a diagonal pull from a corner gives a diagonal crease', () => {
  const t = turnablePane({ w: 300, h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 380 });
    t.pane.dragLiveTurn({ x: 120, y: 150 });
    const m = t.pane._live.fold.reflect;
    assert.ok(Math.abs(m[1]) > 1e-3,
      'a crease that is not vertical must shear the reflection');
  } finally { t.restore(); }
});

check('while the hand moves only transforms change: the page is photographed once', () => {
  // 原来每一帧在一张 canvas 上把整页重画一遍，平板上三分之一的帧掉到 60fps。
  const t = turnablePane({ w: 300, h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 200 });
    const draws = () => t.ctx.calls.filter((c) => c[0] === 'drawImage').length;
    const before = draws();
    for (const x of [260, 220, 180, 140, 100]) t.pane.dragLiveTurn({ x, y: 210 });
    assert.equal(draws(), before, 'nothing is redrawn while the sheet follows the hand');
    const half = t.vp.querySelector('.pdf-fold-half');
    const photo = t.vp.querySelector('.pdf-fold-photo');
    assert.match(half.style.transform, /^matrix\(/);
    assert.match(photo.style.transform, /^matrix\(/);
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
  assert.ok(/beginLiveTurn\(direction, \{\s*x: swipe\.x, y: swipe\.y, from: \{ x: e\.clientX, y: e\.clientY \},?\s*\}\)/.test(src),
    'the grab point, not the current point, picks the corner — and the current point is where the sheet starts following');
});

// 人说「应该有一边是固定的」，又说清楚了：从右往左翻（下一页）固定左边，从左往右翻（上一页）
// 固定右边。原来斜着拉一个角、或者松手以后自己翻完的那一段，折痕会斜着扫过固定的那一边。
check('the sheet starts following from where the turn was decided: nothing jumps', () => {
  const t = turnablePane({ w: 300, h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 150, y: 200, from: { x: 122, y: 200 } });
    t.pane.dragLiveTurn({ x: 122, y: 200 });
    assert.deepEqual(t.pane._live.point, { x: 300, y: 200 }, 'still flat where the turn began');
    t.pane.dragLiveTurn({ x: 72, y: 200 });
    assert.deepEqual(t.pane._live.point, { x: 250, y: 200 }, 'fifty pixels on, the edge is fifty pixels in');
  } finally { t.restore(); }
});

check('going forward the left edge never folds, however the corner is dragged', () => {
  const t = turnablePane({ w: 300, h: 400 });
  try {
    t.pane.beginLiveTurn('next', { x: 290, y: 380 });      // the bottom corner
    const a = t.pane._live.anchor;
    for (const [x, y] of [[-400, 380], [-600, -300], [-200, 50], [100, -500]]) {
      t.pane.dragLiveTurn({ x, y });
      const p = t.pane._live.point;
      for (const q of [{ x: 0, y: 0 }, { x: 0, y: 400 }]) {
        assert.ok(Math.hypot(p.x - q.x, p.y - q.y) <= Math.hypot(a.x - q.x, a.y - q.y) + 1e-6,
          'dragged to (' + x + ', ' + y + '): the crease would cross the left edge at y=' + q.y);
      }
    }
  } finally { t.restore(); }
});

check('going back the right edge is the fixed one', () => {
  const t = turnablePane({ w: 300, h: 400 });
  try {
    t.pane.beginLiveTurn('prev', { x: 10, y: 20 });        // the top corner of the left edge
    const a = t.pane._live.anchor;
    t.pane.dragLiveTurn({ x: 900, y: 500 });
    const p = t.pane._live.point;
    for (const q of [{ x: 300, y: 0 }, { x: 300, y: 400 }]) {
      assert.ok(Math.hypot(p.x - q.x, p.y - q.y) <= Math.hypot(a.x - q.x, a.y - q.y) + 1e-6,
        'the crease would cross the right edge at y=' + q.y);
    }
  } finally { t.restore(); }
});

check('letting go is decided by the throw first, then by how far it went', () => {
  const src = $code('src/pdf/pdf-pane.js');
  const end = src.slice(src.indexOf('const endTouch'), src.indexOf('const endPointer'));
  assert.ok(/releaseCommits\(live\.direction, live\.progress,\s*pointVelocity\(live\.samples, clock\(\)\)\.vx, TURN_COMMIT\)/.test(end),
    'a flick back cancels even a turn most of the way over; a flick on turns one barely started');
});

check('finishing the turn lands the fold on the fixed edge, not past it', () => {
  const src = $code('src/pdf/pdf-pane.js');
  const end = src.slice(src.indexOf('  endLiveTurn(commit) {'), src.indexOf('get isTurning'));
  assert.ok(/turnedPoint\(anchor, spine\)/.test(end), 'the target is the anchor mirrored in the fixed edge');
  assert.ok(!/live\.w \* 2\.1/.test(end), 'not two page-widths off the far side at the height the hand left it');
  assert.ok(/stepFold\(state, to, dt, anchor, spine, live\.h\)/.test(end),
    'and every frame on the way there stays inside the constraint');
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
  // 只有展开着的横杠才算大小——收成球、拖在手里的时候量到的是那颗球，见 _applyFit。
  bar.state = { edge: 'left', phase: 'expanded' };
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


/**
 * 一条长度随缩放变、但两头有一截不变的横杠——真的那条就是这样：内边距、分隔线、
 * 描边都是写死的像素。
 */
function realisticBar({ fixed = 32, scaled = 551, edge = 'left', phase = 'expanded', hostWidth = 1190 } = {}) {
  const bar = Object.create(InkToolbar.prototype);
  const props = new Map();
  const length = () => fixed + scaled * Number(props.get('--ink-scale') ?? 1);
  const vertical = edge === 'left' || edge === 'right';
  bar.root = {
    style: { setProperty: (k, v) => props.set(k, v) },
    get offsetHeight() { return vertical ? length() : 44; },
    get offsetWidth() { return vertical ? 46 : length(); },
  };
  bar.cardLayer = { style: { setProperty: () => {} } };
  bar.host = { clientWidth: hostWidth };
  bar.state = { edge, phase };
  bar._scale = 1;
  bar._safe = { top: 0, bottom: 0 };
  bar._clampIntoHost = () => {};
  bar.scale = () => Number(props.get('--ink-scale') ?? 1);
  bar.length = length;
  return bar;
}

check('the same inputs give the same size, however many times it is asked', () => {
  // 真机上报的：收起来再展开，换个工具，工具栏大小变了、跳一下。原来的算法是
  // 「量出来的长度 ÷ 当前缩放」，可两头那一截不跟着缩，每算一次都偏一点——
  // 工作区在每一次换工具之后都会再问一遍，于是每换一次工具它就再缩一点。
  const bar = realisticBar();
  bar.fitTo({ height: 560, column: 2000 });
  const first = bar.scale();
  assert.ok(first < 1, 'it must give ground');
  for (let i = 0; i < 5; i++) bar.fitTo({ height: 560, column: 2000 });
  assert.equal(bar.scale(), first, '问多少遍都是同一个答案');
  assert.ok(bar.length() <= 560 - 24 + 0.5, `and it actually fits: ${bar.length()}`);
});

check('a folded-away bar is not measured — the puck is not the bar', () => {
  // 收成球的时候量到的是那颗球。原来那一下把缩放放回了 1，展开之后横杠按满尺
  // 寸画出来，下一次换工具再量又缩回去——人看到的就是它跳了一下。
  for (const phase of ['docked', 'dragging']) {
    const bar = realisticBar({ phase });
    bar._scale = 0.84;
    bar.fitTo({ height: 560, column: 2000 });
    assert.equal(bar._scale, 0.84, `${phase}: the size it had stays the size it has`);
  }
});

check('a bar lying along the bottom is budgeted by the width, not the height', () => {
  // 贴底边的那一条是横着的。原来一律拿长度和高度比：菜单栏一升起来，可用高度
  // 少了 86px，它就被缩了一圈——而它只该往上让，不该变短。
  const bar = realisticBar({ edge: 'bottom', hostWidth: 1190 });
  bar._safe = { top: 92, bottom: 86 };
  bar.fitTo({ height: 670, column: 2000 });
  assert.equal(bar.scale(), 1, 'the menu bar rising makes it move, not shrink');

  // 520 宽：缩到 0.84 左右，还在 0.72 那条下限之上（再窄就停在下限，见下一组）。
  const narrow = realisticBar({ edge: 'bottom', hostWidth: 520 });
  narrow.fitTo({ height: 900, column: 2000 });
  assert.ok(narrow.scale() < 1, 'a workspace narrower than the bar still makes it give ground');
  assert.ok(narrow.length() <= 520 - 24 + 0.5, `and it fits the width: ${narrow.length()}`);
});

check('where the bar is, for layout decisions, ignores the animation it is playing', () => {
  // 刚展开、刚落边的头几百毫秒，横杠是从球的位置、按球的大小飞过来的。拿那一帧
  // 去判「底下的菜单栏挡没挡住它」，判的是那颗球。
  const host = {
    getBoundingClientRect: () => ({ left: 5, top: 64, width: 1190, height: 670 }),
    clientLeft: 0,
    clientTop: 0,
  };
  const bar = Object.create(InkToolbar.prototype);
  bar.host = host;
  bar.state = { phase: 'expanded', edge: 'left' };
  bar.root = {
    offsetParent: host,
    offsetLeft: 10,
    offsetTop: 403,
    offsetWidth: 46,
    offsetHeight: 517,
    // 这一帧还是那颗球。
    getBoundingClientRect: () => ({ left: 1140, top: 690, width: 58, height: 58 }),
  };
  const r = bar.rect();
  assert.equal(r.left, 15);
  assert.equal(r.width, 46);
  assert.equal(r.top, 64 + 403 - 517 / 2, 'the resting position: centred on its offset, not mid-flight');
  assert.equal(r.bottom - r.top, 517);

  bar.state = { phase: 'expanded', edge: 'bottom' };
  bar.root.offsetLeft = 600;
  bar.root.offsetWidth = 495;
  bar.root.offsetHeight = 44;
  const h = bar.rect();
  assert.equal(h.left, 5 + 600 - 495 / 2, 'a horizontal bar is centred on its left offset');
});
// The acceptance run on the tablet found the bar sized against the wrong pane:
// it floated over a 312px column while the 856px one was active, and kept the
// size the wide pane had earned it.
function workspaceOver(barLeft, barWidth, { swapped = false, active = SLOTS.PRIMARY } = {}) {
  const ws = Object.create(PdfWorkspace.prototype);
  ws.activeSlot = active;
  ws.state = { swapped };
  // 问的是 rect()——横杠停稳之后在哪儿，不是这一帧画在哪儿（刚展开时它还在从球的位置飞过来）。
  ws.toolbar = { rect: () => ({ left: barLeft, width: barWidth }) };
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

check('the Agent button steps aside for a toolbar on the right edge', () => {
  // 那颗按钮钉在右边正中，工具栏贴右边时也在那儿——按钮压在它中间两格上，层级
  // 还更高，那两格就点不到了。
  const props = new Map();
  const layer = { style: { setProperty: (k, v) => props.set(k, v) } };
  const rect = { left: 5, top: 64, right: 1195, bottom: 734, width: 1190, height: 670 };
  const ws = Object.create(PdfWorkspace.prototype);
  ws.root = { querySelector: (sel) => (sel === '.pdf-agent-layer' ? layer : null) };
  const place = (state, bar) => {
    ws.toolbar = { state, rect: () => bar };
    ws._syncAgentFab(rect);
    return props.get('--agent-fab-right');
  };
  const tall = { left: 1139, right: 1185, top: 150, bottom: 667, width: 46, height: 517 };

  assert.equal(place({ phase: 'expanded', edge: 'right' }, tall), `${1195 - 1139 + 8}px`,
    'it moves to the left of the bar, 8px clear');
  assert.equal(place({ phase: 'expanded', edge: 'left' }, { ...tall, left: 15, right: 61 }), '14px',
    'a bar on the other side leaves it where it lives');
  assert.equal(place({ phase: 'docked', edge: 'right' }, { left: 1127, right: 1185, top: 666, bottom: 724, width: 58, height: 58 }), '14px',
    'a puck in the corner is nowhere near it');
  assert.equal(place({ phase: 'expanded', edge: 'right' }, { ...tall, top: 80, bottom: 300, height: 220 }), '14px',
    'a short bar parked high on the edge does not reach the middle');
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

check('底边再没有东西压着工作区：工具栏的安全区底边是 0', () => {
  // 原来底下有一条 fixed 的悬浮菜单栏压在工作区上，菜单栏一升起来，贴底边的工具
  // 栏就被顶上去（还得判横向相不相交，免得靠边的工具栏被白顶一截）。它挪到了顶上
  // 那一排的正中，在工作区外面——底边再没有东西要让。
  const ws = Object.create(PdfWorkspace.prototype);
  ws.elSlots = { [SLOTS.PRIMARY]: null, [SLOTS.SECONDARY]: null };
  const host = { left: 0, right: 1200, top: 64, bottom: 736, width: 1200, height: 672 };
  for (const bar of [{ left: 10, right: 63 }, { left: 400, right: 460 }, { left: 300, right: 900 }]) {
    ws.toolbar = { rect: () => bar };
    assert.equal(ws._toolbarSafeArea(host).bottom, 0, `工具栏在 ${bar.left}–${bar.right}`);
  }
});

check('安全区不再去量底栏', () => {
  const src = $code('src/pdf/pdf-workspace.js');
  const fn = src.slice(src.indexOf('_toolbarSafeArea(rect) {'));
  const body = fn.slice(0, fn.indexOf('syncToolbarSafeArea()'));
  assert.ok(!/bottom-nav|app-nav/.test(body), '顶上那两个标签在工作区外面，不是工具栏要让的东西');
  assert.ok(/return \{ top, bottom: 0 \}/.test(body));
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

check('牌子挂在栏头底下、横着居中，白色、小一号（原来是页面正中一大块深色的，压在字上）', () => {
  // 人说「那个页面之间显示百分比的提示调去文件菜单栏下面，变成白色，再缩小一点」。
  document.body.innerHTML =
    '<div class="pdf-ws-slot"><div class="pdf-slot-pane" hidden></div>'
    + '<div class="pdf-slot-pane"></div><div data-role="zoom-badge"></div></div>';
  const el = document.querySelector('.pdf-ws-slot');
  const [hiddenPane, livePane] = el.querySelectorAll('.pdf-slot-pane');
  Object.defineProperty(hiddenPane, 'offsetTop', { get: () => 20 });
  Object.defineProperty(livePane, 'offsetTop', { get: () => 78 });
  const ws = Object.create(PdfWorkspace.prototype);
  ws.elSlots = { [SLOTS.PRIMARY]: el };
  const badge = el.querySelector('[data-role="zoom-badge"]');
  ws._flashZoom(SLOTS.PRIMARY, 100, 'e1');
  ws._flashZoom(SLOTS.PRIMARY, 122, 'e1');
  assert.equal(badge.style.top, '86px', '露着的那一块内容（栏头底下）的上沿往下 8px');

  const css = $read('src/styles/pdf.css');
  const at = css.indexOf('.pdf-zoom-badge {');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.ok(!/top:\s*50%/.test(rule), '不在页面正中');
  assert.ok(/background: rgba\(255, 255, 255, 0\.9\d\);/.test(rule), '白色');
  assert.ok(/font-size: 12px;/.test(rule) && /padding: 3px 10px;/.test(rule), '小一号');
  assert.ok(!/backdrop-filter/.test(rule), '压在正文上，不磨砂');
  const vis = css.slice(css.indexOf('.pdf-zoom-badge.is-visible {'));
  assert.ok(/transform: translate\(-50%, 0\) scale\(1\);/.test(vis.slice(0, 120)), '按上沿挂，不按中心');
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

// ── the top row, put away and brought back ──────────────────────────────────

group('12. Hiding the top row, and getting it back');

/**
 * The page as initChromeHiding finds it, with the row where it really sits.
 *
 * JSDOM has no layout, so every box is 0x0 and every hit test would miss. The
 * rectangles are stated instead — the tablet's, 1200x736.
 *
 * 两个标签（练习 / 设置）在那一排的正中：原来它们是底边一枚能单独收起来的胶囊，
 * 挪上来之后跟着那一排走，底边整条还给了纸。
 */
function chromePage({ topHidden = false, page = null, opts = {} } = {}) {
  document.body.className = '';
  delete document.body.dataset.page;
  if (page) document.body.dataset.page = page;
  // initChromeHiding restores what was hidden last time, and localStorage is
  // one object for the whole run — without this a scenario starts wherever the
  // previous one left the row, and a check on where it ended up is really a
  // check on what ran before it.
  try { localStorage.clear(); } catch (_) { /* not available */ }
  document.body.innerHTML = [
    '<nav class="app-nav">',
    '  <button class="active" data-page="pdf"><svg></svg><span>练习</span></button>',
    '  <button data-page="settings"><svg></svg><span>设置</span></button>',
    '</nav>',
    '<div class="page" id="page-pdf">',
    '  <div class="pdf-page-bar"></div>',
    // 一栏：栏头（按钮、页码框）、切换条、书页。那一排收起来以后，它们就在屏幕顶上那一截里。
    '  <div class="pdf-workspace-host"><div class="pdf-workspace"><div class="pdf-ws-slot">',
    '    <div class="pdf-slot-toolbar"><button class="pdf-slot-btn">适合宽度</button><input class="pdf-slot-page"></div>',
    '    <div class="deck-strip"><button class="deck-title">草稿纸 01</button></div>',
    '    <div class="pdf-pane-viewport"><canvas class="pdf-ink-canvas"></canvas></div>',
    '  </div></div></div>',
    '</div>',
  ].join('\n');

  const root = document.getElementById('page-pdf');
  const q = (sel) => document.querySelector(sel);
  const box = (el, r) => { el.getBoundingClientRect = () => ({
    left: r[0], top: r[1], right: r[2], bottom: r[3],
    width: r[2] - r[0], height: r[3] - r[1], x: r[0], y: r[1],
  }); };

  box(q('.pdf-page-bar'), topHidden ? [10, -88, 1190, -44] : [10, 10, 1190, 54]);
  box(q('.app-nav'), topHidden ? [514, -88, 686, -44] : [514, 10, 686, 54]);
  box(q('[data-page="pdf"]'), [518, 14, 599, 50]);
  box(q('[data-page="settings"]'), [601, 14, 682, 50]);

  if (topHidden) document.body.classList.add('is-top-hidden');
  // The last scenario's listeners come off first. Left on, they would handle
  // every gesture twice — which is exactly the fault initChromeHiding's
  // teardown exists to prevent in the app, so the tests would be papering over
  // the thing they are meant to catch.
  chromeOff?.();
  chromeOff = initChromeHiding(root, opts);
  return root;
}
let chromeOff = null;

/**
 * A finger going down at (x,y), travelling `dy`, and lifting.
 *
 * `on` is what it comes down on, which is half of what the handler decides
 * from: a press on a tab and a press on the glass beside it are the same
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

const tab = (page) => document.querySelector(`[data-page="${page}"]`);

const hidden = () => document.body.classList.contains('is-top-hidden');

check('dragging the import row up puts it away', () => {
  chromePage();
  swipe(200, 30, -60);
  assert.ok(hidden(), 'a deliberate upward drag on the row is how it goes');
});

check('改排版之前先说一声（beforeChromeMove）：收起传 true、拉回传 false，说的那一刻那一排还是原来的样子', () => {
  const seen = [];
  chromePage({ opts: {
    beforeChromeMove: (h) => seen.push(['before', h, hidden()]),
    onChromeMove: () => seen.push(['moved', hidden()]),
  } });
  swipe(200, 30, -60);
  assert.deepEqual(seen, [['before', true, false], ['moved', true]]);
  seen.length = 0;
  swipe(600, 30, 80);
  assert.deepEqual(seen, [['before', false, true], ['moved', false]]);
});

check('dragging down from the top brings the import row back', () => {
  chromePage({ topHidden: true });
  swipe(600, 30, 80);
  assert.ok(!hidden(), 'the top edge is what catches this');
});

check('the row comes back from a press anywhere along the top edge', () => {
  for (const x of [40, 600, 1100]) {
    chromePage({ topHidden: true });
    swipe(x, 30, 80);
    assert.ok(!hidden(), 'a press at x=' + x + ' should reach it too');
  }
});

check('a drag that changes its mind leaves the row where it was', () => {
  chromePage();
  const fire = (type, y) => document.dispatchEvent(new window.PointerEvent(type, {
    clientX: 300, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true,
    bubbles: true, cancelable: true,
  }));
  fire('pointerdown', 30);
  for (const y of [22, 14, 8, 16, 24, 30]) fire('pointermove', y);
  fire('pointerup', 30);
  assert.ok(!hidden(), 'pulled a little way and put back is not putting it away');
});

check('a wandering tap on the row is not a drag', () => {
  chromePage();
  swipe(300, 30, -9, { steps: 3 });
  assert.ok(!hidden(), 'a finger resting on the glass moves a few pixels before it lifts — that is a press');
});

check('a sideways swipe along the row is not a drag either', () => {
  chromePage();
  const fire = (type, x, y) => document.dispatchEvent(new window.PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true,
    bubbles: true, cancelable: true,
  }));
  fire('pointerdown', 200, 40);
  for (let i = 1; i <= 8; i++) fire('pointermove', 200 + i * 25, 40 - i * 2);
  fire('pointerup', 400, 24);
  assert.ok(!hidden(), 'a thumb sliding along the row is not reaching for it');
});

// ── 两个标签：在那一排的正中，跟着它走 ────────────────────────────────────────

check('按在一个标签上竖着往上拉，收起的是整排；那一下点击被吞掉，不会顺手换页', () => {
  // 原来按在任何按钮上都不算：胶囊里全是按钮，能按住往上拉的只剩胶囊之间那几像素
  // 空白，人说「向上收起判定太严」。现在看方向：竖着走的归收起。
  chromePage();
  let pressed = 0;
  tab('settings').addEventListener('click', () => { pressed++; });
  swipe(640, 30, -60, { on: tab('settings').querySelector('span') });
  assert.ok(hidden(), '标签上竖着拉，也是在拉那一排');
  tab('settings').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 0, '拉完那一下点击被吞掉');
});

check('按在标签上先横着走过门槛，就归标签（划着挑），后面怎么拐都不算收起', () => {
  chromePage();
  const fire = (type, x, y) => tab('pdf').dispatchEvent(new window.PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true,
    bubbles: true, cancelable: true,
  }));
  fire('pointerdown', 560, 30);
  fire('pointermove', 572, 29);
  for (let i = 1; i <= 8; i++) fire('pointermove', 572 + i * 4, 29 - i * 8);
  fire('pointerup', 604, -35);
  assert.ok(!hidden());
});

check('按在两个标签之间那几像素玻璃上往上拉，收起的是整排', () => {
  // 那枚胶囊不在横杠的盒子里（它 fixed 在页面外），可看上去它就是这一排的一部分。
  chromePage();
  swipe(600, 12, -60, { on: document.querySelector('.app-nav') });
  assert.ok(hidden());
});

check('拉完那一下点击，不会顺手换了页', () => {
  chromePage();
  let pressed = 0;
  tab('settings').addEventListener('click', () => { pressed++; });
  swipe(300, 40, -60);
  assert.ok(hidden(), '那一排收起来了');
  tab('settings').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 0, 'the click the drag ends on is swallowed, once');
  tab('settings').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 1, 'and the tap after it is not');
});

check('设置页上没有那一排：按顶上、往下拉，什么都不动', () => {
  // 设置页上两个标签一直在，那里没有可以拉的横杠。原来顶边那 96px 在哪一页都会
  // 接这一下。
  chromePage({ topHidden: true, page: 'settings' });
  swipe(600, 30, 80);
  assert.ok(hidden(), '收起的状态是练习页的，设置页上不该有人去改它');
});

check('底边整条是纸：往上划、往下拉，什么都不收、什么都不叫回', () => {
  // 原来底边正中有一根叫回菜单栏的把手，它上面还有一条 76px 的抓取带，笔写到那
  // 里就变成了拉菜单栏。
  for (const pointerType of ['touch', 'pen']) {
    chromePage();
    swipe(600, 640, 70, { pointerType });
    assert.ok(!hidden(), `${pointerType}：往下拉`);
    chromePage();
    swipe(600, 700, -70, { pointerType });
    assert.ok(!hidden(), `${pointerType}：往上划`);
    swipe(600, 662, 0, { steps: 1, pointerType });
    assert.ok(!hidden(), `${pointerType}：点一下`);
  }
});

check('底部菜单栏那一整套都拆干净了', () => {
  const html = $read('index.html');
  assert.ok(!/dock-peek|bottom-nav/.test(html), '标记里没有底栏，也没有叫回它的把手');
  assert.ok(/<nav class="app-nav">/.test(html));
  assert.ok(html.indexOf('<nav class="app-nav">') < html.indexOf('<div id="app">'),
    '标签在页面前面：读屏和键盘先走到它');
  const ui = $read('src/pdf/pdf-workspace-ui.js');
  assert.ok(!/is-bottom-hidden|is-bottom-moving|dockGrip|dockSummonBox|onInkBar/.test(ui),
    '收起底栏的手势一条不剩');
  const css = ['src/styles/pdf.css', 'src/styles/base.css', 'src/styles/liquid.css',
    'src/styles/material.css', 'src/styles/mobile.css', 'src/styles/deck.css'].map($read).join('\n');
  assert.ok(!/\.bottom-nav|\.dock-peek|is-bottom-hidden|--bottom-drag|--dock-peek-lift/.test(css),
    '样式表里也一条不剩');
  assert.ok(!/_syncDockPeek|dock-peek/.test($read('src/pdf/pdf-workspace.js')));
});

check('上一版记下的「底栏收着」被清掉，不会留成一条读不到的记录', () => {
  try { localStorage.setItem('ls_chrome_bottom', '1'); } catch (_) { return; }
  chromeOff?.();
  chromeOff = initChromeHiding(document.getElementById('page-pdf'));
  assert.equal(localStorage.getItem('ls_chrome_bottom'), null);
});

check('两个标签跟着那一排收起来——只在练习页上', () => {
  const css = $read('src/styles/pdf.css');
  assert.ok(/body\[data-page="pdf"\] \.app-nav \{ --drag: var\(--top-drag, 0\); \}/.test(css),
    '练习页上跟着那一排的进度走');
  assert.ok(/body\[data-page="pdf"\]\.is-top-hidden \.app-nav \{ pointer-events: none; \}/.test(css),
    '收起来之后点不到');
  const nav = css.slice(css.indexOf('.app-nav {'), css.indexOf('.app-nav button {'));
  assert.ok(/--drag: 0;/.test(nav), '别的页上它不动：设置页上收起来就回不去了');
  assert.ok(/position: fixed;/.test(nav) && /margin-inline: auto;/.test(nav), '顶上正中');
  assert.ok(/top: calc\(var\(--app-bar-top\)/.test(nav), '和那一排同一个上沿');
});

check('那一排给两个标签留了正中那一格，两边等宽', () => {
  const css = $read('src/styles/pdf.css');
  assert.ok(/grid-template-columns: minmax\(0, 1fr\) var\(--app-nav-w\) minmax\(0, 1fr\);/.test(css),
    '两边按剩下的宽度平分（不按内容撑），正中才是真的正中');
  const html = $read('index.html');
  const bar = html.slice(html.indexOf('<div class="pdf-page-bar">'));
  assert.ok(bar.indexOf('pdf-bar-nav-slot') > 0
    && bar.indexOf('pdf-bar-nav-slot') < bar.indexOf('data-role="close-all"'),
    '空位在左边那枚胶囊和「全部关闭」之间');
});

check('收起的时候，横杠占的地方一起还回去', () => {
  // 液态玻璃皮肤原来把横杠的上边距写死了（margin: 6px 12px），盖掉了按收起进度
  // 算的那条算式：横杠滑走了，它占的那一截却还空着。
  const css = $read('src/styles/pdf.css');
  // 那一排不在文档流里，它让出来的那一截是工作区自己的上边距；收起时这一截变成 --app-bar-gap。
  assert.ok(/#page-pdf > \.pdf-workspace-host \{\s*margin-top: calc\(var\(--app-bar-top\) \+ var\(--pdf-bar-h\) \+ var\(--app-bar-gap\)\);/.test(css));
  assert.ok(/body\.is-top-hidden #page-pdf > \.pdf-workspace-host \{\s*margin-top: var\(--app-bar-gap\);/.test(css));
  const barAt = css.search(/\.pdf-page-bar \{\s*--drag/);
  const barBody = css.slice(barAt, css.indexOf('}', barAt));
  assert.ok(/position: absolute;/.test(barBody), '那一排只靠 transform 进出，不碰排版');
  assert.ok(!/transition:[^;]*margin/.test(barBody), '边距不过渡：每一帧改工作区的高度就是掉帧的根');
  assert.ok(/transform 0\.32s/.test(barBody) && /opacity 0\.26s/.test(barBody));
  const laterAt = css.search(/\.pdf-page-bar \{\s*column-gap/);
  assert.ok(!/transition:/.test(css.slice(laterAt, css.indexOf('}', laterAt))),
    '后面那条不能再写 transition，写了就把上面那条盖掉');
  const liquidRule = css.slice(css.indexOf('[data-skin="liquid-math"] .pdf-page-bar {'));
  const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  const body = noComments(liquidRule.slice(0, liquidRule.indexOf('}')));
  assert.ok(!/margin:\s/.test(body) && !/margin-top/.test(body), `pdf.css 里的液态玻璃规则：${body}`);
  const liquid = $read('src/styles/liquid.css');
  const own = liquid.slice(liquid.indexOf('html[data-skin="liquid-math"] .pdf-page-bar {'));
  const ownBody = noComments(own.slice(0, own.indexOf('}')));
  assert.ok(!/margin:\s/.test(ownBody) && !/margin-top/.test(ownBody), `liquid.css：${ownBody}`);
});

check('the gesture is the only way, and there is no button left to press', () => {
  // The chevron in the corner did the same job as the swipe, floated over the
  // page it was making room for, and was the one control on this screen that
  // was not about reading. Removing it means the swipe has to be right — which
  // is what the rest of this group is for.
  const root = chromePage({ topHidden: true });
  assert.equal(root.querySelector('[data-role="chrome-toggle"]'), null,
    'no button in the markup');
  assert.ok(!/chrome-toggle/.test($read('index.html')), 'nor in the page');
  assert.ok(!/pdf-chrome-toggle/.test($read('src/styles/pdf.css')), 'nor in the stylesheet');
  assert.ok(!/chrome-toggle|syncToggle/.test($read('src/pdf/pdf-workspace-ui.js')),
    'and nothing left listening for it');

  swipe(600, 40, 70);
  assert.ok(!hidden(), 'the top edge brings the row back');
});

check('no strip covers the pane headers once the row is away (收起后栏头不是禁用区)', () => {
  // 原来是一条盖在屏幕顶上的透明条（.bar-peek，64px、z-index 999）专门接往下拉。收起后两栏顶上去，
  // 栏头正好落在它底下，整排按钮点不动。
  const css = $read('src/styles/pdf.css').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/bar-peek/.test($read('index.html')), 'no strip in the page');
  assert.ok(!/bar-peek/.test(css), 'nor in the stylesheet');
  assert.ok(!/bar-peek|barPeek/.test($read('src/pdf/pdf-workspace-ui.js')), 'nor anything asking where it is');
  // 竖着的拖动不交给 WebView：写在栏头和它里面每一个元素上（栏头自己会横着滚，滚动容器的子元素会
  // 被重新放开上下拖动），不写在整页、整栏上（里面有会上下滚的列表）。
  assert.ok(/body\.is-top-hidden \.pdf-slot-toolbar,\nbody\.is-top-hidden \.pdf-slot-toolbar \* \{ touch-action: pan-x; \}/.test(css));
  assert.ok(!/is-top-hidden (#page-pdf|\.pdf-ws-slot|\.pdf-workspace)[^{]*\{[^}]*touch-action/.test(css),
    'the page and the pane keep their own touch-action: the lists in them still scroll');
});

check('a tap on a pane header button lands while the row is away; a pull down from it brings the row back', () => {
  chromePage({ topHidden: true });
  const btn = document.querySelector('.pdf-slot-toolbar .pdf-slot-btn');
  let pressed = 0;
  btn.addEventListener('click', () => { pressed++; });
  // 一下点：按下、手指晃了几像素、抬起，浏览器补一下点击。
  swipe(530, 30, 4, { on: btn, steps: 2 });
  btn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 1, 'the tap reaches the button');
  assert.ok(hidden(), 'and a tap does not bring the row back');
  // 从同一颗按钮往下拉：那一排回来，拉完补来的那一下点击吞掉，按钮不被顺手按下。
  swipe(530, 30, 70, { on: btn });
  assert.ok(!hidden(), 'pulling down from the header brings the row back');
  btn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 1, 'the click the pull ends in is swallowed');
  btn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 2, 'and the tap after it is not');
});

check('a sideways drag on the header is neither a pull nor a press', () => {
  chromePage({ topHidden: true });
  const fire = (type, x, y, target) => target.dispatchEvent(new window.PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
  }));
  const btn = document.querySelector('.pdf-slot-btn');
  fire('pointerdown', 530, 30, btn);
  fire('pointermove', 560, 36, btn);
  fire('pointermove', 600, 40, btn);
  fire('pointerup', 600, 40, btn);
  assert.ok(hidden());
});

check('the switching strip, the page and the page-number box keep their own gestures up there', () => {
  // 切换条上下划是换这一摞里的上一本 / 下一本；书页上是拖着走、写字；页码框里是打字。它们都在收起后
  // 屏幕顶上那一截里，从它们上面往下划不许顺手把那一排也拉下来。
  const places = [
    ['.deck-strip .deck-title', 530, 70],
    ['.pdf-pane-viewport', 530, 90],
    ['.pdf-ink-canvas', 300, 90],
    ['.pdf-slot-page', 620, 30],
  ];
  for (const [sel, x, y] of places) {
    chromePage({ topHidden: true });
    swipe(x, y, 70, { on: document.querySelector(sel) });
    assert.ok(hidden(), `a drag down from ${sel} is its own, not a pull on the row`);
  }
});

check('the bare edge beside the header: the WebView takes the drag after a few pixels, and a start downward still brings the row back', () => {
  const fire = (type, x, y, target) => target.dispatchEvent(new window.PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
  }));
  const slot = () => document.querySelector('.pdf-ws-slot');
  // 往下走了 6px，WebView 把手势收走（pointercancel 带的坐标是 0，不作数）：放那一排下来。
  chromePage({ topHidden: true });
  fire('pointerdown', 100, 20, slot());
  fire('pointermove', 101, 23, slot());
  fire('pointermove', 101, 26, slot());
  fire('pointercancel', 0, 0, slot());
  assert.ok(!hidden(), 'a pull that the WebView took away still counts');
  // 平板上（WebView 138）实测的那一串：+6、+11 两下 pointermove（第二下已经过了 10px 的门槛，那一排
  // 跟上了手），然后才 pointercancel。一样放下来，不退回去。
  chromePage({ topHidden: true });
  fire('pointerdown', 1160, 35, slot());
  fire('pointermove', 1160, 41, slot());
  fire('pointermove', 1160, 46, slot());
  fire('pointercancel', 0, 0, slot());
  assert.ok(!hidden(), 'taken away after it had already started to follow: still a pull');
  // 横着走的、几乎没走的：不算。
  for (const [dx, dy] of [[9, 3], [1, 2], [0, -6]]) {
    chromePage({ topHidden: true });
    fire('pointerdown', 100, 20, slot());
    fire('pointermove', 100 + dx, 20 + dy, slot());
    fire('pointercancel', 0, 0, slot());
    assert.ok(hidden(), `a cancel after (${dx}, ${dy}) is not a pull`);
  }
  // 那一排露着的时候，被收走的手势什么都不做。
  chromePage();
  fire('pointerdown', 100, 30, document);
  fire('pointermove', 100, 36, document);
  fire('pointercancel', 0, 0, document);
  assert.ok(!hidden());
});

check('a tap on an import button is a tap; an upward drag from it puts the row away', () => {
  chromePage();
  const btn = document.createElement('button');
  btn.textContent = '导入练习册';
  document.querySelector('.pdf-page-bar').appendChild(btn);
  let pressed = 0;
  btn.addEventListener('click', () => { pressed++; });
  swipe(120, 30, -6, { on: btn, steps: 2 });
  btn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.ok(!hidden(), 'a finger resting on a button wanders a little — that is still a press');
  assert.equal(pressed, 1, 'and the press goes through');
  swipe(120, 30, -60, { on: btn });
  assert.ok(hidden(), 'a real upward drag is reaching for the row, wherever it starts');
});

check('the toolbar and an open menu are not the row: dragging on them leaves it alone', () => {
  chromePage();
  const tb = document.createElement('div');
  tb.className = 'ink-toolbar';
  const menu = document.createElement('div');
  menu.className = 'pdf-bar-menu';
  document.querySelector('.pdf-page-bar').append(tb, menu);
  swipe(700, 30, -60, { on: tb });
  assert.ok(!hidden(), 'the toolbar has its own drag');
  swipe(200, 30, -60, { on: menu });
  assert.ok(!hidden(), 'a list is for choosing from');
});

await checkAsync('the row is marked as moving while it travels, and only while', async () => {
  chromePage();
  const during = [];
  const watch = () => during.push(document.body.classList.contains('is-top-moving'));
  document.addEventListener('pointermove', watch);
  swipe(300, 40, -60);
  document.removeEventListener('pointermove', watch);
  assert.ok(during.slice(-1)[0], 'it is marked from the moment it starts travelling');
  assert.ok(document.body.classList.contains('is-top-moving'),
    'and still on its way when the finger lets go');
  await wait(500);
  assert.ok(!document.body.classList.contains('is-top-moving'),
    'once it has arrived the buttons come back');
});

check('a row in motion has nothing on it that can be pressed', () => {
  const css = $read('src/styles/pdf.css');
  assert.ok(/body\.is-top-moving \.app-nav > button/.test(css),
    'a tab arriving under a thumb must not register as a press');
  assert.ok(/body\.is-top-moving \.pdf-page-bar button/.test(css), 'nor a button on the row');
  const moving = css.slice(css.indexOf('body.is-top-moving'));
  assert.ok(!/^body\.is-top-moving \.app-nav\s*\{/m.test(moving),
    'the capsule itself keeps its events — it has to answer the finger carrying it');
});

check('building the workspace twice does not handle every gesture twice', () => {
  chromePage();
  // A second set of listeners, left on, would arm two swallows per drag — and
  // the second one eats the user's next real tap. This is the fault behind
  // buttons that work, then do not, then do.
  const off = initChromeHiding(document.getElementById('page-pdf'));
  let pressed = 0;
  tab('pdf').addEventListener('click', () => { pressed++; });
  off();
  swipe(300, 40, -60);
  tab('pdf').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 0, 'the drag it ends on is still swallowed once');
  tab('pdf').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(pressed, 1, 'and the tap after it is not');
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

// ═══════════════════════════════════════════════════════════════
// 「导入」下拉单子
//
// 横杠上原来并排两颗「导入练习册 / 导入答案册」，现在收成一颗「导入」点开一张
// 单子。会静默坏掉的是关闭那三条路：少一条就会留下一张关不掉的单子盖在页面上。

const importHtml = $read('index.html');
const importUi = $read('src/pdf/pdf-workspace-ui.js');
// 切到「导入」那张单子本身为止，不是切到底下某个碰巧在后面的东西。
//
// 原来的下界是 data-role="file-exercise"，中间隔着整条横杠。横杠上多出第二
// 张下拉单子（组合）的那一天，这几条「单子里有两项」当场数成了四项——断言没
// 错，是切片切得太松。
const importMenuHtml = importHtml.slice(
  importHtml.indexOf('data-role="import-menu"'),
  importHtml.indexOf('data-role="open-library"'));

ok(
  new RegExp('data-role="import-open"[\\s\\S]{0,200}?aria-haspopup="menu"').test(importHtml),
  '横杠上是一颗会展开单子的「导入」',
);
ok(
  (importMenuHtml.match(/class="pdf-bar-menu-item"/g) || []).length === 2,
  '单子里两项：练习册和答案册',
);
ok(
  new RegExp('data-role="import-menu"[^>]*role="menu"[^>]*hidden').test(importHtml),
  '单子默认收着，且报出 role=menu',
);
ok(
  (importMenuHtml.match(/class="pdf-bar-menu-icon"/g) || []).length === 2,
  '每一项带一枚图标 —— 两项都是「导入一份 PDF」，光靠文字要读完整行才分得清',
);
ok(
  !/stroke="#|fill="#/.test(importMenuHtml),
  '图标用 currentColor，不写死颜色 —— 它要跟着三套皮肤走',
);

// 关闭的三条路，少一条就会留下一张关不掉的单子。
ok(importUi.includes("e.key === 'Escape'"), '按 Escape 能关');
ok(
  importUi.includes("addEventListener('pointerdown'")
  && importUi.includes('host.contains(e.target)'),
  '点单子以外的地方能关（pointerdown 捕获，不是 click）',
);
// 横杠上两张单子共用同一个 bindBarMenu，所以这一条现在盯的是那一处。
//
// 原来写的是 indexOf('close();') < indexOf('pickAndImport(role)')。抽出公共实
// 现之后，菜单里已经没有 pickAndImport(role) 这个写法了，而这条断言还是绿
// 的——它匹配到的是几百行外一句毫不相干的 onImport 赋值。靠巧合过的断言比没
// 有断言更坏：它会在真正坏掉的那天继续绿着。
const barMenuBody = importUi.slice(
  importUi.indexOf('function bindBarMenu('),
  importUi.indexOf('function bindImportMenu('));
ok(
  barMenuBody.indexOf('close();') < barMenuBody.indexOf('run();'),
  '选完一项先关单子再做那件事 —— 反过来的话选完文件回来它还开着',
);

// 挑文件有两条路，但只有一套导入逻辑。
ok(
  importUi.includes('nativeFilesAvailable()')
  && importUi.includes('openDevicePdfPicker('),
  '平板上走应用内面板，浏览器里退回系统选择器',
);
ok(
  (importUi.match(/await handleImport\(/g) || []).length >= 1
  && importUi.includes('await handleImport([file], role)'),
  '——两条路在 handleImport 之前就合并了，往下只有一套导入逻辑',
);
ok(
  importUi.includes('if (focus) button.focus();'),
  '只有焦点还在单子里时才收回按钮 —— 人点别处时硬抢会夺走他刚点的东西',
);

// 空状态卡片上那两颗按钮是另一套（data-action），不能被这次改动波及。
ok(
  /data-action="import-exercise"/.test($read('src/pdf/pdf-workspace.js')),
  '空工作区那两颗导入按钮还在，走的是它们自己的 data-action',
);

// ═══════════════════════════════════════════════════════════════
// 本机 PDF 选择面板
//
// 「只导入 PDF」这件事现在是结构上成立的，不是靠一个筛选条件：数据源本身就只有
// PDF（MediaStore 按 MIME 查）。能静默坏掉的是权限那一段——没权限时如果只说「失
// 败」，人不知道该去哪儿开，而这个权限没有应用内弹窗。

const filesJs = $read('src/pdf/pdf-files.js');
const pickerJs = $read('src/pdf/pdf-picker.js');
const pluginJava = $read('android/app/src/main/java/io/github/lzy0105/duiye/files/PdfFilesPlugin.java');
const manifest = $read('android/app/src/main/AndroidManifest.xml');

ok(
  pluginJava.includes('MIME_TYPE') && pluginJava.includes('application/pdf'),
  '按 MIME 查，不是按文件名后缀 —— 没有 .pdf 后缀的 PDF 照样是 PDF',
);
ok(
  manifest.includes('android.permission.MANAGE_EXTERNAL_STORAGE'),
  '声明了「所有文件访问权限」—— 没有它只看得见自己创建的文件',
);
ok(
  $read('android/app/src/main/java/io/github/lzy0105/duiye/MainActivity.java')
    .includes('registerPlugin(PdfFilesPlugin.class)'),
  '插件在 super.onCreate 之前登记，否则网页那边找不到它',
);
ok(
  !/void delete|void write|void rename/.test(pluginJava),
  '插件只读：权限的粒度比用得着的粗，那不是顺手多做几件事的理由',
);
ok(
  pluginJava.includes('private static boolean hidden('),
  '点开头的目录滤掉 —— 那里面是缓存副本和解压残留，会让同一本书出现两次',
);

// 没有原生层时（浏览器、测试）要诚实地说没有，而不是抛一个谁也接不住的错。
ok(
  filesJs.includes('export function nativeFilesAvailable()')
  && /return !!plugin\(\)/.test(filesJs),
  '没有原生插件时如实回 false，调用方据此退回系统选择器',
);

// 权限那一段。
ok(
  pickerJs.includes("t('picker.needPermission')") && pickerJs.includes("t('picker.grant')"),
  '没权限时说的是「为什么要」和「去哪儿开」，不是一句「失败」',
);
ok(
  pickerJs.includes("addEventListener('visibilitychange'"),
  '从系统设置回来要重新问一次 —— 授权发生在别的应用里，这边收不到回调',
);
for (const lang of ['zh-CN', 'zh-TW', 'en']) {
  const src = $read(`src/core/lang/${lang}.js`);
  const missing = ['picker.title', 'picker.confirm', 'picker.search', 'picker.empty',
    'picker.needPermission', 'picker.grant', 'picker.count']
    .filter(k => !src.includes(`"${k}"`));
  ok(missing.length === 0, `${lang} 有全部面板文案`, missing.join(', '));
}

// 文件名来自本机文件系统，是别处写的名字。
ok(
  pickerJs.includes(".textContent = file.name"),
  '文件名走 textContent 不进 innerHTML',
);
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
