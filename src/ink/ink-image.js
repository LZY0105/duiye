// Ink Module —— 贴在页上的图片：存图、取图、画之前先解码好、新放一张进来。
//
// 一张图片在笔迹层里是「一笔」（stroke.js 的 IMAGE_TOOL）：四个点是图的四个角，image.id 指着这里存的那张图。
// 图本身不进笔迹的存档：一页笔迹每改一笔就整页存一次，一张几百 K 的图跟着存一遍又一遍不划算。它另存在自己的
// IndexedDB 库里，一张图一条，按 id 取；复制、跨栏拖出来的那一份指着同一张，不另存。
//
// 画是同步的（ink-renderer 每一帧都要画），解码是异步的：imageFor(id) 解好了就给、没解过就去解，解好了叫一声
// （onImageReady），看着这一页的画布重画一次。导出、截图要一次画完，先 whenImagesReady 等齐了再画。

import { openDB } from 'idb';
import { IMAGE_TOOL, createStroke, isImageStroke, recomputeBounds } from './stroke.js';

const DB_NAME = 'latexsnipper-images';
const DB_VERSION = 1;
const STORE = 'images';

/**
 * 放进来的图最长边最多多少像素，再大就缩。手机拍的照片四千多像素，贴在页上用不着：存着占地方，解开一张就是
 * 六七十兆。2048 放大到半页宽也还清楚，图里的公式照样认得出。
 */
export const IMAGE_MAX_SIDE = 2048;

/** 解好的图最多留几张。一张 2048 的解开是十几兆，翻过去的那几页不必一直占着。 */
const DECODED_MAX = 24;

let dbPromise = null;
/** 没有 IndexedDB 的地方（Node 里跑的测试）就记在内存里。 */
const memory = new Map();

function getDB() {
  if (typeof indexedDB === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

function newImageId() {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 存一张图，回它的 id。
 * @param {Blob} blob
 * @param {{width: number, height: number}} size 像素
 * @returns {Promise<string>}
 */
export async function putImage(blob, { width, height }) {
  const id = newImageId();
  const record = { id, blob, type: blob?.type || 'image/jpeg', width, height, createdAt: Date.now() };
  const db = await getDB();
  if (db) await db.put(STORE, record);
  else memory.set(id, record);
  return id;
}

/** 取一张图：{ id, blob, type, width, height }，没有就是 null。 */
export async function getImage(id) {
  if (!id) return null;
  if (memory.has(id)) return memory.get(id);
  const db = await getDB();
  return db ? (await db.get(STORE, id)) || null : null;
}

/** 删一张图（只有收拾图片库时用，见 removeUnusedImages）。 */
async function deleteImage(id) {
  memory.delete(id);
  const db = await getDB();
  if (db) await db.delete(STORE, id);
}

/** 库里存着的每一张：id 和存进来的时候。一条一条地读，图本身不读出来。 */
async function storedImages() {
  const db = await getDB();
  if (!db) return [...memory.values()].map(({ id, createdAt }) => ({ id, createdAt }));
  const out = [];
  let cursor = await db.transaction(STORE).store.openCursor();
  while (cursor) {
    out.push({ id: cursor.value.id, createdAt: Number(cursor.value.createdAt) || 0 });
    cursor = await cursor.continue();
  }
  return out;
}

/**
 * 收拾图片库：没有一页存着的笔迹指着、这一次打开里也没出现过、又存了 keepDays 天以上的图，删掉。
 *
 * 图另存在这里（笔迹里只记它是哪一张）：一张图从页上删掉、撤销记录也走了以后，库里那一份就没人要了，平板上
 * 一张截图一两兆，攒下去是实打实的地方。三条都满足才删，宁可多留：
 *   - 存着的笔迹都不指着它（ink-store.js 的 imageIdsInUse，正在存、还没落到库里的那几页也算）；
 *   - 这一次打开里没画过它（seen）：删掉的图能撤销回来，撤销记录只活在这一次打开里，而撤销得回来的那一张
 *     一定是画过的；
 *   - 存进来已经 keepDays 天以上：刚放进来、还没来得及存盘的那一张碰不到。
 *
 * @param {Set<string>} inUse
 * @param {{now?: number, keepDays?: number}} [options]
 * @returns {Promise<number>} 删了几张
 */
export async function removeUnusedImages(inUse, { now = Date.now(), keepDays = 7 } = {}) {
  const cutoff = now - keepDays * 86400000;
  let removed = 0;
  for (const { id, createdAt } of await storedImages()) {
    if (inUse.has(id) || seen.has(id) || !(createdAt < cutoff)) continue;
    await deleteImage(id);
    removed++;
  }
  return removed;
}

/** 上一次收拾图片库是什么时候（localStorage），一天最多一次。 */
const SWEEP_KEY = 'ls_image_sweep';
const SWEEP_EVERY_MS = 86400000;

/**
 * 一天最多收拾一次图片库（开机过一会儿由 app.js 叫）。读得出哪些图有人用才删；读不出来（库打不开、出错）
 * 就什么都不删，下次再说。
 * @param {function(): Promise<Set<string>>} loadInUse ink-store.js 的 imageIdsInUse
 * @returns {Promise<number>} 删了几张；这一次不该收拾就是 0
 */
export async function sweepUnusedImages(loadInUse, { now = Date.now() } = {}) {
  try {
    const last = Number(globalThis.localStorage?.getItem(SWEEP_KEY)) || 0;
    if (now - last < SWEEP_EVERY_MS) return 0;
    const removed = await removeUnusedImages(await loadInUse(), { now });
    globalThis.localStorage?.setItem(SWEEP_KEY, String(now));
    return removed;
  } catch (_) {
    return 0;
  }
}

// ── 解码 ──────────────────────────────────────────────────────────────────

/** id → { state: 'loading'|'ready'|'failed', image, version, promise }。插入顺序就是最近用过的顺序。 */
const decoded = new Map();
const listeners = new Set();
/** 这一次打开里画过、放进来过的图（收拾图片库时不碰它们，见 removeUnusedImages）。 */
const seen = new Set();

/** 有一张图解好（或者解不出来）了。回一个取消订阅的函数。 */
export function onImageReady(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 画的时候问：解好了就给；没解过就去解（解好了 onImageReady 叫一声）；正在解、解不出来都是 null。 */
export function imageFor(id) {
  if (!id) return null;
  seen.add(id);
  const entry = decoded.get(id);
  if (!entry) {
    load(id);
    return null;
  }
  decoded.delete(id);
  decoded.set(id, entry);
  return entry.state === 'ready' ? entry.image : null;
}

/** 这张图解到哪一步了：0 还没好，1 好了，-1 解不出来。画布拿它判断缓存的那张图还对不对。 */
export function imageVersion(id) {
  return decoded.get(id)?.version ?? 0;
}

/** 这几笔里的图片都是哪几张。 */
export function imageIdsOf(strokes) {
  const ids = new Set();
  for (const stroke of strokes || []) if (isImageStroke(stroke)) ids.add(stroke.image.id);
  return [...ids];
}

/** 等这几张都解好（导出、截图要一次画完）。解不出来的不等、不报错：画的时候那儿是一块淡灰。 */
export function whenImagesReady(ids) {
  return Promise.all([...new Set(ids || [])].map((id) => load(id).catch(() => null)));
}

/** 刚放进来的那一张：手里已经有画好的，直接记上，不必再从库里读一遍、解一遍。 */
export function rememberDecoded(id, image) {
  if (!id || !image) return;
  seen.add(id);
  decoded.set(id, { state: 'ready', image, version: 1, promise: Promise.resolve(image) });
  trim();
  announce(id);
}

function load(id) {
  seen.add(id);
  const known = decoded.get(id);
  if (known?.promise) return known.promise;
  const entry = { state: 'loading', image: null, version: 0, promise: null };
  decoded.set(id, entry);
  entry.promise = (async () => {
    try {
      const record = await getImage(id);
      if (!record?.blob) throw new Error('IMAGE_MISSING');
      entry.image = await decodeBlob(record.blob);
      entry.state = 'ready';
      entry.version = 1;
    } catch (_) {
      entry.state = 'failed';
      entry.version = -1;
    }
    trim();
    announce(id);
    return entry.image;
  })();
  return entry.promise;
}

function announce(id) {
  for (const fn of [...listeners]) {
    try { fn(id); } catch (_) { /* 一块画布出错不连累别的 */ }
  }
}

/** 超过 DECODED_MAX 就放掉最久没用的那几张（正在解的不动）。放掉的下次要画时再解。 */
function trim() {
  for (const [id, entry] of decoded) {
    if (decoded.size <= DECODED_MAX) return;
    if (entry.state === 'loading') continue;
    decoded.delete(id);
    entry.image?.close?.();
  }
}

/**
 * 一份图片字节 → 能画的东西。createImageBitmap 会照照片里记的方向（EXIF）转正；没有它（老 WebView、测试）
 * 退回 <img>。
 */
export async function decodeBlob(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') throw new Error('IMAGE_UNDECODABLE');
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    if (typeof img.decode === 'function') await img.decode();
    else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeCanvas(width, height) {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  throw new Error('IMAGE_NO_CANVAS');
}

function encode(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('IMAGE_ENCODE_FAILED'))), type, quality);
  });
}

/**
 * 人挑的一张图（相机、图库、最近照片）→ 存进库里的那一份。
 *
 * 一律过一遍画布再编码：照片里记的方向转正了（导出 PDF 时嵌进去的是字节，PDF 不认 EXIF，不转正就是躺着的），
 * 太大的缩到 IMAGE_MAX_SIDE，HEIC 之类 PDF 不认的格式也换掉。截图、PNG 这种字多、边缘利的还存 PNG（JPEG 的
 * 毛边会让图里的公式认不清）；照片存 JPEG。JPEG 没有透明：先垫一层白。
 *
 * @param {Blob} source
 * @returns {Promise<{blob: Blob, width: number, height: number, canvas: object}>} canvas 是画好的那一张，可以
 *   直接拿去画（rememberDecoded），不用再解一遍
 */
export async function prepareImage(source) {
  if (!source || !(source.size > 0)) throw new Error('IMAGE_EMPTY');
  let bitmap;
  try {
    bitmap = await decodeBlob(source);
  } catch (error) {
    throw new Error('IMAGE_UNREADABLE', { cause: error });
  }
  const w0 = bitmap.width || bitmap.naturalWidth || 0;
  const h0 = bitmap.height || bitmap.naturalHeight || 0;
  if (!w0 || !h0) throw new Error('IMAGE_UNREADABLE');
  const k = Math.min(1, IMAGE_MAX_SIDE / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * k));
  const height = Math.max(1, Math.round(h0 * k));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('IMAGE_NO_CANVAS');
  const png = /png|gif|webp|bmp/i.test(source.type || '');
  if (!png) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await encode(canvas, png ? 'image/png' : 'image/jpeg', 0.92);
  return { blob, width, height, canvas };
}

/**
 * 一张 width×height 的图放进 box（文档坐标的框）里：等比缩到正好放得下，在框里居中。
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function fitImageRect(width, height, box) {
  const bw = box.maxX - box.minX;
  const bh = box.maxY - box.minY;
  const k = Math.min(bw / Math.max(1, width), bh / Math.max(1, height));
  const w = width * k;
  const h = height * k;
  return { x: box.minX + (bw - w) / 2, y: box.minY + (bh - h) / 2, width: w, height: h };
}

/**
 * 一张图片的「笔」：四个点是四个角（左上、右上、右下、左下），image 记它是哪一张、原来多大。
 * @param {{id: string, width: number, height: number}} image
 * @param {{x: number, y: number, width: number, height: number}} rect 文档坐标
 */
export function createImageStroke(image, rect) {
  const stroke = createStroke({ tool: IMAGE_TOOL, color: '#000000', width: 0, opacity: 1 });
  stroke.image = { id: image.id, w: image.width, h: image.height };
  const { x, y, width: w, height: h } = rect;
  stroke.points = [
    { x, y, p: 0.5 }, { x: x + w, y, p: 0.5 },
    { x: x + w, y: y + h, p: 0.5 }, { x, y: y + h, p: 0.5 },
  ];
  recomputeBounds(stroke);
  return stroke;
}

/**
 * 图片放进这一层的哪个位置：在已有的图片上面、所有笔迹下面。图是垫在底下的纸——在它上面写字、圈字，字都在
 * 图上面；后放的图压着先放的。
 */
export function imageInsertIndex(layer) {
  const strokes = layer?.getAll?.() || [];
  let index = 0;
  strokes.forEach((stroke, i) => { if (isImageStroke(stroke)) index = i + 1; });
  return index;
}
