// PDF Module — 使用说明。
//
// 装完软件第一次打开，书架上一本书都没有。那正是最该有人说一句话的时候，而原来
// 那一句是「书架上还没有书」——它说的是现状，不是该怎么办。
//
// 所以说明书自己就摆在书架上，永远是第一本：不用导入，不占存储，删不掉，也不会
// 因为书多了就被挤到后面去。人找它的时候会去文档库找，而不是去设置里翻。
//
// 图是画出来的，不是截出来的。截图只能是某一种语言的，而这个软件有五种；截图还
// 会随着界面改动慢慢变成谎话。这里的图是一组 SVG，画的是这个软件自己的样子——
// 两栏、那条工具栏、套索圈完之后蹦出来的那一条——字一个都不写在图里，全在图外面
// 的文字里，所以换语言时图不用动，长句子也不会把图挤破。
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

function svg(inner) {
  return `<svg class="guide-figure" viewBox="0 0 360 200" role="img" aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

/** 两栏并排，中间一条能拖的线。 */
function figurePanes() {
  return svg(`
    ${sheet(18, 24, 150, 152, { lines: 5 })}
    ${sheet(192, 24, 150, 152, { lines: 5 })}
    <rect x="176" y="24" width="8" height="152" rx="4" fill="${LINE}" opacity="0.5"/>
    <rect x="177.5" y="84" width="5" height="32" rx="2.5" fill="${DIM}"/>
    ${stroke('M44 86 q22 -16 40 2 t38 -4', { width: 3 })}
    ${stroke('M218 120 q20 14 40 -2', { color: 'var(--guide-red)', width: 3 })}
  `);
}

/** 同一本书开在两栏：两页一模一样，一笔下去两边都有。 */
function figureSameBook() {
  const same = 'M44 74 q20 -14 38 0 t38 0';
  return svg(`
    ${sheet(18, 24, 150, 152, { lines: 4 })}
    ${sheet(192, 24, 150, 152, { lines: 4 })}
    ${stroke(same, { width: 3 })}
    ${stroke('M218 74 q20 -14 38 0 t38 0', { width: 3 })}
    ${stroke('M52 122 q26 18 52 -4', { color: 'var(--guide-red)', width: 3.6 })}
    ${stroke('M226 122 q26 18 52 -4', { color: 'var(--guide-red)', width: 3.6 })}
    <path d="M168 148 h24" stroke="${DIM}" stroke-width="1.5" stroke-dasharray="3 3"/>
    <circle cx="180" cy="148" r="9" fill="var(--guide-chip)" stroke="${DIM}" stroke-width="1.5"/>
    <path d="M176 148 h8 M181 145 l3 3 -3 3" stroke="${DIM}" stroke-width="1.6"
      fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  `);
}

/**
 * 一栏里叠着一摞：后面那几本露出一截，栏头一条写着第几本，两头是上下两个箭头。
 */
function figureDeck() {
  return svg(`
    ${sheet(74, 52, 212, 128, { lines: 3 })}
    <rect x="82" y="42" width="196" height="12" rx="5"
      fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="90" y="32" width="180" height="12" rx="5"
      fill="${PAPER}" stroke="${LINE}" stroke-width="1.5"/>
    ${stroke('M108 116 q26 -20 48 2 t46 -6', { width: 3.2 })}
    <rect x="112" y="8" width="136" height="24" rx="12"
      fill="var(--guide-chip)" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="140" y="17" width="34" height="6" rx="3" fill="${DIM}"/>
    <rect x="182" y="17" width="10" height="6" rx="3" fill="${INK}"/>
    <rect x="198" y="17" width="20" height="6" rx="3" fill="${DIM}"/>
    <path d="M122 24 l6 -7 6 7" stroke="${INK}" stroke-width="2.2" fill="none"
      stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M228 16 l6 7 6 -7" stroke="${INK}" stroke-width="2.2" fill="none"
      stroke-linecap="round" stroke-linejoin="round"/>
  `);
}

/** 贴在边上的那条笔迹工具栏。 */
function figureInk() {
  let bar = `<rect x="18" y="18" width="46" height="164" rx="16"
    fill="var(--guide-chip)" stroke="${LINE}" stroke-width="1.5"/>`;
  for (let i = 0; i < 6; i++) {
    const y = 30 + i * 20;
    const on = i === 0;
    bar += `<rect x="28" y="${y}" width="26" height="15" rx="5"
      fill="${on ? INK : 'transparent'}" opacity="${on ? 0.18 : 1}"/>`;
    bar += `<rect x="32" y="${y + 5}" width="18" height="4" rx="2"
      fill="${on ? INK : DIM}"/>`;
  }
  const dots = ['var(--guide-dot1)', 'var(--guide-red)', INK, 'var(--guide-green)'];
  dots.forEach((c, i) => {
    bar += `<circle cx="${28 + i * 9}" cy="162" r="4" fill="${c}"/>`;
  });
  return svg(`
    ${sheet(80, 24, 262, 152, { lines: 5 })}
    ${bar}
    ${stroke('M112 92 q28 -22 52 4 t54 -8 t52 6', { width: 3.4 })}
  `);
}

/** 套索圈完，线旁边蹦出来的那一条。 */
function figureLasso() {
  const bar = `
    <rect x="112" y="132" width="136" height="34" rx="17"
      fill="var(--guide-chip)" stroke="${LINE}" stroke-width="1.5"/>
    ${[0, 1, 2, 3].map(i => `
      <rect x="${128 + i * 32}" y="143" width="18" height="12" rx="4"
        fill="${i === 3 ? 'var(--guide-red)' : DIM}" opacity="0.75"/>`).join('')}`;
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

/** 页码、缩放比例牌、书签带。 */
function figurePage() {
  return svg(`
    ${sheet(60, 16, 240, 168, { lines: 6 })}
    <rect x="96" y="4" width="82" height="26" rx="13"
      fill="var(--guide-chip)" stroke="${LINE}" stroke-width="1.5"/>
    <rect x="108" y="14" width="14" height="6" rx="3" fill="${DIM}"/>
    <rect x="128" y="14" width="22" height="6" rx="3" fill="${INK}"/>
    <rect x="156" y="14" width="12" height="6" rx="3" fill="${DIM}"/>
    <path d="M252 16 h26 v42 l-13 -11 -13 11 z" fill="${INK}" opacity="0.85"/>
    <rect x="140" y="86" width="82" height="34" rx="10" fill="var(--guide-badge)"/>
    <rect x="156" y="99" width="50" height="8" rx="4" fill="#fff" opacity="0.92"/>
  `);
}

/** 草稿纸：格子铺满，边上淡出去，意思是没有边。 */
function figurePad() {
  let grid = '';
  for (let x = 10; x <= 350; x += 20) {
    grid += `<path d="M${x} 8 V192" stroke="${LINE}" stroke-width="1"/>`;
  }
  for (let y = 8; y <= 192; y += 20) {
    grid += `<path d="M10 ${y} H350" stroke="${LINE}" stroke-width="1"/>`;
  }
  return svg(`
    <defs>
      <radialGradient id="guideFade" cx="50%" cy="50%" r="62%">
        <stop offset="55%" stop-color="#fff" stop-opacity="1"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
      <mask id="guideMask">
        <rect x="0" y="0" width="360" height="200" fill="url(#guideFade)"/>
      </mask>
    </defs>
    <rect x="10" y="8" width="340" height="184" rx="10" fill="${PAPER}"/>
    <g mask="url(#guideMask)">${grid}</g>
    ${stroke('M96 128 q18 -56 40 -54 q20 2 10 34 q-10 32 8 34 q22 2 40 -44', { width: 3.4 })}
    ${stroke('M212 92 h56 M240 70 v44', { color: 'var(--guide-red)', width: 3 })}
  `);
}

/**
 * 说明书的正文。
 *
 * 顺序是人第一次用会碰到的顺序：先看见两栏，再动笔，再动圈起来的那一片，最后才
 * 是翻页和草稿纸这些随时能发现的。
 */
const SECTIONS = [
  { key: 'panes', figure: figurePanes },
  { key: 'deck', figure: figureDeck },
  { key: 'same', figure: figureSameBook },
  { key: 'ink', figure: figureInk },
  { key: 'lasso', figure: figureLasso },
  { key: 'page', figure: figurePage },
  { key: 'pad', figure: figurePad },
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
        <h3>${escapeHtml(t(`guide.${key}.t`))}</h3>
        <p>${escapeHtml(t(`guide.${key}.a`))}</p>
        <p>${escapeHtml(t(`guide.${key}.b`))}</p>
      </div>
    </section>`;
}

/**
 * 画一遍说明书。
 *
 * 每次打开都重画：整页就是一串纯文本加几段写死的 SVG，重画比留着一份旧的便宜，
 * 也省得语言换了而它还留在上一种语言里。
 */
export function renderGuide(host) {
  host.innerHTML = `
    <div class="guide-head">
      <h2>${escapeHtml(t('guide.title'))}</h2>
      <p>${escapeHtml(t('guide.sub'))}</p>
    </div>
    <div class="guide-cards">${SECTIONS.map(sectionHtml).join('')}</div>
    <p class="guide-foot">${escapeHtml(t('guide.foot'))}</p>`;
}

/**
 * 开一本说明书。
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
