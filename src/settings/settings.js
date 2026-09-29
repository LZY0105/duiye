// Settings — appearance, language, updates, developer logs.
//
// What this file used to be: recognition engine presets, acceleration modes,
// OCR model management, AI provider registry, Pandoc download, ONNX threading.
// All of it belonged to features this build no longer ships, and it is
// preserved on `feature/with-ocr-preserved`.
//
// What is left is what the textbook workspace still needs: which skin to wear,
// which language to speak, whether to look for updates, and a way to get logs
// off the device when something goes wrong.

import { t, currentLang, onLangChange, setLang } from '../core/i18n.js';
import Logger from '../core/logger.js';
import { saveText } from '../export/save-file.js';

const SKIN_KEY = 'ls_skin';
const DEFAULT_SKIN = 'liquid-math';
/**
 * 三套，都共用一套尺寸和排法（liquid.css）。存盘的是左边的名字，挂到 html 上的是右边两样：
 *
 *   · liquid-math（液态玻璃）：data-skin="liquid-math" + data-glass="liquid"——照 liquid-glass-react
 *     挂的那几层（src/ui/liquid-glass-react.js、liquid-glass-react.css）只认 data-glass="liquid"；
 *   · frosted（毛玻璃）：data-skin="liquid-math"，不挂 data-glass——改写成液态玻璃之前的那一套：白色半透、
 *     磨砂、玻璃泡。人说「把以前玻璃风格也加回来，换个名字」。它和液态玻璃是同一个 data-skin，
 *     按 liquid-math 写的那几十条样式两套都吃，差的只是那几层；
 *   · minimal（纸）：data-skin="minimal"，只换材质（paper.css）。
 *
 * 存档里的 liquid-math 原来叫「玻璃」、那时已经是液态玻璃了，名字改了、样子不变。
 */
const SKINS = Object.freeze({
  'liquid-math': Object.freeze({ skin: 'liquid-math', glass: 'liquid' }),
  frosted: Object.freeze({ skin: 'liquid-math', glass: null }),
  minimal: Object.freeze({ skin: 'minimal', glass: null }),
});

export function initSettings() {
  initSkin();
  initLanguage();
  initDevTools();
  initUpdates();
  initAbout();
}

// ── the legal notice ────────────────────────────────────────────────────────

/**
 * Stamps the running version into the notice in Settings → 关于.
 *
 * The number is written into the bundle by vite from package.json, so the line
 * a user reads and the build they are holding cannot drift apart — which for a
 * notice about licence terms is the whole point of having it.
 */
function initAbout() {
  const el = document.getElementById('aboutVersion');
  if (!el) return;
  try {
    if (typeof __APP_VERSION__ === 'string') el.textContent = __APP_VERSION__;
  } catch (_) { /* not built by vite: leave the markup's fallback */ }
}

// ── appearance ──────────────────────────────────────────────────────────────

function initSkin() {
  const skinSelect = document.getElementById('setSkinSelect');

  /**
   * 换一套皮肤。
   *
   * 两套皮肤的尺寸和排法是同一套，按钮本来就不该挪；挪了的那几下都出在「换」的这一
   * 瞬间：有过渡的属性在两套皮肤之间滑一段，靠量尺寸摆位置的东西（两个标签的上下居
   * 中、透镜、顶上那一排的收字）要等到下一帧的观察器才重量——人看到的就是按钮先挪一
   * 下再回来。所以这一下：
   *   · 什么都不过渡（html.is-reskinning，base.css），颜色、圆角、影子直接换过去；
   *   · 换完当场发一声 skinchange，要量尺寸的那几处同步重量，不等下一帧；
   *   · 两帧之后放开过渡——一帧让新样式落地，一帧画出来。
   * 存档里不认识的名字（老版本的皮肤）按默认的来，不然下拉框是空的、页面没穿衣服。
   */
  const applySkin = (name) => {
    const choice = Object.hasOwn(SKINS, name) ? name : DEFAULT_SKIN;
    const { skin, glass } = SKINS[choice];
    const root = document.documentElement;
    if (root.getAttribute('data-skin') !== skin || root.getAttribute('data-glass') !== glass) {
      root.classList.add('is-reskinning');
      root.setAttribute('data-skin', skin);
      if (glass) root.setAttribute('data-glass', glass);
      else root.removeAttribute('data-glass');
      window.dispatchEvent(new Event('skinchange'));
      const settle = () => root.classList.remove('is-reskinning');
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(settle));
      } else {
        settle();
      }
    }
    if (skinSelect) skinSelect.value = choice;
    try { localStorage.setItem(SKIN_KEY, choice); } catch (_) { /* storage unavailable */ }
  };

  skinSelect?.addEventListener('change', () => applySkin(skinSelect.value));

  try {
    applySkin(localStorage.getItem(SKIN_KEY) || DEFAULT_SKIN);
  } catch (_) {
    applySkin(DEFAULT_SKIN);
  }
}

function initLanguage() {
  const langSelect = document.getElementById('setLangSelect');
  if (!langSelect) return;
  langSelect.value = currentLang();
  langSelect.addEventListener('change', async () => { await setLang(langSelect.value); });
}

// ── developer logs ──────────────────────────────────────────────────────────

function initDevTools() {
  const devOptions = document.getElementById('devOptions');
  const devGroupTitle = document.getElementById('devGroupTitle');

  // 标签走词表，箭头是状态不是文字。两者由同一个地方写，否则换语言时
  // translateDOM 会把整行文本换掉，箭头就没了——它只认词条，不知道后面那个符号
  // 还有意思。
  const paintDevTitle = () => {
    if (!devGroupTitle) return;
    const open = devOptions && devOptions.style.display !== 'none';
    devGroupTitle.textContent = `${t('settings.devOptions')} ${open ? '▾' : '▸'}`;
  };

  devGroupTitle?.addEventListener('click', () => {
    if (!devOptions) return;
    devOptions.style.display = devOptions.style.display !== 'none' ? 'none' : 'block';
    paintDevTitle();
  });
  paintDevTitle();
  onLangChange(paintDevTitle);

  const devMode = document.getElementById('setDevMode');
  const devContent = document.getElementById('devOptionsContent');
  const syncDevMode = () => {
    if (devContent) devContent.style.display = devMode?.checked ? 'block' : 'none';
  };
  devMode?.addEventListener('change', () => {
    try { localStorage.setItem('ls_dev', devMode.checked ? '1' : '0'); } catch (_) {}
    syncDevMode();
  });
  try { if (devMode) devMode.checked = localStorage.getItem('ls_dev') === '1'; } catch (_) {}
  syncDevMode();

  const output = document.getElementById('devLogOutput');

  document.getElementById('devShowLogs')?.addEventListener('click', () => {
    if (!output) return;
    output.style.display = output.style.display === 'none' ? 'block' : 'none';
    if (output.style.display === 'block') output.textContent = Logger.getLastLines(500).join('\n');
  });

  document.getElementById('devClearLogs')?.addEventListener('click', () => {
    Logger.clear?.();
    if (output) output.textContent = '';
  });

  document.getElementById('devExportLogs')?.addEventListener('click', async () => {
    const text = Logger.getLastLines(2000).join('\n');
    try {
      saveText(text, 'duiye-log.txt', t('toast.savedToDownload'));
    } catch (error) {
      Logger.error('SETTINGS', 'log export failed', error);
    }
  });
}

// ── updates ─────────────────────────────────────────────────────────────────

function initUpdates() {
  const autoUpdate = document.getElementById('setAutoUpdate');
  try {
    // Off unless it was turned on. The switch reads the same rule the checker
    // does, so what it shows is what will happen.
    if (autoUpdate) autoUpdate.checked = localStorage.getItem('latexsnipper-autoUpdate') === 'true';
  } catch (_) { /* storage unavailable */ }
  autoUpdate?.addEventListener('change', () => {
    try {
      localStorage.setItem('latexsnipper-autoUpdate', autoUpdate.checked ? 'true' : 'false');
    } catch (_) { /* storage unavailable */ }
  });

  import('../update-checker.js').then(({ initUpdateChecker, checkForUpdateNow }) => {
    const appVersion = document.querySelector('meta[name="version"]')
      ?.getAttribute('content') || '1.0.0';
    initUpdateChecker(appVersion);

    const btn = document.getElementById('checkUpdateBtn');
    btn?.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = t('update.checking');
      await checkForUpdateNow();
      btn.disabled = false;
      btn.textContent = t('update.checkUpdate');
    });
  }).catch(() => { /* update checking is optional */ });
}
