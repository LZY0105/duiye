// Ink Module —— 「插入图片」那张单子上的「最近照片」从哪儿来。
//
// 相册是 Android 的 MediaStore，网页够不着：列出最近的照片、要一张缩略图，走原生插件
// （android/…/files/PhotosPlugin.java）。整张图的字节和本机 PDF 走同一条路（pdf-files.js 的 readDevicePdf：
// 先走本地网址流过来，不行再一块一块地要）——读的是字节，不在乎是不是 PDF。
//
// 和 pdf-files.js 一样，没有原生层（浏览器里跑、测试）时诚实地说没有：photosAvailable() 回 false，单子上就
// 不摆「最近照片」那一块，只剩「拍照」「从图库中选择」（那两样走系统的选择器，哪儿都有）。
//
// 权限用的是导入 PDF 时已经要过的「所有文件访问」：有了它，查 MediaStore 看得见全部照片；没有它，只看得见
// 本应用自己存的，等于没有——那时单子上说一句、给一颗「去打开」。

import {
  FILES_ERRORS, hasFilesPermission, readDevicePdf, requestFilesPermission,
} from '../pdf/pdf-files.js';

function plugin() {
  const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return cap?.Plugins?.Photos || null;
}

export const PHOTO_ERRORS = Object.freeze({
  UNAVAILABLE: 'PHOTOS_UNAVAILABLE',
  NO_PERMISSION: FILES_ERRORS.NO_PERMISSION,
  READ_FAILED: 'PHOTOS_READ_FAILED',
});

/** 原生那一侧在不在。 */
export function photosAvailable() {
  return !!plugin();
}

export { hasFilesPermission as hasPhotosPermission, requestFilesPermission as requestPhotosPermission };

/**
 * 最近的几张照片，新的在前（截图也算——人刚截下来的那一张多半就是要贴的那一张）。
 * @returns {Promise<Array<{uri: string, name: string, width: number, height: number, mime: string, modified: number}>>}
 */
export async function recentPhotos(limit = 30) {
  const api = plugin();
  if (!api) throw new Error(PHOTO_ERRORS.UNAVAILABLE);
  try {
    const { photos } = await api.recent({ limit });
    // 原生那一侧只列网页解得开的几种（见 PhotosPlugin.PHOTO_TYPES）；这里再挡一道 SVG：
    // 它在相册里也算「图片」，可缩略图要不到、放也放不进来。
    return Array.isArray(photos) ? photos.filter((p) => !/svg/i.test(p?.mime || '')) : [];
  } catch (error) {
    if (String(error?.code || error?.message || '').includes('NO_PERMISSION')) {
      throw new Error(PHOTO_ERRORS.NO_PERMISSION);
    }
    throw new Error(PHOTO_ERRORS.READ_FAILED, { cause: error });
  }
}

/** 一张照片的缩略图：一个 data: 网址（JPEG，长边约 size 像素）。要不到就是 null，格子里留一块灰。 */
export async function photoThumbnail(uri, size = 240) {
  const api = plugin();
  if (!api || !uri) return null;
  try {
    const { data } = await api.thumbnail({ uri, size });
    return typeof data === 'string' && data.startsWith('data:') ? data : null;
  } catch (_) {
    return null;
  }
}

/** 整张照片的字节，包成 Blob（类型照相册记的）。 */
export async function readPhoto(photo) {
  const file = await readDevicePdf({ uri: photo.uri, name: photo.name, size: photo.size });
  return new Blob([await file.arrayBuffer()], { type: photo.mime || 'image/jpeg' });
}
