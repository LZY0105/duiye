// Ink 模块 —— 形状：面板上那十个。
//
// 这不是「画一个歪圆、松手它自己变圆」那种识别。参照那段视频逐帧量下来，它是
// **拖出来的**：按下去那一点是锚，形状跟着笔实时长，松手才落进笔迹层。整段手势
// 里屏幕上只有一个深色物体，就是那个形状本身——没有原始笔迹、没有识别、没有猜。
//
// 松手之后形状**还能改**：它身上留着几颗琥珀色的点，拖一颗就动一处。多边形还会
// 在每个顶点旁边标出那个角是多少度，正好 90° 的画一个直角符号。点一下页面上已经
// 画好的形状，它也会重新亮起这些点——这一条是第 2706–2724 帧量到的：手指点在矩形
// **里面**，十八帧之后四颗点和四个「90°」一起出现。
//
// 下面这些数都是量出来的（视频 1920×1228、55.9fps）。
//
// ── 直线的角度吸附（第 174–206 帧）─────────────────────────────────────────
//
// 落笔 (424,822)。
//
//   帧   笔的位置     相对锚点的角度   屏幕上那条线
//   180  (588,805)    −5.9°           斜的
//   182  (632,808)    −3.9°           **正水平**（y 820–823，整条一样高）
//   199  (958,773)    −5.2°           仍然正水平
//   202  (941,768)    −6.0°           斜的，−5.65°，一直到松手
//
// 容差落在 5.2° 和 6.0° 之间——取 5.5°；刻度取 15° 的整数倍（视频只示范了 0°，而
// 15 的倍数含 0/45/90）。吸住时**屏幕上没有任何辅助线**，所以这里也不画。
//
// ── 框的长宽吸附（第 330–357 帧，圆）──────────────────────────────────────
//
//   帧   外接框     长宽比   形状
//   339  169×153    1.10    自由椭圆
//   340  170×170    1.00    **正圆**，同一帧出现琥珀色虚线十字
//   351  242×242    1.00    正圆（此时笔给的原始框约 1.05）
//   352  241×241    —       松手，十字消失
//
// 容差落在 5% 和 10% 之间——取 5%；直径取长的那一边（340 帧 max(170,155)=170，正
// 是画出来的 170）。第 548–612 帧还量到：拖回长宽差得远的地方，十字会**消失**，
// 圆又变回椭圆——所以这是每一帧重新判的，不是「吸住了就黏住」。
//
// 视频只在圆上示范了这件事。三角、方、五边、星共用同一条规矩：那三个的「正」正
// 是靠长宽相等得到的，把同一条吸附给它们，比给每个形状各编一套要诚实。
//
// ── 顶点是怎么被拖动的（第 2724–2794、1816–1880 帧）───────────────────────
//
// 矩形被拖走一个角之后**不再是矩形**：四个角的度数当场变成 83°/92°/95°/90°，直角
// 符号只留在还是 90° 的那个角上。星星被逐个拖动顶点之后变成一团任意多边形。所以
// 「拖顶点」不是在缩放这个形状，而是让它从此变成一个自由多边形——这里用 POLY 表
// 示，它不在面板上，只从拖动里来。
//
// DOM-free，和 combo-state、deck-state 一样：一个形状是数据的性质，不是渲染的性
// 质，所以它能在 Node 里单独测——上面那些数正是靠这一点钉住的。

export const SHAPE_KINDS = Object.freeze({
  LINE: 'line',
  ARROW: 'arrow',
  DARROW: 'darrow',
  CORNER: 'corner',
  ARC: 'arc',
  CIRCLE: 'circle',
  TRIANGLE: 'triangle',
  RECT: 'rect',
  PENTAGON: 'pentagon',
  STAR: 'star',
  /** 不在面板上：顶点被拖过之后，形状就变成一个自由多边形。 */
  POLY: 'poly',
});

/** 面板上那十个，按视频里的顺序：上一排是线和角，下一排是闭合的。 */
export const SHAPE_ORDER = Object.freeze([
  SHAPE_KINDS.LINE, SHAPE_KINDS.ARROW, SHAPE_KINDS.DARROW, SHAPE_KINDS.CORNER, SHAPE_KINDS.ARC,
  SHAPE_KINDS.CIRCLE, SHAPE_KINDS.TRIANGLE, SHAPE_KINDS.RECT,
  SHAPE_KINDS.PENTAGON, SHAPE_KINDS.STAR,
]);

/** 角度吸到 15° 的整数倍上，容差 5.5°。两个数的来历见文件开头。 */
export const ANGLE_STEP_DEG = 15;
export const ANGLE_SNAP_DEG = 5.5;

/** 长宽差在长边的 5% 以内就吸成正的。 */
export const ASPECT_SNAP = 0.05;

/** 比这还小的一下算「点了一下」，不算画形状——见 tooSmall。 */
export const MIN_EXTENT = 3;

/** 采样间隔（文档单位）。区域橡皮按点切，所以形状也得有足够的点。 */
const SAMPLE_STEP = 3;
const MAX_POINTS = 900;
const CURVE_MIN_POINTS = 48;

/** 五角星的内外半径之比。量到的是 73/183 = 0.399，取正五角星的 1/φ²。 */
const STAR_INNER = 0.382;

const DEG = Math.PI / 180;
const pt = (x, y) => ({ x, y });
const mid = (a, b) => pt((a.x + b.x) / 2, (a.y + b.y) / 2);

/** 两头张着口的那几种。 */
const LINE_KINDS = new Set([SHAPE_KINDS.LINE, SHAPE_KINDS.ARROW, SHAPE_KINDS.DARROW]);
/** 首尾相接的那几种。填充、点在里面算命中，都只对这些成立。 */
const CLOSED_KINDS = new Set([
  SHAPE_KINDS.CIRCLE, SHAPE_KINDS.TRIANGLE, SHAPE_KINDS.RECT,
  SHAPE_KINDS.PENTAGON, SHAPE_KINDS.STAR,
]);

export function isClosedShape(shape) {
  if (!shape) return false;
  if (shape.kind === SHAPE_KINDS.POLY) return shape.closed !== false;
  return CLOSED_KINDS.has(shape.kind);
}

function isKind(kind) {
  return Object.values(SHAPE_KINDS).includes(kind);
}

/**
 * 角度吸附。
 *
 * 吸的是**方向**，长度不动：笔尖离锚点多远，线就多长。改成往刻度方向做投影也只差
 * 半个像素（5.5° 的余弦是 0.995），但那会让线在吸住的一瞬间缩一下，而这一下正是
 * 人盯着的那一下。
 */
function snapAngle(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { to: pt(to.x, to.y), snapped: false };
  const deg = Math.atan2(dy, dx) / DEG;
  const step = Math.round(deg / ANGLE_STEP_DEG) * ANGLE_STEP_DEG;
  if (Math.abs(deg - step) > ANGLE_SNAP_DEG) return { to: pt(to.x, to.y), snapped: false };
  const rad = step * DEG;
  // 把 cos/sin 里那点浮点毛刺抹掉：cos(90°) 在 IEEE 里是 6.1e-17，不是 0。留着
  // 它，一条「竖直」的线两端 x 会差 1e-14——数值上无所谓，但这条线的整个意思就是
  // 「它是正的」，而视频里量到的也正是一条从头到尾一个像素都不歪的线。
  const clean = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  return {
    to: pt(from.x + clean(Math.cos(rad)) * len, from.y + clean(Math.sin(rad)) * len),
    snapped: true,
  };
}

/**
 * 每一种形状「正」的时候，框是什么长宽比（高 ÷ 宽）。
 *
 * 圆、方、五边、星都是 1：它们的顶点摆在框的内切椭圆上，框一正，形状就正。
 *
 * 三角形不是。它的三个顶点是「上中 + 左下 + 右下」，框正方的时候底和高相等，
 * 顶角 53°——那是个瘦高的等腰三角形，不是正三角形。正三角形的高是底的 √3/2，
 * 所以它的「正」对应的是一个 1 : 0.866 的框。虚线十字说的是「现在是正的那一
 * 个」，那它出现的时候画出来就得真的是正三角形。
 */
const REGULAR_RATIO = Object.freeze({
  [SHAPE_KINDS.TRIANGLE]: Math.sqrt(3) / 2,
});

/**
 * 长宽吸附。
 *
 * 锚点那一角不动，动的是对角——视频里外接框的左上角从落笔到松手一个像素都没挪
 * 过。吸住时取长的那一边，所以形状只会长，不会在吸住的一瞬间缩回去。
 *
 * `ratio` 是这一种形状「正」的长宽比（见 REGULAR_RATIO）。把高按它归一化之后，
 * 判据和圆那一条完全一样——圆的 ratio 是 1，所以那一条本来就是这一条的特例。
 */
function snapSquare(from, to, ratio = 1) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const w = Math.abs(dx);
  const h = Math.abs(dy) / ratio;
  const long = Math.max(w, h);
  if (long < 1e-6 || Math.abs(w - h) > ASPECT_SNAP * long) {
    return { to: pt(to.x, to.y), snapped: false };
  }
  return {
    to: pt(
      from.x + (dx < 0 ? -long : long),
      from.y + (dy < 0 ? -long : long) * ratio,
    ),
    snapped: true,
  };
}

/**
 * 一个形状。
 *
 * 直线那一族和框里那一族都只记 from/to（锚，和吸附之后的另一头）；弧和自由多边形
 * 记一串点。两种形态由 `pts` 在不在来分。
 */
export function createShape(kind, from, to) {
  if (!isKind(kind) || !from || !to) return null;
  const anchor = pt(from.x, from.y);
  const raw = pt(to.x, to.y);
  const fit = LINE_KINDS.has(kind)
    ? snapAngle(anchor, raw)
    : snapSquare(anchor, raw, REGULAR_RATIO[kind] || 1);
  return Object.freeze({
    kind,
    from: Object.freeze(anchor),
    to: Object.freeze(fit.to),
    raw: Object.freeze(raw),
    snapped: fit.snapped,
  });
}

/** 一串顶点组成的自由多边形。顶点被拖过之后，所有形状都落到这里。 */
export function createPoly(points, closed) {
  const pts = (points || []).map(p => Object.freeze(pt(p.x, p.y)));
  return Object.freeze({
    kind: SHAPE_KINDS.POLY,
    pts: Object.freeze(pts),
    closed: !!closed,
    snapped: false,
  });
}

/** 三个点定下来的一段弧：两端，加一个「鼓到哪儿」的中点。 */
export function createArc(a, apex, b) {
  return Object.freeze({
    kind: SHAPE_KINDS.ARC,
    pts: Object.freeze([
      Object.freeze(pt(a.x, a.y)),
      Object.freeze(pt(apex.x, apex.y)),
      Object.freeze(pt(b.x, b.y)),
    ]),
    closed: false,
    snapped: false,
  });
}

/** 一下点出来的、没有大小的形状。不落进层里——那只会在纸上留个点。 */
export function tooSmall(shape) {
  if (!shape) return true;
  const box = shapeBox(shape);
  if (!box) return true;
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (LINE_KINDS.has(shape.kind)) return Math.hypot(w, h) < MIN_EXTENT;
  if (shape.kind === SHAPE_KINDS.POLY || shape.kind === SHAPE_KINDS.ARC) {
    return Math.max(w, h) < MIN_EXTENT;
  }
  return w < MIN_EXTENT || h < MIN_EXTENT;
}

/** 外接框，左上到右下，和拖的方向无关。 */
export function shapeBox(shape) {
  if (!shape) return null;
  const list = shape.pts || [shape.from, shape.to];
  if (!list || !list.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of list) {
    if (!p) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** 正多边形的顶点，摆在框的内切椭圆上，第一个顶点朝正上。 */
function regular(box, n, innerRatio) {
  const rx = (box.x1 - box.x0) / 2;
  const ry = (box.y1 - box.y0) / 2;
  const cx = box.x0 + rx;
  const cy = box.y0 + ry;
  const out = [];
  const total = innerRatio ? n * 2 : n;
  for (let i = 0; i < total; i++) {
    const k = innerRatio && i % 2 ? innerRatio : 1;
    const a = -Math.PI / 2 + (Math.PI * 2 * i) / total;
    out.push(pt(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k));
  }
  return out;
}

/**
 * 形状身上那几个能拖的点，按画的顺序。
 *
 * 这几个点同时是三样东西：松手之后画出来的琥珀色圆点、拖动时动的那一处、以及算
 * 角度用的顶点。三样共用一份，所以它们不可能对不上。
 */
export function shapeVertices(shape) {
  if (!shape) return [];
  if (shape.pts) return shape.pts.map(p => pt(p.x, p.y));
  const { from, to } = shape;
  const box = shapeBox(shape);
  switch (shape.kind) {
    case SHAPE_KINDS.LINE:
    case SHAPE_KINDS.ARROW:
    case SHAPE_KINDS.DARROW:
      return [pt(from.x, from.y), pt(to.x, to.y)];
    case SHAPE_KINDS.CORNER:
      // 图标上是个 Γ：一条竖臂、一条横臂，拐角在锚点那一角。
      return [pt(from.x, to.y), pt(from.x, from.y), pt(to.x, from.y)];
    case SHAPE_KINDS.ARC:
      // 生成出来的弧：弦是框的一条边，鼓到对边的中点。第 404–448 帧量到的正是
      // 这个——两端齐平，最高点在正中间，两头的切线是竖的（所以是半椭圆，不是
      // 抛物线）。
      return [pt(from.x, from.y), pt((from.x + to.x) / 2, to.y), pt(to.x, from.y)];
    case SHAPE_KINDS.CIRCLE: {
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      return [pt(cx, box.y0), pt(box.x1, cy), pt(cx, box.y1), pt(box.x0, cy)];
    }
    case SHAPE_KINDS.TRIANGLE:
      return [pt((box.x0 + box.x1) / 2, box.y0), pt(box.x1, box.y1), pt(box.x0, box.y1)];
    case SHAPE_KINDS.RECT:
      return [pt(box.x0, box.y0), pt(box.x1, box.y0), pt(box.x1, box.y1), pt(box.x0, box.y1)];
    case SHAPE_KINDS.PENTAGON:
      return regular(box, 5, 0);
    case SHAPE_KINDS.STAR:
      return regular(box, 5, STAR_INNER);
    default:
      return [];
  }
}

/** 松手之后那几颗琥珀色圆点。id 就是顶点的序号，拖动时按它认人。 */
export function shapeHandles(shape) {
  return shapeVertices(shape).map((p, i) => ({ id: `v${i}`, x: p.x, y: p.y }));
}

/** 沿一条折线按间隔采样，首尾都保留。 */
function sampleAlong(points, closed) {
  const list = closed ? [...points, points[0]] : points;
  const out = [];
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.min(MAX_POINTS, Math.round(len / SAMPLE_STEP)));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: 0.5 });
    }
  }
  const last = list[list.length - 1];
  out.push({ x: last.x, y: last.y, p: 0.5 });
  return out;
}

/** 箭头那两根倒须。长度跟着线宽走，细线上也还看得出是个箭头。 */
function barbs(tip, from, width) {
  const len = Math.max(9, (Number(width) || 2) * 4);
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = 26 * DEG;
  return [
    pt(tip.x - Math.cos(angle - spread) * len, tip.y - Math.sin(angle - spread) * len),
    pt(tip.x - Math.cos(angle + spread) * len, tip.y - Math.sin(angle + spread) * len),
  ];
}

/** 半椭圆：弦是 a→b，鼓起来的高是 apex 到弦中点那一段。 */
function arcPoints(a, apex, b) {
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < 1e-6) return [{ x: a.x, y: a.y, p: 0.5 }];
  const centre = mid(a, b);
  const ux = (b.x - a.x) / chord;
  const uy = (b.y - a.y) / chord;
  // 法线朝 apex 那一侧，高就是 apex 在法线上的投影。
  const h = (apex.x - centre.x) * -uy + (apex.y - centre.y) * ux;
  const rx = chord / 2;
  const n = Math.max(CURVE_MIN_POINTS, Math.min(MAX_POINTS,
    Math.round((Math.PI * (rx + Math.abs(h)) / 2) / SAMPLE_STEP)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    // 从 a 走到 b 是半圈：本地坐标算好，再转回弦的方向。
    const t = Math.PI - (Math.PI * i) / n;
    const lx = Math.cos(t) * rx;
    const ly = Math.sin(t) * h;
    out.push({ x: centre.x + ux * lx - uy * ly, y: centre.y + uy * lx + ux * ly, p: 0.5 });
  }
  return out;
}

/**
 * 形状上的点，文档空间，压力一律 0.5。
 *
 * 为什么要采这么多点，而不是直线存两个端点、圆存一段 arc：这些点之后要走和手写笔
 * 迹完全同一条路——区域橡皮按点切、套索按点判、拖到另一栏按点缩放。只有两个点的
 * 直线在橡皮底下是「要么整条没、要么一点不动」，而人擦的是中间那一截。
 *
 * 压力给中间值：形状是等宽的，而每个工具的 pressureRange 会让 p 偏离 0.5 的点变
 * 粗或变细。
 */
export function shapePoints(shape, { width = 2 } = {}) {
  if (!shape) return [];
  const verts = shapeVertices(shape);
  if (!verts.length) return [];

  switch (shape.kind) {
    case SHAPE_KINDS.ARC:
      return arcPoints(verts[0], verts[1], verts[2]);
    case SHAPE_KINDS.CIRCLE: {
      const box = shapeBox(shape);
      const rx = (box.x1 - box.x0) / 2;
      const ry = (box.y1 - box.y0) / 2;
      const cx = box.x0 + rx;
      const cy = box.y0 + ry;
      const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
      // 点数取 4 的倍数：这样最上、最右、最下、最左四个点一定被采到，而那四个点正
      // 是四颗圆点待的地方。不取的话，圆点会浮在离线一点点的空处。
      const raw = Math.max(CURVE_MIN_POINTS,
        Math.min(MAX_POINTS, Math.round(perimeter / SAMPLE_STEP)));
      const n = Math.ceil(raw / 4) * 4;
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (Math.PI * 2 * i) / n;
        out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, p: 0.5 });
      }
      out.push({ x: out[0].x, y: out[0].y, p: 0.5 });
      return out;
    }
    case SHAPE_KINDS.ARROW: {
      const [a, b] = verts;
      const [p1, p2] = barbs(b, a, width);
      // 一笔画完：杆走到头，画一根倒须，回到尖上，再画另一根。回头那一段和倒须
      // 重合，画出来看不出来，但省掉了「一个形状是几条笔迹」这个问题。
      return sampleAlong([a, b, p1, b, p2], false);
    }
    case SHAPE_KINDS.DARROW: {
      const [a, b] = verts;
      const [p1, p2] = barbs(b, a, width);
      const [q1, q2] = barbs(a, b, width);
      return sampleAlong([q1, a, q2, a, b, p1, b, p2], false);
    }
    default:
      return sampleAlong(verts, isClosedShape(shape));
  }
}

/**
 * 吸附时该画的那几条辅助线（文档空间）。
 *
 * 只有长宽被吸成相等的那一下有：横竖两条虚线，各贯穿整个框。直线吸到刻度上时视频
 * 里什么都不画——那二十帧里除了线本身没有第二个物体——所以这里也不给它编一条。
 */
export function shapeGuides(shape) {
  if (!shape || !shape.snapped || LINE_KINDS.has(shape.kind)) return [];
  const box = shapeBox(shape);
  if (!box) return [];
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  return [
    { x1: box.x0, y1: cy, x2: box.x1, y2: cy },
    { x1: cx, y1: box.y0, x2: cx, y2: box.y1 },
  ];
}

/**
 * 每个顶点旁边那个角度标签。
 *
 * 视频第 2724 帧：矩形刚被选中，四个角上各一个「90°」，外加四个直角符号；拖走一个
 * 角之后当场变成 83°/92°/95°/90°，直角符号只留在还是 90° 的那个角上。
 *
 * 直线、箭头、圆、弧没有标签——它们没有「角」可言，视频里也确实一个字都没有。
 */
export function shapeLabels(shape) {
  if (!shape) return [];
  if (LINE_KINDS.has(shape.kind) || shape.kind === SHAPE_KINDS.CIRCLE
      || shape.kind === SHAPE_KINDS.ARC) return [];
  const verts = shapeVertices(shape);
  if (verts.length < 3) return [];
  const closed = isClosedShape(shape);
  const out = [];
  for (let i = 0; i < verts.length; i++) {
    const prev = verts[i - 1] ?? (closed ? verts[verts.length - 1] : null);
    const next = verts[i + 1] ?? (closed ? verts[0] : null);
    // 开口形状的两头没有角：一条臂的末端量不出夹角来。
    if (!prev || !next) continue;
    const v = verts[i];
    const a1 = Math.atan2(prev.y - v.y, prev.x - v.x);
    const a2 = Math.atan2(next.y - v.y, next.x - v.x);
    let diff = Math.abs(a1 - a2);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    const degrees = diff / DEG;
    // 标签摆在角平分线上，往形状里面挪一点。挪的距离按两条臂里短的那条给，小形状
    // 上才不会把标签甩到图形外面去。
    let bx = Math.cos(a1) + Math.cos(a2);
    let by = Math.sin(a1) + Math.sin(a2);
    const blen = Math.hypot(bx, by);
    if (blen < 1e-6) { bx = -Math.sin(a1); by = Math.cos(a1); }
    else { bx /= blen; by /= blen; }
    const arms = Math.min(
      Math.hypot(prev.x - v.x, prev.y - v.y),
      Math.hypot(next.x - v.x, next.y - v.y),
    );
    const away = Math.max(10, Math.min(34, arms * 0.32));
    out.push({
      x: v.x + bx * away,
      y: v.y + by * away,
      vertex: pt(v.x, v.y),
      degrees,
      right: Math.abs(degrees - 90) < 0.5,
      arm1: pt(Math.cos(a1), Math.sin(a1)),
      arm2: pt(Math.cos(a2), Math.sin(a2)),
    });
  }
  return out;
}

/**
 * 拖一颗圆点。
 *
 * 直线那一族：拖一端，另一端当锚，角度吸附照旧——改回来的那一下和画出来的那一下
 * 是同一套规矩，人不用学两遍。
 *
 * 圆：拖哪个正交点就动那一条边，对边不动；动完再过一次长宽吸附。
 *
 * 弧：拖两端就是换弦，拖中间那颗就是换鼓起来的高。
 *
 * 其余（角、三角、方、五边、星）：拖一个顶点之后就**不再是那个形状**了，变成一个
 * 自由多边形。视频里矩形被拖走一个角之后四个角当场各自报数，星星被拖成了一团东
 * 西——它们都不再回得去。这是对的：人要的是这一个顶点挪到那儿，不是整个图形跟着
 * 缩放。
 */
export function reshape(shape, handleId, point) {
  if (!shape || !point) return shape;
  const index = Number(String(handleId).replace(/^v/, ''));
  if (!Number.isInteger(index) || index < 0) return shape;

  if (LINE_KINDS.has(shape.kind)) {
    if (index === 0) {
      const fit = snapAngle(shape.to, point);
      return Object.freeze({
        kind: shape.kind,
        from: Object.freeze(pt(fit.to.x, fit.to.y)),
        to: Object.freeze(pt(shape.to.x, shape.to.y)),
        raw: Object.freeze(pt(point.x, point.y)),
        snapped: fit.snapped,
      });
    }
    return createShape(shape.kind, shape.from, point);
  }

  if (shape.kind === SHAPE_KINDS.ARC) {
    const v = shapeVertices(shape);
    if (index >= v.length) return shape;
    v[index] = pt(point.x, point.y);
    return createArc(v[0], v[1], v[2]);
  }

  if (shape.kind === SHAPE_KINDS.CIRCLE) {
    const box = shapeBox(shape);
    if (index === 0) return createShape(shape.kind, pt(box.x0, box.y1), pt(box.x1, point.y));
    if (index === 1) return createShape(shape.kind, pt(box.x0, box.y0), pt(point.x, box.y1));
    if (index === 2) return createShape(shape.kind, pt(box.x0, box.y0), pt(box.x1, point.y));
    if (index === 3) return createShape(shape.kind, pt(box.x1, box.y0), pt(point.x, box.y1));
    return shape;
  }

  const verts = shapeVertices(shape);
  if (index >= verts.length) return shape;
  verts[index] = pt(point.x, point.y);
  return createPoly(verts, isClosedShape(shape));
}

/** 离某一点最近的那颗圆点，够近才算。半径由调用方按缩放给。 */
export function handleAt(shape, point, radius) {
  let best = null;
  let bestDist = Infinity;
  for (const handle of shapeHandles(shape)) {
    const d = Math.hypot(handle.x - point.x, handle.y - point.y);
    if (d <= radius && d < bestDist) { best = handle; bestDist = d; }
  }
  return best;
}

function nearSegment(px, py, a, b, tol) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t)) <= tol;
}

/**
 * 这一下点在这个形状上吗。
 *
 * 闭合的形状**里面**也算——视频第 2706 帧那一下正是点在矩形当中的空白处，十八帧之
 * 后四颗圆点就亮起来了。开口的形状只认线附近，不然一条斜线会把它外接框里的半页纸
 * 都认成自己。
 */
export function hitShape(shape, point, tolerance = 8) {
  if (!shape || !point) return false;
  const box = shapeBox(shape);
  if (!box) return false;
  const pad = tolerance;
  if (point.x < box.x0 - pad || point.x > box.x1 + pad
      || point.y < box.y0 - pad || point.y > box.y1 + pad) return false;

  const pts = shapePoints(shape, { width: 2 });
  for (let i = 0; i < pts.length - 1; i++) {
    if (nearSegment(point.x, point.y, pts[i], pts[i + 1], tolerance)) return true;
  }
  if (!isClosedShape(shape)) return false;

  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i].y; const yj = pts[j].y;
    if ((yi > point.y) === (yj > point.y)) continue;
    const x = pts[j].x + ((point.y - yi) / (yj - yi || 1e-9)) * (pts[i].x - pts[j].x);
    if (point.x < x) inside = !inside;
  }
  return inside;
}

const r2 = (n) => Math.round(Number(n) * 100) / 100;

/** 落盘的形状：能画出同一个图形的最少几个数。 */
export function serializeShape(shape) {
  if (!shape) return null;
  if (shape.pts) {
    return {
      k: shape.kind,
      p: shape.pts.map(p => [r2(p.x), r2(p.y)]),
      c: shape.closed ? 1 : 0,
    };
  }
  return {
    k: shape.kind,
    f: [r2(shape.from.x), r2(shape.from.y)],
    t: [r2(shape.to.x), r2(shape.to.y)],
  };
}

export function deserializeShape(json) {
  if (!json || !isKind(json.k)) return null;
  if (Array.isArray(json.p)) {
    const pts = json.p.map(p => pt(Number(p[0]), Number(p[1])));
    if (json.k === SHAPE_KINDS.ARC) {
      return pts.length === 3 ? createArc(pts[0], pts[1], pts[2]) : null;
    }
    return createPoly(pts, !!json.c);
  }
  if (!Array.isArray(json.f) || !Array.isArray(json.t)) return null;
  // 落盘的是吸附**之后**的位置，所以读回来不再吸一次：再吸一次会把一条人特意留成
  // 5.6° 的线掰平。
  return Object.freeze({
    kind: json.k,
    from: Object.freeze(pt(Number(json.f[0]), Number(json.f[1]))),
    to: Object.freeze(pt(Number(json.t[0]), Number(json.t[1]))),
    raw: Object.freeze(pt(Number(json.t[0]), Number(json.t[1]))),
    snapped: false,
  });
}

/** 把形状平移一段。复制、粘贴、拖到另一栏的时候，它得跟着笔迹一起走。 */
export function translateShape(shape, dx, dy) {
  if (!shape) return null;
  if (shape.pts) {
    const pts = shape.pts.map(p => pt(p.x + dx, p.y + dy));
    if (shape.kind === SHAPE_KINDS.ARC) return createArc(pts[0], pts[1], pts[2]);
    return createPoly(pts, shape.closed);
  }
  return Object.freeze({
    kind: shape.kind,
    from: Object.freeze(pt(shape.from.x + dx, shape.from.y + dy)),
    to: Object.freeze(pt(shape.to.x + dx, shape.to.y + dy)),
    raw: Object.freeze(pt(shape.raw.x + dx, shape.raw.y + dy)),
    snapped: shape.snapped,
  });
}
