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
 * 原生那边回的是 base64（Capacitor 的桥只走 JSON），这里解回 Uint8Array 再包成
 * File —— 因为下游的 importPdf 收的就是 File/Blob，和系统选择器那条路共用同一个
 * 入口。两条路在这里合并，往下就只有一条。
 */
export async function readDevicePdf(entry) {
  const api = plugin();
  if (!api) throw new Error(FILES_ERRORS.UNAVAILABLE);
  let data;
  try {
    ({ data } = await api.read({ uri: entry.uri }));
  } catch (error) {
    throw new Error(FILES_ERRORS.READ_FAILED, { cause: error });
  }
  if (typeof data !== 'string') throw new Error(FILES_ERRORS.READ_FAILED);

  // atob 一次解完一份两百兆的书会把主线程按住好几秒，所以分块。这里不是在省总时
  // 间——总量一样多——是在把它切成不会让界面卡死的小段。
  const CHUNK = 1 << 20;
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += CHUNK) {
    const end = Math.min(binary.length, at + CHUNK);
    for (let i = at; i < end; i++) bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], entry.name || 'document.pdf', { type: 'application/pdf' });
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
