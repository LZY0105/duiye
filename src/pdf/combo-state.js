// PDF 模块 —— 组合：一套「书是怎么摆的」。
//
// 一个组合记的是**哪几本书、各在哪一栏、什么顺序、分栏怎么切**。
//
// 它**不记页码**。这是整个设计的重点，不是省事：
//
// 人保存组合的那一刻，手上那本书停在第 42 页。两天后他用这个组合把书开回来，
// 他要的是「我上次读到哪儿」，不是「我保存那天读到哪儿」——中间这两天他很可能
// 又翻了几十页。页码属于书，不属于摆法。document-session.js 已经替每一份资源
// 记着「最后被放下的位置」（recallDocView），开的时候现问一次就是对的。
//
// 在组合里存一份页码，等于给同一个问题造了第二个答案，而两个答案迟早会不一
// 样——到那时人只会看到「这个组合打开的页码是错的」，而不会知道错在哪一层。
//
// 条目存的是 {kind, resourceId}，不是条目 id。条目 id 是这一次会话里的身份
// （同一本书可以同时开在两栏，各有各的 id）；组合说的是「哪几本书」，用的时候
// 现建条目，新 id 由 deck-state 自己发。
//
// DOM-free、i18n-free，和旁边的 deck-state、shelf-state 一样：一套摆法是数据的
// 性质，不是渲染的性质，所以它可以在 Node 里单独测。

import { ENTRY_KINDS } from './deck-state.js';
import { ORIENTATIONS, SLOTS } from './workspace-state.js';

/** 名字多长、一栏最多摞几本。两个都只是防呆，不是设计上的限制。 */
export const COMBO_LIMITS = Object.freeze({
  NAME: 40,
  ENTRIES_PER_SLOT: 24,
});

const KINDS = new Set(Object.values(ENTRY_KINDS));

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clamp01 = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
};

/**
 * 一栏里的一本。
 *
 * kind 认不出来就当 PDF —— 这里宁可多开一本错类型的书，也不要因为一条坏记录让
 * 整个组合打不开。真正会出事的是 resourceId 空，那种直接丢掉。
 */
function cleanEntry(raw) {
  const resourceId = str(raw?.resourceId);
  if (!resourceId) return null;
  const kind = KINDS.has(raw?.kind) ? raw.kind : ENTRY_KINDS.PDF;
  return Object.freeze({ kind, resourceId });
}

function cleanSlot(raw) {
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  const entries = [];
  for (const one of list) {
    const entry = cleanEntry(one);
    if (entry) entries.push(entry);
    if (entries.length >= COMBO_LIMITS.ENTRIES_PER_SLOT) break;
  }
  // 活动项越界就落回第一本。空栏的 active 是 -1，不是 0——「这一栏是空的」和
  // 「这一栏开着第一本」是两回事。
  const wanted = Number.isInteger(raw?.active) ? raw.active : 0;
  const active = entries.length
    ? Math.min(entries.length - 1, Math.max(0, wanted))
    : -1;
  return Object.freeze({ entries: Object.freeze(entries), active });
}

/**
 * 一个组合。
 *
 * @param {Object} initial
 * @param {string} initial.id
 * @param {string} initial.name
 * @param {Object} initial.slots  {a: {entries, active}, b: {…}}
 * @param {number} initial.dividerRatio
 * @param {string} initial.orientation
 * @param {boolean} initial.swapped
 */
export function createCombo(initial = {}) {
  return Object.freeze({
    id: str(initial.id),
    name: str(initial.name).slice(0, COMBO_LIMITS.NAME),
    slots: Object.freeze({
      [SLOTS.PRIMARY]: cleanSlot(initial.slots?.[SLOTS.PRIMARY]),
      [SLOTS.SECONDARY]: cleanSlot(initial.slots?.[SLOTS.SECONDARY]),
    }),
    dividerRatio: clamp01(initial.dividerRatio),
    orientation: initial.orientation === ORIENTATIONS.COLUMN
      ? ORIENTATIONS.COLUMN
      : ORIENTATIONS.ROW,
    swapped: initial.swapped === true,
    createdAt: Number.isFinite(initial.createdAt) ? initial.createdAt : 0,
    updatedAt: Number.isFinite(initial.updatedAt) ? initial.updatedAt : 0,
  });
}

/**
 * 把此刻的工作区拍成一个组合。
 *
 * 只取摆法：两摞里每一本的类型和资源 id、各自开着第几本、分栏比例、横竖、左右
 * 是否对调过。**页码一个字都不取**，理由见文件开头。
 *
 * 收起来的那一栏（collapsedSlot）不特殊处理：它的摞是完整的，比例存的是
 * restoreRatio 那个「展开之后该多宽」，所以用这个组合开出来是两栏都在的样子。
 * 把「某一栏是收起来的」也存进去听上去更忠实，但那会让一个组合在打开时把半个
 * 屏幕藏起来，而人保存它的时候看到的是两栏——忠实于数据，不忠实于他看到的东西。
 */
export function comboFromWorkspace(state, { id, name, now = 0 } = {}) {
  const slotOf = (slot) => {
    const deck = state?.decks?.[slot];
    const entries = Array.isArray(deck?.entries) ? deck.entries : [];
    // 摞里记的是 activeId（这一次会话里的身份），组合里存的是**下标**：
    // 用组合开出来的是一批新条目，新 id 由 deck-state 现发，旧 id 指不到
    // 任何东西。下标说的是「这一摞里的第几本」，跨会话仍然成立。
    const at = entries.findIndex((e) => e?.id === deck?.activeId);
    return {
      entries: entries.map((e) => ({ kind: e?.kind, resourceId: e?.resourceId })),
      active: at >= 0 ? at : 0,
    };
  };
  const collapsed = state?.collapsedSlot;
  return createCombo({
    id,
    name,
    slots: { [SLOTS.PRIMARY]: slotOf(SLOTS.PRIMARY), [SLOTS.SECONDARY]: slotOf(SLOTS.SECONDARY) },
    // 收起来的时候 dividerRatio 是 0 或 1（那个位置本身就是「收起」的意思），
    // 存它等于存下一个立刻把半边藏掉的组合。
    dividerRatio: collapsed ? state?.restoreRatio : state?.dividerRatio,
    orientation: state?.orientation,
    swapped: state?.swapped,
    createdAt: now,
    updatedAt: now,
  });
}

/** 这个组合一共摆了几本。空组合没有保存的意义，调用方拿它拦。 */
export function comboSize(combo) {
  return comboSlots(combo).reduce((n, s) => n + s.entries.length, 0);
}

const comboSlots = (combo) => [
  combo?.slots?.[SLOTS.PRIMARY],
  combo?.slots?.[SLOTS.SECONDARY],
].filter(Boolean);

/**
 * 这个组合用到的资源 id，去重，按「先左栏后右栏、各自从前到后」。
 *
 * 画缩略图和「书删了之后修剪组合」都要它。
 */
export function comboResourceIds(combo) {
  const seen = new Set();
  const out = [];
  for (const slot of comboSlots(combo)) {
    for (const entry of slot.entries) {
      if (seen.has(entry.resourceId)) continue;
      seen.add(entry.resourceId);
      out.push(entry.resourceId);
    }
  }
  return out;
}

/**
 * 每一栏当前开着的那一本，没有就是 null。
 *
 * 缩略图画的是这两本——一个组合在书架上要一眼认出来，靠的是「哪两本并排」，
 * 而不是底下还摞着谁。
 */
export function comboFacing(combo) {
  const face = (slot) => {
    const s = combo?.slots?.[slot];
    if (!s || s.active < 0) return null;
    return s.entries[s.active] || null;
  };
  return { [SLOTS.PRIMARY]: face(SLOTS.PRIMARY), [SLOTS.SECONDARY]: face(SLOTS.SECONDARY) };
}

/**
 * 把删掉的资源从组合里摘掉。
 *
 * 书可以在存了组合之后被删。摘掉之后那一栏可能空了，整个组合也可能空了——空的
 * 由调用方决定是删掉还是留着，这里只回一个干净的结果和「动没动过」。
 *
 * @param {function(string): boolean} exists 这个资源还在不在
 */
export function pruneCombo(combo, exists) {
  if (typeof exists !== 'function') return { combo, changed: false };
  let changed = false;
  const slots = {};
  for (const slot of [SLOTS.PRIMARY, SLOTS.SECONDARY]) {
    const before = combo?.slots?.[slot];
    if (!before) { slots[slot] = { entries: [], active: -1 }; continue; }
    const kept = [];
    let active = -1;
    before.entries.forEach((entry, i) => {
      if (!exists(entry.resourceId)) { changed = true; return; }
      if (i === before.active) active = kept.length;
      kept.push(entry);
    });
    // 原来开着的那一本被删了：落回这一栏的第一本，而不是让它变成空栏。
    if (active < 0 && kept.length) active = 0;
    slots[slot] = { entries: kept, active };
  }
  if (!changed) return { combo, changed: false };
  return { combo: createCombo({ ...combo, slots }), changed: true };
}

export function serializeCombo(combo) {
  const slot = (s) => ({ entries: s.entries.map((e) => [e.kind, e.resourceId]), active: s.active });
  return {
    id: combo.id,
    name: combo.name,
    a: slot(combo.slots[SLOTS.PRIMARY]),
    b: slot(combo.slots[SLOTS.SECONDARY]),
    ratio: combo.dividerRatio,
    orientation: combo.orientation,
    swapped: combo.swapped,
    createdAt: combo.createdAt,
    updatedAt: combo.updatedAt,
  };
}

export function deserializeCombo(json) {
  const slot = (s) => ({
    entries: (Array.isArray(s?.entries) ? s.entries : []).map((e) => (
      Array.isArray(e) ? { kind: e[0], resourceId: e[1] } : e
    )),
    active: s?.active,
  });
  return createCombo({
    id: json?.id,
    name: json?.name,
    slots: { [SLOTS.PRIMARY]: slot(json?.a), [SLOTS.SECONDARY]: slot(json?.b) },
    dividerRatio: json?.ratio,
    orientation: json?.orientation,
    swapped: json?.swapped,
    createdAt: json?.createdAt,
    updatedAt: json?.updatedAt,
  });
}
