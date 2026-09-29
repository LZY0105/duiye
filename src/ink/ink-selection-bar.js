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
});

const sameColor = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** 条和选区之间留的空，CSS 像素。 */
const GAP = 12;
/** 贴边时至少离容器边缘这么远。 */
const EDGE = 8;

const BUTTONS = [
  { action: SELECTION_ACTIONS.COPY, label: '复制', glyph: '⧉' },
  { action: SELECTION_ACTIONS.CUT, label: '剪切', glyph: '✂' },
  { action: SELECTION_ACTIONS.COLOR, label: '颜色', glyph: '◧' },
  { action: SELECTION_ACTIONS.DELETE, label: '删除', glyph: '✕', danger: true },
];

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
      // 两排的时候挑完不收：边框和填充常常是连着改的，收起来就得再点一次「颜色」。
      const picking = action === SELECTION_ACTIONS.COLOR_PICK
        || action === SELECTION_ACTIONS.FILL_PICK;
      if (!(picking && this._twoRows)) this._closePalette();
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
    palette.append(
      this._paletteRow('边框', edgeDots),
      this._paletteRow('填充', [
        this._noFillDot(),
        ...colors.map(color => this._dot(color, SELECTION_ACTIONS.FILL_PICK, 'fill')),
      ]),
    );
    return palette;
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
    this._paletteOpen = !this._paletteOpen;
    this._palette.hidden = !this._paletteOpen;
  }

  _closePalette() {
    if (!this._palette || !this._paletteOpen) return;
    this._paletteOpen = false;
    this._palette.hidden = true;
  }

  /** 按当下该是哪一副面孔重建。两种面孔的按钮完全不同，所以是重建而不是切换。 */
  _build(mode, colors, canFill = false) {
    // 面孔一样还不够：圈里有没有闭合形状、用的哪排色变了，色排也得跟着变。原来只
    // 认面孔，工具栏的色换了，这里还是旧的那排。
    const key = `${mode}|${canFill ? 1 : 0}|${(colors || []).join(',')}`;
    if (this.el && this._key === key) return;
    this.el?.remove();
    this._palette = null;
    this._paletteOpen = false;
    this._key = key;
    this._twoRows = mode !== 'paste' && !!canFill;

    const bar = document.createElement('div');
    bar.className = 'ink-selection-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', mode === 'paste' ? '剪贴板' : '选中内容的操作');

    const row = document.createElement('div');
    row.className = 'ink-selection-row';

    if (mode === 'paste') {
      row.appendChild(this._button({
        action: SELECTION_ACTIONS.PASTE, label: '粘贴', glyph: '⎘',
      }));
      bar.appendChild(row);
    } else {
      for (const spec of BUTTONS) row.appendChild(this._button(spec));
      bar.appendChild(row);
      this._palette = this._buildPalette(colors, canFill);
      bar.appendChild(this._palette);
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
   *          current?: {color?: ?string, fill?: ?string}}} [opts]
   *   canFill：圈里有闭合的形状，换色那排分成边框、填充两排；current：这一片眼下
   *   的颜色，标在色排上
   */
  place(box, viewport, { mode = 'selection', colors = [], canFill = false, current = null } = {}) {
    if (!box || !viewport || !this.host) { this.hide(); return; }
    this._build(mode, colors, canFill);
    if (!this.el) return;
    this._markCurrent(current);

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

    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  hide() {
    this._closePalette();
    if (!this.el || !this._visible) return;
    this.el.classList.remove('is-visible');
    this._visible = false;
  }

  destroy() {
    this.el?.remove();
    this.el = null;
    this._palette = null;
    this._visible = false;
    this._mode = null;
    this._key = null;
  }
}
