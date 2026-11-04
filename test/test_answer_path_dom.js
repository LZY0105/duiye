#!/usr/bin/env node
// 产品里"看这一页的答案"那条路，在真 DOM 里跑一遍。
//
// 这条路此前没有任何行为测试：test_pdf_workspace.js 测的是纯状态模块，加上几条
// 源码文本断言。于是 showAnswersForPage 自己排的那串判断——索引、对齐、配对核验、
// 打分——只能靠读代码来确认，而它和 matching-engine 里那套是两份。
//
// 用原型借用驱动真方法，不造整个 PdfWorkspace：这个类要 DOM、要 pdf.js、要一堆
// 生命周期，而这里要测的只是那一串判断。借原型意味着测的是**产品那段代码本身**，
// 不是它的一份誊抄——誊抄出来的测试在源码改了之后照样绿。
//
// 第 2 组是这份文件存在的理由。两条路读同样两份文档，必须得出同样的身份证据。
// 产品曾经把 pane.doc（PDF 适配器，没有 lines）直接交给 verifyPair，而
// documentYear / documentSubject 读的正是 doc.lines——目录是平的那种书（只有例题
// 叶子、没有章节标题），年份和学科两道硬闸都拿不到信号。实测：2024 的习题册配
// 2019 的答案册判成 VERIFIED_PAIR，也就是放行自动答案。
//
// 第 3 组盯的是修法本身的代价：每本书的文字只读一次。把产品路径整个换成
// preparePair 也能让那两道闸通电，但 preparePair 先 readDocument 读一遍整本、再交给
// 索引器又读一遍整本——首次查询的文字提取翻倍，而平板上首次查询本来就要九秒。

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { preparePair } from '../src/pdf/matching-engine.js';
import { PAIR_STATUS } from '../src/pdf/decision.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Event', 'PointerEvent',
  'CustomEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
  'localStorage']) {
  if (dom.window[key] !== undefined) globalThis[key] = dom.window[key];
}

const { PdfWorkspace } = await import('../src/pdf/pdf-workspace.js');

let passed = 0;
let failed = 0;
const group = (n) => console.log(`\n─── [${n}] ───`);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  产品那条答案路 — 它自己排的闸门顺序');
console.log('═══════════════════════════════════════════════════════════════');

// ── 夹具 ────────────────────────────────────────────────────────────────────
//
// 和 test_matching_engine.js 同一个形状，多一个开关：目录是平的还是带章节标题。
//
// 平目录不是刁难出来的边界。语料里 2024 那两本就是平的（271 和 217 条，全是例题
// 叶子），而年份和学科只印在正文里——所以"读不到身份"在真书上是常态，不是例外。
//
// extractText 记着被调了几次，第 3 组靠它。

const N = 24;
function makeDoc({ role, year = '2024', flatOutline = true, subject = 'MA' }) {
  const topic = subject === 'MA' ? '极限与连续函数' : '矩阵与行列式';
  const task = subject === 'MA' ? '求导数' : '求特征值';
  const chapter = subject === 'MA' ? '1' : '2';
  const lines = [];
  const items = [];
  for (let i = 1; i <= N; i++) {
    const page = i + 2;
    const label = `${chapter}.${i}`;
    const expr = `f(x)=x^${i}+${i}`;
    items.push({ title: `例题 ${label}`, pageNumber: page, children: [] });
    lines.push({ page, text: `例题 ${label} (${year}. 某大学). ${task}，${expr}` });
    if (role === 'ANSWER') {
      lines.push({ page, text: `解答：由 ${expr} 可得，因此 答案：${i}x^${i - 1}，所以证毕` });
      lines.push({ page, text: `综上，${topic} 的结论成立，故 得证` });
    } else {
      lines.push({ page, text: `其中 ${topic} 为本节内容，${expr} 为待求函数` });
    }
  }
  const root = flatOutline
    ? items
    : [{ title: `第${chapter}章 ${year} 年${topic}`, pageNumber: 1, children: items }];
  const doc = {
    numPages: 40,
    outline: { available: true, items: root },
    reads: 0,
    async extractText({ from = 1, to = 40 } = {}) {
      doc.reads++;
      return lines.filter(l => l.page >= from && l.page <= to);
    },
  };
  return doc;
}

/**
 * 一个刚好够 showAnswersForPage 跑起来的 this。
 *
 * 只放那个方法真的会碰的东西。多放一件，下一个人就得猜哪些是必需的。
 */
function harness(exerciseDoc, answerDoc, { page = 3 } = {}) {
  const slotEl = dom.window.document.createElement('div');
  slotEl.innerHTML = '<div data-role="answer-panel"></div>';
  const panel = slotEl.querySelector('[data-role="answer-panel"]');

  const pane = { isLoaded: () => true, state: { pageNumber: page, pageCount: 40 }, doc: exerciseDoc };
  const holder = { doc: answerDoc, state: { pageCount: 40 } };

  const ctx = {
    panes: { a: pane },
    elSlots: { a: slotEl },
    async _resolveAnswerSource() { return answerDoc ? { resourceId: 'ans', holder } : null; },
    hideAnswers() {},
    viewOriginal() {},
  };

  return {
    pane,
    holder,
    panel,
    text: () => panel.textContent.replace(/\s+/g, ' ').trim(),
    run: () => PdfWorkspace.prototype.showAnswersForPage.call(ctx, 'a'),
  };
}

/**
 * 同样两份文档，引擎那条路得出的配对判决。用独立的文档对象，不碰产品那边的计数。
 *
 * status 取 prepared.status（配对状态）并且放在最后：decision 自己也带一个 status，
 * 拒绝时是 RUNG.BLOCKED，展开在后面会把配对状态盖掉。
 */
async function engineVerdict(spec) {
  const prepared = await preparePair({
    exerciseDocument: makeDoc(spec.exercise),
    answerDocument: makeDoc(spec.answer),
    expectScript: 'han',
  });
  return { ...prepared.decision, status: prepared.status };
}

// ═══════════════════════════════════════════════════════════════
group('1. 这条路说得出话');

await test('没有配套答案册时，说清楚要先指定', async () => {
  const h = harness(makeDoc({ role: 'EXERCISE' }), null);
  await h.run();
  assert.match(h.text(), /先为这本习题册指定配套的答案册/);
});

await test('一对有效的书，面板上出现这一页的题号', async () => {
  const h = harness(makeDoc({ role: 'EXERCISE' }), makeDoc({ role: 'ANSWER' }));
  await h.run();
  assert.match(h.text(), /1\.1/, `面板上没有题号，实际是：${h.text().slice(0, 80)}`);
  assert.equal(h.pane.pairVerdict?.status, PAIR_STATUS.VERIFIED_PAIR,
    '同年同科的一对，修了之后也得照样认得出来');
});

await test('这一页没有编号题目时，说的是"没识别到"，不是报错', async () => {
  const h = harness(makeDoc({ role: 'EXERCISE' }), makeDoc({ role: 'ANSWER' }), { page: 1 });
  await h.run();
  assert.match(h.text(), /第 1 页没有识别到编号题目/);
});

await test('角色反了的两本书被挡在打分之前', async () => {
  // 答案册当习题册用。这条不依赖正文，修之前也拦得住——它钉的是"被拒的配对
  // 走不到打分"，而不是身份识别。
  const h = harness(makeDoc({ role: 'ANSWER' }), makeDoc({ role: 'ANSWER' }));
  await h.run();
  assert.match(h.text(), /这两本书看起来不是一对/);
  assert.equal(h.pane.pairVerdict?.status, PAIR_STATUS.REJECTED_PAIR);
});

// ═══════════════════════════════════════════════════════════════
group('2. 两条路必须看见同样的身份证据');

for (const [name, spec, field] of [
  ['平目录的书：产品路读得到年份，和引擎一致',
    { exercise: { role: 'EXERCISE', year: '2024' }, answer: { role: 'ANSWER', year: '2024' } }, 'year'],
  ['平目录的书：产品路判得出学科，和引擎一致',
    { exercise: { role: 'EXERCISE' }, answer: { role: 'ANSWER' } }, 'subject'],
]) {
  await test(name, async () => {
    const h = harness(makeDoc(spec.exercise), makeDoc(spec.answer));
    await h.run();
    const mine = h.pane.pairVerdict?.evidence?.[field];
    const theirs = (await engineVerdict(spec)).evidence?.[field];
    assert.deepEqual(mine, theirs, `产品 ${JSON.stringify(mine)} vs 引擎 ${JSON.stringify(theirs)}`);
  });
}

await test('配错年份的答案册，当场拒，不靠后面的锚点兜', async () => {
  // 872 条错误 HIGH 接受就是这种组合来的，年份闸是专门为它设的，而它只在
  // documentYear 拿得到正文时才响。同一书系跨年的书，标签和内容都像，锚点兜不住。
  const spec = { exercise: { role: 'EXERCISE', year: '2024' }, answer: { role: 'ANSWER', year: '2019' } };
  const h = harness(makeDoc(spec.exercise), makeDoc(spec.answer));
  await h.run();
  const verdict = h.pane.pairVerdict;
  assert.equal(verdict?.status, PAIR_STATUS.REJECTED_PAIR,
    `实际 ${verdict?.status}，理由 ${(verdict?.reasonCodes ?? []).join(',') || '无'}`);
  assert.equal(verdict?.evidence?.year?.exercise?.year, '2024', '习题册的年份没读出来');
  assert.equal(verdict?.evidence?.year?.answer?.year, '2019', '答案册的年份没读出来');
  assert.match(h.text(), /这两本书看起来不是一对/, '面板上得说出来，而不是给答案');
  assert.equal((await engineVerdict(spec)).status, PAIR_STATUS.REJECTED_PAIR, '引擎那条路本来就拒');
});

await test('配错学科的答案册，当场拒', async () => {
  const spec = { exercise: { role: 'EXERCISE', subject: 'MA' }, answer: { role: 'ANSWER', subject: 'ALG' } };
  const h = harness(makeDoc(spec.exercise), makeDoc(spec.answer));
  await h.run();
  const verdict = h.pane.pairVerdict;
  assert.equal(verdict?.status, (await engineVerdict(spec)).status,
    `产品 ${verdict?.status}（${(verdict?.reasonCodes ?? []).join(',') || '无'}）和引擎不一致`);
  assert.equal(verdict?.status, PAIR_STATUS.REJECTED_PAIR);
});

// ═══════════════════════════════════════════════════════════════
group('3. 每本书的文字只读一次');

await test('第一次查答案，两本书各读一次整本', async () => {
  // 让闸门通电不能靠再读一遍：平板上整本提取是首次查询里最贵的那一段。
  const ex = makeDoc({ role: 'EXERCISE' });
  const an = makeDoc({ role: 'ANSWER' });
  const h = harness(ex, an);
  await h.run();
  assert.equal(ex.reads, 1, `习题册读了 ${ex.reads} 遍`);
  assert.equal(an.reads, 1, `答案册读了 ${an.reads} 遍`);
});

await test('翻到下一页再查，一遍都不再读', async () => {
  const ex = makeDoc({ role: 'EXERCISE' });
  const an = makeDoc({ role: 'ANSWER' });
  const h = harness(ex, an);
  await h.run();
  h.pane.state.pageNumber = 4;
  await h.run();
  assert.equal(ex.reads, 1, `习题册一共读了 ${ex.reads} 遍`);
  assert.equal(an.reads, 1, `答案册一共读了 ${an.reads} 遍`);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(failed ? 1 : 0);
