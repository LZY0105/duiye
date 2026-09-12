// PDF Module — 书架的顺序。
//
// 文档库原来是一张表：每份文件一行，行里是名字、页数、大小，右边一排按钮。
// 表读起来是「查」，而人对自己的书不是查，是认——认封面、认厚薄、认摆在哪。
// 所以它现在是一排书，而这里管的是这排书怎么排。
//
// 不按日期分组。分组会把同一批东西拆到两个标题底下，于是「我那本」在哪要先
// 想是哪一天的；而且组会随时间自己变（今天在「最近 7 天」，下周就不在了），
// 位置不稳定的东西记不住。一整排，一个顺序，位置只在你自己动过它时才变。
//
// DOM-free，和旁边的 deck-state、panel-state、bookmark-state 一样：顺序是数据
// 的性质，不是渲染的性质，所以它可以在 Node 里单独测。

/** 书架上摆的两种东西。草稿纸也是书，只是它的封面是纸本身。 */
export const SHELF_KINDS = Object.freeze({ DOC: 'doc', PAD: 'pad' });

const str = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v : fallback);
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/**
 * 把文档和草稿纸并成一排，按「最近读过的在前」排好。
 *
 * @param {Array} docs    listDocuments() 的结果
 * @param {Array} pads    listScratchpads() 的结果
 * @param {Array<string>} recent  最近打开过的 id，越靠前越近
 * @returns {ReadonlyArray} 冻结的书架条目
 */
export function shelfItems(docs = [], pads = [], recent = []) {
  // 名次表：查一次 O(1)，而不是每次比较都去数组里找。
  const rank = new Map();
  if (Array.isArray(recent)) {
    recent.forEach((id, i) => { if (id && !rank.has(id)) rank.set(id, i); });
  }

  const items = [];
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (!doc?.id) continue;
    items.push(Object.freeze({
      id: doc.id,
      kind: SHELF_KINDS.DOC,
      name: str(doc.name, '未命名文档'),
      role: str(doc.role),
      pageCount: num(doc.pageCount),
      sizeBytes: num(doc.sizeBytes),
      hasOutline: !!doc.hasOutline,
      style: null,
      addedAt: num(doc.importedAt),
      // 没读过的排在读过的后面，而不是排在最前：书架的前排是「手边那几本」。
      rank: rank.has(doc.id) ? rank.get(doc.id) : Infinity,
    }));
  }
  for (const pad of Array.isArray(pads) ? pads : []) {
    if (!pad?.id) continue;
    items.push(Object.freeze({
      id: pad.id,
      kind: SHELF_KINDS.PAD,
      name: str(pad.name, '草稿纸'),
      role: '',
      pageCount: 1,
      sizeBytes: num(pad.sizeBytes),
      hasOutline: false,
      style: pad.style || null,
      addedAt: num(pad.updatedAt) || num(pad.createdAt),
      rank: rank.has(pad.id) ? rank.get(pad.id) : Infinity,
    }));
  }

  // 两级：先看多久以前读过，读过的里面按远近；都没读过就按什么时候进来的。
  // 第三级按 id，只是为了让两份时间戳一模一样的东西也有个定死的先后——顺序
  // 稳定比顺序「对」更要紧，人是靠位置记住书的。
  items.sort((a, b) => (a.rank - b.rank) || (b.addedAt - a.addedAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze(items);
}

/**
 * 一本书至少要多宽。
 *
 * 「一行只摆几本」这件事最后是 CSS 的 grid 做的，不是这里算的——算一遍再让
 * CSS 再算一遍，两个数迟早会对不上，而对不上的时候没人知道该信哪个。所以这里
 * 只放那一个数，CSS 去用它，测试去盯着它俩一致。
 *
 * 240 不是随手写的：书缩到两百像素以下就认不出封面了，而认封面正是这排书存在
 * 的理由。宁可往下滚，也不把八本塞成一行邮票。横屏平板上它是一行四本。
 */
export const BOOK_MIN_WIDTH = 240;

/** 书脊上印什么——没有别名时就印它自己是什么。 */
export function shelfSubtitle(item) {
  if (!item) return '';
  if (item.kind === SHELF_KINDS.PAD) return '草稿纸';
  return item.pageCount > 0 ? `${item.pageCount} 页` : '';
}
