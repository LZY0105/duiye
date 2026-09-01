// PDF Module — workspace session persistence.
//
// "Exit and re-enter restores the session" is an acceptance requirement, so the
// workspace remembers which documents were open in which slot, where the
// divider sat, and each pane's own page, zoom and pan.
//
// Only small scalars are stored — never page bytes, which stay in the library's
// IndexedDB. That keeps this synchronous and cheap enough to save on every
// interaction without debouncing becoming a correctness concern.

import { createWorkspaceState, serializeWorkspaceState, SLOTS } from './workspace-state.js';
import { createViewState, serializeViewState } from './pdf-view-state.js';
import { getDocumentMeta } from './pdf-library.js';

const STORAGE_KEY = 'ls_pdf_session';
const SESSION_VERSION = 1;

function readRaw() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    const parsed = JSON.parse(text);
    // A session written by a future/older layout is discarded rather than
    // half-applied; a fresh workspace is strictly better than a corrupt one.
    if (!parsed || parsed.version !== SESSION_VERSION) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/** Persists the workspace layout and both panes' view state. */
export function saveSession(workspaceState, viewStates = {}) {
  try {
    const payload = {
      version: SESSION_VERSION,
      savedAt: Date.now(),
      workspace: serializeWorkspaceState(workspaceState),
      views: {
        [SLOTS.PRIMARY]: viewStates[SLOTS.PRIMARY]
          ? serializeViewState(viewStates[SLOTS.PRIMARY]) : null,
        [SLOTS.SECONDARY]: viewStates[SLOTS.SECONDARY]
          ? serializeViewState(viewStates[SLOTS.SECONDARY]) : null,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {
    // Storage full or unavailable (private mode). Losing the session is not
    // worth breaking the workspace over.
  }
}

export function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* nothing to do */ }
}

/**
 * Restores a saved session, dropping anything that no longer holds.
 *
 * A slot whose document has since been deleted from the library is cleared
 * rather than restored — otherwise the workspace would come back pointing at a
 * document it can never load, and the pane would sit permanently broken.
 *
 * @returns {Promise<{workspace: Object, views: Object, dropped: string[]}>}
 */
export async function restoreSession() {
  const raw = readRaw();
  if (!raw) {
    return { workspace: createWorkspaceState(), views: {}, dropped: [] };
  }

  const saved = raw.workspace || {};
  const documents = { ...(saved.documents || {}) };
  const dropped = [];

  for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
    const id = documents[slot];
    if (!id) continue;
    let meta = null;
    try {
      meta = await getDocumentMeta(id);
    } catch (_) {
      meta = null;
    }
    if (!meta) {
      documents[slot] = null;
      dropped.push(id);
    }
  }

  const workspace = createWorkspaceState({ ...saved, documents });

  // View state is rebuilt lazily once each document's real page count is known;
  // what is kept here are the restored scalars to seed it with.
  const views = {};
  for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
    if (documents[slot] && raw.views && raw.views[slot]) {
      views[slot] = raw.views[slot];
    }
  }

  return { workspace, views, dropped };
}

/**
 * Builds a pane's view state from a document's page count plus whatever was
 * restored for that slot. Clamping lives in createViewState, so a session saved
 * against a since-replaced document cannot land on a page that no longer exists.
 */
export function hydrateViewState(pageCount, restored) {
  return createViewState(pageCount, restored || {});
}
