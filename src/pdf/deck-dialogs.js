// PDF Module — the dialogs decks need (F01, F02, F08, F09).
//
// Four questions, one shape: create a pad and say where it goes, open a file
// and say where it goes, move an entry somewhere else, and confirm a deletion
// that cannot be taken back.
//
// A destination is described by where it IS and what is in it — "Right /
// Answer book" — never by a role. Position is not role: the panes can be
// swapped, and a chooser that said "the answer side" would be naming something
// that had moved. The specification is explicit about this and it is the reason
// every option below carries both halves.
//
// Nothing here decides anything. Each returns a promise that resolves to the
// user's answer or to null, and cancelling always leaves the workspace exactly
// as it was — no pad created, no deck changed.

import { t } from '../core/i18n.js';
import { ENTRY_KINDS, kindKeyFor } from './deck-state.js';
import { createScratchStyle, paperColor } from '../scratch/scratch-style.js';
import { PATTERN_ORDER, TONE_ORDER, paintTile } from '../scratch/scratch-style-panel.js';

/** 摞里这一项叫什么 —— 键在 deck-state，文案在这里。 */
const kindLabelFor = (kind) => t(kindKeyFor(kind));

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Opens a modal and resolves with whatever `build` hands to `finish`.
 *
 * One implementation, so every dialog dismisses the same way: the backdrop, the
 * Escape key and the cancel control all reach the same exit, and the promise
 * resolves exactly once however it is left.
 *
 * Escape is handled HERE, on the dialog, and stopped: an open dialog is the
 * top thing on screen, so it must consume the key before focus mode or the
 * app's own navigation sees it.
 */
function modal(build, { signal, focusCancel = false } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'deck-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'deck-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    overlay.appendChild(dialog);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      signal?.removeEventListener('abort', onAbort);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };
    // A page-owned confirmation must not outlive the page it would erase.
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(null);
    });

    build(dialog, finish);
    if (settled) return;
    document.body.appendChild(overlay);
    // Focus the DIALOG, not the first field.
    //
    // Focusing the name input opened the on-screen keyboard the instant the
    // dialog appeared, and on the tablet that keyboard covered the paper
    // chooser and both buttons — so the first thing the reader saw of a dialog
    // they opened to make a choice was half a dialog they could not finish.
    // The name already has a sensible default; anyone who wants to change it
    // taps it, and the keyboard comes up then.
    //
    // The container still takes focus, so a screen reader and the Tab order
    // both land inside rather than behind.
    dialog.tabIndex = -1;
    const focusTarget = focusCancel
      ? dialog.querySelector('[data-role="cancel"]') || dialog
      : dialog;
    focusTarget.focus({ preventScroll: true });
  });
}

/** A destination button: where it is, and what is in it right now. */
function destinationButton(option, selected) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `deck-destination${selected ? ' is-selected' : ''}`;
  button.dataset.slot = option.slot;
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(!!selected));
  button.innerHTML = `
    <span class="deck-destination-where">${escapeHtml(option.position)}</span>
    <span class="deck-destination-what">${escapeHtml(option.current || t('deck.emptySlot'))}</span>`;
  return button;
}

/**
 * Where should this go?
 *
 * @param {{options: Array<{slot,position,current}>, preferred: string,
 *          title: string, note?: string, confirm: string}} spec
 * @returns {Promise<string|null>} the chosen slot id
 */
export function chooseDestination({ options, preferred, title, note, confirm }) {
  return modal((dialog, finish) => {
    let chosen = options.some(o => o.slot === preferred) ? preferred : options[0]?.slot;

    dialog.innerHTML = `
      <div class="deck-dialog-title">${escapeHtml(title)}</div>
      <div class="deck-destinations" role="radiogroup"
           aria-label="${escapeHtml(t('deck.destination'))}"></div>
      ${note ? `<p class="deck-dialog-note">${escapeHtml(note)}</p>` : ''}
      <div class="deck-dialog-actions">
        <button type="button" class="deck-dialog-btn" data-role="cancel"></button>
        <button type="button" class="deck-dialog-btn is-primary" data-role="confirm"></button>
      </div>`;

    const group = dialog.querySelector('.deck-destinations');
    for (const option of options) {
      const button = destinationButton(option, option.slot === chosen);
      button.addEventListener('click', () => {
        chosen = option.slot;
        group.querySelectorAll('.deck-destination').forEach((el) => {
          const on = el.dataset.slot === chosen;
          el.classList.toggle('is-selected', on);
          el.setAttribute('aria-checked', String(on));
        });
      });
      group.appendChild(button);
    }

    dialog.querySelector('[data-role="cancel"]').textContent = t('deck.cancel');
    dialog.querySelector('[data-role="confirm"]').textContent = confirm;
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    dialog.querySelector('[data-role="confirm"]').addEventListener('click', () => finish(chosen));
  });
}

/** 这个对话框能做出来的两样东西。 */
export const PAPER_MODES = Object.freeze({ SCRATCH: 'scratch', NOTE: 'note' });

/**
 * 新建一张纸，并说它开在哪一栏。
 *
 * 草稿纸和笔记本是这里的两个模式，不是两个对话框。它们要问的东西几乎完全重合
 * ——叫什么、用什么纸、开在哪 —— 只有「几页」是笔记本独有的。拆成两个对话框，
 * 就要把纸张选择器和目的地选择器各维护一份，而它们迟早会长得不一样。
 *
 * 两者的差别就是那一行字说的那件事：草稿纸是一张没有边界的纸，笔记本是一叠有
 * 边界的纸。所以模式切换在最上面，且切换时不清空已经填的名字和已经选的纸 ——
 * 「我要一张方格纸」这个决定，和「它是一张还是一叠」是两件事。
 *
 * 资源由**调用方**在这个 Promise 落地之后才创建。在这里取消不会留下任何东西 ——
 * 一本没人要的空本子留在库里，比没有更糟，而那正是「先创建、对话框只决定放哪」
 * 的做法会发生的事。
 *
 * @returns {Promise<{mode: string, name: string, slot: string, style: object,
 *   pageCount: number}|null>}
 */
export function createPaperDialog({
  options, preferred, defaultName, defaultNoteName, defaultStyle,
  mode = PAPER_MODES.SCRATCH, defaultPageCount = 20, pageMax = 999, nameMax = 60,
}) {
  return modal((dialog, finish) => {
    let chosen = options.some(o => o.slot === preferred) ? preferred : options[0]?.slot;
    let current = mode === PAPER_MODES.NOTE ? PAPER_MODES.NOTE : PAPER_MODES.SCRATCH;
    // The paper is chosen HERE, at the moment the pad is made, because that is
    // when someone knows what they are about to use it for — squared for a
    // derivation, ruled for an explanation, 田字格 for characters. It was
    // reachable only afterwards, through the pad's own menu, which meant every
    // pad started blank and had to be corrected.
    let style = createScratchStyle(defaultStyle);

    dialog.innerHTML = `
      <div class="deck-dialog-title" data-role="title"></div>
      <div class="paper-modes" role="radiogroup"
           aria-label="${escapeHtml(t('paper.mode'))}">
        <button type="button" class="paper-mode" role="radio" data-mode="scratch">
          <span class="paper-mode-name">${escapeHtml(t('deck.scratch'))}</span>
          <span class="paper-mode-note">${escapeHtml(t('paper.scratchNote'))}</span>
        </button>
        <button type="button" class="paper-mode" role="radio" data-mode="note">
          <span class="paper-mode-name">${escapeHtml(t('deck.note'))}</span>
          <span class="paper-mode-note">${escapeHtml(t('paper.noteNote'))}</span>
        </button>
      </div>
      <label class="deck-field">
        <span class="deck-field-label">${escapeHtml(t('scratch.name'))}</span>
        <input type="text" class="deck-input" data-role="name" maxlength="${nameMax}">
      </label>
      <label class="deck-field" data-role="pages-field">
        <span class="deck-field-label">${escapeHtml(t('note.pages'))}</span>
        <input type="number" class="deck-input" data-role="pages"
               min="1" max="${pageMax}" step="1" inputmode="numeric">
      </label>
      <div class="deck-field-label" data-role="style-label"></div>
      <div class="create-styles" data-role="patterns" role="radiogroup"
           aria-label="${escapeHtml(t('scratch.pattern'))}"></div>
      <div class="style-row">
        <span class="style-row-label">${escapeHtml(t('scratch.tone'))}</span>
        <span class="style-swatches" data-role="tones" role="radiogroup"
              aria-label="${escapeHtml(t('scratch.tone'))}"></span>
      </div>
      <div class="deck-field-label">${escapeHtml(t('deck.destination'))}</div>
      <div class="deck-destinations" role="radiogroup"
           aria-label="${escapeHtml(t('deck.destination'))}"></div>
      <p class="deck-dialog-note">${escapeHtml(t('deck.keptUnderneath'))}</p>
      <div class="deck-dialog-actions">
        <button type="button" class="deck-dialog-btn" data-role="cancel"></button>
        <button type="button" class="deck-dialog-btn is-primary" data-role="confirm"></button>
      </div>`;

    const input = dialog.querySelector('[data-role="name"]');
    const pages = dialog.querySelector('[data-role="pages"]');
    const pagesField = dialog.querySelector('[data-role="pages-field"]');
    pages.value = String(defaultPageCount);

    // 两个模式各记各的默认名字。切过去再切回来，原来那个名字还在 —— 而人自己
    // 改过的名字两边共用，因为那是他给这张纸起的名，不是给模式起的。
    const proposed = {
      [PAPER_MODES.SCRATCH]: defaultName || '',
      [PAPER_MODES.NOTE]: defaultNoteName || defaultName || '',
    };
    let touched = false;
    input.addEventListener('input', () => { touched = true; });

    const renderMode = () => {
      const note = current === PAPER_MODES.NOTE;
      dialog.querySelector('[data-role="title"]').textContent =
        note ? t('note.newTitle') : t('scratch.newTitle');
      // 「草稿纸样式」在笔记本模式下是错的 —— 选的是纸，不是草稿纸。
      dialog.querySelector('[data-role="style-label"]').textContent =
        note ? t('note.style') : t('scratch.style');
      pagesField.hidden = !note;
      if (!touched) input.value = proposed[current];
      for (const button of dialog.querySelectorAll('.paper-mode')) {
        const on = button.dataset.mode === current;
        button.classList.toggle('is-selected', on);
        button.setAttribute('aria-checked', String(on));
      }
    };
    for (const button of dialog.querySelectorAll('.paper-mode')) {
      button.addEventListener('click', () => {
        current = button.dataset.mode === PAPER_MODES.NOTE
          ? PAPER_MODES.NOTE : PAPER_MODES.SCRATCH;
        renderMode();
      });
    }
    renderMode();

    // Patterns and tones are redrawn together: a tile has to show the tone that
    // is actually selected, or the choice it offers is not the one it makes.
    const patterns = dialog.querySelector('[data-role="patterns"]');
    const tones = dialog.querySelector('[data-role="tones"]');

    const renderStyle = () => {
      patterns.replaceChildren();
      for (const id of PATTERN_ORDER) {
        const selected = id === style.patternId;
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = `create-style-tile${selected ? ' is-selected' : ''}`;
        tile.setAttribute('role', 'radio');
        tile.setAttribute('aria-checked', String(selected));
        tile.innerHTML = '<canvas aria-hidden="true"></canvas><span></span>';
        tile.querySelector('span').textContent = t(`pattern.${id}`);
        paintTile(tile.querySelector('canvas'), createScratchStyle({ ...style, patternId: id }),
          { width: 96, height: 48 });
        tile.addEventListener('click', () => {
          style = createScratchStyle({ ...style, patternId: id });
          renderStyle();
        });
        patterns.appendChild(tile);
      }

      tones.replaceChildren();
      for (const tone of TONE_ORDER) {
        const selected = tone === style.paperTone;
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = `style-swatch${selected ? ' is-selected' : ''}`;
        swatch.setAttribute('role', 'radio');
        swatch.setAttribute('aria-checked', String(selected));
        swatch.setAttribute('aria-label', t(`tone.${tone}`));
        swatch.title = t(`tone.${tone}`);
        swatch.style.background = paperColor({ paperTone: tone });
        swatch.addEventListener('click', () => {
          style = createScratchStyle({ ...style, paperTone: tone });
          renderStyle();
        });
        tones.appendChild(swatch);
      }
    };
    renderStyle();

    const group = dialog.querySelector('.deck-destinations');
    for (const option of options) {
      const button = destinationButton(option, option.slot === chosen);
      button.addEventListener('click', () => {
        chosen = option.slot;
        group.querySelectorAll('.deck-destination').forEach((el) => {
          const on = el.dataset.slot === chosen;
          el.classList.toggle('is-selected', on);
          el.setAttribute('aria-checked', String(on));
        });
      });
      group.appendChild(button);
    }

    // 页数就地夹住，而不是等到提交。输入 0 或者 9999 之后按回车，人该看见的是
    // 框里立刻变成 1 或者上限，而不是创建出一本和他输入的不一样的本子。
    const pageCount = () => {
      const n = Math.floor(Number(pages.value));
      if (!Number.isFinite(n) || n < 1) return 1;
      return Math.min(pageMax, n);
    };
    pages.addEventListener('change', () => { pages.value = String(pageCount()); });

    const commit = () => finish({
      mode: current,
      name: input.value.trim() || proposed[current],
      slot: chosen,
      style,
      pageCount: pageCount(),
    });
    dialog.querySelector('[data-role="cancel"]').textContent = t('deck.cancel');
    dialog.querySelector('[data-role="confirm"]').textContent = t('scratch.createAndOpen');
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    dialog.querySelector('[data-role="confirm"]').addEventListener('click', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
    pages.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  });
}

/**
 * Move one entry: which pane, and where in its order (F09).
 *
 * The insertion point is named by a stable entry id — "After Scratchpad 02" —
 * and never by a row number. Rows move under every insert and removal, and an
 * index captured when the dialog opened would land the entry somewhere the user
 * did not point at.
 *
 * "Move and show" is off by default and says so in words. Moving something
 * underneath is the common case, and quietly changing what a pane displays is
 * not what "put this away over there" means.
 *
 * @returns {Promise<{to: string, afterId: string|null, andShow: boolean}|null>}
 */
export function moveEntryDialog({ entry, entryName, options, preferred, anchorsFor }) {
  return modal((dialog, finish) => {
    let target = options.some(o => o.slot === preferred) ? preferred : options[0]?.slot;
    let afterId = null;
    let andShow = false;

    dialog.innerHTML = `
      <div class="deck-dialog-title">${escapeHtml(t('deck.moveTitle'))}</div>
      <div class="deck-dialog-subject">
        <span class="deck-row-kind">${escapeHtml(
    kindLabelFor(entry.kind))}</span>
        <span></span>
      </div>
      <div class="deck-field-label">${escapeHtml(t('deck.destination'))}</div>
      <div class="deck-destinations" role="radiogroup"></div>
      <div class="deck-field-label">${escapeHtml(t('deck.insertAt'))}</div>
      <div class="deck-anchors" role="radiogroup"></div>
      <label class="deck-check">
        <input type="checkbox" data-role="and-show">
        <span>${escapeHtml(t('deck.moveAndShow'))}</span>
      </label>
      <p class="deck-dialog-note" data-role="explain"></p>
      <div class="deck-dialog-actions">
        <button type="button" class="deck-dialog-btn" data-role="cancel"></button>
        <button type="button" class="deck-dialog-btn is-primary" data-role="confirm"></button>
      </div>`;

    dialog.querySelector('.deck-dialog-subject span:last-child').textContent = entryName;

    const anchorGroup = dialog.querySelector('.deck-anchors');
    const explain = dialog.querySelector('[data-role="explain"]');

    const describeOutcome = () => {
      const option = options.find(o => o.slot === target);
      if (!option) return '';
      const where = option.current
        ? t('deck.moveExplain', { name: entryName, position: option.position, current: option.current })
        : t('deck.moveExplainEmpty', { name: entryName, position: option.position });
      if (andShow) return `${where} ${t('deck.moveShowsIt', { name: entryName })}`;
      return option.current
        ? `${where} ${t('deck.moveKeepsCurrent', { current: option.current })}`
        : where;
    };

    const renderAnchors = () => {
      const anchors = anchorsFor(target) || [];
      anchorGroup.replaceChildren();
      // An empty destination has one place to go, and it is the only honest
      // label for it: there is nothing to be after.
      const choices = anchors.length
        ? anchors.map(a => ({ id: a.id, label: t('deck.afterX', { name: a.name }) }))
        : [{ id: null, label: t('deck.firstEntryHere') }];
      // Default to immediately after whatever the target is showing, which is
      // "just underneath the current one" — the position people mean.
      if (!choices.some(c => c.id === afterId)) afterId = choices[0].id;

      for (const choice of choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `deck-anchor${choice.id === afterId ? ' is-selected' : ''}`;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(choice.id === afterId));
        button.textContent = choice.label;
        button.addEventListener('click', () => {
          afterId = choice.id;
          renderAnchors();
          explain.textContent = describeOutcome();
        });
        anchorGroup.appendChild(button);
      }
    };

    const group = dialog.querySelector('.deck-destinations');
    for (const option of options) {
      const button = destinationButton(option, option.slot === target);
      button.addEventListener('click', () => {
        target = option.slot;
        afterId = null;
        group.querySelectorAll('.deck-destination').forEach((el) => {
          const on = el.dataset.slot === target;
          el.classList.toggle('is-selected', on);
          el.setAttribute('aria-checked', String(on));
        });
        renderAnchors();
        explain.textContent = describeOutcome();
      });
      group.appendChild(button);
    }

    dialog.querySelector('[data-role="and-show"]').addEventListener('change', (e) => {
      andShow = e.target.checked;
      explain.textContent = describeOutcome();
    });

    renderAnchors();
    explain.textContent = describeOutcome();

    dialog.querySelector('[data-role="cancel"]').textContent = t('deck.cancel');
    dialog.querySelector('[data-role="confirm"]').textContent = t('deck.move');
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    dialog.querySelector('[data-role="confirm"]')
      .addEventListener('click', () => finish({ to: target, afterId, andShow }));
  });
}

/**
 * Confirms something that cannot be undone.
 *
 * Names the resource and says plainly what is lost. The danger is carried by
 * the wording, not by the colour alone — which is both an accessibility
 * requirement and the only thing that works when the button is read aloud.
 */
/**
 * 起个名字。
 *
 * 两处在用：书架上给一本书改名，和给一页书签起名。它们是同一个问题——「这个
 * 东西你自己叫它什么」——所以是同一个对话框，而不是两个长得差不多的。
 *
 * 不用 window.prompt。那是浏览器画的，在这个 WebView 里它是一个和整个 app
 * 毫无关系的系统弹窗；而且它会阻塞主线程，弹出的那一刻所有动画都停住。
 *
 * 输入框在打开时并不抢焦点：抢了就会立刻弹出软键盘，把对话框的下半截连同两个
 * 按钮一起盖住——这条规矩上面 modal() 的注释里已经讲过一次，这里照办。
 *
 * @param {{title: string, label?: string, value?: string, max?: number,
 *          confirm?: string, placeholder?: string}} spec
 * @returns {Promise<string|null>} 清理过的名字（可能是空串），取消则是 null
 */
export function promptText({
  title, label = '', value = '', max = 60, confirm = '', placeholder = '',
}) {
  return modal((dialog, finish) => {
    dialog.innerHTML = `
      <div class="deck-dialog-title">${escapeHtml(title)}</div>
      ${label ? `<label class="deck-dialog-label" for="deck-prompt-input">${escapeHtml(label)}</label>` : ''}
      <input id="deck-prompt-input" class="deck-input" type="text"
             maxlength="${Number(max) || 60}"
             placeholder="${escapeHtml(placeholder)}">
      <div class="deck-dialog-actions">
        <button type="button" class="deck-dialog-btn" data-role="cancel">${escapeHtml(t('common.cancel'))}</button>
        <button type="button" class="deck-dialog-btn is-primary" data-role="confirm">${escapeHtml(confirm || t('common.ok'))}</button>
      </div>`;

    const input = dialog.querySelector(".deck-input");
    input.value = value || '';

    // 交出去的是清理过的字符串，不是原文：名字里的换行和成串空格不是名字的
    // 一部分，而「全是空格」和「什么都没填」是同一件事。
    //
    // 但「清空」和「取消」不是同一件事：清空是「不要这个名字了」，取消是「当我
    // 没说」。所以确定给的是字符串（可能是空串），取消给的是 null。分不开的话，
    // 给书签改名时按取消会把原来的名字抹掉。
    const done = () => finish(input.value.replace(/\s+/g, ' ').trim());
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      done();
    });
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    dialog.querySelector('[data-role="confirm"]').addEventListener('click', done);
  });
}

/**
 * 对这一样东西能做的几件事。
 *
 * 书架上一本书只有一个正面动作——打开；改名、换册别、删除都不该占着书架的
 * 位置，它们是「顺便」的事。所以它们收在角上那个 ⋯ 里，点开是这张单子。
 *
 * 危险的那一条自己标出来（is-danger），而且永远排在最后：手指是从上往下够的。
 *
 * @param {{title: string, note?: string,
 *          actions: Array<{id: string, label: string, danger?: boolean}>,
 *          cancelLabel?: string}} spec
 *   `cancelLabel` 是不做选择那一颗按钮的字，默认「取消」。开机时问权限那一张写
 *   「以后再说」——那不是取消一件事，是把一件事往后放。
 * @returns {Promise<string|null>} 选中的 id
 */
export function chooseAction({ title, note = '', actions = [], cancelLabel = '' }) {
  return modal((dialog, finish) => {
    dialog.innerHTML = `
      <div class="deck-dialog-title">${escapeHtml(title)}</div>
      ${note ? `<p class="deck-dialog-note">${escapeHtml(note)}</p>` : ''}
      <div class="deck-actions"></div>
      <div class="deck-dialog-actions">
        <button type="button" class="deck-dialog-btn" data-role="cancel">${escapeHtml(cancelLabel || t('common.cancel'))}</button>
      </div>`;

    const list = dialog.querySelector('.deck-actions');
    for (const action of actions) {
      if (!action?.id) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `deck-action${action.danger ? ' is-danger' : ''}`;
      button.textContent = action.label;
      button.addEventListener('click', () => finish(action.id));
      list.appendChild(button);
    }
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
  });
}

export function confirmDestructive({ title, body, confirmLabel, signal, focusCancel = false }) {
  return modal((dialog, finish) => {
    dialog.innerHTML = `
      <div class="deck-dialog-title"></div>
      <p class="deck-dialog-note"></p>
      <div class="deck-dialog-actions">
        <button type="button" class="deck-dialog-btn" data-role="cancel"></button>
        <button type="button" class="deck-dialog-btn is-danger" data-role="confirm"></button>
      </div>`;
    dialog.querySelector('.deck-dialog-title').textContent = title;
    dialog.querySelector('.deck-dialog-note').textContent = body;
    dialog.querySelector('[data-role="cancel"]').textContent = t('deck.cancel');
    dialog.querySelector('[data-role="confirm"]').textContent = confirmLabel;
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(false));
    dialog.querySelector('[data-role="confirm"]').addEventListener('click', () => finish(true));
  }, { signal, focusCancel });
}

/**
 * Tells the user why something could not happen, and what they can do instead.
 *
 * Used by the duplicate-resource refusal, which offers to take them to the
 * entry that is already there rather than making a second one or silently
 * merging two reading positions.
 */
export function explainRefusal({ title, body, actionLabel }) {
  return modal((dialog, finish) => {
    dialog.innerHTML = `
      <div class="deck-dialog-title"></div>
      <p class="deck-dialog-note"></p>
      <div class="deck-dialog-actions">
        <button type="button" class="deck-dialog-btn" data-role="cancel"></button>
        ${actionLabel ? '<button type="button" class="deck-dialog-btn is-primary" data-role="confirm"></button>' : ''}
      </div>`;
    dialog.querySelector('.deck-dialog-title').textContent = title;
    dialog.querySelector('.deck-dialog-note').textContent = body;
    dialog.querySelector('[data-role="cancel"]').textContent = t('deck.cancel');
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(false));
    const action = dialog.querySelector('[data-role="confirm"]');
    if (action) {
      action.textContent = actionLabel;
      action.addEventListener('click', () => finish(true));
    }
  });
}

/**
 * 「移动到文件夹」那张单子。
 *
 * 顶上一句话说这一份**现在**在哪——「不在任何文件夹里」或者「在「高代」里」。它是
 * 一句话，不是一个选项：原来把「不在文件夹里」做成了列表的第一行、能点能选，人在
 * 机上看到的是一个长得和文件夹一样、却不是文件夹的格子，点了还没反应。
 * 把东西拿出文件夹走的是它自己那条路：文件夹里那一份的 ⋯ 里有「移出文件夹」。
 *
 * 底下那颗按钮当场就把文件夹建出来，并且直接进入改名。先弹一个「请输入名称」的框，
 * 等于在他想放东西的路上竖一道墙；人点它的那一刻要的是一个格子，名字是顺手的事，
 * 回头还能改。建完就选中它——他建这个格子就是为了装手上这一份。
 *
 * 「移动」只在选中了一个**别的**文件夹时才能按：什么都没选、或者选的就是它现在
 * 在的那个，按下去什么都不会发生，而一颗按下去没反应的按钮会让人以为是坏了。
 *
 * 不嵌套，所以这张单子永远是平的一层，没有「进入下一级」这回事（理由写在
 * folder-state.js 开头）。
 *
 * @param {Object} options
 * @param {string}  [options.title]    单子的标题
 * @param {string}  [options.itemName] 正在移动的是哪一样东西
 * @param {Array}   options.folders    [{id, name, count}]
 * @param {?string} [options.current]  它现在在哪个文件夹里
 * @param {function} [options.onCreate] 建一个新文件夹，返回 {id, name}；落盘是调用方的事
 * @param {function} [options.onRename] 改名，(id, name)；同上
 * @returns {Promise<{folderId: string}|null>} 取消是 null
 */
export function chooseFolder({
  title, itemName = '', folders = [], current = null, onCreate, onRename,
}) {
  return modal((dialog, finish) => {
    dialog.classList.add('deck-folder-dialog');
    let list = folders.map(f => ({ id: f.id, name: f.name, count: f.count }));
    // 它现在在的那个文件夹先亮着：人一眼看得见它在哪，挑别的就是「挪过去」。
    let chosen = current && list.some(f => f.id === current) ? current : null;

    dialog.innerHTML = `
      <div class="deck-folder-head">
        <button type="button" class="deck-dialog-btn" data-role="cancel">${escapeHtml(t('deck.cancel'))}</button>
        <div class="deck-dialog-title">${escapeHtml(title || t('folder.moveTitle'))}</div>
        <button type="button" class="deck-dialog-btn is-primary" data-role="confirm">${escapeHtml(t('folder.move'))}</button>
      </div>
      <p class="deck-dialog-note deck-folder-where" data-role="where"></p>
      <div class="deck-folder-list" data-role="list"></div>
      <div class="deck-folder-foot">
        <button type="button" class="deck-folder-new" data-role="new">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <path d="M12 11.5v5M9.5 14h5"/>
          </svg>
          <span></span>
        </button>
      </div>`;
    dialog.querySelector('[data-role="new"] span').textContent = t('folder.new');

    const whereEl = dialog.querySelector('[data-role="where"]');
    const listEl = dialog.querySelector('[data-role="list"]');
    const confirmEl = dialog.querySelector('[data-role="confirm"]');

    /** 顶上那句话：它现在在哪。名字是别处写的（文件名、人自己起的名），走 textContent。 */
    function renderWhere() {
      const home = current ? list.find(f => f.id === current) : null;
      whereEl.textContent = home
        ? t('folder.whereIn', { name: itemName, folder: home.name })
        : t('folder.whereNone', { name: itemName });
    }

    function rowFor(folder) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `deck-folder-row${chosen === folder.id ? ' is-selected' : ''}`;
      el.dataset.folderId = folder.id;
      el.setAttribute('aria-pressed', chosen === folder.id ? 'true' : 'false');
      el.innerHTML = `
        <span class="deck-folder-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </span>
        <span class="deck-folder-name"></span>
        <span class="deck-folder-count">${folder.count == null ? '' : escapeHtml(t('folder.count', { count: folder.count }))}</span>
        <span class="deck-folder-tick" aria-hidden="true">✓</span>`;
      el.querySelector('.deck-folder-name').textContent = folder.name;
      el.addEventListener('click', () => {
        chosen = folder.id;
        render();
      });
      return el;
    }

    function render() {
      listEl.replaceChildren();
      if (!list.length) {
        // 一个文件夹都还没有：说一句去哪儿建，而不是摊一张空单子。
        const none = document.createElement('p');
        none.className = 'deck-folder-empty';
        none.textContent = t('folder.noneYet');
        listEl.appendChild(none);
      }
      for (const folder of list) listEl.appendChild(rowFor(folder));
      confirmEl.disabled = !chosen || chosen === current;
    }

    /**
     * 新建的那一行直接变成输入框。
     *
     * 建完就在改名，人不用再去找「重命名」在哪。改不改都行——它已经有名字了，
     * 所以走神走掉也不会留下一个没名字的格子。
     */
    function beginRename(folder) {
      const row = listEl.querySelector(`[data-folder-id="${folder.id}"]`);
      const nameEl = row?.querySelector('.deck-folder-name');
      if (!nameEl) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'deck-folder-input';
      input.value = folder.name;
      input.maxLength = 40;
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const commit = (keep) => {
        if (done) return;
        done = true;
        const next = keep ? input.value.replace(/\s+/g, ' ').trim() : '';
        // 空名字不是名字：留着它建出来时那个默认名，而不是留一个认不出来的格子。
        if (next && next !== folder.name) {
          folder.name = next;
          try { onRename?.(folder.id, next); } catch (_) { /* 存不住就先这么显示 */ }
        }
        render();
      };
      input.addEventListener('keydown', (e) => {
        // 这里的 Escape 只收回这次改名，不该把整张单子关掉——人正在打字。
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(false); }
      });
      input.addEventListener('blur', () => commit(true));
    }

    dialog.querySelector('[data-role="new"]').addEventListener('click', async () => {
      const made = await onCreate?.();
      if (!made?.id) return;
      // 改名改的必须是**单子上那一行**。存一个 onCreate 回来的对象在旁边，改完
      // 名字重画一次就又变回去了——而人看到的正是重画之后那一行。
      const row = { id: made.id, name: made.name, count: 0 };
      list = [...list, row];
      chosen = row.id;
      render();
      beginRename(row);
    });

    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    confirmEl.addEventListener('click', () => {
      if (!chosen || chosen === current) return;
      finish({ folderId: chosen });
    });
    renderWhere();
    render();
  });
}

/**
 * 从一堆东西里挑几份。
 *
 * 往文件夹里放已有的文件用它。一行一份，点一下选中再点一下取消——没有复选框那个
 * 小方块：手指点的是整行，而那个方块只会让人以为只有点中它才算数。
 *
 * 选了几份印在按钮上。挑东西的人心里有个数，界面该把那个数说出来，而不是让他自己
 * 回头数一遍。
 *
 * @param {{title:string, note?:string, items:Array<{id,name,sub?}>,
 *          confirm?:string, empty?:string}} spec
 * @returns {Promise<string[]|null>} 选中的 id；取消是 null
 */
export function pickResources({ title, note = '', items = [], confirm, empty }) {
  return modal((dialog, finish) => {
    dialog.classList.add('deck-pick-dialog');
    const picked = new Set();

    dialog.innerHTML = `
      <div class="deck-dialog-title" data-role="title"></div>
      ${note ? '<p class="deck-dialog-note" data-role="note"></p>' : ''}
      <div class="deck-pick-list" data-role="list"></div>
      <div class="deck-dialog-actions">
        <button type="button" class="deck-dialog-btn" data-role="cancel">${escapeHtml(t('deck.cancel'))}</button>
        <button type="button" class="deck-dialog-btn is-primary" data-role="confirm"></button>
      </div>`;
    dialog.querySelector('[data-role="title"]').textContent = title;
    if (note) dialog.querySelector('[data-role="note"]').textContent = note;

    const listEl = dialog.querySelector('[data-role="list"]');
    const confirmEl = dialog.querySelector('[data-role="confirm"]');
    const label = confirm || t('common.ok');

    const syncConfirm = () => {
      confirmEl.textContent = picked.size ? `${label}（${picked.size}）` : label;
      // 一份都没选时确认没有意义：按下去什么都不会发生，而一颗按下去没反应的按钮
      // 会让人以为是坏了。
      confirmEl.disabled = picked.size === 0;
    };

    if (!items.length) {
      const none = document.createElement('div');
      none.className = 'organizer-empty';
      none.textContent = empty || t('folder.pickEmpty');
      listEl.appendChild(none);
    }

    for (const item of items) {
      if (!item?.id) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'deck-pick-row';
      row.dataset.id = item.id;
      row.setAttribute('aria-pressed', 'false');
      row.innerHTML = `
        <span class="deck-pick-name"></span>
        <span class="deck-row-kind" data-role="sub"></span>
        <span class="deck-folder-tick" aria-hidden="true">✓</span>`;
      row.querySelector('.deck-pick-name').textContent = item.name || t('deck.untitled');
      row.querySelector('[data-role="sub"]').textContent = item.sub || '';
      row.addEventListener('click', () => {
        if (picked.has(item.id)) picked.delete(item.id);
        else picked.add(item.id);
        row.classList.toggle('is-selected', picked.has(item.id));
        row.setAttribute('aria-pressed', picked.has(item.id) ? 'true' : 'false');
        syncConfirm();
      });
      listEl.appendChild(row);
    }

    syncConfirm();
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    confirmEl.addEventListener('click', () => {
      if (!picked.size) return;
      finish([...picked]);
    });
  });
}
