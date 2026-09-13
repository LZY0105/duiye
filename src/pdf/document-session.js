// PDF Module — workspace session persistence.
//
// "Exit and re-enter restores the session" is an acceptance requirement, so the
// workspace remembers both decks in full — every entry, its order, which one
// each slot was showing — along with the divider ratio, swapped placement,
// collapsed and focused state, and each entry's own page, zoom and pan.
//
// Only small scalars are stored, never page bytes: those stay in the library's
// IndexedDB and in the pads' own store. That keeps this synchronous and cheap
// enough to save on every interaction without debouncing becoming a
// correctness concern.
//
// Views are keyed by ENTRY id — not by slot, and not by resource. That is what
// lets the same PDF sit in both panes at different pages, and what lets an
// entry keep its place when it is moved from one pane to the other: the id
// travels with the entry, so the view travels with it too.

import {
  createWorkspaceState,
  serializeWorkspaceState,
  SLOTS,
} from './workspace-state.js';
import { ENTRY_KINDS } from './deck-state.js';
import { createViewState, serializeViewState } from './pdf-view-state.js';
import { getDocumentMeta } from './pdf-library.js';
import { getScratchpad } from '../scratch/scratch-store.js';
import { getNotebook } from '../note/note-store.js';

const STORAGE_KEY = 'ls_pdf_session';

/**
 * Version 2 keeps decks; version 1 kept one document per slot.
 *
 * A v1 record is migrated on first read rather than discarded — it is the
 * user's open books and their places in them, and a version change is no
 * reason to cost them that.
 */
const SESSION_VERSION = 2;
const LEGACY_VERSION = 1;

/**
 * Where the migrated v1 record is kept afterwards.
 *
 * Read-only, and never written again. If this code turns out to have migrated
 * something wrongly the original is still there to look at, and a user who
 * moves back to an older build finds their old session where that build
 * expects it rather than finding nothing.
 */
const LEGACY_BACKUP_KEY = 'ls_pdf_session_v1';

/**
 * Where each RESOURCE was last left, by resource id.
 *
 * A different question from the entry views above, and both are needed. An
 * entry view answers "where was THIS pane's copy of the book"; this answers
 * "where was this book last read", which is what a brand-new entry for it
 * should open at. Without it, reopening a 372-page book you were forty pages
 * into starts at page 1.
 */
const DOC_VIEWS_KEY = 'ls_pdf_doc_views';

/**
 * How many resources' places are kept.
 *
 * Enough for any library someone actually reads from. Past it the least
 * recently written is dropped, so this cannot grow without limit in the storage
 * the ink and the session also have to fit into.
 */
const DOC_VIEWS_MAX = 48;

/**
 * The entry views this session is holding.
 *
 * Kept in memory so `saveSession` — which runs on every frame of a pan — does
 * not have to read and reparse the stored record just to preserve the views of
 * entries that are not currently on screen. Seeded by `restoreSession`, merged
 * with the live panes' state on every write.
 */
let viewCache = {};

function readRaw() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!parsed) return null;
    if (parsed.version === SESSION_VERSION || parsed.version === LEGACY_VERSION) return parsed;
    // Written by a version this build does not know. Discarded rather than
    // half-applied: a fresh workspace is strictly better than a corrupt one.
    return null;
  } catch (_) {
    return null;
  }
}

/** Every entry id currently in either deck. */
function liveEntryIds(workspaceState) {
  const ids = new Set();
  for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
    for (const entry of workspaceState.decks?.[slot]?.entries || []) ids.add(entry.id);
  }
  return ids;
}

/**
 * Persists the workspace and every entry's view.
 *
 * `liveViews` is what the panes currently on screen are showing, by entry id.
 * Everything else is carried over from the cache, so entries rotated
 * underneath keep their pages — and views belonging to entries that have since
 * been removed are pruned here, which is the only place they can be.
 */
export function saveSession(workspaceState, liveViews = {}) {
  const alive = liveEntryIds(workspaceState);
  const views = {};
  for (const [entryId, view] of Object.entries({ ...viewCache, ...liveViews })) {
    if (!view || !alive.has(entryId)) continue;
    // A live pane hands over its own frozen view state; the cache already holds
    // the serialised form. Both are accepted, so callers never have to remember
    // which side of that line they are on.
    views[entryId] = view.pageCount ? serializeViewState(view) : view;
  }
  viewCache = views;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: SESSION_VERSION,
      savedAt: Date.now(),
      workspace: serializeWorkspaceState(workspaceState),
      views,
    }));
  } catch (_) {
    // Storage full or unavailable (private mode). Losing the session is not
    // worth breaking the workspace over.
  }
}

export function clearSession() {
  viewCache = {};
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* nothing to do */ }
}

/**
 * Turns a v1 record into a v2 one.
 *
 * A v1 slot held one document and one view. That is a deck of exactly one
 * entry — the same thing said in the new vocabulary — so nothing is lost and
 * nothing is invented: no second entry appears, and the reader's page, zoom and
 * pan are carried onto the entry that now holds them.
 *
 * Returns the v2 shape WITHOUT writing it. Committing is a separate step,
 * because a migration announced before it has been read back is a migration
 * that can take the session with it.
 */
function migrateV1(raw) {
  const saved = raw.workspace || {};
  const workspace = createWorkspaceState(saved);
  const views = {};
  for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
    const entry = workspace.decks[slot]?.entries?.[0];
    const view = raw.views?.[slot];
    if (entry && view) views[entry.id] = view;
  }
  return { workspace, views };
}

/**
 * Writes the migrated record and proves it can be read back.
 *
 * The old record is preserved as a backup only AFTER the read-back succeeds. If
 * any part fails — quota, private mode, a storage that accepts a write and
 * returns nothing — the v1 record is left exactly where it was and the
 * migration is simply attempted again next launch. There is no point at which
 * the new record is unusable and the old one has been moved away.
 *
 * @returns {boolean} whether the migration is committed.
 */
function commitMigration(raw, migrated) {
  const payload = {
    version: SESSION_VERSION,
    savedAt: Date.now(),
    workspace: serializeWorkspaceState(migrated.workspace),
    views: migrated.views,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    const back = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!back || back.version !== SESSION_VERSION || !back.workspace?.decks) return false;
    localStorage.setItem(LEGACY_BACKUP_KEY, JSON.stringify(raw));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Whether a resource is still there to be opened.
 *
 * 每一种都要问对地方。这里漏一种的后果不是报错，是那一项被当成「已经删掉了」
 * 悄悄从摞里剔掉 —— 重启之后书桌上就少了一本，而日志里只有一句「dropped 1」。
 * 笔记本刚加进来的时候正是这么丢的。
 *
 * The resolvers are injectable so the failure paths can be exercised in Node
 * without a database.
 */
async function resourceExists(entry, resolvers) {
  try {
    if (entry.kind === ENTRY_KINDS.SCRATCH) {
      return !!(await resolvers.getScratchpad(entry.resourceId));
    }
    if (entry.kind === ENTRY_KINDS.NOTE) {
      return !!(await resolvers.getNotebook(entry.resourceId));
    }
    return !!(await resolvers.getDocumentMeta(entry.resourceId));
  } catch (_) {
    return false;
  }
}

/**
 * Restores a saved session, dropping only what no longer exists.
 *
 * An entry whose resource has since been deleted is taken out of its deck —
 * otherwise the pane would come back pointing at something it can never load.
 * The rest of the deck survives: losing one book must not wipe the order, and a
 * deck that loses its active entry falls to the next one rather than to
 * nothing.
 *
 * @returns {Promise<{workspace: Object, views: Object, dropped: string[],
 *                    migrated: boolean}>}
 */
export async function restoreSession(resolvers = {}) {
  const resolve = {
    getDocumentMeta: resolvers.getDocumentMeta || getDocumentMeta,
    getScratchpad: resolvers.getScratchpad || getScratchpad,
    getNotebook: resolvers.getNotebook || getNotebook,
  };

  const raw = readRaw();
  if (!raw) {
    viewCache = {};
    return { workspace: createWorkspaceState(), views: {}, dropped: [], migrated: false };
  }

  let migrated = false;
  let workspace;
  let views;
  if (raw.version === LEGACY_VERSION) {
    const converted = migrateV1(raw);
    workspace = converted.workspace;
    views = { ...converted.views };
    migrated = commitMigration(raw, converted);
  } else {
    workspace = createWorkspaceState(raw.workspace || {});
    views = { ...(raw.views || {}) };
  }

  // Check every entry, then rebuild both decks from what survived. One pass
  // over a plain description rather than a mutation of the state, so a deck
  // that loses its active entry is repaired by createWorkspaceState's own
  // invariants instead of by a rule written out a second time here.
  const dropped = [];
  const decks = {};
  for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
    const deck = workspace.decks[slot];
    const kept = [];
    for (const entry of deck?.entries || []) {
      if (await resourceExists(entry, resolve)) {
        kept.push(entry);
      } else {
        dropped.push(entry.resourceId);
        delete views[entry.id];
      }
    }
    decks[slot] = { entries: kept, activeId: deck?.activeId ?? null };
  }

  workspace = createWorkspaceState({ ...serializeWorkspaceState(workspace), decks });
  viewCache = views;
  return { workspace, views, dropped, migrated };
}

/**
 * Builds a pane's view state from a resource's page count plus whatever was
 * restored for that entry. Clamping lives in createViewState, so a session
 * saved against a since-replaced document cannot land on a page that no longer
 * exists.
 */
export function hydrateViewState(pageCount, restored) {
  return createViewState(pageCount, restored || {});
}

/** The stored view for one entry, or null. */
export function viewForEntry(entryId) {
  return (entryId && viewCache[entryId]) || null;
}

/**
 * 记下某一条目现在停在哪一页。
 *
 * 这份缓存原来只有两处会写：开机恢复会话时灌一次，和存盘时整个换一遍。中间
 * 那一大段时间里它一直是开机那一刻的样子。
 *
 * 而换书的时候，「这一条目上次在哪一页」的优先级高于「这本书上次在哪一页」——
 * 前者是这一摞里这一条自己的位置，后者是这份文件在任何地方最后被放下的位置，
 * 同一本书同时开在两栏里时，靠的正是前者。于是同一栏里 A→B→A 走一趟：离开 A
 * 时记下的是「资源 A 在第 124 页」，回到 A 时先问的却是这份开机就没再动过的
 * 条目缓存，答出来的是开机那一刻的页码。
 *
 * 所以离开一份文件时两边都要写。存盘仍然会把整份缓存重排一遍，这里只是让它
 * 在两次存盘之间也是真的。
 */
export function rememberEntryView(entryId, viewState) {
  if (!entryId || !viewState) return;
  viewCache[entryId] = viewState.pageCount ? serializeViewState(viewState) : viewState;
}

// ── where each resource was left ────────────────────────────────────────────

function readDocViews() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DOC_VIEWS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Records where a resource was last being read.
 *
 * Re-inserted rather than updated in place, so the object's key order is
 * least-recently-written first and trimming takes the right ones.
 */
export function rememberDocView(documentId, viewState) {
  if (!documentId || !viewState) return;
  try {
    const all = readDocViews();
    delete all[documentId];
    all[documentId] = serializeViewState(viewState);
    const ids = Object.keys(all);
    for (const stale of ids.slice(0, Math.max(0, ids.length - DOC_VIEWS_MAX))) {
      delete all[stale];
    }
    localStorage.setItem(DOC_VIEWS_KEY, JSON.stringify(all));
  } catch (_) {
    // Storage full or unavailable. Losing a reading position is not worth
    // breaking the pane that was about to show it.
  }
}

/**
 * 读过的资源，最近的在前。
 *
 * 这个顺序不是另存的，就是上面那份记录自己的顺序：rememberDocView 每次都把
 * 条目删掉重新插到末尾，所以键的顺序本来就是「最久以前写的在最前」。倒过来
 * 就是书架要的顺序——不用再加一个时间戳字段，也就不会有两份会对不上的记录。
 */
export function docViewOrder() {
  return Object.keys(readDocViews()).reverse();
}

/** Where this resource was left, or null if it has not been opened before. */
export function recallDocView(documentId) {
  if (!documentId) return null;
  return readDocViews()[documentId] || null;
}

/** Drops a resource's remembered place — for when the resource itself goes. */
export function forgetDocView(documentId) {
  if (!documentId) return;
  try {
    const all = readDocViews();
    if (!(documentId in all)) return;
    delete all[documentId];
    localStorage.setItem(DOC_VIEWS_KEY, JSON.stringify(all));
  } catch (_) { /* nothing to do */ }
}
