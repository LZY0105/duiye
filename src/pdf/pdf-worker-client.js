// PDF 模块 —— 渲染 worker 的主线程这一端。
//
// 对外只有一个形状：它返回的文档对象和 pdf-document.js 主线程那条路返回的一模一
// 样，pdf-pane、page-panel、book-cover、answer-index 都不知道自己在跟谁说话。这
// 是刻意的 —— worker 这条路随时可能整条不可用（见 openInWorker 的 try），换回主
// 线程时不能有任何调用方需要跟着改。
//
// 唯一一处形状不同藏在 renderPage 的 drawable 选项里：默认给的是一张
// bitmaprenderer 画布，位图零拷贝上屏（实测 0–0.1ms）；但这种画布之后再也拿不到
// 2d 上下文。page-panel 要往页面上继续画批注，所以它得传 drawable: true，换成一
// 张 2d 画布、真拷一次。全页尺寸下这一拷要 10–15ms，缩略图尺寸可以忽略 —— 谁用
// 得起零拷贝谁就别拷，这是那个参数存在的全部理由。

import { PDF_ERRORS } from './pdf-errors.js';

/** worker 能不能用。缺任何一样就整条路不走。 */
export function workerRenderingAvailable() {
  return typeof Worker === 'function'
    && typeof OffscreenCanvas === 'function'
    && typeof createImageBitmap === 'function';
}

/** 一个 worker 一本书，这样 destroy 是真的把那一百多兆还回去。 */
function spawn() {
  return new Worker(new URL('./pdf-render-worker.js', import.meta.url));
}

/**
 * 把 worker 包成一问一答。
 *
 * 每个请求带一个自增 id，回来按 id 找回调。worker 那边是串行处理的，但请求可以
 * 并发发出去 —— pdf-pane 的预取和当前页的渲染本来就会撞在一起。
 */
function rpc(worker) {
  const pending = new Map();
  let nextId = 0;
  let dead = null;

  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.channel !== 'duiye-pdf') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.payload);
    else entry.reject(new Error(message.error));
  });

  // worker 整个挂掉的时候，所有在飞的请求都要收到答复，否则调用方会永远停在
  // await 上 —— 那比报错难查得多，界面只是再也不刷新了。
  const kill = (reason) => {
    dead = dead || new Error(reason);
    for (const entry of pending.values()) entry.reject(dead);
    pending.clear();
  };
  worker.addEventListener('error', (event) => kill(event.message || 'worker error'));

  return {
    call(op, args, transfer) {
      if (dead) return Promise.reject(dead);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ channel: 'duiye-pdf', id, op, args }, transfer || []);
      });
    },
    kill,
  };
}

/** 位图上屏。默认零拷贝；要继续在上面画的，换成能拿 2d 上下文的画布。 */
function canvasFrom(bitmap, width, height, drawable) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  if (drawable) {
    canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0);
    bitmap.close();
  } else {
    canvas.getContext('bitmaprenderer').transferFromImageBitmap(bitmap);
  }
  return canvas;
}

/**
 * 在 worker 里打开一份 PDF。
 *
 * 失败就抛，由 pdf-document.js 接住并回退到主线程。这里不吞异常：一条悄悄降级的
 * 路会让「为什么放大还是卡」永远查不出来。
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<Object>} 和 openPdfDocument 相同形状的文档对象
 */
export async function openInWorker(bytes) {
  const worker = spawn();
  const channel = rpc(worker);

  // pdf.js 会把拿到的 buffer 据为己有并 detach 掉，所以传的是一份拷贝；同一份缓存
  // 字节第二次打开才不会撞上 detached ArrayBuffer。主线程那条路也是这么做的。
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buffer = source.slice().buffer;

  let numPages;
  try {
    ({ numPages } = await channel.call('open', { buffer }, [buffer]));
  } catch (cause) {
    worker.terminate();
    const error = new Error(PDF_ERRORS.OPEN_FAILED);
    error.cause = cause;
    throw error;
  }

  const inRange = (pageNumber) => Number.isInteger(pageNumber)
    && pageNumber >= 1 && pageNumber <= numPages;

  // null 表示「还没要过」，NO_OUTLINE 表示「要过了，这本书确实没有目录」。和主线
  // 程那条路是同一套约定，pdf-workspace 依赖这个区别决定要不要显示目录面板。
  let outline = null;
  let outlinePromise = null;

  return {
    numPages,
    get outline() { return outline; },

    getOutline() {
      if (!outlinePromise) {
        outlinePromise = channel.call('outline').then((result) => {
          outline = result.outline;
          return outline;
        });
      }
      return outlinePromise;
    },

    async renderPage(pageNumber, scale, { drawable = false } = {}) {
      if (!inRange(pageNumber)) throw new Error(PDF_ERRORS.PAGE_OUT_OF_RANGE);
      const { bitmap, width, height } = await channel.call('render', { pageNumber, scale });
      return { canvas: canvasFrom(bitmap, width, height, drawable), width, height };
    },

    async pageText(pageNumber) {
      if (!inRange(pageNumber)) throw new Error(PDF_ERRORS.PAGE_OUT_OF_RANGE);
      return channel.call('text', { pageNumber });
    },

    async extractText({ from = 1, to = numPages } = {}) {
      const start = Math.max(1, from);
      const end = Math.min(numPages, to);
      if (end < start) return [];
      const { lines } = await channel.call('textRange', { from: start, to: end });
      return lines;
    },

    async pageSize(pageNumber) {
      if (!inRange(pageNumber)) throw new Error(PDF_ERRORS.PAGE_OUT_OF_RANGE);
      return channel.call('size', { pageNumber });
    },

    destroy() {
      channel.call('close').catch(() => { /* 正要拆掉，报什么都不重要 */ })
        .finally(() => {
          channel.kill('document destroyed');
          worker.terminate();
        });
    },
  };
}
