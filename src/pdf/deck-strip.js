// PDF Module — the switching strip (F03, F04, M01-M04).
//
// One strip per slot. It says what the pane is showing, how many other things
// are behind it, and it is how you get to them: two arrows, a title that opens
// the list, and a vertical drag on the strip itself.
//
// The gesture lives HERE and nowhere else. Ink on paper never switches the
// deck, a PDF keeps its page turns and its panning, and a drag that starts on
// the paper cannot become a deck swipe by wandering over the strip — because
// the POINTER listeners are attached to the strip, not to the document, and
// there is no global touch suppressor anywhere in this file.
//
// The one document-level listener is for CLICK, and only to take back the one
// the browser synthesises at the end of a drag; it is armed for a moment and
// swallows exactly one. See the note above `armSwallow`.
//
// Up recalls the next item, down the previous, the same for PDFs and pads.

import { t } from '../core/i18n.js';
import {
  ENTRY_KINDS,
  activeEntry,
  activePosition,
  canCycle,
  deckLength,
  entryAtOffset,
} from './deck-state.js';

/** Within this much travel the press is still a tap. */
const TAP_SLOP = 6;

/** And past it, a drag must be this much more vertical than horizontal. */
const VERTICAL_RATIO = 1.5;

/**
 * How far the gesture has to travel for a full unit of progress.
 *
 * Proportional to the paper, so the same flick means the same thing on a
 * full-height pane and on a short one, and clamped so it never becomes absurd
 * at either extreme.
 */
const travelDistance = (paperHeight) => Math.min(180, Math.max(120, 0.26 * paperHeight));

/** Progress at which a release commits. */
const COMMIT_PROGRESS = 0.28;

/** A flick this fast commits regardless of how far it got. */
const FLICK_SPEED = 0.55;          // px per ms
const FLICK_TRAVEL = 16;           // and it must have gone at least this far

/** Velocity is measured over the tail of the gesture, not its average. */
const VELOCITY_WINDOW = 80;        // ms

/** How far the card travels at full progress. */
const CARD_TRAVEL = 24;
const CARD_SCALE = 0.985;
const CARD_OPACITY = 0.86;

/** Shown once, ever. A tutorial that replays is a tutorial nobody reads. */
const HINT_KEY = 'ls_deck_hint_seen';

/**
 * The settling spring.
 *
 * Near-critical, so it arrives without a visible bounce: paper is not rubber.
 * Integrated against real elapsed frame time rather than a hard-coded 16.7ms
 * step, because a 120Hz tablet and a stalled frame are both ordinary and a
 * fixed step makes the first too slow and the second a jump.
 */
const SPRING = Object.freeze({ mass: 1, stiffness: 360, damping: 38 });

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

// ── the click a finished drag leaves behind ─────────────────────────────────
//
// A vertical swipe of any length starts on the strip and ENDS somewhere else:
// the strip is 52dp tall and the gesture travels a hundred and more. The click
// the browser synthesises afterwards is delivered to whatever is under the
// finger by then — on the tablet a swipe ended on the pane's ⋯ button and
// opened the slot menu.
//
// So it is swallowed at the document, in the capture phase, before it can reach
// anything. Only after a real drag: a tap must still work.
//
// Deliberately ONE listener and ONE flag for the whole module rather than one
// per strip. There are two strips on screen; per-instance state meant two
// listeners stacked on the document, and the left strip's armed flag could eat
// a tap meant for the right pane.

let swallowNextClick = false;
let swallowTimer = 0;
let swallowInstalled = false;

function installSwallow() {
  if (swallowInstalled || typeof document === 'undefined') return;
  swallowInstalled = true;
  document.addEventListener('click', (e) => {
    if (!swallowNextClick) return;
    disarmSwallow();
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

/**
 * Arms the swallow for exactly one click.
 *
 * A drag that ends somewhere with nothing to click produces no click at all,
 * and the flag would then sit armed until the reader's NEXT press, eating a tap
 * they meant. The timer drops it again — later than any synthesised click,
 * sooner than any human.
 */
function armSwallow() {
  installSwallow();
  swallowNextClick = true;
  clearTimeout(swallowTimer);
  swallowTimer = setTimeout(() => { swallowNextClick = false; }, 350);
}

function disarmSwallow() {
  swallowNextClick = false;
  clearTimeout(swallowTimer);
}

export class DeckStrip {
  /**
   * @param {HTMLElement} host the slot element this strip belongs to
   * @param {{getDeck: function, describe: function, onCycle: function,
   *          onActivate: function, onRemove: function, onOrganize: function,
   *          getPaper: function, isBusy: function}} handlers
   */
  constructor(host, handlers = {}) {
    this.host = host;
    this.handlers = handlers;
    this.el = host.querySelector('[data-role="strip"]');
    this.elList = host.querySelector('[data-role="deck-list"]');
    this.elPreview = host.querySelector('[data-role="deck-preview"]');
    /** Undone on destroy; a rebuilt workspace must not leave two of everything. */
    this._life = new AbortController();
    this._drag = null;
    this._spring = null;
    this._raf = 0;
    if (this.el) this._bind();
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  /**
   * Writes the strip's own state: what is showing, and how much is behind it.
   *
   * The count is the discoverability, together with the arrows: "1 / 3" is what
   * tells someone there are two other things in this pane at all. With one
   * entry it still reads 1 / 1 and the arrows are disabled — the list stays
   * reachable, because it is also where Remove and Organize live.
   */
  render() {
    if (!this.el) return;
    const deck = this.handlers.getDeck?.();
    const entry = activeEntry(deck);
    const length = deckLength(deck);

    this.el.hidden = length === 0;
    if (!entry) return;

    const described = this.handlers.describe?.(entry) || {};
    const kindLabel = entry.kind === ENTRY_KINDS.SCRATCH ? t('deck.scratch') : t('deck.pdf');
    const set = (role, fn) => {
      const node = this.el.querySelector(`[data-role="${role}"]`);
      if (node) fn(node);
    };

    set('deck-kind', n => { n.textContent = kindLabel; });
    set('deck-name', n => {
      n.textContent = described.name || t('deck.untitled');
      // Ellipsised on screen, complete to a screen reader — a name is how you
      // tell two exercise books apart, and the truncation is a layout accident.
      n.title = described.name || '';
    });
    set('deck-count', n => {
      n.textContent = `${activePosition(deck)} / ${length}`;
    });
    set('deck-prev', n => {
      n.disabled = !canCycle(deck);
      n.setAttribute('aria-label', t('deck.previousContent'));
    });
    set('deck-next', n => {
      n.disabled = !canCycle(deck);
      n.setAttribute('aria-label', t('deck.nextContent'));
    });
    set('deck-title', n => {
      // The whole accessible name, whatever the width leaves visible.
      n.setAttribute('aria-label',
        `${kindLabel} ${described.name || ''} ${activePosition(deck)} / ${length} · ${t('deck.openList')}`);
      n.setAttribute('aria-expanded', String(!this.elList?.hidden));
    });

    this.el.classList.toggle('is-single', length < 2);
    this._renderHint(length);
    if (!this.elList?.hidden) this.renderList();
  }

  /** The one-time hint, and only where there is something to discover. */
  _renderHint(length) {
    const node = this.el.querySelector('[data-role="deck-hint"]');
    if (!node) return;
    let seen = true;
    try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch (_) { /* private mode */ }
    node.hidden = seen || length < 2;
    node.textContent = t('deck.swipeHint');
  }

  _markHintSeen() {
    try { localStorage.setItem(HINT_KEY, '1'); } catch (_) { /* nothing to do */ }
    const node = this.el?.querySelector('[data-role="deck-hint"]');
    if (node) node.hidden = true;
  }

  /**
   * The content list.
   *
   * In saved deck order, with the active item marked — deliberately NOT rotated
   * so that the current entry appears first. A list that reorders itself under
   * the reader is a list in which nothing is ever where they left it.
   */
  renderList() {
    if (!this.elList) return;
    const deck = this.handlers.getDeck?.();
    if (!deck) return;

    const rows = deck.entries.map((entry, index) => {
      const described = this.handlers.describe?.(entry) || {};
      const active = entry.id === deck.activeId;
      const row = document.createElement('div');
      row.className = `deck-row${active ? ' is-active' : ''}`;
      row.dataset.entryId = entry.id;

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'deck-row-select';
      select.setAttribute('role', 'menuitemradio');
      select.setAttribute('aria-checked', String(active));
      select.innerHTML = `
        <span class="deck-row-kind">${entry.kind === ENTRY_KINDS.SCRATCH ? t('deck.scratch') : t('deck.pdf')}</span>
        <span class="deck-row-name"></span>
        <span class="deck-row-meta"></span>`;
      select.querySelector('.deck-row-name').textContent = described.name || t('deck.untitled');
      // Page for a book, zoom for a pad, and the save state for anything that
      // has one — the three things that say "which of these is which".
      select.querySelector('.deck-row-meta').textContent = [described.detail, described.save]
        .filter(Boolean).join(' · ');
      select.addEventListener('click', () => {
        this.closeList();
        this.handlers.onActivate?.(entry.id);
      });
      row.appendChild(select);

      const menu = document.createElement('div');
      menu.className = 'deck-row-actions';

      const move = document.createElement('button');
      move.type = 'button';
      move.className = 'deck-row-btn';
      move.textContent = t('deck.moveTo');
      move.addEventListener('click', () => {
        this.closeList();
        this.handlers.onOrganize?.(entry.id);
      });
      menu.appendChild(move);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'deck-row-btn is-danger';
      remove.textContent = t('deck.removeFromPane');
      remove.addEventListener('click', () => {
        this.closeList();
        this.handlers.onRemove?.(entry.id);
      });
      menu.appendChild(remove);

      row.appendChild(menu);
      row.style.setProperty('--row-index', String(Math.min(index, 8)));
      return row;
    });

    const header = document.createElement('div');
    header.className = 'deck-list-head';
    header.innerHTML = `<strong></strong>`;
    header.querySelector('strong').textContent = t('deck.contentIn');

    // Previous and Next live in here as well as on the strip.
    //
    // On a very narrow pane the strip sheds its arrows — three controls and a
    // name will not fit — and the specification is explicit that the list it
    // falls back to must carry the full pair. Present at every width rather
    // than only when narrow: a control that appears and disappears with the
    // divider is one nobody learns where to find.
    const cycle = document.createElement('span');
    cycle.className = 'deck-list-cycle';
    for (const [step, key] of [[-1, 'deck.previousContent'], [1, 'deck.nextContent']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'deck-row-btn';
      button.textContent = t(key);
      button.disabled = !canCycle(deck);
      button.addEventListener('click', () => this._request(step));
      cycle.appendChild(button);
    }
    header.appendChild(cycle);

    const organise = document.createElement('button');
    organise.type = 'button';
    organise.className = 'deck-row-btn';
    organise.textContent = t('deck.organize');
    organise.addEventListener('click', () => {
      this.closeList();
      this.handlers.onOrganize?.(null);
    });
    header.appendChild(organise);

    this.elList.replaceChildren(header, ...rows);
  }

  toggleList() {
    if (!this.elList) return;
    if (this.elList.hidden) this.openList();
    else this.closeList();
  }

  openList() {
    if (!this.elList) return;
    this.renderList();
    this.elList.hidden = false;
    this.el?.querySelector('[data-role="deck-title"]')?.setAttribute('aria-expanded', 'true');
    this.host.classList.add('is-deck-list-open');
    this._syncOverlay();
  }

  closeList() {
    if (!this.elList || this.elList.hidden) return;
    this.elList.hidden = true;
    this.el?.querySelector('[data-role="deck-title"]')?.setAttribute('aria-expanded', 'false');
    this.host.classList.remove('is-deck-list-open');
    this._syncOverlay();
  }

  /**
   * Gets the floating ink toolbar out of the way while the list is open.
   *
   * The bar is mounted on the workspace at z-index 36 and the list is a panel
   * inside a slot, so it can never be raised above it without also covering the
   * other column. It was sitting across the entries, hiding the very names the
   * list exists to show — and nobody is writing at that moment anyway: the list
   * is for choosing, and it closes as soon as you have.
   *
   * The same treatment the outline panel and the document library already get,
   * through the same kind of class on the workspace root. Recomputed from what
   * is actually open, because there are two strips and one closing must not
   * clear the class while the other's list is up.
   */
  _syncOverlay() {
    const root = this.host?.closest?.('.pdf-workspace');
    if (!root) return;
    const open = root.querySelector('[data-role="deck-list"]:not([hidden])');
    root.classList.toggle('is-deck-list-open', !!open);
    // The panel that is up, not merely the fact that one is: whoever moves the
    // ink bar has to know what it would have to clear. Null means the coast is
    // clear again.
    this.handlers.onListOverlay?.(open || null);
  }

  get listOpen() { return !!this.elList && !this.elList.hidden; }

  // ── the gesture ───────────────────────────────────────────────────────────

  _bind() {
    const alive = { signal: this._life.signal };

    this.el.querySelector('[data-role="deck-prev"]')
      ?.addEventListener('click', () => this._request(-1), alive);
    this.el.querySelector('[data-role="deck-next"]')
      ?.addEventListener('click', () => this._request(1), alive);

    const title = this.el.querySelector('[data-role="deck-title"]');
    title?.addEventListener('click', () => this.toggleList(), alive);

    // Keyboard, on the strip only. Global arrows belong to the page, the paper
    // and any text field that has focus — hijacking them would take navigation
    // away from all three.
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); this._request(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this._request(-1); }
      else if (e.key === 'Escape') {
        if (this._drag) { e.preventDefault(); this._cancelDrag(); }
        else if (this.listOpen) { e.preventDefault(); this.closeList(); }
      }
    }, alive);

    // The drag is taken on the title and the strip's own background. An arrow
    // is a button: pressing it must not also start a drag.
    this.el.addEventListener('pointerdown', (e) => this._onDown(e), alive);
    this.el.addEventListener('pointermove', (e) => this._onMove(e), alive);
    this.el.addEventListener('pointerup', (e) => this._onUp(e), alive);
    this.el.addEventListener('pointercancel', () => this._cancelDrag(), alive);
    // Everything that can take the pointer away without telling us.
    this.el.addEventListener('lostpointercapture', () => {
      // Expected after a normal pointerup; only a LOSS mid-gesture cancels, and
      // cancelling twice must be harmless.
      if (this._drag) this._cancelDrag();
    }, alive);
    window.addEventListener('blur', () => this._cancelDrag(), alive);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._cancelDrag();
    }, alive);

    // A press anywhere else puts the list away.
    //
    // Without this the list could be opened and not closed: the title toggles
    // it, and every other press went to whatever was under it while the list
    // stayed up over the page it was covering. The one way out was to pick
    // something from it, which turns a list you opened to LOOK at into a list
    // you have to commit to.
    //
    // Capture phase, so it is seen before the press reaches whatever it landed
    // on — but it only closes; the press still does its own job.
    document.addEventListener('pointerdown', (e) => {
      if (!this.listOpen) return;
      // Inside the list is a press on the list. On this strip's own title is
      // the toggle's business, and closing here too would close and reopen.
      if (this.elList?.contains(e.target)) return;
      if (this.el?.querySelector('[data-role="deck-title"]')?.contains(e.target)) return;
      this.closeList();
    }, { capture: true, ...alive });

    // And Escape, wherever focus happens to be. The strip's own keydown only
    // fires while the strip has focus, which after opening the list it may not.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.listOpen) return;
      e.stopPropagation();
      this.closeList();
    }, { capture: true, ...alive });
  }

  _onDown(e) {
    // A second finger landing while a drag is live cancels it — this is the
    // event a real browser sends first, before any move.
    if (this._drag && this._drag.id !== e.pointerId) { this._cancelDrag(); return; }
    if (this.handlers.isBusy?.()) return;
    if (e.target?.closest?.('button') && !e.target.closest('[data-role="deck-title"]')) return;
    const deck = this.handlers.getDeck?.();
    if (!canCycle(deck)) return;

    this._drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      at: e.timeStamp || performance.now(),
      locked: false,
      progress: 0,
      samples: [],
      // Captured now and never re-read: the entry the gesture is about cannot
      // change under it, whatever else happens to the deck meanwhile.
      entryId: deck.activeId,
    };
    try { this.el.setPointerCapture(e.pointerId); } catch (_) { /* not ours */ }
  }

  _onMove(e) {
    const drag = this._drag;
    if (!drag) return;

    // A second pointer cancels: two fingers on the strip is not a swipe, and
    // guessing which one to follow is how a gesture ends up doing neither.
    //
    // Tested BEFORE the pointer-id filter, and that order is the whole point: a
    // second contact carries a DIFFERENT id, so filtering by id first discards
    // the very event that says it has arrived — and the gesture then commits as
    // though the finger had been alone the whole time.
    if (e.isPrimary === false) { this._cancelDrag(); return; }
    if (drag.id !== e.pointerId) return;

    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;

    if (!drag.locked) {
      if (Math.abs(dy) < TAP_SLOP) return;                 // still a tap
      if (Math.abs(dy) < Math.abs(dx) * VERTICAL_RATIO) {
        // Classified horizontal. It does not switch, and it does not become a
        // switch later — the classification is made once.
        this._cancelDrag();
        return;
      }
      drag.locked = true;
      this.el.classList.add('is-dragging');
      this._markHintSeen();
    }

    e.preventDefault();
    const now = e.timeStamp || performance.now();
    drag.samples.push({ y: e.clientY, at: now });
    // Only the tail matters: a slow drag that changes its mind at the end has a
    // healthy average in the wrong direction.
    while (drag.samples.length > 2 && now - drag.samples[0].at > VELOCITY_WINDOW) {
      drag.samples.shift();
    }

    const D = travelDistance(this._paperHeight());
    // Up is positive: dy is negative going up, so the sign is flipped.
    this._setProgress(-dy / D);
  }

  _onUp(e) {
    const drag = this._drag;
    if (!drag || drag.id !== e.pointerId) return;
    try { this.el.releasePointerCapture(e.pointerId); } catch (_) { /* gone */ }

    if (!drag.locked) { this._drag = null; return; }        // a tap: the click handler has it
    armSwallow();

    const progress = drag.progress;
    const velocity = this._velocity(e);
    this._drag = null;
    this.el.classList.remove('is-dragging');

    // Carried far enough, or thrown hard enough — and a throw only counts when
    // it agrees with where the gesture actually went. A flick back the other way
    // at the last moment cannot commit the direction it is travelling away from.
    const carried = Math.abs(progress) >= COMMIT_PROGRESS;
    const flicked = Math.abs(velocity) >= FLICK_SPEED
      && Math.abs(progress) * travelDistance(this._paperHeight()) >= FLICK_TRAVEL
      && Math.sign(velocity) === Math.sign(progress);

    if ((carried || flicked) && progress !== 0) {
      const step = progress > 0 ? 1 : -1;
      // Asked for AT ONCE, and the card settles underneath it.
      //
      // This used to wait for the spring to converge before requesting the
      // switch, which made every swipe cost the length of an animation and —
      // worse — made the switch depend on a callback being delivered. A frame
      // that never runs, a backgrounded tab, a spring interrupted by the next
      // touch: any of them would have swallowed the gesture entirely. Animation
      // completion is not commit, and it must never be allowed to become it.
      this._request(step);
      this._settle(0);
      return;
    }
    this._settle(0);
  }

  /**
   * Speed over the tail of the gesture, in screen px per ms.
   *
   * A pause makes it zero rather than carrying the speed the hand had before
   * it: holding still at the end of a drag means "not this far", and the
   * gesture must not keep the momentum it has plainly given up.
   */
  _velocity(e) {
    const drag = this._drag;
    if (!drag || drag.samples.length < 2) return 0;
    const last = drag.samples[drag.samples.length - 1];
    const first = drag.samples[0];
    const now = e ? (e.timeStamp || performance.now()) : last.at;
    if (now - last.at > VELOCITY_WINDOW) return 0;          // stationary at release
    const dt = last.at - first.at;
    if (dt <= 0) return 0;
    return -(last.y - first.y) / dt;                        // up is positive
  }

  _paperHeight() {
    const paper = this.handlers.getPaper?.();
    const rect = paper?.getBoundingClientRect?.();
    return rect && rect.height > 0 ? rect.height : 480;
  }

  /**
   * Shows how far the gesture has got, reversibly.
   *
   * The card moves, dims and shrinks a little; the incoming one is named. None
   * of this touches the deck: the active entry, the order and the source
   * renderer are exactly as they were until a release commits, so letting go
   * halfway leaves nothing to undo.
   */
  _setProgress(raw) {
    if (!this._drag) return;
    // One item per gesture. Past a full unit the card meets resistance rather
    // than running on to the next entry — there is no inertial multi-skip.
    const clamped = Math.sign(raw) * (Math.abs(raw) <= 1
      ? Math.abs(raw)
      : 1 + Math.log1p(Math.abs(raw) - 1) * 0.12);
    this._drag.progress = Math.max(-1.35, Math.min(1.35, clamped));
    this._paint(this._drag.progress);
  }

  _paint(progress) {
    const paper = this.handlers.getPaper?.();
    if (paper) {
      if (prefersReducedMotion() || progress === 0) {
        paper.style.transform = '';
        paper.style.opacity = '';
      } else {
        const k = Math.min(1, Math.abs(progress));
        const shift = -progress * CARD_TRAVEL;
        paper.style.transform =
          `translateY(${shift.toFixed(2)}px) scale(${(1 - (1 - CARD_SCALE) * k).toFixed(4)})`;
        paper.style.opacity = String(1 - (1 - CARD_OPACITY) * k);
      }
    }
    if (!this.elPreview) return;
    if (progress === 0 || !this._drag) {
      this.elPreview.hidden = true;
      return;
    }
    const deck = this.handlers.getDeck?.();
    const target = entryAtOffset(deck, progress > 0 ? 1 : -1);
    if (!target) { this.elPreview.hidden = true; return; }
    const described = this.handlers.describe?.(target) || {};
    // Named, not decoded. A preview must never cost a full PDF render.
    this.elPreview.textContent = `${t('deck.preview')}: ${described.name || t('deck.untitled')}`;
    this.elPreview.hidden = false;
  }

  /**
   * Runs the card back to `to` on a spring.
   *
   * Resumes from wherever the preview is, with whatever velocity it had, so a
   * new touch during the return takes over instead of fighting a fixed easing
   * curve that has already decided where it is going.
   *
   * Nothing is sequenced behind it. The switch has already been requested by
   * the time this runs — see `_onUp` — so this is decoration catching up with a
   * decision, and a frame that never arrives costs a bit of polish rather than
   * the gesture.
   */
  _settle(to) {
    const from = this._drag?.progress ?? this._spring?.value ?? 0;
    if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      this._spring = null;
      this._paint(to);
      return;
    }
    this._spring = { value: from, velocity: this._spring?.velocity || 0, to };
    if (this._raf) return;

    let last = performance.now();
    const step = (now) => {
      this._raf = 0;
      const s = this._spring;
      if (!s) return;
      // Real elapsed time, capped so a stalled frame does not teleport the
      // spring past its target and back.
      const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000));
      last = now;
      const force = -SPRING.stiffness * (s.value - s.to) - SPRING.damping * s.velocity;
      s.velocity += (force / SPRING.mass) * dt;
      s.value += s.velocity * dt;
      if (Math.abs(s.value - s.to) < 0.002 && Math.abs(s.velocity) < 0.02) {
        s.value = s.to;
        this._paint(s.to);
        this._spring = null;
        return;
      }
      this._paint(s.value);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  /**
   * Abandons an uncommitted gesture.
   *
   * Idempotent, because it is called from six places and several of them can
   * fire for the same gesture: a pointercancel followed by a lostpointercapture
   * must not cancel twice, and a cancel after a normal release must do nothing
   * at all.
   */
  _cancelDrag() {
    if (!this._drag) return;
    const wasLocked = this._drag.locked;
    this._drag = null;
    this.el?.classList.remove('is-dragging');
    // No synthetic click and no "one more step": a cancelled gesture leaves the
    // deck exactly where it was.
    if (wasLocked) {
      armSwallow();
      this._settle(0);
    } else {
      this._paint(0);
    }
  }

  /** Asks the workspace to switch. It owns the transaction; this only asks. */
  _request(step) {
    this._markHintSeen();
    this.handlers.onCycle?.(step);
  }

  /**
   * Recomputes what a gesture's full travel means, after a resize.
   *
   * An uncommitted drag is cancelled rather than rescaled: the distance it has
   * covered meant one thing on the old height and something else on the new
   * one, and there is no honest way to carry it across.
   */
  onViewportChange() {
    this._cancelDrag();
  }

  destroy() {
    this._cancelDrag();
    disarmSwallow();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._spring = null;
    this._paint(0);
    this._life.abort();
  }
}

/** The markup one slot's strip, list and preview label need. */
export function deckStripHtml() {
  return `
    <div class="deck-strip" data-role="strip" role="group" hidden>
      <button type="button" class="deck-arrow" data-role="deck-prev" tabindex="0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
             stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true">
          <path d="M12 19V5M5 12l7-7 7 7"/>
        </svg>
      </button>
      <button type="button" class="deck-title" data-role="deck-title" aria-haspopup="menu">
        <span class="deck-kind" data-role="deck-kind"></span>
        <span class="deck-name" data-role="deck-name"></span>
        <span class="deck-count" data-role="deck-count"></span>
        <span class="deck-hint" data-role="deck-hint" hidden></span>
      </button>
      <button type="button" class="deck-arrow" data-role="deck-next" tabindex="0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
             stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true">
          <path d="M12 5v14M19 12l-7 7-7-7"/>
        </svg>
      </button>
    </div>
    <div class="deck-preview" data-role="deck-preview" aria-live="polite" hidden></div>
    <div class="deck-list" data-role="deck-list" role="menu" hidden></div>
  `;
}
