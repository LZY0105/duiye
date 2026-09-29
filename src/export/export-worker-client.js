// 导出 —— 在后台线程里做 PDF 的那一头（后台那一头在 export-worker.js）。
//
// 起不来就说起不来（WORKER_UNAVAILABLE），不替调用方在主线程上悄悄做：交过去的原文件字节
// 已经转手（转手不复制），主线程这边已经空了，要照做得先重新读一份——这件事调用方知道怎么做，
// 这里不知道。测试里（Node 没有 Worker）、打包漏了这一块、WebView 加载失败，都走这条路。

/** 后台线程用不了。调用方重新拿一份输入，在主线程上照做。 */
export const WORKER_UNAVAILABLE = 'EXPORT_WORKER_UNAVAILABLE';

let worker = null;
let broken = false;
let seq = 0;
const pending = new Map();

function fail(reason) {
  broken = true;
  if (worker) {
    try { worker.terminate(); } catch (_) { /* 已经没了 */ }
  }
  worker = null;
  for (const job of pending.values()) job.reject(new Error(reason));
  pending.clear();
}

function spawn() {
  if (worker) return worker;
  if (broken || typeof Worker !== 'function') return null;
  try {
    worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
  } catch (_) {
    broken = true;
    return null;
  }
  worker.onmessage = (event) => {
    const { id, bytes, error, progress } = event.data || {};
    const job = pending.get(id);
    if (!job) return;
    if (progress) {
      job.onProgress?.(progress.done, progress.total);
      return;
    }
    pending.delete(id);
    if (error) job.reject(new Error(error));
    else job.resolve(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  };
  // 加载失败，或者里面抛了没接住的错：手上的活都交还给调用方，以后不再用它。
  worker.onerror = (event) => {
    event?.preventDefault?.();
    fail(WORKER_UNAVAILABLE);
  };
  return worker;
}

/**
 * 在后台线程里做一份 PDF。
 *
 * @param {'book'|'notebook'|'scratch'} job 做哪一种（对应 pdf-export.js 的 build*）
 * @param {object} input 交给 build* 的东西，要能被结构化复制：字节、笔迹、纸样
 * @param {{onProgress?: function(number, number), transfer?: Transferable[]}} [options]
 *   transfer 里的东西转手给后台线程，不复制——之后主线程这边就空了
 * @returns {Promise<Uint8Array>} 做好的 PDF。后台线程用不了时以 WORKER_UNAVAILABLE 拒绝；
 *   做的时候出的错（加密、读不懂……）原样拒绝，消息和主线程上做时一样
 */
export function buildInWorker(job, input, { onProgress, transfer = [] } = {}) {
  const w = spawn();
  if (!w) return Promise.reject(new Error(WORKER_UNAVAILABLE));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    try {
      w.postMessage({ id, job, input }, transfer);
    } catch (_) {
      // 复制不了（笔迹里夹了不能复制的东西）：什么都没转手，调用方照做就行。
      pending.delete(id);
      reject(new Error(WORKER_UNAVAILABLE));
    }
  });
}
