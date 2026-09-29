#!/usr/bin/env node
// 把一片字迹从这一栏拖到另一栏。
//
// 复制出来的那一份，人会按住它往旁边那一栏拖。手指出了这块画布之后，pointermove
// 还在来（setPointerCapture 的作用），所以「拖出去」这件事从头到尾都在源那一侧，
// 松手那一下才问外面：那儿有没有别的画布接得住。
//
// 这里钉五样：
//   1. 拖过去就是搬家，不是复印：左边少掉的和右边多出来的是同一片，总数不变。
//   2. 撤销是「就当没拖过」。左边要回到**按下去之前**待的地方——不是回到手指离开
//      左边时它碰巧在的地方（那时它已经跟着手指跑到视野外了），而右边那一份要跟着
//      消失。少了后半句的话，一次撤销把内容变成两份。
//   3. 重做把这一步原样再走一遍，两边都是。
//   4. 没人接得住就不交出去。松在空白处，这一片还在原地——凭空消失是最糟的结果。
//   5. 一个 id 在一层里只有一份。getById 用的是 find，撞了 id 的第二份看得见、
//      选不中、也擦不掉。
//
// 真机上这条路要笔（stylus-only），这里用 pointerType: 'pen' 的事件走同一条。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

const NEWLINE = String.fromCharCode(10);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}

const { InkSurface } = await import('../src/ink/ink-surface.js');
const { INK_TOOLS, appendPoint, createStroke } = await import('../src/ink/stroke.js');

/** jsdom 没有画布。要的不是画得对，是别在画的时候炸掉。 */
function stubContext() {
  const sink = {};
  return new Proxy(sink, {
    get(target, key) {
      if (key === 'canvas') return null;
      if (!(key in target)) target[key] = () => {};
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

/**
 * 一块装在屏幕某处的画布。
 *
 * rect 是它在屏幕上的位置——两块画布必须占不同的地方，不然「手指出了这一块、进了
 * 那一块」就无从谈起，而那正是这个文件要测的事。
 */
function mount(rect) {
  const canvas = dom.window.document.createElement('canvas');
  canvas.getContext = () => stubContext();
  canvas.getBoundingClientRect = () => ({
    left: rect.left, top: rect.top,
    right: rect.left + rect.width, bottom: rect.top + rect.height,
    width: rect.width, height: rect.height,
  });
  // jsdom 的指针捕获会挑 pointerId，而这里的事件是手搓的。
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  dom.window.document.body.appendChild(canvas);

  const surface = new InkSurface(canvas, {});
  surface.resize(rect.width, rect.height, 1);
  surface.setTransform(1, 0, 0);
  surface.selecting = true;
  return { surface, canvas, rect };
}

/**
 * 把两块画布接起来，接法照抄 pdf-workspace 的 _dropInkIntoOtherSlot。
 *
 * 回的是 adoptStrokes 给的那组把手，不是布尔——源那边要把「撤销拖走」接到落地的
 * 那一份上。这一点是这个文件的重点。
 */
function wire(panes) {
  for (const pane of panes) {
    // 照抄工作区的 _showInkGhost：按**这一片的外框**和对面画布相不相交来判，不是
    // 按手指在哪。
    pane.surface.handlers.onDragOver = ({ ghost }) => {
      for (const other of panes) {
        if (other === pane) continue;
        const r = other.rect;
        const b = ghost?.bounds;
        const reaches = b && b.maxX > r.left && b.minX < r.left + r.width
          && b.maxY > r.top && b.minY < r.top + r.height;
        if (reaches) other.surface.showDragGhost(ghost);
        else other.surface.clearDragGhost();
      }
    };
    pane.surface.handlers.onDragDrop = ({ strokes, clientX, clientY, scale, origin }) => {
      const hit = panes.find(p => p !== pane
        && clientX >= p.rect.left && clientX <= p.rect.left + p.rect.width
        && clientY >= p.rect.top && clientY <= p.rect.top + p.rect.height);
      if (!hit) return null;
      return hit.surface.adoptStrokes(strokes, clientX, clientY, scale, origin);
    };
  }
}

/** 一条从 (x,y) 往右的直线，直接放进层里。 */
function line(surface, x, y, len = 20) {
  const stroke = createStroke({ tool: INK_TOOLS.PEN, color: '#000', width: 2 });
  appendPoint(stroke, x, y, 0.5, 0);
  appendPoint(stroke, x + len, y, 0.5, 0);
  surface.layer.add(stroke);
  return stroke;
}

/** 手搓一个笔的事件。InkSurface 只读这几个字段。 */
function pen(type, clientX, clientY) {
  const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: 1, pointerType: 'pen', isPrimary: true, pressure: 0.5,
    clientX, clientY,
  });
  return e;
}

/** 一片选中的字迹，连它的套索线。 */
function selectRect(surface, ids, x0, y0, x1, y1) {
  surface.selection = ids;
  surface.selectionLoop = [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
}

/** 每条笔画的头一个点，用来比「回没回到原处」。 */
const heads = (surface) => surface.layer.getAll()
  .map(s => [Math.round(s.points[0].x), Math.round(s.points[0].y)]);

/** 层里所有点的中心。只有没带来处（origin）的老调用才按它落。 */
function centre(surface) {
  const pts = surface.layer.getAll().flatMap(s => s.points);
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  return [
    Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
    Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
  ];
}

/**
 * 左边画一条，选中它，按住往右边拖，松手。
 *
 * 两块画布在屏幕上左右各占 400 宽，中间不重叠——和真机上两栏的样子一样。
 */
function dragAcross() {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  wire([left, right]);

  const a = line(left.surface, 100, 200);
  selectRect(left.surface, [a.id], 60, 150, 220, 280);
  const before = heads(left.surface);

  left.canvas.dispatchEvent(pen('pointerdown', 140, 215));
  left.canvas.dispatchEvent(pen('pointermove', 300, 250));
  left.canvas.dispatchEvent(pen('pointermove', 600, 300));
  left.canvas.dispatchEvent(pen('pointerup', 600, 300));

  return { left, right, before, id: a.id };
}

// ═══════════════════════════════════════════════════════════════
group('1. 拖过去是搬家，不是复印');

await test('左边空了，右边接住了', async () => {
  const { left, right } = dragAcross();
  assert.equal(left.surface.layer.length, 0, '交出去了就该删，不然两边各一份');
  assert.equal(right.surface.layer.length, 1, '右边没接住的话这一片就凭空消失了');
});

await test('按着哪一点拖过去，松手时那一点还在指尖下', async () => {
  const { right } = dragAcross();
  // 按在 (140,215)，线头在 (100,200)：指尖在线头右下 (40,15)。右边那块画布从屏幕
  // 400 开始，手在屏幕 600 松开 —— 它自己的 200。线头该在 (200-40, 300-15)。
  //
  // 以前落的是「整片的中心在指尖下」，也就是 (190..210, 300)：按着一角拖过来的那
  // 一片，松手那一下跳了半个身位。
  assert.deepEqual(heads(right.surface), [[160, 285]], '松手那一下不该跳');
});

await test('落下来就是选中的', async () => {
  const { right } = dragAcross();
  assert.equal(right.surface.selection.length, 1, '接着多半还要再挪一下');
  assert.ok(right.surface.selectionLoop, '没有套索线就没有可抓的把手');
});

await test('新的 id，不是原来那一条', async () => {
  const { right, id } = dragAcross();
  assert.notEqual(right.surface.layer.getAll()[0].id, id,
    '两份文档共用一个 id，谁先存谁后存都能把对方盖掉');
});

// ═══════════════════════════════════════════════════════════════
group('2. 在源那边撤销 = 就当没拖过');

await test('左边回到按下去之前的位置', async () => {
  const { left, before } = dragAcross();
  left.surface.undo();
  assert.deepEqual(heads(left.surface), before,
    '拖动是实时改坐标的：照松手时的位置还原，等于还原到屏幕外，看着就是撤销没反应');
});

await test('右边那一份跟着消失', async () => {
  const { left, right } = dragAcross();
  left.surface.undo();
  assert.equal(right.surface.layer.length, 0,
    '不跟着走的话，一次撤销把内容变成了两份');
});

await test('撤销之后总数和拖之前一样', async () => {
  const { left, right } = dragAcross();
  left.surface.undo();
  assert.equal(left.surface.layer.length + right.surface.layer.length, 1);
});

// ═══════════════════════════════════════════════════════════════
group('3. 重做把这一步原样再走一遍');

await test('左边又空了，右边又有了', async () => {
  const { left, right } = dragAcross();
  left.surface.undo();
  left.surface.redo();
  assert.equal(left.surface.layer.length, 0);
  assert.equal(right.surface.layer.length, 1);
});

await test('撤销重做来回三趟，两边都不多不少', async () => {
  const { left, right } = dragAcross();
  for (let i = 0; i < 3; i++) {
    left.surface.undo();
    assert.equal(left.surface.layer.length, 1, `第 ${i + 1} 趟撤销`);
    assert.equal(right.surface.layer.length, 0, `第 ${i + 1} 趟撤销`);
    left.surface.redo();
    assert.equal(left.surface.layer.length, 0, `第 ${i + 1} 趟重做`);
    assert.equal(right.surface.layer.length, 1, `第 ${i + 1} 趟重做`);
  }
});

// ═══════════════════════════════════════════════════════════════
group('4. 没人接得住就不交出去');

await test('松在两块画布之外，这一片还在原地', async () => {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  wire([left, right]);

  const a = line(left.surface, 100, 200);
  selectRect(left.surface, [a.id], 60, 150, 220, 280);

  left.canvas.dispatchEvent(pen('pointerdown', 140, 215));
  left.canvas.dispatchEvent(pen('pointermove', 300, 250));
  // 900 在两块画布右边的外面。
  left.canvas.dispatchEvent(pen('pointermove', 900, 900));
  left.canvas.dispatchEvent(pen('pointerup', 900, 900));

  assert.equal(left.surface.layer.length, 1, '没处可去就该留下，不该消失');
  assert.equal(right.surface.layer.length, 0);
});

await test('在自己这块画布里挪动不算交出去', async () => {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  wire([left, right]);

  const a = line(left.surface, 100, 200);
  selectRect(left.surface, [a.id], 60, 150, 220, 280);
  left.canvas.dispatchEvent(pen('pointerdown', 140, 215));
  left.canvas.dispatchEvent(pen('pointermove', 200, 300));
  left.canvas.dispatchEvent(pen('pointerup', 200, 300));

  assert.equal(left.surface.layer.length, 1);
  assert.equal(right.surface.layer.length, 0);
  const [x] = heads(left.surface)[0];
  assert.ok(x > 100, '挪了就该在新地方');
});

// ═══════════════════════════════════════════════════════════════
group('5. 一个 id 在一层里只有一份');

await test('同一条笔画放两次，第二次不算', async () => {
  const { surface } = mount({ left: 0, top: 0, width: 400, height: 600 });
  const a = line(surface, 10, 10);
  assert.equal(surface.layer.add(a), -1, 'getById 用的是 find，撞了 id 的第二份永远选不中');
  assert.equal(surface.layer.length, 1);
});

await test('insertAt 也挡', async () => {
  const { surface } = mount({ left: 0, top: 0, width: 400, height: 600 });
  const a = line(surface, 10, 10);
  assert.equal(surface.layer.insertAt(0, a), -1);
  assert.equal(surface.layer.length, 1);
});

await test('拖过去之后在两边来回撤销重做，右边不会多出一份', async () => {
  // 右边自己也记了一步「加入」。两边各按各的顺序重放时，同一份有可能被还回去两
  // 次——挡重复的那一层就是为这条路准备的。
  const { left, right } = dragAcross();
  right.surface.undo();
  left.surface.undo();
  left.surface.redo();
  right.surface.redo();
  const ids = right.surface.layer.getAll().map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, '同一个 id 出现了两次');
  assert.ok(right.surface.layer.length <= 1, `右边有 ${right.surface.layer.length} 份`);
});

// ═══════════════════════════════════════════════════════════════
group('6. 越过去的那一半，对面当场就画出来');

// 一片字迹拖到两栏交界处时，越过去的那部分会被这块画布切掉——人看到的是它一点点
// 消失，松手之后在对面凭空出现。要让它看着像慢慢挪过去，对面就得在同一时刻把越
// 过去的那部分画出来。

await test('手指还在这边，但这一片探过去了，对面就有了', async () => {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  wire([left, right]);

  // 一条很长的线：手指按在它左端，右端早就过了 400 那条界。
  const a = line(left.surface, 200, 300, 260);
  selectRect(left.surface, [a.id], 180, 250, 480, 350);
  left.canvas.dispatchEvent(pen('pointerdown', 220, 300));
  left.canvas.dispatchEvent(pen('pointermove', 260, 300));

  assert.ok(right.surface._ghost, '手指还在左边，但右边该已经看得见探过去的那一截了');
  assert.equal(right.surface.layer.length, 0, '预览不进层：它还在别人手里');
  assert.equal(right.surface.history.canUndo(), false, '预览也不该记成一步');

  left.canvas.dispatchEvent(pen('pointerup', 260, 300));
});

await test('还没探到对面就不画', async () => {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  wire([left, right]);

  const a = line(left.surface, 100, 300);
  selectRect(left.surface, [a.id], 60, 250, 220, 350);
  left.canvas.dispatchEvent(pen('pointerdown', 140, 300));
  left.canvas.dispatchEvent(pen('pointermove', 160, 300));
  assert.equal(right.surface._ghost, null, '离得还远就画，那是一片突然冒出来的字迹');
  left.canvas.dispatchEvent(pen('pointerup', 160, 300));
});

await test('松手之后预览不留在对面', async () => {
  const { right } = dragAcross();
  assert.equal(right.surface._ghost, null,
    '落地之后那一份是真的了，预览再留着就是同一片东西画了两遍');
});

await test('缩回来也不留', async () => {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  wire([left, right]);

  const a = line(left.surface, 200, 300, 260);
  selectRect(left.surface, [a.id], 180, 250, 480, 350);
  left.canvas.dispatchEvent(pen('pointerdown', 220, 300));
  left.canvas.dispatchEvent(pen('pointermove', 300, 300));
  assert.ok(right.surface._ghost, '先探过去');
  left.canvas.dispatchEvent(pen('pointermove', 100, 300));
  assert.equal(right.surface._ghost, null, '缩回来了就该收掉');
  left.canvas.dispatchEvent(pen('pointerup', 100, 300));
});

// ═══════════════════════════════════════════════════════════════
group('7. 落下来和拖着的时候一样大');

await test('两栏缩放不同时，落地不改屏幕上的大小', async () => {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  left.surface.setTransform(0.5, 0, 0);   // 左边 50%
  right.surface.setTransform(2, 0, 0);    // 右边 200%
  wire([left, right]);

  const a = line(left.surface, 100, 200, 40);   // 文档里 40 宽，屏幕上 20
  selectRect(left.surface, [a.id], 60, 150, 220, 280);
  // 按在套索线的左上角一带：右下角那个圈是旋转把手，离它太近按下去开始的是旋
  // 转，不是搬动。
  left.canvas.dispatchEvent(pen('pointerdown', 40, 85));
  left.canvas.dispatchEvent(pen('pointermove', 300, 200));
  left.canvas.dispatchEvent(pen('pointermove', 600, 300));
  left.canvas.dispatchEvent(pen('pointerup', 600, 300));

  const got = right.surface.layer.getAll()[0];
  assert.ok(got, '先得落过去');
  const xs = got.points.map(p => p.x);
  const onScreen = (Math.max(...xs) - Math.min(...xs)) * 2;   // 右边 scale = 2
  assert.ok(Math.abs(onScreen - 20) < 0.5,
    `屏幕上应该还是 20 宽，实际 ${onScreen.toFixed(1)}——松手那一刻变了大小，前面` +
    '一路铺垫的「慢慢挪过去」就毁在最后那一下');
  assert.ok(Math.abs(got.width - 2 * 0.25) < 1e-6,
    '线的粗细也要一起折算，不然它在屏幕上会突然变粗');
});

// ═══════════════════════════════════════════════════════════════
group('7b. 落在预览最后停着的地方');

// 真机上报的：拖过去之后，落下来的那一片不在松手的地方。预览一路是跟着指尖、保持
// 着按下去时的相对位置走的；松手那一下却改成「整片的中心摆到指尖下」——除非正好
// 按着正中间拖，否则一定跳。

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

await test('落下来的每个点，就是预览最后画它的地方', async () => {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  wire([left, right]);

  const a = line(left.surface, 100, 200, 60);
  selectRect(left.surface, [a.id], 60, 150, 220, 280);
  left.canvas.dispatchEvent(pen('pointerdown', 110, 205));
  left.canvas.dispatchEvent(pen('pointermove', 300, 260));
  left.canvas.dispatchEvent(pen('pointermove', 520, 330));
  const ghost = right.surface._ghost.map(st => st.points.map(p => ({ x: p.x, y: p.y })));
  left.canvas.dispatchEvent(pen('pointerup', 520, 330));

  const got = right.surface.layer.getAll().map(st => st.points.map(p => ({ x: p.x, y: p.y })));
  assert.equal(got.length, ghost.length);
  got.forEach((pts, i) => pts.forEach((p, j) => {
    assert.ok(near(p.x, ghost[i][j].x) && near(p.y, ghost[i][j].y),
      `第 ${i + 1} 笔第 ${j + 1} 点：预览在 (${ghost[i][j].x}, ${ghost[i][j].y})，` +
      `落在 (${p.x}, ${p.y})`);
  }));
});

await test('松手的坐标和最后一次移动不一样时，以松手为准', async () => {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  wire([left, right]);

  const a = line(left.surface, 100, 200);
  selectRect(left.surface, [a.id], 60, 150, 220, 280);
  left.canvas.dispatchEvent(pen('pointerdown', 140, 215));
  left.canvas.dispatchEvent(pen('pointermove', 600, 300));
  // 甩得快的时候，抬笔那一下还会再走一截。
  left.canvas.dispatchEvent(pen('pointerup', 610, 305));
  assert.deepEqual(heads(right.surface), [[170, 290]],
    '指尖在线头右下 (40,15)，抬笔在右边的 (210,305)：线头该在 (170,290)');
});

await test('两栏缩放、平移都不一样，抓着的那一点照样在指尖下', async () => {
  dom.window.document.body.innerHTML = '';
  const left = mount({ left: 0, top: 0, width: 400, height: 600 });
  const right = mount({ left: 400, top: 0, width: 400, height: 600 });
  left.surface.setTransform(0.5, 30, -40);
  right.surface.setTransform(1.5, 10, 20);
  wire([left, right]);

  // 线头 (100,200) 在左边屏幕上是 ((100-30)*0.5, (200+40)*0.5) = (35,120)。
  const a = line(left.surface, 100, 200, 40);
  selectRect(left.surface, [a.id], 60, 150, 220, 280);
  left.canvas.dispatchEvent(pen('pointerdown', 40, 125));   // 指尖在线头右下 (5,5)
  left.canvas.dispatchEvent(pen('pointermove', 300, 200));
  left.canvas.dispatchEvent(pen('pointermove', 600, 300));
  left.canvas.dispatchEvent(pen('pointerup', 600, 300));

  const got = right.surface.layer.getAll()[0];
  assert.ok(got, '先得落过去');
  // 线头该在屏幕 (595,295)，也就是右边画布的 (195,295)，换成右边的文档坐标。
  const head = got.points[0];
  assert.ok(near(head.x, 195 / 1.5 + 10) && near(head.y, 295 / 1.5 + 20),
    `线头落在 (${head.x.toFixed(2)}, ${head.y.toFixed(2)})，` +
    `该在 (${(195 / 1.5 + 10).toFixed(2)}, ${(295 / 1.5 + 20).toFixed(2)})`);
  // 屏幕上 20 宽（左边 40 × 0.5），右边 scale 1.5 → 文档里 13.33。
  const tail = got.points[got.points.length - 1];
  assert.ok(near((tail.x - head.x) * 1.5, 20), '屏幕上的长短也不该变');
  assert.ok(near(got.width, 2 * 0.5 / 1.5), '粗细按两边的缩放折算');
});

await test('落下来的选框框着落下来的那一片', async () => {
  const { right } = dragAcross();
  const loop = right.surface.selectionLoop;
  const xs = loop.map(p => p.x);
  const ys = loop.map(p => p.y);
  // 线在 (160..180, 285)，框四边各让出 6。
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)],
    [154, 186, 279, 291]);
});

await test('没带来处的老调用，退回「整片的中心摆到指尖下」', async () => {
  dom.window.document.body.innerHTML = '';
  const { surface } = mount({ left: 400, top: 0, width: 400, height: 600 });
  const src = createStroke({ tool: INK_TOOLS.PEN, color: '#000', width: 2 });
  appendPoint(src, 0, 0, 0.5, 0);
  appendPoint(src, 20, 10, 0.5, 0);
  const { serializeStroke } = await import('../src/ink/stroke.js');
  assert.ok(surface.adoptStrokes([serializeStroke(src)], 600, 300, 1));
  assert.deepEqual(centre(surface), [200, 300]);
});

// ═══════════════════════════════════════════════════════════════
group('8. 两块面板把把手原样传出去');

// 上面那些测试是直接把两块画布接在一起的，绕过了 PdfPane / ScratchPane。真机上
// 中间隔着这两层，而它们原先写的是 `onInkDragDrop?.(payload) === true` —— 把那一
// 组把手折成了布尔。折完之后源那边收到的是 true，配不上任何回调，撤销就又变回
// 「两边各留一份」。上面全绿、真机照错，所以这一条钉的是那行字本身。
const paneSources = [
  ['pdf-pane', readFileSync(new URL('../src/pdf/pdf-pane.js', import.meta.url), 'utf-8')],
  ['scratch-pane', readFileSync(new URL('../src/scratch/scratch-pane.js', import.meta.url), 'utf-8')],
];

for (const [name, src] of paneSources) {
  await test(`${name} 不把 onDragDrop 的结果折成布尔`, async () => {
    const wired = src.split(NEWLINE).find(l => l.includes('onDragDrop:'));
    assert.ok(wired, '这块面板没有把 onDragDrop 接出去');
    assert.ok(!wired.includes('=== true') && !wired.includes('!!'),
      `折成布尔之后，落地那一份就再也连不回源的撤销：${wired.trim()}`);
    assert.ok(wired.includes('onInkDragDrop'), '接的应该是工作区那个口子');
  });
}

await test('工作区回的是把手，不是布尔', async () => {
  const ws = readFileSync(new URL('../src/pdf/pdf-workspace.js', import.meta.url), 'utf-8');
  assert.ok(ws.includes('return landed;'),
    '_dropInkIntoOtherSlot 要把 adoptStrokes 给的那组把手交回去');
  assert.ok(!ws.includes('adoptStrokes(strokes, clientX, clientY) === true'),
    '同样不能折成布尔');
  assert.ok(ws.includes('adoptStrokes(strokes, clientX, clientY, scale, origin)'),
    '来处（origin）要交过去，不然落下来的那一片会跳到「中心在指尖下」');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
