// 构建时把这一版的文件清单写进 dist/sw.js。
//
// sw.js 在 public/ 下，Vite 原样复制，构建之间一个字不变。浏览器比对 sw.js 的字节
// 决定要不要装新的 SW：字节不变就不装，activate 也就不跑，旧版本的 /assets/ 在缓存
// 里只进不出。平板上量过，duiye-v1 里 /assets/ 有 147 条、39.3 MiB。
//
// 这里把 dist/assets/ 下的每一个文件写进 sw.js 的 BUILD_ASSETS，activate 照着它删掉
// 不属于这一版的（public/sw.js 里的 forgetOldBuilds）。为什么是全部文件、而不是一个
// 构建号加上 index.html 点名的那几个，见 public/sw.js 里 BUILD_ASSETS 的注释。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** public/sw.js 里留给清单的那一行，构建时整行换掉。 */
const PLACEHOLDER = 'const BUILD_ASSETS = null;';

/**
 * 把清单写进 sw.js 的源码，回写好的源码。
 *
 * 清单先排序：bundle 里文件的先后不该算进「这一版是什么」。同样一批文件换个顺序
 * sw.js 就变的话，浏览器会白白重装一次 SW。
 *
 * 找不到那一行、或者清单是空的，就让构建失败。两种都是改了一边忘了另一边（sw.js 里
 * 那一行换了写法，或者 assetsDir 不叫 assets 了）。这时候默默出一个不清理的 sw.js，
 * 缓存就又回到只进不出 —— 而且没有任何地方会报错。
 */
export function injectBuildAssets(source, files) {
  if (source.split(PLACEHOLDER).length !== 2) {
    throw new Error(`sw.js 里要有且只有一行「${PLACEHOLDER}」，构建时把这一版的文件清单写在那里`);
  }
  if (files.length === 0) {
    throw new Error('这次构建一个 assets/ 下的文件都没有，sw.js 没法知道缓存里哪些是这一版的');
  }
  const list = JSON.stringify([...files].sort(), null, 2);
  return source.replace(PLACEHOLDER, () => `const BUILD_ASSETS = ${list};`);
}

/**
 * Vite 插件：dist/ 写完之后，用 public/sw.js 和这次的产物重写 dist/sw.js。
 *
 * 在 writeBundle 里做：到这一步 bundle 才齐（worker 和 CSS 里引用的字体都在里面），
 * public/ 也早已复制过去。读的是 public/ 那份，不是 dist/ 里复制过去的：
 * vite build --watch 第二次起不再复制 public/，那时 dist/sw.js 里已经是上一次写好的了。
 */
export function swBuildAssets() {
  let publicDir;
  return {
    name: 'sw-build-assets',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    writeBundle({ dir }, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => name.startsWith('assets/'))
        .map((name) => `/${name}`);
      const source = readFileSync(resolve(publicDir, 'sw.js'), 'utf8');
      writeFileSync(resolve(dir, 'sw.js'), injectBuildAssets(source, files));
    },
  };
}
