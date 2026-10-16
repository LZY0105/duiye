// PDF Module — the Agent overlay.
//
// Owns only the floating trigger and the result dialog. It does not read PDF
// content and it does not know which Agent transport is being used; the
// workspace supplies metadata and result text through the small imperative API
// returned by createAgentPanel().

import { renderAgentAnswer } from '../agent/answer-renderer.js';

// ── 那颗圆按钮能拖 ──────────────────────────────────────────────────────────
//
// 人说「做一下 agent 按钮可以拖动功能」。它原来钉在工作区右边正中，正好压在书页右边那一截上。
// 现在按住拖到哪儿都行，松手吸到最近的左边或右边（不停在书页中间挡字），高度照放下的地方；记下来，
// 下次打开还在那儿。按下去挪不到 FAB_DRAG_SLOP 就还是点——点它照旧打开对话。

/** 挪过这么多（px）才算拖，不然是点：手指按下去总要抖一两个像素。 */
const FAB_DRAG_SLOP = 8;
/** 按钮离工作区四边至少留多少（px）：和原来钉在右边时一样。 */
const FAB_MARGIN = 14;
const FAB_SIZE = 48;
/** 记在这里：{ side: 'left' | 'right', y: 按钮正中的高度占工作区高度的比例 }。按比例记，转屏、分栏变了也落在差不多的地方。 */
const FAB_STORAGE_KEY = 'ls_agent_fab';
/** 松手以后吸过去：和顶栏收起、工具栏停靠同一条曲线。 */
const FAB_SETTLE_MS = 340;
const FAB_SETTLE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const DEFAULT_FAB_PLACEMENT = Object.freeze({ side: 'right', y: 0.5 });

function readFabPlacement() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAB_STORAGE_KEY) || 'null');
    if ((saved?.side === 'left' || saved?.side === 'right') && Number.isFinite(saved.y)) {
      return { side: saved.side, y: Math.min(1, Math.max(0, saved.y)) };
    }
  } catch (_) { /* 读不到、记坏了：放回原处 */ }
  return { ...DEFAULT_FAB_PLACEMENT };
}

function writeFabPlacement(placement) {
  try {
    localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify(placement));
  } catch (_) { /* 无痕模式：这一次记不住，按钮照样在那儿 */ }
}

/** 夹在 lo、hi 之间；地方小到放不下（hi < lo）时贴着 lo。 */
function clampTo(value, lo, hi) {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
  { onOpen, onClose, onSubmit, onPlace } = {},
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

  // ── 拖着挪地方 ──
  let placement = readFabPlacement();
  // 上面栏头占掉多少、下面占掉多少（px，工作区量了给）：按钮拖不进去，记着的高度也不落进去。
  let safeTop = 0;
  let safeBottom = 0;
  let press = null;
  let swallowClick = false;

  // 停着的位置交给样式表（pdf.css 的 .pdf-agent-fab）：哪一边是一个类，高度是一个比例，上下的界是两个数。
  const applyPlacement = () => {
    layer.classList.toggle('is-fab-left', placement.side === 'left');
    layer.style.setProperty('--agent-fab-y', `${(placement.y * 100).toFixed(3)}%`);
    layer.style.setProperty('--agent-fab-top-min', `${Math.round(safeTop + FAB_MARGIN)}px`);
    layer.style.setProperty('--agent-fab-safe-bottom', `${Math.round(safeBottom)}px`);
  };
  applyPlacement();

  const fabSize = () => fab.offsetWidth || FAB_SIZE;

  // 拖着的时候直接写 left / top（相对这一层），按下去的那一点一直在手指底下，出不了工作区、进不了栏头。
  const followPointer = (event) => {
    const box = layer.getBoundingClientRect();
    const size = fabSize();
    const left = clampTo(event.clientX - box.left - press.grabX, FAB_MARGIN, box.width - size - FAB_MARGIN);
    const top = clampTo(
      event.clientY - box.top - press.grabY,
      safeTop + FAB_MARGIN,
      box.height - safeBottom - size - FAB_MARGIN,
    );
    fab.style.left = `${left}px`;
    fab.style.top = `${top}px`;
  };

  // 松手：离哪边近吸到哪边，高度照放下的地方；记下来，再从松手的地方滑过去。
  const settle = () => {
    const box = layer.getBoundingClientRect();
    const size = fabSize();
    const from = { left: parseFloat(fab.style.left), top: parseFloat(fab.style.top) };
    if (Number.isFinite(from.left) && Number.isFinite(from.top)) {
      placement = {
        side: from.left + size / 2 < box.width / 2 ? 'left' : 'right',
        y: box.height > 0 ? clampTo((from.top + size / 2) / box.height, 0, 1) : DEFAULT_FAB_PLACEMENT.y,
      };
      writeFabPlacement(placement);
    }
    fab.classList.remove('is-dragging');
    fab.style.removeProperty('left');
    fab.style.removeProperty('top');
    applyPlacement();
    // 给贴边的工具栏让路的那一截（--agent-fab-left / --agent-fab-right）要按新的那一边再量一次，量完才知道
    // 最后落在哪儿。
    onPlace?.();
    if (prefersReducedMotion() || typeof fab.animate !== 'function') return;
    // 用 left / top 动，不用 translate：液态玻璃给按钮的 translate、scale 是 !important（弹性、按下去），动画盖不过它。
    const rest = getComputedStyle(fab);
    const to = { left: parseFloat(rest.left), top: parseFloat(rest.top) };
    if (![from.left, from.top, to.left, to.top].every(Number.isFinite)) return;
    if (Math.abs(from.left - to.left) < 0.5 && Math.abs(from.top - to.top) < 0.5) return;
    fab.animate(
      [{ left: `${from.left}px`, top: `${from.top}px` }, { left: `${to.left}px`, top: `${to.top}px` }],
      { duration: FAB_SETTLE_MS, easing: FAB_SETTLE_EASE },
    );
  };

  fab.addEventListener('pointerdown', (event) => {
    swallowClick = false;
    if (press || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const r = fab.getBoundingClientRect();
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      grabX: event.clientX - r.left,
      grabY: event.clientY - r.top,
      dragging: false,
    };
  });

  fab.addEventListener('pointermove', (event) => {
    if (!press || event.pointerId !== press.id) return;
    if (!press.dragging) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < FAB_DRAG_SLOP) return;
      press.dragging = true;
      // 上一次松手的那段滑动还没走完：停下，从它现在画在哪儿接着拖（动画压在行内样式上面，不停下就拖不动）。
      fab.getAnimations?.().forEach((animation) => animation.cancel());
      fab.classList.add('is-dragging');
      try { fab.setPointerCapture?.(press.id); } catch (_) { /* 已经抬起来了 */ }
    }
    followPointer(event);
  });

  const release = (event) => {
    if (!press || event.pointerId !== press.id) return;
    const dragged = press.dragging;
    press = null;
    if (!dragged) return;
    // 拖完松手，浏览器紧跟着还会补一个 click：那不是点它。下一次按下去时清掉，免得一直吞着。
    swallowClick = true;
    settle();
  };
  fab.addEventListener('pointerup', release);
  fab.addEventListener('pointercancel', release);
  fab.addEventListener('lostpointercapture', (event) => {
    // 只认按钮自己丢了指针。手指按下去时浏览器把指针隐式交给手指底下那一层（图标、液态玻璃挂的那几层），
    // 拖起来时上面 setPointerCapture 把它要到按钮身上——那一层会收到一个 lostpointercapture，冒泡上来，
    // 那不是手势被收走（平板上实测：当成松手，拖一下按钮只挪两个像素就吸回去了）。
    if (event.target === fab) release(event);
  });

  fab.addEventListener('click', (event) => {
    if (swallowClick) {
      swallowClick = false;
      event.preventDefault();
      return;
    }
    onOpen?.();
  });
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

    /** 按钮停在哪一边、多高（正中占工作区高度的比例）：工作区按这个给贴边的工具栏让路。 */
    placement() {
      return { ...placement };
    },

    /** 上面栏头、下面各占掉多少（px）：按钮拖不进去，记着的高度也不落进去。 */
    setSafeArea(top = 0, bottom = 0) {
      const t = Math.max(0, Number(top) || 0);
      const b = Math.max(0, Number(bottom) || 0);
      if (t === safeTop && b === safeBottom) return;
      safeTop = t;
      safeBottom = b;
      applyPlacement();
    },

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
