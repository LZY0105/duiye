// OCR —— 识别引擎的登记处，以及「套索圈一块、认出里面的字和公式」这一件事的统一入口。
//
// 软件现在还没有接 OCR。这里先把接口定下来：将来不管识别跑在哪儿——原生插件（Capacitor，模型在 Java / C++ 里）、
// 网页里的 WebAssembly、还是别的什么——都只是在这里登记一个「引擎」（provider），套索那一头不用改一行。
// 没有引擎的时候，套索上就不出现「识别」，一切照旧。
//
// 一个引擎长这样（详见 docs/OCR接入说明.md）：
//
//   registerOcrProvider({
//     id: 'formula-int8',            // 唯一的名字
//     label: '公式识别',              // 给人看的名字（可选）
//     async recognize(request, { signal, onProgress }) {
//       // request.image：圈里那一块页面的图（画布），圈外涂白；request.scale：图上几像素是一个文档单位
//       // request.strokes：圈里的笔迹（矢量，文档单位），认手写的引擎用得上
//       // 认的过程中可以 onProgress(0..1)；signal 被取消时尽早停下（抛什么都行，这边当作取消）
//       return { items: [{ kind: 'math', latex: '\\int_a^b f(x)\\,dx', confidence: 0.93, box: {x, y, width, height} }] };
//     },
//   });
//
// 认出来的每一条（item）：kind 是 'text'（一段文字）或 'math'（一个公式）；text 是给人看、给复制的纯文字；公式另带
// latex。box 是这一条在 request.image 上的位置（像素），有的话界面会在图上把它框出来。

/** 识别没成功的几种原因。界面按这个说话，引擎自己抛的错都归到 FAILED。 */
export const OCR_ERRORS = Object.freeze({
  /** 没有登记任何引擎。 */
  UNAVAILABLE: 'OCR_UNAVAILABLE',
  /** 等太久了（默认 30 秒）。 */
  TIMEOUT: 'OCR_TIMEOUT',
  /** 人取消了（或者开始做别的事，比如又圈了一块、翻了页）。 */
  CANCELLED: 'OCR_CANCELLED',
  /** 引擎自己出错。 */
  FAILED: 'OCR_FAILED',
});

/** 认出来的一条是什么。 */
export const OCR_KINDS = Object.freeze({ TEXT: 'text', MATH: 'math' });

/** 一次识别最多等多久，毫秒。本机跑的模型第一次要加载，留宽一点。 */
export const OCR_TIMEOUT_MS = 30000;

const providers = new Map();
let activeId = null;
const listeners = new Set();

function announce() {
  for (const fn of listeners) {
    try { fn(ocrAvailable()); } catch (_) { /* 一个听的人出错不影响别人 */ }
  }
}

/**
 * 登记一个识别引擎。同一个 id 再登记一次就是换掉旧的。最后登记的那个成为正在用的。
 * 同一个引擎原样再登记一次（开机、开关各叫一次 sync 的时候）什么都不变，也不惊动听的人。
 * @returns {function(): void} 撤销这一次登记（那个 id 已经被别的引擎换掉了的话，什么都不做）
 */
export function registerOcrProvider(provider) {
  if (!provider || typeof provider.id !== 'string' || typeof provider.recognize !== 'function') {
    throw new TypeError('OCR provider needs an id and a recognize(request, ctx) function');
  }
  const unchanged = providers.get(provider.id) === provider && activeId === provider.id;
  providers.set(provider.id, provider);
  activeId = provider.id;
  if (!unchanged) announce();
  return () => {
    if (providers.get(provider.id) === provider) unregisterOcrProvider(provider.id);
  };
}

export function unregisterOcrProvider(id) {
  if (!providers.delete(id)) return;
  if (activeId === id) activeId = [...providers.keys()].pop() || null;
  announce();
}

/** 指定用哪一个（登记过的）。 */
export function useOcrProvider(id) {
  if (!providers.has(id)) return false;
  if (activeId === id) return true;
  activeId = id;
  announce();
  return true;
}

export function activeOcrProvider() {
  return activeId ? providers.get(activeId) || null : null;
}

/** 现在能不能识别：有没有正在用的引擎。套索上那颗「识别」按它显隐。 */
export function ocrAvailable() {
  return !!activeOcrProvider();
}

/** 引擎来了、走了时告诉一声（套索那条小条要跟着重搭）。 @returns 撤销 */
export function onOcrAvailabilityChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 把引擎给的东西收拾成界面能直接用的样子：去空、去重、补 kind、信心夹到 0..1。 */
export function normalizeOcrItems(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const latex = typeof item.latex === 'string' ? item.latex.trim() : '';
    const text = typeof item.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
    if (!latex && !text) continue;
    const kind = item.kind === OCR_KINDS.MATH || (latex && item.kind !== OCR_KINDS.TEXT) ? OCR_KINDS.MATH : OCR_KINDS.TEXT;
    const key = `${kind}|${latex || text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const confidence = Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence)) : null;
    const box = item.box && [item.box.x, item.box.y, item.box.width, item.box.height].every(Number.isFinite)
      ? { x: item.box.x, y: item.box.y, width: item.box.width, height: item.box.height } : null;
    out.push({
      id: `ocr-${out.length + 1}`,
      kind,
      text: text || latex,
      latex: kind === OCR_KINDS.MATH ? (latex || text) : '',
      confidence,
      box,
    });
  }
  return out;
}

/**
 * 认一块。
 *
 * @param {Object} request 见文件头：image、scale、box、polygon、strokes、mode、lang
 * @param {{signal?: AbortSignal, onProgress?: function(number), timeoutMs?: number}} [options]
 * @returns {Promise<{items: Array, provider: string, ms: number}>}
 *   失败时以 Error 拒绝，message 是 OCR_ERRORS 里的一个
 */
export async function recognizeRegion(request, { signal, onProgress, timeoutMs = OCR_TIMEOUT_MS } = {}) {
  const provider = activeOcrProvider();
  if (!provider) throw new Error(OCR_ERRORS.UNAVAILABLE);
  if (signal?.aborted) throw new Error(OCR_ERRORS.CANCELLED);

  // 给引擎一个自己的取消信号：外面取消、等太久，都从这里发下去。
  const inner = new AbortController();
  const started = Date.now();
  let timer = 0;
  const outcome = new Promise((resolve, reject) => {
    const cancel = () => { inner.abort(); reject(new Error(OCR_ERRORS.CANCELLED)); };
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { inner.abort(); reject(new Error(OCR_ERRORS.TIMEOUT)); }, timeoutMs);
    let lastProgress = -1;
    const progress = (fraction) => {
      if (inner.signal.aborted || !Number.isFinite(fraction)) return;
      const f = Math.min(1, Math.max(0, fraction));
      if (f <= lastProgress) return;
      lastProgress = f;
      onProgress?.(f);
    };
    Promise.resolve()
      .then(() => provider.recognize(request, { signal: inner.signal, onProgress: progress }))
      .then((raw) => {
        signal?.removeEventListener('abort', cancel);
        if (inner.signal.aborted) return;
        resolve({ items: normalizeOcrItems(raw), provider: provider.id, ms: Date.now() - started });
      }, (error) => {
        signal?.removeEventListener('abort', cancel);
        if (inner.signal.aborted) return;
        reject(new Error(OCR_ERRORS.FAILED, { cause: error }));
      });
  });
  try {
    return await outcome;
  } finally {
    clearTimeout(timer);
  }
}

/** 测试用：清空登记处。 */
export function resetOcrProviders() {
  providers.clear();
  activeId = null;
  announce();
}
