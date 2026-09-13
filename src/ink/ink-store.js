// Ink Module — per-page ink persistence.
//
// Ink is stored per (document, page) as serialised vector strokes, in its own
// IndexedDB database. It is deliberately NOT stored inside the PDF: the
// imported file is never rewritten, so annotating can never corrupt the
// original exercise or answer book, and deleting ink cannot damage the page.
//
// "Save and reopen, then keep editing" is an acceptance requirement, and
// storing geometry rather than a flattened image is what makes the reopened
// ink still editable and still erasable stroke by stroke.

import { openDB } from 'idb';
import { InkLayer } from './ink-layer.js';

const DB_NAME = 'latexsnipper-ink';
const DB_VERSION = 1;
const STORE = 'pageInk';

let dbPromise = null;

/**
 * Recently touched pages' ink, as the SERIALISED form, keyed like the store.
 *
 * Ink lives one IndexedDB round trip away, and a page turn now puts the bitmap
 * up in a single frame — so the annotations arrived forty to a hundred
 * milliseconds after the page they belong to, and on a cold jump much later
 * than that. Long enough to read as "my notes disappeared".
 *
 * The cache is module-level on purpose: `saveLayer` writes through it, so two
 * panes showing the SAME document cannot drift apart the way a per-pane cache
 * would let them.
 *
 * 它存的是序列化之后的记录，不是活的 `InkLayer`，所以每次读出来的都是**新的一个
 * 对象**。同一页同时开在两栏时，那正好是不能要的——两份副本各自盲写，后写的会把
 * 先写的整个盖掉。所以读出来之后还要过一道 `ink-shared.js` 的登记处，它把「这一页
 * 该用哪一份」换回来。这里不做这件事：谁在看哪一页是分栏自己的事，这一层只管存取。
 */
const recordCache = new Map();
const RECORD_CACHE_MAX = 24;

function cacheRead(key) {
  if (!recordCache.has(key)) return undefined;
  const v = recordCache.get(key);
  recordCache.delete(key);
  recordCache.set(key, v);                 // insertion order is the LRU
  return v;
}

function cacheWrite(key, data) {
  recordCache.delete(key);
  recordCache.set(key, data ?? null);
  while (recordCache.size > RECORD_CACHE_MAX) {
    recordCache.delete(recordCache.keys().next().value);
  }
}

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('documentId', 'documentId');
        }
      },
    });
  }
  return dbPromise;
}

export function inkKey(documentId, pageNumber) {
  return `${documentId}#${pageNumber}`;
}

/**
 * Persists one page's ink. An empty layer deletes the record rather than
 * storing an empty one, so erasing everything does not leave orphan rows.
 */
export async function saveLayer(documentId, pageNumber, layer) {
  if (!documentId) return;
  const db = await getDB();
  const key = inkKey(documentId, pageNumber);
  if (layer.isEmpty()) {
    cacheWrite(key, null);
    await db.delete(STORE, key);
    return;
  }
  // Written through, not invalidated: the next reader of this page — including
  // the other pane on the same book — must see what was just drawn.
  const data = layer.serialize();
  cacheWrite(key, data);
  await db.put(STORE, {
    key,
    documentId,
    pageNumber,
    updatedAt: Date.now(),
    data,
  });
}

/** Always returns a layer — an unannotated page yields an empty one. */
export async function loadLayer(documentId, pageNumber) {
  if (!documentId) return new InkLayer();
  const key = inkKey(documentId, pageNumber);
  const cached = cacheRead(key);
  if (cached !== undefined) {
    // Resolves in a microtask rather than a database round trip, so the ink
    // lands in the same frame as the page it belongs to.
    return cached ? InkLayer.deserialize(cached) : new InkLayer();
  }
  const db = await getDB();
  const record = await db.get(STORE, key);
  cacheWrite(key, record?.data ?? null);
  if (!record || !record.data) return new InkLayer();
  return InkLayer.deserialize(record.data);
}

/**
 * Reads a page's ink into the cache without installing it anywhere.
 *
 * Called for the pages either side of the one being read, at the same time as
 * their bitmaps, so turning onto one costs no round trip at all. Failure is
 * silent: this is work done ahead of a page that may never be turned to.
 */
export async function prefetchInk(documentId, pageNumber) {
  if (!documentId) return;
  const key = inkKey(documentId, pageNumber);
  if (cacheRead(key) !== undefined) return;
  try {
    const db = await getDB();
    const record = await db.get(STORE, key);
    cacheWrite(key, record?.data ?? null);
  } catch (_) { /* the reader will fetch it properly if they arrive */ }
}

/** Page numbers of every annotated page in a document, ascending. */
export async function annotatedPages(documentId) {
  const db = await getDB();
  const records = await db.getAllFromIndex(STORE, 'documentId', documentId);
  return records.map(r => r.pageNumber).sort((a, b) => a - b);
}

/** Removes all ink for a document; called when the document itself is deleted. */
/**
 * Forgets one page's ink.
 *
 * Symmetric with deleteDocumentInk, and needed by anything that can make a
 * page stop existing — today that is shortening a notebook. Leaving the row
 * behind would be invisible rather than harmless: nothing can reach that page
 * any more, so the ink is unreachable storage, and if the notebook is later
 * lengthened again the old strokes would reappear on what the reader believes
 * is a fresh page.
 */
export async function deletePageInk(documentId, pageNumber) {
  if (!documentId) return;
  const db = await getDB();
  const key = inkKey(documentId, pageNumber);
  cacheWrite(key, null);
  await db.delete(STORE, key);
}

export async function deleteDocumentInk(documentId) {
  const db = await getDB();
  const records = await db.getAllFromIndex(STORE, 'documentId', documentId);
  for (const r of records) recordCache.delete(r.key);
  const tx = db.transaction(STORE, 'readwrite');
  await Promise.all([
    ...records.map(r => tx.store.delete(r.key)),
    tx.done,
  ]);
}
