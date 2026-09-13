// PDF 模块 —— 渲染 worker。
//
// 一页 PDF 在主线程上栅格化要 14–34ms（首次带图片解码要 500ms）。在平板上实测，
// 放大缩小时主线程的 rAF 间隔 p95 27ms、最坏 84ms —— 就是「批注多了放大缩小有点
// 卡」看到的那一下。把栅格化搬到这里之后，同一段操作主线程 p95 9ms、最坏 9ms。
// 渲染本身没有变快，变的是它不再占着主线程。
//
// pdf.js 官方不支持在 worker 里渲染，但它只在两个地方碰 document：
//
//   1. getDocument 里判断 useWorkerFetch 时读 document.baseURI；
//   2. FontLoader 往 document.fonts 里塞 FontFace。
//
// 这两样 worker 里都拿得出真东西 —— self.fonts 就是一个真的 FontFaceSet ——
// 所以下面那个 document 桩不是「骗过」pdf.js，是把它要的两样东西如实给它。再配一
// 个用 OffscreenCanvas 的 canvasFactory，渲染结果和主线程逐像素一致（同一本书同
// 一页，深色像素占比两边都是 0.03981）。
//
// 桩只有两个字段是刻意的：将来升级 pdf.js 如果多碰了 document 的别的东西，这里会
// 直接抛 ReferenceError，客户端随即回退到主线程那条路（见 pdf-worker-client.js）。
// 悄悄多给几个字段会让这种失败变成画面出错，那比回退坏得多。
//
// 这个文件是 classic worker（Vite 的 worker.format 默认 iife），因为 pdf.js
// 3.11 的 pdf.min.js 是 UMD 不是 ESM，只能 importScripts 进来。index.html 里主
// 线程那份也是同一个文件，两边版本不可能对不上。

import { extractOutline, fragmentsFrom, textLinesFrom } from './pdf-extract.js';

/* global importScripts */

// 所有资源都拼成完整 URL，一个相对路径都不留。
//
// worker 的 base URL 是它自己的脚本地址，不是页面地址。打包后它在 /assets/ 下，
// 这时 '/vendor/…' 这种根相对路径还能对；但只要投递方式变一下 —— 比如从 blob: 起
// 一个 worker —— base 就成了不透明的 blob URL，根相对路径直接解析失败，
// importScripts 抛 SyntaxError，worker 在第一行就死了。拼绝对地址便宜得多。
const ORIGIN = self.location.origin;

// 字段和 pdf-document.js 里的 PDF_RESOURCES 一一对应 —— 主线程回退路径解不出来
// 的 CJK 字体，worker 这边也必须解得出来，否则抽出来的文本两条路不一样。
const PDF_RESOURCES = Object.freeze({
  cMapUrl: `${ORIGIN}/vendor/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ORIGIN}/vendor/standard_fonts/`,
});

self.document = { baseURI: `${ORIGIN}/`, fonts: self.fonts };

importScripts(`${ORIGIN}/vendor/pdf.min.js`);
const pdfjs = self.pdfjsLib;

/**
 * pdf.js 自己的解析 worker —— 由我们亲手起，而不是让 pdf.js 照 workerSrc 去起。
 *
 * 这不是讲究，是必须的。PDFWorker 自己起 worker 时要读 window.location 判同源；
 * worker 里没有 window，它就抛异常、退到 fake worker，而 fake worker 用
 * document.createElement 插 <script> —— 我们的 document 桩没有这个方法，于是
 * 「Setting up fake worker failed」，整份文档打不开。
 *
 * 补一个 window 桩是走不通的：pdf.js 用 `typeof window !== 'undefined'` 决定
 * _useRequestAnimationFrame，只要 window 存在，渲染分块时就会去调
 * window.requestAnimationFrame —— worker 里没有这个函数。那会变成一个更坏的
 * bug：整页是一张图的扫描件一次画完，不分块，看不出问题；矢量正文页要分块，才
 * 在半路上炸。
 *
 * 给现成的 port，PDFWorker 走 _initializeFromPort，两处都绕开了。
 */
const parsePort = new Worker(`${ORIGIN}/vendor/pdf.worker.min.js`);
const pdfWorker = new pdfjs.PDFWorker({ port: parsePort, name: 'duiye-pdf-parse' });

/**
 * 让 pdf.js 画到 OffscreenCanvas 上。
 *
 * 形状照抄 pdf.js 的 BaseCanvasFactory：create 返回 {canvas, context}，reset 改
 * 尺寸，destroy 归零。归零不是客气 —— 一张 A4 页面在 3 倍缩放下是 2000 万像素，
 * 等垃圾回收器想起来的时候通常已经是下一次翻页了。
 */
const canvasFactory = {
  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  },
  reset(target, width, height) {
    if (!target.canvas) throw new Error('Canvas is not specified');
    target.canvas.width = width;
    target.canvas.height = height;
  },
  destroy(target) {
    if (!target.canvas) return;
    target.canvas.width = 0;
    target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  },
};

/** 当前这个 worker 负责的那一份文档。一个 worker 只管一本书。 */
let pdf = null;

/**
 * 最近用过的几页留着不 cleanup。
 *
 * 原来是每渲完一页就 page.cleanup()，理由是「一本长书不能把访问过的每一页的操作
 * 列表留到会话结束」。那个理由仍然成立，所以这里是有界的 LRU，被挤出去的那一页照
 * 样 cleanup —— 换的是「无界地留」变成「留最近 3 页」。
 *
 * 为什么值得：放大缩小就是同一页换个 scale 重渲一遍。平板上实测，同一页连渲 6 个
 * 缩放级别 ——
 *
 *   每次都 cleanup    646  548  495  492  561  490 ms
 *   留着页对象        544   24   12   16   36   15 ms
 *
 * 第 200 页另测一次，一样的形状（536/526/490/490/525/502 对 529/26/1/17/34/10）。
 * 每次 cleanup 等于每次重新解一遍那一页的图，一本扫描版教材上就是半秒。
 *
 * 代价量过：用 dumpsys meminfo 看整个进程的 PSS，留 1 页、留 4 页、留 8 页分别是
 * 387/387/374 MB，全部释放后 374 MB —— 每页的边际开销在测量噪声以下，真正占地方
 * 的是那份一百多兆的文档本身。所以这个数不必抠。
 *
 * 3 是按 pdf-pane 的工作集定的：当前页，加上 PREFETCH_AHEAD=1 带来的前后各一页。
 * 再大没有用处，因为预取不会走得更远。
 */
const PAGE_HOLD = 3;
const heldPages = new Map();          // pageNumber -> PDFPageProxy；Map 的插入序即 LRU

async function pageAt(pageNumber) {
  const hit = heldPages.get(pageNumber);
  if (hit) {
    heldPages.delete(pageNumber);
    heldPages.set(pageNumber, hit);     // 重新排到最近用过的一端
    return hit;
  }
  const page = await pdf.getPage(pageNumber);
  heldPages.set(pageNumber, page);
  while (heldPages.size > PAGE_HOLD) {
    const oldest = heldPages.keys().next().value;
    const dropped = heldPages.get(oldest);
    heldPages.delete(oldest);
    // pdf.js 自己会推迟到那一页没有在渲的时候才真的清，所以这里不必怕撞上预取。
    try { dropped.cleanup(); } catch (_) { /* 已经清过了 */ }
  }
  return page;
}

function releasePages() {
  for (const page of heldPages.values()) {
    try { page.cleanup(); } catch (_) { /* 已经清过了 */ }
  }
  heldPages.clear();
}

const OPS = {
  async open({ buffer }) {
    pdf = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      ...PDF_RESOURCES,
      worker: pdfWorker,
      canvasFactory,
      isOffscreenCanvasSupported: true,
    }).promise;
    return { numPages: pdf.numPages };
  },

  async outline() {
    return { outline: await extractOutline(pdf) };
  },

  async size({ pageNumber }) {
    const page = await pageAt(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  },

  async render({ pageNumber, scale }) {
    const page = await pageAt(pageNumber);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
    // transferToImageBitmap 把像素的所有权交出去，主线程那边
    // transferFromImageBitmap 再接过来，全程零拷贝：实测 1961×2772 只花 0.1ms。
    const bitmap = canvas.transferToImageBitmap();
    return { payload: { bitmap, width, height }, transfer: [bitmap] };
  },

  async text({ pageNumber }) {
    const page = await pageAt(pageNumber);
    let content;
    try {
      content = await page.getTextContent();
    } catch (_) {
      return { lines: [], empty: true };
    }
    return textLinesFrom(fragmentsFrom(content.items));
  },

  async textRange({ from, to }) {
    const out = [];
    for (let p = from; p <= to; p++) {
      const { lines } = await OPS.text({ pageNumber: p });
      for (const text of lines) out.push({ page: p, text });
    }
    return { lines: out };
  },

  async close() {
    releasePages();
    try { pdf?.destroy(); } catch (_) { /* 已经拆掉了 */ }
    pdf = null;
    // port 是我们起的，PDFWorker.destroy 只关它自己起的那个，所以这里得自己收。
    try { parsePort.terminate(); } catch (_) { /* 已经没了 */ }
    return {};
  },
};

self.addEventListener('message', async (event) => {
  const request = event.data;
  // pdf.js 的 worker bundle 一旦被 importScripts 进来，就会在这个全局上收发它自己
  // 的协议消息。没有这一行，它的握手会被当成我们的请求。
  if (!request || request.channel !== 'duiye-pdf') return;
  const { id, op, args } = request;
  try {
    const handler = OPS[op];
    if (!handler) throw new Error(`unknown op: ${op}`);
    const result = await handler(args || {});
    const { payload, transfer } = result && result.payload
      ? result
      : { payload: result, transfer: [] };
    self.postMessage({ channel: 'duiye-pdf', id, ok: true, payload }, transfer);
  } catch (error) {
    self.postMessage({
      channel: 'duiye-pdf',
      id,
      ok: false,
      error: String((error && error.message) || error),
    });
  }
});
