// PDF Module — dragging a row between two lists, by its handle.
//
// Shared by the content organizer (「整理内容」) and the free-combination
// builder (「自由组合」). Both answer the same question — which item sits in
// which column, and in what order — so the gesture that answers it is one
// implementation, not two that drift apart. It was lifted out of
// deck-organizer.js unchanged; what differs between the two panels is only
// which lists count as drop targets, what the insertion line says, and what a
// drop does.
//
// The drag is deliberately narrow. It starts on a dedicated 48dp handle, never
// on the row — ordinary row space scrolls and selects, and long-pressing a row
// does nothing, because a long press already means something everywhere else.
// The gesture belongs to the panel while it is open and cannot reach the canvas,
// the divider or the switching strip beneath it.
//
// Rows are `.organizer-row` carrying `data-entry-id` and `data-slot`; each list
// carries `data-slot`; the handle is `[data-role="handle"]` inside a row.

/** Hold this long on the handle before a touch drag begins. */
const HOLD_MS = 180;

/** And it must travel this far, so a hold that never moves is not a drag. */
const DRAG_SLOP = 6;

/** Within this of a list's edge, dragging scrolls it. */
const EDGE_BAND = 32;
const EDGE_SPEED = 12;

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

/**
 * Makes the rows of `panel` draggable between its lists.
 *
 * @param {HTMLElement} panel the element that stays put while its contents are
 *   re-rendered; every listener lives on it, so a render cannot drop a gesture.
 * @param {Object} options
 * @param {string} [options.lists] selector for the lists a row may land in
 * @param {function} options.gapText `({slot, afterId}) → string` — what the
 *   insertion line says, so it is never read by position or colour alone
 * @param {function} options.onDrop `({from, to, entryId, afterId})` — commit it;
 *   `afterId` null means the head of that list
 * @returns {{cancel: function, active: function, destroy: function}}
 */
export function installListDrag(panel, { lists = '[data-role="organizer-list"]', gapText, onDrop }) {
  let drag = null;
  let holdTimer = 0;
  let scrollTimer = 0;
  /** The handle a touch is holding but has not yet lifted into a drag. */
  let pending = null;

  function cancel() {
    clearTimeout(holdTimer);
    clearInterval(scrollTimer);
    holdTimer = 0;
    scrollTimer = 0;
    // Left behind, the next pointermove — belonging to some other gesture
    // entirely — would find it and pick that row up.
    pending = null;
    if (!drag) return;
    drag.ghost?.remove();
    drag.row?.classList.remove('is-lifted');
    panel.querySelectorAll('.organizer-gap').forEach(n => n.remove());
    panel.classList.remove('is-dragging');
    drag = null;
  }

  /** Where a drop at this point would land: which list, and after which entry. */
  function dropTargetAt(x, y) {
    const list = [...panel.querySelectorAll(lists)].find((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (!list) return null;
    const slot = list.dataset.slot;
    const rows = [...list.querySelectorAll('.organizer-row')];
    // After the last row whose midpoint is above the pointer. Nothing above it
    // means the head of the list, which an empty list also reports.
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
    // Never colour alone: the line says where, the text says what it means.
    gap.textContent = gapText?.({ slot: target.slot, afterId: target.afterId }) || '';
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
      // across the divider means moving a LIST ITEM, and rendering a real page
      // for the animation would cost a decode for a picture nobody keeps. An
      // equal-height placeholder stays where it came from.
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

  function commit(x, y) {
    const target = dropTargetAt(x, y);
    const request = drag && target
      ? { from: drag.from, to: target.slot, entryId: drag.entryId, afterId: target.afterId }
      : null;
    cancel();
    if (request) onDrop?.(request);
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
      pending = { handle, x: e.clientX, y: e.clientY, id: e.pointerId };
    } else {
      // A stylus or a mouse has already been deliberate by pressing the handle
      // at all.
      beginDrag(handle, e);
    }
  });

  panel.addEventListener('pointermove', (e) => {
    if (pending && !drag) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > DRAG_SLOP && !holdTimer) {
        beginDrag(pending.handle, e);
      }
      return;
    }
    if (!drag) return;
    if (e.isPrimary === false) { cancel(); return; }
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
    pending = null;
    if (!drag || drag.id !== e.pointerId) { cancel(); return; }
    commit(e.clientX, e.clientY);
  };
  panel.addEventListener('pointerup', release);
  panel.addEventListener('pointercancel', () => cancel());
  panel.addEventListener('lostpointercapture', () => { if (drag) cancel(); });

  // Rotation, a resize or the window losing focus all stop an uncommitted drag:
  // its screen coordinates have stopped meaning what they meant.
  window.addEventListener('blur', cancel);
  window.addEventListener('resize', cancel);

  return {
    cancel,
    /** An actual drag is under way (a touch still holding does not count). */
    active: () => !!drag,
    destroy() {
      cancel();
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
    },
  };
}
