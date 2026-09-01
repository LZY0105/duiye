#!/usr/bin/env node
// What happens when the bookmark tree is absent.
//
// Every other real-PDF measurement in this repo was taken with both books'
// bookmark trees intact, which is the easy case: all 508 questions resolve at
// stage 0 by exact id and nothing else in the engine runs. That made the
// headline numbers true and unrepresentative.
//
// This suite strips the bookmarks and scores what is left. The important part is
// HOW it scores: ground truth comes from the bookmark trees, which are
// structural and completely independent of the text layer the stripped runs are
// forced to rely on. Scoring a body-parsed match against another body-parsed
// label — which is what an earlier ad-hoc measurement did — grades the text
// layer against itself and proves nothing.
//
// A body-parsed question is only counted when TWO independent facts agree: its
// parsed label is a real question id, and the bookmark tree independently places
// that id on the page the parser found it. Matches failing that are reported as
// unidentifiable rather than quietly dropped, because dropping them would let
// the parser hide its own mistakes.
//
// Regimes C and D sample pages by stride. They are slow — see the timing
// assertions, which are a finding in their own right — and the point is the
// precision measurement, which a sample supports perfectly well.

import assert from 'node:assert/strict';
import { PAIR_STATUS } from '../src/pdf/decision.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOutlineIndex,
  indexAnswerDocument,
  indexQuestionDocument,
  questionsOnPage,
} from '../src/pdf/answer-index.js';
import { alignOutlines, matchPage } from '../src/pdf/question-matcher.js';
import { TEXT_QUALITY } from '../src/pdf/text-quality.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let PASS = 0, FAIL = 0, SKIP = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
async function check(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

const CORPUS = [
  process.env.FIND_ENGINE_CORPUS,
  join(ROOT, 'corpus', 'data.json'),
  join(ROOT, '..', 'find-engine-corpus', 'data.json'),
].find(p => p && existsSync(p)) || join(ROOT, 'corpus', 'data.json');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Without bookmarks — scored against bookmark ground truth');
console.log('═══════════════════════════════════════════════════════════════');

if (!existsSync(CORPUS)) {
  console.log(`\n  corpus not found at ${CORPUS}`);
  console.log('  set FIND_ENGINE_CORPUS to run this suite\n');
  SKIP++;
  console.log(`  ${PASS} passed, ${FAIL} failed, ${SKIP} skipped\n`);
  process.exit(0);
}

const raw = JSON.parse(readFileSync(CORPUS, 'utf-8'));

/**
 * Ground truth: question id -> where it lives in each book.
 *
 * Built from the bookmark trees only. Nothing here reads the text layer, so it
 * stays valid as an oracle when the text layer is the thing under test.
 */
function buildTruth() {
  const outlineIndex = (d) => buildOutlineIndex(d.outline, d.lines, {
    numPages: d.numPages, quality: TEXT_QUALITY.USABLE,
  });
  const q = outlineIndex(raw.q2023);
  const a = outlineIndex(raw.ans2023);
  const answers = new Map(a.entries.map(e => [e.label, e]));
  const truth = new Map();
  for (const qe of q.entries) {
    const ae = answers.get(qe.label);
    if (!ae) continue;
    truth.set(qe.label, {
      qFrom: qe.page, qTo: qe.endPage, aFrom: ae.page, aTo: ae.endPage,
    });
  }
  return truth;
}

const TRUTH = buildTruth();

const asDocument = (d, keepOutline) => ({
  numPages: d.numPages,
  outline: keepOutline ? d.outline : { available: false, items: [] },
  async extractText({ from, to } = {}) {
    if (from == null && to == null) return d.lines;
    return d.lines.filter(l =>
      (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});

/** Runs one regime and scores every match it emits against the oracle. */
async function measure({ questionBookmarks, answerBookmarks, stride = 1 }) {
  const qDoc = asDocument(raw.q2023, questionBookmarks);
  const aDoc = asDocument(raw.ans2023, answerBookmarks);

  const startedIndex = Date.now();
  const questionIndex = await indexQuestionDocument(qDoc, { expectScript: 'han' });
  const answerIndex = await indexAnswerDocument(aDoc, { expectScript: 'han' });
  const indexMs = Date.now() - startedIndex;

  const alignment = alignOutlines(qDoc.outline, aDoc.outline);

  const r = {
    questionSource: questionIndex.source,
    questionEntries: questionIndex.entries.length,
    answerSource: answerIndex.source,
    answerEntries: answerIndex.entries.length,
    exactIds: alignment.questionIds.size,
    indexMs,
    pagesRun: 0,
    emitted: 0,
    refused: 0,
    identified: 0,
    correct: 0,
    wrong: 0,
    unidentifiable: 0,
    distinct: new Set(),
    wrongExamples: [],
    perPageMs: [],
  };

  for (let page = 1; page <= qDoc.numPages; page += stride) {
    const questions = questionsOnPage(questionIndex, page);
    if (questions.length === 0) continue;
    r.pagesRun++;

    const started = Date.now();
    const matches = matchPage(questions, answerIndex, {
      pairStatus: PAIR_STATUS.VERIFIED_PAIR,
      alignment,
      exercisePage: page,
      answerPageCount: aDoc.numPages,
      questionCount: questionIndex.entries.length,
    });
    r.perPageMs.push(Date.now() - started);

    for (const m of matches) {
      r.emitted++;
      if (!m.matched) { r.refused++; continue; }

      // Two independent facts, or it does not count.
      const t = TRUTH.get(m.question.label);
      if (!t || page < t.qFrom || page > t.qTo) { r.unidentifiable++; continue; }
      r.identified++;

      const answerPage = m.entry?.page;
      if (answerPage >= t.aFrom && answerPage <= t.aTo) {
        r.correct++;
        r.distinct.add(m.question.label);
      } else {
        r.wrong++;
        if (r.wrongExamples.length < 3) {
          r.wrongExamples.push(
            `${m.question.label}: chose p${answerPage}, truth p${t.aFrom}-${t.aTo}`);
        }
      }
    }
  }

  r.perPageMs.sort((a, b) => a - b);
  r.p50 = r.perPageMs[Math.floor(r.perPageMs.length * 0.5)] ?? 0;
  r.p95 = r.perPageMs[Math.floor(r.perPageMs.length * 0.95)] ?? 0;
  r.precision = r.identified ? (r.correct / r.identified) : 1;
  return r;
}

function report(name, r, stride) {
  console.log(`      index  q=${r.questionSource}(${r.questionEntries})`
    + ` a=${r.answerSource}(${r.answerEntries}) in ${r.indexMs}ms, exact ids ${r.exactIds}`);
  console.log(`      pages  ${r.pagesRun}${stride > 1 ? ` (every ${stride}th)` : ''}`
    + `, per-page p50 ${r.p50}ms p95 ${r.p95}ms`);
  console.log(`      result emitted ${r.emitted}, refused ${r.refused},`
    + ` identified ${r.identified}, correct ${r.correct}, WRONG ${r.wrong}`
    + `, precision ${(r.precision * 100).toFixed(1)}%`);
  console.log(`      recall ${r.distinct.size} distinct questions`
    + `, ${r.unidentifiable} unidentifiable`);
  if (r.wrongExamples.length) console.log(`      e.g. ${r.wrongExamples.join(' | ')}`);
}

// ═══════════════════════════════════════════════════════════════
group('1. The oracle itself');

await check('ground truth pairs all 508 questions across both bookmark trees', () => {
  assert.equal(TRUTH.size, 508, `oracle has ${TRUTH.size} pairs`);
  const sample = TRUTH.get('1.31');
  assert.ok(sample, '1.31 must be in the oracle');
  assert.ok(sample.aFrom > 0 && sample.aTo >= sample.aFrom);
});

await check('most exercise pages carry several questions, so pages alone cannot identify', () => {
  // The reason identification needs the parsed label AND the page, not the page
  // alone: only 16 of 365 covered pages hold exactly one question.
  const perPage = new Map();
  for (const t of TRUTH.values()) {
    for (let p = t.qFrom; p <= t.qTo; p++) perPage.set(p, (perPage.get(p) ?? 0) + 1);
  }
  const single = [...perPage.values()].filter(n => n === 1).length;
  assert.ok(single < perPage.size * 0.1,
    `${single} of ${perPage.size} pages are single-question — page alone would suffice, `
    + 'and this test would be measuring something easier than reality');
});

// ═══════════════════════════════════════════════════════════════
group('2. Every regime, scored against the oracle');

const REGIMES = [
  ['A. both books have bookmarks', { questionBookmarks: true, answerBookmarks: true, stride: 1 }],
  ['B. answer key has NO bookmarks', { questionBookmarks: true, answerBookmarks: false, stride: 1 }],
  ['C. exercise book has NO bookmarks', { questionBookmarks: false, answerBookmarks: true, stride: 8 }],
  ['D. NEITHER book has bookmarks', { questionBookmarks: false, answerBookmarks: false, stride: 16 }],
];

const results = new Map();
for (const [name, opts] of REGIMES) {
  await check(`${name} — zero wrong answers`, async () => {
    const r = await measure(opts);
    results.set(name, r);
    report(name, r, opts.stride);
    // The invariant. Recall may collapse; a confident wrong answer may not
    // happen, in any regime, ever.
    assert.equal(r.wrong, 0,
      `${r.wrong} wrong of ${r.identified} identified:\n        ${r.wrongExamples.join('\n        ')}`);
  });
}

// ═══════════════════════════════════════════════════════════════
group('3. What the bookmarks were carrying');

await check('with bookmarks, all 508 resolve; without, recall is reduced but not destroyed', () => {
  const a = results.get('A. both books have bookmarks');
  const b = results.get('B. answer key has NO bookmarks');
  // 508 under the CALIBRATED formula policy; 470 under the STRICT default,
  // which is the agreed rule that every complete expression must correspond.
  // Zero wrong under either. See test_real_pdfs.js for the policy comparison.
  assert.ok(a.distinct.size >= 470,
    `regime A resolved ${a.distinct.size}, below the strict-policy floor`);
  // Under STRICT some correct matches are held at REVIEW rather than refused
  // outright, so the property is that nothing is WRONG, not that nothing is
  // withheld.
  assert.equal(a.wrong, 0, `regime A produced ${a.wrong} wrong`);

  // This assertion used to require b.distinct < 50, and it was true: the engine
  // resolved 8 of 508 without the key's bookmarks. That was not a property of
  // the problem, it was two defects. The answer book's own table of contents
  // listed every id, so every lookup found its label twice and refused a
  // question it had already located (825 of 872 attempts, the true answer among
  // the two candidates every time); and running heads inflated similarity
  // between unrelated entries. With contents rows and boilerplate excluded,
  // recall is 270 — see src/toc-filter.js and src/boilerplate.js.
  //
  // The bound is now stated the way the finding actually reads: losing the
  // bookmarks still costs real recall, and it must never cost precision.
  assert.ok(b.distinct.size < a.distinct.size,
    `losing the key's bookmarks should still cost recall, got ${b.distinct.size}`);
  assert.equal(b.wrong, 0, 'and it must cost no precision at all');
  assert.ok(b.refused > 0, 'the engine should still be refusing where it cannot tell');
  assert.ok(b.distinct.size >= 200,
    `the contents-row and boilerplate fixes should hold; got ${b.distinct.size}`);
});

await check('the body parser over-extracts, which is why its ids are not the oracle', () => {
  const c = results.get('C. exercise book has NO bookmarks');
  const d = results.get('D. NEITHER book has bookmarks');
  // 730 body "questions" against 508 real ones, and 1235 body "answers" against
  // 508. Section headings and stray numbering parse as entries. Harmless for
  // precision because the extra entries simply never match, but it is the
  // reason a body-parsed label cannot be trusted as ground truth.
  assert.ok(c.questionEntries > 508,
    `expected over-extraction, got ${c.questionEntries}`);
  assert.ok(d.answerEntries > 508,
    `expected over-extraction, got ${d.answerEntries}`);
});

await check('losing the exercise bookmarks is expensive per page', () => {
  // The finding this suite exists to record. With bookmarks a page costs
  // ~0.01ms because stage 0 answers it outright. Without them every question
  // is scored against a large candidate pool of long attached texts.
  const a = results.get('A. both books have bookmarks');
  const c = results.get('C. exercise book has NO bookmarks');
  assert.ok(a.p95 <= 5, `bookmarked path should stay trivial, got ${a.p95}ms`);
  assert.ok(c.p95 > a.p95 * 10,
    'if this stops being true the bounds changed — re-measure before relying on them');
  // Loose ceiling: the engine's own deadline is 1500ms, and a page that hits it
  // refuses rather than stalling. This asserts we are still under that.
  assert.ok(c.p95 < 1500, `p95 ${c.p95}ms is at the alignment deadline`);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  regime                              correct  wrong  precision  distinct');
for (const [name] of REGIMES) {
  const r = results.get(name);
  if (!r) continue;
  console.log('  ' + name.padEnd(36)
    + String(r.correct).padStart(7)
    + String(r.wrong).padStart(7)
    + ((r.precision * 100).toFixed(1) + '%').padStart(11)
    + String(r.distinct.size).padStart(10));
}
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
