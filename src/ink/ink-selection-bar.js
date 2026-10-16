// Ink Module — 套住一片字迹之后，旁边那几个动作。
//
// 套索原来只能选和搬。选完之后想复制一份、换个颜色、或者干脆不要了，得先松开
// 套索、换工具、一点一点擦——而松开的那一刻选区就没了，等于从头再来一遍。
//
// 动作就摆在套索线旁边：它指的是这一圈里的东西，那它就该长在这一圈旁边。摆到
// 顶上的工具栏里也能用，但那样它指的是什么就得靠人自己记住了。
//
// 这块条是 DOM，不是画在画布上的。画上去的东西不能被点——要么自己做一套命中
// 检测，要么把整块画布的指针事件重新分流一遍，而套索、橡皮、笔都在抢那条路。
// 一个按钮就该是一个按钮。
//
// 两种面孔：手里有一片选中的东西时，它是复制/剪切/换色/删除；什么都没选、而
// 剪贴板里有东西时，它只剩一个粘贴。后者是剪切的另一半——剪下来却放不下去的
// 剪切，和删除没有区别。
//
// 换色那一排在圈里有闭合形状时分成两排：边框、填充，各挑各的。原来只有一排，
// 改的只是边框——一个红边蓝底的三角形，底色就再也换不掉了。
//
// 接了识别（OCR）以后多一颗「识别」：认出圈里那一块的字和公式（见 ink-recognize.js、src/ocr/）。圈里没套到笔迹、只圈了
// 书上印的字时，条只剩这一颗——那一圈是「识别区域」，不是选区。没接识别的时候它不出现，一切照旧。
//
// 「大小」展开一排：缩小、眼下是原来的百分之几、放大（人说识别写成的笔迹「同时也要可以放大缩小」）。拖套索线上那颗把手
// 也能缩放，但它同时转——只想变大变小的时候，按钮比把手准。

import { t } from '../core/i18n.js';
import { avoidFloatingObstacles } from './float-avoid.js';

export const SELECTION_ACTIONS = Object.freeze({
  COPY: 'copy',
  CUT: 'cut',
  COLOR: 'color',
  DELETE: 'delete',
  PASTE: 'paste',
  /** 换色那一排里点了某一个色点。带着颜色一起回来。 */
  COLOR_PICK: 'color-pick',
  /** 填充那一排里点了某一个色点，或者「不填充」。带着颜色回来，「不填充」是空串。 */
  FILL_PICK: 'fill-pick',
  /** 认出圈里那一块的字和公式。只在接了识别的时候出现。 */
  RECOGNIZE: 'recognize',
  /** 「大小」：展开、收起放大缩小那一排（条自己处理，不往外报）。 */
  SIZE: 'size',
  /** 那一排里的放大、缩小、点百分比回到原来的大小。 */
  SIZE_UP: 'size-up',
  SIZE_DOWN: 'size-down',
  SIZE_RESET: 'size-reset',
});

/** 「大小」那颗的图标：对角两个箭头。用画的，不用字——这种箭头字符有的系统字体里没有，会是一个方块。 */
const SIZE_GLYPH = '<svg class="ink-selection-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" '
  + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>';

/** 「识别」那颗的图标：一个取景框里一个 T。 */
const RECOGNIZE_GLYPH = '<svg class="ink-selection-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" '
  + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16'
  + 'M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M9 9h6M12 9v7"/></svg>';
const recognizeSpec = () => ({ action: SELECTION_ACTIONS.RECOGNIZE, label: t('ocr.button'), glyph: RECOGNIZE_GLYPH });

const sameColor = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** 条和选区之间留的空，CSS 像素。 */
const GAP = 12;
/** 贴边时至少离容器边缘这么远。 */
const EDGE = 8;

const BUTTONS = [
  { action: SELECTION_ACTIONS.COPY, label: '复制', glyph: '⧉' },
  { action: SELECTION_ACTIONS.CUT, label: '剪切', glyph: '✂' },
  { action: SELECTION_ACTIONS.COLOR, label: '颜色', glyph: '◧' },
  { action: SELECTION_ACTIONS.SIZE, label: '大小', glyph: SIZE_GLYPH },
  { action: SELECTION_ACTIONS.DELETE, label: '删除', glyph: '✕', danger: true },
];

/** 「大小」那一排里按一下会连着按好几下：这几样按完不收那一排。 */
const SIZE_STEPS = new Set([SELECTION_ACTIONS.SIZE_UP, SELECTION_ACTIONS.SIZE_DOWN, SELECTION_ACTIONS.SIZE_RESET]);

export class SelectionBar {
  /**
   * @param {Element} host   条挂在哪；要是定位过的容器（笔迹画布的父节点正是）
   * @param {(action: string, value?: string) => void} onAction
   */
  constructor(host, onAction) {
    this.host = host;
    this.onAction = onAction;
    this.el = null;
    this._visible = false;
    this._mode = null;        // 'selection' | 'paste'
    this._palette = null;
    this._paletteOpen = false;
    /** 「大小」那一排（放大、缩小、百分比）和它开着没有。和色排一次只开一个。 */
    this._sizeRow = null;
    this._sizeOpen = false;
    /** 这一副条是按什么搭的：面孔、有没有填充那一排、用的哪排色。变了才重搭。 */
    this._key = null;
    /** 换色那排是不是分成了边框、填充两排。 */
    this._twoRows = false;
  }

  _press(el, action, value) {
    // pointerdown 而不是 click：套索的手势挂在画布上，而画布就在这条底下。
    // 等到 click 的时候，pointerdown 早就穿过去被当成「在选区外按了一下」，
    // 选区在按钮响应之前就已经没了。
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (action === SELECTION_ACTIONS.COLOR) { this._togglePalette(); return; }
      if (action === SELECTION_ACTIONS.SIZE) { this._toggleSize(); return; }
      // 放大缩小常常连着按好几下：那一排开着不收。
      if (SIZE_STEPS.has(action)) { this.onAction?.(action, value); return; }
      // 两排的时候挑完不收：边框和填充常常是连着改的，收起来就得再点一次「颜色」。
      const picking = action === SELECTION_ACTIONS.COLOR_PICK
        || action === SELECTION_ACTIONS.FILL_PICK;
      if (!(picking && this._twoRows)) this._closePalette();
      this._closeSize();
      this.onAction?.(action, value);
    });
  }

  _button(spec) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ink-selection-btn${spec.danger ? ' is-danger' : ''}`;
    button.dataset.action = spec.action;
    button.title = spec.label;
    button.innerHTML = `<span class="ink-selection-glyph" aria-hidden="true">${spec.glyph}</span>`
      + `<span class="ink-selection-text">${spec.label}</span>`;
    this._press(button, spec.action);
    return button;
  }

  /**
   * 换色那一排。
   *
   * 收在「颜色」后面，不是摊开在条上：条已经有四个动作了，再平铺六个色点，它
   * 就长得比人刚圈出来的那一片还大。点一下展开，选完就收。
   */
  _buildPalette(colors, canFill) {
    const palette = document.createElement('div');
    palette.className = `ink-selection-palette${canFill ? ' is-two-rows' : ''}`;
    palette.hidden = true;
    const edgeDots = colors.map(color => this._dot(color, SELECTION_ACTIONS.COLOR_PICK, 'color'));
    if (!canFill) {
      palette.append(...edgeDots);
      return palette;
    }
    // 圈里有闭合的形状：边框一排、填充一排。填充那排打头的是「不填充」——它不是一
    // 种颜色，是「别填」，和形状卡片上填充那一排的头一格一个样。
    //
    // 边框那排在同一个位置空一格：两排的颜色要上下对齐。原来边框那排从第一格就是色，
    // 填充那排多了「不填充」，同一个颜色在两排里错开一格——边框的黑正压在「不填充」
    // 上面、边框的红压在填充的黑上面（人说「这个颜色位置视觉上有点怪」）。
    palette.append(
      this._paletteRow('边框', [this._gapCell(), ...edgeDots]),
      this._paletteRow('填充', [
        this._noFillDot(),
        ...colors.map(color => this._dot(color, SELECTION_ACTIONS.FILL_PICK, 'fill')),
      ]),
    );
    return palette;
  }

  /** 边框那排里对着「不填充」的那个空位：占着一格的地方，看不见、点不到。 */
  _gapCell() {
    const gap = document.createElement('span');
    gap.className = 'ink-selection-dot is-gap';
    gap.setAttribute('aria-hidden', 'true');
    return gap;
  }

  _dot(color, action, key) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'ink-selection-dot';
    dot.dataset[key] = color;
    dot.title = color;
    dot.setAttribute('aria-label', key === 'fill' ? `填充改成 ${color}` : `改成 ${color}`);
    dot.style.background = color;
    this._press(dot, action, color);
    return dot;
  }

  _noFillDot() {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'ink-selection-dot is-none';
    dot.dataset.fill = '';
    dot.title = '不填充';
    dot.setAttribute('aria-label', '不填充');
    this._press(dot, SELECTION_ACTIONS.FILL_PICK, '');
    return dot;
  }

  /** 一排色，左边一个字说这一排改的是哪一样。 */
  _paletteRow(label, dots) {
    const row = document.createElement('div');
    row.className = 'ink-selection-palette-row';
    const name = document.createElement('span');
    name.className = 'ink-selection-palette-label';
    name.textContent = label;
    row.append(name, ...dots);
    return row;
  }

  /**
   * 把这一片眼下的颜色在色排上标出来。
   *
   * 一片里各是各的色（圈了好几种）就一个都不标——标哪一个都是在说假话。
   *
   * @param {{color?: ?string, fill?: ?string}} [current]
   *   fill 为 undefined 是「说不上来」（有的填了有的没填、或者根本没有闭合形状），
   *   null 是「都没填」
   */
  _markCurrent(current) {
    if (!this._palette) return;
    for (const dot of this._palette.querySelectorAll('[data-color]')) {
      dot.classList.toggle('is-current', !!current?.color && sameColor(dot.dataset.color, current.color));
    }
    for (const dot of this._palette.querySelectorAll('[data-fill]')) {
      const known = current && current.fill !== undefined;
      dot.classList.toggle('is-current', !!known && sameColor(dot.dataset.fill, current.fill || ''));
    }
  }

  _togglePalette() {
    if (!this._palette) return;
    this._closeSize();
    this._paletteOpen = !this._paletteOpen;
    this._palette.hidden = !this._paletteOpen;
    // 展开以后条有两三行高：两头还是半圆的话，高出来的那一截整个成了一个大半圆，色排贴着弯边（样式表按这个类换成圆角矩形）。
    this.el?.classList.toggle('is-palette-open', this._paletteOpen);
  }

  _closePalette() {
    if (!this._palette || !this._paletteOpen) return;
    this._paletteOpen = false;
    this._palette.hidden = true;
    this.el?.classList.remove('is-palette-open');
  }

  /**
   * 「大小」那一排：缩小、眼下是原来的百分之几、放大。点百分比回到原来的大小。
   *
   * 也收在一颗按钮后面，和色排一样：条上已经五六个动作了。按一下放大、缩小是一步撤销；那一排开着不收，连着按几下就行。
   */
  _buildSizeRow() {
    const row = document.createElement('div');
    row.className = 'ink-selection-size';
    row.hidden = true;
    const step = (action, glyph, label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ink-selection-btn ink-selection-size-btn';
      button.dataset.action = action;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.textContent = glyph;
      this._press(button, action);
      return button;
    };
    const value = step(SELECTION_ACTIONS.SIZE_RESET, '100%', '回到原来的大小');
    value.classList.add('ink-selection-size-value');
    row.append(step(SELECTION_ACTIONS.SIZE_DOWN, '−', '缩小'), value, step(SELECTION_ACTIONS.SIZE_UP, '+', '放大'));
    this._sizeValue = value;
    return row;
  }

  /** 那一排上的百分比：眼下是圈住（或刚写成）时的几倍。回到 100% 时那颗按不下去——已经是原来的大小了。 */
  _markScale(scale) {
    if (!this._sizeValue) return;
    const pct = Math.round((Number.isFinite(scale) ? scale : 1) * 100);
    this._sizeValue.textContent = `${pct}%`;
    this._sizeValue.disabled = pct === 100;
  }

  _toggleSize(force) {
    if (!this._sizeRow) return;
    const open = typeof force === 'boolean' ? force : !this._sizeOpen;
    if (open) this._closePalette();
    this._sizeOpen = open;
    this._sizeRow.hidden = !open;
    this.el?.classList.toggle('is-palette-open', open || this._paletteOpen);
  }

  _closeSize() {
    if (!this._sizeRow || !this._sizeOpen) return;
    this._toggleSize(false);
  }

  /** 按当下该是哪一副面孔重建。几种面孔的按钮完全不同，所以是重建而不是切换。 */
  _build(mode, colors, canFill = false, recognize = false) {
    // 面孔一样还不够：圈里有没有闭合形状、用的哪排色变了，色排也得跟着变。原来只
    // 认面孔，工具栏的色换了，这里还是旧的那排。识别接上、断开了，那颗按钮也跟着变。
    const key = `${mode}|${canFill ? 1 : 0}|${recognize ? 1 : 0}|${(colors || []).join(',')}`;
    if (this.el && this._key === key) return;
    this.el?.remove();
    this._palette = null;
    this._paletteOpen = false;
    this._sizeRow = null;
    this._sizeValue = null;
    this._sizeOpen = false;
    this._key = key;
    this._twoRows = mode !== 'paste' && !!canFill;

    const bar = document.createElement('div');
    bar.className = 'ink-selection-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', mode === 'paste' ? '剪贴板' : mode === 'region' ? t('ocr.regionLabel') : '选中内容的操作');

    const row = document.createElement('div');
    row.className = 'ink-selection-row';

    if (mode === 'paste') {
      row.appendChild(this._button({
        action: SELECTION_ACTIONS.PASTE, label: '粘贴', glyph: '⎘',
      }));
      bar.appendChild(row);
    } else if (mode === 'region') {
      // 圈里没套到笔迹、只圈了书上印的字：能做的只有认它。
      row.appendChild(this._button(recognizeSpec()));
      bar.appendChild(row);
    } else {
      for (const spec of BUTTONS) {
        // 「识别」排在「删除」前面：危险的那一颗永远在最后。
        if (spec.danger && recognize) row.appendChild(this._button(recognizeSpec()));
        row.appendChild(this._button(spec));
      }
      bar.appendChild(row);
      this._palette = this._buildPalette(colors, canFill);
      bar.appendChild(this._palette);
      this._sizeRow = this._buildSizeRow();
      bar.appendChild(this._sizeRow);
    }

    this.host.appendChild(bar);
    this.el = bar;
    this._mode = mode;
    this._visible = false;
  }

  /**
   * 摆到这一圈旁边。
   *
   * @param {{minX:number, minY:number, maxX:number, maxY:number}} box
   *   选区在屏幕上的外接矩形，CSS 像素，相对 host
   * @param {{width:number, height:number}} viewport  host 自己多大
   * @param {{mode?: string, colors?: Array<string>, canFill?: boolean,
   *          current?: {color?: ?string, fill?: ?string}, recognize?: boolean,
   *          scale?: number, openSize?: boolean}} [opts]
   *   mode：'selection'（套到了笔迹）、'paste'（只剩粘贴）、'region'（识别区域，只有「识别」）；
   *   canFill：圈里有闭合的形状，换色那排分成边框、填充两排；current：这一片眼下
   *   的颜色，标在色排上；recognize：接了识别，套到笔迹时也多一颗「识别」；
   *   scale：这一片眼下是原来的几倍（「大小」那一排上的百分比）；openSize：这一次把「大小」那一排打开
   */
  place(box, viewport, {
    mode = 'selection', colors = [], canFill = false, current = null, recognize = false,
    scale = 1, openSize = false,
  } = {}) {
    if (!box || !viewport || !this.host) { this.hide(); return; }
    this._build(mode, colors, canFill, recognize);
    if (!this.el) return;
    this._markCurrent(current);
    this._markScale(scale);
    if (openSize) this._toggleSize(true);

    if (!this._visible) {
      this.el.classList.add('is-visible');
      this._visible = true;
    }

    // 量一次自己多大。还没显示过时它是 0×0，所以得在加上 is-visible 之后量。
    const w = this.el.offsetWidth || 0;
    const h = this.el.offsetHeight || 0;

    // 默认摆在下面。下面放不下就翻到上面去——而不是压在选区上：压上去就挡住了
    // 人刚刚圈出来的那点东西，而那正是他要看着决定「复制还是删掉」的依据。
    let top = box.maxY + GAP;
    if (top + h > viewport.height - EDGE) top = box.minY - GAP - h;
    // 上下都不够（选区几乎占满整屏）就贴着下沿，宁可压住一点也别跑到屏幕外面。
    if (top < EDGE) top = Math.max(EDGE, viewport.height - h - EDGE);

    let left = (box.minX + box.maxX) / 2 - w / 2;
    left = Math.max(EDGE, Math.min(left, viewport.width - w - EDGE));
    // 圈在页边时条会落到浮着的工具栏底下：横着挪开（见 float-avoid.js）。
    left = avoidFloatingObstacles(this.host, left, top, w, h, viewport, EDGE);

    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  hide() {
    this._closePalette();
    this._closeSize();
    if (!this.el || !this._visible) return;
    this.el.classList.remove('is-visible');
    this._visible = false;
  }

  destroy() {
    this.el?.remove();
    this.el = null;
    this._palette = null;
    this._sizeRow = null;
    this._sizeValue = null;
    this._visible = false;
    this._mode = null;
    this._key = null;
  }
}
