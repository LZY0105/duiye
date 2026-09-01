// bootstrap.js — Platform setup: PWA, Service Worker, tab navigation.
// Runs before any feature modules are loaded.

import { installCrashGuard } from './crash-guard.js';

export async function bootstrap() {
  // First, before anything else can fail: capture errors and unhandled
  // rejections into the native log, so a fault on a tablet is retrievable
  // through the existing log export instead of vanishing into a WebView
  // console nobody is attached to.
  installCrashGuard();

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // The app is light-only. There is no theme to initialise, no preference to
  // restore and no OS media query to follow: `data-theme` is never set, and
  // the stylesheets carry a single palette.

  // Tab navigation. 课本 is the landing surface now that 识别 is retired.
  setupTabs();
  document.getElementById('page-pdf')?.classList.add('active');

  // PWA install prompt
  setupInstallPrompt();
}

/**
 * Tab navigation across the three surfaces this version ships.
 *
 * 识别 (OCR) and 编辑器 are retired for now: their tabs are gone, their pages
 * carry `hidden` and `data-retired`, and app.js does not initialise them. The
 * markup and modules are still here rather than deleted, because the removal is
 * temporary — the full version, with both features working, is preserved on the
 * `feature/ocr-and-editor-preserved` branch.
 */
function setupTabs() {
  const tabs = document.querySelectorAll('.bottom-nav button');
  const pages = document.querySelectorAll('.page:not(.is-retired)');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const page = document.getElementById('page-' + tab.dataset.page);
      if (page && !page.classList.contains('is-retired')) page.classList.add('active');
    });
  });
}

function setupInstallPrompt() {
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('installBanner')?.classList.add('show');
  });
  document.getElementById('installBtn')?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    document.getElementById('installBanner')?.classList.remove('show');
  });
  document.getElementById('dismissInstall')?.addEventListener('click', () => {
    document.getElementById('installBanner')?.classList.remove('show');
  });
  if (window.matchMedia('(display-mode: standalone)').matches) {
    document.getElementById('installBanner')?.classList.remove('show');
  }
}
