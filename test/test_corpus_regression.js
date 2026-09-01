#!/usr/bin/env node
// The three scenarios that decide whether this engine is safe to ship, run
// against the real corpus through the public interface only.
//
//   1. With bookmarks      — matches are expected, and must all be correct.
//   2. Without bookmarks   — degraded structure must never produce a wrong answer,
//                            and must never reject a pair that is actually valid.
//   3. Invalid pairs       — answer/exercise mismatch, answer/answer, exercise/
//                            exercise. None may produce an automatic answer.
//
// These lived in tools/ as measurement scripts, which meant `npm test` never ran
// them and a regression could land unnoticed. They are assertions now.
//
// ── two independent oracles ──
//
// Correctness is checked twice, by evidence that does not share a failure mode.
//
//   STRUCTURAL   the two bookmark trees. Label agrees, the exercise page falls
//                inside the gold question span, the answer page falls inside the
//                gold answer span. Independent of the text layer.
//
//   CONTENT      the answer's own printed body carries the question's label —
//                "例题 1.6 ..." appears in the text of the entry claimed for 1.6.
//                Independent of the bookmark trees.
//
// Measured separation for the content oracle over all three valid pairs: the
// true label appears in 100.0% / 99.6% / 99.5% of correct answers, and a
// DIFFERENT question's label appears in 0.0% of them. Requiring both oracles
// means a silently mis-built bookmark tree cannot certify a wrong match, and
// neither can a coincidence of body text.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOutlineIndex } from '../src/pdf/answer-index.js';
import { PAIR_STATUS, RUNG } from '../src/pdf/decision.js';
import { FORMULA_POLICY } from '../src/pdf/formula-set.js';
import { preparePair } from '../src/pdf/matching-engine.js';
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

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Corpus regression — bookmarks, no bookmarks, invalid pairs');
console.log('═══════════════════════════════════════════════════════════════');

// The expanded corpus, in order of preference. Like the base corpus it is
// extracted from copyrighted textbooks and is never committed.
const CORPUS = [
  process.env.FIND_ENGINE_EXPANDED_CORPUS,
  join(ROOT, 'corpus', 'expanded-corpus.json'),
  join(ROOT, 'tmp', 'expanded-corpus-20260825.json'),
].find(p => p && existsSync(p)) || join(ROOT, 'corpus', 'expanded-corpus.json');

if (!existsSync(CORPUS)) {
  console.log(`\n  corpus not found at ${CORPUS}`);
  console.log('  set FIND_ENGINE_EXPANDED_CORPUS to run this suite\n');
  SKIP++;
  console.log(`  ${PASS} passed, ${FAIL} failed, ${SKIP} skipped\n`);
  process.exit(0);
}

const raw = JSON.parse(readFileSync(CORPUS, 'utf-8'));

/** Ground truth from the two bookmark trees. Never reads the text layer. */
const outlineIndex = (d) => buildOutlineIndex(d.outline, d.lines, {
  numPages: d.numPages, quality: TEXT_QUALITY.USABLE,
});

function structuralTruth(qKey, aKey) {
  const q = outlineIndex(raw[qKey]);
  const a = outlineIndex(raw[aKey]);
  const answers = new Map(a.entries.map(e => [e.label, e]));
  const truth = new Map();
  for (const qe of q.entries) {
    const ae = answers.get(qe.label);
    if (ae) truth.set(qe.label, { qFrom: qe.page, qTo: qe.endPage, aFrom: ae.page, aTo: ae.endPage });
  }
  return truth;
}

/** The answer's printed body carries the question's own label. */
const labelPrinted = (text, label) =>
  new RegExp(`例\\s*题\\s*${String(label).replace(/\./g, '\\.')}(?![0-9])`).test(String(text ?? ''));

const asDoc = (d, keepOutline = true) => ({
  numPages: d.numPages,
  outline: keepOutline ? d.outline : { available: false, items: [] },
  async extractText({ from, to } = {}) {
    if (from == null && to == null) return d.lines;
    return d.lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});

// strictFloor: measured recall under the agreed all-expressions rule. Zero wrong
// under either policy; the floor exists so a regression cannot quietly lower it.
const VALID = [
  { name: '2023', q: 'q2023', a: 'ans2023', gold: 508, strictFloor: 470 },
  { name: '2024 Math Analysis', q: 'a2024', a: 'a2024_ma', gold: 271, strictFloor: 159 },
  { name: '2024 Adv Algebra', q: 'g2024', a: 'a2024_alg', gold: 217, strictFloor: 175 },
];

const ROLES = {
  q2023: 'EX', a2024: 'EX', g2024: 'EX', q2025: 'EX',
  ans2023: 'ANS', a2024_ma: 'ANS', a2024_alg: 'ANS', a2025: 'ANS',
};
const VALID_KEYS = new Set(VALID.map(p => `${p.q}|${p.a}`).concat(['q2025|a2025']));

/** Runs a pair and scores every accepted result against BOTH oracles. */
async function runPair({
  q, a, qBookmarks = true, aBookmarks = true, stride = 1, formulaPolicy,
}) {
  const truth = structuralTruth(q, a);
  const qDoc = asDoc(raw[q], qBookmarks);
  const aDoc = asDoc(raw[a], aBookmarks);

  const prepared = await preparePair({
    exerciseDocument: qDoc, answerDocument: aDoc, expectScript: 'han', formulaPolicy,
  });

  const r = {
    status: prepared.status,
    reasons: prepared.decision.reasonCodes,
    auto: 0, structuralOk: 0, contentOk: 0, bothOk: 0,
    wrong: 0, unidentifiable: 0, contentSilent: 0, contentContradicted: 0,
    distinct: new Set(), gold: truth.size, pagesRun: 0,
  };
  if (!prepared.session) return r;

  for (let page = 1; page <= qDoc.numPages; page += stride) {
    const matches = await prepared.session.matchQuestion({ page });
    r.pagesRun++;
    for (const m of matches) {
      if (m.rung !== RUNG.AUTO_MATCH) continue;
      r.auto++;

      const t = truth.get(m.question?.label);
      const structural = !!t && page >= t.qFrom && page <= t.qTo
        && m.entry?.page >= t.aFrom && m.entry?.page <= t.aTo;
      const content = labelPrinted(m.entry?.text, m.question?.label);

      if (!t || page < t.qFrom || page > t.qTo) { r.unidentifiable++; continue; }
      if (structural) { r.structuralOk++; r.distinct.add(m.question.label); } else r.wrong++;
      if (content) r.contentOk++;
      if (structural && content) r.bothOk++;

      // A disagreement is one of two very different things, and conflating them
      // would either hide a real error or fail on a known limitation.
      //
      //   SILENT       structure confirms, the printed label is simply absent
      //                from the entry's text. Entry text is a PAGE RANGE, so an
      //                entry whose own heading fell outside its extracted range
      //                cannot carry it. Measured: 2 of 470 and 2 of 413 in 2024.
      //
      //   CONTRADICTED content positively identifies the entry as belonging to a
      //                different question than structure claims. That is a real
      //                conflict and no match may survive it.
      if (structural && !content) r.contentSilent++;
      if (!structural && content) r.contentContradicted++;
    }
  }
  return r;
}

// ═══════════════════════════════════════════════════════════════
group('1. With bookmarks — matches are expected and must be right');

for (const pair of VALID) {
  await check(`${pair.name}: full recall under the calibrated policy, zero wrong`, async () => {
    // The capability, unchanged: every question resolves and none is wrong.
    const r = await runPair({ q: pair.q, a: pair.a, formulaPolicy: FORMULA_POLICY.CALIBRATED });
    assert.equal(r.status, PAIR_STATUS.VERIFIED_PAIR, `status ${r.status}`);
    assert.equal(r.wrong, 0, `${r.wrong} wrong automatic answers`);
    assert.equal(r.unidentifiable, 0, `${r.unidentifiable} accepts no oracle can confirm`);
    assert.equal(r.distinct.size, pair.gold, `unique recall ${r.distinct.size}/${pair.gold}`);
  });

  await check(`${pair.name}: the strict formula rule costs recall and never precision`, async () => {
    // The agreed product rule — every complete expression in the question must
    // have a counterpart — is the default. It withholds automatic matching where
    // the two texts do not fully correspond, and that is measured here rather
    // than asserted in a report: the floor is what the corpus produced, and zero
    // wrong is the property that must never move.
    const strict = await runPair({ q: pair.q, a: pair.a, formulaPolicy: FORMULA_POLICY.STRICT });
    assert.equal(strict.status, PAIR_STATUS.VERIFIED_PAIR, `status ${strict.status}`);
    assert.equal(strict.wrong, 0, `${strict.wrong} wrong automatic answers`);
    assert.equal(strict.unidentifiable, 0, `${strict.unidentifiable} unconfirmable accepts`);
    assert.ok(strict.distinct.size <= pair.gold);
    assert.ok(strict.distinct.size >= pair.strictFloor,
      `strict recall ${strict.distinct.size}/${pair.gold}, below the measured floor ${pair.strictFloor}`);
    console.log(`      strict ${strict.distinct.size}/${pair.gold}`
      + ` (${((strict.distinct.size / pair.gold) * 100).toFixed(1)}%), 0 wrong`);
  });

  await check(`${pair.name}: content oracle never contradicts the bookmarks`, async () => {
    const r = await runPair({ q: pair.q, a: pair.a, formulaPolicy: FORMULA_POLICY.CALIBRATED });
    assert.ok(r.auto > 0, 'no matches to check');

    // The two oracles share no failure mode, so a CONTRADICTION would mean one
    // of them is wrong and the match cannot be trusted either way. This is the
    // assertion that matters, and it is absolute.
    assert.equal(r.contentContradicted, 0,
      `${r.contentContradicted} matches where the printed text names a different question`);

    // Silence is tolerated at its measured rate, and only at that rate. An entry
    // whose text is a page range cannot always carry its own heading; measured
    // across the three valid pairs the printed label is present in 100.0%,
    // 99.6% and 99.5% of correct answers. Below 99% something else is wrong.
    const agreement = r.contentOk / r.auto;
    assert.ok(agreement >= 0.99,
      `printed-label confirmation ${(agreement * 100).toFixed(1)}% `
      + `(${r.contentSilent} silent of ${r.auto})`);
  });
}

// ═══════════════════════════════════════════════════════════════
group('2. Without bookmarks — degrade, never guess, never reject a valid pair');

const DEGRADED = [
  { label: 'answer key has none', qBookmarks: true, aBookmarks: false },
  { label: 'exercise book has none', qBookmarks: false, aBookmarks: true },
  { label: 'neither has any', qBookmarks: false, aBookmarks: false },
];

for (const pair of VALID) {
  for (const regime of DEGRADED) {
    await check(`${pair.name} / ${regime.label}: no wrong answer, pair not rejected`, async () => {
      const r = await runPair({
        q: pair.q, a: pair.a,
        qBookmarks: regime.qBookmarks, aBookmarks: regime.aBookmarks,
        stride: 8,
      });
      // A valid pair must never be REJECTED merely because a bookmark tree is
      // missing. Three separate false rejections of this kind were found and
      // fixed; this is the guard against a fourth.
      assert.notEqual(r.status, PAIR_STATUS.REJECTED_PAIR,
        `valid pair rejected: ${r.reasons.join(',')}`);
      assert.equal(r.wrong, 0, `${r.wrong} wrong automatic answers`);
      assert.equal(r.unidentifiable, 0,
        `${r.unidentifiable} accepts no oracle can confirm`);
      assert.equal(r.contentContradicted, 0,
        `${r.contentContradicted} matches where printed text names a different question`);
    });
  }
}

await check('the scanned 2025 exercise book returns OCR_REQUIRED in every regime', async () => {
  for (const [qb, ab] of [[true, true], [true, false], [false, true], [false, false]]) {
    const r = await runPair({ q: 'q2025', a: 'a2025', qBookmarks: qb, aBookmarks: ab, stride: 40 });
    assert.ok(r.reasons.includes('OCR_REQUIRED'),
      `regime ${qb}/${ab} reported ${r.reasons.join(',') || 'nothing'}`);
    assert.equal(r.auto, 0, `regime ${qb}/${ab} produced ${r.auto} automatic answers`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('3. Invalid pairs — every combination must refuse to answer');

/** Probes a combination and returns how many automatic answers escaped. */
async function probe(L, R) {
  const prepared = await preparePair({
    exerciseDocument: asDoc(raw[L]), answerDocument: asDoc(raw[R]), expectScript: 'han',
  });
  let auto = 0;
  if (prepared.session) {
    const pages = raw[L].numPages;
    const stride = Math.max(1, Math.floor(pages / 25));
    for (let p = 1; p <= pages; p += stride) {
      for (const m of await prepared.session.matchQuestion({ page: p })) {
        if (m.rung === RUNG.AUTO_MATCH) auto++;
      }
    }
  }
  return { auto, status: prepared.status, reasons: prepared.decision.reasonCodes };
}

const keys = Object.keys(ROLES);
const combos = { mismatch: [], answerAnswer: [], exerciseExercise: [], reversed: [] };
for (const L of keys) {
  for (const R of keys) {
    if (VALID_KEYS.has(`${L}|${R}`)) continue;
    if (ROLES[L] === 'EX' && ROLES[R] === 'ANS') combos.mismatch.push([L, R]);
    else if (ROLES[L] === 'ANS' && ROLES[R] === 'ANS') combos.answerAnswer.push([L, R]);
    else if (ROLES[L] === 'EX' && ROLES[R] === 'EX') combos.exerciseExercise.push([L, R]);
    else combos.reversed.push([L, R]);
  }
}

async function assertNoneAnswer(label, list) {
  await check(`${label} (${list.length} combinations): zero automatic answers`, async () => {
    const leaks = [];
    for (const [L, R] of list) {
      const r = await probe(L, R);
      if (r.auto > 0) leaks.push(`${L}->${R} auto=${r.auto} status=${r.status}`);
    }
    assert.equal(leaks.length, 0, `leaked: ${leaks.join(' | ')}`);
  });
}

// 3a. An answer document that does not correspond to the exercise document —
//     right roles, wrong books: cross-year and cross-subject.
await assertNoneAnswer('3a. answer/exercise mismatch', combos.mismatch);

// 3b. Two answer documents paired together.
await assertNoneAnswer('3b. answer paired with answer', combos.answerAnswer);

// 3c. Two exercise documents paired together.
await assertNoneAnswer('3c. exercise paired with exercise', combos.exerciseExercise);

// The reversed orientation, for completeness: an answer book on the left.
await assertNoneAnswer('3d. answer on the left, exercise on the right', combos.reversed);

await check('every invalid combination names a reason', async () => {
  const silent = [];
  for (const list of Object.values(combos)) {
    for (const [L, R] of list) {
      const r = await probe(L, R);
      if (r.reasons.length === 0) silent.push(`${L}->${R}`);
    }
  }
  assert.equal(silent.length, 0,
    `refused without saying why: ${silent.join(', ')}`);
});

await check('a wrong-year pair is rejected outright, not merely unverified', async () => {
  const r = await probe('q2023', 'a2025');
  assert.equal(r.status, PAIR_STATUS.REJECTED_PAIR, `status ${r.status}`);
  assert.ok(r.reasons.includes('PAIR_IDENTITY_MISMATCH'), r.reasons.join(','));
});

await check('a wrong-subject pair is rejected outright', async () => {
  const r = await probe('a2024', 'a2024_alg');
  assert.equal(r.status, PAIR_STATUS.REJECTED_PAIR, `status ${r.status}`);
  assert.ok(r.reasons.includes('PAIR_IDENTITY_MISMATCH'), r.reasons.join(','));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed${SKIP ? `, ${SKIP} skipped` : ''}`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(FAIL > 0 ? 1 : 0);
