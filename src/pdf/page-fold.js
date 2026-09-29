// 翻页：按折痕对折，而折痕永远不越过固定的那一边。
//
// 从右往左翻（下一页）：左边固定，右边被拉起来折过去；从左往右翻（上一页）：右边固定，左边被拉起
// 来折过去。人说「滑动翻页的手感优化一下，应该有一边是固定的」——原来拉着角斜着拖、或者松手以后
// 自己翻完的那一段，折痕会斜着扫过固定的那一边，那一边的角也被折了起来。
//
// 这里只有几何和手感（松手翻不翻、剩下那一段怎么走完），没有 DOM：pdf-pane.js 拿它们摆那张纸。

/** 松手时自由边的横向速度（px/ms）超过这个，就按甩的方向走：往前甩就翻，往回甩就退。 */
export const TURN_FLING = 0.3;

/** 松手以后剩下那一段的弹簧（临界阻尼，1/s）：接着手的速度走，大约 0.3 秒走完。 */
export const SETTLE_OMEGA = 16;

/** 固定的那一边在哪儿（页面坐标的 x）：往后翻是左边，往前翻是右边。 */
export function spineX(direction, w) {
  return direction === 'next' ? 0 : w;
}

/**
 * 把手拉着的那一点收回到「折痕不越过固定边」的范围里。
 *
 * 折痕是锚点 A（被拉起来的那一点原来的位置）和手里那一点 P 连线的中垂线；离 A 比离 P 近的那一侧
 * 折了过去。固定边上的一点 Q 不被折起来 ⇔ |Q − P| ≤ |Q − A|。|Q−P|² − |Q−A|² 对 Q 是线性的，
 * 所以只要固定边的两个端点守住了，整条边都守住了：P 得在以这两个端点为圆心、各自到 A 的距离为
 * 半径的两个圆的交集里。
 *
 * 在外面就放到交集里离它最近的那一点。交集是一枚两头尖的「透镜」，两个尖正好是 A（纸平躺）和
 * A 关于固定边的镜像（翻到底）；最近的那一点要么在某一段圆弧上（等于投到那个圆上、且落在另一
 * 个圆里），要么就是两个尖之一。
 *
 * 这也是一张装订着的纸本来的样子：被拉着的角离装订边两头的距离，不会比它原来离得远。
 */
export function constrainFold(p, anchor, spine, h) {
  const ends = [{ x: spine, y: 0 }, { x: spine, y: h }];
  const radii = ends.map((q) => Math.hypot(anchor.x - q.x, anchor.y - q.y));
  const inside = (pt, i) => Math.hypot(pt.x - ends[i].x, pt.y - ends[i].y) <= radii[i] + 1e-9;
  if (inside(p, 0) && inside(p, 1)) return { x: p.x, y: p.y };
  const onto = (i) => {
    const dx = p.x - ends[i].x;
    const dy = p.y - ends[i].y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: ends[i].x + (dx * radii[i]) / d, y: ends[i].y + (dy * radii[i]) / d };
  };
  const candidates = [{ x: anchor.x, y: anchor.y }, turnedPoint(anchor, spine)];
  const arc0 = onto(0);
  if (inside(arc0, 1)) candidates.push(arc0);
  const arc1 = onto(1);
  if (inside(arc1, 0)) candidates.push(arc1);
  let best = candidates[0];
  let bestD = Infinity;
  for (const q of candidates) {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; best = q; }
  }
  return { x: best.x, y: best.y };
}

/** 翻到底：锚点关于固定边的镜像——整张纸都折到固定边另一侧去了，折痕正好落在固定边上。 */
export function turnedPoint(anchor, spine) {
  return { x: 2 * spine - anchor.x, y: anchor.y };
}

/** 翻过去多少，0..1：折痕走过的比例（折痕走得是手的一半）。 */
export function foldProgress(anchor, p, w) {
  const span = w || 1;
  return Math.max(0, Math.min(1, Math.abs(p.x - anchor.x) / (span * 2)));
}

/**
 * 松手：翻还是不翻。
 *
 * 甩得够快就听甩的方向——往回甩，哪怕已经翻过一大半也退回去；往前甩，哪怕才拉开一点也翻。
 * 不快，就看翻过去了多少。vx 是手拉着的那一点松手前的横向速度（px/ms，向右为正）。
 */
export function releaseCommits(direction, progress, vx, commitAt, fling = TURN_FLING) {
  const toward = direction === 'next' ? -vx : vx;
  if (toward > fling) return true;
  if (toward < -fling) return false;
  return progress >= commitAt;
}

/**
 * 最近一小段时间里那一点的速度（px/ms）。samples 是 [{ t, x, y }]，只看最后 90ms：再往前是手指还在
 * 加速的那一段。now 是松手的时刻：手指停住一会儿再抬起来，那一下的速度是 0，不是停住之前的——
 * 不然停稳了再松手也会被当成一甩。
 */
export function pointVelocity(samples, now = null, windowMs = 90) {
  const still = { vx: 0, vy: 0 };
  if (!samples?.length) return still;
  const last = samples[samples.length - 1];
  if (now != null && now - last.t > windowMs) return still;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  if (!(dt > 0)) return still;
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

/**
 * 临界阻尼弹簧的一步（精确解，不怕帧长短不一）。x 是离目标还差多少，v 是速度（每秒），dt 秒。
 * 返回 [x, v]。
 */
export function settleStep(x, v, dt, omega = SETTLE_OMEGA) {
  const e = Math.exp(-omega * dt);
  const k = v + omega * x;
  return [(x + k * dt) * e, (v - omega * k * dt) * e];
}

/**
 * 松手以后那一点走一帧：两个方向各走一步弹簧，再收回到「折痕不越过固定边」的范围里。
 * state = { x, y, vx, vy }（位置 px、速度 px/s），target 是要去的那一点。返回新的 state。
 */
export function stepFold(state, target, dt, anchor, spine, h, omega = SETTLE_OMEGA) {
  const [dx, vx] = settleStep(state.x - target.x, state.vx, dt, omega);
  const [dy, vy] = settleStep(state.y - target.y, state.vy, dt, omega);
  const p = constrainFold({ x: target.x + dx, y: target.y + dy }, anchor, spine, h);
  return { x: p.x, y: p.y, vx, vy };
}
