// 诊断日志。
//
// 这台机器上没有开发者工具。应用跑在平板的 WebView 里，出问题时能拿到的只有用户
// 的一句描述，所以日志必须自己留在设备上、能被导出、并且要熬过一次崩溃——崩溃前
// 的最后几行往往就是原因。
//
// 上一版是上游为「JS + Java 双层」写的：每条日志都会转发给 window.NativeOcr 的
// Java 桥，导出时打包成含模型清单的 ZIP。那座桥随识别栈一起删了（MainActivity
// 里留有说明），ZIP 那条路则从来没能跑通——它 new JSZip()，而没有任何地方加载
// JSZip。这里把两者都去掉了，同时修掉三个它带来的问题：
//
//   1. 每写一行日志都要读一次 localStorage、再把整个缓冲区写回去。缓冲区本来就
//      在内存里，那次读取只是把它覆盖成自己。现在只在内存里追加，落盘走空闲时
//      的防抖，外加页面隐藏时强制写一次——那是移动端唯一可靠的「最后时刻」。
//   2. push() 会调用 console.debug，而 console.debug 被下面的捕获逻辑改写过，
//      于是每一条 Logger.info 都在缓冲区里留下两行。现在捕获逻辑认得自己人。
//   3. Logger.info/warn/error 各自又向原生桥转发了一次，push() 里已经转发过。

const MAX_LINES = 2000;
const STORE_KEY = 'ls_log';
const FLUSH_DELAY = 800;

/** 内存里的环形缓冲区，是唯一的真相；localStorage 只是它的一份快照。 */
let lines = [];
let flushTimer = 0;
let loaded = false;

/** 正在写入的标记：console 被改写过，捕获逻辑靠它认出自己的输出，避免记两遍。 */
let writing = false;

function restore() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) lines = saved.split('\n').filter(Boolean);
  } catch (_) { /* 隐私模式下没有存储，只在内存里记 */ }
}

function flush() {
  flushTimer = 0;
  try {
    localStorage.setItem(STORE_KEY, lines.slice(-MAX_LINES).join('\n'));
  } catch (_) { /* 配额满或不可用：内存里的仍然是全的 */ }
}

/** 攒一会儿再落盘。日志是成串出现的，一行一次写入毫无意义。 */
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY);
}

// 页面被隐藏时立刻落盘。移动端不保证还会有 unload，pagehide 是最后能确定拿到的
// 一次机会——崩溃或被系统回收之前的那几行，价值最高。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

function stamp() {
  const d = new Date();
  return `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function append(level, tag, text) {
  restore();
  lines.push(`[${stamp()}][${level}][${tag}] ${text}`);
  if (lines.length > MAX_LINES * 1.5) lines = lines.slice(-MAX_LINES);
  scheduleFlush();
}

/** 把任意实参转成一行可读文本，Error 连同前几层调用栈一起。 */
function describe(value) {
  if (value instanceof Error) {
    const stack = (value.stack || '').split('\n').slice(0, 5).join('\n');
    return value.message + (stack ? '\n' + stack : '');
  }
  if (value !== null && typeof value === 'object') {
    try { return JSON.stringify(value, null, 1); } catch (_) { return String(value); }
  }
  return String(value);
}

// ── 接管 console ────────────────────────────────────────────────────────────
//
// 连第三方库的输出一起收进来。没有开发者工具的时候，pdf.js 抱怨了什么、
// MathLive 什么时候报了警告，都只能从这里看到。
const native = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function capture(level, args) {
  if (writing) return;          // 自己写的，append() 已经记过一次
  const text = args.map(describe).join(' ');
  const tagged = /^\[([^\]]+)\]/.exec(text);
  append(level, tagged ? tagged[1] : 'CONSOLE', text);
}

if (typeof console !== 'undefined') {
  console.log = (...a) => { capture('INFO', a); native.log(...a); };
  console.debug = (...a) => { capture('DEBUG', a); native.debug(...a); };
  console.warn = (...a) => { capture('WARN', a); native.warn(...a); };
  console.error = (...a) => { capture('ERROR', a); native.error(...a); };
}

/** 写一行，并且原样送到真正的 console，好让连着调试器的时候仍看得见。 */
function emit(level, tag, text, out) {
  append(level, tag, text);
  writing = true;
  try { out(`[${tag}] ${text}`); } finally { writing = false; }
}

const Logger = {
  info(tag, msg) { emit('INFO', tag, describe(msg), native.debug); },
  warn(tag, msg) { emit('WARN', tag, describe(msg), native.warn); },

  /**
   * @param {string} tag 来源模块
   * @param {string} msg 出了什么事
   * @param {Error} [err] 若有异常对象，它的信息与调用栈会附在后面
   */
  error(tag, msg, err) {
    const text = err ? `${msg} | ${describe(err)}` : String(msg);
    emit('ERROR', tag, text, native.error);
  },

  /**
   * 记一次运行环境。
   *
   * 放在日志最前面，因为大部分「只在我这台机器上出现」的问题，答案就在这几行里：
   * 是哪个 WebView、多少内存、什么语言。
   */
  logSystemInfo() {
    restore();
    const rule = '═'.repeat(39);
    lines.push(
      rule,
      `启动时间: ${new Date().toLocaleString('zh-CN')}`,
      `用户代理: ${navigator.userAgent}`,
      `平台: ${navigator.platform || '未知'}`,
      `语言: ${navigator.language}`,
      `硬件并发: ${navigator.hardwareConcurrency || '未知'}`,
      `内存: ${navigator.deviceMemory ? navigator.deviceMemory + 'GB' : '未知'}`,
      `Capacitor: ${typeof window.Capacitor !== 'undefined' ? '是' : '否'}`,
      `屏幕: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
      `网络: ${navigator.onLine ? '在线' : '离线'}`,
      rule,
    );
    scheduleFlush();
  },

  /** 最近 n 行，最新的在最后。 */
  getLastLines(n = 100) {
    restore();
    return lines.slice(-n);
  },

  /** 导出用的完整文本：一段环境说明，加上留存的全部日志。 */
  getExportText() {
    restore();
    return [
      '对页 · 诊断日志',
      `导出于 ${new Date().toLocaleString('zh-CN')}`,
      `运行环境 ${navigator.userAgent}`,
      '',
      ...lines.slice(-MAX_LINES),
    ].join('\n');
  },

  clear() {
    lines = [];
    loaded = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
    try { localStorage.removeItem(STORE_KEY); } catch (_) { /* 无存储可清 */ }
  },
};

export default Logger;
