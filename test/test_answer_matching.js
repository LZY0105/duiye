#!/usr/bin/env node
// Wiring test for the answer-matching engine inside the app.
//
// The engine has its own suites; this one exists for the seam between them and
// pdf-workspace.js, which is where an engine upgrade actually breaks things.
// Every assertion here corresponds to a call the workspace makes, so a signature
// change that the engine's own tests are happy with still fails here.

import assert from 'node:assert/strict';

import {
  INDEX_SOURCE,
  TEXT_QUALITY,
  indexAnswerDocument,
  indexQuestionDocument,
  indexesComparable,
  questionsOnPage,
} from '../src/pdf/answer-index.js';
import { CONFIDENCE, alignOutlines, matchPage } from '../src/pdf/question-matcher.js';
import { verifyPair } from '../src/pdf/pair-verifier.js';
import { PAIR_STATUS } from '../src/pdf/decision.js';

// The workspace establishes the pair before it asks for a single answer, and
// `matchPage` fails safe without that verdict — an unverified pair is never
// handed an automatic match, because matching a book against the wrong year's
// key produces confident wrong answers that no per-question evidence catches.
// These tests mirror that sequence rather than reaching past it.
const gate = (q, a, questionIndex, answerIndex) => verifyPair({
  exerciseDoc: q,
  answerDoc: a,
  exerciseIndex: questionIndex,
  answerIndex,
}).status;

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  PASS  ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  FAIL  ${l}${d ? ': ' + d : ''}`); };
async function check(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

/** Two books with bookmark trees, as pdf-document.js would present them. */
function book({ pages = 12, opaque = false, withOutline = true, answer = false } = {}) {
  const items = [];
  for (let i = 1; i <= pages; i++) {
    items.push({ title: `例题 1.${i}`, pageNumber: i, depth: 0, children: [] });
  }
  const readable = (i) => (answer
    ? `1.${i} 求函数 y = x^${i} + 2x 的导数，答案：${i}x^${i - 1} + 2`
    : `1.${i} 求函数 y = x^${i} + 2x 的导数，并说明理由。`);
  // Text that cannot be decoded: the mathematics is Latin and digits and comes
  // through, the CJK prose does not. What every book looked like before the app
  // shipped pdf.js cmaps.
  const garbled = (i) => (answer
    ? `1.${i} ඔ২ y = x^${i} + 2x ᄹඔਙ ࢳ࠺ ${i}x^${i - 1} + 2`
    : `1.${i} ඔ২ y = x^${i} + 2x ᄹඔਙđ౏ ཋթᄝ`);

  return {
    numPages: pages,
    outline: withOutline ? { available: true, items } : { available: false, items: [] },
    async extractText({ from, to } = {}) {
      const lo = from ?? 1;
      const hi = to ?? pages;
      const out = [];
      for (let i = lo; i <= hi; i++) out.push({ page: i, text: opaque ? garbled(i) : readable(i) });
      return out;
    },
  };
}

console.log('answer matching — app wiring');

await check('the workspace call sequence runs end to end', async () => {
  const q = book();
  const a = book({ answer: true });
  const opts = { expectScript: 'han' };

  const questionIndex = await indexQuestionDocument(q, opts);
  const answerIndex = await indexAnswerDocument(a, opts);
  assert.equal(questionIndex.source, INDEX_SOURCE.OUTLINE);

  const alignment = alignOutlines(q.outline, a.outline);
  const questions = questionsOnPage(questionIndex, 3);
  assert.ok(questions.length > 0, 'page 3 should carry a question');

  const pairStatus = gate(q, a, questionIndex, answerIndex);
  assert.notEqual(pairStatus, PAIR_STATUS.REJECTED_PAIR, 'a book and its own key must pass the gate');

  const matches = matchPage(questions, answerIndex, {
    pairStatus,
    alignment,
    exercisePage: 3,
    answerPageCount: a.numPages,
    questionCount: questionIndex.entries.length,
    crossBookComparable: indexesComparable(questionIndex, answerIndex).comparable,
  });
  assert.ok(matches.length > 0);
  // The fixture books carry no identity evidence, so the pair is UNKNOWN and
  // the engine caps an otherwise perfect id hit at REVIEW rather than asserting
  // it. That cap IS the feature: `matched` stays false, the answer is still
  // located, and the reason for holding back is named.
  const [first] = matches;
  assert.equal(first.rung, 'REVIEW', `expected a capped result, got ${first.rung}`);
  assert.equal(first.cappedBy, 'PAIR_IDENTITY_UNKNOWN');
  assert.equal(first.confidence, CONFIDENCE.HIGH,
    'per-question evidence is strong; only the PAIR is unestablished');
  assert.ok(first.entry, 'a capped result still knows where the answer is');
  assert.equal(first.entry.label, first.question.label,
    'the match must be the same question in the other book');
});

await check('every field the workspace reads is present on a match', async () => {
  const q = book();
  const a = book({ answer: true });
  const questionIndex = await indexQuestionDocument(q, { expectScript: 'han' });
  const answerIndex = await indexAnswerDocument(a, { expectScript: 'han' });
  const [m] = matchPage(questionsOnPage(questionIndex, 2), answerIndex, {
    pairStatus: gate(q, a, questionIndex, answerIndex),
    alignment: alignOutlines(q.outline, a.outline),
    exercisePage: 2,
    answerPageCount: a.numPages,
  });
  // renderAnswerMatches and the onReveal handler read exactly these.
  assert.ok(m.question, 'question');
  assert.ok(typeof m.matched === 'boolean', 'matched');
  assert.ok(m.confidence in { HIGH: 1, MEDIUM: 1, LOW: 1, NONE: 1 }, 'confidence');
  assert.ok(typeof m.reason === 'string', 'reason');
  assert.ok(Number.isFinite(m.entry?.page), 'entry.page — onReveal jumps to it');
});

await check('undecodable CJK text is OPAQUE, not a failure', async () => {
  // The real books no longer look like this — they decode properly now that
  // cmaps ship. Kept because a document whose fonts genuinely cannot be decoded
  // must still match on its bookmark ids rather than being rejected outright.
  const q = book({ opaque: true });
  const a = book({ opaque: true, answer: true });
  const questionIndex = await indexQuestionDocument(q, { expectScript: 'han' });
  assert.equal(questionIndex.quality, TEXT_QUALITY.OPAQUE, questionIndex.reason);
  assert.equal(questionIndex.scanned, false);
  assert.ok(questionIndex.entries.length > 0,
    'bookmark ids are structural and survive undecodable text');

  const answerIndex = await indexAnswerDocument(a, { expectScript: 'han' });
  const [m] = matchPage(questionsOnPage(questionIndex, 4), answerIndex, {
    pairStatus: gate(q, a, questionIndex, answerIndex),
    alignment: alignOutlines(q.outline, a.outline),
    exercisePage: 4,
    answerPageCount: a.numPages,
    questionCount: questionIndex.entries.length,
  });
  // Same capped contract as above: an unestablished pair is never asserted.
  // What matters here is that undecodable text does not stop the STRUCTURAL id
  // from locating the answer — the bookmark tree survives a broken font map.
  assert.ok(m.entry, 'an opaque pair must still locate the answer by bookmark id');
  assert.equal(m.entry.label, m.question.label, 'and it must be the same question');
});

await check('a scanned book is reported as scanned, not silently empty', async () => {
  const scanned = {
    numPages: 5,
    outline: { available: false, items: [] },
    async extractText() { return []; },
  };
  const index = await indexQuestionDocument(scanned, { expectScript: 'han' });
  assert.equal(index.quality, TEXT_QUALITY.SCANNED);
  assert.equal(index.scanned, true);
  assert.equal(index.entries.length, 0);
});

await check('indexesComparable refuses a verdict it cannot support', () => {
  // Small alphabets cannot separate "same font" from "different font", so the
  // workspace must get comparable:false rather than a coin flip.
  const tiny = { alphabet: new Set(['a', 'b', 'c']) };
  const r = indexesComparable(tiny, tiny);
  assert.equal(r.sufficient, false);
  assert.equal(r.comparable, false);
});

await check('a question spanning pages is found from any page it covers', async () => {
  const q = book({ pages: 6 });
  const index = await indexQuestionDocument(q, { expectScript: 'han' });
  for (let page = 1; page <= 6; page++) {
    assert.ok(questionsOnPage(index, page).length > 0, `page ${page} found nothing`);
  }
});

console.log(FAIL === 0
  ? `\nanswer matching: PASS (${PASS} checks)`
  : `\nanswer matching: FAIL (${FAIL} of ${PASS + FAIL})`);
process.exit(FAIL === 0 ? 0 : 1);
