// PDF Module — workspace page wiring.
//
// Owns the import controls and the document library drawer, and hands the
// chosen document to the workspace. Kept separate from PdfWorkspace so the
// workspace itself stays about layout and rendering rather than about file
// pickers and list rendering.

import { PdfWorkspace } from './pdf-workspace.js';
import { SLOTS } from './workspace-state.js';
import {
  DOC_ROLES,
  deleteDocument,
  importPdf,
  libraryUsageBytes,
  listDocuments,
} from './pdf-library.js';
import { onDoubleTap } from '../ui/double-tap.js';
import { isPdfRuntimeAvailable } from './pdf-document.js';
import { deleteDocumentInk } from '../ink/ink-store.js';
import Logger from '../core/logger.js';

let workspace = null;
/** Takes the chrome-hiding listeners back off, so a rebuild does not double them. */
let chromeOff = null;
let elRoot = null;

const SLOT_LABELS = {
  [SLOTS.PRIMARY]: '左/上',
  [SLOTS.SECONDARY]: '右/下',
};

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function setStatus(message, isError) {
  const el = elRoot?.querySelector('[data-role="pdf-status"]');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('is-error', !!isError);
}

/**
 * The document whose open is in flight, if any.
 *
 * Module-scoped rather than per-row: the guard has to survive the row being
 * rebuilt by a refresh in the middle of an open.
 */
let openingId = null;

async function refreshLibrary() {
  const list = elRoot?.querySelector('[data-role="library-list"]');
  if (!list) return;

  const [docs, usage] = await Promise.all([listDocuments(), libraryUsageBytes()]);
  const usageEl = elRoot.querySelector('[data-role="library-usage"]');
  if (usageEl) usageEl.textContent = `${docs.length} 个文档 · ${formatBytes(usage)}`;

  if (docs.length === 0) {
    list.innerHTML = '<div class="pdf-library-empty">还没有导入任何 PDF</div>';
    return;
  }

  list.replaceChildren(...docs.map((doc) => {
    const row = document.createElement('div');
    row.className = 'pdf-library-row';
    row.title = '双击打开';

    const info = document.createElement('div');
    info.className = 'pdf-library-info';
    const roleTag = doc.role === DOC_ROLES.EXERCISE ? '练习'
      : doc.role === DOC_ROLES.ANSWER ? '答案' : '';
    info.innerHTML = `
      <div class="pdf-library-name">${escapeHtml(doc.name)}${roleTag ? ` <span class="pdf-role-tag">${roleTag}</span>` : ''}</div>
      <div class="pdf-library-meta">${doc.pageCount} 页 · ${formatBytes(doc.sizeBytes)} · ${doc.hasOutline ? '有目录' : '无目录'}</div>
    `;
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'pdf-library-actions';
    // One button, not one per side.
    //
    // The page holds two documents; the first one opened takes the left pane
    // and the second takes the right. Asking the user to choose a side up front
    // made them decide something they had no basis to decide yet — and it was
    // the wrong moment to ask, because the arrangement is trivially changed
    // afterwards with the swap control on the divider.
    // One open path, two ways to reach it.
    //
    // Guarded against a second activation while the first is still in flight:
    // a double-tap on the button itself, or an impatient second tap on the
    // row, would otherwise open the same document into BOTH panes — the two
    // calls each ask for the next free slot before either has filled one.
    const openDoc = async () => {
      if (openingId === doc.id) return;
      openingId = doc.id;
      const slot = workspace.nextFreeSlot();
      try {
        setStatus('正在打开…');
        await workspace.openDocument(slot, doc.id);
        setStatus('');
        closeLibrary();
      } catch (error) {
        Logger.error('PDF', 'open failed', error);
        setStatus('打开失败: ' + error.message, true);
      } finally {
        openingId = null;
      }
    };

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'pdf-library-btn is-primary';
    open.textContent = '打开';
    open.title = '打开到空的一侧';
    open.addEventListener('click', openDoc);
    actions.appendChild(open);

    // Double-tap the row. The buttons speak for themselves, so a tap that
    // lands on one is a tap on IT, not on the row around it.
    onDoubleTap(row, openDoc, { ignore: '.pdf-library-actions' });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pdf-library-btn is-danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      // Deleting a document that is currently open would leave a pane bound to
      // bytes that no longer exist, so close those slots first.
      for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
        if (workspace.state.documents[slot] === doc.id) workspace.closeSlot(slot);
      }
      await deleteDocument(doc.id);
      // Ink is stored separately from the PDF, so it has to be cleaned up
      // explicitly or it would outlive the document it annotates.
      await deleteDocumentInk(doc.id);
      await refreshLibrary();
    });
    actions.appendChild(del);

    row.appendChild(actions);
    return row;
  }));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function openLibrary() {
  elRoot?.querySelector('[data-role="library"]')?.removeAttribute('hidden');
  // Nothing to draw on while the library is open, and the floating toolbar was
  // being painted over the file list.
  document.body.classList.add('is-library-open');
  refreshLibrary();
}

function closeLibrary() {
  elRoot?.querySelector('[data-role="library"]')?.setAttribute('hidden', '');
  document.body.classList.remove('is-library-open');
}

/**
 * Asks the user to confirm what a file is before it is stored.
 *
 * The role drives answer matching, so getting it wrong means the app looks for
 * answers inside the exercise book. The button pressed is only a default —
 * picking the wrong one is easy, and it is far cheaper to confirm here than to
 * discover it later as "no answers found".
 *
 * @returns {Promise<string|null>} chosen role, or null if cancelled
 */
function confirmRole(file, suggested) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'pdf-role-overlay';
    overlay.innerHTML = `
      <div class="pdf-role-dialog" role="dialog" aria-modal="true">
        <div class="pdf-role-title">这份文件是？</div>
        <div class="pdf-role-file">${escapeHtml(file.name)}</div>
        <div class="pdf-role-options">
          <button type="button" data-role="${DOC_ROLES.EXERCISE}"
            class="${suggested === DOC_ROLES.EXERCISE ? 'is-suggested' : ''}">习题册（题目）</button>
          <button type="button" data-role="${DOC_ROLES.ANSWER}"
            class="${suggested === DOC_ROLES.ANSWER ? 'is-suggested' : ''}">答案册（答案）</button>
        </div>
        <button type="button" class="pdf-role-cancel" data-role="cancel">取消</button>
      </div>`;
    elRoot.appendChild(overlay);

    const finish = (value) => { overlay.remove(); resolve(value); };
    overlay.querySelectorAll('[data-role]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = button.dataset.role;
        finish(value === 'cancel' ? null : value);
      });
    });
  });
}

/**
 * Imports one document.
 *
 * One at a time, deliberately. The pickers no longer carry `multiple` and this
 * takes only the first entry even if a file list arrives from somewhere else
 * (a drop, a share intent). A batch import asked the role question once per
 * file in a modal chain, and a run that failed on file three left files one and
 * two imported with no way to tell from the status line which had landed.
 */
async function handleImport(files, suggestedRole) {
  const file = files && files[0];
  if (!file) return;

  const role = await confirmRole(file, suggestedRole);
  if (role === null) { setStatus('已取消导入'); return; }

  try {
    setStatus(`正在导入 ${file.name} …`);
    await importPdf(file, role);
  } catch (error) {
    Logger.error('PDF', 'import failed', error);
    const reason = error.message === 'PDF_STORAGE_FULL'
      ? '设备存储空间不足，请先删除一些文档再导入'
      : error.message;
    setStatus(`导入 ${file.name} 失败: ${reason}`, true);
    return;
  }

  setStatus('已导入 1 个文档');
  await refreshLibrary();
  openLibrary();
}

/** Builds the PDF page and restores the previous workspace session. */
export async function initPdfWorkspace() {
  elRoot = document.getElementById('page-pdf');
  if (!elRoot) return;

  if (!isPdfRuntimeAvailable()) {
    elRoot.innerHTML = '<div class="pdf-runtime-missing">PDF 运行时未加载，无法使用 PDF 工作区。</div>';
    Logger.warn('PDF', 'pdfjsLib global is unavailable; workspace disabled');
    return;
  }

  const host = elRoot.querySelector('[data-role="workspace"]');
  if (!host) return;

  workspace = new PdfWorkspace(host);

  chromeOff?.();
  chromeOff = initChromeHiding(elRoot);

  elRoot.querySelector('[data-role="import-exercise"]')?.addEventListener('click', () => {
    elRoot.querySelector('[data-role="file-exercise"]')?.click();
  });
  elRoot.querySelector('[data-role="import-answer"]')?.addEventListener('click', () => {
    elRoot.querySelector('[data-role="file-answer"]')?.click();
  });
  elRoot.querySelector('[data-role="file-exercise"]')?.addEventListener('change', (e) => {
    handleImport(Array.from(e.target.files || []), DOC_ROLES.EXERCISE);
    e.target.value = '';
  });
  elRoot.querySelector('[data-role="file-answer"]')?.addEventListener('change', (e) => {
    handleImport(Array.from(e.target.files || []), DOC_ROLES.ANSWER);
    e.target.value = '';
  });
  elRoot.querySelector('[data-role="open-library"]')?.addEventListener('click', openLibrary);
  elRoot.querySelector('[data-role="close-library"]')?.addEventListener('click', closeLibrary);

  try {
    await workspace.init();
  } catch (error) {
    Logger.error('PDF', 'session restore failed', error);
  }
  await refreshLibrary();
}

/** Exposed for teardown in tests and for release(). */
export function destroyPdfWorkspace() {
  workspace?.destroy();
  workspace = null;
  chromeOff?.();
  chromeOff = null;
}

// ── hiding the two bars ─────────────────────────────────────────────────────

/**
 * Slide the import row up to put it away, and the dock down.
 *
 * Two bars, two states, no relationship between them: putting the dock away to
 * read a page is not a reason to lose the import row, and the reverse. The
 * button in the corner is the way back — it restores whatever is hidden, and
 * puts both away when nothing is.
 *
 * The gesture is read from pointer events, so a finger, a stylus and a mouse
 * all work the same way, and it only fires on a deliberate travel: a bar you
 * brush past on the way to a button must not disappear.
 */
export function initChromeHiding(elRoot) {
  // Everything below is hung on the document and on the window, and the
  // workspace can be built more than once in a session — leave the last set
  // attached and every gesture is handled twice, which for the swallowed click
  // means the tap AFTER a drag is eaten as well. One controller takes them all
  // off again.
  const life = new AbortController();
  const alive = { signal: life.signal };

  const toggle = elRoot?.querySelector('[data-role="chrome-toggle"]');
  const topBar = elRoot?.querySelector('.pdf-page-bar');
  const dock = document.querySelector('.bottom-nav');
  const peek = document.querySelector('[data-role="dock-peek"]');
  const barPeek = document.querySelector('[data-role="bar-peek"]');
  const body = document.body;

  /** How far each bar has to travel to be gone — its own height. */
  const topBarHeight = () => {
    const v = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--pdf-bar-h'));
    return Number.isFinite(v) && v > 0 ? v : 44;
  };
  const dockHeight = () => {
    const r = dock?.getBoundingClientRect();
    return r && r.height > 0 ? r.height : 66;
  };

  /** How far a swipe must travel before it counts as one. */
  const TRAVEL = 26;

  const isHidden = (which) => body.classList.contains(`is-${which}-hidden`);

  const setHidden = (which, hidden) => {
    if (isHidden(which) === hidden) return;
    markMoving(which);
    body.classList.toggle(`is-${which}-hidden`, hidden);
    try { localStorage.setItem(`ls_chrome_${which}`, hidden ? '1' : '0'); } catch (_) { /* private mode */ }
    syncToggle();
    // The import row is in the flow, so the panes have just changed height.
    if (which === 'top') window.dispatchEvent(new Event('resize'));
  };

  function syncToggle() {
    if (!toggle) return;
    const anyHidden = isHidden('top') || isHidden('bottom');
    toggle.setAttribute('aria-pressed', anyHidden ? 'true' : 'false');
    const label = anyHidden ? '显示工具栏' : '隐藏工具栏';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
  }

  // The row's own height, so hiding it can give exactly that much back.
  const measure = () => {
    if (!topBar || isHidden('top')) return;
    const h = Math.round(topBar.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--pdf-bar-h', `${h}px`);
  };
  measure();
  window.addEventListener('resize', measure, alive);

  /**
   * Dragging a bar away, and dragging it back.
   *
   * The bar is placed by a number — 0 out, 1 away — and while a finger is down
   * that number is simply where the finger is. So the bar leaves under the hand
   * rather than after it, and a drag that changes its mind halfway brings the
   * bar back with it. On release it finishes the journey itself, to whichever
   * end it is nearer, or to wherever a flick was headed.
   *
   * Watched from the document and decided by where the press STARTED, because a
   * bar is 44px tall: dragging it away means leaving it, and a pointerup lands
   * on whatever is under the finger by then, which is not the bar.
   */

  /**
   * How far down the screen a press still counts as reaching for the import row.
   *
   * Generous on purpose: it is a gesture with nothing to aim at, and the only
   * other thing a vertical drag does up here is nothing — the pane's own bar
   * scrolls sideways. A tap is unaffected either way, because a drag is not a
   * drag until it has travelled.
   */
  const EDGE_TOP = 96;
  /** Past this fraction of the way, letting go finishes the journey. */
  const SETTLE = 0.4;
  /** A flick this fast commits regardless of how far it got. */
  const FLICK = 0.5;   // px per ms
  /**
   * How far above the dock a press still counts as taking hold of it.
   *
   * This is now the whole of it. The dock's glass runs 360-840 and its two
   * capsules run 370-830, so there is five pixels of bar either side of them
   * and nothing else — and a press on a capsule is a press on the capsule, not
   * a hold on the dock. What is left to take hold of is the band above, so the
   * band has to be worth aiming at: a thumb coming up off the bezel lands here.
   *
   * It is over the page, which costs nothing — the page turns on a SIDEWAYS
   * drag, and ink is drawn with the pen.
   */
  const DOCK_REACH = 76;
  /** Travel before a press becomes a drag rather than a wandering tap. */
  const DRAG_START = 12;

  /**
   * The band the dock is taken hold of by — above it, never on it.
   *
   * Reaching INTO the dock left a boundary where both things fired at once: a
   * finger on the few pixels between the dock's edge and a capsule's edge is
   * on the capsule as far as the eye goes, and was on the bar as far as the
   * box test went, so it both pressed 课本 and started dragging the dock away.
   * There is no width of glass there worth defending — the capsules run
   * 370-830 inside a bar that runs 360-840 — so the bar keeps none of it.
   */
  const dockGrip = () => {
    const r = dock?.getBoundingClientRect();
    if (!r || !r.width) return null;
    return { left: r.left, right: r.right, top: r.top - DOCK_REACH, bottom: r.top };
  };

  const boxOf = (el, padTop = 0) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    return { left: r.left, right: r.right, top: r.top - padTop, bottom: r.bottom };
  };
  const inBox = (b, x, y) => !!b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

  let drag = null;

  /**
   * How long a bar is treated as still moving after it is let go.
   *
   * A shade past the 0.32s the transform takes, so the controls come back only
   * once the bar has actually arrived.
   */
  const MOVE_SETTLE = 380;
  const moveTimers = { top: 0, bottom: 0 };

  /**
   * Marks a bar as in motion, which puts the controls on it out of reach.
   *
   * The other half of keeping the two gestures apart: a bar arriving under a
   * resting thumb, or leaving from under one, must not register as a press. The
   * swallowed click was not enough on its own — it catches the click a drag
   * produces, but not a finger that comes down on a bar already in flight.
   *
   * Timed rather than waiting for transitionend, because a drag that does not
   * cross the threshold settles BACK to where it started: the class never
   * changes, and on some paths neither does the transform, so the event that
   * would end this may never arrive.
   */
  const markMoving = (which) => {
    document.body.classList.add(`is-${which}-moving`);
    clearTimeout(moveTimers[which]);
    moveTimers[which] = setTimeout(() => {
      document.body.classList.remove(`is-${which}-moving`);
    }, MOVE_SETTLE);
  };

  const setProgress = (which, p) => {
    document.body.style.setProperty(`--${which}-drag`, String(p));
  };

  const clearProgress = (which) => {
    document.body.style.removeProperty(`--${which}-drag`);
  };

  /**
   * Whether the press landed on something meant to be pressed.
   *
   * A capsule and the bar under it want opposite things from the same finger,
   * and there is no reading of a gesture that gives both. So they are separated
   * by where it starts: on 课本, on 设置, on 导入练习册 — on any control at all —
   * the bar does not move, whatever the finger does next. The bar is taken hold
   * of by its own glass, of which there is plenty either side of the capsules,
   * or by the strip it leaves behind.
   */
  const onControl = (t) => !!(t && t.closest)
    && !!t.closest('button, a, input, select, textarea, [role="button"], [role="tab"]');

  document.addEventListener('pointerdown', (e) => {
    drag = null;
    if (document.body.classList.contains('is-library-open')) return;
    if (onControl(e.target)) return;
    const x = e.clientX;
    const y = e.clientY;

    // Taking hold of a bar that is out, to push it away.
    if (!isHidden('top') && inBox(boxOf(topBar), x, y)) {
      drag = { which: 'top', from: 0, span: Math.max(24, topBar.getBoundingClientRect().height), sign: -1 };
    } else if (!isHidden('bottom') && inBox(dockGrip(), x, y)) {
      drag = { which: 'bottom', from: 0, span: Math.max(24, dock.getBoundingClientRect().height), sign: 1 };
    // Taking hold of one that is away, to pull it back.
    } else if (isHidden('top') && (inBox(boxOf(barPeek), x, y) || y <= EDGE_TOP)) {
      drag = { which: 'top', from: 1, span: topBarHeight(), sign: -1 };
    } else if (isHidden('bottom') && inBox(boxOf(peek), x, y)) {
      drag = { which: 'bottom', from: 1, span: dockHeight(), sign: 1 };
    }
    if (!drag) return;
    drag.x = x;
    drag.y = y;
    drag.at = e.timeStamp || performance.now();
    drag.moved = false;
  }, { passive: true, ...alive });

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      // A finger resting on a button wanders several pixels before it lifts, and
      // at four the dock started sliding under every press — so the tap became a
      // drag, the click was swallowed as one, and 课本 and 设置 simply stopped
      // working every so often. Past twelve it was meant.
      if (Math.abs(dy) < DRAG_START) return;
      // And it has to be going mostly up or down. A thumb sliding along the dock
      // is not reaching for it.
      if (Math.abs(dy) < Math.abs(e.clientX - drag.x)) return;
      drag.moved = true;
      document.body.classList.add('is-chrome-dragging');
    }
    markMoving(drag.which);
    // Toward 1 is away; `sign` says which direction that is for this bar.
    const p = Math.max(0, Math.min(1, drag.from + (dy * drag.sign) / drag.span));
    drag.p = p;
    // Kept for the flick test: the speed of the LAST stretch of the gesture,
    // not its average. A slow drag that changes its mind at the end has a
    // healthy average speed in the wrong direction, and averaging would send
    // the bar away from under a hand that was bringing it back.
    drag.prevY = drag.lastY ?? drag.y;
    drag.prevAt = drag.lastAt ?? drag.at;
    drag.lastY = e.clientY;
    drag.lastAt = e.timeStamp || performance.now();
    setProgress(drag.which, p);
  }, { passive: true, ...alive });

  const endDrag = (e) => {
    if (!drag) return;
    const { which } = drag;
    const p = drag.p;
    const moved = drag.moved;
    const dt = Math.max(1, (drag.lastAt ?? drag.at) - (drag.prevAt ?? drag.at));
    const v = moved ? ((drag.lastY ?? drag.y) - (drag.prevY ?? drag.y)) * drag.sign / dt : 0;
    drag = null;
    document.body.classList.remove('is-chrome-dragging');
    if (!moved || p === undefined) { clearProgress(which); return; }
    armSwallow();

    // Thrown hard enough, it goes where it was thrown; otherwise it finishes
    // whichever journey it is nearer to completing.
    const away = v > FLICK ? true : v < -FLICK ? false : p >= SETTLE;
    clearProgress(which);           // the class takes over, and it transitions
    markMoving(which);              // and it is out of reach until it lands
    setHidden(which, away);
  };

  /**
   * A drag must not also press the thing it started on.
   *
   * The gesture begins on the dock, and the dock is two buttons — so pulling it
   * away ended on 课本 or 设置 and changed the page as it went. The click the
   * browser synthesises afterwards is swallowed once, in the capture phase,
   * before it can reach them. Only after a real drag: a tap is left alone, or
   * the bars would stop working as buttons.
   */
  let swallowClick = false;
  let swallowTimer = 0;

  /**
   * Swallow the click this drag is about to produce — and only that one.
   *
   * A drag that ends somewhere with nothing to click produces no click at all,
   * and the flag would then sit armed until the user's NEXT press, eating a tap
   * they meant. It is dropped again on the turn of the event loop, which is
   * later than the synthesised click and sooner than any human.
   */
  const armSwallow = () => {
    swallowClick = true;
    clearTimeout(swallowTimer);
    swallowTimer = setTimeout(() => { swallowClick = false; }, 350);
  };

  document.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    clearTimeout(swallowTimer);
    e.stopPropagation();
    e.preventDefault();
  }, { capture: true, ...alive });

  document.addEventListener('pointerup', endDrag, { passive: true, ...alive });
  document.addEventListener('pointercancel', () => {
    if (!drag) return;
    const which = drag.which;
    drag = null;
    document.body.classList.remove('is-chrome-dragging');
    clearProgress(which);
  }, { passive: true, ...alive });

  toggle?.addEventListener('click', () => {
    // Anything hidden: bring it all back. Nothing hidden: put it all away.
    const restore = isHidden('top') || isHidden('bottom');
    setHidden('top', !restore);
    setHidden('bottom', !restore);
  }, alive);

  try {
    if (localStorage.getItem('ls_chrome_top') === '1') setHidden('top', true);
    if (localStorage.getItem('ls_chrome_bottom') === '1') setHidden('bottom', true);
  } catch (_) { /* storage unavailable: start with both showing */ }
  syncToggle();

  return () => {
    life.abort();
    clearTimeout(swallowTimer);
    clearTimeout(moveTimers.top);
    clearTimeout(moveTimers.bottom);
    document.body.classList.remove('is-chrome-dragging', 'is-top-moving', 'is-bottom-moving');
    clearProgress('top');
    clearProgress('bottom');
  };
}
