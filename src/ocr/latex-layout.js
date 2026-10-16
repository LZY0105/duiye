// OCR —— 认出来的公式（LaTeX）排成一张「绘制清单」：哪个字放哪儿、多大、哪里画一道横线、哪里画根号。
//
// 转成笔迹那一步（ink-typeset.js）照这张清单把字画到一块离屏画布上，再抽成单线的笔画。这里不碰画布、不碰 DOM：
// 量字宽的函数由调用方给（真画布上是 measureText，测试里是一个固定宽度），所以排版规则能在 Node 里单独钉住。
//
// 只管识别结果里常见的那些：上下标、分式、根号（带次数）、希腊字母和常见的运算符 / 关系符、\lim \sin 这类函数名、
// 上横线 / 箭头 / 帽子 / 点这些修饰、\left \right 这种只管大小的命令（忽略，括号照常写）。认不得的命令照名字写出来，
// 不报错——宁可多几个字母，也别让人点了「转为笔迹」什么都没有。
//
// 坐标：单位是 em（字号 1），x 向右；y 向下，基线在 y = 0。一个盒子 {w, a, d, ops}：宽、基线以上多高、以下多深、
// 画的东西（每一样的坐标相对盒子左端的基线）。

const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃',
  cong: '≅', propto: '∝', ll: '≪', gg: '≫', lt: '<', gt: '>',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  leftrightarrow: '↔', iff: '⇔', implies: '⇒', mapsto: '↦', uparrow: '↑', downarrow: '↓',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
  setminus: '∖', emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  wedge: '∧', vee: '∨', infty: '∞', partial: '∂', nabla: '∇', angle: '∠', perp: '⊥', parallel: '∥',
  mid: '∣', prime: '′', cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱', degree: '°',
  int: '∫', iint: '∬', iiint: '∭', oint: '∮', sum: '∑', prod: '∏', coprod: '∐', bigcup: '⋃', bigcap: '⋂',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', vert: '|', Vert: '‖',
  hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', therefore: '∴', because: '∵',
};

/** 这几个画得大一号（积分号、求和号……），上下限照上下标排在右边。 */
const BIG = new Set(['∫', '∬', '∭', '∮', '∑', '∏', '∐', '⋃', '⋂']);

/** 函数名：直立，不斜。 */
const FUNCTIONS = new Set([
  'lim', 'limsup', 'liminf', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh',
  'tanh', 'coth', 'ln', 'lg', 'log', 'exp', 'max', 'min', 'sup', 'inf', 'det', 'deg', 'dim', 'gcd', 'ker', 'arg',
  'Pr', 'rank', 'tr', 'span', 'mod',
]);

/** 只管大小、不出字的命令：跳过，后面跟着的括号照常写。 */
const SIZERS = new Set(['left', 'right', 'middle', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr',
  'biggl', 'biggr', 'Biggl', 'Biggr', 'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits']);

/** 字体命令：里面的东西直立写（\mathbb 的几个常见字母换成双线体）。 */
const UPRIGHT = new Set(['mathrm', 'text', 'textrm', 'textbf', 'textit', 'operatorname', 'mathbf', 'mathsf',
  'mathtt', 'boldsymbol', 'bm', 'mathbb', 'mathcal', 'mathscr', 'mathfrak', 'mbox']);
const BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', E: '𝔼' };

/** 空白命令：多宽（em）。 */
const SPACES = { ',': 0.17, ':': 0.22, ';': 0.28, ' ': 0.25, quad: 1, qquad: 2, '!': -0.1, enspace: 0.5, thinspace: 0.17 };

/** 修饰：画在上面（或下面）的那一笔。 */
const ACCENTS = { overline: 'bar', bar: 'bar', hat: 'hat', widehat: 'hat', vec: 'vec', overrightarrow: 'vec',
  dot: 'dot', ddot: 'ddot', tilde: 'tilde', widetilde: 'tilde', underline: 'under' };

/** 两边要空一点的：关系符空得多，运算符空得少。 */
const RELATIONS = new Set(['=', '<', '>', '≤', '≥', '≠', '≈', '≡', '∼', '≃', '≅', '∝', '→', '←', '⇒', '⇐', '⇔',
  '↔', '↦', '∈', '∉', '∋', '⊂', '⊆', '⊃', '⊇', '∣', '≪', '≫']);
const BINARY = new Set(['+', '−', '×', '·', '÷', '±', '∓', '∪', '∩', '∖', '∧', '∨', '∘', '∗']);

// ── 拆词 ─────────────────────────────────────────────────────────────────────

export function tokenize(src) {
  const tokens = [];
  const s = String(src || '');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      let j = i + 1;
      if (j < s.length && /[A-Za-z]/.test(s[j])) {
        while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
        tokens.push({ t: 'cmd', v: s.slice(i + 1, j) });
        i = j;
      } else {
        tokens.push({ t: 'cmd', v: s[j] ?? '' });
        i = j + 1;
      }
      continue;
    }
    if (c === '{' || c === '}' || c === '^' || c === '_') { tokens.push({ t: c }); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i));
    tokens.push({ t: 'ch', v: ch });
    i += ch.length;
  }
  return tokens;
}

// ── 分析 ─────────────────────────────────────────────────────────────────────

/** LaTeX → 一棵小树。永远不抛：多出来的 }、缺的参数都当没有。 */
export function parseLatex(src) {
  const tokens = tokenize(src);
  let pos = 0;

  const sym = (text, italic = false) => ({ type: 'sym', text, italic });

  function arg() {
    const tk = tokens[pos];
    if (!tk) return { type: 'row', items: [] };
    if (tk.t === '{') {
      pos++;
      return row(true);
    }
    return atom() || { type: 'row', items: [] };
  }

  function optionalBracket() {
    if (tokens[pos]?.t !== 'ch' || tokens[pos].v !== '[') return null;
    pos++;
    const items = [];
    while (pos < tokens.length && !(tokens[pos].t === 'ch' && tokens[pos].v === ']')) {
      const a = atom();
      if (a) items.push(a);
    }
    pos++; // ]
    return { type: 'row', items };
  }

  function atom() {
    const tk = tokens[pos++];
    if (!tk) return null;
    if (tk.t === 'ch') {
      if (tk.v === '-') return sym('−');
      if (tk.v === '*') return sym('∗');
      if (tk.v === "'") return sym('′');
      return sym(tk.v, /^[A-Za-z]$/.test(tk.v));
    }
    if (tk.t === '{') return row(true);
    if (tk.t === '}' || tk.t === '^' || tk.t === '_') return null;
    const name = tk.v;
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const num = arg();
      const den = arg();
      return { type: 'frac', num, den };
    }
    if (name === 'binom') {
      const top = arg();
      const bottom = arg();
      return { type: 'row', items: [sym('('), { type: 'frac', num: top, den: bottom, noBar: true }, sym(')')] };
    }
    if (name === 'sqrt') {
      const index = optionalBracket();
      return { type: 'sqrt', body: arg(), index };
    }
    if (UPRIGHT.has(name)) {
      const body = arg();
      return { type: 'row', items: upright(body, name === 'mathbb') };
    }
    if (ACCENTS[name]) return { type: 'accent', mark: ACCENTS[name], body: arg() };
    if (SIZERS.has(name)) return { type: 'row', items: [] };
    if (Object.prototype.hasOwnProperty.call(SPACES, name)) return { type: 'space', w: SPACES[name] };
    if (FUNCTIONS.has(name)) return { ...sym(name, false), fn: true };
    if (SYMBOLS[name]) return sym(SYMBOLS[name]);
    if (name === '\\') return { type: 'space', w: 0.5 };
    if (name === '{' || name === '}' || name === '|' || name === '%' || name === '$' || name === '#' || name === '&' || name === '_') {
      return sym(name === '|' ? '‖' : name);
    }
    // 认不得：照名字写出来。
    return sym(name, false);
  }

  /** 字体命令里面的东西：直立；\mathbb 的几个常见字母换成双线体。 */
  function upright(node, blackboard) {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (n.type === 'row') { n.items.forEach(walk); return; }
      if (n.type === 'sym') {
        out.push({ ...n, italic: false, text: blackboard && BLACKBOARD[n.text] ? BLACKBOARD[n.text] : n.text });
        return;
      }
      out.push(n);
    };
    walk(node);
    return out;
  }

  function row(closedByBrace) {
    const items = [];
    while (pos < tokens.length) {
      const tk = tokens[pos];
      if (tk.t === '}') {
        pos++;
        if (closedByBrace) break;
        continue; // 多出来的 }：跳过
      }
      if (tk.t === '^' || tk.t === '_') {
        pos++;
        const script = arg();
        let base = items.pop();
        if (!base) base = { type: 'row', items: [] };
        if (base.type !== 'scripts') base = { type: 'scripts', base, sup: null, sub: null };
        if (tk.t === '^') base.sup = script;
        else base.sub = script;
        items.push(base);
        continue;
      }
      const a = atom();
      if (a) items.push(a);
    }
    return { type: 'row', items };
  }

  return row(false);
}

// ── 排版 ─────────────────────────────────────────────────────────────────────

const shift = (ops, dx, dy) => ops.map((op) => {
  if (op.type === 'path') return { ...op, points: op.points.map(([x, y]) => [x + dx, y + dy]) };
  return { ...op, x: op.x + dx, y: op.y + dy };
});

/**
 * 一棵树排成一个盒子。
 * @param {Object} node parseLatex 给的
 * @param {number} size 字号（em）
 * @param {function(string, number, boolean): number} measure 一串字在这个字号下多宽（em）
 */
export function layoutNode(node, size, measure) {
  if (!node) return { w: 0, a: 0, d: 0, ops: [] };
  switch (node.type) {
    case 'sym': {
      const big = BIG.has(node.text);
      const s = big ? size * 1.35 : size;
      const w = measure(node.text, s, node.italic) + (node.italic ? 0.04 * s : 0);
      return { w, a: 0.72 * s, d: big ? 0.3 * s : 0.22 * s, ops: [{ type: 'text', x: 0, y: big ? 0.1 * s : 0, size: s, text: node.text, italic: node.italic }], big, text: node.text };
    }
    case 'space':
      return { w: node.w * size, a: 0, d: 0, ops: [] };
    case 'row':
      return layoutRow(node.items, size, measure);
    case 'scripts': {
      const base = layoutNode(node.base, size, measure);
      const sup = node.sup ? layoutNode(node.sup, size * 0.7, measure) : null;
      const sub = node.sub ? layoutNode(node.sub, size * 0.7, measure) : null;
      const ops = [...base.ops];
      const x = base.w + 0.04 * size;
      let a = base.a;
      let d = base.d;
      if (sup) {
        const up = Math.max(0.42 * size, base.a - 0.38 * size);
        ops.push(...shift(sup.ops, x, -up));
        a = Math.max(a, up + sup.a);
      }
      if (sub) {
        const down = Math.max(0.22 * size, base.d + (base.big ? 0.05 * size : 0));
        ops.push(...shift(sub.ops, x, down));
        d = Math.max(d, down + sub.d);
      }
      return { w: x + Math.max(sup?.w || 0, sub?.w || 0) + 0.04 * size, a, d, ops };
    }
    case 'frac': {
      const s = size * 0.85;
      const num = layoutNode(node.num, s, measure);
      const den = layoutNode(node.den, s, measure);
      const w = Math.max(num.w, den.w) + 0.24 * size;
      const axis = 0.26 * size;
      const t = 0.055 * size;
      const pad = 0.12 * size;
      const numBase = -(axis + t / 2 + pad + num.d);
      const denBase = -axis + t / 2 + pad + den.a;
      const ops = [
        ...shift(num.ops, (w - num.w) / 2, numBase),
        ...shift(den.ops, (w - den.w) / 2, denBase),
      ];
      if (!node.noBar) ops.push({ type: 'rule', x: 0.06 * size, y: -axis - t / 2, w: w - 0.12 * size, h: t });
      return { w, a: -numBase + num.a, d: denBase + den.d, ops };
    }
    case 'sqrt': {
      const body = layoutNode(node.body, size, measure);
      const gap = 0.1 * size;
      const t = 0.055 * size;
      const rw = 0.55 * size;
      const top = body.a + gap;
      const ops = [
        { type: 'path', width: t, points: [
          [0, -0.3 * top], [0.22 * rw, -0.42 * top], [0.55 * rw, body.d], [rw, -top],
          [rw + body.w + 0.12 * size, -top],
        ] },
        ...shift(body.ops, rw + 0.06 * size, 0),
      ];
      let a = top + t;
      if (node.index && node.index.items?.length) {
        const index = layoutNode(node.index, size * 0.55, measure);
        ops.push(...shift(index.ops, 0, -0.45 * top));
        a = Math.max(a, 0.45 * top + index.a);
      }
      return { w: rw + body.w + 0.18 * size, a, d: body.d, ops };
    }
    case 'accent': {
      const body = layoutNode(node.body, size, measure);
      const ops = [...body.ops];
      const y = -(body.a + 0.1 * size);
      const t = 0.05 * size;
      const mid = body.w / 2;
      let a = body.a + 0.22 * size;
      let d = body.d;
      switch (node.mark) {
        case 'bar': ops.push({ type: 'path', width: t, points: [[0.04 * size, y], [body.w - 0.04 * size, y]] }); break;
        case 'hat': ops.push({ type: 'path', width: t, points: [[mid - 0.16 * size, y + 0.06 * size], [mid, y - 0.06 * size], [mid + 0.16 * size, y + 0.06 * size]] }); break;
        case 'vec': ops.push({ type: 'path', width: t, points: [[0.02 * size, y], [body.w, y]] },
          { type: 'path', width: t, points: [[body.w - 0.12 * size, y - 0.08 * size], [body.w, y], [body.w - 0.12 * size, y + 0.08 * size]] }); break;
        case 'dot': ops.push({ type: 'path', width: t * 1.6, points: [[mid, y]] }); break;
        case 'ddot': ops.push({ type: 'path', width: t * 1.6, points: [[mid - 0.1 * size, y]] }, { type: 'path', width: t * 1.6, points: [[mid + 0.1 * size, y]] }); break;
        case 'tilde': ops.push({ type: 'path', width: t, points: [[mid - 0.18 * size, y + 0.03 * size], [mid - 0.06 * size, y - 0.05 * size], [mid + 0.06 * size, y + 0.03 * size], [mid + 0.18 * size, y - 0.05 * size]] }); break;
        case 'under':
          ops.push({ type: 'path', width: t, points: [[0.04 * size, body.d + 0.1 * size], [body.w - 0.04 * size, body.d + 0.1 * size]] });
          a = body.a;
          d = body.d + 0.16 * size;
          break;
        default: break;
      }
      return { w: body.w, a, d, ops };
    }
    default:
      return { w: 0, a: 0, d: 0, ops: [] };
  }
}

/** 函数名（sin、lim……），带不带上下标都算。 */
const isFunction = (node) => (node?.type === 'scripts' ? isFunction(node.base) : !!(node?.type === 'sym' && node.fn));

/** 函数名后面跟着这些就不空：括号、标点（关系符、运算符另外判，它们自己会空）。 */
const NO_SPACE_AFTER_FUNCTION = new Set(['(', '[', '{', '|', '⟨', '⌊', '⌈', ',', '.', ';', ':', '!', '?', ')', ']', '}']);

function layoutRow(items, size, measure) {
  let x = 0;
  let a = 0;
  let d = 0;
  const ops = [];
  items.forEach((item, i) => {
    const box = layoutNode(item, size, measure);
    const text = item.type === 'sym' ? item.text : null;
    // 关系符两边空得多；运算符在一排开头是正负号，不空。
    let margin = 0;
    if (text && RELATIONS.has(text)) margin = 0.26 * size;
    else if (text && BINARY.has(text) && i > 0) margin = 0.18 * size;
    // 函数名和它的自变量之间一个细空：sin x 不写成「sinx」。
    let after = 0;
    const next = items[i + 1];
    if (isFunction(item) && next && next.type !== 'space') {
      const nextText = next.type === 'sym' ? next.text : null;
      const tight = nextText && (RELATIONS.has(nextText) || BINARY.has(nextText) || NO_SPACE_AFTER_FUNCTION.has(nextText));
      if (!tight) after = 0.17 * size;
    }
    x += margin;
    ops.push(...shift(box.ops, x, 0));
    x += box.w + margin + after;
    a = Math.max(a, box.a);
    d = Math.max(d, box.d);
  });
  return { w: x, a, d, ops };
}

/** 一个公式：LaTeX → 盒子。 */
export function layoutLatex(latex, measure, size = 1) {
  return layoutNode(parseLatex(latex), size, measure);
}

/** 一段文字：照原样一行，直立。 */
export function layoutText(text, measure, size = 1) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { w: 0, a: 0, d: 0, ops: [] };
  return { w: measure(clean, size, false), a: 0.8 * size, d: 0.22 * size, ops: [{ type: 'text', x: 0, y: 0, size, text: clean, italic: false }] };
}
