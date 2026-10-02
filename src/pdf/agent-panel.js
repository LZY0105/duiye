// PDF Module — the Agent overlay.
//
// Owns only the floating trigger and the result dialog. It does not read PDF
// content and it does not know which Agent transport is being used; the
// workspace supplies metadata and result text through the small imperative API
// returned by createAgentPanel().

import { renderAgentAnswer } from '../agent/answer-renderer.js';
import { onLangChange, t, translateDOM } from '../core/i18n.js';
import { confirmDestructive } from './deck-dialogs.js';

/** 助手名字本身也是一个词条：句子里要出现时走插值，别在代码里再抄一份。 */
const agentVars = () => ({ name: t('agent.name') });

/**
 * 文字来源的标签。OCR 是缩写，三种语言写法一样，不建词条。
 */
const SOURCE_LABELS = Object.freeze({
  LAYER: () => t('agent.origin.layer'),
  OCR: () => 'OCR',
  NONE: () => t('agent.origin.none'),
});

function sourceLabel(origin) {
  return SOURCE_LABELS[origin]?.() || '';
}

function metadataLabel(metadata = {}) {
  const parts = [
    metadata.documentName || t('agent.meta.currentDocument'),
    Number.isFinite(metadata.page) ? t('agent.meta.page', { page: metadata.page }) : '',
    sourceLabel(metadata.textOrigin),
  ];
  return parts.filter(Boolean).join(' · ');
}

function createMessageElement(
  role,
  content,
  { pending = false, status = 'done', generated = '' } = {},
) {
  const messageEl = document.createElement('article');
  messageEl.className = `pdf-agent-message is-${role}`;
  messageEl.dataset.role = 'agent-message';
  messageEl.dataset.messageRole = role;

  if (pending) messageEl.classList.add('is-pending');

  if (status === 'error') messageEl.classList.add('is-error');

  const bodyEl = document.createElement('div');
  bodyEl.className = 'pdf-agent-message-body';
  // 面板自己生成的那句（目前只有「正在思考」）要跟着语言换，标出来好找。
  if (generated) bodyEl.dataset.generated = generated;

  if (role === 'assistant' && !pending) {
    bodyEl.innerHTML = renderAgentAnswer(content);
  } else {
    // 用户消息和加载提示永远只作为文本处理。
    bodyEl.textContent = content;
  }

  messageEl.appendChild(bodyEl);
  return messageEl;
}

/**
 * Mounts the workspace-level Agent trigger and dialog.
 *
 * The panel is intentionally imperative: PDF workspaces already own their
 * DOM and lifecycle, while this module should remain independent of document
 * loading, text quality and the eventual C++ transport.
 */
export function createAgentPanel(
  root,
  { onOpen, onClose, onSubmit, onClear } = {},
) {
  const layer = document.createElement('div');
  layer.className = 'pdf-agent-layer';
  // 静态文案走 data-i18n；由状态决定的那几句（发送/处理中、空会话、等待回答）
  // 由 syncForm() 和 paintGenerated() 独占，不挂标记，免得两边各写一次。
  layer.innerHTML = `
    <button type="button"
            class="pdf-agent-fab"
            data-role="agent-fab"
            title="${t('agent.fab.open', agentVars())}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
           width="22" height="22" aria-hidden="true">
        <path d="M7.5 17.5 4 20l.9-4.1A7.7 7.7 0 0 1 3 10.5C3 6.4 7 3 12 3s9 3.4 9 7.5-4 7.5-9 7.5c-1.6 0-3.1-.4-4.5-1Z" />
        <path d="m12 6.4.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8Z" />
      </svg>
    </button>
    <section class="pdf-agent-dialog"
             data-role="agent-dialog"
             role="dialog"
             aria-modal="false"
             aria-labelledby="pdf-agent-dialog-title"
             hidden>
      <header class="pdf-agent-dialog-header">
        <div>
          <h2 id="pdf-agent-dialog-title" data-i18n="agent.name">${t('agent.name')}</h2>
          <div class="pdf-agent-dialog-meta" data-role="agent-meta"></div>
        </div>
        <div class="pdf-agent-dialog-actions">
          <button type="button"
                  class="pdf-agent-dialog-clear"
                  data-role="agent-clear"
                  data-i18n="agent.dialog.clearShort"
                  title="${t('agent.dialog.clear', agentVars())}">${t('agent.dialog.clearShort')}</button>
          <button type="button"
                  class="pdf-agent-dialog-close"
                  data-role="agent-close"
                  title="${t('agent.dialog.close', agentVars())}">×</button>
        </div>
      </header>
      <div class="pdf-agent-dialog-content"
           data-role="agent-content"
           aria-live="polite"></div>
      <form class="pdf-agent-form" data-role="agent-form">
        <textarea class="pdf-agent-question"
                  data-role="agent-question"
                  rows="2"
                  maxlength="500"
                  aria-label="${t('agent.question.label')}"
                  data-i18n-placeholder="agent.question.placeholder"
                  placeholder="${t('agent.question.placeholder')}"></textarea>
        <button type="submit"
                class="pdf-agent-submit"
                data-role="agent-submit"
                disabled>${t('agent.submit')}</button>
      </form>
    </section>
  `;
  root.appendChild(layer);

  const fab = layer.querySelector('[data-role="agent-fab"]');
  const dialog = layer.querySelector('[data-role="agent-dialog"]');
  const closeButton = layer.querySelector('[data-role="agent-close"]');
  const clearButton = layer.querySelector('[data-role="agent-clear"]');
  const metaEl = layer.querySelector('[data-role="agent-meta"]');
  const contentEl = layer.querySelector('[data-role="agent-content"]');
  const form = layer.querySelector('[data-role="agent-form"]');
  const questionInput = layer.querySelector('[data-role="agent-question"]');
  const submitButton = layer.querySelector('[data-role="agent-submit"]');

  let available = false;
  let opened = false;
  let busy = false;
  /** 面板上是否真的有一轮对话可清——决定「清空」按钮能不能按。 */
  let hasConversation = false;
  let metadata = {};
  let previousFocus = null;
  let clearConfirmation = null;
  let composing = false;
  /**
   * 内容区当前画的是什么。
   *
   * 整块由面板生成的文字（空会话、读取中、提示、兜底回答）换语言时重画；消息列表
   * 只换掉「正在思考」那一句——用户消息和模型回答是别人的原话，一个字都不动。
   */
  let view = { kind: 'generated', state: '', key: '' };

  const syncVisibility = () => {
    fab.hidden = !available || opened;
    dialog.hidden = !opened;
  };

  const syncForm = () => {
    const hasQuestion = Boolean(questionInput.value.trim());
    const blocked = busy || Boolean(clearConfirmation);
    questionInput.disabled = blocked;
    submitButton.disabled = blocked || !hasQuestion;
    submitButton.textContent = busy ? t('agent.submitBusy') : t('agent.submit');
    // 正在飞的请求不能一边等回答一边被清掉。
    clearButton.disabled = blocked || !hasConversation;
  };

  const cancelClearConfirmation = () => {
    const controller = clearConfirmation;
    clearConfirmation = null;
    controller?.abort();
  };

  const renderMetadata = () => {
    metaEl.textContent = metadataLabel(metadata);
  };

  /** 画内容区里那句由面板自己生成的说明。 */
  const paintGenerated = () => {
    const { state = '', key = '' } = view;
    contentEl.dataset.state = state;
    // 提示里可能嵌着助手名称（"关闭页问后…"），变量必须在这里按当前语言代入。
    contentEl.textContent = key ? t(key, agentVars()) : '';
  };

  const renderConversation = (conversation = {}) => {
    cancelClearConfirmation();
    const messages = Array.isArray(conversation.messages)
      ? conversation.messages
      : [];
    const fragment = document.createDocumentFragment();
    let renderedMessages = 0;

    for (const message of messages) {
      if (
        message?.role !== 'user'
        && message?.role !== 'assistant'
      ) {
        continue;
      }

      const content = String(message.content ?? '').trim();
      if (!content) continue;

      fragment.appendChild(
        createMessageElement(
          message.role,
          content,
          { status: message.status },
        ),
      );
      renderedMessages += 1;
    }

    if (conversation.pendingRequestId) {
      fragment.appendChild(
        createMessageElement(
          'assistant',
          t('agent.status.thinking', agentVars()),
          { pending: true, generated: 'thinking' },
        ),
      );
    }

    busy = Boolean(conversation.pendingRequestId);
    hasConversation = renderedMessages > 0;

    if (fragment.childNodes.length === 0) {
      view = { kind: 'generated', state: 'notice', key: 'agent.status.empty' };
      paintGenerated();
    } else {
      // 有记录才重画，且只在这里画：换语言不动这一块，只换「正在思考」那一句。
      const scrollTop = contentEl.scrollTop;
      view = { kind: 'conversation' };
      contentEl.dataset.state = 'conversation';
      contentEl.replaceChildren(fragment);
      contentEl.scrollTop = scrollTop > 0 ? scrollTop : contentEl.scrollHeight;
    }

    syncForm();
  };

  /**
   * 语言换了之后把这一屏重写一遍。
   *
   * 静态文案、title 与 aria-label 走 data-i18n；状态说明、页码和来源由这里重画。
   * 会话内容属于用户和模型，不翻译，也不重新渲染——那样会白跑一遍 Markdown 和公式，
   * 顺手把滚动位置和对焦搅乱。
   */
  const applyLanguage = () => {
    // A confirmation in the old language is dismissed rather than left misleading.
    const hadConfirmation = Boolean(clearConfirmation);
    cancelClearConfirmation();
    translateDOM(layer);
    // 输入框的无障碍名不是悬停提示：data-i18n-title 会给它挂一个 title，不合适。
    questionInput.setAttribute('aria-label', t('agent.question.label'));
    // 这三处的文案里嵌着助手名称，t(key) 单独取会留下没填的 {{name}}，所以自己代入。
    fab.title = t('agent.fab.open', agentVars());
    fab.setAttribute('aria-label', fab.title);
    clearButton.title = t('agent.dialog.clear', agentVars());
    clearButton.setAttribute('aria-label', clearButton.title);
    closeButton.title = t('agent.dialog.close', agentVars());
    closeButton.setAttribute('aria-label', closeButton.title);
    renderMetadata();

    if (view.kind === 'conversation') {
      for (const el of contentEl.querySelectorAll('[data-generated="thinking"]')) {
        el.textContent = t('agent.status.thinking', agentVars());
      }
    } else if (view.kind === 'answer') {
      if (view.answer === null) {
        contentEl.innerHTML = renderAgentAnswer(t('agent.reply.empty', agentVars()));
      }
    } else {
      paintGenerated();
    }

    syncForm();
    if (hadConfirmation && opened && !busy) questionInput.focus({ preventScroll: true });
  };

  const open = (nextMetadata = {}) => {
    if (!available) return;
    cancelClearConfirmation();
    composing = false;
    previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    metadata = { ...nextMetadata };
    opened = true;
    busy = false;
    hasConversation = false;
    view = { kind: 'generated', state: 'notice', key: 'agent.status.empty' };
    paintGenerated();
    renderMetadata();
    syncVisibility();
    syncForm();
    questionInput.focus();
  };

  const close = ({ notify = true } = {}) => {
    if (!opened) return;
    cancelClearConfirmation();
    composing = false;
    opened = false;
    busy = false;
    hasConversation = false;
    metadata = {};
    view = { kind: 'generated', state: '', key: '' };
    contentEl.replaceChildren();
    contentEl.dataset.state = '';
    questionInput.value = '';
    syncForm();
    syncVisibility();
    if (notify) onClose?.();
    if (available) fab.focus();
    else previousFocus?.focus?.();
    previousFocus = null;
  };

  fab.addEventListener('click', () => onOpen?.());
  closeButton.addEventListener('click', () => close());

  clearButton.addEventListener('click', async () => {
    if (!opened || busy || !hasConversation || clearConfirmation) return;

    const controller = new AbortController();
    clearConfirmation = controller;
    syncForm();
    try {
      const confirmed = await confirmDestructive({
        title: t('agent.dialog.clearTitle'),
        body: t('agent.dialog.clearBody', agentVars()),
        confirmLabel: t('agent.dialog.clearShort'),
        signal: controller.signal,
        focusCancel: true,
      });
      // Closing, changing pages or receiving a newer state invalidates this consent.
      if (!confirmed || controller.signal.aborted || clearConfirmation !== controller
          || !opened || busy || !hasConversation) return;

      clearConfirmation = null;
      // The owner checks the actual document/page and may refuse a stale target.
      if (onClear?.() !== false && opened) {
        renderConversation({ messages: [], pendingRequestId: null });
      }
    } finally {
      if (clearConfirmation === controller) clearConfirmation = null;
      if (opened && !controller.signal.aborted && !clearConfirmation) {
        syncForm();
        if (!busy) questionInput.focus({ preventScroll: true });
      }
    }
  });

  questionInput.addEventListener('input', syncForm);
  questionInput.addEventListener('compositionstart', () => { composing = true; });
  questionInput.addEventListener('compositionend', () => { composing = false; });
  questionInput.addEventListener('keydown', (event) => {
    // Enter used to commit an input-method candidate is not a send instruction.
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)
        || event.altKey || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || !opened || busy || clearConfirmation
        || !questionInput.value.trim()) return;
    form.requestSubmit(submitButton);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const question = questionInput.value.trim();
    if (!question || !opened || busy || clearConfirmation || composing) return;

    onSubmit?.(question);
    questionInput.value = '';
    syncForm();
  });

  // 挂上去之后跑一次：静态文案、title 和 aria-label 都要按当前语言写一遍。
  applyLanguage();
  const offLang = onLangChange(applyLanguage);

  return {
    setAvailable(value) {
      available = !!value;
      if (!available && opened) close();
      syncVisibility();
    },

    open,

    close,

    showConversation(conversation = {}, nextMetadata = null) {
      if (nextMetadata) {
        metadata = { ...metadata, ...nextMetadata };
        renderMetadata();
      }

      renderConversation(conversation);
    },

    showLoading(nextMetadata = null) {
      cancelClearConfirmation();
      busy = true;
      hasConversation = false;

      if (nextMetadata) {
        metadata = { ...metadata, ...nextMetadata };
        renderMetadata();
      }
      view = { kind: 'generated', state: 'loading', key: 'agent.status.reading' };
      paintGenerated();

      syncForm();
    },

    showResult(result = {}) {
      cancelClearConfirmation();
      busy = false;
      hasConversation = false;

      if (result.textOrigin) {
        metadata = { ...metadata, textOrigin: result.textOrigin };
        renderMetadata();
      }
      contentEl.dataset.state = result.ok ? 'result' : 'error';
      // 模型回答原样渲染，换语言也不重画；只有它缺席时那句兜底是面板生成的。
      const answer = result.answer || null;
      view = { kind: 'answer', answer };
      contentEl.innerHTML = renderAgentAnswer(
        answer ?? t('agent.reply.empty', agentVars()),
      );

      syncForm();
    },

    /**
     * @param {string} messageKey 词条键。t() 查不到时原样显示，所以传一句现成的话
     *   也能用，只是那样不会跟着语言换。
     */
    showNotice(messageKey, nextMetadata = null) {
      cancelClearConfirmation();
      busy = false;
      hasConversation = false;

      if (nextMetadata) {
        metadata = { ...metadata, ...nextMetadata };
        renderMetadata();
      }
      view = { kind: 'generated', state: 'notice', key: messageKey || '' };
      paintGenerated();

      syncForm();
    },

    destroy() {
      cancelClearConfirmation();
      opened = false;
      offLang();
      layer.remove();
    },
  };
}
