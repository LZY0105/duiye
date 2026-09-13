// PDF Module — per-slot deck state.
//
// A slot used to hold one document. It now holds a DECK: an ordered list of
// entries with one of them active. That is the whole of the "rotates
// underneath" requirement — content that is replaced is not closed, it moves
// down the order and can be brought back.
//
// Pure and DOM-free, like workspace-state.js and pdf-view-state.js beside it.
// Every operation returns a new frozen object, so a deck can be reasoned about
// and tested in plain Node without a canvas, a PDF or a database.
//
// It deliberately does NOT hold view state (page, zoom, scroll, camera). Those
// belong to the entry's own view record, kept in document-session.js and keyed
// by entry id — which is what lets the SAME pdf sit in both slots with
// independent reading positions.
//
// Vocabulary, from the specification:
//   Entry     one item in one deck, with a stable id
//   Resource  the actual PDF or scratchpad the entry points at
//   Deck      a slot's ordered entries plus which one is active
//
// Invariants enforced here: at most one active entry per deck; the active id
// always names an entry that exists (or is null for an empty deck); no two
// entries in ONE deck reference the same resource.

/**
 * What an entry points at. A scratchpad is never matched against a PDF.
 *
 * NOTE 是笔记本。它和 PDF 一样是一份分页文档，在同一个 PdfPane 里翻 —— 差别只在
 * 从哪儿取：一本书从 pdf-library，一本本子从 note-store（见 note-document.js）。
 * 所以下面凡是「不是草稿纸就当 PDF」的地方，对笔记本大多是对的；真正要分开的是
 * 取资源和「这东西能不能拿去对题」这两件事。
 */
export const ENTRY_KINDS = Object.freeze({
  PDF: 'pdf',
  SCRATCH: 'scratch',
  NOTE: 'note',
});

/**
 * 摞里这一项在界面上叫什么。
 *
 * 原来三处 UI 各写了一遍「不是草稿纸就是 PDF」。加进笔记本之后那句话就错了 ——
 * 一本本子会被标成 PDF，三个地方都是，而且都不报错。同一个问题只该有一个答案。
 *
 * 文案键从这里回去，而不是在这里翻译：这个文件是 DOM-free 也 i18n-free 的，
 * 顺序和类型是数据的性质。
 */
export function kindKeyFor(kind) {
  if (kind === ENTRY_KINDS.SCRATCH) return 'deck.scratch';
  if (kind === ENTRY_KINDS.NOTE) return 'deck.note';
  return 'deck.pdf';
}

/** 在 PdfPane 里翻的那些 —— 笔记本和 PDF 走同一条装载路径。 */
export const PAGED_KINDS = Object.freeze([ENTRY_KINDS.PDF, ENTRY_KINDS.NOTE]);

/** 这一项是分页文档（书或本子）吗。 */
export function isPagedKind(kind) {
  return kind === ENTRY_KINDS.PDF || kind === ENTRY_KINDS.NOTE;
}

/** Why a move was refused. Callers show these; they never guess a remedy. */
export const DECK_ERRORS = Object.freeze({
  NO_SUCH_ENTRY: 'DECK_NO_SUCH_ENTRY',
  NO_SUCH_ANCHOR: 'DECK_NO_SUCH_ANCHOR',
  DUPLICATE_RESOURCE: 'DECK_DUPLICATE_RESOURCE',
});

let idCounter = 0;

/**
 * A new entry id.
 *
 * Ids are stable for the life of the entry and are the only thing insertion
 * anchors, view records and in-flight handoff tokens are allowed to name. Row
 * indices are not: they move under every insert, remove and reorder, and an
 * anchor that shifts while a dialog is open lands the entry somewhere the user
 * did not point at.
 */
export function newEntryId() {
  idCounter += 1;
  return `e${Date.now().toString(36)}${idCounter.toString(36)}`;
}

const freeze = (o) => Object.freeze(o);

/**
 * One item in a deck.
 *
 * `resourceId` is a document id from pdf-library for a PDF, a pad id from the
 * scratch store for a scratchpad, or a notebook id from note-store for a note.
 * Two entries may share a resource across DIFFERENT decks — that is the "same
 * PDF in both panes" case — but never within one.
 */
export function createEntry({ id, kind, resourceId } = {}) {
  // 认得的照收，认不得的当 PDF。存盘里读回来一个未来版本写的 kind 时，退成 PDF
  // 会让它去 pdf-library 里找一个不存在的 id，然后干净地开不开 —— 好过当成草稿纸
  // 塞进一个不会翻页的面板里。
  const entryKind = kind === ENTRY_KINDS.SCRATCH || kind === ENTRY_KINDS.NOTE
    ? kind
    : ENTRY_KINDS.PDF;
  return freeze({
    id: id || newEntryId(),
    kind: entryKind,
    resourceId: resourceId == null ? null : String(resourceId),
  });
}

/**
 * Builds a deck, dropping anything that would break an invariant.
 *
 * Restoration runs through here, so it is the one place a malformed record can
 * be made safe: entries with no resource, duplicate resources and an active id
 * naming nothing are all repaired rather than carried into the workspace. A
 * deck that is quietly corrected is strictly better than a pane that cannot
 * decide what it is showing.
 */
export function createDeck(initial = {}) {
  const seen = new Set();
  const entries = [];
  for (const raw of Array.isArray(initial.entries) ? initial.entries : []) {
    if (!raw || raw.resourceId == null) continue;
    const entry = createEntry(raw);
    if (!entry.resourceId) continue;
    if (seen.has(entry.resourceId)) continue;      // no duplicate resource per deck
    seen.add(entry.resourceId);
    entries.push(entry);
  }
  const wanted = initial.activeId;
  const activeId = entries.some(e => e.id === wanted) ? wanted : (entries[0]?.id ?? null);
  return freeze({ entries: freeze(entries), activeId });
}

const withDeck = (deck, entries, activeId) => freeze({
  entries: freeze(entries),
  activeId: entries.some(e => e.id === activeId) ? activeId : (entries[0]?.id ?? null),
});

// ── reading ─────────────────────────────────────────────────────────────────

export function deckLength(deck) {
  return deck?.entries?.length || 0;
}

export function isEmptyDeck(deck) {
  return deckLength(deck) === 0;
}

export function indexOfEntry(deck, entryId) {
  if (!deck?.entries) return -1;
  return deck.entries.findIndex(e => e.id === entryId);
}

export function findEntry(deck, entryId) {
  return deck?.entries?.find(e => e.id === entryId) || null;
}

export function activeEntry(deck) {
  return findEntry(deck, deck?.activeId);
}

/** Where the active entry sits, 1-based — the "1 / 3" the strip shows. */
export function activePosition(deck) {
  const index = indexOfEntry(deck, deck?.activeId);
  return index < 0 ? 0 : index + 1;
}

/**
 * The first entry in this deck pointing at `resourceId`.
 *
 * `except` skips one entry id, which is what makes a same-deck reorder legal:
 * an entry being moved must not be found as a duplicate of itself.
 */
export function findByResource(deck, resourceId, { except } = {}) {
  if (!deck?.entries || resourceId == null) return null;
  return deck.entries.find(e => e.resourceId === String(resourceId) && e.id !== except) || null;
}

export function hasResource(deck, resourceId, options) {
  return !!findByResource(deck, resourceId, options);
}

/**
 * The entry `step` places along the deck, wrapping.
 *
 * Deck order is circular: the last entry's next is the first. One gesture
 * advances at most one item, so `step` is ±1 everywhere in the app; the
 * parameter exists so the wrap arithmetic lives in one place.
 */
export function entryAtOffset(deck, step) {
  const length = deckLength(deck);
  if (length === 0) return null;
  const index = indexOfEntry(deck, deck.activeId);
  const from = index < 0 ? 0 : index;
  const at = ((from + step) % length + length) % length;
  return deck.entries[at];
}

export function nextEntry(deck) {
  return entryAtOffset(deck, 1);
}

export function previousEntry(deck) {
  return entryAtOffset(deck, -1);
}

/** Cycling is only meaningful with something to cycle to. */
export function canCycle(deck) {
  return deckLength(deck) > 1;
}

// ── writing ─────────────────────────────────────────────────────────────────

/**
 * Puts a new entry in front of the reader, keeping what was there underneath.
 *
 * Inserted immediately BEFORE the active entry, so the content it displaced
 * becomes its next item — which is the ordering the specification works
 * through: [A] → create S → [S, A] → open B → [B, S, A], and Next from B runs
 * S, A, B. The displaced entry is the one the reader most likely wants back,
 * so it is the one the very next swipe reaches.
 *
 * Appending instead would put the new content at the far end of the deck, and
 * "come back to what I was just reading" would then cost a full lap.
 */
export function insertEntry(deck, entry) {
  if (!entry?.id) return deck;
  const at = indexOfEntry(deck, deck?.activeId);
  const entries = [...(deck?.entries || [])];
  entries.splice(at < 0 ? entries.length : at, 0, entry);
  return withDeck(deck, entries, entry.id);
}

/**
 * Places an entry at a chosen point in the order — the F09 "After X" anchor.
 *
 * `afterId` null means the head of the deck, which is what an empty target
 * offers as "First entry here". Because the order is circular, "after the last
 * entry" and "at the end" are the same position.
 *
 * `activate` is the explicit Move and show: off by default, because moving
 * something underneath is the common case and silently changing what a pane
 * displays is not what "put this away over there" means.
 */
export function insertEntryAfter(deck, entry, afterId, { activate = false } = {}) {
  if (!entry?.id) return deck;
  const entries = [...(deck?.entries || [])];
  let at = 0;
  if (afterId != null) {
    const anchor = entries.findIndex(e => e.id === afterId);
    if (anchor < 0) return deck;
    at = anchor + 1;
  }
  entries.splice(at, 0, entry);
  const activeId = activate ? entry.id : (deck?.activeId ?? entry.id);
  return withDeck(deck, entries, activeId);
}

/**
 * Brings one entry to the foreground.
 *
 * Order is NOT touched. Selecting from the list is a way of looking at
 * something, not a way of rearranging the deck — a list that rotated itself
 * under every selection would never show the same thing twice.
 */
export function activateEntry(deck, entryId) {
  if (!deck || deck.activeId === entryId) return deck;
  if (indexOfEntry(deck, entryId) < 0) return deck;
  return withDeck(deck, [...deck.entries], entryId);
}

/** One step along the deck. `step` is +1 for next, -1 for previous. */
export function cycleEntry(deck, step = 1) {
  const target = entryAtOffset(deck, step);
  return target ? activateEntry(deck, target.id) : deck;
}

/**
 * Detaches an entry. The resource itself is untouched — it stays in its
 * library, and removing is not deleting.
 *
 * Removing the ACTIVE entry activates what was its next item, which is the
 * same content the strip's own Next control would have reached. Removing the
 * last entry leaves an empty deck rather than a deleted resource.
 */
export function removeEntry(deck, entryId) {
  const at = indexOfEntry(deck, entryId);
  if (at < 0) return deck;
  const wasActive = deck.activeId === entryId;
  // Captured BEFORE the removal: after it, the index that followed this entry
  // holds a different one, and at the end of the deck it holds nothing.
  const successor = wasActive ? entryAtOffset(deck, 1) : null;
  const entries = [...deck.entries];
  entries.splice(at, 1);
  if (!wasActive) return withDeck(deck, entries, deck.activeId);
  // The successor of a one-entry deck is the entry itself, which has just gone.
  const activeId = successor && successor.id !== entryId ? successor.id : (entries[0]?.id ?? null);
  return withDeck(deck, entries, activeId);
}

/** Everything worth persisting. Entries are already plain data. */
export function serializeDeck(deck) {
  return {
    entries: (deck?.entries || []).map(e => ({
      id: e.id,
      kind: e.kind,
      resourceId: e.resourceId,
    })),
    activeId: deck?.activeId ?? null,
  };
}

// ── moving an entry between decks (F09) ─────────────────────────────────────

/**
 * Moves ONE entry, atomically, within a deck or across the two.
 *
 * Both decks are decided together and returned together: either the caller
 * gets a new pair, or it gets a reason and the pair it already had. There is
 * no intermediate state in which the entry has left one deck and not arrived
 * in the other — which matters because the two decks are persisted as one
 * record, and a failure between the halves would strand the entry.
 *
 * The rules the result follows, all from F09:
 *
 *   - a background entry moves without changing what either pane displays;
 *   - moving the source's ACTIVE entry activates its pre-move next item, and
 *     leaves the source empty if it was the only one;
 *   - a non-empty target keeps showing what it was showing; an empty target
 *     displays the arrival, because it is now the only thing there;
 *   - a same-deck reorder keeps the active entry active, wherever it lands.
 *
 * Moving is not copying: the entry keeps its id, and with it the view record,
 * the ink and the undo context that are all filed under that id.
 *
 * @param {{[slot: string]: Object}} decks both decks, by slot id
 * @param {{from: string, to: string, entryId: string, afterId?: string|null,
 *          andShow?: boolean}} request
 * @returns {{ok: true, decks: Object} | {ok: false, reason: string}}
 */
export function moveEntry(decks, { from, to, entryId, afterId = null, andShow = false } = {}) {
  const source = decks?.[from];
  const target = decks?.[to];
  if (!source || !target) return { ok: false, reason: DECK_ERRORS.NO_SUCH_ENTRY };

  const entry = findEntry(source, entryId);
  if (!entry) return { ok: false, reason: DECK_ERRORS.NO_SUCH_ENTRY };

  // Dropping an entry onto itself is not a move. Answered before anything else,
  // because every later step would otherwise have to special-case an anchor
  // that is about to be removed.
  if (from === to && afterId === entryId) return { ok: true, decks };

  // Two entries in one deck may not share a resource — but the entry being
  // moved must not be found as a duplicate of ITSELF, which is exactly what a
  // same-deck reorder looks like to a naive check.
  const clash = findByResource(target, entry.resourceId, { except: entry.id });
  if (clash) return { ok: false, reason: DECK_ERRORS.DUPLICATE_RESOURCE, entry: clash };

  // The anchor is checked against the deck the entry will be inserted into,
  // AFTER the removal — in a same-deck move the removal can invalidate it.
  const nextSource = removeEntry(source, entryId);
  const insertInto = from === to ? nextSource : target;
  if (afterId != null && indexOfEntry(insertInto, afterId) < 0) {
    return { ok: false, reason: DECK_ERRORS.NO_SUCH_ANCHOR };
  }

  if (from === to) {
    // Same deck: the active entry stays active wherever the order puts it.
    // Move and show is still honoured — it is the one way a reorder is allowed
    // to change what is displayed.
    const reordered = insertEntryAfter(nextSource, entry, afterId, { activate: andShow });
    const activeId = andShow ? entry.id : source.activeId;
    return {
      ok: true,
      decks: { ...decks, [to]: withDeck(reordered, [...reordered.entries], activeId) },
    };
  }

  // An empty target shows the arrival because there is nothing else to show;
  // a target with content keeps showing it unless Move and show says otherwise.
  const activate = andShow || isEmptyDeck(target);
  const nextTarget = insertEntryAfter(target, entry, afterId, { activate });
  return { ok: true, decks: { ...decks, [from]: nextSource, [to]: nextTarget } };
}
