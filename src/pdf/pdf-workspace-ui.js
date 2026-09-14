// PDF Module — workspace page wiring.
//
// Owns the import controls and the document library drawer, and hands the
// chosen document to the workspace. Kept separate from PdfWorkspace so the
// workspace itself stays about layout and rendering rather than about file
// pickers and list rendering.

import { PdfWorkspace } from './pdf-workspace.js';
import {
  DOC_ROLES,
  deleteDocument,
  importPdf,
  libraryUsageBytes,
  listDocuments,
  renameDocument,
  setDocumentRole,
} from './pdf-library.js';
import { isPdfRuntimeAvailable } from './pdf-document.js';
import { docViewOrder, forgetDocView } from './document-session.js';
import { deleteDocumentInk } from '../ink/ink-store.js';
import { ENTRY_KINDS } from './deck-state.js';
import { chooseAction, confirmDestructive, promptText } from './deck-dialogs.js';
import { SHELF_KINDS, shelfItems, shelfSubtitle } from './shelf-state.js';
import { BookShelf } from './book-shelf.js';
import { fitRect, playBookOpen } from './book-open.js';
import { openGuide } from './user-guide.js';
import { forgetCover } from './cover-store.js';
import {
  deleteScratchpad,
  listScratchpads,
  renameScratchpad,
} from '../scratch/scratch-store.js';
import {
  deleteNotebook,
  listNotebooks,
  renameNotebook,
} from '../note/note-store.js';
import { nativeFilesAvailable, readDevicePdf } from './pdf-files.js';
import { openDevicePdfPicker } from './pdf-picker.js';
import { t } from '../core/i18n.js';
import Logger from '../core/logger.js';

let workspace = null;
/** Takes the chrome-hiding listeners back off, so a rebuild does not double them. */
let chromeOff = null;
let elRoot = null;

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
  // 书架开着的时候，那条状态栏正被它盖着。
  //
  // 导入的入口现在也在书架上（那个「＋」），于是「正在导入 …」这句话说给了一个
  // 没人看得见的地方——人答完「这份文件是？」之后，等着的是几秒钟的安静。所以
  // 同一句话在书架自己的头上再说一遍；刷新书架时那一行会重新写成新的份数，正好
  // 是这件事结束的样子。
  const shelfEl = elRoot?.querySelector('[data-role="library-usage"]');
  const shelfOpen = !libraryEl()?.hidden;
  if (shelfEl && shelfOpen) {
    shelfEl.textContent = message || '';
    shelfEl.classList.toggle('is-error', !!isError);
  }
}

/**
 * The document whose open is in flight, if any.
 *
 * Module-scoped rather than per-row: the guard has to survive the row being
 * rebuilt by a refresh in the middle of an open.
 */
let openingId = null;

/** 屏幕上那一排书。每次刷新重建——封面都在缓存里，重建是便宜的。 */
let shelf = null;

/** 书架自己那一层。翻书的最后四分之一要把它淡掉，所以动画需要认得它。 */
function libraryEl() {
  return elRoot?.querySelector('[data-role="library"]') || null;
}

async function refreshLibrary() {
  const list = elRoot?.querySelector('[data-role="library-list"]');
  if (!list) return;

  const [docs, usage, pads, notes] = await Promise.all([
    listDocuments(), libraryUsageBytes(), listScratchpads(), listNotebooks(),
  ]);
  const usageEl = elRoot.querySelector('[data-role="library-usage"]');
  if (usageEl) {
    // 笔记本也算进来。原来这行只数文档和草稿纸，于是建了几本笔记之后它还是
    // 说「0 个文档 · 0 张草稿纸」，而架子上明明摆着东西。
    usageEl.textContent = t('shelf.usage', {
      docs: docs.length, notes: notes.length, pads: pads.length, size: formatBytes(usage),
    });
  }

  shelf?.destroy();
  shelf = null;

  const items = shelfItems(docs, pads, docViewOrder(), notes);

  // 一本书都没有时也要把架子搭出来。
  //
  // 原来这里直接回一句「书架上还没有书」就走了——而那正是第一次打开软件看到的
  // 那一屏：一句说现状的话，没有说明书，连「＋」都没有。现在空的时候那句话摆在
  // 架子上面，架子上是说明书和一个「＋」。
  const frag = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'pdf-library-empty';
    empty.textContent = t('shelf.empty');
    frag.appendChild(empty);
  }

  const host = document.createElement('div');
  host.className = 'pdf-shelf';
  frag.appendChild(host);
  list.replaceChildren(frag);
  shelf = new BookShelf(host, {
    onOpen: openItem,
    onMenu: openItemMenu,
    onAdd: () => pickAndImport(DOC_ROLES.EXERCISE),
    onGuide: showGuide,
  });
  shelf.setItems(items);
}

/**
 * 摊开说明书。
 *
 * 盖在书架上，不顶掉书架：人是从书架进来的，看完要回得去，而书架在底下原样待着
 * 就不用重建一次——那些封面都还在。
 */
function showGuide() {
  const host = libraryEl();
  if (!host) return;
  openGuide(host);
}

/**
 * 起飞和落地。
 *
 * 起点是那一格封面此刻在屏幕上的矩形，终点是那一页在目标栏里会占的位置——
 * 不是那一栏本身。双开时它是半边，单开时它是整屏，被收起来的栏量出来是空的，
 * 那就退回整个工作区。三种情形的差别全在这个矩形上，动画本身一行都不用改。
 *
 * 量不出来就不演：没有起点的翻书是凭空长出来的一本书，比直接切过去更难看。
 */
function beginFlight(item, slot) {
  const from = shelf?.tileRect(item.id);
  if (!from || !from.width) return null;
  const box = workspace.slotRect?.(slot) || workspace.root?.getBoundingClientRect();
  if (!box || !box.width) return null;
  return playBookOpen({
    from,
    to: fitRect(from.width / from.height, box),
    coverUrl: shelf.coverUrl(item.id),
    title: item.name,
    veil: libraryEl(),
    onSettled: closeLibrary,
  });
}

/**
 * 点一本书。
 *
 * 一下点开，不是双击——书架上一本书只有一件正面的事可做。改名、换册别、删除
 * 都收在角上那个 ⋯ 里。
 *
 * 还是挡着重入：分栏在问「开到哪一栏」的时候人可以再点一下别的书，两次调用
 * 会各自去要「下一个空栏」，而那时谁都还没填上。
 */
async function openItem(item) {
  if (openingId === item.id) return;
  openingId = item.id;
  let flight = null;
  try {
    // 开到哪一栏是问出来的，不是猜出来的：一栏里本来就叠着一摞，「空的那边」
    // 常常哪边都不是；而册别说的是这份文件「是什么」，不是它该在屏幕的哪半边。
    const slot = await workspace.chooseSlotFor(item.id);
    if (!slot) return;

    flight = beginFlight(item, slot);
    // 先让这一下站稳，再去干那件会占住主线程的活。顺序反过来，书会先愣三百
    // 毫秒再飞——真机上量到的就是这个。
    if (flight) await flight.ready();
    setStatus('正在打开…');
    await workspace.openResource(item.id, { slot, kind: kindForShelf(item) });
    setStatus('');
    if (flight) await flight.land();
    else closeLibrary();
  } catch (error) {
    // 打不开就留在书架上。这时候把书架收掉，人会看着一个空分栏不知道刚才那一
    // 下有没有发生过。
    flight?.cancel();
    Logger.error('PDF', 'open failed', error);
    setStatus('打开失败: ' + error.message, true);
  } finally {
    openingId = null;
  }
}

/** 书架上的一样东西，在摞里是哪一种。 */
function kindForShelf(item) {
  if (item?.kind === SHELF_KINDS.PAD) return ENTRY_KINDS.SCRATCH;
  if (item?.kind === SHELF_KINDS.NOTE) return ENTRY_KINDS.NOTE;
  return ENTRY_KINDS.PDF;
}

/** 一本书的 ⋯。 */
async function openItemMenu(item) {
  const isPad = item.kind === SHELF_KINDS.PAD;
  const isNote = item.kind === SHELF_KINDS.NOTE;
  const actions = [{ id: 'rename', label: '重命名' }];
  // 「标为练习册 / 答案册」只对 PDF 有意义：对题靠的是文字层，而草稿纸和笔记本
  // 上只有手写的笔迹。给它们这两个选项，是让人去设一个永远不会起作用的角色。
  if (!isPad && !isNote) {
    if (item.role !== DOC_ROLES.EXERCISE) actions.push({ id: 'role-exercise', label: '标为练习册' });
    if (item.role !== DOC_ROLES.ANSWER) actions.push({ id: 'role-answer', label: '标为答案册' });
  }
  actions.push({ id: 'delete', label: '永久删除', danger: true });

  const chosen = await chooseAction({
    title: item.name,
    note: shelfSubtitle(item),
    actions,
  });
  if (!chosen) return;

  if (chosen === 'rename') {
    const next = await promptText({
      title: '重命名',
      label: isPad ? '草稿纸名称' : isNote ? t('deck.note') : '书名',
      value: item.name,
      confirm: '保存',
    });
    // 空名字不是名字。清空对书签是「去掉这个名字」，对一本书不是——书没有名字
    // 就没法在架子上被认出来，所以这里把空串和取消一样对待。
    if (!next) return;
    if (isPad) await renameScratchpad(item.id, next);
    else if (isNote) await renameNotebook(item.id, next);
    else await renameDocument(item.id, next);
    await refreshLibrary();
    return;
  }

  if (chosen === 'role-exercise' || chosen === 'role-answer') {
    await setDocumentRole(item.id,
      chosen === 'role-exercise' ? DOC_ROLES.EXERCISE : DOC_ROLES.ANSWER);
    await refreshLibrary();
    return;
  }

  if (chosen === 'delete') await deleteItem(item);
}

/**
 * 永久删除，连它身上挂着的东西一起。
 *
 * 笔迹、读到哪一页、封面缓存都和文件本体分开存着，所以都得点名删掉，否则它们
 * 会比被标注的那份文件活得更久。先从每一摞里撤出去再删字节：不然会留下一条
 * 指着已经不存在的字节的记录——而正在显示它的那一栏应该落到它底下那一份上，
 * 不是变空：丢一本书不该连带赔上同一栏里的另外两本。
 */
async function deleteItem(item) {
  const isPad = item.kind === SHELF_KINDS.PAD;
  const isNote = item.kind === SHELF_KINDS.NOTE;
  const ok = await confirmDestructive({
    title: isPad ? t('scratch.deleteTitle')
      : isNote ? t('note.deleteTitle') : '永久删除这本书？',
    body: isPad ? t('scratch.deleteBody', { name: item.name })
      : isNote ? t('note.deleteBody', { name: item.name })
        : `「${item.name}」连同它上面的笔迹会一起删掉，无法撤销。`,
    confirmLabel: t('scratch.delete'),
  });
  if (!ok) return;

  await workspace.forgetResource(item.id);
  if (isPad) {
    await deleteScratchpad(item.id);
  } else if (isNote) {
    // deleteNotebook 自己会把笔迹一起删掉，和 deleteScratchpad 一样。
    await deleteNotebook(item.id);
  } else {
    await deleteDocument(item.id);
    await deleteDocumentInk(item.id);
  }
  forgetDocView(item.id);
  await forgetCover(item.id);
  await refreshLibrary();
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
 * 「导入」那颗按钮和它点开的那张单子。
 *
 * 两项走的是同一条导入路径，只是把「这份文件是？」那个问题的默认答案先填好——
 * confirmRole 仍然会问，所以选错了还能改。单子不是替它做决定，是让那个问题在被
 * 问出来之前就已经有一个对的默认值。
 *
 * 关掉的三条路都要有，少一条都会留下一张关不掉的单子：按 Escape、点单子以外的任
 * 何地方、以及选了其中一项之后。第二条用捕获阶段的 pointerdown，和 pdf-workspace
 * 里那张栏内单子是同一套做法——用 click 的话，落在别的按钮上的那一下会先触发它自
 * 己的动作，单子还开着。
 */
function bindImportMenu() {
  const host = elRoot.querySelector('.pdf-bar-menu-host');
  const button = elRoot.querySelector('[data-role="import-open"]');
  const menu = elRoot.querySelector('[data-role="import-menu"]');
  if (!host || !button || !menu) return;

  const items = [...menu.querySelectorAll('.pdf-bar-menu-item')];
  const isOpen = () => !menu.hidden;

  const close = ({ focus = false } = {}) => {
    if (!isOpen()) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    // 只有在焦点还在单子里的时候才收回按钮上。人点别处把它关掉时，焦点是那个别
    // 处的——硬抢回来会把他刚点的东西从手里夺走。
    if (focus) button.focus();
  };

  const open = () => {
    if (isOpen()) return;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    items[0]?.focus();
  };

  button.addEventListener('click', () => { if (isOpen()) close({ focus: true }); else open(); });

  document.addEventListener('pointerdown', (e) => {
    if (!isOpen()) return;
    if (host.contains(e.target)) return;
    close();
  }, true);

  elRoot.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.stopPropagation(); close({ focus: true }); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  });

  const ROLES = {
    'import-exercise': DOC_ROLES.EXERCISE,
    'import-answer': DOC_ROLES.ANSWER,
  };
  for (const item of items) {
    const role = ROLES[item.dataset.role];
    if (!role) continue;
    item.addEventListener('click', () => {
      // 先关再开选择器：反过来的话，选择器盖上来时单子还留在底下，选完回来它仍
      // 然开着。
      close();
      pickAndImport(role);
    });
  }
}

/**
 * 挑一份 PDF 然后导入。
 *
 * 两条路，同一个终点。平板上走应用内那张面板——它列的是全机的 PDF，人不用自己翻
 * 目录（见 pdf-picker.js）。浏览器里没有原生插件，退回 &lt;input type="file"&gt;，
 * 那是开发和测试时唯一能用的路。
 *
 * 两条路在 handleImport 之前就合并了：面板给的是一个 File，文件框给的也是 File，
 * 往下只有一套导入逻辑。这是刻意的——第二套导入逻辑会和第一套慢慢长岔。
 *
 * **应用里每一个「导入」都必须走这里**，一共四个入口：横杠单子那两项、书架上那张
 * 「＋」卡片、空工作区卡片上那两颗按钮。它们原来各自去点隐藏的 &lt;input&gt;，于是
 * 同一个动作有两种表现——横杠上弹应用内面板，书架上弹系统选择器。人不会认为那是两
 * 个功能，只会觉得这个应用时好时坏。
 */
export async function pickAndImport(role = DOC_ROLES.EXERCISE) {
  if (!nativeFilesAvailable()) {
    const input = role === DOC_ROLES.ANSWER ? 'file-answer' : 'file-exercise';
    elRoot.querySelector(`[data-role="${input}"]`)?.click();
    return;
  }
  let chosen;
  try {
    chosen = await openDevicePdfPicker({ title: t('picker.title') });
  } catch (error) {
    Logger.error('PDF', 'picker failed', error);
    setStatus(t('picker.failed'), true);
    return;
  }
  if (!chosen) return;

  let file;
  try {
    setStatus(`正在读取 ${chosen.name} …`);
    file = await readDevicePdf(chosen);
  } catch (error) {
    Logger.error('PDF', 'read device pdf failed', error);
    setStatus(`读取 ${chosen.name} 失败`, true);
    return;
  }
  await handleImport([file], role);
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
  // openLibrary 自己会刷新，不必先刷一遍——那是把整架书连同每一张封面重建两次。
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
  // 关掉最后一份文件之后，书架自己回来。空工作区没有别的用途，而人接下来要做
  // 的事就在书架上。
  workspace.onEmpty = () => openLibrary();
  // 空工作区卡片上那两颗「导入」和横杠上的是同一个动作，走同一条路。
  workspace.onImport = (role) => pickAndImport(role);

  chromeOff?.();
  // 菜单栏一动，工具栏就跟着让位——见 initChromeHiding 里那个泵。
  chromeOff = initChromeHiding(elRoot, {
    onChromeMove: () => workspace?.syncToolbarSafeArea?.(),
  });

  bindImportMenu();
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
  // Creating a pad is available before any PDF is opened, which is why this is
  // bound here rather than inside the workspace's own empty state.
  elRoot.querySelector('[data-role="new-scratch"]')?.addEventListener('click', async () => {
    try {
      // 一个按钮，一个对话框，两个模式 —— 草稿纸和笔记本要问的东西几乎完全
      // 重合，横杠上摆两个按钮只会让人先选一次再填一次同样的表。
      await workspace.createPaper();
    } catch (error) {
      Logger.error('PDF', 'create paper failed', error);
      setStatus('新建失败: ' + error.message, true);
    }
  });

  try {
    await workspace.init();
  } catch (error) {
    Logger.error('PDF', 'session restore failed', error);
  }

  // 桌上还摊着东西就接着读，桌上是空的才回书架。
  //
  // 上次退出时手边还开着书，那么「我在读什么」这个问题人自己心里有答案，直接
  // 落回那一页就是；这时候盖一层书架上去，是拿一个他没问的问题挡住他要的东西。
  // 反过来，上次是把书都合上才走的，那再进来时唯一要做的事就是挑一本——而那个
  // 入口原来藏在横杠上一个叫「文档库」的按钮里。
  //
  // 判断用的是恢复之后的工作区，不是存盘里那一行：会话里那份文件可能已经被删
  // 掉了，restoreSession 会把它剔掉，于是「存盘时有」而「恢复后没有」。人看到
  // 的是后者。
  if (workspace.isEmpty()) openLibrary();
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
export function initChromeHiding(elRoot, { onChromeMove } = {}) {
  // Everything below is hung on the document and on the window, and the
  // workspace can be built more than once in a session — leave the last set
  // attached and every gesture is handled twice, which for the swallowed click
  // means the tap AFTER a drag is eaten as well. One controller takes them all
  // off again.
  const life = new AbortController();
  const alive = { signal: life.signal };

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
    // The import row is in the flow, so the panes have just changed height.
    if (which === 'top') window.dispatchEvent(new Event('resize'));
  };

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

  /** How much of the dock's peek strip answers to a STYLUS, in CSS pixels. */
  const PEN_PEEK_WIDTH = 200;

  /**
   * The way back to a hidden dock, which is narrower for a pen than for a hand.
   *
   * A finger at the bottom of the screen is reaching for the dock: there is
   * nothing else down there for it to be doing, so it may call the dock back
   * from anywhere along the strip. A stylus IS doing something else — the
   * bottom of the pane is page, and a line of working that ran along it kept
   * pulling the dock back out from under the writing hand. That is the conflict
   * the tablet run reported.
   *
   * So the pen gets a handle in the middle of the strip rather than the whole
   * of it: far enough from where a line of working ends to be deliberate, and
   * still the obvious place to reach for. Only the way BACK is narrowed —
   * putting the dock away is untouched, for the pen and the hand alike.
   */
  const dockSummonBox = (pointerType) => {
    const box = boxOf(peek);
    if (!box || pointerType !== 'pen') return box;
    const middle = (box.left + box.right) / 2;
    const half = Math.min(PEN_PEEK_WIDTH, box.right - box.left) / 2;
    return { left: middle - half, right: middle + half, top: box.top, bottom: box.bottom };
  };

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
  /**
   * 菜单栏在动的这段时间里，每一帧都告诉外面一声。
   *
   * 这是「菜单栏把工具栏顶起来」那件事的动力：工具栏的底边安全区是按菜单栏此刻
   * 的上沿算的，所以只要每帧重算一次，它就贴着菜单栏走——手慢慢滑，它慢慢让；
   * 手停住，它也停住。用 CSS 过渡去追是追不出这个效果的，那样它只会在菜单栏
   * 到位之后自己滑一段。
   *
   * 拖的过程和松手之后那段自己走完的路，都被 is-*-moving 这个类框住了，所以
   * 一个泵盯着它就够，不必在指针事件和收尾两处各接一次。
   */
  let pumping = false;
  const pump = () => {
    onChromeMove?.();
    const moving = document.body.classList.contains('is-top-moving')
      || document.body.classList.contains('is-bottom-moving')
      || !!drag;
    if (!moving || life.signal.aborted) { pumping = false; return; }
    requestAnimationFrame(pump);
  };

  const markMoving = (which) => {
    if (!pumping && typeof requestAnimationFrame === 'function') {
      pumping = true;
      requestAnimationFrame(pump);
    }
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
    } else if (isHidden('bottom') && inBox(dockSummonBox(e.pointerType), x, y)) {
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

  try {
    if (localStorage.getItem('ls_chrome_top') === '1') setHidden('top', true);
    if (localStorage.getItem('ls_chrome_bottom') === '1') setHidden('bottom', true);
  } catch (_) { /* storage unavailable: start with both showing */ }

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
