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
import {
  chooseAction,
  chooseFolder,
  confirmDestructive,
  pickResources,
  promptText,
} from './deck-dialogs.js';
import { SHELF_KINDS, shelfItems, shelfSubtitle } from './shelf-state.js';
import {
  COMBO_ERRORS,
  COMBO_MAX,
  deleteCombo,
  getCombo,
  listCombos,
  renameCombo,
  replaceCombo,
  saveCombo,
} from './combo-store.js';
import { comboFacing, comboSize, pruneCombo } from './combo-state.js';
import { openComboBuilder } from './combo-builder.js';
import {
  FOLDER_ERRORS,
  addFolder,
  deleteFolder,
  folderMembers,
  listFolders,
  moveToFolder,
  pruneFolders,
  renameFolder,
} from './folder-store.js';
// 组合的显示图上两栏各画在哪一块 —— 翻开它的时候那两本书就从那两块起飞。
import { comboPaneBoxes } from './combo-cover.js';
import { ORIENTATIONS, SLOTS } from './workspace-state.js';
import { BookShelf } from './book-shelf.js';
import { fitRect, playBookOpen } from './book-open.js';
import { openGuide } from './user-guide.js';
import { initTopBarFit } from './top-bar-fit.js';
import { initTopRowDock } from './top-row-dock.js';
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
import {
  FILES_ERRORS,
  nativeFilesAvailable,
  readDevicePdf,
  writeExportFile,
} from './pdf-files.js';
import { PERMISSION, ensureFilesPermission, openDevicePdfPicker } from './pdf-picker.js';
import { EXPORT_KINDS, buildExport } from '../export/export-document.js';
import { EXPORT_ERRORS, exportFileName } from '../export/pdf-export.js';
import { ensureExportPermission, introduceFilesPermission } from '../export/export-permission.js';
import { saveFile, showSaveToast } from '../export/save-file.js';
import { t } from '../core/i18n.js';
import Logger from '../core/logger.js';

let workspace = null;
/** Takes the chrome-hiding listeners back off, so a rebuild does not double them. */
let chromeOff = null;
/** 同理：顶上那一排「窄了先收字」的那个观察器。 */
let topBarOff = null;
/** 顶上那一排里给工具栏停的地方（top-row-dock.js）。重建工作区时换一个新的。 */
let topRowDock = null;
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

/**
 * 正开着的那个文件夹；null 就是最外面那一层。
 *
 * 放在模块上而不是放进 refreshLibrary 的参数里：关掉书架再打开，人回到的应该还是
 * 他刚才在的那一格。一个人整理「高代」的时候会连着开好几本，每次都被扔回最外层，
 * 等于每开一本都要再走一遍进来的路。
 */
let openFolderId = null;

/** 书架自己那一层。翻书的最后四分之一要把它淡掉，所以动画需要认得它。 */
function libraryEl() {
  return elRoot?.querySelector('[data-role="library"]') || null;
}

/**
 * 进了文件夹之后，架子上面那一条。
 *
 * 它有三件事要说，缺一件人就会卡住：这是哪个文件夹、怎么回去、怎么往里放东西。
 * 「怎么回去」排在最左边——摊开一个只显示三本书的文档库，人的第一个念头是「我别
 * 的书呢」，而那一条必须在他找之前就答上。
 */
function folderBar(folder, count) {
  const bar = document.createElement('div');
  bar.className = 'pdf-folder-bar';
  bar.innerHTML = `
    <button type="button" class="pdf-folder-bar-back" data-role="folder-back">
      <span aria-hidden="true">‹</span><span data-role="back-label"></span>
    </button>
    <span class="pdf-folder-bar-face" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linejoin="round">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      </svg>
    </span>
    <span class="pdf-folder-bar-name" data-role="folder-name"></span>
    <span class="pdf-folder-bar-count" data-role="folder-count"></span>
    <button type="button" class="pdf-folder-bar-add" data-role="folder-add"></button>`;
  // 名字是人自己起的，走 textContent。
  bar.querySelector('[data-role="back-label"]').textContent = t('folder.back');
  bar.querySelector('[data-role="folder-name"]').textContent = folder.name;
  bar.querySelector('[data-role="folder-count"]').textContent = t('folder.count', { count });
  bar.querySelector('[data-role="folder-add"]').textContent = t('folder.addHere');
  bar.querySelector('[data-role="folder-back"]').addEventListener('click', () => {
    openFolderId = null;
    refreshLibrary();
  });
  bar.querySelector('[data-role="folder-add"]').addEventListener('click', () => addIntoFolder(folder.id));
  return bar;
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

  // 组合里可能指着已经被删掉的书。在摆上架子之前修剪一次：一个点开只会开出
  // 半套的组合，比一个不存在的组合更让人困惑，而修剪的信息只有这里齐全。
  const alive = new Set([
    ...docs.map((d) => d.id), ...pads.map((p) => p.id), ...notes.map((n) => n.id),
  ]);
  const combos = [];
  for (const combo of listCombos()) {
    const { combo: trimmed, changed } = pruneCombo(combo, (id) => alive.has(id));
    if (changed) replaceCombo(trimmed);
    if (comboSize(trimmed)) combos.push(trimmed);
  }

  // 文件夹里记着的可能是已经被删掉的东西。和组合一样在摆上架子之前修剪：文件夹
  // 上印的份数正是人判断「这里面还有没有东西」的依据，多出几本不存在的书，那个数
  // 就在骗他。这里是唯一一处同时知道四种东西都还剩下谁的地方。
  const { folders, members } = pruneFolders((id) => alive.has(id)
    || combos.some((c) => c.id === id));
  // 开着的那个文件夹被删掉了（比如在另一台设备上），就回到最外面那一层，而不是
  // 摊开一个空架子。
  if (openFolderId && !folders.some((f) => f.id === openFolderId)) openFolderId = null;

  const items = shelfItems(docs, pads, docViewOrder(), notes, combos,
    { folders, members, openFolderId });

  // 组合的显示图是借它那两本书的封面拼的，翻开它时飞出去的也是那两本的封面和名
  // 字。那两本要是收在文件夹里（或者组合收在文件夹里、书在外面），它们不在这一屏
  // 上——书架得额外认得它们，不然组合的图上是两个空框，飞出去的是两张白纸。
  const onView = new Set(items.map((i) => i.id));
  const everything = new Map(shelfItems(docs, pads, [], notes, []).map((i) => [i.id, i]));
  const comboById = new Map(combos.map((c) => [c.id, c]));
  const companions = [];
  for (const item of items) {
    const combo = item.kind === SHELF_KINDS.COMBO ? comboById.get(item.id) : null;
    if (!combo) continue;
    for (const entry of Object.values(comboFacing(combo))) {
      const id = entry?.resourceId;
      if (!id || onView.has(id) || !everything.has(id)) continue;
      onView.add(id);
      companions.push(everything.get(id));
    }
  }

  // 一本书都没有时也要把架子搭出来。
  //
  // 原来这里直接回一句「书架上还没有书」就走了——而那正是第一次打开软件看到的
  // 那一屏：一句说现状的话，没有说明书，连「＋」都没有。现在空的时候那句话摆在
  // 架子上面，架子上是说明书和一个「＋」。
  const frag = document.createDocumentFragment();
  const folder = openFolderId ? folders.find((f) => f.id === openFolderId) : null;
  if (folder) frag.appendChild(folderBar(folder, items.length));
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = folder ? 'pdf-folder-empty' : 'pdf-library-empty';
    empty.textContent = folder ? t('folder.empty') : t('shelf.empty');
    frag.appendChild(empty);
  }

  const host = document.createElement('div');
  host.className = 'pdf-shelf';
  frag.appendChild(host);
  list.replaceChildren(frag);
  shelf = new BookShelf(host, {
    onOpen: openItem,
    onMenu: openItemMenu,
    onAdd: () => (openFolderId ? addIntoFolder() : pickAndImport(DOC_ROLES.EXERCISE)),
    onGuide: openFolderId ? null : showGuide,
  });
  shelf.setItems(items, { companions });
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
  // 进一个文件夹不载入任何东西，所以它不在「正在打开」那道闸后面——那道闸挡的是
  // 两次载入抢同一栏，而这里换的只是架子上摆着谁。
  if (item?.kind === SHELF_KINDS.FOLDER) {
    openFolderId = item.id;
    await refreshLibrary();
    return;
  }
  if (item?.kind === SHELF_KINDS.COMBO) return useCombo(item);
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

// ── 组合：一套「书是怎么摆的」 ─────────────────────────────────────────────

/**
 * 两栏此刻摆着什么，说给人听。
 *
 * 用在那句提醒里。说「会换掉现在开着的东西」是不够的——人得看见换掉的是**哪
 * 两本**才能决定要不要换。
 */
function describeOpen() {
  const names = workspace?.facingNames?.() || [];
  return names.filter(Boolean);
}

/**
 * 用一个组合。
 *
 * 这一下会换掉两栏里的东西，所以先问。问的时候把「换掉的是哪两本」和「它们会
 * 不会丢位置」都说出来——后半句是人真正担心的那件事，而答案恰好是「不会」：
 * 换过去之前每一栏停在哪一页都会记进那本书自己身上，下次再打开还回到那儿。
 */
async function useCombo(item) {
  const combo = getCombo(item.id);
  if (!combo) {
    setStatus(t('combo.gone'), true);
    await refreshLibrary();
    return;
  }

  const open = describeOpen();
  const ok = await confirmDestructive({
    title: t('combo.useTitle', { name: item.name }),
    body: open.length
      ? t('combo.useBodyOpen', { open: open.join(t('combo.join')) })
      : t('combo.useBody'),
    confirmLabel: t('combo.use'),
  });
  if (!ok) return;
  await applyComboNow(item, combo);
}

/**
 * 真的换过去：飞、换、说一句话。
 *
 * 从 useCombo 里拆出来的，因为自由组合存完之后走的是同一条路。差别只在要不要先问
 * 一声——点架子上一个现成的组合是要换掉两栏里的东西，而刚按下「保存并打开」的人
 * 已经答过这个问题了。
 */
async function applyComboNow(item, combo) {
  setStatus(t('combo.applying', { name: item.name }));
  const flights = beginComboFlight(item, combo);
  try {
    // 先让这几下站稳，再去干那件会占住主线程的活。顺序反过来，书会先愣三百
    // 毫秒再飞——和点开一本书那条路一模一样的理由。
    await Promise.all(flights.map((f) => f.ready()));
    const { opened, missing } = await workspace.applyCombo(combo, {
      // 分栏要等这几张纸收干净才滑。在那之前它们整个盖在两栏上，底下怎么动都
      // 看不见。没有飞行可演的时候，这一下就是「把书架收掉」。
      revealed: flights.length
        ? () => Promise.all(flights.map((f) => f.land()))
        : () => { closeLibrary(); },
    });
    // 有开不起来的就说出来，而不是让人自己去发现少了一栏。
    setStatus(missing
      ? t('combo.appliedPartly', { name: item.name, missing })
      : t('combo.applied', { name: item.name, count: opened }));
  } catch (error) {
    // 半路出事就把纸收掉、留在书架上。不收的话屏幕上会停着一张永远不落地的
    // 封面，而底下是没换成的两栏。
    for (const flight of flights) flight.cancel();
    Logger.error('PDF', 'apply combo failed', error);
    setStatus(t('combo.failed'), true);
  }
}

/**
 * 翻开一个组合：两本一起飞。
 *
 * 一本书飞的是它那一格封面；一个组合的显示图上本来就画着两栏，每一栏里是那一
 * 栏当前开着的那本书。所以这里让那两块各自起飞——画在左边的飞去左栏，画在右边
 * 的飞去右栏。起点问 comboPaneBoxes，而那张图正是它排的版，所以书是从人刚才
 * 看着的那一块离开的，不是从某个重新算出来的近似位置。
 *
 * 一栏此刻量不出来就不飞那一栏：收起来的那半边在屏幕上没有位置，没有位置就没
 * 有终点。它会在最后那下分栏滑动里自己张开。两栏都量不出来（书架还没画完、
 * 组合是空的）就整个不演，和 beginFlight 一样——没有起点的翻书是凭空长出来一
 * 本书，比直接切过去更难看。
 *
 * 书架那层纱只交给第一段飞行去淡，收书架也只挂在它身上：两段都收的话，第二次
 * 收的是一层已经不在了的纱。
 */
function beginComboFlight(item, combo) {
  const tile = shelf?.tileRect(item.id);
  if (!tile || !tile.width) return [];
  const boxes = comboPaneBoxes(combo);
  const facing = comboFacing(combo);
  // 起点和终点用同一个形状：书架上的格子是 1:1.414，落地的那一块也按这个比例
  // 放进栏里。一头一个形状的话，书在半路会被抻扁。
  const aspect = tile.width / tile.height;

  // 按**屏幕位置**对位，不按 slot 对位。
  //
  // 一套左右对调过的组合会把 PRIMARY 挪到右边去，而此刻画在右边的可能是
  // SECONDARY。照 slot 飞的话，两本书会各自飞到对面那一栏，落地时那一栏里
  // 却是另一本——看着就像它们在半路上换了个身。applyCombo 那边保证了这两块
  // 的几何在换过去的一瞬间不变，所以「换过去之后画在左边的那一栏」，量的就
  // 是此刻左边那一栏。
  const after = combo.swapped
    ? [SLOTS.SECONDARY, SLOTS.PRIMARY]
    : [SLOTS.PRIMARY, SLOTS.SECONDARY];
  const now = workspace.screenSlots?.() || after;

  const flights = [];
  for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
    const entry = facing[slot];
    if (!entry) continue;
    const box = workspace.slotRect?.(now[after.indexOf(slot)]);
    if (!box || !box.width) continue;
    const cell = boxes[slot];
    const from = fitRect(aspect, {
      left: tile.left + cell.x * tile.width,
      top: tile.top + cell.y * tile.height,
      width: cell.w * tile.width,
      height: cell.h * tile.height,
    });
    if (!(from.width > 1)) continue;
    flights.push(playBookOpen({
      from,
      to: fitRect(aspect, box),
      coverUrl: shelf.coverUrl(entry.resourceId),
      title: shelf.nameOf(entry.resourceId),
      veil: flights.length ? null : libraryEl(),
      onSettled: flights.length ? null : closeLibrary,
    }));
  }
  return flights;
}

/**
 * 横杠上那条「打开组合…」：先列出来让人挑一个。
 *
 * 挑完走的是和书架上点开它完全同一条路（useCombo），所以那句提醒、那次覆盖、
 * 那份退出页记录，两个入口一模一样。两条路各写一遍的话，迟早只有一条记得问。
 */
async function pickCombo() {
  const combos = listCombos();
  if (!combos.length) {
    setStatus(t('combo.none'), true);
    return;
  }
  const chosen = await chooseAction({
    title: t('combo.pickTitle'),
    note: t('combo.pickNote'),
    actions: combos.slice(0, 12).map((c) => ({
      id: c.id,
      label: `${c.name}（${comboSize(c)}${t('combo.booksSuffix')}）`,
    })),
  });
  if (!chosen) return;
  const combo = combos.find((c) => c.id === chosen);
  if (combo) await useCombo({ id: combo.id, name: combo.name });
}

/**
 * 把此刻的摆法存成一个组合。
 *
 * 存的是「哪几本、在哪一栏、什么顺序、怎么切」，**不含页码**——页码属于书，见
 * combo-state.js 开头。所以一个组合过几天再用，书还是回到你最后读到的那一页。
 */
async function saveCurrentCombo() {
  const draft = workspace.snapshotCombo();
  if (!comboSize(draft)) {
    setStatus(t('combo.nothingOpen'), true);
    return;
  }

  // 预填两本书的名字，但那只是个建议：输入框是空着等人改的，整段选中不了才
  // 叫「强加」。人给组合起的名字通常和书名无关——「考前那一套」「批作业」——
  // 而那种名字才是他下次一眼认出它的方式。
  const name = await promptText({
    title: t('combo.saveTitle'),
    label: t('combo.nameLabel'),
    value: describeOpen().filter(Boolean).join(t('combo.nameJoin')).slice(0, 40),
    max: 40,
    confirm: t('combo.save'),
  });
  // 空名字不是名字：一个没有名字的组合在架子上认不出来。和书、草稿纸一样，
  // 清空等同于取消。
  if (!name) return;

  try {
    saveCombo({ ...draft, name });
    setStatus(t('combo.saved', { name }));
  } catch (error) {
    setStatus(error.message === COMBO_ERRORS.FULL ? t('combo.full') : t('combo.saveFailed'), true);
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
  if (item.kind === SHELF_KINDS.FOLDER) return openFolderMenu(item);
  const isPad = item.kind === SHELF_KINDS.PAD;
  const isNote = item.kind === SHELF_KINDS.NOTE;
  const isCombo = item.kind === SHELF_KINDS.COMBO;
  const actions = [{ id: 'rename', label: '重命名' }];
  // 「标为练习册 / 答案册」只对 PDF 有意义：对题靠的是文字层，而草稿纸和笔记本
  // 上只有手写的笔迹。给它们这两个选项，是让人去设一个永远不会起作用的角色。
  if (!isPad && !isNote && !isCombo) {
    if (item.role !== DOC_ROLES.EXERCISE) actions.push({ id: 'role-exercise', label: '标为练习册' });
    if (item.role !== DOC_ROLES.ANSWER) actions.push({ id: 'role-answer', label: '标为答案册' });
  }
  // 分类和「这是什么」是两回事，所以每一样东西都能进文件夹：书、草稿纸、笔记本，
  // 还有组合——对人来说它们都是架子上的一格。
  actions.push({ id: 'folder', label: t('folder.moveItem') });
  // 在文件夹里的那一份，拿出来的路在这里。「移动到文件夹」那张单子顶上只用一句话
  // 说它现在在哪，不再有一行「不在文件夹里」可点——那一行长得像个文件夹，却不是。
  if (folderMembers()[item.id]) actions.push({ id: 'unfolder', label: t('folder.takeOut') });
  // 书、笔记本、草稿纸都能导出成 PDF。组合不是一份文件，是「几本书怎么摆」，没有
  // 东西可导——要导出里面的书，去导出那几本书。
  if (!isCombo) actions.push({ id: 'export', label: t('export.menu') });
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
      label: isCombo ? t('combo.nameLabel')
        : isPad ? '草稿纸名称' : isNote ? t('deck.note') : '书名',
      value: item.name,
      confirm: '保存',
    });
    // 空名字不是名字。清空对书签是「去掉这个名字」，对一本书不是——书没有名字
    // 就没法在架子上被认出来，所以这里把空串和取消一样对待。
    if (!next) return;
    if (isCombo) renameCombo(item.id, next);
    else if (isPad) await renameScratchpad(item.id, next);
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

  if (chosen === 'folder') {
    await moveItemToFolder(item);
    return;
  }

  if (chosen === 'export') {
    await exportAsPdf({ kind: kindForShelf(item), id: item.id, name: item.name });
    return;
  }

  if (chosen === 'unfolder') {
    try {
      moveToFolder(item.id, null);
    } catch (error) {
      Logger.error('PDF', `take out of folder failed: ${error?.message || error}`);
      setStatus(t('folder.failed'), true);
      return;
    }
    setStatus(t('folder.movedOut'));
    await refreshLibrary();
    return;
  }

  if (chosen === 'delete') await deleteItem(item);
}

/**
 * 「移动到文件夹」那张单子，从 ⋯ 里进来。
 *
 * 这是文件夹唯一的入口。书架上没有「新建文件夹」那一格——一个空文件夹对人没有用，
 * 他建文件夹的时刻永远是「这一份该收起来了」的时刻，所以建和放是同一下。
 */
async function moveItemToFolder(item) {
  const members = folderMembers();
  const answer = await chooseFolder({
    itemName: item.name,
    current: members[item.id] || null,
    folders: listFolders().map((f) => ({
      id: f.id,
      name: f.name,
      count: Object.values(members).filter((v) => v === f.id).length,
    })),
    // 建出来的文件夹当场就落盘：这张单子上的「新建」按下去之后，人可能改名、可能
    // 走神、可能直接点「移动」，而其中任何一条路都不该让这个格子消失。
    onCreate: () => {
      try {
        return addFolder('');
      } catch (error) {
        setStatus(error.message === FOLDER_ERRORS.FULL ? t('folder.full') : t('folder.failed'), true);
        return null;
      }
    },
    onRename: (id, name) => renameFolder(id, name),
  });
  if (!answer) return;

  try {
    moveToFolder(item.id, answer.folderId);
  } catch (error) {
    Logger.error('PDF', `move to folder failed: ${error?.message || error}`);
    setStatus(t('folder.failed'), true);
    return;
  }
  const into = answer.folderId ? listFolders().find((f) => f.id === answer.folderId) : null;
  setStatus(into ? t('folder.moved', { name: into.name }) : t('folder.movedOut'));
  await refreshLibrary();
}

/** 文件夹自己的 ⋯：改名、往里放东西、删掉这个格子。 */
async function openFolderMenu(item) {
  const chosen = await chooseAction({
    title: item.name,
    note: shelfSubtitle(item),
    actions: [
      { id: 'rename', label: t('folder.rename') },
      { id: 'add', label: t('folder.addHere') },
      { id: 'delete', label: t('folder.delete'), danger: true },
    ],
  });
  if (!chosen) return;

  if (chosen === 'rename') {
    const next = await promptText({
      title: t('folder.rename'),
      label: t('folder.renameLabel'),
      value: item.name,
      max: 40,
      confirm: '保存',
    });
    if (!next) return;
    renameFolder(item.id, next);
    await refreshLibrary();
    return;
  }

  if (chosen === 'add') {
    await addIntoFolder(item.id);
    return;
  }

  // 删一个文件夹只是把格子拿走。里面的东西回到外面那一排——这一点必须在问话里说
  // 清楚，不然人会以为自己正要把里面几本书一起删掉，而那恰恰是他最怕的事。
  const ok = await confirmDestructive({
    title: t('folder.deleteTitle', { name: item.name }),
    body: t('folder.deleteBody', { count: item.folderSize || 0 }),
    confirmLabel: t('scratch.delete'),
  });
  if (!ok) return;
  deleteFolder(item.id);
  if (openFolderId === item.id) openFolderId = null;
  setStatus(t('folder.deleted', { name: item.name }));
  await refreshLibrary();
}

/**
 * 往一个文件夹里放东西。
 *
 * 两条路：从本机导一份新的进来，或者把已经在文档库里的挪进来。它们是同一个念头的
 * 两种情形——「这个格子里该有点东西」——所以摆在同一张单子上，而不是让人先猜这次
 * 该走「导入」还是该走「移动」。
 */
async function addIntoFolder(folderId = openFolderId) {
  if (!folderId) return;
  const folder = listFolders().find((f) => f.id === folderId);
  if (!folder) return;

  const chosen = await chooseAction({
    title: t('folder.addTitle', { name: folder.name }),
    actions: [
      { id: 'local', label: t('folder.addLocal') },
      { id: 'existing', label: t('folder.addExisting') },
    ],
  });
  if (!chosen) return;

  if (chosen === 'local') {
    // 导入自己会看 openFolderId，所以这里只要保证人是站在这个文件夹里的。
    openFolderId = folderId;
    await pickAndImport(DOC_ROLES.EXERCISE);
    return;
  }

  const outside = (await shelfEverything({ withCombos: true }))
    .filter((one) => (folderMembers()[one.id] || null) !== folderId);
  const picked = await pickResources({
    title: t('folder.pickTitle', { name: folder.name }),
    note: t('folder.pickNote'),
    items: outside,
    confirm: t('folder.pickConfirm'),
  });
  if (!picked?.length) return;

  let moved = 0;
  for (const id of picked) {
    try {
      moveToFolder(id, folderId);
      moved += 1;
    } catch (error) {
      Logger.warn('PDF', `move into folder failed: ${error?.message || error}`);
    }
  }
  setStatus(t('folder.movedIn', { count: moved }));
  await refreshLibrary();
}

/**
 * 文档库里所有能被摆上去、放进去的东西，拍平成一张表。
 *
 * 挑东西那两张单子（往文件夹里放、自由组合）问的都是「都有些什么」，而那个答案不
 * 分层——不管一份东西在哪个文件夹里，它都还在这个文档库里。
 */
async function shelfEverything({ withCombos = false } = {}) {
  const [docs, pads, notes] = await Promise.all([
    listDocuments(), listScratchpads(), listNotebooks(),
  ]);
  const rows = [];
  if (withCombos) {
    for (const combo of listCombos()) {
      rows.push({
        id: combo.id,
        kind: null,
        name: combo.name,
        sub: `${comboSize(combo)}${t('combo.booksSuffix')}`,
      });
    }
  }
  for (const doc of docs) {
    rows.push({ id: doc.id, kind: ENTRY_KINDS.PDF, name: doc.name, sub: t('deck.pdf') });
  }
  for (const pad of pads) {
    rows.push({ id: pad.id, kind: ENTRY_KINDS.SCRATCH, name: pad.name, sub: t('deck.scratch') });
  }
  for (const note of notes) {
    rows.push({ id: note.id, kind: ENTRY_KINDS.NOTE, name: note.name, sub: t('deck.note') });
  }
  return rows;
}

/**
 * 自由组合：不先摆好，直接拼一套。
 *
 * 「存为组合」存的是此刻的两栏，这条走的是反方向——先说要哪几本、各在哪一栏，存下
 * 来，然后才打开。理由写在 combo-builder.js 开头。
 *
 * 组合本身不能摆进组合：一个指着另一个组合的组合，打开时该展开成什么，没有一个
 * 说得通的答案。
 */
async function buildCombo() {
  // 满了就先说。拼完了才告诉人存不进去，等于让他白干一场。
  if (listCombos().length >= COMBO_MAX) {
    setStatus(t('combo.full'), true);
    return;
  }
  const items = await shelfEverything();
  if (!items.length) {
    setStatus(t('build.nothingLeft'), true);
    return;
  }

  // 栏名照屏幕此刻的样子叫：竖着拿平板时两栏是上下叠的。组合存成不对调，所以
  // PRIMARY 就是左边（或上边）那一栏。
  const column = workspace?.state?.orientation === ORIENTATIONS.COLUMN;
  const positions = [
    { slot: SLOTS.PRIMARY, position: column ? t('deck.top') : t('deck.left') },
    { slot: SLOTS.SECONDARY, position: column ? t('deck.bottom') : t('deck.right') },
  ];
  const positionOf = (slot) => positions.find((p) => p.slot === slot)?.position || '';
  const open = describeOpen();

  const saved = await openComboBuilder({
    items,
    positions,
    // 和从书架上打开一个组合时那句提醒同一句话：换掉的是哪几本，它们读到哪一页
    // 会记下来。这里不另弹一个框——那句话就贴在「保存并打开」上面。
    replaceNote: open.length
      ? t('combo.useBodyOpen', { open: open.join(t('combo.join')) })
      : '',
    pick: ({ slot, position, inThis, inOther }) => pickResources({
      title: t('build.pickTitle', { position }),
      note: t('folder.pickNote'),
      // 这一栏里已经有的不再列；另一栏里有的照样列，并且标出来——同一本书左右
      // 各开一份是正经用法，但人得知道自己挑的是「另一份」。
      items: items
        .filter((one) => !inThis.has(one.id))
        .map((one) => (inOther.has(one.id)
          ? { ...one, sub: t('build.alsoOn', { position: positionOf(slot === SLOTS.PRIMARY ? SLOTS.SECONDARY : SLOTS.PRIMARY) }) }
          : one)),
      confirm: t('folder.pickConfirm'),
      empty: t('build.nothingLeft'),
    }),
    askName: (suggested) => promptText({
      title: t('build.title'),
      label: t('build.nameLabel'),
      value: suggested,
      max: 40,
      confirm: t('build.save'),
    }),
    save: (draft) => {
      try {
        return { ok: true, combo: saveCombo(draft) };
      } catch (error) {
        return {
          ok: false,
          message: error.message === COMBO_ERRORS.FULL ? t('combo.full') : t('combo.saveFailed'),
        };
      }
    },
  });
  if (!saved) return;

  setStatus(t('combo.saved', { name: saved.name }));
  // 存完直接打开，走的是和「打开组合…」同一条路。书架这时是收着的——这一套是从
  // 顶上那一排拼出来的——所以没有一格封面可以起飞，分栏自己滑到位就是那一下「打
  // 开」。原来这里会先把书架摊开、刷新两遍，只为了让书从一格刚画出来、封面还没
  // 加载的格子里飞出去。
  await applyComboNow({ id: saved.id, name: saved.name }, saved);
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
  // 删一个组合只是删掉一套摆法。书一本都不动——这一点必须在问话里说清楚，
  // 不然人会以为自己正要把那几本书一起删掉，而那恰恰是他最怕的事。
  if (item.kind === SHELF_KINDS.COMBO) {
    const ok = await confirmDestructive({
      title: t('combo.deleteTitle'),
      body: t('combo.deleteBody', { name: item.name }),
      confirmLabel: t('scratch.delete'),
    });
    if (!ok) return;
    deleteCombo(item.id);
    await refreshLibrary();
    return;
  }

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
/**
 * 横杠上的一张下拉单子：开合、点外面关掉、Esc、上下键。
 *
 * 两张单子（导入、组合）共用这一套。照抄一遍的话，两边迟早会长岔——而人不会认
 * 为那是两个功能，只会觉得这个应用时好时坏。
 *
 * @param {string} openRole  按钮的 data-role
 * @param {string} menuRole  单子的 data-role
 * @param {Object} actions   {菜单项的 data-role: 点了做什么}
 */
function bindBarMenu(openRole, menuRole, actions) {
  const button = elRoot.querySelector(`[data-role="${openRole}"]`);
  const menu = elRoot.querySelector(`[data-role="${menuRole}"]`);
  // 各自认各自那一个宿主。用 elRoot.querySelector('.pdf-bar-menu-host') 的话，
  // 第二张单子会拿到第一张的宿主，于是「点外面关掉」判错地方。
  const host = button?.closest('.pdf-bar-menu-host');
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

  for (const item of items) {
    const run = actions[item.dataset.role];
    if (!run) continue;
    item.addEventListener('click', () => {
      // 先关再做：反过来的话，选择器或对话框盖上来时单子还留在底下，做完回来它
      // 仍然开着。
      close();
      run();
    });
  }
}

function bindImportMenu() {
  bindBarMenu('import-open', 'import-menu', {
    'import-exercise': () => pickAndImport(DOC_ROLES.EXERCISE),
    'import-answer': () => pickAndImport(DOC_ROLES.ANSWER),
  });
}

function bindComboMenu() {
  bindBarMenu('combo-open', 'combo-menu', {
    'combo-save': () => saveCurrentCombo(),
    'combo-build': () => buildCombo(),
    'combo-use': () => pickCombo(),
  });
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
  if (!nativeFilesAvailable()) return openSystemPicker(role);

  // 先把权限问清楚，再摊面板。没有权限的那张面板是空的，而空面板不会告诉人**为
  // 什么**空——它看着就像「这台机器上没有 PDF」。
  const permission = await ensureFilesPermission({
    onWaiting: () => setStatus(t('picker.waitingGrant')),
  });
  if (permission === PERMISSION.CANCELLED) return;
  if (permission === PERMISSION.NO_SETTINGS_PAGE) setStatus(t('picker.noSettingsPage'), true);
  // 没要到就退回系统选择器。一次只能选一份，也得自己翻目录，但它不需要任何权
  // 限——不给这个权限的人照样导得进东西，这是这条退路存在的全部理由。
  if (permission !== PERMISSION.GRANTED) return openSystemPicker(role);

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
 * 系统那张选择器。
 *
 * 两处用它：浏览器里（没有原生插件），以及人不肯给「所有文件访问权限」的时候。
 * 它走的是页面上那两个藏起来的 &lt;input type="file"&gt;，和应用内面板在
 * handleImport 之前就合并了。
 */
function openSystemPicker(role) {
  const input = role === DOC_ROLES.ANSWER ? 'file-answer' : 'file-exercise';
  elRoot.querySelector(`[data-role="${input}"]`)?.click();
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

  let meta = null;
  try {
    setStatus(`正在导入 ${file.name} …`);
    meta = await importPdf(file, role);
  } catch (error) {
    Logger.error('PDF', 'import failed', error);
    const reason = error.message === 'PDF_STORAGE_FULL'
      ? '设备存储空间不足，请先删除一些文档再导入'
      : error.message;
    setStatus(`导入 ${file.name} 失败: ${reason}`, true);
    return;
  }

  // 在一个文件夹里导入，东西就落在这个文件夹里。人是站在「高代」里点的「＋」，
  // 他要的不是「导进来然后自己再挪一次」。
  if (openFolderId && meta?.id) {
    try { moveToFolder(meta.id, openFolderId); } catch (_) { /* 落在外面也不算丢 */ }
  }
  setStatus('已导入 1 个文档');
  // openLibrary 自己会刷新，不必先刷一遍——那是把整架书连同每一张封面重建两次。
  openLibrary();
}

/**
 * 「全部关闭」：两栏里开着的全部，一下关掉。
 *
 * 先问一声，问的时候说清楚关掉的是哪几份、会不会丢东西——答案是不会：停在哪一页
 * 记下来，文件都还在文档库里。和打开一个组合时那句提醒是同一个理由：人得看见要
 * 关的是哪几份，才决定得了要不要关。一摞里压着的也算，所以列的是全部，不只是露在
 * 外面的那两份。
 */
async function closeAllOpen() {
  const open = workspace?.openEntries?.() || [];
  if (!open.length) {
    setStatus(t('pdf.closeAllNone'));
    return;
  }
  const names = open.map((o) => o.name).filter(Boolean);
  const shown = names.slice(0, 6).join(t('pdf.closeAllJoin'))
    + (names.length > 6 ? t('pdf.closeAllMore', { count: names.length - 6 }) : '');
  const ok = await confirmDestructive({
    title: t('pdf.closeAllTitle', { count: open.length }),
    body: t('pdf.closeAllBody', { names: shown }),
    confirmLabel: t('pdf.closeAll'),
  });
  if (!ok) return;
  const closed = await workspace.closeAll();
  if (closed) setStatus(t('pdf.closedAll'));
}

/**
 * 「导出 PDF」：一本书（连同批注）、一本笔记本或一张草稿纸，导出成 PDF 存进「文档/对页」。
 *
 * 次序是定死的：先问权限，再做，最后存。一本几百页的书要做好一会儿——做完才发现存
 * 不进去，是最糟的那种顺序。没有权限、人又不给：说清楚这个功能要文件权限，别的什么
 * 都不受影响。去设置里开了、回来：接着导出，不用再点一遍。
 *
 * 同一时刻只导一份。第二下点进来就说一声「上一份还在导出」，而不是悄悄排队——几百
 * 页的书排在后面，人会以为按钮坏了。
 */
let exporting = null;
function exportAsPdf(target) {
  if (!target?.id) return Promise.resolve();
  if (exporting) {
    showSaveToast(t('export.busy'));
    return exporting;
  }
  exporting = runExport(target)
    .catch((error) => {
      Logger.error('PDF', `export failed: ${error?.message || error}`, error);
      setStatus(t('export.failed'), true);
      showSaveToast(t('export.failed'));
    })
    .finally(() => { exporting = null; });
  return exporting;
}

async function runExport({ kind, id, name }) {
  const title = name || t('export.untitled');
  const waiting = () => setStatus(t('export.waiting'));
  const allowed = await ensureExportPermission({ notify: showSaveToast, onWaiting: waiting });
  if (!allowed) {
    setStatus('');
    return;
  }

  // 屏幕上刚写的那几笔可能还没落盘（自动保存有几百毫秒的延迟）。导出去的必须是人
  // 刚才看见的样子。
  await workspace?.flushInkFor?.(id);

  setStatus(t('export.working', { name: title }));
  let built;
  try {
    built = await buildExport({ kind, id }, {
      onProgress: ({ stage, done, total }) => {
        if (stage === 'pages' && total > 1) setStatus(t('export.progress', { name: title, done, total }));
      },
    });
  } catch (error) {
    if (error?.message !== EXPORT_ERRORS.EMPTY) throw error;
    setStatus('');
    showSaveToast(t('export.empty'));
    return;
  }

  const fileName = exportFileName(title, kind === EXPORT_KINDS.PDF ? t('export.suffix') : '');

  // 浏览器里（开发、测试）没有原生层：交给浏览器自己的下载。
  if (!nativeFilesAvailable()) {
    saveFile(new Blob([built.bytes], { type: 'application/pdf' }), fileName);
    const done = t('export.downloaded', { file: fileName });
    setStatus(done);
    showSaveToast(done);
    return;
  }

  const save = () => writeExportFile(built.bytes, fileName, {
    onProgress: (done, total) => setStatus(t('export.saving', {
      name: title, percent: Math.round((done / total) * 100),
    })),
  });
  let saved;
  try {
    saved = await save();
  } catch (error) {
    // 问过之后、写之前，人在设置里把权限关了：再问一次，给了就接着写，不从头做。
    if (error?.message !== FILES_ERRORS.NO_PERMISSION) throw error;
    const again = await ensureExportPermission({ notify: showSaveToast, onWaiting: waiting });
    if (!again) {
      setStatus('');
      return;
    }
    saved = await save();
  }
  const done = t(built.raster ? 'export.doneRaster' : 'export.done', {
    folder: t('export.folder'),
    file: saved?.name || fileName,
  });
  setStatus(done);
  showSaveToast(done);
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
  // 本栏 ⋯ 里的「导出 PDF」：导出这一栏正显示着的那一份。
  workspace.onExport = (target) => exportAsPdf(target);

  chromeOff?.();
  // 菜单栏一动，工具栏就跟着让位——见 initChromeHiding 里那个泵。
  chromeOff = initChromeHiding(elRoot, {
    // 改排版之前：借住在左边、马上要回那一排的工具栏先记下它此刻的样子（见 rowWillMove）。
    beforeChromeMove: (hidden) => workspace?.toolbar?.rowWillMove?.(hidden),
    onChromeMove: () => workspace?.syncToolbarSafeArea?.(),
  });
  // 窄屏上那一排先收字，再收两个标签的字，不让左右两枚胶囊伸进正中压住标签。
  topBarOff?.();
  topBarOff = initTopBarFit(elRoot);
  // 工具栏也能拖进顶上那一排：收着是一颗球塞在两枚胶囊之间，点开就整条躺进那一排、
  // 把两边挤开（top-row-dock.js 管量和挤，工具栏管自己装什么）。
  topRowDock?.destroy();
  topRowDock = initTopRowDock(elRoot);
  workspace.toolbar?.setPerchHost?.(topRowDock);

  bindImportMenu();
  bindComboMenu();
  elRoot.querySelector('[data-role="file-exercise"]')?.addEventListener('change', (e) => {
    handleImport(Array.from(e.target.files || []), DOC_ROLES.EXERCISE);
    e.target.value = '';
  });
  elRoot.querySelector('[data-role="file-answer"]')?.addEventListener('change', (e) => {
    handleImport(Array.from(e.target.files || []), DOC_ROLES.ANSWER);
    e.target.value = '';
  });
  elRoot.querySelector('[data-role="open-library"]')?.addEventListener('click', openLibrary);
  elRoot.querySelector('[data-role="close-all"]')?.addEventListener('click', closeAllOpen);
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

  // 第一次进应用：问一次文件权限（导出 PDF、列出本机 PDF 都要它）。不等它——人可能
  // 要去设置里走一趟，开机不该卡在这里。以后不在开机时再问，到导出时才问。
  introduceFilesPermission({ notify: showSaveToast }).catch((error) => {
    Logger.warn('PDF', `permission intro failed: ${error?.message || error}`);
  });
}

/** Exposed for teardown in tests and for release(). */
export function destroyPdfWorkspace() {
  workspace?.destroy();
  workspace = null;
  chromeOff?.();
  chromeOff = null;
  topBarOff?.();
  topBarOff = null;
  topRowDock?.destroy();
  topRowDock = null;
}

// ── hiding the top row ──────────────────────────────────────────────────────

/** 两栏补的那一段滑动：和横杠、两个标签的过渡同一条曲线、同一个时长，才一起到。 */
const ROW_SLIDE_MS = 320;
const ROW_SLIDE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

/**
 * Slide the import row up to put it away; pull down from the top edge to bring
 * it back. The two tabs (练习 / 设置) sit in the middle of that row and go and
 * come with it — see .app-nav in pdf.css.
 *
 * 底下原来还有一条能单独收起来的菜单栏，收起之后靠底边正中一根小把手叫回。它挪
 * 到了顶上这一排的正中，于是那一整套——底边的抓取带、把手、从横躺的工具栏上往
 * 下拉、把手给工具栏让位——都没了：底边整条还给了纸，笔写到哪儿都是纸。
 *
 * 怎么动（两段，各管各的）：
 *
 *   · 那一排自己（横杠、两个标签、停在那一排里的工具栏）只靠 transform 进出，跟手、
 *     松手后自己走完，都不碰排版。它不在文档流里（pdf.css 的 .pdf-page-bar）。
 *   · 两栏的位置和高度只在「定了」的那一刻变一次：is-top-hidden 挂上或摘掉，工作区的
 *     上边距当场到位。看上去的那一段滑动是补出来的——每一件先摆回原来的地方，再放它
 *     滑到新地方（slideWorkspace）。位移走合成器，主线程这时候就算在重画 PDF 页也拖
 *     不住它。
 *
 * 原来是边距本身在过渡：0.32 秒里每一帧都在改工作区的高度，两栏、PDF 页面、栏头的
 * 适配、工具栏的安顿全跟着重来一遍；拖的时候更是每挪一下就来一遍。平板上看是一卡
 * 一卡的——而且那条过渡后来被一条同名规则盖掉了，横杠和两栏其实是一下子跳过去的，
 * 只有两个标签在滑。
 *
 * The gesture is read from pointer events, so a finger, a stylus and a mouse
 * all work the same way, and it only fires on a deliberate travel: a bar you
 * brush past on the way to a button must not disappear.
 */
export function initChromeHiding(elRoot, { onChromeMove, beforeChromeMove } = {}) {
  // Everything below is hung on the document and on the window, and the
  // workspace can be built more than once in a session — leave the last set
  // attached and every gesture is handled twice, which for the swallowed click
  // means the tap AFTER a drag is eaten as well. One controller takes them all
  // off again.
  const life = new AbortController();
  const alive = { signal: life.signal };

  const topBar = elRoot?.querySelector('.pdf-page-bar');
  /** 两个标签那枚胶囊：它不在横杠里（fixed 在页面外），但按在它上面也是按在这一排上。 */
  const nav = document.querySelector('.app-nav');
  const workspace = elRoot?.querySelector('.pdf-workspace-host');
  const body = document.body;

  const cssPx = (name, fallback) => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };

  /** How tall the row is. */
  const topBarHeight = () => {
    const v = cssPx('--pdf-bar-h', 44);
    return v > 0 ? v : 44;
  };

  /** 那一排走多远才算走完：它自己的高度，加上它离屏幕上沿那一截——下沿刚好出屏。 */
  const rowTravel = () => topBarHeight() + Math.max(0, cssPx('--app-bar-top', 8));

  const isHidden = () => body.classList.contains('is-top-hidden');

  // ── 两栏补的那一段滑动 ────────────────────────────────────────────────────

  /**
   * 停在那一排里的工具栏是那一排的一部分，它跟着那一排的 transform 走，不在这里挪。
   * 挂在栏头下面的那一种（is-perch-hanging）不是：它跟着两栏。
   * 那一排收着、借住在左边的那一个（is-off-row）也不在这里挪：那一排收起、拉回的那一刻它自己
   * 从左边进来、往左边出去（ink-toolbar.js 的 _stepOffRow / _returnToRow），这里再给它补一段
   * 竖着的滑动，两段动画就叠在同一个元素上了。
   */
  const ridesWithRow = (el) => el.classList.contains('ink-toolbar')
    && ((el.classList.contains('is-perched') && !el.classList.contains('is-perch-hanging'))
      || el.classList.contains('is-off-row'));

  let slides = [];
  let slideGen = 0;

  /**
   * 排版改一次（commit），然后让工作区里看得见的每一件从原来的地方滑到新地方。
   *
   * 逐件量、逐件滑，不是整个工作区一起滑：工作区里有 fixed 的东西（停在那一排里的
   * 工具栏），祖先一带位移，它就改按那个祖先定位，当场跳开。滑的用的是单独的
   * translate，不碰 transform——工具栏平时靠 transform 放自己。
   *
   * 滑的那一段里两栏会探出工作区的上沿（拉出来的时候，它们从原来贴着屏幕上沿的地方
   * 往下走），所以这 0.32 秒里工作区不裁边（is-row-sliding）。
   */
  const slideWorkspace = (commit, { animate = true } = {}) => {
    const pieces = workspace
      ? Array.from(workspace.children).filter((el) => !ridesWithRow(el) && el.getClientRects().length > 0)
      : [];
    // 先量：正在滑的那一段也算在里面（上一段还没走完就又改了主意，从它此刻在的地方接着走）。
    const before = pieces.map((el) => el.getBoundingClientRect().top);
    for (const anim of slides) anim.cancel();
    slides = [];
    const gen = ++slideGen;
    const sliding = pieces.length > 0 && animate && !reducedMotion();
    // 不裁边要在改排版之前挂上：量完之后再挂，overflow 一变又把工作区弄脏一次，这一帧就得
    // 再排一遍版（平板上量到松手那一帧本来就要二十来毫秒，不能再添一遍）。
    workspace?.classList.toggle('is-row-sliding', sliding);
    commit();
    if (!sliding) return;
    const moves = [];
    pieces.forEach((el, i) => {
      const dy = before[i] - el.getBoundingClientRect().top;
      if (Number.isFinite(dy) && Math.abs(dy) >= 0.5 && typeof el.animate === 'function') moves.push([el, dy]);
    });
    if (!moves.length) {
      workspace.classList.remove('is-row-sliding');
      return;
    }
    let left = moves.length;
    const landed = () => {
      if (gen !== slideGen) return;
      if (--left <= 0) workspace.classList.remove('is-row-sliding');
    };
    for (const [el, dy] of moves) {
      const anim = el.animate(
        [{ translate: `0 ${dy}px` }, { translate: '0 0' }],
        { duration: ROW_SLIDE_MS, easing: ROW_SLIDE_EASE },
      );
      slides.push(anim);
      anim.addEventListener('finish', landed);
      anim.addEventListener('cancel', landed);
    }
  };

  const setHidden = (hidden, { animate = true } = {}) => {
    if (isHidden() === hidden) return;
    markMoving();
    // 排版马上要变：让还画在旧位置上的东西先记下自己在哪（工具栏借住在左边、要回那一排的
    // 时候，它的替身得从人眼里它原来的样子出发，而不是排版改完、被挪下去缩了一圈之后）。
    beforeChromeMove?.(hidden);
    slideWorkspace(() => {
      body.classList.toggle('is-top-hidden', hidden);
      // 两栏的高度刚变：工具栏先按新的高度安顿好，再量它落在哪——它和两栏一起滑过去，
      // 而不是等两栏滑完了再自己跳一下。
      onChromeMove?.();
    }, { animate });
    try { localStorage.setItem('ls_chrome_top', hidden ? '1' : '0'); } catch (_) { /* private mode */ }
    // The panes have just changed height. 滑完再说：这一声会叫工作区把两栏重排一遍，挤在滑动的
    // 头一帧里就是一顿（两栏自己的尺寸观察器也等滑完，见 PdfWorkspace._afterRowSlide）。
    clearTimeout(resizeTimer);
    const announce = () => window.dispatchEvent(new Event('resize'));
    if (animate && !reducedMotion()) resizeTimer = setTimeout(announce, ROW_SLIDE_MS + 30);
    else announce();
  };
  let resizeTimer = 0;

  // The row's own height, so hiding it can give exactly that much back.
  const measure = () => {
    if (!topBar || isHidden()) return;
    const h = Math.round(topBar.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--pdf-bar-h', `${h}px`);
  };
  measure();
  window.addEventListener('resize', measure, alive);
  // 换皮肤、换语言，这一排的高度会变，而窗口没变：两个标签按这个高度在它里面竖着
  // 居中（pdf.css 的 .app-nav），只听 resize 的话它们会偏上或偏下几像素。
  const sizeWatch = typeof ResizeObserver === 'function' && topBar ? new ResizeObserver(measure) : null;
  sizeWatch?.observe(topBar);
  // 换皮肤是当场量，不等 ResizeObserver 的下一轮：等的那一帧里两个标签按旧的高度摆着，
  // 下一帧再跳到新的地方——人看到的就是「一换皮肤按钮先挪一下」。
  window.addEventListener('skinchange', measure, alive);

  /**
   * Dragging the row away, and dragging it back.
   *
   * The row is placed by a number — 0 out, 1 away — and while a finger is down
   * that number is simply where the finger is. So the row leaves under the hand
   * rather than after it, and a drag that changes its mind halfway brings the
   * row back with it. On release it finishes the journey itself, to whichever
   * end it is nearer, or to wherever a flick was headed.
   *
   * Watched from the document and decided by where the press STARTED, because
   * the row is 44px tall: dragging it away means leaving it, and a pointerup
   * lands on whatever is under the finger by then, which is not the row.
   */

  /**
   * How far down the screen a press still counts as reaching for the row.
   *
   * Generous on purpose: it is a gesture with nothing to aim at. A tap is
   * unaffected either way, because a drag is not a drag until it has travelled.
   * 这一截里只有栏头和空白底子算数（见 reachesForRow）：切换条、书页这些在同一截里的，
   * 竖着划各有各的意思。
   */
  const EDGE_TOP = 96;
  /**
   * 那一排收着、按在栏头两边的空白上往下拉：那里没法不让 WebView 接走竖着的拖动（两栏里有会
   * 上下滚的列表，touch-action 不能在它们的祖先上收窄，见 pdf.css），它让手指走十来像素（平板上
   * 实测 11px）就发 pointercancel 把手势收走。收走的时候已经往下走了这么多、而且竖着走得比横着
   * 多，就当是在拉——放那一排下来（后面不跟手，自己走完）。
   */
  const CANCEL_PULL = 4;
  /** 那一排下沿往下再让出这么一截也算按在它上面：它和两栏之间那道缝。 */
  const ROW_SLACK = 6;
  /** Past this fraction of the way, letting go finishes the journey. */
  const SETTLE = 0.3;
  /** A flick this fast commits regardless of how far it got. */
  const FLICK = 0.3;   // px per ms
  /** 甩的快慢按最后这么长一段算：只看最后两个点，120Hz 的笔一帧才走一两像素，一抖就反了。 */
  const VELOCITY_WINDOW = 80;   // ms
  /** Travel before a press becomes a drag rather than a wandering tap. */
  const DRAG_START = 10;

  const boxOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const inBox = (b, x, y) => !!b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

  /** 那一排占的那一条：整个宽度，从屏幕上沿到它下沿再往下一点。 */
  const inRowBand = (x, y) => {
    const b = boxOf(topBar);
    return !!b && y >= 0 && y <= b.bottom + ROW_SLACK;
  };

  let drag = null;

  /**
   * How long the row is treated as still moving after it is let go.
   *
   * A shade past the 0.32s the transform takes, so the controls come back only
   * once the row has actually arrived.
   */
  const MOVE_SETTLE = 380;
  let moveTimer = 0;

  /**
   * Marks the row as in motion, which puts the controls on it out of reach.
   *
   * The other half of keeping the two gestures apart: a row arriving under a
   * resting thumb, or leaving from under one, must not register as a press. The
   * swallowed click was not enough on its own — it catches the click a drag
   * produces, but not a finger that comes down on a row already in flight.
   *
   * Timed rather than waiting for transitionend, because a drag that does not
   * cross the threshold settles BACK to where it started: the class never
   * changes, and on some paths neither does the transform, so the event that
   * would end this may never arrive.
   *
   * 原来这里还有一个逐帧的泵，每一帧叫工作区把工具栏重新安顿一次：那时候两栏跟着
   * 手逐帧变高。现在拖的时候两栏不动，松手那一刻安顿一次（setHidden），泵就拆了。
   */
  const markMoving = () => {
    body.classList.add('is-top-moving');
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => body.classList.remove('is-top-moving'), MOVE_SETTLE);
  };

  /**
   * 跟手的那个进度只写在用它的那几样上：横杠、两个标签、停在那一排里的工具栏。
   *
   * 原来写在 body 上。自定义属性是继承的，body 上改一下，整页每一个元素都要重算一遍
   * 样式——两栏里一页 PDF 的文字层就是几百上千个小块，手指每挪一下都来一遍，平板上
   * 拖起来是一顿一顿的。写在这三样自己身上，重算的就只有它们。松手之后交给 body 上
   * 的 is-top-hidden（那是一次性的）。
   */
  let tracked = [];
  const setProgress = (p) => {
    if (!tracked.length) {
      tracked = [topBar, nav, document.querySelector('.ink-toolbar.is-perched')].filter(Boolean);
    }
    for (const el of tracked) el.style.setProperty('--top-drag', String(p));
  };
  const clearProgress = () => {
    for (const el of tracked) el.style.removeProperty('--top-drag');
    tracked = [];
    body.style.removeProperty('--top-drag');
  };

  /**
   * 按在哪儿不归这里管。
   *
   * 原来是「按在任何一个按钮上都不算」——胶囊里全是按钮，两个标签也是按钮，能按住往
   * 上拉的只剩胶囊之间那几像素空白，人说收起来太难。现在按钮上也能拉：过了门槛看方
   * 向，竖着走的归这里（点击随后被吞掉，按钮不会被顺手按下），横着走的不归这里（两个
   * 标签划着换页；左边那枚胶囊横着划什么都不做）。
   *
   * 仍然不归这里的：工具栏（它自己能拖，拖它是挪它；工具、颜色上划着是在挑）、展开着的单子
   * （里面是一列要点的东西）、输入框。
   */
  const claimedElsewhere = (t) => !!(t && t.closest)
    && !!t.closest('.ink-toolbar, .pdf-bar-menu, input, textarea, select, [contenteditable="true"]');

  /**
   * 那一排收着的时候，按在屏幕顶上那一截（EDGE_TOP）的哪儿算是去拉它回来。
   *
   * 收起之后两栏顶上去，这一截里放的就是两栏的栏头。原来这里盖着一条透明条专门接这个手势，
   * 栏头整排被它盖住、点不动（人说「收起后不该成为禁用区，唤出手势和点击选择手势并不冲突，
   * 请仔细划分」）。现在谁都不盖，只挑：
   *
   *   · 栏头那枚胶囊，连同上面的按钮：按下去没走够 DRAG_START 就是点，照常落到按钮上；竖着
   *     走过了就是拉，那一排跟手下来，随后那一下点击被吞掉。横着走的归浏览器（栏头放不下时
   *     能横着滚）——收起时栏头只把横着的拖动交给浏览器（pdf.css）。
   *   · 什么都没有的底子：栏头两边、两栏上面那道留白、空桌面。这里的竖着的拖动会被 WebView
   *     接走（见 CANCEL_PULL），收走之前往下走了就放那一排下来。
   *
   * 这一截里别的都不归这里：切换条（上下划是换这一摞里的上一本 / 下一本）、书页和草稿纸（拖
   * 着走、写字）、分隔条、面板和清单（上下滚）、卡片——各有各的手势，拉那一排不能顺手把它们
   * 也带上。原来书页顶上那一截也算，笔在书页上沿往下写一笔，那一排跟着下来。
   */
  const BARE = '#page-pdf, .pdf-workspace-host, .pdf-workspace, .pdf-ws-slot, .pdf-ws-empty';
  const reachesForRow = (t) => {
    // 没有落在哪个元素上（测试里直接发在 document 上的那种）：当它是底子。
    if (!t || t.nodeType !== 1) return true;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return false;
    if (t.closest('.pdf-slot-toolbar')) return true;
    return t.matches(BARE) || t === document.body || t === document.documentElement;
  };


  document.addEventListener('pointerdown', (e) => {
    drag = null;
    if (body.classList.contains('is-library-open')) return;
    // 只有练习页上才有这一排。设置页上两个标签一直在，按哪儿都不是在拉它。
    if (body.dataset.page && body.dataset.page !== 'pdf') return;
    if (claimedElsewhere(e.target)) return;
    const x = e.clientX;
    const y = e.clientY;

    if (!isHidden() && (inRowBand(x, y) || inBox(boxOf(nav), x, y))) {
      // Taking hold of the row while it is out, to push it away.
      drag = { from: 0 };
    } else if (isHidden() && y <= EDGE_TOP && reachesForRow(e.target)) {
      // Taking hold of it while it is away, to pull it back.
      drag = { from: 1 };
    }
    if (!drag) return;
    drag.span = Math.max(24, rowTravel());
    drag.x = x;
    drag.y = y;
    drag.moved = false;
    drag.samples = [];
  }, { passive: true, ...alive });

  /** 记下这一点，只留最后 VELOCITY_WINDOW 那一段（至少两个点）。 */
  const track = (e) => {
    const t = e.timeStamp || performance.now();
    drag.samples.push({ t, y: e.clientY });
    while (drag.samples.length > 2 && t - drag.samples[0].t > VELOCITY_WINDOW) drag.samples.shift();
  };

  /** 最后那一段的速度，往上（收起的方向）为正。 */
  const velocity = () => {
    const s = drag.samples;
    if (s.length < 2) return 0;
    const a = s[0];
    const b = s[s.length - 1];
    return -(b.y - a.y) / Math.max(1, b.t - a.t);
  };

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const dx = e.clientX - drag.x;
    // 每一下都记着：WebView 把手势收走的时候（CANCEL_PULL），要靠它看出刚才是不是在往下拉。
    // pointercancel 自己带的坐标不作数（安卓上常常是旧的或者 0）。
    drag.dx = dx;
    drag.dy = dy;
    if (!drag.moved) {
      // A finger resting on a button wanders several pixels before it lifts, and
      // at four the bar started sliding under every press — so the tap became a
      // drag, the click was swallowed as one, and the buttons simply stopped
      // working every so often. Past ten it was meant.
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_START) return;
      // 过了门槛就定方向，只定这一次：横着走的不是在拉这一排（两个标签上是划着换页）——
      // 放手，后面它怎么拐都不再归这里。
      if (Math.abs(dy) <= Math.abs(dx)) { drag = null; return; }
      drag.moved = true;
      body.classList.add('is-chrome-dragging');
    }
    markMoving();
    // Toward 1 is away, and away is up.
    const p = Math.max(0, Math.min(1, drag.from - dy / drag.span));
    drag.p = p;
    track(e);
    setProgress(p);
  }, { passive: true, ...alive });

  const endDrag = () => {
    if (!drag) return;
    const p = drag.p;
    const moved = drag.moved;
    // Positive is toward away, which is up. 按最后那一小段算，不按全程的平均：慢慢拉了一
    // 大半、最后又往回收的那一下，才是人真正的意思。
    const v = moved ? velocity() : 0;
    drag = null;
    body.classList.remove('is-chrome-dragging');
    if (!moved || p === undefined) {
      clearProgress();
      return;
    }
    armSwallow();

    // Thrown hard enough, it goes where it was thrown; otherwise it finishes
    // whichever journey it is nearer to completing.
    const away = v > FLICK ? true : v < -FLICK ? false : p >= SETTLE;
    clearProgress();           // the class takes over, and it transitions
    markMoving();              // and it is out of reach until it lands
    setHidden(away);
  };

  /**
   * A drag must not also press the thing it started on.
   *
   * The click the browser synthesises after a drag lands on whatever is under
   * the finger by then — 练习 or 设置, as often as not — and would change the
   * page as it went. It is swallowed once, in the capture phase, before it can
   * reach them. Only after a real drag: a tap is left alone, or the row would
   * stop working as buttons.
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
    // 那一排收着、手指在空白底子上往下走了几像素，WebView 就把手势收走了（见 CANCEL_PULL）：
    // 那是在拉，放它下来。过没过 DRAG_START 都一样——平板上实测，WebView 让出 11px 才收走
    // （先来 +6、+11 两下 pointermove，再 pointercancel），那时候那一排已经跟上手了。
    const pulled = drag.from === 1
      && (drag.dy || 0) >= CANCEL_PULL && (drag.dy || 0) > Math.abs(drag.dx || 0);
    drag = null;
    body.classList.remove('is-chrome-dragging');
    clearProgress();
    // 被收走的手势后面没有点击，不用吞。
    if (pulled) setHidden(false);
  }, { passive: true, ...alive });

  try {
    // 开机时恢复上次的样子：直接到位，不演——这时候没人在看它从哪儿来。
    if (localStorage.getItem('ls_chrome_top') === '1') setHidden(true, { animate: false });
    // 底部菜单栏收起来的那一笔：它已经没有了，留着的话只是一条永远读不到的记录。
    localStorage.removeItem('ls_chrome_bottom');
  } catch (_) { /* storage unavailable: start with the row showing */ }

  return () => {
    life.abort();
    sizeWatch?.disconnect();
    clearTimeout(swallowTimer);
    clearTimeout(moveTimer);
    clearTimeout(resizeTimer);
    for (const anim of slides) anim.cancel();
    slides = [];
    workspace?.classList.remove('is-row-sliding');
    body.classList.remove('is-chrome-dragging', 'is-top-moving');
    clearProgress();
  };
}
