#!/usr/bin/env node
// The 2026-09 textbook release, run through the public interface.
//
// datasets/books-20260924 is the first material this engine has seen from
// outside the 考研 series it was built on: other publishers, nine subjects,
// bookmark trees written by other tools. That makes it the held-out set the
// research report said did not exist — with one large limit. Every matched pair
// in it has a scanned side, so the released text path never runs end to end
// here, and no figure below is a recall.
//
// What the books CAN test is everything that decides before matching starts:
// the text-quality gate on scans and broken font maps, the outline classifier on
// foreign bookmark conventions, subject detection on subjects the engine had
// never been shown, and — over every ordered pairing — whether any automatic
// answer escapes. Measured on 22 volumes, 462 pairings, zero did.
//
// Books are release assets, not repository content. To run:
//
//   node datasets/books-20260924/download.mjs --id book-003 ... --out ../find-engine-books
//   node tools/extract-books.mjs --books ../find-engine-books
//   FIND_ENGINE_BOOKS=../find-engine-books/extracted node test/test_books_20260924.js
//
// Absent, the suite skips and says so.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { indexAnswerDocument, indexQuestionDocument } from '../src/pdf/answer-index.js';
import { PAIR_STATUS, RUNG } from '../src/pdf/decision.js';
import { preparePair } from '../src/pdf/matching-engine.js';
import { NODE_KIND, classifyOutline } from '../src/pdf/outline-classify.js';
import { documentSubject } from '../src/pdf/pair-verifier.js';
import { alignOutlines } from '../src/pdf/question-matcher.js';
import { assessTextQuality } from '../src/pdf/text-quality.js';

let PASS = 0, FAIL = 0, SKIP = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
async function check(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Textbook release 2026-09-24 — gates, structure, and no leaks');
console.log('═══════════════════════════════════════════════════════════════');

const DIR = process.env.FIND_ENGINE_BOOKS || join(process.cwd(), '..', 'find-engine-books', 'extracted');

/**
 * What is known about each volume, from the release inventory and from reading
 * the extraction. `quality` is what the text layer is; `subject` is the
 * inventory's label; `role` the inventory's 电子书/答案 tag.
 *
 * Only volumes that were actually inspected are listed. A volume present in
 * the directory but not here is still run through the pairing matrix.
 */
const BOOKS = {
  'book-003': { name: '谢惠民 上', role: 'EX', subject: 'MATH_ANALYSIS', quality: 'SPARSE_LAYER' },
  'book-017': { name: '王高雄 常微分方程', role: 'EX', subject: 'ODE', quality: 'SCANNED' },
  'book-018': { name: '数值分析', role: 'EX', subject: 'NUMERICAL_ANALYSIS', quality: 'SCANNED', pageMarkers: true },
  'book-019': { name: '陈纪修 上', role: 'EX', subject: 'MATH_ANALYSIS', quality: 'SPARSE_LAYER' },
  'book-022': { name: '姜礼尚 数学物理方程', role: 'EX', subject: 'PDE', quality: 'SCANNED' },
  'book-023': { name: '茆诗松 概率论', role: 'EX', subject: 'PROBABILITY', quality: 'USABLE' },
  'book-026': { name: '绿皮书', role: 'EX', subject: 'ALGEBRA', quality: 'SPARSE_LAYER', exerciseSets: 60 },
  'book-027': { name: '谷超豪 数学物理方程', role: 'EX', subject: 'PDE', quality: 'SCANNED' },
  'book-028': { name: '杨子胥 近世代数', role: 'EX', subject: 'ABSTRACT_ALGEBRA', quality: 'USABLE' },
  'book-031': { name: '韩士安 近世代数', role: 'EX', subject: 'ABSTRACT_ALGEBRA', quality: 'SCANNED' },
  'book-038': { name: '数值分析 答案', role: 'ANS', subject: 'NUMERICAL_ANALYSIS', quality: 'SCANNED' },
  'book-040': { name: '杨子胥 习题解', role: 'ANS', subject: 'ABSTRACT_ALGEBRA', quality: 'SCANNED' },
  'book-041': { name: '茆诗松 习题与解答', role: 'ANS', subject: 'PROBABILITY', quality: 'SCANNED' },
  'book-043': { name: '江泽坚 习题解答', role: 'ANS', subject: 'REAL_ANALYSIS', quality: 'OPAQUE' },
  'book-044': { name: '绿皮书答案', role: 'ANS', subject: 'ALGEBRA', quality: 'USABLE' },
  'book-049': { name: '谷超豪 答案', role: 'ANS', subject: 'PDE', quality: 'USABLE' },
  'book-050': { name: '近世代数三百题 答案', role: 'ANS', subject: 'ABSTRACT_ALGEBRA', quality: 'SCANNED' },
  'book-051': { name: '韩士安 习题解答', role: 'ANS', subject: 'ABSTRACT_ALGEBRA', quality: 'SPARSE_LAYER', pageMarkers: true },
  'book-053': { name: '陈纪修 上 答案', role: 'ANS', subject: 'MATH_ANALYSIS', quality: 'SPARSE_LAYER' },
  'book-056': { name: '北大六版', role: 'EX', subject: 'ALGEBRA', quality: 'SPARSE_LAYER' },
  'book-057': { name: '数学分析 第六版 上', role: 'EX', subject: 'MATH_ANALYSIS', quality: 'SCANNED' },
  'book-061': { name: '王高雄 习题详解', role: 'ANS', subject: 'ODE', quality: 'USABLE' },
  'book-062': { name: '近世代数三百题', role: 'EX', subject: 'ABSTRACT_ALGEBRA', quality: 'SCANNED' },
  'book-063': { name: '高等代数 考研教案', role: 'EX', subject: 'ALGEBRA', quality: 'USABLE' },
};

if (!existsSync(DIR)) {
  console.log(`\n  extracted books not found at ${DIR}`);
  console.log('  set FIND_ENGINE_BOOKS to run this suite\n');
  SKIP++;
  console.log(`  ${PASS} passed, ${FAIL} failed, ${SKIP} skipped\n`);
  process.exit(0);
}

const keys = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
const raw = Object.fromEntries(keys.map(k => [k, JSON.parse(readFileSync(join(DIR, `${k}.json`), 'utf-8'))]));
console.log(`\n  ${keys.length} volumes under ${DIR}`);

const asDoc = (d) => ({
  numPages: d.numPages,
  outline: d.outline,
  async extractText({ from, to } = {}) {
    if (from == null && to == null) return d.lines;
    return d.lines.filter(l => (from == null || l.page >= from) && (to == null || l.page <= to));
  },
});
const known = keys.filter(k => BOOKS[k]);

// ═══════════════════════════════════════════════════════════════
group('1. The text-quality gate reads each volume for what it is');

for (const k of known) {
  await check(`${k} ${BOOKS[k].name}: ${BOOKS[k].quality}`, () => {
    const d = raw[k];
    const q = assessTextQuality(d.lines, { expectScript: 'han', pagesRead: d.numPages });
    assert.equal(q.quality, BOOKS[k].quality, q.reason);
  });
}

// ═══════════════════════════════════════════════════════════════
group('2. Foreign bookmark conventions');

for (const k of known.filter(k => BOOKS[k].pageMarkers)) {
  await check(`${k} ${BOOKS[k].name}: a bookmark per page is not a question index`, async () => {
    // 213 and 326 flat nodes titled with the printed page number. Before the
    // page-marker rule these indexed as 213 and 326 questions.
    const d = raw[k];
    const c = classifyOutline(d.outline, { numPages: d.numPages });
    assert.ok(c.cohorts.some(x => x.kind === NODE_KIND.PAGE_MARKER), JSON.stringify(c.cohorts));
    assert.equal(c.questions.length, 0);
    const idx = await indexQuestionDocument(asDoc(d), { expectScript: 'han' });
    assert.equal(idx.entries.length, 0, `${idx.entries.length} phantom questions`);
  });
}

for (const k of known.filter(k => BOOKS[k].exerciseSets)) {
  await check(`${k} ${BOOKS[k].name}: 习题 bookmarks index as exercise sets`, async () => {
    // 87 "习题 1.1" bookmarks. The classifier called them questions; the id
    // parser knew only 例题 and gave every one an empty id.
    const idx = await indexQuestionDocument(asDoc(raw[k]), { expectScript: 'han' });
    assert.equal(idx.source, 'OUTLINE', idx.source);
    assert.ok(idx.entries.length >= BOOKS[k].exerciseSets, `${idx.entries.length} entries`);
    assert.ok(idx.entries.every(e => /^\d+\.\d+$/.test(e.label)), 'set ids are section-scoped');
  });
}

await check('book-019 -> book-053 陈纪修: two scanned volumes still locate by their bookmark trees', async () => {
  // The one matched pair with bookmarks on both sides. Neither has a text
  // layer, so no question is ever matched — but the section trees are the same
  // book's, and every exercise page must locate to the answer section that
  // carries the same title. Measured: 40 of 40 aligned pairs carry identical
  // titles (the appendix pair scores 0.78 on a genuinely reworded title), and
  // 355 of 381 pages locate; the 26 that do not are front matter before the
  // first chapter and the index after the last aligned section.
  if (!raw['book-019'] || !raw['book-053']) return;
  const q = raw['book-019'];
  const a = raw['book-053'];
  const al = alignOutlines(q.outline, a.outline, { exercisePageCount: q.numPages, answerPageCount: a.numPages });
  assert.ok(al.pairs.length >= 40, `${al.pairs.length} aligned sections`);
  const norm = (t) => String(t).replace(/\s+/g, '');
  const differing = al.pairs.filter(p => norm(p.exercise.title) !== norm(p.answer.title));
  assert.ok(differing.length <= 1, `titles differ on ${differing.map(p => `${p.exercise.title}~${p.answer.title}`).join(', ')}`);

  const p = await preparePair({ exerciseDocument: asDoc(q), answerDocument: asDoc(a), expectScript: 'han' });
  assert.ok(p.decision.reasonCodes.includes('OCR_REQUIRED'));
  let located = 0;
  let auto = 0;
  let wrongRegion = 0;
  for (let pg = 1; pg <= q.numPages; pg++) {
    for (const m of await p.session.matchQuestion({ page: pg })) {
      if (m.rung === RUNG.AUTO_MATCH) auto++;
      if (m.rung !== RUNG.LOCATED) continue;
      located++;
      if (norm(m.region.exerciseSection) !== norm(m.region.answerSection)
        && !/习题答案/.test(m.region.answerSection)) wrongRegion++;
    }
  }
  assert.equal(auto, 0);
  assert.equal(wrongRegion, 0, `${wrongRegion} regions point at a differently titled section`);
  assert.ok(located >= 350, `only ${located} of ${q.numPages} pages located`);
});

await check('book-019 陈纪修 against a wrong book locates almost nothing', async () => {
  // A 近世代数 textbook shares two section titles with this one ("1 集合",
  // "2 映射与函数"). Before regions were bounded by the aligned section's own
  // span, those two pairs located 91 of 96 sampled pages of the wrong book.
  if (!raw['book-019'] || !raw['book-028']) return;
  const q = raw['book-019'];
  const p = await preparePair({ exerciseDocument: asDoc(q), answerDocument: asDoc(raw['book-028']), expectScript: 'han' });
  let located = 0;
  let sampled = 0;
  for (let pg = 1; pg <= q.numPages; pg += 4) {
    sampled++;
    for (const m of await p.session.matchQuestion({ page: pg })) if (m.rung === RUNG.LOCATED) located++;
  }
  assert.ok(located <= sampled / 8, `${located} of ${sampled} sampled pages located against the wrong book`);
});

// ═══════════════════════════════════════════════════════════════
group('3. Subject detection never names a wrong subject');

for (const k of known) {
  await check(`${k} ${BOOKS[k].name}: ${BOOKS[k].subject} or MIXED`, () => {
    const d = raw[k];
    const r = documentSubject({ outline: d.outline, lines: d.lines });
    assert.ok(r.subject === 'MIXED' || r.subject === BOOKS[k].subject,
      `read as ${r.subject}; names ${JSON.stringify(r.names)}`);
  });
}

await check('the subject is named on every volume that has readable text and a name to read', () => {
  // The books whose running heads say what they are. A MIXED verdict here would
  // mean the gate went back to being silent on a subject it can see.
  for (const k of ['book-023', 'book-028', 'book-049', 'book-063']) {
    if (!raw[k]) continue;
    const r = documentSubject({ outline: raw[k].outline, lines: raw[k].lines });
    assert.equal(r.subject, BOOKS[k].subject, `${k} read as ${r.subject}`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('4. No pairing produces an automatic answer');

await check('every ordered pairing of every volume: zero AUTO_MATCH', async () => {
  // Every volume against every other, both orientations, sampled at ~40 pages
  // per pairing. Nothing here is a verified pair, and every matched pair has a
  // scanned side, so the only acceptable count is zero.
  const leaks = [];
  let pairs = 0;
  const statuses = {};
  for (const L of keys) {
    for (const R of keys) {
      if (L === R) continue;
      const p = await preparePair({ exerciseDocument: asDoc(raw[L]), answerDocument: asDoc(raw[R]), expectScript: 'han' });
      pairs++;
      statuses[p.decision.status] = (statuses[p.decision.status] || 0) + 1;
      assert.ok(p.decision.reasonCodes.length > 0, `${L}->${R} gave no reason`);
      if (!p.session) continue;
      const pages = raw[L].numPages;
      const stride = Math.max(1, Math.floor(pages / 40));
      for (let pg = 1; pg <= pages; pg += stride) {
        for (const m of await p.session.matchQuestion({ page: pg })) {
          if (m.rung === RUNG.AUTO_MATCH) leaks.push(`${L}->${R} p${pg} ${m.question?.label}`);
        }
      }
    }
  }
  console.log(`      ${pairs} pairings: ${JSON.stringify(statuses)}`);
  assert.equal(leaks.length, 0, `leaked: ${leaks.slice(0, 5).join(' | ')}`);
});

await check('a pair with a scanned side is OCR_REQUIRED, never VERIFIED', async () => {
  const scanned = known.filter(k => BOOKS[k].quality === 'SCANNED' || BOOKS[k].quality === 'SPARSE_LAYER');
  const readable = known.filter(k => BOOKS[k].quality === 'USABLE');
  for (const L of scanned.slice(0, 6)) {
    for (const R of readable) {
      const p = await preparePair({ exerciseDocument: asDoc(raw[L]), answerDocument: asDoc(raw[R]), expectScript: 'han' });
      assert.notEqual(p.status, PAIR_STATUS.VERIFIED_PAIR, `${L}->${R} verified`);
      if (p.session) assert.ok(p.decision.reasonCodes.includes('OCR_REQUIRED'), `${L}->${R}: ${p.decision.reasonCodes}`);
    }
  }
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed${SKIP ? `, ${SKIP} skipped` : ''}`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(FAIL > 0 ? 1 : 0);
