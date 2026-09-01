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
    await db.delete(STORE, key);
    return;
  }
  await db.put(STORE, {
    key,
    documentId,
    pageNumber,
    updatedAt: Date.now(),
    data: layer.serialize(),
  });
}

/** Always returns a layer — an unannotated page yields an empty one. */
export async function loadLayer(documentId, pageNumber) {
  if (!documentId) return new InkLayer();
  const db = await getDB();
  const record = await db.get(STORE, inkKey(documentId, pageNumber));
  if (!record || !record.data) return new InkLayer();
  return InkLayer.deserialize(record.data);
}

/** Page numbers of every annotated page in a document, ascending. */
export async function annotatedPages(documentId) {
  const db = await getDB();
  const records = await db.getAllFromIndex(STORE, 'documentId', documentId);
  return records.map(r => r.pageNumber).sort((a, b) => a - b);
}

/** Removes all ink for a document; called when the document itself is deleted. */
export async function deleteDocumentInk(documentId) {
  const db = await getDB();
  const records = await db.getAllFromIndex(STORE, 'documentId', documentId);
  const tx = db.transaction(STORE, 'readwrite');
  await Promise.all([
    ...records.map(r => tx.store.delete(r.key)),
    tx.done,
  ]);
}
