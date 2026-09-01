#!/usr/bin/env node
// Exercise-book ↔ answer-key matching.
//
// Two-stage: TOC alignment narrows the search, then content similarity plus the
// exercise number identifies the entry.
//
// The property under test throughout is that a WRONG answer is never shown
// confidently. Question numbers restart every chapter, so a number alone is
// ambiguous across a book; answer entries often restate little of the question,
// so content alone can be thin. The tests below check that each signal's
// weakness is covered by the other, and that genuine ambiguity is reported as
// ambiguity rather than resolved by guessing.

import assert from 'node:assert/strict';
import { PAIR_STATUS, RUNG } from "../src/pdf/decision.js";
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIDENCE,
  alignOutlines,
  alignSequences,
  answerRangeForPage,
  answerRangeForQuestion,
  contentSimilarity,
  extractMathFragments,
  matchPage,
  matchQuestion,
  normalizeForMatch,
  similarity,
} from '../src/pdf/question-matcher.js';
import {
  buildAnswerIndex,
  indexAnswerDocument,
  indexQuestionDocument,
  questionsOnPage,
} from '../src/pdf/answer-index.js';
import { positionalWindow, separateByPosition } from '../src/pdf/positional-prior.js';
import { symbolContexts, symbolContextSimilarity } from '../src/pdf/symbol-context.js';

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
async function checkAsync(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

const outline = (items) => ({ available: true, items });
const node = (title, pageNumber) => ({ title, pageNumber, depth: 0, children: [] });
const lines = (...items) => items.map(([page, text]) => ({ page, text }));

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Question ↔ Answer matching');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. Text similarity');

check('formatting differences do not change the content', () => {
  assert.equal(normalizeForMatch('求 f(x) = x² 的导数。'), normalizeForMatch('求f(x)=x²的导数'));
  assert.equal(similarity('解方程 2x + 1 = 5', '解方程2x+1=5'), 1);
});

check('related questions score high, unrelated ones low', () => {
  const related = similarity('求函数 y = x^2 + 3x 的导数', '求 y = x^2 + 3x 的导数');
  const unrelated = similarity('求函数 y = x^2 + 3x 的导数', '计算定积分 ∫sin(x)dx');
  assert.ok(related > 0.7, `related should be high, got ${related}`);
  assert.ok(unrelated < 0.3, `unrelated should be low, got ${unrelated}`);
  assert.ok(related > unrelated);
});

check('empty text never scores as a match', () => {
  assert.equal(similarity('', '求导数'), 0);
  assert.equal(similarity(null, undefined), 0);
});

// ═══════════════════════════════════════════════════════════════
group('1b. Mathematical content carries the signal');

check('math fragments are extracted whole, with their arrangement', () => {
  // Kept whole rather than split into symbols: "x^2+3x" and "x^3+5x" share
  // every individual symbol and differ only in how they are arranged.
  assert.deepEqual(extractMathFragments('求函数 y = x^2 + 3x 的导数'), ['y=x^2+3x']);
  assert.deepEqual(extractMathFragments('求导数'), [], 'pure prose has no fragments');
});

check('identical prose no longer masks different mathematics', () => {
  // A page of derivative exercises shares nearly all its wording, so a plain
  // whole-string similarity could not separate two different questions.
  const q = '求函数 y = x^2 + 3x 的导数';
  const right = '求函数 y = x^2 + 3x 的导数，答案：2x+3';
  const wrong = '求函数 y = x^3 + 5x 的导数，答案：3x^2+5';

  const plainMargin = similarity(q, right) - similarity(q, wrong);
  const weightedMargin = contentSimilarity(q, right) - contentSimilarity(q, wrong);

  assert.ok(weightedMargin > plainMargin,
    `weighting must widen the margin (${plainMargin.toFixed(3)} -> ${weightedMargin.toFixed(3)})`);
  assert.ok(weightedMargin > 0.15,
    'and must clear the threshold at which a match is treated as decisive');
});

check('prose still breaks a tie when the expression is identical', () => {
  // 求导数 vs 求积分 of the same function: the mathematics cannot separate
  // these, so the words must still count for something.
  const q = '求 y = x^2 的导数';
  const right = '求 y = x^2 的导数，答案：2x';
  const wrong = '求 y = x^2 的积分，答案：x^3/3';
  assert.ok(contentSimilarity(q, right) > contentSimilarity(q, wrong));
});

check('a question with no mathematics still compares sensibly', () => {
  // Degrades to plain similarity rather than scoring zero.
  const s = contentSimilarity('叙述罗尔定理', '叙述罗尔定理');
  assert.equal(s, 1);
});

check('duplicate numbers are now resolved by the mathematics', () => {
  const candidates = buildAnswerIndex(lines(
    [10, '5. 求函数 y = x^2 + 3x 的导数，答案：2x+3'],
    [80, '5. 求函数 y = x^3 + 5x 的导数，答案：3x^2+5'],
  )).entries;
  const m = matchQuestion({ label: '5', text: '求函数 y = x^2 + 3x 的导数' }, candidates);
  assert.equal(m.matched, true, 'the expression should now decide it');
  assert.ok(m.entry.answer.includes('2x+3'), 'must pick the x^2 question, not the x^3 one');
});

// ═══════════════════════════════════════════════════════════════
group('1c. Operator context — where the mathematics actually differs');

check('context windows anchor on operators and pad at the edges', () => {
  assert.deepEqual(symbolContexts(normalizeForMatch('x^2+3x')),
    ['··x^2+3', 'x^2+3x·']);
  assert.deepEqual(symbolContexts('a=b', 1), ['a=b']);
  assert.deepEqual(symbolContexts('求导数'), [], 'prose has no operators');
});

check('two expressions differing only around an operator share no context', () => {
  const a = symbolContexts(normalizeForMatch('x^2+3x'));
  const b = symbolContexts(normalizeForMatch('x^3+5x'));
  assert.equal(a.filter(t => b.includes(t)).length, 0,
    'a bigram bag shares x^, + and x here; the whole point is that these do not');
});

check('radius 3 beats the alternatives on near-identical questions', () => {
  // Identical prose; mathematics differing only in exponent, grouping or sign.
  const cases = [
    ['求函数 y = x^2 + 3x 的导数', '求函数 y = x^2 + 3x 的导数，答案：2x+3', '求函数 y = x^3 + 5x 的导数，答案：3x^2+5'],
    ['求 1/(x+1) 的导数', '求 1/(x+1) 的导数，答案：-1/(x+1)^2', '求 1/x+1 的导数，答案：-1/x^2'],
    ['求 (a-b)^2 的值', '求 (a-b)^2 的值，答案：a^2-2ab+b^2', '求 (a+b)^2 的值，答案：a^2+2ab+b^2'],
  ];
  const margin = (r) => Math.min(...cases.map(([q, right, wrong]) =>
    (symbolContextSimilarity(normalizeForMatch(q), normalizeForMatch(right), r) ?? 0)
    - (symbolContextSimilarity(normalizeForMatch(q), normalizeForMatch(wrong), r) ?? 0)));

  assert.ok(margin(3) > margin(1), 'a one-character window is too narrow to discriminate');
  assert.ok(margin(3) >= margin(6), 'a six-character window reaches into unrelated material');
  assert.ok(margin(3) >= 0.4, `worst-case margin at radius 3 was ${margin(3).toFixed(3)}`);
});

check('operator context widens the margin the whole engine depends on', () => {
  const q = '求函数 y = x^2 + 3x 的导数';
  const right = '求函数 y = x^2 + 3x 的导数，答案：2x+3';
  const wrong = '求函数 y = x^3 + 5x 的导数，答案：3x^2+5';
  // The README's headline number. It was 0.107 plain, 0.160 with fragment
  // bigrams; operator context must not narrow it.
  const margin = contentSimilarity(q, right) - contentSimilarity(q, wrong);
  assert.ok(margin > 0.160,
    `margin must exceed the previous 0.160, got ${margin.toFixed(3)}`);
});

check('a question with too few operators falls back instead of guessing', () => {
  // One operator is a single token; deciding on it would be deciding on a
  // coincidence. Prose questions have none at all.
  assert.equal(symbolContextSimilarity('a=b', 'c=d'), null, 'one anchor is not enough');
  assert.equal(symbolContextSimilarity('求导数', '求积分'), null);
  // contentSimilarity must still return a usable number in that case.
  assert.ok(contentSimilarity('叙述罗尔定理', '叙述罗尔定理') === 1);
});

// ═══════════════════════════════════════════════════════════════
group('2. Stage 1 — TOC alignment');

const exerciseToc = outline([
  node('第一章 函数与极限', 1),
  node('第二章 导数与微分', 30),
  node('第三章 积分', 60),
]);
const answerToc = outline([
  node('第一章 函数与极限 参考答案', 200),
  node('第二章 导数与微分 参考答案', 220),
  node('第三章 积分 参考答案', 250),
]);

check('chapters pair despite differing titles', () => {
  const a = alignOutlines(exerciseToc, answerToc);
  assert.equal(a.available, true);
  assert.equal(a.pairs.length, 3);
  const second = a.pairs.find(p => p.exercise.title.includes('第二章'));
  assert.ok(second.answer.title.includes('第二章'), 'chapter 2 must pair with chapter 2');
});

check('a document without an outline reports unavailable, not a wrong guess', () => {
  const none = { available: false, items: [] };
  assert.equal(alignOutlines(exerciseToc, none).available, false);
  assert.equal(alignOutlines(none, answerToc).available, false);
});

check('unrelated titles do not pair', () => {
  const other = outline([node('附录 A 三角函数表', 300)]);
  assert.equal(alignOutlines(exerciseToc, other).pairs.length, 0);
});

check('each answer section is used at most once', () => {
  const dupes = outline([node('第二章 导数与微分', 30), node('第二章 导数与微分', 45)]);
  const a = alignOutlines(dupes, answerToc);
  const used = a.pairs.map(p => p.answer.pageNumber);
  assert.equal(new Set(used).size, used.length, 'no answer section may be claimed twice');
});

check('an exercise page maps to its chapter range in the answer book', () => {
  const a = alignOutlines(exerciseToc, answerToc);
  const r = answerRangeForPage(a, 35, 300);   // page 35 is in chapter 2
  assert.equal(r.from, 220);
  assert.equal(r.to, 249, 'range must stop before the next chapter');

  const last = answerRangeForPage(a, 70, 300); // chapter 3 runs to the end
  assert.equal(last.from, 250);
  assert.equal(last.to, 300);
});

check('a page before any section has no range rather than a guessed one', () => {
  const a = alignOutlines(outline([node('第二章', 30)]), outline([node('第二章', 220)]));
  assert.equal(answerRangeForPage(a, 5, 300), null);
});

// ═══════════════════════════════════════════════════════════════
group('3. Stage 2 — content matching');

const answers = buildAnswerIndex(lines(
  [220, '1. 答案：2x + 3'],
  [220, '2. 答案：x = 2'],
  [221, '3. 答案：{1, 2}'],
));

check('number and content agreeing gives the strongest confidence', () => {
  const q = { label: '1', text: '求 y = x^2 + 3x 的导数' };
  const candidates = buildAnswerIndex(lines([220, '1. 求 y = x^2 + 3x 的导数，答案：2x + 3'])).entries;
  const m = matchQuestion(q, candidates, { sectionAligned: true });
  assert.equal(m.matched, true);
  assert.equal(m.confidence, CONFIDENCE.HIGH);
});

check('an unaligned section downgrades an otherwise good match', () => {
  const q = { label: '1', text: '求 y = x^2 + 3x 的导数' };
  const candidates = buildAnswerIndex(lines([220, '1. 求 y = x^2 + 3x 的导数，答案：2x + 3'])).entries;
  const m = matchQuestion(q, candidates, { sectionAligned: false });
  assert.equal(m.confidence, CONFIDENCE.MEDIUM, 'without chapter alignment it is weaker');
});

check('a number alone in an aligned chapter is usable but labelled', () => {
  const q = { label: '2', text: '完全不同的题目内容在这里' };
  const m = matchQuestion(q, answers.entries, { sectionAligned: true });
  assert.equal(m.matched, true);
  assert.equal(m.confidence, CONFIDENCE.MEDIUM);
  assert.ok(m.entry.answer.includes('x = 2'));
});

check('a number alone WITHOUT alignment is only LOW confidence', () => {
  const q = { label: '2', text: '完全不同的题目内容在这里' };
  const m = matchQuestion(q, answers.entries, { sectionAligned: false });
  assert.equal(m.confidence, CONFIDENCE.LOW,
    'numbering restarts per chapter, so a bare number is weak evidence');
});

check('a repeated number is resolved by content when content is decisive', () => {
  const candidates = buildAnswerIndex(lines(
    [220, '1. 求导数 y = x^2 + 3x，答案：2x + 3'],
    [260, '1. 计算定积分 ∫ sin x dx，答案：-cos x + C'],
  )).entries;
  const m = matchQuestion({ label: '1', text: '求导数 y = x^2 + 3x' }, candidates);
  assert.equal(m.matched, true);
  assert.ok(m.entry.answer.includes('2x + 3'), 'must pick the derivative, not the integral');
});

check('a repeated number with indistinguishable content is REFUSED', () => {
  const candidates = buildAnswerIndex(lines(
    [220, '1. 答案：5'],
    [260, '1. 答案：9'],
  )).entries;
  const m = matchQuestion({ label: '1', text: '某个题目' }, candidates);
  assert.equal(m.matched, false, 'showing either answer would be a coin flip');
  assert.equal(m.confidence, CONFIDENCE.NONE);
  assert.equal(m.candidates.length, 2, 'the alternatives are reported so a user can choose');
});

check('strong content alone can match when the number is missing', () => {
  const candidates = buildAnswerIndex(lines(
    [220, '7. 求 y = x^2 + 3x 的导数，答案：2x + 3'],
    [220, '8. 计算三角函数的极限，答案：1'],
  )).entries;
  const m = matchQuestion({ text: '求 y = x^2 + 3x 的导数' }, candidates);
  assert.equal(m.matched, true);
  assert.ok(m.entry.answer.includes('2x + 3'));
});

check('weak content with no number match is refused', () => {
  const m = matchQuestion({ text: '毫不相关的内容' }, answers.entries);
  assert.equal(m.matched, false);
  assert.equal(m.confidence, CONFIDENCE.NONE);
});

check('an empty answer book is refused, not treated as no-match-found', () => {
  const m = matchQuestion({ label: '1', text: 'x' }, []);
  assert.equal(m.matched, false);
  assert.equal(m.confidence, CONFIDENCE.NONE);
});

// ═══════════════════════════════════════════════════════════════
group('4. Whole-page matching');

check('the aligned chapter narrows the search', () => {
  // The same number exists in two chapters; alignment must disambiguate.
  const answerIndex = buildAnswerIndex(lines(
    [220, '1. 答案：导数是 2x + 3'],
    [260, '1. 答案：积分是 -cos x + C'],
  ));
  const alignment = alignOutlines(exerciseToc, answerToc);
  const matches = matchPage(
    [{ label: '1', text: '求导数' }],
    answerIndex,
    { pairStatus: PAIR_STATUS.VERIFIED_PAIR, alignment, exercisePage: 35, answerPageCount: 300 },  // chapter 2
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].matched, true);
  assert.ok(matches[0].entry.answer.includes('2x + 3'),
    'chapter alignment must exclude the chapter-3 entry with the same number');
});

check('without alignment a lone number is a review candidate, not an answer', () => {
  const answerIndex = buildAnswerIndex(lines([220, '1. 答案：2x + 3']));
  const matches = matchPage([{ label: '1', text: '求导数' }], answerIndex, { pairStatus: PAIR_STATUS.VERIFIED_PAIR });
  // A bare number agreeing across an unaligned book is one weak signal. It used
  // to come back matched=true at LOW, which is how a guess reaches a reader as a
  // final answer; the rung now carries that judgement and matched follows it.
  assert.equal(matches[0].confidence, CONFIDENCE.LOW);
  assert.equal(matches[0].rung, RUNG.REVIEW, 'LOW is a review candidate');
  assert.equal(matches[0].matched, false, 'and is never asserted as the answer');
  assert.ok(matches[0].entry, 'while still carrying the candidate it found');
  assert.equal(matches[0].section, null);
});

// ═══════════════════════════════════════════════════════════════
group('4b. Monotonic alignment (the ordering constraint)');

check('alignment never crosses and never reuses an answer', () => {
  // Independent scoring could not express this; it only happened not to break
  // it. Here every question is deliberately similar to every answer.
  const questions = [
    { label: '1', text: '求 y = x^2 的导数' },
    { label: '2', text: '求 y = x^3 的导数' },
    { label: '3', text: '求 y = x^4 的导数' },
  ];
  const entries = buildAnswerIndex(lines(
    [10, '1. 求 y = x^2 的导数，答案：2x'],
    [10, '2. 求 y = x^3 的导数，答案：3x^2'],
    [10, '3. 求 y = x^4 的导数，答案：4x^3'],
  )).entries;

  const pairs = alignSequences(questions, entries).assignments.filter(p => p.entryIndex !== null);
  const indices = pairs.map(p => p.entryIndex);

  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), 'must not cross');
  assert.equal(new Set(indices).size, indices.length, 'must not reuse an entry');
});

check('a question with no answer is left unpaired, not forced onto a neighbour', () => {
  const questions = [
    { label: '1', text: '求 y = x^2 的导数' },
    { label: '2', text: '证明连续函数的介值定理' },   // absent from the key
  ];
  const entries = buildAnswerIndex(lines([10, '1. 求 y = x^2 的导数，答案：2x'])).entries;

  const pairs = alignSequences(questions, entries).assignments;
  assert.equal(pairs[0].entryIndex, 0);
  assert.equal(pairs[1].entryIndex, null,
    'forcing a partner would be worse than admitting there is none');
});

check('extra answer entries are skipped without shifting the rest', () => {
  const questions = [
    { label: '2', text: '求 y = x^3 的导数' },
    { label: '3', text: '求 y = x^4 的导数' },
  ];
  const entries = buildAnswerIndex(lines(
    [10, '1. 求 y = x^2 的导数，答案：2x'],      // no question for this one
    [10, '2. 求 y = x^3 的导数，答案：3x^2'],
    [10, '3. 求 y = x^4 的导数，答案：4x^3'],
  )).entries;

  const pairs = alignSequences(questions, entries).assignments.filter(p => p.entryIndex !== null);
  assert.deepEqual(pairs.map(p => entries[p.entryIndex].label), ['2', '3']);
});

check('a confident pair on each side lifts an uncertain one between them', () => {
  // The point of the ordering constraint: Q5 has no usable content signal, but
  // its neighbours pin its position.
  const answerIndex = buildAnswerIndex(lines(
    [10, '4. 求 y = x^2 + 7x 的导数，答案：2x+7'],
    [10, '5. 答案：12'],                             // bare answer, no question text
    [10, '6. 求 y = x^3 + 2x 的导数，答案：3x^2+2'],
  ));
  const questions = [
    { label: '4', text: '求 y = x^2 + 7x 的导数' },
    { label: '5', text: '完全没有共同内容的题目描述' },
    { label: '6', text: '求 y = x^3 + 2x 的导数' },
  ];

  const matches = matchPage(questions, answerIndex, { pairStatus: PAIR_STATUS.VERIFIED_PAIR });
  assert.equal(matches[1].matched, true, 'the middle question should still be matched');
  assert.notEqual(matches[1].confidence, CONFIDENCE.LOW,
    'positional support should raise it above a bare guess');
  assert.ok(/顺序推定/.test(matches[1].reason), 'and should say why');
});

check('positional support does not vouch for a whole run of guesses', () => {
  // Only a pair flanked on BOTH sides by strong matches is lifted.
  const answerIndex = buildAnswerIndex(lines(
    [10, '1. 求 y = x^2 + 7x 的导数，答案：2x+7'],
    [10, '2. 答案：5'],
    [10, '3. 答案：6'],
  ));
  const questions = [
    { label: '1', text: '求 y = x^2 + 7x 的导数' },
    { label: '2', text: '无关内容甲' },
    { label: '3', text: '无关内容乙' },
  ];
  const matches = matchPage(questions, answerIndex, { pairStatus: PAIR_STATUS.VERIFIED_PAIR });
  assert.equal(matches[2].confidence, CONFIDENCE.LOW,
    'the last one has no strong neighbour after it');
});

// ═══════════════════════════════════════════════════════════════
group('4c. Mathematical grouping is content, not formatting');

check('brackets are canonicalised, never deleted', () => {
  assert.notEqual(normalizeForMatch('1/(x+1)'), normalizeForMatch('1/x+1'),
    'deleting brackets made two different functions the same string');
  assert.equal(normalizeForMatch('f（x）'), normalizeForMatch('f(x)'),
    'full-width and ASCII brackets ARE the same expression written twice');
  assert.equal(normalizeForMatch('\\left(x+1\\right)'), normalizeForMatch('(x+1)'),
    'LaTeX and bare spellings of the same bracket must still fold together');
});

check('grouping, signs and exponents each separate two questions', () => {
  const pairs = [
    ['求 1/(x+1) 的导数', '求 1/x+1 的导数'],
    ['求 x^2+3x 的导数', '求 x^3+5x 的导数'],
    ['求 (a-b)^2 的值', '求 (a+b)^2 的值'],
  ];
  for (const [a, b] of pairs) {
    assert.ok(contentSimilarity(a, b) < 0.95,
      `must not read as identical: ${a} / ${b}`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('4d. Per-question ranges and exact ids');

const bmOutline = (items) => ({ available: true, items });
const bm = (title, pageNumber, depth) => ({ title, pageNumber, depth, children: [] });

check('an exact id correspondence beats any page range', () => {
  const ex = bmOutline([
    bm('第一章 数学分析', 4, 0),
    bm('例题 1.1', 4, 1), bm('例题 1.2', 4, 1), bm('例题 1.3', 5, 1),
  ]);
  const an = bmOutline([
    bm('第一章 数学分析（答案）', 19, 0),
    bm('例题 1.1', 19, 1), bm('例题 1.2', 21, 1), bm('例题 1.3', 24, 1),
  ]);
  const al = alignOutlines(ex, an);
  assert.equal(al.questionIds.size, 3);

  const r1 = answerRangeForQuestion(al, { label: '1.1', page: 4 }, 400);
  const r2 = answerRangeForQuestion(al, { label: '1.2', page: 4 }, 400);
  assert.equal(r1.exact, true);
  assert.equal(r1.from, 19);
  assert.equal(r2.from, 21,
    'two questions on page 4 must NOT share one range — that was the shared-page bug');
  assert.notEqual(r1.from, r2.from);
});

check('section titles and question bookmarks do not compete for a partner', () => {
  // '1.1 极限与连续函数' and '例题 1.1' are similar enough to pair with each
  // other when depth is ignored, which pointed the range at the wrong place.
  const ex = bmOutline([bm('1.1 极限与连续函数', 4, 0), bm('例题 1.1', 4, 1)]);
  const an = bmOutline([bm('1.1 极限与连续函数', 19, 0), bm('例题 1.1', 19, 1)]);
  const al = alignOutlines(ex, an);
  for (const pair of al.pairs) {
    assert.equal(pair.exercise.depth, pair.answer.depth,
      `crossed depths: ${pair.exercise.title} -> ${pair.answer.title}`);
  }
});

check('section alignment is monotonic — chapters cannot cross', () => {
  const ex = bmOutline([bm('第一章 导数', 1, 0), bm('第二章 积分', 50, 0)]);
  const an = bmOutline([bm('第二章 积分（答案）', 10, 0), bm('第一章 导数（答案）', 80, 0)]);
  const al = alignOutlines(ex, an);
  const answerPages = al.pairs.map(p => p.answer.pageNumber);
  assert.deepEqual(answerPages, [...answerPages].sort((a, b) => a - b),
    'a greedy pairing crossed these and produced a range with no answer in it');
});

// ═══════════════════════════════════════════════════════════════
group('4e. Refusing rather than guessing');

check('a duplicated id with no alignment is refused when content cannot separate it', () => {
  // The sequence alignment always produces SOME assignment. Accepting it here
  // would convert genuine ambiguity into a confident wrong answer. These two
  // entries are word-for-word identical, so nothing but position could choose
  // between them — and position is not allowed to.
  const dup = buildAnswerIndex(lines(
    [1, '1. 求 y=x^2 的导数，答案：2x'],
    [9, '1. 求 y=x^2 的导数，答案：2x'],
  ));
  const [m] = matchPage([{ label: '1', text: '求 y=x^2 的导数', page: 1 }], dup,
    { pairStatus: PAIR_STATUS.VERIFIED_PAIR, alignment: null, exercisePage: 1, answerPageCount: 20 });
  assert.equal(m.matched, false);
  assert.equal(m.confidence, CONFIDENCE.NONE);
  assert.equal(m.candidates.length, 2);
  assert.deepEqual(m.candidatePages, [1, 9]);
});

check('a duplicated id IS settled when the mathematics genuinely differs', () => {
  // The counterpart to the test above, and the reason operator context was
  // added: x^2 and x^3 are distinguishable, so refusing them was recall thrown
  // away rather than precision protected.
  const dup = buildAnswerIndex(lines(
    [1, '1. 求 y=x^2 的导数，答案：2x'],
    [9, '1. 求 y=x^3 的导数，答案：3x^2'],
  ));
  const [m] = matchPage([{ label: '1', text: '求 y=x^3 的导数', page: 1 }], dup,
    { pairStatus: PAIR_STATUS.VERIFIED_PAIR, alignment: null, exercisePage: 1, answerPageCount: 20 });
  assert.equal(m.matched, true);
  assert.equal(m.entry.page, 9, 'must pick the x^3 entry, not the nearer x^2 one');
});

check('a corrupt text layer cannot carry a content-only match', () => {
  const idx = { ...buildAnswerIndex(lines([1, '5. 答案：42'])), quality: 'CORRUPT' };
  const [m] = matchPage([{ label: '7', text: '求某个导数', page: 1 }], idx,
    { pairStatus: PAIR_STATUS.VERIFIED_PAIR, alignment: null, exercisePage: 1, answerPageCount: 5 });
  assert.equal(m.matched, false);
  assert.equal(m.confidence, CONFIDENCE.NONE);
});

check('alignment is bounded and reports a timeout instead of guessing', () => {
  const questions = Array.from({ length: 8 }, (_, i) => (
    { label: String(i + 1), text: `求 y = x^${i + 2} 的导数` }));
  const entries = Array.from({ length: 60 }, (_, i) => (
    { label: String(i + 1), page: 1, text: `求 y = x^${i + 2} 的导数，答案` }));

  const timedOut = alignSequences(questions, entries, { timeoutMs: -1 });
  assert.equal(timedOut.timedOut, true);
  assert.ok(timedOut.assignments.every(a => a.entryIndex === null),
    'a partial table must not be read as a real alignment');

  const capped = alignSequences(questions, entries, { maxCandidates: 10 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.timedOut, false);
});

// ═══════════════════════════════════════════════════════════════
group('4f. No outline: duplicates, content, and the positional prior');

/** Six chapters of twenty, numbering restarting each chapter, no bookmarks. */
function noOutlineBooks({ keyChapters = [1, 2, 3, 4, 5, 6] } = {}) {
  const q = [];
  const a = [];
  for (let ch = 1; ch <= 6; ch++) {
    for (let n = 1; n <= 20; n++) {
      q.push({ key: `${ch}:${n}`, text: `${n}. 求函数 y = x^${n} + ${ch}x 的导数，并说明理由。` });
    }
  }
  for (const ch of keyChapters) {
    for (let n = 1; n <= 20; n++) {
      a.push({ key: `${ch}:${n}`, text: `${n}. 求函数 y = x^${n} + ${ch}x 的导数，答案：${n}x^${n - 1} + ${ch}` });
    }
  }
  const mk = (arr) => ({
    numPages: Math.ceil(arr.length / 4),
    outline: { available: false, items: [] },
    async extractText() {
      return arr.map((e, i) => ({ page: Math.floor(i / 4) + 1, text: e.text }));
    },
  });
  return { qDoc: mk(q), aDoc: mk(a), qKeys: q.map(e => e.key), aKeys: a.map(e => e.key) };
}

async function runNoOutline(opts, matchOpts = {}) {
  const { qDoc, aDoc, qKeys, aKeys } = noOutlineBooks(opts);
  const qi = await indexQuestionDocument(qDoc, { expectScript: 'han' });
  const ai = await indexAnswerDocument(aDoc, { expectScript: 'han' });
  const al = alignOutlines(qDoc.outline, aDoc.outline);
  let matched = 0; let wrong = 0; let total = 0;
  for (let p = 1; p <= qDoc.numPages; p++) {
    const onPage = questionsOnPage(qi, p);
    if (onPage.length === 0) continue;
    for (const m of matchPage(onPage, ai, {
      pairStatus: PAIR_STATUS.VERIFIED_PAIR,
      alignment: al, exercisePage: p, answerPageCount: aDoc.numPages,
      questionCount: qi.entries.length, ...matchOpts,
    })) {
      total++;
      if (!m.matched) continue;
      matched++;
      if (aKeys[m.entry.ordinal] !== qKeys[m.question.ordinal]) wrong++;
    }
  }
  return { matched, wrong, total, refused: total - matched };
}

await checkAsync('with no outline, content resolves what it can and refuses the rest', async () => {
  const r = await runNoOutline({});
  assert.equal(r.wrong, 0, `${r.wrong} wrong matches — precision must stay at 100%`);
  assert.ok(r.matched > 0, 'blanket refusal threw away the cases content could settle');
  assert.ok(r.refused > 0, 'indistinguishable duplicates must still refuse');
});

await checkAsync('precision survives a key that is NOT parallel to the exercise book', async () => {
  // Chapters 1-3 absent from the key: every question in them has its number
  // present, but under the wrong chapter. Nothing may be matched wrongly.
  const r = await runNoOutline({ keyChapters: [4, 5, 6] });
  assert.equal(r.wrong, 0,
    `${r.wrong} wrong — a missing chapter must produce refusals, not neighbours`);
});

await checkAsync('the positional prior is OFF by default, and is now intercepted too', async () => {
  // Reversed chapters: position points at the wrong copy every single time.
  const reversed = { keyChapters: [6, 5, 4, 3, 2, 1] };
  const off = await runNoOutline(reversed);
  assert.equal(off.wrong, 0, `default must not guess: ${off.wrong} wrong`);

  // This assertion used to read `on.wrong > 0`, recording that enabling the
  // prior returned 120 of 120 wrong answers at MEDIUM confidence. It no longer
  // does. Measured after the formula veto landed: 0 wrong, 0 accepted, and all
  // 120 capped at REVIEW, because reversed chapters pair each question with an
  // answer that shares none of its mathematics.
  //
  // That is NOT evidence the prior became safe. It is evidence that one
  // independent signal happens to catch this fixture, where the wrong partner
  // differs mathematically. A wrong partner that shared an expression would
  // pass the veto untouched. The prior still cannot detect its own
  // inapplicability, which is the property it was disabled for, so it stays
  // off — and re-measuring on real non-parallel books is still the
  // precondition for reconsidering that.
  const on = await runNoOutline(reversed, { usePositionalPrior: true });
  assert.equal(on.wrong, 0, 'the veto must intercept the prior, not let it answer');
  assert.equal(on.matched, 0, 'and the prior must not quietly start resolving them');
});

check('the positional window separates rather than ranks', () => {
  const w = positionalWindow(10, 100, 100);
  assert.equal(w.expected, 10);
  // Two candidates inside the window is a refusal, not a nearest-wins choice.
  assert.equal(separateByPosition(
    [{ ordinal: 9 }, { ordinal: 11 }], w), null);
  // Exactly one inside is the only accepting case.
  assert.equal(separateByPosition(
    [{ ordinal: 10 }, { ordinal: 90 }], w).entry.ordinal, 10);
  // None inside is also a refusal.
  assert.equal(separateByPosition([{ ordinal: 90 }], w), null);
});

// ═══════════════════════════════════════════════════════════════
group('5. Module contract');

ok(existsSync(join(ROOT, 'src/pdf/question-matcher.js')), 'matcher module exists');

const matcher = $read('src/pdf/question-matcher.js');
ok(
  !/fetch\(|XMLHttpRequest|provider/.test(matcher),
  'matching is entirely local — no network, no AI provider',
);
ok(
  matcher.includes('CONFIDENCE.NONE'),
  'a refusal is representable, so ambiguity is never resolved by guessing',
);

const index = $read('src/pdf/answer-index.js');
ok(index.includes('indexQuestionDocument'), 'the exercise book can be indexed too');
ok(index.includes('questionsOnPage'), 'questions can be read per page');

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
