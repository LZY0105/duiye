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

export const SELECTION_ACTIONS = Object.freeze({
  COPY: 'copy',
  CUT: 'cut',
  COLOR: 'color',
  DELETE: 'delete',
  PASTE: 'paste',
  /** 换色那一排里点了某一个色点。带着颜色一起回来。 */
  COLOR_PICK: 'color-pick',
});

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
  }

  _press(el, action, value) {
    // pointerdown 而不是 click：套索的手势挂在画布上，而画布就在这条底下。
    // 等到 click 的时候，pointerdown 早就穿过去被当成「在选区外按了一下」，
    // 选区在按钮响应之前就已经没了。
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (action === SELECTION_ACTIONS.COLOR) { this._togglePalette(); return; }
      this._closePalette();
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
  _buildPalette(colors) {
    const row = document.createElement('div');
    row.className = 'ink-selection-palette';
    row.hidden = true;
    for (const color of colors) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'ink-selection-dot';
      dot.dataset.color = color;
      dot.title = color;
      dot.setAttribute('aria-label', `改成 ${color}`);
      dot.style.background = color;
      this._press(dot, SELECTION_ACTIONS.COLOR_PICK, color);
      row.appendChild(dot);
    }
    return row;
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
  _build(mode, colors) {
    if (this.el && this._mode === mode) return;
    this.el?.remove();
    this._palette = null;
    this._paletteOpen = false;

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
      this._palette = this._buildPalette(colors);
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
   * @param {{mode?: string, colors?: Array<string>}} [opts]
   */
  place(box, viewport, { mode = 'selection', colors = [] } = {}) {
    if (!box || !viewport || !this.host) { this.hide(); return; }
    this._build(mode, colors);
    if (!this.el) return;

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
  }
}
