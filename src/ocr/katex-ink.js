// OCR —— 公式用 KaTeX 排：结果单子上的预览、写成笔迹的样子，都是这一份。
//
// 原来写成笔迹用的是自己的小排版（latex-layout.js），只认一百来个命令，认不得的照名字写出来；而单子上的预览是 KaTeX 排的。
// 于是同一条公式，单子上看着是对的，写出来却变了样——\begin{cases} 写成「begin cases」、\phi 写成另一个 φ（人在平板上
// 说的「有些符号识别对了，但是转化为笔记后却不正确了」）。现在两边都交给 KaTeX：预览什么样，写出来就什么样。
//
// 自建公式模型的词表里有 443 个命令，KaTeX 认得 414 个；剩下的在这里换成意思一样的写法（OCR_KATEX_MACROS）。模型没写完的
// （到了长度上限、括号没配上）先补齐（repairLatex），还有 KaTeX 认不得的地方就把那一处删了再排（fitLatexForKatex）——
// 宁可少一个记号，也别把整条写成一串红字。
//
// 画成笔迹（rasterizeFormula）：在页面里排一份（看不见），等它用到的那几套 KaTeX 字体加载好，再照排好的样子一个字一个字画到
// 画布上——画布用的就是页面里已经加载的字体；分数线、上划线、\boxed 的框是边框，照边框画；根号、长箭头这些是 SVG，照路径画。
// 画好的黑白图交给 skeleton.js 抽成笔画（ink-typeset.js）。

/** KaTeX 认不得、模型却会写的那几个命令：换成意思一样的写法。 */
export const OCR_KATEX_MACROS = Object.freeze({
  // 直立的希腊字母（upgreek）：KaTeX 没有，写成普通的那一个。
  '\\upepsilon': '\\epsilon',
  '\\upiota': '\\iota',
  '\\uplambda': '\\lambda',
  '\\uppi': '\\pi',
  '\\upxi': '\\xi',
  '\\upzeta': '\\zeta',
  '\\textgreater': '>',
  '\\textless': '<',
  '\\mbox': '\\text{#1}',
  '\\framebox': '\\fbox',
  '\\eqref': '(\\text{#1})',
  '\\ref': '\\text{#1}',
  '\\iiiint': '\\int\\!\\!\\!\\int\\!\\!\\!\\int\\!\\!\\!\\int',
  '\\bigtimes': '\\mathop{\\Large\\times}',
  '\\prescript': '{}^{#1}_{#2}{#3}',
  '\\sideset': '{}#1\\!{#3}#2',
  '\\mspace': '\\mskip{#1}',
});

/** 排的时候都用这一套：块级（公式单独成行时的样子）、只出 HTML、不严格、不信任外来的命令。 */
function katexOptions(throwOnError) {
  return {
    displayMode: true,
    output: 'html',
    throwOnError,
    strict: 'ignore',
    trust: false,
    // 每次给一份新的：KaTeX 会往 macros 里写（\gdef），共用一份会让上一条公式影响下一条。
    macros: { ...OCR_KATEX_MACROS },
  };
}

let katexLoad = null;
/** KaTeX 用的时候才去拿：它不小，不该进开机那一包。拿不到（离线、包坏了）就是 null，调用方退回别的写法。 */
export function loadKatex() {
  katexLoad ||= import('katex').then((m) => m.default || m).catch(() => null);
  return katexLoad;
}

// ── 补齐、修好 ─────────────────────────────────────────────────────────────

/** 一个记号：\begin{x} / \end{x} 整个算一个（模型的词表就是这么切的），\命令、\符号、括号、单个字。 */
const TOKEN = /\\(begin|end)\s*\{([^{}]*)\}|\\[a-zA-Z]+|\\[^a-zA-Z]|[{}]|[\s\S]/gy;

function lex(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while (TOKEN.lastIndex < src.length && (m = TOKEN.exec(src))) {
    const s = m[0];
    if (m[1]) out.push({ kind: m[1], name: m[2], s });
    else if (s === '{' || s === '}') out.push({ kind: s, s });
    else if (s === '\\left' || s === '\\right') out.push({ kind: s.slice(1), s });
    else out.push({ kind: /^\s$/.test(s) ? 'space' : 'other', s });
  }
  return out;
}

/** 从里往外关上，直到栈只剩 keep 个。 */
function closeDown(stack, keep, out) {
  while (stack.length > keep) {
    const top = stack.pop();
    if (top === '{') out.push('}');
    else if (top === 'left') out.push('\\right.');
    else out.push(`\\end{${top.env}}`);
  }
}

/**
 * 模型没写完、或者写得不配对的地方补齐：多出来的右括号、\end、\right 不要；没关上的 {、\left、\begin{…} 按次序关上。
 * 另外两样 TeX 老写法换掉：\buildrel a \over b → \stackrel{a}{b}；\raise / \lower 后面的尺寸去掉（盒子留着）。
 */
export function repairLatex(latex) {
  let src = String(latex ?? '').trim();
  if (!src) return '';
  src = src.replace(/\\buildrel\s*((?:\{[^{}]*\}|(?!\\over\b)[^{}])+?)\s*\\over\s*(\{[^{}]*\}|\\[a-zA-Z]+|\S)/g,
    (_, top, base) => `\\stackrel{${top.trim()}}{${base}}`);
  src = src.replace(/\\(?:raise|lower)\s*-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:em|ex|pt|pc|mm|cm|in|bp|dd|cc|sp|mu|px)/g, '');
  const out = [];
  const stack = [];
  let dropDelimiter = false;
  for (const tk of lex(src)) {
    if (dropDelimiter && tk.kind !== 'space') {
      // 多出来的 \right 已经扔了，它后面那个定界符跟着扔。
      dropDelimiter = false;
      continue;
    }
    if (tk.kind === '{') { stack.push('{'); out.push('{'); continue; }
    if (tk.kind === '}') {
      const at = stack.lastIndexOf('{');
      if (at < 0) continue;
      closeDown(stack, at + 1, out);
      stack.pop();
      out.push('}');
      continue;
    }
    if (tk.kind === 'begin') { stack.push({ env: tk.name }); out.push(tk.s); continue; }
    if (tk.kind === 'end') {
      let at = -1;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i]?.env === tk.name) { at = i; break; }
      if (at < 0) continue;
      closeDown(stack, at + 1, out);
      stack.pop();
      out.push(tk.s);
      continue;
    }
    if (tk.kind === 'left') { stack.push('left'); out.push(tk.s); continue; }
    if (tk.kind === 'right') {
      const at = stack.lastIndexOf('left');
      if (at < 0) { dropDelimiter = true; continue; }
      closeDown(stack, at + 1, out);
      stack.pop();
      out.push(tk.s);
      continue;
    }
    out.push(tk.s);
  }
  closeDown(stack, 0, out);
  return out.join('').trim();
}

/** 去掉最后一个记号（连同它后面的空白）。 */
function dropLastToken(src) {
  const tokens = lex(src).filter((tk) => tk.kind !== 'space');
  tokens.pop();
  return tokens.map((tk) => tk.s).join(' ');
}

const fitted = new Map();
const FITTED_MAX = 200;

/**
 * 一条 KaTeX 排得出来的 LaTeX：先补齐，KaTeX 还报错，就按它报的位置把那一处删掉再试（最多十次）；末尾缺参数的先补一个空组。
 * 排不出来也不抛错：返回改到哪儿算哪儿（调用方用 throwOnError: false 排，剩下的那一处会是红字）。
 */
export function fitLatexForKatex(katex, latex) {
  const key = String(latex ?? '');
  if (fitted.has(key)) return fitted.get(key);
  let src = repairLatex(key);
  let padded = false;
  for (let tries = 0; tries < 10 && src; tries++) {
    try {
      katex.renderToString(src, katexOptions(true));
      break;
    } catch (error) {
      if (!(katex.ParseError && error instanceof katex.ParseError)) break;
      const at = Number.isInteger(error.position) ? error.position : -1;
      if (at < 0) break;
      if (at >= src.length) {
        // 到了末尾还缺东西（\frac{a} 少一个参数、\sqrt 后面没东西）：先补一个空组，还不行就去掉最后一个记号。
        if (!padded) { src += '{}'; padded = true; continue; }
        src = repairLatex(dropLastToken(src.slice(0, -2)));
        padded = false;
        continue;
      }
      const len = error.length > 0 ? error.length : 1;
      src = repairLatex(`${src.slice(0, at)} ${src.slice(at + len)}`);
    }
  }
  if (fitted.size >= FITTED_MAX) fitted.delete(fitted.keys().next().value);
  fitted.set(key, src);
  return src;
}

/** 把一条公式排进 el（结果单子上的预览、画成笔迹之前的那一份，都走这里）。 */
export function renderFormula(katex, latex, el) {
  const src = fitLatexForKatex(katex, latex) || String(latex ?? '');
  katex.render(src, el, katexOptions(false));
}

// ── 画成一张黑白图 ─────────────────────────────────────────────────────────

/** 排的时候的字号（像素）。KaTeX 自己再放大 1.21 倍：一个 em 七十多像素，竖笔七八个像素宽，细化出来的中心线稳。 */
const RASTER_FONT_PX = 64;
/** 图最大多少像素见方：再长的公式按比例缩小。 */
const MAX_RASTER_PX = 4096;
/** 墨的阈值：字边上半透明的像素，过了这个才算墨。 */
const INK_ALPHA = 110;
/** 等字体加载最多等多久。等不到也照样画（会退回系统字体）。 */
const FONT_WAIT_MS = 1500;

/** 透明的颜色（\phantom 的字就是这样）。只认四个分量、最后一个是 0 的；rgb(0, 0, 0) 是黑，不是透明。 */
export function isTransparent(color) {
  if (!color || color === 'transparent') return true;
  const m = /^rgba?\(([^)]*)\)$/.exec(String(color).trim());
  if (!m) return false;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length === 4 && parseFloat(parts[3]) === 0;
}

/** 画布上用的字体：和页面上那一段字一样。 */
const fontOf = (cs) => `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

function unionRect(a, r) {
  if (!r || !(r.width > 0 || r.height > 0)) return a;
  if (!a) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  return {
    left: Math.min(a.left, r.left), top: Math.min(a.top, r.top),
    right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom),
  };
}

/** 等这条公式用到的字体都加载好（每一种字体只等它要画的那几个字）。 */
async function loadFonts(root) {
  const fonts = typeof document !== 'undefined' ? document.fonts : null;
  if (!fonts?.load) return;
  const wanted = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!/\S/.test(node.data) || !node.parentElement) continue;
    const font = fontOf(getComputedStyle(node.parentElement));
    wanted.set(font, (wanted.get(font) || '') + node.data);
  }
  const jobs = [...wanted].map(([font, text]) => fonts.load(font, text).catch(() => null));
  await Promise.race([Promise.allSettled(jobs), new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))]);
}

/** 一个元素四条边里画出来的那几条（分数线、上下划线、\boxed、表格横线都是边框）。 */
function bordersOf(el, cs, rules) {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 || r.height > 0)) return;
  const side = (name) => {
    const w = parseFloat(cs[`border${name}Width`]) || 0;
    const style = cs[`border${name}Style`];
    return w > 0 && style !== 'none' && style !== 'hidden' && !isTransparent(cs[`border${name}Color`]) ? w : 0;
  };
  const top = side('Top');
  const bottom = side('Bottom');
  const left = side('Left');
  const right = side('Right');
  if (top) rules.push({ x: r.left, y: r.top, w: r.width, h: top });
  if (bottom) rules.push({ x: r.left, y: r.bottom - bottom, w: r.width, h: bottom });
  if (left) rules.push({ x: r.left, y: r.top, w: left, h: r.height });
  if (right) rules.push({ x: r.right - right, y: r.top, w: right, h: r.height });
}

/** SVG 被哪些祖先裁着（根号那条长尾巴是一个 400em 宽的 SVG，靠外面那层 overflow: hidden 裁到该有的长度）。 */
function clipOf(svg, root) {
  let clip = null;
  for (let el = svg.parentElement; el && el !== root.parentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const r = el.getBoundingClientRect();
    clip = clip
      ? { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return clip;
}

/**
 * 量出排好的公式里每一样东西在哪：字（起点和基线）、边框、SVG 路径。都是页面坐标（CSS 像素）。
 * 没有排版的地方（jsdom）量出来全是 0，返回 null。
 */
function collectScene(root) {
  let box = null;
  for (const el of root.querySelectorAll('.base')) box = unionRect(box, el.getBoundingClientRect());
  box = unionRect(box, root.getBoundingClientRect());
  if (!box || !(box.right > box.left) || !(box.bottom > box.top)) return null;

  // 字：每一段字前面塞一个零大小、贴着基线的小块，量它就知道这段字从哪儿起、基线在哪儿。先都塞好再一起量，只排一次版。
  const texts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  for (const node of nodes) {
    if (!/\S/.test(node.data) || !node.parentElement) continue;
    const cs = getComputedStyle(node.parentElement);
    // \phantom 的字是透明的：占地方，不画。
    if (isTransparent(cs.color)) continue;
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline';
    node.parentElement.insertBefore(probe, node);
    texts.push({ probe, font: fontOf(cs), text: node.data });
  }
  for (const t of texts) {
    const r = t.probe.getBoundingClientRect();
    t.x = r.left;
    t.y = r.bottom;
  }
  for (const t of texts) t.probe.remove();

  const rules = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.closest('svg')) continue;
    bordersOf(el, getComputedStyle(el), rules);
  }

  const shapes = [];
  for (const svg of root.querySelectorAll('svg')) {
    const clip = clipOf(svg, root);
    for (const shape of svg.querySelectorAll('path, line')) {
      const m = shape.getScreenCTM?.();
      if (!m) continue;
      if (shape.localName === 'path') {
        const d = shape.getAttribute('d');
        if (d) shapes.push({ kind: 'path', d, m, clip });
      } else {
        const num = (name) => parseFloat(shape.getAttribute(name)) || 0;
        shapes.push({
          kind: 'line', x1: num('x1'), y1: num('y1'), x2: num('x2'), y2: num('y2'),
          width: parseFloat(getComputedStyle(shape).strokeWidth) || 1, m, clip,
        });
      }
    }
  }
  return { box, texts, rules, shapes };
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 照量好的样子画到一块画布上，读成黑白掩码。 */
export function paintScene(scene, emPx) {
  const { box, texts, rules, shapes } = scene;
  const pad = Math.ceil(emPx * 0.3);
  const rawW = box.right - box.left + pad * 2;
  const rawH = box.bottom - box.top + pad * 2;
  const s = Math.min(1, MAX_RASTER_PX / rawW, MAX_RASTER_PX / rawH);
  const width = Math.max(1, Math.ceil(rawW * s));
  const height = Math.max(1, Math.ceil(rawH * s));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const ox = box.left - pad;
  const oy = box.top - pad;
  ctx.setTransform(s, 0, 0, s, -ox * s, -oy * s);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  for (const t of texts) {
    ctx.font = t.font;
    ctx.fillText(t.text, t.x, t.y);
  }
  for (const r of rules) ctx.fillRect(r.x, r.y, r.w, r.h);
  for (const sh of shapes) {
    ctx.save();
    if (sh.clip) {
      ctx.beginPath();
      ctx.rect(sh.clip.left, sh.clip.top, sh.clip.right - sh.clip.left, sh.clip.bottom - sh.clip.top);
      ctx.clip();
    }
    // 路径自己的坐标 → 页面坐标（含 viewBox 和 preserveAspectRatio）→ 这块画布。
    ctx.transform(sh.m.a, sh.m.b, sh.m.c, sh.m.d, sh.m.e, sh.m.f);
    if (sh.kind === 'path') {
      ctx.fill(new Path2D(sh.d));
    } else {
      ctx.lineWidth = sh.width;
      ctx.beginPath();
      ctx.moveTo(sh.x1, sh.y1);
      ctx.lineTo(sh.x2, sh.y2);
      ctx.stroke();
    }
    ctx.restore();
  }
  const data = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > INK_ALPHA ? 1 : 0;
  // 用完让出内存。
  canvas.width = 1;
  canvas.height = 1;
  return { mask, width, height, pxPerEm: emPx * s };
}

/**
 * 一条公式 → 一张黑白图：{mask, width, height, pxPerEm}（pxPerEm：图上几个像素是 KaTeX 的一个 em）。
 * 在页面里排、在画布上画——没有页面（Node）、没有排版（jsdom）、拿不到 KaTeX，都返回 null，调用方退回自己的小排版。
 */
export async function rasterizeFormula(latex, { fontPx = RASTER_FONT_PX } = {}) {
  if (typeof document === 'undefined' || !document.body || typeof Path2D !== 'function') return null;
  const katex = await loadKatex();
  if (!katex) return null;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:fixed', 'left:-40000px', 'top:0', 'visibility:hidden', 'pointer-events:none',
    `font-size:${fontPx}px`, 'line-height:normal', 'white-space:nowrap', 'margin:0', 'padding:0', 'border:0',
  ].join(';');
  document.body.appendChild(host);
  try {
    renderFormula(katex, latex, host);
    const root = host.querySelector('.katex-html');
    const katexEl = host.querySelector('.katex');
    if (!root || !katexEl) return null;
    await loadFonts(root);
    const scene = collectScene(root);
    if (!scene) return null;
    const emPx = parseFloat(getComputedStyle(katexEl).fontSize) || fontPx * 1.21;
    return paintScene(scene, emPx);
  } catch (_) {
    return null;
  } finally {
    host.remove();
  }
}
