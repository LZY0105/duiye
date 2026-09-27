// PDF Module — the Agent overlay.
//
// Owns only the floating trigger and the result dialog. It does not read PDF
// content and it does not know which Agent transport is being used; the
// workspace supplies metadata and result text through the small imperative API
// returned by createAgentPanel().

import { renderAgentAnswer } from '../agent/answer-renderer.js';

const SOURCE_LABELS = Object.freeze({
  LAYER: 'PDF 文字层',
  OCR: 'OCR',
  NONE: '文字不可用',
});

function sourceLabel(origin) {
  return SOURCE_LABELS[origin] || '';
}

function metadataLabel(metadata = {}) {
  const parts = [
    metadata.documentName || '当前文档',
    Number.isFinite(metadata.page) ? `第 ${metadata.page} 页` : '',
    sourceLabel(metadata.textOrigin),
  ];
  return parts.filter(Boolean).join(' · ');
}

function createMessageElement(
  role,
  content,
  { pending = false, status = 'done' } = {},
) {
  const messageEl = document.createElement('article');
  messageEl.className = `pdf-agent-message is-${role}`;
  messageEl.dataset.role = 'agent-message';
  messageEl.dataset.messageRole = role;

  if (pending) messageEl.classList.add('is-pending');

  if (status === 'error') messageEl.classList.add('is-error');

  const bodyEl = document.createElement('div');
  bodyEl.className = 'pdf-agent-message-body';

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
  { onOpen, onClose, onSubmit } = {},
) {
  const layer = document.createElement('div');
  layer.className = 'pdf-agent-layer';
  layer.innerHTML = `
    <button type="button"
            class="pdf-agent-fab"
            data-role="agent-fab"
            aria-label="打开 Agent 对话框"
            title="打开 Agent 对话框">
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
          <h2 id="pdf-agent-dialog-title">Agent</h2>
          <div class="pdf-agent-dialog-meta" data-role="agent-meta"></div>
        </div>
        <button type="button"
                class="pdf-agent-dialog-close"
                data-role="agent-close"
                aria-label="关闭 Agent 对话框"
                title="关闭">×</button>
      </header>
      <div class="pdf-agent-dialog-content"
           data-role="agent-content"
           aria-live="polite"></div>
      <form class="pdf-agent-form" data-role="agent-form">
        <textarea class="pdf-agent-question"
                  data-role="agent-question"
                  rows="2"
                  maxlength="500"
                  aria-label="输入关于当前页的问题"
                  placeholder="输入关于当前页的问题……"></textarea>
        <button type="submit"
                class="pdf-agent-submit"
                data-role="agent-submit"
                disabled>发送</button>
      </form>
    </section>
  `;
  root.appendChild(layer);

  const fab = layer.querySelector('[data-role="agent-fab"]');
  const dialog = layer.querySelector('[data-role="agent-dialog"]');
  const closeButton = layer.querySelector('[data-role="agent-close"]');
  const metaEl = layer.querySelector('[data-role="agent-meta"]');
  const contentEl = layer.querySelector('[data-role="agent-content"]');
  const form = layer.querySelector('[data-role="agent-form"]');
  const questionInput = layer.querySelector('[data-role="agent-question"]');
  const submitButton = layer.querySelector('[data-role="agent-submit"]');

  let available = false;
  let opened = false;
  let busy = false;
  let metadata = {};
  let previousFocus = null;

  const syncVisibility = () => {
    fab.hidden = !available || opened;
    dialog.hidden = !opened;
  };

  const syncForm = () => {
    const hasQuestion = Boolean(questionInput.value.trim());
    questionInput.disabled = busy;
    submitButton.disabled = busy || !hasQuestion;
    submitButton.textContent = busy ? '处理中…' : '发送';
  };

  const renderMetadata = () => {
    metaEl.textContent = metadataLabel(metadata);
  };

  const renderConversation = (conversation = {}) => {
    const messages = Array.isArray(conversation.messages)
      ? conversation.messages
      : [];
    const fragment = document.createDocumentFragment();

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
    }

    if (conversation.pendingRequestId) {
      fragment.appendChild(
        createMessageElement(
          'assistant',
          'Agent 正在思考……',
          { pending: true },
        ),
      );
    }

    busy = Boolean(conversation.pendingRequestId);

    if (fragment.childNodes.length === 0) {
      contentEl.dataset.state = 'notice';
      contentEl.textContent = '输入一个关于当前页的问题。';
    } else {
      contentEl.dataset.state = 'conversation';
      contentEl.replaceChildren(fragment);
      contentEl.scrollTop = contentEl.scrollHeight;
    }

    syncForm();
  };

  const open = (nextMetadata = {}) => {
    if (!available) return;
    previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    metadata = { ...nextMetadata };
    opened = true;
    busy = false;
    contentEl.dataset.state = 'notice';
    contentEl.textContent = '输入一个关于当前页的问题。';
    renderMetadata();
    syncVisibility();
    syncForm();
    questionInput.focus();
  };

  const close = ({ notify = true } = {}) => {
    if (!opened) return;
    opened = false;
    busy = false;
    metadata = {};
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

  questionInput.addEventListener('input', syncForm);

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const question = questionInput.value.trim();
    if (!question || busy) return;

    onSubmit?.(question);
    questionInput.value = '';
    syncForm();
  });

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
      busy = true;

      if (nextMetadata) {
        metadata = { ...metadata, ...nextMetadata };
        renderMetadata();
      }
      contentEl.dataset.state = 'loading';
      contentEl.textContent = '正在检查当前页文字……';

      syncForm();
    },

    showResult(result = {}) {
      busy = false;

      if (result.textOrigin) {
        metadata = { ...metadata, textOrigin: result.textOrigin };
        renderMetadata();
      }
      contentEl.dataset.state = result.ok ? 'result' : 'error';
      contentEl.innerHTML = renderAgentAnswer(result.answer || 'Agent 暂时没有返回结果。',);

      syncForm();
    },

    showNotice(message, nextMetadata = null) {
      busy = false;

      if (nextMetadata) {
        metadata = { ...metadata, ...nextMetadata };
        renderMetadata();
      }
      contentEl.dataset.state = 'notice';
      contentEl.textContent = message || '';

      syncForm();
    },

    destroy() {
      layer.remove();
    },
  };
}
