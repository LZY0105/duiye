// 设定页背后那层缓慢漂浮的数学符号。
//
// 纯装饰，不承载任何信息。这一点决定了它的每一条规则：系统要求「减少动态效果」
// 时它根本不启动；页面切到后台时不画；切到「课本」时由 bootstrap 整个停掉——那一
// 页被文档铺满，画出来的每一帧都会被盖住，却仍在和手写笔的采样抢主线程。
//
// 因此这个模块必须能被彻底关掉，而不只是停在那里。start/stop 会被反复调用，
// 任何一个没撤掉的监听器或没取消的帧，下次启动时都会变成第二个同时在跑的循环。
// 下面用一个 `session` 对象持有这一轮拿到的所有资源，停止时整个交还。

/** 拖尾用的符号。 */
const SYMBOLS = [
  '∑', '∫', '∂', '∇', '√', 'π', '∞', '≈', '≠', '≤', '≥', '∮', '∯', '∭',
  'ℱ', 'λ', 'θ', 'α', 'β', 'γ', 'δ', 'ε', 'φ', 'ψ', 'ℂ', 'ℝ', 'ℤ', 'ħ',
];

/** 缓慢漂过背景的式子。 */
const FORMULAS = [
  'e^{iπ} + 1 = 0',
  '∫ e^{-x²} dx = √π',
  '∑ 1/n² = π²/6',
  '∇ · B = 0',
  'iħ∂Ψ/∂t = ĤΨ',
  '∮ E·dl = -∂Φ/∂t',
  'ds² = -c²dt² + dx²',
  'F(s) = ∫ f(t)e^{-st}dt',
  'f(x) = ∑ [fⁿ(a)/n!](x-a)ⁿ',
];

const MATH_FONT = '"KaTeX_Math", "Latin Modern Roman", "STIX Two Math", "Cambria Math", serif';
const INK = 'rgba(15, 23, 42, 0.18)';        // 漂浮的式子
const INK_TRAIL = 'rgba(15, 23, 42, 0.45)';  // 跟着指针的符号
const MAX_TRAIL = 30;
const IDLE_MS = 800;                          // 指针静止多久后开始自己冒符号

/** 这一轮运行占用的一切。null 表示没在跑。 */
let session = null;

/** 系统的「减少动态效果」偏好。取不到就当作没有这个要求。 */
function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * 造一个式子。
 *
 * 它有三段生命：淡入到自己的目标透明度、维持、再淡出。寿命到了或者飘出画面就被
 * 原地换成一个新的——数量恒定，不需要增删数组。
 */
function makeFormula(w, h) {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    text: pick(FORMULAS),
    size: rand(18, 32),
    alpha: 0,
    target: rand(0.20, 0.55),
    fade: rand(0.003, 0.009),
    life: rand(300, 900),
    vx: rand(-0.11, 0.11),
    vy: rand(-0.11, 0.11),
    phase: 'in',
  };
}

/**
 * 屏幕上同时有多少个式子。
 *
 * 按面积定，不按屏幕数量定：手机上疏一些，平板上密一些，但两端都要夹住——太少不
 * 成气候，太多就从背景变成了图案。
 */
function formulaCount(w, h) {
  const density = w < 768 ? 100000 : 65000;
  return Math.max(16, Math.min(36, Math.floor((w * h) / density)));
}

/** 在 (x, y) 处冒一个符号，并带上指针这一步的移动方向。 */
function spawn(s, x, y, fromX, fromY) {
  const dx = x - fromX;
  const dy = y - fromY;
  const moved = Math.hypot(dx, dy) > 2;
  s.trail.push({
    x: x + rand(-3, 3),
    y: y + rand(-3, 3),
    text: pick(SYMBOLS),
    size: rand(16, 24),
    life: 1,
    vx: (moved ? dx * 0.15 : 0) + rand(-0.6, 0.6),
    vy: (moved ? dy * 0.15 : 0) + rand(0.3, 0.8),
  });
  if (s.trail.length > MAX_TRAIL) s.trail.splice(0, s.trail.length - MAX_TRAIL);
}

/**
 * 把画布调整到视口大小。
 *
 * 刻意按 CSS 像素而不是设备像素来分配。这块画布是全屏的，在这台平板上按 2.5 倍
 * 像素比来画意味着六倍的填充量——而它整体只有 0.65 的不透明度、字号又大，放在
 * 背景里的那点锐利度换不回这个代价。
 */
function resize(s) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w === s.width && h === s.height) return;   // resize 会连续触发，尺寸没变就别重来
  s.width = s.canvas.width = w;
  s.height = s.canvas.height = h;
  s.canvas.style.width = `${w}px`;
  s.canvas.style.height = `${h}px`;
  s.formulas = Array.from({ length: formulaCount(w, h) }, () => makeFormula(w, h));
}

function drawFormulas(s) {
  const { ctx } = s;
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < s.formulas.length; i++) {
    const f = s.formulas[i];
    f.x += f.vx;
    f.y += f.vy;
    f.life--;

    if (f.phase === 'in') {
      f.alpha += f.fade;
      if (f.alpha >= f.target) f.phase = 'hold';
    } else if (f.phase === 'hold') {
      if (f.life < 60) f.phase = 'out';
    } else {
      f.alpha -= f.fade;
    }

    const gone = f.life <= 0 || f.alpha <= 0
      || f.x < -120 || f.x > s.width + 120
      || f.y < -60 || f.y > s.height + 60;
    if (gone) { s.formulas[i] = makeFormula(s.width, s.height); continue; }
    if (f.alpha < 0.02) continue;

    ctx.globalAlpha = f.alpha;
    ctx.font = `${f.size}px ${MATH_FONT}`;
    ctx.fillText(f.text, f.x, f.y);
  }
}

function drawTrail(s) {
  const { ctx } = s;
  ctx.fillStyle = INK_TRAIL;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = s.trail.length - 1; i >= 0; i--) {
    const p = s.trail[i];
    p.life -= 0.006;
    if (p.life <= 0) { s.trail.splice(i, 1); continue; }
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.04;        // 一点重力，符号是往下落的
    p.vx *= 0.993;       // 横向逐渐停住

    ctx.globalAlpha = p.life * 0.75;
    ctx.font = `${p.size}px ${MATH_FONT}`;
    // 取整落笔：半像素位置会让同一个字形在相邻帧之间抖动。
    ctx.fillText(p.text, Math.round(p.x), Math.round(p.y));
  }
}

function frame(s) {
  s.raf = null;
  if (!s.running) return;

  // 页面在后台：继续排下一帧以便回来时接得上，但不画。
  if (document.hidden) { s.raf = requestAnimationFrame(() => frame(s)); return; }

  s.tick++;
  s.ctx.clearRect(0, 0, s.width, s.height);

  // 式子每两帧走一步。它们本来就慢，半速看不出来，却省下一半的文本绘制。
  if (s.tick % 2 === 0) drawFormulas(s);

  // 指针停下之后，让它自己继续冒一点，别让画面彻底静止。
  if (s.tick % 25 === 0 && s.pointer && Date.now() - s.lastMove > IDLE_MS) {
    spawn(s, s.pointer.x + rand(-12, 12), s.pointer.y + rand(-8, 8), s.pointer.x, s.pointer.y);
  }

  drawTrail(s);
  s.ctx.globalAlpha = 1;
  s.raf = requestAnimationFrame(() => frame(s));
}

/**
 * 启动背景动画。
 *
 * 可重复调用；已经在跑就直接返回。系统要求减少动态效果时不启动——把画布清空留白，
 * 而不是停在某一帧上——同时继续监听这个偏好，用户中途打开或关掉都应立刻生效。
 *
 * @param {string} canvasId 画布元素的 id
 */
export function initParticles(canvasId) {
  if (session && session.running) return;

  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // 偏好监听独立于运行状态：即使因为「减少动态效果」而没启动，也要留着它，
  // 否则用户关掉这个开关之后再也回不来。
  if (!session) {
    session = { canvas, watcher: null, onWatch: null, running: false };
    try {
      session.watcher = window.matchMedia('(prefers-reduced-motion: reduce)');
      session.onWatch = () => (reducedMotion() ? stopParticles() : initParticles(canvasId));
      session.watcher.addEventListener('change', session.onWatch);
    } catch (_) { /* 没有 matchMedia：按没有这个偏好处理 */ }
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (reducedMotion()) {
    try { ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (_) { /* 画布已失效 */ }
    return;
  }

  const s = session;
  Object.assign(s, {
    canvas, ctx, running: true, raf: null, tick: 0,
    width: 0, height: 0, formulas: [], trail: [],
    pointer: null, lastMove: 0, resizeTimer: 0,
  });

  resize(s);

  const move = (x, y) => {
    const from = s.pointer || { x, y };
    s.pointer = { x, y };
    s.lastMove = Date.now();
    spawn(s, x, y, from.x, from.y);
  };

  s.onMouse = (e) => move(e.clientX, e.clientY);
  s.onTouch = (e) => {
    const touch = e.touches[0];
    if (touch) move(touch.clientX, touch.clientY);
  };
  s.onResize = () => {
    clearTimeout(s.resizeTimer);
    s.resizeTimer = setTimeout(() => resize(s), 150);
  };

  window.addEventListener('mousemove', s.onMouse, { passive: true });
  window.addEventListener('touchmove', s.onTouch, { passive: true });
  window.addEventListener('resize', s.onResize, { passive: true });

  frame(s);
}

/** 交还这一轮占用的每一个监听器、定时器和动画帧，并把画布擦干净。 */
export function stopParticles() {
  const s = session;
  if (!s || !s.running) return;

  s.running = false;
  if (s.raf !== null) { cancelAnimationFrame(s.raf); s.raf = null; }
  clearTimeout(s.resizeTimer);

  window.removeEventListener('mousemove', s.onMouse);
  window.removeEventListener('touchmove', s.onTouch);
  window.removeEventListener('resize', s.onResize);
  s.onMouse = s.onTouch = s.onResize = null;

  s.trail.length = 0;
  s.formulas.length = 0;
  try { s.ctx?.clearRect(0, 0, s.width, s.height); } catch (_) { /* 画布已失效 */ }
}
