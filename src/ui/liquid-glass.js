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

import { createLensMotion, LENS_MOTION, PLAIN_LENS_MOTION } from './lens-motion.js';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const DRAG_THRESHOLD = 4;
/**
 * 横着的那几种（两个标签、分段控件）要走多远才定方向。和顶上那一排的收起手势
 * （pdf-workspace-ui.js 的 DRAG_START）是同一个数、同一条规矩：过了这么远，竖着走得
 * 多的归收起，横着走得多（或一样多）的归这里。两边在同一个事件上各自下结论，结论正好
 * 互补——不会一个在滑透镜、一个在收那一排。
 */
const AXIS_DECIDE = 10;

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

// ── the sliding lens ────────────────────────────────────────────────────────

/**
 * Shared controller for both sliding lenses.
 *
 * @param {HTMLElement} container element the lens rides inside
 * @param {string} itemSelector   the items it snaps between
 * @param {string} lensClass      class of the lens element to create
 * @param {{vertical?: boolean, activeClasses?: string[], tintFollows?: boolean}} [opts]
 *   tintFollows：字的颜色跟着透镜走（见下面的 paintCover）。
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

  const activeItem = () => container.querySelector(activeSelector) || items[0];

  // 怎么动归 lens-motion.js：人给的那段录屏（「照片 | 图集」那枚胶囊）逐帧量出来、拟合出来的几根
  // 弹簧——按住缩一点、进了另一格浮起来弹过去、走的时候顺着方向拉长、松手像一滴水落定。这里每一帧
  // 推它一步，把它给的位置和大小写到透镜上。样式表里 left / width 那几条过渡用不上了：留着它们会和
  // 逐帧写的位置抢。
  const motion = createLensMotion({ vertical: !!opts.vertical });
  lens.style.transition = 'none';
  // 纸里只是普通地滑：按住不缩、划的时候跟着手指走、松手（或者点了另一格）平平地滑到那一格上，不浮、不拉长。人说「纸的状态
  // 下就不要那个按钮动画了，普通滑动即可」——纸上的透镜是钢笔划的一道线，压扁、拉长只像是画歪了。每次动之前现看一眼皮肤：
  // 皮肤随时会换。
  const plain = () => document.documentElement.getAttribute('data-skin') === 'minimal';
  /** 透镜此刻去的那一格。 */
  let homeItem = null;
  /** 划着的时候手指在哪一格上：透镜跟着它一格一格地跳。 */
  let dragItem = null;

  // ── 字的颜色跟着透镜走 ──
  //
  // 人说「胶囊按钮完全离开字时，字的蓝色也该结束，消失或去到另一个字」：原来蓝色挂在选中的
  // 那一格（.active）上，按住透镜划到另一格、或者点了另一格透镜还在路上，蓝色早就（或者还）
  // 在那一格上，和透镜对不上。现在每一格记一个 --lens-cover：透镜此刻盖住它的字多少（0～1）；
  // 样式按它在蓝和灰之间调（liquid.css 的 .app-nav button）。完全离开是 0——灰；整个盖住是 1——蓝。
  // 量的是字（和前面那个图标）实际画在哪，不是整颗按钮：按钮比字宽一截内边距，透镜离开按钮
  // 的边时，字早就没被盖着了。
  const tintFollows = !!opts.tintFollows;
  const contentOf = (item) => {
    try {
      const range = document.createRange();
      range.selectNodeContents(item);
      const r = range.getBoundingClientRect();
      if (r && r.width > 0) return r;
    } catch (_) { /* 没有 Range 的地方：退回整颗按钮 */ }
    return item.getBoundingClientRect();
  };
  // 每一格的字在容器里横着占哪一段：开始动的时候量一次，动着的每一帧拿透镜此刻的位置（算出来的，
  // 不是量出来的）去比——一帧里不读排版。
  let coverBoxes = null;
  const measureCover = (cRect) => {
    if (!tintFollows) return;
    coverBoxes = items.map((item) => {
      const b = contentOf(item);
      return { left: b.left - cRect.left, right: b.right - cRect.left, width: b.width };
    });
  };
  const paintCover = (r) => {
    if (!tintFollows || !coverBoxes) return;
    items.forEach((item, i) => {
      const b = coverBoxes[i];
      const covered = Math.max(0, Math.min(r.left + r.width, b.right) - Math.max(r.left, b.left));
      const cover = b.width > 0 ? Math.min(1, covered / b.width) : 0;
      item.style.setProperty('--lens-cover', String(Math.round(cover * 1000) / 1000));
    });
  };

  // 按 0.1px 取整、没变就不写。平板上 WebView 每一帧都把整页的玻璃重画一遍（十几层磨砂和折射，一帧二三十毫秒），
  // 透镜哪怕只挪了零点零几像素，那一帧也得整页重画——落定前那一截肉眼看不见的零头，少写一次就少画一帧。
  const px = (v) => `${Math.round(v * 10) / 10}px`;
  const draw = () => {
    const r = motion.rect();
    const next = [px(r.left), px(r.top), px(r.width), px(r.height)];
    const s = lens.style;
    if (s.left === next[0] && s.top === next[1] && s.width === next[2] && s.height === next[3]) return;
    s.left = next[0];
    s.top = next[1];
    s.width = next[2];
    s.height = next[3];
    paintCover(r);
  };

  // 逐帧推，停下来就不再要帧：没在动的时候这里一帧都不花。动着的时候容器上挂 data-lens-moving——
  // liquid-glass-react.js 等它摘掉才把玻璃换回静止时那一版（STILL_MOVING）。挂的是属性不是类：类一变，
  // 盯着类的那几个 MutationObserver（这里的、液态玻璃挂层的）都要醒一次，一次动画两回，白花工夫。
  let frame = 0;
  let lastTime = 0;
  const tick = () => {
    frame = 0;
    // 用 performance.now()，不用 rAF 递进来的那个时间戳：两个时钟起点不一定是同一个（测试里的 jsdom
    // 就不是），混着减会差出几百毫秒。
    const t = performance.now();
    motion.step(Math.min(1 / 20, Math.max(1 / 240, (t - lastTime) / 1000)));
    lastTime = t;
    const r = motion.rect();
    const broken = !Number.isFinite(r.left + r.top + r.width + r.height);
    if (broken || motion.settled()) {
      motion.snap();
      draw();
      container.removeAttribute('data-lens-moving');
      return;
    }
    draw();
    frame = requestAnimationFrame(tick);
  };
  const run = () => {
    if (reduced) { motion.snap(); draw(); return; }
    motion.setParams(plain() ? PLAIN_LENS_MOTION : LENS_MOTION);
    container.setAttribute('data-lens-moving', '');
    if (frame) return;
    // 告诉液态玻璃「又在动了」：换成手在屏幕上时那一版（只弯一次），等透镜停了再换回色散版。不说的话——按着不动那半秒里
    // 玻璃已经判定静止、换回了色散版，松手后透镜一回弹，平板上每一帧都用色散版整页重画，一帧 110ms（实测）。
    window.dispatchEvent(new Event('glassbusy'));
    lastTime = performance.now();
    frame = requestAnimationFrame(tick);
  };

  /** 这一格在容器里的位置；还没排版（量出来是 0）就是 null。 */
  const rectOf = (item, cRect) => {
    const r = item.getBoundingClientRect();
    if (cRect.width === 0 || r.width === 0) return null;
    return { left: r.left - cRect.left, top: r.top - cRect.top, width: r.width, height: r.height };
  };

  const place = (target, immediate = false) => {
    // A user-driven drag owns the lens until it lets go.
    if (isSliding) return;
    const item = target || activeItem();
    if (!item) return;

    const cRect = container.getBoundingClientRect();
    // Before first layout every rect is zero; placing then would stick the
    // lens in the corner, and the spring would fling it out from there.
    const rect = rectOf(item, cRect);
    if (!rect) return;
    homeItem = item;
    measureCover(cRect);

    // 当场到位：头一次摆、减少动态、没在动的时候尺寸变了。
    //
    // 动着的时候来一声「当场重摆」不跳：接着弹，只把终点改到量出来的新位置上。人说「这个条点击选择
    // 时也做滑过去的动画」：从设置点回练习，同一帧里顶上那一排从藏着变成露出来，top-bar-fit 量完就
    // 叫一声重摆（_relayoutLens）；原来那一声会把滑到一半的透镜一帧摁到终点。同样会来叫的还有工作区
    // 发的 resize、哪一格尺寸变了（ResizeObserver）。
    if (!motion.placed || reduced || (immediate && !frame)) {
      motion.set(rect);
      draw();
      return;
    }
    motion.target(rect);
    run();
  };

  // Follow the active item wherever it is set from — the app's own routing, a
  // keyboard activation, a restored session. The lens never sets it itself.
  //
  // 容器自己、透镜自己换类不算（液态玻璃给透镜挂上 lgr 那几个类、顶上那一排给胶囊挂的状态）：那不是
  // 选中的换了。
  const observer = new MutationObserver((records) => {
    if (isSliding) return;
    if (records.every((r) => r.target === container || r.target === lens)) return;
    place();
  });
  observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['class'] });

  const relayout = () => place(null, true);
  // Two frames: one for the class to land, one for layout to settle under it.
  requestAnimationFrame(() => requestAnimationFrame(relayout));
  window.addEventListener('resize', relayout, { passive: true });
  // 容器或者哪一格自己变了大小——从藏着到露出来（找页面板打开）、换了皮肤、换了语言——
  // 当场重摆，不演。原来只听窗口的 resize：这几种时候透镜停在旧的地方，等下一次点才滑
  // 过去，看上去就是选中的那一格底色「晃了一下」。ResizeObserver 在排完版、画出来之前
  // 回调，摆完正好赶上这一帧。
  if (typeof ResizeObserver === 'function') {
    const sizeWatch = new ResizeObserver(() => { if (!isSliding) relayout(); });
    sizeWatch.observe(container);
    items.forEach((item) => sizeWatch.observe(item));
  }
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

  /** 这一点在不在透镜上（透镜此刻画在哪，按算出来的）。 */
  const onLens = (x, y) => {
    if (!motion.placed) return false;
    const cRect = container.getBoundingClientRect();
    const r = motion.rect();
    const lx = x - cRect.left;
    const ly = y - cRect.top;
    return lx >= r.left && lx <= r.left + r.width && ly >= r.top && ly <= r.top + r.height;
  };

  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    isTracking = true;
    isSliding = false;
    capturedId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dragItem = homeItem || activeItem();
    // 按在透镜上：它开始缩（录屏里按住它，它就一点一点缩下去）。按在别的格上：透镜不在手指底下，
    // 不缩——点一下，它等 app 换了选中再弹过去。纸里不缩。
    if (!reduced && !plain() && onLens(e.clientX, e.clientY)) {
      motion.press(true);
      run();
    }
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
      if (opts.vertical) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      } else {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_DECIDE) return;
        // 竖着走的不是在挑：顶上那两个标签上是在拉那一排（initChromeHiding），面板里
        // 是在滚。放手，而且要在拿指针之前放——拿了，后面整段都改道到这里，松手还会
        // 替人点一下最近的那一格（顶上那两个就是换页）。按在透镜上缩下去的那一点也还回去。
        if (Math.abs(dy) > Math.abs(dx)) {
          isTracking = false;
          capturedId = null;
          if (motion.pressed) { motion.press(false); run(); }
          return;
        }
      }
      isSliding = true;
      try { container.setPointerCapture(capturedId); } catch (_) { /* not capturable */ }
    }

    // 纸里：透镜跟着手指走（和选中那一格一样大，不出容器），松手再滑到最近的那一格上（onPointerEnd）。
    if (plain()) {
      const c = container.getBoundingClientRect();
      const home = rectOf(homeItem || activeItem(), c);
      if (!home) return;
      const at = { ...home };
      if (opts.vertical) {
        at.top = Math.max(0, Math.min(c.height - home.height, e.clientY - c.top - home.height / 2));
      } else {
        at.left = Math.max(0, Math.min(c.width - home.width, e.clientX - c.left - home.width / 2));
      }
      motion.set(at);
      draw();
      return;
    }

    // 手指进了另一格：透镜浮起来，自己弹过去（录屏里手指快慢不一，它走的都是同一条曲线）。手指在
    // 它自己那一格里挪，它不动——不跟着手指一寸一寸地走。
    const cRect = container.getBoundingClientRect();
    const item = nearestItem(e.clientX - cRect.left, e.clientY - cRect.top);
    if (!item || item === dragItem) return;
    const rect = rectOf(item, cRect);
    if (!rect) return;
    dragItem = item;
    homeItem = item;
    measureCover(cRect);
    if (reduced) {
      motion.set(rect);
      draw();
      return;
    }
    motion.press(true);
    motion.lift(true);
    motion.target(rect);
    run();
  });

  const onPointerEnd = (e) => {
    if (!isTracking || e.pointerId !== capturedId) return;
    const wasSliding = isSliding;

    isTracking = false;
    isSliding = false;
    try { container.releasePointerCapture(capturedId); } catch (_) { /* never taken */ }
    capturedId = null;
    // 松手：浮起来时扁下去的、按住时缩下去的，都回去（高度 0.2 秒上下回来，宽度慢一点——落定时先窄
    // 一点再回到原样）。
    motion.press(false);
    motion.lift(false);

    if (wasSliding) {
      const cRect = container.getBoundingClientRect();
      const target = nearestItem(e.clientX - cRect.left, e.clientY - cRect.top);
      // Exactly one click, and only for a drag. A tap is left entirely alone:
      // the browser's own click is already on its way to the item, and the
      // previous version's extra .click() here made every tap fire twice —
      // which on a toggle meant it visibly undid itself.
      if (target && !activeClasses.some(c => target.classList.contains(c))) target.click();
      place(target);
    } else {
      place();
    }
    if (motion.placed) run();
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
  '.action-btn',
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
    // 字的颜色跟着透镜走（透镜离开哪一格，那一格的蓝就退掉；盖到哪一格，哪一格就蓝）。
    setupSlidingLens(document.querySelector('.app-nav'), 'button', 'nav-glass-lens', { tintFollows: true });
    // 顶上左边那枚胶囊（导入、文档库、组合、新建纸张）只能点，不能划：人说「左上方那个菜单栏把滑
    // 动选择去掉」。划着挑搬到了笔迹工具栏上（ink-toolbar.js 的 _installScrub）。

    const segmented = [
      ['.recog-tabs', '.mode-tab'],
      ['.mode-tabs', '.mode-tab'],
      ['.settings-tabs', '.settings-tab'],
      // 找页面板顶上那三页（目录、缩略图、书签）：和顶上那两个标签一样，点和划都行。
      // 面板是打开时才造的，造出来那一刻被下面那个 MutationObserver 接住。
      ['.pdf-panel-tabs', '.pdf-panel-tab', ['is-selected']],
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
    document.querySelectorAll('.app-nav, .settings-tabs')
      .forEach(c => c._relayoutLens?.());
  };
  window.addEventListener('resize', onResize, { passive: true });
  // 换皮肤：每一块透镜当场按新的尺寸摆好（settings.js 换完皮肤就发这一声）。
  const onSkin = () => {
    document.querySelectorAll('.app-nav, .settings-tabs, .pdf-panel-tabs, .mode-tabs, .recog-tabs, .cam-mode-bar')
      .forEach(c => c._relayoutLens?.());
  };
  window.addEventListener('skinchange', onSkin);

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
    // 挂着 liquid-glass-react 那几层的按钮（.lgr）按下去由那边管：缩到 0.96、亮光打满。
    // 这里的鼓起和水波纹再叠一层就是两套按压；水波纹的 mix-blend-mode 还会让整块玻璃
    // 自成一组，里面那层看不到背后。
    if (pressed.classList.contains('lgr')) return;

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
    window.removeEventListener('skinchange', onSkin);
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
