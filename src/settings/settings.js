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

import { t, currentLang, setLang } from '../core/i18n.js';
import Logger from '../core/logger.js';
import { saveText } from '../export/save-file.js';

const SKIN_KEY = 'ls_skin';
const DEFAULT_SKIN = 'liquid-math';

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

  const applySkin = (name) => {
    document.documentElement.setAttribute('data-skin', name);
    if (skinSelect) skinSelect.value = name;
    try { localStorage.setItem(SKIN_KEY, name); } catch (_) { /* storage unavailable */ }
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
  devGroupTitle?.addEventListener('click', () => {
    if (!devOptions) return;
    const visible = devOptions.style.display !== 'none';
    devOptions.style.display = visible ? 'none' : 'block';
    devGroupTitle.textContent = visible ? '开发者选项 ▸' : '开发者选项 ▾';
  });

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
