#!/usr/bin/env node
// 套住一片字迹之后，能对它做的那几件事。
//
// 套索原来只能选和搬。选完想复制一份、换个颜色、或者干脆不要了，得先松开套索、
// 换工具、一点一点擦——而松开的那一刻选区就没了，等于从头再来。
//
// 这里钉四样：
//   1. 复制和粘贴出来的都是独立的一份（不是同一条笔画的第二个引用），而复制挪开
//      的是固定的屏幕距离——不然 600% 下两份差半页，50% 下两份几乎重叠。
//   2. 每件事都是一步撤销。复制十条要按十次才收得回来，等于没有撤销。
//   3. 剪贴板是两块画布共用的一份。那正是剪切的用处：从这一页剪下来，翻到另一页
//      再放下。各存各的话，剪切和「复制一份再删掉原来的」没有区别。
//   4. 那条小条只在「选区站住了」的时候露面：正在画的一圈不算，正在搬的一片人看
//      的是它落到哪儿。什么都没选、手里却捏着一片时，它只剩一个粘贴。

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event', 'PointerEvent',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}

const { InkSurface } = await import('../src/ink/ink-surface.js');
const { SELECTION_ACTIONS } = await import('../src/ink/ink-selection-bar.js');
const {
  INK_TOOLS, appendPoint, cloneStroke, createStroke,
} = await import('../src/ink/stroke.js');

/** jsdom 没有画布。这里要的不是画得对，是别在画的时候炸掉。 */
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

/** 一块装好的画布，外加它那条动作小条。 */
function mount({ width = 800, height = 600, scale = 1 } = {}) {
  document.body.innerHTML = '<div class="host"></div>';
  const host = document.querySelector('.host');
  const canvas = document.createElement('canvas');
  canvas.getContext = () => stubContext();
  host.appendChild(canvas);

  const changes = [];
  const surface = new InkSurface(canvas, { onChange: () => changes.push(1) });
  surface.resize(width, height, 1);
  surface.setTransform(scale, 0, 0);
  return { surface, host, changes };
}

/** 一条从 (x,y) 到 (x+len,y) 的直线。 */
function line(surface, x, y, len = 20) {
  const stroke = createStroke({ tool: INK_TOOLS.PEN, color: '#000', width: 2 });
  appendPoint(stroke, x, y, 0.5, 0);
  appendPoint(stroke, x + len, y, 0.5, 0);
  surface.layer.add(stroke);
  return stroke;
}

/** 把一圈方框当成套完的选区装上去。 */
function selectRect(surface, ids, x0, y0, x1, y1) {
  surface.selection = ids;
  surface.selectionLoop = [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
}

// ═══════════════════════════════════════════════════════════════
group('1. 复制出来的是独立的一份');

await test('新的 id，新的点，挪开了', async () => {
  const stroke = createStroke({ tool: INK_TOOLS.PEN, color: '#f00', width: 3 });
  appendPoint(stroke, 10, 10, 0.5, 0);
  appendPoint(stroke, 20, 30, 0.7, 0);
  const copy = cloneStroke(stroke, 5, 7);

  assert.notEqual(copy.id, stroke.id, '同一个 id 会让撤销和擦除把两条当成一条');
  assert.deepEqual(copy.points.map(p => [p.x, p.y]), [[15, 17], [25, 37]]);
  assert.equal(copy.points[1].p, 0.7, '压感照抄，不然复制出来的笔粗细会变');
  assert.equal(copy.color, '#f00');
  assert.ok(copy.bounds && copy.bounds.minX < copy.bounds.maxX, '边界重新算过');
});

await test('两份的点不是同一批对象', async () => {
  // 共用点对象的话，搬动其中一份会把另一份也搬走——而那是一次谁都看不懂的联动。
  const stroke = createStroke({ tool: INK_TOOLS.PEN });
  appendPoint(stroke, 0, 0, 0.5, 0);
  const copy = cloneStroke(stroke, 1, 1);
  copy.points[0].x = 999;
  assert.equal(stroke.points[0].x, 0);
});

// ═══════════════════════════════════════════════════════════════
group('2. 复制和删除');

await test('复制之后多出一份，而且选中的是新的那一份', async () => {
  const { surface, changes } = mount();
  const a = line(surface, 10, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);

  assert.equal(surface.duplicateSelection(), true);
  assert.equal(surface.layer.strokes.length, 2);
  assert.equal(surface.selection.length, 1);
  assert.notEqual(surface.selection[0], a.id,
    '接下来十有八九是把新的那一份拖走，那它就得是被选中的那个');
  assert.ok(changes.length >= 1, '多了东西就该存盘');
});

await test('套索线跟着新的那一份挪过去', async () => {
  const { surface } = mount();
  const a = line(surface, 10, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);
  const before = surface.selectionLoop.map(p => p.x);
  surface.duplicateSelection();
  const after = surface.selectionLoop.map(p => p.x);
  assert.ok(after.every((x, i) => x > before[i]),
    '线不跟过去的话，它圈的就还是原来那一份');
});

await test('挪开的是固定的屏幕距离，不是固定的文档距离', async () => {
  // 600% 下固定的文档距离会把两份分开半页；50% 下两份几乎重叠，看着像没反应。
  const one = mount({ scale: 1 });
  const a1 = line(one.surface, 0, 0);
  selectRect(one.surface, [a1.id], -5, -5, 25, 5);
  one.surface.duplicateSelection();
  const d1 = one.surface.layer.strokes[1].points[0].x - a1.points[0].x;

  const two = mount({ scale: 2 });
  const a2 = line(two.surface, 0, 0);
  selectRect(two.surface, [a2.id], -5, -5, 25, 5);
  two.surface.duplicateSelection();
  const d2 = two.surface.layer.strokes[1].points[0].x - a2.points[0].x;

  assert.ok(d1 > 0 && d2 > 0);
  assert.ok(Math.abs(d1 / 2 - d2) < 0.001,
    `放大一倍时文档里该只挪一半：${d1} 对 ${d2}`);
});

await test('复制十条是一步撤销，不是十步', async () => {
  const { surface } = mount();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(line(surface, i * 30, 10).id);
  selectRect(surface, ids, 0, 0, 400, 20);

  surface.duplicateSelection();
  assert.equal(surface.layer.strokes.length, 20);
  surface.history.undo();
  assert.equal(surface.layer.strokes.length, 10, '一次手势，一步撤销');
});

await test('删除拿得走，撤销拿得回来', async () => {
  const { surface, changes } = mount();
  const a = line(surface, 10, 10);
  const b = line(surface, 100, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);

  assert.equal(surface.deleteSelection(), true);
  assert.equal(surface.layer.strokes.length, 1);
  assert.equal(surface.layer.strokes[0].id, b.id, '只走圈住的那一条');
  assert.equal(surface.selection.length, 0, '删完选区也就没了');
  assert.ok(changes.length >= 1);

  surface.history.undo();
  assert.equal(surface.layer.strokes.length, 2);
});

await test('什么都没选的时候，两个动作都不做事', async () => {
  const { surface } = mount();
  line(surface, 10, 10);
  assert.equal(surface.duplicateSelection(), false);
  assert.equal(surface.deleteSelection(), false);
  assert.equal(surface.layer.strokes.length, 1);
});

await test('换一层就把选区丢掉', async () => {
  // 选区是一串 id 加一圈线，两样都只对上一层成立。翻页不清掉的话，那圈虚线会
  // 留在新的一页上，指着一批已经不在这里的笔画。
  const { surface } = mount();
  const a = line(surface, 10, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);
  surface.loadLayer(null);
  assert.equal(surface.selection.length, 0);
  assert.equal(surface.selectionLoop, null);
});

// ═══════════════════════════════════════════════════════════════
group('3. 那条小条摆在哪');

/** 让条报一个真实的尺寸——jsdom 里它永远是 0。 */
function sizeBar(surface, w = 160, h = 42) {
  const el = surface._bar.el;
  assert.ok(el, '条还没建出来');
  Object.defineProperty(el, 'offsetWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: h, configurable: true });
  return el;
}

const xyOf = (el) => {
  const m = (el.style.transform || '').match(/translate\((-?\d+)px, (-?\d+)px\)/);
  assert.ok(m, '条没有被摆到任何地方');
  return { x: Number(m[1]), y: Number(m[2]) };
};

await test('选完就露面，摆在选区下面、横着居中', async () => {
  const { surface } = mount({ width: 800, height: 600 });
  const a = line(surface, 100, 100);
  selectRect(surface, [a.id], 100, 100, 300, 200);
  surface.render();
  const el = sizeBar(surface);
  surface.render();

  assert.ok(el.classList.contains('is-visible'));
  const { x, y } = xyOf(el);
  assert.ok(y > 200, `该在选区下边(200)以下，实际 ${y}`);
  assert.ok(Math.abs((x + 160 / 2) - 200) <= 1, '横着对准选区中线');
});

await test('下面放不下就翻到上面，而不是压住刚圈出来的东西', async () => {
  const { surface } = mount({ width: 800, height: 600 });
  const a = line(surface, 100, 500);
  selectRect(surface, [a.id], 100, 500, 300, 580);
  surface.render();
  sizeBar(surface);
  surface.render();

  const { y } = xyOf(surface._bar.el);
  assert.ok(y + 42 <= 500, `该翻到选区上边(500)以上，实际 ${y}`);
});

await test('贴着边的选区，条不会跑到屏幕外面', async () => {
  const { surface } = mount({ width: 800, height: 600 });
  const a = line(surface, 0, 100);
  selectRect(surface, [a.id], 0, 100, 20, 150);
  surface.render();
  sizeBar(surface);
  surface.render();

  const { x } = xyOf(surface._bar.el);
  assert.ok(x >= 0, `不该是负的，实际 ${x}`);
});

await test('手还在动的时候不露面', async () => {
  const { surface } = mount();
  const a = line(surface, 100, 100);
  selectRect(surface, [a.id], 100, 100, 300, 200);
  surface.render();
  const el = sizeBar(surface);
  surface.render();
  assert.ok(el.classList.contains('is-visible'));

  // 正在搬这一片：人看的是它落到哪儿，不是旁边有什么按钮。
  surface._grab = { kind: 'move' };
  surface.render();
  assert.ok(!el.classList.contains('is-visible'));

  surface._grab = null;
  surface.render();
  assert.ok(el.classList.contains('is-visible'), '松开手它自己回来');
});

await test('清掉选区，条也跟着收', async () => {
  const { surface } = mount();
  const a = line(surface, 100, 100);
  selectRect(surface, [a.id], 100, 100, 300, 200);
  surface.render();
  const el = sizeBar(surface);
  surface.render();
  surface.clearSelection();
  assert.ok(!el.classList.contains('is-visible'));
});

await test('按钮认的是 pointerdown，不是 click', async () => {
  // 套索的手势挂在画布上，而画布就在这条底下。等到 click 的时候，pointerdown
  // 早就穿过去被当成「在选区外按了一下」，选区在按钮响应之前就已经没了。
  const src = await import('node:fs').then(fs => fs.readFileSync(
    new URL('../src/ink/ink-selection-bar.js', import.meta.url), 'utf-8'));
  assert.ok(/addEventListener\('pointerdown'/.test(src));
  assert.ok(!/addEventListener\('click'/.test(src));
  assert.ok(/stopPropagation/.test(src), '这一下不能再穿到画布上去');
});

await test('四个动作都在，删除排在最后并自己标出来', async () => {
  const { surface } = mount();
  const a = line(surface, 100, 100);
  selectRect(surface, [a.id], 100, 100, 300, 200);
  surface.render();
  const el = surface._bar.el;
  const actions = [...el.querySelectorAll('.ink-selection-row [data-action]')]
    .map(b => b.dataset.action);
  assert.deepEqual(actions, [
    SELECTION_ACTIONS.COPY, SELECTION_ACTIONS.CUT,
    SELECTION_ACTIONS.COLOR, SELECTION_ACTIONS.DELETE,
  ], '删除排在最后——手指是从左往右够的，不可撤销的那个不该在半路上');
  assert.ok(el.querySelector('.ink-selection-btn.is-danger'));
});

await test('点复制就复制，点删除就删除', async () => {
  const { surface } = mount();
  const a = line(surface, 100, 100);
  selectRect(surface, [a.id], 100, 100, 300, 200);
  surface.render();
  const el = surface._bar.el;
  const press = (action) => el.querySelector(`[data-action="${action}"]`)
    .dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));

  press(SELECTION_ACTIONS.COPY);
  assert.equal(surface.layer.strokes.length, 2);
  press(SELECTION_ACTIONS.DELETE);
  assert.equal(surface.layer.strokes.length, 1, '删掉的是复制出来的那一份');
  assert.equal(surface.layer.strokes[0].id, a.id);
});


// ═══════════════════════════════════════════════════════════════
group('4. 剪切、粘贴、换色');

const { clearClipboard, clipboardHasInk } = await import('../src/ink/ink-clipboard.js');

await test('剪切拿走，剪贴板里就有了', async () => {
  clearClipboard();
  const { surface } = mount();
  const a = line(surface, 10, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);

  assert.equal(surface.cutSelection(), true);
  assert.equal(surface.layer.strokes.length, 0, '原处不留');
  assert.equal(clipboardHasInk(), true);
  assert.equal(surface.selection.length, 0);
});

await test('粘贴回来的是新的一份，不是同一条的第二个引用', async () => {
  clearClipboard();
  const { surface } = mount();
  const a = line(surface, 10, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);
  surface.cutSelection();

  assert.equal(surface.pasteClipboard(), true);
  assert.equal(surface.layer.strokes.length, 1);
  assert.notEqual(surface.layer.strokes[0].id, a.id, '新的号，不然撤销会认错人');

  // 再粘一次：两片互不相干。
  surface.pasteClipboard();
  assert.equal(surface.layer.strokes.length, 2);
  assert.notEqual(surface.layer.strokes[0].id, surface.layer.strokes[1].id);
  surface.layer.strokes[0].points[0].x = 999;
  assert.notEqual(surface.layer.strokes[1].points[0].x, 999, '点也不能是同一批对象');
});

await test('剪贴板是两块画布共用的一份——那正是剪切的用处', async () => {
  // 从这一页剪下来，翻到另一页、换到另一栏再放下。每块画布各存一份的话，剪切
  // 就只能在它自己那一页里打转，和「复制一份再删掉原来的」没有区别。
  clearClipboard();
  const one = mount();
  const two = mount();
  const a = line(one.surface, 10, 10);
  selectRect(one.surface, [a.id], 0, 0, 40, 20);
  one.surface.cutSelection();

  assert.equal(two.surface.pasteClipboard(), true);
  assert.equal(two.surface.layer.strokes.length, 1);
});

await test('粘贴完是选中的，接着拖就行', async () => {
  clearClipboard();
  const { surface } = mount();
  const a = line(surface, 10, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);
  surface.cutSelection();
  surface.pasteClipboard();

  assert.equal(surface.selection.length, 1);
  assert.equal(surface.selection[0], surface.layer.strokes[0].id);
  assert.ok(surface.selectionLoop && surface.selectionLoop.length >= 3, '套索线也圈好了');
});

await test('粘贴落在看得见的那块地方中间', async () => {
  clearClipboard();
  const { surface } = mount({ width: 800, height: 600 });
  const a = line(surface, 0, 0, 20);
  selectRect(surface, [a.id], -5, -5, 25, 5);
  surface.cutSelection();
  surface.pasteClipboard();

  const b = surface.layer.strokes[0].bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  assert.ok(Math.abs(cx - 400) < 2, `横着该在 400 附近，实际 ${cx}`);
  assert.ok(Math.abs(cy - 300) < 2, `竖着该在 300 附近，实际 ${cy}`);
});

await test('剪贴板空着的时候，粘贴什么也不做', async () => {
  clearClipboard();
  const { surface } = mount();
  assert.equal(surface.pasteClipboard(), false);
  assert.equal(surface.layer.strokes.length, 0);
});

await test('换色只动圈住的那些，撤销各还各的', async () => {
  const { surface } = mount();
  const a = line(surface, 10, 10);
  const b = line(surface, 100, 10);
  a.color = '#111111';
  b.color = '#222222';
  const c = line(surface, 200, 10);
  c.color = '#333333';
  selectRect(surface, [a.id, b.id], 0, 0, 140, 20);

  assert.equal(surface.recolorSelection('#ff0000'), true);
  assert.equal(a.color, '#ff0000');
  assert.equal(b.color, '#ff0000');
  assert.equal(c.color, '#333333', '没圈住的不动');

  surface.history.undo();
  assert.equal(a.color, '#111111', '一片里本来就可能有好几种色，各还各的');
  assert.equal(b.color, '#222222');

  surface.history.redo();
  assert.equal(a.color, '#ff0000');
  assert.equal(b.color, '#ff0000');
});

await test('换成同一个颜色不记一步', async () => {
  const { surface } = mount();
  const a = line(surface, 10, 10);
  a.color = '#ff0000';
  selectRect(surface, [a.id], 0, 0, 40, 20);
  assert.equal(surface.recolorSelection('#ff0000'), false);
  assert.equal(surface.history.canUndo(), false, '什么都没变就不该占一步撤销');
});

await test('换色那排收着，点了颜色才展开', async () => {
  const { surface } = mount();
  surface.setSwatches(['#111111', '#ff0000', '#2563eb']);
  const a = line(surface, 100, 100);
  selectRect(surface, [a.id], 100, 100, 300, 200);
  surface.render();

  const el = surface._bar.el;
  const palette = el.querySelector('.ink-selection-palette');
  assert.ok(palette, '色排得在');
  assert.equal(palette.querySelectorAll('.ink-selection-dot').length, 3,
    '用的是工具栏那排色，不另立一套');
  assert.equal(palette.hidden, true, '一上来是收着的——四个动作再加六个色点就比选区还大了');

  const press = (node) => node.dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  press(el.querySelector('[data-action="color"]'));
  assert.equal(palette.hidden, false);

  press(palette.querySelector('.ink-selection-dot[data-color="#ff0000"]'));
  assert.equal(a.color, '#ff0000');
  assert.equal(palette.hidden, true, '选完就收');
});

await test('什么都没选、手里却捏着一片时，条上只剩粘贴', async () => {
  clearClipboard();
  const { surface } = mount();
  const a = line(surface, 10, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);
  surface.setTool('lasso');
  surface.cutSelection();
  surface.render();

  const el = surface._bar.el;
  assert.ok(el.classList.contains('is-visible'), '剪下来放不下去的剪切，和删除没区别');
  const actions = [...el.querySelectorAll('[data-action]')].map(b => b.dataset.action);
  assert.deepEqual(actions, [SELECTION_ACTIONS.PASTE]);
});

await test('不是套索工具的时候，那个粘贴不出来', async () => {
  // 这一条原来在 setTool 之后补了一句 render()，于是它测的是「重画之后对不对」。
  // 真机上换工具**不会**重画：剪完切到笔，那个粘贴按钮就一直浮在页面上——两栏
  // 都浮着，而人正准备写字。真机上撞到的就是这个，所以这里不再替它重画。
  clearClipboard();
  const { surface } = mount();
  const a = line(surface, 10, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);
  surface.setTool('lasso');
  surface.cutSelection();
  assert.ok(surface._bar.el?.classList.contains('is-visible'), '剪完先有个粘贴');

  surface.setTool('pen');
  assert.ok(!surface._bar.el?.classList.contains('is-visible'),
    '换了工具就该收——而且不靠调用方补一次重画');
});

await test('换成橡皮也一样收', async () => {
  clearClipboard();
  const { surface } = mount();
  const a = line(surface, 10, 10);
  selectRect(surface, [a.id], 0, 0, 40, 20);
  surface.setTool('lasso');
  surface.cutSelection();
  surface.setTool('eraser');
  assert.ok(!surface._bar.el?.classList.contains('is-visible'));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(failed ? 1 : 0);
