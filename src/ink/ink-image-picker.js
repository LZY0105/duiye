// Ink Module —— 「插入图片」：页上先占一个框，旁边一张单子挑图。
//
// 人说「点图片的按钮出来的菜单如图1」：图 1 里页上先出一个虚线框、中间一个图片的样子（图会放在这儿），旁边浮着
// 一张单子——上面「最近照片」一格一格的缩略图，下面「拍照」「从图库中选择」两行。挑了哪一张，那张就等比放进
// 那个框里（ink-surface.js 的 insertImage）。框和单子用这里三套皮肤自己的颜色（纸里不许有黄）。
//
//   · 最近照片：原生那一侧在才有（photo-source.js）；没有「所有文件访问」就说一句、给一颗「去打开」。
//   · 拍照、从图库中选择：两个藏起来的 <input type="file">，一个带 capture（Capacitor 会直接开系统相机）。
//   · 点单子外面、按 Esc：收起，什么都不放。点在页上的那一下只是收起，不顺手写一笔。
//
// 这一块是 DOM，挂在画布的父节点上（和套索那条小条、识别那一套一样）。框在页上的位置由调用方给（屏幕上的
// CSS 像素），单子按框摆：右边放得下放右边，不然左边，再不然下面；也躲开浮着的工具栏（float-avoid.js）。

import { t } from '../core/i18n.js';
import { avoidFloatingObstacles } from './float-avoid.js';
import * as photoSource from './photo-source.js';

const SVGNS_ATTRS = 'viewBox="0 0 24 24" aria-hidden="true"';
const ICON_IMAGE = `<svg ${SVGNS_ATTRS}><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m4.5 17.5 5-5 3.5 3.5 2.5-2.5 4 4"/></svg>`;
const ICON_CAMERA = `<svg ${SVGNS_ATTRS}><path d="M4.5 8.5a2 2 0 0 1 2-2h1.6l1.4-2h5l1.4 2h1.6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.4"/></svg>`;
const ICON_GALLERY = `<svg ${SVGNS_ATTRS}><rect x="3.5" y="5.5" width="14" height="14" rx="2.5"/><path d="M7 3.5h11a2.5 2.5 0 0 1 2.5 2.5v11"/><circle cx="8.3" cy="10.2" r="1.5"/><path d="m4 17.5 4-4 3 3 2-2 4.5 4.5"/></svg>`;

/** 单子离框多远、离容器边多远，CSS 像素。 */
const GAP = 12;
const EDGE = 8;
/** 框缩到多矮为止（四边都放不下单子、只好把框缩小的时候）。 */
const SLOT_MIN_HEIGHT = 48;

const sameRect = (a, b) => !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 0.5);

/**
 * 框和单子怎么摆（都是相对容器的 CSS 像素）。
 *
 * 单子挨着框：右边、左边（上下对着框的正中），下面、上面（左右对着框的正中），哪边整个放得下放哪边。四边都放不下
 * ——窄的那一栏、竖着的那一栏，框在正中、单子比两边的空都宽——就把框挪开给单子让地方，而不是让单子压在框上
 * （机上 10-17 右边那一栏就是这样，框整个被单子盖住了）：先试上下叠着（整组在容器里上下居中），再试左右并排，
 * 再不行把框缩小到上下叠得下为止（不矮过 SLOT_MIN_HEIGHT）。
 *
 * @param {{x: number, y: number, width: number, height: number}} slot 调用方给的框
 * @param {{width: number, height: number}} size 单子多大
 * @param {{width: number, height: number}} v 容器多大
 * @returns {{slot: object, card: {left: number, top: number}}} slot 是框最后在哪（没挪就是原来那个）
 */
export function layoutPicker(slot, size, v, gap = GAP, edge = EDGE) {
  const { width: w, height: h } = size;
  const fitsX = (left) => left >= edge && left + w <= v.width - edge;
  const fitsY = (top) => top >= edge && top + h <= v.height - edge;
  const clampX = (left) => Math.max(edge, Math.min(left, v.width - w - edge));
  const clampY = (top) => Math.max(edge, Math.min(top, v.height - h - edge));
  const besideTop = clampY(slot.y + slot.height / 2 - h / 2);
  if (fitsX(slot.x + slot.width + gap)) return { slot, card: { left: slot.x + slot.width + gap, top: besideTop } };
  if (fitsX(slot.x - gap - w)) return { slot, card: { left: slot.x - gap - w, top: besideTop } };
  const underLeft = clampX(slot.x + slot.width / 2 - w / 2);
  if (fitsY(slot.y + slot.height + gap)) return { slot, card: { left: underLeft, top: slot.y + slot.height + gap } };
  if (fitsY(slot.y - gap - h)) return { slot, card: { left: underLeft, top: slot.y - gap - h } };
  const roomY = v.height - 2 * edge;
  if (slot.height + gap + h <= roomY) {
    const top = edge + (roomY - (slot.height + gap + h)) / 2;
    return { slot: { ...slot, y: top }, card: { left: underLeft, top: top + slot.height + gap } };
  }
  const roomX = v.width - 2 * edge;
  if (slot.width + gap + w <= roomX) {
    const left = edge + (roomX - (slot.width + gap + w)) / 2;
    return { slot: { ...slot, x: left }, card: { left: left + slot.width + gap, top: besideTop } };
  }
  const k = Math.max(SLOT_MIN_HEIGHT, roomY - gap - h) / slot.height;
  const sw = slot.width * k;
  const sh = slot.height * k;
  const top = edge + Math.max(0, (roomY - (sh + gap + h)) / 2);
  const moved = { x: slot.x + (slot.width - sw) / 2, y: top, width: sw, height: sh };
  return { slot: moved, card: { left: clampX(moved.x + sw / 2 - w / 2), top: clampY(top + sh + gap) } };
}
/** 「最近照片」最多列几张，缩略图同时要几张。 */
const RECENT_LIMIT = 30;
const THUMB_PARALLEL = 3;

export class ImagePicker {
  /**
   * @param {Element} host 画布的父节点（定位过的）
   * @param {{onPick: function(Blob): Promise<boolean>, onClose?: function(), onSlotMove?: function(object)}} handlers
   *   onPick 拿到人挑的那张图（Blob），放进去了回 true；放不进去回 false，单子上说一声；
   *   onSlotMove 框给单子让了地方（新的框，相对容器的 CSS 像素）——图要放进人看见的那个框里
   * @param {{source?: object}} [options] 最近照片从哪儿来（测试换成假的）
   */
  constructor(host, handlers, { source = photoSource } = {}) {
    this.host = host;
    this.handlers = handlers;
    this.source = source;
    this.el = null;
    this._rect = null;
    this._viewport = null;
    this._busy = false;
    this._onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    };
    // 按在单子外面：收起。按在页上的那一下吞掉——收起单子是一件事，写一笔是另一件事。
    this._onOutside = (e) => {
      if (!this.el || this.el.querySelector('.ink-image-card')?.contains(e.target)) return;
      if (this.host.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      this.close();
    };
    // 去系统设置里打开权限，回来时再列一次。
    this._onVisible = () => {
      if (document.visibilityState === 'visible' && this.el && this._waitingPermission) {
        this._waitingPermission = false;
        this._loadRecent();
      }
    };
  }

  get isOpen() { return !!this.el; }

  /**
   * 打开：框摆在 rect（相对 host 的 CSS 像素），单子挨着它。
   * @param {{x: number, y: number, width: number, height: number}} rect
   * @param {{width: number, height: number}} viewport host 的大小
   */
  open(rect, viewport) {
    this.close();
    this._origin = rect;
    this._rect = rect;
    this._viewport = viewport;
    const el = document.createElement('div');
    el.className = 'ink-image-picker';
    el.innerHTML = `
      <div class="ink-image-slot" aria-hidden="true">${ICON_IMAGE}</div>
      <div class="ink-image-card" role="dialog">
        <section class="ink-image-recent" data-role="recent" hidden>
          <div class="ink-image-head" data-role="recent-title"></div>
          <div class="ink-image-grid" data-role="grid"></div>
          <div class="ink-image-hint" data-role="hint" hidden>
            <span data-role="hint-text"></span>
            <button type="button" class="ink-image-hint-btn" data-role="allow"></button>
          </div>
        </section>
        <div class="ink-image-actions">
          <button type="button" class="ink-image-row" data-role="camera">${ICON_CAMERA}<span data-role="camera-label"></span></button>
          <button type="button" class="ink-image-row" data-role="gallery">${ICON_GALLERY}<span data-role="gallery-label"></span></button>
        </div>
        <div class="ink-image-status" data-role="status" role="status" aria-live="polite" hidden></div>
        <input type="file" accept="image/*" capture="environment" hidden data-role="camera-input">
        <input type="file" accept="image/*" hidden data-role="gallery-input">
      </div>`;
    const $ = (role) => el.querySelector(`[data-role="${role}"]`);
    this._$ = $;
    el.querySelector('.ink-image-card').setAttribute('aria-label', t('image.insert'));
    $('recent-title').textContent = t('image.recent');
    $('camera-label').textContent = t('image.camera');
    $('gallery-label').textContent = t('image.gallery');
    $('allow').textContent = t('image.allow');
    $('camera').addEventListener('click', () => { if (!this._busy) $('camera-input').click(); });
    $('gallery').addEventListener('click', () => { if (!this._busy) $('gallery-input').click(); });
    for (const role of ['camera-input', 'gallery-input']) {
      const input = $(role);
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = '';
        if (file) this._pick(() => Promise.resolve(file));
      });
    }
    $('allow').addEventListener('click', async () => {
      this._waitingPermission = true;
      try { await this.source.requestPhotosPermission(); } catch (_) { this._waitingPermission = false; }
    });
    // 单子上的手指不许漏到底下的书页上：漏下去就是一笔、一次翻页。
    const card = el.querySelector('.ink-image-card');
    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    card.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.host.appendChild(el);
    this.el = el;
    this._placeSlot();
    this._placeCard();
    document.addEventListener('keydown', this._onKey, true);
    document.addEventListener('pointerdown', this._onOutside, true);
    document.addEventListener('visibilitychange', this._onVisible);
    if (this.source?.photosAvailable?.()) this._loadRecent();
    $('camera').focus?.({ preventScroll: true });
  }

  close() {
    if (!this.el) return;
    document.removeEventListener('keydown', this._onKey, true);
    document.removeEventListener('pointerdown', this._onOutside, true);
    document.removeEventListener('visibilitychange', this._onVisible);
    this.el.remove();
    this.el = null;
    this._busy = false;
    this._waitingPermission = false;
    this._loadToken = (this._loadToken || 0) + 1;
    this.handlers.onClose?.();
  }

  _placeSlot() {
    const slot = this.el.querySelector('.ink-image-slot');
    const r = this._rect;
    slot.style.width = `${Math.round(r.width)}px`;
    slot.style.height = `${Math.round(r.height)}px`;
    slot.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px)`;
  }

  /**
   * 摆单子（见 layoutPicker），框跟着让地方。每次都从调用方给的那个框算起，不在挪过的框上再挪：单子的高度变了
   * （最近照片那一块收起来）就照原来的框重新摆一遍。框挪了就告诉调用方（onSlotMove）：图要放进人看见的那个框里。
   */
  _placeCard() {
    const card = this.el?.querySelector('.ink-image-card');
    if (!card) return;
    const v = this._viewport || { width: this.host.clientWidth || 0, height: this.host.clientHeight || 0 };
    const w = card.offsetWidth || 0;
    const h = card.offsetHeight || 0;
    const { slot, card: at } = layoutPicker(this._origin, { width: w, height: h }, v);
    if (!sameRect(slot, this._rect)) {
      this._rect = slot;
      this._placeSlot();
      this.handlers.onSlotMove?.(slot);
    }
    const left = avoidFloatingObstacles(this.host, at.left, at.top, w, h, v, EDGE);
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(at.top)}px)`;
  }

  /** 列最近的照片，一格一格补上缩略图。没权限：说一句、给「去打开」。没有照片、读不出来：这一块不摆。 */
  async _loadRecent() {
    const token = (this._loadToken = (this._loadToken || 0) + 1);
    const $ = this._$;
    const section = $('recent');
    const grid = $('grid');
    const hint = $('hint');
    section.hidden = false;
    grid.hidden = false;
    hint.hidden = true;
    // 先摆三排空格子：单子一开始就是摆满照片时那么高，缩略图来了框和单子都不再挪。
    grid.replaceChildren(...Array.from({ length: 9 }, () => {
      const cell = document.createElement('span');
      cell.className = 'ink-image-thumb is-empty';
      return cell;
    }));
    this._placeCard();
    let photos;
    try {
      photos = await this.source.recentPhotos(RECENT_LIMIT);
    } catch (error) {
      if (token !== this._loadToken || !this.el) return;
      if (error?.message === this.source.PHOTO_ERRORS?.NO_PERMISSION) {
        grid.hidden = true;
        hint.hidden = false;
        $('hint-text').textContent = t('image.needPermission');
      } else {
        section.hidden = true;
      }
      this._placeCard();
      return;
    }
    if (token !== this._loadToken || !this.el) return;
    if (!photos.length) {
      section.hidden = true;
      this._placeCard();
      return;
    }
    const cells = photos.map((photo, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'ink-image-thumb';
      cell.setAttribute('aria-label', t('image.photo', { n: i + 1 }));
      cell.addEventListener('click', () => {
        if (!this._busy) this._pick(() => this.source.readPhoto(photo));
      });
      return cell;
    });
    grid.replaceChildren(...cells);
    this._placeCard();
    // 缩略图一次要几张：一下子全要，桥上排着队，最上面那几格反而最晚出来。
    let next = 0;
    const worker = async () => {
      while (next < photos.length) {
        const i = next++;
        const data = await this.source.photoThumbnail(photos[i].uri, 240);
        if (token !== this._loadToken || !this.el) return;
        if (!data) continue;
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.src = data;
        cells[i].appendChild(img);
      }
    };
    await Promise.all(Array.from({ length: THUMB_PARALLEL }, worker));
  }

  /** 人挑了一张：读出来、交出去；放进去了就收起，没放进去就在单子上说一声，单子留着再挑。 */
  async _pick(getBlob) {
    const $ = this._$;
    const card = this.el?.querySelector('.ink-image-card');
    if (!card || this._busy) return;
    this._busy = true;
    card.classList.add('is-busy');
    const status = $('status');
    status.hidden = false;
    status.textContent = t('image.reading');
    let ok = false;
    try {
      const blob = await getBlob();
      ok = !!blob && !!(await this.handlers.onPick(blob));
    } catch (_) {
      ok = false;
    }
    if (!this.el) return;
    if (ok) {
      this.close();
      return;
    }
    this._busy = false;
    card.classList.remove('is-busy');
    status.textContent = t('image.failed');
  }
}
