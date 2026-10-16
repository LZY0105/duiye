// OCR —— 模拟识别：真的引擎接进来之前，用它把「圈一块 → 识别 → 挑结果 → 复制 / 转成笔迹」这条路走通、看动画。
//
// 它看不懂图：按圈的形状给几条像样的示例（一段文字、一两个公式），慢慢报进度，一点五秒左右给结果。圈得太小
// 就说什么都没认出来（看「没认出」那一面）。只有开发者模式开着、又打开了「预览识别（模拟结果）」时才登记
// （设置 → 开发者选项），正式用的人碰不到它；结果单子上也写着「模拟」。

import { registerOcrProvider, unregisterOcrProvider } from './ocr-service.js';

export const MOCK_OCR_ID = 'mock';
const KEY = 'ls_ocr_mock';
/** 开发者模式（settings.js 存的那一项）。关了它，模拟识别跟着撤掉，开关自己记着的那一项不动。 */
const DEV_KEY = 'ls_dev';

/** 一次模拟识别大概多久，毫秒。 */
export const MOCK_DELAY_MS = 1600;

const SAMPLES = [
  { kind: 'text', text: '设函数 f(x) 在闭区间 [a, b] 上连续' },
  { kind: 'math', latex: '\\int_a^b f(x)\\,dx = F(b) - F(a)' },
  { kind: 'math', latex: '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1' },
  { kind: 'math', latex: 'x^2 + y^2 = r^2' },
];

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
});

export const mockOcrProvider = Object.freeze({
  id: MOCK_OCR_ID,
  label: '模拟识别',
  mock: true,
  async recognize(request, { signal, onProgress } = {}) {
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await sleep(MOCK_DELAY_MS / steps, signal);
      onProgress?.(i / steps);
    }
    const width = request?.image?.width || 0;
    const height = request?.image?.height || 0;
    const scale = request?.scale || 1;
    // 圈得太小（文档单位里不到一个字那么大）：什么都没认出来。
    if (width / scale < 24 || height / scale < 12) return { items: [] };
    // 扁长的一条：一行字、一个公式；高一些的一块：三条。
    const count = height < width * 0.25 ? 2 : 3;
    const picked = height < width * 0.25 ? [SAMPLES[0], SAMPLES[3]] : SAMPLES.slice(0, count);
    const rowH = height / count;
    return {
      items: picked.map((item, i) => ({
        ...item,
        confidence: 0.98 - i * 0.07,
        box: { x: width * 0.06, y: rowH * i + rowH * 0.18, width: width * (0.88 - i * 0.12), height: rowH * 0.64 },
      })),
    };
  },
});

/** 开关本身开着没有（不管开发者模式）。 */
export function mockOcrSwitchOn() {
  try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; }
}

/** 现在该不该用模拟识别：开发者模式开着，开关也开着。 */
export function mockOcrEnabled() {
  try { return localStorage.getItem(DEV_KEY) === '1' && mockOcrSwitchOn(); } catch (_) { return false; }
}

/** 按设置里那个开关登记或撤掉模拟识别。开机时调一次，开关变了再调一次。 */
export function syncMockOcr() {
  if (mockOcrEnabled()) registerOcrProvider(mockOcrProvider);
  else unregisterOcrProvider(MOCK_OCR_ID);
}

export function setMockOcrEnabled(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (_) { /* 存不下就算了：开发用的东西 */ }
  syncMockOcr();
}
