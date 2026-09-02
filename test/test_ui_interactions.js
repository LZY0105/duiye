#!/usr/bin/env node
// UI details that only show up when something is driven, not inspected.
//
// Three things live here because each one is a behaviour a static read of the
// source cannot confirm: what the lasso actually paints, what the answer panel
// tells the reader to do next, and whether a row opens on a double-tap.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { LASSO_STROKE, createTransform, drawLasso } from '../src/ink/ink-renderer.js';
import {
  LASSO_MODES, LASSO_SHAPES, LASSO_TOOL,
  createToolbarState, serializeToolbarState, setLassoMode, setLassoShape,
} from '../src/ink/toolbar-state.js';
import { InkSurface } from '../src/ink/ink-surface.js';
import { renderAnswerNotice } from '../src/pdf/answer-panel.js';
import { onDoubleTap } from '../src/ui/double-tap.js';

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

check('the handle breathes with the zoom, and its hit target with it', () => {
  const surface = Object.create(InkSurface.prototype);
  const at = (scale) => {
    surface.transform = { scale, offsetX: 0, offsetY: 0 };
    return surface._handleRadius();
  };
  assert.equal(at(1), 9, 'at 100% it is the size it always was');
  assert.ok(at(2) > at(1), 'zooming in grows it — a frozen dot reads as unattached');
  assert.ok(at(0.5) < at(1), 'and zooming out shrinks it');
  assert.equal(at(9), 16, 'but never into a blob that hides the ink');
  assert.equal(at(0.05), 7, 'nor below something a stylus can land on');

  // The hit target is measured against the drawn size, so the two cannot part
  // company at some zoom the constant never knew about.
  const code = $read('src/ink/ink-surface.js');
  assert.ok(/this\._handleRadius\(\) \* 2\.4/.test(code));
  assert.ok(!/SELECT_HANDLE \* 2\.4/.test(code), 'the fixed hit radius is gone');
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
group('4. A double-tap opens the row');

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

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
