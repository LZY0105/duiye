#!/usr/bin/env node
// Learning a broken font's substitution table by watching OCR read a page.
//
// The property under test is PRECISION, not coverage. A missing entry leaves a
// character garbled, which the reader can see; a wrong entry silently replaces
// it with a plausible different character on every page it appears, which the
// reader cannot. So every test here asks "did it learn anything false?" before
// it asks "did it learn enough?", and the deliberately hostile inputs — spans
// that do not line up, OCR that substitutes rather than drops, text with no
// anchors at all — are the point rather than the edge cases.

import assert from 'node:assert/strict';

import {
  createGlyphLearner,
  createGlyphRepair,
  learnGlyphTable,
  repairCoverage,
} from '../src/pdf/glyph-map.js';

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Glyph map recovery');
console.log('═══════════════════════════════════════════════════════════════');

/** A page of maths prose: Chinese wording, Latin/digit mathematics. */
const REAL_PAGES = [
  '1.1 求函数 y = x^2 + 3x 的导数，并说明理由。答案：2x + 3',
  '1.2 计算定积分 A = 4 + 7，说明收敛的条件。答案：11',
  '1.3 证明函数 f(x) = 5x 在区间上连续，写出完整过程。答案：连续',
  '1.4 设数列 a(n) = 2n + 1，求它的极限与上界。答案：无界',
  '1.5 求方程 3x + 9 = 0 的根，并验证结果的正确性。答案：x = -3',
];

/** A deterministic "broken font": every Han character to a fixed odd glyph. */
function makeCipher(pages) {
  const alphabet = [...new Set(pages.join('').split('')
    .filter(ch => /[一-鿿，。：；？！（）、]/.test(ch)))];
  const truth = new Map();       // garbled -> real
  const forward = new Map();     // real -> garbled
  alphabet.forEach((real, i) => {
    const garbled = String.fromCharCode(0x0980 + i);   // Bengali block, as in life
    truth.set(garbled, real);
    forward.set(real, garbled);
  });
  const corrupt = (text) => [...text].map(ch => forward.get(ch) ?? ch).join('');
  return { truth, corrupt };
}

const { truth, corrupt } = makeCipher(REAL_PAGES);

/** OCR that drops and/or misreads characters. */
function noisyOcr(text, seed, { del = 0, sub = 0 } = {}) {
  let out = '';
  let r = seed;
  for (const ch of text) {
    r = (r * 1103515245 + 12345) & 0x7fffffff;
    const roll = r % 100;
    if (roll < del) continue;
    if (roll < del + sub && /[一-鿿]/.test(ch)) {
      out += String.fromCharCode(0x4E00 + ((r >> 7) % 500));
      continue;
    }
    out += ch;
  }
  return out;
}

const wrongEntries = (table) => [...table].filter(([k, v]) => truth.get(k) !== v);

// ═══════════════════════════════════════════════════════════════
group('1. Recovering the table');

check('a clean page pair yields correct substitutions', () => {
  const page = REAL_PAGES[0];
  const { table } = learnGlyphTable(corrupt(page), page);
  assert.ok(table.size > 0, 'nothing was learned at all');
  assert.deepEqual(wrongEntries(table), [], 'every entry must be correct');
  // The mathematics anchors the alignment; the prose is what gets learned.
  const repaired = createGlyphRepair(table)(corrupt(page));
  assert.equal(repaired, page, 'a page it learned from must decode exactly');
});

check('pooling pages decodes text from a page never seen', () => {
  const learner = createGlyphLearner({ minVotes: 1, minAgreement: 0.6 });
  for (let i = 0; i < 4; i++) learner.observe(corrupt(REAL_PAGES[i]), REAL_PAGES[i]);
  const table = learner.table();
  assert.deepEqual(wrongEntries(table), []);

  const unseen = REAL_PAGES[4];
  const before = repairCoverage([{ page: 1, text: corrupt(unseen) }], new Map());
  const after = repairCoverage([{ page: 1, text: corrupt(unseen) }], table);
  assert.equal(before.coverage, 0);
  assert.ok(after.coverage > 0.5,
    `a table from other pages should decode most of an unseen one, got ${after.coverage}`);
});

check('the mathematics is never touched, because it was never broken', () => {
  const page = REAL_PAGES[0];
  const { table } = learnGlyphTable(corrupt(page), page);
  for (const [garbled, real] of table) {
    assert.ok(!/[0-9A-Za-z+\-=^]/.test(garbled), `learned an anchor as broken: ${garbled}`);
    assert.ok(/[一-鿿　-〿＀-￯]/.test(real),
      `learned an implausible target: ${real}`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('2. Refusing to learn what it cannot see clearly');

check('a span whose two sides disagree in length is discarded', () => {
  // OCR dropped a character between two anchors. Which side lost it is
  // unknowable from here, so pairing off-by-one would learn shifted nonsense.
  const learner = createGlyphLearner({ minVotes: 1, minAgreement: 0.5, minAnchors: 2 });
  const c = '1 ঀঁং 2 ঃ঄ 3';
  const o = '1 甲乙丙 2 丁 3';           // second span: 2 characters vs 1
  learner.observe(c, o);
  const table = learner.table();
  assert.equal(table.get('ঀ'), '甲', 'the span that DID line up is still learned');
  assert.equal(table.has('ঃ'), false, 'the mismatched span must be skipped');
  assert.ok(learner.progress().spansSkipped > 0);
});

check('a target that is not a real character is rejected', () => {
  const learner = createGlyphLearner({ minVotes: 1, minAgreement: 0.5, minAnchors: 2 });
  // OCR emitted Cyrillic where the text layer had a broken glyph — the
  // alignment slipped; the font does not map there.
  learner.observe('1 ঀ 2', '1 Ж 2');
  assert.equal(learner.table().size, 0);
  assert.ok(learner.progress().rejected > 0);
});

check('text with too few anchors is not guessed at', () => {
  const learner = createGlyphLearner();
  learner.observe('ঀঁংঃ', '甲乙丙丁');
  assert.equal(learner.table().size, 0,
    'with nothing to pin the sequences together, order is an assumption');
});

check('one mismatched page cannot reach the vote threshold on its own', () => {
  // Pairing page 1's text layer with page 4's OCR output produces plausible
  // alignments on the shared digits, and everything learned from them is wrong.
  // The defaults survive it only because a single page cannot supply three
  // votes — NOT because the mispairing is detected.
  const learner = createGlyphLearner();
  learner.observe(corrupt(REAL_PAGES[0]), REAL_PAGES[3]);
  assert.equal(learner.table().size, 0);

  // Stated plainly, because it is a real limitation and not a covered case:
  // feeding the SAME wrong pairing repeatedly does get believed. Nothing here
  // can tell that the caller handed it the wrong page.
  const fooled = createGlyphLearner({ minAnchors: 2 });
  for (let i = 0; i < 4; i++) fooled.observe(corrupt(REAL_PAGES[0]), REAL_PAGES[3]);
  assert.ok(fooled.table().size >= 0,
    'the caller owns page correspondence; the learner cannot verify it');
});

// ═══════════════════════════════════════════════════════════════
group('3. Precision under a realistic recogniser');

check('substitution noise does not produce wrong entries at the defaults', () => {
  // Deletions are caught by the span-length check. Substitutions preserve
  // length and slip past it, which is what the vote thresholds are for.
  const learner = createGlyphLearner();          // minVotes 3, agreement 0.8
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < REAL_PAGES.length; i++) {
      const page = REAL_PAGES[i];
      learner.observe(corrupt(page), noisyOcr(page, (round * 31 + i) * 7919, { del: 4, sub: 10 }));
    }
  }
  const table = learner.table();
  assert.ok(table.size > 0, 'it should still learn something');
  assert.deepEqual(wrongEntries(table), [],
    'a wrong entry corrupts every page its glyph appears on');
});

check('one vote is not enough — a rare glyph misread once is believed', () => {
  // The failure mode the vote threshold exists for, made deterministic: a glyph
  // that appears ONCE in everything the learner sees, which OCR misread. On a
  // real book most of the 600-glyph alphabet is rare like this, which is why
  // the measured sweep (see src/glyph-map.js) shows single-vote learning
  // admitting 14-29 wrong entries where the defaults admit none.
  const rare = 'ঀ';
  const misread = '错';
  const corruptLine = `1 ${rare} 2 x = 3`;
  const ocrLine = `1 ${misread} 2 x = 3`;

  const loose = createGlyphLearner({ minVotes: 1, minAgreement: 0.5, minAnchors: 2 });
  loose.observe(corruptLine, ocrLine);
  assert.equal(loose.table().get(rare), misread,
    'a single sighting is taken as fact, and it is wrong');

  const strict = createGlyphLearner({ minAnchors: 2 });   // shipped defaults
  strict.observe(corruptLine, ocrLine);
  assert.equal(strict.table().has(rare), false,
    'the shipped defaults wait for corroboration');
});

check('the defaults hold precision under sustained substitution noise', () => {
  const learner = createGlyphLearner();
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < REAL_PAGES.length; i++) {
      const page = REAL_PAGES[i];
      learner.observe(corrupt(page), noisyOcr(page, (round * 31 + i) * 7919, { del: 2, sub: 25 }));
    }
  }
  assert.ok(learner.table().size > 0, 'it should still learn something');
  assert.deepEqual(wrongEntries(learner.table()), []);
});

check('split evidence is refused rather than settled by a majority of two', () => {
  const learner = createGlyphLearner({ minVotes: 2, minAgreement: 0.8, minAnchors: 2 });
  // The same glyph read as two different characters, near-evenly.
  for (let i = 0; i < 3; i++) learner.observe('1 ঀ 2', '1 甲 2');
  for (let i = 0; i < 3; i++) learner.observe('1 ঀ 2', '1 乙 2');
  assert.equal(learner.table().has('ঀ'), false,
    'a coin-flip entry is worse than no entry');
  assert.equal(learner.evidenceFor('ঀ').length, 2, 'but the evidence is kept');
});

// ═══════════════════════════════════════════════════════════════
group('4. Knowing when to stop OCRing');

check('coverage reports what is fixed and what to chase next', () => {
  const learner = createGlyphLearner({ minVotes: 1, minAgreement: 0.6 });
  learner.observe(corrupt(REAL_PAGES[0]), REAL_PAGES[0]);
  const lines = REAL_PAGES.map((t, i) => ({ page: i + 1, text: corrupt(t) }));

  const partial = repairCoverage(lines, learner.table());
  assert.ok(partial.coverage > 0 && partial.coverage < 1, 'one page is a partial table');
  assert.ok(partial.missing.length > 0, 'and it names what is still missing');

  for (const page of REAL_PAGES) learner.observe(corrupt(page), page);
  const full = repairCoverage(lines, learner.table());
  assert.ok(full.coverage > partial.coverage, 'more pages must mean more coverage');
});

check('progress separates what is seen from what is believed', () => {
  const learner = createGlyphLearner();          // needs 3 votes
  learner.observe(corrupt(REAL_PAGES[0]), REAL_PAGES[0]);
  const p = learner.progress();
  assert.ok(p.glyphsSeen > 0);
  assert.equal(p.glyphsConfident, 0, 'one sighting is not yet belief');
  assert.equal(p.glyphsPending, p.glyphsSeen, 'and pending says another page would help');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
