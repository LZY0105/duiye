// lens-motion.js — 会滑的那块透镜怎么动（顶上「练习 / 设置」、找页面板「目录 / 缩略图 / 书签」）。
//
// 人给了一段录屏（手机相册底下「照片 | 图集」那枚胶囊），说「滑动的按钮的动画效果如视频所示一比一
// 复刻，仅是效果，不是样式」。录屏逐帧量了那块滑块的左右边、上下边（30fps，四次划动），下面这几根
// 弹簧就是照量出来的数拟合的（先粗拟定结构，再长拟合细调：四次合起来，宽、高、中心逐帧差的均方根 2.0px，
// 滑块本身 209px 宽）。量出来的是这么几件事：
//
//   · 按住它：慢慢缩一点，按得越久缩得越多（0.17 秒宽缩到九成二、高缩到九成四）。
//   · 手指进了另一格：它当场「浮起来」——一帧之内扁下去一截（高到八成九）——然后自己弹过去。
//     浮起来那一刻缩到哪儿就停在哪儿，不再往下缩。不是跟着手指走：手指快慢差了一倍多的几次，它走
//     的是同一条曲线（100ms 走一半、215ms 到九成、300ms 到九成八，几乎不过冲）。手指在它自己那一格
//     里挪，它不动。
//   · 走的时候顺着方向拉长：速度越快拉得越长，慢半拍（最快的那一下过后一两帧才最长）。
//   · 松手：高度当场往回长（0.3 秒上下回齐）；宽度要等它到了位才回来——所以落定那一下它比原来
//     窄一截（按得久的那次窄了近一成），停一两帧再慢慢长回去，像一滴水落定。
//
// 只管数，不碰 DOM：给它目标的位置和大小、告诉它按着没有、浮起来没有，每一帧推一步，读出这一帧的
// 位置和大小。怎么画是 liquid-glass.js 的事。

/**
 * 拟合出来的数。w 是弹簧的角频率（rad/s），z 是阻尼比；按住、浮起那两组是临界阻尼（z = 1）。
 *
 * travel：位置（和大小——两格一样宽时它不动，不一样宽时和位置一起变过去）。
 * stretch：顺着走的方向拉长多少。被速度推着：目标是 gain × 速度 ÷ 自己的长度（每秒走几个自己）；
 *          它自己又是一根弹簧（过阻尼，相当于慢 60ms 跟上），所以跟在速度后面慢半拍。
 * press：按住时缩到多少（along 顺着走的方向、across 横过来），in 缩下去的快慢；松手后横着那一半用
 *        outAcross 回来，顺着那一半等到了位再用 outAlong 回来。
 * lift：浮起来时横过来扁到多少，in 扁下去、out 松手回来的快慢。
 * arrived：离终点多近算到了位（按自己的长度算）。
 */
export const LENS_MOTION = Object.freeze({
  travel: Object.freeze({ w: 15.99, z: 0.908 }),
  stretch: Object.freeze({ gain: 0.0482, w: 100.3, z: 3.0, max: 0.45 }),
  press: Object.freeze({ along: 0.863, across: 0.876, in: 11.0, outAlong: 11.39, outAcross: 13.71 }),
  lift: Object.freeze({ across: 0.902, in: 200, out: 13.31 }),
  arrived: 0.001,
});

/**
 * 普通地滑：同一根位置弹簧，不缩、不浮、不拉长。纸里用它——人说「纸的状态下就不要那个按钮动画了，普通滑动即可」：
 * 纸上的透镜是钢笔划的一道线，线被压扁、拉长只会像是画歪了。
 */
export const PLAIN_LENS_MOTION = Object.freeze({
  travel: LENS_MOTION.travel,
  stretch: Object.freeze({ ...LENS_MOTION.stretch, gain: 0 }),
  press: Object.freeze({ ...LENS_MOTION.press, along: 1, across: 1 }),
  lift: Object.freeze({ ...LENS_MOTION.lift, across: 1 }),
  arrived: LENS_MOTION.arrived,
});

/** 一步最长多少秒：最硬的那两根（lift.in = 200、stretch 过阻尼的快根约 585）也稳得住。 */
const MAX_STEP = 1 / 960;
/**
 * 多近算停了（px、px/s、比例）。画的时候按 0.1px 取整（liquid-glass.js）：再往下的零头画不出来，却要一帧一帧地推、
 * 平板上每一帧都整页重画——停得太「准」只是白画那几帧。
 */
const EPS_POS = 0.1;
const EPS_VEL = 2;
const EPS_RATIO = 0.001;

function spring(x, v, target, w, z, h) {
  const a = w * w * (target - x) - 2 * z * w * v;
  const nv = v + a * h;
  return [x + nv * h, nv];
}

/**
 * @param {{vertical?: boolean, params?: typeof LENS_MOTION}} [opts]
 *   vertical：竖着排的（顺着走的方向是上下）。
 */
export function createLensMotion({ vertical = false, params = LENS_MOTION } = {}) {
  let P = params;
  // 中心、大小（都是容器里的坐标），和它们的速度。
  const s = {
    cx: 0, cy: 0, w: 0, h: 0, vcx: 0, vcy: 0, vw: 0, vh: 0,
    tcx: 0, tcy: 0, tw: 0, th: 0,
    st: 0, vst: 0,                // 拉长
    pa: 1, vpa: 0, pc: 1, vpc: 0, // 按住缩的：顺着、横着
    lc: 1, vlc: 0,                // 浮起扁的：横着
    pressed: false, lifted: false, placed: false,
  };

  const centreOf = (r) => [r.left + r.width / 2, r.top + r.height / 2];
  const arrived = () => {
    const along = Math.max(1, vertical ? s.h : s.w);
    return Math.abs(s.cx - s.tcx) < P.arrived * along && Math.abs(s.cy - s.tcy) < P.arrived * along;
  };
  /** 顺着那一半此刻停住不动吗：浮着（手按着）、或者松了手但还没到位。 */
  const holdAlong = () => (s.pressed && s.lifted) || (!s.pressed && !arrived());
  /** 横着那一半此刻停住不动吗：浮着、手按着。 */
  const holdAcross = () => s.pressed && s.lifted;
  const alongTarget = () => (s.pressed ? P.press.along : 1);
  const acrossTarget = () => (s.pressed ? P.press.across : 1);

  function step1(h) {
    const T = P.travel;
    [s.cx, s.vcx] = spring(s.cx, s.vcx, s.tcx, T.w, T.z, h);
    [s.cy, s.vcy] = spring(s.cy, s.vcy, s.tcy, T.w, T.z, h);
    [s.w, s.vw] = spring(s.w, s.vw, s.tw, T.w, T.z, h);
    [s.h, s.vh] = spring(s.h, s.vh, s.th, T.w, T.z, h);

    const S = P.stretch;
    const speed = Math.abs(vertical ? s.vcy : s.vcx);
    const length = Math.max(1, vertical ? s.h : s.w);
    [s.st, s.vst] = spring(s.st, s.vst, Math.min(S.max, (S.gain * speed) / length), S.w, S.z, h);

    const Pr = P.press;
    if (holdAlong()) s.vpa = 0;
    else [s.pa, s.vpa] = spring(s.pa, s.vpa, alongTarget(), s.pressed ? Pr.in : Pr.outAlong, 1, h);
    if (holdAcross()) s.vpc = 0;
    else [s.pc, s.vpc] = spring(s.pc, s.vpc, acrossTarget(), s.pressed ? Pr.in : Pr.outAcross, 1, h);

    const L = P.lift;
    [s.lc, s.vlc] = spring(s.lc, s.vlc, s.lifted ? L.across : 1, s.lifted ? L.in : L.out, 1, h);
  }

  return {
    /** 当场摆到这里（开机、没在动的时候尺寸变了、减少动态）。按住 / 浮起的样子不动。 */
    set(rect) {
      [s.cx, s.cy] = centreOf(rect);
      s.w = rect.width;
      s.h = rect.height;
      s.tcx = s.cx; s.tcy = s.cy; s.tw = s.w; s.th = s.h;
      s.vcx = 0; s.vcy = 0; s.vw = 0; s.vh = 0;
      s.st = 0; s.vst = 0;
      s.placed = true;
    },
    /** 往这里弹过去（从现在的位置、带着现在的速度）。 */
    target(rect) {
      if (!s.placed) { this.set(rect); return; }
      [s.tcx, s.tcy] = centreOf(rect);
      s.tw = rect.width;
      s.th = rect.height;
    },
    press(on) { s.pressed = !!on; },
    lift(on) { s.lifted = !!on; },
    /** 换一组数（换了皮肤：纸里是 PLAIN_LENS_MOTION）。正在走的这一段接着走，只是往后按新的数推。 */
    setParams(params) { P = params; },
    get pressed() { return s.pressed; },
    get lifted() { return s.lifted; },
    get placed() { return s.placed; },
    /** 往前推 dt 秒。 */
    step(dt) {
      let left = Math.max(0, dt);
      while (left > 1e-9) {
        const h = Math.min(MAX_STEP, left);
        step1(h);
        left -= h;
      }
    },
    /** 这一帧画在哪、多大（容器里的坐标）。 */
    rect() {
      const along = (vertical ? s.h : s.w) * s.pa * (1 + s.st);
      const across = (vertical ? s.w : s.h) * s.pc * s.lc;
      const width = vertical ? across : along;
      const height = vertical ? along : across;
      return { left: s.cx - width / 2, top: s.cy - height / 2, width, height };
    },
    /** 该停了吗：位置、大小都到了，拉长收完了，按住 / 浮起的样子也到了它此刻该在的地方，速度都没了。 */
    settled() {
      const near = (a, b, e) => Math.abs(a - b) < e;
      const still = (v) => Math.abs(v) < EPS_RATIO * 10;
      return near(s.cx, s.tcx, EPS_POS) && near(s.cy, s.tcy, EPS_POS)
        && near(s.w, s.tw, EPS_POS) && near(s.h, s.th, EPS_POS)
        && Math.abs(s.vcx) < EPS_VEL && Math.abs(s.vcy) < EPS_VEL
        && Math.abs(s.vw) < EPS_VEL && Math.abs(s.vh) < EPS_VEL
        && Math.abs(s.st) < EPS_RATIO && still(s.vst)
        && (holdAlong() || (near(s.pa, alongTarget(), EPS_RATIO) && still(s.vpa)))
        && (holdAcross() || (near(s.pc, acrossTarget(), EPS_RATIO) && still(s.vpc)))
        && near(s.lc, s.lifted ? P.lift.across : 1, EPS_RATIO) && still(s.vlc);
    },
    /** 停下时把剩下的那一点零头抹掉：落在正好的位置上，不留 0.03px 的毛边。 */
    snap() {
      s.cx = s.tcx; s.cy = s.tcy; s.w = s.tw; s.h = s.th;
      s.vcx = 0; s.vcy = 0; s.vw = 0; s.vh = 0;
      s.st = 0; s.vst = 0;
      if (!holdAlong()) s.pa = alongTarget();
      if (!holdAcross()) s.pc = acrossTarget();
      s.lc = s.lifted ? P.lift.across : 1;
      s.vpa = 0; s.vpc = 0; s.vlc = 0;
    },
  };
}
