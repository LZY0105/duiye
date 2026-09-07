// 把一段数据交给用户保存成文件。
//
// 这个模块从前叫 share.js，导出分享文本、分享文件、保存文件与提示条四组能力，
// 走的是「Capacitor Share → Web Share → 剪贴板」和「原生 saveFile 桥 → 下载链接」
// 两条降级链。现在只剩下保存这一件事：
//
//   - 分享文本没有调用方。应用里唯一会被导出的东西是诊断日志，那是要落成文件的。
//   - 原生 saveFile 桥（window.NativeOcr）随识别栈一起删掉了，MainActivity 里
//     还留着说明。降级链的第一级永远不成立，剩下的就是浏览器自己的下载。
//
// 所以这里不再假装有多条路径。一条路径，写清楚它的限制。

/**
 * 在屏幕底部提示一次，几秒后自行退场。
 *
 * 保存动作本身没有可见结果——文件落在下载目录里，用户当时看不到——所以这句提示
 * 是「刚才那一下确实做成了」的唯一证据。
 */
export function showSaveToast(message) {
  document.querySelector('.save-toast')?.remove();

  const el = document.createElement('div');
  el.className = 'save-toast';
  el.textContent = message;
  el.setAttribute('role', 'status');       // 读屏软件会读出来，且不打断当前朗读
  document.body.appendChild(el);

  requestAnimationFrame(() => el.classList.add('save-toast-show'));

  setTimeout(() => {
    el.classList.add('save-toast-hide');
    // 动画结束就移除；同时留一个兜底定时器，因为元素若在过渡期间被隐藏
    // （切到别的标签页、prefers-reduced-motion 把时长压到 0），
    // transitionend 可能根本不会来。
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600);
  }, 3000);
}

/**
 * 保存一个 Blob。
 *
 * 用一个临时的 <a download> 触发浏览器自己的下载流程。在 Capacitor 的 WebView 里
 * 这会交给系统下载管理器，文件落到下载目录。
 *
 * object URL 必须显式释放，否则整个 Blob 会一直留在内存里直到页面关闭；但也不能
 * 立刻释放——下载是异步开始的，撤销得太早会让它拿到一个已经失效的地址。延后几秒
 * 是这两者之间唯一稳妥的做法。
 *
 * @param {Blob} blob 要保存的内容
 * @param {string} filename 建议的文件名，浏览器可能会改写其中的非法字符
 */
export function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * 保存一段文本，并提示已保存。
 *
 * 应用里所有导出都是文本（诊断日志），所以这是实际会被调用的那一个。
 */
export function saveText(text, filename, toast) {
  saveFile(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
  if (toast) showSaveToast(toast);
}
