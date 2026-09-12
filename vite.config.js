import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  plugins: [
    {
      // 版本号只有一个来源：package.json。
      //
      // 「关于」里那行版本、以及更新检查拿去和 GitHub Releases 比对的那个值，都从
      // 这里来。写死在 HTML 里的那种迟早和实际构建对不上，而一条说错了版本的版权
      // 声明比没有更糟。
      name: 'inject-version',
      transformIndexHtml(html) {
        return html.replace(
          /<meta name="version" content=".*?">/,
          `<meta name="version" content="${pkg.version}">`,
        );
      },
    },
  ],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },

  server: {
    port: 5174,
  },
});
