#!/usr/bin/env node
// Bookmarks: the pages a reader put a finger in.
//
// A bookmark is not a note and not an annotation — it is "come back here". So
// the rules worth pinning are the ones that make it trustworthy: the same page
// never marked twice, the list always in reading order, and a page number that
// cannot possibly be right never getting in.

import assert from 'node:assert/strict';
import {
  LABEL_MAX,
  addBookmark,
  bookmarkLabel,
  createBookmarks,
  hasBookmark,
  nextBookmark,
  prevBookmark,
  removeBookmark,
  serializeBookmarks,
  toggleBookmark,
} from '../src/pdf/bookmark-state.js';

let PASS = 0;
let FAIL = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
function check(label, fn) {
  try { fn(); PASS++; console.log(`  ✅ ${label}`); }
  catch (e) { FAIL++; console.log(`  ❌ ${label}\n     ${e.message}`); }
}

const pages = (marks) => marks.map(m => m.page);

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Bookmarks — one page, one mark, in reading order');
console.log('═══════════════════════════════════════════════════════════════');

// ═══════════════════════════════════════════════════════════════
group('1. Adding and removing');

check('a fresh document has none', () => {
  assert.deepEqual(createBookmarks(), []);
});

check('marks come back in reading order, whatever order they were made in', () => {
  let m = createBookmarks();
  m = addBookmark(m, 124, { pageCount: 476 });
  m = addBookmark(m, 20, { pageCount: 476 });
  m = addBookmark(m, 300, { pageCount: 476 });
  assert.deepEqual(pages(m), [20, 124, 300], 'the book decides the order, not the reader');
});

check('marking the same page twice leaves one mark', () => {
  // Two entries for one page is a list that cannot be read and a "remove"
  // that leaves one behind.
  let m = addBookmark(createBookmarks(), 42, { pageCount: 476 });
  m = addBookmark(m, 42, { pageCount: 476 });
  assert.deepEqual(pages(m), [42]);
});

check('marking it again with words relabels it rather than duplicating', () => {
  let m = addBookmark(createBookmarks(), 42, { pageCount: 476 });
  m = addBookmark(m, 42, { label: '行列式那题', pageCount: 476 });
  assert.deepEqual(pages(m), [42]);
  assert.equal(m[0].label, '行列式那题');
});

check('removing takes exactly one page off', () => {
  let m = createBookmarks([{ page: 3 }, { page: 9 }, { page: 27 }]);
  m = removeBookmark(m, 9);
  assert.deepEqual(pages(m), [3, 27]);
});

check('removing a page that was never marked changes nothing at all', () => {
  const m = createBookmarks([{ page: 3 }]);
  assert.equal(removeBookmark(m, 999), m, 'same object, so nothing re-renders');
});

check('one control does both', () => {
  let m = createBookmarks();
  m = toggleBookmark(m, 15, { pageCount: 476 });
  assert.equal(hasBookmark(m, 15), true);
  m = toggleBookmark(m, 15, { pageCount: 476 });
  assert.equal(hasBookmark(m, 15), false);
});

// ═══════════════════════════════════════════════════════════════
group('2. What cannot get in');

check('a page the book does not have is refused', () => {
  const m = addBookmark(createBookmarks(), 900, { pageCount: 476 });
  assert.deepEqual(pages(m), [], 'a mark naming page 900 of a 476-page book is not a mark');
});

check('page zero and negatives are refused', () => {
  let m = addBookmark(createBookmarks(), 0, { pageCount: 476 });
  m = addBookmark(m, -3, { pageCount: 476 });
  assert.deepEqual(pages(m), []);
});

check('nonsense is refused without throwing', () => {
  let m = createBookmarks();
  for (const bad of [NaN, Infinity, undefined, null, 'twelve', {}]) {
    m = addBookmark(m, bad, { pageCount: 476 });
  }
  assert.deepEqual(pages(m), []);
});

check('a book whose length is not known yet still accepts marks', () => {
  // A restore can arrive before the document does. Refusing everything then
  // would silently drop the reader's marks.
  const m = addBookmark(createBookmarks(), 500);
  assert.deepEqual(pages(m), [500]);
});

check('a fractional page is taken as the page it is nearest', () => {
  const m = addBookmark(createBookmarks(), 12.4, { pageCount: 476 });
  assert.deepEqual(pages(m), [12]);
});

check('a label is trimmed, flattened and capped', () => {
  const m = addBookmark(createBookmarks(), 1, { label: '  a\n\n  b  ', pageCount: 9 });
  assert.equal(m[0].label, 'a b');
  const long = addBookmark(createBookmarks(), 1, { label: 'x'.repeat(500), pageCount: 9 });
  assert.equal(long[0].label.length, LABEL_MAX, 'a label longer than this is a note');
});

// ═══════════════════════════════════════════════════════════════
group('3. Coming back to them');

check('a mark with no words of its own still reads as something', () => {
  assert.equal(bookmarkLabel({ page: 42, label: '' }), '第 42 页');
  assert.equal(bookmarkLabel({ page: 42, label: '行列式' }), '行列式');
});

check('next and previous walk the marks, and wrap', () => {
  const m = createBookmarks([{ page: 10 }, { page: 50 }, { page: 90 }]);
  assert.equal(nextBookmark(m, 10).page, 50);
  assert.equal(nextBookmark(m, 90).page, 10, 'wraps rather than stopping at the end');
  assert.equal(prevBookmark(m, 50).page, 10);
  assert.equal(prevBookmark(m, 10).page, 90, 'and wraps the other way');
});

check('walking a book with no marks goes nowhere', () => {
  const m = createBookmarks();
  assert.equal(nextBookmark(m, 5), null);
  assert.equal(prevBookmark(m, 5), null);
});

// ═══════════════════════════════════════════════════════════════
group('4. Surviving a restart');

check('what goes to disk comes back the same', () => {
  const m = createBookmarks([{ page: 9, label: '第二章' }, { page: 2 }]);
  const back = createBookmarks(JSON.parse(JSON.stringify(serializeBookmarks(m))));
  assert.deepEqual(pages(back), [2, 9]);
  assert.equal(back[1].label, '第二章');
});

check('a mark with no label costs no label on disk', () => {
  const m = addBookmark(createBookmarks(), 5, { pageCount: 9 });
  assert.deepEqual(serializeBookmarks(m), [{ page: 5 }]);
});

check('a hand-edited store cannot produce a broken list', () => {
  const m = createBookmarks([
    { page: 5 }, { page: 5 }, { page: 'x' }, null, { page: -1 }, { page: 2 },
  ]);
  assert.deepEqual(pages(m), [2, 5], 'duplicates and nonsense dropped, order restored');
});

check('a store that is not even a list is survived', () => {
  assert.deepEqual(createBookmarks('nope'), []);
  assert.deepEqual(createBookmarks(null), []);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
