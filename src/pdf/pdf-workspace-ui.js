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

  initChromeHiding(elRoot);

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
function initChromeHiding(elRoot) {
  const toggle = elRoot?.querySelector('[data-role="chrome-toggle"]');
  const topBar = elRoot?.querySelector('.pdf-page-bar');
  const dock = document.querySelector('.bottom-nav');
  const body = document.body;

  /** How far a swipe must travel before it counts as one. */
  const TRAVEL = 26;

  const isHidden = (which) => body.classList.contains(`is-${which}-hidden`);

  const setHidden = (which, hidden) => {
    if (isHidden(which) === hidden) return;
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
  window.addEventListener('resize', measure);

  /**
   * A swipe over a bar puts it away: up for the top one, down for the dock.
   *
   * Watched from the document and decided by where the press STARTED, rather
   * than by listening on the bars themselves. A bar is 44px tall, so swiping it
   * away means leaving it, and a pointerup is delivered to whatever is under the
   * finger by then — the page, not the bar. Capturing the pointer fixes that in
   * a browser and did not survive the trip through the WebView, so the bar's
   * box is simply tested at the start instead. Nothing is captured, nothing is
   * prevented, and a tap still reaches the buttons: only a real vertical travel
   * counts as a swipe.
   */
  const within = (el, x, y) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  let grab = null;
  document.addEventListener('pointerdown', (e) => {
    grab = null;
    if (document.body.classList.contains('is-library-open')) return;
    if (!isHidden('top') && within(topBar, e.clientX, e.clientY)) {
      grab = { which: 'top', want: 'up', x: e.clientX, y: e.clientY };
    } else if (!isHidden('bottom') && within(dock, e.clientX, e.clientY)) {
      grab = { which: 'bottom', want: 'down', x: e.clientX, y: e.clientY };
    }
  }, { passive: true });

  // Acted on as soon as the travel is there, rather than waiting for the finger
  // to lift. A gesture over a bar can be taken away mid-flight — the WebView
  // decides it was a scroll and sends pointercancel, and no pointerup ever
  // arrives — so a swipe that waits for the lift is a swipe that sometimes does
  // nothing at all. It also simply feels better: the bar leaves under the
  // finger instead of after it.
  document.addEventListener('pointermove', (e) => {
    if (!grab) return;
    const { which, want, x, y } = grab;
    const dy = e.clientY - y;
    if (Math.abs(dy) < TRAVEL || Math.abs(dy) < Math.abs(e.clientX - x)) return;
    grab = null;
    if (want === 'up' ? dy < 0 : dy > 0) setHidden(which, true);
  }, { passive: true });

  document.addEventListener('pointerup', () => { grab = null; }, { passive: true });
  document.addEventListener('pointercancel', () => { grab = null; }, { passive: true });

  /**
   * Swipe in from the edge a bar went out at, and it comes back.
   *
   * Listened for on the document rather than through a strip of its own, so
   * there is nothing lying over the top of the page waiting to swallow a tap
   * meant for the pane's own controls. A gesture that does not qualify is left
   * entirely alone — nothing is captured and nothing is prevented.
   */
  /**
   * Where a bar can be called back from.
   *
   * The top one comes back from the very top: there is nothing else up there.
   *
   * The bottom one does NOT. The last stripe of a tablet screen belongs to the
   * system's own back-and-home gesture, and a band sitting in it is a band that
   * loses every second attempt to Android. So the bottom band stops short of the
   * edge and is made deep enough to be found without aiming — it is a long way
   * up the screen before it stops being "the bottom".
   */
  const EDGE_TOP = 34;
  const EDGE_BOTTOM_SKIP = 26;    // left to the system gesture
  const EDGE_BOTTOM_DEPTH = 120;  // and this much above that is ours

  let edge = null;
  document.addEventListener('pointerdown', (e) => {
    edge = null;
    if (document.body.classList.contains('is-library-open')) return;
    const y = e.clientY;
    const h = window.innerHeight;
    if (isHidden('top') && y <= EDGE_TOP) {
      edge = { which: 'top', want: 'down', y };
    } else if (isHidden('bottom')
        && y <= h - EDGE_BOTTOM_SKIP
        && y >= h - EDGE_BOTTOM_SKIP - EDGE_BOTTOM_DEPTH) {
      edge = { which: 'bottom', want: 'up', y };
    }
  }, { passive: true });

  document.addEventListener('pointermove', (e) => {
    if (!edge) return;
    const { which, want, y } = edge;
    const dy = e.clientY - y;
    if (Math.abs(dy) < TRAVEL) return;
    edge = null;
    if (want === 'down' ? dy > 0 : dy < 0) setHidden(which, false);
  }, { passive: true });

  document.addEventListener('pointerup', () => { edge = null; }, { passive: true });
  document.addEventListener('pointercancel', () => { edge = null; }, { passive: true });

  toggle?.addEventListener('click', () => {
    // Anything hidden: bring it all back. Nothing hidden: put it all away.
    const restore = isHidden('top') || isHidden('bottom');
    setHidden('top', !restore);
    setHidden('bottom', !restore);
  });

  try {
    if (localStorage.getItem('ls_chrome_top') === '1') setHidden('top', true);
    if (localStorage.getItem('ls_chrome_bottom') === '1') setHidden('bottom', true);
  } catch (_) { /* storage unavailable: start with both showing */ }
  syncToggle();
}
