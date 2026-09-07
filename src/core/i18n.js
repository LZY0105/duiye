// 界面文案的多语言查表。
//
// 没有依赖，也不需要有：这里要解决的问题小得很——一层扁平的键值表，一个取值函数，
// 一个把 DOM 上带标记的节点批量替换掉的工具。键是扁平字符串（"pdf.library"、
// "update.later"），不是嵌套对象，因为嵌套只在词条上千时才划算，而代价是每次取值
// 都要拆路径。
//
// 语言包按需加载，一次只留一份在内存里。简体中文额外常驻一份作为兜底：任何一门
// 语言漏翻的键都会落回它，而不是把裸键显示给用户。这也意味着新增词条时不必等到
// 五种语言都补齐才能上线。

/** 支持的语言，以及它们各自的加载器。 */
const LANGUAGES = {
  'zh-CN': () => import('./lang/zh-CN.js'),
  'zh-TW': () => import('./lang/zh-TW.js'),
  en: () => import('./lang/en.js'),
  ja: () => import('./lang/ja.js'),
  ko: () => import('./lang/ko.js'),
};

const FALLBACK = 'zh-CN';
const STORE_KEY = 'latexsnipper-lang';

let current = FALLBACK;
let dict = {};
let base = {};                 // 兜底语言，始终是简体中文
const listeners = new Set();

/**
 * 猜一个起始语言。
 *
 * 用户选过就用他选的；没选过就看浏览器。中文要多分一步繁简：navigator.language
 * 可能是 zh、zh-CN、zh-TW、zh-Hant-HK 等等，只看前两位会把所有中文用户都送去简体。
 */
function detect() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && LANGUAGES[saved]) return saved;
  } catch (_) { /* 隐私模式：当作没选过 */ }

  const tag = (navigator.language || '').toLowerCase();
  if (tag.startsWith('zh')) {
    return /hant|hk|mo|tw/.test(tag) ? 'zh-TW' : 'zh-CN';
  }
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('en')) return 'en';
  return FALLBACK;
}

async function load(code) {
  const loader = LANGUAGES[code] || LANGUAGES[FALLBACK];
  try {
    const mod = await loader();
    return mod.default || mod;
  } catch (_) {
    return {};             // 语言包取不到就当它是空的，兜底表还在
  }
}

/** 读取起始语言并把词表准备好。要在任何 t() 之前完成。 */
export async function initI18n() {
  current = detect();
  base = await load(FALLBACK);
  dict = current === FALLBACK ? base : { ...base, ...(await load(current)) };
  return current;
}

/**
 * 取一条文案。
 *
 * 查不到就把键本身返回——这在界面上很难看，但那正是目的：漏翻的词条应该一眼可见，
 * 而不是悄悄显示成空白。
 *
 * @param {string} key 词条键
 * @param {Object} [vars] 用于替换 {{name}} 占位符的值
 */
export function t(key, vars) {
  const raw = typeof dict[key] === 'string' ? dict[key]
    : typeof base[key] === 'string' ? base[key]
      : null;
  if (raw === null) return key;
  if (!vars) return raw;
  return raw.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    (vars[name] === undefined || vars[name] === null ? whole : String(vars[name])));
}

export function currentLang() {
  return current;
}

/** 语言变了之后要重跑的回调——用于那些由 JS 写进 DOM、没有 data-i18n 标记的文字。 */
export function onLangChange(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 切换语言：换词表、重译页面、通知回调。 */
export async function setLang(code) {
  if (code === current || !LANGUAGES[code]) return;
  current = code;
  try { localStorage.setItem(STORE_KEY, code); } catch (_) { /* 记不住就只管这一次 */ }
  dict = code === FALLBACK ? base : { ...base, ...(await load(code)) };
  translateDOM();
  for (const fn of listeners) {
    try { fn(); } catch (_) { /* 一个回调出错不该拖垮其余的 */ }
  }
}

/**
 * 按标记翻译一棵 DOM 子树。
 *
 * 三种标记，分别对应三个去处：
 *   data-i18n              → 文本内容
 *   data-i18n-placeholder  → 输入框占位符
 *   data-i18n-title        → 悬停提示，同时写进 aria-label
 *
 * 文本的写入要小心。很多按钮里除了文字还有图标（<svg>）或输入框，整个 textContent
 * 一换就把它们抹掉了。所以带子元素时只改最后一个非空文本节点——那按惯例就是图标
 * 后面的那句话；找不到这样的节点才整体替换。
 */
export function translateDOM(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;

    // 明确声明要按 HTML 写入的，保留 <strong>、<kbd> 这类内联标记。
    if (el.hasAttribute('data-i18n-html')) {
      el.innerHTML = t(key);
      return;
    }

    if (el.children.length) {
      let last = null;
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) last = node;
      }
      if (last) { last.textContent = t(key); return; }
    }
    el.textContent = t(key);
  });

  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.placeholder = t(key);
  });

  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (!key) return;
    const text = t(key);
    el.title = text;
    // 触屏上没有悬停，title 永远不会显示；读屏软件读的是 aria-label。
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', text);
  });
}
