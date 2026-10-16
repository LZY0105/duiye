// Ink Module —— 套索圈一块之后「识别」的那一整段界面：扫描时的动画、进度、结果单子、出错时说什么。
//
// 识别要一会儿（本机跑模型，一两秒到十几秒）。这一会儿里人得一直知道三件事：它在认（没卡死）、认的是哪一块、
// 不想等了怎么停。所以：
//   - 扫描：只照亮圈里那一块（圈外一点不碰），一道光从上往下扫，圈线变成流动的虚线；圈下面一个小条，跳动的三个点、
//     「正在识别…」、有进度就带百分比，右边「取消」。认得久了（4 秒）小条上补一句「内容多会久一点」。
//   - 找到了：扫光淡出，认出来的那几处在图上依次框出来（「是这几处」），框完结果单子从下面浮上来。
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

  _build() {
    if (this.el) return;
    const id = this._id;
    const el = document.createElement('div');
    el.className = 'ink-recognize';
    el.dataset.state = RECOGNIZE_STATES.IDLE;
    el.innerHTML = `
      <svg class="ink-recognize-scan" aria-hidden="true">
        <defs>
          <clipPath id="ink-rec-clip-${id}"><path data-role="clip"></path></clipPath>
          <linearGradient id="ink-rec-band-${id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="currentColor" stop-opacity="0"></stop>
            <stop offset="0.6" stop-color="currentColor" stop-opacity="0.22"></stop>
            <stop offset="0.68" stop-color="currentColor" stop-opacity="0.42"></stop>
            <stop offset="1" stop-color="currentColor" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        <path class="ink-recognize-wash" data-role="wash"></path>
        <g clip-path="url(#ink-rec-clip-${id})">
          <rect class="ink-recognize-band" data-role="band" fill="url(#ink-rec-band-${id})"></rect>
        </g>
        <path class="ink-recognize-outline" data-role="outline"></path>
        <g class="ink-recognize-boxes" data-role="boxes"></g>
      </svg>
      <div class="ink-recognize-pill" data-role="pill" role="status" aria-live="polite">
        <span class="ink-recognize-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="ink-recognize-label" data-role="label"></span>
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
    $('pill-close').addEventListener('click', () => {
      if (this._state === RECOGNIZE_STATES.SCANNING) this.handlers.onCancel?.();
      else this.handlers.onClose?.();
    });
    $('retry').addEventListener('click', () => this.handlers.onRetry?.());
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
    this._items = [];
    this._picked.clear();
    this._$('panel').hidden = true;
    this._$('boxes').replaceChildren();
    this.el.classList.toggle('is-reduced', reduceMotion());
    this._setState(RECOGNIZE_STATES.SCANNING);
    this._pill(t('ocr.scanning'), { close: t('ocr.cancel') });
    this.place(points, viewport);
    this._later(() => {
      if (this._state === RECOGNIZE_STATES.SCANNING) this._$('label').textContent = t('ocr.scanningSlow');
    }, SLOW_MS);
  }

  /** 引擎报的进度（0..1）：小条上带一个百分比。 */
  progress(fraction) {
    if (this._state !== RECOGNIZE_STATES.SCANNING || !this.el || !Number.isFinite(fraction)) return;
    const label = this._$('label');
    const base = label.textContent.replace(/\s*\d+%$/, '');
    label.textContent = `${base} ${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }

  /** 摆到圈上（缩放、平移、转屏之后再叫一次）。 */
  place(points, viewport) {
    if (!this.el) return;
    if (points) this._points = points;
    if (viewport) this._viewport = viewport;
    const pts = this._points;
    const v = this._viewport || { width: this.host.clientWidth || 0, height: this.host.clientHeight || 0 };
    const box = boundsOf(pts);
    if (!box) return;
    const d = pathOf(pts);
    this._$('clip').setAttribute('d', d);
    this._$('wash').setAttribute('d', d);
    this._$('outline').setAttribute('d', d);
    const band = this._$('band');
    const h = box.maxY - box.minY;
    const bandH = Math.max(28, h * 0.45);
    band.setAttribute('x', String(box.minX));
    band.setAttribute('y', String(box.minY));
    band.setAttribute('width', String(Math.max(1, box.maxX - box.minX)));
    band.setAttribute('height', String(bandH));
    band.style.setProperty('--sweep-from', `${-bandH}px`);
    band.style.setProperty('--sweep-to', `${h}px`);
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
    this._$('label').textContent = label;
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
    if (!this.el) return;
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
