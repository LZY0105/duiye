// Particle background — math symbol animation on canvas
// Extracted from ocr_demo.html, logic preserved 100%

const SYMBOLS = ['∑', '∫', '∂', '∇', '√', 'π', '∞', '≈', '≠', '≤', '≥', '∮', '∯', '∭', 'ℱ', 'λ', 'θ', 'α', 'β', 'γ', 'δ', 'ε', 'φ', 'ψ', 'ℂ', 'ℝ', 'ℤ', 'ħ'];
const FORMULAS = [
  'e^{iπ} + 1 = 0',
  '∫ e^{-x²} dx = √π',
  '∑ 1/n² = π²/6',
  '∇ · B = 0',
  'iħ∂Ψ/∂t = ĤΨ',
  '∮ E·dl = -∂Φ/∂t',
  'ds² = -c²dt² + dx²',
  'F(s) = ∫ f(t)e^{-st}dt',
  'f(x) = ∑ [fⁿ(a)/n!](x-a)ⁿ'
];

let canvas, ctx;
let mouse = { x: -100, y: -100 };
let trail = [], formulas = [];
let frame = 0;
let lastMove = Date.now();
let animating = false;
let _rt = null;
// Every resource the module owns, so shutdown can actually give them back.
// `stopParticles()` used to set `animating = false` and nothing else: the
// pending animation frame was never cancelled and the three window listeners
// could never be removed, because two of them were anonymous. A stop/start
// cycle therefore left the old listeners attached and, on the next start, a
// second animation loop running alongside the first.
let _rafId = null;
let _started = false;
let _onResize = null;
let _onTouchMove = null;
let _motionQuery = null;
let _onMotionChange = null;

/** The OS-level request not to animate. Absent matchMedia means "no request". */
function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  initFormulas();
}

function initFormulas() {
  formulas = [];
  const density = window.innerWidth < 768 ? 100000 : 65000;
  const count = Math.max(16, Math.min(36, Math.floor((canvas.width * canvas.height) / density)));
  for (let i = 0; i < count; i++) {
    formulas.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      content: FORMULAS[Math.floor(Math.random() * FORMULAS.length)],
      size: Math.random() * 14 + 18,
      opacity: 0,
      targetO: Math.random() * 0.35 + 0.25,
      fadeSpeed: Math.random() * 0.006 + 0.003,
      life: Math.random() * 600 + 300,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      phase: 'in',
    });
  }
}

function spawn(cx, cy, px, py) {
  const dx = cx - px, dy = cy - py;
  const sx = (Math.sqrt(dx * dx + dy * dy) > 2 ? dx * 0.15 : 0) + (Math.random() - 0.5) * 1.2;
  const sy = (Math.sqrt(dx * dx + dy * dy) > 2 ? dy * 0.15 : 0) + Math.random() * 0.5 + 0.3;
  trail.push({
    x: cx + (Math.random() - 0.5) * 6,
    y: cy + (Math.random() - 0.5) * 6,
    s: SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
    life: 1,
    size: Math.random() * 8 + 16,
    vx: sx,
    vy: sy,
  });
  if (trail.length > 30) trail.splice(0, trail.length - 30);
}

function animate() {
  _rafId = null;
  if (!animating) return;
  frame++;
  if (document.hidden) { _rafId = requestAnimationFrame(animate); return; }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const isDark = false; // Light-only app; kept as a named constant so the
                        // colour maths below stays readable.

  const fc = isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(15, 23, 42, 0.18)';
  const trailColor = isDark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(15, 23, 42, 0.45)';

  if (frame % 2 === 0) {
    for (let i = 0; i < formulas.length; i++) {
      const f = formulas[i];
      f.x += f.vx;
      f.y += f.vy;
      f.life--;
      if (f.phase === 'in') { f.opacity += f.fadeSpeed; if (f.opacity >= f.targetO) f.phase = 'hold'; }
      else if (f.phase === 'hold') { if (f.life < 60) f.phase = 'out'; }
      else if (f.phase === 'out') { f.opacity -= f.fadeSpeed; }

      if (f.life <= 0 || f.opacity <= 0 || f.x < -120 || f.x > canvas.width + 120 || f.y < -60 || f.y > canvas.height + 60) {
        formulas[i] = {
          x: Math.random() * canvas.width, y: Math.random() * canvas.height,
          content: FORMULAS[Math.floor(Math.random() * FORMULAS.length)],
          size: Math.random() * 14 + 18, opacity: 0,
          targetO: Math.random() * 0.35 + 0.20, fadeSpeed: Math.random() * 0.006 + 0.003,
          life: Math.random() * 600 + 300,
          vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
          phase: 'in',
        };
        continue;
      }
      if (f.opacity < 0.02) continue;

      ctx.save();
      ctx.globalAlpha = f.opacity;
      ctx.fillStyle = fc;
      ctx.font = f.size + 'px "KaTeX_Math", "Latin Modern Roman", "Computer Modern", "Cambria Math", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.content, f.x, f.y);
      ctx.restore();
    }
  }

  if (frame % 25 === 0 && Date.now() - lastMove > 800 && mouse.x > 0) {
    trail.push({
      x: mouse.x + (Math.random() - 0.5) * 25,
      y: mouse.y + (Math.random() - 0.5) * 15,
      s: SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
      life: 1, size: Math.random() * 6 + 12,
      vx: (Math.random() - 0.5) * 0.25, vy: Math.random() * 0.5 + 0.3,
    });
    if (trail.length > 25) trail.splice(0, trail.length - 25);
  }

  for (let i = trail.length - 1; i >= 0; i--) {
    const p = trail[i];
    p.life -= 0.006;
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.04;
    p.vx *= 0.993;
    if (p.life <= 0) { trail.splice(i, 1); continue; }

    ctx.save();
    ctx.globalAlpha = p.life * 0.75;
    ctx.fillStyle = trailColor;
    ctx.font = p.size + 'px "KaTeX_Math", "Latin Modern Roman", "STIX Two Math", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.s, Math.floor(p.x), Math.floor(p.y));
    ctx.restore();
  }

  _rafId = requestAnimationFrame(animate);
}

// There is no pointer-tracked lighting here any more.
//
// `updateDynamicLighting()` used to write `--glass-x`, `--glass-y` and
// `--glass-angle` onto the document element on every mousemove and touchmove.
// Every glass surface in the app reads those three properties to place its
// catchlight and rotate its rim, so a bright spot tracked the cursor across the
// whole interface — the second, and better hidden, half of the effect that was
// removed from ui/liquid-glass.js. Removing that one left this one running,
// which is why the light was still there.
//
// The properties now go unset, and each surface falls back to the static angle
// and position baked into its own gradient. Glass keeps its highlight; the
// highlight just stops chasing the mouse.

function onMove(e) {
  const px = mouse.x, py = mouse.y;
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  spawn(e.clientX, e.clientY, px, py);
  lastMove = Date.now();
}

/**
 * Starts the decorative background.
 *
 * Idempotent, and honours the reduced-motion preference: a drifting field of
 * symbols is decoration with no informational content, so when the user has
 * asked for less motion it is not started at all — which also spares a
 * lower-powered tablet a permanent animation loop and two continuous input
 * listeners it gains nothing from.
 */
export function initParticles(canvasId) {
  if (_started) return;
  canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Keep watching the preference: a user who turns reduced motion on mid-session
  // should see this stop, and one who turns it off should get it back.
  if (!_motionQuery) {
    try {
      _motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      _onMotionChange = () => {
        if (prefersReducedMotion()) stopParticles();
        else initParticles(canvasId);
      };
      _motionQuery.addEventListener('change', _onMotionChange);
    } catch (_) { /* matchMedia unavailable */ }
  }

  if (prefersReducedMotion()) {
    // Leave the canvas blank rather than frozen mid-frame.
    try { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); } catch (_) {}
    return;
  }

  _started = true;
  ctx = canvas.getContext('2d');
  resize();
  initFormulas();

  _onResize = () => {
    clearTimeout(_rt);
    _rt = setTimeout(resize, 150);
  };
  _onTouchMove = (e) => {
    if (!e.touches.length) return;
    const t = e.touches[0];
    const px = mouse.x, py = mouse.y;
    mouse.x = t.clientX;
    mouse.y = t.clientY;
    spawn(t.clientX, t.clientY, px, py);
    lastMove = Date.now();
  };

  window.addEventListener('resize', _onResize);
  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('touchmove', _onTouchMove, { passive: true });

  animating = true;
  animate();
}

/** Gives back every listener, timer and animation frame this module took. */
export function stopParticles() {
  animating = false;

  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
  clearTimeout(_rt);
  _rt = null;

  if (_onResize) window.removeEventListener('resize', _onResize);
  window.removeEventListener('mousemove', onMove);
  if (_onTouchMove) window.removeEventListener('touchmove', _onTouchMove);
  _onResize = null;
  _onTouchMove = null;

  trail.length = 0;
  if (ctx && canvas) {
    try { ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (_) {}
  }
  _started = false;
}
