// PDF Module — 把一本书的封面画出来。
//
// 「有封面就用封面，没有就用第一页」——对 PDF 来说这两句话是同一句：PDF 没有
// 「封面」这个字段，出版社的封面就是它的第 1 页。所以这里的规则是：
//
//   PDF   → 第 1 页渲成图
//   草稿纸 → 它自己的纸：纸色和格线就是这张纸的封面，没有别的东西更像它
//
// 渲一张封面要把整份文件解出来，所以排队：一次只做一张。文档库一打开就有十
// 几本书同时要封面，十几个 pdf.js 实例同时把几百兆字节读进内存，是能把这个
// WebView 直接打死的。一张一张来，画好一张挂一张，人看到的是书一本本长出来，
// 而不是等一片空白等三秒。
//
// 画完立刻 destroy()：这个 pdf.js 句柄只为这一张图存在，留着它就等于把整本书
// 留在内存里。

import { openStoredDocument } from './pdf-library.js';
import { getScratchpad } from '../scratch/scratch-store.js';
import { drawScratchBackground } from '../scratch/scratch-background.js';
import { ORIGIN_CAMERA } from '../scratch/scratch-camera.js';
import { SHELF_KINDS } from './shelf-state.js';
import { openNoteDocument } from '../note/note-document.js';
import {
  COVER_LONG_EDGE,
  coverSignature,
  readCover,
  writeCover,
} from './cover-store.js';
import { getCombo } from './combo-store.js';
import { renderComboCover } from './combo-cover.js';
import Logger from '../core/logger.js';

/** 封面长边的像素数。书架上一本宽 168–220 CSS px，2 倍屏下 440 足够清楚。 */
// 常量住在 cover-store（那边说明了为什么）。这里转出去，是因为它本来就是从
// 这个模块导出的，外面已经有人在引。
export { COVER_LONG_EDGE };
/** 草稿纸是无限画布，封面取它原点处的一块，比例跟 A4 一样。 */
const PAD_ASPECT = 1 / 1.414;

/** 同时只渲一张。数字是 1 不是 3：每一张都要开一份完整的 PDF。 */
const CONCURRENCY = 1;

let running = 0;
const queue = [];

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    if (job.cancelled) continue;
    running += 1;
    job.run().then(job.resolve, job.reject).finally(() => {
      running -= 1;
      pump();
    });
  }
}

function enqueue(run) {
  const job = { run, cancelled: false };
  const promise = new Promise((resolve, reject) => {
    job.resolve = resolve;
    job.reject = reject;
  });
  queue.push(job);
  pump();
  return { promise, cancel: () => { job.cancelled = true; job.resolve(null); } };
}

function toBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') { resolve(null); return; }
    // JPEG，不是 PNG：封面是照片式的整页图，PNG 存它要大四五倍，而书架上一本
    // 只有两百像素宽，0.82 的 JPEG 在这个尺寸上看不出区别。
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.82);
  });
}

/** PDF 的第 1 页。 */
async function renderDocCover(id) {
  let doc = null;
  try {
    doc = await openStoredDocument(id);
    // 先按 1 倍量一次这一页有多大，再算出把长边推到 COVER_LONG_EDGE 要多少倍。
    // 直接猜一个 scale 会让 A4 和 16:9 的讲义渲出两种大小的图。
    const probe = await doc.renderPage(1, 0.2);
    const long = Math.max(probe.width, probe.height) / 0.2;
    const scale = Math.max(0.05, Math.min(3, COVER_LONG_EDGE / long));
    const { canvas } = await doc.renderPage(1, scale);
    return await toBlob(canvas);
  } finally {
    doc?.destroy?.();
  }
}

/** 笔记本的第一页。 */
async function renderNoteCover(item) {
  const doc = openNoteDocument({
    id: item.id, pageCount: item.pageCount, style: item.style,
  });
  const size = await doc.pageSize(1);
  const long = Math.max(size.width, size.height);
  const scale = Math.max(0.05, Math.min(3, COVER_LONG_EDGE / long));
  const { canvas } = await doc.renderPage(1, scale);
  return toBlob(canvas);
}

/** 草稿纸的纸。 */
async function renderPadCover(id, style) {
  const pad = style ? { style } : await getScratchpad(id);
  if (!pad) return null;
  const h = COVER_LONG_EDGE;
  const w = Math.round(h * PAD_ASPECT);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  drawScratchBackground(ctx, {
    style: pad.style,
    camera: ORIGIN_CAMERA,
    viewport: { width: w, height: h },
    dpr: 1,
  });
  return toBlob(canvas);
}

/**
 * 一本书的封面，能从缓存里拿就从缓存里拿。
 *
 * @returns {{promise: Promise<Blob|null>, cancel: () => void}}
 *   cancel 是给「人已经把文档库关了」用的：排在后面还没轮到的活直接不做。
 */
export function requestCover(item) {
  const signature = coverSignature(item);
  return enqueue(async () => {
    // 组合不走缓存，每次现画。它画的是别人的封面拼起来的版面——那些封面这一
    // 刻可能还没渲出来，缓存一张「两个空框」的图，人下次看到的还是空框。现画
    // 的代价是两次 drawImage，而它会随着别人的封面渐渐变完整。
    if (item.kind === SHELF_KINDS.COMBO) {
      const combo = getCombo(item.id);
      return combo ? renderComboCover(combo) : null;
    }
    const cached = await readCover(item.id, signature);
    if (cached) return cached;
    try {
      // 笔记本的封面就是它的第一页 —— 和一本书完全一样，因为它本来就是一份
      // 文档（见 note-document.js）。只有草稿纸要单独画，那一张纸没有页。
      const blob = item.kind === SHELF_KINDS.PAD
        ? await renderPadCover(item.id, item.style)
        : item.kind === SHELF_KINDS.NOTE
          ? await renderNoteCover(item)
          : await renderDocCover(item.id);
      if (blob) await writeCover(item.id, blob, signature);
      return blob;
    } catch (error) {
      Logger.warn('PDF', `cover failed for ${item.id}: ${error.message}`);
      return null;
    }
  });
}
