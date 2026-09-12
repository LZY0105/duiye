// PDF Module — 一排书。
//
// 文档库原来是一张表：一行一份文件，行里写着名字、页数、大小，右边三个按钮。
// 表是拿来查的，而人对自己的书不查——认。认封面、认厚薄、认它摆在第几个。
// 所以它现在是书：封面朝外，名字在下面，一行只摆得下几本，宁可滚也不缩小，
// 因为缩到认不出封面的时候，这排书就又变回一张表了。
//
// 只负责摆和点。封面怎么来的在 book-cover.js，顺序怎么定的在 shelf-state.js，
// 点下去之后那一下动画在 book-open.js——这里一件都不做，它只知道「那一格在屏
// 幕上的哪里」，而那恰好是动画唯一需要它给的东西。

import { SHELF_KINDS, shelfSubtitle } from './shelf-state.js';
import { requestCover } from './book-cover.js';
import { DOC_ROLES } from './pdf-library.js';
import { t } from '../core/i18n.js';

// 册别的角标。原来是写死的两个中文词——这一架书是给五种语言的人看的，而角标是
// 这一格上唯一一处说「它是什么」的地方。
const ROLE_KEYS = {
  [DOC_ROLES.EXERCISE]: 'shelf.tagExercise',
  [DOC_ROLES.ANSWER]: 'shelf.tagAnswer',
};

/**
 * 说明书的封面。
 *
 * 画的是这个软件本身：两栏、中间那条线、一笔手写。不用截图——截图只能是某一种
 * 语言的，而且会随界面改动慢慢变成一张假的。
 */
const GUIDE_COVER = `
  <svg viewBox="0 0 120 160" preserveAspectRatio="xMidYMid slice"
       xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="120" height="160" fill="#eef3fb"/>
    <rect x="12" y="28" width="43" height="104" rx="4" fill="#fff" stroke="#cbd6e6"/>
    <rect x="65" y="28" width="43" height="104" rx="4" fill="#fff" stroke="#cbd6e6"/>
    <rect x="57" y="28" width="6" height="104" rx="3" fill="#dbe4f0"/>
    <g fill="#c3cede">
      <rect x="18" y="40" width="31" height="3" rx="1.5"/>
      <rect x="18" y="50" width="24" height="3" rx="1.5"/>
      <rect x="71" y="40" width="31" height="3" rx="1.5"/>
      <rect x="71" y="50" width="20" height="3" rx="1.5"/>
    </g>
    <path d="M20 78 q12 -14 24 2 t22 -6" fill="none" stroke="#2563eb"
      stroke-width="3.4" stroke-linecap="round"/>
    <path d="M72 104 q14 12 30 -4" fill="none" stroke="#dc2626"
      stroke-width="3.4" stroke-linecap="round"/>
  </svg>`;

export class BookShelf {
  /**
   * @param {Element} host  书架挂在哪
   * @param {Object}  handlers
   * @param {(item: Object, tile: Element) => void} handlers.onOpen
   * @param {(item: Object, anchor: Element) => void} handlers.onMenu
   * @param {() => void} [handlers.onAdd]
   * @param {() => void} [handlers.onGuide] 说明书那一格
   */
  constructor(host, { onOpen, onMenu, onAdd, onGuide } = {}) {
    this.host = host;
    this.onOpen = onOpen;
    this.onMenu = onMenu;
    this.onAdd = onAdd;
    this.onGuide = onGuide;
    /** 还没画完的封面，关掉书架时一起撤销。 */
    this._pending = [];
    /** 挂上去的 blob 地址，撤掉书架时一起回收。 */
    this._urls = [];
    this._tiles = new Map();
  }

  /** 某一本在屏幕上的封面矩形——动画从这里起飞。 */
  tileRect(id) {
    const cover = this._tiles.get(id)?.querySelector('.pdf-book-cover');
    return cover ? cover.getBoundingClientRect() : null;
  }

  /** 某一本封面的图，飞的时候带着它。 */
  coverUrl(id) {
    return this._tiles.get(id)?.dataset.cover || '';
  }

  setItems(items) {
    this._release();
    const frag = document.createDocumentFragment();

    // 说明书永远是第一本。装完软件第一次进来这里一本书都没有，而那正是最需要它
    // 的时候；书多了它也不该被挤到后面去——人回头找它，还是会来文档库找。
    if (this.onGuide) frag.appendChild(this._guideTile());
    for (const item of items) frag.appendChild(this._tile(item));
    if (this.onAdd) frag.appendChild(this._addTile());

    this.host.replaceChildren(frag);
    // 顺着书架的顺序要封面：人先看第一本，第一本就先画出来。队列一次只画一张，
    // 所以这个顺序就是它们出现的顺序。
    for (const item of items) this._loadCover(item);
  }

  _tile(item) {
    const tile = document.createElement('div');
    tile.className = 'pdf-book';
    tile.dataset.id = item.id;
    tile.dataset.kind = item.kind;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'pdf-book-hit';
    open.title = item.name;
    open.setAttribute('aria-label', t('shelf.openBook', { name: item.name }));

    const block = document.createElement('span');
    block.className = 'pdf-book-block';
    if (item.kind === SHELF_KINDS.PAD) block.classList.add('is-pad');

    const cover = document.createElement('span');
    cover.className = 'pdf-book-cover';
    block.appendChild(cover);

    // 书脊那一叠纸。没有它，书就是一张卡片；有了它，厚薄是能看出来的。
    const edge = document.createElement('span');
    edge.className = 'pdf-book-edge';
    block.appendChild(edge);

    const tag = ROLE_KEYS[item.role] ? t(ROLE_KEYS[item.role]) : null;
    if (tag) {
      const badge = document.createElement('span');
      badge.className = 'pdf-book-tag';
      badge.textContent = tag;
      block.appendChild(badge);
    }

    open.appendChild(block);

    const name = document.createElement('span');
    name.className = 'pdf-book-name';
    name.textContent = item.name;
    open.appendChild(name);

    const sub = document.createElement('span');
    sub.className = 'pdf-book-sub';
    sub.textContent = shelfSubtitle(item);
    open.appendChild(sub);

    open.addEventListener('click', () => this.onOpen?.(item, tile));
    tile.appendChild(open);

    if (this.onMenu) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'pdf-book-more';
      more.textContent = '⋯';
      more.setAttribute('aria-label', `${item.name} 的更多操作`);
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onMenu(item, more);
      });
      tile.appendChild(more);
    }

    this._tiles.set(item.id, tile);
    return tile;
  }

  _addTile() {
    const tile = document.createElement('div');
    tile.className = 'pdf-book is-add';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pdf-book-hit';
    button.setAttribute('aria-label', t('shelf.import'));
    const block = document.createElement('span');
    block.className = 'pdf-book-block is-add';
    block.textContent = '＋';
    button.appendChild(block);
    const name = document.createElement('span');
    name.className = 'pdf-book-name';
    name.textContent = t('shelf.import');
    button.appendChild(name);
    button.addEventListener('click', () => this.onAdd?.());
    tile.appendChild(button);
    return tile;
  }

  /**
   * 说明书那一格。
   *
   * 长得和别的书一样——一样的封面块、一样的厚薄、名字在下面——因为它就该像一本
   * 书那样被点开。封面是画的不是截的：截图只能是某一种语言的。
   */
  _guideTile() {
    const tile = document.createElement('div');
    tile.className = 'pdf-book is-guide';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pdf-book-hit';
    button.title = t('guide.name');
    button.setAttribute('aria-label', t('guide.name'));

    const block = document.createElement('span');
    block.className = 'pdf-book-block is-guide';
    const cover = document.createElement('span');
    cover.className = 'pdf-book-cover is-guide-cover';
    cover.innerHTML = GUIDE_COVER;
    block.appendChild(cover);
    const edge = document.createElement('span');
    edge.className = 'pdf-book-edge';
    block.appendChild(edge);
    button.appendChild(block);

    const name = document.createElement('span');
    name.className = 'pdf-book-name';
    name.textContent = t('guide.name');
    button.appendChild(name);

    const sub = document.createElement('span');
    sub.className = 'pdf-book-sub';
    sub.textContent = t('guide.tagline');
    button.appendChild(sub);

    button.addEventListener('click', () => this.onGuide?.());
    tile.appendChild(button);
    return tile;
  }

  _loadCover(item) {
    const job = requestCover(item);
    this._pending.push(job);
    job.promise.then((blob) => {
      const tile = this._tiles.get(item.id);
      if (!tile || !blob) return;
      const url = URL.createObjectURL(blob);
      this._urls.push(url);
      tile.dataset.cover = url;
      const cover = tile.querySelector('.pdf-book-cover');
      if (!cover) return;
      cover.style.backgroundImage = `url("${url}")`;
      cover.classList.add('is-loaded');
    }).catch(() => { /* 一本没有封面不该让整架书画不出来 */ });
  }

  _release() {
    for (const job of this._pending) job.cancel?.();
    this._pending = [];
    for (const url of this._urls) URL.revokeObjectURL(url);
    this._urls = [];
    this._tiles.clear();
  }

  destroy() {
    this._release();
    this.host?.replaceChildren();
  }
}
