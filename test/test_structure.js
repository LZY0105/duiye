#!/usr/bin/env node
// Structure, suppression and the decision ladder.
//
// These are the pieces that decide WHAT the engine is looking at before it
// decides what anything matches: which bookmarks are questions, which parsed
// lines are real entries, and how strong a claim a result is allowed to make.
//
// Every fixture here is synthetic, so the suite runs on a fresh clone. The
// numbers quoted in the comments come from the real corpus and are asserted by
// test_no_bookmarks.js, which needs it.

import assert from 'node:assert/strict';

import { NODE_KIND, classifyOutline, descriptiveLength } from '../src/pdf/outline-classify.js';
import { findContentsPages, isTocRow, suppressContentsRows } from '../src/pdf/toc-filter.js';
import { findBoilerplate, boilerplateFilter } from '../src/pdf/boilerplate.js';
import {
  PAIR_STATUS, RUNG, applyPairPermissions, capRung, permittedRungs,
} from '../src/pdf/decision.js';
import { locateAnswerRegion, sectionRangeForPage } from '../src/pdf/region-locator.js';
import { auditOcrMatches, headingPagesFrom } from '../src/pdf/ocr-audit.js';
import { parseQuestionLine } from '../src/pdf/question-id.js';
import {
  buildContentsLocations, estimatePageOffset, extractContentsRows,
} from '../src/pdf/contents-index.js';

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Structure classification, suppression, and the rung ladder');
console.log('═══════════════════════════════════════════════════════════════');

// A tree shaped like the real books: chapters, sections, question bookmarks.
const fullTree = {
  available: true,
  items: [{
    title: '第一章  2023 年数学分析真题分类', pageNumber: 4, children: [
      {
        title: '1.1 极限与连续函数', pageNumber: 4, children: [
          { title: '例题 1.1', pageNumber: 4, children: [] },
          { title: '例题 1.2', pageNumber: 5, children: [] },
          { title: '例题 1.3', pageNumber: 6, children: [] },
        ],
      },
      {
        title: '1.2 一元函数微分学', pageNumber: 46, children: [
          { title: '例题 1.4', pageNumber: 46, children: [] },
          { title: '例题 1.5', pageNumber: 47, children: [] },
        ],
      },
    ],
  }],
};

/** The same book with its question level removed — the scanned-book structure. */
const sectionsOnly = {
  available: true,
  items: [{
    title: '第一章  2023 年数学分析真题分类', pageNumber: 4, children: [
      { title: '1.1 极限与连续函数', pageNumber: 4, children: [] },
      { title: '1.2 一元函数微分学', pageNumber: 46, children: [] },
    ],
  }],
};

// ═══════════════════════════════════════════════════════════════
group('1. A section is never a question');

check('question bookmarks are found when the question level exists', () => {
  const c = classifyOutline(fullTree, { numPages: 100 });
  assert.equal(c.questions.length, 5);
  assert.ok(c.questions.every(q => /例题/.test(q.title)));
  assert.equal(c.hasQuestionLevel, true);
});

check('chapters and sections are kept as structure, not discarded', () => {
  const c = classifyOutline(fullTree, { numPages: 100 });
  const titles = c.sections.map(s => s.title);
  assert.ok(titles.includes('1.1 极限与连续函数'));
  assert.ok(titles.includes('第一章  2023 年数学分析真题分类'));
});

check('with the question level gone, NO section is promoted to a question', () => {
  // The defect this replaced. On the real 2025 exercise book the deepest
  // surviving depth was the section level, and its 18 nodes became 18
  // "questions" that produced 479 accepted matches at HIGH confidence, every
  // one of them wrong, at a true-question recall of 0/573.
  const c = classifyOutline(sectionsOnly, { numPages: 465 });
  assert.equal(c.questions.length, 0, 'sections must not become questions');
  assert.equal(c.hasQuestionLevel, false);
  assert.equal(c.sections.length, 3, 'and must survive as location anchors');
});

check('a descriptive title is what separates a section from a question', () => {
  assert.ok(descriptiveLength('1.1 极限与连续函数') >= 2);
  assert.equal(descriptiveLength('例题 1.1'), 0);
  assert.equal(descriptiveLength('1.31'), 0);
});

check('a node with children is never a question, whatever its cohort', () => {
  const oddTree = {
    available: true,
    items: [
      { title: '例题 1.1', pageNumber: 1, children: [{ title: '例题 1.2', pageNumber: 2, children: [] }] },
      { title: '例题 1.3', pageNumber: 3, children: [] },
    ],
  };
  const c = classifyOutline(oddTree, { numPages: 10 });
  const parent = c.nodes.find(n => n.title === '例题 1.1');
  assert.notEqual(parent.kind, NODE_KIND.QUESTION);
});

check('an ambiguous cohort is withheld from the question index, not guessed into it', () => {
  // Three bare numeric bookmarks: too few to read as a question level, no
  // markers, no descriptions. Being wrong toward SECTION costs coverage; being
  // wrong toward QUESTION costs precision.
  const sparse = {
    available: true,
    items: [
      { title: '1', pageNumber: 1, children: [] },
      { title: '2', pageNumber: 20, children: [] },
      { title: '3', pageNumber: 40, children: [] },
    ],
  };
  const c = classifyOutline(sparse, { numPages: 60 });
  assert.equal(c.questions.length, 0);
});

// ═══════════════════════════════════════════════════════════════
group('2. Contents rows are not answers');

check('a dot leader with a trailing page number is a contents row', () => {
  assert.ok(isTocRow('2023. 东北大学 . . . . . . . . . . . . . 24'));
  assert.ok(isTocRow('极限与连续函数 ......... 7'));
  assert.equal(isTocRow('设 f(x) 在 [0,1] 上连续，证明 f(x) = 0 有解'), false);
  assert.equal(isTocRow('1.1 极限与连续函数'), false);
});

check('a decimal or an ellipsis does not read as a leader', () => {
  assert.equal(isTocRow('取 x = 3.14159'), false);
  assert.equal(isTocRow('于是 a1, a2, ... 收敛'), false);
});

check('a page of contents rows is suppressed whole', () => {
  const entries = [];
  for (let i = 1; i <= 8; i++) {
    entries.push({ page: 4, label: `1.${i}`, text: `2023. 某大学 . . . . . . . . ${20 + i}` });
  }
  entries.push({ page: 4, label: '1.9', text: '2023. 某大学 第 29 页' });  // leader lost in extraction
  entries.push({ page: 27, label: '1.10', text: '设 f(x) 可导，求 f(x) 的导数' });

  const pages = findContentsPages(entries);
  assert.deepEqual([...pages], [4]);
  const { entries: kept, suppressed } = suppressContentsRows(entries);
  assert.equal(kept.length, 1, 'only the real answer survives');
  assert.equal(kept[0].page, 27);
  assert.equal(suppressed.length, 9, 'including the row whose leader was lost');
});

check('a real answer page is never suppressed', () => {
  const entries = [
    { page: 27, label: '1.10', text: '设 f(x) 在 [0,1] 上可导，求 f(x) 的导数' },
    { page: 27, label: '1.11', text: '计算 ∫ x^2 dx，答案：x^3/3 + C' },
  ];
  assert.equal(findContentsPages(entries).size, 0);
});

check('one dotted line inside a real answer cannot delete the page', () => {
  const entries = [
    { page: 30, label: '2.1', text: '于是 a . . . . . . . 5' },
    { page: 30, label: '2.2', text: '设 A 为 n 阶矩阵，证明 A 可对角化' },
  ];
  // Two distinct labels is below the minimum for a contents verdict.
  assert.equal(findContentsPages(entries).size, 0);
});

// ═══════════════════════════════════════════════════════════════
group('3. Running heads are not content');

const withHeaders = () => {
  const lines = [];
  for (let page = 1; page <= 40; page++) {
    lines.push({ page, text: `第一章 2023 年数学分析真题分类 ${page}` });   // running head
    lines.push({ page, text: `例题 1.${page} 2023. 某大学 原 PDF 第 ${page} 页` });
    lines.push({ page, text: `独有内容甲 ${page} ${'x'.repeat(page % 7 + 3)}` });
    lines.push({ page, text: 'lim n→∞ a_n = 0' });                        // recurring maths, mid-page
    lines.push({ page, text: `独有内容乙 ${page} ${'y'.repeat(page % 5 + 3)}` });
    lines.push({ page, text: `独有内容丙 ${page} ${'z'.repeat(page % 3 + 3)}` });
    lines.push({ page, text: `— ${page} —` });                            // running footer
  }
  return lines;
};

check('a line that repeats at the page edge is boilerplate', () => {
  const { report } = findBoilerplate(withHeaders());
  const forms = report.map(r => r.form);
  assert.ok(forms.some(f => f.includes('第一章')), 'the running head must be caught');
});

check('a line that repeats mid-page is content, however often it repeats', () => {
  const { forms } = findBoilerplate(withHeaders());
  const isBp = boilerplateFilter(withHeaders());
  assert.equal(isBp({ page: 1, text: 'lim n→∞ a_n = 0' }), false,
    'recurring mathematics must survive');
  assert.ok(forms.size >= 1);
});

check('a line carrying a question label is exempt', () => {
  // On the real books "例题 1.31 2023. 大连理工大学 原 PDF 第 25 页" recurs on 18
  // pages at a page edge 64% of the time. Stripping it would take the label.
  const isBp = boilerplateFilter(withHeaders());
  assert.equal(isBp({ page: 5, text: '例题 1.5 2023. 某大学 原 PDF 第 5 页' }), false);
});

check('boilerplate is a comparison filter, not a segmentation filter', () => {
  // Removing the lines outright moves entry boundaries; measured on the real
  // books that cost regime C 33 of its 77 resolved questions.
  const isBp = boilerplateFilter(withHeaders());
  assert.equal(typeof isBp, 'function');
  assert.equal(isBp({ page: 3, text: '第一章 2023 年数学分析真题分类 3' }), true);
});

// ═══════════════════════════════════════════════════════════════
group('4. The rung ladder');

check('a verified pair may answer; an unknown pair may not', () => {
  assert.ok(permittedRungs(PAIR_STATUS.VERIFIED_PAIR).includes(RUNG.AUTO_MATCH));
  assert.equal(permittedRungs(PAIR_STATUS.UNKNOWN_PAIR).includes(RUNG.AUTO_MATCH), false);
  assert.deepEqual(permittedRungs(PAIR_STATUS.REJECTED_PAIR), []);
});

check('an unknown pair still locates and reviews rather than refusing outright', () => {
  const allowed = permittedRungs(PAIR_STATUS.UNKNOWN_PAIR);
  assert.ok(allowed.includes(RUNG.LOCATED));
  assert.ok(allowed.includes(RUNG.REVIEW));
});

check('an auto-match on an unverified pair falls to review, not to nothing', () => {
  const r = applyPairPermissions(RUNG.AUTO_MATCH, PAIR_STATUS.UNKNOWN_PAIR, { hasRegion: true });
  assert.equal(r.rung, RUNG.REVIEW);
  assert.equal(r.cappedBy, 'PAIR_IDENTITY_UNKNOWN');
});

check('a rejected pair blocks every rung', () => {
  const r = applyPairPermissions(RUNG.AUTO_MATCH, PAIR_STATUS.REJECTED_PAIR, { hasRegion: true });
  assert.equal(r.rung, RUNG.BLOCKED);
});

check('a cap only ever lowers a rung', () => {
  assert.equal(capRung(RUNG.REVIEW, RUNG.AUTO_MATCH, 'x').rung, RUNG.REVIEW,
    'a ceiling above the current rung must not promote it');
  assert.equal(capRung(RUNG.AUTO_MATCH, RUNG.LOCATED, 'y').rung, RUNG.LOCATED);
});

// ═══════════════════════════════════════════════════════════════
group('5. Locating without identifying');

const alignment = {
  available: true,
  questionIds: new Map(),
  pairs: [
    { exercise: { pageNumber: 4, title: '1.1 极限与连续函数' }, answer: { pageNumber: 20, title: '1.1 极限与连续函数' }, score: 1 },
    { exercise: { pageNumber: 46, title: '1.2 一元函数微分学' }, answer: { pageNumber: 60, title: '1.2 一元函数微分学' }, score: 1 },
  ],
};

check('a page inside an aligned section yields that section\'s answer range', () => {
  const r = sectionRangeForPage(alignment, 10, 200);
  assert.equal(r.from, 20);
  assert.equal(r.to, 59, 'the range must stop before the next section starts');
});

check('the last section runs to the end of the answer book', () => {
  const r = sectionRangeForPage(alignment, 100, 200);
  assert.equal(r.from, 60);
  assert.equal(r.to, 200);
});

check('a page before the first aligned section yields nothing rather than a guess', () => {
  assert.equal(sectionRangeForPage(alignment, 1, 200), null);
});

check('a region is available with no question at all', () => {
  // The scanned-book case: the reader taps a page, the engine cannot read the
  // question, and the answer key's structure is still intact.
  const r = locateAnswerRegion(alignment, { exercisePage: 50, answerPageCount: 200 });
  assert.equal(r.from, 60);
  assert.equal(r.answerSection, '1.2 一元函数微分学');
});

check('no alignment means no region — the locator does not invent one', () => {
  assert.equal(locateAnswerRegion({ available: false, pairs: [] },
    { exercisePage: 50, answerPageCount: 200 }), null);
});
// ═══════════════════════════════════════════════════════════════
group('6. The book prints its own index');

// A contents listing 40 questions at printed pages 1..40, and a body parse that
// finds them at PDF pages 19..58 — a constant offset of 18, as on the real key.
const contentsLines = () => {
  const lines = [];
  for (let i = 1; i <= 40; i++) {
    lines.push({ page: 3 + Math.floor(i / 20), text: `1.${i} 2023. 某大学 . . . . . . . . . ${i}` });
  }
  return lines;
};
const bodyAt = (offset, { skip = [], moved = {} } = {}) =>
  Array.from({ length: 40 }, (_, k) => k + 1)
    .filter(i => !skip.includes(i))
    .map(i => ({ label: `1.${i}`, page: moved[i] ?? (i + offset), endPage: moved[i] ?? (i + offset) }));

check('contents rows yield label and printed page', () => {
  const rows = extractContentsRows(contentsLines());
  assert.equal(rows.length, 40);
  assert.equal(rows[0].label, '1.1');
  assert.equal(rows[0].printedPage, 1);
});

check('the offset is recovered from the document alone', () => {
  const est = estimatePageOffset(extractContentsRows(contentsLines()), bodyAt(18));
  assert.equal(est.offset, 18);
  assert.equal(est.agreement, 1);
  assert.equal(est.support, 40);
});

check('too little overlap is refused rather than extrapolated', () => {
  const est = estimatePageOffset(extractContentsRows(contentsLines()), bodyAt(18).slice(0, 5));
  assert.equal(est, null, 'five labels cannot establish a book-wide offset');
});

check('a book with no single offset is refused', () => {
  // Renumbered partway through: half at +18, half at +40. Forcing one offset
  // would relocate whichever half loses the vote.
  const split = bodyAt(18).map((e, i) => i < 20 ? e : { ...e, page: i + 41, endPage: i + 41 });
  const est = estimatePageOffset(extractContentsRows(contentsLines()), split);
  assert.equal(est, null);
});

check('only corroborated locations are returned', () => {
  // 1.7 is listed but never found in the body; 1.9 is found somewhere else.
  const body = bodyAt(18, { skip: [7], moved: { 9: 300 } });
  const c = buildContentsLocations(contentsLines(), body, { numPages: 400 });
  assert.equal(c.offset, 18);
  assert.equal(c.corroborated, 38, 'the other 38 agree twice over');
  assert.equal(c.unseen, 1, '1.7 was listed but never found');
  assert.equal(c.conflicted, 1, '1.9 sits where the contents disagrees');
  assert.equal(c.locations.has('1.7'), false);
  assert.equal(c.locations.has('1.9'), false);
  assert.equal(c.locations.get('1.1').page, 19);
});

check('a predicted page outside the book is refused', () => {
  const c = buildContentsLocations(contentsLines(), bodyAt(18), { numPages: 30 });
  assert.ok(c.corroborated < 40, 'pages past the end cannot be locations');
  for (const [, loc] of c.locations) assert.ok(loc.page <= 30);
});

check('no contents means no locations, not a guessed offset', () => {
  const plain = [{ page: 1, text: '例题 1.1 设 f(x) 可导' }, { page: 2, text: '例题 1.2 求积分' }];
  const c = buildContentsLocations(plain, bodyAt(18), { numPages: 100 });
  assert.equal(c.offset, null);
  assert.equal(c.locations.size, 0);
});


// ═══════════════════════════════════════════════════════════════
group('7. Auditing an OCR match set');

// The corpus these normally run against is extracted text from copyrighted
// books and is never committed, so the reasoning is exercised on synthetic
// fixtures here. tools/audit-ocr-matches.mjs is the thin CLI over the same
// function and skips cleanly when the private inputs are absent.

const goldLabels = ['1.1', '1.2', '1.3', '1.4', '1.5'];
const headingsOn = (pairs) => new Map(pairs.map(([label, pages]) => [label, new Set(pages)]));

check('a match from a page that printed its label counts as start-aligned', () => {
  const r = auditOcrMatches({
    events: [{ page: 10, label: '1.1' }, { page: 11, label: '1.2' }],
    headingPages: headingsOn([['1.1', [10]], ['1.2', [11]]]),
    goldLabels,
  });
  assert.equal(r.onStartPage, 2);
  assert.equal(r.onContinuationPage, 0);
  assert.equal(r.distinctStartAligned, 2);
});

check('a match from a page that never printed its label is a continuation', () => {
  const r = auditOcrMatches({
    events: [{ page: 10, label: '1.1' }, { page: 11, label: '1.1' }],
    headingPages: headingsOn([['1.1', [10]]]),
    goldLabels,
  });
  assert.equal(r.onStartPage, 1);
  assert.equal(r.onContinuationPage, 1);
  // Printed once and continued onto the next page is ordinary, not a risk.
  assert.deepEqual(r.continuationOnlyLabels, []);
});

check('a label seen ONLY on pages that never printed it is flagged', () => {
  // This is the page-boundary risk the audit exists to surface: nothing in the
  // recognised text ever said this question starts here.
  const r = auditOcrMatches({
    events: [{ page: 20, label: '1.3' }, { page: 21, label: '1.3' }],
    headingPages: headingsOn([['1.3', [19]]]),
    goldLabels,
  });
  assert.equal(r.onStartPage, 0);
  assert.deepEqual(r.continuationOnlyLabels, ['1.3']);
  assert.deepEqual(r.continuationOnlyPages['1.3'], [20, 21]);
});

check('raw and start-aligned distinct counts are reported separately', () => {
  // Conflating them is exactly how "108/573" was first reported as accuracy.
  const r = auditOcrMatches({
    events: [
      { page: 1, label: '1.1' },   // printed here
      { page: 5, label: '1.2' },   // never printed anywhere
    ],
    headingPages: headingsOn([['1.1', [1]]]),
    goldLabels,
  });
  assert.equal(r.distinctRaw, 2, 'both labels were matched');
  assert.equal(r.distinctStartAligned, 1, 'only one came from a page that printed it');
  assert.equal(r.rawShare, 0.4);
  assert.equal(r.startAlignedShare, 0.2);
});

check('labels absent from the answer book count toward neither', () => {
  const r = auditOcrMatches({
    events: [{ page: 1, label: '9.9' }],
    headingPages: headingsOn([['9.9', [1]]]),
    goldLabels,
  });
  assert.equal(r.events, 1);
  assert.equal(r.distinctRaw, 0, 'a label the answer book does not have is not a question');
});

check('a backward step is counted as an order break', () => {
  const r = auditOcrMatches({
    events: [
      { page: 1, label: '1.1' },
      { page: 2, label: '1.4' },
      { page: 3, label: '1.2' },   // goes backwards
    ],
    headingPages: headingsOn([['1.1', [1]], ['1.4', [2]], ['1.2', [3]]]),
    goldLabels,
  });
  assert.equal(r.orderBreaks, 1);
  assert.equal(r.orderBreakExamples[0].from.label, '1.4');
  assert.equal(r.orderBreakExamples[0].to.label, '1.2');
});

check('breaks and inversions are different measurements', () => {
  // One label read far too early: the sequence steps backwards exactly once,
  // but it reads in the wrong order against each of the three that follow.
  // Reporting the first number under the second's name overstated the order
  // evidence, which is why they are now separate fields.
  const r = auditOcrMatches({
    events: [
      { page: 1, label: '1.4' },
      { page: 2, label: '1.1' },
      { page: 3, label: '1.2' },
      { page: 4, label: '1.3' },
    ],
    headingPages: headingsOn([['1.4', [1]], ['1.1', [2]], ['1.2', [3]], ['1.3', [4]]]),
    goldLabels,
  });
  assert.equal(r.orderBreaks, 1, 'the reading order is interrupted once');
  assert.equal(r.orderInversions, 3, '1.4 precedes 1.1, 1.2 and 1.3');
  assert.equal(r.maxOrderInversions, 6);
  assert.equal(r.orderInversionRate, 0.5);
});

check('a sequence in book order has no inversions at all', () => {
  const r = auditOcrMatches({
    events: [
      { page: 1, label: '1.1' },
      { page: 2, label: '1.2' },
      { page: 3, label: '1.3' },
    ],
    headingPages: headingsOn([['1.1', [1]], ['1.2', [2]], ['1.3', [3]]]),
    goldLabels,
  });
  assert.equal(r.orderBreaks, 0);
  assert.equal(r.orderInversions, 0);
  assert.equal(r.orderInversionRate, 0);
});

check('an empty match set audits to zeroes rather than throwing', () => {
  const r = auditOcrMatches({ events: [], headingPages: new Map(), goldLabels });
  assert.equal(r.events, 0);
  assert.equal(r.distinctRaw, 0);
  assert.equal(r.orderBreaks, 0);
  assert.equal(r.orderInversions, 0);
  assert.equal(r.orderInversionRate, null, 'no pairs to compare is not a rate of zero');
});

check('headingPagesFrom reads printed labels out of recognised lines', () => {
  const pages = headingPagesFrom([
    { page: 7, text: '例题 1.1 (2025. 某大学). 求导数' },
    { page: 7, text: '其中 极限与连续函数 为本节内容' },
    { page: 8, text: '例题 1.2 (2025. 某大学). 求积分' },
  ], parseQuestionLine);
  assert.deepEqual([...pages.get('1.1')], [7]);
  assert.deepEqual([...pages.get('1.2')], [8]);
  assert.equal(pages.has('极限与连续函数'), false);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(FAIL > 0 ? 1 : 0);
