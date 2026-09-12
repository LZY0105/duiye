// PDF Module — 翻开一本书。
//
// 参照视频逐帧量出来的（720×1608、48.64fps，第 164 帧起第 210 帧止）：
//
//   帧   书的宽度   进度        阶段
//   164   187 px    0.000      静止，书在格子里
//   176   266       0.150      封面开始绕左边翻
//   184   381       0.369      翻到一半，内页露出大半
//   189   483       0.563      封面已经看不见了
//   200   640       0.861
//   210   711       1.000      铺满
//
// 三件事同时在走，而不是三段接力：
//
// 一、书从格子里的那一块长到它落地的那一块。量到的进度对时间是标准的缓入缓出
//     （t=0.25→0.150，t=0.5→0.498，t=0.75→0.861，和 easeInOutQuad 几乎重合），
//     全程 946ms。这个时长是量出来的，不是挑出来的。
//
// 二、封面绕它自己的左边缘往里转。从第 176 帧转到第 189 帧，占全程的
//     0.26–0.52；角度对时间基本是直线（量到 6°/35°/55°/72°/88°）。转过 90° 之后
//     背面朝人，backface-visibility 让它自己消失，不用再淡出。
//
// 三、封面底下是一张空白的纸。视频里翻开后露出的也是空白纸——正文是后来才
//     出现的。这一点省掉了一整块麻烦：不用先去渲第 2 页，翻开看到的就是纸，
//     等分栏把真正那一页画出来，这张纸淡掉就行。
//
// 落点不是「那一栏」，是「那一页在那一栏里会占的位置」。一栏是 584×620，一本
// 书是 A4 的 0.707——直接飞到栏的矩形上，书在半路会被抻成扁的。飞到页落地后
// 真正占的那块，形状全程不变，缩放是等比的。双开、单开、左栏右栏，差别只在这
// 个矩形是哪一块，别的都不用改。

/** 全程时长，毫秒。量出来的 946，取整。 */
export const OPEN_MS = 950;
/** 封面翻开占全程的哪一段。 */
const FLIP_FROM = 0.26;
const FLIP_TO = 0.52;
/** 转过头一点，好让背面朝人那一刻干脆利落。 */
const FLIP_DEGREES = 105;
/** 落地之后这张纸淡掉的时间。 */
const SETTLE_MS = 160;

/** 量出来的那条缓入缓出。 */
const EASE = 'cubic-bezier(0.45, 0, 0.55, 1)';
/** 封面转的角度对时间近乎直线，只在两头收一点，免得起停生硬。 */
const FLIP_EASE = 'cubic-bezier(0.4, 0.05, 0.6, 0.95)';

const reducedMotion = () => typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 一个形状放进一个框里，居中，等比。
 *
 * @param {number} aspect  宽高比（宽/高）
 * @param {DOMRect|Object} box
 */
export function fitRect(aspect, box) {
  const ratio = aspect > 0 ? aspect : 1 / 1.414;
  const boxRatio = box.width / box.height;
  const width = boxRatio > ratio ? box.height * ratio : box.width;
  const height = boxRatio > ratio ? box.height : box.width / ratio;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * 演一次翻开。
 *
 * @param {Object}   opts
 * @param {DOMRect}  opts.from      书现在在屏幕上的那一块（封面那张图的矩形）
 * @param {Object}   opts.to        它要落到的那一块（已经 fitRect 过）
 * @param {string}   [opts.coverUrl] 封面图；没有就画一张素封面
 * @param {string}   [opts.title]    没有封面图时印在素封面上的名字
 * @param {Element}  [opts.veil]     飞到后半程要淡掉的那一层（文档库）
 * @param {Function} [opts.onSettled] 书落地、纸还盖着的那一刻回调——把 veil
 *                                    真正收起来的时机就是这里，早一帧它会当着
 *                                    人的面消失，晚一帧它会闪回来一下
 * @returns {{land: () => Promise<void>, cancel: () => void}}
 */
export function playBookOpen({
  from, to, coverUrl, title = '', veil = null, onSettled = null,
} = {}) {
  if (!from || !to || typeof document === 'undefined') {
    return { land: () => Promise.resolve(), cancel: () => {} };
  }

  const flight = document.createElement('div');
  flight.className = 'pdf-book-flight';
  flight.setAttribute('aria-hidden', 'true');
  flight.style.left = `${to.left}px`;
  flight.style.top = `${to.top}px`;
  flight.style.width = `${to.width}px`;
  flight.style.height = `${to.height}px`;

  // 影子是自己一层，而且只动透明度。
  //
  // 原来是给纸做 box-shadow 的关键帧——而 box-shadow 每一帧都要主线程重画，
  // 偏偏这一下正演在「把一本 800 页的书解出来」的同一条线程上。位移和透明度
  // 是合成器自己能跑的，阴影不是；只要有一样不是，整段就跟着主线程一起卡。
  const shade = document.createElement('div');
  shade.className = 'pdf-book-flight-shade';
  flight.appendChild(shade);

  const page = document.createElement('div');
  page.className = 'pdf-book-flight-page';
  flight.appendChild(page);

  const cover = document.createElement('div');
  cover.className = 'pdf-book-flight-cover';
  if (coverUrl) cover.style.backgroundImage = `url("${coverUrl}")`;
  else {
    cover.classList.add('is-plain');
    cover.textContent = title;
  }
  flight.appendChild(cover);

  document.body.appendChild(flight);

  // 等比：from 和 to 是同一个形状，所以一个数就够了。
  const scale = to.width > 0 ? from.width / to.width : 1;
  const dx = from.left - to.left;
  const dy = from.top - to.top;

  const animations = [];
  const still = reducedMotion();
  const duration = still ? 1 : OPEN_MS;

  if (!still) {
    animations.push(flight.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
      { transform: 'translate(0px, 0px) scale(1)' },
    ], { duration, easing: EASE, fill: 'both' }));

    animations.push(cover.animate([
      { transform: 'rotateY(0deg)' },
      { transform: `rotateY(${FLIP_DEGREES}deg)` },
    ], {
      duration: Math.round(duration * (FLIP_TO - FLIP_FROM)),
      delay: Math.round(duration * FLIP_FROM),
      easing: FLIP_EASE,
      fill: 'both',
    }));

    // 书抬起来的时候底下的影子也张开，落地时收回去——影子是「它离开架子了」
    // 唯一的说明，没有它，长大的书像是贴在架子上被放大的一张图。
    animations.push(shade.animate([
      { opacity: 0.25 },
      { opacity: 1, offset: 0.55 },
      { opacity: 0.4 },
    ], { duration, easing: EASE, fill: 'both' }));

    if (veil) {
      // 书架不是一开始就走的：视频里它一直在书后面，直到被长大的书盖住。所以
      // 这层只在最后四分之一淡掉，那时书已经大了、也慢了，底下换什么看不见。
      animations.push(veil.animate([
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: 0.75 },
        { opacity: 0, offset: 1 },
      ], { duration, easing: 'linear', fill: 'both' }));
    }
  } else {
    flight.style.opacity = '0';
  }

  let cancelled = false;

  const cleanup = () => {
    for (const a of animations) { try { a.cancel(); } catch (_) { /* 已经收了 */ } };
    flight.remove();
    if (veil) veil.style.opacity = '';
  };

  return {
    /**
     * 等这几条动画真的交到合成器手上。
     *
     * 不等的话会这样：书刚摆好，调用方转头就去开那份 PDF，而解一本 800 页的书
     * 是实打实占着主线程的——动画对象早就建好了，可它的起始时刻要等下一帧才
     * 落定，于是真机上量到点下去之后有三百多毫秒书一动不动，然后才猛地飞出去。
     *
     * 起始时刻一旦落定，位移和透明度就归合成器管了，之后主线程再怎么忙，这一
     * 下也照演不误。
     */
    ready() {
      return Promise.all(animations.map(a => a.ready)).catch(() => {});
    },

    /**
     * 等它落地，然后把这张纸交出去。
     *
     * 分栏可能比动画快，也可能比它慢。快了就等动画演完——这一下本来就是给人
     * 看的；慢了就停在最后一帧等它，而不是半路把纸撤掉露出底下还没画完的白。
     */
    async land() {
      if (cancelled) return;
      try {
        await Promise.all(animations.map(a => a.finished));
      } catch (_) {
        // cancel() 会让 finished 抛出，这时候什么都不用做。
      }
      if (cancelled) return;
      // 书已经到位，这张纸还整个盖在上面——底下换什么这一刻都看不见，所以
      // 收书架、露分栏都在这里做，而不是在淡出之后。
      try { onSettled?.(); } catch (_) { /* 收尾的活不该让动画收不了场 */ }
      try {
        await flight.animate(
          [{ opacity: 1 }, { opacity: 0 }],
          { duration: SETTLE_MS, easing: 'ease-out', fill: 'forwards' },
        ).finished;
      } catch (_) { /* 同上 */ }
      cleanup();
    },
    cancel() {
      cancelled = true;
      cleanup();
    },
  };
}
