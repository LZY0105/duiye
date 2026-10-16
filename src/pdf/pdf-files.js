// PDF 模块 —— 本机 PDF 的来源。
//
// 网页这一侧只知道几件事：有没有权限、去要权限、本机有哪些 PDF，以及把导出的 PDF
// 写进「文档/对页」。查 MediaStore、写文件的那一半在
// android/…/files/PdfFilesPlugin.java，因为那是 Android 的 API，网页够不着
// （&lt;input type="file"&gt; 只能把人交给系统选择器，那是系统的样子，而且要人自己一
// 层层翻目录）。
//
// 这一层还负责一件事：**在没有原生插件的地方诚实地说没有**。浏览器里跑（开发、
// 测试）时 window.Capacitor 不在，available() 回 false，调用方退回系统选择器——
// 而不是抛一个谁也接不住的错。

/** 拿不到文件时的原因，调用方按这个分支给话说。 */
export const FILES_ERRORS = Object.freeze({
  UNAVAILABLE: 'PDF_FILES_UNAVAILABLE',
  NO_PERMISSION: 'PDF_FILES_NO_PERMISSION',
  READ_FAILED: 'PDF_FILES_READ_FAILED',
  WRITE_FAILED: 'PDF_FILES_WRITE_FAILED',
});

function plugin() {
  const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return cap?.Plugins?.PdfFiles || null;
}

/** 原生那一侧在不在。不在就是在浏览器里跑，调用方该退回系统选择器。 */
export function nativeFilesAvailable() {
  return !!plugin();
}

/** 有没有「所有文件访问权限」。没有原生层时一律 false，而不是抛错。 */
export async function hasFilesPermission() {
  const api = plugin();
  if (!api) return false;
  try {
    const { granted } = await api.hasPermission();
    return !!granted;
  } catch (_) {
    return false;
  }
}

/**
 * 把人送到系统设置里那一页。
 *
 * 它不等结果，也等不到：授权发生在另一个应用里。回来之后要重新问一次
 * hasFilesPermission——调用方是在 visibilitychange 回到前台时问的。
 */
export async function requestFilesPermission() {
  const api = plugin();
  if (!api) throw new Error(FILES_ERRORS.UNAVAILABLE);
  await api.requestPermission();
}

/**
 * 本机所有 PDF，新的在前。
 *
 * @returns {Promise<Array<{uri: string, name: string, size: number,
 *   modified: number, folder: string|null}>>}
 */
export async function listDevicePdfs() {
  const api = plugin();
  if (!api) throw new Error(FILES_ERRORS.UNAVAILABLE);
  let result;
  try {
    result = await api.list();
  } catch (error) {
    if (String(error?.code || error?.message || '').includes('NO_PERMISSION')) {
      throw new Error(FILES_ERRORS.NO_PERMISSION);
    }
    throw error;
  }
  return Array.isArray(result?.files) ? result.files : [];
}

/**
 * 一份 PDF 的字节。
 *
 * 原来是一次 read() 整份过桥：原生那边把整份读进内存、编成 base64，一份 315 兆的书在 Java 那边要
 * 申请 512 兆的缓冲，正撞上这台平板给应用的堆上限——抛 OutOfMemoryError，整个应用崩掉（人报
 * 「导入文件时软件会崩溃」，机上复现过）。网页这边也好不到哪去：base64 字符串、解出来的字符串、
 * 字节数组、再包成 File，同一份书同时躺四五份。
 *
 * 现在两条路，都是边读边放进一块事先按文件大小开好的内存里，从头到尾这边只有这一份字节：
 *
 *   1. 先走 Capacitor 自己的本地网址（convertFileSrc 把 content:// 换成 http://localhost/_capacitor_content_/…），
 *      fetch 按二进制一段一段地流过来，不过 base64。机上实测 315 兆 1.6 秒（约 195 MB/s）。
 *   2. 走不通（没权限、换不出网址、读到一半断了）就退回原生插件，一块一块地要（openRead / readChunk，
 *      每块 3 兆，base64 过桥）。慢——同一本 26 秒、901 兆 76 秒——但任何时刻桥上、Java 那边只有一块，
 *      机上读过 901 兆的那本也不崩。
 *
 * 回的不是 File：包成 File 又要整份拷一遍。回一个长得像 File 的东西（name、size、arrayBuffer()），
 * 下游的 importPdf 只用这几样，和系统选择器那条路照样在这里合并，往下只有一套导入。
 *
 * @param {{uri: string, name?: string, size?: number}} entry
 * @param {{onProgress?: function(number, number)}} [options] 读的过程中回调（已读、总共），大约每 1% 一次
 * @returns {Promise<{name: string, size: number, type: string, arrayBuffer: function(): Promise<ArrayBuffer>}>}
 */
export async function readDevicePdf(entry, { onProgress } = {}) {
  const api = plugin();
  if (!api) throw new Error(FILES_ERRORS.UNAVAILABLE);
  const report = throttled(onProgress);
  const fast = await readThroughLocalUrl(entry, report).catch(() => null);
  if (fast) return fast;
  return readThroughBridge(api, entry, report);
}

/**
 * 进度不用每一段都报：fetch 一本书能流过来几千段，每段都改一次状态栏是白忙。知道总数时每 1% 报一次
 * （读满那一下也算一格），不知道时每 1 兆报一次、总数报 0。读到比记的还多（文件在列表之后变大了），
 * 总数跟着已读走，不报出 101%。
 */
function throttled(onProgress) {
  if (!onProgress) return null;
  let last = -1;
  return (done, expected) => {
    const total = expected > 0 ? Math.max(expected, done) : 0;
    const mark = total > 0 ? Math.floor((done / total) * 100) : Math.floor(done / (1 << 20));
    if (mark === last) return;
    last = mark;
    onProgress(done, total);
  };
}

/** 一块按大小开好的内存，往里接着放；放不下（文件比记的大）就翻倍。 */
function growable(expected) {
  let bytes = new Uint8Array(expected > 0 ? expected : READ_CHUNK);
  let length = 0;
  return {
    get length() { return length; },
    push(part) {
      if (length + part.length > bytes.length) {
        const grown = new Uint8Array(Math.max(bytes.length * 2, length + part.length));
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(part, length);
      length += part.length;
    },
    /** 截成实际那么长：只有和记的不一样时才多拷一遍。 */
    take() { return length === bytes.length ? bytes : bytes.slice(0, length); },
  };
}

/**
 * 第一条路：Capacitor 的本地网址，fetch 流过来。换不出网址、回的不是 200、读到一半断了、长度对不上、
 * 一个字节也没读到，都回 null，交给第二条路——宁可慢，不可错。
 *
 * 打不开的时候不会把应用带崩：Capacitor 那边打开 content:// 时 SecurityException、IOException 都接住了，
 * 回的是 404（AndroidProtocolHandler.openContentUrl、WebViewLocalServer 里处理 _capacitor_content_ 那段）。
 */
async function readThroughLocalUrl(entry, report) {
  const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
  if (typeof cap?.convertFileSrc !== 'function' || typeof fetch !== 'function') return null;
  const url = cap.convertFileSrc(entry.uri);
  if (!url || url === entry.uri) return null;
  const response = await fetch(url);
  if (!response.ok || !response.body) return null;
  // 原生那边给了长度就按它核对，没给就按列表里记的那个数。对不上——读到一半断了，或者文件在列表之后
  // 又变了——都交给第二条路，它会问原生那边现在的大小。
  const expected = Number(response.headers.get('content-length')) || Number(entry.size) || 0;
  const into = growable(expected);
  const reader = response.body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      into.push(value);
      report?.(into.length, expected);
    }
    finished = true;
  } finally {
    // 半路不读了（放不下、出错）把流关掉，别让原生那边一直开着这个文件。
    if (!finished) reader.cancel().catch(() => { /* 已经断了的流关不关都一样 */ });
  }
  if (into.length === 0 || (expected && into.length !== expected)) return null;
  return devicePdf(entry.name || 'document.pdf', into.take());
}

/** 第二条路：原生插件一块一块地给（见 PdfFilesPlugin.openRead / readChunk）。 */
async function readThroughBridge(api, entry, report) {
  let token;
  let size;
  try {
    ({ token, size } = await api.openRead({ uri: entry.uri }));
  } catch (error) {
    if (String(error?.code || error?.message || '').includes('NO_PERMISSION')) {
      throw new Error(FILES_ERRORS.NO_PERMISSION);
    }
    throw new Error(FILES_ERRORS.READ_FAILED, { cause: error });
  }
  // 原生那边问不出大小时（有的 provider 不给）退到列表里记的那个数，再不行就边读边长。
  const known = Number(size) > 0 ? Number(size) : Number(entry.size) || 0;
  const into = growable(known);
  let done = false;
  try {
    while (!done) {
      const chunk = await api.readChunk({ token });
      if (typeof chunk?.data !== 'string') throw new Error(FILES_ERRORS.READ_FAILED);
      done = !!chunk.done;
      const binary = atob(chunk.data);
      const part = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) part[i] = binary.charCodeAt(i);
      into.push(part);
      report?.(into.length, known);
    }
  } catch (error) {
    throw new Error(FILES_ERRORS.READ_FAILED, { cause: error });
  } finally {
    // 读到头时原生那边已经自己关了；出错、半路不读了也要关，不然那个流一直开着。
    if (!done) api.closeRead({ token }).catch(() => { /* 关不掉也只是一个没人用的流 */ });
  }
  return devicePdf(entry.name || 'document.pdf', into.take());
}

/** 每一趟过桥带多少字节，和原生那边的 READ_CHUNK 一样（3 MiB：3 的倍数，base64 中间不带填充）。 */
const READ_CHUNK = 3 << 20;

/** 长得像 File 的一份 PDF：importPdf、确认角色那张单子只用 name、size、arrayBuffer()。 */
function devicePdf(name, bytes) {
  return {
    name,
    size: bytes.length,
    type: 'application/pdf',
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}

/**
 * Uint8Array → base64。分块拼：一次把几兆字节塞进 String.fromCharCode 会撑爆调用栈。
 */
function toBase64(bytes) {
  let binary = '';
  const STEP = 0x8000;
  for (let at = 0; at < bytes.length; at += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + STEP));
  }
  return btoa(binary);
}

/** 每一趟过桥带多少字节。3 MiB 正好是 3 的倍数，编出来的 base64 中间不带填充。 */
const EXPORT_CHUNK = 3 << 20;

/**
 * 把一份导出的 PDF 写进「文档/对页」，一块一块地写。
 *
 * 不是一次交过去：Capacitor 的桥只走 JSON，一本两百兆的书编成 base64 是两百七十兆的
 * 一个字符串，在 WebView 和原生两头各躺一份，平板上是会被系统杀掉的量。切成每块几
 * 兆，任何时刻桥上都只有一块。
 *
 * 原生那边先写进一个隐藏的临时文件，全部写完才改成真名字——写到一半出了错，文件夹
 * 里不会留下一份打不开的半截 PDF。
 *
 * @param {Uint8Array} bytes
 * @param {string} name 想要的文件名；重名时原生那边会加「(2)」
 * @param {{onProgress?: function(number, number)}} [options]
 * @returns {Promise<{name: string, folder: string, path: string}>}
 */
export async function writeExportFile(bytes, name, { onProgress } = {}) {
  const api = plugin();
  if (!api) throw new Error(FILES_ERRORS.UNAVAILABLE);
  let token;
  try {
    ({ token } = await api.beginExport({ name }));
  } catch (error) {
    if (String(error?.code || error?.message || '').includes('NO_PERMISSION')) {
      throw new Error(FILES_ERRORS.NO_PERMISSION);
    }
    throw new Error(FILES_ERRORS.WRITE_FAILED, { cause: error });
  }
  try {
    const total = bytes.length;
    for (let at = 0; at < total; at += EXPORT_CHUNK) {
      const end = Math.min(total, at + EXPORT_CHUNK);
      await api.appendExport({ token, data: toBase64(bytes.subarray(at, end)) });
      onProgress?.(end, total);
    }
    return await api.finishExport({ token });
  } catch (error) {
    api.abortExport({ token }).catch(() => { /* 临时文件是隐藏的，留下也不碍事 */ });
    throw new Error(FILES_ERRORS.WRITE_FAILED, { cause: error });
  }
}
