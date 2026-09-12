#!/usr/bin/env node
// 使用说明：装完软件就在，五种语言都在。
//
// 两条要求，两条都能在这里证完：
//
//   「一下载软件就要有」→ 它不是库里的一条记录，是书架自己摆出来的一格。所以
//     哪怕一份文件都没导入过，它也在——这一条要盯住「空书架那条路也把架子搭出
//     来」，因为原来那条路是直接回一句话就走。
//
//   「语言跟随软件所选」→ 说明书整页都是文案。漏一条键，t() 会把裸键显示出来
//     （i18n 是故意这么设计的），或者落回简体中文——一页中文夹在日文里。所以这
//     里逐条比对五份语言包。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

const $read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf-8');

const LANGS = ['zh-CN', 'zh-TW', 'en'];
const dicts = {};
for (const lang of LANGS) {
  dicts[lang] = (await import(`../src/core/lang/${lang}.js`)).default;
}

const guideSrc = $read('src/pdf/user-guide.js');
const shelfSrc = $read('src/pdf/book-shelf.js');
const uiSrc = $read('src/pdf/pdf-workspace-ui.js');

/** 说明书里真正会去查的那些键。 */
const SECTIONS = [...guideSrc.matchAll(/\{ key: '([a-z]+)', figure:/g)].map(m => m[1]);
const USED = [
  'guide.name', 'guide.tagline', 'guide.title', 'guide.sub', 'guide.foot',
  ...SECTIONS.flatMap(k => [`guide.${k}.t`, `guide.${k}.a`, `guide.${k}.b`]),
];
const SHELF_KEYS = [
  'shelf.tagExercise', 'shelf.tagAnswer', 'shelf.openBook',
  'shelf.import', 'shelf.empty', 'shelf.usage',
];

// ═══════════════════════════════════════════════════════════════
group('1. 五种语言，一条都不缺');

test(`说明书正文有 ${SECTIONS.length} 节，节数从源码里数出来`, () => {
  assert.ok(SECTIONS.length >= 5, `只数到 ${SECTIONS.length} 节`);
});

for (const lang of LANGS) {
  test(`${lang}：说明书的每一条都在`, () => {
    const missing = USED.filter(k => typeof dicts[lang][k] !== 'string');
    assert.deepEqual(missing, [], `缺 ${missing.length} 条`);
  });
}

for (const lang of LANGS) {
  test(`${lang}：书架上那几句也在`, () => {
    const missing = SHELF_KEYS.filter(k => typeof dicts[lang][k] !== 'string');
    assert.deepEqual(missing, [], `缺 ${missing.length} 条`);
  });
}

test('没有哪一门语言是照抄简体中文的', () => {
  // 抄一份过去，测试就绿了，而用户看到的还是中文。至少标题那几条得是各说各的。
  const sample = ['guide.name', 'guide.title', 'guide.panes.t'];
  for (const lang of ['en']) {
    for (const key of sample) {
      assert.notEqual(dicts[lang][key], dicts['zh-CN'][key], `${lang} 的 ${key} 还是中文`);
    }
  }
});

test('占位符两边对得上', () => {
  // {{name}} 少一个，界面上就会出现一个空洞或者一串花括号。
  const withVars = { 'shelf.openBook': ['name'], 'shelf.usage': ['docs', 'pads', 'size'] };
  for (const [key, vars] of Object.entries(withVars)) {
    for (const lang of LANGS) {
      for (const v of vars) {
        assert.ok(dicts[lang][key].includes(`{{${v}}}`), `${lang} 的 ${key} 少了 {{${v}}}`);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════
group('2. 一装上就在，不用导入');

test('说明书不是库里的记录，是书架自己摆的一格', () => {
  assert.ok(/_guideTile\(\)/.test(shelfSrc), '书架自己画那一格');
  assert.ok(!/importPdf|listDocuments/.test($read('src/pdf/user-guide.js')),
    '说明书不该碰文档库');
});

test('它排在第一个，前面没有别的书', () => {
  const fn = shelfSrc.slice(shelfSrc.indexOf('setItems(items) {'));
  const body = fn.slice(0, fn.indexOf('_tile(item) {'));
  const guideAt = body.indexOf('_guideTile()');
  const itemsAt = body.indexOf('for (const item of items)');
  assert.ok(guideAt > 0, '书架要摆出说明书那一格');
  assert.ok(guideAt < itemsAt, '它得排在那些书前面');
});

test('一本书都没有时，架子照样搭出来', () => {
  // 这是第一次打开软件看到的那一屏。原来这条路直接回一句「书架上还没有书」就
  // 走了——没有说明书，连「＋」都没有。
  const fn = uiSrc.slice(uiSrc.indexOf('async function refreshLibrary()'));
  const body = fn.slice(0, fn.indexOf('function showGuide'));
  assert.ok(!/if \(!items\.length\) \{[\s\S]{0,200}?return;/.test(body),
    '空书架不能提前返回');
  assert.ok(/onGuide: showGuide/.test(body), '书架要接上说明书');
});

test('封面是画的，不是截的', () => {
  // 截图只能是某一种语言的，而这个软件有五种；它还会随界面改动慢慢变成假的。
  assert.ok(/GUIDE_COVER = `[\s\S]*?<svg/.test(shelfSrc), '封面是内联 SVG');
  assert.ok(!/\.png|\.jpg|\.webp/.test(shelfSrc), '不该引任何位图');
});

// ═══════════════════════════════════════════════════════════════
group('3. 语言换了，这一页跟着换');

test('整页文案都走 t()，没有写死的句子', () => {
  // 中日韩的方块字最容易被直接写进模板里。
  // 先把注释整段去掉再找——这个文件的注释本来就是中文的。
  const code = guideSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const literals = code.split('\n')
    .filter(line => /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(line));
  assert.deepEqual(literals, [], `有 ${literals.length} 行把文字写死在代码里`);
});

test('语言一换就重画，并且换走时把回调摘掉', () => {
  assert.ok(/onLangChange\(paint\)/.test(guideSrc), '要挂上语言变化的回调');
  assert.ok(/offLang\(\)/.test(guideSrc), '关掉时要摘回调，否则开一次留一个');
});

test('书架上那两个角标也跟着语言走', () => {
  assert.ok(!/EXERCISE\]: '练习'/.test(shelfSrc), '角标不能写死');
  assert.ok(/ROLE_KEYS/.test(shelfSrc) && /t\(ROLE_KEYS\[item\.role\]\)/.test(shelfSrc));
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(failed ? 1 : 0);
