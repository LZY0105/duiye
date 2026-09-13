// PDF 模块 —— 错误码。
//
// 单独一个文件，是因为主线程那条路（pdf-document.js）和 worker 那条路
// （pdf-worker-client.js）都要抛同样的错，而前者要 import 后者。放在任何一边都
// 会绕成循环依赖。调用方按这些字符串分支，两条路必须抛得一模一样。

export const PDF_ERRORS = Object.freeze({
  RUNTIME_MISSING: 'PDF_RUNTIME_MISSING',
  OPEN_FAILED: 'PDF_OPEN_FAILED',
  PAGE_OUT_OF_RANGE: 'PDF_PAGE_OUT_OF_RANGE',
});
