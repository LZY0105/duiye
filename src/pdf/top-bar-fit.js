// top-bar-fit.js — 顶上那一排在窄屏上怎么让。
//
// 那一排是三格（pdf.css 的 .pdf-page-bar）：左边一枚胶囊（导入、文档库、组合、
// 新建纸张），正中留给「练习 / 设置」两个标签的空位，右边状态字和「全部关闭」。
// 两边各分一半剩下的宽度，所以正中那一格是真的正中——和 fixed 在屏幕正中的那两
// 个标签（.app-nav）对得上。
//
// 左边那枚胶囊比它那一格宽的时候，会伸进正中压住标签。所以量：放不下就退一级，
// 有富余再回来。退的顺序：
//
//   1. is-bar-compact：左右两枚胶囊只留图标。字还在按钮里（读屏照读），只是缩成 0；
//   2. is-bar-tight：两个标签也只留图标，正中那一格随之变窄。
//
// 回来要多留 8px，免得正好卡在边界上的时候一帧一个样。和栏头那道阶梯是同一个做
// 法（pdf-workspace.js 的 _syncPaneHeaderFit）：不猜断点，量真的内容——换语言、换
// 字体、换皮肤都会挪动断点，而这里一个数都不用改。
//
// 平板横着拿（1200 宽）两级都用不上；竖过来（736 宽）要退一级。

import { onLangChange } from '../core/i18n.js';

/** 从上往下退的那几级，挂在 body 上：两个标签在页面外面，也得看得见它们。 */
export const BAR_LADDER = Object.freeze(['is-bar-compact', 'is-bar-tight']);

/** 回来时多要的那一点：刚好放得下不算放得下。 */
const COME_BACK_SLACK = 8;

const rectOf = (el) => el?.getBoundingClientRect?.() || null;

/** 正中那两个标签现在多宽：正中那一格就按这个宽度留。 */
export function syncNavWidth(nav, target = document.body) {
  const width = Math.round(nav?.getBoundingClientRect?.().width || 0);
  if (!width || !target?.style) return 0;
  const value = `${width}px`;
  if (target.style.getPropertyValue('--app-nav-w') !== value) {
    target.style.setProperty('--app-nav-w', value);
  }
  return width;
}

/**
 * 量一次，最多走一级。走了就回 true。
 *
 * 「放不下」看的是有没有伸进正中那一格：左边胶囊的右沿越过了它和空位之间那道
 * 缝的一半，或者右边「全部关闭」的左沿越过了另一边那一半。只看这两枚：状态字自
 * 己会省略，挤不坏谁。
 *
 * @param {HTMLElement} bar  .pdf-page-bar
 * @param {Object} memo      每一级退下来之前量到的宽度，回来时拿它比。调用方持有，跨调用保留。
 * @param {HTMLElement} [target=document.body]  那几级挂在谁身上
 */
export function fitTopBar(bar, memo, target = document.body) {
  const box = rectOf(bar);
  // 不在屏幕上（切到设置页了）：量到的全是 0，0 不是退一级的理由。
  if (!box || !box.width) return false;
  const lead = bar.querySelector('.pdf-bar-group:not(.is-end)');
  const end = bar.querySelector('.pdf-bar-trail .pdf-bar-group.is-end');
  const slot = bar.querySelector('.pdf-bar-nav-slot');
  const leadBox = rectOf(lead);
  const slotBox = rectOf(slot);
  if (!leadBox || !slotBox || !slotBox.width) return false;
  const endBox = rectOf(end);

  const style = typeof getComputedStyle === 'function' ? getComputedStyle(bar) : null;
  const gap = parseFloat(style?.columnGap) || 0;
  const pad = (parseFloat(style?.paddingLeft) || 0) + (parseFloat(style?.paddingRight) || 0);

  let level = BAR_LADDER.findIndex((cls) => !target.classList.contains(cls));
  if (level === -1) level = BAR_LADDER.length;

  const leadOver = leadBox.right > slotBox.left - gap / 2;
  const endOver = !!endBox && endBox.width > 0 && endBox.left < slotBox.right + gap / 2;
  if (leadOver || endOver) {
    if (level >= BAR_LADDER.length) return false;
    // 退下来之前记一笔：这一级要多宽才放得下。回来的时候拿它比。
    memo[level] = {
      lead: leadBox.width,
      end: endBox?.width || 0,
      nav: slotBox.width,
    };
    target.classList.add(BAR_LADDER[level]);
    return true;
  }

  if (level === 0) return false;
  const need = memo[level - 1];
  if (!need) {
    // 没有记录（比如换了语言，记录作废了）：先回去再说，放不下下一次量会再退。
    target.classList.remove(BAR_LADDER[level - 1]);
    return true;
  }
  // 回到上一级之后，正中那一格是退下来之前那么宽；两边各分剩下的一半。
  const side = (box.width - pad - need.nav - 2 * gap) / 2;
  if (side >= need.lead + COME_BACK_SLACK && side >= need.end + COME_BACK_SLACK) {
    target.classList.remove(BAR_LADDER[level - 1]);
    return true;
  }
  return false;
}

/**
 * 盯着那一排：尺寸变了、换了语言、字体到了，都重新量一遍。
 *
 * 一次量到底（最多走完整道阶梯），不是一帧一级：收字这件事没有过渡（pdf.css 里
 * 那几条按钮不 transition 宽度和字号），加上类当场就量得到收完的样子，一帧之内就
 * 能停在对的那一级上，人看不到它一级一级地缩。
 *
 * @returns {function} 拆掉
 */
export function initTopBarFit(elRoot, { target = document.body } = {}) {
  const bar = elRoot?.querySelector?.('.pdf-page-bar');
  if (!bar) return () => {};
  const nav = document.querySelector('.app-nav');
  const memo = {};

  const settle = () => {
    syncNavWidth(nav, target);
    for (let i = 0; i <= BAR_LADDER.length; i++) {
      if (!fitTopBar(bar, memo, target)) break;
      // 标签那一级会改它自己的宽度，正中那一格要跟着。
      syncNavWidth(nav, target);
    }
    nav?._relayoutLens?.();
  };

  let frame = 0;
  const schedule = () => {
    if (frame || typeof requestAnimationFrame !== 'function') return;
    frame = requestAnimationFrame(() => { frame = 0; settle(); });
  };

  // 尺寸一变就当场量，不等下一帧：ResizeObserver 在排完版、画出来之前回调，这里改完
  // 类、重排一次，正好赶上这一帧——等到下一帧，人就先看到一帧挤着的样子。
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => settle()) : null;
  observer?.observe(bar);
  // 换皮肤：当场重量，理由同上。
  const onSkin = () => {
    for (const key of Object.keys(memo)) delete memo[key];
    for (const cls of BAR_LADDER) target.classList.remove(cls);
    settle();
  };
  if (typeof window !== 'undefined') window.addEventListener('skinchange', onSkin);

  // 换了语言，字的宽度全变了：之前记下的「要多宽」作废，从头量。
  const offLang = onLangChange(() => {
    for (const key of Object.keys(memo)) delete memo[key];
    for (const cls of BAR_LADDER) target.classList.remove(cls);
    schedule();
  });
  document.fonts?.ready?.then(schedule).catch(() => {});
  schedule();

  return () => {
    observer?.disconnect();
    if (typeof window !== 'undefined') window.removeEventListener('skinchange', onSkin);
    offLang?.();
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
  };
}
