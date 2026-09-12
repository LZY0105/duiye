// Scratch Module — scratchpad resources.
//
// A scratchpad is a resource in its own right, the way a PDF is: it has an id,
// a name, a style and a camera, and it lives in storage independently of which
// deck happens to hold it. Moving a pad between panes moves an ENTRY; the
// record here does not move at all.
//
// Ink is deliberately NOT stored here. It goes to the existing ink store under
// (padId, page 1), which is the same path a PDF page's annotations take — so
// the write-through cache, the prefetch and the "save and reopen, still
// editable" guarantee are inherited rather than rebuilt. A pad has exactly one
// page because it is one boundless surface, not because a page is a unit of
// anything here.

import { openDB } from 'idb';
import { deleteDocumentInk } from '../ink/ink-store.js';
import { createScratchStyle, sameStyle, serializeStyle } from './scratch-style.js';

const DB_NAME = 'duiye-scratch';
const DB_VERSION = 1;
const STORE = 'scratchpads';

/** The one page every pad's ink is filed under. */
export const SCRATCH_PAGE = 1;

/** The style a NEW pad is created with, when the user has opted into one. */
const NEW_PAD_STYLE_KEY = 'ls_scratch_default_style';

export const SCRATCH_ERRORS = Object.freeze({
  NOT_FOUND: 'SCRATCH_NOT_FOUND',
  STALE_REVISION: 'SCRATCH_STALE_REVISION',
});

/** Longest name a pad may carry, per the specification's dialog rules. */
export const NAME_MAX = 60;

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Makes a label safe to put inside a pattern.
 *
 * The prefix is a translated string today, but it is the kind of thing that
 * ends up user-supplied — and a name containing `(` or `*` would otherwise
 * either throw or match something nobody meant.
 */
function escapeForRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function newId() {
  return 'pad_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Where the pad is being looked at, in world coordinates.
 *
 * The CENTRE of the viewport rather than a corner, because the viewport
 * changes size — a pane resize, a rotation, entering and leaving focus — and a
 * centre survives all of those while a corner slides. Origin is (0,0) at 100%.
 */
export function createCamera(initial = {}) {
  const zoom = Number(initial?.zoom);
  return Object.freeze({
    x: Number.isFinite(Number(initial?.x)) ? Number(initial.x) : 0,
    y: Number.isFinite(Number(initial?.y)) ? Number(initial.y) : 0,
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
  });
}

function normalise(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name || '',
    // A record written before styles existed is plain white, and stays that
    // way: createScratchStyle fills the defaults, and the new-pad preference
    // below is read at creation only, never applied by association.
    style: createScratchStyle(record.style),
    camera: createCamera(record.camera),
    createdAt: record.createdAt || 0,
    updatedAt: record.updatedAt || 0,
    /**
     * Bumped by every committed write.
     *
     * The style panel captures this when it opens and hands it back on Apply,
     * so a panel left open while the pad changed by another route cannot write
     * its stale draft over the newer state. A serial, not a clock: two writes
     * in the same millisecond still get different numbers.
     */
    revision: Number(record.revision) || 1,
  };
}

export function trimName(name, fallback = '') {
  const text = String(name ?? '').trim().slice(0, NAME_MAX);
  return text || fallback;
}

/**
 * The next default name: 草稿纸 01, 02, 03… in whatever language is showing.
 *
 * The prefix comes from the caller, so the proposal is in the reader's
 * language rather than the code's. Numbering is read off the existing names
 * rather than a stored counter, so deleting a pad frees its number again and a
 * fresh install starts at 01. Duplicate names are permitted — this only
 * proposes one — and can never overwrite a resource, because identity is the id.
 */
export async function nextScratchpadName(prefix) {
  const label = prefix || 'Scratchpad';
  const pads = await listScratchpads();
  const used = new Set();
  const pattern = new RegExp(`^${escapeForRegExp(label)}\\s*(\\d+)$`, 'i');
  for (const pad of pads) {
    const hit = pattern.exec(pad.name || '');
    if (hit) used.add(Number(hit[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `${label} ${String(n).padStart(2, '0')}`;
}

export async function createScratchpad({ name, style, namePrefix } = {}) {
  const now = Date.now();
  const record = {
    id: newId(),
    // The caller normally supplies a name from the dialog, already in the
    // reader's language. The fallback is only for a pad created without one.
    name: trimName(name, await nextScratchpadName(namePrefix)),
    style: serializeStyle(style || readNewPadStyle()),
    camera: { x: 0, y: 0, zoom: 1 },
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  const db = await getDB();
  await db.put(STORE, record);
  return normalise(record);
}

/** Every pad, newest first. */
export async function listScratchpads() {
  const db = await getDB();
  const all = await db.getAll(STORE);
  return all.map(normalise).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getScratchpad(id) {
  if (!id) return null;
  const db = await getDB();
  return normalise(await db.get(STORE, id));
}

/**
 * Applies a patch to one pad, under an optional revision check.
 *
 * A patch touches only the fields it names. That is the rule the style panel
 * depends on: applying a background must never carry an old full-ink snapshot
 * with it — and ink is not in this record at all, precisely so that it cannot.
 *
 * When `expectedRevision` is given and stale the write is refused, and the
 * record that IS stored comes back on the error, so the caller can say what
 * happened instead of silently discarding the newer state.
 */
async function patch(id, fields, expectedRevision) {
  const db = await getDB();
  const stored = await db.get(STORE, id);
  if (!stored) throw new Error(SCRATCH_ERRORS.NOT_FOUND);
  if (expectedRevision != null && Number(stored.revision || 1) !== Number(expectedRevision)) {
    const error = new Error(SCRATCH_ERRORS.STALE_REVISION);
    error.current = normalise(stored);
    throw error;
  }
  const record = {
    ...stored,
    ...fields,
    updatedAt: Date.now(),
    revision: Number(stored.revision || 1) + 1,
  };
  await db.put(STORE, record);
  return normalise(record);
}

export async function renameScratchpad(id, name) {
  const current = await getScratchpad(id);
  if (!current) throw new Error(SCRATCH_ERRORS.NOT_FOUND);
  return patch(id, { name: trimName(name, current.name) });
}

/**
 * Writes a pad's style.
 *
 * Reapplying values already stored is not a write. Without this, Apply on an
 * unchanged panel would bump the revision and invalidate any other panel's
 * captured one, in exchange for no change at all.
 */
export async function setScratchpadStyle(id, style, { expectedRevision } = {}) {
  const current = await getScratchpad(id);
  if (!current) throw new Error(SCRATCH_ERRORS.NOT_FOUND);
  if (sameStyle(current.style, style)) return current;
  return patch(id, { style: serializeStyle(style) }, expectedRevision);
}

/**
 * Records where the pad was being looked at.
 *
 * Deliberately NOT revision-checked. A camera is where this view happens to be
 * pointing, it is written whenever a pan settles, and losing one costs a scroll
 * position rather than any content. Refusing it on a stale revision would make
 * an ordinary pan fail because a style had been applied somewhere else.
 */
export async function setScratchpadCamera(id, camera) {
  const db = await getDB();
  const stored = await db.get(STORE, id);
  if (!stored) return null;
  return patch(id, { camera: { ...createCamera(camera) } });
}

/**
 * Destroys a pad and its ink, permanently.
 *
 * Ink first. A record deleted without its strokes leaves rows in the ink store
 * that nothing will ever collect; the reverse order can only ever lose ink
 * belonging to a pad that no longer exists.
 */
export async function deleteScratchpad(id) {
  if (!id) return;
  await deleteDocumentInk(id);
  const db = await getDB();
  await db.delete(STORE, id);
}

// ── the new-pad default (F11) ───────────────────────────────────────────────

/**
 * The style new pads are created with.
 *
 * Opt-in, and stored apart from every pad: "also use for new pads" is a
 * statement about the FUTURE. Existing pads are never updated by association,
 * which is why this is read at creation and nowhere else.
 */
export function readNewPadStyle() {
  try {
    const raw = localStorage.getItem(NEW_PAD_STYLE_KEY);
    return raw ? createScratchStyle(JSON.parse(raw)) : createScratchStyle();
  } catch (_) {
    return createScratchStyle();
  }
}

/**
 * @returns {boolean} whether the preference was actually stored.
 *
 * Reported rather than thrown. The caller has just successfully saved a pad,
 * and has to be able to say "current pad saved; new-pad default not saved"
 * instead of rolling back a write that worked.
 */
export function writeNewPadStyle(style) {
  try {
    localStorage.setItem(NEW_PAD_STYLE_KEY, JSON.stringify(serializeStyle(style)));
    return true;
  } catch (_) {
    return false;
  }
}
