// PDF Module — the answer-lookup panel.
//
// Shows the answer for each question on the current exercise page. It renders
// what the matcher decided and never decides anything itself.
//
// The governing display rule: a match's CONFIDENCE must be visible, not buried.
// A number-only match across an unaligned book is a guess, and presenting it
// with the same authority as a chapter-aligned content match would quietly
// mislead — the user cannot tell the two apart from the answer text alone.
// Weak matches are therefore labelled, and ambiguous ones show the alternatives
// instead of a choice this module is not entitled to make.

import { CONFIDENCE } from './question-matcher.js';
import { RUNG } from './decision.js';

const CONFIDENCE_META = {
  [CONFIDENCE.HIGH]: { label: '匹配可靠', className: 'is-high' },
  [CONFIDENCE.MEDIUM]: { label: '较可能匹配', className: 'is-medium' },
  [CONFIDENCE.LOW]: { label: '匹配不确定，请自行核对', className: 'is-low' },
  [CONFIDENCE.NONE]: { label: '无法确定', className: 'is-none' },
};

/**
 * The rung is the engine's verdict; confidence is only how strong the evidence
 * for THIS question was.
 *
 * They are separate on purpose and the panel must not merge them. A question
 * can carry overwhelming per-question evidence — a unique bookmark id hit — and
 * still be capped at REVIEW because the two BOOKS have not been established as
 * a pair. That is the case that used to produce confident wrong answers: every
 * individual comparison looks perfect when an exercise book is matched against
 * the wrong year's key. So the rung leads, and the cap is named.
 */
const RUNG_META = {
  [RUNG.AUTO_MATCH]: { label: '匹配可靠', className: 'is-high', showAnswer: true },
  [RUNG.REVIEW]: { label: '请核对后使用', className: 'is-medium', showAnswer: true },
  [RUNG.LOCATED]: { label: '已定位，未确认', className: 'is-low', showAnswer: false },
  [RUNG.REFUSED]: { label: '无法确定', className: 'is-none', showAnswer: false },
  [RUNG.BLOCKED]: { label: '已阻止', className: 'is-none', showAnswer: false },
};

/** Why a result was held back, in the reader's terms rather than a code. */
const CAP_REASONS = {
  PAIR_IDENTITY_UNKNOWN: '尚未确认这两本书是配套的',
  PAIR_IDENTITY_MISMATCH: '这两本书看起来不是一对',
  OCR_REQUIRED: '文本层不可读，需要先识别',
  TEXT_OPAQUE: '文本层无法解码',
};

const describeCap = (code) => CAP_REASONS[code] || (code ? String(code) : '');

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * The panel while the matcher is still working.
 *
 * Matching walks a 372-page answer key, so on a cold index there is a real
 * wait. A single line of text gave no sense of what was coming or how much:
 * the panel sat empty and then everything appeared at once. Skeleton rows
 * reserve the shape of the result instead, so the panel does not jump when the
 * matches land, and the reader can see that rows — not an error — are on the
 * way.
 *
 * The count is the number of questions found on the page, so the placeholder is
 * the right height rather than an arbitrary three bars.
 */
export function renderAnswerLoading(host, { page, count = 3 } = {}) {
  if (!host) return;
  const rows = Array.from({ length: Math.max(1, Math.min(6, count)) }, () => `
    <div class="answer-row is-skeleton" aria-hidden="true">
      <div class="answer-q"><span class="sk sk-label"></span><span class="sk sk-chip"></span></div>
      <div class="answer-qtext"><span class="sk sk-line"></span></div>
    </div>`).join('');

  host.innerHTML = `
    <div class="answer-panel is-loading" role="status" aria-live="polite" aria-busy="true">
      <div class="answer-head">
        <span>${page ? `第 ${escapeHtml(page)} 页` : ''} 正在匹配答案…</span>
        <span class="answer-spinner" aria-hidden="true"></span>
      </div>
      ${rows}
    </div>`;
}

/** The dismiss control, shared by the notice and the matched-answer header. */
function closeButtonHtml(title = '收起') {
  return `<button type="button" class="answer-close" data-role="close-answers"
            title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" width="13" height="13" aria-hidden="true">
        <path d="M5 5l14 14M19 5L5 19"/>
      </svg>
    </button>`;
}

/**
 * A plain message: no answer book, scanned document, nothing on this page.
 *
 * `hint` is the thing to DO about it. A notice that only reports the failure
 * leaves the reader to guess whether the app is broken or the file is wrong,
 * and the answer is almost always the file — so when there is a next step
 * worth taking, it is said here rather than left to be inferred.
 *
 * The panel is dismissible whatever it says. It was not: a notice covered the
 * top of the page it was reporting on and the only way to clear it was to press
 * the answer button a second time, which is an odd thing to have to work out —
 * and a panel that reports a FAILURE is the one the reader most wants gone.
 *
 * @param {{hint?: string, onDismiss?: function}} [opts]
 */
export function renderAnswerNotice(host, message, { hint, onDismiss } = {}) {
  if (!host) return;
  const wrap = document.createElement('div');
  wrap.className = 'answer-panel';
  wrap.innerHTML = `
    <div class="answer-notice-head">${closeButtonHtml('关闭')}</div>
    <div class="answer-notice">${escapeHtml(message)}</div>
    ${hint ? `<div class="answer-notice-hint">${escapeHtml(hint)}</div>` : ''}`;
  wrap.querySelector('[data-role="close-answers"]')
    ?.addEventListener('click', () => onDismiss?.());
  host.replaceChildren(wrap);
}

/**
 * Renders one row per question on the page.
 *
 * The answer is hidden behind a disclosure by default. Someone working through
 * an exercise usually wants to attempt it first, and a panel that reveals every
 * answer the moment it opens would remove that choice.
 */
export function renderAnswerMatches(host, matches, {
  page, aligned, onReveal, onDismiss, textQuality,
} = {}) {
  if (!host) return;

  // OPAQUE text compares correctly but decodes to nothing a reader recognises —
  // the CJK mapping is broken, so it renders as a stream of Bengali and Thai.
  // It is legitimate evidence for the MATCH and must never be shown as the
  // ANSWER; the reader is sent to the page instead.
  const displayable = textQuality !== 'OPAQUE';

  const header = `
    <div class="answer-head">
      <span>第 ${page} 页 · ${matches.length} 题</span>
      <span class="answer-head-end">
        <span class="answer-stage">${aligned ? '已按目录章节对齐' : '未使用目录对齐'}</span>
        ${closeButtonHtml('完成，收起答案')}
      </span>
    </div>`;

  const wrap = document.createElement('div');
  wrap.className = 'answer-panel';
  wrap.innerHTML = header;

  for (const match of matches) {
    // Prefer the rung when the engine supplies one; fall back to confidence for
    // any caller still on the older shape.
    const rungMeta = RUNG_META[match.rung];
    const meta = rungMeta || CONFIDENCE_META[match.confidence] || CONFIDENCE_META[CONFIDENCE.NONE];
    const cap = describeCap(match.cappedBy);
    const row = document.createElement('div');
    row.className = `answer-row ${meta.className}`;

    const label = match.question.label ? `第 ${escapeHtml(match.question.label)} 题` : '未编号';
    const preview = displayable
      ? escapeHtml(String(match.question.text || '').slice(0, 60))
      : '';

    // A capped result is not an ambiguous one. REVIEW and LOCATED both know
    // WHERE the answer is; only REFUSED and BLOCKED do not. Treating every
    // non-AUTO_MATCH as ambiguous hid answers the engine had already found.
    const located = !!match.entry;
    if (!located) {
      // Ambiguity is shown as ambiguity, with the alternatives listed so the
      // user can decide — the module must not pick one for them.
      // An entry indexed from the bookmark tree alone carries no text — that is
      // the normal case when the text layer was rejected — so the id and the
      // page have to identify the alternative on their own.
      const alts = (match.candidates || []).map((c) => {
        const body = displayable ? (c.answer || c.text) : '';
        const where = `第 ${escapeHtml(c.label)} 题 · 答案册第 ${escapeHtml(c.page)} 页`;
        return `<li>${where}${body ? `：${escapeHtml(body)}` : ''}</li>`;
      }).join('');
      row.innerHTML = `
        <div class="answer-q"><b>${label}</b> <span class="answer-conf ${meta.className}">${meta.label}</span></div>
        <div class="answer-qtext">${preview}</div>
        <div class="answer-reason">${escapeHtml(match.reason || '')}</div>
        ${alts ? `<ul class="answer-alts">${alts}</ul>` : ''}`;
      row.style.setProperty('--row-index', String(Math.min(wrap.children.length, 8)));
      wrap.appendChild(row);
      continue;
    }

    row.innerHTML = `
      <div class="answer-q">
        <b>${label}</b>
        <span class="answer-conf ${meta.className}">${meta.label}</span>
        <button type="button" class="answer-goto" data-role="goto">答案册第 ${escapeHtml(match.entry.page)} 页</button>
      </div>
      <div class="answer-qtext">${preview}</div>
      ${(rungMeta ? rungMeta.showAnswer : true)
        ? `<details class="answer-reveal">
        <summary>显示答案</summary>
        <div class="answer-value">${displayable && (match.entry.answer || match.entry.text)
          ? escapeHtml(match.entry.answer || match.entry.text)
          : `<span class="answer-empty">此书文本层无法显示，请翻到答案册第 ${escapeHtml(match.entry.page)} 页查看</span>`}</div>
      </details>`
        : `<div class="answer-located">答案在答案册第 ${escapeHtml(match.entry.page)} 页，但尚未确认，请自行核对</div>`}
      ${cap ? `<div class="answer-cap">${escapeHtml(cap)}</div>` : ''}
      <div class="answer-reason">${escapeHtml(match.reason || '')}</div>`;

    row.querySelector('[data-role="goto"]')?.addEventListener('click', () => onReveal?.(match));
    // The stagger is capped: past about eight rows a per-row delay stops
    // reading as choreography and starts reading as the list being slow.
    row.style.setProperty('--row-index', String(Math.min(wrap.children.length, 8)));
    wrap.appendChild(row);
  }

  wrap.querySelector('[data-role="close-answers"]')?.addEventListener('click', () => onDismiss?.());

  host.replaceChildren(wrap);
}
