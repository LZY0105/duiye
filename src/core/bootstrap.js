// bootstrap.js — 开机前要先摆好的那几样。
//
// 这一层在任何功能模块加载之前跑，所以它只能依赖平台本身：崩溃捕获、Service
// Worker、两个标签页的切换、以及「装到桌面」那条横幅。功能模块的初始化在
// app.js 里，那时候 DOM 和词表都已经就位。

import { installCrashGuard } from './crash-guard.js';

/** 首屏是练习。设定页没有东西要预热，进来就落在能干活的那一页上。 */
const LANDING = 'pdf';

export async function bootstrap() {
  // 第一件事，在任何东西有机会出错之前：把异常和未处理的 rejection 接进原生日
  // 志。平板上出的错，要能从「导出日志」里捞出来，而不是消失在一个没人连着的
  // WebView 控制台里。
  installCrashGuard();

  // 离线靠它。注册失败不该拦住启动——拿不到缓存，无非是每次都走网络。
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  bindTabs();
  showPage(LANDING);
  bindInstallBanner();
}

/**
 * 两个标签页：练习和设定。
 *
 * 以前这里还要绕过「退役」的页面——识别和编辑器那两套被摘掉时，标记留在 DOM 里
 * 没删。现在 index.html 里一个 is-retired 都没有了，那套绕行连同它守着的那个从
 * 未被读过的 pages 变量一起去掉。
 *
 * 切页这件事只有一份实现（showPage），点击和开机都走它：两份的话，开机那一份
 * 迟早会漏掉后来加进点击那一份里的事情——背景的开关就是这么来的。
 */
function bindTabs() {
  for (const tab of document.querySelectorAll('.app-nav button')) {
    tab.addEventListener('click', () => showPage(tab.dataset.page));
  }
}

/**
 * 走掉的那一页淡出多久：取最长的那一段——练习页顶上那两枚胶囊收拢要 0.3 秒，整页
 * 的计时（pdf.css 的 pageHold）是 0.32 秒。兜底的计时器再多给一点余量：动画结束
 * 事件没来（页面在后台、动画被系统停了）也照样收得掉。
 */
export const PAGE_LEAVE_MS = 320;

/**
 * 让某一页成为当前页；标签的高亮和背景跟着走。
 *
 * 来的那一页淡入（.page.active 上的 pageFadeIn），走的那一页也要淡出——原来它是
 * 当场消失的：一页凭空没了、另一页慢慢浮上来，两半动作不对称，看着像闪了一下。
 * 走的那一页挂上 is-leaving，钉在它原来的位置上（滚过的距离也算上）淡出，结束了
 * 才真的收起来。它在淡出的时候什么都点不到（pointer-events: none、inert）。
 *
 * body 上记一笔现在是哪一页：两个标签在顶上正中，练习页上它们跟着那一排一起收
 * 起来，设置页上没有那一排，它们得一直在——CSS 靠这个分。
 */
export function showPage(name) {
  for (const tab of document.querySelectorAll('.app-nav button')) {
    tab.classList.toggle('active', tab.dataset.page === name);
  }
  const reduced = prefersReducedMotion();
  for (const page of document.querySelectorAll('.page')) {
    const coming = page.id === `page-${name}`;
    const was = page.classList.contains('active');
    if (coming) settlePage(page);
    else if (was && !reduced) leavePage(page);
    page.classList.toggle('active', coming);
  }
  if (document.body) document.body.dataset.page = name;
  syncBackgroundToPage(name);
}

/** 这一页淡出。回来得比它走完还快的话，settlePage 会把它拦下。 */
function leavePage(page) {
  settlePage(page);
  // 钉住的是它此刻在屏幕上的位置：它要变成 fixed，而 fixed 不跟着文档滚。
  page.style.setProperty('--leave-top', `${-(window.scrollY || 0)}px`);
  page.classList.add('is-leaving');
  page.inert = true;
  // 只认它自己的那一段动画：页里别的东西（转圈、卡片入场）的 animationend 也会冒
  // 泡到这里。
  const done = (e) => {
    if (e && e.target !== page) return;
    settlePage(page);
  };
  page.addEventListener('animationend', done);
  page._leaveTimer = setTimeout(done, PAGE_LEAVE_MS + 60);
  page._leaveDone = done;
}

/** 收尾：不管是淡完了、还是半路被叫了回来。 */
function settlePage(page) {
  clearTimeout(page._leaveTimer);
  if (page._leaveDone) page.removeEventListener('animationend', page._leaveDone);
  page._leaveTimer = 0;
  page._leaveDone = null;
  if (!page.classList.contains('is-leaving')) return;
  page.classList.remove('is-leaving');
  page.style.removeProperty('--leave-top');
  page.inert = false;
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

/**
 * 那层装饰性背景只在看得见它的地方跑。
 *
 * `#mathBg` 是一张铺满视口的画布——在这台平板上一百六十万像素——挂在一个永不停
 * 的动画循环上，每帧清空重画。练习那一页的工作区是不透明且满幅的，于是每一帧都
 * 画在它下面然后被丢掉，同时还在和那条要跟上 120Hz 触控笔的管线抢主线程。
 *
 * 省下的不是一点点，而且什么都不损失：这层背景唯一能透出来的地方是设定页。
 */
function syncBackgroundToPage(page) {
  const wanted = page !== 'pdf';
  import('../ui/particles.js').then(({ initParticles, stopParticles }) => {
    if (wanted) initParticles('mathBg');
    else stopParticles();
  }).catch(() => { /* 装饰而已，加载不上就算了 */ });
}

/**
 * 「装到桌面，离线也能用」那条横幅。
 *
 * 浏览器认为这个站点够格被安装时会抛 beforeinstallprompt，并允许把它拦下来留到
 * 合适的时机再用。所以这里拦住它、把事件存起来、亮出横幅，等人真的点了再
 * prompt()。不拦的话，浏览器会按自己的时机和自己的样子去问，而那一下往往正落在
 * 人读得好好的时候。
 *
 * 已经装过的（display-mode: standalone）不该再被问一次。
 */
function bindInstallBanner() {
  const banner = document.getElementById('installBanner');
  if (!banner) return;

  let pending = null;
  const hide = () => banner.classList.remove('show');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    pending = e;
    banner.classList.add('show');
  });

  document.getElementById('installBtn')?.addEventListener('click', async () => {
    if (!pending) return;
    pending.prompt();
    // 装没装成不影响这条横幅的去留：问过了就该收起来。
    await pending.userChoice;
    pending = null;
    hide();
  });

  document.getElementById('dismissInstall')?.addEventListener('click', hide);

  if (window.matchMedia('(display-mode: standalone)').matches) hide();
}
