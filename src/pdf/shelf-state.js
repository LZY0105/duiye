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

/**
 * 书架上摆的三种东西。
 *
 * 草稿纸和笔记本也是书，只是它们的封面是纸本身。笔记本和 PDF 一样有页数，所以
 * 书脊上印的是页数；草稿纸只有一张纸，印的是它自己是什么。
 */
export const SHELF_KINDS = Object.freeze({
  DOC: 'doc', PAD: 'pad', NOTE: 'note', COMBO: 'combo', FOLDER: 'folder',
});

const str = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v : fallback);
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/**
 * 把文档和草稿纸并成一排，按「最近读过的在前」排好。
 *
 * @param {Array} docs    listDocuments() 的结果
 * @param {Array} pads    listScratchpads() 的结果
 * @param {Array<string>} recent  最近打开过的 id，越靠前越近
 * @param {Array} notes   listNotebooks() 的结果
 * @param {Array} combos  listCombos() 的结果
 * @returns {ReadonlyArray} 冻结的书架条目
 */
export function shelfItems(docs = [], pads = [], recent = [], notes = [], combos = [], view = {}) {
  // 文件夹把这排书分成两批：在某个文件夹里的，和还摆在外面的。
  //
  // 摊开书架看到的是外面那一批加上几个文件夹；点进一个文件夹，看到的只有它里面
  // 那一批。同一套排序两边都用——进了文件夹，书的先后不该换一套规矩。
  const members = view.members || {};
  const openFolderId = view.openFolderId || null;
  const inThisView = (id) => (members[id] || null) === openFolderId;
  // 名次表：查一次 O(1)，而不是每次比较都去数组里找。
  const rank = new Map();
  if (Array.isArray(recent)) {
    recent.forEach((id, i) => { if (id && !rank.has(id)) rank.set(id, i); });
  }

  const items = [];
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (!doc?.id || !inThisView(doc.id)) continue;
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
    if (!pad?.id || !inThisView(pad.id)) continue;
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

  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note?.id || !inThisView(note.id)) continue;
    items.push(Object.freeze({
      id: note.id,
      kind: SHELF_KINDS.NOTE,
      name: str(note.name, '笔记本'),
      role: '',
      pageCount: num(note.pageCount, 1),
      // 真的是 0。空白页不占存储，算进「文档库用了多少空间」是在说谎。
      sizeBytes: 0,
      hasOutline: false,
      style: note.style || null,
      addedAt: num(note.updatedAt) || num(note.createdAt),
      rank: rank.has(note.id) ? rank.get(note.id) : Infinity,
    }));
  }

  // 组合不是一份文件，是一套摆法：它没有页数、没有体积、也不会被「读过」。
  //
  // 它排在最前面，而且不参与上面那套「最近读过的在前」。理由是用法不同——
  // 书是一本一本挑的，组合是「我要回到那个状态」，那是进文档库之前就想好的
  // 事。让它和书混在一起按时间浮沉，人每次都得先找一遍。
  const combined = [];
  for (const combo of Array.isArray(combos) ? combos : []) {
    if (!combo?.id || !inThisView(combo.id)) continue;
    combined.push(Object.freeze({
      id: combo.id,
      kind: SHELF_KINDS.COMBO,
      name: str(combo.name, '组合'),
      role: '',
      pageCount: 0,
      sizeBytes: 0,
      hasOutline: false,
      style: null,
      addedAt: num(combo.updatedAt) || num(combo.createdAt),
      rank: Infinity,
      /** 摆了几本。书脊那一行印它，而不是印页数——组合没有页数。 */
      comboSize: countCombo(combo),
    }));
  }
  combined.sort((a, b) => (b.addedAt - a.addedAt) || (a.id < b.id ? -1 : 1));

  // 两级：先看多久以前读过，读过的里面按远近；都没读过就按什么时候进来的。
  // 第三级按 id，只是为了让两份时间戳一模一样的东西也有个定死的先后——顺序
  // 稳定比顺序「对」更要紧，人是靠位置记住书的。
  items.sort((a, b) => (a.rank - b.rank) || (b.addedAt - a.addedAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 文件夹只摆在最外面那一层。一层就够，不嵌套——理由写在 folder-state.js 开头。
  //
  // 它们排在组合之后、书之前：组合说的是「回到那个状态」，文件夹说的是「往里
  // 找」，书才是「就是它」。三种事，从粗到细。
  const folders = [];
  if (!openFolderId) {
    for (const folder of Array.isArray(view.folders) ? view.folders : []) {
      if (!folder?.id) continue;
      let count = 0;
      for (const value of Object.values(members)) if (value === folder.id) count += 1;
      folders.push(Object.freeze({
        id: folder.id,
        kind: SHELF_KINDS.FOLDER,
        name: str(folder.name, '文件夹'),
        role: '',
        pageCount: 0,
        sizeBytes: 0,
        hasOutline: false,
        style: null,
        addedAt: num(folder.createdAt),
        rank: Infinity,
        /** 里面有几份东西。书脊那一行印它。 */
        folderSize: count,
      }));
    }
    folders.sort((a, b) => (a.addedAt - b.addedAt) || (a.id < b.id ? -1 : 1));
  }

  return Object.freeze([...combined, ...folders, ...items]);
}

/**
 * 一个组合摆了几本。
 *
 * 这里自己数，不从 combo-state 引：那边会引回 deck-state 和 workspace-state，
 * 而这个文件是刻意没有依赖的——顺序是数据的性质，要能在 Node 里单独测。
 */
function countCombo(combo) {
  let n = 0;
  for (const slot of ['a', 'b']) {
    const entries = combo?.slots?.[slot]?.entries;
    if (Array.isArray(entries)) n += entries.length;
  }
  return n;
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
  // 组合印的是它摆了几本。页数对它没有意义——它不是一份文件。
  if (item.kind === SHELF_KINDS.COMBO) return `${item.comboSize || 0} 本`;
  // 文件夹印的是里面有几份。空文件夹也要说出来——「0 项」和什么都不印，后者
  // 看着像还没数完。
  if (item.kind === SHELF_KINDS.FOLDER) return `${item.folderSize || 0} 项`;
  if (item.kind === SHELF_KINDS.PAD) return '草稿纸';
  // 笔记本落到下面那行：它有页数，而页数正是「这本厚不厚」这个问题的答案。
  return item.pageCount > 0 ? `${item.pageCount} 页` : '';
}
