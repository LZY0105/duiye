// PDF Module — dual-document workspace.
//
// Owns two PdfPane instances, the divider between them, and the workspace
// layout state. Each pane keeps its own document and view state, so page,
// zoom and scroll on one side never reach the other; this file only decides
// how much room each pane gets and which document is loaded into it.

import { PdfPane } from './pdf-pane.js';
import { FIT_MODES } from './pdf-view-state.js';
import {
  ORIENTATIONS,
  SLOTS,
  assignDocument,
  clearFocus,
  closeSlot,
  createWorkspaceState,
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
import { restoreSession, saveSession } from './document-session.js';
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
import { InkToolbar } from '../ink/ink-toolbar.js';
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
    };
    this.state = createWorkspaceState();
    this.panes = {};
    this.restoredViews = {};
    /** Which pane the shared toolbar currently applies to (spec §11.2). */
    this.activeSlot = SLOTS.PRIMARY;
    // Per slot, the width the slot toolbar wanted at each rung of HEADER_LADDER,
    // so _syncPaneHeaderFit knows how much room it takes to put a rung back.
    this._headerWanted = {};
    /** Per-pane "has annotations that are not written yet". */
    this._inkDirty = { [SLOTS.PRIMARY]: false, [SLOTS.SECONDARY]: false };
    /** Per-slot open tokens; a superseded open must not overwrite a newer one. */
    this._openTokens = { [SLOTS.PRIMARY]: 0, [SLOTS.SECONDARY]: 0 };
    /** Resolved bookmark data; DOM nodes are built only when the panel opens. */
    this._outlines = { [SLOTS.PRIMARY]: null, [SLOTS.SECONDARY]: null };
    this._buildDom();
    this._bindDivider();
    this._bindSwap();
    this._bindOrientation();

    // One shared floating toolbar, applied to the explicitly active Ink
    // surface. It is mounted on the workspace root, so it floats over both
    // panes without belonging to either one's layout.
    this.toolbar = new InkToolbar(this.root, {
      getSurface: () => this.panes[this.activeSlot]?.ink || null,
      // Moving or docking the bar can carry it over the other column, and the
      // column it lands on is what it now has to fit inside.
      onChange: () => this._syncToolbarSize(paneFractions(this.state)),
      onClearInk: () => {
        // Scoped to the active pane's ink only — never the PDF (§6.2).
        this.panes[this.activeSlot]?.ink.clear();
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
    `;

    this.elDivider = this.root.querySelector('[data-role="divider"]');
    this.elSwap = this.root.querySelector('[data-role="swap"]');
    this.elGrip = this.root.querySelector('[data-role="grip"]');
    this.elRatioBadge = this.root.querySelector('[data-role="ratio-badge"]');
    this.elEmpty = this.root.querySelector('[data-role="empty-state"]');
    this.elSlots = {
      [SLOTS.PRIMARY]: this.root.querySelector('.pdf-ws-slot[data-slot="a"]'),
      [SLOTS.SECONDARY]: this.root.querySelector('.pdf-ws-slot[data-slot="b"]'),
    };

    this.elEmpty?.querySelector('[data-action="import-exercise"]')?.addEventListener('click', () => {
      document.querySelector('[data-role="file-exercise"]')?.click();
    });
    this.elEmpty?.querySelector('[data-action="import-answer"]')?.addEventListener('click', () => {
      document.querySelector('[data-role="file-answer"]')?.click();
    });

    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const host = this.elSlots[slot].querySelector('[data-role="pane"]');
      this.panes[slot] = new PdfPane(host, {
        onStateChange: () => { this._syncSlotChrome(slot); this._persist(); },
        onFocus: () => this._markActive(slot),
        onInkHistoryChange: () => this._syncSlotChrome(slot),
        onDirtyChange: (dirty) => {
          this._inkDirty[slot] = dirty;
          this._syncSlotChrome(slot);
        },
      });
      this._bindSlotChrome(slot);
    }
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
      pointerId = e.pointerId;
      // Widths at the start of the gesture, so the live preview knows what it
      // is scaling from. Recorded BEFORE the capture, and the capture is allowed
      // to fail: it throws if the pointer is not one the element can claim, and
      // everything after it used to be skipped — leaving the drag running with
      // no starting width, so the preview scaled from a nominal 1px pane and
      // blew the page up several times its size until the release put it back.
      this._dragBaseWidth = {
        [SLOTS.PRIMARY]: this.elSlots[SLOTS.PRIMARY].clientWidth || 1,
        [SLOTS.SECONDARY]: this.elSlots[SLOTS.SECONDARY].clientWidth || 1,
      };
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
      this._previewPaneFits(this._dragBaseWidth);
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
      this._dragBaseWidth = null;
      this.root.classList.remove('is-closing-primary', 'is-closing-secondary');
      this.elSlots[SLOTS.PRIMARY].classList.remove('is-closing');
      this.elSlots[SLOTS.SECONDARY].classList.remove('is-closing');
      this._hideRatioBadge();

      if (tapped) {
        this.animateToRatio(0.5);
        return;
      }

      // Released at an end: that side is being closed, not resized to nothing.
      const r = this.state.dividerRatio;
      const closing = r <= CLOSE_THRESHOLD ? (this.state.swapped ? SLOTS.SECONDARY : SLOTS.PRIMARY)
        : r >= 1 - CLOSE_THRESHOLD ? (this.state.swapped ? SLOTS.PRIMARY : SLOTS.SECONDARY)
          : null;
      if (closing) {
        this._clearPaneFitPreviews();
        this._absorbPane(closing, () => {
          // Put the divider back to centre first, so the surviving document
          // does not inherit a ratio that means "closed".
          this._setState(setDividerRatio(this.state, 0.5));
          this.closeSlot(closing);
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
  _previewPaneFits(base) {
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const pane = this.panes[slot];
      if (!pane?.previewScale || !pane.isLoaded?.()) continue;
      const from = base?.[slot];
      // A manual zoom is not ours to re-price, and nor is a pane we never took
      // a starting width from — but both still have to be re-PLACED, because
      // the middle of a pane that is changing width is a moving target.
      if (pane.state?.fitMode === FIT_MODES.NONE || !(from > 1)) {
        pane.reposition?.();
        continue;
      }
      const now = this.elSlots[slot].clientWidth || from;
      const was = pane.fitZoomFor?.(from);
      const will = pane.fitZoomFor?.(now);
      pane.previewScale(was && will ? will / was : now / from);
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
    const base = {
      [SLOTS.PRIMARY]: this.elSlots[SLOTS.PRIMARY].clientWidth || 0,
      [SLOTS.SECONDARY]: this.elSlots[SLOTS.SECONDARY].clientWidth || 0,
    };
    if (this._trackFrame) cancelAnimationFrame(this._trackFrame);
    const until = Date.now() + duration;
    const step = () => {
      this._previewPaneFits(base);
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
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this.panes[slot]?.resize?.();
  }

  // ── state → DOM ───────────────────────────────────────────────────────────

  _setState(next) {
    if (next === this.state) return;
    this.state = next;
    this._layout();
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
      el.hidden = fraction === 0 && !this._dividerDragging;
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

    this._syncPaneHeaderFit();
    this._syncToolbarSize(fractions);
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

    // The pane toolbar runs across the top of the workspace and holds controls.
    // Measured rather than assumed, because it is exactly the thing that grows
    // a row when a pane gets narrow.
    const header = this.elSlots[this.activeSlot]?.querySelector('.pdf-slot-toolbar');
    this.toolbar.setSafeArea?.(header ? header.offsetHeight : 0, 0);

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
    const share = fractions?.[this.activeSlot];
    const fallback = Number.isFinite(share) ? rect.width * share : rect.width;

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
    on('zoom-out', () => pane.zoomOut());
    on('zoom-in', () => pane.zoomIn());
    on('fit-width', () => pane.fitWidth());
    on('fit-page', () => pane.fitPage());
    on('save-ink', async () => {
      const el = this.elSlots[slot];
      const label = el.querySelector('[data-role="save-ink-text"]');
      await this.panes[slot].saveNow();
      // Say it happened. An autosave that reports nothing is indistinguishable
      // from one that failed, which is the whole reason this button exists.
      if (label) {
        label.textContent = '已保存';
        clearTimeout(this._saveLabelTimer?.[slot]);
        this._saveLabelTimer = this._saveLabelTimer || {};
        this._saveLabelTimer[slot] = setTimeout(() => { label.textContent = '保存'; }, 1600);
      }
      this._syncSlotChrome(slot);
    });
    on('close', () => this.closeSlot(slot));
    on('focus', () => {
      this.animateToFocus(slot);
    });
    on('outline', () => {
      const panel = el.querySelector('[data-role="outline-panel"]');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) this._renderOutline(slot, this._outlines[slot]);
      this._syncOverlayState();
    });

    // Tool selection lives in the floating toolbar (spec chapter 5); per-pane
    // undo/redo stays here because history belongs to a pane, not to a tool.
    on('ink-undo', () => pane.ink.undo());
    on('ink-redo', () => pane.ink.redo());
    on('answers', () => this.toggleAnswers(slot));

    // The exercise label drives answer lookup, so it lives on the pane rather
    // than in the grading panel — it belongs to the page being solved.
    const labelInput = el.querySelector('[data-role="exercise-label"]');
    if (labelInput) {
      labelInput.addEventListener('input', () => {
        pane.exerciseLabel = labelInput.value.trim();
      });
    }

    const pageInput = el.querySelector('[data-role="page-input"]');
    if (pageInput) {
      pageInput.addEventListener('change', () => {
        pane.goToPage(parseInt(pageInput.value, 10));
        this._syncSlotChrome(slot);
      });
    }
  }

  _syncSlotChrome(slot) {
    const el = this.elSlots[slot];
    const pane = this.panes[slot];
    const set = (role, fn) => {
      const node = el.querySelector(`[data-role="${role}"]`);
      if (node) fn(node);
    };

    const loaded = pane.isLoaded();
    set('toolbar', n => { n.hidden = !loaded; });
    set('title', n => { n.textContent = pane.meta ? pane.meta.name : ''; });
    set('prev', n => { n.disabled = !pane.canGoPrevious(); });
    set('next', n => { n.disabled = !pane.canGoNext(); });
    set('page-input', n => {
      if (loaded && document.activeElement !== n) n.value = String(pane.state.pageNumber);
      n.max = loaded ? String(pane.state.pageCount) : '1';
    });
    set('page-total', n => { n.textContent = loaded ? `/ ${pane.state.pageCount}` : ''; });
    set('zoom-label', n => {
      // Counted from the whole page, not from the PDF's own 1:1 — so 100%
      // means the page is all there, which is what a reader means by it.
      n.textContent = loaded ? `${Math.round((pane.displayZoom?.() ?? pane.state.zoom) * 100)}%` : '';
    });
    set('focus', n => {
      n.classList.toggle('is-active', this.state.focusedSlot === slot);
      n.title = this.state.focusedSlot === slot ? '退出专注' : '专注此文档';
    });
    set('save-ink', n => {
      n.hidden = !loaded;
      // Enabled only when there is something to write. Annotations autosave on
      // a 400ms debounce, so a disabled button here means "already safe".
      n.disabled = !this._inkDirty[slot];
      n.classList.toggle('is-dirty', !!this._inkDirty[slot]);
      n.title = this._inkDirty[slot] ? '保存本页批注' : '批注已保存';
    });
    set('ink-undo', n => { n.disabled = !loaded || !pane.ink.canUndo(); });
    set('ink-redo', n => { n.disabled = !loaded || !pane.ink.canRedo(); });

    // Answering belongs to the exercise book.
    //
    // The action asks "what are the answers to the questions on THIS page",
    // which is only a question the side holding the questions can ask. It used
    // to sit on both panes, so half the time it was pointed at the answer key
    // and asked it to find answers to itself.
    const isExercise = loaded && pane.meta?.role === DOC_ROLES.EXERCISE;
    set('answers', n => { n.hidden = !isExercise; });
    set('exercise-label', n => { n.hidden = !isExercise; });
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
    const panel = this.elSlots[slot].querySelector('[data-role="outline-panel"]');
    const button = this.elSlots[slot].querySelector('[data-role="outline"]');
    this._outlines[slot] = null;
    if (panel) {
      panel.replaceChildren();
      panel.hidden = true;
    }
    if (button) button.disabled = true;
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
  }

  _renderOutline(slot, outline) {
    const panel = this.elSlots[slot].querySelector('[data-role="outline-panel"]');
    const button = this.elSlots[slot].querySelector('[data-role="outline"]');
    if (!panel) return;
    this._outlines[slot] = outline;

    if (!outline) {
      if (!panel.hidden) {
        panel.innerHTML = '<div class="pdf-outline-empty">正在加载目录…</div>';
      }
      if (button) button.disabled = true;
      return;
    }

    if (!outline.available || outline.items.length === 0) {
      panel.innerHTML = '<div class="pdf-outline-empty" data-i18n="pdf.noOutline">此文档没有目录</div>';
      if (button) button.disabled = true;
      return;
    }
    if (button) button.disabled = false;

    // Large books can have hundreds of bookmarks. Avoid constructing every
    // button while the panel is hidden for work the reader may never request.
    if (panel.hidden) {
      panel.replaceChildren();
      return;
    }

    const list = document.createElement('ul');
    list.className = 'pdf-outline-list';
    const walk = (items, parent) => {
      for (const item of items) {
        const li = document.createElement('li');
        li.className = 'pdf-outline-item';
        li.style.paddingInlineStart = `${item.depth * 12}px`;

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'pdf-outline-link';
        label.textContent = item.title || '(未命名)';
        if (item.pageNumber) {
          label.addEventListener('click', () => {
            this.panes[slot].goToPage(item.pageNumber);
            this._syncSlotChrome(slot);
          });
        } else {
          // Unresolvable destination: shown, but not pretending to navigate.
          label.disabled = true;
          label.title = '该目录项没有可解析的目标页';
        }
        li.appendChild(label);
        parent.appendChild(li);
        if (item.children.length) walk(item.children, parent);
      }
    };
    walk(outline.items, list);
    panel.replaceChildren(list);
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
    }
  }

  async openDocument(slot, documentId, restoredView) {
    const token = (this._openTokens[slot] || 0) + 1;
    this._openTokens[slot] = token;
    const superseded = () => this._openTokens[slot] !== token;

    const meta = await this._pdfLibrary.getDocumentMeta(documentId);
    if (!meta) throw new Error('PDF_DOC_NOT_FOUND');
    if (superseded()) return null;

    this._resetOutline(slot);
    const pane = this.panes[slot];
    if (pane.isLoaded()) pane.unload();
    this._invalidatePairCaches();

    const doc = await this._pdfLibrary.openStoredDocument(documentId);
    if (superseded()) {
      try { doc.destroy(); } catch (_) { /* nothing further to release */ }
      return null;
    }
    const loaded = await pane.loadDocument(doc, meta, restoredView, () => !superseded());
    if (!loaded || superseded()) {
      if (pane.doc === doc) pane.unload();
      else {
        try { doc.destroy(); } catch (_) { /* already released */ }
      }
      return null;
    }

    this._setState(assignDocument(this.state, slot, documentId));
    this._layout();
    // The other pane just lost half its width; a fit mode has to follow.
    this._resizePanes();
    this._persist();

    // First page is already visible. Resolve the optional outline afterwards,
    // and never let a stale document update the replacement pane.
    const outlinePromise = typeof doc.getOutline === 'function'
      ? doc.getOutline()
      : Promise.resolve(doc.outline);
    outlinePromise.then((outline) => {
      if (!superseded() && pane.doc === doc) this._renderOutline(slot, outline);
    }).catch((error) => {
      if (!superseded() && pane.doc === doc) {
        Logger.warn('PDF', `Could not load outline: ${error.message}`);
        this._renderOutline(slot, { available: false, items: [] });
      }
    });
    return meta;
  }

  closeSlot(slot) {
    this._openTokens[slot] = (this._openTokens[slot] || 0) + 1;
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
    const other = this.panes[otherSlot(slot)];
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

    if (!other?.isLoaded()) {
      notice('请在另一侧打开答案册');
      return;
    }
    if (other.meta?.role !== DOC_ROLES.ANSWER) {
      notice('另一侧的文档没有标记为答案册');
      return;
    }

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
          // Jump the answer pane to where the answer actually is, so the user
          // can verify the match against the book itself.
          if (m.entry?.page) other.goToPage(m.entry.page);
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

  // ── grading ───────────────────────────────────────────────────────────────




  _persist() {
    saveSession(this.state, {
      [SLOTS.PRIMARY]: this.panes[SLOTS.PRIMARY].state,
      [SLOTS.SECONDARY]: this.panes[SLOTS.SECONDARY].state,
    });
  }

  /** Restores the previous session; safe to call when there is none. */
  async init() {
    const { workspace, views, dropped } = await restoreSession();
    if (dropped.length) {
      Logger.warn('PDF', `Dropped ${dropped.length} session slot(s) whose document was deleted`);
    }
    this._setState(setOrientation(
      workspace,
      orientationForViewport(this.root.clientWidth, this.root.clientHeight),
    ));

    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
      const id = workspace.documents[slot];
      if (!id) continue;
      try {
        await this.openDocument(slot, id, views[slot]);
      } catch (error) {
        Logger.warn('PDF', `Could not restore slot ${slot}: ${error.message}`);
        this._setState(closeSlot(this.state, slot));
      }
    }
    // Focus is restored after both documents load, so it is not cleared by a
    // slot assignment happening later.
    this._setState(workspace.focusedSlot
      ? toggleFocus(clearFocus(this.state), workspace.focusedSlot)
      : this.state);
    this._layout();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    clearTimeout(this._animTimer);
    if (this._trackFrame) cancelAnimationFrame(this._trackFrame);
    this._trackFrame = 0;
    this.toolbar?.destroy();
    for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) this.panes[slot].unload();
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function slotChrome(slot) {
  return `
    <div class="pdf-slot-toolbar" data-role="toolbar" hidden>
      <span class="pdf-slot-title" data-role="title"></span>
      <button type="button" class="pdf-slot-btn" data-role="outline" title="目录">☰</button>
      <button type="button" class="pdf-slot-btn" data-role="prev" title="上一页">‹</button>
      <input type="number" class="pdf-slot-page" data-role="page-input" min="1" step="1" value="1" aria-label="页码">
      <span class="pdf-slot-total" data-role="page-total"></span>
      <button type="button" class="pdf-slot-btn" data-role="next" title="下一页">›</button>
      <button type="button" class="pdf-slot-btn" data-role="zoom-out" title="缩小">−</button>
      <span class="pdf-slot-zoom" data-role="zoom-label"></span>
      <button type="button" class="pdf-slot-btn" data-role="zoom-in" title="放大">+</button>
      <button type="button" class="pdf-slot-btn" data-role="fit-width" title="适合宽度">↔</button>
      <button type="button" class="pdf-slot-btn" data-role="fit-page" title="整页">⤢</button>
      <span class="pdf-slot-sep"></span>
      <button type="button" class="pdf-slot-btn is-save-action" data-role="save-ink" title="保存本页批注">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
             stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
          <path d="M17 21v-8H7v8M7 3v5h8"/>
        </svg>
        <span class="pdf-slot-btn-text" data-role="save-ink-text">保存</span>
      </button>
      <button type="button" class="pdf-slot-btn" data-role="ink-undo" title="撤销">↶</button>
      <button type="button" class="pdf-slot-btn" data-role="ink-redo" title="重做">↷</button>
      <input type="text" class="pdf-slot-label" data-role="exercise-label" placeholder="题号" aria-label="题号" maxlength="4">
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
      <span class="pdf-slot-sep"></span>
      <button type="button" class="pdf-slot-btn" data-role="focus" title="专注此文档">⛶</button>
      <button type="button" class="pdf-slot-btn" data-role="close" title="关闭">✕</button>
    </div>
    <div class="pdf-outline-panel" data-role="outline-panel" hidden></div>
    <div class="pdf-answer-panel" data-role="answer-panel" hidden></div>
    <div class="pdf-slot-pane" data-role="pane" data-slot="${slot}"></div>
  `;
}
