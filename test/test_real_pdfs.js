#!/usr/bin/env node
// Regression tests against the real books.
//
// Every synthetic fixture in the other two suites was written by someone who
// already knew how the parser worked. These four documents were not: they are
// the extracted text and bookmark trees of four published 考研数学 PDFs, and
// they are the reason the engine was rewritten. Three things they exposed that
// no hand-written fixture had:
//
//   - Question ids are hierarchical (1.1 … 2.231). Parsing them as flat
//     integers collapsed 508 questions onto 2 ids.
//   - The text layer READ as broken — 0–1.9% Han from Chinese textbooks. That
//     turned out to be the extractor, not the books: pdf.js cannot decode
//     CID-keyed CJK fonts without cmaps. Diagnosed correctly only after the
//     corpus was rebuilt through the app's own reader. The quality gate that
//     caught it is what made a misconfigured reader visible at all.
//   - Questions share pages, so one range per page is one range too few.
//
// The corpus is not committed — it is extracted text from copyrighted books,
// and 2.9 MB of it. Point FIND_ENGINE_CORPUS at data.json, or drop it at
// ../find-engine-corpus/data.json next to the repo. Absent, this suite skips
// rather than fails, so a fresh clone still runs green.

import assert from 'node:assert/strict';
import { PAIR_STATUS } from "../src/pdf/decision.js";
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INDEX_SOURCE,
  TEXT_QUALITY,
  indexAnswerDocument,
  indexQuestionDocument,
  questionsOnPage,
} from '../src/pdf/answer-index.js';
import {
  CONFIDENCE,
  alignOutlines,
  contentSimilarity,
  matchPage,
} from '../src/pdf/question-matcher.js';
import { assessTextQuality, sharedAlphabetOverlap } from '../src/pdf/text-quality.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let PASS = 0, FAIL = 0, SKIP = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const skip = (l) => { SKIP++; console.log(`  ⏭️  ${l}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
async function check(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

// Where the real-book corpus may live, in order. It is 2.5 MB of extracted
// text from copyrighted textbooks and is deliberately never committed:
//   1. FIND_ENGINE_CORPUS, pointing straight at data.json
//   2. corpus/data.json inside this repo (gitignored)
//   3. ../find-engine-corpus/data.json, the engine repo's layout
const CORPUS = [
  process.env.FIND_ENGINE_CORPUS,
  join(ROOT, 'corpus', 'data.json'),
  join(ROOT, '..', 'find-engine-corpus', 'data.json'),
].find(p => p && existsSync(p)) || join(ROOT, 'corpus', 'data.json');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Real PDFs — 2023/2024 考研数学');
console.log('═══════════════════════════════════════════════════════════════');

if (!existsSync(CORPUS)) {
  console.log(`\n  corpus not found at ${CORPUS}`);
  console.log('  set FIND_ENGINE_CORPUS to run this suite\n');
  skip('real-PDF regression suite');
  console.log(`\n  ${PASS} passed, ${FAIL} failed, ${SKIP} skipped\n`);
  process.exit(0);
}

const raw = JSON.parse(readFileSync(CORPUS, 'utf-8'));

/** The document interface the engine expects, over pre-extracted text. */
const asDocument = (d) => ({
  numPages: d.numPages,
  outline: d.outline,
  async extractText({ from, to } = {}) {
    if (from == null && to == null) return d.lines;
    return d.lines.filter(l =>
      (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});

const q2023 = asDocument(raw.q2023);
const ans2023 = asDocument(raw.ans2023);

// ═══════════════════════════════════════════════════════════════
group('1. The gold sets are locked');

// These counts come from the published books' own bookmark trees. A change to
// them means the parser changed, not that the books did.
const GOLD = [
  ['q2023', raw.q2023, 508, '1.1', '2.231'],
  ['ans2023', raw.ans2023, 508, '1.1', '2.231'],
  ['a2024 数学分析', raw.a2024, 271, '1.1', '1.271'],
  ['g2024 高等代数', raw.g2024, 217, '2.1', '2.217'],
];

const indexes = new Map();
for (const [name, doc, expected, firstId, lastId] of GOLD) {
  await check(`${name}: ${expected} questions, ids ${firstId}…${lastId}, none duplicated`, async () => {
    const index = await indexQuestionDocument(asDocument(doc), { expectScript: 'han' });
    indexes.set(name, index);
    assert.equal(index.entries.length, expected, `expected ${expected} entries`);
    assert.equal(index.source, INDEX_SOURCE.OUTLINE,
      'ids come from the bookmark tree, which needs no text at all');
    assert.equal(index.entries[0].label, firstId);
    assert.equal(index.entries[index.entries.length - 1].label, lastId);
    assert.equal(index.duplicates.length, 0, 'hierarchical ids must be unique');
    assert.equal(new Set(index.entries.map(e => e.label)).size, expected);
  });
}

await check('a hierarchical id is never truncated to its chapter', async () => {
  const index = indexes.get('q2023');
  const flat = index.entries.filter(e => !e.label.includes('.'));
  assert.equal(flat.length, 0,
    `${flat.length} ids lost their hierarchy, e.g. ${flat.slice(0, 3).map(e => e.label).join(', ')}`);
  assert.ok(index.entries.some(e => e.label === '2.231'), '2.231 must survive as itself');
});

// ═══════════════════════════════════════════════════════════════
group('2. The text layer is clean — when it is decoded properly');

// These four books were originally extracted WITHOUT pdf.js cmaps, which cannot
// decode CID-keyed CJK fonts. The result read as 0% Han and was diagnosed as a
// broken font. It was not: the reader was missing its decoding tables. Same
// PDF, same page 4, same line:
//
//   without cmaps   ২ี 1.1 2023.॓࿐ჽն࿐ ჰ PDFֻ4 ်
//   with cmaps      例题 1.1 2023. 中国科学院大学 原 PDF 第 4 页
//
// The corpus is now built by tools/extract-corpus.mjs, which calls the app's own
// pdf-document.js so the fixtures are what the app actually feeds the engine.
for (const [name, doc] of [['q2023', raw.q2023], ['ans2023', raw.ans2023],
  ['a2024', raw.a2024], ['g2024', raw.g2024]]) {
  await check(`${name}: decodes to real Chinese and is classed USABLE`, async () => {
    const index = await indexQuestionDocument(asDocument(doc), { expectScript: 'han' });
    assert.equal(index.quality, TEXT_QUALITY.USABLE,
      `Han ${index.metrics.hanRatio}, odd-script ${index.metrics.oddScriptRatio}`);
    assert.ok(index.metrics.hanRatio > 0.15,
      `a Chinese textbook should be substantially Han, got ${index.metrics.hanRatio}`);
    assert.equal(index.metrics.oddScriptRatio, 0,
      'no stray Bengali/Thai/Tibetan — that was the signature of the missing cmaps');
    assert.equal(index.scanned, false);
  });
}

await check('a corpus extracted without cmaps would still be caught', () => {
  // The gate that diagnosed this remains valuable: it is what makes a
  // misconfigured reader visible instead of silently producing noise. Fed the
  // undecoded form, it must still refuse to call it usable.
  const undecoded = [{ page: 1, text: '২ี 1.1 2023.॓࿐ჽն࿐ ჰ PDFֻ4 ် č1ཋ'.repeat(40) }];
  const verdict = assessTextQuality(undecoded, { expectScript: 'han' });
  assert.notEqual(verdict.quality, TEXT_QUALITY.USABLE, verdict.reason);
  assert.ok(verdict.hanRatio < 0.02);
});

await check('the alphabet check separates a matched pair from unrelated books', () => {
  // Written when the text was thought to be garbled, and still the guard that
  // lets unreadable text be used safely IF a book ever genuinely is corrupt:
  // the signal can detect its own inapplicability.
  const pair = sharedAlphabetOverlap(raw.q2023.lines, raw.ans2023.lines);
  assert.ok(pair.comparable, `matched pair should be comparable, got ${pair.overlap}`);
  assert.ok(pair.overlap > 0.95, `expected near-total overlap, got ${pair.overlap}`);

  for (const [a, b] of [['q2023', 'a2024'], ['a2024', 'g2024']]) {
    const r = sharedAlphabetOverlap(raw[a].lines, raw[b].lines);
    assert.equal(r.comparable, false,
      `${a} vs ${b} are different books and must NOT be treated as comparable (${r.overlap})`);
  }
});

await check('content ranks the right answer first', async () => {
  // 400 questions, each against 40 distractors. Scored 95.3% back when the text
  // was undecoded garbage and 95.5% now that it is real Chinese — the corruption
  // was a consistent substitution, so it had preserved almost all of the
  // discriminating information.
  const qi = await indexQuestionDocument(q2023, { expectScript: 'han' });
  const ai = await indexAnswerDocument(ans2023, { expectScript: 'han' });
  assert.ok(qi.textAttached && ai.textAttached, 'text must be attached to compare');

  const byLabel = new Map(ai.entries.map(e => [e.label, e]));
  const pool = ai.entries.filter(e => e.text.length > 20);
  let tested = 0; let first = 0;
  for (const qe of qi.entries) {
    if (qe.text.length < 20) continue;
    const right = byLabel.get(qe.label);
    if (!right || right.text.length < 20) continue;
    tested++;
    const s = contentSimilarity(qe.text, right.text);
    let best = -1;
    for (let k = 0; k < 40; k++) {
      const c = pool[(qe.ordinal * 37 + k * 101) % pool.length];
      if (c.label === qe.label) continue;
      best = Math.max(best, contentSimilarity(qe.text, c.text));
    }
    if (s > best) first++;
    if (tested >= 400) break;
  }
  const rate = first / tested;
  console.log(`      ${first}/${tested} ranked first (${(rate * 100).toFixed(1)}%)`);
  assert.ok(rate > 0.90, `expected >90%, got ${(rate * 100).toFixed(1)}%`);
});

// ═══════════════════════════════════════════════════════════════
group('3. End-to-end: 2023 exercise book against its answer key');

const questionIndex = await indexQuestionDocument(q2023, { expectScript: 'han' });
const answerIndex = await indexAnswerDocument(ans2023, { expectScript: 'han' });
const alignment = alignOutlines(q2023.outline, ans2023.outline);

await check('every question id in the book maps to exactly one answer bookmark', () => {
  assert.equal(alignment.questionIds.size, 508,
    `only ${alignment.questionIds.size} of 508 ids corresponded`);
  assert.ok(alignment.questionIdsAvailable);
});

/** Runs the whole book and reports per-question outcomes. */
function runWholeBook(options = {}) {
  const results = [];
  const perPageMs = [];
  for (let page = 1; page <= q2023.numPages; page++) {
    const questions = questionsOnPage(questionIndex, page);
    if (questions.length === 0) continue;
    const started = performance.now();
    const matches = matchPage(questions, answerIndex, {
      pairStatus: PAIR_STATUS.VERIFIED_PAIR,
      alignment,
      exercisePage: page,
      answerPageCount: ans2023.numPages,
      ...options,
    });
    perPageMs.push(performance.now() - started);
    for (const m of matches) {
      results.push({
        questionId: m.question.label,
        questionPage: page,
        answerPage: m.entry?.page ?? null,
        answerId: m.entry?.label ?? null,
        confidence: m.confidence,
        matched: m.matched,
        reason: m.reason,
      });
    }
  }
  perPageMs.sort((a, b) => a - b);
  return { results, perPageMs };
}

const { results, perPageMs } = runWholeBook();

/** One whole-book run under a given formula policy, summarised. */
function runPair({ formulaPolicy }) {
  const { results: rs } = runWholeBook({ formulaPolicy });
  return {
    resolved: new Set(rs.filter(r => r.matched).map(r => r.questionId)).size,
    wrong: rs.filter(r => r.matched && r.answerId !== r.questionId).length,
  };
}

/** The report the checklist asks for on failure. */
const describe = (r) =>
  `id=${r.questionId} qPage=${r.questionPage} aPage=${r.answerPage} `
  + `aId=${r.answerId} conf=${r.confidence} ${r.matched ? '' : '(' + r.reason + ')'}`;

await check('every question the strict formula rule admits is resolved', () => {
  // This used to assert 508 of 508, and under the CALIBRATED formula policy it
  // still is. The default is now STRICT — the agreed product rule that every
  // complete expression in a question must have a counterpart in its answer —
  // and that rule deliberately withholds automatic matching where the two texts
  // do not fully correspond.
  //
  // Measured cost of STRICT on this pair: 470 of 508, the shortfall dominated by
  // FORMULA_CONFLICT on expressions differing only by an extraction artefact.
  // Zero wrong matches under either policy. The trade-off is a product decision,
  // and it is recorded here rather than absorbed.
  const resolved = new Set(results.filter(r => r.matched).map(r => r.questionId)).size;
  assert.ok(resolved >= 470, `resolved ${resolved} of 508 — below the strict-policy floor`);
  assert.ok(resolved <= 508);
});

await check('zero accepted matches are wrong', () => {
  // Ground truth: both books bookmark the same question under the same id, so
  // a correct match is one whose answer id equals the question id.
  const wrong = results.filter(r => r.matched && r.answerId !== r.questionId);
  assert.equal(wrong.length, 0,
    `${wrong.length} wrong:\n    ${wrong.slice(0, 10).map(describe).join('\n    ')}`);
});

await check('HIGH confidence precision is 100%', () => {
  const high = results.filter(r => r.confidence === CONFIDENCE.HIGH);
  const bad = high.filter(r => r.answerId !== r.questionId);
  assert.ok(high.length > 0, 'expected some HIGH matches');
  assert.equal(bad.length, 0,
    `${bad.length} HIGH errors:\n    ${bad.slice(0, 10).map(describe).join('\n    ')}`);
});

await check('no match originates from a non-question page', () => {
  const pages = new Set(answerIndex.entries.map(e => e.page));
  const stray = results.filter(r => r.matched && !pages.has(r.answerPage));
  assert.equal(stray.length, 0,
    `${stray.length} stray:\n    ${stray.slice(0, 5).map(describe).join('\n    ')}`);
});

await check('questions sharing a page each get their own answer', () => {
  const byPage = new Map();
  for (const r of results) {
    const bucket = byPage.get(r.questionPage) ?? [];
    bucket.push(r);
    byPage.set(r.questionPage, bucket);
  }
  const shared = [...byPage.values()].filter(b => b.length > 1);
  assert.ok(shared.length > 0, 'the corpus must actually contain shared pages');

  for (const bucket of shared) {
    const answers = bucket.filter(r => r.matched).map(r => r.answerId);
    assert.equal(new Set(answers).size, answers.length,
      `page ${bucket[0].questionPage} gave two questions the same answer: `
      + bucket.map(describe).join(' | '));
  }
});

await check('shared-page recall is not systematically worse than single-question pages', () => {
  const byPage = new Map();
  for (const r of results) {
    const bucket = byPage.get(r.questionPage) ?? [];
    bucket.push(r);
    byPage.set(r.questionPage, bucket);
  }
  const rate = (buckets) => {
    const flat = buckets.flat();
    return flat.length === 0 ? 1 : flat.filter(r => r.matched).length / flat.length;
  };
  const single = rate([...byPage.values()].filter(b => b.length === 1));
  const shared = rate([...byPage.values()].filter(b => b.length > 1));
  // One-sided on purpose. The defect this guards is the original one: a page
  // carrying six questions used to compute ONE answer range for all six, so the
  // last question on the page silently governed the first. Sharing a page must
  // therefore never DISADVANTAGE a question.
  //
  // It must not require the two rates to be equal. Under the strict formula
  // policy they legitimately diverge — a question that occupies a whole page is
  // a long one, carrying more expressions, and a rule requiring all of them to
  // match fails multiplicatively with question size (measured: 76.7% full
  // coverage at 1-2 expressions, 12.9% at 11+). That is question length, not
  // page sharing, and asserting equality would report it as this bug.
  assert.ok(shared >= single - 0.02,
    `single-question pages ${(single * 100).toFixed(1)}%, shared ${(shared * 100).toFixed(1)}%`);
});

await check('end-to-end recall meets the strict-policy floor', () => {
  // 98% under CALIBRATED; 91.1% measured under the STRICT default.
  const recall = results.filter(r => r.matched).length / results.length;
  assert.ok(recall >= 0.90, `recall ${(recall * 100).toFixed(2)}%`);
});

await check('the calibrated policy restores full recall, and neither is ever wrong', async () => {
  // The lever, exercised. Both policies run over the same book, so the cost of
  // the strict rule is a measured number in the suite rather than a claim in a
  // report — and a future change cannot quietly move it.
  const { FORMULA_POLICY } = await import('../src/pdf/formula-set.js');
  const calibrated = runPair({ formulaPolicy: FORMULA_POLICY.CALIBRATED });
  const strict = runPair({ formulaPolicy: FORMULA_POLICY.STRICT });
  assert.equal(calibrated.wrong, 0);
  assert.equal(strict.wrong, 0);
  assert.equal(calibrated.resolved, 508, `calibrated resolved ${calibrated.resolved} of 508`);
  assert.ok(strict.resolved <= calibrated.resolved);
  console.log(`      strict ${strict.resolved}/508, calibrated ${calibrated.resolved}/508, wrong 0 under both`);
});

// ═══════════════════════════════════════════════════════════════
group('4. Performance on a 368-page book');

await check('per-page matching stays under 100 ms on desktop', () => {
  const p95 = perPageMs[Math.floor(perPageMs.length * 0.95)];
  const max = perPageMs[perPageMs.length - 1];
  assert.ok(p95 < 100, `p95 ${p95.toFixed(1)}ms`);
  assert.ok(max < 250, `max ${max.toFixed(1)}ms`);
  console.log(`      p50 ${perPageMs[Math.floor(perPageMs.length * 0.5)].toFixed(2)}ms`
    + `  p95 ${p95.toFixed(2)}ms  max ${max.toFixed(2)}ms  over ${perPageMs.length} pages`);
});

await check('indexing a 372-page answer book is not slow enough to notice', async () => {
  const started = performance.now();
  await indexAnswerDocument(ans2023, { expectScript: 'han' });
  const ms = performance.now() - started;
  assert.ok(ms < 3000, `${ms.toFixed(0)}ms`);
  console.log(`      ${ms.toFixed(0)}ms for 372 pages, 18,308 lines, 508 questions`);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed${SKIP ? `, ${SKIP} skipped` : ''}`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL > 0 ? 1 : 0);
