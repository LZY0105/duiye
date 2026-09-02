// app.js — Module initialization and event wiring.
//
// Runs after bootstrap(). This build is a handwriting note-taking app for
// textbooks: open one or two PDFs side by side, annotate them with a stylus,
// and look up the matching answer for the question on the page.
//
// Recognition is gone. There is no OCR pipeline, no model manager, no formula
// editor, no AI provider and no result history — those belonged to the app this
// one was streamlined out of, and they are preserved in full on the
// `feature/with-ocr-preserved` branch. What remains is the textbook workspace
// and the settings that surface still needs.
//
// Answer matching does NOT depend on any of that: it resolves questions from
// the PDF bookmark tree, and only falls back to text similarity when ids do not
// line up. It was measured at 508/508 with zero wrong answers with no
// recognizer present at all.

import { initI18n, translateDOM, onLangChange } from './i18n.js';
import { initSettings } from '../settings/settings.js';
import { initCustomSelects, syncCustomSelects } from '../ui/custom-select.js';
import { initPdfWorkspace } from '../pdf/pdf-workspace-ui.js';
import { initLiquidGlass } from '../ui/liquid-glass.js';

export async function createApp() {
  // Nothing to assemble ahead of time any more: the workspace owns its own DOM
  // and the settings page binds itself. Kept as the documented entry point so
  // main.js reads the same as it always did.
  return {};
}

export async function start() {
  const { default: Logger } = await import('./logger.js');
  Logger.logSystemInfo();

  await initI18n();
  translateDOM();

  initCustomSelects();
  initSettings();

  // Restores the previous session; failures must not stop app start, so the
  // workspace reports its own errors and never rejects into here.
  initPdfWorkspace().catch(() => {});

  syncCustomSelects();
  onLangChange(() => syncCustomSelects());

  hideSplash();
  // The background is started by bootstrap's tab wiring, which knows which
  // surface is showing; starting it here too would run it on 课本, where it is
  // painted entirely behind an opaque workspace.
  initLiquidGlass();
}

/** Removes the boot splash once the first surface is ready to be looked at. */
function hideSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.classList.add('is-gone');
  setTimeout(() => splash.remove(), 400);
}
