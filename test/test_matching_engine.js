#!/usr/bin/env node
// The public interface, and only the public interface.
//
// Every test here goes through preparePair / matchQuestion / matchAll. That is
// the point of the suite rather than an aesthetic preference: the defect these
// gates exist to close was that a caller could supply its own verification
// facts, so proving the gates hold means exercising them where a caller meets
// them. A test that reached into matchQuestion() would prove nothing about
// whether the product path can be bypassed.
//
// Fixtures are synthetic so the suite runs on a fresh clone. The real-corpus
// figures live in tools/measure-regimes.mjs and tools/measure-pair-matrix.mjs.

import assert from 'node:assert/strict';

import { preparePair } from '../src/pdf/matching-engine.js';
import { PAIR_STATUS, RUNG } from '../src/pdf/decision.js';

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
async function check(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  MatchingEngine — the product interface');
console.log('═══════════════════════════════════════════════════════════════');

// ── fixtures ────────────────────────────────────────────────────────────────
//
// Roles are judged from whether entries WORK the problem, so an answer fixture
// has to actually contain worked solutions. Twenty-four questions clears the
// minimum the role classifier needs to form an opinion at all.

const N = 24;

function makeDoc({ role, year = '2024', subject = 'MA', pages = 40, sparse = false }) {
  const topic = subject === 'MA' ? '极限与连续函数' : '矩阵与行列式';
  // The task verb has to belong to the subject too, or a document asking for a
  // derivative in an algebra chapter reads as MIXED — which correctly declines
  // to claim a conflict, and would make this fixture prove nothing.
  const task = subject === 'MA' ? '求导数' : '求特征值';
  const chapter = subject === 'MA' ? '1' : '2';
  const lines = [];
  const items = [];
  for (let i = 1; i <= N; i++) {
    const page = i + 2;
    const label = `${chapter}.${i}`;
    items.push({ title: `例题 ${label}`, pageNumber: page, children: [] });
    const expr = `f(x)=x^${i}+${i}`;
    if (role === 'ANSWER') {
      lines.push({ page, text: `例题 ${label} (${year}. 某大学). ${task}，${expr}` });
      lines.push({ page, text: `解答：由 ${expr} 可得，因此 答案：${i}x^${i - 1}，所以证毕` });
      lines.push({ page, text: `综上，${topic} 的结论成立，故 得证` });
    } else {
      lines.push({ page, text: `例题 ${label} (${year}. 某大学). ${task}，${expr}` });
      lines.push({ page, text: `其中 ${topic} 为本节内容，${expr} 为待求函数` });
    }
  }
  if (sparse) {
    return {
      numPages: 400,
      outline: { available: true, items: [{ title: topic, pageNumber: 1, children: items }] },
      async extractText() { return lines.slice(0, 4); },
    };
  }
  return {
    numPages: pages,
    outline: { available: true, items: [{ title: `第${chapter}章 ${year} 年${topic}`, pageNumber: 1, children: items }] },
    async extractText({ from, to } = {}) {
      if (from == null && to == null) return lines;
      return lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
    },
  };
}

const EX = () => makeDoc({ role: 'EXERCISE' });
const ANS = () => makeDoc({ role: 'ANSWER' });

// ═══════════════════════════════════════════════════════════════
group('1. Both roles are checked, not just the right-hand one');

await check('a valid exercise -> answer pair prepares', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  assert.notEqual(p.status, PAIR_STATUS.REJECTED_PAIR, p.decision.reasonCodes.join(','));
  assert.ok(p.session, 'a usable pair must open a session');
});

await check('two answer books are rejected on the LEFT role', async () => {
  // The old check looked only at the right-hand document, so every A/A pair
  // walked straight through it.
  const p = await preparePair({ exerciseDocument: ANS(), answerDocument: ANS() });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
  assert.ok(p.decision.reasonCodes.includes('LEFT_ROLE_INVALID'));
  assert.equal(p.session, null, 'a rejected pair must not open a session');
});

await check('two exercise books are rejected on the RIGHT role', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: EX() });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
  assert.ok(p.decision.reasonCodes.includes('RIGHT_ROLE_INVALID'));
});

await check('answer -> exercise, the reversed orientation, is rejected', async () => {
  const p = await preparePair({ exerciseDocument: ANS(), answerDocument: EX() });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
});

// ═══════════════════════════════════════════════════════════════
group('2. Identity conflicts reject; missing identity does not');

await check('a year conflict is a hard rejection', async () => {
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', year: '2023' }),
    answerDocument: makeDoc({ role: 'ANSWER', year: '2025' }),
  });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
  assert.ok(p.decision.reasonCodes.includes('PAIR_IDENTITY_MISMATCH'));
});

await check('a subject conflict is a hard rejection', async () => {
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', subject: 'MA' }),
    answerDocument: makeDoc({ role: 'ANSWER', subject: 'ALG' }),
  });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR);
  assert.ok(p.decision.reasonCodes.includes('PAIR_IDENTITY_MISMATCH'));
});

await check('a rejected pair refuses to match anything at all', async () => {
  const p = await preparePair({ exerciseDocument: ANS(), answerDocument: ANS() });
  assert.equal(p.session, null);
  assert.equal(p.decision.status, RUNG.BLOCKED);
});

// ═══════════════════════════════════════════════════════════════
group('3. A caller cannot forge evidence');

await check('supplying pairStatus does not raise the verdict', async () => {
  // The single most dangerous thing the old interface allowed. matchPage()
  // defaulted pairStatus to VERIFIED_PAIR and accepted whatever a caller passed.
  const p = await preparePair({
    exerciseDocument: ANS(),
    answerDocument: ANS(),
    pairStatus: PAIR_STATUS.VERIFIED_PAIR,
    exactId: true,
    crossBookComparable: true,
  });
  assert.equal(p.status, PAIR_STATUS.REJECTED_PAIR,
    'verification facts are conclusions, never inputs');
});

await check('the session reports the status the engine derived', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  assert.equal(p.session.pairStatus, p.status);
});

// ═══════════════════════════════════════════════════════════════
group('4. Sparse and scanned input fails closed');

await check('a 400-page document with four lines is OCR_REQUIRED', async () => {
  // Ratio-based quality assessment called this USABLE, because the handful of
  // characters present decode perfectly well. Coverage is the missing question.
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', sparse: true }),
    answerDocument: ANS(),
  });
  assert.ok(p.decision.reasonCodes.includes('OCR_REQUIRED'),
    `expected OCR_REQUIRED, got ${p.decision.reasonCodes.join(',')}`);
});

await check('OCR_REQUIRED yields no automatic answer anywhere in the book', async () => {
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', sparse: true }),
    answerDocument: ANS(),
  });
  if (!p.session) return;                       // blocked outright is also acceptable
  const all = await p.session.matchAll();
  const auto = all.matches.filter(m => m.rung === RUNG.AUTO_MATCH);
  assert.equal(auto.length, 0, `${auto.length} automatic answers escaped the OCR gate`);
});

// ═══════════════════════════════════════════════════════════════
group('4b. A recognizer is used, not merely noted');

/** A recognizer that produces indexable pages, the way a real one does. */
/**
 * A recognizer that reproduces what the page actually says.
 *
 * The sparse fixture bookmarks question 1.i on page i+2, and the answer
 * document restates that question before solving it. A recognizer whose output
 * does not correspond to the answer book is not a recognition failure — the
 * pair genuinely is a mismatch, and the engine is right to say so — so the fake
 * has to emit the same question the real page carries.
 */
const workingRecognizer = () => {
  const calls = [];
  const fn = async (page) => {
    calls.push(page);
    const i = page - 2;
    // Every page returns something. A recognizer that reads only the 24
    // bookmarked pages of a 400-page book leaves coverage at 6 percent, and the
    // quality gate is right to keep calling that sparse — recognition has to
    // cover the document, not only the parts already known about.
    if (i < 1 || i > N) {
      return `本页为解答留白区域，第 ${page} 页，无题目内容。`;
    }
    return [
      `例题 1.${i} (2024. 某大学). 求导数，f(x)=x^${i}+${i}`,
      `其中 极限与连续函数 为本节内容，f(x)=x^${i}+${i} 为待求函数`,
    ].join(n);
  };
  fn.calls = calls;
  return fn;
};

await check('a sparse document with no recognizer is never recognised', async () => {
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', sparse: true }),
    answerDocument: ANS(),
  });
  assert.ok(p.decision.reasonCodes.includes('OCR_REQUIRED'));
  assert.equal(p.session?.exerciseIndex.ocr?.attempted ?? false, false,
    'nothing to attempt without a recognizer');
});

await check('a recognizer that returns nothing leaves OCR_REQUIRED set', async () => {
  // The defect this replaced: supplying any truthy recognizer cleared
  // OCR_REQUIRED while the recognizer was never called at all.
  const calls = [];
  const recognizer = async (page) => { calls.push(page); return ''; };
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', sparse: true }),
    answerDocument: ANS(),
    recognizer,
  });
  assert.ok(calls.length > 0, 'the recognizer must actually be called');
  assert.ok(p.decision.reasonCodes.includes('OCR_REQUIRED'),
    'empty recognition is not recognition');
});

await check('a recognizer that throws leaves OCR_REQUIRED set', async () => {
  const recognizer = async () => { throw new Error('recognizer exploded'); };
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', sparse: true }),
    answerDocument: ANS(),
    recognizer,
  });
  assert.ok(p.decision.reasonCodes.includes('OCR_REQUIRED'));
  // A throwing recognizer must not take the process with it.
  assert.ok(p.session || p.decision, 'preparation survived the failure');
});

await check('successful recognition clears OCR_REQUIRED and yields an index', async () => {
  const recognizer = workingRecognizer();
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', sparse: true }),
    answerDocument: ANS(),
    recognizer,
  });
  assert.ok(recognizer.calls.length > 0, 'the recognizer must be called');
  assert.equal(p.decision.reasonCodes.includes('OCR_REQUIRED'), false,
    `still OCR_REQUIRED: ${p.decision.reasonCodes.join(',')}`);
  assert.equal(p.session.exerciseIndex.textOrigin, 'OCR',
    'recognised text must be labelled as such');
  assert.ok(p.session.exerciseIndex.entries.length > 0,
    'recognised pages must produce questions');
});

await check('recognised pages keep their line structure', async () => {
  // Joining a page's lines into one string puts the running head at the start,
  // where every label parser is anchored — measured, that turned 400
  // successfully recognised pages into zero indexed questions.
  const recognizer = workingRecognizer();
  const p = await preparePair({
    exerciseDocument: makeDoc({ role: 'EXERCISE', sparse: true }),
    answerDocument: ANS(),
    recognizer,
  });
  const labels = p.session.exerciseIndex.entries.map(e => e.label);
  assert.ok(labels.some(l => /^1\.\d+$/.test(l)),
    `no hierarchical label survived recognition: ${labels.slice(0, 5).join(', ')}`);
});

// ═══════════════════════════════════════════════════════════════
group('4c. A region the adapter cannot honour withholds the answer');

/**
 * A whole book where questions 1.1 and 1.2 share ONE page.
 *
 * The failure this guards is specifically a multi-question page: a caller taps
 * one of two questions, the adapter cannot localise the tap, and the engine
 * hands back confident answers for both. One question per page cannot express
 * that, so the fixture puts 1.1 and 1.2 on the same page.
 *
 * It has to be a whole book, not a two-question stub. A stub cannot reach this
 * code at all — the role classifier withholds a verdict below 20 entries, and
 * four lines across ten pages is a sparse layer that returns OCR_REQUIRED. Both
 * gates fire before matching, and a fixture that trips them tests them instead
 * of the region.
 */
function sharedPageBook({ geometry }) {
  const lines = [];
  const items = [];
  const push = (page, text, y) => lines.push(
    geometry ? { page, text, y, height: 18 } : { page, text },
  );

  for (let i = 1; i <= N; i++) {
    // 1.1 and 1.2 both sit on page 3, one near the top and one far below it.
    const page = i <= 2 ? 3 : i + 2;
    const base = i === 2 ? 400 : 0;
    items.push({ title: `例题 1.${i}`, pageNumber: page, children: [] });
    push(page, `例题 1.${i} (2024. 某大学). 求导数，f(x)=x^${i}+${i}`, base);
    push(page, `其中 极限与连续函数 为本节内容，f(x)=x^${i}+${i} 为待求函数`, base + 20);
  }

  return {
    numPages: 40,
    outline: {
      available: true,
      items: [{ title: '第1章 2024 年极限与连续函数', pageNumber: 1, children: items }],
    },
    async extractText({ from, to } = {}) {
      if (from == null && to == null) return lines;
      return lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
    },
  };
}


await check('two questions on one page: an unlocalisable tap downgrades BOTH', async () => {
  const p = await preparePair({
    exerciseDocument: sharedPageBook({ geometry: false }),
    answerDocument: ANS(),
  });
  const plain = await p.session.matchQuestion({ page: 3 });
  assert.equal(plain.length, 2, `expected two questions, got ${plain.length}`);
  assert.ok(plain.some(m => m.rung === RUNG.AUTO_MATCH),
    'without a region the page must still answer');

  const tapped = await p.session.matchQuestion({ page: 3, region: { top: 0, bottom: 30 } });
  assert.equal(tapped.length, 2, 'the candidates are still returned');
  for (const m of tapped) {
    assert.equal(m.rung, RUNG.REVIEW, `${m.question?.label} kept rung ${m.rung}`);
    assert.equal(m.matched, false, `${m.question?.label} still reports matched`);
    assert.equal(m.asserted, false, `${m.question?.label} still reports asserted`);
    assert.equal(m.cappedBy, 'REGION_UNSUPPORTED_BY_ADAPTER',
      `${m.question?.label} cappedBy was ${m.cappedBy}`);
    assert.equal(m.regionApplied, false);
  }
});

await check('with geometry, a tap selects one of the two and still answers', async () => {
  const p = await preparePair({
    exerciseDocument: sharedPageBook({ geometry: true }),
    answerDocument: ANS(),
  });
  const top = await p.session.matchQuestion({ page: 3, region: { top: 0, bottom: 40 } });
  assert.equal(top.length, 1, `a localised tap must select one question, got ${top.length}`);
  assert.equal(top[0].question.label, '1.1');
  assert.equal(top[0].regionApplied, true);

  const bottom = await p.session.matchQuestion({ page: 3, region: { top: 395, bottom: 450 } });
  assert.equal(bottom.length, 1);
  assert.equal(bottom[0].question.label, '1.2');
});

await check('a tap that selects nothing says REGION_EMPTY, not "no questions here"', async () => {
  // These mean different things to a caller: tap again, versus look elsewhere.
  const p = await preparePair({
    exerciseDocument: sharedPageBook({ geometry: true }),
    answerDocument: ANS(),
  });
  const empty = await p.session.matchQuestion({ page: 3, region: { top: 900, bottom: 1000 } });
  assert.equal(empty.length, 1);
  assert.equal(empty[0].cappedBy, 'REGION_EMPTY',
    `empty tap reported ${empty[0].cappedBy}`);
  assert.equal(empty[0].regionApplied, true, 'the region WAS applied; it simply hit nothing');
  assert.equal(empty[0].matched, false);
});

await check('a page with no questions still reports NO_QUESTION_LEVEL_INDEX', async () => {
  // Page 1, ahead of the first question. A late page will not do: the final
  // entry's span runs to the end of the book, so every trailing page still
  // carries a question and is correctly reported as such.
  const p = await preparePair({
    exerciseDocument: sharedPageBook({ geometry: true }),
    answerDocument: ANS(),
  });
  const none = await p.session.matchQuestion({ page: 1, region: { top: 0, bottom: 50 } });
  assert.equal(none[0].cappedBy, 'NO_QUESTION_LEVEL_INDEX',
    `page without questions reported ${none[0].cappedBy}`);
});

await check('a region is only capped when one was actually requested', async () => {
  // Batch and whole-book flows pass no region and must be unaffected.
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  const all = await p.session.matchAll();
  assert.ok(all.matches.some(m => m.rung === RUNG.AUTO_MATCH),
    'matchAll must still produce automatic answers');
});


// ═══════════════════════════════════════════════════════════════
group('5. The rung ladder is honoured end to end');

await check('a verified pair produces automatic answers', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  const all = await p.session.matchAll();
  const auto = all.matches.filter(m => m.rung === RUNG.AUTO_MATCH);
  assert.ok(auto.length > 0, 'the capability must survive the gates');
});

await check('every automatic answer carries an entry, and no other rung does', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  const all = await p.session.matchAll();
  for (const m of all.matches) {
    if (m.rung === RUNG.AUTO_MATCH) {
      assert.ok(m.entry, 'an automatic answer must name its entry');
      assert.equal(m.matched, true);
    } else {
      assert.equal(m.matched, false,
        `${m.rung} must not report matched=true; that is how a guess reaches a reader`);
    }
  }
});

await check('a result below AUTO_MATCH always says why', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  const all = await p.session.matchAll();
  for (const m of all.matches) {
    if (m.rung === RUNG.AUTO_MATCH) continue;
    assert.ok(m.cappedBy || m.reasonCodes?.length || m.reason,
      'a capped result that cannot say why has not recorded its reasoning');
  }
});

await check('matchQuestion and matchAll agree on the same page', async () => {
  const p = await preparePair({ exerciseDocument: EX(), answerDocument: ANS() });
  const all = await p.session.matchAll();
  const first = all.matches.find(m => m.question);
  const one = await p.session.matchQuestion({ page: first.question.page });
  assert.equal(one[0].rung, all.matches.find(
    m => m.question?.label === one[0].question?.label).rung,
    'single-question and whole-book flows must apply the same rules');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(FAIL > 0 ? 1 : 0);
