#!/usr/bin/env node
// Scratchpad style tests (F11).
//
// The rules that matter here are all about NOT losing things: a style change
// never touches ink, a pad with no style stays plain white rather than
// inheriting someone's later default, and a pattern this build has never heard
// of comes back unharmed instead of being quietly replaced.

import assert from 'node:assert/strict';

import {
  CONTRASTS,
  DEFAULT_STYLE,
  PATTERNS,
  SPACINGS,
  STYLE_SCHEMA_VERSION,
  TONES,
  axisColor,
  createScratchStyle,
  effectivePattern,
  guideColor,
  guideSpacing,
  hasGuides,
  isCellPattern,
  isKnownPattern,
  paperColor,
  sameStyle,
  serializeStyle,
} from '../src/scratch/scratch-style.js';

let PASS = 0, FAIL = 0;
function pass(l) { PASS++; console.log(`  ✅ ${l}`); }
function fail(l, d) { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); }
function group(n) { console.log(`\n─── [${n}] ───`); }
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Scratchpad Style Tests — eight patterns, one boundless surface');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. The first-release scope');

check('there are exactly eight patterns, P01 to P08', () => {
  const ids = Object.values(PATTERNS);
  assert.equal(ids.length, 8);
  assert.deepEqual(ids, ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08']);
  for (const id of ids) assert.equal(isKnownPattern(id), true);
});

check('there are four paper tones and no dark one', () => {
  assert.deepEqual(Object.values(TONES), ['white', 'ivory', 'grey', 'sage']);
  // Every tone is light. A chalkboard would swallow the near-black ink this
  // app writes with, which is why it is out of the first release.
  for (const tone of Object.values(TONES)) {
    const hex = paperColor({ paperTone: tone });
    const lightness = parseInt(hex.slice(1, 3), 16);
    assert.ok(lightness > 0xdd, `${tone} is light paper`);
  }
});

check('first use is plain on white, standard spacing, light guides', () => {
  assert.equal(DEFAULT_STYLE.patternId, PATTERNS.PLAIN);
  assert.equal(DEFAULT_STYLE.paperTone, TONES.WHITE);
  assert.equal(DEFAULT_STYLE.spacingPreset, SPACINGS.STANDARD);
  assert.equal(DEFAULT_STYLE.guideContrast, CONTRASTS.LIGHT);
  assert.equal(DEFAULT_STYLE.schemaVersion, STYLE_SCHEMA_VERSION);
});

check('plain has nothing to space or contrast, so both controls are hidden', () => {
  assert.equal(hasGuides(PATTERNS.PLAIN), false);
  for (const id of Object.values(PATTERNS)) {
    if (id !== PATTERNS.PLAIN) assert.equal(hasGuides(id), true, `${id} has guides`);
  }
});

check('the two handwriting grids are cell patterns, and nothing else is', () => {
  assert.equal(isCellPattern(PATTERNS.TIANZI), true);
  assert.equal(isCellPattern(PATTERNS.MIZI), true);
  assert.equal(isCellPattern(PATTERNS.SQUARE), false);
});

// ═══════════════════════════════════════════════════════════════
group('2. Spacing is in world units, not on screen');

check('line spacing steps 16 / 24 / 32 world units', () => {
  const at = (preset) => guideSpacing({ patternId: PATTERNS.SQUARE, spacingPreset: preset });
  assert.equal(at(SPACINGS.COMPACT), 16);
  assert.equal(at(SPACINGS.STANDARD), 24);
  assert.equal(at(SPACINGS.SPACIOUS), 32);
});

check('handwriting cells are outer boxes, at 48 / 64 / 80', () => {
  const at = (preset) => guideSpacing({ patternId: PATTERNS.TIANZI, spacingPreset: preset });
  assert.equal(at(SPACINGS.COMPACT), 48);
  assert.equal(at(SPACINGS.STANDARD), 64);
  assert.equal(at(SPACINGS.SPACIOUS), 80);
  // A 24-unit 田字格 is not a writing cell, it is graph paper with a cross in it.
  assert.ok(guideSpacing({ patternId: PATTERNS.MIZI, spacingPreset: SPACINGS.STANDARD })
    > guideSpacing({ patternId: PATTERNS.SQUARE, spacingPreset: SPACINGS.SPACIOUS }));
});

check('changing the pattern never changes the spacing family silently', () => {
  const style = { spacingPreset: SPACINGS.STANDARD };
  const square = guideSpacing({ ...style, patternId: PATTERNS.SQUARE });
  const tianzi = guideSpacing({ ...style, patternId: PATTERNS.TIANZI });
  assert.notEqual(square, tianzi, 'each pattern family has its own defaults');
});

// ═══════════════════════════════════════════════════════════════
group('3. Contrast');

check('guides get firmer through light, standard, clear', () => {
  const alpha = (c) => Number(/([\d.]+)\)$/.exec(guideColor({ guideContrast: c }))[1]);
  assert.ok(alpha(CONTRASTS.LIGHT) < alpha(CONTRASTS.STANDARD));
  assert.ok(alpha(CONTRASTS.STANDARD) < alpha(CONTRASTS.CLEAR));
  assert.ok(alpha(CONTRASTS.CLEAR) < 1, 'guides are never as solid as ink');
});

check('the level-of-detail fade thins a family without dropping it', () => {
  const full = Number(/([\d.]+)\)$/.exec(guideColor(DEFAULT_STYLE, 1))[1]);
  const faded = Number(/([\d.]+)\)$/.exec(guideColor(DEFAULT_STYLE, 0.35))[1]);
  assert.ok(faded < full && faded > 0, 'fading is continuous, so it cannot flicker');
  assert.equal(Number(/([\d.]+)\)$/.exec(guideColor(DEFAULT_STYLE, 0))[1]), 0);
});

check('axes are drawn firmer than the grid they cross', () => {
  const grid = Number(/([\d.]+)\)$/.exec(guideColor(DEFAULT_STYLE))[1]);
  const axis = Number(/([\d.]+)\)$/.exec(axisColor(DEFAULT_STYLE))[1]);
  assert.ok(axis > grid);
});

// ═══════════════════════════════════════════════════════════════
group('4. Never lose what was chosen');

check('a pad with no style is plain white, and not a later default', () => {
  const legacy = createScratchStyle(undefined);
  assert.equal(legacy.patternId, PATTERNS.PLAIN);
  assert.equal(legacy.paperTone, TONES.WHITE);
});

check('an unknown pattern is preserved and rendered as plain, with no rewrite', () => {
  const future = createScratchStyle({ patternId: 'P42', paperTone: TONES.SAGE });
  assert.equal(future.patternId, 'P42', 'the choice survives this build');
  assert.equal(isKnownPattern(future.patternId), false);
  assert.equal(effectivePattern(future), PATTERNS.PLAIN, 'and is safely drawn as plain');
  assert.equal(serializeStyle(future).patternId, 'P42',
    'a write must not overwrite it with a default');
  assert.equal(future.paperTone, TONES.SAGE, 'the rest of the style still applies');
});

check('nonsense in the other fields falls back without touching the pattern', () => {
  const s = createScratchStyle({
    patternId: PATTERNS.DOTS, paperTone: 'neon', spacingPreset: 'huge', guideContrast: 'loud',
  });
  assert.equal(s.patternId, PATTERNS.DOTS);
  assert.equal(s.paperTone, TONES.WHITE);
  assert.equal(s.spacingPreset, SPACINGS.STANDARD);
  assert.equal(s.guideContrast, CONTRASTS.LIGHT);
});

check('a style round-trips through storage unchanged', () => {
  const s = createScratchStyle({
    patternId: PATTERNS.MIZI,
    paperTone: TONES.IVORY,
    spacingPreset: SPACINGS.SPACIOUS,
    guideContrast: CONTRASTS.CLEAR,
  });
  assert.deepEqual(createScratchStyle(JSON.parse(JSON.stringify(serializeStyle(s)))), s);
});

check('reapplying the same values is recognised, so it is not a write', () => {
  const s = createScratchStyle({ patternId: PATTERNS.RULED, paperTone: TONES.GREY });
  assert.equal(sameStyle(s, { patternId: PATTERNS.RULED, paperTone: TONES.GREY }), true);
  assert.equal(sameStyle(s, { patternId: PATTERNS.RULED, paperTone: TONES.WHITE }), false);
  assert.equal(sameStyle(DEFAULT_STYLE, {}), true);
});

check('a style is only ever these five fields — never ink, never a camera', () => {
  const raw = serializeStyle(createScratchStyle({ patternId: PATTERNS.DOTS }));
  assert.deepEqual(Object.keys(raw).sort(),
    ['guideContrast', 'paperTone', 'patternId', 'schemaVersion', 'spacingPreset']);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
