// Note Module —— 把一本笔记本装成一份文档。
//
// 这个文件的全部意思是：**笔记本不需要自己的阅读器**。
//
// PdfPane 已经会翻页、会缩放、会适合宽度/整页、会按页缓存位图、会预取前后页、会
// 把笔迹层对齐到页上、会把页码记进会话。找页面板会画缩略图，书签会记页，封面会
// 画第一页。这一整套东西问的不是「你是不是 PDF」，而是
// pdf-document.js 定下的那几个问题：几页、第 N 页多大、第 N 页长什么样、第 N 页上
// 有什么字。
//
// 所以这里就回答那几个问题，形状和 openPdfDocument 返回的一模一样。代价是零：没
// 有一行 PdfPane 的代码为笔记本改过，也就没有一条「PDF 能用而笔记本不能」的路。
//
// 页面是现画的，不是存的。一本空本子的 IndexedDB 记录只有名字、样式和页数几十个
// 字节 —— 一千页也是几十个字节。真正占地方的是写上去的笔迹，而那本来就是按页存
// 在 ink-store 里的。

import { drawScratchBackground } from '../scratch/scratch-background.js';
import { createScratchStyle } from '../scratch/scratch-style.js';
import { NO_OUTLINE } from '../pdf/pdf-extract.js';
import { PDF_ERRORS } from '../pdf/pdf-errors.js';

/**
 * 一页多大，单位和 PDF 的页面单位一样（72 dpi 的点）。
 *
 * 595 × 842 就是 A4。用和 PDF 相同的单位和相同的量级，是为了让「适合宽度」「整
 * 页」和缩放百分比在笔记本上和在书上意思完全一致 —— 100% 在两边看着一样大，人不
 * 用重新学一遍这个百分比是什么意思。
 */
export const NOTE_PAGE = Object.freeze({ width: 595, height: 842 });

/**
 * 每一页画的格子都一样，而不是接着上一页往下画。
 *
 * 真本子就是这样：每一页都是新的一页横线，不是一卷纸裁开。接着画的话，横线会在
 * 翻页处错开半格，而且第 300 页的格子相位取决于前面 299 页 —— 那是没人想要、也
 * 没人能预期的东西。
 */
function cameraForPage(scale) {
  return {
    x: NOTE_PAGE.width / 2,
    y: NOTE_PAGE.height / 2,
    zoom: scale,
  };
}

/**
 * 打开一本笔记本，得到一份 pdf-document 形状的文档。
 *
 * @param {{id: string, pageCount: number, style: object}} record note-store 的记录
 * @returns {Object} 和 openPdfDocument 相同形状
 */
export function openNoteDocument(record) {
  if (!record?.id) throw new Error(PDF_ERRORS.OPEN_FAILED);

  const numPages = Math.max(1, Math.floor(Number(record.pageCount) || 1));
  // 样式在打开时定格。面板改完样式之后是重新打开这份文档，而不是让一份已经打开的
  // 文档中途换脸 —— 否则 PdfPane 里缓存着的那些位图就是旧样式的，而它没有任何理由
  // 知道要作废它们。
  const style = createScratchStyle(record.style);

  const inRange = (pageNumber) => Number.isInteger(pageNumber)
    && pageNumber >= 1 && pageNumber <= numPages;

  return {
    numPages,

    /** 空白本子没有目录，而且绝不替它编一个。和没有书签的 PDF 是同一个答案。 */
    get outline() { return NO_OUTLINE; },
    async getOutline() { return NO_OUTLINE; },

    async pageSize(pageNumber) {
      if (!inRange(pageNumber)) throw new Error(PDF_ERRORS.PAGE_OUT_OF_RANGE);
      return { width: NOTE_PAGE.width, height: NOTE_PAGE.height };
    },

    /**
     * 画第 N 页。
     *
     * 每一页画出来都一样，所以这里不看 pageNumber ——只用它判越界。看着像可以缓存
     * 一张重复用，但不能：PdfPane 把返回的画布直接放进 DOM，两页共用一张画布就是
     * 同一张纸同时出现在两个地方。位图缓存是 PdfPane 那一层的事，它已经在做了。
     *
     * `drawable` 这里不起作用 —— 画出来的本来就是一张普通 2d 画布，谁都能接着往
     * 上画。收下它只是为了和另外两条路签名一致。
     */
    async renderPage(pageNumber, scale, _options = {}) {
      if (!inRange(pageNumber)) throw new Error(PDF_ERRORS.PAGE_OUT_OF_RANGE);
      const width = Math.max(1, Math.floor(NOTE_PAGE.width * scale));
      const height = Math.max(1, Math.floor(NOTE_PAGE.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      drawScratchBackground(context, {
        style,
        camera: cameraForPage(scale),
        viewport: { width, height },
        dpr: 1,
      });
      return { canvas, width, height };
    },

    /**
     * 本子上没有文字层。
     *
     * 这不是「还没做」，是事实：纸上只有手写的笔迹，而笔迹不是文字。所以对题引擎
     * 拿到的是一页空的，它会如实说这本书没有可用的文本 —— 比返回一串猜出来的东西
     * 让它去匹配要好得多。
     */
    async pageText(pageNumber) {
      if (!inRange(pageNumber)) throw new Error(PDF_ERRORS.PAGE_OUT_OF_RANGE);
      return { lines: [], empty: true };
    },

    async extractText() { return []; },

    destroy() { /* 没有什么要释放的：页面是现画的 */ },
  };
}

/**
 * 一本笔记本在「文档」那一侧的元数据。
 *
 * PdfPane 和它周围那些东西要的是 meta，不是 note-store 的记录。字段名照抄
 * pdf-library 的 importPdf 写进去的那份，因为消费它的是同一批代码。
 */
export function noteMeta(record) {
  if (!record?.id) return null;
  return {
    id: record.id,
    name: record.name || '',
    fileName: '',
    // 真的是 0。一本空本子不占存储，把它算进「文档库用了多少空间」是在说谎。
    sizeBytes: 0,
    pageCount: Math.max(1, Math.floor(Number(record.pageCount) || 1)),
    hasOutline: false,
    role: 'unspecified',
    importedAt: record.createdAt || 0,
    /** 只有笔记本有。要区分「这份 meta 是一本书还是一本本子」的地方看这个。 */
    isNote: true,
    style: record.style || null,
  };
}
