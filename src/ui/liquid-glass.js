// liquid-glass.js — the lighting and gesture layer for the Liquid Glass skin.
//
// Two jobs, and deliberately only two:
//
//   1. Move the lens. The dock and the segmented controls carry a sliding pill
//      of glass that tracks whichever item is active, and can be dragged.
//   2. Answer a press. A tap on a control bulges it and sends one ripple out
//      from the contact point, and both stop under reduced motion.
//
// It does NOT track the pointer with a light. That job was here once and was
// removed; the note in the reduced-motion section says why.
//
// It routes nothing. An earlier version toggled `.page.active` itself, which
// duplicated `bootstrap.js:setupTabs()` and made the navigation answer to two
// owners; when they disagreed the page and the highlighted tab came apart. The
// lens now only *observes* the active class and follows it, and a drag ends by
// dispatching one real click so the app's own handler does the routing.

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const DRAG_THRESHOLD = 4;

let isInitialized = false;
/** Set by initLiquidGlass(); gives every listener and observer back. */
let teardown = null;

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

/** True while the skin that owns these effects is the one on screen. */
function skinActive() {
  return document.documentElement.getAttribute('data-skin') === 'liquid-math';
}

/**
 * A pointer that is drawing belongs to the ink surface and nothing else.
 *
 * On a tablet a stylus emits pointermove at 120Hz or better, and every one of
 * those events used to trigger a full-document querySelectorAll plus a
 * getBoundingClientRect for each match. That is the exact budget the stroke
 * pipeline needs, and losing it shows up as visibly faceted handwriting.
 */
function isDrawingPointer(e) {
  if (e.pointerType === 'pen' && e.buttons !== 0) return true;
  const t = e.target;
  return !!(t && t.closest && t.closest('canvas, .ink-layer, .ink-surface, .hw-canvas'));
}

const transitionFor = (props, ms = 380) =>
  props.map(p => `${p} ${ms}ms ${EASE}`).join(', ');

// ── the sliding lens ────────────────────────────────────────────────────────

/**
 * Shared controller for both sliding lenses.
 *
 * @param {HTMLElement} container element the lens rides inside
 * @param {string} itemSelector   the items it snaps between
 * @param {string} lensClass      class of the lens element to create
 * @param {{vertical?: boolean, activeClasses?: string[]}} [opts]
 */
function setupSlidingLens(container, itemSelector, lensClass, opts = {}) {
  if (!container || container._hasSlidingLens) return;
  const items = Array.from(container.querySelectorAll(itemSelector));
  if (items.length === 0) return;
  container._hasSlidingLens = true;

  const activeClasses = opts.activeClasses || ['active', 'is-active'];
  const activeSelector = activeClasses.map(c => `${itemSelector}.${c}`).join(', ');

  let lens = container.querySelector(`.${lensClass}`);
  if (!lens) {
    lens = document.createElement('div');
    lens.className = lensClass;
    lens.setAttribute('aria-hidden', 'true');
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.prepend(lens);
  }

  // The lens paints behind the labels; z-index on the items keeps it there
  // without needing the lens to be transparent to hit-testing twice over.
  items.forEach((item) => {
    if (getComputedStyle(item).position === 'static') item.style.position = 'relative';
    item.style.zIndex = '2';
  });

  const reduced = prefersReducedMotion();
  let isTracking = false;
  let isSliding = false;
  let capturedId = null;
  let startX = 0;
  let startY = 0;
  let grabbedWidth = 0;
  let grabbedHeight = 0;

  const activeItem = () => container.querySelector(activeSelector) || items[0];

  const place = (target, immediate = false) => {
    // A user-driven drag owns the lens until it lets go.
    if (isSliding) return;
    const item = target || activeItem();
    if (!item) return;

    const cRect = container.getBoundingClientRect();
    const iRect = item.getBoundingClientRect();
    // Before first layout every rect is zero; placing then would stick the
    // lens in the corner, and the transition would animate it out from there.
    if (cRect.width === 0 || iRect.width === 0) return;

    lens.style.transition = (immediate || reduced)
      ? 'none'
      : transitionFor(['left', 'top', 'width', 'height', 'transform']);
    lens.style.left = `${iRect.left - cRect.left}px`;
    lens.style.top = `${iRect.top - cRect.top}px`;
    lens.style.width = `${iRect.width}px`;
    lens.style.height = `${iRect.height}px`;
    lens.style.removeProperty('scale');
  };

  // Follow the active item wherever it is set from — the app's own routing, a
  // keyboard activation, a restored session. The lens never sets it itself.
  const observer = new MutationObserver(() => { if (!isSliding) place(); });
  observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['class'] });

  const relayout = () => place(null, true);
  // Two frames: one for the class to land, one for layout to settle under it.
  requestAnimationFrame(() => requestAnimationFrame(relayout));
  window.addEventListener('resize', relayout, { passive: true });
  if (document.fonts?.ready) document.fonts.ready.then(relayout).catch(() => {});
  container._relayoutLens = relayout;

  const nearestItem = (pointerX, pointerY) => {
    const cRect = container.getBoundingClientRect();
    let best = null;
    let bestDistance = Infinity;
    items.forEach((item) => {
      const r = item.getBoundingClientRect();
      const dx = pointerX - ((r.left + r.right) / 2 - cRect.left);
      const dy = opts.vertical ? pointerY - ((r.top + r.bottom) / 2 - cRect.top) : 0;
      const d = Math.hypot(dx, dy);
      if (d < bestDistance) { bestDistance = d; best = item; }
    });
    return best;
  };

  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    isTracking = true;
    isSliding = false;
    capturedId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    const item = activeItem();
    const r = item ? item.getBoundingClientRect() : null;
    grabbedWidth = r?.width || 64;
    grabbedHeight = r?.height || 34;
    // Capture is NOT taken here. Capturing on press retargets every later
    // pointer event — and, in Chromium, the synthesised click — to the
    // container, so a plain tap on a tab stopped reaching the tab's own
    // handler and the app never navigated. Capture is taken below, only once
    // the gesture has proven itself a drag and a tap is no longer possible.
  });

  container.addEventListener('pointermove', (e) => {
    if (!isTracking || e.pointerId !== capturedId) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!isSliding) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      isSliding = true;
      try { container.setPointerCapture(capturedId); } catch (_) { /* not capturable */ }
      lens.style.transition = 'none';
      // `scale`, not a transform: the lens is positioned with left/top and a
      // transform here would be a second, competing source of position.
      if (!reduced) lens.style.scale = '1.045';
    }

    const cRect = container.getBoundingClientRect();
    const pointerX = e.clientX - cRect.left;
    const pointerY = e.clientY - cRect.top;

    lens.style.left = `${Math.max(0, Math.min(cRect.width - grabbedWidth, pointerX - grabbedWidth / 2))}px`;
    lens.style.width = `${grabbedWidth}px`;
    lens.style.height = `${grabbedHeight}px`;
    if (opts.vertical) {
      lens.style.top = `${Math.max(0, Math.min(cRect.height - grabbedHeight, pointerY - grabbedHeight / 2))}px`;
    }

    // No `--glass-angle` is written here any more. The pill's rim is a fixed
    // top-to-bottom Fresnel gradient now, so rotating a custom property nothing
    // reads was just work done on every pointermove of a drag.
  });

  const onPointerEnd = (e) => {
    if (!isTracking || e.pointerId !== capturedId) return;
    const wasSliding = isSliding;

    isTracking = false;
    isSliding = false;
    try { container.releasePointerCapture(capturedId); } catch (_) { /* never taken */ }
    capturedId = null;

    if (wasSliding) {
      const cRect = container.getBoundingClientRect();
      const target = nearestItem(e.clientX - cRect.left, e.clientY - cRect.top);
      lens.style.transition = reduced
        ? 'none'
        : transitionFor(['left', 'top', 'width', 'height', 'transform'], 420);
      lens.style.removeProperty('scale');
      // Exactly one click, and only for a drag. A tap is left entirely alone:
      // the browser's own click is already on its way to the item, and the
      // previous version's extra .click() here made every tap fire twice —
      // which on a toggle meant it visibly undid itself.
      if (target && !activeClasses.some(c => target.classList.contains(c))) target.click();
      place(target);
    } else {
      place();
    }
  };

  container.addEventListener('pointerup', onPointerEnd);
  container.addEventListener('pointercancel', onPointerEnd);
}

// ── draggable capsules ──────────────────────────────────────────────────────

/**
 * Gives a floating capsule a spring-damped drag.
 *
 * Currently bound to no surface: every capsule that used to call it (the ink
 * card, the page bar, the ratio badge, the calculator and handwriting
 * toolbars) is anchored by the product spec, not movable. It is kept, and
 * exported, as the one implementation to reuse if a surface is ever
 * *specified* as draggable — see the note in `bind()` for what that spec has
 * to settle first.
 */
export function makeGlassCapsuleDraggable(element, options = {}) {
  if (!element || element._hasGlassDrag) return;
  element._hasGlassDrag = true;

  const reduced = prefersReducedMotion();
  let isDragging = false;
  let hasMoved = false;
  let startX = 0, startY = 0;
  let currentX = 0, currentY = 0;
  let originX = 0, originY = 0;
  let pointerId = null;

  element.style.touchAction = 'none';
  element.classList.add('draggable-glass-capsule');

  const onPointerDown = (e) => {
    // A drag started on a control is a press on that control, not a grab.
    if (e.target.closest('button, a, input, select, textarea, [role="button"]')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    isDragging = true;
    hasMoved = false;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;

    let matrix;
    try {
      matrix = new DOMMatrixReadOnly(window.getComputedStyle(element).transform);
    } catch (_) {
      matrix = null;
    }
    originX = matrix ? matrix.m41 : 0;
    originY = matrix ? matrix.m42 : 0;
  };

  const onPointerMove = (e) => {
    if (!isDragging || e.pointerId !== pointerId) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!hasMoved) {
      if (Math.hypot(dx, dy) < 5) return;
      hasMoved = true;
      element.classList.add('is-glass-dragging');
      element.style.transition = 'none';
      try { element.setPointerCapture(pointerId); } catch (_) { /* not capturable */ }
      options.onDragStart?.(e);
    }

    currentX = originX + dx;
    currentY = originY + dy;

    if (options.clamp) {
      // Measured against the untranslated box, so the clamp does not drift by
      // the current offset on every frame the way a live-rect clamp does.
      const rect = element.getBoundingClientRect();
      const left = rect.left - (currentX - dx);
      const top = rect.top - (currentY - dy);
      const margin = 10;
      currentX = Math.max(margin - left, Math.min(window.innerWidth - rect.width - left - margin, currentX));
      currentY = Math.max(margin - top, Math.min(window.innerHeight - rect.height - top - margin, currentY));
    }

    element.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
    if (!reduced) element.style.scale = '1.025';
    element.style.setProperty('--glass-angle', `${Math.round((Math.atan2(dy, dx) * 180) / Math.PI) + 90}deg`);

    options.onDrag?.({ x: currentX, y: currentY, dx, dy, e });
  };

  const onPointerUp = (e) => {
    if (!isDragging || e.pointerId !== pointerId) return;
    isDragging = false;

    try { element.releasePointerCapture(pointerId); } catch (_) { /* never taken */ }
    pointerId = null;

    if (!hasMoved) return;

    // Swallow the click the browser is about to synthesise at the end of the
    // drag, so releasing over a control does not also activate it.
    const suppressClick = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    element.addEventListener('click', suppressClick, { capture: true, once: true });
    setTimeout(() => element.removeEventListener('click', suppressClick, { capture: true }), 120);

    element.classList.remove('is-glass-dragging');
    element.style.transition = reduced ? 'none' : `transform 480ms ${EASE}, scale 300ms ${EASE}, box-shadow 300ms ease`;
    element.style.removeProperty('scale');

    if (options.snapReset) {
      currentX = 0;
      currentY = 0;
      element.style.transform = 'translate3d(0, 0, 0)';
    } else {
      element.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
    }

    options.onDragEnd?.({ x: currentX, y: currentY, e });
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
}

// ── lighting ────────────────────────────────────────────────────────────────

// Surfaces large enough that a catchlight travelling across them reads as
// light on glass. Small controls are deliberately absent: on a 34px button a
// tracked highlight is a flicker, not a reflection.
// Controls that take a tap ripple.
const RIPPLE_TARGETS = [
  '.ink-tool',
  '.ink-overflow',
  '.ink-swatch',
  '.calc-btn',
  '.ocr-btn',
  '.pdf-control-btn',
  '.skin-quick-toggle',
].join(',');

// Press feedback belongs to the control that was pressed, never to the panel
// it sits on. Squashing a whole toolbar because one button inside it was
// tapped reads as the surface itself being unstable, and on the surfaces that
// position themselves with a transform it also fights that transform.
const PRESSABLE = RIPPLE_TARGETS;

export function initLiquidGlass() {
  if (isInitialized) return;
  isInitialized = true;

  // Reduced motion is a live setting, not a boot-time snapshot.
  //
  // This used to be `const reduced = prefersReducedMotion()`, read once. A user
  // who turned the OS preference on while the app was open kept the
  // pointer-driven catchlight and the tap ripples until they reloaded the page —
  // and on a tablet the app is rarely reloaded. The media query is now kept and
  // listened to, and every effect reads `reduced` at the moment it would run.
  let motionQuery = null;
  let reduced = false;
  try {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = motionQuery.matches;
  } catch (_) { /* no matchMedia: treat motion as allowed */ }

  // ── bind lenses and capsules, including elements created later ────────────

  const bind = () => {
    setupSlidingLens(document.querySelector('.bottom-nav'), 'button', 'nav-glass-lens');

    const segmented = [
      ['.recog-tabs', '.mode-tab'],
      ['.mode-tabs', '.mode-tab'],
      ['.settings-tabs', '.settings-tab'],
      // The camera bar marks its two modes with different classes —
      // `active` for rectangle, `lasso-active` for lasso — so the lens has to
      // be told about both or it never follows the selection to the lasso.
      ['.cam-mode-bar', '.cam-mode-btn', ['active', 'lasso-active']],
    ];
    segmented.forEach(([containerSel, itemSel, activeClasses]) => {
      document.querySelectorAll(containerSel).forEach((container) => {
        setupSlidingLens(container, itemSel, 'segmented-glass-lens', { activeClasses });
      });
    });
    // `.history-toolbar` is deliberately not in that list. Its buttons are
    // actions, not a selection, and a lens sliding under them announced a
    // "currently selected" state that does not exist.

    // Nothing is bound as a draggable capsule here, and that is deliberate.
    //
    // `.calc-toolbar`, `.pdf-page-bar`, `.hw-toolbar` and `.pdf-ws-ratio-badge`
    // were draggable once, and none of them is a movable surface in the product
    // spec: nothing persisted where they were left, nothing defined what a reset
    // meant, and the gesture competed for the pointer with PDF panning and
    // zooming, page navigation and handwriting — on the exact surfaces where
    // those gestures matter most.
    //
    // `.ink-card` was the last one left, and it goes for the same reason. The
    // spec authorises movement for the ink *toolbar* (§ UI/UX 415-444) and then
    // requires the tool-setting card to stay anchored beside it (line 483,
    // acceptance line 685). A draggable card contradicts that, and it claimed
    // the gesture with `touch-action: none` on a surface the spec says does not
    // move. Reinstating it needs the spec to define movement, reset, whether the
    // position persists, the collision bounds and who owns the gesture first.
    //
    // The ink toolbar itself is absent for a different reason: it owns a
    // placement model of its own (edge + offset, persisted, with a
    // collapse-to-token drag) and a second drag handler would fight it for the
    // same pointer.
  };

  bind();

  // These elements are built on demand — the ink card only exists while a card
  // is open, the calculator only on its page. Binding once at boot silently
  // missed every one of them. A mutation observer catches them as they arrive.
  let bindQueued = false;
  const bindObserver = new MutationObserver(() => {
    if (bindQueued) return;
    bindQueued = true;
    requestAnimationFrame(() => { bindQueued = false; bind(); });
  });
  bindObserver.observe(document.body, { childList: true, subtree: true });

  const onResize = () => {
    document.querySelectorAll('.bottom-nav, .recog-tabs, .mode-tabs, .settings-tabs, .cam-mode-bar')
      .forEach(c => c._relayoutLens?.());
  };
  window.addEventListener('resize', onResize, { passive: true });

  // ── reduced motion ────────────────────────────────────────────────────────

  // There is no pointer-tracked lighting here any more.
  //
  // Every glass surface used to read `--glass-x` / `--glass-y` / `--glass-angle`
  // from a rAF-batched pass that ran on every pointermove, so a catchlight
  // followed the cursor across the chrome. It went, for two reasons. On a
  // tablet driven by a stylus and a thumb there is no persistent cursor for a
  // highlight to track, so the effect mostly fired while the user was reaching
  // for something else; and the pass walked a cached element list calling
  // getBoundingClientRect on each entry, on the same main thread as the stroke
  // pipeline. Glass keeps its rim, bevel and cast shadow — the parts that are
  // properties of the material rather than of where the mouse happens to be.
  //
  // What survives is the live reduced-motion flag, because the tap ripple below
  // still has to answer to it.

  const onMotionChange = () => { reduced = motionQuery ? motionQuery.matches : false; };
  if (motionQuery) {
    try {
      motionQuery.addEventListener('change', onMotionChange);
    } catch (_) {
      motionQuery = null; // No change events here; the boot-time value stands.
    }
  }

  // ── press feedback ────────────────────────────────────────────────────────

  // A press still held when the module is torn down owns two window listeners;
  // teardown runs its release so nothing outlives it.
  const pendingReleases = new Set();

  const onPointerDown = (e) => {
    if (!skinActive() || isDrawingPointer(e)) return;

    const pressed = e.target.closest(PRESSABLE);
    if (!pressed) return;

    pressed.classList.add('liquid-bulge-press');
    const release = () => {
      pressed.classList.remove('liquid-bulge-press');
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      pendingReleases.delete(release);
    };
    pendingReleases.add(release);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);

    // Read live, not from a snapshot: a ripple is decoration and has to stop
    // the moment the preference is turned on.
    if (reduced) return;

    const target = e.target.closest(RIPPLE_TARGETS);
    if (!target) return;

    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Size the wave to reach the farthest corner and stop. The previous
    // fixed scale(45) on a 12px seed produced a 540px disc regardless of the
    // control it came from, which on a 34px tool button washed out the screen.
    const reach = Math.max(
      Math.hypot(x, y),
      Math.hypot(rect.width - x, y),
      Math.hypot(x, rect.height - y),
      Math.hypot(rect.width - x, rect.height - y),
    );

    const ripple = document.createElement('span');
    ripple.className = 'liquid-ripple-wave';
    ripple.style.setProperty('--ripple-size', `${Math.ceil(reach * 2)}px`);
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    target.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    setTimeout(() => ripple.remove(), 900);
  };
  window.addEventListener('pointerdown', onPointerDown, { passive: true });

  teardown = () => {
    bindObserver.disconnect();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointerdown', onPointerDown);
    if (motionQuery) {
      try { motionQuery.removeEventListener('change', onMotionChange); } catch (_) { /* never attached */ }
    }
    for (const release of [...pendingReleases]) release();
  };
}

/** Gives back every listener and observer initLiquidGlass() took. */
export function destroyLiquidGlass() {
  teardown?.();
  teardown = null;
  isInitialized = false;
}
