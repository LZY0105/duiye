// PDF 模块 —— 一个组合在书架上长什么样。
//
// 一本书的封面是它的第一页，一张草稿纸的封面是那张纸本身。组合没有"第一页"可
// 画——它不是一份文件，是**一套摆法**。所以这张图画的就是那套摆法：一块横着的
// 屏，按组合自己的比例切成两栏，每一栏里放那一栏当前开着的那本书的封面。
//
// 人在书架上认一个组合，靠的是"哪两本并排、怎么切"。把两张封面缩到指甲盖大小
// 拼在一起是认不出书名的，但**版面**认得出来：左宽右窄的那一套、上下分的那一
// 套、左边厚右边空的那一套。所以版面是主角，封面是填充。
//
// 这张图不进缓存，每次摊开书架现画。理由是它依赖别人的封面：书的封面可能这一
// 刻还没渲出来，缓存一张"两个空框"的图，人下次看到的还是空框。现画的代价是两
// 次 drawImage，而它自己会随着别人的封面渐渐变完整。

import { comboFacing } from './combo-state.js';
import { ENTRY_KINDS } from './deck-state.js';
import { ORIENTATIONS, SLOTS } from './workspace-state.js';
// 从 cover-store 引，不从 book-cover 引：book-cover 要引这个文件（组合的封面
// 走它那条流水线），两边互引会让先初始化的那个读到还没赋值的常量。
import { COVER_LONG_EDGE, readCover } from './cover-store.js';

/** 卡片本身是竖的，和书架上其它封面一样——它要占同一个格子。 */
const CARD_W = Math.round(COVER_LONG_EDGE * 0.72);
const CARD_H = COVER_LONG_EDGE;

/**
 * 两栏铺满整张卡，只留一圈很窄的边。
 *
 * 头一版是在卡中间画了一块横着的「屏」，四周留白。那样最忠实——它确实是一块
 * 横屏——但在书架格子里，那块屏只剩指甲盖大，两栏切在哪儿根本看不出来，而
 * **切在哪儿正是这张图要说的唯一一件事**。忠实于设备，不如忠实于那件事。
 */
const PAD = 16;
const RADIUS = 10;
const PANE_GAP = 7;

/** 没有封面可填时那一栏的底色。按类型分，好让「本子」和「书」看着不一样。 */
const FALLBACK_FILL = Object.freeze({
  [ENTRY_KINDS.PDF]: '#e8ecf3',
  [ENTRY_KINDS.NOTE]: '#f3efe4',
  [ENTRY_KINDS.SCRATCH]: '#f6f2e6',
});

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * 把一张封面按「填满并居中裁切」画进一个框。
 *
 * 不是等比缩放进去——那样两栏里会出现宽窄不一的白边，版面就读不出来了。这里要
 * 的是「那一栏里装着这本书」，所以宁可裁掉上下，也要把框填满。
 */
function drawCover(ctx, bitmap, x, y, w, h) {
  const scale = Math.max(w / bitmap.width, h / bitmap.height);
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  ctx.save();
  roundRect(ctx, x, y, w, h, RADIUS);
  ctx.clip();
  // 从顶上开始裁，不是从中间：书的第一页上半部分是书名和作者，那是最认得出的
  // 地方；居中裁会把它切掉一半。
  ctx.drawImage(bitmap, x + (w - dw) / 2, y, dw, dh);
  ctx.restore();
}

function drawEmptyPane(ctx, entry, x, y, w, h) {
  ctx.fillStyle = FALLBACK_FILL[entry?.kind] || '#eceff4';
  roundRect(ctx, x, y, w, h, RADIUS);
  ctx.fill();
  if (entry) return;
  // 真的空着的一栏：画一条淡淡的斜线，表示「这里没有东西」，而不是「这里有东
  // 西但还没画出来」。两者看着必须不一样。
  ctx.save();
  roundRect(ctx, x, y, w, h, RADIUS);
  ctx.clip();
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.10)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w, y);
  ctx.stroke();
  ctx.restore();
}

/** 能拿到就拿，拿不到回 null——这张图缺一块也画得出来。 */
async function bitmapFor(entry) {
  if (!entry?.resourceId) return null;
  try {
    // 签名传空：这里不关心那张封面新不新，只关心有没有。真要重渲是书架那一侧
    // 的事，而一张稍旧的封面比一个空框有用得多。
    const blob = await readCover(entry.resourceId, '');
    if (!blob) return null;
    return await createImageBitmap(blob);
  } catch (_) {
    return null;
  }
}

/**
 * 画一个组合的显示图。
 *
 * @param {Object} combo
 * @returns {Promise<Blob|null>}
 */
export async function renderComboCover(combo) {
  if (!combo) return null;
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  // 卡片底：一层很淡的竖向渐变，比纯白多一点厚度，又不至于和书的封面抢。
  const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
  bg.addColorStop(0, '#f7f8fb');
  bg.addColorStop(1, '#eef1f6');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const boxX = PAD;
  const boxY = PAD;
  const boxW = CARD_W - PAD * 2;
  const boxH = CARD_H - PAD * 2;

  const facing = comboFacing(combo);
  // swapped 说的是「哪一栏画在哪一边」。组合要还原的是人看到的样子，所以这里也
  // 得跟着换——不换的话，一套左右对调过的摆法在书架上看着和没调过的一样。
  const first = combo.swapped ? facing[SLOTS.SECONDARY] : facing[SLOTS.PRIMARY];
  const second = combo.swapped ? facing[SLOTS.PRIMARY] : facing[SLOTS.SECONDARY];
  // 夹一下：真实的比例可以是 0.02，而那样画出来那一栏只有两个像素宽，看着像没
  // 有。图要说的是「左宽右窄」，不是「左边 2%」。
  const ratio = Math.min(0.85, Math.max(0.15, combo.dividerRatio || 0.5));

  const column = combo.orientation === ORIENTATIONS.COLUMN;
  const firstMain = Math.round((column ? boxH : boxW) * ratio) - PANE_GAP / 2;
  const secondMain = (column ? boxH : boxW) - firstMain - PANE_GAP;

  const rects = column
    ? [[boxX, boxY, boxW, firstMain], [boxX, boxY + firstMain + PANE_GAP, boxW, secondMain]]
    : [[boxX, boxY, firstMain, boxH], [boxX + firstMain + PANE_GAP, boxY, secondMain, boxH]];

  for (const [entry, rect] of [[first, rects[0]], [second, rects[1]]]) {
    const [x, y, w, h] = rect;
    if (w < 2 || h < 2) continue;
    // 每一栏自己有一点投影，让两栏看着是两张纸并排，而不是一张纸上划了条线。
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.16)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x, y, w, h, RADIUS);
    ctx.fill();
    ctx.restore();

    const bitmap = await bitmapFor(entry);
    if (bitmap) {
      drawCover(ctx, bitmap, x, y, w, h);
      bitmap.close?.();
    } else {
      drawEmptyPane(ctx, entry, x, y, w, h);
    }

    ctx.strokeStyle = 'rgba(15, 23, 42, 0.12)';
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, RADIUS);
    ctx.stroke();
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}
