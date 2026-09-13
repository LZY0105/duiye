#!/usr/bin/env node
// 检查每一个会被打进 APK 的依赖，许可证是否与本项目的 AGPL-3.0 相容。
//
// 为什么这件事值得有一个检查：AGPL 是 copyleft，整份作品必须以 AGPL 发布。
// 往里混进一个不相容的依赖，不是「有个警告」，是整个分发行为失去许可 —— 而这
// 种错误极难在别处被发现，它不会让构建失败，也不会让测试变红，装出来的包跑得
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

// 可以并入 AGPL-3.0 作品的许可证。
//
// 判断标准是单向的：这些许可证允许把代码并入一个以更严格条款分发的作品。
// 宽松许可证（MIT/BSD/ISC/Apache-2.0）都可以；弱 copyleft（MPL-2.0、LGPL）
// 按文件/按库隔离，也可以；GPL-3.0 与 AGPL-3.0 之间 FSF 明确规定可以互相链接。
//
// 不在这张表上的不等于一定不行，而是「我没想过，先停下来让人看一眼」。这比
// 维护一张「禁止」的表安全 —— 漏写一个禁止项是静默放行，漏写一个允许项只是
// 多一次人工确认。
const COMPATIBLE = new Set([
  '0BSD', 'MIT', 'MIT-0', 'ISC', 'Apache-2.0',
  'BSD-2-Clause', 'BSD-3-Clause', 'BSD-3-Clause-Clear',
  'BlueOak-1.0.0', 'Unlicense', 'CC0-1.0', 'Python-2.0', 'Zlib',
  'MPL-2.0',
  'LGPL-2.1-or-later', 'LGPL-3.0-or-later', 'LGPL-3.0-only',
  'GPL-3.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
]);

// GPL-2.0-only 是最容易被放过去的一个：它和 AGPL-3.0 **不**相容 —— GPL-2 没有
// 「或更新版本」这一句时，无法升到 GPL-3 系列。所以这里单独点名，报错时给出
// 的理由要说得出口，而不是一句「不在白名单里」。
const KNOWN_INCOMPATIBLE = new Map([
  ['GPL-2.0-only', 'GPL-2.0 不带「or later」时无法升级到 GPL-3 系列，与 AGPL-3.0 不相容'],
  ['GPL-2.0', '同上（旧写法）'],
  ['SSPL-1.0', 'SSPL 不是 OSI 认可的自由软件许可证，条款与 AGPL 冲突'],
  ['BUSL-1.1', '商用源代码许可证，限制使用场景，不能并入 AGPL 作品'],
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

console.log('本项目以 AGPL-3.0 分发，以下是会被打进 APK 的依赖：\n');
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
  console.log('\n与 AGPL-3.0 不相容：');
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
}

if (failed) {
  console.log('\n没写许可证 ≠ 可以随便用。默认是「保留所有权利」，也就是默认不许分发。');
  process.exit(1);
}

console.log('\n全部相容。');
