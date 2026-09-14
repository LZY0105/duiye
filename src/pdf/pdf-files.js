// PDF 模块 —— 本机 PDF 的来源。
//
// 网页这一侧只知道三件事：有没有权限、去要权限、以及本机有哪些 PDF。查 MediaStore
// 的那一半在 android/…/files/PdfFilesPlugin.java，因为那是 Android 的 API，网页够
// 不着（&lt;input type="file"&gt; 只能把人交给系统选择器，那是系统的样子，而且要人
// 自己一层层翻目录）。
//
// 这一层还负责一件事：**在没有原生插件的地方诚实地说没有**。浏览器里跑（开发、
// 测试）时 window.Capacitor 不在，available() 回 false，调用方退回系统选择器——
// 而不是抛一个谁也接不住的错。

/** 拿不到文件时的原因，调用方按这个分支给话说。 */
export const FILES_ERRORS = Object.freeze({
  UNAVAILABLE: 'PDF_FILES_UNAVAILABLE',
  NO_PERMISSION: 'PDF_FILES_NO_PERMISSION',
  READ_FAILED: 'PDF_FILES_READ_FAILED',
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
