// PDF Module — 使用手册。
//
// 装完软件第一次打开，书架上一本书都没有。那正是最该有人说一句话的时候，而原来
// 那一句是「书架上还没有书」——它说的是现状，不是该怎么办。
//
// 所以手册自己就摆在书架上，永远是第一本：不用导入，不占存储，删不掉，也不会因为
// 书多了就被挤到后面去。人找它的时候会去文档库找，而不是去设置里翻。
//
// 它按「用一遍」的顺序分成五章：开始（把书放进来、摆开）、写与改、读与对答案、整
// 理、收尾（导出、全部关闭、把顶栏和菜单栏收起来）。顶上一排章节标签，点一下跳过
// 去——十五节从头滑到尾太长了，人多半是回来查某一件事的。
//
// 图是画出来的，不是截出来的。截图只能是某一种语言的，而这个软件有三种；截图还会
// 随着界面改动慢慢变成谎话。这里的图是一组 SVG，画的是这个软件自己的样子——两栏、
// 那条工具栏、套索圈完之后蹦出来的那一条——字一个都不写在图里，全在图外面的文字
// 里，所以换语言时图不用动，长句子也不会把图挤破。
//
// 文案全部走 t()，语言一换整页重画。

import { onLangChange, t } from '../core/i18n.js';

/** 书架上那一格用的 id。以双下划线开头，和库里那些 pdf_/pad_ 的 id 不会撞。 */
export const GUIDE_ID = '__guide__';

// ── 图 ────────────────────────────────────────────────────────────────────
//
// 每张图都是 360×200 的 viewBox，靠 CSS 缩放。颜色用变量，跟着主题走；纸是浅
// 灰、墨是强调色，和真界面一致。

const PAPER = 'var(--guide-paper)';
const LINE = 'var(--guide-line)';
const INK = 'var(--accent)';
const DIM = 'var(--guide-dim)';
const RED = 'var(--guide-red)';
const GREEN = 'var(--guide-green)';
const CHIP = 'var(--guide-chip)';

/** 一张纸，带几行字的意思。 */
function sheet(x, y, w, h, { lines = 4, mark = null } = {}) {
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"
    fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>`;
  const gap = (h - 24) / (lines + 1);
  for (let i = 1; i <= lines; i++) {
    const ly = y + 12 + gap * i;
    const lw = (w - 24) * (i % 3 === 0 ? 0.55 : 0.82);
    out += `<rect x="${x + 12}" y="${ly}" width="${lw}" height="3" rx="1.5" fill="${LINE}"/>`;
  }
  if (mark) out += mark;
  return out;
}

/** 手写的一笔。 */
function stroke(d, { color = INK, width = 3.4 } = {}) {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"
    stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** 一枚线条图标那样的箭头、勾、叉——和界面上那套图标同一种画法。 */
function glyph(d, { color = DIM, width = 2.2 } = {}) {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"
    stroke-linecap="round" stroke-linejoin="round"/>`;
}

function svg(inner) {
  return `<svg class="guide-figure" viewBox="0 0 360 200" role="img" aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

/** 书架：三本书一排，最后一格是「＋」；上面一枚往下的箭头——从本机拿进来。 */
function figureLibrary() {
  const book = (x, tint) => `
    <rect x="${x}" y="70" width="58" height="82" rx="4" fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="${x}" y="70" width="7" height="82" rx="2" fill="${tint}" opacity="0.5"/>
    <rect x="${x + 16}" y="90" width="32" height="4" rx="2" fill="${LINE}"/>
    <rect x="${x + 16}" y="100" width="22" height="4" rx="2" fill="${LINE}"/>`;
  return svg(`
    ${book(30, INK)}
    ${book(102, RED)}
    ${book(174, GREEN)}
    <rect x="246" y="70" width="58" height="82" rx="10" fill="none" stroke="${DIM}"
      stroke-width="1.5" stroke-dasharray="5 5"/>
    ${glyph('M275 99v24M263 111h24', { color: INK, width: 2.6 })}
    <circle cx="275" cy="36" r="17" fill="${CHIP}" stroke="${LINE}" stroke-width="1.5"/>
    ${glyph('M275 27v14M269 35l6 6 6-6', { color: INK })}
    <path d="M22 166h316" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/>
  `);
}

/** 两栏并排，中间一条能拖的线。 */
function figurePanes() {
  return svg(`
    ${sheet(18, 24, 150, 152, { lines: 5 })}
    ${sheet(192, 24, 150, 152, { lines: 5 })}
    <rect x="176" y="24" width="8" height="152" rx="4" fill="${LINE}" opacity="0.5"/>
    <rect x="177.5" y="84" width="5" height="32" rx="2.5" fill="${DIM}"/>
    ${stroke('M44 86 q22 -16 40 2 t38 -4', { width: 3 })}
    ${stroke('M218 120 q20 14 40 -2', { color: RED, width: 3 })}
  `);
}

/** 同一本书开在两栏：两页一模一样，一笔下去两边都有。 */
function figureSameBook() {
  return svg(`
    ${sheet(18, 24, 150, 152, { lines: 4 })}
    ${sheet(192, 24, 150, 152, { lines: 4 })}
    ${stroke('M44 74 q20 -14 38 0 t38 0', { width: 3 })}
    ${stroke('M218 74 q20 -14 38 0 t38 0', { width: 3 })}
    ${stroke('M52 122 q26 18 52 -4', { color: RED, width: 3.6 })}
    ${stroke('M226 122 q26 18 52 -4', { color: RED, width: 3.6 })}
    <path d="M168 148 h24" stroke="${DIM}" stroke-width="1.5" stroke-dasharray="3 3"/>
    <circle cx="180" cy="148" r="9" fill="${CHIP}" stroke="${DIM}" stroke-width="1.5"/>
    <path d="M176 148 h8 M181 145 l3 3 -3 3" stroke="${DIM}" stroke-width="1.6"
      fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  `);
}

/** 一栏里叠着一摞：后面那几本露出一截，栏头一条写着第几本，两头是上下两个箭头。 */
function figureDeck() {
  return svg(`
    ${sheet(74, 52, 212, 128, { lines: 3 })}
    <rect x="82" y="42" width="196" height="12" rx="5"
      fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="90" y="32" width="180" height="12" rx="5"
      fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    ${stroke('M108 116 q26 -20 48 2 t46 -6', { width: 3.2 })}
    <rect x="112" y="8" width="136" height="24" rx="12"
      fill="${CHIP}" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="140" y="17" width="34" height="6" rx="3" fill="${DIM}"/>
    <rect x="182" y="17" width="10" height="6" rx="3" fill="${INK}"/>
    <rect x="198" y="17" width="20" height="6" rx="3" fill="${DIM}"/>
    ${glyph('M122 24 l6 -7 6 7', { color: INK })}
    ${glyph('M228 16 l6 7 6 -7', { color: INK })}
  `);
}

/** 贴在边上的那条笔迹工具栏；旁边一颗收进角里的小球。 */
function figureInk() {
  let bar = `<rect x="18" y="18" width="46" height="164" rx="23"
    fill="${CHIP}" stroke="${LINE}" stroke-width="1.5"/>`;
  for (let i = 0; i < 6; i++) {
    const y = 30 + i * 20;
    const on = i === 0;
    bar += `<rect x="28" y="${y}" width="26" height="15" rx="7.5"
      fill="${on ? INK : 'transparent'}" opacity="${on ? 0.18 : 1}"/>`;
    bar += `<rect x="32" y="${y + 5}" width="18" height="4" rx="2"
      fill="${on ? INK : DIM}"/>`;
  }
  const dots = ['var(--guide-dot1)', RED, INK, GREEN];
  dots.forEach((c, i) => {
    bar += `<circle cx="${28 + i * 9}" cy="162" r="4" fill="${c}"/>`;
  });
  return svg(`
    ${sheet(80, 24, 262, 152, { lines: 5 })}
    ${bar}
    ${stroke('M112 92 q28 -22 52 4 t54 -8 t52 6', { width: 3.4 })}
    <circle cx="318" cy="156" r="14" fill="${CHIP}" stroke="${LINE}" stroke-width="1.5"/>
    <circle cx="318" cy="156" r="5" fill="${INK}" opacity="0.8"/>
  `);
}

/** 套索圈完，线旁边蹦出来的那一条。 */
function figureLasso() {
  const bar = `
    <rect x="112" y="132" width="136" height="34" rx="17"
      fill="${CHIP}" stroke="${LINE}" stroke-width="1.5"/>
    ${[0, 1, 2, 3].map(i => `
      <rect x="${128 + i * 32}" y="143" width="18" height="12" rx="4"
        fill="${i === 3 ? RED : DIM}" opacity="0.75"/>`).join('')}`;
  return svg(`
    ${sheet(18, 16, 324, 168, { lines: 6 })}
    ${stroke('M120 74 q26 -20 50 2 t48 -6', { width: 3.4 })}
    <path d="M104 72 q-8 -34 34 -38 q46 -6 88 4 q26 6 18 34 q-6 24 -40 26
             q-48 4 -84 -4 q-16 -4 -16 -22 z"
      fill="${INK}" fill-opacity="0.07" stroke="${INK}" stroke-width="2"
      stroke-dasharray="7 6" stroke-linejoin="round"/>
    ${bar}
  `);
}

/** 形状：一个填了色的圆、一个选中的三角形（顶点上亮着圆点）、一个方块。 */
function figureShapes() {
  const handles = [[178, 146], [222, 60], [266, 146]]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="#fff" stroke="${INK}" stroke-width="2"/>`)
    .join('');
  return svg(`
    <rect x="18" y="16" width="324" height="168" rx="6" fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    <circle cx="92" cy="102" r="42" fill="${INK}" fill-opacity="0.14" stroke="${INK}" stroke-width="3"/>
    <path d="M178 146 L222 60 L266 146 Z" fill="none" stroke="${RED}" stroke-width="3"
      stroke-linejoin="round"/>
    ${handles}
    <rect x="286" y="70" width="40" height="64" rx="3" fill="${GREEN}" fill-opacity="0.14"
      stroke="${GREEN}" stroke-width="3"/>
  `);
}

/** 草稿纸：格子铺满，边上淡出去，意思是没有边；旁边一本一页一页的笔记本。 */
function figurePad() {
  let grid = '';
  for (let x = 10; x <= 230; x += 20) {
    grid += `<path d="M${x} 8 V192" stroke="${LINE}" stroke-width="1"/>`;
  }
  for (let y = 8; y <= 192; y += 20) {
    grid += `<path d="M10 ${y} H230" stroke="${LINE}" stroke-width="1"/>`;
  }
  return svg(`
    <defs>
      <radialGradient id="guideFade" cx="50%" cy="50%" r="62%">
        <stop offset="55%" stop-color="#fff" stop-opacity="1"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
      <mask id="guideMask">
        <rect x="0" y="0" width="240" height="200" fill="url(#guideFade)"/>
      </mask>
    </defs>
    <rect x="10" y="8" width="220" height="184" rx="10" fill="${PAPER}"/>
    <g mask="url(#guideMask)">${grid}</g>
    ${stroke('M60 128 q18 -56 40 -54 q20 2 10 34 q-10 32 8 34 q22 2 40 -44', { width: 3.4 })}
    <rect x="258" y="40" width="84" height="120" rx="6" fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="252" y="46" width="84" height="120" rx="6" fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="252" y="46" width="10" height="120" rx="3" fill="${INK}" opacity="0.25"/>
    ${[70, 88, 106, 124].map((y) => `<path d="M272 ${y} h52" stroke="${LINE}" stroke-width="1.5"/>`).join('')}
  `);
}

/** 页码、缩放比例牌、书签带。 */
function figurePage() {
  return svg(`
    ${sheet(60, 16, 240, 168, { lines: 6 })}
    <rect x="96" y="4" width="82" height="26" rx="13"
      fill="${CHIP}" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="108" y="14" width="14" height="6" rx="3" fill="${DIM}"/>
    <rect x="128" y="14" width="22" height="6" rx="3" fill="${INK}"/>
    <rect x="156" y="14" width="12" height="6" rx="3" fill="${DIM}"/>
    <path d="M252 16 h26 v42 l-13 -11 -13 11 z" fill="${INK}" opacity="0.85"/>
    <rect x="140" y="86" width="82" height="34" rx="17" fill="var(--guide-badge)"/>
    <rect x="156" y="99" width="50" height="8" rx="4" fill="#fff" opacity="0.92"/>
  `);
}

/** 对答案：左边练习册上圈出一题，一道虚线牵到右边答案册里亮起来的那一段。 */
function figureAnswers() {
  return svg(`
    ${sheet(18, 18, 150, 152, { lines: 5 })}
    ${sheet(192, 18, 150, 152, { lines: 5 })}
    <rect x="26" y="56" width="52" height="18" rx="9" fill="${INK}" opacity="0.16"/>
    <rect x="200" y="92" width="134" height="36" rx="9" fill="${GREEN}" fill-opacity="0.14"
      stroke="${GREEN}" stroke-width="1.5"/>
    <path d="M80 65 C 132 65, 148 110, 194 110" stroke="${DIM}" stroke-width="2" fill="none"
      stroke-dasharray="4 4" stroke-linecap="round"/>
    ${glyph('M188 104 l7 6 -7 6', { width: 2 })}
    <rect x="104" y="158" width="66" height="26" rx="13" fill="${INK}"/>
    ${glyph('M127 171 l5 5 9 -10', { color: '#fff', width: 2.4 })}
  `);
}

/**
 * 组合：左边是摆好的两栏，右边是它在书架上变成的那一格。
 *
 * 那一格照着真的组合封面画——一格里并排两个小页面，角上一枚牌子——而两栏里那两
 * 笔在小页面上原样出现一遍：存下来的是「这一套摆法」，不是一张截图。牌子上不写
 * 字，理由见文件开头：图里一个字都不写。
 */
function figureCombo() {
  const miniLines = (x) => [73, 93, 113, 133].map((y, i) => `
    <rect x="${x + 6}" y="${y}" width="${i === 2 ? 16.5 : 24.6}" height="2.5"
      rx="1.25" fill="${LINE}"/>`).join('');
  return svg(`
    ${sheet(16, 38, 76, 124, { lines: 4 })}
    ${sheet(104, 38, 76, 124, { lines: 4 })}
    <rect x="94" y="38" width="8" height="124" rx="4" fill="${LINE}" opacity="0.5"/>
    ${stroke('M28 90 q12 -10 24 0 t24 -2', { width: 3 })}
    ${stroke('M116 122 q14 10 30 -2', { color: RED, width: 3 })}
    ${glyph('M192 100 h28 M213 93 l7 7 -7 7')}
    <rect x="234" y="22" width="110" height="156" rx="8"
      fill="${CHIP}" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="244" y="40" width="42" height="126" rx="4"
      fill="${PAPER}" stroke="${LINE}" stroke-width="1.2"/>
    <rect x="292" y="40" width="42" height="126" rx="4"
      fill="${PAPER}" stroke="${LINE}" stroke-width="1.2"/>
    ${miniLines(244)}
    ${miniLines(292)}
    ${stroke('M251 93 q6.6 -5.5 13.2 0 t13.2 -1.1', { width: 2.2 })}
    ${stroke('M299 126 q7.7 5.5 16.6 -1.1', { color: RED, width: 2.2 })}
    <rect x="240" y="27" width="26" height="9" rx="4.5" fill="${INK}" opacity="0.85"/>
  `);
}

/**
 * 文件夹：外面一本书，角上那个 ⋯；一道虚线把它引进文件夹，文件夹里已经插着一本。
 *
 * 文件夹画成书架上那个样子——后片带一条翻起来的标签，前片亮一档——这样人在手册
 * 里见过它，回到书架上一眼就认得出来。
 */
function figureFolder() {
  return svg(`
    ${sheet(22, 56, 78, 108, { lines: 4 })}
    ${stroke('M36 128 q12 -9 22 0 t22 -2', { width: 2.6 })}
    <circle cx="82" cy="66" r="1.8" fill="${DIM}"/>
    <circle cx="88" cy="66" r="1.8" fill="${DIM}"/>
    <circle cx="94" cy="66" r="1.8" fill="${DIM}"/>
    <path d="M104 52 q36 -40 72 18" stroke="${DIM}" stroke-width="2"
      stroke-dasharray="4 4" fill="none" stroke-linecap="round"/>
    <path d="M175.7 61 L176 70 L168.1 65.8" stroke="${DIM}" stroke-width="2"
      fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M150 72 a8 8 0 0 1 8 -8 h40 l12 14 h100 a8 8 0 0 1 8 8 v74
             a8 8 0 0 1 -8 8 h-152 a8 8 0 0 1 -8 -8 z" fill="var(--guide-gold)"/>
    <g transform="rotate(6 265 86)">${sheet(232, 40, 66, 92, { lines: 3 })}</g>
    <path d="M150 100 h168 v60 a8 8 0 0 1 -8 8 h-152 a8 8 0 0 1 -8 -8 z"
      fill="var(--guide-gold-hi)"/>
  `);
}

/** 导出：写了字的一页，一道箭头，变成一份折了角的新文件——笔迹原样在上面。 */
function figureExport() {
  return svg(`
    ${sheet(24, 26, 122, 150, { lines: 5 })}
    ${stroke('M40 88 q18 -14 34 2 t32 -4', { width: 3 })}
    ${stroke('M44 130 q16 10 32 -2', { color: RED, width: 3 })}
    ${glyph('M162 101 h36 M190 93 l8 8 -8 8')}
    <path d="M222 26 h66 l32 32 v110 a8 8 0 0 1 -8 8 h-90 a8 8 0 0 1 -8 -8 v-134 a8 8 0 0 1 8 -8 z"
      fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    <path d="M288 26 v24 a8 8 0 0 0 8 8 h24" fill="none" stroke="${LINE}" stroke-width="1.5"/>
    ${stroke('M236 92 q14 -10 26 2 t26 -4', { width: 2.6 })}
    ${stroke('M240 122 q12 8 26 -2', { color: RED, width: 2.6 })}
    <rect x="232" y="146" width="46" height="18" rx="6" fill="${RED}" opacity="0.85"/>
  `);
}

/** 全部关闭：右上角那一颗；两栏淡下去，落回书架那一道线上。 */
function figureCloseAll() {
  return svg(`
    <g opacity="0.4">
      ${sheet(18, 42, 150, 108, { lines: 4 })}
      ${sheet(192, 42, 150, 108, { lines: 4 })}
    </g>
    <rect x="232" y="8" width="110" height="26" rx="13" fill="${CHIP}" stroke="${LINE}" stroke-width="1.5"/>
    <circle cx="250" cy="21" r="7.5" fill="none" stroke="${RED}" stroke-width="1.8"/>
    ${glyph('M247 18 l6 6 M253 18 l-6 6', { color: RED, width: 1.8 })}
    <rect x="266" y="18" width="62" height="6" rx="3" fill="${DIM}"/>
    ${glyph('M93 158 v18 M86 170 l7 7 7 -7')}
    ${glyph('M267 158 v18 M260 170 l7 7 7 -7')}
    <path d="M22 190h316" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/>
  `);
}

/** 收起顶栏和菜单栏：一块屏幕，顶上那一排往上走、底下菜单栏往下走，留下一根小横条。 */
/**
 * 收起顶上那一排：左、中、右三枚胶囊一起往上走（中间那枚是「练习 / 设置」，
 * 当前那一格淡淡一块主题色）。底下什么都没有——底边整条是纸。
 */
function figureChrome() {
  return svg(`
    <rect x="40" y="10" width="280" height="180" rx="18" fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="54" y="22" width="84" height="18" rx="9" fill="${CHIP}" stroke="${LINE}" stroke-width="1.2" opacity="0.7"/>
    <rect x="152" y="22" width="56" height="18" rx="9" fill="${CHIP}" stroke="${LINE}" stroke-width="1.2" opacity="0.7"/>
    <rect x="156" y="25" width="24" height="12" rx="6" fill="${INK}" opacity="0.22"/>
    <rect x="274" y="22" width="32" height="18" rx="9" fill="${CHIP}" stroke="${LINE}" stroke-width="1.2" opacity="0.7"/>
    ${glyph('M180 72 v-20 M173 59 l7 -7 7 7', { color: INK })}
    ${[96, 112, 128, 144, 160].map((y, i) => `<rect x="70" y="${y}" width="${i === 2 ? 130 : 220}" height="4" rx="2" fill="${LINE}"/>`).join('')}
  `);
}

/**
 * 手册的五章，按「用一遍」的顺序。
 *
 * 开始：把书放进来、摆开。写与改：工具栏、套索、形状、纸。读与对答案：翻页和这个
 * 应用最初为之而写的那件事。整理：组合和文件夹，东西多起来之后才用得着。收尾：导
 * 出、全部关闭、把顶上那一排收起来。
 */
const CHAPTERS = ['start', 'write', 'read', 'organize', 'finish'];

/** 手册的正文：每一节一件事。 */
const SECTIONS = [
  { key: 'library', figure: figureLibrary, chapter: 'start' },
  { key: 'panes', figure: figurePanes, chapter: 'start' },
  { key: 'deck', figure: figureDeck, chapter: 'start' },
  { key: 'same', figure: figureSameBook, chapter: 'start' },
  { key: 'ink', figure: figureInk, chapter: 'write' },
  { key: 'lasso', figure: figureLasso, chapter: 'write' },
  { key: 'shapes', figure: figureShapes, chapter: 'write' },
  { key: 'pad', figure: figurePad, chapter: 'write' },
  { key: 'page', figure: figurePage, chapter: 'read' },
  { key: 'answers', figure: figureAnswers, chapter: 'read' },
  { key: 'combo', figure: figureCombo, chapter: 'organize' },
  { key: 'folder', figure: figureFolder, chapter: 'organize' },
  { key: 'export', figure: figureExport, chapter: 'finish' },
  { key: 'closeall', figure: figureCloseAll, chapter: 'finish' },
  { key: 'chrome', figure: figureChrome, chapter: 'finish' },
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function sectionHtml({ key, figure }) {
  return `
    <section class="guide-card">
      <div class="guide-card-art">${figure()}</div>
      <div class="guide-card-text">
        <h4>${escapeHtml(t(`guide.${key}.t`))}</h4>
        <p>${escapeHtml(t(`guide.${key}.a`))}</p>
        <p>${escapeHtml(t(`guide.${key}.b`))}</p>
      </div>
    </section>`;
}

function chapterHtml(chapter, index) {
  const cards = SECTIONS.filter((s) => s.chapter === chapter).map(sectionHtml).join('');
  return `
    <section class="guide-chapter" data-chapter="${chapter}">
      <h3 class="guide-chapter-title">
        <span class="guide-chapter-no" aria-hidden="true">${index + 1}</span>
        ${escapeHtml(t(`guide.chapter.${chapter}`))}
      </h3>
      <div class="guide-cards">${cards}</div>
    </section>`;
}

/**
 * 画一遍手册。
 *
 * 每次打开都重画：整页就是一串纯文本加几段写死的 SVG，重画比留着一份旧的便宜，
 * 也省得语言换了而它还留在上一种语言里。
 */
export function renderGuide(host) {
  host.innerHTML = `
    <div class="guide-head">
      <h2>${escapeHtml(t('guide.title'))}</h2>
      <p>${escapeHtml(t('guide.sub'))}</p>
      <nav class="guide-toc" aria-label="${escapeHtml(t('guide.toc'))}">
        ${CHAPTERS.map((c, i) => `
          <button type="button" class="guide-toc-chip" data-chapter="${c}">
            <span class="guide-toc-no" aria-hidden="true">${i + 1}</span>${escapeHtml(t(`guide.chapter.${c}`))}
          </button>`).join('')}
      </nav>
    </div>
    ${CHAPTERS.map(chapterHtml).join('')}
    <p class="guide-foot">${escapeHtml(t('guide.foot'))}</p>`;

  // 章节标签：点一下滑到那一章。十五节从头滑到尾太长，人多半是回来查某一件事的。
  for (const chip of host.querySelectorAll('.guide-toc-chip')) {
    chip.addEventListener('click', () => {
      const target = host.querySelector(`.guide-chapter[data-chapter="${chip.dataset.chapter}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

/**
 * 开一本手册。
 *
 * 它盖在书架上而不是顶掉书架：人是从书架进来的，看完要回得去，而书架在底下原样
 * 待着就不用重建一次（封面都还在）。
 *
 * @returns {{close: () => void}}
 */
export function openGuide(container) {
  const layer = document.createElement('div');
  layer.className = 'pdf-guide';
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.innerHTML = `
    <div class="pdf-guide-header">
      <strong data-role="guide-title"></strong>
      <button type="button" class="pdf-library-btn" data-role="guide-close"></button>
    </div>
    <div class="pdf-guide-body" data-role="guide-body" tabindex="-1"></div>`;

  const body = layer.querySelector('[data-role="guide-body"]');
  const paint = () => {
    layer.querySelector('[data-role="guide-title"]').textContent = t('guide.name');
    layer.querySelector('[data-role="guide-close"]').textContent = t('pdf.close');
    renderGuide(body);
  };
  paint();
  // 语言在别处换了，这一页跟着重画——它整页都是文案，留着旧的就是留着另一种语言。
  const offLang = onLangChange(paint);

  const close = () => {
    offLang();
    layer.remove();
  };
  layer.querySelector('[data-role="guide-close"]').addEventListener('click', close);
  // 点空白处也算关：这是一页读物，不是一个要人回答的问题。
  layer.addEventListener('click', (e) => { if (e.target === layer) close(); });

  container.appendChild(layer);
  // 不带滚动的对焦：这一页本来就该从头看起，focus() 顺手把它滚下去一截。
  body.focus({ preventScroll: true });
  return { close };
}
