// 网页这一侧的原生代理。
//
// 两件以后要接的活——AI 代理（把题目和上下文交出去，拿回讲解）和 OCR（把一块
// 图交出去，拿回文字或 LaTeX）——走同一座桥。桥现在是通的，两个位置是空的：
// 问它，它会诚实地回 UNIMPLEMENTED，而不是假装在算。
//
// 为什么一上来就写成「一段一段回来」的样子：一个只在算完才开口的模型，在人这
// 一侧和卡死没有区别。所以 request() 返回的东西既是一个 Promise（要最终结果就
// await 它），又可以订阅中间结果。OCR 用不上分段也没关系——能分段的接口可以不
// 分段用，反过来不行，而反过来的那次改动要动到四个文件。
//
// 这个模块不做重试、不做排队、不做超时。它是一层转发：谁在等什么、等多久、
// 失败了怎么办，是叫它的那一方的事，因为只有那一方知道人这会儿在看什么。

import Logger from '../core/logger.js';

export const PROXY_SERVICES = Object.freeze({
  /** 大模型 / 本地推理：解题、讲解、改写。 */
  AGENT: 'agent',
  /** 光学字符识别：图 → 文字 / LaTeX。 */
  OCR: 'ocr',
});

export const PROXY_ERRORS = Object.freeze({
  /** 这个构建里根本没有原生层（浏览器里跑、或者构建时关掉了）。 */
  NO_BRIDGE: 'NO_BRIDGE',
  /** 桥在，但这个位置还没接上实现。 */
  UNIMPLEMENTED: 'UNIMPLEMENTED',
  NO_SERVICE: 'NO_SUCH_SERVICE',
  CANCELLED: 'CANCELLED',
});

/** Capacitor 注入的插件对象；浏览器里跑的时候它不存在。 */
function plugin() {
  return globalThis.Capacitor?.Plugins?.NativeProxy || null;
}

let listening = null;
/** 监听挂在哪个插件对象上。Capacitor 重新注入过就得重挂——见 ensureListening。 */
let listeningOn = null;
/** requestId → 这条请求的收件人。 */
const waiting = new Map();

/** 一条回音落到它该去的那件活上。 */
function deliver(event) {
  const entry = waiting.get(event?.requestId);
  if (!entry) return;
  let data = {};
  try { data = event.data ? JSON.parse(event.data) : {}; } catch (_) { data = { raw: event.data }; }

  if (event.kind === 'chunk') { entry.onChunk?.(data); return; }
  waiting.delete(event.requestId);
  if (event.kind === 'done') entry.resolve(data);
  else entry.reject(fail(data.code || 'UNKNOWN', data.message || '原生层没有说明原因'));
}

/**
 * 一个插件对象只挂一次监听。
 *
 * 每次请求都挂一个的话，一次会话下来会有几百个监听器都在为同一条事件做同样的
 * 分发；而且取消掉的那些如果忘了摘，它们会一直活着。一个总入口，按 requestId
 * 派信。
 *
 * 但记的是「挂在哪个对象上」而不是「挂过没有」：WebView 重载时 Capacitor 会把
 * Plugins 整个重新注入，旧对象上那个监听器随着旧桥一起没了。只记一个布尔值的
 * 话，重载之后这层就再也收不到任何回音，而且一声不响。
 */
function ensureListening() {
  const api = plugin();
  if (!api) return null;
  if (listening && listeningOn === api) return listening;
  listeningOn = api;
  listening = api.addListener('proxyEvent', deliver);
  return listening;
}

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

/** 桥在不在，两个位置各自接上了没有。 */
export async function describeProxy() {
  const api = plugin();
  if (!api) return { loaded: false, services: [] };
  try {
    const raw = await api.describe();
    let services = [];
    try { services = JSON.parse(raw.services || '{}').services || []; } catch (_) { /* 原生层给的形状不对就当没有 */ }
    return { loaded: !!raw.loaded, services };
  } catch (error) {
    Logger.warn('PROXY', `describe failed: ${error.message}`);
    return { loaded: false, services: [] };
  }
}

/** 某一位现在能不能真的干活。上层用它决定露不露那个入口。 */
export async function serviceReady(name) {
  const { loaded, services } = await describeProxy();
  return loaded && services.some(s => s?.name === name && s.ready === true);
}

/**
 * 交一件活下去。
 *
 * @param {Object}   spec
 * @param {string}   spec.service  PROXY_SERVICES 里的一个
 * @param {string}   spec.op       这个服务自己定义的动作，例如 'chat' / 'recognize'
 * @param {Object}   [spec.payload] 随便什么，原封不动转发
 * @param {Function} [spec.onChunk] 有中间结果时一段一段回调
 * @returns {Promise<Object> & {requestId: string, cancel: () => void}}
 *   await 它拿最终结果；要中途撤回就调 cancel()。
 */
export function request({ service, op = '', payload = {}, onChunk } = {}) {
  const api = plugin();
  const id = `${service}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (!api) {
    // 浏览器里跑、或者这个构建没带原生层。这不是异常情况，是这一层现在的实情，
    // 所以它和「接上了但失败了」走同一条路，调用方只写一处错误处理。
    const promise = Promise.reject(fail(PROXY_ERRORS.NO_BRIDGE, '这个构建没有原生代理层'));
    promise.catch(() => {});   // 没人接手时不要变成未处理的拒绝
    return Object.assign(promise, { requestId: id, cancel() {} });
  }

  // 监听先挂上，再把活交下去。
  //
  // addListener 是异步的，而原生那一侧可以同步回话：库没加载、服务名不存在，
  // 这两条路都在 submit 还没返回的时候就把事件发出来了。先提交再挂监听的话，
  // 那条回音会落在空处——promise 永远不落地，而且正好是这层还没接上时人碰到的
  // 第一种情况。
  const ready = ensureListening();

  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  waiting.set(id, { ...settle, onChunk });

  Promise.resolve(ready)
    // 挂监听失败不该把这件活也毙掉：原生层未必会同步回话，晚一点挂上也还来得及。
    .catch(() => {})
    // 还没递下去就被撤了，就别递了。
    .then(() => (waiting.has(id) ? api.submit({ service, op, payload, requestId: id }) : null))
    .catch((error) => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      settle.reject(fail(error?.code || 'SUBMIT_FAILED', error?.message || String(error)));
    });

  return Object.assign(promise, {
    requestId: id,
    cancel() {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      api.cancel({ service, requestId: id }).catch(() => { /* 撤不回来就算了 */ });
      settle.reject(fail(PROXY_ERRORS.CANCELLED, '已取消'));
    },
  });
}

/** 把一段东西交给模型。op 和 payload 的细节留给接入方定。 */
export function askAgent(payload, { op = 'chat', onChunk } = {}) {
  return request({ service: PROXY_SERVICES.AGENT, op, payload, onChunk });
}

/** 把一块图交给识别。 */
export function recognize(payload, { op = 'recognize', onChunk } = {}) {
  return request({ service: PROXY_SERVICES.OCR, op, payload, onChunk });
}
