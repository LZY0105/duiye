// PDF Module — which answer book belongs to which exercise book (F07).
//
// The association is bound to the exercise RESOURCE, not to a pane, a slot or a
// deck position. That is the whole point of it: the two panes can be swapped,
// either book can be rotated underneath a scratchpad, and the answer key can
// be moved to the other side — and none of that changes which key belongs to
// which book.
//
// It is also what stops the app from answering out of "whatever PDF happens to
// be open on the other side". That behaviour looks right until the day the
// other side is holding last year's key, at which point every individual
// comparison still looks fine and the answers are confidently wrong.

const KEY = 'ls_answer_pairs';

/** Enough for any library someone reads from; the oldest is dropped past it. */
const MAX_PAIRS = 64;

function read() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** The answer resource associated with this exercise book, or null. */
export function answerFor(exerciseId) {
  if (!exerciseId) return null;
  return read()[exerciseId] || null;
}

/**
 * Records the pairing.
 *
 * Re-inserted rather than updated in place, so the key order is
 * least-recently-confirmed first and trimming takes the right ones.
 */
export function rememberPair(exerciseId, answerId) {
  if (!exerciseId || !answerId) return;
  try {
    const all = read();
    delete all[exerciseId];
    all[exerciseId] = answerId;
    const ids = Object.keys(all);
    for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_PAIRS))) delete all[stale];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch (_) {
    // Storage unavailable. The pairing is still good for this session; it will
    // simply be asked for again next time.
  }
}

/** Drops every association naming a resource — for when the resource goes. */
export function forgetPairsFor(resourceId) {
  if (!resourceId) return;
  try {
    const all = read();
    let changed = false;
    for (const [exercise, answer] of Object.entries(all)) {
      if (exercise === resourceId || answer === resourceId) {
        delete all[exercise];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(KEY, JSON.stringify(all));
  } catch (_) { /* nothing to do */ }
}
