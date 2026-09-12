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
import { ENTRY_KINDS } from './deck-state.js';
import { createScratchStyle, paperColor } from '../scratch/scratch-style.js';
import { PATTERN_ORDER, TONE_ORDER, paintTile } from '../scratch/scratch-style-panel.js';

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
function modal(build) {
  return new Promise((resolve) => {
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
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(null);
    });

    build(dialog, finish);
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
    dialog.focus({ preventScroll: true });
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

/**
 * Create a scratchpad, and say where it opens.
 *
 * The pad is created by the CALLER, after this resolves. Cancelling here leaves
 * no resource behind — an empty pad in the library that nobody asked for is
 * worse than no pad at all, and it is what happens when creation runs first and
 * the dialog only decides where to put it.
 *
 * @returns {Promise<{name: string, slot: string}|null>}
 */
export function createScratchpadDialog({
  options, preferred, defaultName, defaultStyle, nameMax = 60,
}) {
  return modal((dialog, finish) => {
    let chosen = options.some(o => o.slot === preferred) ? preferred : options[0]?.slot;
    // The paper is chosen HERE, at the moment the pad is made, because that is
    // when someone knows what they are about to use it for — squared for a
    // derivation, ruled for an explanation, 田字格 for characters. It was
    // reachable only afterwards, through the pad's own menu, which meant every
    // pad started blank and had to be corrected.
    let style = createScratchStyle(defaultStyle);

    dialog.innerHTML = `
      <div class="deck-dialog-title">${escapeHtml(t('scratch.newTitle'))}</div>
      <label class="deck-field">
        <span class="deck-field-label">${escapeHtml(t('scratch.name'))}</span>
        <input type="text" class="deck-input" data-role="name" maxlength="${nameMax}">
      </label>
      <div class="deck-field-label">${escapeHtml(t('scratch.style'))}</div>
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
    input.value = defaultName || '';

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

    const commit = () => finish({
      name: input.value.trim() || defaultName,
      slot: chosen,
      style,
    });
    dialog.querySelector('[data-role="cancel"]').textContent = t('deck.cancel');
    dialog.querySelector('[data-role="confirm"]').textContent = t('scratch.createAndOpen');
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    dialog.querySelector('[data-role="confirm"]').addEventListener('click', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
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
    entry.kind === ENTRY_KINDS.SCRATCH ? t('deck.scratch') : t('deck.pdf'))}</span>
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
 *          actions: Array<{id: string, label: string, danger?: boolean}>}} spec
 * @returns {Promise<string|null>} 选中的 id
 */
export function chooseAction({ title, note = '', actions = [] }) {
  return modal((dialog, finish) => {
    dialog.innerHTML = `
      <div class="deck-dialog-title">${escapeHtml(title)}</div>
      ${note ? `<p class="deck-dialog-note">${escapeHtml(note)}</p>` : ''}
      <div class="deck-actions"></div>
      <div class="deck-dialog-actions">
        <button type="button" class="deck-dialog-btn" data-role="cancel">${escapeHtml(t('common.cancel'))}</button>
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

export function confirmDestructive({ title, body, confirmLabel }) {
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
  });
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
