// Ink Module —— 套索圈一块之后「识别」的那一整段界面：扫描时的动画、进度、结果单子、出错时说什么。
//
// 识别要一会儿（本机跑模型，一两秒到十几秒）。这一会儿里人得一直知道三件事：它在认（没卡死）、认的是哪一块、
// 不想等了怎么停。所以：
//   - 扫描：圈里的东西自己像水面一样起伏——书页的底色、字、笔迹、贴着的图，一竖条一竖条地上下错开（ripple）；不另外
//     铺颜色（人说「识别动画的波浪不要有颜色，让下面的背景和字像波浪一样动就行」），圈外一点不碰；圈线还是套索那条
//     金色虚线，不另画一条、不流动（人说「识别时套索的边界线周围也不要有蓝色虚线，保留波浪的动画即可」）。圈下面
//     一个小条：三个点、「正在识别…」、有进度就带百分比，右边「取消」；点和字跟着同一个节拍一个接一个涌起来、亮一下，
//     像浪从头传到尾。认得久了（4 秒）小条上补一句「内容多会久一点」。「取消」冒出来先淡着，过 CANCEL_ARM_MS 才算数。
//   - 找到了：起伏慢慢平下去（认得再快也至少起伏 RIPPLE_HOLD_MS），认出来的那几处在图上依次框出来（「是这几处」），
//     框完结果单子从下面浮上来。
//   - 结果单子：一条一行，公式按排好的样子显示（KaTeX），文字照原样；默认全选，点一行选上 / 取消；认错的点 ✎ 改；
//     底下「复制」「转为笔迹」。
//   - 没认出、认失败、等太久：小条上说一句，失败的能「再试一次」。
// 动画全在样式表里（ink-recognize.css）。系统开了「减少动态效果」：不扫、不流动、不弹，只有静态的提示。
//
// 这块东西是 DOM，挂在笔迹画布的父节点上，和套索那条小条一样：画上去的东西不能被点。它自己不知道圈在哪——
// 屏幕上的圈由笔迹画布算好给它（缩放、平移时再给一次）。

import { t } from '../core/i18n.js';
import { loadKatex, renderFormula } from '../ocr/katex-ink.js';
import { avoidFloatingObstacles } from './float-avoid.js';

const SVGNS = 'http://www.w3.org/2000/svg';
/** 条、单子离圈多远，CSS 像素。 */
const GAP = 12;
/** 贴边时至少离容器边多远。 */
const EDGE = 8;
/** 认了多久以后补一句「内容多会久一点」。 */
const SLOW_MS = 4000;
/** 框框都框完再浮出单子：一个框 70ms，最多等这么久。 */
const BOXES_MAX_MS = 420;
/**
 * 小条上的按钮冒出来以后先淡着、等这么久才算数，之后也只认在它上面按下去的那一下（见 _counts）。小条正好冒在「识别」
 * 那颗按钮原来的地方：点「识别」抬手时浏览器补的那一下 click、手指抖一下多碰的、连点两下的第二下，都会落在「取消」上，
 * 刚开始认就被取消了（人说「取消识别的按钮不应该点了识别后就立即生效，有些时候他们会冲突」）。点「识别」抬手补的那一下
 * click 那边另外吞了一道（ink-selection-bar.js 的 _swallowClickOf），可它只认同一根指针，挡不全。
 */
export const CANCEL_ARM_MS = 600;

/**
 * 小条上的点和字：一个接一个涌起来，前后隔这么久；整个节拍这么长（样式表 ink-rec-crest 那一段用的是同一个数）。
 * 三个点排在最前面，字从第四个起。
 */
const CREST_STAGGER_MS = 65;
const CREST_PERIOD_MS = 1500;
const CREST_DOTS = 3;

const nowMs = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

/**
 * 圈里的东西起伏多大（CSS 像素，按圈高的 5% 算，夹在这中间）、一道浪走一个浪长要多久。另叠一道短一点、反着走、
 * 小一点的浪（RIPPLE_SECOND），两道一合，起伏才像水面，不像一条正弦在平移。
 */
const RIPPLE_AMP_MIN = 2;
const RIPPLE_AMP_MAX = 7;
const RIPPLE_PERIOD_MS = 1200;
const RIPPLE_SECOND = Object.freeze({ amp: 0.35, len: 0.53, period: 1.7 });
/**
 * 认得再快，圈里的东西也至少起伏这么久才平下去：机上一块小圈不到半秒就认完，浪刚起来就没了，看不出是在认。
 * 只拖起伏，不拖结果——单子照常时候出来。
 */
const RIPPLE_HOLD_MS = 700;
/**
 * 起伏涨上来、平下去按时间走（时间常数，毫秒），不按帧：平板上认着的时候一帧三四十毫秒，按帧走要一秒多才平下去。
 * 竖条按设备像素切（两个设备像素一条），一块再宽也最多切这么多条：按 CSS 像素切，平板上一条五个设备像素宽，相邻
 * 两条错开的那一点在斜着的边上是一级一级的锯齿（机上录屏放大看得见）。
 */
const RIPPLE_EASE_MS = 150;
const RIPPLE_SLICES = 600;

export const RECOGNIZE_STATES = Object.freeze({
  IDLE: 'idle', SCANNING: 'scanning', RESULTS: 'results', EMPTY: 'empty', ERROR: 'error',
});

let uid = 0;

const reduceMotion = () => {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch (_) { return false; }
};

/** 屏幕上一圈点 → SVG 的 path。 */
const pathOf = (points) => (points?.length >= 3
  ? `M${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}Z` : '');

function boundsOf(points) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of points || []) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * 一段字放进系统剪贴板。WebView 里 navigator.clipboard 要在人点了一下之后才给用（复制正是点出来的）；
 * 用不了就退回老办法：一个看不见的文本框、选中、execCommand('copy')。
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* 退回老办法 */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.('copy') ?? false;
    area.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

export class RecognizeOverlay {
  /**
   * @param {Element} host 挂在哪（笔迹画布的父节点，定位过的）
   * @param {{onCancel?: function(), onRetry?: function(), onClose?: function(),
   *          onCopy?: function(Array): (Promise|void), onConvert?: function(Array): (Promise|void)}} handlers
   */
  constructor(host, handlers = {}) {
    this.host = host;
    this.handlers = handlers;
    this.el = null;
    this._id = ++uid;
    this._state = RECOGNIZE_STATES.IDLE;
    this._items = [];
    this._picked = new Set();
    this._points = null;
    this._viewport = null;
    this._timers = [];
    // 小条上的按钮从什么时候起算数、最近一次在小条上按下去的是哪颗按钮（见 _arm、_counts）。
    this._armedAt = 0;
    this._armTimer = 0;
    this._down = null;
    this._onKey = (e) => {
      if (e.key !== 'Escape' || this._state === RECOGNIZE_STATES.IDLE) return;
      if (this.el?.querySelector('.ink-recognize-edit:not([hidden])') === document.activeElement) return;
      e.preventDefault();
      e.stopPropagation();
      if (this._state === RECOGNIZE_STATES.SCANNING) this.handlers.onCancel?.();
      else this.handlers.onClose?.();
    };
  }

  get state() { return this._state; }
  get active() { return this._state !== RECOGNIZE_STATES.IDLE; }

  _later(fn, ms) {
    const id = setTimeout(fn, ms);
    this._timers.push(id);
    return id;
  }

  _clearTimers() {
    for (const id of this._timers) clearTimeout(id);
    this._timers = [];
  }

  /**
   * 小条上的按钮先淡着、不算数，ms 以后才算（见 CANCEL_ARM_MS）。计时不和 _timers 放在一起：认得快的时候，等着的
   * 这一会儿里小条就换成了「知道了」「再试一次」，换的时候会清掉 _timers，按钮就一直淡着了。
   */
  _arm(ms) {
    clearTimeout(this._armTimer);
    this._armedAt = nowMs() + ms;
    this._down = null;
    this._syncArmed();
    this._armTimer = setTimeout(() => {
      this._armTimer = 0;
      // 计时器和 nowMs 不是同一块表，可能早到零点几毫秒：到点了就是到点了。
      this._armedAt = Math.min(this._armedAt, nowMs());
      this._syncArmed();
    }, ms);
  }

  _syncArmed() {
    if (!this.el) return;
    const arming = nowMs() < this._armedAt;
    for (const role of ['pill-close', 'retry']) {
      const button = this._$(role);
      button.classList.toggle('is-arming', arming);
      if (arming) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
  }

  /**
   * 小条上这一下 click 算不算数：按钮冒出来 CANCEL_ARM_MS 以内不算；之后也只认在这颗按钮上按下去的那一下——点「识别」
   * 抬手时补来的 click、等着的时候就按下去的、按在别处滑过来松开的，都不算。键盘按的（回车、空格）、程序点的没有指针，
   * 也就没有按下那一下，过了等的那一会儿照算。手点、笔点的认 pointerType，不认 detail：平板 WebView 里手指点出来的
   * click，detail 也是 0（10-23 机上记到的）。
   */
  _counts(e, button) {
    if (nowMs() < this._armedAt) return false;
    if (!e?.pointerType) return true;
    const down = this._down;
    return !!down && down.button === button && down.at >= this._armedAt;
  }

  _build() {
    if (this.el) return;
    const id = this._id;
    const el = document.createElement('div');
    el.className = 'ink-recognize';
    el.dataset.state = RECOGNIZE_STATES.IDLE;
    el.innerHTML = `
      <!-- 圈里那一块自己像水面一样起伏：截图（连同圈里的笔迹、贴着的图）一竖条一竖条地上下错开画，盖在原来的样子上（见 ripple）。 -->
      <canvas class="ink-recognize-ripple" data-role="ripple" aria-hidden="true" hidden></canvas>
      <svg class="ink-recognize-scan" aria-hidden="true">
        <defs>
          <clipPath id="ink-rec-clip-${id}"><path data-role="clip"></path></clipPath>
        </defs>
        <path class="ink-recognize-wash" data-role="wash"></path>
        <!-- 起伏的那块画布压住了套索线靠里的半边：照套索线的样子在上面再描一遍（不是另一条线，见 ink-recognize.css）。 -->
        <path class="ink-recognize-outline" data-role="outline"></path>
        <g class="ink-recognize-boxes" data-role="boxes"></g>
      </svg>
      <div class="ink-recognize-pill" data-role="pill" role="status" aria-live="polite">
        <span class="ink-recognize-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="ink-recognize-label" data-role="label"></span>
        <!-- 认着的时候眼睛看的是这一份：同一句话，一个字一个 span，跟着浪起伏（见 _syncCrest）。读屏读上面那一份。 -->
        <span class="ink-recognize-crest" data-role="crest" aria-hidden="true"></span>
        <button type="button" class="ink-recognize-pill-btn" data-role="retry" hidden></button>
        <button type="button" class="ink-recognize-pill-btn" data-role="pill-close"></button>
      </div>
      <div class="ink-recognize-panel" data-role="panel" role="dialog" hidden>
        <div class="ink-recognize-head">
          <span class="ink-recognize-title" data-role="title"></span>
          <span class="ink-recognize-tag" data-role="tag" hidden></span>
          <button type="button" class="ink-recognize-close" data-role="close"></button>
        </div>
        <div class="ink-recognize-hint" data-role="hint"></div>
        <div class="ink-recognize-list" data-role="list" role="listbox" aria-multiselectable="true"></div>
        <div class="ink-recognize-foot">
          <button type="button" class="ink-recognize-btn" data-role="copy"></button>
          <button type="button" class="ink-recognize-btn is-primary" data-role="convert"></button>
        </div>
      </div>`;
    const $ = (role) => el.querySelector(`[data-role="${role}"]`);
    this._$ = $;
    // 按在条、单子上的手指不许漏到底下：底下是画布和书页，漏下去就是一笔、一次翻页。
    for (const part of [$('pill'), $('panel')]) {
      part.addEventListener('pointerdown', (e) => e.stopPropagation());
      part.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    }
    // 小条上按下去的是哪颗按钮、什么时候：松开时的那一下 click 要对得上它才算（见 _counts）。
    $('pill').addEventListener('pointerdown', (e) => {
      this._down = { button: e.target?.closest?.('button') || null, at: nowMs() };
    });
    $('pill-close').addEventListener('click', (e) => {
      if (!this._counts(e, $('pill-close'))) return;
      if (this._state === RECOGNIZE_STATES.SCANNING) this.handlers.onCancel?.();
      else this.handlers.onClose?.();
    });
    $('retry').addEventListener('click', (e) => {
      if (this._counts(e, $('retry'))) this.handlers.onRetry?.();
    });
    $('close').addEventListener('click', () => this.handlers.onClose?.());
    $('copy').addEventListener('click', () => this._act('copy'));
    $('convert').addEventListener('click', () => this._act('convert'));
    $('close').setAttribute('aria-label', t('ocr.close'));
    $('close').textContent = '✕';
    this.host.appendChild(el);
    this.el = el;
  }

  _setState(state) {
    this._state = state;
    if (!this.el) return;
    this.el.dataset.state = state;
    // 扫着的时候告诉液态玻璃「有东西在动」：它换成手在屏幕上时那一版（只弯一次），扫完再换回去。不说的话，扫光每动
    // 一帧，整页的玻璃都按静止那一版（色散）重画一遍，平板上一帧几十毫秒。
    if (state === RECOGNIZE_STATES.SCANNING) {
      this.el.setAttribute('data-lens-moving', '');
      try { window.dispatchEvent(new Event('glassbusy')); } catch (_) { /* 没有 window（测试）就算了 */ }
    } else {
      this.el.removeAttribute('data-lens-moving');
    }
    if (state === RECOGNIZE_STATES.IDLE) document.removeEventListener('keydown', this._onKey, true);
    else document.addEventListener('keydown', this._onKey, true);
  }

  /** 开始扫：points 是屏幕上的圈（相对 host 的 CSS 像素）。 */
  scan(points, viewport) {
    this._build();
    this._clearTimers();
    this._stopRipple();
    this._items = [];
    this._picked.clear();
    this._$('panel').hidden = true;
    this._$('boxes').replaceChildren();
    this.el.classList.toggle('is-reduced', reduceMotion());
    this._setState(RECOGNIZE_STATES.SCANNING);
    // 小条上的点和字从这一刻起按一个节拍涌（三个点也是这一刻重新起跳：小条刚露出来，或者刚摘掉 is-still）。上一回
    // 留下的那几个字的 span 按的是上一回的节拍，先清掉，和三个点一起从头来。
    this._crestStart = nowMs();
    this._$('crest').replaceChildren();
    this._pill(t('ocr.scanning'), { close: t('ocr.cancel') });
    // 小条冒在「识别」那颗按钮原来的地方：「取消」先淡着，等一会儿才算数（见 CANCEL_ARM_MS）。
    this._arm(CANCEL_ARM_MS);
    this.place(points, viewport);
    this._later(() => {
      if (this._state === RECOGNIZE_STATES.SCANNING) this._setLabel(t('ocr.scanningSlow'));
    }, SLOW_MS);
  }

  /** 引擎报的进度（0..1）：小条上带一个百分比。 */
  progress(fraction) {
    if (this._state !== RECOGNIZE_STATES.SCANNING || !this.el || !Number.isFinite(fraction)) return;
    const base = this._$('label').textContent.replace(/\s*\d+%$/, '');
    this._setLabel(`${base} ${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`);
  }

  /** 小条上那句话。读屏读的、测试量的都是 label 这一份；认着的时候眼睛看的是跟着浪起伏的那一份（_syncCrest）。 */
  _setLabel(text) {
    this._$('label').textContent = text;
    this._syncCrest();
  }

  /**
   * 认着的时候，小条上的字和圈里那片浪一个样子：前面三个点、后面一个字接一个字，依次涌起来、亮一下，像一道浪从头
   * 传到尾（人说「下面的字也要有如此效果」）。
   *
   * 换字的时候（认得久了补的那句、进度的百分比）接着原来的节拍走，不从头来：已经在起伏的那几个 span 只换字、不换
   * span——span 一换，它的动画就从头算起，而从头算起的那一刻是浏览器下一次排样式的时候，不是这里说的时候，节拍就
   * 和三个点错开了（预览里量到差了四百多毫秒）。多出来的字才新排一个 span，animation-delay 往回拨掉「从开始扫到
   * 现在」那一段，一出来就在它该在的那个起伏上。不认了、或者减少动态效果：这一份空着，眼睛看的就是 label 本身。
   */
  _syncCrest() {
    const crest = this._$('crest');
    if (this._state !== RECOGNIZE_STATES.SCANNING || this.el.classList.contains('is-reduced')) {
      crest.replaceChildren();
      return;
    }
    const chars = [...this._$('label').textContent];
    const spans = crest.children;
    while (spans.length > chars.length) spans[spans.length - 1].remove();
    const elapsed = (nowMs() - (this._crestStart ?? nowMs())) % CREST_PERIOD_MS;
    chars.forEach((ch, i) => {
      let span = spans[i];
      if (!span) {
        span = document.createElement('span');
        span.className = 'ink-recognize-ch';
        span.style.animationDelay = `${Math.round((CREST_DOTS + i) * CREST_STAGGER_MS - elapsed)}ms`;
        crest.appendChild(span);
      }
      if (span.textContent !== ch) span.textContent = ch;
    });
  }

  /**
   * 圈里的东西像水面一样起伏：source 是那一块的样子（截图连同圈里的笔迹、贴着的图），rect 是它在屏幕上的位置。
   * 一竖条一竖条地上下错开画（两道浪叠着走，见 RIPPLE_SECOND），盖在原来那一块上、按圈裁着；不另铺颜色。起伏从 0
   * 慢慢涨上来，接上那一刻和原来一模一样，看不出换过。不认了就慢慢落回 0 再收起——认得再快也至少起伏到开始扫以后
   * RIPPLE_HOLD_MS。减少动态效果：不做。
   */
  ripple(source, rect) {
    if (!this.el || !source || !rect || this._state !== RECOGNIZE_STATES.SCANNING
      || this.el.classList.contains('is-reduced')) return;
    this._ripple = { source, amp: 0 };
    this._placeRipple(rect);
    this._$('ripple').hidden = false;
    if (!this._rippleFrame) this._rippleFrame = requestAnimationFrame(this._rippleTick);
  }

  _placeRipple(rect) {
    const r = this._ripple;
    if (!r || !rect || !(rect.width > 0) || !(rect.height > 0)) return;
    r.rect = rect;
    const canvas = this._$('ripple');
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    const d = pathOf((this._points || []).map((p) => ({ x: p.x - rect.x, y: p.y - rect.y })));
    canvas.style.clipPath = d ? `path('${d}')` : '';
  }

  /**
   * 一帧：起伏往目标值走（认着、或者还没起伏够 RIPPLE_HOLD_MS 是满的，不认了是 0），再画：先把原样整张垫在底下，
   * 再一竖条一竖条地错开画在上面——错开露出的那一道缝里是原样，不会露出底下真的那一页、叠出两份。落回 0 就收起。
   */
  _rippleTick = (now) => {
    this._rippleFrame = 0;
    const r = this._ripple;
    const canvas = this._$('ripple');
    const ctx = r && canvas.getContext?.('2d');
    if (!r || !ctx || !r.rect) { this._stopRipple(); return; }
    const live = this._state === RECOGNIZE_STATES.SCANNING || nowMs() < (this._crestStart ?? 0) + RIPPLE_HOLD_MS;
    const target = live ? Math.min(RIPPLE_AMP_MAX, Math.max(RIPPLE_AMP_MIN, r.rect.height * 0.05)) : 0;
    const dt = r.last == null ? 16 : Math.min(64, Math.max(0, now - r.last));
    r.last = now;
    r.amp += (target - r.amp) * (1 - Math.exp(-dt / RIPPLE_EASE_MS));
    if (!live && r.amp < 0.05) { this._stopRipple(); return; }
    // 在设备像素里画：dy 按 CSS 像素算好再乘 dpr。
    const W = canvas.width;
    const H = canvas.height;
    const dpr = W / r.rect.width;
    const len = Math.min(280, Math.max(100, r.rect.width * 0.6));
    const step = Math.max(2, Math.ceil(W / RIPPLE_SLICES));
    const sw = r.source.width / W;
    const tau = Math.PI * 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(r.source, 0, 0, W, H);
    for (let X = 0; X < W; X += step) {
      const x = X / dpr;
      const dy = r.amp * (Math.sin(((x / len) - now / RIPPLE_PERIOD_MS) * tau)
        + RIPPLE_SECOND.amp * Math.sin(((x / (len * RIPPLE_SECOND.len)) + now / (RIPPLE_PERIOD_MS * RIPPLE_SECOND.period)) * tau));
      ctx.drawImage(r.source, X * sw, 0, step * sw, r.source.height, X, dy * dpr, step + 0.5, H);
    }
    this._rippleFrame = requestAnimationFrame(this._rippleTick);
  };

  _stopRipple() {
    if (this._rippleFrame) cancelAnimationFrame(this._rippleFrame);
    this._rippleFrame = 0;
    const r = this._ripple;
    this._ripple = null;
    if (!this.el) return;
    const canvas = this._$('ripple');
    canvas.hidden = true;
    if (r) { canvas.width = 0; canvas.height = 0; }
    if (r?.source) { r.source.width = 0; r.source.height = 0; }
  }

  /** 摆到圈上（缩放、平移、转屏之后再叫一次）。rippleRect：圈里那一块的样子在屏幕上的位置（有就跟着挪）。 */
  place(points, viewport, rippleRect = null) {
    if (!this.el) return;
    if (points) this._points = points;
    if (viewport) this._viewport = viewport;
    if (rippleRect && this._ripple) this._placeRipple(rippleRect);
    const pts = this._points;
    const v = this._viewport || { width: this.host.clientWidth || 0, height: this.host.clientHeight || 0 };
    const box = boundsOf(pts);
    if (!box) return;
    const d = pathOf(pts);
    this._$('clip').setAttribute('d', d);
    this._$('wash').setAttribute('d', d);
    this._$('outline').setAttribute('d', d);
    this._placeFloating(this._$('pill'), box, v);
    if (!this._$('panel').hidden) this._placeFloating(this._$('panel'), box, v);
  }

  /** 条、单子摆在圈下面；下面放不下就翻到上面；都不够就贴着下沿（和套索那条小条一个规矩）。 */
  _placeFloating(node, box, v) {
    if (!node || node.hidden) return;
    const w = node.offsetWidth || 0;
    const h = node.offsetHeight || 0;
    let top = box.maxY + GAP;
    if (top + h > v.height - EDGE) top = box.minY - GAP - h;
    if (top < EDGE) top = Math.max(EDGE, v.height - h - EDGE);
    let left = (box.minX + box.maxX) / 2 - w / 2;
    left = Math.max(EDGE, Math.min(left, v.width - w - EDGE));
    // 圈在页边时单子会落到浮着的工具栏底下，平板上标题只露出半截：横着挪开（见 float-avoid.js）。
    left = avoidFloatingObstacles(this.host, left, top, w, h, v, EDGE);
    node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  _pill(label, { close = '', retry = '', hideDots = false } = {}) {
    const pill = this._$('pill');
    pill.hidden = false;
    pill.classList.toggle('is-still', hideDots);
    this._setLabel(label);
    const retryBtn = this._$('retry');
    retryBtn.hidden = !retry;
    retryBtn.textContent = retry;
    this._$('pill-close').textContent = close || t('ocr.close');
    if (this._points) this._placeFloating(pill, boundsOf(this._points), this._viewport || { width: 0, height: 0 });
  }

  /**
   * 认出来了。
   * @param {Array} items normalizeOcrItems 给的
   * @param {{mock?: boolean, boxes?: Array<?{x, y, width, height}>}} [opts]
   *   boxes：每一条在屏幕上的位置（相对 host 的 CSS 像素），有就在图上框出来
   */
  results(items, { mock = false, boxes = [] } = {}) {
    this._build();
    this._clearTimers();
    this._items = items.map((item) => ({ ...item }));
    this._picked = new Set(this._items.map((item) => item.id));
    this._setState(RECOGNIZE_STATES.RESULTS);
    this._$('pill').hidden = true;
    // 先框：认出来的几处依次亮出来，告诉人「是这几处」。
    const group = this._$('boxes');
    group.replaceChildren();
    let shown = 0;
    (boxes || []).forEach((b) => {
      if (!b) return;
      const rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('class', 'ink-recognize-box');
      rect.setAttribute('x', String(b.x));
      rect.setAttribute('y', String(b.y));
      rect.setAttribute('width', String(Math.max(1, b.width)));
      rect.setAttribute('height', String(Math.max(1, b.height)));
      rect.setAttribute('rx', '5');
      rect.style.setProperty('--i', String(shown++));
      group.appendChild(rect);
    });
    this._$('title').textContent = t('ocr.resultsTitle', { count: this._items.length });
    const tag = this._$('tag');
    tag.hidden = !mock;
    tag.textContent = t('ocr.mockTag');
    this._$('hint').textContent = t('ocr.resultsHint');
    this._renderList();
    this._syncFoot();
    const panel = this._$('panel');
    const reveal = () => {
      if (this._state !== RECOGNIZE_STATES.RESULTS) return;
      panel.hidden = false;
      panel.classList.remove('is-in');
      this._placeFloating(panel, boundsOf(this._points), this._viewport || { width: 0, height: 0 });
      // 下一帧再加 is-in：先以「还没浮上来」的样子摆好，过渡才演得出来。
      const nextFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
      nextFrame(() => panel.classList.add('is-in'));
    };
    if (reduceMotion() || !shown) reveal();
    else this._later(reveal, Math.min(BOXES_MAX_MS, 160 + shown * 70));
  }

  empty() {
    this._build();
    this._clearTimers();
    this._setState(RECOGNIZE_STATES.EMPTY);
    this._$('panel').hidden = true;
    this._pill(t('ocr.empty'), { close: t('ocr.ok'), hideDots: true });
  }

  /** @param {string} code OCR_ERRORS 里的一个 */
  error(code) {
    this._build();
    this._clearTimers();
    this._setState(RECOGNIZE_STATES.ERROR);
    this._$('panel').hidden = true;
    const label = code === 'OCR_TIMEOUT' ? t('ocr.timeout')
      : code === 'OCR_UNAVAILABLE' ? t('ocr.unavailable')
        : code === 'TYPESET_FAILED' ? t('ocr.convertFailed') : t('ocr.failed');
    // 没接引擎、写不成笔迹：再试一次也是一样，不给那颗按钮。
    const retry = code === 'OCR_UNAVAILABLE' || code === 'TYPESET_FAILED' ? '' : t('ocr.retry');
    this._pill(label, { close: t('ocr.close'), retry, hideDots: true });
  }

  /** 正在写成笔迹：两颗按钮按不下去，「转为笔迹」上说一声。 */
  busy(on) {
    if (!this.el) return;
    this.el.classList.toggle('is-busy', !!on);
    this._syncFoot();
  }

  close() {
    this._clearTimers();
    clearTimeout(this._armTimer);
    this._armTimer = 0;
    if (!this.el) return;
    this._stopRipple();
    this._setState(RECOGNIZE_STATES.IDLE);
    this._$('panel').hidden = true;
    this._$('panel').classList.remove('is-in');
    this._$('boxes').replaceChildren();
    this.el.classList.remove('is-busy');
  }

  destroy() {
    this.close();
    this.el?.remove();
    this.el = null;
  }

  /** 人挑中的那几条（照单子上的次序），连同改过的字。 */
  picked() {
    return this._items.filter((item) => this._picked.has(item.id));
  }

  _renderList() {
    const list = this._$('list');
    list.replaceChildren();
    this._items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'ink-recognize-row';
      row.dataset.id = item.id;
      row.setAttribute('role', 'option');
      row.style.setProperty('--i', String(i));
      row.innerHTML = `
        <span class="ink-recognize-tick" aria-hidden="true">✓</span>
        <span class="ink-recognize-kind"></span>
        <span class="ink-recognize-preview"></span>
        <input class="ink-recognize-edit" type="text" hidden>
        <span class="ink-recognize-doubt" hidden>?</span>
        <button type="button" class="ink-recognize-edit-btn">✎</button>`;
      row.querySelector('.ink-recognize-kind').textContent = item.kind === 'math' ? t('ocr.kindMath') : t('ocr.kindText');
      const doubt = row.querySelector('.ink-recognize-doubt');
      if (item.confidence != null && item.confidence < 0.6) {
        doubt.hidden = false;
        doubt.title = t('ocr.doubt');
      }
      const editBtn = row.querySelector('.ink-recognize-edit-btn');
      editBtn.setAttribute('aria-label', t('ocr.edit'));
      editBtn.title = t('ocr.edit');
      this._paintPreview(row, item);
      row.addEventListener('click', (e) => {
        if (e.target.closest('.ink-recognize-edit, .ink-recognize-edit-btn')) return;
        if (this._picked.has(item.id)) this._picked.delete(item.id);
        else this._picked.add(item.id);
        this._syncRows();
        this._syncFoot();
      });
      editBtn.addEventListener('click', () => this._edit(row, item));
      list.appendChild(row);
    });
    this._syncRows();
  }

  _syncRows() {
    for (const row of this._$('list').children) {
      const on = this._picked.has(row.dataset.id);
      row.classList.toggle('is-selected', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  _syncFoot() {
    if (!this.el) return;
    const none = this._picked.size === 0;
    const busy = this.el.classList.contains('is-busy');
    const copy = this._$('copy');
    const convert = this._$('convert');
    copy.disabled = none || busy;
    convert.disabled = none || busy;
    if (!copy.dataset.flash) copy.textContent = t('ocr.copy');
    convert.textContent = busy ? t('ocr.converting') : t('ocr.convert');
  }

  _paintPreview(row, item) {
    const preview = row.querySelector('.ink-recognize-preview');
    preview.textContent = item.kind === 'math' ? item.latex : item.text;
    if (item.kind !== 'math') return;
    preview.classList.add('is-math');
    // 和写成笔迹的是同一个排法（katex-ink.js）：单子上看着什么样，写出来就是什么样。
    loadKatex().then((katex) => {
      if (!katex || !preview.isConnected) return;
      try {
        renderFormula(katex, item.latex, preview);
      } catch (_) { preview.textContent = item.latex; }
    });
  }

  /** 改一条认错的：公式改 LaTeX，文字改文字。回车、点别处就算改好；Esc 不改。 */
  _edit(row, item) {
    const input = row.querySelector('.ink-recognize-edit');
    const preview = row.querySelector('.ink-recognize-preview');
    input.value = item.kind === 'math' ? item.latex : item.text;
    input.hidden = false;
    preview.hidden = true;
    row.classList.add('is-editing');
    input.focus();
    input.select?.();
    const done = (commit) => {
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
      const value = input.value.replace(/\s+/g, ' ').trim();
      if (commit && value) {
        if (item.kind === 'math') { item.latex = value; item.text = value; } else item.text = value;
        this._picked.add(item.id);
      }
      input.hidden = true;
      preview.hidden = false;
      row.classList.remove('is-editing');
      this._paintPreview(row, item);
      this._syncRows();
      this._syncFoot();
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    };
    const onBlur = () => done(true);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  }

  async _act(kind) {
    const items = this.picked();
    if (!items.length) return;
    if (kind === 'copy') {
      await this.handlers.onCopy?.(items);
      // 按钮上说一声「已复制」，一会儿换回来：复制是看不见的动作，不说的话人会再点一次。
      const copy = this._$('copy');
      copy.dataset.flash = '1';
      copy.textContent = t('ocr.copied', { count: items.length });
      copy.classList.add('is-done');
      this._later(() => {
        delete copy.dataset.flash;
        copy.classList.remove('is-done');
        this._syncFoot();
      }, 1400);
      return;
    }
    this.busy(true);
    try {
      await this.handlers.onConvert?.(items);
    } finally {
      this.busy(false);
    }
  }
}
