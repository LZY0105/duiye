// 导出 —— 从哪儿拿东西。
//
// pdf-export.js 只会「给我字节和笔迹，还你一份 PDF」。这里负责把那些东西找齐：书
// 的原文件在文档库里，笔迹在 ink-store 里按（文档，页码）存着，本子和草稿纸的样子
// 在它们各自的记录里。纸样要画成图、加密的书要逐页画成图，这两件事要用画布，所以
// 也在这里——这是导出里唯一碰 DOM 的地方。

import { annotatedPages, loadLayer } from '../ink/ink-store.js';
import { createTransform, drawStroke } from '../ink/ink-renderer.js';
import { getDocumentBytes, openStoredDocument } from '../pdf/pdf-library.js';
import { getNotebook } from '../note/note-store.js';
import { NOTE_PAGE, openNoteDocument } from '../note/note-document.js';
import { getScratchpad, SCRATCH_PAGE } from '../scratch/scratch-store.js';
import { drawScratchBackground } from '../scratch/scratch-background.js';
import {
  createScratchStyle, effectivePattern, paperColor, PATTERNS,
} from '../scratch/scratch-style.js';
import {
  EXPORT_ERRORS,
  buildBookPdf,
  buildNotebookPdf,
  buildRasterPdf,
  buildScratchPdf,
  parseColor,
  scratchPageBox,
} from './pdf-export.js';
import { WORKER_UNAVAILABLE, buildInWorker } from './export-worker-client.js';

/** 能导出的三样东西。和摞里的 ENTRY_KINDS 同名同值，调用方可以直接拿来用。 */
export const EXPORT_KINDS = Object.freeze({ PDF: 'pdf', NOTE: 'note', SCRATCH: 'scratch' });

/** 逐页画成图时一页最多多少像素。六百万像素的 A4 大约是 190 dpi，印出来够清楚。 */
const RASTER_MAX_PIXELS = 6e6;
/** 逐页画成图时想要的清晰度：150 dpi，PDF 的一个点是 1/72 英寸。 */
const RASTER_SCALE = 150 / 72;
/** 纸样底图最多多少像素。一整张草稿纸可以很大，底图不必跟着无限大。 */
const PAPER_MAX_PIXELS = 8e6;

/** 一页上的笔迹。空的就是空数组，不是 null——调用方只管「有几笔」。 */
async function strokesOn(id, pageNumber) {
  const layer = await loadLayer(id, pageNumber);
  return layer?.getAll?.() || [];
}

/** 画布 → 某种格式的字节。 */
function canvasBytes(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    const done = (blob) => {
      if (!blob) { reject(new Error('CANVAS_ENCODE_FAILED')); return; }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    };
    if (typeof canvas.toBlob === 'function') canvas.toBlob(done, type, quality);
    else if (typeof canvas.convertToBlob === 'function') canvas.convertToBlob({ type, quality }).then(done, reject);
    else reject(new Error('CANVAS_ENCODE_FAILED'));
  });
}

/** 用完的画布立刻让出内存：一页 A4 的图有二十几兆，几百页攒着会把 WebView 撑爆。 */
function release(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * 加密的书，第 N 页画成图、叠上笔迹。
 *
 * 画页用的是屏幕上那一套（pdf.js，解得了密），叠笔迹用的也是屏幕上那一套
 * （ink-renderer 的 drawStroke）——所以导出来的这一页和人在屏幕上看到的是同一张图，
 * 铅笔的颗粒、荧光笔的叠色都在。
 */
async function rasterBookPage(doc, pageNumber, strokes) {
  const size = await doc.pageSize(pageNumber);
  const wanted = RASTER_SCALE;
  const pixels = size.width * size.height * wanted * wanted;
  const scale = pixels > RASTER_MAX_PIXELS ? wanted * Math.sqrt(RASTER_MAX_PIXELS / pixels) : wanted;
  const { canvas } = await doc.renderPage(pageNumber, scale, { drawable: true });
  try {
    if (strokes?.length) {
      const ctx = canvas.getContext('2d');
      const transform = createTransform(scale, 0, 0);
      for (const stroke of strokes) drawStroke(ctx, stroke, transform);
    }
    const jpeg = await canvasBytes(canvas, 'image/jpeg', 0.86);
    return { width: size.width, height: size.height, jpeg };
  } finally {
    release(canvas);
  }
}

/** 本子的纸：纯色就只给颜色，有格子就把一页的格子画成图（每页都一样，画一次就够）。 */
async function notePaper(record) {
  const style = createScratchStyle(record.style);
  const color = parseColor(paperColor(style));
  if (effectivePattern(style) === PATTERNS.PLAIN) return { color, png: null };
  const { canvas } = await openNoteDocument(record).renderPage(1, 2);
  try {
    return { color, png: await canvasBytes(canvas, 'image/png') };
  } finally {
    release(canvas);
  }
}

/** 草稿纸的纸：笔迹范围那一块的格子，画成一张图。 */
async function scratchPaper(record, box) {
  const style = createScratchStyle(record.style);
  const color = parseColor(paperColor(style));
  if (effectivePattern(style) === PATTERNS.PLAIN) return { color, png: null };
  const worldW = box.x1 - box.x0;
  const worldH = box.y1 - box.y0;
  const zoom = Math.max(0.25, Math.min(2, Math.sqrt(PAPER_MAX_PIXELS / (worldW * worldH))));
  const width = Math.max(1, Math.round(worldW * zoom));
  const height = Math.max(1, Math.round(worldH * zoom));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    drawScratchBackground(canvas.getContext('2d', { alpha: false }), {
      style,
      camera: { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, zoom },
      viewport: { width, height },
      dpr: 1,
    });
    return { color, png: await canvasBytes(canvas, 'image/png') };
  } finally {
    release(canvas);
  }
}

/**
 * 先交给后台线程做（export-worker.js），做不了再在主线程上照做。
 *
 * 做 PDF 是整个导出里最重的一段：一本几十上百兆的书，pdf-lib 要整份读一遍、再整份写回去。
 * 在主线程上做，平板上就是点了导出以后整个软件卡住好几秒。后台线程用不了（Node 里测、WebView
 * 加载失败）时才退回主线程——慢一点、卡一下，但照样导得出来。
 *
 * @param {string} job 'book' | 'notebook' | 'scratch'
 * @param {function(): Promise<object>} inputFor 交给后台线程的输入；退回主线程时再调一次拿
 *   新的一份（交过去的字节已经转手，原来那一份空了）
 * @param {function(object): Promise<Uint8Array>} onMain 主线程上照做
 * @param {function(object): Transferable[]} [transferOf] 输入里哪些转手不复制
 */
async function inBackground(job, inputFor, onMain, { onProgress, transferOf } = {}) {
  const input = await inputFor();
  try {
    return await buildInWorker(job, input, { onProgress, transfer: transferOf?.(input) || [] });
  } catch (error) {
    if (error?.message !== WORKER_UNAVAILABLE) throw error;
  }
  const again = transferOf ? await inputFor() : input;
  return onMain(again);
}

/** 字节背后那一块内存（ArrayBuffer 本身，或者 Uint8Array 的 buffer），转手用。 */
function bufferOf(bytes) {
  if (!bytes) return [];
  if (bytes instanceof ArrayBuffer) return [bytes];
  return bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [];
}

/**
 * 做出一份导出用的 PDF。
 *
 * @param {{kind: string, id: string}} target 导出哪一样
 * @param {{onProgress?: function({stage: string, done: number, total: number})}} [options]
 * @returns {Promise<{bytes: Uint8Array, raster: boolean}>} `raster` 为真表示走了逐页
 *   画成图那条路（加密的书）——字不能选了，调用方要告诉人
 */
export async function buildExport(target, { onProgress } = {}) {
  const { kind, id } = target || {};
  const report = (stage) => (done, total) => onProgress?.({ stage, done, total });

  if (kind === EXPORT_KINDS.NOTE) {
    const record = await getNotebook(id);
    if (!record) throw new Error(EXPORT_ERRORS.NOT_FOUND);
    // 笔迹按页先收齐：后台线程拿不到「按页去取」的函数。写过字的页才去读。
    const strokesByPage = {};
    for (const n of await annotatedPages(id)) strokesByPage[n] = await strokesOn(id, n);
    const input = {
      pageCount: record.pageCount,
      size: NOTE_PAGE,
      paper: await notePaper(record),
      strokesByPage,
    };
    const bytes = await inBackground('notebook', async () => input,
      (again) => buildNotebookPdf({
        ...again,
        strokesFor: async (n) => again.strokesByPage[n] || [],
        onProgress: report('pages'),
      }),
      { onProgress: report('pages') });
    return { bytes, raster: false };
  }

  if (kind === EXPORT_KINDS.SCRATCH) {
    const record = await getScratchpad(id);
    if (!record) throw new Error(EXPORT_ERRORS.NOT_FOUND);
    const strokes = await strokesOn(id, SCRATCH_PAGE);
    const box = scratchPageBox(strokes);
    if (!box) throw new Error(EXPORT_ERRORS.EMPTY);
    const input = { strokes, box, paper: await scratchPaper(record, box) };
    const bytes = await inBackground('scratch', async () => input, (again) => buildScratchPdf(again));
    return { bytes, raster: false };
  }

  // 书。
  const pages = [];
  for (const pageNumber of await annotatedPages(id)) {
    const strokes = await strokesOn(id, pageNumber);
    if (strokes.length) pages.push({ pageNumber, strokes });
  }
  // 原文件字节转手给后台线程（不复制：一本书几十上百兆）。退回主线程时重新读一份。
  const bookInput = async () => {
    const original = await getDocumentBytes(id);
    if (!original) throw new Error(EXPORT_ERRORS.NOT_FOUND);
    return { bytes: original, pages };
  };
  try {
    const bytes = await inBackground('book', bookInput,
      (again) => buildBookPdf({ ...again, onProgress: report('ink') }),
      { onProgress: report('ink'), transferOf: (input) => bufferOf(input.bytes) });
    return { bytes, raster: false };
  } catch (error) {
    // 加了密、或者 pdf-lib 读不懂：换逐页画成图那条路。别的错照样抛出去。
    if (error?.message !== EXPORT_ERRORS.ENCRYPTED && error?.message !== EXPORT_ERRORS.UNREADABLE) throw error;
  }

  const inkByPage = new Map(pages.map((p) => [p.pageNumber, p.strokes]));
  const doc = await openStoredDocument(id);
  try {
    const bytes = await buildRasterPdf({
      pageCount: doc.numPages,
      rasterPage: (n) => rasterBookPage(doc, n, inkByPage.get(n)),
      onProgress: report('pages'),
    });
    return { bytes, raster: true };
  } finally {
    doc.destroy?.();
  }
}
