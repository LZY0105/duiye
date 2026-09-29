// Ink Module — the interactive ink surface.
//
// Binds an InkLayer to its OWN canvas, stacked above the PDF canvas. The two
// canvases are separate elements: ink drawing, erasing and clearing all target
// this one, so there is no code path by which ink can modify the page bitmap.
//
// Input arrives in screen pixels and is converted to document space before
// being stored, so what is persisted is independent of the zoom it was drawn
// at — the same reason zooming in later is lossless.

import { InkLayer } from './ink-layer.js';
import { INK_OPS, InkHistory } from './ink-history.js';
import {
  INK_TOOLS,
  TOOL_DEFAULTS,
  appendPoint,
  cloneStroke,
  createStroke,
  deserializeStroke,
  isDrawable,
  nearPolygon,
  recomputeBounds,
  serializeStroke,
} from './stroke.js';
import {
  clipboardHasInk,
  putOnClipboard,
  takeFromClipboard,
} from './ink-clipboard.js';
import {
  ERASER_MODES,
  eraseAreaAlongPath,
  eraseStrokes,
  strokeIdsAlongPath,
  strokeIdsInRegion,
} from './ink-eraser.js';
import {
  boundsCentre,
  handleIndex,
  nearestIndex,
  polygonBounds,
  rectLoop,
  restorePoints,
  selectInPolygon,
  selectionBounds,
  transformPolygon,
  snapshotStrokes,
  transformSelection,
} from './ink-selection.js';
import { SelectionBar, SELECTION_ACTIONS } from './ink-selection-bar.js';
import {
  LASSO_STROKE,
  createTransform,
  documentToScreen,
  drawLasso,
  drawShapeGuides,
  drawShapeHandles,
  drawShapeLabels,
  drawStroke,
  renderLayer,
  screenToDocument,
} from './ink-renderer.js';
import {
  SHAPE_KINDS,
  createShape,
  handleAt as shapeHandleAt,
  hitShape,
  isClosedShape,
  reshape,
  shapeGuides,
  shapeHandles,
  shapeLabels,
  shapePoints,
  tooSmall,
} from './shape-geometry.js';

/** Whether a gesture actually changed anything worth recording. */
function moved(before, after) {
  if (!before || !after || before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) {
    const a = before[i].points;
    const b = after[i].points;
    if (a.length !== b.length) return true;
    for (let j = 0; j < a.length; j++) {
      if (Math.abs(a[j].x - b[j].x) > 1e-6 || Math.abs(a[j].y - b[j].y) > 1e-6) return true;
    }
  }
  return false;
}

/**
 * Radius of the rotate/scale handle, in screen pixels at 100% page zoom.
 *
 * It is sized against what it MANIPULATES, not pinned to an absolute number.
 * A control that holds still while the thing it belongs to grows and shrinks
 * does not read as attached to it, and the failure is worst in the shrinking
 * direction: scale a selection down to a quarter and a fixed dot ends up
 * larger than the ink it is supposed to be a corner of.
 *
 * Two influences, and the smaller wins:
 *   - the page zoom, damped by a square root, so it always responds across the
 *     whole practical range instead of moving 1:1 and running away at 4x;
 *   - the selection's own on-screen size, capped at HANDLE_SHARE of its
 *     shorter side, which is what makes it shrink with the selection.
 *
 * Then clamped, because it is still a touch target: it may not shrink below
 * something a stylus can land on, and it may not grow into a blob that hides
 * the ink underneath it.
 */
const SELECT_HANDLE = 9;
const HANDLE_MIN = 6;
const HANDLE_MAX = 20;
/** Never more than this fraction of the selection's shorter on-screen side. */
const HANDLE_SHARE = 0.18;
/** The hit target may not follow the dot all the way down. */
const HANDLE_HIT_MIN = 15;

/**
 * 形状那几颗圆点：画出来多大、多近算摸到。
 *
 * 比选区那颗把手小一档，因为视频里就是小一档——它是压在线上的一小颗，不是一个
 * 白心金边的环。和把手一样按 sqrt(缩放) 阻尼，也一样上下夹住：它仍然是个要用笔
 * 尖去戳的东西。
 */
const SHAPE_HANDLE = 4.5;
const SHAPE_HANDLE_MIN = 3.5;
const SHAPE_HANDLE_MAX = 10;
const SHAPE_HIT_MIN = 16;
/** 按在已有形状上之后走多远才算「在画新的」而不是「点了一下」。 */
const SHAPE_TAP_SLOP = 6;

/**
 * How far outside a finished lasso a press still counts as grabbing it, to
 * move the selection. Screen pixels, scaled into document units at use.
 *
 * A freehand loop is drawn tight against the ink, so without this a press has
 * to land in a sliver a stylus cannot reliably hit — and just missing it
 * throws the selection away and starts a new one.
 */
const GRAB_MARGIN = 14;

/**
 * 复制出来的那一份挪开多远，屏幕像素。
 *
 * 屏幕距离而不是文档距离：600% 下复制，固定的文档距离会把两份分开半页；50% 下
 * 则几乎重叠，看起来像什么都没发生。一指宽左右，刚好看得出是两份。
 */
const COPY_OFFSET = 18;

/**
 * Minimum spacing between lasso samples, in document units.
 *
 * A hand-drawn loop only needs enough points to keep its curve; anything
 * closer than this is the stylus reporting that it has not moved yet.
 */
const LOOP_SPACING = 2;

export const INPUT_MODES = Object.freeze({
  /** Draw with any pointer. */
  ANY: 'any',
  /** Draw only with a stylus; finger and mouse pan the page instead. */
  STYLUS_ONLY: 'stylus',
  /**
   * The tablet default: a stylus draws, a finger never does.
   *
   * A mouse still draws, because a desk is where the app is developed and
   * tested and there is no pen there to test with. A finger is the one input
   * that must not leave a mark: it is the hand resting on the glass while the
   * other hand writes, and it is the hand turning the page.
   */
  NO_FINGER: 'no-finger',
});

export class InkSurface {
  /**
   * @param {HTMLCanvasElement} canvas the ink canvas (never the PDF canvas)
   * @param {{onChange?: function, onHistoryChange?: function}} handlers
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;

    this.layer = new InkLayer();
    this.history = new InkHistory(this.layer, {
      onChange: () => this.handlers.onHistoryChange?.(this.history),
    });

    this.transform = createTransform(1, 0, 0);
    this.tool = INK_TOOLS.PEN;
    this.color = '#111827';
    this.width = TOOL_DEFAULTS[INK_TOOLS.PEN].width;
    // undefined means "use the tool's own default"; a number overrides it.
    this.opacity = undefined;
    this.eraserMode = ERASER_MODES.STROKE;
    this.eraserRadius = 8;
    /** 形状工具画哪一种、填什么色，以及正在拖的那个形状。见 shape-geometry.js。 */
    this.shapeKind = SHAPE_KINDS.LINE;
    this.shapeFill = null;
    this._shape = null;      // 正在拖的那个（还没落进层里）
    this._shapeSel = null;   // 亮着圆点的那个：{ shape, strokeId }
    this._shapeGrab = null;  // 正在拖的那颗圆点
    this._shapePress = null; // 按在一个已有形状上，还没决定是「选它」还是「画新的」
    this.inputMode = INPUT_MODES.NO_FINGER;
    this.enabled = true;

    this._active = null;      // in-progress stroke
    // 正在测的那一段橡皮路径（文档空间），最多两个点：上一次的位置和这一次。
    // 不是整条拖动轨迹 —— 见 _eraseAlong。
    this._eraserPath = null;
    this._eraserDot = null;   // the eraser head while it is down, document space
    this._pointerId = null;

    // ── lasso ──
    this.selection = [];      // ids, document order irrelevant
    this._loop = null;        // the lasso being drawn, document space
    this.selectionLoop = null; // the closed loop that caught it, document space
    this._anchor = -1;        // which loop vertex carries the transform handle
    this._loopFrom = null;    // where a rectangle lasso started
    this.lassoShape = 'free';
    this.lassoInside = false; // require strokes to fall entirely inside
    this._grab = null;        // an in-progress move/rotate/scale of the selection
    /** 另一栏正拖过来的那一片。只画，不进层——见 showDragGhost。 */
    this._ghost = null;
    // 选完之后浮在套索线旁的那两个动作。挂在画布的父节点上——画布自己是 canvas，
    // 按钮不能长在它里面。
    this._swatches = [];
    this._bar = new SelectionBar(canvas.parentElement, (action, value) => {
      if (action === SELECTION_ACTIONS.COPY) this.duplicateSelection();
      else if (action === SELECTION_ACTIONS.CUT) this.cutSelection();
      else if (action === SELECTION_ACTIONS.DELETE) this.deleteSelection();
      else if (action === SELECTION_ACTIONS.PASTE) this.pasteClipboard();
      else if (action === SELECTION_ACTIONS.COLOR_PICK) this.recolorSelection(value);
      else if (action === SELECTION_ACTIONS.FILL_PICK) this.refillSelection(value || null);
    });

    // `erasing` and `selecting` are born here, through the same door every
    // later change uses. Declaring them separately is how they came to be set
    // in four places, two of which forgot the other flag.
    this._setMode('draw');

    this._bind();
  }

  // ── configuration ─────────────────────────────────────────────────────────

  /**
   * The ONE place the surface's mode is decided.
   *
   * `erasing` and `selecting` are mutually exclusive, and pointerdown tests
   * them in order — so any path that sets one without clearing the other
   * silently disables whichever loses the race. That is exactly what happened:
   * `setEraser()` set `erasing` and left `selecting` alone, so picking the
   * lasso and then the eraser left both true, the lasso branch ran first, and
   * the eraser did nothing at all until some other tool was chosen in between.
   *
   * Two flags with three writers cannot be kept consistent by remembering to.
   * They are now written here and nowhere else.
   *
   * @param {'draw'|'erase'|'select'} mode
   */
  _setMode(mode) {
    // Leaving the lasso drops the selection: a highlighted set that no gesture
    // can act on any more is just decoration on the page.
    if (this.selecting && mode !== 'select') this.clearSelection();
    // 换掉形状工具，那几颗圆点也该走：它们是「这一个形状还能改」的意思，而换了
    // 工具之后再拖它们，改的是一个人已经不在编辑的东西。
    if (this.shaping && mode !== 'shape') this._dropShapeSelection();
    this.erasing = mode === 'erase';
    this.selecting = mode === 'select';
    this.shaping = mode === 'shape';
    // 那条动作小条也跟着这个模式走，而且要单独说一句。
    //
    // 只靠上面那句 clearSelection 是不够的：它开头就写着「没选东西也没在画就直接
    // 返回」，而剪切之后正是这个状态——选区空了，条上却还挂着一个「粘贴」。于是
    // 换回笔去写字，那个粘贴按钮就一直浮在页面上。真机上撞到的就是这个。
    //
    // 而换工具本身不会触发重画，所以也不能指望 render() 里那次摆位来收它。
    this._placeBar();
  }

  setTool(tool) {
    if (tool === 'eraser') { this._setMode('erase'); return; }
    if (tool === 'lasso') { this._setMode('select'); return; }
    if (tool === 'shape') { this._setMode('shape'); return; }
    this._setMode('draw');
    this.tool = tool;
    this.width = TOOL_DEFAULTS[tool]?.width ?? this.width;
  }

  /**
   * 形状工具：画直线还是画圆。
   *
   * 形状落下来是一条普通笔迹，用的是**钢笔**那套渲染（等宽、不带颗粒）——所以
   * this.tool 保持不动，只有模式变了。换句话说：形状不是第七支笔，是一种画法。
   */
  setShape(kind, fill) {
    this._setMode('shape');
    if (Object.values(SHAPE_KINDS).includes(kind) && kind !== SHAPE_KINDS.POLY) {
      this.shapeKind = kind;
    }
    if (fill !== undefined) this.shapeFill = fill || null;
  }

  /** Shape of the loop, and what counts as caught. */
  /** 换色那一排用哪几个色。工具栏推过来的，和笔用的是同一排。 */
  setSwatches(list) {
    this._swatches = Array.isArray(list) ? list.filter(c => typeof c === 'string') : [];
  }

  setLasso({ shape, mode } = {}) {
    if (shape === 'free' || shape === 'rect') this.lassoShape = shape;
    if (mode === 'touch' || mode === 'inside') this.lassoInside = mode === 'inside';
  }

  /**
   * 收掉形状上那几颗圆点。
   *
   * 形状本身留在纸上——它已经是一条笔迹了。走的只是「还能改它」这件事。
   */
  _dropShapeSelection() {
    if (!this._shapeSel && !this._shape && !this._shapeGrab && !this._shapePress) return false;
    this._shapeSel = null;
    this._shape = null;
    this._shapeGrab = null;
    this._shapePress = null;
    return true;
  }

  clearSelection() {
    // 形状那几颗圆点和套索的选区是同一类东西：「这一片现在还听我的」。所以翻页、
    // 换工具、剪切之后统统该走，而那些地方叫的都是这一扇门。
    const hadShape = this._dropShapeSelection();
    if (!this.selection.length && !this._loop) {
      if (hadShape) this.render();
      return;
    }
    this.selection = [];
    this.selectionLoop = null;
    this._bar?.hide();
    this._anchor = -1;
    this._loop = null;
    this._loopFrom = null;
    this._grab = null;
    this.render();
  }

  /** The selection's box in document space, recomputed on demand. */
  selectionBox() {
    return selectionBounds(this.layer, this.selection);
  }

  setEraser(mode) {
    this._setMode('erase');
    this.eraserMode = mode === ERASER_MODES.REGION ? ERASER_MODES.REGION : ERASER_MODES.STROKE;
  }

  setColor(color) { this.color = color; }
  setWidth(width) { this.width = Math.max(0.2, Number(width) || this.width); }

  /**
   * Opacity for strokes drawn from now on.
   *
   * Applies to NEW strokes only — changing it must not reach back and repaint
   * existing ones, which would silently rewrite work the user already did.
   */
  setOpacity(opacity) {
    const value = Number(opacity);
    if (Number.isFinite(value)) this.opacity = Math.min(1, Math.max(0, value));
  }
  setInputMode(mode) { this.inputMode = mode; }
  setEnabled(enabled) { this.enabled = !!enabled; }

  /** Called by the host pane whenever its zoom or pan changes. */
  setTransform(scale, offsetX, offsetY) {
    this.transform = createTransform(scale, offsetX, offsetY);
    this.render();
  }

  /** Resizes the backing store to match the CSS box; contents are repainted. */
  resize(cssWidth, cssHeight, dpr = 1) {
    const w = Math.max(1, Math.floor(cssWidth * dpr));
    const h = Math.max(1, Math.floor(cssHeight * dpr));

    // Only touch the backing store when it actually changes size.
    //
    // Assigning canvas.width reallocates and clears the bitmap even when the
    // value is identical — and this is called from _syncInk on every position
    // change, which means every frame of a pan. A 1.6MP surface was being
    // thrown away and rebuilt, and every stroke repainted, sixty times a second
    // while dragging a page that had not resized at all.
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this._viewport = { width: cssWidth, height: cssHeight };
    // The repaint stays: the transform may have moved even when the size did not.
    this.render();
  }

  // ── layer lifecycle ───────────────────────────────────────────────────────

  /** Swaps in a page's ink; history starts clean for the new page. */
  loadLayer(layer) {
    // 选区是一串 id 加一圈线，两样都只对上一层成立。翻一页而不清掉它，那圈虚线
    // 会留在新的一页上，指着一批已经不在这里的笔画——而旁边那两个按钮会对着它们
    // 去复制和删除，什么也不会发生，看起来就是「按了没反应」。
    this.clearSelection();
    this.layer = layer || new InkLayer();
    this.history = new InkHistory(this.layer, {
      onChange: () => this.handlers.onHistoryChange?.(this.history),
    });
    this.render();
    this.handlers.onHistoryChange?.(this.history);
  }

  getLayer() { return this.layer; }

  // ── rendering ─────────────────────────────────────────────────────────────

  render() {
    if (!this._viewport) return;
    renderLayer(this.ctx, this.layer, this.transform, this._viewport);
    // The in-progress stroke is drawn on top so it appears live, before it is
    // committed to the layer on pointerup.
    if (this._active && isDrawable(this._active)) {
      drawStroke(this.ctx, this._active, this.transform);
    }
    // 从另一栏探过来的那一片，画在自己这一层上面：它还没落地，但人得看见它到哪
    // 儿了。见 showDragGhost。
    if (this._ghost) {
      for (const stroke of this._ghost) drawStroke(this.ctx, stroke, this.transform);
    }
    if (this._eraserDot) this._drawEraserDot();
    // The tip ring marks where a freehand loop will close back to. A dragged
    // rectangle has no such point — it is already closed, and a ring on one of
    // its corners would only claim a meaning it does not have.
    if (this._loop) {
      drawLasso(this.ctx, this._loop, this.transform, {
        tip: this.lassoShape !== 'rect',
        closed: this.lassoShape === 'rect',
      });
    }
    // 形状：正在拖的那一个，和松手之后还挂着圆点的那一个。
    //
    // 预览就是拿最终那条笔迹去画的——同一个 _strokeFromShape、同一个 drawStroke。
    // 另画一条细一点的「预览线」看着更轻快，代价是松手那一瞬间粗细和颜色都会
    // 跳一下，而那一下正是人在对比「我想要的」和「它给我的」。
    const live = this._shapeGrab?.shape || this._shape;
    if (live && !tooSmall(live)) {
      drawStroke(this.ctx, this._strokeFromShape(live), this.transform);
      drawShapeGuides(this.ctx, shapeGuides(live), this.transform);
    }
    // 撤销掉、擦掉、被套索删掉之后，那几颗圆点指着的笔迹已经不在层里了。
    //
    // 真机上撞到的就是这个：画完一个形状按撤销，形状没了，四颗琥珀点还浮在纸
    // 上——它们拖不动（按下去那条笔迹已经查无此人）、擦不掉（橡皮擦的是笔迹），
    // 但看着像是页面上的内容。下一次按下去才收掉已经太晚了。
    if (this._shapeSel && !this.layer.has(this._shapeSel.strokeId)) this._shapeSel = null;
    // 圆点和角度标签：正在拖的那个要看着改，没在拖的那个是「它还听我的」。
    const marked = this._shapeGrab?.shape || (this._shape ? null : this._shapeSel?.shape);
    if (marked) {
      drawShapeLabels(this.ctx, shapeLabels(marked), this.transform);
      drawShapeHandles(
        this.ctx, shapeHandles(marked), this.transform, this._shapeHandleRadius(),
      );
    }
    if (this.selection.length) this._drawSelection();
    this._placeBar();
  }

  /**
   * 把那条小条摆到套索线旁，或者收起来。
   *
   * 跟着 render 走，所以缩放、平移、搬完选区之后它都在该在的地方——不必在五个
   * 手势各自的收尾处记得叫一次。
   *
   * 手还在动的时候不露面：正在画的那一圈还不算选区，而正在搬的那一片，人看的是
   * 它落到哪儿，不是旁边有什么按钮。松开手它自己回来。
   */
  _placeBar() {
    if (!this._bar) return;
    // 手还在动就什么都不露：正在画的那一圈还不算选区，正在搬的那一片人看的是
    // 它落到哪儿。
    if (this._grab || this._loop) { this._bar.hide(); return; }

    const loop = this.selectionLoop;
    if (!this.selection.length || !loop || loop.length < 3) {
      // 没选东西，但手里还捏着剪下来的一片：那就只剩一个粘贴。剪下来却放不下去
      // 的剪切，和删除没有区别。
      if (this.selecting && clipboardHasInk() && this._viewport) {
        const v = this._viewport;
        this._bar.place(
          { minX: v.width / 2, maxX: v.width / 2, minY: v.height - 96, maxY: v.height - 96 },
          v,
          { mode: 'paste' },
        );
      } else {
        this._bar.hide();
      }
      return;
    }
    const docBox = polygonBounds(loop);
    if (!docBox) { this._bar.hide(); return; }
    // documentToScreen 只有缩放和平移、没有旋转，所以映两个对角就够，不必把整圈
    // 点都映一遍。这里不能用 transformPolygon——它是另一种变换（搬动选区那种），
    // 拿来做这件事会得到一个看不出错的错结果。
    const a = documentToScreen(this.transform, docBox.minX, docBox.minY);
    const b = documentToScreen(this.transform, docBox.maxX, docBox.maxY);
    const { canFill, current } = this._selectionPaint();
    this._bar.place(
      { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y },
      this._viewport || { width: 0, height: 0 },
      { mode: 'selection', colors: this._swatches, canFill, current },
    );
  }

  /**
   * 这一片里有没有能填色的东西（闭合的形状），以及它眼下是什么色。
   *
   * 各笔颜色不一样就说不上来（null）；填充在闭合形状之间不一样、或者根本没有闭合
   * 形状，也说不上来（undefined）。说得上来的才在色排上标出来。
   */
  _selectionPaint() {
    let canFill = false;
    let color;
    let fill;
    let mixedColor = false;
    let mixedFill = false;
    const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    for (const id of this.selection) {
      const stroke = this.layer.getById(id);
      if (!stroke) continue;
      if (color === undefined) color = stroke.color;
      else if (!same(color, stroke.color)) mixedColor = true;
      if (stroke.shape && isClosedShape(stroke.shape)) {
        const now = stroke.fill || null;
        if (!canFill) fill = now;
        else if (!same(fill, now)) mixedFill = true;
        canFill = true;
      }
    }
    return {
      canFill,
      current: {
        color: mixedColor ? null : (color ?? null),
        fill: canFill && !mixedFill ? fill : undefined,
      },
    };
  }

  /**
   * 把圈住的这一片再来一份，挪开一点。
   *
   * 复制完选中的是新的那一份，套索线也跟着挪过去——人接着要做的事十有八九是把它
   * 拖到别处，而那需要它是被选中的那一个。
   */
  duplicateSelection() {
    if (!this.selection.length) return false;
    const offset = COPY_OFFSET / (this.transform.scale || 1);
    const copies = [];
    for (const id of this.selection) {
      const original = this.layer.getById(id);
      if (!original) continue;
      const copy = cloneStroke(original, offset, offset);
      if (copy) copies.push(copy);
    }
    if (!copies.length) return false;

    // 一次手势，一步撤销。不然复制十条要按十次才收得回来。
    this.history.beginBatch();
    for (const copy of copies) {
      this.layer.add(copy);
      this.history.recordAdd(copy, this.layer.strokes.length - 1);
    }
    this.history.endBatch();

    this.selection = copies.map(s => s.id);
    if (this.selectionLoop) {
      this.selectionLoop = this.selectionLoop
        .map(p => ({ ...p, x: p.x + offset, y: p.y + offset }));
    }
    this._anchor = -1;
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  /** 圈住的这一片，不要了。撤销拿得回来——它走的是橡皮那条路。 */
  deleteSelection() {
    if (!this.selection.length) return false;
    const removed = this.layer.removeByIds(this.selection);
    if (!removed.length) return false;
    this.history.recordErase(removed);
    this.clearSelection();
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  /**
   * 剪下来收着，等会儿放到别处。
   *
   * 剪贴板是两个分栏共用的一份——从这一页剪下来，翻到另一页、换到另一栏、换到
   * 草稿纸上再放下，那正是剪切存在的理由。
   */
  cutSelection() {
    if (!this.selection.length) return false;
    const strokes = this.selection.map(id => this.layer.getById(id)).filter(Boolean);
    if (!strokes.length) return false;
    putOnClipboard(strokes);
    return this.deleteSelection();
  }

  /**
   * 把手里这一片放下。
   *
   * 落在当前看得见的那块地方的中间：粘贴之后人多半还要把它拖到确切的位置，而
   * 从画面正中往外拖，比从某个记不住的旧坐标往回找要短。
   *
   * 放下之后它是被选中的，套索线也圈好——接着拖就行，不必再套一次。
   */
  pasteClipboard() {
    if (!clipboardHasInk() || !this._viewport) return false;
    const centre = screenToDocument(
      this.transform, this._viewport.width / 2, this._viewport.height / 2);
    const strokes = takeFromClipboard(centre.x, centre.y);
    if (!strokes.length) return false;

    // 落点算的是整片的左上角，所以还要把它自己的一半挪回去，才是「居中」。
    const box = strokes.reduce((acc, s) => {
      const b = s.bounds;
      if (!b) return acc;
      return {
        minX: Math.min(acc.minX, b.minX), minY: Math.min(acc.minY, b.minY),
        maxX: Math.max(acc.maxX, b.maxX), maxY: Math.max(acc.maxY, b.maxY),
      };
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const dx = -(box.maxX - box.minX) / 2;
    const dy = -(box.maxY - box.minY) / 2;
    for (const stroke of strokes) {
      for (const pt of stroke.points) { pt.x += dx; pt.y += dy; }
      recomputeBounds(stroke);
    }


    this.history.beginBatch();
    for (const stroke of strokes) {
      this.layer.add(stroke);
      this.history.recordAdd(stroke, this.layer.strokes.length - 1);
    }
    this.history.endBatch();

    this.selection = strokes.map(s => s.id);
    const pad = 6;
    this.selectionLoop = [
      { x: box.minX + dx - pad, y: box.minY + dy - pad },
      { x: box.maxX + dx + pad, y: box.minY + dy - pad },
      { x: box.maxX + dx + pad, y: box.maxY + dy + pad },
      { x: box.minX + dx - pad, y: box.maxY + dy + pad },
    ];
    this._anchor = -1;
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  /**
   * 把圈住的这一片改成另一个颜色——笔画的颜色，形状的边框。填充不归它管，见
   * refillSelection。
   *
   * 记下每一条原来的颜色，而不是「原来都是黑的」——一片里本来就可能有好几种色，
   * 撤销要把各自的那一种还回去。
   */
  recolorSelection(color) {
    if (!this.selection.length || !color) return false;
    const before = [];
    for (const id of this.selection) {
      const stroke = this.layer.getById(id);
      if (!stroke || stroke.color === color) continue;
      before.push({ id, color: stroke.color });
      stroke.color = color;
    }
    if (!before.length) return false;
    this.history.recordRestyle(before, color);
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  /**
   * 把圈住的这一片里闭合形状的填充换掉；fill 为 null 是「不填」。
   *
   * 和换色分开：换色改的是边框（以及手写的笔画），这里只改填充。一个红边蓝底的
   * 三角形，人要的常常只是把底换掉，而原来只有一个颜色可挑、只改得了边——底色一
   * 旦定下就再也换不掉了。开口的形状（直线、箭头、圆弧）和手写笔画没有「里面」，
   * 这里不碰它们。没填过色的闭合形状挑了颜色就填上，这也是「能改」的一部分。
   *
   * 撤销是自己一步，只还填充，边框不动；各还各的，一片里本来就可能填着好几种色。
   */
  refillSelection(fill) {
    if (!this.selection.length) return false;
    const next = fill || null;
    const before = [];
    for (const id of this.selection) {
      const stroke = this.layer.getById(id);
      if (!stroke?.shape || !isClosedShape(stroke.shape)) continue;
      const was = stroke.fill || null;
      if (String(was || '').toLowerCase() === String(next || '').toLowerCase()) continue;
      before.push({ id, fill: was });
      stroke.fill = next;
    }
    if (!before.length) return false;
    this.history.recordRefill(before, next);
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  /**
   * The selection outline: the loop the user drew, kept.
   *
   * Not a bounding box. The lasso IS the shape — you draw a line round the
   * working you meant and that line is what stays on screen, closed and
   * dashed. A box would answer a different question: it would show the extent
   * of what was caught rather than what you asked for, and around anything
   * diagonal or L-shaped it would claim a large area of blank page that is not
   * part of the selection at all.
   *
   * The loop travels with the ink under every move, rotation and scale, so it
   * never stops describing what it holds.
   *
   * One handle carries rotate and scale, pinned to a VERTEX of the loop — the
   * lower-right extreme to begin with, and thereafter whichever vertex the
   * user grabbed. Deliberately one handle rather than eight: this is a stylus
   * interface, eight 8px targets round a shape is a precision task, and the
   * gesture a diagram actually wants is "turn it and size it", which one handle
   * does in a single movement.
   */
  _drawSelection() {
    const loop = this.selectionLoop;
    if (!loop || loop.length < 3) return;

    // The SAME renderer that drew it while the hand was moving, so releasing
    // the stylus does not change how the loop looks. It only closes.
    drawLasso(this.ctx, loop, this.transform, { closed: true });

    const handle = this._handleAt();
    if (!handle) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    const r = this._handleRadius();
    ctx.arc(handle.x, handle.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    // The ring's weight goes with its size. A 2px outline on a 40px dot reads
    // as a thin hoop, and on a 12px one it swallows the white centre.
    ctx.lineWidth = Math.min(3, Math.max(1.5, r / 4.5));
    ctx.strokeStyle = LASSO_STROKE;
    ctx.stroke();
    ctx.restore();
  }

  /** Drawn radius of the handle at the current zoom, in screen pixels. */
  _handleRadius() {
    const zoom = this.transform?.scale || 1;
    // sqrt, not the zoom itself: 1:1 would double the dot every time the page
    // doubles, which is a blob at 4x and invisible at a quarter. Damped, it
    // still moves everywhere in between — which is the whole point.
    let r = SELECT_HANDLE * Math.sqrt(zoom);

    const box = polygonBounds(this.selectionLoop);
    if (box) {
      const w = (box.maxX - box.minX) * zoom;
      const h = (box.maxY - box.minY) * zoom;
      r = Math.min(r, Math.min(w, h) * HANDLE_SHARE);
    }
    return Math.min(HANDLE_MAX, Math.max(HANDLE_MIN, r));
  }

  /**
   * How close a press has to be to count as grabbing the handle.
   *
   * Tracks the drawn dot, so aim and appearance never part company — but with
   * a floor of its own. On a very small selection the dot is deliberately
   * tiny, and a hit target that shrank with it all the way down would leave a
   * handle that can be seen and not pressed.
   */
  _handleHitRadius() {
    return Math.max(HANDLE_HIT_MIN, this._handleRadius() * 2.4);
  }

  /** Document point → canvas pixel. */
  _toScreen(p) {
    const t = this.transform;
    return { x: (p.x - t.offsetX) * t.scale, y: (p.y - t.offsetY) * t.scale };
  }

  /**
   * Screen-space position of the transform handle, or null.
   *
   * Reads the pinned vertex rather than searching for one, so the handle moves
   * with the loop instead of hopping between its points as the shape turns.
   */
  _handleAt() {
    const loop = this.selectionLoop;
    if (loop && this._anchor >= 0 && this._anchor < loop.length) {
      return this._toScreen(loop[this._anchor]);
    }
    const box = this.selectionBox();
    return box ? this._toScreen({ x: box.maxX, y: box.maxY }) : null;
  }

  /**
   * The eraser head, drawn where the pointer is.
   *
   * An eraser you cannot see is an eraser you aim by guessing: region erasing
   * used to draw a lasso outline that only told you where you had BEEN, never
   * what the next press would take. This is the head itself, at its real
   * radius, so the area about to be cleared is the area under the dot.
   */
  _drawEraserDot() {
    const { x, y } = this._eraserDot;
    const r = Math.max(2, this.eraserRadius * this.transform.scale);
    const px = x * this.transform.scale - this.transform.offsetX * this.transform.scale;
    const py = y * this.transform.scale - this.transform.offsetY * this.transform.scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.10)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
    ctx.stroke();
    ctx.restore();
  }

  // ── input ─────────────────────────────────────────────────────────────────

  _shouldDraw(e) {
    if (!this.enabled) return false;
    // Palm rejection: a hand resting on the tablet raises secondary touch
    // pointers, which must not each start their own stroke.
    if (e.pointerType === 'touch' && e.isPrimary === false) return false;
    if (this.inputMode === INPUT_MODES.STYLUS_ONLY) return e.pointerType === 'pen';
    if (this.inputMode === INPUT_MODES.NO_FINGER) return e.pointerType !== 'touch';
    return true;
  }

  _docPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return screenToDocument(this.transform, e.clientX - rect.left, e.clientY - rect.top);
  }

  /** Devices with no pressure report 0; treat that as neutral rather than zero width. */
  static _pressure(e) {
    if (e.pointerType === 'pen' && e.pressure > 0) return e.pressure;
    return 0.5;
  }

  _bind() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      // Not a drawing pointer: let the event bubble to the pane so the page can
      // be panned. The ink canvas covers the viewport, so swallowing events it
      // does not use would make the document immovable.
      if (!this._shouldDraw(e)) return;
      e.preventDefault();

      // Say so BEFORE the stroke is built.
      //
      // The next line stops propagation, and the pane's own pointerdown — the
      // one that marks this pane active — is upstream of it. So while ink was
      // claiming the pointer, drawing on a pane never made it the active pane:
      // the shared toolbar went on pushing tool, colour, width and eraser mode
      // to whichever pane was active before, and this surface kept whatever it
      // was last given. That is why selecting the highlighter or the eraser, or
      // changing colour, appeared to do nothing and every stroke came out as
      // the same marker.
      //
      // It has to run before `createStroke` reads this.tool/color/width below,
      // because the host answers by pushing the current tool state back to us.
      this.handlers.onDrawStart?.();

      // Claimed for ink — the pane must not also treat it as a pan drag.
      e.stopPropagation();
      this._pointerId = e.pointerId;
      c.setPointerCapture(e.pointerId);
      const pt = this._docPoint(e);

      if (this.selecting) {
        this._beginSelectionGesture(pt);
        return;
      }

      if (this.shaping) {
        this._beginShapeGesture(pt);
        return;
      }

      if (this.erasing) {
        // Both modes are a head you drag; they differ in what they take.
        // STROKE lifts a whole stroke it touches. REGION clears the area under
        // the head — press, a dot appears, and what the dot covers goes.
        //
        // REGION used to be a lasso: you drew a closed outline and everything
        // inside it vanished on release. That is a selection gesture, not an
        // eraser, and nothing showed what was about to be removed.
        // One gesture, one undo step. The eraser cuts on every pointermove,
        // so a single wipe across a page used to record dozens of separate
        // splits and needed dozens of presses to take back.
        this.history?.beginBatch();
        this._eraserDot = pt;
        this._eraserPath = [pt];
        this._eraseAlong();
        this.render();
        return;
      }

      this._active = createStroke({
        tool: this.tool,
        color: this.color,
        width: this.width,
        opacity: this.opacity,
      });
      appendPoint(this._active, pt.x, pt.y, InkSurface._pressure(e));
      this.render();
    });

    c.addEventListener('pointermove', (e) => {
      if (this._pointerId !== e.pointerId) return;
      e.stopPropagation();
      const pt = this._docPoint(e);

      if (this._grab) {
        this._dragSelection(pt);
        // 手指已经移到这块画布外面了——问问外面那一层，那儿有没有别的画布接
        // 得住。只在「搬」的时候问：旋转缩放是对这一片自己做的，没有落到别处
        // 这回事。
        if (this._grab.mode === 'move') this._offerDragOut(e);
        return;
      }
      if (this._loop) {
        // A rectangle is not sampled: it is redrawn from the two corners, so
        // the box always has exactly four points however far the hand wandered
        // getting to the second one.
        if (this.lassoShape === 'rect') {
          this._loop = rectLoop(this._loopFrom, pt);
          this.render();
          return;
        }
        // Only sample where the hand actually went somewhere. A stylus reports
        // at 120Hz or better, so an unfiltered loop arrives with hundreds of
        // near-identical points — every one of which would then be rotated and
        // scaled on every frame of the next gesture, and tested on every press.
        const last = this._loop[this._loop.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) >= LOOP_SPACING) {
          this._loop.push(pt);
          this.render();
        }
        return;
      }

      if (this._shapeGrab) {
        // 拖一颗圆点：形状照着新的那一头重算，吸附规则和画的时候一样。
        this._shapeGrab.shape = reshape(
          this._shapeGrab.shape, this._shapeGrab.handleId, pt,
        );
        this.render();
        return;
      }
      if (this._shapePress) {
        // 按在已有形状上之后手走了：这一下不是「选它」，是从按下那一点开始画一
        // 个新的。阈值按屏幕像素给，缩放到 400% 的时候手指抖那几下才不会算数。
        const slop = SHAPE_TAP_SLOP / (this.transform.scale || 1);
        const from = this._shapePress.at;
        if (Math.hypot(pt.x - from.x, pt.y - from.y) < slop) return;
        this._shapePress = null;
        this._shape = createShape(this.shapeKind, from, pt);
        this.render();
        return;
      }
      if (this._shape) {
        // 锚不动，另一头跟着笔。吸附在 createShape 里做，所以屏幕上看到的就是
        // 松手会留下的那一个——预览和结果是同一次计算。
        this._shape = createShape(this._shape.kind, this._shape.from, pt);
        this.render();
        return;
      }

      if (this._eraserDot) {
        // The head follows the pointer and takes what it passes over, so the
        // erase is continuous rather than committed on release.
        //
        // 只把**新走的这一段**交给命中测试，不是整条轨迹。走过的地方已经擦干净
        // 了，而擦除过程中不会凭空多出笔画来，所以重走一遍必然一无所获 —— 那是
        // 一条随手势变长而变慢的 O(n²)。600 笔的页面上实测，整条重走比只走新段
        // 贵 22–75 倍。
        //
        // 这一段要用合并事件里的原始采样，不能只用事件的落点。笔的采样率比
        // pointermove 的派发率高得多，浏览器会把中间那些点合并进一个事件；快速
        // 划过时，两次事件之间笔真正走的是一条**曲线**，而只拿落点去插值得到的
        // 是那条曲线的弦 —— 弦会抄近路，把弯里那几笔漏掉。这就是「快速扫过时
        // 有些笔记擦不到」。画笔一直用着合并事件（见下面），橡皮以前没用。
        //
        // 仍然是常数量级：合并事件只含**这一次**派发攒下的采样，不随手势变长。
        const previous = this._eraserDot;
        const merged = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const walked = merged.length > 1 ? merged.map(m => this._docPoint(m)) : [pt];
        this._eraserDot = walked[walked.length - 1];
        this._eraserPath = [previous, ...walked];
        this._eraseAlong();
        this.render();
        return;
      }
      if (!this._active) return;

      // Coalesced events keep fast strokes smooth without raising the sample
      // rate the rest of the time.
      const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      if (samples.length > 1) {
        for (const sample of samples) {
          const sp = this._docPoint(sample);
          appendPoint(this._active, sp.x, sp.y, InkSurface._pressure(sample));
        }
      } else {
        appendPoint(this._active, pt.x, pt.y, InkSurface._pressure(e));
      }
      this.render();
    });

    const finish = (e) => {
      if (this._pointerId !== e.pointerId) return;
      e.stopPropagation();
      try { c.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      this._pointerId = null;

      if (this._grab) {
        // 先看这一下是不是松在别的画布上。是的话这一片就归那边了，这边把它
        // 删掉——而删掉这一步记的是「带着另一半的擦除」：在这边撤销，那边那
        // 份也跟着消失，见 _handOff。
        //
        // 交出去了就不必收那个预览：那边已经把它收成真的了，先清再放会闪一下。
        if (this._grab.mode === 'move' && this._handOff(e)) return;
        if (this._grab.mode === 'move') this._endDragOut();

        // ONE history entry for the whole gesture.
        //
        // The transform is applied incrementally, a delta per pointer event, so
        // recording each of those would put fifty steps on the undo stack for
        // one drag and make undo useless. The snapshot taken when the gesture
        // began is compared with where it ended, and that pair is the step.
        const before = this._grab.before;
        const loopBefore = this._grab.loopBefore;
        this._grab = null;
        const after = snapshotStrokes(this.layer, this.selection);
        if (before?.length && moved(before, after)) {
          // The outline goes on the op with the ink. Undoing the points alone
          // left the loop sitting where the ink no longer was, drawing a
          // selection that had stopped existing — which is what the tablet
          // run saw after undoing a rotate.
          this.history?.recordTransform(before, after, {
            loopBefore,
            loopAfter: this.selectionLoop ? this.selectionLoop.map(p => ({ ...p })) : null,
          });
          this.handlers.onChange?.(this.layer);
        }
        this.render();
        return;
      }
      if (this._loop) {
        const loop = this._loop;
        this._loop = null;
        this._loopFrom = null;
        this.selection = loop.length >= 3
          ? selectInPolygon(this.layer, loop, strokeIdsInRegion, this.lassoInside)
          : [];
        // The loop is only kept when it caught something. An outline round
        // empty page is not a selection, and leaving it on screen would offer
        // a handle that transforms nothing.
        this.selectionLoop = this.selection.length ? loop : null;
        this._anchor = this.selectionLoop ? handleIndex(loop) : -1;
        this.render();
        return;
      }

      if (this._shapeGrab) {
        this._commitReshape();
        return;
      }
      if (this._shapePress) {
        // 手没走：这一下就是「选中它」。
        const press = this._shapePress;
        this._shapePress = null;
        this._shapeSel = { shape: press.shape, strokeId: press.strokeId };
        this.render();
        return;
      }
      if (this._shape) {
        this._commitShape();
        return;
      }

      if (this._eraserDot) {
        this._eraserDot = null;
        this._eraserPath = null;
        this.history?.endBatch();
        this.render();
        return;
      }

      if (this._eraserPath) {
        this._eraserPath = null;
        this.history?.endBatch();
        this.render();
        return;
      }

      const stroke = this._active;
      this._active = null;
      if (stroke && isDrawable(stroke)) {
        const index = this.layer.add(stroke);
        this.history.recordAdd(stroke, index);
        this.handlers.onChange?.(this.layer);
      }
      this.render();
    };

    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);
  }

  /**
   * Decides what a press means while the lasso tool is active.
   *
   * Three possibilities, resolved by where the press lands: on the handle it
   * rotates and scales; inside an existing selection it moves it; anywhere else
   * it starts a new loop and abandons the old selection.
   */
  _beginSelectionGesture(pt) {
    const handle = this._handleAt();
    if (handle && this.selection.length) {
      const sx = (pt.x - this.transform.offsetX) * this.transform.scale;
      const sy = (pt.y - this.transform.offsetY) * this.transform.scale;
      // Measured against what is DRAWN, not against a constant. A hit radius
      // that ignored the zoom would drift away from the dot the user is aiming
      // at — generous at one zoom, unreachable at another.
      const near = Math.hypot(sx - handle.x, sy - handle.y) <= this._handleHitRadius();
      if (near) {
        // Pin the handle to the loop vertex nearest the press, for the whole
        // gesture. The handle is then under the finger that grabbed it and
        // stays there while the shape turns and grows, instead of sliding
        // around the outline as the down-right extreme changes.
        const pinned = nearestIndex(this.selectionLoop, pt.x, pt.y);
        if (pinned >= 0) this._anchor = pinned;

        // The loop's centre, not the ink's. The user is turning the shape
        // they drew, and pivoting about a point that shape is not centred on
        // makes the selection swing rather than rotate.
        const box = polygonBounds(this.selectionLoop) || this.selectionBox();
        const origin = boundsCentre(box);
        this._grab = {
          mode: 'transform',
          before: snapshotStrokes(this.layer, this.selection),
          loopBefore: this.selectionLoop.map(p => ({ ...p })),
          origin,
          startAngle: Math.atan2(pt.y - origin.y, pt.x - origin.x),
          startDistance: Math.max(1e-3, Math.hypot(pt.x - origin.x, pt.y - origin.y)),
          last: { angle: 0, scale: 1 },
        };
        return;
      }
    }

    // Inside the LOOP, or close enough to its edge to have meant it — but NOT
    // merely inside its bounding box. Pressing in the empty corner of a
    // diagonal selection's box is a press on the page and starts a new lasso;
    // a freehand loop hugs the ink, though, so a stylus a few pixels outside
    // the line still meant to grab it. `GRAB_MARGIN` px of screen, in doc units.
    const loop = this.selectionLoop;
    const margin = GRAB_MARGIN / (this.transform.scale || 1);
    if (this.selection.length && loop && nearPolygon(pt.x, pt.y, loop, margin)) {
      this._grab = {
        mode: 'move',
        last: pt,
        before: snapshotStrokes(this.layer, this.selection),
        loopBefore: loop.map(p => ({ ...p })),
      };
      return;
    }

    this.selection = [];
    this.selectionLoop = null;
    this._anchor = -1;
    this._loopFrom = pt;
    this._loop = this.lassoShape === 'rect' ? rectLoop(pt, pt) : [pt];
    this.render();
  }

  // ── 形状 ──────────────────────────────────────────────────────────────────

  /**
   * 形状工具按下去意味着什么，看按在哪儿。
   *
   * 按在上一个形状的圆点上就是改它；按在别处就是画新的一个，同时把那几颗圆点
   * 收走——视频里正是这样：圆点在人下一次碰屏幕的那一帧灭掉。
   */
  _beginShapeGesture(pt) {
    // 它还在层里吗？撤销过、擦掉了、被套索删了，那几颗圆点就成了指向空处的东
    // 西——再拖一下会照着一条不存在的笔迹复制出新的一条来。
    if (this._shapeSel && !this.layer.has(this._shapeSel.strokeId)) {
      this._dropShapeSelection();
    }
    if (this._shapeSel) {
      const radius = this._shapeHitRadius() / (this.transform.scale || 1);
      const handle = shapeHandleAt(this._shapeSel.shape, pt, radius);
      if (handle) {
        // 拖之前先把旧的那条从层里拿走，拖完再放回去（改过的那一条）。
        //
        // 不拿走的话，整个拖动过程中屏幕上是两个形状：旧的还在层里，新的画在上
        // 面。人以为自己复制了一份。拿走的这一份留着——万一这一下什么也没改成，
        // 得原样放回原来那个层序里去。
        this._shapeGrab = {
          handleId: handle.id,
          shape: this._shapeSel.shape,
          strokeId: this._shapeSel.strokeId,
          removed: this.layer.removeByIds([this._shapeSel.strokeId]),
        };
        this.render();
        return;
      }
    }

    // 按在一个已经画好的形状上。
    //
    // 视频第 2706 帧那一下点在矩形**当中的空白处**，十八帧之后四颗圆点和四个
    // 「90°」一起亮起来——所以点一个已有的形状就是把它选中，不是在它上面开始画
    // 新的一个。
    //
    // 但也不能就此断了「在已有形状上面再画一个」这条路，所以这一下先不定性：
    // 手没走就是选中，走了就当作从按下那一点开始画新的。松手时在 _commitShape
    // 里分岔。
    const under = this._shapeStrokeAt(pt);
    if (under) {
      this._dropShapeSelection();
      this._shapePress = { at: pt, ...under };
      this.render();
      return;
    }

    this._dropShapeSelection();
    this._shape = createShape(this.shapeKind, pt, pt);
    this.render();
  }

  /**
   * 这一点底下那条**形状笔迹**，从上往下找，找不到就是 null。
   *
   * 只认还带着形状的那些笔迹：手写的线、以及被套索搬动过、被区域橡皮切开过的形
   * 状，都不在其列——见 _shapeIsLive。
   */
  _shapeStrokeAt(point) {
    const all = this.layer.getAll();
    const tolerance = Math.max(6, 10 / (this.transform.scale || 1));
    for (let i = all.length - 1; i >= 0; i--) {
      const stroke = all[i];
      if (!stroke.shape || !this._shapeIsLive(stroke)) continue;
      if (hitShape(stroke.shape, point, tolerance)) {
        return { shape: stroke.shape, strokeId: stroke.id };
      }
    }
    return null;
  }

  /**
   * 这条笔迹身上那个形状还作数吗。
   *
   * 形状记的是「这些点是怎么算出来的」，而套索搬过、转过、区域橡皮切过之后，点
   * 已经不是那么算出来的了。那种情况下它就该变回一条普通笔迹——还看得见、还擦得
   * 掉，只是不再亮圆点。
   *
   * 判据是头一个点：形状生成的点是定死的顺序（圆从正上开始，多边形从第一个顶点
   * 开始），所以头一个点对得上，这条笔迹就还是那个形状生出来的。
   */
  _shapeIsLive(stroke) {
    const first = stroke.points?.[0];
    if (!first) return false;
    const made = shapePoints(stroke.shape, { width: stroke.width })[0];
    if (!made) return false;
    return Math.abs(made.x - first.x) < 0.5 && Math.abs(made.y - first.y) < 0.5;
  }

  /**
   * 照一个形状做一条笔迹。用钢笔那套渲染，等宽，颜色粗细听工具栏的。
   *
   * 形状本身跟着笔迹存下来：之后点一下它、拖一个顶点，靠的就是这一份。
   * 填充只给闭合的形状——一条直线「里面」是没有面积的。
   */
  _strokeFromShape(shape) {
    const stroke = createStroke({
      tool: INK_TOOLS.PEN,
      color: this.color,
      width: this.width,
      opacity: this.opacity,
      fill: isClosedShape(shape) ? this.shapeFill : null,
      shape,
    });
    stroke.points = shapePoints(shape, { width: this.width });
    recomputeBounds(stroke);
    return stroke;
  }

  /**
   * 松手：形状落进层里，圆点留在它身上。
   *
   * 没拖出大小的那一下不落——它是「点了一下」，意思是把上一个形状的圆点收走，
   * 而那件事在 _beginShapeGesture 里已经做完了。往纸上留一个点不是任何人的意思。
   */
  _commitShape() {
    const shape = this._shape;
    this._shape = null;
    if (!shape || tooSmall(shape)) { this.render(); return; }
    const stroke = this._strokeFromShape(shape);
    const index = this.layer.add(stroke);
    this.history.recordAdd(stroke, index);
    this._shapeSel = { shape, strokeId: stroke.id };
    this.handlers.onChange?.(this.layer);
    this.render();
  }

  /**
   * 拖完一颗圆点：换掉那条笔迹。
   *
   * 记成一次 SPLIT（拿掉旧的、放回新的），不是「擦一次 + 画一次」——那会在撤销
   * 栈上留下两步，而人做的是一下。新笔迹的 id 是新的，所以 _shapeSel 也要跟着
   * 换，不然下一次拖圆点找的是一条已经不在层里的笔画。
   */
  _commitReshape() {
    const grab = this._shapeGrab;
    this._shapeGrab = null;
    if (!grab) { this.render(); return; }
    const removed = grab.removed || [];

    // 拖没了（拖成一条零长的线、一个零宽的圆）：当这一下没发生过，原样放回去。
    // 把一条笔迹拖到消失不该是「改形状」这个动作的一种结果。
    if (tooSmall(grab.shape)) {
      for (const entry of removed) this.layer.insertAt(entry.index, entry.stroke);
      this.render();
      return;
    }

    const stroke = this._strokeFromShape(grab.shape);
    const index = this.layer.add(stroke);
    if (removed.length) {
      // 一次 SPLIT：拿掉旧的、放回新的，记成**一步**。记成「擦一次 + 画一次」
      // 的话，人拖一下圆点要按两次撤销才回得去。
      this.history.recordSplit(removed, [{ index, stroke }]);
    } else {
      this.history.recordAdd(stroke, index);
    }
    this._shapeSel = { shape: grab.shape, strokeId: stroke.id };
    this.handlers.onChange?.(this.layer);
    this.render();
  }

  /** 圆点画出来多大（屏幕像素）。规矩和选区那颗把手一样，只是小一档。 */
  _shapeHandleRadius() {
    const zoom = this.transform?.scale || 1;
    const r = SHAPE_HANDLE * Math.sqrt(zoom);
    return Math.min(SHAPE_HANDLE_MAX, Math.max(SHAPE_HANDLE_MIN, r));
  }

  /** 多近算摸到它。画出来那么小一颗，光靠它自己是戳不中的。 */
  _shapeHitRadius() {
    return Math.max(SHAPE_HIT_MIN, this._shapeHandleRadius() * 3);
  }

  /**
   * Applies one increment of the live gesture.
   *
   * Increments, not absolutes: each move applies the delta since the last
   * event, so the strokes' own points are the running state and there is no
   * separate pending matrix that could disagree with them. It also means undo
   * gets one entry per event rather than one per gesture — which is why the
   * surface coalesces them below.
   */
  /**
   * 手指跑到这块画布外面了，问外面那一层要不要接。
   *
   * 只是「问」——真正接住是在松手那一刻。这里叫它是为了让落点那一栏能亮起来：
   * 一片被拖到半空中的笔迹，如果没有任何东西表示它会落在哪，人只会以为自己
   * 把它拖丢了。
   *
   * 之所以移出画布之后还收得到事件：搬动是带 setPointerCapture 的。
   */
  _offerDragOut(e) {
    if (!this.handlers.onDragOver) return;
    const r = this.canvas.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right
      || e.clientY < r.top || e.clientY > r.bottom;
    this.handlers.onDragOver({
      clientX: e.clientX,
      clientY: e.clientY,
      outside,
      ghost: this._ghostOnScreen(r),
    });
  }

  /** 手松开或者手势被打断：把探到别处的那一片收回来。 */
  _endDragOut() {
    this.handlers.onDragOver?.({ clientX: -1, clientY: -1, outside: false, ghost: null });
  }

  /**
   * 选中的这一片此刻在屏幕上的样子。
   *
   * 这是给**另一栏**用的。一片字迹被拖到两栏交界处时，越过去的那部分会被这块画
   * 布切掉——人看到的是它一点点消失，然后松手时在对面凭空出现。要让它看着像慢慢
   * 挪过去，对面就得在同一时刻把越过去的那部分画出来。
   *
   * 点用客户端坐标：那是两块画布唯一共用的坐标系，对面拿到之后换算成自己的。
   * scale 一并带上，好让对面把线画成一样的粗细——同一片字迹在路上不该变胖变瘦。
   */
  _ghostOnScreen(rect) {
    if (!this.selection.length) return null;
    const strokes = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of this.selection) {
      const stroke = this.layer.getById(id);
      if (!stroke) continue;
      const points = stroke.points.map((pt) => {
        const at = documentToScreen(this.transform, pt.x, pt.y);
        const x = rect.left + at.x;
        const y = rect.top + at.y;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        return { x, y, p: pt.p };
      });
      strokes.push({
        tool: stroke.tool,
        color: stroke.color,
        width: stroke.width,
        opacity: stroke.opacity,
        // 填了色的形状，路上也是填着色的——不带的话它一路是个空框，落地才突然填上。
        fill: stroke.fill || null,
        points,
      });
    }
    if (!strokes.length || !Number.isFinite(minX)) return null;
    return { strokes, scale: this.transform.scale, bounds: { minX, minY, maxX, maxY } };
  }

  /**
   * 别的栏有一片字迹探到这块画布上来了，先画出来。
   *
   * 只是画：不进层、不记历史、擦不到也选不中——它还在别人手里。松手那一下走的是
   * adoptStrokes，那才是真的收下。
   */
  showDragGhost(ghost) {
    if (!ghost?.strokes?.length || !this._viewport) { this.clearDragGhost(); return; }
    const r = this.canvas.getBoundingClientRect();
    // 粗细先除掉自己的 scale：drawStroke 画的时候会再乘回来，不这么做的话，同一
    // 片字迹跨过来会突然变粗或变细——而两栏的缩放本来就常常不一样。
    const k = (ghost.scale || 1) / (this.transform.scale || 1);
    this._ghost = ghost.strokes.map((stroke) => ({
      ...stroke,
      width: stroke.width * k,
      points: stroke.points.map((pt) => {
        const at = screenToDocument(this.transform, pt.x - r.left, pt.y - r.top);
        return { x: at.x, y: at.y, p: pt.p };
      }),
    }));
    this.render();
  }

  clearDragGhost() {
    if (!this._ghost) return;
    this._ghost = null;
    this.render();
  }

  /**
   * 松在别的画布上：把这一片交过去，这边删掉。
   *
   * 交的是序列化过的笔画，不是活对象——理由和剪贴板那边一样（见
   * ink-clipboard.js 开头）：活对象会让两边的撤销栈牵住同一批笔画，谁都放不掉。
   *
   * 两边各记一步撤销，不是一步。它们是两份不同的文档，各有各的历史；硬凑成一
   * 步的话，在目标那边按撤销要连带改动源文档，而人看不到源文档正在发生什么。
   *
   * @returns {boolean} 真的交出去了吗。false 时调用方照常走原来的收尾。
   */
  _handOff(e) {
    if (!this.handlers.onDragDrop || !this.selection.length) return false;
    const r = this.canvas.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside) return false;

    // 松手这一下也算一步。pointerup 的坐标和最后一次 pointermove 常常差几个像素
    // （甩得快的时候更多），不补上的话，落下去的比指尖差那么一截。
    if (this._grab?.mode === 'move') this._dragSelection(this._docPoint(e));

    const strokes = this.selection
      .map(id => this.layer.getById(id))
      .filter(Boolean);
    if (!strokes.length) return false;

    const landed = this.handlers.onDragDrop({
      strokes: strokes.map(serializeStroke),
      clientX: e.clientX,
      clientY: e.clientY,
      // 带上这边的缩放，让它落下去之后**看着和拖着的时候一样大**。不带的话，两
      // 栏缩放不同时，松手那一刻它会突然涨一圈或缩一圈——前面一路铺垫的「慢慢挪
      // 过去」，全毁在最后那一下。
      scale: this.transform.scale,
      // 再带上这些点此刻在屏幕上的换算（画布的位置＋这边的变换），让那边把每个
      // 点放回它松手时在屏幕上的位置——也就是预览最后画它的地方。见 adoptStrokes。
      origin: { left: r.left, top: r.top, transform: { ...this.transform } },
    });
    if (!landed) return false;

    // 交出去了才删。反过来先删的话，目标那边要是接不住（比如那一栏没装东
    // 西），这一片就凭空消失了。
    const ids = strokes.map(s => s.id);

    // 删之前先把它们放回**拖动开始前**的位置。
    //
    // 拖动是实时改坐标的：松手那一刻，这些笔画在本文档里的位置已经跟着手指跑
    // 到视野外去了（手指此刻在另一栏）。照那个位置记擦除，撤销会把它们「还
    // 原」到屏幕外——看上去就是撤销没反应。真机之前就是这么表现的。
    //
    // 撤销「把这一片拖走了」，人期望的是它回到拖之前待的地方，而不是回到手指
    // 离开这一栏时它碰巧在的地方。_grab.before 正是抓取那一刻的快照。
    const before = this._grab?.before;
    this._grab = null;
    if (before?.length) {
      restorePoints(this.layer, before);
      for (const id of ids) {
        const stroke = this.layer.getById(id);
        if (stroke) recomputeBounds(stroke);
      }
    }

    const removed = this.layer.removeByIds(ids);
    // 记成一步「带着另一半的擦除」：在这边撤销，那边那份也跟着消失。少了这一对
    // 回调的话，撤销之后两边各有一份——一次撤销把内容变成了两份。
    if (removed.length) {
      this.history.recordErase(removed, landed.remove && landed.restore
        ? { onUndo: landed.remove, onRedo: landed.restore }
        : null);
    }
    this.clearSelection();
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  /**
   * 别的画布把一片交过来了，落在这个屏幕点上。
   *
   * @param {number} [sourceScale] 源那块画布的缩放。给了就按它折算，让这一片落下
   *   来之后在屏幕上和拖着的时候一样大。
   * @param {{left: number, top: number, transform: object}} [origin] 源那块画布
   *   在屏幕上的位置和它的变换。给了就逐点落回松手时的屏幕位置（见下）；没给才退
   *   回「整片的中心摆到指尖下」。
   * @returns {{ids: string[], remove: function, restore: function}|null}
   *   接住了就回一组把手：源那边把它挂在自己的撤销上，好让「撤销拖走」把两边一起
   *   还原。接不住回 null。
   */
  adoptStrokes(serialized, clientX, clientY, sourceScale, origin) {
    if (!Array.isArray(serialized) || !serialized.length || !this._viewport) return null;
    const r = this.canvas.getBoundingClientRect();

    // 屏幕上多大就多大。两栏缩放不同时，照搬文档坐标会让它在松手那一刻变个大小
    // ——而人刚刚一路看着它以某个大小挪过来。代价是它在**文档**里的尺寸变了，但
    // 直接拖动本来承诺的就是「所见即所得」。
    const k = Number.isFinite(sourceScale) && sourceScale > 0
      ? sourceScale / (this.transform.scale || 1)
      : 1;

    const strokes = serialized.map(json => deserializeStroke({ ...json, id: undefined }));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const stroke of strokes) {
      for (const pt of stroke.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
    if (!Number.isFinite(minX)) return null;

    // 每个点落回它松手那一刻在屏幕上的位置：源的文档坐标 → 屏幕 → 这边的文档坐
    // 标，和 showDragGhost 画预览是同一套换算，所以落下来的就是预览最后停着的那
    // 一片，一个像素都不挪。
    //
    // 以前是把整片的中心摆到指尖下。人很少按着正中间拖——按着左上角拖过来，松手
    // 那一下它就往左上跳半个身位，看着像没放准。
    const from = origin?.transform;
    const exact = from && Number.isFinite(origin.left) && Number.isFinite(origin.top)
      && Number.isFinite(from.scale) && from.scale > 0;
    let place;
    if (exact) {
      place = (pt) => {
        const on = documentToScreen(from, pt.x, pt.y);
        return screenToDocument(this.transform, origin.left + on.x - r.left, origin.top + on.y - r.top);
      };
    } else {
      // 没带来处：整片的中心摆到指尖下，缩放也绕这个中心做，变大变小都朝着指尖。
      const at = screenToDocument(this.transform, clientX - r.left, clientY - r.top);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      place = (pt) => ({ x: at.x + (pt.x - cx) * k, y: at.y + (pt.y - cy) * k });
    }
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const stroke of strokes) {
      for (const pt of stroke.points) {
        const to = place(pt);
        pt.x = to.x;
        pt.y = to.y;
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
      stroke.width *= k;
      recomputeBounds(stroke);
    }

    // 预览到此为止：这一片马上就是真的了，两份一起画就是同一片字迹重了影。
    // 收在这里而不是让外面记得收——它是谁的预览，谁就该在它变成真的那一刻收
    // 掉，而不是指望调用方的顺序排得刚好。
    this._ghost = null;

    this.history.beginBatch();
    for (const stroke of strokes) {
      this.layer.add(stroke);
      this.history.recordAdd(stroke, this.layer.strokes.length - 1);
    }
    this.history.endBatch();

    // 落下来就是选中的：人接着多半要再挪一下，而那需要它是被选中的那一个。
    this.selection = strokes.map(s => s.id);
    const pad = 6;
    const left = minX - pad;
    const right = maxX + pad;
    const top = minY - pad;
    const bottom = maxY + pad;
    this.selectionLoop = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
    this._anchor = -1;
    this.render();
    this.handlers.onChange?.(this.layer);

    // 把手交回去。撤销走的不是这块画布自己的历史——那一步属于源那边（人是在那
    // 边按的撤销），所以这里只提供动作，不记步。
    const ids = strokes.map(st => st.id);
    const taken = strokes.map(st => ({ ...st, points: st.points.map(pt2 => ({ ...pt2 })) }));
    return {
      ids,
      remove: () => {
        this.layer.removeByIds(ids);
        if (ids.some(id => this.selection.includes(id))) this.clearSelection();
        this.render();
        this.handlers.onChange?.(this.layer);
      },
      restore: () => {
        for (const st of taken) {
          const copy = { ...st, points: st.points.map(pt2 => ({ ...pt2 })) };
          recomputeBounds(copy);
          this.layer.add(copy);
        }
        this.render();
        this.handlers.onChange?.(this.layer);
      },
    };
  }

  _dragSelection(pt) {
    const g = this._grab;
    if (!g) return;

    if (g.mode === 'move') {
      const dx = pt.x - g.last.x;
      const dy = pt.y - g.last.y;
      g.last = pt;
      if (transformSelection(this.layer, null, this.selection, { dx, dy })) {
        this.selectionLoop = transformPolygon(this.selectionLoop, { dx, dy });
        this.render();
      }
      return;
    }

    const angleNow = Math.atan2(pt.y - g.origin.y, pt.x - g.origin.x);
    const distNow = Math.max(1e-3, Math.hypot(pt.x - g.origin.x, pt.y - g.origin.y));
    const angle = (angleNow - g.startAngle) - g.last.angle;
    const scale = (distNow / g.startDistance) / g.last.scale;
    g.last = { angle: angleNow - g.startAngle, scale: distNow / g.startDistance };

    // Rotation and scale in ONE step about the selection's centre, which is
    // what makes turning and resizing a single continuous movement instead of
    // two that fight over the origin.
    const step = { origin: g.origin, angle, scale };
    if (transformSelection(this.layer, null, this.selection, step)) {
      this.selectionLoop = transformPolygon(this.selectionLoop, step);
      this.render();
    }
  }

  /**
   * Applies the eraser at its current position, coalescing one drag into one
   * undo step.
   *
   * The two modes take different things, which is the whole distinction between
   * them: STROKE lifts any whole stroke the head touches, REGION takes only the
   * ink under the head and leaves the rest of the stroke behind, cut.
   */
  /**
   * 擦掉橡皮头这一步经过的东西。
   *
   * **不重画。** 两个调用点（pointerdown 和 pointermove）在它返回之后都会
   * render 一次；这里再画一次就是同一帧里把整层笔画重绘两遍，而且恰好发生在
   * 真的擦到东西、那一帧本来就最重的时候。真机上这一下是「橡皮比画笔卡」的
   * 主要来源：600 笔的页面上，橡皮 p95 73ms、最坏 108ms，同一页画笔是 59ms /
   * 85ms。
   *
   * `_eraserPath` 只有新走的那一段（最多两点），不是整条轨迹 —— 理由见
   * pointermove 那里。
   */
  _eraseAlong() {
    if (this.eraserMode === ERASER_MODES.REGION) {
      // 沿这一段路径一路挖，不是只在落点挖一个洞 —— 见 eraseAreaAlongPath。
      if (!this._eraserPath?.length) return;
      if (eraseAreaAlongPath(this.layer, this.history, this._eraserPath, this.eraserRadius)) {
        this.handlers.onChange?.(this.layer);
      }
      return;
    }

    const ids = strokeIdsAlongPath(this.layer, this._eraserPath, this.eraserRadius);
    if (!ids.length) return;
    const removed = eraseStrokes(this.layer, this.history, ids);
    if (removed.length) this.handlers.onChange?.(this.layer);
  }

  // ── commands ──────────────────────────────────────────────────────────────

  undo() {
    const op = this.history.undo();
    if (!op) return false;
    this._syncSelectionTo(op, 'loopBefore');
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  redo() {
    const op = this.history.redo();
    if (!op) return false;
    this._syncSelectionTo(op, 'loopAfter');
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  /**
   * Keeps the lasso outline honest across an undo or a redo.
   *
   * A selection is a claim about where some ink is. Stepping the ink back
   * without stepping the claim back leaves a loop drawn round empty page, with
   * a handle that transforms strokes somewhere else entirely.
   *
   * A transform carries the outline on the op, so it can be put back exactly.
   * Anything else — an erase, a clear, a stroke coming or going — may have
   * removed the very strokes the selection names, so the claim is dropped
   * rather than guessed at.
   */
  _syncSelectionTo(op, which) {
    if (!this.selection.length) return;
    if (op?.type === INK_OPS.TRANSFORM && op[which]) {
      this.selectionLoop = op[which].map(p => ({ ...p }));
      if (this._anchor >= this.selectionLoop.length) this._anchor = -1;
      return;
    }
    if (op?.type === INK_OPS.TRANSFORM) return;
    this.selection = [];
    this.selectionLoop = null;
    this._anchor = -1;
  }

  /** Clears ink only. The PDF canvas is a different element entirely. */
  clear() {
    const removed = this.layer.clear();
    if (!removed.length) return false;
    this.history.recordClear(removed);
    this.render();
    this.handlers.onChange?.(this.layer);
    return true;
  }

  canUndo() { return this.history.canUndo(); }
  canRedo() { return this.history.canRedo(); }
  isEmpty() { return this.layer.isEmpty(); }
}
