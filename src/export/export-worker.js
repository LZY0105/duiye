// 导出 —— 在后台线程里把 PDF 做出来。
//
// 一本几十上百兆的书，pdf-lib 要把整份文件读一遍（扫描版的书里，很多流的长度写在别处，
// 它得一个字节一个字节地找每一段在哪儿结束）、接上笔迹、再整份写回去。这些原来在主线程
// 上做：每做一百个对象才让一下，一下就是几百毫秒——平板上是「点了导出，整个软件卡住好几秒，
// 直到开始存文件才缓过来」。挪到这里以后，主线程只管读原文件、收笔迹、存结果，界面一直能动。
//
// 跑的就是 pdf-export.js 里那几个 build*，一个字都不改：它们本来就不碰 DOM。笔记本的笔迹由
// 主线程先按页收齐（函数传不过来），这里再按页递给 buildNotebookPdf。

import { buildBookPdf, buildNotebookPdf, buildScratchPdf } from './pdf-export.js';

const JOBS = {
  book: (input, onProgress) => buildBookPdf({ ...input, onProgress }),
  notebook: (input, onProgress) => buildNotebookPdf({
    ...input,
    strokesFor: async (n) => input.strokesByPage?.[n] || [],
    onProgress,
  }),
  scratch: (input) => buildScratchPdf(input),
};

self.onmessage = async (event) => {
  const { id, job, input } = event.data || {};
  const run = JOBS[job];
  if (!run) {
    self.postMessage({ id, error: 'EXPORT_UNKNOWN_JOB' });
    return;
  }
  try {
    const bytes = await run(input || {}, (done, total) => self.postMessage({ id, progress: { done, total } }));
    // 做好的那一份整块交回去，不复制：几十兆的东西复制一遍，主线程又要等一下。
    self.postMessage({ id, bytes }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
