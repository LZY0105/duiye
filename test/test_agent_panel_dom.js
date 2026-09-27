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

function mount() {
  document.body.innerHTML = '<main id="root"></main>';

  const submitted = [];
  let closed = 0;
  let panel;

  panel = createAgentPanel(document.querySelector('#root'), {
    onOpen: () => panel.open({
      documentName: '物理练习.pdf',
      page: 3,
    }),
    onSubmit: (question) => submitted.push(question),
    onClose: () => { closed += 1; },
  });

  panel.setAvailable(true);

  return {
    panel,
    submitted,
    closed: () => closed,
    fab: document.querySelector('[data-role="agent-fab"]'),
    dialog: document.querySelector('[data-role="agent-dialog"]'),
    content: document.querySelector('[data-role="agent-content"]'),
    form: document.querySelector('[data-role="agent-form"]'),
    input: document.querySelector('[data-role="agent-question"]'),
    submit: document.querySelector('[data-role="agent-submit"]'),
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
        content: 'Agent 处理失败。',
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;