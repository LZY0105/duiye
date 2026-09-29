#!/usr/bin/env node
// 检查每一个会被打进 APK 的依赖，许可证是否与本项目的 MIT 相容。
//
// 方向和 AGPL 时代**反过来**了，这一点值得写清楚，否则下一个人会照着旧的直觉
// 改错：
//
//   AGPL 时代  本作品条款更严，宽松许可的东西都能并进来，要挡的是「比 AGPL
//              还严或条款冲突」的那几个（GPL-2.0-only、SSPL、BUSL）。
//   MIT 时代   本作品条款最宽松，于是**copyleft 的东西一个都不能并进来**。
//              混进一个 GPL/AGPL 依赖，整份作品就必须以 GPL/AGPL 发布，而
//              LICENSE 写的是 MIT —— 那是一份没有履行的许可，分发行为失去依据。
//
// 这种错误极难在别处被发现：它不会让构建失败，不会让测试变红，装出来的包跑得
// 好好的。
//
// 只看**会分发的**那些。devDependencies（vite、jsdom、sharp……）在构建机上跑完
// 就没事了，它们不进 APK，许可证怎么写都不影响分发。把它们一起算进来，只会在
// 每次有人加个构建工具时制造假警报，然后这个检查就会被人加上 `|| true`。
//
// 用法：
//   node scripts/check-licenses.mjs          有不相容的就退出码 1
//   node scripts/check-licenses.mjs --all    连 devDependencies 一起列出来看

import fs from 'node:fs';
import path from 'node:path';

// 可以并入 MIT 作品的许可证。
//
// 判断标准：这些许可证不要求「衍生作品必须以同样条款发布」。宽松许可
// （MIT/BSD/ISC/Apache-2.0）当然可以；公有领域式的（0BSD、Unlicense、CC0）
// 可以；MPL-2.0 是**按文件**的弱 copyleft —— 它只要求被修改的那些文件保持
// MPL，不传染到整份作品，所以作为不加修改的依赖使用是可以的。
//
// 不在这张表上的不等于一定不行，而是「我没想过，先停下来让人看一眼」。这比
// 维护一张「禁止」的表安全 —— 漏写一个禁止项是静默放行，漏写一个允许项只是
// 多一次人工确认。
const COMPATIBLE = new Set([
  '0BSD', 'MIT', 'MIT-0', 'ISC', 'Apache-2.0',
  'BSD-2-Clause', 'BSD-3-Clause', 'BSD-3-Clause-Clear',
  'BlueOak-1.0.0', 'Unlicense', 'CC0-1.0',
  'Python-2.0', 'PSF-2.0', 'Zlib',
  'MPL-2.0',
]);

// copyleft 的那些。它们不是「质量不好」，是**方向不对**：把它们并进来，整份
// 作品就得跟着它们走，而 LICENSE 写的是 MIT。
//
// LGPL 单独说一句：动态链接的情况下它允许被更宽松的作品调用，但这个项目把
// 依赖打进同一个 JS 包里，那是静态链接，条件就不成立了。所以这里一律拦下，
// 真遇到了再人工判断具体那一个是怎么用的。
const KNOWN_INCOMPATIBLE = new Map([
  ['GPL-2.0-only', 'GPL 是 copyleft：并入之后整份作品必须以 GPL 发布，而 LICENSE 是 MIT'],
  ['GPL-2.0', 'GPL 是 copyleft：并入之后整份作品必须以 GPL 发布，而 LICENSE 是 MIT'],
  ['GPL-2.0-or-later', 'GPL 是 copyleft：并入之后整份作品必须以 GPL 发布，而 LICENSE 是 MIT'],
  ['GPL-3.0-only', 'GPL 是 copyleft：并入之后整份作品必须以 GPL 发布，而 LICENSE 是 MIT'],
  ['GPL-3.0-or-later', 'GPL 是 copyleft：并入之后整份作品必须以 GPL 发布，而 LICENSE 是 MIT'],
  ['AGPL-3.0-only', 'AGPL 比 GPL 更进一步，连网络访问都触发源码义务；不能并入 MIT 作品'],
  ['AGPL-3.0-or-later', 'AGPL 比 GPL 更进一步，连网络访问都触发源码义务；不能并入 MIT 作品'],
  ['LGPL-2.1-only', 'LGPL 的宽松只在动态链接时成立，而这里依赖是打进同一个 JS 包的'],
  ['LGPL-2.1-or-later', 'LGPL 的宽松只在动态链接时成立，而这里依赖是打进同一个 JS 包的'],
  ['LGPL-3.0-only', 'LGPL 的宽松只在动态链接时成立，而这里依赖是打进同一个 JS 包的'],
  ['LGPL-3.0-or-later', 'LGPL 的宽松只在动态链接时成立，而这里依赖是打进同一个 JS 包的'],
  ['SSPL-1.0', 'SSPL 不是 OSI 认可的自由软件许可证'],
  ['BUSL-1.1', '商用源代码许可证，限制使用场景'],
]);

const root = process.cwd();
const showAll = process.argv.includes('--all');

/** 从 package.json 里把许可证抠出来。老包用 `licenses` 数组，新包用 `license` 字符串。 */
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  }
  return null;
}

/**
 * SPDX 表达式拆成一组「够用就行」的判断。
 *
 * `(MIT OR CC0-1.0)` —— 任选其一，只要有一个相容就相容。
 * `Apache-2.0 AND LGPL-3.0-or-later` —— 两个都要满足。
 * 这里不实现完整的 SPDX 文法（那要一个库），只处理实际出现过的这两种形状；
 * 遇到看不懂的就当作「要人看一眼」，而不是猜。
 */
function isCompatible(expr) {
  const clean = expr.replace(/[()]/g, ' ').trim();
  if (COMPATIBLE.has(clean)) return true;
  if (KNOWN_INCOMPATIBLE.has(clean)) return false;
  if (/\bOR\b/.test(clean)) {
    return clean.split(/\bOR\b/).some((t) => isCompatible(t.trim()));
  }
  if (/\bAND\b/.test(clean)) {
    return clean.split(/\bAND\b/).every((t) => isCompatible(t.trim()));
  }
  return false;
}

// 哪些包会被分发，由 lockfile 说了算 —— 它给每一个包标了 dev / devOptional。
// 靠遍历 node_modules 猜不出来：一个包可能同时是某个生产依赖和某个构建工具的
// 依赖，扁平化之后在磁盘上只有一份。
const lockPath = path.join(root, 'package-lock.json');
if (!fs.existsSync(lockPath)) {
  console.error('找不到 package-lock.json —— 先跑一次 npm install');
  process.exit(2);
}
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (!lock.packages) {
  console.error(`package-lock.json 是 v${lock.lockfileVersion} 格式，这个检查需要 v2 及以上`);
  process.exit(2);
}

const shipped = [];
const devOnly = [];

for (const [where, meta] of Object.entries(lock.packages)) {
  if (!where.startsWith('node_modules/')) continue;   // '' 是项目自己
  const name = where.replace(/^(?:.*\/)?node_modules\//, '');
  const manifest = path.join(root, where, 'package.json');
  let license = meta.license ?? null;
  if (!license && fs.existsSync(manifest)) {
    try {
      license = licenseOf(JSON.parse(fs.readFileSync(manifest, 'utf8')));
    } catch { /* 读不动就当没写，下面按 UNKNOWN 处理 */ }
  }
  const row = { name, version: meta.version, license };
  (meta.dev || meta.devOptional ? devOnly : shipped).push(row);
}

shipped.sort((a, b) => a.name.localeCompare(b.name));

const bad = [];
const unknown = [];
const byLicense = new Map();

for (const row of shipped) {
  const key = row.license || 'UNKNOWN';
  byLicense.set(key, (byLicense.get(key) || 0) + 1);
  if (!row.license) { unknown.push(row); continue; }
  if (!isCompatible(row.license)) bad.push(row);
}

console.log('本项目以 MIT 分发，以下是会被打进 APK 的依赖：\n');
for (const [lic, n] of [...byLicense].sort((a, b) => b[1] - a[1])) {
  const mark = lic === 'UNKNOWN' ? '?' : isCompatible(lic) ? '✓' : '✗';
  console.log(`  ${mark} ${String(n).padStart(3)}  ${lic}`);
}
console.log(`\n  合计 ${shipped.length} 个会分发，${devOnly.length} 个只在构建时用（不进包，不检查）`);

if (showAll) {
  console.log('\n只在构建时用的：');
  const devBy = new Map();
  for (const r of devOnly) devBy.set(r.license || 'UNKNOWN', (devBy.get(r.license || 'UNKNOWN') || 0) + 1);
  for (const [lic, n] of [...devBy].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${lic}`);
  }
}

let failed = false;

if (bad.length) {
  failed = true;
  console.log('\n与 MIT 不相容（copyleft 会把整份作品拉过去）：');
  for (const r of bad) {
    const why = KNOWN_INCOMPATIBLE.get(r.license.replace(/[()]/g, '').trim());
    console.log(`  ✗ ${r.name}@${r.version} —— ${r.license}`);
    if (why) console.log(`      ${why}`);
  }
}

if (unknown.length) {
  failed = true;
  console.log('\n没写许可证，得人工确认：');
  for (const r of unknown) console.log(`  ? ${r.name}@${r.version}`);
  console.log('\n没写许可证 ≠ 可以随便用。默认是「保留所有权利」，也就是默认不许分发。');
}

if (failed) process.exit(1);

console.log('\n全部相容。');
