// PDF Module — the content organizer (F09 §08).
//
// Two lists, one per pane, each labelled with where it IS and what it is
// currently showing. An entry is moved by dragging its handle or by pressing
// Move on its row; both paths go through the same atomic commit, so they
// cannot produce different results.
//
// The drag is deliberately narrow. It starts on a dedicated 48dp handle, never
// on the row — ordinary row space scrolls and selects, and long-pressing a row
// does nothing, because a long press already means something everywhere else.
// Paper is never a drag source. The gesture belongs to this panel while it is
// open and cannot reach the canvas, the divider or the switching strip beneath
// it.
//
// The complete click path is always available, which is what makes the whole
// feature reachable from a keyboard and a screen reader.

import { t } from '../core/i18n.js';
import { ENTRY_KINDS, kindKeyFor } from './deck-state.js';

/** 摞里这一项叫什么 —— 键在 deck-state，文案在这里。 */
const kindLabelFor = (kind) => t(kindKeyFor(kind));

/** Hold this long on the handle before a touch drag begins. */
const HOLD_MS = 180;

/** And it must travel this far, so a hold that never moves is not a drag. */
const DRAG_SLOP = 6;

/** Within this of a list's edge, dragging scrolls it. */
const EDGE_BAND = 32;
const EDGE_SPEED = 12;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

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

    let drag = null;
    let holdTimer = 0;
    let scrollTimer = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      cancelDrag();
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', cancelDrag);
      window.removeEventListener('resize', cancelDrag);
      overlay.remove();
      resolve();
    };

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      // Escape stops an uncommitted drag first, and only then closes the panel.
      if (drag) cancelDrag();
      else finish();
    };
    document.addEventListener('keydown', onKey, true);
    // Rotation, a resize or the window losing focus all stop an uncommitted
    // drag: its screen coordinates have stopped meaning what they meant.
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('resize', cancelDrag);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) finish(); });

    function cancelDrag() {
      clearTimeout(holdTimer);
      clearInterval(scrollTimer);
      holdTimer = 0;
      scrollTimer = 0;
      // The handle a touch was holding but had not yet lifted into a drag. Left
      // behind, the next pointermove — belonging to some other gesture
      // entirely — would find it and pick that row up.
      panel._pendingHandle = null;
      if (!drag) return;
      drag.ghost?.remove();
      drag.row?.classList.remove('is-lifted');
      panel.querySelectorAll('.organizer-gap').forEach(n => n.remove());
      panel.classList.remove('is-dragging');
      drag = null;
    }

    /** Where a drop at this point would land: which deck, and after which entry. */
    function dropTargetAt(x, y) {
      const lists = [...panel.querySelectorAll('[data-role="organizer-list"]')];
      const list = lists.find((el) => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      if (!list) return null;
      const slot = list.dataset.slot;
      const rows = [...list.querySelectorAll('.organizer-row')];
      // After the last row whose midpoint is above the pointer. Nothing above
      // it means the head of the deck, which an empty list also reports.
      let afterId = null;
      for (const row of rows) {
        if (row.dataset.entryId === drag?.entryId) continue;
        const r = row.getBoundingClientRect();
        if (y > r.top + r.height / 2) afterId = row.dataset.entryId;
      }
      return { slot, afterId, list };
    }

    /** The insertion line, plus the words that say the same thing. */
    function showGap(target) {
      panel.querySelectorAll('.organizer-gap').forEach(n => n.remove());
      if (!target) return;
      const gap = document.createElement('div');
      gap.className = 'organizer-gap';
      const decks = getDecks();
      const anchor = target.afterId
        ? decks[target.slot].entries.find(e => e.id === target.afterId)
        : null;
      // Never colour alone: the line says where, the text says what it means.
      gap.textContent = anchor
        ? t('deck.afterX', { name: describe(target.slot, anchor).name })
        : t('deck.firstEntryHere');
      const rows = [...target.list.querySelectorAll('.organizer-row')];
      const afterRow = target.afterId
        ? rows.find(r => r.dataset.entryId === target.afterId) : null;
      if (afterRow) afterRow.after(gap);
      else target.list.prepend(gap);
    }

    /** Auto-scroll, one list at a time, and only while the pointer is in its band. */
    function edgeScroll(target, y) {
      clearInterval(scrollTimer);
      scrollTimer = 0;
      if (!target) return;
      const r = target.list.getBoundingClientRect();
      const up = y - r.top < EDGE_BAND;
      const down = r.bottom - y < EDGE_BAND;
      if (!up && !down) return;
      scrollTimer = setInterval(() => {
        target.list.scrollTop += up ? -EDGE_SPEED : EDGE_SPEED;
      }, 16);
    }

    function beginDrag(handle, e) {
      const row = handle.closest('.organizer-row');
      if (!row) return;
      drag = {
        id: e.pointerId,
        entryId: row.dataset.entryId,
        from: row.dataset.slot,
        row,
        x: e.clientX,
        y: e.clientY,
      };
      panel.classList.add('is-dragging');
      row.classList.add('is-lifted');

      if (!prefersReducedMotion()) {
        // A lightweight row preview, not the page it stands for: moving a PDF
        // across the divider means moving a LIST ITEM, and rendering a real
        // page for the animation would cost a decode for a picture nobody
        // keeps. An equal-height placeholder stays where it came from.
        const ghost = row.cloneNode(true);
        ghost.className = 'organizer-row is-ghost';
        ghost.style.width = `${row.getBoundingClientRect().width}px`;
        panel.appendChild(ghost);
        drag.ghost = ghost;
        moveGhost(e.clientX, e.clientY);
      }
      try { handle.setPointerCapture(e.pointerId); } catch (_) { /* not ours */ }
    }

    function moveGhost(x, y) {
      if (!drag?.ghost) return;
      drag.ghost.style.transform = `translate(${x + 8}px, ${y - 18}px) scale(1.015)`;
    }

    async function commitDrag(x, y) {
      const target = dropTargetAt(x, y);
      const request = drag && target
        ? { from: drag.from, to: target.slot, entryId: drag.entryId, afterId: target.afterId }
        : null;
      cancelDrag();
      if (!request) return;
      // Validated and saved before the list settles. A refusal or a failure
      // leaves both decks untouched and the panel simply redraws what is
      // actually stored.
      await onMove(request);
      render();
    }

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

    // Handle-only, and only while the panel is open. It cannot propagate to the
    // paper or the strip underneath, because it is bound here.
    panel.addEventListener('pointerdown', (e) => {
      const handle = e.target?.closest?.('[data-role="handle"]');
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.pointerType === 'touch') {
        // A hold, so a finger that lands on the handle on its way past does not
        // pick the row up.
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => { holdTimer = 0; beginDrag(handle, e); }, HOLD_MS);
        drag = null;
        panel._pendingHandle = { handle, x: e.clientX, y: e.clientY, id: e.pointerId };
      } else {
        // A stylus or a mouse has already been deliberate by pressing the
        // handle at all.
        beginDrag(handle, e);
      }
    });

    panel.addEventListener('pointermove', (e) => {
      const pending = panel._pendingHandle;
      if (pending && !drag) {
        if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > DRAG_SLOP && !holdTimer) {
          beginDrag(pending.handle, e);
        }
        return;
      }
      if (!drag) return;
      if (e.isPrimary === false) { cancelDrag(); return; }
      if (drag.id !== e.pointerId) return;
      e.preventDefault();
      moveGhost(e.clientX, e.clientY);
      const target = dropTargetAt(e.clientX, e.clientY);
      showGap(target);
      edgeScroll(target, e.clientY);
    });

    const release = (e) => {
      clearTimeout(holdTimer);
      holdTimer = 0;
      panel._pendingHandle = null;
      if (!drag || drag.id !== e.pointerId) { cancelDrag(); return; }
      commitDrag(e.clientX, e.clientY);
    };
    panel.addEventListener('pointerup', release);
    panel.addEventListener('pointercancel', () => cancelDrag());
    panel.addEventListener('lostpointercapture', () => { if (drag) cancelDrag(); });

    render();
    document.body.appendChild(overlay);
    panel.querySelector('button')?.focus();
  });
}
