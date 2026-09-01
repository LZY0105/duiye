#!/usr/bin/env node
// Answer-book indexing tests.
//
// This closes the exercise → answer loop that previously made the user type the
// expected answer. The governing rule under test is that a WRONG match is worse
// than no match: handing the grader the wrong answer makes every later stage
// confidently wrong and tells a student their correct work is mistaken.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INDEX_SOURCE,
  MATCH,
  TEXT_QUALITY,
  buildAnswerIndex,
  buildOutlineIndex,
  extractAnswer,
  findAnswer,
  indexAnswerDocument,
  parseLabelledLine,
  questionsOnPage,
} from '../src/pdf/answer-index.js';
import { parseSubQuestionLine } from '../src/pdf/question-id.js';

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

const lines = (...items) => items.map(([page, text]) => ({ page, text }));

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Answer Index — exercise → answer matching');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. Label recognition');

check('common Chinese and western numbering forms are recognised', () => {
  for (const [line, label] of [
    ['1. x = 2', '1'],
    ['12) x = 3', '12'],
    ['15、x = 6', '15'],
    ['第 9 题：x = 7', '9'],
    ['3．x = 8', '3'],
    // Hierarchical ids survive whole. Truncating 1.200 to 1 was the single
    // largest source of wrong matches on the real books.
    ['1.1 求极限', '1.1'],
    ['1.200. 求导数', '1.200'],
    ['2.231、证明', '2.231'],
    ['例题 1.31 求积分', '1.31'],
  ]) {
    const parsed = parseLabelledLine(line);
    assert.ok(parsed, `should parse: ${line}`);
    assert.equal(parsed.label, label, `label of: ${line}`);
  }
});

check('a parenthesised number is a SUBQUESTION, never a new question', () => {
  // (1) and (2) restart inside every question. Promoted to top level they
  // manufacture hundreds of duplicate '1's, converting a clean unique-id
  // lookup into forced ambiguity across the whole book.
  assert.equal(parseLabelledLine('(7) x = 4'), null);
  assert.equal(parseLabelledLine('（8）x = 5'), null);
  assert.deepEqual(parseSubQuestionLine('(7) x = 4'), { sub: '7', body: 'x = 4' });
  assert.deepEqual(parseSubQuestionLine('（8）x = 5'), { sub: '8', body: 'x = 5' });
});

check('a bare number mid-line is not treated as a label', () => {
  // Labels are anchored to the start; otherwise the mathematics itself would
  // constantly look like a new exercise.
  assert.equal(parseLabelledLine('x = 12. something'), null);
  assert.equal(parseLabelledLine('  解得 3) 无意义'), null);
});

check('continuation lines carry no label', () => {
  assert.equal(parseLabelledLine('因此 x = 2'), null);
  assert.equal(parseLabelledLine(''), null);
});

// ═══════════════════════════════════════════════════════════════
group('2. Building the index');

check('each labelled entry keeps its page and text', () => {
  const { entries } = buildAnswerIndex(lines(
    [1, '1. x = 2'],
    [1, '2. x = 3'],
    [2, '3. x = 4'],
  ));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].label, '1');
  assert.equal(entries[2].page, 2, 'page is how a user verifies the match themselves');
});

check('a multi-line answer stays whole', () => {
  const { entries } = buildAnswerIndex(lines(
    [1, '1. 解方程'],
    [1, '整理得 2x = 4'],
    [1, '所以 x = 2'],
    [1, '2. x = 9'],
  ));
  assert.equal(entries.length, 2);
  assert.ok(entries[0].text.includes('2x = 4'));
  assert.ok(entries[0].text.includes('x = 2'));
});

check('text before the first label is discarded, not attributed', () => {
  const { entries } = buildAnswerIndex(lines(
    [1, '第一章 答案'],
    [1, '1. x = 2'],
  ));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, '1');
});

check('repeated labels are reported as duplicates', () => {
  const index = buildAnswerIndex(lines(
    [1, '1. x = 2'],
    [5, '1. x = 9'],   // chapter two, numbering restarts
  ));
  assert.deepEqual(index.duplicates, ['1']);
});

// ═══════════════════════════════════════════════════════════════
group('3. Extracting the answer value');

check('answer-book prefixes are stripped', () => {
  assert.equal(extractAnswer('答案：x = 2'), 'x = 2');
  assert.equal(extractAnswer('答: 5/6'), '5/6');
  assert.equal(extractAnswer('解 x = -3'), 'x = -3');
  assert.equal(extractAnswer('Answer: 42'), '42');
});

check('an explanation following the answer is dropped', () => {
  assert.equal(extractAnswer('x = 2。因为两边同时减一'), 'x = 2');
  assert.equal(extractAnswer('5/6；注意通分'), '5/6');
});

check('the mathematics itself is left untouched', () => {
  // Parsing is the Math Engine's job; guessing here would hide a parse failure
  // behind a plausible-looking string.
  assert.equal(extractAnswer('{1, 2}'), '{1, 2}');
  assert.equal(extractAnswer('\\frac{1}{2}'), '\\frac{1}{2}');
  assert.equal(extractAnswer(''), '');
});

// ═══════════════════════════════════════════════════════════════
group('4. Matching — a wrong match is worse than none');

const index = buildAnswerIndex(lines(
  [1, '1. 答案：x = 2'],
  [1, '2. 答案：{1, 2}'],
  [1, '10. 答案：5/6'],
));

check('an unambiguous label matches', () => {
  const r = findAnswer(index, '2');
  assert.equal(r.status, MATCH.MATCHED);
  assert.equal(r.entry.answer, '{1, 2}');
});

check('leading zeros do not defeat a match', () => {
  assert.equal(findAnswer(index, '02').status, MATCH.MATCHED);
});

check('a label that is not present is NOT_FOUND, not a nearby guess', () => {
  const r = findAnswer(index, '3');
  assert.equal(r.status, MATCH.NOT_FOUND);
  assert.equal(r.entry, undefined);
});

check('"1" does not match "10"', () => {
  assert.equal(findAnswer(index, '1').entry.answer, 'x = 2');
  assert.equal(findAnswer(index, '10').entry.answer, '5/6');
});

check('a duplicated label is AMBIGUOUS rather than arbitrarily chosen', () => {
  const dup = buildAnswerIndex(lines(
    [1, '1. 答案：x = 2'],
    [9, '1. 答案：x = 99'],
  ));
  const r = findAnswer(dup, '1');
  assert.equal(r.status, MATCH.AMBIGUOUS,
    'picking one would grade against another chapter without the user knowing');
  assert.equal(r.candidates.length, 2);
});

check('an empty index reports NO_INDEX', () => {
  assert.equal(findAnswer({ entries: [] }, '1').status, MATCH.NO_INDEX);
  assert.equal(findAnswer(null, '1').status, MATCH.NO_INDEX);
});

check('a missing label is NOT_FOUND rather than matching the first entry', () => {
  assert.equal(findAnswer(index, '').status, MATCH.NOT_FOUND);
});

// ═══════════════════════════════════════════════════════════════
group('5. Scanned answer books');

await checkAsync('a document with no text layer is reported as scanned', async () => {
  const scanned = { async extractText() { return []; } };
  const result = await indexAnswerDocument(scanned);
  assert.equal(result.scanned, true,
    'a scanned book needs a different message than an empty one');
  assert.equal(result.entries.length, 0);
});

await checkAsync('a document with text indexes normally', async () => {
  const doc = { async extractText() { return lines([1, '1. 答案：x = 2']); } };
  const result = await indexAnswerDocument(doc);
  assert.equal(result.scanned, false);
  assert.equal(result.entries[0].answer, 'x = 2');
});

// ═══════════════════════════════════════════════════════════════
group('5b. Hierarchical ids and subquestions');

check('a subquestion joins its parent instead of becoming a new entry', () => {
  const { entries, duplicates } = buildAnswerIndex(lines(
    [1, '1.5 求下列函数的导数'],
    [1, '(1) y = x^2，答案：2x'],
    [1, '(2) y = x^3，答案：3x^2'],
    [1, '1.6 求极限，答案：0'],
  ));
  assert.equal(entries.length, 2, 'two questions, not four');
  assert.deepEqual(entries.map(e => e.label), ['1.5', '1.6']);
  assert.equal(entries[0].subQuestions.length, 2);
  assert.deepEqual(entries[0].subQuestions.map(s => s.sub), ['1', '2']);
  assert.deepEqual(duplicates, [],
    'promoting (1)/(2) to top level would invent a duplicate 1 in every question');
});

check('1.1 and 1.10 are different questions', () => {
  const index = buildAnswerIndex(lines(
    [1, '1.1 答案：a'],
    [2, '1.10 答案：b'],
  ));
  assert.deepEqual(index.duplicates, []);
  assert.equal(findAnswer(index, '1.1').entry.answer, 'a');
  assert.equal(findAnswer(index, '1.10').entry.answer, 'b');
});

check('per-segment leading zeros normalise, the hierarchy does not flatten', () => {
  const index = buildAnswerIndex(lines([1, '1.200 答案：c']));
  assert.equal(findAnswer(index, '01.200').status, MATCH.MATCHED);
  assert.equal(findAnswer(index, '1').status, MATCH.NOT_FOUND,
    'the chapter number alone must not resolve to a question inside it');
});

check('an abstention keeps its candidates, pages and reason', () => {
  const dup = buildAnswerIndex(lines(
    [1, '1. 答案：x = 2'],
    [9, '1. 答案：x = 99'],
  ));
  const r = findAnswer(dup, '1');
  assert.equal(r.status, MATCH.AMBIGUOUS);
  assert.deepEqual(r.candidatePages, [1, 9]);
  assert.equal(r.candidateIds.length, 2);
  assert.ok(r.reason.includes('1'), 'a refusal that drops its evidence wastes the work');
});

// ═══════════════════════════════════════════════════════════════
group('5c. Text quality gates indexing');

check('a question spanning pages is found from any page it covers', () => {
  const index = buildAnswerIndex(lines(
    [4, '1.1 求极限'],
    [5, '继续的推导'],
    [6, '1.2 求导数'],
  ));
  assert.equal(questionsOnPage(index, 4)[0].label, '1.1');
  assert.equal(questionsOnPage(index, 5)[0].label, '1.1',
    'page equality dropped every question that ran over a page break');
});

check('the four ways a book can yield nothing are distinguished', () => {
  assert.equal(TEXT_QUALITY.SCANNED !== TEXT_QUALITY.BLANK, true);
  assert.equal(TEXT_QUALITY.CORRUPT !== TEXT_QUALITY.BLANK, true);
  assert.equal(INDEX_SOURCE.OUTLINE !== INDEX_SOURCE.BODY, true);
});

check('an outline index carries ids even when the text layer is refused', () => {
  const outline = { available: true, items: [
    { title: '例题 1.1', pageNumber: 1, depth: 0, children: [] },
    { title: '例题 1.2', pageNumber: 3, depth: 0, children: [] },
  ] };
  const built = buildOutlineIndex(outline, lines([1, 'garbage']), {
    numPages: 5, quality: TEXT_QUALITY.CORRUPT,
  });
  assert.equal(built.source, INDEX_SOURCE.OUTLINE);
  assert.deepEqual(built.entries.map(e => e.label), ['1.1', '1.2']);
  assert.equal(built.entries[0].text, '',
    'no text may be attached from a layer the gate rejected');
  assert.equal(built.entries[0].endPage, 3, 'a question spans up to the next one');
});

check('inline answers are extracted, not only leading ones', () => {
  assert.equal(extractAnswer('求 f(x) 的导数，答案：2x+3。'), '2x+3');
  assert.equal(extractAnswer('题干很长，Answer: 42'), '42');
  assert.equal(extractAnswer('解答过程中没有标记'), '解答过程中没有标记');
});

// ═══════════════════════════════════════════════════════════════
group('6. Wiring');

ok(existsSync(join(ROOT, 'src/pdf/answer-index.js')), 'answer-index module exists');

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
