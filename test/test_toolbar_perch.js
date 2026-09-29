#!/usr/bin/env node
// 工具栏停进顶上那一排；工具、颜色上能划着挑（原来是左边那枚胶囊能划）；切页时那几枚胶囊收拢。
//
// 顶上那一排是四样东西：左边那枚胶囊（导入、文档库、组合、新建纸张）、正中「练习 /
// 设置」、右边「全部关闭」，以及可以拖进去停着的工具栏。这里钉：
//
//   1. 量和挤（src/pdf/top-row-dock.js 里那几个纯函数）：两处空当在哪、球停哪儿、
//      点开之后横杠有多宽、标签被推多少——只在碰上的时候推，一个像素都不多推；
//   2. 工具栏那一侧（src/ink/ink-toolbar.js）：拖进去收成球、点开、点把手收回、拖出
//      去让标签回家、自动收起、开机恢复、专注模式请出去再请回来、那一排收起时借住到
//      左边再回来；
//   3. 状态（toolbar-state.js）：停哪儿只是一个字段，别的都不动；
//   4. 划着挑：搬到了工具栏的工具、颜色上（左边那枚胶囊不再划）——点照旧是点；顺着横杠划，一块
//      玻璃浮在横杠上面跟着手指，松手拿底下那一格；划出去老远、系统收走手势算反悔；
//   5. 切页：左右两枚胶囊往正中收、回来时长出来，都不碰 transform。

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
const $read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf-8');
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'localStorage', 'PointerEvent', 'Event', 'MutationObserver',
  'getComputedStyle', 'HTMLElement', 'Element']) {
  if (dom.window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
// 这里的动画一律当场演完：测的是摆到哪儿，不是怎么过去。
globalThis.requestAnimationFrame = undefined;
globalThis.cancelAnimationFrame = undefined;
dom.window.Element.prototype.setPointerCapture = function () {};
dom.window.Element.prototype.releasePointerCapture = function () {};
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const dockMod = await import('../src/pdf/top-row-dock.js');
const {
  perchGaps, ballBox, ballTrack, ballAt, rowSideFor, rowFraction, springStep,
  solvePerch, pushFor, cubicBezier, SPRING_EASE, initTopRowDock,
} = dockMod;
const stateMod = await import('../src/ink/toolbar-state.js');
const { InkToolbar } = await import('../src/ink/ink-toolbar.js');

/** 1200×736 的平板上，这一排三枚胶囊在家的位置（液态玻璃皮肤）。 */
const R = (left, right, top = 10, bottom = 54) => ({ left, right, top, bottom, width: right - left, height: bottom - top });
const ROW = {
  lead: R(10, 376),
  nav: R(514, 686),
  end: R(1077, 1190),
  row: { left: 10, right: 1190, top: 10, bottom: 54 },
};

// ═══════════════════════════════════════════════════════════════
group('1. 量和挤');

await test('两处空当：两个标签左右各一处，各让出一道 12px 的缝', () => {
  const g = perchGaps(ROW);
  assert.deepEqual(g.left, { left: 388, right: 502 });
  assert.deepEqual(g.right, { left: 698, right: 1065 });
});

await test('球能走的那一段：标签能被推到贴住另一边那枚为止，贴边的两枚不动', () => {
  // 左边那一侧：376 + 12 = 388 起；右界 = 1077 - 12 - 172 - 12 - 44 = 837。
  assert.deepEqual(ballTrack('left', ROW), { lo: 388, hi: 837 });
  // 右边那一侧：376 + 12 + 172 + 12 = 572 起；右界 = 1077 - 12 - 44 = 1021。
  assert.deepEqual(ballTrack('right', ROW), { lo: 572, hi: 1021 });
  // 挤得连一颗球都放不下（标签推到头也不行）：null。
  const jammed = { ...ROW, lead: R(10, 480), end: R(730, 1190) };
  assert.equal(ballTrack('left', jammed), null);
  assert.equal(ballTrack('right', jammed), null);
  assert.equal(rowSideFor(600, jammed), null);
});

await test('收着的球也推：贴上标签才推，推多少是多少；推到标签贴住「全部关闭」，球就过不去了', () => {
  const free = ballAt('left', 440, ROW);
  assert.equal(free.left, 418, '停在松手的地方，不是空当正中');
  assert.equal(pushFor('left', ROW, { left: free.left, right: free.right }).navShift, 0, '没碰上，不动');
  const touching = ballAt('left', 490, ROW);   // 右沿 512，加一道缝 524，标签在 514
  assert.equal(pushFor('left', ROW, { left: touching.left, right: touching.right }).navShift, 10);
  const far = ballAt('left', 5000, ROW);
  assert.equal(far.left, 837, '推到头了');
  const push = pushFor('left', ROW, { left: far.left, right: far.right });
  assert.equal(686 + push.navShift, 1077 - 12, '标签和「全部关闭」之间只剩一道缝');
  // 反过来一样：右边那一侧往左推，推到标签贴住左边那枚。
  const farR = ballAt('right', -5000, ROW);
  assert.equal(farR.left, 572);
  assert.equal(514 + pushFor('right', ROW, { left: farR.left, right: farR.right }).navShift, 376 + 12);
});

await test('在标签哪一侧：刚进来看手指在它正中哪边；推着走不换边；推到头、手指越过它此刻的正中才翻过去', () => {
  assert.equal(rowSideFor(430, ROW), 'left');
  assert.equal(rowSideFor(700, ROW), 'right');
  // 左边那一侧推到头：标签被推开 379，此刻的正中在 979。
  assert.equal(rowSideFor(900, ROW, 'left', 379), 'left', '手指还在标签正中左边');
  assert.equal(rowSideFor(990, ROW, 'left', 379), 'right', '越过了才翻');
  // 右边那一侧推到头：标签被推开 -126，此刻的正中在 474。
  assert.equal(rowSideFor(500, ROW, 'right', -126), 'right');
  assert.equal(rowSideFor(460, ROW, 'right', -126), 'left');
});

await test('停在哪儿按这一排里的比例记：窗口变了还在差不多的地方；老存档没有这个数，停在空当正中', () => {
  const b = ballBox('right', ROW, 44, 12, 0.75);   // 球心 10 + 0.75 × 1180 = 895
  assert.equal(b.left, 873);
  assert.ok(near(rowFraction(895, ROW), 0.75));
  const legacy = ballBox('right', ROW);
  assert.ok(near((legacy.left + legacy.right) / 2, (698 + 1065) / 2));
});

await test('吃掉跳变的弹簧：临界阻尼——一路收过去，不越过、不回弹', () => {
  let x = 100;
  let v = 0;
  let min = Infinity;
  for (let i = 0; i < 30; i++) {
    [x, v] = springStep(x, v, 1 / 60);
    min = Math.min(min, x);
  }
  assert.ok(x < 1, `半秒之后差不多到了：${x}`);
  assert.ok(min >= 0, '没越过目标');
});

await test('球停在那处空当的正中，和这一排一样高、竖着对齐', () => {
  const b = ballBox('right', ROW);
  assert.equal(b.width, 44);
  assert.equal(b.height, 44);
  assert.ok(near((b.left + b.right) / 2, (698 + 1065) / 2));
  assert.equal(b.top, 10);
});

await test('点开：要多宽给多宽；挤到极限还不够就给到能给的——标签能挪、贴边的两枚不能', () => {
  // 右边那处：左界 = 左边那枚 + 缝 + 标签 + 缝 = 376+12+172+12 = 572；右界 = 1190-113-12 = 1065。
  const got = solvePerch('right', ROW, { preferred: 503, min: 330, center: 881.5 });
  assert.equal(got.left, 572);
  assert.equal(got.width, 493, '只有 493，要 503 也只能给 493');
  const roomy = solvePerch('right', ROW, { preferred: 300, min: 200, center: 881.5 });
  assert.ok(near(roomy.left, 731.5), '放得下就以球为中心');
});

await test('靠着贴边的那一枚长不过去，就往另一边多长一点', () => {
  // 球紧挨着「全部关闭」：以它为中心放不下，整条往左让。
  const got = solvePerch('right', ROW, { preferred: 400, min: 200, center: 1040 });
  assert.equal(got.right, 1065);
  assert.equal(got.left, 665);
});

await test('左边那处：左边那枚后面一道缝起，右界要给标签和「全部关闭」都留出地方', () => {
  // 右界 = 1190 - 113 - 12 - 172 - 12 = 881；要 503，只给得出 881 - 388 = 493。
  const got = solvePerch('left', ROW, { preferred: 503, min: 330, center: 445 });
  assert.equal(got.left, 388);
  assert.equal(got.right, 881);
  assert.equal(got.width, 493);
});

await test('连最窄也放不下：null（这时它挂到这一排下面去，不推谁）', () => {
  // 左界 450+12+172+12 = 646，右界 1190-240-12 = 938：只剩 292，最窄也要 330。
  const tight = { ...ROW, lead: R(10, 450), end: R(950, 1190) };
  assert.equal(solvePerch('right', tight, { preferred: 503, min: 330, center: 900 }), null);
});

await test('只在碰上的时候推：横杠的边还没到，标签一动不动', () => {
  const ball = ballBox('right', ROW);
  const idle = pushFor('right', ROW, { left: ball.left, right: ball.right });
  assert.equal(idle.navShift, 0);
  // 横杠左边正好离标签一道缝：刚好挨上，还不推。
  assert.equal(pushFor('right', ROW, { left: 698, right: 1000 }).navShift, 0);
  // 再往左 30px，标签就被推开 30px——一个像素都不多。
  assert.equal(pushFor('right', ROW, { left: 668, right: 1000 }).navShift, -30);
});

await test('横杠一路长开的每一帧，标签都紧挨着它的边，不叠、也不留多余的缝', () => {
  const ball = ballBox('right', ROW);
  const final = solvePerch('right', ROW, { preferred: 503, min: 330, center: (ball.left + ball.right) / 2 });
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const e = SPRING_EASE(t);
    const edges = {
      left: ball.left + (final.left - ball.left) * e,
      right: ball.right + (final.right - ball.right) * e,
    };
    const { navShift } = pushFor('right', ROW, edges);
    const navRight = ROW.nav.right + navShift;
    assert.ok(navRight <= edges.left - 12 + 1e-6, `t=${t.toFixed(2)}：标签压到横杠上了`);
    if (navShift < 0) assert.ok(near(navRight, edges.left - 12), `t=${t.toFixed(2)}：被推开的时候要紧挨着`);
    // 标签不会被推到左边那枚身上。
    assert.ok(ROW.nav.left + navShift >= ROW.lead.right + 12 - 1e-6, `t=${t.toFixed(2)}`);
  }
});

await test('左边那处点开：标签往右被推；状态字那一格只剩「全部关闭」那么宽也不会被压住', () => {
  // 用解出来的那两条边（388–881）：标签被推到它右边一道缝，正好贴着「全部关闭」前那道缝。
  const push = pushFor('left', ROW, { left: 388, right: 881 });
  assert.equal(push.navShift, 881 + 12 - 514);
  assert.equal(push.trailMax, 1190 - (686 + push.navShift + 12));
  assert.ok(push.trailMax >= 113, '全部关闭那一枚本身放得下');
});

await test('曲线是那条弹簧（0.32, 0.72, 0, 1）：两头对、单调、前快后慢', () => {
  const ease = cubicBezier(0.32, 0.72, 0, 1);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  let last = 0;
  for (let t = 0.02; t <= 1; t += 0.02) {
    const v = ease(t);
    assert.ok(v >= last - 1e-9, '不许往回走');
    last = v;
  }
  assert.ok(ease(0.3) > 0.7, '前三成的时间走掉大半路');
});

// ═══════════════════════════════════════════════════════════════
group('2. 这一排那一层：量「在家」的位置，推标签、收状态字');

function dockPage() {
  document.body.className = '';
  document.body.dataset.page = 'pdf';
  document.body.innerHTML = `
    <nav class="app-nav"><button>练习</button><button>设置</button></nav>
    <div id="page-pdf">
      <div class="pdf-page-bar">
        <div class="pdf-bar-group"></div>
        <span class="pdf-bar-nav-slot"></span>
        <div class="pdf-bar-trail"><span class="pdf-status">正在打开…</span><div class="pdf-bar-group is-end"></div></div>
      </div>
    </div>`;
  const q = (s) => document.querySelector(s);
  const rects = new Map([
    [q('.pdf-page-bar'), R(10, 1190)],
    [q('.pdf-page-bar > .pdf-bar-group'), R(10, 376)],
    [q('.app-nav'), R(514, 686)],
    [q('.pdf-bar-group.is-end'), R(1077, 1190)],
  ]);
  const dock = initTopRowDock(q('#page-pdf'), { measure: (el) => rects.get(el) || R(0, 0, 0, 0) });
  return { dock, nav: q('.app-nav'), trail: q('.pdf-bar-trail') };
}

await test('停着的球：标签在家，状态字那一格让出球的位置', () => {
  const { dock, nav, trail } = dockPage();
  const b = dock.ballBox('right');
  dock.settle('right', { left: b.left, right: b.right });
  assert.equal(nav.style.translate, '');
  assert.equal(trail.style.maxWidth, `${Math.floor(1190 - (b.right + 12))}px`);
  dock.destroy();
});

await test('点开到位：标签被推到横杠左边一道缝的地方，拿走之后回家', () => {
  const { dock, nav } = dockPage();
  dock.settle('right', { left: 572, right: 1065 });
  assert.equal(nav.style.translate, `${572 - 12 - 686}px 0`);
  dock.release({ animate: false });
  assert.equal(nav.style.translate, '');
  dock.destroy();
});

await test('点开那一段演完：横杠不再被切，邻居停在终点', () => {
  const { dock, nav } = dockPage();
  const root = document.createElement('div');
  let done = 0;
  const ball = dock.ballBox('right');
  dock.play({
    perch: 'right', root,
    box: { left: 572, right: 1065, top: 10, bottom: 54, width: 493, height: 44 },
    from: { left: ball.left, right: ball.right }, to: { left: 572, right: 1065 },
    fromHeight: 44, toHeight: 44, duration: 460, onDone: () => { done++; },
  });
  assert.equal(done, 1);
  assert.equal(root.style.clipPath, '');
  assert.equal(nav.style.translate, `${572 - 12 - 686}px 0`);
  dock.destroy();
});

await test('拖着经过这一排：靠近顶上（到栏头那一带）才算；收起了、在设置页上、专注着都不算', () => {
  const { dock } = dockPage();
  assert.equal(dock.zoneAt(900, 30), 'right');
  assert.equal(dock.zoneAt(430, 30), 'left');
  assert.equal(dock.zoneAt(430, 140), 'left', '栏头那一带也接得住：靠近顶上就吸进去');
  assert.equal(dock.zoneAt(900, 200), null, '工作区里是工作区');
  document.body.classList.add('is-top-hidden');
  assert.equal(dock.zoneAt(900, 30), null);
  document.body.classList.remove('is-top-hidden');
  document.body.dataset.page = 'settings';
  assert.equal(dock.zoneAt(900, 30), null);
  document.body.dataset.page = 'pdf';
  document.body.classList.add('is-scratch-focus');
  assert.equal(dock.zoneAt(900, 30), null);
  dock.destroy();
});

await test('拖着球在这一排里走：贴着这一排、推着标签走；推到头手指越过标签正中，就翻到另一边，标签回家', () => {
  const { dock, nav } = dockPage();
  const root = document.createElement('div');
  const s = dock.beginDrag(root, {});
  s.start(430, 300);
  assert.equal(s.inRow, false, '工作区中间：跟着手指');
  assert.equal(root.style.top, '300px');
  s.move(430, 120);
  assert.equal(s.inRow, true, '靠近顶上：被这一排接住');
  assert.equal(root.style.top, '32px', '贴着这一排，竖着居中');
  assert.equal(root.style.left, '430px');
  s.move(560, 110);   // 球右沿 582，加一道缝 594，标签在 514：推 80
  assert.equal(nav.style.translate, '80px 0');
  s.move(950, 40);   // 手指越过了球能到的地方，但还没越过标签（它此刻的正中在 979）
  assert.equal(root.style.left, `${837 + 22}px`, '推到头，球停住');
  assert.equal(nav.style.translate, '379px 0');
  s.move(1000, 40);   // 越过了被推到头的标签此刻的正中（979）
  assert.equal(s.side, 'right');
  assert.equal(nav.style.translate, '', '球翻过去了，标签不再被顶着，回家');
  const land = s.end();
  assert.equal(land.perch, 'right');
  assert.ok(near(land.at, (1000 - 10) / 1180));
  dock.destroy();
});

await test('拖出这一排再松手：标签回家；拖着的时候书架开着、那一排收着，都不接', () => {
  const { dock, nav } = dockPage();
  const root = document.createElement('div');
  const s = dock.beginDrag(root, {});
  s.start(560, 40);
  assert.equal(nav.style.translate, '80px 0');
  s.move(560, 400);
  assert.equal(s.inRow, false);
  assert.equal(nav.style.translate, '');
  assert.equal(s.end(), null);
  document.body.classList.add('is-library-open');
  const s2 = dock.beginDrag(root, {});
  s2.start(560, 40);
  assert.equal(s2.inRow, false);
  s2.end();
  document.body.classList.remove('is-library-open');
  dock.destroy();
});

await test('往上收起、拉回来：当场告诉横杠（{ away }）；这一排走到哪儿了按标签此刻画在哪儿算', async () => {
  const { dock, nav } = dockPage();
  const heard = [];
  dock.onChange((info) => { if (info && 'away' in info) heard.push(info.away); });
  assert.equal(dock.away(), false);
  document.body.classList.add('is-top-hidden');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(heard, [true]);
  assert.equal(dock.away(), true);
  // 在家时下沿 54：整个收走要走 54。标签此刻画在 10 - 27 = -17：走了一半。
  assert.equal(dock.travel(), 54);
  nav.getBoundingClientRect = () => ({ left: 514, right: 686, top: -17, bottom: 27, width: 172, height: 44 });
  assert.ok(near(dock.progress(), 0.5));
  document.body.classList.remove('is-top-hidden');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(heard, [true, false]);
  dock.destroy();
});

// ═══════════════════════════════════════════════════════════════
group('3. 工具栏那一侧');

const HOST_RECT = { left: 0, top: 64, right: 1200, bottom: 736, width: 1200, height: 672, x: 0, y: 64 };

/** 一个假的「顶上那一排」：记下工具栏都问了它什么、叫它演了什么。 */
function fakeRow() {
  const calls = { play: [], release: [], preview: [], settle: [], begin: [] };
  let listener = null;
  const ballAtX = (cx) => ({ left: cx - 22, top: 10, width: 44, height: 44, right: cx + 22, bottom: 54 });
  const host = {
    calls,
    ok: true,
    /** 往上收起来了没有（真的那一排看 body 上的 is-top-hidden）。 */
    isAway: false,
    available: () => host.ok,
    away: () => host.isAway,
    travel: () => 54,
    progress: () => (host.isAway ? 1 : 0),
    zoneAt: (x, y) => (host.ok && y < 150 ? (x < 600 ? 'left' : 'right') : null),
    spotFor: (x) => (host.ok ? { perch: x < 600 ? 'left' : 'right', at: (x - 10) / 1180 } : null),
    ballBox: (perch, size, at) => (Number.isFinite(at) ? ballAtX(10 + at * 1180)
      : perch === 'left'
        ? { left: 423, top: 10, width: 44, height: 44, right: 467, bottom: 54 }
        : { left: 859.5, top: 10, width: 44, height: 44, right: 903.5, bottom: 54 }),
    /** 和真的那一路一样：在顶上附近贴着那一排走，出去了跟着手指；松手时在那一排里就回答停哪儿。 */
    beginDrag: (root, opts = {}) => {
      calls.begin.push(opts);
      let x = 0;
      let inRow = false;
      let side = null;
      let live = false;
      return {
        get inRow() { return inRow; },
        get side() { return side; },
        get live() { return live; },
        start(px, py) { live = true; this.move(px, py); },
        move(px, py) {
          x = px;
          inRow = host.ok && py < 150;
          side = inRow ? (px < 600 ? 'left' : 'right') : null;
          root.style.left = `${px}px`;
          root.style.top = `${inRow ? 32 : py}px`;
        },
        end() {
          live = false;
          if (!inRow) { host.release({ animate: true }); return null; }
          return { perch: side, at: (x - 10) / 1180 };
        },
        cancel() { live = false; },
      };
    },
    layout: (perch) => (perch === 'left'
      ? { left: 388, top: 10, width: 490, height: 44, scale: 0.94, inRow: true }
      : { left: 574, top: 10, width: 490, height: 44, scale: 0.94, inRow: true }),
    settle: (perch, edges) => calls.settle.push({ perch, edges }),
    play: (o) => { calls.play.push(o); o.onDone?.(); },
    release: (o) => calls.release.push(o),
    preview: (z) => calls.preview.push(z),
    onChange: (fn) => { listener = fn; return () => { listener = null; }; },
    fire: (info) => listener?.(info),
  };
  return host;
}

let mounted = null;
function mount({ saved = null, away = false } = {}) {
  dom.window.localStorage.clear();
  if (saved) dom.window.localStorage.setItem('ls_ink_toolbar', JSON.stringify(saved));
  if (mounted) { try { mounted.destroy(); } catch (_) { /* gone */ } }
  document.body.className = '';
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ ...HOST_RECT });
  Object.defineProperty(host, 'clientWidth', { value: 1200, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: 672, configurable: true });
  document.body.appendChild(host);
  const bar = new InkToolbar(host, { getSurface: () => null });
  // jsdom 没有排版，量不出宽高：给一个平板上量到的样子。
  bar._perchModel = () => ({ key: 'x', wFixed: 10, wPer: 510, hFixed: 10, hPer: 36 });
  const row = fakeRow();
  row.isAway = away;
  bar.setPerchHost(row);
  mounted = bar;
  return { bar, row, host };
}

function pointer(type, { x = 0, y = 0, id = 1, target } = {}) {
  const ev = new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: id, clientX: x, clientY: y,
    button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
  (target || dom.window).dispatchEvent(ev);
}

/** 按住工具栏的把手（或那颗球），拖到 (x, y) 松手。坐标是视口的。 */
function dragTo(bar, x, y) {
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 20, y: 200, target: handle });
  pointer('pointermove', { x: (20 + x) / 2, y: (200 + y) / 2 });
  pointer('pointermove', { x, y });
  pointer('pointerup', { x, y });
}

function tap(bar) {
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 30, y: 30, id: 2, target: handle });
  pointer('pointerup', { x: 30, y: 30, id: 2 });
}

await test('拖到这一排附近：被它接住，松手收成球，就停在松手的地方，记下来', () => {
  const { bar, row } = mount();
  dragTo(bar, 880, 30);
  assert.equal(row.calls.begin.length, 1, '拿起来那一刻就交给那一排摆');
  assert.equal(bar.state.perch, 'right');
  assert.equal(bar.state.phase, 'docked');
  assert.equal(bar.state.corner, null);
  assert.ok(near(bar.state.perchX, (880 - 10) / 1180));
  assert.ok(bar.root.classList.contains('is-perched'));
  assert.equal(bar.root.style.position, 'fixed');
  assert.equal(bar.root.style.left, '858px', '松在 880，球心就在 880');
  assert.equal(bar.root.style.top, '10px');
  const saved = JSON.parse(dom.window.localStorage.getItem('ls_ink_toolbar'));
  assert.equal(saved.perch, 'right');
  assert.ok(near(saved.perchX, (880 - 10) / 1180));
});

await test('拖在手里的那颗球用视口坐标：飞出工作区（它是 overflow: hidden 的）也看得见；到了顶上贴着那一排走', () => {
  const { bar } = mount();
  const handle = bar.root.querySelector('[data-role="handle"]');
  pointer('pointerdown', { x: 20, y: 200, target: handle });
  pointer('pointermove', { x: 700, y: 30 });
  assert.equal(bar.root.style.position, 'fixed');
  assert.equal(bar.root.style.top, '32px', '被那一排接住：竖着居中在那一排里，不跟着手指上下');
  pointer('pointerup', { x: 700, y: 30 });
});

await test('松在离顶上近、却还没到那一排的地方：不在栏头底下横着展开，飞进那一排', () => {
  const { bar } = mount();
  dragTo(bar, 600, 64 + 170);   // 工作区里 y = 170：离顶边最近
  assert.equal(bar.state.perch, 'right');
  assert.equal(bar.state.phase, 'docked');
  assert.ok(near(bar.state.perchX, (600 - 10) / 1180));
});

await test('老存档里横着贴在工作区顶边的：一接上那一排就挪进去，收成球', () => {
  const { bar } = mount({ saved: { edge: 'top', offset: 0.3 } });
  assert.equal(bar.state.perch, 'left');
  assert.equal(bar.state.phase, 'docked');
  assert.ok(near(bar.state.perchX, (360 - 10) / 1180));
});

await test('点那颗球：就地长开，从球的两条边演到点开之后的两条边', () => {
  const { bar, row } = mount({ saved: { perch: 'right' } });
  assert.equal(bar.state.phase, 'docked', '开机时停在那一排里的，一律是收着的球');
  tap(bar);
  assert.equal(bar.state.phase, 'expanded');
  assert.equal(bar.state.perch, 'right');
  const play = row.calls.play.at(-1);
  assert.ok(play, '要演，不是一下子出现');
  assert.equal(play.opening, true);
  assert.deepEqual(play.to, { left: 574, right: 1064 });
  assert.equal(play.box.width, 490);
  assert.equal(bar.root.dataset.orientation, 'horizontal', '在那一排里永远横躺');
  assert.equal(bar.root.style.left, '574px');
  assert.equal(bar.root.style.getPropertyValue('--ink-scale'), '0.94');
});

await test('点开着的时候点一下把手：收回那颗球，也是演的', () => {
  const { bar, row } = mount({ saved: { perch: 'right' } });
  tap(bar);
  tap(bar);
  const play = row.calls.play.at(-1);
  assert.equal(play.opening, false);
  assert.deepEqual(play.to, { left: 859.5, right: 903.5 });
  assert.equal(bar.state.phase, 'docked');
  assert.equal(bar.state.perch, 'right');
});

await test('点开着的时候拖把手：拿起来交给那一排摆，拖到工作区里松手，标签一段一段回家', () => {
  const { bar, row } = mount({ saved: { perch: 'right' } });
  tap(bar);
  dragTo(bar, 840, 450);   // 工作区的下半截：离底边最近
  assert.deepEqual(row.calls.release.at(-1), { animate: true });
  assert.equal(bar.state.perch, null);
  assert.ok(!bar.root.classList.contains('is-perched'));
  assert.equal(bar.root.style.position, '', '回到工作区里，照工作区的边摆');
});

await test('开着「自动收起」时一落笔：收回那一排里的球，不飞到工作区的角上', () => {
  const { bar } = mount({ saved: { perch: 'left', autoMinimize: true } });
  tap(bar);
  bar.minimizeOnDraw();
  assert.equal(bar.state.phase, 'docked');
  assert.equal(bar.state.perch, 'left');
  assert.equal(bar.state.corner, null);
});

await test('停在那一排里的不给面板让位：它压不着工作区里的任何东西', () => {
  const { bar } = mount({ saved: { perch: 'right' } });
  tap(bar);
  bar.yieldTo(['bottom-left']);
  assert.equal(bar.isYielded(), false);
  assert.equal(bar.state.phase, 'expanded');
});

await test('书架关了、从设置页回来：点开着的那一条从球那儿再长开一次', () => {
  const { bar, row } = mount({ saved: { perch: 'right' } });
  tap(bar);
  const before = row.calls.play.length;
  row.fire({ shown: true });
  const play = row.calls.play.at(-1);
  assert.equal(row.calls.play.length, before + 1);
  assert.equal(play.opening, true);
  assert.deepEqual(play.from, { left: 859.5, right: 903.5 }, '从球那儿长，不是整条突然出现');
});

await test('专注模式把那一排收掉：请到工作区右上角；专注结束、它还在那儿，就回原处', () => {
  const { bar, row } = mount({ saved: { perch: 'left' } });
  document.body.classList.add('is-scratch-focus');
  row.ok = false;
  row.fire({ shown: false });
  assert.equal(bar.state.perch, null);
  assert.equal(bar.state.corner, 'top-right');
  document.body.classList.remove('is-scratch-focus');
  row.ok = true;
  row.fire({ shown: true });
  assert.equal(bar.state.perch, 'left');
  assert.equal(bar.state.phase, 'docked');
});

await test('专注的时候人亲手挪过它：结束之后不再替人搬回去', () => {
  const { bar, row } = mount({ saved: { perch: 'left' } });
  document.body.classList.add('is-scratch-focus');
  row.ok = false;
  row.fire({ shown: false });
  dragTo(bar, 1150, 600);
  document.body.classList.remove('is-scratch-focus');
  row.ok = true;
  row.fire({ shown: true });
  assert.equal(bar.state.perch, null);
});

await test('收起顶上那一排：停在里面的球借住到工作区左上角（从左边出来）；拉回来回原处', () => {
  const { bar, row } = mount({ saved: { perch: 'left', perchX: 0.4, edge: 'left', offset: 0.2 } });
  const released = row.calls.release.length;
  row.isAway = true;
  row.fire({ away: true });
  assert.equal(bar.state.perch, null);
  assert.equal(bar.state.phase, 'docked');
  assert.equal(bar.state.corner, 'top-left');
  assert.ok(bar.root.classList.contains('is-off-row'));
  assert.ok(!bar.root.classList.contains('is-perched'));
  assert.equal(bar.root.style.position, '', '回到工作区里，照工作区的角摆');
  assert.equal(bar.root.style.left, '10px');
  assert.equal(row.calls.release.length, released + 1, '被它推开的标签回家');
  row.isAway = false;
  row.fire({ away: false });
  assert.equal(bar.state.perch, 'left');
  assert.ok(near(bar.state.perchX, 0.4), '回到原来停的地方，不是空当正中');
  assert.equal(bar.state.phase, 'docked');
  assert.ok(!bar.root.classList.contains('is-off-row'));
  assert.ok(bar.root.classList.contains('is-perched'));
  assert.equal(bar.root.style.position, 'fixed');
});

await test('点开着的那一条：借住到左边竖着（照平时贴边那样摆）；拉回来从球那儿再长开', () => {
  const { bar, row } = mount({ saved: { perch: 'right', edge: 'left', offset: 0.3 } });
  tap(bar);
  assert.equal(bar.state.phase, 'expanded');
  row.isAway = true;
  row.fire({ away: true });
  assert.equal(bar.state.phase, 'expanded');
  assert.equal(bar.state.edge, 'left');
  assert.ok(near(bar.state.offset, 0.3), '上下停在它在工作区里的老地方');
  assert.equal(bar.root.dataset.orientation, 'vertical', '贴左边是竖着的');
  assert.equal(bar.root.style.left, '10px');
  const before = row.calls.play.length;
  row.isAway = false;
  row.fire({ away: false });
  assert.equal(bar.state.perch, 'right');
  assert.equal(bar.state.phase, 'expanded');
  assert.equal(bar.root.dataset.orientation, 'horizontal', '回到那一排里又是横躺的');
  const play = row.calls.play.at(-1);
  assert.equal(row.calls.play.length, before + 1, '要演，不是一下子出现');
  assert.equal(play.opening, true);
  assert.deepEqual(play.from, { left: 859.5, right: 903.5 }, '从球那儿长开、把两边挤开');
});

await test('借住在左边时人亲手挪过它：拉回来不再替人搬回去', () => {
  const { bar, row } = mount({ saved: { perch: 'left' } });
  row.isAway = true;
  row.fire({ away: true });
  dragTo(bar, 1150, 600);
  assert.equal(bar.state.offRow, null);
  row.isAway = false;
  row.fire({ away: false });
  assert.equal(bar.state.perch, null);
  assert.ok(!bar.root.classList.contains('is-off-row'));
});

await test('借住在左边时存盘写那一排里的位置；开机时那一排还收着：直接借住到左边，拉回来照样回去', () => {
  const { row } = mount({ saved: { perch: 'left', perchX: 0.4, edge: 'left', offset: 0.2 } });
  row.isAway = true;
  row.fire({ away: true });
  const saved = JSON.parse(dom.window.localStorage.getItem('ls_ink_toolbar'));
  assert.equal(saved.perch, 'left');
  assert.ok(near(saved.perchX, 0.4));
  assert.equal(saved.corner, null);
  const again = mount({ saved, away: true });
  assert.equal(again.bar.state.perch, null);
  assert.ok(again.bar.state.offRow);
  assert.equal(again.bar.state.corner, 'top-left');
  assert.ok(again.bar.root.classList.contains('is-off-row'));
  again.row.isAway = false;
  again.row.fire({ away: false });
  assert.equal(again.bar.state.perch, 'left');
});

await test('拉回之前先记下借住在左边那一个此刻的样子（替身从这儿出发）；收起那一次不记；用过就扔', () => {
  const { bar, row } = mount({ saved: { perch: 'left' } });
  row.isAway = true;
  row.fire({ away: true });
  bar.root.getBoundingClientRect = () => ({ left: 10, top: 98, right: 58, bottom: 146, width: 48, height: 48 });
  bar.rowWillMove(true);
  assert.equal(bar._beforeRowMove, null);
  bar.rowWillMove(false);
  assert.equal(bar._beforeRowMove.rect.top, 98);
  row.isAway = false;
  row.fire({ away: false });
  assert.equal(bar._beforeRowMove, null);
  assert.equal(bar.state.perch, 'left');
});

/**
 * 收起 / 拉回那几段动画的先后。jsdom 没有 Web Animations，这里临时装一个只记账的 animate：
 * 谁演了什么、多久、等多久才开始。演完这一段就拆掉，别的测试照旧走「不演」那条路。
 */
async function withAnimations(bar, fn) {
  const played = [];
  const proto = dom.window.Element.prototype;
  const hadAnimate = Object.prototype.hasOwnProperty.call(proto, 'animate');
  const oldAnimate = proto.animate;
  const oldGCS = globalThis.getComputedStyle;
  proto.animate = function (keyframes, opts = {}) {
    const anim = { el: this, keyframes, opts, cancelled: false, finished: new Promise(() => {}), cancel() { this.cancelled = true; } };
    played.push(anim);
    return anim;
  };
  // 停在那一排里时它的透明度跟着那一排走（CSS 算的），jsdom 算不出来：由测试说。
  let rootOpacity = '1';
  globalThis.getComputedStyle = (el, ...rest) => (el === bar.root ? { opacity: rootOpacity } : oldGCS(el, ...rest));
  try {
    await fn({ played, setOpacity: (v) => { rootOpacity = v; } });
  } finally {
    if (hadAnimate) proto.animate = oldAnimate; else delete proto.animate;
    globalThis.getComputedStyle = oldGCS;
  }
}
const isGhost = (a) => a.el.dataset?.role === 'toolbar-ghost';
const touches = (a, prop) => a.keyframes.some((k) => prop in k);

await test('收起（甩一下就松手，那一排才走一小段）：替身跟着那一排走完，左边那一个才滑进来', async () => {
  const { bar, row } = mount({ saved: { perch: 'left' } });
  await withAnimations(bar, ({ played, setOpacity }) => {
    bar.root.getBoundingClientRect = () => ({ left: 456, top: -9, right: 500, bottom: 35, width: 44, height: 44 });
    setOpacity('0.65');
    row.isAway = true;
    row.progress = () => 0.17;
    row.fire({ away: true });
    const up = played.find((a) => isGhost(a));
    const enter = played.find((a) => a.el === bar.root && touches(a, 'translate'));
    assert.ok(up, '替身跟着那一排往上走');
    assert.ok(enter, '左边那一个从外面滑进来');
    assert.ok(enter.opts.delay >= up.opts.duration, `替身走完（${up.opts.duration}ms）才进来，实际等了 ${enter.opts.delay}ms`);
    assert.equal(enter.opts.fill, 'backwards', '等着的时候停在外面，不在终点先闪一下');
  });
});

await test('拉回（收着的球）：左边那一个先滑出去，走完了顶上那一颗才长出来', async () => {
  const { bar, row } = mount({ saved: { perch: 'left' } });
  row.isAway = true;
  row.fire({ away: true });
  await withAnimations(bar, ({ played }) => {
    bar.root.getBoundingClientRect = () => ({ left: 10, top: 98, right: 58, bottom: 146, width: 48, height: 48 });
    bar.rowWillMove(false);
    row.isAway = false;
    row.progress = () => 0;
    row.fire({ away: false });
    const out = played.find((a) => isGhost(a));
    const pop = played.find((a) => a.el === bar.root && touches(a, 'scale'));
    assert.ok(out, '左边那一个往外滑');
    assert.ok(pop, '顶上那一颗长出来');
    assert.ok(pop.opts.delay >= out.opts.duration, `左边那一个走完（${out.opts.duration}ms）才出来，实际等了 ${pop.opts.delay}ms`);
    assert.equal(pop.opts.fill, 'backwards', '等着的时候看不见');
    assert.equal(bar.state.perch, 'left');
  });
});

await test('拉回（点开着的）：先按收着的球摆回去、藏着；左边那一条走完，才从球那儿长开', async () => {
  const { bar, row } = mount({ saved: { perch: 'right' } });
  tap(bar);
  row.isAway = true;
  row.fire({ away: true });
  assert.equal(bar.state.phase, 'expanded');
  await withAnimations(bar, async ({ played }) => {
    bar.root.getBoundingClientRect = () => ({ left: 10, top: 96, right: 64, bottom: 720, width: 54, height: 624 });
    bar.rowWillMove(false);
    const plays = row.calls.play.length;
    row.isAway = false;
    row.progress = () => 0;
    row.fire({ away: false });
    assert.equal(bar.state.perch, 'right');
    assert.equal(bar.state.phase, 'docked', '先是那一排里的球');
    assert.equal(row.calls.play.length, plays, '左边那一条还在往外走：不长开');
    const out = played.find((a) => isGhost(a));
    const hold = played.find((a) => a.el === bar.root && touches(a, 'opacity'));
    assert.ok(out && hold, '左边那一条往外走；顶上那一颗藏着');
    assert.ok(hold.keyframes.every((k) => k.opacity === 0));
    await new Promise((r) => setTimeout(r, out.opts.duration + 30));
    assert.equal(bar.state.phase, 'expanded', '走完了：长开');
    assert.equal(row.calls.play.length, plays + 1);
    assert.equal(row.calls.play.at(-1).opening, true);
    assert.equal(hold.cancelled, true, '藏着的那一段收掉，长开的那一段看得见');
  });
});

await test('拉回之后还没长开就又收起来：那一段作罢，不在收起的那一排里长开', async () => {
  const { bar, row } = mount({ saved: { perch: 'right' } });
  tap(bar);
  row.isAway = true;
  row.fire({ away: true });
  await withAnimations(bar, async () => {
    bar.root.getBoundingClientRect = () => ({ left: 10, top: 96, right: 64, bottom: 720, width: 54, height: 624 });
    bar.rowWillMove(false);
    row.isAway = false;
    row.fire({ away: false });
    const plays = row.calls.play.length;
    row.isAway = true;
    row.fire({ away: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(row.calls.play.length, plays, '没有在那一排里长开');
    assert.ok(bar.state.offRow, '又借住到左边去了');
  });
});

await test('没停在那一排里的：那一排收起、拉回都不碰它', () => {
  const { bar, row } = mount({ saved: { edge: 'right', offset: 0.6 } });
  const before = bar.state;
  row.isAway = true;
  row.fire({ away: true });
  assert.equal(bar.state, before);
  row.isAway = false;
  row.fire({ away: false });
  assert.equal(bar.state, before);
});

await test('没有那一排（setPerchHost 没给）：拖到顶上照旧落在工作区的边上', () => {
  const { bar } = mount();
  bar.setPerchHost(null);
  dragTo(bar, 880, 30);
  assert.equal(bar.state.perch, null);
});

// ═══════════════════════════════════════════════════════════════
group('4. 状态');

await test('停哪儿只是一个字段：工具、颜色、粗细一样不动', () => {
  const s0 = stateMod.createToolbarState({ tool: 'marker', color: '#dc2626', width: 7 });
  const dragging = stateMod.startDrag(s0, { x: 1, y: 1 });
  const perched = stateMod.endDrag(dragging, { x: 1, y: -30 }, { width: 1200, height: 672 }, { perch: 'right' });
  assert.equal(perched.perch, 'right');
  assert.equal(perched.phase, 'docked');
  for (const k of ['tool', 'color', 'width', 'opacity']) assert.equal(perched[k], s0[k], k);
});

await test('拿起来就不在那一排里了；落在工作区里也不在', () => {
  const s = stateMod.createToolbarState({ perch: 'left' });
  assert.equal(stateMod.startDrag(s, { x: 1, y: 1 }).perch, null);
  const landed = stateMod.endDrag(stateMod.startDrag(s, { x: 1, y: 1 }), { x: 600, y: 300 }, { width: 1200, height: 672 });
  assert.equal(landed.perch, null);
});

await test('收起、请出去、请回来；让位和飞角都不管停在那一排里的', () => {
  const open = stateMod.undock(stateMod.createToolbarState({ perch: 'right' }));
  assert.equal(open.phase, 'expanded');
  assert.equal(open.perch, 'right', '点开还在那一排里');
  assert.equal(stateMod.foldToPerch(open).phase, 'docked');
  assert.equal(stateMod.yieldToCorner(open, 'bottom-left'), open);
  assert.equal(stateMod.dockToCorner(open, 'bottom-left'), open);
  const out = stateMod.leavePerch(open);
  assert.equal(out.perch, null);
  assert.equal(out.corner, 'top-right');
  assert.equal(stateMod.perchAt(out, 'right').perch, 'right');
});

await test('存下来的有它；开机按收着的球恢复', () => {
  const s = stateMod.undock(stateMod.createToolbarState({ perch: 'left' }));
  const saved = stateMod.serializeToolbarState(s);
  assert.equal(saved.perch, 'left');
  const back = stateMod.createToolbarState(saved);
  assert.equal(back.phase, 'docked');
  assert.equal(back.corner, null);
});

await test('借住到左边、再回去：只动摆放，不动工具；存盘写那一排里的位置', () => {
  const ball = stateMod.createToolbarState({ perch: 'left', perchX: 0.4, edge: 'left', offset: 0.2, tool: 'marker' });
  const off = stateMod.stepOffRow(ball);
  assert.equal(off.perch, null);
  assert.equal(off.phase, 'docked');
  assert.equal(off.corner, 'top-left');
  assert.equal(off.edge, 'left');
  assert.ok(near(off.offset, 0.2));
  assert.deepEqual({ ...off.offRow }, { perch: 'left', perchX: 0.4, edge: 'left', offset: 0.2 });
  assert.equal(off.tool, 'marker');
  assert.equal(stateMod.isOffRow(off), true);
  // 它在左边的老地方偏下半截：左下角。
  assert.equal(stateMod.stepOffRow(stateMod.createToolbarState({ perch: 'right', edge: 'left', offset: 0.8 })).corner, 'bottom-left');
  // 原来贴右边、点开着的：借住在左边正中，竖着。
  const openRight = stateMod.undock(stateMod.createToolbarState({ perch: 'right', edge: 'right', offset: 0.3 }));
  const offOpen = stateMod.stepOffRow(openRight);
  assert.equal(offOpen.phase, 'expanded');
  assert.equal(offOpen.edge, 'left');
  assert.equal(offOpen.offset, 0.5);
  assert.equal(offOpen.corner, null);
  const saved = stateMod.serializeToolbarState(off);
  assert.equal(saved.perch, 'left');
  assert.ok(near(saved.perchX, 0.4));
  assert.equal(saved.corner, null);
  const back = stateMod.backToRow(off);
  assert.equal(back.perch, 'left');
  assert.ok(near(back.perchX, 0.4));
  assert.equal(back.offRow, null);
  assert.equal(back.phase, 'docked');
  assert.equal(back.tool, 'marker');
  assert.equal(stateMod.backToRow(stateMod.undock(off)).phase, 'expanded', '在左边点开了：回去也开着');
  assert.equal(stateMod.backToRow(offOpen).edge, 'right', '工作区里的家还是原来那条边');
});

await test('没停在那一排里的、拖在手里的：不借住；拿起来就把账清了', () => {
  const plain = stateMod.createToolbarState({ edge: 'left' });
  assert.equal(stateMod.stepOffRow(plain), plain);
  assert.equal(stateMod.backToRow(plain), plain);
  const off = stateMod.stepOffRow(stateMod.createToolbarState({ perch: 'left' }));
  const dragging = stateMod.startDrag(off, { x: 1, y: 1 });
  assert.equal(dragging.offRow, null);
  assert.equal(stateMod.stepOffRow(dragging), dragging);
  // 借住时为面板让了位：回去时那笔账一起结清（停在那一排里的不压着面板）。
  const yielded = stateMod.yieldToCorner(off, 'bottom-left');
  assert.ok(yielded.yielded);
  assert.equal(stateMod.backToRow(yielded).yielded, null);
});

await test('工作区补的那一段滑动不挪借住在左边的那一个（它自己从左边进出）', () => {
  const src = $read('src/pdf/pdf-workspace-ui.js');
  const at = src.indexOf('const ridesWithRow');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 300), /is-off-row/);
});

// ═══════════════════════════════════════════════════════════════
group('5. 划着挑：从左边那枚胶囊搬到了工具栏上');

/**
 * 给横杠上的工具、颜色摆上尺寸（jsdom 不排版）：竖着的一格一格往下，横躺的一格一格往右，每格
 * 44、隔 2。返回每一格的正中，和这一条横杠自己的框。
 */
function layoutBar(bar) {
  const vertical = bar.root.dataset.orientation === 'vertical';
  const box = (a, b, c, d) => ({ left: a, right: b, top: c, bottom: d, width: b - a, height: d - c, x: a, y: c });
  const cell = (i, base) => {
    const a = base + i * 46;
    return vertical ? box(10, 54, a, a + 44) : box(a, a + 44, 20, 64);
  };
  const tools = [...bar.root.querySelectorAll('[data-tool]')];
  const swatches = [...bar.root.querySelectorAll('[data-swatch]')];
  tools.forEach((b, i) => { const r = cell(i, 100); b.getBoundingClientRect = () => r; });
  swatches.forEach((b, i) => { const r = cell(i, 460); b.getBoundingClientRect = () => r; });
  const span = (n, base) => (vertical ? box(10, 54, base, base + n * 46) : box(base, base + n * 46, 20, 64));
  const toolsBox = span(tools.length, 100);
  const swatchBox = span(swatches.length, 460);
  bar.root.querySelector('.ink-tools').getBoundingClientRect = () => toolsBox;
  bar.root.querySelector('.ink-swatches').getBoundingClientRect = () => swatchBox;
  const rootBox = vertical ? box(5, 59, 60, 760) : box(60, 760, 15, 69);
  bar.root.getBoundingClientRect = () => rootBox;
  const centre = (el) => { const r = el.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; };
  return {
    vertical,
    tool: (name) => centre(bar.root.querySelector(`[data-tool="${name}"]`)),
    swatch: (i) => centre(swatches[i]),
  };
}

function touch(type, x, y, target = dom.window, id = 31) {
  const ev = new dom.window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
    button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
  target.dispatchEvent(ev);
  return ev;
}

/** 从 from 按下，分几步顺着走到 to（不抬手）。 */
function slide(bar, from, to, { id = 31, steps = 6 } = {}) {
  const start = bar.root.querySelector(`[data-tool="${from.name}"], [data-swatch="${from.name}"]`) || bar.root;
  touch('pointerdown', from.x, from.y, start, id);
  for (let i = 1; i <= steps; i++) {
    touch('pointermove', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, dom.window, id);
  }
}

const drops = () => [...document.querySelectorAll('.ink-scrub-drop')];

await test('点：不插手——没有玻璃浮出来，按钮自己的 click 照常到', () => {
  const { bar } = mount();
  assert.equal(bar.state.phase, 'expanded');
  const L = layoutBar(bar);
  const pencil = bar.root.querySelector('[data-tool="pencil"]');
  const p = L.tool('pencil');
  touch('pointerdown', p.x, p.y, pencil);
  touch('pointermove', p.x + 2, p.y + 3);
  touch('pointerup', p.x + 2, p.y + 3);
  assert.equal(drops().length, 0);
  assert.ok(!bar.root.querySelector('.ink-tools').classList.contains('is-scrubbing'));
  pencil.click(); // 浏览器补的那一下点击
  assert.equal(bar.state.tool, 'pencil', '点一下照样换工具（没有被当成划完之后那一下吞掉）');
});

await test('顺着横杠划：玻璃浮在 body 上、跟着手指，底下那一格亮；松手拿那一格', () => {
  const { bar } = mount();
  const L = layoutBar(bar);
  assert.ok(L.vertical, '贴左边的那一条是竖着的');
  assert.equal(bar.state.tool, 'pen');
  const pen = { name: 'pen', ...L.tool('pen') };
  slide(bar, pen, L.tool('marker'));
  const [drop] = drops();
  assert.ok(drop, '浮起来一块玻璃');
  assert.equal(drop.parentNode, document.body, '挂在 body 上：在横杠里面它只看得见横杠自己那层底，弯出来会叠成两个');
  assert.ok(drop.classList.contains('is-on'));
  assert.equal(drop.getAttribute('aria-hidden'), 'true');
  const tools = bar.root.querySelector('.ink-tools');
  assert.ok(tools.classList.contains('is-scrubbing'));
  assert.ok(bar.root.querySelector('[data-tool="marker"]').classList.contains('is-scrub-target'), '底下那一格亮起来');
  assert.equal(bar.state.tool, 'pen', '划着的时候还没换：松手才换');
  // 玻璃摆在手指底下（竖着的那一条：上下跟手，左右对齐那一列的中线）；和镜片一样大（44 - 6）。
  const m = L.tool('marker');
  assert.equal(drop.style.width, '38px');
  assert.equal(drop.style.translate, `${32 - 19}px ${m.y - 19}px`);
  touch('pointerup', m.x, m.y);
  assert.equal(bar.state.tool, 'marker');
  assert.ok(!tools.classList.contains('is-scrubbing'));
  assert.equal(bar.root.querySelectorAll('.is-scrub-target').length, 0);
  assert.ok(!drop.classList.contains('is-on'), '松手：落回去、淡掉');
  // 松手后浏览器补的那一下点击落到哪一格上，都不再算一次点（点选中的那一支会开卡片）。
  bar.root.querySelector('[data-tool="marker"]').click();
  assert.equal(bar.state.openCard, null, '没有替人开卡片');
});

await test('落回去的玻璃过一会儿自己摘掉', async () => {
  const { bar } = mount();
  const L = layoutBar(bar);
  slide(bar, { name: 'pen', ...L.tool('pen') }, L.tool('pencil'));
  touch('pointerup', L.tool('pencil').x, L.tool('pencil').y);
  assert.equal(drops().length, 1);
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(drops().length, 0);
});

await test('松在原来那一支上：什么都不变，也不开卡片（那是点的事）', () => {
  const { bar } = mount();
  const L = layoutBar(bar);
  const pen = { name: 'pen', ...L.tool('pen') };
  slide(bar, pen, L.tool('eraser'));
  slide(bar, { name: 'eraser', ...L.tool('eraser') }, pen, { steps: 4 }); // 同一根手指走回来
  touch('pointerup', pen.x, pen.y);
  assert.equal(bar.state.tool, 'pen');
  assert.equal(bar.state.openCard, null);
});

await test('横着划过竖着的那一条：不是在挑，放手', () => {
  const { bar } = mount();
  const L = layoutBar(bar);
  const pen = L.tool('pen');
  touch('pointerdown', pen.x, pen.y, bar.root.querySelector('[data-tool="pen"]'));
  touch('pointermove', pen.x + 30, pen.y + 4);
  touch('pointermove', pen.x + 60, pen.y + 50);
  touch('pointerup', pen.x + 60, pen.y + 50);
  assert.equal(drops().length, 0);
  assert.equal(bar.state.tool, 'pen');
});

await test('横躺的那一条（贴底边）：左右划', () => {
  const { bar } = mount({ saved: { edge: 'bottom' } });
  const L = layoutBar(bar);
  assert.ok(!L.vertical);
  const pen = { name: 'pen', ...L.tool('pen') };
  const lasso = L.tool('lasso');
  slide(bar, pen, lasso);
  const [drop] = drops();
  assert.equal(drop.style.translate, `${lasso.x - 19}px ${42 - 19}px`, '横着跟手，竖着对齐那一行的中线');
  touch('pointerup', lasso.x, lasso.y + 20);
  assert.equal(bar.state.tool, 'lasso');
  // 竖着划过横躺的那一条：不算。
  touch('pointerdown', pen.x, pen.y, bar.root.querySelector('[data-tool="pen"]'), 32);
  touch('pointermove', pen.x + 3, pen.y - 40, dom.window, 32);
  touch('pointerup', pen.x + 3, pen.y - 40, dom.window, 32);
  assert.equal(bar.state.tool, 'lasso');
});

await test('划到横杠外面老远再松手、系统把手势收走：算反悔，什么都不拿', () => {
  const { bar } = mount();
  const L = layoutBar(bar);
  const pen = { name: 'pen', ...L.tool('pen') };
  const marker = L.tool('marker');
  slide(bar, pen, marker);
  touch('pointermove', marker.x + 120, marker.y);
  touch('pointerup', marker.x + 120, marker.y); // 横杠右边 59，+44 之外
  assert.equal(bar.state.tool, 'pen');
  slide(bar, pen, marker, { id: 33 });
  touch('pointercancel', marker.x, marker.y, dom.window, 33);
  assert.equal(bar.state.tool, 'pen');
  assert.ok(!bar.root.querySelector('.ink-tools').classList.contains('is-scrubbing'));
  // 在横杠边上一点点松手（44 以内）还算：手指没离开多远。
  slide(bar, pen, marker, { id: 34 });
  touch('pointerup', marker.x + 50, marker.y, dom.window, 34);
  assert.equal(bar.state.tool, 'marker');
});

await test('颜色那一排也能划；「更多颜色」那一格是动作，不算', () => {
  const { bar } = mount();
  const L = layoutBar(bar);
  const colours = [...bar.root.querySelectorAll('[data-swatch]')].map((b) => b.dataset.swatch);
  assert.ok(colours.length >= 3);
  const first = { name: colours[0], ...L.swatch(0) };
  const last = L.swatch(colours.length - 1);
  slide(bar, first, { x: last.x, y: last.y + 200 }); // 划过了头：落在最后一个颜色上，不是「＋」
  assert.ok(bar.root.querySelector(`[data-swatch="${colours[colours.length - 1]}"]`).classList.contains('is-scrub-target'));
  touch('pointerup', last.x, last.y + 200);
  assert.equal(bar.state.color, colours[colours.length - 1]);
  assert.equal(bar.state.openCard, null, '没有开颜色卡片');
});

await test('开始划时按下的那一格丢了隐式捕获：不是手势被收走，接着划；横杠自己丢了捕获才算反悔', () => {
  // 平板上（WebView 138）的那一串：手指按在钢笔上，浏览器隐式地把指针交给钢笔；走过 10px、横杠接住
  // 指针的那一刻，钢笔收到 lostpointercapture。原来把它当成了被收走，划动刚开始就取消了。
  const { bar } = mount();
  const L = layoutBar(bar);
  const pen = bar.root.querySelector('[data-tool="pen"]');
  const lost = (target, id = 31) => target.dispatchEvent(new dom.window.PointerEvent('lostpointercapture', {
    bubbles: true, pointerId: id, pointerType: 'touch',
  }));
  slide(bar, { name: 'pen', ...L.tool('pen') }, L.tool('pencil'), { steps: 2 });
  lost(pen);
  assert.ok(bar.root.querySelector('.ink-tools').classList.contains('is-scrubbing'), '还在划');
  assert.ok(drops()[0]?.classList.contains('is-on'), '玻璃还浮着');
  touch('pointermove', L.tool('marker').x, L.tool('marker').y);
  touch('pointerup', L.tool('marker').x, L.tool('marker').y);
  assert.equal(bar.state.tool, 'marker', '松在哪一格拿哪一格');
  // 横杠自己的捕获丢了（系统把手势收走）：反悔。
  slide(bar, { name: 'marker', ...L.tool('marker') }, L.tool('eraser'), { id: 35 });
  lost(bar.root, 35);
  touch('pointerup', L.tool('eraser').x, L.tool('eraser').y, dom.window, 35);
  assert.equal(bar.state.tool, 'marker');
});

await test('划起来就不再有动效：按下时的水波纹摘掉；划着时什么都不渐变（这一排玻璃里每动一帧都要重合成）', () => {
  const { bar } = mount();
  const L = layoutBar(bar);
  const pen = bar.root.querySelector('[data-tool="pen"]');
  // liquid-glass.js 按下时往那一格里放的那道水波纹。
  const wave = document.createElement('span');
  wave.className = 'liquid-ripple-wave';
  pen.appendChild(wave);
  const p = L.tool('pen');
  touch('pointerdown', p.x, p.y, pen);
  touch('pointermove', p.x + 3, p.y);
  assert.ok(wave.isConnected, '还没开始划（可能只是点）：水波纹照常');
  touch('pointermove', L.tool('pencil').x, L.tool('pencil').y);
  assert.ok(!wave.isConnected, '划起来了：摘掉');
  touch('pointerup', L.tool('pencil').x, L.tool('pencil').y);
  const css = $read('src/styles/ink-toolbar.css').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.ink-tools\.is-scrubbing \.ink-tool,\n\.ink-swatches\.is-scrubbing \.ink-swatch,\n\.ink-swatches\.is-scrubbing \.ink-swatch-fill \{ transition: none; \}/);
});

await test('松手、被收走这两下照样传到 window 的冒泡阶段：按下时挂上的「鼓起」在那儿摘掉，不留一圈', () => {
  // 平板上：划几次之后一排工具每一格都套着一圈——liquid-glass.js 按下时挂上的 liquid-bulge-press 是在
  // window 冒泡阶段听 pointerup 摘掉的，划完那一下被拦在了 window 的捕获阶段。捕获住的指针，事件是发
  // 到横杠上的。
  const { bar } = mount();
  const L = layoutBar(bar);
  const heard = [];
  const onEnd = (e) => heard.push(e.type);
  dom.window.addEventListener('pointerup', onEnd);
  dom.window.addEventListener('pointercancel', onEnd);
  try {
    slide(bar, { name: 'pen', ...L.tool('pen') }, L.tool('marker'));
    touch('pointerup', L.tool('marker').x, L.tool('marker').y, bar.root);
    assert.equal(bar.state.tool, 'marker');
    slide(bar, { name: 'marker', ...L.tool('marker') }, L.tool('eraser'), { id: 36 });
    touch('pointercancel', 0, 0, bar.root, 36);
    assert.equal(bar.state.tool, 'marker');
  } finally {
    dom.window.removeEventListener('pointerup', onEnd);
    dom.window.removeEventListener('pointercancel', onEnd);
  }
  assert.deepEqual(heard, ['pointerup', 'pointercancel']);
});

await test('松手时先换工具、再摘掉划着的那两个类：拿到的那一格蓝色一直在，不先灰一下', () => {
  const { bar } = mount();
  const L = layoutBar(bar);
  const tools = bar.root.querySelector('.ink-tools');
  const marker = bar.root.querySelector('[data-tool="marker"]');
  const seen = [];
  const original = bar._set.bind(bar);
  bar._set = (next, opts) => {
    seen.push([next.tool, tools.classList.contains('is-scrubbing'), marker.classList.contains('is-scrub-target')]);
    return original(next, opts);
  };
  slide(bar, { name: 'pen', ...L.tool('pen') }, L.tool('marker'));
  touch('pointerup', L.tool('marker').x, L.tool('marker').y);
  assert.deepEqual(seen, [['marker', true, true]], '换工具的那一刻，还在划、那一格还亮着');
  assert.ok(!tools.classList.contains('is-scrubbing') && !marker.classList.contains('is-scrub-target'), '换完才摘');
  assert.ok(marker.classList.contains('is-selected'));
});

await test('划着的时候另一根手指去拿把手：不作数（拿起来会把正划着的那一排换成球）', () => {
  const { bar } = mount();
  const L = layoutBar(bar);
  slide(bar, { name: 'pen', ...L.tool('pen') }, L.tool('marker'));
  const handle = bar.root.querySelector('[data-role="handle"]');
  touch('pointerdown', 30, 70, handle, 40);
  assert.equal(bar.state.phase, 'expanded');
  touch('pointerup', 30, 70, dom.window, 40);
  touch('pointerup', L.tool('marker').x, L.tool('marker').y);
  assert.equal(bar.state.tool, 'marker');
});

await test('跟手的监听只在按着的时候挂在 window 上；拆掉工具栏时划到一半的那一路和玻璃一起收走', () => {
  const live = new Map();
  const origAdd = dom.window.addEventListener;
  const origRemove = dom.window.removeEventListener;
  dom.window.addEventListener = function (type, handler, opts) {
    if (!live.has(handler)) live.set(handler, new Set());
    live.get(handler).add(type);
    return origAdd.call(this, type, handler, opts);
  };
  dom.window.removeEventListener = function (type, handler, opts) {
    live.get(handler)?.delete(type);
    return origRemove.call(this, type, handler, opts);
  };
  const count = () => [...live.values()].reduce((n, s) => n + s.size, 0);
  try {
    const { bar } = mount();
    const L = layoutBar(bar);
    const base = count();
    const pen = { name: 'pen', ...L.tool('pen') };
    touch('pointerdown', pen.x, pen.y, bar.root.querySelector('[data-tool="pen"]'));
    assert.equal(count(), base + 4, '按下：挂上 move / up / cancel / lostpointercapture');
    touch('pointerup', pen.x, pen.y);
    assert.equal(count(), base, '抬手：摘掉');
    slide(bar, pen, L.tool('marker'));
    assert.equal(drops().length, 1);
    bar.destroy();
    mounted = null;
    assert.equal(drops().length, 0, '浮在 body 上的玻璃不在横杠里，横杠走了它得一起摘');
    assert.equal(count(), 0, '拆掉之后 window 上什么都不剩');
  } finally {
    dom.window.addEventListener = origAdd;
    dom.window.removeEventListener = origRemove;
  }
});

await test('左边那枚胶囊不再划：liquid-glass.js 里没有那一套了，三份样式表里的透镜也拆了', async () => {
  const lg = await import('../src/ui/liquid-glass.js');
  assert.equal(lg.setupScrubLens, undefined);
  const src = $read('src/ui/liquid-glass.js');
  assert.ok(!/setupScrubLens\(|bar-scrub-lens|is-scrubbing/.test(src.replace(/\/\/.*$/gm, '')));
  for (const f of ['src/styles/pdf.css', 'src/styles/liquid.css', 'src/styles/paper.css']) {
    assert.ok(!/bar-scrub-lens|pdf-bar-group\.is-scrubbing/.test($read(f)), f);
  }
});

await test('样式：两组什么手势都不让给浏览器；划着时镜片让出去、蓝色跟着手指底下那一格；三套皮肤各有样子', () => {
  const noComments = (css) => css.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const ink = noComments($read('src/styles/ink-toolbar.css'));
  const groups = ink.slice(ink.indexOf('.ink-tools,\n.ink-swatches {'));
  assert.match(groups.slice(0, groups.indexOf('}')), /touch-action: none;/);
  const vertical = ink.slice(ink.indexOf(".ink-toolbar[data-orientation='vertical'] .ink-tools {"));
  assert.ok(!/touch-action/.test(vertical.slice(0, vertical.indexOf('}'))), '竖着那一列不再让上下拖给浏览器去滚');
  assert.match(ink, /\.ink-tools\.is-scrubbing \.ink-tool\.is-selected::before \{ opacity: 0; \}/);
  assert.match(ink, /\.ink-tools\.is-scrubbing \.ink-tool\.is-scrub-target \{ color: var\(--accent\); \}/);
  assert.match(ink, /\.ink-scrub-drop \{[^}]*position: fixed;[^}]*pointer-events: none;/);
  // 毛玻璃：原来那段折射；液态玻璃：库里那段，静止 / 手在屏幕上两版；纸：一枚钢笔水的圆，不折射。
  assert.match(ink, /\[data-skin="liquid-math"\] \.ink-scrub-drop \{[^}]*backdrop-filter: url\(#lg-refract-soft\);/);
  const lgr = noComments($read('src/styles/liquid-glass-react.css'));
  assert.match(lgr, /html\[data-glass="liquid"\] \.ink-scrub-drop \{\s*backdrop-filter: saturate\(140%\) url\(#lgr-drop-rich\);/);
  assert.match(lgr, /html\[data-glass="liquid"\]\.lgr-busy \.ink-scrub-drop \{\s*backdrop-filter: saturate\(140%\) url\(#lgr-drop-lean\);/);
  const paper = noComments($read('src/styles/paper.css'));
  assert.match(paper, /html\[data-skin="minimal"\] \.ink-scrub-drop \{[^}]*--scrub-lift: 1;[^}]*backdrop-filter: none;/);
  assert.match(ink, /\.ink-scrub-drop\.is-on \{ opacity: 1; scale: var\(--scrub-lift, 1\.3\); \}/);
});

// ═══════════════════════════════════════════════════════════════
group('6. 切页：另外那两枚胶囊收拢、再长出来');

const pdfCss = $read('src/styles/pdf.css');
const rule = (sel) => {
  const at = pdfCss.indexOf(`${sel} {`);
  assert.ok(at >= 0, `找不到 ${sel}`);
  return pdfCss.slice(at, pdfCss.indexOf('}', at));
};

await test('走的时候：左边那枚往右收、右边那枚往左收（朝着留下来的那两个标签），淡出', () => {
  assert.ok(/animation: capsuleOutToRight/.test(rule('#page-pdf.is-leaving .pdf-page-bar > .pdf-bar-group:first-child')));
  assert.ok(/animation: capsuleOutToLeft/.test(rule('#page-pdf.is-leaving .pdf-bar-trail')));
  const kf = pdfCss.slice(pdfCss.indexOf('@keyframes capsuleOutToRight'));
  assert.ok(/to\s*\{ opacity: 0; translate: 22px 0; scale: 0\.9; \}/.test(kf.slice(0, kf.indexOf('}\r\n}') + 3) || kf));
});

await test('退场用两头慢的曲线，不用弹簧：平板上录下来，弹簧那条前 50ms 就走掉六成，看着像当场没了', () => {
  assert.ok(pdfCss.includes('--exit-ease: cubic-bezier(0.4, 0, 0.2, 1);'));
  for (const sel of ['#page-pdf.is-leaving .pdf-page-bar > .pdf-bar-group:first-child', '#page-pdf.is-leaving .pdf-bar-trail']) {
    const body = rule(sel);
    assert.ok(body.includes('0.3s var(--exit-ease)'), sel);
    assert.ok(!body.includes('spring-ease'), sel);
  }
  assert.ok(rule('#page-pdf.is-leaving').includes('animation: pageHold 0.32s'), '整页的计时要比胶囊收拢那一段长');
});

await test('回来的时候：从那儿长出来', () => {
  assert.ok(/animation: capsuleInFromRight/.test(rule('#page-pdf.active .pdf-page-bar > .pdf-bar-group:first-child')));
  assert.ok(/animation: capsuleInFromLeft/.test(rule('#page-pdf.active .pdf-bar-trail')));
});

await test('这一段不许碰 transform：停在这一排里的工具栏是 fixed 的，祖先一带 transform 它就跳', () => {
  for (const name of ['capsuleOutToRight', 'capsuleOutToLeft', 'capsuleInFromRight', 'capsuleInFromLeft',
    'pageFadeInFlat', 'pageFadeOutFlat', 'pageHold']) {
    const at = pdfCss.indexOf(`@keyframes ${name}`);
    assert.ok(at >= 0, name);
    const body = pdfCss.slice(at, pdfCss.indexOf('\n}', at));
    assert.ok(!/transform/.test(body), `${name} 里有 transform`);
  }
  assert.ok(pdfCss.includes('#page-pdf.active { animation: none; }'), '练习页整页不再上浮');
  assert.ok(/animation: pageHold/.test(rule('#page-pdf.is-leaving')));
});

// ═══════════════════════════════════════════════════════════════
group('7. 样式：停进那一排之后');

const inkCss = $read('src/styles/ink-toolbar.css');

await test('跟着那一排收起：和两个标签同一个算式', () => {
  const at = inkCss.indexOf('.ink-toolbar.is-perched {');
  const body = inkCss.slice(at, inkCss.indexOf('}', at));
  assert.ok(/transform: translateY\(calc\(-1 \* \(var\(--pdf-bar-h, 44px\) \+ var\(--app-bar-top, 8px\)\) \* var\(--top-drag, 0\)\)\);/.test(body));
  const nav = pdfCss.slice(pdfCss.indexOf('.app-nav {'));
  assert.ok(/transform: translateY\(calc\(-1 \* \(var\(--pdf-bar-h\) \+ var\(--app-bar-top\)\) \* var\(--drag\)\)\);/.test(nav.slice(0, nav.indexOf('}'))),
    '两个标签走一样远');
  assert.ok(/opacity: calc\(1 - var\(--top-drag, 0\)\);/.test(body));
});

await test('is-instant 在那一排里照样作数（不然量出来的宽度差一截内边距）', () => {
  const perched = inkCss.indexOf('.ink-toolbar.is-perched {');
  const instant = inkCss.indexOf('.ink-toolbar.is-perched.is-instant { transition: none; }');
  assert.ok(instant > perched, '要写在那条过渡后面，或者比它更具体');
});

await test('被那一排接住的球缩到和那一排一样高（不鼓起来，鼓起来会顶到标签上）', () => {
  const at = inkCss.indexOf('.ink-toolbar.is-dragging.is-row-drag .ink-token {');
  assert.ok(at > 0);
  const body = inkCss.slice(at, inkCss.indexOf('}', at));
  assert.ok(/width: var\(--app-nav-h, 44px\);/.test(body) && /height: var\(--app-nav-h, 44px\);/.test(body));
  assert.ok(!/is-perch-armed/.test(inkCss), '那一圈「要进去了」的鼓起不要了');
});

await test('拖在手里那颗球在两个标签上面；标签被推的那一段不过渡', () => {
  assert.ok(/\.ink-toolbar\.is-dragging \{ z-index: 1100; \}/.test(inkCss));
  assert.ok(/\.app-nav\.is-pushed-live \{/.test(pdfCss));
  assert.ok(/body:not\(\[data-page="pdf"\]\) \.app-nav,\s*body\.is-library-open \.app-nav \{ translate: none !important; \}/.test(pdfCss));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(failed ? 1 : 0);
