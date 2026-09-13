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

  probeNativeProxy(Logger);
}

/**
 * 开机问一次原生层：你在不在，两个位置接上了没有。
 *
 * 这一层是**安静地**失效的。发布版里 R8 会给 `NativeProxy.onNativeEvent` 改名
 * （实测改成 `c`），于是 C++ 那侧按字符串找不到它，`JNI_OnLoad` 返回 JNI_ERR，
 * `System.loadLibrary` 抛 UnsatisfiedLinkError，整层消失——而类名反倒保住了
 * （`native <methods>` 那条规则顺带保的），看起来像「库装上了却不动」。
 * `proguard-rules.pro` 里那一大段讲的就是这件事。
 *
 * 在这之前，唯一能发现它的办法是连上 CDP 手动调 describe()。而发布版的 WebView
 * 默认不可调试——也就是说**唯一会发作的构建，恰好是唯一验不了的构建**。
 *
 * 现在它开机写一行进日志缓冲区，「设定 → 开发者选项 → 查看日志」在平板上直接
 * 看得到，不用连线。
 *
 * 不 await：这一层眼下没有任何调用方（`agent` 和 `ocr` 两个位置都还空着），让
 * 启动去等它没有道理。探测失败也只记一行——桥不在是浏览器里跑时的正常情形。
 */
function probeNativeProxy(Logger) {
  import('../native/native-proxy.js')
    .then(({ describeProxy }) => describeProxy())
    .then(({ loaded, services }) => {
      const slots = services
        .map((s) => `${s.name}=${s.ready ? 'ready' : s.reason || 'not ready'}`)
        .join('，');
      Logger.info('PROXY', loaded
        ? `原生层已加载${slots ? `（${slots}）` : ''}`
        : '原生层不在：浏览器里跑，或者库没能加载');
    })
    .catch((error) => Logger.warn('PROXY', `探测失败：${error?.message || error}`));
}

/** Removes the boot splash once the first surface is ready to be looked at. */
function hideSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.classList.add('is-gone');
  setTimeout(() => splash.remove(), 400);
}
