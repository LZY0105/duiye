// PDF 模块 —— 本机 PDF 的选择面板。
//
// 系统选择器的问题不是难看，是**要人自己去找**：一层层翻目录，而人记得的是「那本
// 谢惠民」，不是它在哪个文件夹。这张面板把问题倒过来——全机的 PDF 一次列出来，按
// 时间排好，想找就搜名字。
//
// 只列 PDF。这不是过滤出来的效果，是数据源本身就只有 PDF（MediaStore 按 MIME 查，
// 见 pdf-files.js）。所以「点进去只看得见 PDF」是结构上成立的，不是靠一个可以被绕
// 过的筛选条件。
//
// 面板不做导入，只回答「选了哪一份」。导入那一步（问角色、读字节、写库）还在
// pdf-workspace-ui.js 里，和系统选择器那条路共用——两条路在 readDevicePdf 之后就合
// 并了，往下只有一条，不会长出第二套导入逻辑。

import { t } from '../core/i18n.js';
import {
  FILES_ERRORS,
  hasFilesPermission,
  listDevicePdfs,
  requestFilesPermission,
} from './pdf-files.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** 「51.4M」这种。和书架上那个 formatBytes 同一个量级写法。 */
function formatSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'K', 'M', 'G'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, i);
  return `${value.toFixed(i === 0 || value >= 100 ? 0 : 1)}${units[i]}`;
}

/** 「2026/9/13」。用本地格式而不是 ISO：这一行是给人认的，不是给机器解析的。 */
function formatDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 打开面板，等人选一份。
 *
 * @returns {Promise<Object|null>} 选中的那一条（uri/name/size/…），取消则 null
 */
export function openDevicePdfPicker({ title } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'pdf-picker-overlay';
    overlay.innerHTML = `
      <div class="pdf-picker" role="dialog" aria-modal="true"
           aria-label="${escapeHtml(title || t('picker.title'))}">
        <div class="pdf-picker-head">
          <button type="button" class="pdf-picker-close" data-role="cancel"
                  aria-label="${escapeHtml(t('deck.cancel'))}">✕</button>
          <div class="pdf-picker-title">${escapeHtml(title || t('picker.title'))}</div>
          <button type="button" class="pdf-picker-confirm" data-role="confirm" disabled>
            ${escapeHtml(t('picker.confirm'))}
          </button>
        </div>
        <label class="pdf-picker-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.4" fill="none" stroke="currentColor" stroke-width="1.7"/>
            <path d="M15.8 15.8 20 20" fill="none" stroke="currentColor" stroke-width="1.7"
                  stroke-linecap="round"/>
          </svg>
          <input type="search" data-role="search" autocomplete="off"
                 placeholder="${escapeHtml(t('picker.search'))}">
        </label>
        <div class="pdf-picker-body" data-role="body"></div>
        <div class="pdf-picker-foot" data-role="foot"></div>
      </div>`;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVisible);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    document.addEventListener('keydown', onKey, true);

    const body = overlay.querySelector('[data-role="body"]');
    const foot = overlay.querySelector('[data-role="foot"]');
    const search = overlay.querySelector('[data-role="search"]');
    const confirm = overlay.querySelector('[data-role="confirm"]');
    const searchRow = overlay.querySelector('.pdf-picker-search');

    let all = [];
    let chosen = null;

    const syncConfirm = () => { confirm.disabled = !chosen; };

    /** 空的时候说清楚是「没有」还是「没权限」，那是两件不同的事。 */
    const showNotice = (message, action) => {
      searchRow.hidden = true;
      body.innerHTML = `<div class="pdf-picker-notice">${escapeHtml(message)}</div>`;
      foot.replaceChildren();
      if (!action) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pdf-picker-action';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      foot.appendChild(button);
    };

    const render = () => {
      const needle = search.value.trim().toLowerCase();
      const rows = needle
        ? all.filter(f => String(f.name || '').toLowerCase().includes(needle))
        : all;

      if (!rows.length) {
        body.innerHTML = `<div class="pdf-picker-notice">${
          escapeHtml(needle ? t('picker.noMatch') : t('picker.empty'))}</div>`;
        return;
      }

      const list = document.createElement('div');
      list.className = 'pdf-picker-list';
      list.setAttribute('role', 'listbox');
      for (const file of rows) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `pdf-picker-row${chosen?.uri === file.uri ? ' is-chosen' : ''}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(chosen?.uri === file.uri));
        row.innerHTML = `
          <span class="pdf-picker-tick" aria-hidden="true"></span>
          <span class="pdf-picker-name"></span>
          <span class="pdf-picker-meta">${escapeHtml(formatSize(file.size))}
            <span>${escapeHtml(formatDate(file.modified))}</span></span>`;
        // 文件名走 textContent，不进 innerHTML：它来自本机文件系统，是别处写的名字。
        row.querySelector('.pdf-picker-name').textContent = file.name || '';
        row.title = file.folder ? `${file.folder}${file.name}` : (file.name || '');
        row.addEventListener('click', () => {
          chosen = chosen?.uri === file.uri ? null : file;
          syncConfirm();
          render();
        });
        // 双击直接就是「选它并导入」——列表最常见的用法是找到那一本就走。
        row.addEventListener('dblclick', () => { chosen = file; finish(chosen); });
        list.appendChild(row);
      }
      body.replaceChildren(list);
      foot.replaceChildren();
      const count = document.createElement('span');
      count.className = 'pdf-picker-count';
      count.textContent = t('picker.count', { count: rows.length });
      foot.appendChild(count);
    };

    const load = async () => {
      body.innerHTML = `<div class="pdf-picker-notice">${escapeHtml(t('picker.loading'))}</div>`;
      try {
        all = await listDevicePdfs();
      } catch (error) {
        if (error?.message === FILES_ERRORS.NO_PERMISSION) { askPermission(); return; }
        showNotice(t('picker.failed'));
        return;
      }
      searchRow.hidden = false;
      render();
    };

    /**
     * 没有权限时这张面板说什么。
     *
     * 说的是「为什么要」而不是「请授权」：这个权限听起来很大（它确实很大），只说
     * 「需要权限」的话，人有理由拒绝，而且拒绝得对。
     *
     * 回来之后重新问一次——授权发生在系统设置里，这边收不到回调，只能在回到前台
     * 时自己再问。
     */
    const askPermission = () => {
      showNotice(t('picker.needPermission'), {
        label: t('picker.grant'),
        onClick: () => { requestFilesPermission().catch(() => { /* 没有那一页 */ }); },
      });
    };

    const onVisible = async () => {
      if (document.visibilityState !== 'visible' || settled) return;
      if (await hasFilesPermission()) load();
    };
    document.addEventListener('visibilitychange', onVisible);

    search.addEventListener('input', render);
    overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    confirm.addEventListener('click', () => { if (chosen) finish(chosen); });
    // 点面板以外的地方也算取消，和应用里其它那几张覆盖层一致。
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) finish(null); });

    document.body.appendChild(overlay);
    search.focus();

    hasFilesPermission().then((ok) => { if (ok) load(); else askPermission(); });
  });
}
