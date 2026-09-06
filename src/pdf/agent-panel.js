// PDF Module — the Agent overlay.
//
// Owns only the floating trigger and the result dialog. It does not read PDF
// content and it does not know which Agent transport is being used; the
// workspace supplies metadata and result text through the small imperative API
// returned by createAgentPanel().

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

/**
 * Mounts the workspace-level Agent trigger and dialog.
 *
 * The panel is intentionally imperative: PDF workspaces already own their
 * DOM and lifecycle, while this module should remain independent of document
 * loading, text quality and the eventual C++ transport.
 */
export function createAgentPanel(root, { onOpen, onClose } = {}) {
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
    </section>
  `;
  root.appendChild(layer);

  const fab = layer.querySelector('[data-role="agent-fab"]');
  const dialog = layer.querySelector('[data-role="agent-dialog"]');
  const closeButton = layer.querySelector('[data-role="agent-close"]');
  const metaEl = layer.querySelector('[data-role="agent-meta"]');
  const contentEl = layer.querySelector('[data-role="agent-content"]');

  let available = false;
  let opened = false;
  let metadata = {};
  let previousFocus = null;

  const syncVisibility = () => {
    fab.hidden = !available || opened;
    dialog.hidden = !opened;
  };

  const renderMetadata = () => {
    metaEl.textContent = metadataLabel(metadata);
  };

  const open = (nextMetadata = {}) => {
    if (!available) return;
    metadata = { ...nextMetadata };
    previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    opened = true;
    renderMetadata();
    syncVisibility();
    closeButton.focus();
  };

  const close = ({ notify = true } = {}) => {
    opened = false;
    metadata = {};
    contentEl.replaceChildren();
    contentEl.dataset.state = '';
    syncVisibility();
    if (notify) onClose?.();
    if (available) fab.focus();
    else previousFocus?.focus?.();
    previousFocus = null;
  };

  fab.addEventListener('click', () => onOpen?.());
  closeButton.addEventListener('click', () => close());

  return {
    setAvailable(value) {
      available = !!value;
      if (!available && opened) close();
      syncVisibility();
    },

    open,

    close,

    showLoading(nextMetadata = null) {
      if (nextMetadata) {
        metadata = { ...metadata, ...nextMetadata };
        renderMetadata();
      }
      contentEl.dataset.state = 'loading';
      contentEl.textContent = '正在检查当前页文字……';
    },

    showResult(result = {}) {
      if (result.textOrigin) {
        metadata = { ...metadata, textOrigin: result.textOrigin };
        renderMetadata();
      }
      contentEl.dataset.state = result.ok ? 'result' : 'error';
      contentEl.textContent = result.answer || 'Agent 暂时没有返回结果。';
    },

    showNotice(message, nextMetadata = null) {
      if (nextMetadata) {
        metadata = { ...metadata, ...nextMetadata };
        renderMetadata();
      }
      contentEl.dataset.state = 'notice';
      contentEl.textContent = message || '';
    },

    destroy() {
      layer.remove();
    },
  };
}
