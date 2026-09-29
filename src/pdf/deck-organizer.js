// PDF Module — the content organizer (F09 §08).
//
// Two lists, one per pane, each labelled with where it IS and what it is
// currently showing. An entry is moved by dragging its handle or by pressing
// Move on its row; both paths go through the same atomic commit, so they
// cannot produce different results.
//
// The drag itself lives in list-drag.js, shared with the free-combination
// builder (「自由组合」): both panels answer "which item sits in which column,
// in what order", so they answer it with one gesture. It starts on a dedicated
// 48dp handle, never on the row, and paper is never a drag source.
//
// The complete click path is always available, which is what makes the whole
// feature reachable from a keyboard and a screen reader.

import { t } from '../core/i18n.js';
import { ENTRY_KINDS, kindKeyFor } from './deck-state.js';
import { installListDrag } from './list-drag.js';

/** 摞里这一项叫什么 —— 键在 deck-state，文案在这里。 */
const kindLabelFor = (kind) => t(kindKeyFor(kind));

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Opens the organizer.
 *
 * @param {{getDecks: function, describe: function, positions: Array,
 *          onMove: function}} options
 *   `onMove({from, to, entryId, afterId})` performs the atomic move and
 *   resolves to `{ok}`; the panel re-reads the decks afterwards rather than
 *   keeping its own copy, so what it shows is always what was committed.
 * @returns {Promise<void>} resolves when the panel is closed
 */
export function openOrganizer({ getDecks, describe, positions, onMove }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'deck-overlay organizer-overlay';
    const panel = document.createElement('div');
    panel.className = 'organizer';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    overlay.appendChild(panel);

    let settled = false;

    // The drag, in the same panel: the insertion line names the entry the row
    // will land after, and a drop goes through the same atomic commit as Move.
    const dragger = installListDrag(panel, {
      gapText: ({ slot, afterId }) => {
        const anchor = afterId
          ? getDecks()[slot].entries.find(e => e.id === afterId)
          : null;
        return anchor
          ? t('deck.afterX', { name: describe(slot, anchor).name })
          : t('deck.firstEntryHere');
      },
      // Validated and saved before the list settles. A refusal or a failure
      // leaves both decks untouched and the panel simply redraws what is
      // actually stored.
      onDrop: async (request) => {
        await onMove(request);
        render();
      },
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      dragger.destroy();
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve();
    };

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      // Escape stops an uncommitted drag first, and only then closes the panel.
      if (dragger.active()) dragger.cancel();
      else finish();
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) finish(); });

    // ── the panel ───────────────────────────────────────────────────────────

    function render() {
      const decks = getDecks();
      panel.innerHTML = `
        <div class="organizer-head">
          <div class="deck-dialog-title">${escapeHtml(t('deck.organize'))}</div>
          <button type="button" class="deck-dialog-btn" data-role="close"></button>
        </div>
        <div class="organizer-body"></div>
        <p class="deck-dialog-note">${escapeHtml(t('deck.keptUnderneath'))}</p>`;
      panel.querySelector('[data-role="close"]').textContent = t('deck.cancel');
      panel.querySelector('[data-role="close"]').addEventListener('click', finish);

      const body = panel.querySelector('.organizer-body');
      for (const position of positions) {
        const deck = decks[position.slot];
        const column = document.createElement('div');
        column.className = 'organizer-column';
        column.innerHTML = `
          <div class="organizer-column-head">
            <span class="organizer-where">${escapeHtml(position.position)}</span>
            <span class="organizer-what">${escapeHtml(position.current || t('deck.emptySlot'))}</span>
          </div>
          <div class="organizer-list" data-role="organizer-list" data-slot="${position.slot}"></div>`;
        const list = column.querySelector('.organizer-list');

        if (!deck.entries.length) {
          // An empty deck still needs somewhere to aim at, and the whole area
          // is the honest target.
          const empty = document.createElement('div');
          empty.className = 'organizer-empty';
          empty.textContent = t('deck.firstEntryHere');
          list.appendChild(empty);
        }

        for (const entry of deck.entries) {
          const described = describe(position.slot, entry);
          const row = document.createElement('div');
          row.className = `organizer-row${entry.id === deck.activeId ? ' is-current' : ''}`;
          row.dataset.entryId = entry.id;
          row.dataset.slot = position.slot;
          row.innerHTML = `
            <button type="button" class="organizer-handle" data-role="handle"
                    aria-label="${escapeHtml(t('deck.moveTo'))}">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
                   fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M8 7h8M8 12h8M8 17h8"/>
              </svg>
            </button>
            <span class="deck-row-kind">${escapeHtml(
    kindLabelFor(entry.kind))}</span>
            <span class="organizer-name"></span>
            <button type="button" class="deck-row-btn" data-role="move"></button>`;
          row.querySelector('.organizer-name').textContent = described.name || t('deck.untitled');
          const move = row.querySelector('[data-role="move"]');
          move.textContent = t('deck.moveTo');
          // The click path, always present and always equivalent: it moves the
          // entry to the head of the other deck, which is the position the
          // dialog defaults to as well.
          move.addEventListener('click', async () => {
            const other = positions.find(p => p.slot !== position.slot);
            if (!other) return;
            await onMove({
              from: position.slot,
              to: other.slot,
              entryId: entry.id,
              afterId: getDecks()[other.slot].activeId || null,
            });
            render();
          });
          list.appendChild(row);
        }
        body.appendChild(column);
      }
    }

    render();
    document.body.appendChild(overlay);
    panel.querySelector('button')?.focus();
  });
}
