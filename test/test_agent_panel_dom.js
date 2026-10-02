#!/usr/bin/env node

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

const dom = new JSDOM(
  '<!doctype html><html><body></body></html>',
  { url: 'http://localhost/' },
);

for (const key of [
  'window',
  'document',
  'Element',
  'HTMLElement',
  'Event',
]) {
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
    writable: true,
  });
}

const { createAgentPanel } = await import('../src/pdf/agent-panel.js');

// 用真实词表，不用伪翻译：面板文案一旦漏进裸键或没填的占位符，这里就会看见。
const i18n = await import('../src/core/i18n.js');
const LANGS = ['zh-CN', 'zh-TW', 'en'];
const packs = {};
for (const lang of LANGS) {
  packs[lang] = (await import(`../src/core/lang/${lang}.js`)).default;
}
await i18n.initI18n();
await i18n.setLang('zh-CN');

/** 期望文案：填上 {{name}} / {{page}}。 */
function fill(lang, key, vars = {}) {
  return packs[lang][key].replace(/\{\{(\w+)\}\}/g, (whole, name) => (
    vars[name] === undefined ? whole : String(vars[name])
  ));
}

const assistantName = (lang) => packs[lang]['agent.name'];

function mount() {
  document.body.innerHTML = '<main id="root"></main>';

  const submitted = [];
  let closed = 0;
  let cleared = 0;
  let panel;

  panel = createAgentPanel(document.querySelector('#root'), {
    onOpen: () => panel.open({
      documentName: '物理练习.pdf',
      page: 3,
    }),
    onSubmit: (question) => submitted.push(question),
    onClear: () => { cleared += 1; },
    onClose: () => { closed += 1; },
  });

  panel.setAvailable(true);

  return {
    panel,
    submitted,
    closed: () => closed,
    cleared: () => cleared,
    fab: document.querySelector('[data-role="agent-fab"]'),
    dialog: document.querySelector('[data-role="agent-dialog"]'),
    content: document.querySelector('[data-role="agent-content"]'),
    form: document.querySelector('[data-role="agent-form"]'),
    input: document.querySelector('[data-role="agent-question"]'),
    submit: document.querySelector('[data-role="agent-submit"]'),
    clear: document.querySelector('[data-role="agent-clear"]'),
    closeButton: document.querySelector('[data-role="agent-close"]'),
    title: document.querySelector('#pdf-agent-dialog-title'),
    meta: document.querySelector('[data-role="agent-meta"]'),
  };
}

await test('opens with an empty disabled question form', () => {
  const view = mount();

  view.fab.click();

  assert.equal(view.dialog.hidden, false);
  assert.equal(view.input.value, '');
  assert.equal(view.submit.disabled, true);
  assert.equal(document.activeElement, view.input);
  assert.match(view.content.textContent, /输入一个关于当前页的问题/);

  view.panel.destroy();
});

await test('trims and submits a custom question', () => {
  const view = mount();
  view.fab.click();

  view.input.value = '  水的沸点是多少？  ';
  view.input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(view.submit.disabled, false);

  view.form.dispatchEvent(new Event('submit', {
    bubbles: true,
    cancelable: true,
  }));

  assert.deepEqual(view.submitted, ['水的沸点是多少？']);

  assert.equal(view.input.value, '');
  assert.equal(view.submit.disabled, true);

  view.panel.destroy();
});

await test('disables the form while loading and restores it after a result', () => {
  const view = mount();
  view.fab.click();

  view.input.value = '为什么？';
  view.input.dispatchEvent(new Event('input', { bubbles: true }));

  view.panel.showLoading();
  assert.equal(view.input.disabled, true);
  assert.equal(view.submit.disabled, true);
  assert.equal(view.submit.textContent, '处理中…');

  view.panel.showResult({ ok: true, answer: '因为页面给出了该条件。' });
  assert.equal(view.input.disabled, false);
  assert.equal(view.submit.disabled, false);
  assert.equal(view.submit.textContent, '发送');

  view.panel.destroy();
});

await test('renders Markdown and math in an Agent answer', () => {
  const view = mount();
  view.fab.click();

  view.panel.showResult({
    ok: true,
    answer: '**粗体** 和公式 $x^2$',
  });

  const content = document.querySelector('[data-role="agent-content"]');
  assert.equal(content.querySelector('strong')?.textContent, '粗体');
  assert.ok(content.querySelector('.katex'), 'the formula was rendered');

  view.panel.destroy();
});

await test('does not create active content from an Agent answer', () => {
  const view = mount();
  view.fab.click();

  view.panel.showResult({
    ok: true,
    answer: [
      '<img src="x" onerror="alert(1)"><script>alert(2)</script>',
      '[外部链接](https://example.com/)',
      '![外部图片](https://example.com/a.png)',
    ].join('\n'),
  });

  const content = document.querySelector('[data-role="agent-content"]');
  assert.equal(
    content.querySelector('a, img, script, [onerror], [onclick]'),
    null,
  );

  view.panel.destroy();
});

await test('renders a multi-message conversation safely', () => {
  const view = mount();
  view.fab.click();

  view.panel.showConversation({
    messages: [
      {
        role: 'user',
        content: '<img src="x" onerror="alert(1)">解释这个公式',
      },
      {
        role: 'assistant',
        content: '**容斥原理**使用公式 $x^2$。',
      },
    ],
    pendingRequestId: null,
  });

  const messages = [
    ...document.querySelectorAll('[data-role="agent-message"]'),
  ];

  assert.equal(messages.length, 2);
  assert.equal(messages[0].dataset.messageRole, 'user');
  assert.match(messages[0].textContent, /<img/);
  assert.equal(messages[0].querySelector('img'), null);

  assert.equal(messages[1].dataset.messageRole, 'assistant');
  assert.equal(messages[1].querySelector('strong')?.textContent, '容斥原理');
  assert.ok(messages[1].querySelector('.katex'));

  view.panel.destroy();
});

await test('shows a pending reply and disables the composer', () => {
  const view = mount();
  view.fab.click();

  view.panel.showConversation({
    messages: [
      {
        role: 'user',
        content: '为什么符号正负交替？',
      },
    ],
    pendingRequestId: 'request-1',
  });

  const pending = document.querySelector(
    '[data-role="agent-message"].is-pending',
  );

  assert.match(pending?.textContent || '', /正在思考/);
  assert.equal(view.input.disabled, true);
  assert.equal(view.submit.disabled, true);
  assert.equal(view.submit.textContent, '处理中…');

  view.panel.destroy();
});

await test('marks failed assistant messages as errors', () => {
  const view = mount();
  view.fab.click();

  view.panel.showConversation({
    messages: [
      {
        role: 'user',
        content: '解释这一页',
        status: 'done',
      },
      {
        role: 'assistant',
        content: '页问处理失败。',
        status: 'error',
      },
    ],
    pendingRequestId: null,
  });

  const errorMessage = document.querySelector(
    '[data-role="agent-message"][data-message-role="assistant"]',
  );

  assert.equal(errorMessage?.classList.contains('is-error'), true);
  assert.match(errorMessage?.textContent || '', /处理失败/);

  view.panel.destroy();
});

await test('closing clears the question and notifies the owner', () => {
  const view = mount();
  view.fab.click();
  view.input.value = '临时问题';

  view.panel.close();

  assert.equal(view.dialog.hidden, true);
  assert.equal(view.input.value, '');
  assert.equal(view.closed(), 1);

  view.panel.destroy();
});

await test('clears the conversation through the owner and refuses while busy', () => {
  const view = mount();
  view.fab.click();

  view.panel.showConversation({
    messages: [{ role: 'assistant', content: '页面给出的答案。' }],
    pendingRequestId: null,
  });
  assert.equal(view.clear.disabled, false);

  view.clear.click();
  assert.equal(view.cleared(), 1);
  assert.equal(view.clear.disabled, true);
  assert.equal(view.content.textContent, packs['zh-CN']['agent.status.empty']);

  view.panel.showConversation({
    messages: [{ role: 'user', content: '再问一次' }],
    pendingRequestId: 'request-2',
  });
  view.clear.click();
  assert.equal(view.cleared(), 1, '请求在飞时不该清');

  view.panel.destroy();
});

await test('localizes the panel and the assistant name in every language', async () => {
  for (const lang of LANGS) {
    await i18n.setLang(lang);
    const view = mount();
    const name = assistantName(lang);

    assert.equal(view.fab.title, fill(lang, 'agent.fab.open', { name }));
    assert.equal(
      view.fab.getAttribute('aria-label'),
      fill(lang, 'agent.fab.open', { name }),
    );
    assert.equal(view.clear.title, fill(lang, 'agent.dialog.clear', { name }));
    assert.equal(view.clear.textContent, packs[lang]['agent.dialog.clearShort']);
    assert.equal(view.closeButton.title, fill(lang, 'agent.dialog.close', { name }));
    assert.equal(view.input.placeholder, packs[lang]['agent.question.placeholder']);
    assert.equal(view.input.getAttribute('aria-label'), packs[lang]['agent.question.label']);

    view.fab.click();

    assert.equal(view.title.textContent, name);
    assert.equal(view.submit.textContent, packs[lang]['agent.submit']);
    assert.equal(view.content.textContent, packs[lang]['agent.status.empty']);
    assert.equal(
      view.meta.textContent,
      `物理练习.pdf · ${fill(lang, 'agent.meta.page', { page: 3 })}`,
    );

    view.panel.showNotice('agent.notice.pageChanged');
    assert.equal(
      view.content.textContent,
      fill(lang, 'agent.notice.pageChanged', { name }),
    );

    view.panel.destroy();
  }

  await i18n.setLang('zh-CN');
});

await test('re-translates an open panel without a refresh', async () => {
  await i18n.setLang('zh-CN');
  const view = mount();
  view.fab.click();

  view.input.value = '水的沸点是多少？';
  view.input.dispatchEvent(new Event('input', { bubbles: true }));
  view.panel.showConversation(
    {
      messages: [
        { role: 'user', content: '解释这一页', status: 'done' },
        { role: 'assistant', content: '页问处理失败。', status: 'error' },
      ],
      pendingRequestId: 'request-1',
    },
    { textOrigin: 'LAYER' },
  );

  const contentNode = view.content;
  contentNode.scrollTop = 24;
  assert.match(view.meta.textContent, /PDF 文字层/);

  await i18n.setLang('en');

  assert.equal(view.dialog.hidden, false);
  assert.equal(view.title.textContent, 'Master Page');
  assert.equal(view.submit.textContent, 'Working…');
  assert.equal(view.input.placeholder, packs.en['agent.question.placeholder']);
  assert.equal(view.meta.textContent, '物理练习.pdf · Page 3 · PDF text layer');

  // 面板没有重建，也没重发请求：内容节点还是同一个，提交记录仍为空。
  assert.equal(document.querySelector('[data-role="agent-content"]'), contentNode);
  assert.deepEqual(view.submitted, []);

  // 草稿、滚动位置和忙碌状态都留着。
  assert.equal(view.input.value, '水的沸点是多少？');
  assert.equal(contentNode.scrollTop, 24);
  assert.equal(view.input.disabled, true);
  assert.equal(view.submit.disabled, true);
  assert.equal(view.clear.disabled, true);

  const messages = [
    ...document.querySelectorAll('[data-role="agent-message"]'),
  ];
  assert.equal(messages.length, 3);
  assert.equal(messages[0].textContent, '解释这一页');
  assert.match(messages[1].textContent, /页问处理失败/);
  assert.equal(messages[1].classList.contains('is-error'), true);
  assert.equal(messages[2].textContent, 'Master Page is thinking…');

  // 换语言之后新出现的提示用新语言。
  view.panel.showNotice('agent.notice.pageChanged');
  assert.equal(
    view.content.textContent,
    packs.en['agent.notice.pageChanged'].replace('{{name}}', 'Master Page'),
  );
  assert.equal(view.submit.textContent, 'Send');

  await i18n.setLang('zh-CN');
  view.panel.destroy();
});

await test('keeps the draft, the caret and the focus while re-localizing', async () => {
  await i18n.setLang('zh-CN');
  const view = mount();
  view.fab.click();

  view.input.value = '草稿';
  view.input.dispatchEvent(new Event('input', { bubbles: true }));
  view.input.focus();
  view.input.setSelectionRange(1, 1);

  await i18n.setLang('en');

  assert.equal(document.activeElement, view.input);
  assert.equal(view.input.value, '草稿');
  assert.equal(view.input.selectionStart, 1);
  assert.equal(view.input.disabled, false);
  assert.equal(view.submit.disabled, false);
  assert.equal(view.submit.textContent, 'Send');

  view.panel.destroy();
  await i18n.setLang('zh-CN');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;