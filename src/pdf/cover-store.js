// PDF Module — 书的封面，存下来的那一份。
//
// 封面是 PDF 第一页渲出来的位图。渲一张要把整份文件解出来、排一页版、光栅化，
// 一本 827 页的书这套下来是几百毫秒；书架上有十几本，每次进文档库都重来一遍，
// 那就是每次进来都卡两三秒。所以渲一次就存下来，除非文件本身换了。
//
// 存的是 Blob 不是 dataURL：dataURL 要 base64，同一张图在 localStorage 里比原
// 图大三分之一，而且 localStorage 是同步的——往里写一张 40KB 的图会停住那一帧。
// Blob 进 IndexedDB，取出来用 createObjectURL 挂上去，是这条路上最省的一段。
//
// 自己一个库，不跟文档本体挤：封面是可以随时重算的东西，丢了不心疼；和「丢了
// 就是丢了」的原件放在一个库里，将来清缓存这类操作就不敢做了。

import { openDB } from 'idb';

const DB_NAME = 'duiye-covers';
const DB_VERSION = 1;
const STORE = 'covers';

let dbPromise = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

/**
 * 封面的「新鲜度签名」。
 *
 * 改名不该让封面作废——名字不在封面上。真正会让这张图不对的是：文件换了
 * （字节数变了）、页数变了、草稿纸换了纸样。签名对不上才重渲。
 */
export function coverSignature(item) {
  if (!item) return '';
  const style = item.style
    ? [item.style.patternId, item.style.paperTone, item.style.guideSpacing].join('.')
    : '';
  return [item.kind, item.sizeBytes || 0, item.pageCount || 0, style].join('|');
}

/** 存下来的那张图，签名对不上就当没有。 */
export async function readCover(id, signature) {
  if (!id) return null;
  try {
    const row = await (await getDB()).get(STORE, id);
    if (!row || !row.blob) return null;
    if (signature && row.signature !== signature) return null;
    return row.blob;
  } catch (_) {
    // 缓存取不到不是错误，重渲一张就是了。
    return null;
  }
}

export async function writeCover(id, blob, signature) {
  if (!id || !blob) return;
  try {
    await (await getDB()).put(STORE, { blob, signature, at: Date.now() }, id);
  } catch (_) {
    // 存不下（配额满了）也照样能显示，只是下次还得重渲。
  }
}

export async function forgetCover(id) {
  if (!id) return;
  try {
    await (await getDB()).delete(STORE, id);
  } catch (_) { /* 缓存删不掉不值得让删除文件这件事失败 */ }
}

/** 整架清空——换皮肤、改渲染参数这类会让所有封面一起过时的事。 */
export async function clearCovers() {
  try {
    await (await getDB()).clear(STORE);
  } catch (_) { /* 同上 */ }
}
