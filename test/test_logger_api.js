#!/usr/bin/env node
// Every Logger.<method>() in src/ names a method the logger actually has.
//
// `Logger.log(...)` compiled, bundled, shipped, and then threw on the tablet on
// the one launch that mattered most — the session migration — taking the whole
// restore down with it before a single pane was opened. The data was all still
// there and the next launch was fine, which is exactly what makes this kind of
// mistake expensive to find: it fires once, on a path that runs once.
//
// Nothing in a bundler or a unit test catches a method name that is simply not
// there. A scan does.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import Logger from '../src/core/logger.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let PASS = 0, FAIL = 0;
const pass = (l) => { PASS++; console.log(`  ✅ ${l}`); };
const fail = (l, d) => { FAIL++; console.log(`  ❌ ${l}${d ? ': ' + d : ''}`); };
function check(label, fn) {
  try { fn(); pass(label); } catch (e) { fail(label, e.message); }
}

function jsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Logger API — no call names a method that is not there');
console.log('═══════════════════════════════════════════════════════════════\n');

const files = jsFilesUnder(join(ROOT, 'src'));

check('the scan found the source tree and a real logger', () => {
  assert.ok(files.length > 20, `only ${files.length} files found`);
  const available = Object.keys(Logger);
  assert.ok(available.includes('warn') && available.includes('error'),
    `logger exposes ${available.join(', ')}`);
});

check('every Logger.<method>() in src/ exists on the logger', () => {
  const available = new Set(Object.keys(Logger));
  const missing = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    for (const hit of source.matchAll(/\bLogger\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!available.has(hit[1])) {
        missing.push(`${relative(ROOT, file).replace(/\\/g, '/')} → Logger.${hit[1]}()`);
      }
    }
  }
  assert.deepEqual(missing, [], 'these call a method the logger does not define');
});

check('the calls that ARE there are the ones the logger offers', () => {
  // A sanity check on the scan itself: if the regexp stopped matching, the test
  // above would pass by finding nothing at all.
  const used = new Set();
  for (const file of files) {
    for (const hit of readFileSync(file, 'utf-8').matchAll(/\bLogger\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      used.add(hit[1]);
    }
  }
  assert.ok(used.size >= 2, `the scan found only ${[...used].join(', ')}`);
  for (const name of used) assert.ok(typeof Logger[name] === 'function', `${name} is callable`);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${PASS} passed, ${FAIL} failed`);
console.log('═══════════════════════════════════════════════════════════════');
process.exit(FAIL === 0 ? 0 : 1);
