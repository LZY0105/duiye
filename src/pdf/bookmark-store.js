// Where a document's bookmarks live between sessions.
//
// Against the RESOURCE, not against a deck entry: a book opened in the other
// pane, or closed and opened again next week, is the same book and keeps the
// pages the reader put a finger in. This is the same reasoning as the
// per-document reading position in document-session.js, and the same storage.

import { createBookmarks, serializeBookmarks } from './bookmark-state.js';

const KEY = 'ls_pdf_bookmarks';

function readAll() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** @returns {ReadonlyArray<{page: number, label: string}>} */
export function loadBookmarks(resourceId) {
  if (!resourceId) return createBookmarks([]);
  return createBookmarks(readAll()[resourceId]);
}

export function saveBookmarks(resourceId, marks) {
  if (!resourceId) return;
  try {
    const all = readAll();
    if (marks.length) all[resourceId] = serializeBookmarks(marks);
    // A book with no marks left holds no entry at all, rather than an empty
    // array that would accumulate one per document ever opened.
    else delete all[resourceId];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch (_) { /* private mode; the marks still work for this session */ }
}

/** Called when a document is deleted, so its marks do not outlive it. */
export function forgetBookmarks(resourceId) {
  saveBookmarks(resourceId, []);
}
