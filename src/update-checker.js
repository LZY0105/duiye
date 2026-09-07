// 版本检查：问一次 GitHub 的 Releases，有新版就把更新说明摆出来。
//
// 两件事和上一版不一样，都是被删掉的上游留下的：
//
//   1. 它问的是 strangelion/LaTeXSnipper_mobile —— 上游仓库。也就是说「检查更新」
//      一直在查别人的发布，对上号才怪。现在指向本项目自己的仓库。
//   2. 更新说明来自网络，却被直接塞进 innerHTML。中间那串 replace 只是把 Markdown
//      的井号和星号换成标签，对原文里本来就有的 <script> 或 onerror 属性不设防；
//      版本号和下载链接也一样没转义。现在整段说明按纯文本逐行建 DOM，标题和加粗
//      这类结构由 createElement 生成，网络来的字符串永远只作为 textContent 出现。
//
// 检查本身是「问一次就好」的性质，所以这里不做重试、不做退避：失败就当没有新版，
// 用户随时可以在设定里再按一次。

import { t } from './core/i18n.js';

const RELEASES_API = 'https://api.github.com/repos/LZY0105/duiye/releases/latest';

/** 自动检查的最小间隔：一天两次足够，再密就只是打扰。 */
const CHECK_INTERVAL = 12 * 60 * 60 * 1000;

const PREF_AUTO = 'latexsnipper-autoUpdate';
const PREF_LAST = 'latexsnipper-lastUpdateCheck';

let appVersion = null;

// ── 界面 ────────────────────────────────────────────────────────────────────

/** 一句话提示，带一个「知道了」。 */
function toast(text) {
  document.querySelector('.toast-popup')?.remove();

  const box = document.createElement('div');
  box.className = 'toast-popup';
  box.setAttribute('role', 'alertdialog');

  const p = document.createElement('p');
  p.textContent = text;

  const ok = document.createElement('button');
  ok.className = 'toast-close';
  ok.type = 'button';
  ok.textContent = t('common.ok');
  ok.addEventListener('click', () => box.remove());

  box.append(p, ok);
  box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  document.body.appendChild(box);
  ok.focus();
}

/**
 * 把 Markdown 形式的更新说明渲染成节点。
 *
 * 只认三种结构：标题、列表项、普通段落；行内只认加粗与行内代码。其余一律按纯文本
 * 处理。这不是一个完整的 Markdown 实现，也不该是——它要读的是一段不受本项目控制
 * 的远端文本，能少解释一点就少一分被利用的余地。
 */
function renderNotes(markdown) {
  const box = document.createElement('div');
  box.className = 'update-dialog-body';

  for (const line of String(markdown || '').split('\n')) {
    const text = line.trim();
    if (!text) continue;

    const heading = /^(#{1,4})\s+(.*)$/.exec(text);
    if (heading) {
      const h = document.createElement(`h${Math.min(4, heading[1].length + 1)}`);
      appendInline(h, heading[2]);
      box.appendChild(h);
      continue;
    }

    const item = /^[-*]\s+(.*)$/.exec(text);
    const p = document.createElement('p');
    if (item) {
      p.className = 'update-note-item';
      appendInline(p, item[1]);
    } else {
      appendInline(p, text);
    }
    box.appendChild(p);
  }
  return box;
}

/** 行内标记：**加粗** 与 `代码`，别的都是文本。 */
function appendInline(parent, text) {
  const pattern = /\*\*(.+?)\*\*|`(.+?)`/g;
  let at = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > at) parent.appendChild(document.createTextNode(text.slice(at, m.index)));
    const el = document.createElement(m[1] !== undefined ? 'strong' : 'code');
    el.textContent = m[1] !== undefined ? m[1] : m[2];
    parent.appendChild(el);
    at = pattern.lastIndex;
  }
  if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
}

/** 更新对话框。`url` 只会出现在 href 上，且限定为 https 的 GitHub 地址。 */
function showUpdateDialog({ version, url, body }) {
  document.querySelector('.update-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'update-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'update-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'update-dialog-header';
  const title = document.createElement('h3');
  title.textContent = t('update.available', { version });
  const close = document.createElement('button');
  close.className = 'update-dialog-close';
  close.type = 'button';
  close.setAttribute('aria-label', t('update.later'));
  close.textContent = '×';
  header.append(title, close);

  const footer = document.createElement('div');
  footer.className = 'update-dialog-footer';
  const later = document.createElement('button');
  later.className = 'ocr-btn secondary';
  later.type = 'button';
  later.textContent = t('update.later');
  footer.appendChild(later);

  // 只接受 https 的绝对地址，否则不给这个按钮——javascript: 之类的 URL 一旦落进
  // href 就是一次点击即执行。
  if (/^https:\/\//i.test(url || '')) {
    const go = document.createElement('a');
    go.className = 'ocr-btn';
    go.href = url;
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    go.textContent = t('update.download');
    footer.appendChild(go);
  }

  dialog.append(header, renderNotes(body), footer);
  overlay.appendChild(dialog);

  const dismiss = () => overlay.remove();
  close.addEventListener('click', dismiss);
  later.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape') return;
    document.removeEventListener('keydown', esc);
    dismiss();
  });

  document.body.appendChild(overlay);
  later.focus();
}

// ── 查询 ────────────────────────────────────────────────────────────────────

async function fetchLatest() {
  try {
    const resp = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const version = String(data.tag_name || '').replace(/^v/i, '').trim();
    if (!version) return null;
    return { version, url: data.html_url || '', body: data.body || '' };
  } catch (_) {
    return null;      // 离线、被墙、限流——都只说明「这次问不到」
  }
}

/**
 * 版本号比较，按点分段逐段比数值。
 *
 * 只比数字段：`1.3.1` 与 `1.3.1-beta` 在这里相等。预发布版本不该把正式用户拽去
 * 更新，而本项目也没有发过带后缀的版本。
 */
function isNewer(candidate, installed) {
  const a = String(candidate).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(installed).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

const read = (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch (_) { /* 无存储 */ } };

// ── 后台自动检查 ────────────────────────────────────────────────────────────

/**
 * 默认关闭，需要用户主动打开。
 *
 * 从前它在每次启动后自己跑，然后把整屏的更新日志盖在当时屏幕上的任何东西上面——
 * 盖在正在读的文档上，也盖在刚导入文件时那个「这份文件是？」的提问框上，于是那个
 * 问题就没法回答了。更新永远没有紧急到可以抢走用户手上的事。
 *
 * 设定里的「自动检查更新」仍然能把它打开，旁边的「检查更新」按一次查一次——那是
 * 用户在问，不是应用在插话。
 */
async function autoCheck() {
  if (read(PREF_AUTO) !== 'true') return;

  const last = parseInt(read(PREF_LAST), 10) || 0;
  if (Date.now() - last < CHECK_INTERVAL) return;

  const info = await fetchLatest();
  if (!info || !isNewer(info.version, appVersion)) return;

  write(PREF_LAST, String(Date.now()));
  showUpdateDialog(info);
}

/** 记下当前版本，并在启动 30 秒后安排一次后台检查（若用户开启了的话）。 */
export function initUpdateChecker(currentVersion) {
  appVersion = currentVersion;
  setTimeout(autoCheck, 30000);
}

/** 设定页那颗按钮：立刻查一次，无论结果如何都给个交代。 */
export async function checkForUpdateNow() {
  const info = await fetchLatest();
  write(PREF_LAST, String(Date.now()));

  if (!info) {
    toast(t('check.failed'));
    return { found: false, error: true };
  }
  if (!isNewer(info.version, appVersion)) {
    toast(t('update.upToDate'));
    return { found: false, current: appVersion };
  }
  showUpdateDialog(info);
  return { found: true, version: info.version, url: info.url };
}
