// 液态玻璃：照 rdev/liquid-glass-react 的做法重写（原生 DOM，不引 React）。
//
// 人说「液态玻璃按钮和液态玻璃的 react 全按里面来重写」。那个库是一个 React 组件，这个应用没有
// React——把整套框架拉进来只为了给几颗按钮套一层，不值；它的效果本身是 DOM、CSS 和一段 SVG 滤镜，
// 一层一层照搬过来就是：
//
//   warp    玻璃的身子（外面套一层裁圆角的 lens）：backdrop-filter 把背后磨一磨、提一提饱和度，
//           再用 SVG 滤镜按库里那张位移贴图把背后弯过去（feDisplacementMap）。库里还把红、绿、蓝
//           三个通道各弯一点不一样的量，边上出一圈色散——那一段在平板上太重，平时不用（见
//           glassFilterMarkup）。
//   rim     两道 1.5px 的边，一道白色渐变的高光，角度和位置跟着指针走。
//   glow    按钮才有：悬停、按下时从顶上正中打下来的径向亮光。
//   弹性    按钮才有：指针靠近（边缘 200px 以内）时整颗按钮朝它挪一点、朝它那个方向拉长一点；
//           按下去缩到 0.96。
//
// 数值（位移、模糊、饱和度、色散、弹性）照库里的默认值和 README 的按钮示例。按这个应用改了的
// 几处（浅底深字、不用混合模式、亮光在字下面）写在 liquid-glass-react.css 开头；这里还有一处：
//
//   · 指针：库里只认鼠标。平板上没有常驻的鼠标，这里认鼠标和笔悬停（笔还没落下的那一段），手指
//     不认（拖着页面走过按钮，按钮不该跟着伸缩），正在写字时一概不算——写字的那条管线不能被它拖慢。
//     按下去谁都算（手指也要有按的反馈）。
//
// 只在「液态玻璃」里挂（html 上 data-glass="liquid"，见 settings.js 的 SKINS）。「毛玻璃」是改写之前的
// 那一套、和它同一个 data-skin，纸有它自己的一套（paper.css）——换到这两套就拆掉，换回来再挂上。
// 位移贴图和滤镜照搬自 liquid-glass-react（MIT，Copyright 2025 Max Rovensky，全文见
// liquid-glass-maps.js 开头）。

import { POLAR_MAP, PROMINENT_MAP, STANDARD_MAP } from './liquid-glass-maps.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAPS = { standard: STANDARD_MAP, polar: POLAR_MAP, prominent: PROMINENT_MAP };

/**
 * 三种玻璃的参数。
 *
 * capsule：顶上那一排的胶囊、正中那两个标签——库的默认值，位移按这些胶囊的个头（44px 高）
 *          收小（库里默认 70）；不弹（它们的位置归各自的排版管，挪了就和旁边对不齐）。
 * button： README 里「按钮」那个示例的数：位移 64、模糊 0.1、饱和度 130、色散 2、弹性 0.35。
 * lens：   「练习 / 设置」那枚胶囊里标出选中那一格的那块透镜（liquid-glass.js 的滑动透镜）。人说
 *          它「为什么会有白色，做的也不像背景反射出来的，要完全液态玻璃按钮」——原来是一层上白下透
 *          的白、一道高光。现在和按钮同一种玻璃（模糊 0.1、饱和度 130、色散 2）；位移按它的个头
 *          （81×36）收到 32——位移按像素算，按钮那个 64 放在这么小一块上，背后被压成一半还多。
 *          不弹、不按：它跟着选中的那一格走，按的是它上面那颗按钮。
 * panel：  空桌面正中那张卡片（「一边做题，一边对答案」）。人说「这个也做成库里展示那种液态玻璃」：
 *          库的默认值原样（位移 70、模糊 0.0625、饱和度 140、色散 2）——它是一大块，库里演示的也是
 *          一大块。不弹：一张要读的卡片跟着笔尖晃，字就跟着晃。
 */
export const PRESETS = Object.freeze({
  capsule: Object.freeze({
    displacementScale: 48, blurAmount: 0.0625, saturation: 140, aberrationIntensity: 2, elasticity: 0, mode: 'standard',
  }),
  button: Object.freeze({
    displacementScale: 64, blurAmount: 0.1, saturation: 130, aberrationIntensity: 2, elasticity: 0.35, mode: 'standard',
  }),
  lens: Object.freeze({
    displacementScale: 32, blurAmount: 0.1, saturation: 130, aberrationIntensity: 2, elasticity: 0, mode: 'standard',
  }),
  panel: Object.freeze({
    displacementScale: 70, blurAmount: 0.0625, saturation: 140, aberrationIntensity: 2, elasticity: 0, mode: 'standard',
  }),
});

/** 指针离玻璃的边多近才开始有反应（px，库里的数）。 */
export const ACTIVATION_ZONE = 200;

/** 磨砂有多重（px）：库里是 (overLight ? 12 : 4) + blurAmount × 32，这里不走 overLight。 */
export function blurRadius(blurAmount) {
  return 4 + blurAmount * 32;
}

/**
 * 一段 SVG 滤镜的标记。两种：
 *
 * chromatic: true——库里 GlassFilter 逐个原语照搬（没用上的那个 radialGradient 不搬）：三个通道各弯
 * 一次、各取一个通道、screen 混回去、柔化一点，再按贴图做的边缘遮罩合回去。贴图是一道线性的坡，
 * 越往边上弯得越多，三个通道弯的量差得也越多——边上那一圈彩边就是这么来的。人说「胶囊按钮边缘的
 * 折射也该还原」：静止的时候就用它（见 BUSY）。
 *
 * 默认只弯一次：库里那张贴图、库里那个位移量，就是库里红通道那一次（x 看 R、y 看 B）——和色散版的
 * 弯法一样，只少那圈彩边。手在屏幕上的时候用它：平板上（Chromium 138）实测，色散版在翻页、写字、
 * 收起顶栏时每隔一帧 50–67ms（多路合成每一路都要开一张中间图，每块玻璃每一帧都重做一遍），只弯一次
 * 和不弯一样快。静止的时候屏幕不重画，色散版一帧都不用算。
 *
 * backdrop: true 给 backdrop-filter: url(…) 用（工具栏、原来那两段折射）。区域收回元素本身；色散版
 * 还要去掉那条边缘遮罩——原样放进 backdrop-filter，Chromium 出来的是没弯过的原样（实测：底下的条纹
 * 笔直）。那条链拿贴图的不透明度做遮罩，只在贴图外面（滤镜区域比元素大出去的那一圈）才起作用，贴图
 * 是不透明的 JPEG，元素里面处处是 1，在 filter 上它什么都不改。
 *
 * fit：贴图怎么铺。库里是 'xMidYMid slice'（按短边铺满、长的那边裁掉）——给胶囊、按钮那种不太长的
 * 形状。浮在书页上的那条工具栏是 54×624 那样的细条，照这样铺，坡只在两个短头上，长边几乎不弯；
 * 它用 'none'（按它自己的比例拉满），长边也弯。
 *
 * box：位移按元素自己的大小算（primitiveUnits="objectBoundingBox"，位移量写成边长的几分之几），不按
 * 像素。划着挑时手指底下那块玻璃用它：同一块玻璃在顶栏里缩到 0.62、贴边时是 1，按像素给一个数，
 * 小的时候弯得太狠、大的时候又看不出来。
 *
 * convex：凸的。库里的贴图是一道 S 形的坡（中间最陡），库里给的位移是负的——一块凹透镜：把背后缩
 * 小，更多的东西挤进来，边上往外弯。一小块玻璃压在一个图标上，凹的会把图标缩小、推偏；反过来就是
 * 一滴水：中间放大，边上往里弯。
 */
export function glassFilterMarkup(id, { displacementScale, aberrationIntensity, mode = 'standard' }, {
  backdrop = false, chromatic = false, fit = 'xMidYMid slice', box = false, convex = false,
} = {}) {
  const map = MAPS[mode] || MAPS.standard;
  const sign = mode === 'shader' || convex ? 1 : -1;
  const r = displacementScale * sign;
  const units = box ? ' primitiveUnits="objectBoundingBox"' : '';
  const extent = box ? 'x="0" y="0" width="1" height="1"' : 'x="0" y="0" width="100%" height="100%"';
  const image = `<feImage ${extent} result="DISPLACEMENT_MAP" href="${map}" preserveAspectRatio="${fit}"/>`;
  if (!chromatic) {
    // 弯一次。区域就是元素本身：外面那一圈库里是给遮罩链留的，这里用不着（warp 外面有 lens 裁圆角）。
    return `<filter id="${id}" x="0%" y="0%" width="100%" height="100%"${units} color-interpolation-filters="sRGB">${image}`
      + `<feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale="${r}" xChannelSelector="R" yChannelSelector="B"/>`
      + '</filter>';
  }
  const g = displacementScale * (sign - aberrationIntensity * 0.05);
  const b = displacementScale * (sign - aberrationIntensity * 0.1);
  // 柔化那一下是按像素定的（0.3px 上下）；按边长算的时候按五十来像素的一块折过去。
  const soften = Math.max(0.1, 0.5 - aberrationIntensity * 0.1) / (box ? 50 : 1);
  const region = backdrop ? 'x="0%" y="0%" width="100%" height="100%"' : 'x="-35%" y="-35%" width="170%" height="170%"';
  const split = `<feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale="${r}" xChannelSelector="R" yChannelSelector="B" result="RED_DISPLACED"/>`
    + '<feColorMatrix in="RED_DISPLACED" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="RED_CHANNEL"/>'
    + `<feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale="${g}" xChannelSelector="R" yChannelSelector="B" result="GREEN_DISPLACED"/>`
    + '<feColorMatrix in="GREEN_DISPLACED" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="GREEN_CHANNEL"/>'
    + `<feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP" scale="${b}" xChannelSelector="R" yChannelSelector="B" result="BLUE_DISPLACED"/>`
    + '<feColorMatrix in="BLUE_DISPLACED" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="BLUE_CHANNEL"/>'
    + '<feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED"/>'
    + '<feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED"/>'
    + `<feGaussianBlur in="RGB_COMBINED" stdDeviation="${soften}" result="ABERRATED_BLURRED"/>`;
  if (backdrop) {
    return `<filter id="${id}" ${region}${units} color-interpolation-filters="sRGB">${image}${split}</filter>`;
  }
  return `<filter id="${id}" ${region}${units} color-interpolation-filters="sRGB">${image}`
    + '<feColorMatrix in="DISPLACEMENT_MAP" type="matrix" values="0.3 0.3 0.3 0 0 0.3 0.3 0.3 0 0 0.3 0.3 0.3 0 0 0 0 0 1 0" result="EDGE_INTENSITY"/>'
    + `<feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK"><feFuncA type="discrete" tableValues="0 ${aberrationIntensity * 0.05} 1"/></feComponentTransfer>`
    + '<feOffset in="SourceGraphic" dx="0" dy="0" result="CENTER_ORIGINAL"/>'
    + split
    + '<feComposite in="ABERRATED_BLURRED" in2="EDGE_MASK" operator="in" result="EDGE_ABERRATION"/>'
    + '<feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>'
    + '<feComposite in="CENTER_ORIGINAL" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN"/>'
    + '<feComposite in="EDGE_ABERRATION" in2="CENTER_CLEAN" operator="over"/>'
    + '</filter>';
}

/**
 * 边上那道高光：一道 135° 起、跟着指针偏的白色渐变（库里 Border layer 的那条式子）。
 * offset 是指针相对玻璃中心的偏移，以玻璃的宽 / 高为 100。
 * @param {'screen'|'overlay'} layer screen 那层淡（0.12 / 0.4），overlay 那层重（0.32 / 0.6）
 */
export function rimGradient(offset, layer) {
  const x = offset?.x || 0;
  const y = offset?.y || 0;
  const ax = Math.abs(x);
  const [a1, a2] = layer === 'overlay' ? [0.32, 0.6] : [0.12, 0.4];
  const angle = 135 + x * 1.2;
  const s1 = Math.max(10, 33 + y * 0.3);
  const s2 = Math.min(90, 66 + y * 0.4);
  const f = (v) => +v.toFixed(3);
  return `linear-gradient(${f(angle)}deg, rgba(255, 255, 255, 0) 0%, `
    + `rgba(255, 255, 255, ${f(a1 + ax * 0.008)}) ${f(s1)}%, `
    + `rgba(255, 255, 255, ${f(a2 + ax * 0.012)}) ${f(s2)}%, rgba(255, 255, 255, 0) 100%)`;
}

/** 指针离玻璃边缘多远（px）；在玻璃里面是 0。 */
function edgeDistance(pointer, rect) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const ex = Math.max(0, Math.abs(pointer.x - cx) - rect.width / 2);
  const ey = Math.max(0, Math.abs(pointer.y - cy) - rect.height / 2);
  return Math.hypot(ex, ey);
}

/**
 * 指针在玻璃附近时，玻璃怎么动（库里 calculateElasticTranslation / calculateDirectionalScale）：
 * 朝指针挪一点，朝指针那个方向拉长、另一个方向收一点；离边缘越近越明显，200px 外不动。
 * @returns {{tx:number, ty:number, sx:number, sy:number, offset:{x:number,y:number}, fade:number}}
 */
export function glassResponse(pointer, rect, elasticity) {
  const still = { tx: 0, ty: 0, sx: 1, sy: 1, offset: { x: 0, y: 0 }, fade: 0 };
  if (!pointer || !rect?.width || !rect?.height) return still;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = pointer.x - cx;
  const dy = pointer.y - cy;
  const edge = edgeDistance(pointer, rect);
  if (edge > ACTIVATION_ZONE) return still;
  const fade = 1 - edge / ACTIVATION_ZONE;
  const offset = { x: (dx / rect.width) * 100, y: (dy / rect.height) * 100 };
  const out = { tx: dx * elasticity * 0.1 * fade, ty: dy * elasticity * 0.1 * fade, sx: 1, sy: 1, offset, fade };
  const dist = Math.hypot(dx, dy);
  if (dist > 0 && elasticity > 0) {
    const nx = Math.abs(dx / dist);
    const ny = Math.abs(dy / dist);
    const stretch = Math.min(dist / 300, 1) * elasticity * fade;
    out.sx = Math.max(0.8, 1 + nx * stretch * 0.3 - ny * stretch * 0.15);
    out.sy = Math.max(0.8, 1 + ny * stretch * 0.3 - nx * stretch * 0.15);
  }
  return out;
}

// ── 挂到元素上 ─────────────────────────────────────────────────────────────────

let defs = null;
const filterIds = new Map();

/** 放滤镜的那张 SVG：没有（或者被拿掉了）就造一张。 */
function ensureDefs() {
  if (defs && defs.isConnected) return defs;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'lgr-defs');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);
  filterIds.clear();
  return defs;
}

/**
 * 同一组参数只造一段滤镜，所有用这组参数的玻璃共用（贴图按各自的大小铺开）。
 * @param {'lean'|'rich'} [variant] rich 是库里原样的色散版，lean 只弯一次（见 glassFilterMarkup）
 */
function filterFor(opts, variant = 'lean') {
  const key = `${variant}|${opts.mode}|${opts.displacementScale}|${opts.aberrationIntensity}`;
  ensureDefs();
  if (filterIds.has(key)) return filterIds.get(key);
  const id = `lgr-filter-${filterIds.size + 1}`;
  defs.insertAdjacentHTML('beforeend', glassFilterMarkup(id, opts, { chromatic: variant === 'rich' }));
  filterIds.set(key, id);
  return id;
}

/**
 * 工具栏的折射（人说「工具栏边缘的折射是不是也有点偷懒了」）。
 *
 * 工具栏挂不了那几层：点开、收起时它整个换一遍 innerHTML，露出来那一截用 clip-path 逐帧裁（见 TARGETS
 * 那条注释）。所以它的折射直接接在它自己的 backdrop-filter 后面（liquid-glass-react.css），用这几段
 * 固定 id 的滤镜——样式表里写得出 url(#…)，静止 / 手在屏幕上两套各一段：
 *
 *   · lgr-cap-*：停在顶上那一排里的那一条、收起来的那颗球——和胶囊同一组数；
 *   · lgr-bar-*：浮在书页上贴边的那一条。它是细长的（竖着 54×624），贴图按它自己的比例拉满（fit:
 *     'none'），长边也弯；位移收到 32——按它 54px 的宽度，边上弯出去十几像素就够了。
 *   · lgr-drop-*：在工具、颜色上划着挑时手指底下那块玻璃（ink-toolbar.js 的 _installScrub）。人说
 *     「工具栏滑动时记得做玻璃折射」：它浮在横杠上面，弯的是横杠连同底下那个图标。凸的、按它自己的
 *     大小算（convex、box，见 glassFilterMarkup）：位移是边长的 0.16，底下那个图标在正中放大到一点
 *     三倍多、边上往里弯——浏览器里试过 0.3（放大将近一倍，图标撑满、被边裁掉）和库里那样凹的 40px
 *     （图标被缩小、推到下半边，认不出来）。
 */
const TOOLBAR_GLASS = Object.freeze({ displacementScale: 32, aberrationIntensity: 2, mode: 'standard' });
const DROP_GLASS = Object.freeze({ displacementScale: 0.16, aberrationIntensity: 2, mode: 'standard' });
export const NAMED_FILTERS = Object.freeze({
  'lgr-cap-rich': [PRESETS.capsule, { backdrop: true, chromatic: true }],
  'lgr-cap-lean': [PRESETS.capsule, { backdrop: true }],
  'lgr-bar-rich': [TOOLBAR_GLASS, { backdrop: true, chromatic: true, fit: 'none' }],
  'lgr-bar-lean': [TOOLBAR_GLASS, { backdrop: true, fit: 'none' }],
  'lgr-drop-rich': [DROP_GLASS, { backdrop: true, chromatic: true, box: true, convex: true }],
  'lgr-drop-lean': [DROP_GLASS, { backdrop: true, box: true, convex: true }],
});

function ensureNamedFilters() {
  for (const [id, [opts, how]] of Object.entries(NAMED_FILTERS)) {
    if (document.getElementById(id)) continue;
    ensureDefs().insertAdjacentHTML('beforeend', glassFilterMarkup(id, opts, how));
  }
}

// ── 静止的时候上色散，手在屏幕上的时候只弯一次 ──────────────────────────────────

/**
 * 手离开屏幕多久算静止（ms）。静止了，html 上的 lgr-busy 摘掉，所有玻璃换回库里原样的色散版；按下、
 * 移动、滚轮、滚动、按键就挂上，换成只弯一次的那一版（样式表按这个类挑滤镜）。
 *
 * 为什么要换：色散版在平板上每隔一帧 50–67ms，但它只在屏幕重画的时候才算——静止的时候什么都不
 * 重画，它一帧都不花；手一动（写字、翻页、滑动）屏幕就一帧一帧地画，这时候换成只弯一次的，和不
 * 弯一样快。两版弯的地方一样，差的只是边上那圈彩边：手动的那一会儿它收起来，停下半秒再回来。
 */
export const IDLE_MS = 500;
/** 手已经离开了、东西还在动（松手以后翻完那一页、那一排滑到位、工具栏长开）：等它们演完再换回去。 */
const STILL_MOVING = '.pdf-page-leaf, .pdf-workspace.is-row-sliding, .ink-toolbar.is-dragging, '
  + '.ink-toolbar.is-perch-animating, [data-role="toolbar-ghost"]';
let lastActivity = 0;
let idleTimer = 0;

function markBusy() {
  // 别的皮肤里没有要换的玻璃：写字时每一下 pointermove 都进这里，读一个属性就走。
  if (!glassSkin()) return;
  lastActivity = now();
  const root = document.documentElement;
  if (!root.classList.contains('lgr-busy')) root.classList.add('lgr-busy');
  if (!idleTimer) idleTimer = setTimeout(checkIdle, IDLE_MS);
}

function checkIdle() {
  idleTimer = 0;
  const left = IDLE_MS - (now() - lastActivity);
  if (left > 8) { idleTimer = setTimeout(checkIdle, left); return; }
  if (document.body?.classList.contains('is-top-moving') || document.querySelector(STILL_MOVING)) {
    idleTimer = setTimeout(checkIdle, 200);
    return;
  }
  document.documentElement.classList.remove('lgr-busy');
}

/**
 * 应用里原来就有的两段折射（index.html 里的 #lg-refract、#lg-refract-soft：拖着走的工具栏、收起来
 * 的那颗球、分段控件的透镜、选角色那张卡在用，都是 backdrop-filter: url(…)）：液态玻璃里换成库里的
 * 这一段——整个应用的液态玻璃是同一种弯法。id 不变，用它们的样式一条都不用动。同样只弯一次：那颗球
 * 浮在正在写的那一页上，写字时每一帧都要重做它。
 *
 * 毛玻璃就是改写之前的那一套，用的是原来那两段：换过去时把原来的放回来。换下来的那一段留着，换回来
 * 直接放回去，不重造。
 */
export const LEGACY_FILTERS = Object.freeze({
  'lg-refract': Object.freeze({ displacementScale: 48, aberrationIntensity: 2, mode: 'standard' }),
  'lg-refract-soft': Object.freeze({ displacementScale: 20, aberrationIntensity: 1, mode: 'standard' }),
});

/** id → 换下来、等着换回去的那一段 <filter>（液态玻璃里是原来那段，别的皮肤里是库里那段）。 */
const legacySwapped = new Map();

function syncLegacyFilters(liquid) {
  for (const [id, opts] of Object.entries(LEGACY_FILTERS)) {
    const current = document.getElementById(id);
    if (!current || (current.getAttribute('data-lgr') === '1') === liquid) continue;
    const other = legacySwapped.get(id);
    if (other) {
      current.replaceWith(other);
    } else if (liquid) {
      current.insertAdjacentHTML('afterend', glassFilterMarkup(id, opts, { backdrop: true }));
      current.nextElementSibling?.setAttribute('data-lgr', '1');
      current.remove();
    } else {
      continue;
    }
    legacySwapped.set(id, current);
  }
}

const attached = new Map();

function layer(className) {
  const el = document.createElement('span');
  el.className = className;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function paintRims(state, offset) {
  state.offset = offset;
  state.screen.style.background = rimGradient(offset, 'screen');
  state.overlay.style.background = rimGradient(offset, 'overlay');
}

/** 那几层还在不在（按钮的字被 textContent 整个换掉时它们会一起没了）。 */
function layersPresent(state) {
  return state.layers.every((l) => l.parentNode === state.el);
}

/** 字被整个换过、层跟着没了的：原样补回去。 */
function restoreLayers() {
  for (const state of attached.values()) {
    if (state.el.isConnected && !layersPresent(state)) state.el.append(...state.layers);
  }
}

/**
 * 给一个元素挂上液态玻璃。已经挂过的：层还在就什么都不做，层没了（字被整个换过）就补上。
 * @param {HTMLElement} el
 * @param {'capsule'|'button'} [preset]
 */
export function attachLiquidGlass(el, preset = 'capsule', overrides = {}) {
  if (!el) return null;
  const existing = attached.get(el);
  if (existing) {
    if (!layersPresent(existing)) el.append(...existing.layers);
    return existing;
  }
  const opts = { ...(PRESETS[preset] || PRESETS.capsule), ...overrides };
  // 库里的结构：一层裁圆角的（.glass 的 overflow: hidden），里面一层弯背后的（.glass__warp）。
  const lens = layer('lgr-lens');
  const warp = layer('lgr-warp');
  // 写成变量，由样式表拿去用（.lgr-warp 的 filter / backdrop-filter）：减少透明时样式表能一句
  // 话把它们都撤掉，不用和行内样式比谁更硬；静止 / 手在屏幕上两版也由样式表按 lgr-busy 挑。
  warp.style.setProperty('--lgr-filter', `url(#${filterFor(opts)})`);
  warp.style.setProperty('--lgr-filter-rich', `url(#${filterFor(opts, 'rich')})`);
  warp.style.setProperty('--lgr-backdrop', `blur(${blurRadius(opts.blurAmount)}px) saturate(${opts.saturation}%)`);
  lens.appendChild(warp);
  const screen = layer('lgr-rim lgr-rim--screen');
  const overlay = layer('lgr-rim lgr-rim--overlay');
  // 影子单独一层，排在身子后面画：库里影子在玻璃自己身上，那样身子磨背后、弯背后的时候会把自己的
  // 影子也吸进来——浅色的底上，宽按钮两头各一块灰（实测：影子一拿掉就没了）。挪到后面画，身子看不
  // 到它，外面看是同一圈影子。
  const layers = [lens, layer('lgr-shadow')];
  if (preset === 'button') {
    layers.push(layer('lgr-glow lgr-glow--1'), layer('lgr-glow lgr-glow--2'), layer('lgr-glow lgr-glow--3'));
  }
  layers.push(screen, overlay);
  // 放在最后而不是最前：按钮里、胶囊里有按 :first-child 摆的东西，挂在前面会把它们挤错。
  // 叠放次序靠 z-index（身子和亮光在字下面，边在字上面），和在不在前面没关系。
  el.append(...layers);
  el.classList.add('lgr', `lgr--${preset}`);
  try {
    const cs = getComputedStyle(el);
    if (cs.position === 'static') el.classList.add('lgr--anchor');
    else if (cs.zIndex === 'auto') el.classList.add('lgr--stack');
  } catch (_) { /* 算不出来就不管：多数玻璃本来就定了位 */ }
  const state = {
    el, opts, preset, lens, warp, screen, overlay, layers,
    offset: { x: 0, y: 0 }, vars: { tx: 0, ty: 0, sx: 1, sy: 1 }, hover: false, rect: null,
  };
  paintRims(state, { x: 0, y: 0 });
  attached.set(el, state);
  return state;
}

const STATE_ATTRS = ['data-lgr-hover', 'data-lgr-active'];
const VARS = ['--lgr-tx', '--lgr-ty', '--lgr-sx', '--lgr-sy'];

/** 拆掉：那几层、那几个类、状态、弹性留下的变量都收回去。 */
export function detachLiquidGlass(el) {
  const state = attached.get(el);
  if (!state) return;
  for (const l of state.layers) l.remove();
  el.classList.remove('lgr', `lgr--${state.preset}`, 'lgr--anchor', 'lgr--stack');
  for (const a of STATE_ATTRS) el.removeAttribute(a);
  for (const v of VARS) el.style.removeProperty(v);
  if (pressed === el) pressed = null;
  attached.delete(el);
}

/** 现在挂着的都有谁（测试用）。 */
export function attachedGlass() {
  return [...attached.keys()];
}

// ── 指针 ─────────────────────────────────────────────────────────────────────

let pointer = null;
let frame = 0;
let measuredAt = -Infinity;
let pressed = null;
let motionQuery = null;

function reducedMotion() {
  return !!motionQuery?.matches;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 这块玻璃现在是不是「动过」的：挪了、拉了、亮着——指针走远以后还得再算一次让它回去。 */
function unsettled(state) {
  const v = state.vars;
  return state.hover || v.tx !== 0 || v.ty !== 0 || v.sx !== 1 || v.sy !== 1
    || state.offset.x !== 0 || state.offset.y !== 0;
}

function writeVars(state, r) {
  const v = state.vars;
  const tx = +r.tx.toFixed(2);
  const ty = +r.ty.toFixed(2);
  const sx = +r.sx.toFixed(4);
  const sy = +r.sy.toFixed(4);
  if (tx === v.tx && ty === v.ty && sx === v.sx && sy === v.sy) return;
  state.vars = { tx, ty, sx, sy };
  const s = state.el.style;
  s.setProperty('--lgr-tx', `${tx}px`);
  s.setProperty('--lgr-ty', `${ty}px`);
  s.setProperty('--lgr-sx', String(sx));
  s.setProperty('--lgr-sy', String(sy));
}

function respond() {
  frame = 0;
  measuredAt = now();
  // 先把位置都量完，再一起写：边量边写，浏览器每写一次就得重排一次。
  const plans = [];
  for (const state of attached.values()) {
    if (!state.el.isConnected) continue;
    const rect = state.el.getBoundingClientRect();
    state.rect = rect;
    const inside = !!pointer && pointer.x >= rect.left && pointer.x <= rect.right
      && pointer.y >= rect.top && pointer.y <= rect.bottom;
    plans.push([state, glassResponse(pointer, rect, state.opts.elasticity), inside]);
  }
  const still = reducedMotion();
  for (const [state, r, inside] of plans) {
    const moved = Math.abs(r.offset.x - state.offset.x) > 0.5 || Math.abs(r.offset.y - state.offset.y) > 0.5
      || (r.fade === 0 && (state.offset.x !== 0 || state.offset.y !== 0));
    if (moved) paintRims(state, r.fade === 0 ? { x: 0, y: 0 } : r.offset);
    if (state.opts.elasticity > 0) writeVars(state, still ? { tx: 0, ty: 0, sx: 1, sy: 1 } : r);
    if (state.preset === 'button' && inside !== state.hover) {
      state.hover = inside;
      state.el.toggleAttribute('data-lgr-hover', inside);
    }
  }
}

function schedule() {
  if (frame || typeof requestAnimationFrame !== 'function') return;
  frame = requestAnimationFrame(respond);
}

/**
 * 指针移动时要不要量：离哪块玻璃都远（量过的位置外面再宽出 40px）、也没有哪块还没回原位，就
 * 不量——笔悬在书页中间时，这里一帧什么都不做。位置是上一次量的，最多隔 300ms 重量一次（玻璃
 * 自己也会挪：顶栏收起、栏宽变了）。
 */
function worthMeasuring(p) {
  if (now() - measuredAt > 300) return true;
  for (const state of attached.values()) {
    if (!state.rect || unsettled(state)) return true;
    const r = state.rect;
    const ex = Math.max(0, r.left - p.x, p.x - r.right);
    const ey = Math.max(0, r.top - p.y, p.y - r.bottom);
    if (Math.hypot(ex, ey) <= ACTIVATION_ZONE + 40) return true;
  }
  return false;
}

/** 墨迹层：画布、笔迹层（和 liquid-glass.js 里 isDrawingPointer 认的是同一组）。 */
const INK = 'canvas, .ink-layer, .ink-surface, .hw-canvas';

/**
 * 这一下指针移动算什么。
 *   'track'  跟着算：鼠标、笔悬着，不在书页上。
 *   'gone'   当作指针走了：笔落下了，或者鼠标、笔挪到了书页上——书页上一概不算，写字的那条管线
 *            一帧都不分给它；玻璃回原样。
 *   'ignore' 不理：手指。拖着页面走过按钮，按钮不该跟着伸缩。
 */
function classify(e) {
  if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return 'ignore';
  if (e.pointerType === 'pen' && e.buttons) return 'gone';
  return e.target?.closest?.(INK) ? 'gone' : 'track';
}

function onPointerMove(e) {
  if (!attached.size) return;
  const kind = classify(e);
  if (kind === 'ignore') return;
  if (kind === 'gone') {
    onPointerGone();
    return;
  }
  pointer = { x: e.clientX, y: e.clientY };
  if (worthMeasuring(pointer)) schedule();
}

function onPointerGone() {
  if (!pointer) return;
  pointer = null;
  schedule();
}

/** 按下去：库里按着的时候缩到 0.96、亮光打满。手指也算——按的反馈谁都要有。 */
function onPointerDown(e) {
  const el = e.target?.closest?.('.lgr--button');
  if (!el || !attached.has(el) || el.disabled) return;
  release();
  pressed = el;
  el.setAttribute('data-lgr-active', '');
}

function release() {
  if (!pressed) return;
  pressed.removeAttribute('data-lgr-active');
  pressed = null;
}

// ── 挂到哪些东西上 ─────────────────────────────────────────────────────────────

/**
 * 哪些东西是液态玻璃、哪一种。
 *
 * 笔迹工具栏不在里面（不管浮在书页上、还是停在顶栏里）：它自己的排法是逐帧写的——点开、收起
 * 时整个外壳换一遍 innerHTML、露出来那一截用 clip-path 一帧一帧裁。挂在里面的层会被整个冲掉；
 * clip-path 还会让它在展开那一下自成一层，里面那层看不到背后，玻璃在动画里变成一块空的。它
 * 停在顶栏里时，样子由 liquid-glass-react.css 用同样的磨砂、底色和影子对齐这几枚胶囊；它拖着
 * 走、收成球时的折射本来就是 #lg-refract，那一段已经换成库里的滤镜（见 LEGACY_FILTERS）。在工具上划着挑
 * 时手指底下那块玻璃也不挂这几层：它要看得清底下那个图标，不能磨（见 NAMED_FILTERS 的 lgr-drop-*）。
 *
 * 「删掉」那种红色的按钮也不在里面：一整块红是「这一下删了就回不来」的意思，不能变成透明的。
 */
export const TARGETS = Object.freeze([
  ['.pdf-page-bar .pdf-bar-group', 'capsule'],
  ['.app-nav', 'capsule'],
  // 胶囊里标出选中那一格的透镜：也是一块玻璃，不是一层白（见 PRESETS.lens）。
  ['.app-nav .nav-glass-lens', 'lens'],
  // 空桌面正中那张卡片：人说「这个也做成库里展示那种液态玻璃」（见 PRESETS.panel）。它里面那两颗
  // 导入按钮本来就是玻璃，玻璃叠在玻璃上：按钮看得见卡片那一层（卡片自己不带 backdrop-filter，身子
  // 在它的 .lgr-warp 里）。
  ['.pdf-empty-card', 'panel'],
  ['.pdf-slot-btn.is-answer-action', 'button'],
  ['#settingsSave', 'button'],
  ['.action-btn.secondary', 'button'],
  ['.set-select-btn', 'button'],
  ['.deck-dialog-btn:not(.is-danger)', 'button'],
  ['.pdf-empty-btn', 'button'],
  ['.pdf-library-header .pdf-library-btn', 'button'],
  ['.pdf-guide-header .pdf-library-btn', 'button'],
  ['.guide-toc-chip', 'button'],
  // 文档库每本书右上角那颗「⋯」：人说「把那个按钮也改成液态玻璃」。和别的按钮同一种玻璃（亮光、弹性、按下
  // 0.96），只是它只有 30px：位移按个头收到 20——按钮那个 64 放在这么小一块上，背后的封面被整个挤到边上
  // 去。第三项是给这一种的参数改动（attachLiquidGlass 的 overrides）。
  ['.pdf-book-more', 'button', { displacementScale: 20 }],
]);

const ANY_TARGET = TARGETS.map(([selector]) => selector).join(', ');

/** 现在穿的是不是液态玻璃。毛玻璃和它同一个 data-skin（liquid.css 那几十条两套都吃），差的就是这个。 */
function glassSkin() {
  return document.documentElement.getAttribute('data-glass') === 'liquid';
}

/** 按现在的皮肤把该挂的挂上、该拆的拆掉。随时可以叫，叫几次都一样。 */
export function syncLiquidGlass() {
  const liquid = glassSkin();
  syncLegacyFilters(liquid);
  if (!liquid) {
    for (const el of [...attached.keys()]) detachLiquidGlass(el);
    document.documentElement.classList.remove('lgr-busy');
    return;
  }
  // 工具栏那几段（样式表里按 id 引用）：放滤镜的那张 SVG 被重建过就补上。
  ensureNamedFilters();
  const wanted = new Set();
  for (const [selector, preset, overrides] of TARGETS) {
    document.querySelectorAll(selector).forEach((el) => {
      if (wanted.has(el)) return;
      wanted.add(el);
      attachLiquidGlass(el, preset, overrides);
    });
  }
  // 不再符合的（对话框关了、按钮换成了红色的那种）：拆掉。
  for (const el of [...attached.keys()]) {
    if (!wanted.has(el) || !el.isConnected) detachLiquidGlass(el);
  }
}

/**
 * 这一批 DOM 变化和玻璃有没有关系。书页一翻，文字层一次加进几千个 span——每一批都把十几个
 * 选择器在整页上查一遍，那是白花的工夫。只看：加进来的东西里有没有该挂的，挂着的有没有被
 * 拿走，类一变谁开始 / 不再符合。
 */
function concernsGlass(records) {
  let removed = false;
  for (const r of records) {
    if (r.type === 'attributes') {
      if (attached.has(r.target) || r.target.matches?.(ANY_TARGET)) return true;
      continue;
    }
    for (const n of r.addedNodes) {
      if (n.nodeType === 1 && (n.matches(ANY_TARGET) || n.querySelector(ANY_TARGET))) return true;
    }
    if (r.removedNodes.length) removed = true;
  }
  if (removed) {
    for (const el of attached.keys()) if (!el.isConnected) return true;
  }
  return false;
}

let teardown = null;

export function initLiquidGlassReact() {
  if (teardown || typeof document === 'undefined') return;
  try { motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (_) { motionQuery = null; }
  syncLiquidGlass();
  let queued = false;
  const observer = new MutationObserver((records) => {
    // 字被整个换掉的按钮当场补上层（微任务里，下一帧画出来之前），不然会有一帧光秃秃的。
    restoreLayers();
    if (queued || !concernsGlass(records)) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncLiquidGlass(); });
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  const onSkin = () => syncLiquidGlass();
  window.addEventListener('skinchange', onSkin);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
  window.addEventListener('pointerup', release, { passive: true, capture: true });
  window.addEventListener('pointercancel', release, { passive: true, capture: true });
  document.documentElement.addEventListener('pointerleave', onPointerGone);
  window.addEventListener('blur', onPointerGone);
  // 手在屏幕上（写字、翻页、滑、滚、敲键）：玻璃换成只弯一次的那一版，停下半秒换回色散（见 IDLE_MS）。
  const BUSY_EVENTS = ['pointerdown', 'pointermove', 'wheel', 'keydown', 'scroll'];
  for (const type of BUSY_EVENTS) window.addEventListener(type, markBusy, { passive: true, capture: true });
  teardown = () => {
    observer.disconnect();
    window.removeEventListener('skinchange', onSkin);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerdown', onPointerDown, { capture: true });
    window.removeEventListener('pointerup', release, { capture: true });
    window.removeEventListener('pointercancel', release, { capture: true });
    document.documentElement.removeEventListener('pointerleave', onPointerGone);
    window.removeEventListener('blur', onPointerGone);
    for (const type of BUSY_EVENTS) window.removeEventListener(type, markBusy, { capture: true });
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = 0;
    document.documentElement.classList.remove('lgr-busy');
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
    pointer = null;
    measuredAt = -Infinity;
    release();
    for (const el of [...attached.keys()]) detachLiquidGlass(el);
    syncLegacyFilters(false);
  };
}

export function destroyLiquidGlassReact() {
  teardown?.();
  teardown = null;
}
