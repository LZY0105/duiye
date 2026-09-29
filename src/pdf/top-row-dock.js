// top-row-dock.js — 顶上那一排里给工具栏留的地方，和它点开时把两边挤开的那一段。
//
// 那一排是三枚胶囊：左边（导入、文档库、组合、新建纸张）、正中「练习 / 设置」、右边
// 「全部关闭」。它们之间有两处空当，工具栏可以拖进去停着：
//
//   · 收着：一颗和这一排一样高的球，停在两处空当里人放下它的那个地方（不是空当的
//     正中）。它也会推：贴上正中那两个标签，就把标签往另一边推，推到标签贴住另一边
//     那枚胶囊为止，再往前球就过不去了；
//   · 点开：整条横躺在这一排里。它比空当宽，于是往两边长——长到碰上邻居，才把邻居
//     推开：没碰上的不动，碰上了就被它推着走，一个像素都不多推。
//
// 拖着球在这一排里走（beginDrag）：球贴着这一排横着走，碰上标签就推着它走；标签被
// 推到头之后手指再越过标签的正中，球就翻到标签另一边去，从那边推。进这一排、出这一
// 排、翻到另一边，这几下目标位置是跳的，跳的那一截由一个临界阻尼的弹簧吃掉——球和
// 标签都是滑过去的；平时手指走多少球走多少，不拖泥带水。
//
// 推的是正中那两个标签（它是这一排里唯一能挪的一枚）：左边那枚贴着屏幕左边、右边
// 那枚贴着屏幕右边，没地方可退。所以横杠往一侧长的时候，碰上那一侧贴边的胶囊就长
// 不过去了，只好往另一侧多长一点，把标签推得更远。右边「全部关闭」前面的状态字是软
// 的：挤到它，它就省略掉一截，不挡横杠。
//
// 这一层只管量和挤，不管横杠里面有什么：横杠（src/ink/ink-toolbar.js）问它「停哪儿、
// 点开有多少地方」，它回答；点开、收起的那一段动画也由它来演，因为每一帧要同时摆横
// 杠露出来的那一截和被推开的邻居，两样必须是同一个数算出来的。
//
// 所有坐标都是视口坐标（getBoundingClientRect）：标签是 fixed 的，停在这一排里的
// 横杠也是 fixed 的，两枚贴边的胶囊在页面里——拿视口坐标比，三样东西才在同一把尺子上。

/** 横杠和邻居之间留的缝：和这一排里胶囊之间的缝一样宽。 */
export const PERCH_GAP = 12;

/** 收起来那颗球多大：和这一排的胶囊一样高。 */
export const PERCH_BALL = 44;

/** 点开那一段多长、收起那一段多长。收得比开得快一点：离开不值得和到来一样多的时间。 */
export const PERCH_OPEN_MS = 460;
export const PERCH_CLOSE_MS = 380;

/** 松手之后被推开的标签回家那一段。 */
const RELEASE_MS = 320;

/**
 * 拖着球往上走，离这一排下沿多近就被这一排接住：大约是两栏栏头那么高。人说「工具栏
 * 靠近顶上就该自己吸进那一排」，不该停在栏头底下横着展开。
 */
export const ROW_REACH = 96;

/** 已经在这一排里了，要往下拖出这么远才算离开：比接住的那一截多一点，边界上不来回跳。 */
export const ROW_LEAVE = 124;

/**
 * 吃掉那一截跳变的弹簧：临界阻尼，周期约 0.34 秒——到位不回弹，也不拖尾。
 * 取精确解，不按步长积分：帧间隔忽长忽短也稳。
 */
const SPRING_OMEGA = (2 * Math.PI) / 0.34;

/**
 * 临界阻尼弹簧往前走 dt 秒：x 是离目标还差多少，v 是速度。
 *
 * @returns {[number, number]} 走完之后的 [x, v]
 */
export function springStep(x, v, dt, w = SPRING_OMEGA) {
  const e = Math.exp(-w * dt);
  const k = v + w * x;
  return [(x + k * dt) * e, (v - w * k * dt) * e];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * CSS 的 cubic-bezier，拿来在 JS 里逐帧算同一条曲线。
 *
 * 这一段动画是 JS 逐帧摆的（横杠露出来那一截和被推开的标签必须同一帧、同一个数），
 * 用的曲线和这个应用里别的动作是同一条（0.32, 0.72, 0, 1）——弹簧那种快进慢停。
 */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // 牛顿法，几步就够；斜率太小的地方退回二分。
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-5) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

export const SPRING_EASE = cubicBezier(0.32, 0.72, 0, 1);

/**
 * 收起用的曲线：两头慢、中间快。弹簧那条收起来尾巴太长——平板上一帧一帧看，空了的
 * 那块玻璃在球那儿磨蹭了 0.3 秒才停。点开照旧用弹簧：落到位的那一下最该被看见。
 */
export const STANDARD_EASE = cubicBezier(0.4, 0, 0.2, 1);

/**
 * 两处空当。rects 是三枚胶囊「在家」的位置（被推开之前）和这一排左右两头。
 *
 * @param {{lead: DOMRect, nav: DOMRect, end: DOMRect, row: {left: number, right: number}}} rects
 */
export function perchGaps(rects, g = PERCH_GAP) {
  const { lead, nav, end } = rects;
  return {
    left: { left: lead.right + g, right: nav.left - g },
    right: { left: nav.right + g, right: end.left - g },
  };
}

/**
 * 标签一侧的球能走的那一段（球左沿的取值范围）。
 *
 * 标签能被推，推到贴住另一边那枚胶囊为止；贴边的两枚不动。所以：
 *   · 左边那一侧：从左边那枚后面一道缝起，到「标签 + 两道缝 + 全部关闭」之前；
 *   · 右边那一侧：从「左边那枚 + 缝 + 标签 + 缝」起，到「全部关闭」前面一道缝。
 * 连一颗球都放不下就是 null。
 */
export function ballTrack(side, rects, size = PERCH_BALL, g = PERCH_GAP) {
  const { lead, nav, end, row } = rects;
  const navW = nav.right - nav.left;
  const leadRight = Math.max(lead.right, row.left);
  const endLeft = Math.min(end.left, row.right);
  const lo = side === 'right' ? leadRight + g + navW + g : leadRight + g;
  const hi = side === 'right' ? endLeft - g - size : endLeft - g - navW - g - size;
  return hi >= lo ? { lo, hi } : null;
}

/** 球的中心想在 cx：放进那一侧能走的那一段里，和这一排竖着居中。 */
export function ballAt(side, cx, rects, size = PERCH_BALL, g = PERCH_GAP) {
  const track = ballTrack(side, rects, size, g);
  if (!track) return null;
  const left = clamp(cx - size / 2, track.lo, track.hi);
  const cy = (rects.lead.top + rects.lead.bottom) / 2;
  const top = cy - size / 2;
  return { left, top, width: size, height: size, right: left + size, bottom: top + size };
}

/**
 * 手指在 x 处，球该在标签的哪一侧。
 *
 * 刚进这一排（current 为空）：看手指在标签正中的哪一边。已经在这一排里了：留在原
 * 来那一侧——球推着标签走的时候，手指在球上，永远到不了标签的正中；只有标签被推到
 * 头、球停住了、手指还往前，越过了标签此刻的正中（navShift 是它此刻被推开了多少），
 * 才翻到另一侧去。某一侧连一颗球都放不下，就只剩另一侧；两侧都不行是 null。
 */
export function rowSideFor(x, rects, current = null, navShift = 0, size = PERCH_BALL, g = PERCH_GAP) {
  const left = ballTrack('left', rects, size, g);
  const right = ballTrack('right', rects, size, g);
  if (!left && !right) return null;
  if (!left) return 'right';
  if (!right) return 'left';
  const center = (rects.nav.left + rects.nav.right) / 2 + (current ? navShift : 0);
  if (current === 'left') return x > center ? 'right' : 'left';
  if (current === 'right') return x < center ? 'left' : 'right';
  return x < center ? 'left' : 'right';
}

/**
 * 收起来那颗球的位置。
 *
 * at 是人放下它的地方：球心在这一排里的比例（0 在左头、1 在右头）——按比例记，窗
 * 口转了、胶囊宽了窄了，它还在差不多的地方。没有 at（老的存档）就停在那处空当的
 * 正中。都放进那一侧能走的那一段里：放得太靠标签，标签就被推开。
 */
export function ballBox(perch, rects, size = PERCH_BALL, g = PERCH_GAP, at = null) {
  let cx;
  if (Number.isFinite(at)) {
    cx = rects.row.left + at * (rects.row.right - rects.row.left);
  } else {
    const gap = perchGaps(rects, g)[perch];
    if (!gap) return null;
    cx = (gap.left + gap.right) / 2;
  }
  return ballAt(perch, cx, rects, size, g);
}

/** 球心在这一排里的比例，ballBox 的 at 就是它。 */
export function rowFraction(cx, rects) {
  const span = rects.row.right - rects.row.left;
  return span > 0 ? clamp((cx - rects.row.left) / span, 0, 1) : 0.5;
}

/**
 * 点开之后横杠躺在哪儿、有多宽。
 *
 * 能用的那一段是：挤到极限之后还空着的地方——能挪的只有标签，贴边的两枚不动：
 *   · 右边那处：左界是「左边那枚 + 缝 + 标签 + 缝」，右界是「全部关闭」前面一道缝；
 *   · 左边那处：左界是左边那枚后面一道缝，右界是「标签 + 两道缝 + 全部关闭」之前。
 * 横杠要它想要的宽度（和这一排一样高时的那个宽度），给不了就给到能给的，再不行
 * （连最窄也放不下）就是 null——那时它不在这一排里点开，挂到这一排下面去。
 * 位置尽量以球为中心，靠边了就往另一边让。
 *
 * @param {'left'|'right'} perch
 * @param {{preferred: number, min: number, center: number}} bar
 * @returns {{left: number, right: number, width: number}|null}
 */
export function solvePerch(perch, rects, bar, g = PERCH_GAP) {
  const { lead, nav, end, row } = rects;
  const navW = nav.right - nav.left;
  const endW = end.right - end.left;
  const leadRight = Math.max(lead.right, row.left);
  let lo;
  let hi;
  if (perch === 'right') {
    lo = leadRight + g + navW + g;
    hi = row.right - endW - g;
  } else {
    lo = leadRight + g;
    hi = row.right - endW - g - navW - g;
  }
  const room = hi - lo;
  if (!(room >= bar.min)) return null;
  const width = Math.min(bar.preferred, room);
  const left = clamp(bar.center - width / 2, lo, hi - width);
  return { left, right: left + width, width };
}

/**
 * 横杠两条边此刻在哪儿，邻居就被推到哪儿。
 *
 * 只在真的碰上的时候推：标签离横杠还有缝，就一动不动。每一帧都拿横杠此刻露出来那
 * 一截的边来算，所以标签是被它「推着走」的，不是另起一段自己的动画。
 *
 * @returns {{navShift: number, trailMax: number}}
 *   navShift 标签要挪多少（负是往左）；trailMax 右边那一格（状态字＋全部关闭）最多
 *   能有多宽，状态字超出的部分省略掉。
 */
export function pushFor(perch, rects, edges, g = PERCH_GAP) {
  const { nav, row } = rects;
  if (perch === 'right') {
    const navRight = Math.min(nav.right, edges.left - g);
    return { navShift: navRight - nav.right, trailMax: row.right - (edges.right + g) };
  }
  const navLeft = Math.max(nav.left, edges.right + g);
  const shift = navLeft - nav.left;
  return { navShift: shift, trailMax: row.right - (nav.right + shift + g) };
}

/**
 * 一个元素排版上停在哪儿（视口坐标），不算任何 transform / translate / scale。
 *
 * 量的是「在家」的位置：标签被推开时带着 translate，切页时两枚胶囊带着收拢的动画，
 * 收起顶栏时整排带着上移的 transform——拿 getBoundingClientRect 量，量到的是这一帧
 * 画在哪儿，拿它去算「推多少」会越推越偏。这一页不滚动，offset 一路加上去就是视口
 * 坐标。
 */
export function layoutRect(el) {
  let left = 0;
  let top = 0;
  let node = el;
  while (node) {
    left += node.offsetLeft || 0;
    top += node.offsetTop || 0;
    node = node.offsetParent;
  }
  const width = el.offsetWidth || 0;
  const height = el.offsetHeight || 0;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/**
 * 页面那一层的这一排。横杠拿它来问位置、演动画。
 *
 * @param {HTMLElement} elRoot 练习页（#page-pdf）
 * @param {{body?: HTMLElement, measure?: function}} [opts]
 *   measure 量「在家」的位置，默认 layoutRect；测试里换成手写的矩形。
 */
export function initTopRowDock(elRoot, { body = document.body, measure = layoutRect } = {}) {
  const bar = elRoot?.querySelector?.('.pdf-page-bar');
  const nav = document.querySelector('.app-nav');
  const lead = bar?.querySelector('.pdf-bar-group:not(.is-end)') || null;
  const trail = bar?.querySelector('.pdf-bar-trail') || null;
  const end = trail?.querySelector('.pdf-bar-group.is-end') || null;
  if (!bar || !nav || !lead || !trail || !end) return null;

  /** 标签此刻被推开了多少（行内的 translate 就是它）。量「在家」的位置要把它减回去。 */
  let navShift = 0;
  let anim = 0;
  /** 横杠此刻露出来那一截的两条边，动画被打断时从这儿接着演。 */
  let edgesNow = null;
  const listeners = new Set();

  const hint = document.createElement('div');
  hint.className = 'top-row-perch-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.hidden = true;
  elRoot.appendChild(hint);

  /**
   * 量过的那一份。拖着工具栏经过这一排时，每一次 pointermove 都要问「在不在这一排
   * 里」——笔一秒报一百多次，每次都去量四个元素就是每次都逼浏览器当场排版。那一排
   * 只在窗口变了、胶囊宽了窄了、换了页的时候才会变，那几件事都有人告诉这里（见文件
   * 末尾的两个观察器），告诉了才重量。
   */
  let cached = null;
  const invalidate = () => { cached = null; };

  /** 这一排此刻能不能停东西：在练习页上、没开专注、量得到尺寸。 */
  const available = () => {
    if (body.dataset.page && body.dataset.page !== 'pdf') return false;
    if (body.classList.contains('is-scratch-focus')) return false;
    const r = rects().row;
    return r.right - r.left > 0;
  };

  /** 书架开着的时候这一排被盖着，停在这儿的横杠也看不见。 */
  const shownNow = () => available() && !body.classList.contains('is-library-open');

  /** 这一排被往上收起来了（pdf-workspace-ui.js 的 initChromeHiding 挂的 is-top-hidden）。 */
  const away = () => body.classList.contains('is-top-hidden');

  /**
   * 三枚胶囊在家的位置，和这一排的左右两头。
   *
   * 竖着的位置一律按标签算：它是 fixed 的，收起顶栏时只挪 transform，排版上永远停在
   * 那一行；横杠停在这一排里也是 fixed 的，和它按同一个上下居中、跟着同一个 transform
   * 走。左右按两枚胶囊实际排在哪儿。
   */
  const rects = () => cached || (cached = measureRects());
  const measureRects = () => {
    const n = measure(nav);
    const l = measure(lead);
    const e = measure(end);
    const b = measure(bar);
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(bar) : null;
    const padL = parseFloat(style?.paddingLeft) || 0;
    const padR = parseFloat(style?.paddingRight) || 0;
    const h = l.height || n.height || PERCH_BALL;
    const cy = n.top + n.height / 2;
    const top = cy - h / 2;
    const bottom = cy + h / 2;
    return {
      lead: { left: l.left, right: l.right, top, bottom, width: l.width, height: h },
      nav: { left: n.left, right: n.right, top: n.top, bottom: n.bottom, width: n.width, height: n.height },
      end: { left: e.left, right: e.right, top, bottom, width: e.width, height: h },
      row: { left: b.left + padL, right: b.right - padR, top, bottom },
    };
  };

  const setNav = (shift) => {
    navShift = Math.round(shift * 10) / 10;
    nav.style.translate = navShift ? `${navShift}px 0` : '';
  };
  const setTrail = (max) => {
    trail.style.maxWidth = Number.isFinite(max) && max > 0 ? `${Math.floor(max)}px` : '';
  };

  /** 按横杠此刻两条边把邻居摆好。 */
  const apply = (perch, edges) => {
    if (!perch || !edges) { setNav(0); setTrail(NaN); return; }
    const push = pushFor(perch, rects(), edges);
    setNav(push.navShift);
    setTrail(push.trailMax);
  };

  const stop = () => {
    if (anim && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(anim);
    anim = 0;
    nav.classList.remove('is-pushed-live');
  };

  const reducedMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  };

  /**
   * 横杠露出来那一截：box 是它整条摆好之后的位置，edges 是这一帧露到哪儿，height
   * 是这一帧那一截有多高（球的高度到横杠的高度）。
   */
  const clip = (root, box, edges, height) => {
    const l = Math.max(0, edges.left - box.left);
    const r = Math.max(0, box.right - edges.right);
    const v = Math.max(0, (box.height - height) / 2);
    root.style.clipPath = `inset(${v}px ${r}px ${v}px ${l}px round ${height / 2}px)`;
  };

  const clearClip = (root) => {
    root.style.clipPath = '';
    root.style.removeProperty('--perch-reveal');
    root.classList.remove('is-perch-animating');
  };

  /** 这一排此刻接不接得住拖过来的球：在练习页上、没收起、书架没盖着。 */
  const catching = () => available()
    && !body.classList.contains('is-top-hidden')
    && !body.classList.contains('is-library-open');

  /** 手指在 y 处算不算在这一排里：已经在里面的，要多拖出一截才算离开。 */
  const reaches = (y, already) => {
    const r = rects();
    return y >= r.row.top - 60 && y <= r.row.bottom + (already ? ROW_LEAVE : ROW_REACH);
  };

  /** 同一时刻只有一路拖动。 */
  let session = null;

  /**
   * 拖着工具栏的那一路：从拿起到松手，球（fixed，按中心摆）和标签都由这里摆。
   *
   * 每一次 move 先算「目标」：在这一排外面，球的目标就是手指；在这一排里，球贴着这一
   * 排横着走（ballAt），标签的目标由球的目标推出来（pushFor）——目标里的球和标签永远
   * 紧挨着、不叠。画出来的是「目标 + 偏差」：平时偏差是 0，手指走多少球走多少；进出
   * 这一排、翻到标签另一边这几下，目标是跳的，跳的那一截记成偏差，交给弹簧慢慢吃掉。
   */
  const createSession = (root, { size = PERCH_BALL, side: side0 = null } = {}) => {
    let pointer = null;
    let inRow = false;
    let side = null;
    const aim = { x: 0, y: 0, nav: navShift, trail: NaN };
    const off = { x: 0, y: 0, nav: 0, vx: 0, vy: 0, vnav: 0 };
    let raf = 0;
    let last = 0;
    let ended = false;

    const setTarget = () => {
      if (inRow) {
        const r = rects();
        const box = ballAt(side, pointer.x, r, size);
        if (box) {
          aim.x = box.left + size / 2;
          aim.y = box.top + size / 2;
          const push = pushFor(side, r, { left: box.left, right: box.right });
          aim.nav = push.navShift;
          aim.trail = push.trailMax;
          return;
        }
        inRow = false;
        side = null;
      }
      aim.x = pointer.x;
      aim.y = pointer.y;
      aim.nav = 0;
      aim.trail = NaN;
    };

    const paint = () => {
      root.style.left = `${aim.x + off.x}px`;
      root.style.top = `${aim.y + off.y}px`;
      setNav(aim.nav + off.nav);
      setTrail(aim.trail);
    };

    const resting = () => Math.abs(off.x) < 0.25 && Math.abs(off.y) < 0.25 && Math.abs(off.nav) < 0.25
      && Math.abs(off.vx) < 2 && Math.abs(off.vy) < 2 && Math.abs(off.vnav) < 2;

    const step = (now) => {
      raf = 0;
      if (ended) return;
      const dt = last ? Math.min(0.05, Math.max(0.001, (now - last) / 1000)) : 1 / 60;
      last = now;
      [off.x, off.vx] = springStep(off.x, off.vx, dt);
      [off.y, off.vy] = springStep(off.y, off.vy, dt);
      [off.nav, off.vnav] = springStep(off.nav, off.vnav, dt);
      if (resting()) {
        off.x = off.y = off.nav = off.vx = off.vy = off.vnav = 0;
        last = 0;
        paint();
        return;
      }
      paint();
      raf = requestAnimationFrame(step);
    };

    const kick = () => {
      if (raf || ended) return;
      if (typeof requestAnimationFrame !== 'function' || reducedMotion()) {
        off.x = off.y = off.nav = off.vx = off.vy = off.vnav = 0;
        paint();
        return;
      }
      if (resting()) return;
      last = 0;
      raf = requestAnimationFrame(step);
    };

    /** 目标跳了：把跳的那一截记成偏差，画出来的位置这一帧不动，之后由弹簧吃掉。 */
    const retarget = (update) => {
      const shown = { x: aim.x + off.x, y: aim.y + off.y, nav: aim.nav + off.nav };
      update();
      setTarget();
      off.x = shown.x - aim.x;
      off.y = shown.y - aim.y;
      off.nav = shown.nav - aim.nav;
      root.classList.toggle('is-row-drag', inRow);
    };

    const locate = (x, y, preferred) => {
      if (!catching() || !reaches(y, inRow)) return { inRow: false, side: null };
      const r = rects();
      // 判翻不翻边，比的是「球留在原来那一侧、跟到这一点时，标签会被推到哪」的正中——
      // 不是上一帧的。手快的时候一帧能走几十像素，拿上一帧的去比，手指还在球上就会被
      // 当成越过了标签。
      let shift = 0;
      if (preferred) {
        const stay = ballAt(preferred, x, r, size);
        if (stay) shift = pushFor(preferred, r, { left: stay.left, right: stay.right }).navShift;
      }
      const s = rowSideFor(x, r, preferred, shift, size);
      return s ? { inRow: true, side: s } : { inRow: false, side: null };
    };

    const api = {
      get inRow() { return inRow; },
      get side() { return side; },
      /** 开始摆了、还没松手：这段时间里球的位置归这里。 */
      get live() { return !!pointer && !ended; },

      /**
       * 从哪儿拿起来的：x, y 是手指（视口坐标），from 是球此刻画在哪儿（拿起一颗停着的球
       * 时给，好让它从原地滑到手指底下，而不是一下子跳过去）。
       */
      start(x, y, from = null) {
        pointer = { x, y };
        const where = locate(x, y, side0);
        inRow = where.inRow;
        side = where.side;
        setTarget();
        const fx = from?.width ? from.left + from.width / 2 : aim.x;
        const fy = from?.height ? from.top + from.height / 2 : aim.y;
        off.x = fx - aim.x;
        off.y = fy - aim.y;
        off.nav = navShift - aim.nav;
        off.vx = off.vy = off.vnav = 0;
        nav.classList.add('is-pushed-live');
        root.classList.toggle('is-row-drag', inRow);
        paint();
        kick();
      },

      move(x, y) {
        if (ended || !pointer) return;
        pointer = { x, y };
        const where = locate(x, y, inRow ? side : null);
        if (where.inRow !== inRow || where.side !== side) {
          retarget(() => { inRow = where.inRow; side = where.side; });
        } else {
          setTarget();
        }
        paint();
        kick();
      },

      /**
       * 松手。落在这一排里：回答停在哪一侧、在这一排里的哪儿（at），标签此刻被推到的地方
       * 留着，剩下那一点由 settle 的过渡接上。没落在这一排里：标签回家。
       */
      end() {
        if (ended) return null;
        ended = true;
        if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        raf = 0;
        root.classList.remove('is-row-drag');
        if (session === api) session = null;
        if (!inRow || !side || !pointer) {
          dock.release({ animate: true });
          return null;
        }
        nav.classList.remove('is-pushed-live');
        return { perch: side, at: rowFraction(aim.x, rects()) };
      },

      /** 半路不要了（工具栏被拆了）：标签直接回家。 */
      cancel() {
        if (ended) return;
        ended = true;
        if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        raf = 0;
        root.classList.remove('is-row-drag');
        if (session === api) session = null;
        dock.release({ animate: false });
      },
    };
    return api;
  };

  const dock = {
    available,
    shown: shownNow,
    away,
    rects,

    /** 这一排整个收走要走多远：它在家时的下沿（收起就是一路往上走到下沿出屏）。 */
    travel() {
      return Math.max(0, rects().row.bottom) || PERCH_BALL;
    },

    /**
     * 这一排此刻走到哪儿了：0 在家，1 整个收走。按正中那两个标签此刻画在哪、和它在家的
     * 位置比——跟手拖着、松手后滑着，它都和这一排走同一个数。
     */
    progress() {
      const now = typeof nav.getBoundingClientRect === 'function' ? nav.getBoundingClientRect() : null;
      const home = rects().nav;
      const t = dock.travel();
      if (!now || !t) return away() ? 1 : 0;
      return clamp((home.top - now.top) / t, 0, 1);
    },

    /** 这一点（视口坐标）在不在这一排里；在的话，刚进来的球落在标签的哪一侧。 */
    zoneAt(x, y) {
      if (!catching() || !reaches(y, false)) return null;
      return rowSideFor(x, rects(), null, navShift);
    },

    /**
     * 松在 x 处（这一排外面，但离顶上够近）的球该停到哪儿：哪一侧、在这一排里的哪儿。
     * 这一排此刻接不住就是 null。
     */
    spotFor(x) {
      if (!catching()) return null;
      const r = rects();
      const side = rowSideFor(x, r, null, 0);
      const box = side ? ballAt(side, x, r) : null;
      return box ? { perch: side, at: rowFraction(box.left + box.width / 2, r) } : null;
    },

    ballBox(perch, size = PERCH_BALL, at = null) {
      if (!available()) return null;
      return ballBox(perch, rects(), size, PERCH_GAP, at);
    },

    /**
     * 拿起工具栏：从这一刻到松手，球和标签都归这一路摆（见 createSession）。
     * side 是它原来停在哪一侧（从这一排里拿起来的时候），好让它接着往原来那边推。
     */
    beginDrag(root, opts = {}) {
      session?.cancel();
      stop();
      hint.hidden = true;
      hint.classList.remove('is-on');
      session = createSession(root, opts);
      return session;
    },

    /**
     * 点开之后横杠的位置和缩放。model 是横杠自己量的：宽和高各是
     * 「不随缩放变的那部分 + 随缩放变的那部分 × 缩放」。
     *
     * @returns {{left, top, width, height, scale, inRow: boolean}|null}
     *   inRow 为 false：这一排挤不下，挂到这一排下面去（不推任何东西）。
     */
    layout(perch, model, { minScale = 0.62, at = null } = {}) {
      if (!available() || !model) return null;
      const r = rects();
      // 从球真正停着的地方长：球停在哪儿，横杠就以它为中心（点开的算法照旧）。
      const ball = ballBox(perch, r, PERCH_BALL, PERCH_GAP, at);
      if (!ball) return null;
      const rowH = r.lead.bottom - r.lead.top || PERCH_BALL;
      const widthAt = (s) => model.wFixed + model.wPer * s;
      const heightAt = (s) => model.hFixed + model.hPer * s;
      const preferredScale = clamp((rowH - model.hFixed) / (model.hPer || 1), minScale, 1);
      const center = (ball.left + ball.right) / 2;
      const cy = (r.lead.top + r.lead.bottom) / 2;
      const solved = solvePerch(perch, r, {
        preferred: widthAt(preferredScale),
        min: widthAt(minScale),
        center,
      });
      if (solved) {
        const scale = clamp((solved.width - model.wFixed) / (model.wPer || 1), minScale, preferredScale);
        const height = heightAt(scale);
        return { left: solved.left, top: cy - height / 2, width: solved.width, height, scale, inRow: true };
      }
      // 挤不下：挂在这一排下面，以球为中心，别出这一排的两头。
      const scale = preferredScale;
      const width = Math.min(widthAt(scale), r.row.right - r.row.left);
      const left = clamp(center - width / 2, r.row.left, r.row.right - width);
      return { left, top: r.row.bottom + 8, width, height: heightAt(scale), scale, inRow: false };
    },

    /** 静止时把邻居摆到位：球在哪处空当，状态字就别伸到它底下；点开的横杠照它的两条边推。 */
    settle(perch, edges) {
      stop();
      apply(perch, edges);
      edgesNow = edges;
    },

    /**
     * 点开 / 收起那一段。
     *
     * root 已经按点开之后的样子整条摆好了（box 是它的位置）；这里每一帧决定它露出
     * 来多少（clip-path，从球那么大到整条），里面的图标跟着淡入淡出，邻居按这一
     * 帧的两条边被推开或者放回来。被打断（点开到一半又收）就从这一帧接着往回演。
     *
     * @param {{perch, root, box, from, to, fromHeight, toHeight, duration, push, onDone}} o
     *   from / to 是露出来那一截的两条边（{left, right}）。push 为 false 时不推邻居
     *   （挂在这一排下面的那种）。
     */
    play({ perch, root, box, from, to, fromHeight, toHeight, duration, push = true, onDone, opening = true }) {
      // 上一段还在演（点开到一半又点了收起）：从它此刻露到的那两条边接着演，不从头来。
      const interrupted = !!anim && !!edgesNow;
      stop();
      const start = interrupted ? edgesNow : from;
      if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
        clearClip(root);
        if (push) apply(perch, to); else apply(null, null);
        edgesNow = to;
        onDone?.();
        return;
      }
      root.classList.add('is-perch-animating');
      nav.classList.add('is-pushed-live');
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const frame = (now) => {
        const t = clamp(((now ?? Date.now()) - t0) / duration, 0, 1);
        const e = (opening ? SPRING_EASE : STANDARD_EASE)(t);
        const edges = {
          left: start.left + (to.left - start.left) * e,
          right: start.right + (to.right - start.right) * e,
        };
        const height = fromHeight + (toHeight - fromHeight) * e;
        edgesNow = edges;
        clip(root, box, edges, height);
        // 图标晚一点出来、早一点走：露出来那一截还只有一颗球那么大的时候，里面
        // 那几格只会是被切开的半个图标。
        const reveal = opening ? clamp((e - 0.18) / 0.5, 0, 1) : clamp(1 - e / 0.45, 0, 1);
        root.style.setProperty('--perch-reveal', String(reveal));
        if (push) apply(perch, edges);
        if (t < 1) {
          anim = requestAnimationFrame(frame);
          return;
        }
        anim = 0;
        nav.classList.remove('is-pushed-live');
        clearClip(root);
        onDone?.();
      };
      frame(t0);
    },

    /**
     * 横杠离开了这一排（被拿起来拖走了）：被推开的标签回家，状态字放开。
     * 回家也是一段，不是一下子跳回去。
     */
    release({ animate = true } = {}) {
      stop();
      edgesNow = null;
      const fromShift = navShift;
      setTrail(NaN);
      if (!fromShift) return;
      if (!animate || reducedMotion() || typeof requestAnimationFrame !== 'function') {
        setNav(0);
        return;
      }
      nav.classList.add('is-pushed-live');
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const frame = (now) => {
        const t = clamp(((now ?? Date.now()) - t0) / RELEASE_MS, 0, 1);
        setNav(fromShift * (1 - SPRING_EASE(t)));
        if (t < 1) { anim = requestAnimationFrame(frame); return; }
        anim = 0;
        nav.classList.remove('is-pushed-live');
      };
      frame(t0);
    },

    /** 拖着工具栏经过这一排：在要落进去的那处空当亮一圈虚影，告诉人松手会停在哪。 */
    preview(perch) {
      const box = perch ? dock.ballBox(perch) : null;
      if (!box) { hint.hidden = true; hint.classList.remove('is-on'); return; }
      hint.hidden = false;
      hint.style.left = `${box.left}px`;
      hint.style.top = `${box.top}px`;
      hint.style.width = `${box.width}px`;
      hint.style.height = `${box.height}px`;
      // 下一帧再亮，好让它从小长出来，而不是一出现就在那儿。
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => hint.classList.add('is-on'));
      } else {
        hint.classList.add('is-on');
      }
    },

    /** 这一排变了（尺寸、语言、切页、书架、专注）就告诉横杠重新摆一次。 */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** 页面那一层知道那一排变了（比如刚换了语言）时，叫它重量一次。 */
    invalidate,

    destroy() {
      session?.cancel();
      stop();
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener('resize', notify);
      setNav(0);
      setTrail(NaN);
      hint.remove();
      listeners.clear();
    },
  };

  let queued = 0;
  const notify = () => {
    invalidate();
    if (queued) return;
    const run = () => { queued = 0; for (const fn of listeners) fn(); };
    queued = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (run(), 0);
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(notify) : null;
  observer?.observe(bar);
  observer?.observe(lead);
  observer?.observe(end);
  window.addEventListener('resize', notify, { passive: true });

  // 切页、开书架、进专注：这一排出现或者消失。立刻告诉（不等下一帧）——回到练习页
  // 的那一帧，点开着的横杠要先按「球那么大」露出来再长开，晚一帧就会先整条闪一下。
  let wasShown = shownNow();
  let wasAway = away();
  const mutations = typeof MutationObserver === 'function'
    ? new MutationObserver(() => {
      // 类名一变（收字那几级、专注、书架），那一排可能就换了样子。
      invalidate();
      // 往上收起来 / 拉回来：停在里面的横杠要借住到左边去、再回来（ink-toolbar.js 的
      // _stepOffRow / _returnToRow）。也是当场告诉：这一排刚开始滑，横杠得和它同一帧动。
      const gone = away();
      if (gone !== wasAway) {
        wasAway = gone;
        for (const fn of listeners) fn({ away: gone });
      }
      const shown = shownNow();
      if (shown === wasShown) return;
      wasShown = shown;
      for (const fn of listeners) fn({ shown });
    })
    : null;
  mutations?.observe(body, { attributes: true, attributeFilter: ['class', 'data-page'] });

  return dock;
}
