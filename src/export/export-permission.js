// 导出 —— 文件权限。
//
// 导出要把 PDF 写进公共的「文档/对页」，用的是本应用本来就有的那个「所有文件访问
// 权限」（导入时列出本机的 PDF 也靠它）。这个权限没有应用内的系统弹窗，Android 只
// 许把人送到系统设置里那一页（见 PdfFilesPlugin.java），授权发生在别的应用里，这边
// 收不到回调，只能在人回来时再看一眼给没给。
//
// 这里管三件事：
//
//   1. 第一次进应用，先问一次（introduceFilesPermission）。说清楚要它做什么、不给会
//      怎样：不给也能正常用，只是导出用不了、导入改用系统的文件选择器。只问这一次，
//      之后不在开机时拦人。
//   2. 点「导出」时还没有：再问一次（ensureExportPermission），这次说的是导出这件事。
//      人去设置里开了、回来，导出**接着往下走**，不用再点一遍。
//   3. 人不给：明明白白告诉他，这个功能要文件权限才能用；别的功能不受影响。

import { t } from '../core/i18n.js';
import { chooseAction } from '../pdf/deck-dialogs.js';
import {
  hasFilesPermission,
  nativeFilesAvailable,
  requestFilesPermission,
} from '../pdf/pdf-files.js';

/** 开机那一问问过没有。问过一次就不再问——不管人当时给没给。 */
export const INTRO_KEY = 'ls_files_permission_intro';

/** 等人从设置回来时，隔多久自己看一眼：分屏、小窗打开设置时应用不会退到后台。 */
const POLL_MS = 1200;

/**
 * 等人从系统设置回来，或者等权限自己出现——哪个先到算哪个。
 *
 * 平常是前者：设置那一页盖住应用，回来时 visibilitychange 一响就再问一次。但设置也
 * 可能是在分屏、小窗里开的，那时这个应用从头到尾都「看得见」，visibilitychange 不会
 * 响；所以同时隔一会儿问一次，一给就走。
 */
function returnFromSettings() {
  return new Promise((resolve) => {
    let left = false;
    let timer = 0;
    const finish = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
      resolve();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { left = true; return; }
      if (left) finish();
    };
    // 分屏、小窗：应用一直看得见，但人去点设置那一边时这个窗口会失去焦点，点回来
    // 时再拿回焦点——那就是「回来了」。没有这一条，人在设置里没开就点回来，这里会
    // 一直等下去，而导出那把锁也就一直不放。
    const onBlur = () => { left = true; };
    const onFocus = () => { if (left) finish(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    timer = setInterval(() => {
      hasFilesPermission().then((ok) => { if (ok) finish(); }, () => {});
    }, POLL_MS);
  });
}

function markIntroduced() {
  try { localStorage.setItem(INTRO_KEY, '1'); } catch (_) { /* 无痕模式：大不了下次再问一次 */ }
}

function introduced() {
  try { return localStorage.getItem(INTRO_KEY) === '1'; } catch (_) { return false; }
}

/**
 * 第一次进应用时问一次。
 *
 * 先记下「问过了」再问：人要是在这张单子上直接把应用划掉，下次开机也不该再被它拦
 * 一回。已经有权限的、在浏览器里跑的，什么都不问。
 *
 * @param {{notify?: function(string)}} [options] 问完之后怎么告诉人结果
 * @returns {Promise<boolean>} 真的问了
 */
export async function introduceFilesPermission({ notify } = {}) {
  if (!nativeFilesAvailable() || introduced()) return false;
  if (await hasFilesPermission()) { markIntroduced(); return false; }
  markIntroduced();

  const answer = await chooseAction({
    title: t('permission.introTitle'),
    note: t('permission.introNote'),
    actions: [{ id: 'grant', label: t('permission.grant') }],
    cancelLabel: t('permission.later'),
  });
  if (answer !== 'grant') {
    notify?.(t('permission.skipped'));
    return true;
  }
  try {
    await requestFilesPermission();
  } catch (_) {
    notify?.(t('export.noSettingsPage'));
    return true;
  }
  await returnFromSettings();
  notify?.(await hasFilesPermission() ? t('permission.granted') : t('permission.skipped'));
  return true;
}

let asking = null;

async function askForExport({ notify, onWaiting } = {}) {
  // 浏览器里（开发、测试）没有原生层：导出走浏览器自己的下载，不需要这个权限。
  if (!nativeFilesAvailable()) return true;
  if (await hasFilesPermission()) return true;

  const answer = await chooseAction({
    title: t('export.permissionTitle'),
    note: t('export.permissionNote'),
    actions: [{ id: 'grant', label: t('permission.grant') }],
  });
  if (answer !== 'grant') {
    notify?.(t('export.needsPermission'));
    return false;
  }
  try {
    await requestFilesPermission();
  } catch (_) {
    // 有的定制系统没有那一页，也没有总列表。没处可去就别装作有。
    notify?.(t('export.noSettingsPage'));
    return false;
  }
  onWaiting?.();
  await returnFromSettings();
  if (await hasFilesPermission()) return true;
  notify?.(t('export.needsPermission'));
  return false;
}

/**
 * 导出之前：有权限就直接放行，没有就再问一次。
 *
 * 同一时刻只问一次：问的过程里人会离开应用，这期间再点一次导出不该叠出第二张单子。
 *
 * @param {{notify?: function(string), onWaiting?: function()}} [options]
 *   `notify` 用来说「没给，所以导不了」；`onWaiting` 在跳去设置那一刻调一次，用来
 *   提示「开了回来就接着导出」
 * @returns {Promise<boolean>} 可以写文件了
 */
export function ensureExportPermission(options = {}) {
  if (asking) return asking;
  asking = askForExport(options).finally(() => { asking = null; });
  return asking;
}
