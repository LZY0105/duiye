// PDF Module — dual-document workspace.
//
// Owns two PdfPane instances, the divider between them, and the workspace
// layout state. Each pane keeps its own document and view state, so page,
// zoom and scroll on one side never reach the other; this file only decides
// how much room each pane gets and which document is loaded into it.

import { createTextSource, TEXT_ORIGIN } from './text-source.js';
import { createAgentPanel } from './agent-panel.js';
import { requestAgent } from '../agent/agent-client.js';
import { PdfPane } from './pdf-pane.js';
import { FIT_MODES } from './pdf-view-state.js';
import {
  ORIENTATIONS,
  SLOTS,
  activeEntryIn,
  clearFocus,
  closeSlot,
  createWorkspaceState,
  deckFor,
  openInSlot,
  orientationForViewport,
  otherSlot,
  paneFractions,
  openSlots,
  setDividerRatio,
  setOrientation,
  swapSides,
  toggleFocus,
  MIN_RATIO,
  MAX_RATIO,
  CLOSE_THRESHOLD,
} from './workspace-state.js';
import {
  ENTRY_KINDS,
  activeEntry,
  createEntry,
  deckLength,
  entryAtOffset,
  findByResource,
  findEntry,
  isPagedKind,
} from './deck-state.js';
import { comboFromWorkspace } from './combo-state.js';
import {
  activateInSlot,
  collapseSlot,
  cycleInSlot,
  isCollapsed,
  moveEntryBetweenSlots,
  removeFromSlot,
  restoreCollapsed,
  slotsWithResource,
} from './workspace-state.js';
import { DeckStrip, deckStripHtml } from './deck-strip.js';
import { PagePanel } from './page-panel.js';
import {
  LABEL_MAX, hasBookmark, renameBookmark, toggleBookmark,
} from './bookmark-state.js';
import { forgetBookmarks, loadBookmarks, saveBookmarks } from './bookmark-store.js';
import {
  createPanelState,
  selectTab as panelSelectTab,
  serializePanelState,
  setHeight as panelSetHeight,
} from './panel-state.js';

/** 面板偏好：显示哪一面、占这一栏多高。 */
const PANEL_PREFS_KEY = 'ls_pdf_panel';

function readPanelPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || '{}');
  } catch (_) {
    return {};
  }
}
import { openOrganizer } from './deck-organizer.js';
import { answerFor, forgetPairsFor, rememberPair } from './answer-association.js';
import {
  chooseDestination,
  confirmDestructive,
  createPaperDialog,
  PAPER_MODES,
  explainRefusal,
  moveEntryDialog,
  promptText,
} from './deck-dialogs.js';
import { ScratchPane, SAVE_STATES } from '../scratch/scratch-pane.js';
import {
  createScratchpad,
  deleteScratchpad,
  getScratchpad,
  nextScratchpadName,
  readNewPadStyle,
} from '../scratch/scratch-store.js';
import { openScratchStylePanel } from '../scratch/scratch-style-panel.js';
import {
  addNotePages,
  createNotebook,
  getNotebook,
  nextNotebookName,
  setNotebookStyle,
  PAGE_DEFAULT as NOTE_PAGE_DEFAULT,
  PAGE_MAX as NOTE_PAGE_MAX,
} from '../note/note-store.js';
import { noteMeta, openNoteDocument } from '../note/note-document.js';
import { t } from '../core/i18n.js';
import {
  recallDocView,
  rememberEntryView,
  rememberDocView,
  restoreSession,
  saveSession,
  viewForEntry,
} from './document-session.js';
import { DOC_ROLES, getDocumentMeta, openStoredDocument } from './pdf-library.js';
import {
  indexAnswerDocument,
  indexQuestionDocument,
  indexesComparable,
  questionsOnPage,
  TEXT_QUALITY,
} from './answer-index.js';
import { alignOutlines, matchPage } from './question-matcher.js';
import { verifyPair } from './pair-verifier.js';
import { PAIR_STATUS } from './decision.js';
import { renderAnswerMatches, renderAnswerNotice, renderAnswerLoading } from './answer-panel.js';
import { InkToolbar, overlaps } from '../ink/ink-toolbar.js';
import { CORNERS } from '../ink/toolbar-state.js';
import Logger from '../core/logger.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * What the slot toolbar sheds, in the order it sheds it, when it cannot fit.
 *
 * Captions the icons already carry go before readouts whose controls stay, and
 * no rung hides anything that can be pressed. Driven by measurement in
 * PdfWorkspace._syncPaneHeaderFit, styled in material.css.
 */
const HEADER_LADDER = ['is-snug', 'is-snugger'];

/** The transitions that change how much room the slot toolbar's content needs. */
const WIDTH_IN_FLIGHT = new Set([
  'max-width', 'width',
  'margin-inline-start', 'margin-inline-end', 'margin-left', 'margin-right',
]);

/**
 * Is anything inside this bar still changing width?
 *
 * Where getAnimations is missing there are no CSS transitions to be mid-flight
 * either, so "no" is the true answer rather than a stand-in for one.
 */
function barIsSettling(bar) {
  const running = bar.getAnimations?.({ subtree: true }) || [];
  return running.some((a) => a.playState === 'running'
    && WIDTH_IN_FLIGHT.has(a.transitionProperty));
}

/**
 * How far a press on the divider may wander and still count as a tap.
 *
 * A finger never lands perfectly still, and a stylus even less so.
 */
const TAP_SLOP = 6;

/** How far outside the grip a press still counts as being on it. */
const GRIP_REACH = 22;

/** How far the swap control travels before a release commits the swap. */
const SWAP_THRESHOLD = 34;

/**
 * How long the reader must be still before their place in each book is filed.
 *
 * Long enough that a pan or a pinch writes it once at the end rather than on
 * every frame; short enough that anything short of pulling the battery out has
 * already been recorded. Closing a document does not wait for it.
 */
const DOC_VIEW_SETTLE = 400;

/** Honour the OS reduced-motion setting for the swap choreography. */
function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

/**
 * Why a book cannot be matched, or null when it can.
 *
 * The engine distinguishes several ways a text layer can fail, and they need
 * different messages because they have different remedies. OPAQUE is
 * deliberately NOT a failure: the text cannot be shown, but bookmark ids are
 * structural and survive whatever happened to the fonts, which is enough to
 * match on.
 *
 * OPAQUE should now be rare here. Every book in the corpus once looked that way,
 * which turned out to be this app shipping pdf.js without cmaps rather than
 * anything wrong with the books — see PDF_RESOURCES in pdf-document.js. If a
 * document still reports OPAQUE, suspect the reader's configuration first.
 */
function describeUnusable(index, what) {
  if (!index) return `${what}索引失败`;
  if (index.entries.length > 0) return null;

  switch (index.quality) {
    case TEXT_QUALITY.SCANNED:
      return `${what}没有文字层（可能是扫描版），需要 OCR 后才能匹配`;
    case TEXT_QUALITY.BLANK:
      return `${what}的文字层是空白的`;
    case TEXT_QUALITY.CORRUPT:
      return `${what}的字库映射已损坏，且没有可用的书签目录`;
    default:
      return `${what}中没有识别到编号题目`;
  }
}

export class PdfWorkspace {
  constructor(root, services = {}) {
    this.root = root;
    this._pdfLibrary = {
      getDocumentMeta: services.getDocumentMeta || getDocumentMeta,
      openStoredDocument: services.openStoredDocument || openStoredDocument,
      // The scratch store goes through the same door, so the pad half of a
      // switch — including its failure paths — can be driven without a
      // database.
      getScratchpad: services.getScratchpad || getScratchpad,
      // 笔记本同理。它走的是和 PDF 一样的装载路径，只是资源从别处取。
      getNotebook: services.getNotebook || getNotebook,
    };
    this.state = createWorkspaceState();
    this.panes = {};
    /**
     * The scratch pane for each slot, built the first time a pad is shown there.
     *
     * A slot holds a PdfPane and, once it needs one, a ScratchPane; only one is
     * ever loaded. An unloaded pane holds no document, no ink layer and two
     * 1x1 canvases, so this does not put a third renderer on the budget — the
     * limit is two LOADED views, and that is what `_showEntry` enforces.
     */
    this.scratchPanes = {};
    this.strips = {};
    /** Pad records currently on screen, by slot — for the strip and the menus. */
    this.pads = {};
    this.restoredViews = {};
    /**
     * The slot mid-handoff, if any.
     *
     * One transaction per pane, and a later request replaces the pending target
     * rather than queueing behind it: rapid taps on Next must land on the entry
     * the user last asked for, not run an animation chain through every one they
     * passed.
     */
    this._switching = { [SLOTS.PRIMARY]: null, [SLOTS.SECONDARY]: null };
    /**
     * 这一栏的窗格正在换内容。
     *
     * 换一本书是这么走的：先记下走掉的那一份停在哪、再把新的装进窗格、最后才
     * 提交「这一栏现在显示的是新的这一份」。中间那一段里，窗格装的已经是新书，
     * 而 _shown 还指着旧的——于是那一刻任何人来问「这一栏在显示谁」，得到的都
     * 是旧的那一份的名字，配上新书的页码。
     *
     * 而那一刻真的有人在问：pdf.js 装载途中会发出状态变化，那条链上挂着落盘。
     * 真机上量到的后果是新书的页码被写进旧书名下，旧书从此每次打开都落在别人
     * 的页上；下一轮再换回来，又把这个错抄给第三本。
     *
     * 正确答案不是「算哪一份」，而是「这一刻不算」：窗格里装的既不是走的那一
     * 份，也还不算来的那一份，没有任何一个条目该为它背这个页码。
     */
    this._paneInFlux = { [SLOTS.PRIMARY]: false, [SLOTS.SECONDARY]: false };
    this._pending = { [SLOTS.PRIMARY]: null, [SLOTS.SECONDARY]: null };
    /** Which pane the shared toolbar currently applies to (spec §11.2). */
    this.activeSlot = SLOTS.PRIMARY;
    /** The document and page captured when the Agent dialog was opened. */
    this.agentTarget = null;
    // Per slot, the width the slot toolbar wanted at each rung of HEADER_LADDER,
    // so _syncPaneHeaderFit knows how much room it takes to put a rung back.
    this._headerWanted = {};
    /** Per-slot open tokens; a superseded open must not overwrite a newer one. */
    this._openTokens = { [SLOTS.PRIMARY]: 0, [SLOTS.SECONDARY]: 0 };
    /** Resolved bookmark data; DOM nodes are built only when the panel opens. */
    this._outlines = { [SLOTS.PRIMARY]: null, [SLOTS.SECONDARY]: null };
    /** 目录 / 缩略图面板，每栏一个；两栏共用一份「显示哪一面、占多高」的偏好。 */
    this.panels = {};
    this._pageShape = { [SLOTS.PRIMARY]: null, [SLOTS.SECONDARY]: null };
    this._panelState = createPanelState(readPanelPrefs());
    this._panelSave = 0;
    this._buildDom();
    this._bindDivider();
    this._bindSwap();
    this._bindOrientation();

    // A press anywhere else puts an open ⋯ menu away. One listener for both
    // slots, in the capture phase so it is seen before the press reaches
    // whatever it landed on, and taken off again in destroy().
    this._onDocumentPointerDown = (e) => {
      const t = e.target;
      if (t?.closest?.('[data-role="slot-menu"], [data-role="slot-more"]')) return;
      this._closeSlotMenus();
    };
    document.addEventListener('pointerdown', this._onDocumentPointerDown, true);

    // One shared floating toolbar, applied to the explicitly active Ink
    // surface. It is mounted on the workspace root, so it floats over both
    // panes without belonging to either one's layout.
    this.toolbar = new InkToolbar(this.root, {
      // Whichever surface is actually ON SCREEN in the active slot — a book's
      // or a pad's.
      //
      // This used to be `this.panes[slot].ink`, which is only ever the PDF
      // pane's. On a scratchpad every tool, colour and width the reader chose
      // was pushed to a surface nobody was drawing on, while the pad kept the
      // one tool its constructor gave it — so on paper the toolbar did nothing
      // at all and every stroke came out the same.
      getSurface: () => this._loadedViewIn(this.activeSlot)?.ink || null,
      // Moving or docking the bar can carry it over the other column, and the
      // column it lands on is what it now has to fit inside.
      onChange: () => this._syncToolbarSize(paneFractions(this.state)),
      onClearInk: () => {
        // Scoped to the surface on screen — never the PDF underneath it (§6.2).
        this._loadedViewIn(this.activeSlot)?.ink.clear();
        this._syncSlotChrome(this.activeSlot);
      },
    });
  }

  _buildDom() {
    this.root.classList.add('pdf-workspace');
    this.root.innerHTML = `
      <div class="pdf-ws-slot" data-slot="a">
        ${slotChrome(SLOTS.PRIMARY)}
      </div>
      <div class="pdf-ws-divider" data-role="divider" role="separator"
           aria-orientation="vertical" tabindex="0" aria-label="调整分栏">
        <button type="button" class="pdf-ws-swap" data-role="swap"
                aria-label="左右互换两个文档" title="拖动或点击以左右互换">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
            <path d="M8 4 4 8l4 4" />
            <path d="M4 8h13" />
            <path d="M16 20l4-4-4-4" />
            <path d="M20 16H7" />
          </svg>
        </button>
        <span class="pdf-ws-divider-grip" data-role="grip"></span>
        <div class="pdf-ws-ratio-badge" data-role="ratio-badge" aria-hidden="true">50% : 50%</div>
      </div>
      <div class="pdf-ws-slot" data-slot="b">
        ${slotChrome(SLOTS.SECONDARY)}
      </div>
      <div class="pdf-ws-empty" data-role="empty-state">
        <div class="pdf-empty-card">
          <div class="pdf-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="40" height="40">
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
              <path d="M6 6h10M6 10h10M6 14h6"/>
            </svg>
          </div>
          <h3 class="pdf-empty-title">双文档分栏学习工作区</h3>
          <p class="pdf-empty-desc">支持练习册与答案册同屏对照、Apple Pencil 原生级笔刷批注、题号一键智能对题</p>
          <div class="pdf-empty-actions">
            <button type="button" class="pdf-empty-btn primary" data-action="import-exercise">导入练习册</button>
            <button type="button" class="pdf-empty-btn secondary" data-action="import-answer">导入答案册</button>
          </div>
        </div>
      </div>
      <!-- A collapsed pane keeps a way back that is worth aiming at, and says
           how much is waiting behind it. Collapse is not close: the deck is
           untouched and every entry is still in it. -->
      <button type="button" class="pdf-ws-restore" data-role="restore" hidden></button>
    `;

    this.elDivider = this.root.querySelector('[data-role="divider"]');
    this.elRestore = this.root.querySelector('[data-role="restore"]');
    this.elSwap = this.root.querySelector('[data-role="swap"]');
    this.elGrip = this.root.querySelector('[data-role="grip"]');
    this.elRatioBadge = this.root.querySelector('[data-role="ratio-badge"]');
    this.elEmpty = this.root.querySelector('[data-role="empty-state"]');
    this.elSlots = {
      [SLOTS.PRIMARY]: this.root.querySelector('.pdf-ws-slot[data-slot="a"]'),
      [SLOTS.SECONDARY]: this.root.querySelector('.pdf-ws-slot[data-slot="b"]'),
    };
    this.agentPanel = createAgentPanel(this.root, {
      onOpen: () => this.openAgentForActiveDocument(),
      onClose: () => { this.agentTarget = null; },
    });

    // 空工作区上那两颗按钮和横杠上的「导入」是同一个动作，所以走同一条路——
    // onImport 由 UI 层挂上来（见 pdf-workspace-ui.js 的 pickAndImport）。没人挂
    // 的时候退回去点隐藏的文件框：工作区在测试里是单独立起来的，那时候没有 UI 层。
    const askImport = (role) => {
      if (typeof this.onImport === 'function') { this.onImport(role); return; }
      const input = role === DOC_ROLES.ANSWER ? 'file-answer' : 'file-exercise';
      document.querySelector(`[data-role="${input}"]`)?.click();
    };
    this.elEmpty?.querySelector('[data-action="import-exercise"]')?.addEventListener('click',
      () => askImport(DOC_ROLES.EXERCISE));
    this.elEmpty?.querySelector('[data-action="import-answer"]')?.addEventListener('click',
      () => askImport(DOC_ROLES.ANSWER));

    this.elRestore?.addEventListener('click', () => this.restorePane());

    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const host = this.elSlots[slot].querySelector('[data-role="pane"]');
      this.panes[slot] = new PdfPane(host, {
        onStateChange: () => { this._syncSlotChrome(slot); this._persist(); },
        onFocus: () => this._markActive(slot),
        onInkHistoryChange: () => this._syncSlotChrome(slot),
        onInkDragOver: (at) => this._markInkDropTarget(slot, at),
        onInkDragDrop: (payload) => this._dropInkIntoOtherSlot(slot, payload),
      });
      this.strips[slot] = new DeckStrip(this.elSlots[slot], {
        getDeck: () => deckFor(this.state, slot),
        describe: (entry) => this.describeEntry(slot, entry),
        getPaper: () => this._paperOf(slot),
        isBusy: () => !!this._switching[slot],
        onCycle: (step) => this.cycleSlot(slot, step),
        onActivate: (entryId) => this.showEntry(slot, entryId),
        onRemove: (entryId) => this.removeEntry(slot, entryId),
        onOrganize: (entryId) => this.organize(slot, entryId),
        onListOverlay: () => this._reviewToolbarConflict(),
      });
      this.panels[slot] = new PagePanel(this.elSlots[slot], {
        getState: () => this._panelState,
        onState: (change, { persist = false } = {}) => {
          this._panelState = change({
            selectTab: (tab) => panelSelectTab(this._panelState, tab),
            setHeight: (h) => panelSetHeight(this._panelState, h),
          });
          if (persist) this._persistPanel();
          else this._persistPanelSoon();
        },
        getDoc: () => this.panes[slot]?.doc || null,
        getPageCount: () => this.panes[slot]?.doc?.numPages || 0,
        getCurrentPage: () => this.panes[slot]?.state?.pageNumber || 1,
        getPageSize: () => this._pageShape?.[slot] || null,
        // Ink is filed under the resource, and the resource on screen is not
        // always the one the deck names — see _entryOnScreen.
        getBookmarks: () => this._bookmarksIn(slot),
        onToggleBookmark: (page) => this._toggleBookmark(slot, page),
        onNameBookmark: (mark) => this._nameBookmark(slot, mark),
        getInkDocId: () => {
          const entry = this._entryOnScreen(slot);
          // 本子的笔迹和书的走同一条路（ink-store 按 (id, 页码) 存），所以缩略
          // 图上也该有。漏掉它的后果是缩略图有纸没字，而且不报错。
          return isPagedKind(entry?.kind) ? entry.resourceId : null;
        },
        onGoToPage: (n) => {
          this.panes[slot].goToPage(n);
          this._syncSlotChrome(slot);
        },
        onOpenChange: () => this._syncOverlayState(),
        onResize: () => this._reviewToolbarConflict(),
      });
      this._bindSlotChrome(slot);
    }
    this._watchSlotSizes();
  }

  /**
   * Gets the floating ink bar off an open deck list — by folding it into the
   * puck and sending it to that column's bottom corner, not by blanking it.
   *
   * It used to be `display: none`, and the bar simply ceased to exist for as
   * long as the list was up. That reads as a glitch rather than as a thing
   * moving: nothing travelled, so there was nothing to follow, and when the
   * list closed the bar reappeared out of nowhere.
   *
   * Only when the two ACTUALLY overlap. The bar lives on one edge of one
   * column; a list opening in the other column is nowhere near it, and moving
   * it then would be the app fidgeting at the reader for no reason. So the
   * collision is measured, not assumed.
   *
   * The corner is the bottom of the column the list belongs to: a conflict on
   * the left folds into the bottom left, one on the right into the bottom
   * right. There is deliberately no second choice. Offering the far corner as
   * a fallback for a list long enough to reach the floor sounds thorough and
   * is worse — it carries the bar across the divider into the column it was
   * not serving, which is both a surprise and further to travel back from. A
   * puck is 48px and sits above the panel; on the rare list that reaches the
   * floor, it resting on that corner costs one row and stays predictable.
   */
  _yieldToolbarAround(listEl) {
    const bar = this.toolbar;
    if (!bar) return;
    if (!listEl) { bar.restoreFromYield(); return; }
    // Already stepped aside — for this list or the other column's. Either way
    // it is small and in a corner, and moving it again would be noise.
    if (bar.isYielded()) return;

    const list = listEl.getBoundingClientRect();
    if (!overlaps(bar.rect(), list)) return;

    // Which column the panel belongs to, asked of the column itself. Guessing
    // from the panel's own midpoint breaks the moment the divider is nowhere
    // near the middle — and this reader keeps it at 0.37. Asking the slot also
    // survives the two panes being swapped, where the left column is slot b.
    const column = listEl.closest?.('.pdf-ws-slot')?.getBoundingClientRect() || list;
    const host = this.root.getBoundingClientRect();
    bar.yieldTo(this._cornerFor(column, host, bar.rect()));
  }

  // ── 跨栏拖拽笔迹 ──────────────────────────────────────────────────────────

  /**
   * 这个屏幕点底下是哪一栏的哪块画布。
   *
   * 问的是画布自己的矩形，不是栏的：一栏里同时挂着 PdfPane 和 ScratchPane，只
   * 有显示着的那一块有面积（另一块是 1x1 的、收起来的）。所以拿矩形去撞，天然
   * 就只会撞上真正在屏幕上的那一块。
   */
  _inkSurfaceAt(clientX, clientY) {
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const view = this._loadedViewIn(slot);
      const canvas = view?.ink?.canvas;
      if (!canvas) continue;
      const r = canvas.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (clientX >= r.left && clientX <= r.right
          && clientY >= r.top && clientY <= r.bottom) {
        return { slot, view };
      }
    }
    return null;
  }

  /**
   * 拖动途中：把手指底下那一栏点亮。
   *
   * 一片被拖到半空中的笔迹，如果没有任何东西表示它会落在哪，人只会以为自己把它
   * 拖丢了——于是松手前就缩回来了，这个功能等于不存在。
   */
  _markInkDropTarget(fromSlot, at) {
    // 预览要先做，而且每一次移动都要做：下面那个「目标没变就直接回去」的短路是
    // 给描边用的（描边一次手势只变两下），而这一片是每一帧都在动的。
    this._showInkGhost(fromSlot, at?.ghost || null);

    const hit = at?.outside ? this._inkSurfaceAt(at.clientX, at.clientY) : null;
    const target = hit && hit.slot !== fromSlot ? hit.slot : null;
    if (this._inkDropSlot === target) return;
    this._inkDropSlot = target;
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      this.elSlots?.[slot]?.classList.toggle('is-ink-drop', slot === target);
    }
  }

  /**
   * 松在别的栏里：把这一片交给那边。
   *
   * 落回原栏（比如拖出去又拖回来）不算交出去——回 false，源画布照常走它本来的
   * 收尾，那一片留在原地。
   *
   * @returns {boolean} 那边接住了吗
   */
  _dropInkIntoOtherSlot(fromSlot, { strokes, clientX, clientY, scale } = {}) {
    const hit = this._inkSurfaceAt(clientX, clientY);
    if (!hit || hit.slot === fromSlot) {
      this._markInkDropTarget(fromSlot, null);
      return null;
    }
    // 回的不是「接住了没有」，是一组把手：源那边要把「撤销拖走」接到这一份上，
    // 否则在源撤销之后两边各留一份，一次撤销反而把内容变成了两份。
    const landed = hit.view.ink.adoptStrokes(strokes, clientX, clientY, scale);
    // 先落地再撤预览。反过来的话中间会空一帧——那一帧上这一片哪儿都不在，看着就
    // 是闪了一下。
    this._markInkDropTarget(fromSlot, null);
    if (landed) {
      // 落过去之后那一栏就是活动栏：人接下来要动的是它。
      this._markActive(hit.slot);
      this._syncSlotChrome(hit.slot);
    }
    return landed;
  }

  /**
   * 把源那一栏探出来的那一片，实时画到另一栏上。
   *
   * 判的是**这一片的外框**和另一栏画布有没有相交，不是手指在哪。一片大的选区，
   * 手指还在这边的时候它的右半边可能已经越过去了——而人要看的正是越过去的那半
   * 边。按手指判的话，那半边会一直被切掉，直到手指自己也过去。
   */
  _showInkGhost(fromSlot, ghost) {
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      if (slot === fromSlot) continue;
      const surface = this._loadedViewIn(slot)?.ink;
      if (!surface) continue;
      if (ghost && this._ghostReaches(surface, ghost.bounds)) surface.showDragGhost(ghost);
      else surface.clearDragGhost();
    }
  }

  _ghostReaches(surface, bounds) {
    if (!bounds) return false;
    const r = surface.canvas?.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) return false;
    return bounds.maxX > r.left && bounds.minX < r.right
      && bounds.maxY > r.top && bounds.minY < r.bottom;
  }

  // ── divider ───────────────────────────────────────────────────────────────

  _bindDivider() {
    let dragging = false;
    let pointerId = null;

    const ratioFromEvent = (e) => {
      const rect = this.root.getBoundingClientRect();
      let raw = 0.5;
      if (this.state.orientation === ORIENTATIONS.COLUMN) {
        raw = (e.clientY - rect.top) / Math.max(1, rect.height);
      } else {
        raw = (e.clientX - rect.left) / Math.max(1, rect.width);
      }
      // `raw` is where the pointer is, measured from the left (or the top).
      // `dividerRatio` belongs to the PRIMARY slot, which is drawn on the right
      // once the panes have been swapped — so the pointer position has to be
      // mirrored, or dragging the divider would move it away from the finger.
      if (this.state.swapped) raw = 1 - raw;

      // No magnetism at the ends.
      //
      // Inside the closing zone the divider used to stop tracking the finger
      // and jump the rest of the way, so that the pull was the answer to "will
      // this close?" before the release. But that zone was 4% of the workspace,
      // which is 48px on this tablet, and 48px is an ordinary amount of
      // resizing: a narrow column was not a thing you could ask for, because
      // asking for it snapped the pane shut instead. A drag now means the ratio
      // it points at for the whole of its travel, and closing a pane means
      // taking the divider to the edge of the workspace — see CLOSE_THRESHOLD.
      //
      // There used to be magnetic detents at 0.3, 0.5 and 0.7 as well —
      // the three preset buttons wearing a different hat. They are gone with
      // the buttons: the divider now rests wherever it is put, anywhere in
      // MIN_RATIO..MAX_RATIO. Double-click still returns it to 50:50, which is
      // the deliberate way to ask for centre rather than an invisible pull
      // that fights you when you want 48:52.
      return clamp(raw, MIN_RATIO, MAX_RATIO);
    };

    this.elDivider.addEventListener('pointerdown', (e) => {
      // The swap button lives on this line and has its own drag; its press is
      // never also a resize. It sits just above the grip, and the grip's reach
      // extends up under it, so without this both would run from one press —
      // the same fault as the dock, three pixels wide.
      if (e.target?.closest?.('[data-role="swap"]')) return;
      // Anywhere but the grip, the press is not ours — and it has to be left
      // alone completely, with no preventDefault and no capture, or the
      // gesture it did belong to never sees the rest of itself.
      if (!this._onDividerGrip(e.clientX, e.clientY)) return;
      dragging = true;
      this._dividerDragging = true;
      // A press that goes nowhere is a tap; one that travels is a drag. The
      // click handler above needs to tell them apart.
      this._dividerTravelled = 0;
      this._dividerFrom = { x: e.clientX, y: e.clientY };
      // The split BEFORE the drag. By the time a drag reaches an edge the
      // ratio is 0 or 1 — the position that MEANS collapse — and restoring to
      // it would collapse the pane again the moment it came back.
      this._ratioBeforeDrag = this.state.dividerRatio;
      pointerId = e.pointerId;
      // 这里原来记一份「手势开始时两栏各多宽」，给实时预览当缩放基准。
      // 现在不记了：预览改成对着屏幕上那张位图定价（pdf-pane.js 的
      // previewFitAt），起点宽度不再参与计算，记着它只会让人以为它还有用。
      try { this.elDivider.setPointerCapture(pointerId); } catch (_) { /* not ours to capture */ }
      this.elDivider.classList.add('is-dragging');
      this.root.classList.remove('is-animating');
      this._showRatioBadge(this.state.dividerRatio);
      e.preventDefault();
    });

    this.elDivider.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const ratio = ratioFromEvent(e);
      this._setState(setDividerRatio(this.state, ratio));
      this._showRatioBadge(ratio);
      // Say what releasing here would do, before the finger lifts.
      const left = this.state.swapped ? SLOTS.SECONDARY : SLOTS.PRIMARY;
      const right = this.state.swapped ? SLOTS.PRIMARY : SLOTS.SECONDARY;
      this.root.classList.toggle('is-closing-primary', ratio <= CLOSE_THRESHOLD);
      this.root.classList.toggle('is-closing-secondary', ratio >= 1 - CLOSE_THRESHOLD);
      this.elSlots[left].classList.toggle('is-closing', ratio <= CLOSE_THRESHOLD);
      this.elSlots[right].classList.toggle('is-closing', ratio >= 1 - CLOSE_THRESHOLD);

      if (this._dividerFrom) {
        this._dividerTravelled = Math.max(
          this._dividerTravelled || 0,
          Math.hypot(e.clientX - this._dividerFrom.x, e.clientY - this._dividerFrom.y),
        );
      }

      // Preview the refit, at the scale the release will actually land on.
      //
      // Rasterising a PDF once per frame is not affordable, so the bitmap on
      // screen is scaled by a transform for the duration. It used to be scaled
      // by how much the PANE had grown, which is only the same number when the
      // fit is limited by width. A whole-page fit — what 100% means here — is
      // usually limited by HEIGHT, and a sideways drag does not change the
      // height: the page should barely move, the preview stretched it anyway,
      // and the real refit on release snapped it back. Asking the pane what the
      // fit would be at the new width makes the preview and the result the same
      // number, so there is nothing left to snap.
      this._previewPaneFits();
    });

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      this._dividerDragging = false;

      // Tap the bar to come back to 50:50.
      //
      // Double-click did this and still does, but a double-tap is not reliably
      // reported through a WebView on a tablet — two taps a couple of hundred
      // milliseconds apart arrive as two separate taps and nothing happens,
      // which leaves centring the panes with no gesture at all on the device
      // the app is for. A single tap is unambiguous here: the bar is a 14px
      // strip nothing else uses, so a finger that lands on it and does not
      // travel meant to press it.
      //
      // Decided on release rather than on `click`, because a drag produces a
      // click too and the two are indistinguishable by the time it arrives.
      //
      // Only reachable from the grip now, since that is the only place a press
      // is taken at all — which also makes it discoverable: the tap is on the
      // thing that looks like a handle, not on 660px of hairline.
      const tapped = e && e.type === 'pointerup'
        && (this._dividerTravelled || 0) <= TAP_SLOP
        && !e.target?.closest?.('[data-role="swap"]');
      this._dividerFrom = null;
      this.elDivider.classList.remove('is-dragging');
      // The preview stays up until the refit's own render replaces it.
      this._stopTrackingPaneFits();
      this.root.classList.remove('is-closing-primary', 'is-closing-secondary');
      this.elSlots[SLOTS.PRIMARY].classList.remove('is-closing');
      this.elSlots[SLOTS.SECONDARY].classList.remove('is-closing');
      this._hideRatioBadge();

      if (tapped) {
        this.animateToRatio(0.5);
        return;
      }

      // Released at an end: that side is being COLLAPSED, not closed.
      //
      // This used to close the slot, which threw away the deck with it. Dragging
      // a pane out of the way is a statement about the layout, not about the
      // documents in it — so the deck is untouched, every entry stays where it
      // was, and a restore control takes its place saying how many are waiting.
      const r = this.state.dividerRatio;
      const collapsing = r <= CLOSE_THRESHOLD ? (this.state.swapped ? SLOTS.SECONDARY : SLOTS.PRIMARY)
        : r >= 1 - CLOSE_THRESHOLD ? (this.state.swapped ? SLOTS.PRIMARY : SLOTS.SECONDARY)
          : null;
      if (collapsing) {
        const restoreTo = this._ratioBeforeDrag ?? 0.5;
        this._clearPaneFitPreviews();
        this._absorbPane(collapsing, () => {
          this.collapsePane(collapsing, restoreTo);
        });
        return;
      }
      try { if (pointerId !== null) this.elDivider.releasePointerCapture(pointerId); } catch (_) { /* gone */ }
      pointerId = null;
      // Panes changed width, so any fit-to-width zoom must be recomputed.
      this._resizePanes();
      this._persist();
    };
    this.elDivider.addEventListener('pointerup', end);
    this.elDivider.addEventListener('pointercancel', end);

    this.elDivider.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.animateToRatio(0.5);
    });

    // Keyboard-accessible divider.
    this.elDivider.addEventListener('keydown', (e) => {
      // Mirrored for the same reason as the pointer: an arrow key moves the
      // divider in the direction it points, whichever slot happens to be on
      // that side.
      const step = (e.shiftKey ? 0.1 : 0.02) * (this.state.swapped ? -1 : 1);
      let ratio = null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ratio = this.state.dividerRatio - step;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') ratio = this.state.dividerRatio + step;
      if (e.key === 'Home') ratio = this.state.swapped ? MAX_RATIO : MIN_RATIO;
      if (e.key === 'End') ratio = this.state.swapped ? MIN_RATIO : MAX_RATIO;
      if (ratio === null) return;
      e.preventDefault();
      this._setState(setDividerRatio(this.state, ratio));
      this._showRatioBadge(this.state.dividerRatio);
      this._resizePanes();
      this._persist();
      this._hideRatioBadge();
    });
  }

  /**
   * Whether a press at this point is on the divider's handle.
   *
   * The handle, not the strip. The strip runs the full height of the workspace,
   * and on its way down it crosses the band the dock is swiped away from — so
   * putting the bars away also took hold of the divider, and the columns
   * changed width on the way past. Two gestures at once, out of one finger that
   * meant only one of them.
   *
   * The pill with the φ on it is the handle; the line above and below it is a
   * line. The reach around it is generous because a 9px pill is not a target —
   * it is a mark saying where the target is.
   */
  _onDividerGrip(clientX, clientY, reach = GRIP_REACH) {
    const g = this.elGrip?.getBoundingClientRect();
    if (!g || !g.height) return false;
    return clientX >= g.left - reach && clientX <= g.right + reach
      && clientY >= g.top - reach && clientY <= g.bottom + reach;
  }

  // ── ratio & sizing animations ──────────────────────────────────────────────

  /**
   * Shows each pane the page it is about to be refitted to.
   *
   * `base` is the width each slot had when the change started. Both panes are
   * priced the same way and from the same place, which is the point: the left
   * one shrinks while the right one grows, and any difference in how the two
   * are measured shows up as two different animations either side of the line
   * the finger is holding.
   */
  _previewPaneFits() {
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const pane = this.panes[slot];
      if (!pane?.previewFitAt || !pane.isLoaded?.()) continue;
      // 手动缩放不归这里重新定价——但仍然要重新摆放：一栏的中线在它变宽变窄的
      // 过程中本来就是移动的。
      if (pane.state?.fitMode === FIT_MODES.NONE) {
        pane.reposition?.();
        continue;
      }
      // 让栏自己量自己。
      //
      // 这里原来传的是「拖动起点的栏宽」，由 pane 算出起点与此刻的比值再乘上去。
      // 那个基准只在整段拖动一次真渲染都不落地时才成立——而它会落地，于是同一次
      // 缩放被乘两遍，越拖越小。`previewFitAt` 改成对着屏幕上那张位图定价，渲染
      // 落地多少次都不影响。整段推导记在 pdf-pane.js 那个方法的注释里。
      pane.previewFitAt();
    }
  }

  /**
   * Stops previewing, and hands the page over to the refit WITHOUT letting go
   * of it first.
   *
   * Resetting the transform here is the obvious thing and it is wrong: the
   * refit that replaces it has to rasterise, PDF.js takes a moment, and in that
   * moment the page snapped back to the size it had before the drag and then
   * grew again. The preview is left standing instead. It is priced off the
   * bitmap actually on screen, so through the refit's await it keeps showing
   * exactly the size the new render is going to arrive at, and `_render` clears
   * it in the same frame that swaps the canvas.
   */
  _stopTrackingPaneFits() {
    if (this._trackFrame) cancelAnimationFrame(this._trackFrame);
    this._trackFrame = 0;
  }

  /** Drops every preview transform outright, for a pane that is going away. */
  _clearPaneFitPreviews() {
    this._stopTrackingPaneFits();
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this.panes[slot]?.previewScale?.(1);
  }

  /**
   * Keeps the pages with the panes for the length of a CSS width transition.
   *
   * A drag previews the refit on every pointer frame; an ANIMATED ratio change
   * — double-tapping the bar to centre it, or focusing one pane — handed the
   * width to CSS and refitted once, when the transition was over. For those
   * 380ms the pages sat at the size they had for the old width, and then the
   * refit landed all at once. That is the same jump the drag used to end on,
   * arriving at the end of an animation instead of at the end of a gesture, so
   * it takes the same cure: price the fit every frame, from the width the pane
   * actually has at that moment.
   */
  _trackPaneFits(duration) {
    if (typeof requestAnimationFrame !== 'function') return;
    if (this._trackFrame) cancelAnimationFrame(this._trackFrame);
    const until = Date.now() + duration;
    const step = () => {
      this._previewPaneFits();
      // 横杠也是随栏变的，所以它也得每帧重新量。
      //
      // 原来整段动画里都不碰它——等动画停了再一次性排好。于是一栏从整屏收回一
      // 半的这 380ms 里，横杠一直是溢出的：按钮被挤扁，尾部那几个顶在栏外；动
      // 画结束的那一帧才「啪」地归位，尾部一次跳 45px。用户看到的「按钮在展开
      // 和关闭时跳」就是这一下。
      //
      // 这里的宽度不是猜的：此刻栏真的就这么宽，量得准。每帧只降一级，跟拖分隔
      // 线那条路一样便宜，而 380ms 有二十多帧，两级梯子绰绰有余。动画收尾时
      // _layout() 仍会整梯子核一遍，所以这里量偏了也有人兜底。
      this._syncPaneHeaderFit();
      this._trackFrame = Date.now() < until ? requestAnimationFrame(step) : 0;
    };
    this._trackFrame = requestAnimationFrame(step);
  }

  animateToRatio(targetRatio) {
    targetRatio = clamp(targetRatio, MIN_RATIO, MAX_RATIO);
    if (this.state.focusedSlot) {
      this.state = clearFocus(this.state);
    }
    this.root.classList.add('is-animating');
    this._trackPaneFits(380);
    this._setState(setDividerRatio(this.state, targetRatio));
    this._showRatioBadge(targetRatio);

    clearTimeout(this._animTimer);
    this._animTimer = setTimeout(() => {
      this.root.classList.remove('is-animating');
      this._layout();
      this._settleHeaderFit();
      this._stopTrackingPaneFits();
      this._resizePanes();
      this._persist();
      this._hideRatioBadge();
    }, 380);
  }

  animateToFocus(slot) {
    this.root.classList.add('is-animating');
    this._trackPaneFits(380);
    this._setState(toggleFocus(this.state, slot));
    clearTimeout(this._animTimer);
    this._animTimer = setTimeout(() => {
      this.root.classList.remove('is-animating');
      // Now that nothing is transitioning, a pane at zero may leave the flow.
      this._layout();
      this._stopTrackingPaneFits();
      this._resizePanes();
      this._persist();
    }, 380);
  }

  /**
   * Swaps the two panes left-for-right, animated.
   *
   * FLIP, because the panes are laid out by flexbox `order` and a change of
   * order is not something CSS can transition: the browser simply paints them
   * in the new places on the next frame. So the positions are measured before
   * the change, the change is applied, they are measured again, and each pane
   * is then transformed back to where it came from and released — which the
   * compositor CAN animate, on the GPU, without touching layout again.
   *
   * Transform-only also means the PDF canvases are not re-rendered mid-flight;
   * a 368-page document simply slides.
   */
  /**
   * Where the next document should open: left first, then right.
   *
   * When both are taken the new document replaces the pane the user is NOT
   * working in, so the document they were just annotating stays where it is.
   */
  nextFreeSlot() {
    if (!this.state.documents[SLOTS.PRIMARY]) return SLOTS.PRIMARY;
    if (!this.state.documents[SLOTS.SECONDARY]) return SLOTS.SECONDARY;
    return otherSlot(this.activeSlot || SLOTS.PRIMARY);
  }

  swapPanes() {
    if (this._swapping) return;
    const a = this.elSlots[SLOTS.PRIMARY];
    const b = this.elSlots[SLOTS.SECONDARY];
    const fractions = paneFractions(this.state);
    if (!(fractions[SLOTS.PRIMARY] > 0 && fractions[SLOTS.SECONDARY] > 0)) return;

    const column = this.state.orientation === ORIENTATIONS.COLUMN;
    const axis = column ? 'top' : 'left';
    const before = { a: a.getBoundingClientRect()[axis], b: b.getBoundingClientRect()[axis] };

    this._swapping = true;
    this.root.classList.add('is-swapping');
    this._setState(swapSides(this.state));

    const after = { a: a.getBoundingClientRect()[axis], b: b.getBoundingClientRect()[axis] };
    const deltas = [[a, before.a - after.a], [b, before.b - after.b]];

    const settle = () => {
      this.root.classList.remove('is-swapping');
      this._swapping = false;
      this._resizePanes();
      this._persist();
    };

    // The panes are ALREADY in their final places; the animation only plays
    // them in from where they came.
    //
    // This is deliberately the Web Animations API rather than a transition
    // driven from a requestAnimationFrame. The first version did the latter,
    // and it had a failure mode that is not theoretical: rAF does not run in a
    // backgrounded tab, so the callback that started the transition — and the
    // timer that cleaned up after it — never fired, and the panes were left
    // holding the inline `translateX` that had put them back where they
    // started. The swap had happened in the state and in the layout, and the
    // screen showed the opposite. An animation cannot be allowed to own
    // correctness like that.
    //
    // With `animate()` the element's own style is never written to, so the
    // resting position is the correct one whether or not a single frame is
    // ever painted, and `finished` settles either way.
    if (prefersReducedMotion() || typeof a.animate !== 'function') {
      settle();
      return;
    }

    const animations = deltas.map(([el, delta]) => el.animate(
      [
        { transform: column ? `translateY(${delta}px)` : `translateX(${delta}px)` },
        { transform: 'none' },
      ],
      { duration: 460, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
    ));

    Promise.all(animations.map(x => x.finished)).then(settle, settle);
  }

  _bindSwap() {
    if (!this.elSwap) return;

    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let travelled = 0;

    const reset = () => {
      this.elSwap.classList.remove('is-grabbed');
      this.elSwap.style.transform = '';
      this.root.classList.remove('is-swap-armed');
    };

    this.elSwap.addEventListener('pointerdown', (e) => {
      // The divider underneath owns resizing; this control owns swapping. If
      // the event reached both, a tap on the swap button would also start a
      // drag of the split.
      e.stopPropagation();
      e.preventDefault();
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      travelled = 0;
      this.elSwap.classList.add('is-grabbed');
      try { this.elSwap.setPointerCapture(pointerId); } catch (_) { /* unsupported */ }
    });

    this.elSwap.addEventListener('pointermove', (e) => {
      if (pointerId !== e.pointerId) return;
      e.stopPropagation();
      const column = this.state.orientation === ORIENTATIONS.COLUMN;
      const d = column ? e.clientY - startY : e.clientX - startX;
      travelled = Math.abs(d);
      // The control follows the finger a little, and resists — it is a switch
      // being thrown, not something being dragged to a destination.
      //
      // The pull has to be COMPOSED with the centring, not written over it.
      // This button is centred on the divider by `transform: translateX(-50%)`
      // in the stylesheet, and an inline transform replaces that property whole:
      // the moment a finger landed, the button jumped half its own width to the
      // right, then snapped back on release. That jump is the drift.
      const pull = Math.sign(d) * Math.min(14, travelled * 0.5);
      this.elSwap.style.transform = column
        ? `translateY(calc(-50% + ${pull}px))`
        : `translateX(calc(-50% + ${pull}px))`;
      this.root.classList.toggle('is-swap-armed', travelled >= SWAP_THRESHOLD);
    });

    const end = (e) => {
      if (pointerId !== e.pointerId) return;
      e.stopPropagation();
      try { this.elSwap.releasePointerCapture(pointerId); } catch (_) { /* gone */ }
      pointerId = null;
      const fired = travelled >= SWAP_THRESHOLD;
      reset();
      // A tap swaps too: the drag is an affordance, not a toll.
      if (fired || travelled < 4) this.swapPanes();
    };
    this.elSwap.addEventListener('pointerup', end);
    this.elSwap.addEventListener('pointercancel', (e) => {
      if (pointerId !== e.pointerId) return;
      try { this.elSwap.releasePointerCapture(pointerId); } catch (_) { /* gone */ }
      pointerId = null;
      reset();
    });

    // Keyboard: the button is a button.
    this.elSwap.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      this.swapPanes();
    });
  }

  /**
   * Plays a pane being absorbed into the edge before it closes.
   *
   * Closing used to be instantaneous: the pane was there, and then the other
   * document filled the screen. Nothing said which one had gone or where it
   * went, which on a two-document workspace is exactly the thing the user needs
   * to see. It collapses toward the edge it was dragged into, and the close
   * lands when the motion does.
   *
   * The callback runs on finish OR on failure, so a browser that cannot animate
   * still closes the pane — the animation reports the state change, it does not
   * own it.
   */
  _absorbPane(slot, done) {
    const el = this.elSlots[slot];
    if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) { done(); return; }

    const toLeft = (slot === SLOTS.PRIMARY) !== !!this.state.swapped;
    const anim = el.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: `translateX(${toLeft ? -18 : 18}px) scaleX(0.86)`, opacity: 0 },
      ],
      { duration: 260, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
    );
    anim.finished.then(done, done);
  }

  _showRatioBadge(ratio) {
    if (!this.elRatioBadge) return;
    const primary = Math.round(ratio * 100);
    const secondary = 100 - primary;
    this.elRatioBadge.textContent = `${primary}% : ${secondary}%`;
    this.elRatioBadge.classList.add('is-visible');
  }

  _hideRatioBadge() {
    clearTimeout(this._badgeTimer);
    this._badgeTimer = setTimeout(() => {
      this.elRatioBadge?.classList.remove('is-visible');
    }, 500);
  }

  // ── orientation ───────────────────────────────────────────────────────────

  _bindOrientation() {
    this._onResize = () => {
      const next = orientationForViewport(this.root.clientWidth, this.root.clientHeight);
      const changed = next !== this.state.orientation;
      if (changed) this._setState(setOrientation(this.state, next));
      this._resizePanes();
      // Rotating a tablet changes the height the toolbar has to live in far
      // more than it changes the width, and it is the height that binds.
      this._syncToolbarSize(paneFractions(this.state));
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
  }

  _resizePanes() {
    // Optional-called: closeSlot() refits after unloading a pane, and a pane
    // that has been torn down — or a stand-in supplied by a test — has nothing
    // to resize. A refit is an optimisation of what is on screen, never a
    // precondition for the state change that triggered it.
    //
    // BOTH kinds of pane. This only ever refitted the book panes, so a pad
    // whose column changed size was never told: entering focus took the column
    // from half the workspace to all of it and the pad went on drawing itself
    // at the old width, leaving paper that stopped halfway and a blank strip
    // beside it. It came right the moment you panned — because panning is the
    // one thing that made the pad re-read its own size — which is why it looked
    // like the pad "needed to be moved once to load".
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      this.panes[slot]?.resize?.();
      this.scratchPanes[slot]?.resize?.();
    }
  }

  /**
   * Keeps both panes fitted to their column, for the whole of every change.
   *
   * A one-shot refit after a state change measures the column before it has
   * finished becoming its new size: `flex-basis` is transitioned over 360ms,
   * so the value read on the frame of the change is the OLD one. Every source
   * of a size change has the same problem — focus, collapse, the divider being
   * dragged, the window rotating — and an observer answers all of them without
   * anyone having to remember to.
   */
  _watchSlotSizes() {
    if (typeof ResizeObserver !== 'function') return;
    this._sizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const slot = entry.target.dataset.slot;
        if (!slot) continue;
        this.panes[slot]?.resize?.();
        this.scratchPanes[slot]?.resize?.();
      }
      // The bar is sized against its column too, and a column can change size
      // without any state change at all — a rotation, the window resizing.
      if (!this.root.classList.contains('is-animating') && !this._dividerDragging) {
        this._settleHeaderFit();
        // A column can change size with no state change at all — a rotation,
        // the window resizing — and that moves what covers what.
        this._reviewToolbarConflict();
      }
    });
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const el = this.elSlots[slot];
      if (!el) continue;
      this._sizeObserver.observe(el);
      // 答案面板单独观察一份。它开合、以及内容从「正在匹配」变成一整页结果时，
      // 高度都会变，而这些都不改变栏本身的尺寸——只观察栏的话，上面那个回调
      // 一次都不会触发。它没有 dataset.slot，所以会从上面那个循环里 continue
      // 掉，只落到循环之后那句重判冲突上，而那正是要的。
      const answers = el.querySelector('[data-role="answer-panel"]');
      if (answers) this._sizeObserver.observe(answers);
    }
  }

  // ── state → DOM ───────────────────────────────────────────────────────────

  _setState(next) {
    if (next === this.state) return;
    const wasEmpty = this.isEmpty();
    this.state = next;
    this._layout();
    // 桌上空了就该回到书架。
    //
    // 关掉最后一份文件之后留在原地，人看到的是两块空白和一行「还没有打开任何
    // 文档」——而他接下来必然要做的那件事（挑下一本）的入口，藏在横杠上一个叫
    // 「文档库」的按钮里。空工作区没有别的用途，所以它直接让位。
    //
    // 只在「从有到无」这一次叫，不是每次状态变化都叫：否则空着的时候每动一下
    // 都会把书架再开一遍，人连关都关不掉。
    if (!wasEmpty && this.isEmpty()) {
      try { this.onEmpty?.(); } catch (_) { /* 这只是一个提议，出错不该带垮换页 */ }
    }
  }

  /** 两边都没有东西——不是「没显示」，是这一摞里一件都不剩。 */
  isEmpty() {
    return !deckLength(deckFor(this.state, SLOTS.PRIMARY))
      && !deckLength(deckFor(this.state, SLOTS.SECONDARY));
  }

  _layout() {
    const fractions = paneFractions(this.state);
    const column = this.state.orientation === ORIENTATIONS.COLUMN;
    this.root.classList.toggle('is-column', column);
    this.elDivider.setAttribute('aria-orientation', column ? 'horizontal' : 'vertical');

    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const el = this.elSlots[slot];
      const fraction = fractions[slot];
      el.style.flexBasis = `${fraction * 100}%`;
      // A pane at zero is hidden, and hiding it also hides the divider — which
      // during a drag would delete the element the pointer is captured on and
      // strand the gesture. While the divider is being dragged the pane stays
      // in the tree at zero width; `end()` decides whether that means closed.
      // Hidden only once it has finished shrinking.
      //
      // Taking it out of the flow the instant its share reaches zero deletes
      // its width in one frame, so the surviving column snaps to the far edge
      // and then grows back across the screen — the right-hand pane expanding
      // left-to-right, which is the wrong way round for a pane on the right and
      // reads as the animation belonging to the other side.
      //
      // Left in the tree at zero width, it transitions its share away over the
      // same 360ms, the survivor's near edge travels as the other retreats, and
      // each pane grows out of its own side.
      el.hidden = fraction === 0 && !this._dividerDragging
        && !this.root.classList.contains('is-animating');
      el.classList.toggle('is-focused', this.state.focusedSlot === slot);
      this._syncSlotChrome(slot);
    }

    // Sides. The slot elements keep their identity and their live panes; only
    // the order they are laid out in changes, so a swap costs no re-render.
    const swapped = this.state.swapped;
    this.elSlots[SLOTS.PRIMARY].style.order = swapped ? '3' : '1';
    this.elSlots[SLOTS.SECONDARY].style.order = swapped ? '1' : '3';
    this.elDivider.style.order = '2';
    this.root.classList.toggle('is-swapped', swapped);
    this._syncAgentAvailability();

    // 100% is the floor for a MANUAL zoom, and only for that.
    //
    // Pinching or stepping below 100% in a half-width pane gives a page too
    // small to read, so the floor stays there for anything the user dials in by
    // hand. It used to apply to fits as well, on the same reasoning — but a fit
    // is not a zoom level, it is a request to see the whole page, and clamping
    // it meant the app could not honour that request at all: 整页 computed the
    // right zoom and the floor immediately pushed it back up, so a page was
    // never once shown whole. A fit now lands where it lands.
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      this.panes[slot]?.setMinZoom?.(1);
    }

    this._syncPaneWidthBands(fractions);

    // The divider only means anything when both panes are visible.
    const bothVisible = (fractions[SLOTS.PRIMARY] > 0 && fractions[SLOTS.SECONDARY] > 0)
      || this._dividerDragging;
    this.elDivider.hidden = !bothVisible;
    // Swapping one document with an empty pane is a move, not a swap, and it
    // would leave the user looking at a blank side wondering what happened.
    if (this.elSwap) this.elSwap.hidden = !bothVisible;
    this.elDivider.setAttribute('aria-valuenow', String(Math.round(this.state.dividerRatio * 100)));

    const noneVisible = fractions[SLOTS.PRIMARY] === 0 && fractions[SLOTS.SECONDARY] === 0;
    if (this.elEmpty) this.elEmpty.hidden = !noneVisible;

    this._syncRestoreControl();
  }

  /**
   * The way back to a collapsed pane.
   *
   * It carries the COUNT, because that is the difference the control has to
   * make visible: a collapsed pane still holds its whole deck, and a bare
   * chevron would look exactly like a pane that had been closed. It sits on the
   * side the pane went, so it points at where its content actually is.
   */
  _syncRestoreControl() {
    if (!this.elRestore) return;
    const slot = this.state.collapsedSlot;
    if (!slot || this.focusSlot) {
      this.elRestore.hidden = true;
      return;
    }
    const count = deckLength(deckFor(this.state, slot));
    this.elRestore.hidden = false;
    this.elRestore.textContent = t('deck.restorePane', { count });
    // Which physical side it collapsed to, which is the swapped question again.
    const onLeft = (slot === SLOTS.PRIMARY) !== !!this.state.swapped;
    this.elRestore.classList.toggle('is-left', onLeft);
    this.elRestore.classList.toggle('is-right', !onLeft);
  }

  /**
   * Tells CSS how much room each pane actually has.
   *
   * With the divider free to travel to 1:9 a pane can be a tenth of the
   * workspace, which is far narrower than its chrome was drawn for: the slot
   * toolbar wrapped, the page counter collided with the zoom controls, and the
   * outline panel covered the page it was an index of. Rather than let each of
   * those overflow, the pane publishes the band it is in and the stylesheet
   * decides what that band can afford to show.
   *
   * Bands are measured in real pixels, not in ratio, because a 30% pane on a
   * 1280px tablet and a 30% pane on a 640px phone are different problems.
   */
  _syncPaneWidthBands(fractions) {
    const column = this.state.orientation === ORIENTATIONS.COLUMN;
    // In column layout the panes are full-width and split vertically, so width
    // is not what is scarce — every pane reports "wide".
    const total = column ? Infinity : this.root.clientWidth;

    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const el = this.elSlots[slot];
      const px = total === Infinity ? Infinity : total * fractions[slot];
      el.classList.toggle('is-tiny', px > 0 && px < 220);
      el.classList.toggle('is-narrow', px >= 220 && px < 380);
    }

    // Mid-animation the bar is being measured against a width its column is
    // only passing through: everything gets shed on the way past, and the bar
    // sits empty while the pane it belongs to is already full size. The widths
    // are settled at the end of the animation instead, where they are true.
    //
    // During a divider drag they ARE true, frame by frame, and one rung per
    // frame is what keeps that drag cheap — so that path is left as it was.
    if (!this.root.classList.contains('is-animating')) {
      if (this._dividerDragging) this._syncPaneHeaderFit();
      else this._settleHeaderFit();
      // And ask again whether the bar is in anyone's way. Until now only
      // opening or closing a panel asked that — but the panel can hold still
      // while the LAYOUT moves out from under it: focusing the other pane
      // takes the column holding an open table of contents off the screen, and
      // the bar was left folded in a corner with nothing left to be folded
      // out of the way of, and nothing on screen to close.
      this._reviewToolbarConflict();
    }
    this._syncToolbarSize(fractions);
  }

  /**
   * Climbs or descends the WHOLE ladder, not one rung per layout.
   *
   * `_syncPaneHeaderFit` deliberately makes at most one change per call, which
   * is right while a divider is being dragged and wrong everywhere else: a
   * column that goes from half the screen to all of it needs every rung back,
   * and got one. The bar then kept its narrow arrangement — the same handful of
   * controls squeezed to the left — under a pane twice the width, which is what
   * "the column changed but the bar did not" looks like.
   *
   * Bounded by the ladder itself, and stops as soon as a pass changes nothing.
   */
  _settleHeaderFit() {
    for (let i = 0; i <= HEADER_LADDER.length; i++) {
      const before = this._headerRungs();
      this._syncPaneHeaderFit();
      if (this._headerRungs() === before) return;
    }
  }

  /**
   * 一栏里真正放页面的那一块，屏幕坐标。
   *
   * 不是整栏：整栏上面还顶着横杠和切换条，而从书架飞过来的那本书是落在页面
   * 上的，不是落在横杠上。落错了这一下会在最后一帧跳一格。
   *
   * 栏在动画中途或者被收起来时量出来是 0，那时候没有「那一页」可言，交给
   * 调用方去退到整个工作区。
   */
  slotRect(slot) {
    const pane = this.elSlots?.[slot]?.querySelector('.pdf-slot-pane');
    const rect = pane?.getBoundingClientRect();
    return rect && rect.width > 1 && rect.height > 1 ? rect : null;
  }

  /**
   * 工具栏不能进的那两条带子：顶上的分栏横杠，底下那条悬浮菜单栏。
   *
   * 顶边问的是每一栏里看得见的横杠，不是「当前那一栏」——当前那一栏不一定是看得
   * 见的那一栏。在左栏是活动栏时点右栏的专注，走掉的正是左栏，而安全区原来是拿
   * 它量的：它一被移出文档流，横杠量到 0，工具栏就被告知顶上空出了 40px，真机上
   * 一帧之内往上弹了 76px。工具栏浮在整个工作区上，任何一条看得见的横杠都是它
   * 要躲开的东西，所以取最大的那个。
   *
   * 底边是这次新加的。它一直是 0——也就是说底下那条悬浮菜单栏从来不算数，而它是
   * fixed 的，就压在工作区上。菜单栏一升起来，工具栏就被它盖住半截。
   *
   * 量的是「此刻」菜单栏的上沿，不是它的最终位置：拖的过程中它的矩形每一帧都在
   * 变，手停下它也停下。所以工具栏是被顶上去的，而不是等它到位之后才跳一下。
   */
  _toolbarSafeArea(rect) {
    const top = [SLOTS.PRIMARY, SLOTS.SECONDARY].reduce((most, s) => {
      const el = this.elSlots[s];
      if (!el || el.hidden || !el.offsetWidth) return most;
      const header = el.querySelector('.pdf-slot-toolbar');
      const strip = el.querySelector('.deck-strip');
      return Math.max(most, (header && !header.hidden ? header.offsetHeight : 0)
        + (strip && !strip.hidden ? strip.offsetHeight : 0));
    }, 0);

    const dock = typeof document !== 'undefined'
      ? document.querySelector('.bottom-nav') : null;
    const box = dock?.getBoundingClientRect?.();
    // 只有真挡在路上的菜单栏才算数。
    //
    // 那条菜单栏是居中的一颗胶囊——真机上量到它横跨 360–840，而工具栏靠在最左边
    // 的 10–63。两者横向根本不相交，可安全区是按整条底边算的，于是菜单栏一升起来
    // 工具栏就被顶上去、还缩短了一截，而它从头到尾都没被挡住过一个像素。
    //
    // 拿横向是否相交来判，而不是纵向：被顶上去之后纵向就不相交了，再拿纵向去判
    // 会来回摆——顶上去、不冲突了、落回来、又冲突。横向不随这个动作改变，所以它
    // 是稳的。
    const bar = this.toolbar?.rect?.();
    const inTheWay = !!box && box.height > 0 && !!bar
      && box.right > bar.left && box.left < bar.right;
    // 收起来的时候它被挪到屏幕外面，上沿落在工作区底边以下，相减是负的——那就是
    // 0，没有盖住任何东西。
    const bottom = inTheWay ? Math.max(0, rect.bottom - box.top) : 0;
    return { top, bottom };
  }

  /**
   * 菜单栏动了一下，工具栏重新安顿一次。
   *
   * 走的是整条 _syncToolbarSize，不是只更新那两条带子。
   *
   * 一开始这里只调 setSafeArea，理由是「菜单栏上下滑的时候列宽没变」——列宽确实
   * 没变，可**可用高度**变了，而那正是 fitTo 的输入之一。于是真机上量到：菜单栏
   * 升起来之后，工具栏整条往上挪了，但它自己还是原来那么长，比让出来的带子还长
   * 25px——夹取只好让它两头均匀溢出，看起来就是最下面那个工具压在菜单栏底下。
   * 「紧贴在菜单栏外面」要成立，它得先能装得下。
   *
   * fitTo 里那句「缩放没变到 0.01 就直接返回」让这条路在多数帧上是廉价的。
   */
  syncToolbarSafeArea() {
    if (!this.toolbar?.fitTo || !this.root) return;
    this._syncToolbarSize(paneFractions(this.state));
  }

  /** Which rungs are applied, as one comparable string. */
  _headerRungs() {
    return [SLOTS.PRIMARY, SLOTS.SECONDARY]
      .map(slot => HEADER_LADDER
        .filter(cls => this.elSlots?.[slot]?.classList.contains(cls)).join(','))
      .join('|');
  }

  /**
   * Sheds slot-toolbar chrome until the bar fits the pane it belongs to.
   *
   * The width bands above are cut at fixed pixel widths and a 50:50 split falls
   * between them — wide enough to be called neither narrow nor tiny, too narrow
   * for a bar that wants 774px. What scrolled off the end there was 对答案, the
   * answer lookup this app exists to do.
   *
   * So this does not guess a threshold. It reads what the bar wants against what
   * it has and steps one rung down the ladder while it overflows, one rung back
   * up when there is room again — which makes the decision depend on the real
   * content: a longer page count, a different language or a skin with fatter
   * buttons all move the point at which chrome starts to go, and none of them
   * needs a number changed here.
   *
   * One measurement and at most one class change per pane per call, because this
   * also runs on every frame of a divider drag. Overflow settles over a frame or
   * two rather than thrashing inside one.
   */
  _syncPaneHeaderFit() {
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const el = this.elSlots[slot];
      const bar = el?.querySelector('.pdf-slot-toolbar');
      if (!bar) continue;

      const have = bar.clientWidth;
      // A hidden or not-yet-laid-out pane measures zero, and zero is not a
      // reason to strip its toolbar.
      if (!have) continue;

      // What the bar wants is a lie while the last rung is still closing.
      //
      // Shedding a rung collapses its widths over a quarter second, so for
      // that quarter second the bar still measures as though nothing had gone
      // — and the next frame would shed the rung below it, and the one below
      // that, until the bar was stripped bare and had to climb back. Worse, it
      // would record what it "wanted" from a width caught mid-flight, and that
      // number is what decides whether the chrome ever comes back.
      //
      // So: one change, then wait for it to land. Only the transitions that
      // move width count; the background fades and the hover tints do not.
      if (barIsSettling(bar)) continue;

      // How many rungs are already applied. They go on in order, so the first
      // missing one is the next to add.
      let level = HEADER_LADDER.findIndex(cls => !el.classList.contains(cls));
      if (level === -1) level = HEADER_LADDER.length;

      const wanted = (this._headerWanted[slot] ||= []);

      if (bar.scrollWidth > have + 1) {
        // Still overflowing. Remember what this rung wanted before leaving it,
        // so we know how much room it takes to come back.
        if (level < HEADER_LADDER.length) {
          wanted[level] = bar.scrollWidth;
          el.classList.add(HEADER_LADDER[level]);
        }
        continue;
      }

      // It fits. Restore the last thing hidden once there is room for it plus a
      // margin, so a pane resting exactly on the boundary does not flicker.
      if (level > 0) {
        const need = wanted[level - 1];
        if (need && have > need + 8) el.classList.remove(HEADER_LADDER[level - 1]);
      }
    }
  }

  /**
   * Keeps the floating toolbar sized to the column it is serving.
   *
   * Called from the same place as the width bands, so it runs on every frame
   * of a divider drag as well as on resize: the tools grow and shrink with the
   * column rather than jumping to a new size when the drag ends.
   *
   * It is measured against the column it FLOATS OVER, which is not always the
   * active one. The bar is parented to the workspace and parked wherever it was
   * dragged, so "the pane it applies to" and "the pane it has to fit inside"
   * are two different panes as soon as someone works in the right-hand book
   * with the bar still resting on the left. Sizing it against the active pane
   * let a bar sitting on a 312px column keep the size it was given for an 856px
   * one, which is the whole point of fitting it.
   *
   * The boundary is computed from `fractions` rather than measured, because on
   * a divider drag the model leads the DOM by a frame and the bar should track
   * the drag, not trail it.
   *
   * The workspace HEIGHT is the other input, and the one that actually binds on
   * a tablet held in landscape — a full-size vertical bar is longer than the
   * space it has to live in.
   */
  _syncToolbarSize(fractions) {
    if (!this.toolbar?.fitTo) return;
    const rect = this.root.getBoundingClientRect();
    if (!rect.height) return;

    // The chrome running across the top of the pane, which the floating ink
    // toolbar must not park on top of. Measured rather than assumed, because
    // it is exactly the thing that grows a row when a pane gets narrow.
    //
    // BOTH bars, not just the first. The switching strip is a second 52dp row
    // under the slot toolbar, and leaving it out of the safe area put the
    // floating bar over the strip's Previous arrow — two controls in one place,
    // which is the overlap the visual acceptance list rules out.
    const safe = this._toolbarSafeArea(rect);
    this.toolbar.setSafeArea?.(safe.top, safe.bottom);

    const column = this.state.orientation === ORIENTATIONS.COLUMN;
    // In column layout the panes are full width, so width is never the
    // constraint and only the height matters.
    const width = column ? rect.width : this._toolbarColumnWidth(fractions, rect);

    this.toolbar.fitTo({ height: rect.height, column: width });
  }

  /**
   * Width of the column the floating toolbar is resting on.
   *
   * Falls back to the active pane's share when the bar has no box yet, and to
   * the whole workspace when there is no usable share — a bar that spans the
   * boundary is not inside either column, and the full width is the only
   * honest answer for it.
   */
  _toolbarColumnWidth(fractions, rect) {
    // Same trap: the active column can be the one at zero share, and a bar
    // fitted to a column of width 0 has no width at all.
    const share = fractions?.[this.activeSlot];
    const fallback = share > 0 ? rect.width * share : rect.width;

    const bar = this.toolbar?.root?.getBoundingClientRect?.();
    if (!bar || !bar.width) return fallback;

    const left = this.state.swapped ? SLOTS.SECONDARY : SLOTS.PRIMARY;
    const right = this.state.swapped ? SLOTS.PRIMARY : SLOTS.SECONDARY;
    const leftShare = fractions?.[left];
    if (!Number.isFinite(leftShare)) return fallback;

    const boundary = rect.left + rect.width * leftShare;
    const centre = bar.left + bar.width / 2;
    const slot = centre <= boundary ? left : right;
    const slotShare = fractions?.[slot];
    if (!Number.isFinite(slotShare) || slotShare <= 0) return fallback;
    return rect.width * slotShare;
  }

  _markActive(slot) {
    this.activeSlot = slot;
    for (const s of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      this.elSlots[s].classList.toggle('is-active', s === slot);
    }
    // The shared toolbar follows the active pane, so its current tool, colour
    // and width apply to the surface the user is about to draw on.
    this.toolbar?.syncToActiveSurface();
    // Refit too: with no resize to ride on, changing panes used to leave the
    // bar at whatever size the previous pane had earned it.
    this._syncToolbarSize(paneFractions(this.state));
  }

  _syncAgentAvailability() {
    const available = [SLOTS.PRIMARY, SLOTS.SECONDARY]
      .some((slot) => this.panes[slot]?.isLoaded());
    if (!available && this.agentTarget) {
      this._closeAgentPanel({ notify: false });
    }
    this.agentPanel?.setAvailable(available);
  }

  _closeAgentPanel({ notify = true } = {}) {
    this.agentPanel?.close({ notify });
    this.agentTarget = null;
  }

  // ── per-slot chrome (toolbar + outline) ───────────────────────────────────

  _bindSlotChrome(slot) {
    const el = this.elSlots[slot];
    const pane = this.panes[slot];
    const on = (role, handler) => {
      const node = el.querySelector(`[data-role="${role}"]`);
      if (node) node.addEventListener('click', handler);
      return node;
    };

    on('prev', () => pane.previous());
    on('next', () => pane.next());
    on('note-add-page', async () => {
      try {
        const updated = await this.addNotePage(slot);
        if (!updated) return;
        if (updated.pageCount >= NOTE_PAGE_MAX) this._setStatus(slot, t('note.atPageMax'));
      } catch (error) {
        Logger.error('PDF', 'add note page failed', error);
        this._setStatus(slot, t('note.addPageFailed'));
      }
    });
    // Zoom belongs to whichever surface is on screen. A pad's zoom is its
    // camera; a book's is its fit — the same two buttons, two different things
    // underneath, and the slot knows which it is showing.
    on('zoom-out', () => this.viewFor(slot)?.zoomOut());
    on('zoom-in', () => this.viewFor(slot)?.zoomIn());
    on('fit-width', () => pane.fitWidth());
    on('fit-page', () => pane.fitPage());

    on('scratch-origin', () => this.scratchPanes[slot]?.returnToOrigin());
    on('scratch-fit', () => {
      const result = this.scratchPanes[slot]?.fitAllInk();
      // Ink spread wider than the minimum zoom can show is REPORTED, not
      // cropped: the reader is told they can pan through the rest.
      if (result && !result.fitted) this._setStatus(slot, t('scratch.tooLarge'));
    });
    // The save readout is also the retry. A failure that can only be read is a
    // failure the reader can do nothing about.
    on('scratch-save', () => {
      const scratch = this.scratchPanes[slot];
      if (!scratch) return;
      if (scratch.saveState === SAVE_STATES.FAILED) scratch.retrySave();
      else scratch.flush();
    });

    // Removing lives inside the ⋯ menu, not on the bar.
    //
    // It was the last control on the right-hand pane's toolbar, a stylus-width
    // target against the edge of the screen, and it threw away the reading
    // position of a book someone was working in. Two deliberate taps for
    // something irreversible-looking is the right price; every other control on
    // the bar is one tap and undoable.
    on('close', () => {
      this._closeSlotMenus();
      const entry = activeEntryIn(this.state, slot);
      if (entry) this.removeEntry(slot, entry.id);
    });
    on('organize', () => { this._closeSlotMenus(); this.organize(slot, null); });
    on('scratch-style', () => {
      this._closeSlotMenus();
      const kind = activeEntryIn(this.state, slot)?.kind;
      if (kind === ENTRY_KINDS.NOTE) this.openNoteStylePanel(slot);
      else this.openStylePanel(slot);
    });
    on('focus-scratch', () => { this._closeSlotMenus(); this.enterFocus(slot); });
    on('focus-exit', () => this.exitFocus());
    on('bookmark', () => this._toggleBookmark(slot));
    on('delete-pad', () => { this._closeSlotMenus(); this.deletePad(slot); });
    on('slot-more', () => this._toggleSlotMenu(slot));
    on('focus', () => {
      this.animateToFocus(slot);
    });
    // 目录与缩略图是同一个面板的两面，同一个按钮开合——它们回答同一个问题，
    // 目录空手而归的那一刻，人想要的正是缩略图，不该再去找第二个按钮。
    on('outline', () => this.panels?.[slot]?.toggle());

    // Tool selection lives in the floating toolbar (spec chapter 5); per-pane
    // undo/redo stays here because history belongs to a pane, not to a tool.
    //
    // 作用在**这一栏里真正显示着的**那块画布上，不是 this.panes[slot]。
    //
    // 原来这两行写的是 pane.ink，而 pane 是构造时抓住的 PdfPane。于是在草稿纸上
    // 按撤销，撤的是那一栏里那本书的笔迹——一块没人在看的画布。按钮本身是亮的
    // （下面 _syncSlotChrome 里算 disabled 用的是显示着的那一个），所以现象是
    // 「按钮能按，按了没反应」，而不是任何一处报错。
    //
    // 和浮动笔迹栏当年那个 bug 是同一个：见构造函数里 getSurface 那一段。那次只
    // 修了浮动栏，栏内这两颗漏了。这次两处都改成问同一个 viewFor(slot)，「按钮亮
    // 不亮」和「按下去作用在谁身上」从此不可能各说各的。
    on('ink-undo', () => this.viewFor(slot)?.ink?.undo());
    on('ink-redo', () => this.viewFor(slot)?.ink?.redo());
    on('answers', () => this.toggleAnswers(slot));

    const pageInput = el.querySelector('[data-role="page-input"]');
    if (pageInput) {
      pageInput.addEventListener('change', () => {
        pane.goToPage(parseInt(pageInput.value, 10));
        this._syncSlotChrome(slot);
      });
    }
  }

  /**
   * Opens this slot's ⋯ menu, closing the other one.
   *
   * Only ever one open: two menus at once on a split screen is two claims on
   * the next tap, and the second one is always a mistake.
   */
  _toggleSlotMenu(slot) {
    const menu = this.elSlots[slot]?.querySelector('[data-role="slot-menu"]');
    if (!menu) return;
    const open = menu.hidden;
    this._closeSlotMenus();
    if (open) this._setSlotMenu(slot, true);
  }

  _setSlotMenu(slot, open) {
    const el = this.elSlots[slot];
    const menu = el?.querySelector('[data-role="slot-menu"]');
    const button = el?.querySelector('[data-role="slot-more"]');
    if (!menu) return;
    if (open) {
      // Under the bar, measured rather than assumed: the toolbar sheds rows as
      // the pane narrows, so its height is not a number this can hard-code.
      //
      // offsetTop as well as offsetHeight — both are in the slot's coordinates,
      // which is what `top` is resolved against, and the bar does not start at
      // the slot's own top: the slot carries a border and the skins add to it.
      // Height alone put the menu over the bottom edge of the bar it hangs off.
      const bar = el.querySelector('.pdf-slot-toolbar');
      const below = bar ? bar.offsetTop + bar.offsetHeight : 0;
      menu.style.top = `${below + 4}px`;
    }
    menu.hidden = !open;
    button?.setAttribute('aria-expanded', String(!!open));
    button?.classList.toggle('is-active', !!open);
  }

  _closeSlotMenus() {
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this._setSlotMenu(slot, false);
  }

  _syncSlotChrome(slot) {
    this.panels?.[slot]?.syncCurrentPage();
    this._syncBookmarkButton(slot);
    const el = this.elSlots[slot];
    const pane = this.panes[slot];
    const set = (role, fn) => {
      const node = el.querySelector(`[data-role="${role}"]`);
      if (node) fn(node);
    };

    const entry = activeEntryIn(this.state, slot);
    const scratch = entry?.kind === ENTRY_KINDS.SCRATCH;
    const scratchPane = this.scratchPanes[slot];
    const view = scratch ? scratchPane : pane;
    const loaded = !!view?.isLoaded?.();

    set('toolbar', n => { n.hidden = !loaded; });
    set('title', n => {
      n.textContent = scratch ? (this.pads[slot]?.name || '') : (pane.meta ? pane.meta.name : '');
    });
    // A pad has no pages, so the controls that are about pages are not merely
    // disabled — they are not there. A disabled Next Page on a boundless sheet
    // invites the question of what it would have done.
    set('pdf-controls', n => { n.hidden = scratch; });
    const note = entry?.kind === ENTRY_KINDS.NOTE;
    set('note-add-page', n => {
      n.hidden = !note || !loaded;
      n.title = t('note.addPage');
      // 到上限了就按不动，但按钮还在 —— 没了的话人会以为自己记错了。
      n.disabled = !!note && loaded && pane.state.pageCount >= NOTE_PAGE_MAX;
    });
    set('scratch-controls', n => { n.hidden = !scratch; });
    set('prev', n => { n.disabled = !pane.canGoPrevious(); });
    set('next', n => { n.disabled = !pane.canGoNext(); });
    set('page-input', n => {
      if (!scratch && loaded && document.activeElement !== n) n.value = String(pane.state.pageNumber);
      n.max = !scratch && loaded ? String(pane.state.pageCount) : '1';
    });
    set('page-total', n => {
      n.textContent = !scratch && loaded ? `/ ${pane.state.pageCount}` : '';
    });
    // Counted from the whole page, not from the PDF's own 1:1 — so 100% means
    // the page is all there, which is what a reader means by it. On a pad 100%
    // is the world's own scale, which is the same promise.
    //
    // 算一次，两处用：横杠上那个小读数，和缩放时浮出来的那块牌子。算两遍的话
    // 它们迟早会在某个边界上各说各的。
    const zoomPercent = !loaded ? null
      : (scratch ? scratchPane.displayZoom()
        : Math.round((pane.displayZoom?.() ?? pane.state.zoom) * 100));
    set('zoom-label', n => { n.textContent = zoomPercent == null ? '' : `${zoomPercent}%`; });
    this._flashZoom(slot, zoomPercent, entry?.id || null);
    set('scratch-origin', n => { n.textContent = t('scratch.origin'); });
    set('scratch-fit', n => { n.textContent = t('scratch.fitAll'); });
    set('scratch-save', n => {
      const state = scratchPane?.saveState;
      n.textContent = saveLabel(state);
      n.className = `scratch-save is-${state || 'saved'}`;
      // Only a failure is worth pressing. Everything else it says is a report.
      n.disabled = !scratch || state === SAVE_STATES.SAVING;
    });
    set('focus', n => {
      n.classList.toggle('is-active', this.state.focusedSlot === slot);
      n.title = this.state.focusedSlot === slot ? '退出专注' : '专注此文档';
    });
    // 和上面那两颗按钮问的是同一个对象，见 _bindSlotChrome 里的注释。
    set('ink-undo', n => { n.disabled = !loaded || !this.viewFor(slot)?.ink?.canUndo(); });
    set('ink-redo', n => { n.disabled = !loaded || !this.viewFor(slot)?.ink?.canRedo(); });

    // The menu: what it offers depends on what the pane is holding.
    set('close', n => { n.textContent = t('deck.removeFromPane'); });
    set('organize', n => { n.textContent = t('deck.organize'); });
    set('scratch-style', n => {
      n.hidden = !scratch && !note;
      n.textContent = note ? t('note.style') : t('scratch.style');
    });
    set('focus-scratch', n => {
      n.hidden = !scratch || !!this.focusSlot;
      n.textContent = t('scratch.focus');
    });
    set('delete-pad', n => { n.hidden = !scratch; n.textContent = t('scratch.delete'); });

    // A menu belonging to a pane with nothing in it has nothing to offer, and
    // the bar it hangs off is hidden anyway.
    if (!loaded) this._setSlotMenu(slot, false);

    this.strips[slot]?.render();
    this._syncFocusBar();

    // Answering belongs to the exercise book.
    //
    // The action asks "what are the answers to the questions on THIS page",
    // which is only a question the side holding the questions can ask. It used
    // to sit on both panes, so half the time it was pointed at the answer key
    // and asked it to find answers to itself. A pad cannot ask it at all: a
    // scratchpad takes no part in matching.
    const isExercise = !scratch && loaded && pane.meta?.role === DOC_ROLES.EXERCISE;
    set('answers', n => { n.hidden = !isExercise; });
    // And the panel follows the book, so a pane that stops being the exercise
    // book does not keep its answers on screen.
    if (!isExercise) set('answer-panel', n => { n.hidden = true; });
  }

  /**
   * Dismisses the answer panel.
   *
   * Exit is shorter than entry and moves less — a panel arriving has to be
   * noticed, a panel leaving has already done its job and only has to get out
   * of the way. Transform and opacity only, so nothing reflows on the way out.
   */
  hideAnswers(slot) {
    const panel = this.elSlots[slot]?.querySelector('[data-role="answer-panel"]');
    if (!panel || panel.hidden) return;

    const done = () => {
      panel.hidden = true;
      panel.classList.remove('is-dismissing');
      this._syncSlotChrome(slot);
    };

    if (prefersReducedMotion() || typeof panel.animate !== 'function') { done(); return; }

    panel.classList.add('is-dismissing');
    const anim = panel.animate(
      [{ opacity: 1, transform: 'translateY(0)' },
       { opacity: 0, transform: 'translateY(-6px)' }],
      { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
    );
    anim.finished.then(done, done);
  }

  /** The action toggles: pressing it again puts the panel away. */
  toggleAnswers(slot) {
    const panel = this.elSlots[slot]?.querySelector('[data-role="answer-panel"]');
    if (panel && !panel.hidden) { this.hideAnswers(slot); return; }
    this.showAnswersForPage(slot);
  }

  /**
   * Renders the document's own table of contents.
   *
   * When the PDF has no outline the panel says so. It never synthesises one
   * from page numbers or headings — the spec forbids force-generating a table
   * of contents, and a fabricated one would be indistinguishable from a real
   * one to the reader.
   */
  _resetOutline(slot) {
    const button = this.elSlots[slot]?.querySelector('[data-role="outline"]');
    this._outlines[slot] = null;
    if (this._pageShape) this._pageShape[slot] = null;
    const panel = this.panels?.[slot];
    if (panel) panel.reset();
    else {
      // Before the panels are built — and in a partial workspace — the element
      // must still stop showing the last document. This is the invariant, not
      // the object that usually upholds it: a panel left open across a
      // replacement shows the previous book's chapters over the new one.
      const el = this.elSlots[slot]?.querySelector('[data-role="outline-panel"]');
      if (el) { el.hidden = true; el.replaceChildren(); }
    }
    // NOT disabled any more. The button used to be switched off whenever the
    // book had no bookmarks, which also switched off the thumbnails — the one
    // way into a book that has no table of contents. It is disabled only when
    // there is no book at all.
    if (button) button.disabled = !this.panes[slot]?.doc;
    this._syncOverlayState();
  }

  /**
   * 目录展开时把浮动笔迹栏收起来。
   *
   * 笔迹栏挂在工作区上、z-index 36，而目录面板是分栏内部的一块，怎么排都在它下面。
   * 于是一打开目录，六个工具图标就压在条目上，两边都读不成——而这一刻本来也没人
   * 在写字：目录是用来跳转的，点完就关。
   *
   * 文档库早就是这么做的（见 pdf.css 里的 body.is-library-open），这里用同一个
   * 办法，而不是去调 z-index：面板在分栏里面，把它抬到 36 以上就会连带盖住另一
   * 侧的分栏，那是另一个更难看的问题。
   */
  _syncOverlayState() {
    // _resetOutline 会在文档卸载和构造中途被调用，那时 root 与 elSlots 可能还不
    // 存在——这里只是同步一个装饰性的类名，够不着就什么都不做。
    if (!this.root || !this.elSlots) return;
    const open = [SLOTS.PRIMARY, SLOTS.SECONDARY].some((slot) => {
      const panel = this.elSlots[slot]?.querySelector('[data-role="outline-panel"]');
      return panel && !panel.hidden;
    });
    this.root.classList.toggle('is-outline-open', open);
    this._reviewToolbarConflict();
  }

  /**
   * 挡在笔迹栏前面的那一块，不管它是哪一块。
   *
   * 「本栏内容」那张单子和找页面板是同一类东西：都盖在某一栏上、都在笔迹栏
   * 下面、都是打开来读的。所以它们对笔迹栏该有同一套规矩——真的压住了就收成
   * 球飞到那一栏的下角，没压住就一动不动。判断压没压住、往哪个角落，全都在
   * _yieldToolbarAround 里，这里只负责回答「现在开着的是哪一块」。
   *
   * 单子在前：两者同时开着时，它是后打开、也更靠上的那一块。
   */
  /**
   * Which bottom corner the bar should step into.
   *
   * The corners are named against the WORKSPACE, so a column only owns the
   * ones its own span reaches: the left column owns the bottom left, the right
   * column the bottom right, and a single open file — a column that is the
   * whole workspace — owns both.
   *
   * That last case is the one this got wrong. The rule used to be "which half
   * of the workspace is the column's midpoint in", which for a column that IS
   * the workspace compares the centre with itself: never less than, so always
   * the bottom right. A panel conflicting on the left sent the bar across the
   * screen to the far corner. Only the two-column case had ever been right.
   *
   * When a column owns both corners, the bar's own side decides — it steps
   * aside, and stepping aside is a short move, not a journey.
   */
  _cornerFor(column, host, barRect) {
    // The slot is inset from the workspace — a margin, a border, a rounded
    // corner — so "touches the edge" cannot mean "equals it". Generous enough
    // to cover that inset and far too small to reach across the gap between two
    // columns, which is most of the screen.
    const EDGE = 16;
    const ownsLeft = column.left <= host.left + EDGE;
    const ownsRight = column.right >= host.right - EDGE;
    if (ownsLeft && !ownsRight) return CORNERS.BOTTOM_LEFT;
    if (ownsRight && !ownsLeft) return CORNERS.BOTTOM_RIGHT;
    // Both (one open file) or neither (a column touching no edge, which the
    // layout does not produce): go to the corner on the bar's own side.
    const barMid = barRect ? (barRect.left + barRect.right) / 2 : host.left;
    return barMid < host.left + host.width / 2
      ? CORNERS.BOTTOM_LEFT
      : CORNERS.BOTTOM_RIGHT;
  }

  /**
   * 重新判一次笔迹栏和盖上来那一块的冲突。
   *
   * 触发点有三个——单子开合、面板开合、面板拖完高度——每一个都要「先问现在
   * 开着的是哪一块，再拿去判」。这两步一直是分开写的，于是第四个触发点只要
   * 忘了前半句，就会把错的东西递进去。合成一个名字之后，这个错就没法犯了。
   * 判断本身仍然只有 _yieldToolbarAround 一处。
   */
  _reviewToolbarConflict() {
    this._yieldToolbarAround(this._openOverlay());
  }

  _openOverlay() {
    if (!this.root) return null;
    // Open AND on screen. A panel keeps its own open/closed flag, and its
    // column can go out from under it — tap 专注 on the other pane and the
    // column holding an open table of contents is taken out of the flow with
    // the panel still marked open, measuring 0 by 0.
    //
    // That empty answer was enough to keep the bar folded in a corner: the
    // conflict check sees "something is open", leaves the bar where it is, and
    // there is nothing on screen the reader can close to get it back.
    const shown = (el) => el && el.getBoundingClientRect().width > 0;
    // 顺序就是叠放顺序，最上面的排前面：单子 z-index 30，找页面板 24，答案面板
    // 在文档流里（没有 z-index，所以在最下面）。两块同时开着时，该让位给压在
    // 最上面的那一块。
    //
    // 答案面板是后补的。它和另外两块是同一类东西——盖在某一栏上、在笔迹栏下面、
    // 打开来是要读的——但一直不在这张表里，于是「对照本页答案」打开之后笔迹栏
    // 就杵在答案上面不动。它还有一点和另外两块不同：高度是内容撑出来的（最高
    // 48%），一条提示和一整页匹配结果差很多，所以它的尺寸变化也要重新判一次
    // ——见 _watchSlotSizes 里对它的观察。
    for (const role of ['deck-list', 'outline-panel', 'answer-panel']) {
      for (const el of this.root.querySelectorAll(`[data-role="${role}"]:not([hidden])`)) {
        if (shown(el)) return el;
      }
    }
    return null;
  }

  _renderOutline(slot, outline) {
    const button = this.elSlots[slot]?.querySelector('[data-role="outline"]');
    this._outlines[slot] = outline;
    if (button) button.disabled = !this.panes[slot]?.doc;
    this.panels?.[slot]?.setOutline(outline);
    this._learnPageShape(slot);
  }

  /** 高度是拖出来的，拖动中每一帧都写盘就太吵了——停下来再写。 */
  _persistPanelSoon() {
    clearTimeout(this._panelSave);
    this._panelSave = setTimeout(() => this._persistPanel(), 400);
  }

  _persistPanel() {
    clearTimeout(this._panelSave);
    try {
      localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(serializePanelState(this._panelState)));
    } catch (_) { /* 无痕模式下存不了，面板照常用 */ }
  }

  /**
   * The shape of page one, used to lay out every thumbnail cell.
   *
   * Every cell is sized before a single page is rasterised, so the scrollbar
   * tells the truth about how long the book is from the first frame and the
   * reader can throw it to the middle. That needs an aspect ratio up front,
   * and asking for all 827 of them to place a grid is asking the wrong
   * question — books are uniform, and a mixed one costs a slightly wrong box
   * until its page is painted into it.
   */
  _learnPageShape(slot) {
    const doc = this.panes[slot]?.doc;
    if (!doc || typeof doc.pageSize !== 'function' || this._pageShape?.[slot]) return;
    const wanted = doc;
    doc.pageSize(1).then((size) => {
      if (this.panes[slot]?.doc !== wanted) return;
      if (this._pageShape) this._pageShape[slot] = size;
    }).catch(() => { /* the A4 guess in the panel stands */ });
  }

  // ── documents ─────────────────────────────────────────────────────────────

  /** Loads a library document into a slot, replacing whatever was there. */
  /**
   * Loads a library document into a slot.
   *
   * Guarded by a per-slot token. Opening is several awaits long (metadata,
   * bytes, parse, first render), so two taps in the library could previously
   * run concurrently against the same slot and the SLOWER one would win —
   * leaving the pane showing one document while the workspace state, outline
   * and saved session all named the other. A superseded open now stops before
   * it can touch the pane, and releases the document it opened rather than
   * leaking it.
   */
  /**
   * Drops the caches that span BOTH documents.
   *
   * The TOC alignment and the shared-font verdict are stored on one pane but
   * describe a PAIR of books, so changing either side invalidates them on both.
   * Clearing only the pane that changed left the other holding an alignment
   * against a document that was no longer open.
   */
  _invalidatePairCaches() {
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const pane = this.panes[slot];
      if (!pane) continue;
      pane.outlineAlignment = null;
      pane.answerComparability = undefined;
      pane.pairVerdict = null;
    }
    // The background answer handles describe a pair too. Held across a change
    // of book they would answer the new exercise out of the old key's index.
    this._releaseAnswerHandles();
  }

  /**
   * Opens a PDF into a slot, keeping what was there underneath.
   *
   * A thin wrapper over the deck operations now: the insert is committed first
   * so the entry exists to be shown, and `showEntry` runs the handoff — flush,
   * prepare, commit — rather than this doing its own. A resource already in the
   * deck is recalled by `openInSlot` instead of opened twice.
   */
  async openDocument(slot, documentId, restoredView) {
    // Two different failures, and they are not interchangeable.
    //
    // A document that is not in the library is an ERROR: the caller asked for
    // something that does not exist and has to say so. An open that is
    // SUPERSEDED — the slot was closed, or something else was opened into it
    // while this one was still loading — is not an error at all; it is the
    // newer request winning, and it resolves to null so the caller quietly
    // stands down. Collapsing the two would either throw on an ordinary race or
    // swallow a missing file.
    const meta = await this._pdfLibrary.getDocumentMeta(documentId);
    if (!meta) throw new Error('PDF_DOC_NOT_FOUND');

    const before = this.state;
    const { state, entry } = openInSlot(this.state, slot, {
      kind: ENTRY_KINDS.PDF,
      resourceId: documentId,
    });
    if (!entry) throw new Error('PDF_DOC_NOT_FOUND');
    this._setState(state);

    const ok = await this.showEntry(slot, entry.id, { restoredView, force: true });
    if (!ok) {
      // Never leave an entry in a deck for something that did not open. The
      // deck goes back exactly as it was, which is the failure rule: the pane
      // keeps showing what it was showing, and nothing was skipped silently.
      this._setState(before);
      this._layout();
      return null;
    }
    return meta;
  }

  closeSlot(slot) {
    this._openTokens[slot] = (this._openTokens[slot] || 0) + 1;
    if (this.agentTarget?.slot === slot) this._closeAgentPanel();
    // Before the unload: it drops the pane's view state, and that state is
    // exactly the page this book should open on next time.
    this._rememberSlotView(slot);
    this.panes[slot].unload();
    this._invalidatePairCaches();
    this._setState(closeSlot(this.state, slot));
    this._resetOutline(slot);
    // Closing one document doubles the width of the other, and a fit-to-width
    // page that is not refitted keeps the zoom it had at half the size. This is
    // why a single open book used to sit at the wrong scale.
    this._resizePanes();
    this._persist();
  }

  // ── decks: showing, cycling, removing ─────────────────────────────────────

  /** The pane this slot's ACTIVE entry belongs to — a book's or a pad's. */
  viewFor(slot) {
    const entry = activeEntryIn(this.state, slot);
    if (entry?.kind === ENTRY_KINDS.SCRATCH) return this.scratchPanes[slot] || null;
    return this.panes[slot] || null;
  }

  /**
   * The pane that actually has something on screen in this slot.
   *
   * Not the same question as `viewFor`, and the difference is where a real
   * defect lived. Opening commits the deck first — the entry has to exist
   * before it can be shown — so by the time the handoff runs, the ACTIVE entry
   * is already the incoming one. Asking `viewFor` for "the outgoing view" then
   * returned the pane the target will land in, which was usually empty: the
   * outgoing pad's `flush()` was never called, and a failure had nothing
   * recorded to restore. What is loaded is a fact about the panes, so it is
   * read from the panes.
   */
  _loadedViewIn(slot) {
    if (this.scratchPanes?.[slot]?.isLoaded?.()) return this.scratchPanes[slot];
    if (this.panes?.[slot]?.isLoaded?.()) return this.panes[slot];
    return null;
  }

  /** The element the switching gesture moves: whichever pane is on screen. */
  _paperOf(slot) {
    const entry = activeEntryIn(this.state, slot);
    const role = entry?.kind === ENTRY_KINDS.SCRATCH ? 'scratch-pane' : 'pane';
    return this.elSlots[slot]?.querySelector(`[data-role="${role}"]`) || null;
  }

  /**
   * The scratch pane for a slot, built the first time one is needed.
   *
   * Lazily, because most sessions never open a pad and an unused pane is still
   * two canvases and a set of listeners.
   */
  _scratchPane(slot) {
    if (this.scratchPanes[slot]) return this.scratchPanes[slot];
    const host = this.elSlots[slot].querySelector('[data-role="scratch-pane"]');
    const pane = new ScratchPane(host, {
      onStateChange: () => { this._syncSlotChrome(slot); this._persist(); },
      onFocus: () => this._markActive(slot),
      onInkHistoryChange: () => this._syncSlotChrome(slot),
      onSaveStateChange: () => this._syncSlotChrome(slot),
      onInkDragOver: (at) => this._markInkDropTarget(slot, at),
      onInkDragDrop: (payload) => this._dropInkIntoOtherSlot(slot, payload),
    });
    this.scratchPanes[slot] = pane;
    return pane;
  }

  /** What the strip and the list say about one entry. */
  describeEntry(slot, entry) {
    if (!entry) return {};
    const showing = activeEntryIn(this.state, slot)?.id === entry.id;
    const cached = this._names?.[entry.resourceId];
    if (entry.kind === ENTRY_KINDS.SCRATCH) {
      const pad = showing ? this.pads[slot] : null;
      const pane = showing ? this.scratchPanes[slot] : null;
      return {
        name: pad?.name || cached || t('deck.scratch'),
        detail: pane?.isLoaded() ? `${pane.displayZoom()}%` : '',
        save: pane?.isLoaded() ? saveLabel(pane.saveState) : '',
      };
    }
    const pane = showing ? this.panes[slot] : null;
    return {
      name: (showing && pane?.meta?.name) || cached || t('deck.pdf'),
      detail: showing && pane?.isLoaded() ? `${pane.state.pageNumber} / ${pane.state.pageCount}` : '',
      save: '',
    };
  }

  /**
   * Brings one entry of a deck to the foreground — the handoff transaction.
   *
   * The order is the whole of it, and it is the order the specification sets
   * out: finish and FLUSH what is on screen, prepare the target, and only then
   * commit. A preview never touches `activeId`; a failure leaves the pane
   * showing exactly what it was showing, with a reason and a retry. Nothing is
   * skipped and the pane is never blanked.
   *
   * Latest-wins: a request arriving mid-handoff replaces the pending target
   * rather than queueing, so a run of taps on Next lands where the user last
   * pointed instead of playing back every entry they passed.
   */
  async showEntry(slot, entryId, { restoredView, force = false } = {}) {
    // A workspace is not always built by its constructor: the performance tests
    // stand one up from the prototype with only the fields they exercise, and
    // this is the first thing they call. Same lesson as `_syncOverlayState` and
    // the page cache — a method reached during setup has to cope with the half
    // of the object that is not there yet.
    this._switching ||= {};
    this._paneInFlux ||= {};
    this._pending ||= {};
    this.scratchPanes ||= {};
    this.strips ||= {};
    this.pads ||= {};

    const deck = deckFor(this.state, slot);
    const entry = findEntry(deck, entryId);
    if (!entry) return false;
    // Already on screen? Asked of the SCREEN, not of the deck. The deck's
    // active id is committed before the switch runs, so testing it here would
    // report "already showing" for an entry that has not been loaded yet —
    // leaving the pane on the previous pad under the new pad's name.
    this._shown ||= {};
    if (!force && this._shown[slot]?.id === entryId && this._loadedViewIn(slot)) return true;

    if (this._switching[slot]) {
      // Someone is already handing this pane over. Record where the user now
      // wants to end up and let the running transaction finish; it will pick
      // this up rather than starting a second one alongside it.
      this._pending[slot] = entryId;
      return false;
    }

    this._switching[slot] = entryId;
    // What is on screen right now, so a failure can put it back. A PdfPane can
    // hold one document, so preparing the target means releasing the source —
    // and if the target then fails to open, the pane is left with nothing. The
    // specification is explicit that a failure must never blank a pane, so the
    // source is re-shown rather than the reader being left looking at nothing.
    //
    // Read from `_shown`, which records what was last COMMITTED to the screen,
    // rather than from the deck's active id: opening commits the entry before
    // showing it, so the active id is already the incoming one by now.
    this._shown ||= {};
    const wasShowing = this._shown[slot];
    this._setStatus(slot, t('deck.savingBefore'));
    try {
      // 1 — commit whatever is on screen. A save that fails stops the switch:
      //     the only unsaved copy is never released to make a transition work.
      const outgoing = this._loadedViewIn(slot);
      if (outgoing?.flush) {
        const saved = await outgoing.flush();
        if (!saved) {
          // Nothing has been released yet, so there is nothing to restore.
          this._setStatus(slot, t('deck.switchFailed', { reason: t('scratch.unsaved') }));
          return false;
        }
      } else if (outgoing?.isLoaded?.()) {
        this._rememberSlotView(slot);
      }

      // 2 — prepare the target. Slow files say so rather than pretending.
      this._setStatus(slot, t('deck.opening'));
      const prepared = entry.kind === ENTRY_KINDS.SCRATCH
        ? await this._prepareScratch(slot, entry)
        : await this._preparePdf(slot, entry, restoredView);
      if (!prepared) {
        await this._restoreAfterFailedSwitch(slot, wasShowing, entryId,
          t('deck.switchFailed', { reason: t('deck.untitled') }));
        return false;
      }

      // 3 — commit: the deck's active id and what is on screen change together.
      this._setState(activateInSlot(this.state, slot, entryId));
      this._shown[slot] = entry;
      this._showPaneFor(slot, entry.kind);
      this._layout();
      this._resizePanes();
      this._persist();
      this._setStatus(slot, '');
      // The deck may have gained an entry this pane has never rendered; the
      // content list has to be able to name it.
      this._resolveNames();
      return true;
    } catch (error) {
      Logger.error('PDF', 'switch failed', error);
      await this._restoreAfterFailedSwitch(slot, wasShowing, entryId,
        t('deck.switchFailed', { reason: error?.message || '' }));
      return false;
    } finally {
      this._paneInFlux[slot] = false;
      this._switching[slot] = null;
      const next = this._pending[slot];
      this._pending[slot] = null;
      // Only if it is still somewhere else: reaching the pending target already
      // cancels the pending intent.
      if (next && activeEntryIn(this.state, slot)?.id !== next) {
        this.showEntry(slot, next);
      } else {
        this._syncSlotChrome(slot);
      }
    }
  }

  /**
   * Puts back what the pane was showing before a switch that did not happen.
   *
   * Guarded against recursion: the restore is itself a preparation and can fail
   * too — a book deleted while it was on screen, say — and two failures must
   * not become an endless pair of attempts. The second one gives up and leaves
   * the pane empty, which by then is the truth.
   *
   * The status is set LAST, because re-showing the source clears it on its way
   * through: the reason the switch failed is what the reader needs to be left
   * looking at.
   */
  async _restoreAfterFailedSwitch(slot, wasShowing, attemptedId, reason) {
    const canRestore = wasShowing
      && wasShowing.id !== attemptedId
      && !this._restoring
      && findEntry(deckFor(this.state, slot), wasShowing.id)
      && !this._loadedViewIn(slot);
    if (canRestore) {
      this._restoring = true;
      try {
        const back = wasShowing.kind === ENTRY_KINDS.SCRATCH
          ? await this._prepareScratch(slot, wasShowing)
          : await this._preparePdf(slot, wasShowing, undefined);
        if (back) {
          this._setState(activateInSlot(this.state, slot, wasShowing.id));
          this._shown[slot] = wasShowing;
          this._showPaneFor(slot, wasShowing.kind);
          this._layout();
          this._resizePanes();
        }
      } catch (error) {
        Logger.warn('PDF', `Could not restore slot ${slot}: ${error.message}`);
      } finally {
        this._restoring = false;
      }
    }

    // The deck must not go on claiming to show something that is not on screen.
    //
    // Opening commits the entry first, so after a failure the active id names
    // the file that would not open while the pane shows the old one. Left that
    // way the strip names the wrong thing, and — worse — `_persist` writes it,
    // so the next launch tries the broken file again and the reader is stuck
    // with it. What is on screen is the truth; the active id is corrected to
    // match.
    const onScreen = this._shown?.[slot];
    if (onScreen
        && findEntry(deckFor(this.state, slot), onScreen.id)
        && activeEntryIn(this.state, slot)?.id !== onScreen.id) {
      this._setState(activateInSlot(this.state, slot, onScreen.id));
      this._layout();
      this._persist();
    }
    this._setStatus(slot, reason);
  }

  /** Loads a PDF entry into the slot's book pane. */
  async _preparePdf(slot, entry, restoredView) {
    const token = (this._openTokens[slot] || 0) + 1;
    this._openTokens[slot] = token;
    const superseded = () => this._openTokens[slot] !== token;

    // 一本书和一本笔记本在这条路上只差两行：从哪儿拿 meta，从哪儿拿文档。往下
    // 的翻页、缩放、位图缓存、预取、笔迹对齐、目录、会话记页，一个字都不用分。
    // 那正是 note-document.js 把笔记本装成文档形状换来的东西。
    const isNote = entry.kind === ENTRY_KINDS.NOTE;
    const notebook = isNote ? await this._pdfLibrary.getNotebook(entry.resourceId) : null;
    if (isNote && !notebook) throw new Error('NOTE_NOT_FOUND');
    const meta = isNote
      ? noteMeta(notebook)
      : await this._pdfLibrary.getDocumentMeta(entry.resourceId);
    if (!meta) throw new Error('PDF_DOC_NOT_FOUND');
    if (superseded()) return false;

    // Where this book should open, in order of who has the best claim.
    //
    // A session restore names the view it wants and wins. Otherwise this
    // ENTRY's own recorded page is the one to come back to — which is what
    // keeps the same PDF at two different pages in the two panes, and what
    // carries a page across when an entry is moved. Failing both, the book
    // opens where it was last put down anywhere. Only a document that has never
    // been opened starts at the top of page 1, which is the one time that is
    // the right answer.
    const view = restoredView
      || viewForEntry(entry.id)
      || recallDocView(entry.resourceId)
      || undefined;

    this._resetOutline(slot);
    const pane = this.panes[slot];
    if (this.agentTarget?.slot === slot) this._closeAgentPanel();
    if (pane.isLoaded()) {
      this._rememberSlotView(slot);
      pane.unload();
    }
    // The pad in this slot is put away too: two loaded views in one slot is the
    // thing the renderer budget exists to prevent.
    if (this.scratchPanes[slot]?.isLoaded()) {
      await this.scratchPanes[slot].flush();
      this.scratchPanes[slot].unload();
      this.pads[slot] = null;
    }
    this._invalidatePairCaches();

    const doc = isNote
      ? openNoteDocument(notebook)
      : await this._pdfLibrary.openStoredDocument(entry.resourceId);
    if (superseded()) {
      try { doc.destroy(); } catch (_) { /* nothing further to release */ }
      return false;
    }
    // 从这一行起，这一栏的页码谁都不许记——见 _paneInFlux。
    this._paneInFlux[slot] = true;
    const loaded = await pane.loadDocument(doc, meta, view, () => !superseded());
    if (!loaded || superseded()) {
      if (pane.doc === doc) pane.unload();
      else {
        try { doc.destroy(); } catch (_) { /* already released */ }
      }
      return false;
    }
    this._rememberName(entry.resourceId, meta.name);

    const outlinePromise = typeof doc.getOutline === 'function'
      ? doc.getOutline() : Promise.resolve(doc.outline);
    outlinePromise.then((outline) => {
      if (!superseded() && pane.doc === doc) this._renderOutline(slot, outline);
    }).catch((error) => {
      if (!superseded() && pane.doc === doc) {
        Logger.warn('PDF', `Could not load outline: ${error.message}`);
        this._renderOutline(slot, { available: false, items: [] });
      }
    });
    return true;
  }

  /** Loads a scratchpad entry into the slot's pad pane. */
  async _prepareScratch(slot, entry) {
    const pad = await this._pdfLibrary.getScratchpad(entry.resourceId);
    if (!pad) throw new Error('SCRATCH_NOT_FOUND');

    // The book in this slot goes away first, for the same renderer budget.
    if (this.panes[slot].isLoaded()) {
      this._rememberSlotView(slot);
      this.panes[slot].unload();
      this._invalidatePairCaches();
    }
    this._resetOutline(slot);

    const pane = this._scratchPane(slot);
    // 同上。草稿纸装载途中也会触发存盘。
    this._paneInFlux[slot] = true;
    const ok = await pane.loadPad(pad);
    if (!ok) return false;
    this.pads[slot] = pad;
    this._rememberName(entry.resourceId, pad.name);
    return true;
  }

  /** Names survive a pane unloading, so the list can still label an entry. */
  _rememberName(resourceId, name) {
    this._names ||= {};
    if (resourceId && name) this._names[resourceId] = name;
  }

  /**
   * Learns the name of everything in both decks, not just what is on screen.
   *
   * Only the active entry has a live pane to ask, so without this every entry
   * rotated underneath showed up in the content list as a bare "PDF" or
   * "Scratchpad" — which makes the list useless for its one job, telling two
   * hidden books apart.
   *
   * Fire-and-forget: it is a handful of metadata reads, the list is already
   * usable without them, and a failure to name something is not a reason to
   * fail whatever operation asked.
   */
  async _resolveNames() {
    this._names ||= {};
    const wanted = [];
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      for (const entry of deckFor(this.state, slot)?.entries || []) {
        if (!this._names[entry.resourceId]) wanted.push(entry);
      }
    }
    if (!wanted.length) return;
    for (const entry of wanted) {
      try {
        const record = entry.kind === ENTRY_KINDS.SCRATCH
          ? await this._pdfLibrary.getScratchpad(entry.resourceId)
          : entry.kind === ENTRY_KINDS.NOTE
            ? await this._pdfLibrary.getNotebook(entry.resourceId)
            : await this._pdfLibrary.getDocumentMeta(entry.resourceId);
        this._rememberName(entry.resourceId, record?.name);
      } catch (_) { /* an unnamed entry still lists, by type */ }
    }
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this.strips[slot]?.render();
  }

  /** Puts the right pane on screen for the kind of entry the slot is showing. */
  _showPaneFor(slot, kind) {
    const el = this.elSlots?.[slot];
    if (!el) return;
    const scratch = kind === ENTRY_KINDS.SCRATCH;
    const bookHost = el.querySelector('[data-role="pane"]');
    if (bookHost) bookHost.hidden = scratch;
    const padHost = el.querySelector('[data-role="scratch-pane"]');
    if (padHost) padHost.hidden = !scratch;
    el.classList?.toggle('is-scratch', scratch);
    // A pad takes no part in matching, so an answer panel left over from the
    // book that was here has nothing to describe.
    if (scratch) this.hideAnswers(slot);
    this.scratchPanes[slot]?.resize?.();
    // The surface under the floating toolbar has just been replaced. Its tool,
    // colour and width have to be pushed to the new one, or the bar goes on
    // showing a pen while the pad it is now over has never been told.
    if (slot === this.activeSlot) this.toolbar?.syncToActiveSurface?.();
  }

  /**
   * A short status line under the strip, for waits and refusals.
   *
   * Its own line, NOT the name. Writing "Opening…" over the title meant the
   * pane stopped saying what it was showing at exactly the moment the reader
   * most needed to know — and a failure left the error there permanently, with
   * the name gone until the next successful switch.
   */
  _setStatus(slot, message) {
    const node = this.elSlots[slot]?.querySelector('[data-role="deck-preview"]');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
    node.classList.toggle('is-status', !!message);
  }

  /** One step along a slot's deck. */
  cycleSlot(slot, step) {
    const target = entryAtOffset(deckFor(this.state, slot), step);
    if (target) this.showEntry(slot, target.id);
  }

  /**
   * Detaches an entry from a pane. The resource stays in its library.
   *
   * Removing the last entry is confirmed, because an empty pane looks like
   * something went wrong even when it is exactly what was asked for.
   */
  async removeEntry(slot, entryId) {
    const deck = deckFor(this.state, slot);
    const entry = findEntry(deck, entryId);
    if (!entry) return;

    // 移出本栏就只是移出本栏——草稿纸和书在这里一视同仁。
    //
    // 这里一度会问「保存还是删除」，选删除就把纸和笔迹一起抹掉。那把一次误触
    // 和一份没有第二个副本的笔迹之间的距离缩短到了一个按钮，而删除本来就已经
    // 有地方了：文档库里的「永久删除」，那里有它该有的确认框，也有让人先看清
    // 自己要删哪一张的上下文。关闭是关闭，删除是删除。
    if (deckLength(deck) === 1) {
      const ok = await confirmDestructive({
        title: t('deck.removeLastTitle'),
        body: t('deck.removeLastBody'),
        confirmLabel: t('deck.removeFromPane'),
      });
      if (!ok) return;
    }

    const showing = deck.activeId === entryId;
    if (showing) {
      const view = this.viewFor(slot);
      // Save before detaching. The entry is about to lose the pane that holds
      // its only unwritten strokes.
      if (view?.flush) {
        const saved = await view.flush();
        if (!saved) { this._setStatus(slot, t('scratch.failed')); return; }
      } else if (view?.isLoaded?.()) {
        this._rememberSlotView(slot);
      }
    }

    const next = showing ? entryAtOffset(deck, 1) : null;
    this._setState(removeFromSlot(this.state, slot, entryId));


    if (showing) {
      const survivor = next && next.id !== entryId ? next : activeEntryIn(this.state, slot);
      if (survivor) {
        await this.showEntry(slot, survivor.id, { force: true });
      } else {
        this._unloadSlot(slot);
      }
    }
    this._layout();
    this._resizePanes();
    this._persist();
    this._syncSlotChrome(slot);
  }

  /** Empties a slot's panes without touching its deck. */
  _unloadSlot(slot) {
    this._openTokens[slot] = (this._openTokens[slot] || 0) + 1;
    this._paneInFlux[slot] = false;
    this.panes[slot].unload();
    this.scratchPanes[slot]?.unload();
    this.pads[slot] = null;
    // Nothing is on screen here any more, so there is nothing for a later
    // failure to restore.
    if (this._shown) this._shown[slot] = null;
    this._invalidatePairCaches();
    this._resetOutline(slot);
    this._showPaneFor(slot, ENTRY_KINDS.PDF);
  }

  // ── creating and opening (F01, F02) ───────────────────────────────────────

  /**
   * How each slot is described in a destination chooser.
   *
   * Where it IS and what is in it. Position is not role: the panes can be
   * swapped, and "the answer side" would name something that has moved.
   *
   * 而且是按屏幕上的先后给的，不是按内部名字。
   *
   * 原来这份单子永远是 [PRIMARY, SECONDARY]，只有标签跟着 swapped 走。于是两栏
   * 交换过之后，对话框里第一个按钮写着「右栏」、第二个写着「左栏」——左右两个
   * 字说的是真话，摆的位置却是反的。这种矛盾里人信的是位置：他要开到右边，手
   * 就往右边那个按钮去了。
   *
   * 所以顺序也跟着 swapped 走。竖排时同理：上在前，下在后。
   */
  destinationOptions() {
    const column = this.state.orientation === ORIENTATIONS.COLUMN;
    const first = this.state.swapped ? SLOTS.SECONDARY : SLOTS.PRIMARY;
    return [first, otherSlot(first)].map((slot) => {
      const isFirst = slot === first;
      const position = column
        ? (isFirst ? t('deck.top') : t('deck.bottom'))
        : (isFirst ? t('deck.left') : t('deck.right'));
      const entry = activeEntryIn(this.state, slot);
      return {
        slot,
        position,
        current: entry ? (this.describeEntry(slot, entry).name || '') : '',
      };
    });
  }

  /**
   * Creates a scratchpad and opens it, keeping what was there underneath.
   *
   * The pad is created only AFTER the dialog is confirmed. Cancelling leaves no
   * resource behind — an empty pad nobody asked for is worse than none, and it
   * is what happens when creation runs first and the dialog only decides where
   * to put it.
   */
  /**
   * 新建一张纸 —— 草稿纸或者笔记本，同一个对话框的两个模式。
   *
   * @param {string} mode PAPER_MODES 之一，作为对话框打开时的初始模式；人可以在
   *   对话框里改主意，最后算数的是他选的那个。
   */
  async createPaper(mode = PAPER_MODES.SCRATCH) {
    const answer = await createPaperDialog({
      mode,
      options: this.destinationOptions(),
      preferred: this.activeSlot,
      // The proposed name is in the reader's language, not the code's: a
      // Chinese interface offering "Scratchpad 01" is the app talking to
      // itself. The numbering still comes from what is already in the library,
      // so deleting a pad frees its number again.
      defaultName: await nextScratchpadName(t('deck.scratch')),
      defaultNoteName: await nextNotebookName(t('deck.note')),
      // Starts from the new-pad preference, so someone who set one gets it
      // without having to choose again — and can still change their mind here.
      defaultStyle: readNewPadStyle(),
      defaultPageCount: NOTE_PAGE_DEFAULT,
      pageMax: NOTE_PAGE_MAX,
    });
    if (!answer) return null;

    const note = answer.mode === PAPER_MODES.NOTE;
    const resource = note
      ? await createNotebook({
        name: answer.name, style: answer.style, pageCount: answer.pageCount,
      })
      : await createScratchpad({ name: answer.name, style: answer.style });
    this._rememberName(resource.id, resource.name);
    const { state, entry } = openInSlot(this.state, answer.slot, {
      kind: note ? ENTRY_KINDS.NOTE : ENTRY_KINDS.SCRATCH,
      resourceId: resource.id,
    });
    this._setState(state);
    await this.showEntry(answer.slot, entry.id, { force: true });
    this._markActive(answer.slot);
    return resource;
  }

  /** 老名字，还有调用方按这个名字叫。 */
  createScratchpad() { return this.createPaper(PAPER_MODES.SCRATCH); }

  /** 给这本笔记本在末尾加一页，然后翻过去。 */
  async addNotePage(slot) {
    const entry = activeEntryIn(this.state, slot);
    if (entry?.kind !== ENTRY_KINDS.NOTE) return null;
    const pane = this.panes[slot];
    if (!pane?.isLoaded()) return null;
    const updated = await addNotePages(entry.resourceId, 1);
    // 页数变了就是文档变了。重开一份而不是就地改 pane.state.pageCount：后者会让
    // 文档对象的 numPages 和面板以为的页数对不上，而越界检查信的是前者。
    // 整份 state 原样带过去。自己拼一个 {pageNumber, zoom} 会漏掉 fitMode 和
    // 平移量，而 zoom 这个字段不是屏幕上那个百分比 —— 真机上试出来的结果是
    // 加完一页缩放从 100% 跳到 316%。
    const reopened = await this._preparePdf(slot, entry, {
      ...pane.state, pageNumber: updated.pageCount,
    });
    if (reopened) { this._layout(); this._resizePanes(); this._syncSlotChrome(slot); }
    return updated;
  }

  /**
   * Opens a library resource into a chosen pane.
   *
   * The destination is asked for rather than inferred: the role says what a
   * document IS, not where it belongs, and the two panes can be swapped at any
   * time. Reopening something already in that deck recalls it.
   */
  async openResource(documentId, { kind = ENTRY_KINDS.PDF, slot } = {}) {
    let target = slot;
    if (!target) {
      target = await this.chooseSlotFor(documentId);
      if (!target) return null;
    }
    const before = this.state;
    const { state, entry } = openInSlot(this.state, target, { kind, resourceId: documentId });
    this._setState(state);
    const ok = await this.showEntry(target, entry.id, { force: true });
    if (!ok) {
      // An entry for something that would not open is an entry the reader will
      // meet again on every cycle and on the next launch. The deck goes back
      // exactly as it was — unless it was already holding this resource, in
      // which case the entry is theirs and only the recall failed.
      if (!findByResource(before.decks?.[target], documentId)) {
        this._setState(before);
        this._layout();
      }
      return null;
    }
    this._markActive(target);
    return entry;
  }

  /**
   * 这个对话框该长什么样——不含文案，也不碰 DOM，所以钉得住。
   *
   * 已经开在某一栏里，也照问。
   *
   * 原来是直接把人带回它已经在的那一栏，理由写的是「再问就成了一栏里放两份，而
   * 一栏放不下」。那条理由只对**同一栏**成立：一栏里两项同一份文件会抢同一个阅
   * 读位置（见 openInSlot）。两栏各有各的 entry、各有各的页码和缩放，互不相干
   * ——而且那正是这本书最该被这么用的时候：478 页的习题册，题在前面答案在后面，
   * 同一本对照着看。挡住它，人只能来回翻。
   *
   * 选它已经在的那一栏，openInSlot 仍然是「recall」而不是开第二份，所以这个对话
   * 框把两件事都给了，一下一个。
   *
   * @returns {{options: Array, preferred: string, openIn: string|null}}
   */
  _destinationSpec(resourceId) {
    const options = this.destinationOptions();
    const here = slotsWithResource(this.state, resourceId);
    // 两栏都已经有了，就没有「它在哪一栏」这回事了，照常问。
    const openIn = here.length === 1 ? here[0] : null;
    return {
      options,
      // 已经看得见它在那一栏了，还来点一次，多半是想两边对照。想回到它那儿的，
      // 选那一栏也只是一下。
      preferred: openIn ? otherSlot(openIn) : this.nextFreeSlot(),
      openIn,
    };
  }

  /** Asks which pane, defaulting to the one the reader is working in. */
  chooseSlotFor(resourceId) {
    const { options, preferred, openIn } = this._destinationSpec(resourceId);
    const where = openIn ? options.find(o => o.slot === openIn)?.position : null;
    return chooseDestination({
      options,
      preferred,
      title: t('deck.destination'),
      note: openIn ? t('deck.alreadyOpen', { position: where }) : t('deck.keptUnderneath'),
      confirm: t('deck.openThere'),
    });
  }

  // ── moving entries between panes (F09) ────────────────────────────────────

  /**
   * Moves one entry, atomically, by the click path.
   *
   * The insertion point is a stable entry id, never a row number: rows shift
   * under every insert and removal, and an index captured when the dialog
   * opened would land the entry somewhere the user did not point at.
   */
  async organize(slot, entryId) {
    // No entry named: this is "Organize content", which is the whole picture —
    // both decks side by side, with handles to drag and a Move on every row.
    // Naming one is "Move to…", which is the same commit reached through a
    // dialog. Neither path can produce a result the other cannot.
    if (!entryId) {
      await openOrganizer({
        getDecks: () => this.state.decks,
        describe: (side, entry) => this.describeEntry(side, entry),
        positions: this.destinationOptions(),
        onMove: (request) => this._applyMove(request),
      });
      return;
    }

    const deck = deckFor(this.state, slot);
    const entry = findEntry(deck, entryId);
    if (!entry) return;

    const answer = await moveEntryDialog({
      entry,
      entryName: this.describeEntry(slot, entry).name,
      options: this.destinationOptions(),
      preferred: otherSlot(slot),
      anchorsFor: (target) => deckFor(this.state, target).entries
        .filter(e => e.id !== entry.id)
        .map(e => ({ id: e.id, name: this.describeEntry(target, e).name })),
    });
    if (!answer) return;
    await this._applyMove({
      from: slot,
      to: answer.to,
      entryId: entry.id,
      afterId: answer.afterId,
      andShow: answer.andShow,
    });
  }

  /**
   * Commits one move, and brings both panes into line with the result.
   *
   * The single place the drag path and the click path meet, which is what makes
   * "click and drag produce identical results" true by construction rather than
   * by two implementations agreeing.
   *
   * Either both decks change or neither does — the pure move decides them
   * together — and only after that do the panes follow whatever each deck is
   * now showing.
   *
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async _applyMove({ from, to, entryId, afterId = null, andShow = false }) {
    const result = moveEntryBetweenSlots(this.state, { from, to, entryId, afterId, andShow });

    if (!result.ok) {
      // A duplicate is refused, never merged and never duplicated. The entry
      // that is already there is offered instead, so the reader can get to it.
      const locate = await explainRefusal({
        title: t('deck.duplicateTitle'),
        body: t('deck.duplicateBody'),
        actionLabel: result.entry ? t('deck.locateExisting') : '',
      });
      if (locate && result.entry) await this.showEntry(to, result.entry.id);
      return result;
    }

    // Both decks changed together; the panes follow whatever each is now
    // showing, and a pane that stopped showing anything is emptied.
    const before = {
      [from]: activeEntryIn(this.state, from)?.id,
      [to]: activeEntryIn(this.state, to)?.id,
    };
    this._setState(result.state);
    for (const side of new Set([from, to])) {
      const now = activeEntryIn(this.state, side);
      if (!now) { this._unloadSlot(side); continue; }
      if (now.id !== before[side]) await this.showEntry(side, now.id, { force: true });
    }
    // Moving the focused pad out of its pane takes focus with it: focus names a
    // slot AND an entry, and the pair has stopped being true.
    if (this.focusSlot && activeEntryIn(this.state, this.focusSlot)?.id !== this.focusEntryId) {
      this.exitFocus();
    }
    this._layout();
    this._resizePanes();
    this._persist();
    for (const side of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this._syncSlotChrome(side);
    return { ok: true };
  }

  // ── collapse and restore (F08) ────────────────────────────────────────────

  /**
   * Hides a pane without touching its deck.
   *
   * `restoreTo` is the split from BEFORE the drag. By the time the divider
   * reaches an edge the ratio is 0 or 1 — the position that means collapse —
   * and remembering that one would collapse the pane again the moment it came
   * back.
   *
   * An empty slot has nothing to collapse and no deck to protect, so it is
   * closed outright, which is what dragging an empty pane away has always
   * meant.
   */
  collapsePane(slot, restoreTo) {
    if (!deckLength(deckFor(this.state, slot))) {
      this._setState(setDividerRatio(this.state, 0.5));
      this.closeSlot(slot);
      return;
    }
    const ratio = Number.isFinite(restoreTo) ? restoreTo : this.state.dividerRatio;
    this._setState(collapseSlot(setDividerRatio(this.state, ratio), slot));
    this._layout();
    this._resizePanes();
    this._persist();
  }

  restorePane() {
    if (!this.state.collapsedSlot) return;
    this._setState(restoreCollapsed(this.state));
    this._resizePanes();
    this._persist();
  }

  // ── focus mode (F10) ──────────────────────────────────────────────────────

  /**
   * One pad, the whole workspace.
   *
   * The layout on the way in is captured so Return can restore it — but ONLY
   * the layout. Which entry each deck is showing, its order and its ink are
   * owned by the workspace state throughout, so leaving focus can never roll
   * back a switch, a move or a stroke made while focused.
   */
  enterFocus(slot) {
    const entry = activeEntryIn(this.state, slot);
    if (entry?.kind !== ENTRY_KINDS.SCRATCH) return;
    this.focusSlot = slot;
    this.focusEntryId = entry.id;
    this._focusLayout = {
      dividerRatio: this.state.dividerRatio,
      swapped: this.state.swapped,
      collapsedSlot: this.state.collapsedSlot,
      focusedSlot: this.state.focusedSlot,
    };
    document.body.classList.add('is-scratch-focus');
    // A collapse is released on the way in and put back on the way out. Focus
    // and collapse are two different ways of saying "one pane", and holding
    // both leaves a state the restore control cannot express — it would offer
    // to bring back a pane that focus is already hiding.
    this._setState(toggleFocus(clearFocus(restoreCollapsed(this.state)), slot));
    this._syncFocusBar();
    this._resizePanes();
  }

  exitFocus() {
    if (!this.focusSlot) return;
    const slot = this.focusSlot;
    this.focusSlot = null;
    this.focusEntryId = null;
    document.body.classList.remove('is-scratch-focus');
    // The captured ratio and placement come back. The DECKS do not: whatever
    // was switched, moved or removed while focused stands.
    const layout = this._focusLayout || {};
    this._focusLayout = null;
    let next = clearFocus(this.state);
    if (layout.dividerRatio !== undefined) next = setDividerRatio(next, layout.dividerRatio);
    if (layout.focusedSlot) next = toggleFocus(next, layout.focusedSlot);
    // The pane that was collapsed before focusing is collapsed again — but only
    // if it still has something in it. A deck emptied while focused is not
    // collapsed, it is empty, and a restore control over nothing is worse than
    // none.
    if (layout.collapsedSlot && deckLength(deckFor(next, layout.collapsedSlot))) {
      next = collapseSlot(next, layout.collapsedSlot);
    }
    // `swapped` is deliberately NOT restored. A swap requested while focused
    // exits focus and then swaps once; putting the captured value back here
    // would undo the very thing the reader just asked for.
    this._setState(next);
    this._syncFocusBar();
    this._resizePanes();
    this._syncSlotChrome(slot);
    this._persist();
  }

  /** Shows the way out on the pad that is focused, and nowhere else. */
  _syncFocusBar() {
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const exit = this.elSlots?.[slot]?.querySelector('[data-role="focus-exit"]');
      if (!exit) continue;
      exit.hidden = this.focusSlot !== slot;
      exit.textContent = t('scratch.exitFocus');
    }
  }

  // ── scratchpad style (F11) ────────────────────────────────────────────────

  async openStylePanel(slot) {
    const pad = this.pads[slot];
    const pane = this.scratchPanes[slot];
    if (!pad || !pane) return;
    // A stroke or a drag still in flight is finished before the panel takes the
    // input away from the canvas.
    await pane.flush();
    const result = await openScratchStylePanel({
      pad,
      compact: this.root.clientWidth < 620,
      onPreview: (style) => pane.previewStyle(style),
      onApplied: (saved) => {
        this.pads[slot] = saved;
        pane.applyPad(saved);
        this._syncSlotChrome(slot);
      },
      onNotice: (message) => this._setStatus(slot, message),
    });
    if (!result.applied) pane.previewStyle(pad.style);
  }

  /**
   * 笔记本的纸张样式。
   *
   * 和草稿纸共用同一个面板，只换了写入口。差别在应用之后：草稿纸是一张纸，
   * 换了背景重画一次就行；笔记本是一叠页，每一页都已经被 PdfPane 栅格化并缓
   * 存过了，所以要整份重新打开 —— 否则屏幕上还是旧纸，而缓存不知道自己过期
   * 了。也因此这里没有实时预览：面板上那些格子的缩略图就是预览。
   */
  async openNoteStylePanel(slot) {
    const entry = activeEntryIn(this.state, slot);
    if (entry?.kind !== ENTRY_KINDS.NOTE) return;
    const notebook = await this._pdfLibrary.getNotebook(entry.resourceId);
    if (!notebook) return;
    const pane = this.panes[slot];
    // 同 addNotePage：整份 state，不要自己拼。
    const at = pane?.isLoaded() ? { ...pane.state } : undefined;
    const result = await openScratchStylePanel({
      pad: notebook,
      compact: this.root.clientWidth < 620,
      save: setNotebookStyle,
      onNotice: (message) => this._setStatus(slot, message),
    });
    if (!result.applied) return;
    const reopened = await this._preparePdf(slot, entry, at);
    if (reopened) { this._layout(); this._resizePanes(); this._syncSlotChrome(slot); }
  }

  /** Permanent deletion, which is only ever reached deliberately. */
  async deletePad(slot) {
    const entry = activeEntryIn(this.state, slot);
    const pad = this.pads[slot];
    if (entry?.kind !== ENTRY_KINDS.SCRATCH || !pad) return;
    const ok = await confirmDestructive({
      title: t('scratch.deleteTitle'),
      body: t('scratch.deleteBody', { name: pad.name }),
      confirmLabel: t('scratch.delete'),
    });
    if (!ok) return;
    if (this.focusSlot === slot) this.exitFocus();
    await this.forgetResource(pad.id);
    await deleteScratchpad(pad.id);
  }

  /**
   * Takes a deleted resource out of both decks.
   *
   * Every entry pointing at it goes, and any pane that was showing one falls to
   * whatever was underneath — never to an empty pane while other entries are
   * still in the deck.
   */
  async forgetResource(resourceId) {
    // The marks describe pages of a document that is about to stop existing.
    forgetBookmarks(resourceId);
    if (this._marks) delete this._marks[resourceId];
    // An association naming a book that no longer exists would send the next
    // lookup after bytes that are not there.
    forgetPairsFor(resourceId);
    this._releaseAnswerHandles();
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const entry = findByResource(deckFor(this.state, slot), resourceId);
      if (!entry) continue;
      const showing = activeEntryIn(this.state, slot)?.id === entry.id;
      const successor = showing ? entryAtOffset(deckFor(this.state, slot), 1) : null;
      this._setState(removeFromSlot(this.state, slot, entry.id));
      if (!showing) continue;
      const survivor = successor && successor.id !== entry.id
        ? successor : activeEntryIn(this.state, slot);
      if (survivor) await this.showEntry(slot, survivor.id, { force: true });
      else this._unloadSlot(slot);
    }
    this._layout();
    this._resizePanes();
    this._persist();
  }

  // ── answer lookup ─────────────────────────────────────────────────────────

  /**
   * Shows the answers for every question on the current exercise page.
   *
   * Independent of grading on purpose: seeing the answer is useful by itself,
   * and making it wait for a verdict would gate a simple lookup behind the
   * part of the system that can least often reach a conclusion.
   *
   * Both indexes are built once per document and cached on the pane.
   */
  async showAnswersForPage(slot) {
    const pane = this.panes[slot];
    const panel = this.elSlots[slot].querySelector('[data-role="answer-panel"]');
    if (!pane?.isLoaded() || !panel) return;

    panel.hidden = false;
    panel.dataset.forPage = String(pane.state.pageNumber);
    renderAnswerLoading(panel, { page: pane.state.pageNumber });

    // Every notice below is dismissible, through the same path the matched
    // answers use. A panel that says why it could not help is the one the
    // reader most wants out of the way, and it used to be the only one with
    // no way to close it.
    const notice = (message, hint) => renderAnswerNotice(panel, message, {
      hint,
      onDismiss: () => this.hideAnswers(slot),
    });

    // The answer book is found by ASSOCIATION, not by "whatever is open on the
    // other side". It may be hidden underneath a scratchpad, sitting in the
    // same pane as the exercise, or not open at all — and in none of those
    // cases does looking it up disturb what either pane is showing.
    let answer;
    try {
      answer = await this._resolveAnswerSource(slot);
    } catch (error) {
      Logger.error('PDF', 'answer source failed', error);
      notice('匹配答案失败: ' + (error?.message || ''));
      return;
    }
    if (!answer) {
      notice('请先为这本习题册指定配套的答案册');
      return;
    }
    const other = answer.holder;

    try {
      // 'han' tells the quality gate these are Chinese books. Absence of the
      // expected script is a far sharper signal than the noise rate, and it is
      // what caught the missing cmaps: a Chinese textbook extracting with no
      // Chinese in it means the READER is misconfigured, not that the book is.
      const opts = { expectScript: 'han' };
      if (!pane.questionIndex) pane.questionIndex = await indexQuestionDocument(pane.doc, opts);
      if (!other.answerIndex) other.answerIndex = await indexAnswerDocument(other.doc, opts);

      // A book can fail to index in several ways that need different messages
      // and have different remedies. OPAQUE is NOT one of them — the text is
      // unreadable but the bookmark ids are intact, which is enough to match.
      const blocked = describeUnusable(pane.questionIndex, '习题册')
        || describeUnusable(other.answerIndex, '答案册');
      if (blocked) {
        // Every branch of describeUnusable means one of the two books did not
        // index, and the first thing to check is always the same: whether the
        // right file went in, under the right role.
        notice(blocked, '请检查答案是否上传正确');
        return;
      }

      // Stage 1: align the two tables of contents, when both have one.
      if (!pane.outlineAlignment) {
        pane.outlineAlignment = alignOutlines(pane.doc.outline, other.doc.outline);
      }

      const page = pane.state.pageNumber;
      const questions = questionsOnPage(pane.questionIndex, page);
      if (questions.length === 0) {
        // Same advice as the whole-book case. From the reader's side the two
        // are one situation — "it did not find the questions" — and the first
        // thing to check is the same either way.
        notice(`第 ${page} 页没有识别到编号题目`, '请检查答案是否上传正确');
        return;
      }

      // Undecodable text garbles two books the same way only when they embed the
      // same font subset. Established once per pair; without it, unreadable text
      // is not used as evidence at all.
      if (pane.answerComparability === undefined) {
        pane.answerComparability = indexesComparable(pane.questionIndex, other.answerIndex);
      }

      // The pair gate, before any answer is offered.
      //
      // `matchPage` defaults `pairStatus` to UNKNOWN_PAIR and fails safe: a
      // caller that has not established the two books belong together is not
      // handed an automatic answer. That default is deliberate — matching an
      // exercise book against the WRONG year's answer key produced confident
      // wrong answers at scale, and no amount of per-question evidence catches
      // it, because every individual comparison looks fine.
      //
      // So the verdict is computed once per pair from the two indexes we
      // already hold, and passed in. A rejected pair never reaches matching.
      if (!pane.pairVerdict) {
        pane.pairVerdict = verifyPair({
          exerciseDoc: pane.doc,
          answerDoc: other.doc,
          exerciseIndex: pane.questionIndex,
          answerIndex: other.answerIndex,
        });
      }
      if (pane.pairVerdict.status === PAIR_STATUS.REJECTED_PAIR) {
        notice(`这两本书看起来不是一对：${pane.pairVerdict.reasonCodes?.join('、') || '文档身份不匹配'}`);
        return;
      }

      // Stage 2: content + number matching, narrowed by the aligned section.
      const matches = matchPage(questions, other.answerIndex, {
        alignment: pane.outlineAlignment,
        exercisePage: page,
        answerPageCount: other.state?.pageCount,
        questionCount: pane.questionIndex.entries.length,
        crossBookComparable: pane.answerComparability?.comparable === true,
        pairStatus: pane.pairVerdict.status,
      });
      renderAnswerMatches(panel, matches, {
        page,
        onDismiss: () => this.hideAnswers(slot),
        aligned: pane.outlineAlignment?.available,
        // Suppresses display of text the reader could not read anyway.
        textQuality: other.answerIndex.quality,
        onReveal: (m) => {
          // View original: recall the answer entry in the pane that OWNS it and
          // go to the matched page. The scratchpad or book it was hidden
          // underneath stays in that deck — recalling something is not closing
          // what it was behind.
          this.viewOriginal(slot, answer.resourceId, m.entry?.page);
          // And then get out of the way: the panel existed to answer "which
          // page", and it has. Leaving it up covers the page it just sent the
          // reader to, which is the one thing they now want to look at.
          this.hideAnswers(slot);
        },
      });
    } catch (error) {
      Logger.error('PDF', 'answer lookup failed', error);
      notice('匹配答案失败: ' + (error?.message || ''));
    }
  }

  /**
   * Finds the answer book for the exercise book in `slot`, wherever it is.
   *
   * Four cases, in the order the specification sets out:
   *
   *   - it is on screen in the other pane: use that pane, and nothing moves;
   *   - it is in a deck but hidden: open a BACKGROUND handle and index that,
   *     so the lookup runs without replacing whatever is in the foreground;
   *   - it is in both decks: prefer the entry opposite the exercise;
   *   - it is in neither: index it in the background too. Opening it into a
   *     pane is what View original is for, and it is the reader's decision.
   *
   * Index access being separate from foreground rendering is the whole reason
   * a hidden answer key still works.
   *
   * @returns {Promise<{resourceId: string, holder: Object}|null>}
   */
  async _resolveAnswerSource(slot) {
    const exerciseId = activeEntryIn(this.state, slot)?.resourceId;
    if (!exerciseId) return null;

    // The remembered pairing first. Failing that, the only answer-role book in
    // either deck — which is an inference, so it is recorded as the pairing the
    // moment it is used, and never guessed at again.
    let answerId = answerFor(exerciseId);
    if (!answerId) {
      answerId = await this._soleAnswerInDecks(slot);
      if (answerId) rememberPair(exerciseId, answerId);
    }
    if (!answerId) return null;

    // On screen in the other pane: use the live one. It already has its index,
    // its outline and its page, and opening a second handle for the same bytes
    // would be a second renderer for no gain.
    const opposite = otherSlot(slot);
    const shown = activeEntryIn(this.state, opposite);
    if (shown?.resourceId === answerId && this.panes[opposite].isLoaded()) {
      return { resourceId: answerId, holder: this.panes[opposite] };
    }

    return { resourceId: answerId, holder: await this._backgroundAnswer(answerId) };
  }

  /** The one answer-role book among both decks, if there is exactly one. */
  async _soleAnswerInDecks(slot) {
    const seen = new Set();
    for (const side of [otherSlot(slot), slot]) {
      for (const entry of deckFor(this.state, side).entries || []) {
        if (entry.kind !== ENTRY_KINDS.PDF) continue;
        seen.add(entry.resourceId);
      }
    }
    const answers = [];
    for (const id of seen) {
      const meta = await this._pdfLibrary.getDocumentMeta(id);
      if (meta?.role === DOC_ROLES.ANSWER) answers.push(id);
    }
    return answers.length === 1 ? answers[0] : null;
  }

  /**
   * A handle on an answer book that is not being rendered.
   *
   * Cached by resource, because indexing a 372-page key is expensive and the
   * lookup is per page. It holds a document and an index and NO canvas: this is
   * not a third renderer, it is a reader.
   */
  async _backgroundAnswer(resourceId) {
    this._answerHandles ||= new Map();
    const cached = this._answerHandles.get(resourceId);
    if (cached) return cached;

    const doc = await this._pdfLibrary.openStoredDocument(resourceId);
    // Shaped like a pane as far as the matcher is concerned: it reads `doc`,
    // `answerIndex`, `state.pageCount` and nothing else.
    const handle = {
      doc,
      answerIndex: null,
      state: { pageCount: doc.numPages },
      isLoaded: () => true,
      goToPage: () => {},
    };
    // The outline is what the TOC alignment stage needs, and it is optional.
    try {
      if (typeof doc.getOutline === 'function') await doc.getOutline();
    } catch (_) { /* a book with no resolvable outline still matches by text */ }
    this._answerHandles.set(resourceId, handle);
    return handle;
  }

  /** Releases every background answer handle. */
  _releaseAnswerHandles() {
    if (!this._answerHandles) return;
    for (const handle of this._answerHandles.values()) {
      try { handle.doc.destroy(); } catch (_) { /* already gone */ }
    }
    this._answerHandles.clear();
  }

  /**
   * Takes the reader to the answer, in the pane that owns it.
   *
   * If the answer is in neither deck it is opened opposite the exercise,
   * preserving that pane's current entry — which rotates underneath rather than
   * being closed — and expanding the pane if it was collapsed.
   */
  async viewOriginal(fromSlot, resourceId, page) {
    const opposite = otherSlot(fromSlot);
    const holders = slotsWithResource(this.state, resourceId);
    // Opposite the exercise if it is there; otherwise wherever it actually is.
    const target = holders.includes(opposite) ? opposite : holders[0];

    if (this.state.collapsedSlot === (target || opposite)) this.restorePane();

    if (target) {
      const entry = findByResource(deckFor(this.state, target), resourceId);
      await this.showEntry(target, entry.id);
    } else {
      await this.openResource(resourceId, { slot: opposite });
    }

    const landed = holders.includes(opposite) ? opposite : (target || opposite);
    if (page) this.panes[landed]?.goToPage(page);
    this._syncSlotChrome(landed);
  }

  _activeAgentSlot() {
    if (this.panes[this.activeSlot]?.isLoaded()) return this.activeSlot;
    return [SLOTS.PRIMARY, SLOTS.SECONDARY]
      .find((slot) => this.panes[slot]?.isLoaded()) || null;
  }

  openAgentForActiveDocument() {
    const slot = this._activeAgentSlot();
    if (slot) this.showAgentForPage(slot);
  }

  _isAgentTargetCurrent(target) {
    return this.agentTarget === target
      && this.panes[target.slot]?.doc === target.doc;
  }

  async showAgentForPage(slot) {
    const pane = this.panes[slot];
    if (!pane?.isLoaded()) return;

    const target = {
      slot,
      doc: pane.doc,
      page: pane.state.pageNumber,
      documentName: pane.meta?.name || '当前文档',
    };
    this.agentTarget = target;
    this.agentPanel?.open({
      documentName: target.documentName,
      page: target.page,
    });
    this.agentPanel?.showLoading();

    try {
      const source = createTextSource(target.doc, {
        expectScript: 'han',
      });
      const result = await source.pageText(
        target.page,
        { needReadable: true },
      );

      if (!this._isAgentTargetCurrent(target)) return;
      if (!result.text || result.origin === TEXT_ORIGIN.NONE) {
        this.agentPanel?.showNotice(
          '当前页文字无法可靠提取，暂不调用 Agent。',
          { textOrigin: result.origin },
        );
        return;
      }

      const answer = await requestAgent({
        version: 1,
        page: target.page,
        questionText: result.text,
        textOrigin: result.origin,
      });

      if (!this._isAgentTargetCurrent(target)) return;
      this.agentPanel?.showResult({
        ...answer,
        textOrigin: result.origin,
      });
    } catch (error) {
      if (!this._isAgentTargetCurrent(target)) return;
      Logger.error('Agent', 'agent request failed', error);
      this.agentPanel?.showNotice('Agent 处理失败。');
    }
  }

  // ── grading ───────────────────────────────────────────────────────────────




  _persist() {
    // By ENTRY, not by slot. Only the two live panes have anything new to say;
    // every other entry's view is preserved by saveSession from what it is
    // already holding, so rotating content underneath does not cost it its
    // page.
    const views = {};
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      // 同上：记的是窗格里装着的那一份。换书途中落一次盘，本来会把旧书的页码
      // 写进新书的条目里。
      // 这一栏正在换内容就跳过它。另一栏照记——saveSession 会把没在这一轮
      // 里出现的条目从缓存里原样带过去，所以跳过就是「这一条这次没有新话说」。
      if (this._paneInFlux?.[slot]) continue;
      const entry = this._entryOnScreen(slot);
      // Only a paged thing — a book or a notebook — has a page, a zoom and a
      // scroll to record here. A pad's place is its camera, and that belongs to
      // the pad rather than to the session — it is filed against the resource by
      // the scratch pane itself, so it survives being opened in the other pane
      // just as well.
      if (!isPagedKind(entry?.kind)) continue;
      const view = this.panes[slot]?.state;
      if (view) views[entry.id] = view;
    }
    saveSession(this.state, views);
    // And against the documents themselves, so a book reopened from the library
    // comes back to the page it was left on rather than to page 1.
    this._scheduleRememberDocViews();
  }

  /**
   * Files both panes' places under the documents they are showing — later.
   *
   * Deliberately NOT on the same beat as saveSession(). That one stringifies a
   * handful of scalars into one key and is cheap enough to run on every
   * interaction, which is what it does: `_persist()` is called from
   * `onStateChange`, and that fires on every frame of a pan. This one reads,
   * parses, rewrites and stores a map of every book the reader has opened, once
   * per pane — three times the storage traffic of the thing it rides on, on the
   * main thread, under a stylus sampling at 120Hz. A reading position is worth
   * a great deal less than that, and it does not change meaningfully inside
   * half a second anyway.
   */
  _scheduleRememberDocViews() {
    clearTimeout(this._docViewTimer);
    this._docViewTimer = setTimeout(() => {
      this._docViewTimer = null;
      for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this._rememberSlotView(slot);
    }, DOC_VIEW_SETTLE);
  }

  /**
   * 这一栏正在显示的那一份，而不是 deck 说的那一份。
   *
   * 打开是先提交 deck、再换屏幕：在这两步之间，deck 已经改口说的是新的那一份，
   * 而窗格里装的还是旧的。谁在这段窗口里问 activeEntryIn，谁就会把旧书的页码
   * 记到新书名下——旧书的页码从此没人记得，新书的页码被覆盖成别人的。
   * 「换一本书再换回来，不在原来那一页」就是这么来的。
   *
   * _shown 记的是最后一次真正commit到屏幕上的那一份，那才是窗格的实情。
   */
  _entryOnScreen(slot) {
    return this._shown?.[slot] || activeEntryIn(this.state, slot);
  }

  /** Filled when this page is marked, hollow when it is not. */
  _syncBookmarkButton(slot) {
    const btn = this.elSlots?.[slot]?.querySelector('[data-role="bookmark"]');
    if (!btn) return;
    const entry = this._entryOnScreen(slot);
    const page = this.panes[slot]?.state?.pageNumber;
    // 本子也是一页一页的，所以书签在它身上和在书上一个意思。只有草稿纸没有页。
    const on = isPagedKind(entry?.kind) && page
      && hasBookmark(this._bookmarksIn(slot), page);
    // 形状不变，只是填不填。一个书签记没记，是它有没有被涂满，而不是它变成
    // 了另一样东西——空心和实心是同一条丝带的两种状态。
    const path = btn.querySelector('path');
    if (path) path.setAttribute('fill', on ? 'currentColor' : 'none');
    btn.classList.toggle('is-on', !!on);
    btn.setAttribute('aria-pressed', String(!!on));
  }

  /**
   * The marks belonging to whatever this column is showing.
   *
   * Read through a small cache rather than off disk each time: the thumbnail
   * grid asks once per cell, and an 827-page book would otherwise parse the
   * whole store 827 times to draw one screen.
   */
  _bookmarksIn(slot) {
    const entry = this._entryOnScreen(slot);
    if (!isPagedKind(entry?.kind)) return [];
    this._marks ||= {};
    if (this._marks[entry.resourceId] === undefined) {
      this._marks[entry.resourceId] = loadBookmarks(entry.resourceId);
    }
    return this._marks[entry.resourceId];
  }

  /**
   * Marks or unmarks a page — by default the one being read.
   *
   * The page count is passed so a mark can never name a page the book does not
   * have; see bookmark-state.
   */
  _toggleBookmark(slot, page) {
    const entry = this._entryOnScreen(slot);
    // 本子的页和书的页一样可以记书签。只有草稿纸没有页。
    if (!isPagedKind(entry?.kind)) return;
    const pane = this.panes[slot];
    const target = page || pane?.state?.pageNumber;
    if (!target) return;
    this._marks ||= {};
    const next = toggleBookmark(this._bookmarksIn(slot), target, {
      pageCount: pane?.doc?.numPages || 0,
    });
    this._marks[entry.resourceId] = next;
    saveBookmarks(entry.resourceId, next);
    this._syncSlotChrome(slot);
    this.panels?.[slot]?.refreshMarks();
  }

  /**
   * 让读者给自己插的这一页起个名字。
   *
   * 「第 137 页」记不住任何东西。人真正在找的是「洛必达那节」「作业三」「卡在
   * 这儿」——书签的用处全在这个名字上，页码只是它落在哪。
   *
   * 名字清掉就退回「第 N 页」，不是把书签删掉：改名的对话框里按空再确定，意思
   * 是「不要这个名字」，不是「不要这一页」。删除是旁边那个 ×。
   */
  async _nameBookmark(slot, mark) {
    const entry = this._entryOnScreen(slot);
    if (!isPagedKind(entry?.kind) || !mark) return;
    const label = await promptText({
      title: `第 ${mark.page} 页`,
      label: '书签名称',
      value: mark.label || '',
      max: LABEL_MAX,
      placeholder: '例如：洛必达法则',
      confirm: '保存',
    });
    // 取消给的是 null，清空给的是空串——对话框把这两件事分开正是为了这里：
    // 按取消什么都不动，清空则是「去掉这个名字」，退回「第 N 页」。
    if (label === null) return;
    this._marks ||= {};
    const next = renameBookmark(this._bookmarksIn(slot), mark.page, label || '');
    if (next === this._bookmarksIn(slot)) return;
    this._marks[entry.resourceId] = next;
    saveBookmarks(entry.resourceId, next);
    this.panels?.[slot]?.refreshMarks();
  }

  /**
   * 缩放变了就报一下，报完就走。
   *
   * 横杠上那个读数一直都在，但它是梯子最先收走的东西之一——两栏各 584px 时它
   * 正好不在，而那恰恰是人捏着两根手指、最想知道自己捏到哪儿的时候。所以另有
   * 一块牌子，浮在这一栏的页面中间，只在比例真的变了的那一刻露面。
   *
   * 只在「同一份东西的比例变了」时露面。翻页、落笔、撤销都会走到这里；换一本
   * 书更会——新书有自己的比例，而那不是一次缩放，是一次打开。所以要连同「现在
   * 显示的是哪一条」一起比，只认前后是同一条、而数变了的那一次。
   */
  _flashZoom(slot, percent, entryId) {
    this._lastZoom ||= {};
    const before = this._lastZoom[slot];
    this._lastZoom[slot] = percent == null ? null : { percent, entryId };
    if (percent == null || !before || before.entryId !== entryId) return;
    if (before.percent === percent) return;

    const badge = this.elSlots?.[slot]?.querySelector('[data-role="zoom-badge"]');
    if (!badge) return;
    badge.textContent = `${percent}%`;
    badge.classList.add('is-visible');
    this._zoomBadgeTimers ||= {};
    clearTimeout(this._zoomBadgeTimers[slot]);
    // 捏合时这里每一帧都会被叫到，所以是「最后一次变化之后再过 900ms」，而不是
    // 每次都重新演一遍淡入淡出。
    this._zoomBadgeTimers[slot] = setTimeout(() => {
      badge.classList.remove('is-visible');
    }, 900);
  }

  // ── 组合：一套「书是怎么摆的」 ─────────────────────────────────────────

  /**
   * 两栏此刻各自开着的那一本叫什么。左边在前，按屏幕上的左右，不是按槽位。
   *
   * 「会换掉现在开着的东西」这句话，人要看见换掉的是**哪两本**才能决定要不要
   * 换。所以名字得由工作区来给——只有它同时知道摞、窗格和左右有没有对调过。
   */
  facingNames() {
    const order = this.state.swapped
      ? [SLOTS.SECONDARY, SLOTS.PRIMARY]
      : [SLOTS.PRIMARY, SLOTS.SECONDARY];
    return order.map((slot) => {
      const entry = activeEntryIn(this.state, slot);
      if (!entry) return '';
      return this.describeEntry(slot, entry).name || '';
    });
  }

  /**
   * 把此刻的摆法拍成一个组合。
   *
   * 拍之前先把两栏停在哪一页记进「这本书最后读到哪儿」。不记的话，一个刚存完
   * 就拿来用的组合会把书开回它们上一次落盘时的页，而不是屏幕上这一页——而人刚
   * 刚看着屏幕按下了保存。
   *
   * 组合本身**不含页码**，理由见 combo-state.js 开头。
   */
  snapshotCombo({ id = '', name = '', now = Date.now() } = {}) {
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this._rememberSlotView(slot);
    return comboFromWorkspace(this.state, { id, name, now });
  }

  /**
   * 用一个组合替换现在开着的一切。
   *
   * 顺序是有讲究的：
   *
   * ① 先把两栏此刻停在哪一页记下来。**被盖掉的东西也要留下退出页**——不记的
   *    话，人用一个组合换过去、再换回来，那两本书会退回更早的某一页，而他什么
   *    都没做错。被盖掉的是另一个组合时同理：组合不存页码，页码存在书上，所以
   *    「记住被盖掉的组合」和「记住被盖掉的书」本来就是同一件事。
   * ② 把两栏卸空。草稿纸要 flush 再 unload —— 它的笔迹还没落盘。
   * ③ 按组合建**新条目**（新 id 现发），摞摆好，再开每一栏的活动项。开的时候
   *    不指定视图：showEntry 自己会去问 recallDocView，问到的正是 ① 刚写进去的
   *    那一页，以及这些书各自上次离开时留下的页码。
   *
   * 开不起来的那一本不删、不跳过整栏：和会话恢复一样，往下换这一摞里的下一本，
   * 摞本身一条不动。一次打不开不等于这本书没了。
   *
   * @returns {Promise<{opened: number, missing: number}>}
   */
  async applyCombo(combo) {
    if (!combo) return { opened: 0, missing: 0 };

    // ①
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this._rememberSlotView(slot);

    // ②
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      this._openTokens[slot] = (this._openTokens[slot] || 0) + 1;
      if (this.agentTarget?.slot === slot) this._closeAgentPanel();
      if (this.scratchPanes[slot]?.isLoaded?.()) {
        await this.scratchPanes[slot].flush();
        this.scratchPanes[slot].unload();
        this.pads[slot] = null;
      }
      this.panes[slot]?.unload();
      this._resetOutline(slot);
    }
    this._invalidatePairCaches();

    // ③
    const decks = {};
    const wanted = {};
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const plan = combo.slots?.[slot];
      const entries = (plan?.entries || []).map(
        (e) => createEntry({ kind: e.kind, resourceId: e.resourceId }),
      );
      const at = Number.isInteger(plan?.active) ? plan.active : 0;
      const activeId = entries[at]?.id ?? entries[0]?.id ?? null;
      decks[slot] = { entries, activeId };
      // 活动项排在前面，其余按摞的顺序——开不起来时就是这个次序往下试。
      wanted[slot] = activeId
        ? [entries[at] || entries[0], ...entries.filter((e) => e.id !== activeId)]
        : [];
    }

    this._setState(createWorkspaceState({
      decks,
      dividerRatio: combo.dividerRatio,
      orientation: orientationForViewport(this.root.clientWidth, this.root.clientHeight),
      swapped: combo.swapped,
    }));

    let opened = 0;
    let missing = 0;
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      let ok = false;
      for (const entry of wanted[slot]) {
        if (!entry) continue;
        try {
          ok = await this.showEntry(slot, entry.id, { force: true });
          if (ok) break;
        } catch (error) {
          Logger.warn('PDF', `组合里这一本打不开：${entry.resourceId}（${error.message}）`);
        }
      }
      if (ok) opened += 1;
      else if (wanted[slot].length) missing += 1;
    }

    this._resizePanes();
    this._layout();
    this._resolveNames();
    this._persist();
    return { opened, missing };
  }

  /** Files the pane's current place under the document it is showing, now. */
  _rememberSlotView(slot) {
    // 换内容的途中不记。这道门是给自动落盘的那两条路开的——翻页 500ms 之后的
    // 延迟记账，和 pdf.js 装载过程中自己发出的状态变化——它们不知道此刻窗格里
    // 装的是谁。换书那条路上那两次「记下走掉的这一份」都发生在装新书之前，
    // 牌子还没立起来，所以照走不误。
    if (this._paneInFlux?.[slot]) return;
    const entry = this._entryOnScreen(slot);
    // 本子和书一样是一页一页的，读到哪一页同样要记 —— 只认 PDF 的话，一本
    // 笔记本换走再换回来永远回到第 1 页。只有草稿纸没有页可记。
    if (!isPagedKind(entry?.kind)) return;
    const view = this.panes[slot]?.state;
    if (!view) return;
    // 两处都要记：这一条目自己的位置，和这份文件在任何地方最后被放下的位置。
    // 只记后者的话，同一栏里换走再换回来会拿到开机那一刻的页码——条目这一层
    // 的优先级更高，而它在两次存盘之间一直是旧的。
    rememberEntryView(entry.id, view);
    rememberDocView(entry.resourceId, view);
  }

  /** Restores the previous session; safe to call when there is none. */
  async init() {
    const { workspace, views, dropped, migrated } = await restoreSession();
    if (dropped.length) {
      Logger.warn('PDF', `Dropped ${dropped.length} session entr(ies) whose resource was deleted`);
    }
    // `info`, not `log`: the logger has no `log`. Calling one threw here on the
    // device, on the ONE launch that matters most — the migrating one — and
    // took the whole restore down with it before a single slot was opened.
    if (migrated) Logger.info('PDF', 'Migrated a version 1 session into decks');
    // The restored DECKS go in first, so the open below finds each slot's
    // entries already in place and recalls the active one rather than
    // inserting a second entry for the same resource.
    this._setState(setOrientation(
      workspace,
      orientationForViewport(this.root.clientWidth, this.root.clientHeight),
    ));

    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      // The entry is already in the deck, so this is a recall: `showEntry`
      // prepares the resource and commits, and the REST of the deck — every
      // entry rotated underneath — is left exactly as it was restored.
      //
      // If it will not open, fall to the NEXT entry rather than deleting
      // anything. This used to call `forgetResource`, which took every entry
      // naming that resource out of BOTH decks — so one bad launch, or one
      // file that happened to be slow, permanently emptied a pane of something
      // still sitting in the library. A resource that failed to open once is
      // not a resource that is gone, and the specification asks for an
      // unavailable ENTRY the reader can retry or remove, not a silently
      // wiped deck.
      const entries = [...(deckFor(this.state, slot).entries || [])];
      const active = activeEntryIn(this.state, slot);
      // The one it was showing first, then the rest in deck order.
      const order = active ? [active, ...entries.filter(e => e.id !== active.id)] : entries;
      for (const entry of order) {
        try {
          const ok = await this.showEntry(slot, entry.id, {
            restoredView: views[entry.id],
            force: true,
          });
          if (ok) break;
          Logger.warn('PDF', `Could not restore ${entry.resourceId} in slot ${slot}`);
        } catch (error) {
          Logger.warn('PDF', `Could not restore slot ${slot}: ${error.message}`);
        }
      }
    }
    // Focus is restored after both resources load, so it is not cleared by a
    // slot assignment happening later.
    this._setState(workspace.focusedSlot
      ? toggleFocus(clearFocus(this.state), workspace.focusedSlot)
      : this.state);
    // A collapsed pane whose deck did not survive the restore is not collapsed
    // any more — it is empty, and leaving the state saying otherwise would put
    // a restore control on screen with nothing behind it.
    if (this.state.collapsedSlot && !deckLength(deckFor(this.state, this.state.collapsedSlot))) {
      this._setState(restoreCollapsed(this.state));
    }
    this._layout();
    // Everything rotated underneath is named too, so the content list is usable
    // from the first moment rather than after each entry has been visited once.
    this._resolveNames();
  }

  destroy() {
    this._sizeObserver?.disconnect();
    this._sizeObserver = null;
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
    // Anything the debounce was still holding: a workspace being torn down is
    // the last moment either book's place can be written.
    clearTimeout(this._docViewTimer);
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this._rememberSlotView(slot);
    clearTimeout(this._animTimer);
    if (this._trackFrame) cancelAnimationFrame(this._trackFrame);
    this._trackFrame = 0;
    this._closeAgentPanel({ notify: false });
    this.agentPanel?.destroy();
    this.toolbar?.destroy();
    this._releaseAnswerHandles();
    // Focus is a body class, so a workspace torn down while focused would leave
    // the import row and the dock hidden with nothing to bring them back.
    document.body.classList.remove('is-scratch-focus');
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      this.strips[slot]?.destroy();
      this.panes[slot].unload();
      // Unload commits: a pad with unwritten strokes is written on the way out,
      // which is the last moment it can be.
      this.scratchPanes[slot]?.unload();
    }
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * The save state, in words.
 *
 * Only a committed write earns "Saved". Saving is a state of its own and says
 * so, and a failure stays on screen as something to press rather than as a
 * colour that fades — an indicator that lies is worse than no indicator,
 * because it is the thing someone checks before closing the app.
 */
function saveLabel(state) {
  switch (state) {
    case SAVE_STATES.SAVED: return t('scratch.saved');
    case SAVE_STATES.SAVING: return t('scratch.savingState');
    case SAVE_STATES.FAILED: return t('scratch.failed');
    case SAVE_STATES.UNSAVED: return t('scratch.unsaved');
    default: return '';
  }
}

function slotChrome(slot) {
  return `
    <div class="pdf-slot-toolbar" data-role="toolbar" hidden>
      <!-- 专注模式的出口。它原来在一条自己的横杠里，而那条横杠是工作区这个
           row flex 的直接子元素——于是它没有横在上面，而是竖在旁边，占掉了整
           整 296px 的宽度：草稿纸被挤到右边，左边四分之一是空的。
           那条横杠上的另外两样东西本来就是重复的：名字和保存状态就在它右边
           这条工具栏里，「本栏内容」就是下面切换条的标题按钮。所以只留出口，
           放在它该在的地方。 -->
      <button type="button" class="pdf-slot-btn is-accent" data-role="focus-exit" hidden></button>
      <span class="pdf-slot-title" data-role="title"></span>
      <span class="pdf-slot-group is-pdf-only" data-role="pdf-controls">
        <button type="button" class="pdf-slot-btn" data-role="outline" title="目录">☰</button>
        <button type="button" class="pdf-slot-btn" data-role="prev" title="上一页">‹</button>
        <input type="number" class="pdf-slot-page" data-role="page-input" min="1" step="1" value="1" aria-label="页码">
        <span class="pdf-slot-total" data-role="page-total"></span>
        <button type="button" class="pdf-slot-btn" data-role="next" title="下一页">›</button>
        <!-- 只有笔记本有。一本书的页数是它自己的事，加不了也不该能加；一本
             空本子写满了要续，而「续」的地方就该在翻到头的那个按钮旁边。 -->
        <button type="button" class="pdf-slot-btn" data-role="note-add-page" hidden>+页</button>
        <!-- 书签：这一页记不记，和翻页是同一件事的两面，所以挨着放。 -->
        <button type="button" class="pdf-slot-btn pdf-slot-mark" data-role="bookmark"
                aria-pressed="false" title="书签">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <path d="M6.5 3.5h11a1 1 0 0 1 1 1v15.2a.6.6 0 0 1-.93.5L12 16.4l-5.57 3.8a.6.6 0 0 1-.93-.5V4.5a1 1 0 0 1 1-1z"
                  fill="none" stroke="currentColor" stroke-width="1.7"
                  stroke-linejoin="round"/>
          </svg>
        </button>
      </span>
      <button type="button" class="pdf-slot-btn" data-role="zoom-out" title="缩小">−</button>
      <span class="pdf-slot-zoom" data-role="zoom-label"></span>
      <button type="button" class="pdf-slot-btn" data-role="zoom-in" title="放大">+</button>
      <span class="pdf-slot-group is-pdf-only">
        <button type="button" class="pdf-slot-btn" data-role="fit-width" title="适合宽度">↔</button>
        <button type="button" class="pdf-slot-btn" data-role="fit-page" title="整页">⤢</button>
      </span>
      <!-- A scratchpad has no outline, no page controls, no question label and
           no answer lookup, because it has no pages and takes no part in
           matching. What it has instead is a way back to the origin, a way to
           see everything at once, and its save state. -->
      <span class="pdf-slot-group is-scratch-only" data-role="scratch-controls" hidden>
        <button type="button" class="pdf-slot-btn" data-role="scratch-origin"></button>
        <button type="button" class="pdf-slot-btn" data-role="scratch-fit"></button>
        <button type="button" class="scratch-save" data-role="scratch-save"></button>
      </span>
      <span class="pdf-slot-sep"></span>
      <button type="button" class="pdf-slot-btn" data-role="ink-undo" title="撤销">↶</button>
      <button type="button" class="pdf-slot-btn" data-role="ink-redo" title="重做">↷</button>
      <button type="button" class="pdf-slot-btn is-answer-action" data-role="answers" title="对照本页答案">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
             stroke-linecap="round" stroke-linejoin="round" width="17" height="17" aria-hidden="true">
          <rect x="3" y="3" width="8" height="18" rx="1.6"/>
          <rect x="13" y="3" width="8" height="18" rx="1.6"/>
          <path d="M6 8h2M6 11h2"/>
          <path d="M16 12.6l1.5 1.6 3-3.4"/>
        </svg>
        <span class="pdf-slot-btn-text">对答案</span>
      </button>
      <span class="pdf-slot-sep is-tail"></span>
      <button type="button" class="pdf-slot-btn" data-role="focus" title="专注此文档">⛶</button>
      <button type="button" class="pdf-slot-btn" data-role="slot-more" title="更多"
              aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">⋯</button>
    </div>
    ${deckStripHtml()}
    <div class="pdf-slot-menu" data-role="slot-menu" role="menu" hidden>
      <!-- Focus and style are only offered for a pad; the workspace hides them
           when the slot is showing a book. -->
      <button type="button" class="pdf-slot-menu-item" role="menuitem" data-role="focus-scratch" hidden></button>
      <button type="button" class="pdf-slot-menu-item" role="menuitem" data-role="scratch-style" hidden></button>
      <button type="button" class="pdf-slot-menu-item" role="menuitem" data-role="organize"></button>
      <!-- Relabelled from 关闭文档. Removing an entry detaches it from this
           pane; the resource stays in its library, and the pane falls to
           whatever was underneath rather than emptying. -->
      <button type="button" class="pdf-slot-menu-item is-danger" role="menuitem" data-role="close"></button>
      <button type="button" class="pdf-slot-menu-item is-danger" role="menuitem" data-role="delete-pad" hidden></button>
    </div>
    <div class="pdf-outline-panel" data-role="outline-panel" hidden></div>
    <div class="pdf-answer-panel" data-role="answer-panel" hidden></div>
    <div class="pdf-slot-pane" data-role="pane" data-slot="${slot}"></div>
    <div class="pdf-slot-pane scratch-slot-pane" data-role="scratch-pane" data-slot="${slot}" hidden></div>
    <!-- 缩放时报一下当前比例，报完就走。
         横杠上本来有个小小的读数，可它是梯子上最先被收走的东西之一：两栏各
         584px 的时候它正好不在。而人捏合的时候恰恰最需要知道自己捏到了哪儿。
         摆在最后，于是它盖在页面上而不是被页面盖住。 -->
    <div class="pdf-zoom-badge" data-role="zoom-badge" aria-hidden="true"></div>
  `;
}
