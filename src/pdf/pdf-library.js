// PDF Module — document library (import, list, delete, persist).
//
// Imported PDFs are stored whole, in IndexedDB, on the device. They are never
// uploaded anywhere: the same privacy rule that keeps OCR images local applies
// to exercise and answer books.
//
// Bytes and metadata live in separate stores. Listing the library must not drag
// hundreds of megabytes of page data into memory just to draw a filename, so
// metadata is its own record and bytes are fetched only when a document is
// actually opened.

import { openDB } from 'idb';
import { openPdfDocument } from './pdf-document.js';

const DB_NAME = 'latexsnipper-pdf';
const DB_VERSION = 1;
const META_STORE = 'documents';
const BYTES_STORE = 'documentBytes';

/** Documents are tagged by their role in the dual workspace. */
export const DOC_ROLES = Object.freeze({
  EXERCISE: 'exercise',
  ANSWER: 'answer',
  UNSPECIFIED: 'unspecified',
});

export const LIBRARY_ERRORS = Object.freeze({
  NOT_A_PDF: 'PDF_IMPORT_NOT_A_PDF',
  EMPTY_FILE: 'PDF_IMPORT_EMPTY',
  NOT_FOUND: 'PDF_DOC_NOT_FOUND',
  STORAGE_FULL: 'PDF_STORAGE_FULL',
});

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(META_STORE)) {
          const store = db.createObjectStore(META_STORE, { keyPath: 'id' });
          store.createIndex('importedAt', 'importedAt');
          store.createIndex('role', 'role');
        }
        if (!db.objectStoreNames.contains(BYTES_STORE)) {
          db.createObjectStore(BYTES_STORE);
        }
      },
    });
  }
  return dbPromise;
}

function newId() {
  return 'pdf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/** A PDF always starts with %PDF-; refuse anything else before storing it. */
function looksLikePdf(bytes) {
  if (bytes.length < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44
    && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/**
 * Imports a File into the library.
 *
 * The document is opened once during import so page count and outline
 * availability are recorded up front — the library list can then show "no table
 * of contents" honestly without re-parsing every file on every render.
 *
 * @param {File|Blob} file
 * @param {string} role one of DOC_ROLES
 * @returns {Promise<Object>} the stored metadata record
 */
export async function importPdf(file, role = DOC_ROLES.UNSPECIFIED) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) throw new Error(LIBRARY_ERRORS.EMPTY_FILE);
  if (!looksLikePdf(bytes)) throw new Error(LIBRARY_ERRORS.NOT_A_PDF);

  // Parse before storing, so a corrupt file is rejected rather than saved and
  // then failing every time the workspace tries to open it.
  const doc = await openPdfDocument(bytes);
  const outline = await doc.getOutline();
  const meta = {
    id: newId(),
    name: (file.name || 'document.pdf').replace(/\.pdf$/i, ''),
    fileName: file.name || 'document.pdf',
    sizeBytes: bytes.length,
    pageCount: doc.numPages,
    hasOutline: outline.available,
    role: Object.values(DOC_ROLES).includes(role) ? role : DOC_ROLES.UNSPECIFIED,
    importedAt: Date.now(),
  };
  doc.destroy();

  // Refuse an import that would not fit rather than letting IndexedDB throw a
  // raw QuotaExceededError. A textbook PDF can be hundreds of megabytes, and a
  // tablet close to full behaves badly in ways that have nothing to do with
  // this app — so the check happens before anything is written.
  await assertRoomFor(bytes.length);

  const db = await getDB();
  try {
    const tx = db.transaction([META_STORE, BYTES_STORE], 'readwrite');
    await Promise.all([
      tx.objectStore(META_STORE).put(meta),
      tx.objectStore(BYTES_STORE).put(bytes, meta.id),
      tx.done,
    ]);
  } catch (error) {
    if (isQuotaError(error)) throw new Error(LIBRARY_ERRORS.STORAGE_FULL);
    throw error;
  }
  return meta;
}

function isQuotaError(error) {
  return error && (error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || /quota/i.test(error.message || ''));
}

/**
 * Throws STORAGE_FULL when the device cannot hold another `bytes`.
 *
 * Keeps a margin free: filling the last of a device's quota tends to break
 * unrelated things (session state, ink autosave) before it stops this import.
 */
async function assertRoomFor(bytes) {
  try {
    if (!navigator?.storage?.estimate) return; // cannot tell; let the write try
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (!quota) return;
    const free = quota - usage;
    if (free < bytes + STORAGE_MARGIN_BYTES) {
      throw new Error(LIBRARY_ERRORS.STORAGE_FULL);
    }
  } catch (error) {
    if (error?.message === LIBRARY_ERRORS.STORAGE_FULL) throw error;
    // estimate() being unavailable is not a reason to block an import.
  }
}

/** Headroom left free after any import, so other features keep working. */
const STORAGE_MARGIN_BYTES = 50 * 1024 * 1024;

/** All imported documents, newest first. Metadata only — no page bytes. */
export async function listDocuments() {
  const db = await getDB();
  const all = await db.getAll(META_STORE);
  return all.sort((a, b) => b.importedAt - a.importedAt);
}

export async function getDocumentMeta(id) {
  const db = await getDB();
  return (await db.get(META_STORE, id)) || null;
}

/** Raw bytes for a stored document, or null when it is gone. */
export async function getDocumentBytes(id) {
  const db = await getDB();
  const bytes = await db.get(BYTES_STORE, id);
  return bytes || null;
}

/** Opens a stored document for rendering. Throws NOT_FOUND if it was deleted. */
export async function openStoredDocument(id) {
  const bytes = await getDocumentBytes(id);
  if (!bytes) throw new Error(LIBRARY_ERRORS.NOT_FOUND);
  return openPdfDocument(bytes);
}

export async function deleteDocument(id) {
  const db = await getDB();
  const tx = db.transaction([META_STORE, BYTES_STORE], 'readwrite');
  await Promise.all([
    tx.objectStore(META_STORE).delete(id),
    tx.objectStore(BYTES_STORE).delete(id),
    tx.done,
  ]);
}

export async function renameDocument(id, name) {
  const db = await getDB();
  const meta = await db.get(META_STORE, id);
  if (!meta) throw new Error(LIBRARY_ERRORS.NOT_FOUND);
  meta.name = String(name || '').trim() || meta.name;
  await db.put(META_STORE, meta);
  return meta;
}

export async function setDocumentRole(id, role) {
  const db = await getDB();
  const meta = await db.get(META_STORE, id);
  if (!meta) throw new Error(LIBRARY_ERRORS.NOT_FOUND);
  meta.role = Object.values(DOC_ROLES).includes(role) ? role : DOC_ROLES.UNSPECIFIED;
  await db.put(META_STORE, meta);
  return meta;
}

/** Total bytes held by the library, for a storage readout in settings. */
export async function libraryUsageBytes() {
  const docs = await listDocuments();
  return docs.reduce((sum, d) => sum + (d.sizeBytes || 0), 0);
}
