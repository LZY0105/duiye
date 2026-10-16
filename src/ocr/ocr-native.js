// OCR —— 原生层那一位（src/native/native-proxy.js 的 'ocr'）接上实现以后，把它登记成识别引擎。
//
// C++ 那边的 ocr 还是空实现（duiye_proxy.cpp 的 NullService），这一位由 Java 接管：NativeProxyPlugin 把 ocr 的请求交给
// FormulaOcrService（自建公式模型，一次认一个印刷公式），describe 里报 ready。开机那次探测（app.js 的 probeNativeProxy）
// 看到 ready 就把它登记进来，套索上那颗按钮自己出现。没带模型的构建里 ocr 不是 ready，这里什么都不登记，一切照旧。
//
// 交下去的 payload（JSON）：
//   { image: PNG 的 base64（不带 data: 前缀）, format: 'png-base64', width, height,
//     scale, pageNumber, mode, lang }
// 原生层可以分段回（chunk）：{ progress: 0..1 }，小条上的百分比就是它。
// 最后（done）回下面两种之一：
//   · { items: [{ kind, text, latex, confidence, box }] }——和网页这边引擎的回法一样（box 是图上的像素）；
//   · { latex, endedWithEos, meanLogProbability, reasonCodes }——自建公式模型（ScratchFormulaRecognizer）原样的回法：
//     整块当一个公式。没写完（endedWithEos 为 false、reasonCodes 里有 NO_EOS）的标「可能认得不准」，EMPTY 当没认出。
// 详见 docs/OCR接入说明.md。

import { PROXY_SERVICES, recognize as proxyRecognize } from '../native/native-proxy.js';
import { registerOcrProvider } from './ocr-service.js';

export const NATIVE_OCR_ID = 'native';

/** 没写完的那种结果给多少把握：低于结果单子上打「?」的那条线（0.6）。 */
const UNFINISHED_CONFIDENCE = 0.3;

/** 描述里 ocr 那一位能不能用（describeProxy 的结果）。 */
export function nativeOcrReady(description) {
  return !!description?.loaded
    && (description.services || []).some((s) => s?.name === PROXY_SERVICES.OCR && s.ready === true);
}

/** 圈里那一块的图 → PNG 的 base64（不带 data: 前缀）。 */
export async function encodePng(image) {
  if (!image) throw new Error('OCR_NO_IMAGE');
  if (typeof image.toDataURL === 'function') return image.toDataURL('image/png').split(',')[1] || '';
  if (typeof image.convertToBlob === 'function') {
    const blob = await image.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  throw new Error('OCR_NO_IMAGE');
}

/**
 * 原生层回来的东西 → 引擎该回的 { items }。
 * @param {Object} data done 带回来的 JSON
 */
export function mapNativeResult(data) {
  if (Array.isArray(data?.items)) return { items: data.items };
  if (typeof data?.latex !== 'string') return { items: [] };
  const reasons = Array.isArray(data.reasonCodes) ? data.reasonCodes : [];
  const latex = data.latex.trim();
  if (!latex || reasons.includes('EMPTY')) return { items: [] };
  const unfinished = data.endedWithEos === false || reasons.includes('NO_EOS');
  // 平均对数概率不是校准过的把握（模型说明里写着），这里只拿它决定要不要打「?」：每个词平均的概率。
  const mean = Number(data.meanLogProbability);
  const confidence = unfinished ? UNFINISHED_CONFIDENCE
    : Number.isFinite(mean) ? Math.min(1, Math.max(0, Math.exp(mean))) : null;
  // 不给框：整块就是这一个公式，框出来和圈线重了。
  return { items: [{ kind: 'math', latex, confidence }] };
}

export const nativeOcrProvider = Object.freeze({
  id: NATIVE_OCR_ID,
  label: '本机识别',
  async recognize(request, { signal, onProgress } = {}) {
    const image = await encodePng(request?.image);
    if (signal?.aborted) throw new Error('aborted');
    const job = proxyRecognize({
      image,
      format: 'png-base64',
      width: request.image.width,
      height: request.image.height,
      scale: request.scale,
      pageNumber: request.pageNumber,
      mode: request.mode,
      lang: request.lang,
    }, {
      onChunk: (chunk) => { if (Number.isFinite(chunk?.progress)) onProgress?.(chunk.progress); },
    });
    // 人取消了、等太久了：原生那边也停下（拦不拦得住看它自己，见 duiye_proxy.h 的 cancel）。
    signal?.addEventListener('abort', () => job.cancel(), { once: true });
    return mapNativeResult(await job);
  },
});

/** 登记原生识别。开机探到 ocr 那一位 ready 时调（app.js）。 @returns 撤销 */
export function registerNativeOcr() {
  return registerOcrProvider(nativeOcrProvider);
}
