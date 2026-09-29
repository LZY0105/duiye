// PDF 模块 —— 自由组合：不先摆好，直接拼一套。
//
// 原来只有一条路能得到组合：把两栏摆成你要的样子，再「存为组合」。那条路对「我刚
// 才摆的这一套挺好用」很合适，对「我知道下周要用哪两本」很不合适——为了记下一套摆
// 法，人得先真的把它摆出来，等两本几百页的书都载进来，再回头存一次。
//
// 这张单子把顺序倒过来：先说要哪几本、分别在哪一栏，存下来，然后才打开。载入只发
// 生一次，而且是在他已经确定了的时候。
//
// 长得像「整理内容」（deck-organizer）不是省事：那张单子回答的是「这几本各在哪一
// 栏」，这张回答的也是同一个问题，只不过一个是在改现成的，一个是在从零拼。同一个
// 问题该长成同一个样子，否则人得学两遍。所以那边有的这边也有：按住把手拖到另一栏、
// 拖上拖下换顺序（每栏最上面那一本打开时露在外面），以及不拖也够得着的「移到另一
// 栏」。拖动用的就是整理内容那一份（list-drag.js），不是照着它另写一份。
//
// 这里不碰存储，也不碰工作区：挑东西、起名字、落盘都由调用方递进来。所以这张单子
// 在测试里能整个跑起来，不需要 IndexedDB，也不需要一个真的工作区。

import { t } from '../core/i18n.js';
import { ENTRY_KINDS, kindKeyFor } from './deck-state.js';
import { SLOTS, ORIENTATIONS } from './workspace-state.js';
import { installListDrag } from './list-drag.js';

/** 摞里这一项叫什么 —— 键在 deck-state，文案在这里。 */
const kindLabelFor = (kind) => t(kindKeyFor(kind));

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** 一栏最多摆几本。和 combo-state 的上限同源，这里只是不让人白挑。 */
const PER_SLOT = 24;

/**
 * 两栏在屏幕上叫什么。
 *
 * 默认是左、右：组合存成不对调（swapped: false），PRIMARY 就画在左边。竖着拿平板
 * 时两栏是上下叠的，那时调用方会递进来「上栏 / 下栏」——这张单子说的必须是人待会
 * 儿在屏幕上真看到的位置，不是一个抽象的「第一栏」。
 */
const defaultPositions = () => [
  { slot: SLOTS.PRIMARY, position: t('deck.left') },
  { slot: SLOTS.SECONDARY, position: t('deck.right') },
];

/** 拼到一半的那套摆法，拍一张。撤销靠它，深拷到条目这一层就够——条目本身不改。 */
const snapshot = (slots) => ({
  [SLOTS.PRIMARY]: [...slots[SLOTS.PRIMARY]],
  [SLOTS.SECONDARY]: [...slots[SLOTS.SECONDARY]],
});

const other = (slot) => (slot === SLOTS.PRIMARY ? SLOTS.SECONDARY : SLOTS.PRIMARY);

/**
 * 摊开「自由组合」。
 *
 * @param {Object} options
 * @param {Array} options.items 能摆上去的东西，[{id, kind, name, sub}]
 * @param {Array} [options.positions] 两栏在屏幕上叫什么，[{slot, position}]，按屏幕顺序
 * @param {function} options.pick 挑东西：pick({slot, position, inThis, inOther}) → id[]|null
 * @param {function} options.askName 起名字：askName(suggested) → string|null
 * @param {function} options.save 落盘：save(draft) → {ok: true, combo} | {ok: false, message}
 * @param {string} [options.replaceNote] 保存并打开会换掉什么——有东西开着时才给
 * @param {number} [options.dividerRatio] 分栏比例，默认对半
 * @returns {Promise<Object|null>} 存好的那个组合；退出是 null
 */
export function openComboBuilder({
  items = [], positions, pick, askName, save, replaceNote = '', dividerRatio = 0.5,
}) {
  return new Promise((resolve) => {
    const byId = new Map(items.filter(i => i?.id).map(i => [i.id, i]));
    const columns = (Array.isArray(positions) && positions.length === 2 ? positions : defaultPositions());
    const positionOf = (slot) => columns.find(c => c.slot === slot)?.position || '';

    let slots = { [SLOTS.PRIMARY]: [], [SLOTS.SECONDARY]: [] };
    const history = [];
    let settled = false;
    /**
     * 上面还压着一张小单子（挑东西、起名字），或者正在落盘。
     *
     * 这时这张单子上的按钮和 Escape 都不算数：人在挑东西那张单子上按 Escape，要
     * 收起的是那一张；它同时把这一整套也退掉的话，他刚拼的就全没了。重复点「保存
     * 并打开」也一样——第二下只会再弹一个起名字的框。
     */
    let busy = 0;
    /** 保存没成的那句话。下一次改动就收起来——它说的是上一次的事。 */
    let failure = '';

    const overlay = document.createElement('div');
    overlay.className = 'deck-overlay organizer-overlay builder-overlay';
    const panel = document.createElement('div');
    panel.className = 'organizer builder';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    overlay.appendChild(panel);

    // 拖动：和「整理内容」同一份手势。落点那一行说的也是同一句话——「在「X」
    // 之后（下层）」「作为该栏第一项」。
    const dragger = installListDrag(panel, {
      lists: '[data-role="builder-list"]',
      gapText: ({ afterId }) => (afterId
        ? t('deck.afterX', { name: byId.get(afterId)?.name || '' })
        : t('deck.firstEntryHere')),
      onDrop: (request) => dropAt(request),
    });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      dragger.destroy();
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };

    const total = () => slots[SLOTS.PRIMARY].length + slots[SLOTS.SECONDARY].length;

    /** 等一张压在上面的小单子，等的时候这张单子不接手。 */
    async function whileBusy(work) {
      busy += 1;
      try { return await work(); }
      finally { busy -= 1; }
    }

    /** 退出。拼了一半的东西要问一声——它没有存在任何地方，关掉就没了。 */
    function leave() {
      if (busy) return;
      if (!total()) { finish(null); return; }
      askLeave();
    }

    /**
     * 退出前那一问，贴在单子底下。
     *
     * 只长一条：点两下「退出」、或者先点「退出」再按 Escape，都还是那一条，不会
     * 摞出两条一样的问话。
     */
    function askLeave() {
      const existing = panel.querySelector('.builder-confirm');
      if (existing) { existing.querySelector('[data-role="go"]')?.focus(); return; }
      // 自己长一条，而不是去借 confirmDestructive：那是给「删掉就没了」用的，用它
      // 会让这一下看起来比实际上更重。
      const bar = document.createElement('div');
      bar.className = 'builder-confirm';
      bar.innerHTML = `
        <span class="builder-confirm-text"></span>
        <button type="button" class="deck-dialog-btn" data-role="stay"></button>
        <button type="button" class="deck-dialog-btn is-danger" data-role="go"></button>`;
      bar.querySelector('.builder-confirm-text').textContent = t('build.discardBody');
      bar.querySelector('[data-role="stay"]').textContent = t('deck.cancel');
      bar.querySelector('[data-role="go"]').textContent = t('build.discard');
      bar.querySelector('[data-role="stay"]').addEventListener('click', () => bar.remove());
      bar.querySelector('[data-role="go"]').addEventListener('click', () => finish(null));
      panel.appendChild(bar);
      bar.querySelector('[data-role="go"]').focus();
    }

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 上面还压着一张小单子：这一下是它的，不是这张的。
      if (busy) return;
      e.preventDefault();
      e.stopPropagation();
      // 正拖着一行：这一下只是放弃这次拖动，和整理内容一样。
      if (dragger.active()) { dragger.cancel(); return; }
      // 已经在问「退出吗」的时候再按 Escape，是「算了，不退」。
      const asking = panel.querySelector('.builder-confirm');
      if (asking) { asking.remove(); return; }
      leave();
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) leave(); });

    /** 改一步。每一步都先拍照——撤销要能一路退回空的那一刻。 */
    function commit(next) {
      history.push(snapshot(slots));
      slots = next;
      failure = '';
      render();
    }

    function undo() {
      if (busy) return;
      const back = history.pop();
      if (!back) return;
      slots = back;
      failure = '';
      render();
    }

    async function addTo(slot) {
      if (busy || slots[slot].length >= PER_SLOT) return;
      // 同一栏里不重复——一摞里摆两本一样的，翻过去还是它自己。另一栏里有的照样
      // 列：同一本书左右各开一份正是这个软件的用法（题在前面、答案在后面的习题册，
      // 见说明书「同一本也能开两栏」）。
      const chosen = await whileBusy(() => pick?.({
        slot,
        position: positionOf(slot),
        inThis: new Set(slots[slot]),
        inOther: new Set(slots[other(slot)]),
      }));
      if (settled || !chosen?.length) return;
      const next = snapshot(slots);
      for (const id of chosen) {
        if (!byId.has(id) || next[slot].includes(id)) continue;
        if (next[slot].length >= PER_SLOT) break;
        next[slot].push(id);
      }
      commit(next);
    }

    function removeFrom(slot, id) {
      if (busy) return;
      const next = snapshot(slots);
      next[slot] = next[slot].filter(one => one !== id);
      commit(next);
    }

    /**
     * 挪到另一栏，排在那一栏最后。
     *
     * 排最后而不是最前：最前面那本是那一栏打开时露在外面的，挪一本过去不该顺手把
     * 人已经定好的那一本换下来。另一栏里本来就有它（左右各一份的情形）就只是从这
     * 一栏拿走——同一栏里不放两份。
     */
    function moveAcross(slot, id) {
      if (busy) return;
      const to = other(slot);
      const next = snapshot(slots);
      next[slot] = next[slot].filter(one => one !== id);
      if (!next[to].includes(id) && next[to].length < PER_SLOT) next[to].push(id);
      commit(next);
    }

    /**
     * 拖完落下。
     *
     * 落到另一栏就插在落点，在同一栏里就是换顺序——最上面那一本打开时露在外面，
     * 所以拖到顶上就是「让它显示」。同一栏里不放两份：另一栏本来就有它（左右各
     * 一份的情形）而又把这一份拖过去，合成一份，放在落点。
     */
    function dropAt({ from, to, entryId, afterId }) {
      if (busy || !slots[from]?.includes(entryId) || !slots[to]) return;
      const next = snapshot(slots);
      next[from] = next[from].filter(one => one !== entryId);
      next[to] = next[to].filter(one => one !== entryId);
      const at = afterId ? next[to].indexOf(afterId) + 1 : 0;
      next[to].splice(Math.max(0, at), 0, entryId);
      if (next[to].length > PER_SLOT) return;
      const unchanged = [SLOTS.PRIMARY, SLOTS.SECONDARY]
        .every(slot => next[slot].join('\u0000') === slots[slot].join('\u0000'));
      // 原地放下不算一步：撤销栈里多一格什么都没变的，人按撤销会以为它坏了。
      if (unchanged) return;
      commit(next);
    }

    async function saveAndOpen() {
      if (busy || !total()) return;
      const suggested = [...slots[SLOTS.PRIMARY], ...slots[SLOTS.SECONDARY]]
        .filter((id, at, all) => all.indexOf(id) === at)
        .map(id => byId.get(id)?.name)
        .filter(Boolean)
        .join(t('combo.nameJoin'))
        .slice(0, 40);
      const name = await whileBusy(() => askName?.(suggested));
      // 名字那一步取消了，人回到这张单子——他拼的东西还在。把它连同摆法一起丢掉，
      // 等于用一次「算了」惩罚他半分钟的活。
      if (settled || !name) return;

      const draft = {
        name,
        slots: {
          [SLOTS.PRIMARY]: { entries: entriesOf(SLOTS.PRIMARY), active: 0 },
          [SLOTS.SECONDARY]: { entries: entriesOf(SLOTS.SECONDARY), active: 0 },
        },
        dividerRatio,
        orientation: ORIENTATIONS.ROW,
        swapped: false,
      };
      // 落盘也在单子还开着的时候做。先关单子再存的话，存不进去（组合满了、存储
      // 写不了）时人拼的东西已经没了，手上只剩一句「没能保存」。
      const result = await whileBusy(async () => {
        try { return await save(draft); }
        catch (error) { return { ok: false, message: error?.message || String(error) }; }
      });
      if (settled) return;
      if (result?.ok) { finish(result.combo ?? draft); return; }
      failure = result?.message || t('combo.saveFailed');
      render();
    }

    const entriesOf = (slot) => slots[slot].map(id => ({
      kind: byId.get(id)?.kind || ENTRY_KINDS.PDF,
      resourceId: id,
    }));

    // ── 这张单子 ──────────────────────────────────────────────────────────────

    function render() {
      panel.innerHTML = `
        <div class="organizer-head">
          <div class="deck-dialog-title">${escapeHtml(t('build.title'))}</div>
          <button type="button" class="deck-dialog-btn" data-role="exit">${escapeHtml(t('build.exit'))}</button>
        </div>
        <div class="organizer-body"></div>
        <p class="deck-dialog-note">${escapeHtml(t('build.note'))}</p>
        <p class="deck-dialog-note builder-replace" data-role="replace" hidden></p>
        <p class="builder-error" data-role="error" role="alert" hidden></p>
        <div class="deck-dialog-actions">
          <button type="button" class="deck-dialog-btn" data-role="undo">${escapeHtml(t('build.undo'))}</button>
          <button type="button" class="deck-dialog-btn is-primary" data-role="save">${escapeHtml(t('build.save'))}</button>
        </div>`;

      const body = panel.querySelector('.organizer-body');
      for (const { slot } of columns) {
        const list = slots[slot];
        const first = list.length ? byId.get(list[0]) : null;
        const el = document.createElement('div');
        el.className = 'organizer-column';
        el.dataset.slot = slot;
        el.innerHTML = `
          <div class="organizer-column-head">
            <span class="organizer-where" data-role="where"></span>
            <span class="organizer-what" data-role="what"></span>
          </div>
          <div class="organizer-list" data-role="builder-list" data-slot="${slot}"></div>
          <button type="button" class="builder-add" data-role="add" data-slot="${slot}"></button>`;
        el.querySelector('[data-role="where"]').textContent = positionOf(slot);
        // 栏头说的是「这一栏会显示哪一本」——摞里第一本就是打开时露在外面那一本。
        el.querySelector('[data-role="what"]').textContent = first?.name || t('build.emptySlot');
        el.querySelector('[data-role="add"]').textContent = `＋ ${t('build.pick')}`;

        const listEl = el.querySelector('[data-role="builder-list"]');
        if (!list.length) {
          const empty = document.createElement('div');
          empty.className = 'organizer-empty';
          empty.textContent = t('build.emptySlot');
          listEl.appendChild(empty);
        }
        for (const [at, id] of list.entries()) {
          const item = byId.get(id);
          if (!item) continue;
          const row = document.createElement('div');
          row.className = `organizer-row${at === 0 ? ' is-current' : ''}`;
          row.dataset.entryId = id;
          row.dataset.slot = slot;
          row.innerHTML = `
            <button type="button" class="organizer-handle" data-role="handle"
                    aria-label="${escapeHtml(t('build.drag'))}">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
                   fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M8 7h8M8 12h8M8 17h8"/>
              </svg>
            </button>
            <span class="deck-row-kind">${escapeHtml(kindLabelFor(item.kind))}</span>
            <span class="organizer-name"></span>
            <button type="button" class="deck-row-btn" data-role="across"></button>
            <button type="button" class="deck-row-btn" data-role="remove"></button>`;
          row.querySelector('.organizer-name').textContent = item.name || t('deck.untitled');
          const across = row.querySelector('[data-role="across"]');
          across.textContent = t('build.moveTo', { position: positionOf(other(slot)) });
          across.addEventListener('click', () => moveAcross(slot, id));
          const remove = row.querySelector('[data-role="remove"]');
          remove.textContent = t('build.remove');
          remove.addEventListener('click', () => removeFrom(slot, id));
          listEl.appendChild(row);
        }

        el.querySelector('[data-role="add"]').addEventListener('click', () => addTo(slot));
        body.appendChild(el);
      }

      // 「保存并打开」会换掉两栏里现在开着的东西。这一句贴在按钮正上方，在他按
      // 下去之前就看得见——和从书架上打开一个组合时那句提醒说的是同一件事，只是
      // 这里不再多弹一个框：他按的那颗按钮本身写着「打开」。
      const replace = panel.querySelector('[data-role="replace"]');
      if (replaceNote && total()) {
        replace.textContent = replaceNote;
        replace.hidden = false;
      }
      const error = panel.querySelector('[data-role="error"]');
      if (failure) {
        error.textContent = failure;
        error.hidden = false;
      }

      const undoBtn = panel.querySelector('[data-role="undo"]');
      undoBtn.disabled = history.length === 0;
      undoBtn.addEventListener('click', undo);
      const saveBtn = panel.querySelector('[data-role="save"]');
      // 一本都没摆的时候存不出东西来：空组合打开是两栏空白，而那不是任何人要的。
      saveBtn.disabled = total() === 0;
      saveBtn.addEventListener('click', saveAndOpen);
      panel.querySelector('[data-role="exit"]').addEventListener('click', leave);
    }

    render();
    document.body.appendChild(overlay);
    panel.querySelector('[data-role="add"]')?.focus();
  });
}
