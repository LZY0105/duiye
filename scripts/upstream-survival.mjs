#!/usr/bin/env node
// 量一量：这个仓库里还有多少行逐字来自上游。
//
// 为什么要有这么一个脚本，而不是量一次记个数：因为这个数字是要拿去做判断的
// （还能不能换许可证、脱钩到哪一步了），而一个记在文档里的数字会过期，一个能
// 重跑的脚本不会。任何人都可以自己跑一遍，不必相信文档。
//
//   npm run check:upstream                  对 upstream/main
//   node scripts/upstream-survival.mjs 8c70c28   对分叉点
//
// 前提：本仓库有一个 upstream 远端指向 github.com/strangelion/LaTeXSnipper_mobile
// 并且 fetch 过。没有的话：
//   git remote add upstream https://github.com/strangelion/LaTeXSnipper_mobile.git
//   git remote set-url --push upstream no-push-to-upstream   # 防手滑
//   git fetch upstream

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REF = process.argv[2] || 'upstream/main';

// ── 判定口径 ────────────────────────────────────────────────────────────────
//
// 「这一行还是上游的」＝ 去掉首尾空白之后，这一行在**同一个文件**的上游版本里
// 原样出现过。
//
// 不用 git blame：blame 回答的是「谁最后碰过这一行」，改个缩进就算你的了。
// 著作权关心的是原文还在不在，不是谁最后碰过。
//
// 不用 LCS（最长公共子序列）：LCS 会考虑顺序，得出的数比这里小。这里故意用
// 更宽松的「出现过就算」——往多了报，不往少了报。一份用来说明「剩得很少」的
// 材料，宁可把自己说得更不利一点。
const isUpstreamLine = (line, upstreamSet) => {
  const t = line.trim();
  return t.length > 0 && upstreamSet.has(t);
};

// ── 不算数的三类 ────────────────────────────────────────────────────────────

// 1. 第三方原样打包进来的，和构建产物
const SKIP_PREFIX = ['public/vendor/', 'dist/', 'node_modules/', 'android/app/build/', 'android/gradle/'];
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|bcmap|jar|zip|pdf|so|wasm|svg)$/i;

// 2. 许可证原文。必须留着——删掉它才是侵权。
const LICENCE = new Set(['LICENSE']);

// 3. 工具生成的。跑一遍对应的命令就会原样重新出现，上游对它们没有著作权可主张。
//    Gradle wrapper 由 `gradle wrapper` 生成，lockfile 由 `npm install` 生成，
//    android/ 那一套由 `npx cap add android` 从 Capacitor 自带的模板解出来。
const GENERATED = new Set([
  'package-lock.json',
  'android/gradlew', 'android/gradlew.bat',
  'android/gradle/wrapper/gradle-wrapper.properties',
]);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const gitOrEmpty = (...args) => { try { return git(...args); } catch { return ''; } };

// ── Capacitor 模板：解出来当第三方 ──────────────────────────────────────────
//
// 这一步是这个脚本里最要紧的一段。没有它，android/ 下那一整套 gradle 和 manifest
// 会被算成上游的——上游跑过 cap add android，我们也跑过，两边当然逐字相同。
// 把模板解出来逐行比对之后，那 180 来行里有 145 行属于模板。
function capacitorTemplateLines() {
  const tarball = 'node_modules/@capacitor/cli/assets/android-template.tar.gz';
  if (!existsSync(tarball)) {
    console.warn('！找不到 Capacitor 的 Android 模板（先 npm install）。');
    console.warn('  没有它，android/ 下的模板代码会被错算成上游的。\n');
    return new Set();
  }
  const dir = mkdtempSync(join(tmpdir(), 'captpl-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', dir]);
    const lines = new Set();
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (BINARY.test(name)) continue;
        try {
          for (const l of readFileSync(p, 'utf8').split('\n')) {
            const t = l.trim();
            if (t) lines.add(t);
          }
        } catch { /* 二进制或读不动的，跳过 */ }
      }
    };
    walk(dir);
    return lines;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 剩下的那些，还能不能改 ──────────────────────────────────────────────────
//
// 分档的意义在于：净室重写的目标是零**受保护的表达**，不是字面的零。把 `}` 和
// `"设置"` 也追到零，代码和界面都会变差，而法律上什么都没改变。
//
// 前五档是形式由语言、框架或既有结构定死的，改它们是换皮。第六档「其余」才是
// 需要人一行一行看的——而正则判不了「这算不算表达」，所以那一档只负责把范围缩
// 到能人工过一遍的大小，不负责下结论。

// 纯标点：一行只有括号、闭合标签、语言强制的开头
const SKELETON = /^\s*(\}|\{|\)|\);|\],?|\[|,|<\/\w+>|<\w+\s*\/?>|\*\/|\/\*|-->|<!--|\}\);?|\)\);?|'use strict';|export default \{|<!DOCTYPE.*)\s*$/i;

// 短语：一条 i18n 词条、一条注释分隔线。单词和短语不构成受保护的表达。
const PHRASE = /^\s*("[\w.]+"\s*:\s*".{0,14}",?|\/\/\s*[─\-=]{3,}.*|\/\*\s*[─\-=]{3,}.*)\s*$/;

// 名字：CSS 选择器行。类名由 HTML 结构定下来，改它要连着 HTML 和 JS 一起改，
// 而类名是短语——换一遍是纯粹的换皮。
const SELECTOR = /^\s*[.#:*\[]?[\w-]*[\w\-.#:>+~*\[\]="'()\s,]*\{\s*$/;

// 形式由语言定死的：CSS 声明（`属性: 值;`）、JSON/YAML 的键值对
const DECLARATION = /^\s*(-{0,2}[\w-]+\s*:\s*[^{}]+;?\s*\}?|"[^"]+"\s*:\s*.+,?)\s*$/;

// API 表面：import、公开函数签名、Actions 的固定字段。都只有一种写法。
const API_SURFACE = /^\s*(import\s|export\s+(async\s+)?(function|const|class)\s|export\s*\{|-\s*uses:\s|uses:\s|runs-on:\s|@media\s|@keyframes\s|@supports\s)/;

function bucketOf(line) {
  if (SKELETON.test(line)) return 'skeleton';
  if (PHRASE.test(line)) return 'phrase';
  if (API_SURFACE.test(line)) return 'api';
  if (SELECTOR.test(line)) return 'selector';
  if (DECLARATION.test(line)) return 'declaration';
  return 'prose';
}

// ── 走一遍 ──────────────────────────────────────────────────────────────────

const tplLines = capacitorTemplateLines();
const upFiles = new Set(gitOrEmpty('ls-tree', '-r', '--name-only', REF).split('\n').filter(Boolean));
if (!upFiles.size) {
  console.error(`取不到 ${REF} 的文件列表。先 git fetch upstream。`);
  process.exit(2);
}
const ours = git('ls-files').split('\n').filter(Boolean);

const totals = { skeleton: 0, phrase: 0, api: 0, selector: 0, declaration: 0, prose: 0 };
const perFile = [];
let licence = 0, generated = 0, template = 0, handwritten = 0;

for (const f of ours) {
  if (SKIP_PREFIX.some((p) => f.startsWith(p)) || BINARY.test(f)) continue;
  let cur;
  try { cur = readFileSync(f, 'utf8').split('\n'); } catch { continue; }
  const live = cur.filter((l) => l.trim()).length;

  if (!GENERATED.has(f) && !LICENCE.has(f)) handwritten += live;
  if (!upFiles.has(f)) continue;

  if (LICENCE.has(f)) { licence += live; continue; }
  if (GENERATED.has(f)) { generated += live; continue; }

  const upstream = new Set(
    gitOrEmpty('show', `${REF}:${f}`).split('\n').map((l) => l.trim()).filter(Boolean),
  );
  if (!upstream.size) continue;

  const counts = { skeleton: 0, phrase: 0, api: 0, selector: 0, declaration: 0, prose: 0 };
  let tpl = 0, kept = 0;
  for (const line of cur) {
    if (!isUpstreamLine(line, upstream)) continue;
    if (tplLines.has(line.trim())) { tpl++; continue; }   // Capacitor 模板，不算上游的
    kept++;
    counts[bucketOf(line)]++;
  }
  template += tpl;
  if (!kept) continue;
  for (const k of Object.keys(totals)) totals[k] += counts[k];
  perFile.push({ f, kept, live, ...counts });
}

perFile.sort((a, b) => b.prose - a.prose || b.kept - a.kept);
const total = Object.values(totals).reduce((a, b) => a + b, 0);

const pad = (s, n) => String(s).padStart(n);
console.log(`对照 ${REF}（${gitOrEmpty('log', '-1', '--format=%h %s', REF).trim()}）\n`);
console.log('不计入的三类：');
console.log(`   许可证原文          ${pad(licence, 6)} 行   必须留着，删掉才是侵权`);
console.log(`   工具生成的          ${pad(generated, 6)} 行   lockfile、Gradle wrapper`);
console.log(`   Capacitor 模板      ${pad(template, 6)} 行   cap add android 解出来的`);
console.log(`\n仍逐字来自上游：${total} 行（占手写代码 ${handwritten} 行的 ${(100 * total / handwritten).toFixed(1)}%）\n`);
console.log(`   语言骨架            ${pad(totals.skeleton, 6)} 行   }、export default {、</div>`);
console.log(`   短语与词条          ${pad(totals.phrase, 6)} 行   "nav.settings": "设置"`);
console.log(`   API 表面            ${pad(totals.api, 6)} 行   import 语句、@media、uses:`);
console.log(`   选择器（类名）      ${pad(totals.selector, 6)} 行   .bottom-nav {、.splash {`);
console.log(`   声明（属性: 值）    ${pad(totals.declaration, 6)} 行   position: fixed;、"name": "duiye"`);
console.log(`   其余                ${pad(totals.prose, 6)} 行   ← 只有这一档需要人来判断`);

console.log(`\n按「其余」排序的前 15 个文件：`);
for (const r of perFile.slice(0, 15)) {
  console.log(`   ${pad(r.prose, 5)} / ${pad(r.kept, 4)} 行（本文件共 ${r.live}）  ${r.f}`);
}
