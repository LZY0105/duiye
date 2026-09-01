#!/usr/bin/env node
// Lazy text, and the OCR seam.
//
// The property under test is COST. Correctness here is easy; what is hard is
// not reading the whole book. Indexing used to extract every page, which costs
// milliseconds against a text layer and 372 page renders against OCR — a
// difference big enough that it is a different design, not a slower one.
//
// So these tests count calls. A change that keeps every assertion about content
// passing while quietly restoring a full extraction has broken the thing this
// module exists for, and the counters are what catch it.

import assert from 'node:assert/strict';

import { indexAnswerDocument } from '../src/pdf/answer-index.js';
import {
  TEXT_ORIGIN,
  createGlyphRepair,
  createTextSource,
  repairCoverage,
} from '../src/pdf/text-source.js';
import { TEXT_QUALITY } from '../src/pdf/text-quality.js';

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
const group = (n) => console.log(`\n─── [${n}] ───`);
async function check(label, fn) {
  try { await fn(); pass(label); } catch (e) { fail(label, e.message); }
}
function checkSync(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Lazy text and the OCR seam');
console.log('═══════════════════════════════════════════════════════════════');

/** A book with a readable text layer, a bookmark tree, and a page counter. */
function makeBook({ pages = 60, readable = true, withOutline = true } = {}) {
  const stats = { pageReads: 0, ocrCalls: 0 };
  const body = (p) => (readable
    ? `求函数 y = x^${p} 的导数，并说明理由，答案：${p}x^${p - 1}`
    // Opaque: the mathematics survives, the prose does not.
    : `ඔ২ี y = x^${p} ᄹඔਙđ౏ ࢳ࠺ ${p}x^${p - 1} ཋթᄝ`);

  const items = [];
  for (let p = 1; p <= pages; p++) {
    items.push({ title: `例题 1.${p}`, pageNumber: p, depth: 0, children: [] });
  }

  return {
    stats,
    doc: {
      numPages: pages,
      outline: withOutline ? { available: true, items } : { available: false, items: [] },
      async extractText({ from, to } = {}) {
        const lo = from ?? 1;
        const hi = to ?? pages;
        for (let p = lo; p <= hi; p++) stats.pageReads++;
        const out = [];
        for (let p = lo; p <= hi; p++) out.push({ page: p, text: body(p) });
        return out;
      },
    },
    recognise: async (page) => {
      stats.ocrCalls++;
      return `求函数 y = x^${page} 的导数，答案：${page}x^${page - 1}`;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
group('1. Indexing does not read the book');

await check('lazy indexing samples instead of extracting every page', async () => {
  const { doc, stats } = makeBook({ pages: 300 });
  const index = await indexAnswerDocument(doc, { lazy: true, samplePages: 12 });
  assert.equal(index.entries.length, 300, 'ids still come from the bookmark tree');
  assert.equal(index.lazy, true);
  assert.equal(index.textAttached, false, 'no text yet — nothing has needed any');
  assert.ok(stats.pageReads <= 20,
    `sampled ${stats.pageReads} pages of 300; a full extraction would be 300`);
});

await check('eager indexing still reads everything, for callers that want it', async () => {
  const { doc, stats } = makeBook({ pages: 300 });
  const index = await indexAnswerDocument(doc, { lazy: false });
  assert.equal(index.entries.length, 300);
  assert.equal(stats.pageReads, 300);
  assert.ok(index.textAttached);
});

await check('a sampled verdict agrees with the full one', async () => {
  const readable = makeBook({ pages: 200, readable: true });
  const opaque = makeBook({ pages: 200, readable: false });
  const a = await indexAnswerDocument(readable.doc, { lazy: true, expectScript: 'han' });
  const b = await indexAnswerDocument(readable.doc, { lazy: false, expectScript: 'han' });
  assert.equal(a.quality, b.quality, 'sampling must not change the verdict');

  const c = await indexAnswerDocument(opaque.doc, { lazy: true, expectScript: 'han' });
  assert.equal(c.quality, TEXT_QUALITY.OPAQUE,
    'and must still notice a broken font from a sample');
});

// ═══════════════════════════════════════════════════════════════
group('2. Text arrives only when a decision needs it');

await check('hydrating one entry reads one page, not the book', async () => {
  const { doc, stats, recognise } = makeBook({ pages: 300 });
  const index = await indexAnswerDocument(doc, { lazy: true });
  const source = createTextSource(doc, { recognise });

  await source.assessLayer();
  const before = stats.pageReads;
  const entry = index.entries.find(e => e.label === '1.42');
  const filled = await source.hydrate(entry);

  assert.ok(filled.text.length > 0, 'the text should have arrived');
  assert.equal(filled.textOrigin, TEXT_ORIGIN.LAYER);
  assert.ok(stats.pageReads - before <= 2,
    `read ${stats.pageReads - before} pages to answer one question`);
  assert.equal(stats.ocrCalls, 0, 'a usable text layer must never trigger OCR');
});

await check('the same page is fetched once, however often it is asked for', async () => {
  const { doc, stats, recognise } = makeBook({ pages: 60 });
  const source = createTextSource(doc, { recognise });
  await source.assessLayer();
  const before = stats.pageReads;
  for (let i = 0; i < 10; i++) await source.pageText(7);
  assert.equal(stats.pageReads - before, 1, 'nine of those ten were cached');
});

await check('an entry that already has text is not re-fetched', async () => {
  const { doc, stats, recognise } = makeBook({ pages: 60 });
  const source = createTextSource(doc, { recognise });
  await source.assessLayer();
  const before = stats.pageReads;
  const same = await source.hydrate({ page: 3, endPage: 3, text: '已经有了' });
  assert.equal(same.text, '已经有了');
  assert.equal(stats.pageReads, before);
});

// ═══════════════════════════════════════════════════════════════
group('3. OCR is reached for, not reached for first');

await check('OCR runs only when the layer cannot serve the request', async () => {
  const { doc, stats, recognise } = makeBook({ pages: 80, readable: false });
  const source = createTextSource(doc, { recognise, expectScript: 'han' });
  const verdict = await source.assessLayer();
  assert.equal(verdict.quality, TEXT_QUALITY.OPAQUE);

  // For MATCHING, opaque text is the cheaper signal and OCR is not needed.
  const forMatching = await source.pageText(5);
  assert.equal(forMatching.origin, TEXT_ORIGIN.LAYER);
  assert.equal(stats.ocrCalls, 0, 'opaque text still compares — do not pay for OCR');

  // For DISPLAY it is useless, and only then is OCR worth its cost.
  const forReading = await source.pageText(5, { needReadable: true });
  assert.equal(forReading.origin, TEXT_ORIGIN.OCR);
  assert.equal(stats.ocrCalls, 1, 'exactly one page, not the book');
});

await check('a scanned book goes straight to OCR', async () => {
  const stats = { ocrCalls: 0 };
  const doc = {
    numPages: 10,
    outline: { available: false, items: [] },
    async extractText() { return []; },
  };
  const source = createTextSource(doc, {
    recognise: async (p) => { stats.ocrCalls++; return `第 ${p} 页`; },
  });
  const got = await source.pageText(3);
  assert.equal(got.origin, TEXT_ORIGIN.OCR);
  assert.equal(stats.ocrCalls, 1);
});

await check('without a recogniser the source says so instead of inventing text', async () => {
  const doc = {
    numPages: 10,
    outline: { available: false, items: [] },
    async extractText() { return []; },
  };
  const source = createTextSource(doc);          // no recognise
  const got = await source.pageText(3);
  assert.equal(got.origin, TEXT_ORIGIN.NONE);
  assert.equal(got.text, '');
  assert.ok(got.reason, 'and explains which failure this is');
});

// ═══════════════════════════════════════════════════════════════
group('4. Repairing the font map instead of reading the pages');

checkSync('a glyph table decodes the whole book at once', () => {
  // The corruption is a substitution, so undoing it is a table lookup — not a
  // re-read of every page. ~600 distinct glyphs against 740 pages.
  const repair = createGlyphRepair({ ඔ: '数', '২': '例', 'ี': '题' });
  assert.equal(repair('ඔ২ี x^2'), '数例题 x^2');
  assert.equal(repair('unchanged 123'), 'unchanged 123');
});

checkSync('an empty table is a no-op, not a corrupter', () => {
  const repair = createGlyphRepair({});
  assert.equal(repair('ඔ২ี'), 'ඔ২ี');
  assert.equal(createGlyphRepair(null)('abc'), 'abc');
});

checkSync('coverage is measurable before committing to building a table', () => {
  const lines = [{ page: 1, text: 'ඔඔ২ x^2 = 4' }];
  // ASCII was never broken, so it is not counted as needing repair.
  const full = repairCoverage(lines, { ඔ: '数', '২': '例' });
  assert.equal(full.coverage, 1);
  const partial = repairCoverage(lines, { ඔ: '数' });
  assert.ok(partial.coverage > 0.6 && partial.coverage < 1,
    `partial table should read as partial, got ${partial.coverage}`);
  assert.equal(repairCoverage(lines, {}).coverage, 0);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
