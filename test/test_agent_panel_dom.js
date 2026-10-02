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
const { confirmDestructive } = await import('../src/pdf/deck-dialogs.js');

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

function mount({ clearResult } = {}) {
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
    onClear: () => { cleared += 1; return clearResult; },
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

await test('clears the conversation through the owner and refuses while busy', async () => {
  const view = mount();
  view.fab.click();

  view.panel.showConversation({
    messages: [{ role: 'assistant', content: '页面给出的答案。' }],
    pendingRequestId: null,
  });
  assert.equal(view.clear.disabled, false);

  view.clear.click();
  assert.equal(view.cleared(), 0, 'opening the confirmation must not erase history');
  document.querySelector('.deck-dialog [data-role="confirm"]').click();
  await Promise.resolve();
  assert.equal(view.cleared(), 1);
  assert.equal(view.clear.disabled, true);
  assert.equal(view.content.textContent, packs['zh-CN']['agent.status.empty']);

  view.panel.showConversation({
    messages: [{ role: 'user', content: '再问一次' }],
    pendingRequestId: 'request-2',
  });
  view.clear.click();
  assert.equal(view.cleared(), 1, '请求在飞时不该清');
  assert.equal(document.querySelector('.deck-overlay'), null);

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

function savedConversation(view) {
  view.panel.showConversation({
    messages: [{ role: 'assistant', content: '保留的历史回答。' }],
    pendingRequestId: null,
  });
  view.input.value = '  未发送的草稿  ';
  view.input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(view, options = {}) {
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true, ...options,
  });
  view.input.dispatchEvent(event);
  return event;
}

await test('cancel, Escape and backdrop preserve history and the draft', async () => {
  const view = mount();
  view.fab.click();
  savedConversation(view);
  const message = view.content.firstElementChild;
  for (const exit of ['cancel', 'escape', 'backdrop']) {
    view.clear.click();
    const overlay = document.querySelector('.deck-overlay');
    const cancel = overlay.querySelector('[data-role="cancel"]');
    assert.equal(document.activeElement, cancel, 'cancel is the safe initial choice');
    assert.equal(view.input.disabled, true);
    pressEnter(view, { ctrlKey: true });
    assert.deepEqual(view.submitted, [], 'confirmation blocks sending too');
    if (exit === 'cancel') cancel.click();
    else if (exit === 'escape') {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
    } else overlay.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await Promise.resolve();
    assert.equal(document.querySelector('.deck-overlay'), null);
    assert.equal(view.cleared(), 0);
    assert.equal(view.content.firstElementChild, message);
    assert.equal(view.input.value, '  未发送的草稿  ');
    assert.equal(view.input.disabled, false);
    assert.equal(view.submit.disabled, false);
    assert.equal(document.activeElement, view.input);
  }
  view.panel.destroy();
});

await test('confirm clears once, preserves the draft and respects an owner refusal', async () => {
  for (const clearResult of [undefined, false]) {
    const view = mount({ clearResult });
    view.fab.click();
    savedConversation(view);
    view.clear.click();
    view.clear.dispatchEvent(new Event('click', { bubbles: true }));
    assert.equal(document.querySelectorAll('.deck-overlay').length, 1);
    const confirm = document.querySelector('.deck-dialog [data-role="confirm"]');
    confirm.click();
    confirm.click();
    await Promise.resolve();
    assert.equal(view.cleared(), 1);
    assert.equal(view.input.value, '  未发送的草稿  ');
    assert.equal(view.submit.disabled, false);
    assert.equal(document.activeElement, view.input);
    assert.equal(view.clear.disabled, clearResult !== false);
    assert.equal(view.content.textContent.trim(), clearResult === false
      ? '保留的历史回答。' : packs['zh-CN']['agent.status.empty']);
    view.panel.destroy();
  }
});

await test('empty history cannot open a destructive confirmation', () => {
  const view = mount();
  view.fab.click();
  view.clear.dispatchEvent(new Event('click', { bubbles: true }));
  assert.equal(document.querySelector('.deck-overlay'), null);
  assert.equal(view.cleared(), 0);
  view.panel.destroy();
});

await test('page changes, close, newer replies and destruction invalidate old consent', async () => {
  for (const invalidate of ['page', 'document', 'close', 'pending', 'destroy', 'confirmed-page']) {
    const view = mount();
    view.fab.click();
    savedConversation(view);
    view.clear.click();
    const oldConfirm = document.querySelector('.deck-dialog [data-role="confirm"]');
    if (invalidate === 'confirmed-page') oldConfirm.click();
    if (invalidate === 'page' || invalidate === 'document' || invalidate === 'confirmed-page') {
      view.panel.close();
      view.panel.open({ documentName: invalidate === 'page' ? '物理练习.pdf' : '另一本.pdf', page: 4 });
      view.panel.showConversation({ messages: [{ role: 'assistant', content: '新页面记录' }] });
    } else if (invalidate === 'close') view.panel.close();
    else if (invalidate === 'pending') {
      view.panel.showConversation({
        messages: [{ role: 'user', content: '正在请求的新问题' }], pendingRequestId: 'new-request',
      });
    } else view.panel.destroy();
    assert.equal(document.querySelector('.deck-overlay'), null);
    oldConfirm.click();
    await Promise.resolve();
    assert.equal(view.cleared(), 0, 'an obsolete confirm control must have no effect');
    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, false, 'dismissal removes the document listener');
    if (invalidate === 'page' || invalidate === 'document' || invalidate === 'confirmed-page') {
      assert.equal(view.content.textContent.trim(), '新页面记录');
    }
    if (invalidate === 'pending') assert.equal(view.input.disabled, true);
    view.panel.destroy();
  }
});

await test('the clear confirmation is translated and cancels on a language change', async () => {
  for (const lang of LANGS) {
    await i18n.setLang(lang);
    const view = mount();
    view.fab.click();
    savedConversation(view);
    view.clear.click();
    const confirmation = document.querySelector('.deck-dialog');
    assert.equal(confirmation.querySelector('.deck-dialog-title').textContent,
      packs[lang]['agent.dialog.clearTitle']);
    assert.equal(confirmation.querySelector('.deck-dialog-note').textContent,
      fill(lang, 'agent.dialog.clearBody', { name: assistantName(lang) }));
    assert.equal(confirmation.querySelector('[data-role="cancel"]').textContent,
      packs[lang]['deck.cancel']);
    assert.equal(confirmation.querySelector('[data-role="confirm"]').textContent,
      packs[lang]['agent.dialog.clearShort']);
    await i18n.setLang(lang === 'en' ? 'zh-CN' : 'en');
    assert.equal(document.querySelector('.deck-overlay'), null);
    assert.equal(view.cleared(), 0);
    assert.equal(view.input.value, '  未发送的草稿  ');
    assert.equal(view.input.disabled, false);
    view.panel.destroy();
  }
  await i18n.setLang('zh-CN');
});

await test('Ctrl+Enter and Command+Enter submit through the same form path', () => {
  const view = mount();
  view.fab.click();
  let formSubmissions = 0;
  view.form.addEventListener('submit', () => { formSubmissions += 1; });
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    view.input.value = '  第一行\n第二行  ';
    view.input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(pressEnter(view, modifier).defaultPrevented, true);
    assert.equal(view.input.value, '');
    assert.equal(view.submit.disabled, true);
  }
  assert.equal(formSubmissions, 2);
  assert.deepEqual(view.submitted, ['第一行\n第二行', '第一行\n第二行']);
  view.panel.destroy();
});

await test('plain Enter remains a newline and key repeats cannot resend', () => {
  const view = mount();
  view.fab.click();
  view.input.value = '草稿';
  view.input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(pressEnter(view).defaultPrevented, false);
  assert.equal(pressEnter(view, { shiftKey: true }).defaultPrevented, false);
  assert.equal(pressEnter(view, { ctrlKey: true, altKey: true }).defaultPrevented, false);
  pressEnter(view, { ctrlKey: true, repeat: true });
  assert.equal(view.input.value, '草稿');
  assert.deepEqual(view.submitted, []);
  view.panel.destroy();
});

await test('composition events, isComposing and keyCode 229 never send a candidate', () => {
  const view = mount();
  view.fab.click();
  view.input.value = '拼音候选';
  view.input.dispatchEvent(new Event('input', { bubbles: true }));
  view.input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
  assert.equal(pressEnter(view, { ctrlKey: true }).defaultPrevented, false);
  view.form.dispatchEvent(new Event('submit', { cancelable: true }));
  view.input.dispatchEvent(new Event('compositionend', { bubbles: true }));
  assert.equal(pressEnter(view, { metaKey: true, isComposing: true }).defaultPrevented, false);
  assert.equal(pressEnter(view, { ctrlKey: true, keyCode: 229 }).defaultPrevented, false);
  assert.deepEqual(view.submitted, []);
  assert.equal(view.input.value, '拼音候选');
  pressEnter(view, { ctrlKey: true });
  assert.deepEqual(view.submitted, ['拼音候选']);
  view.panel.destroy();
});

await test('shortcut submission obeys empty, busy and closed-panel guards', () => {
  const view = mount();
  view.fab.click();
  view.input.value = ' \n ';
  pressEnter(view, { ctrlKey: true });
  view.input.value = '等待回答时的草稿';
  view.input.dispatchEvent(new Event('input', { bubbles: true }));
  view.panel.showLoading();
  pressEnter(view, { metaKey: true });
  assert.equal(view.input.value, '等待回答时的草稿');
  view.panel.close();
  view.input.value = '面板关闭后的输入';
  pressEnter(view, { ctrlKey: true });
  view.form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.deepEqual(view.submitted, []);
  view.panel.destroy();
});

await test('shared confirmations retain their default focus and support safe abort cleanup', async () => {
  document.body.innerHTML = '';
  const controller = new AbortController();
  const result = confirmDestructive({
    title: '测试确认', body: '测试说明', confirmLabel: '确认', signal: controller.signal,
  });
  assert.equal(document.activeElement, document.querySelector('.deck-dialog'),
    'other callers keep the pre-existing dialog focus');
  controller.abort();
  assert.equal(await result, null);
  assert.equal(document.querySelector('.deck-overlay'), null);
  const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  document.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false);
  assert.equal(await confirmDestructive({
    title: '已过期', body: '', confirmLabel: '确认', signal: controller.signal,
  }), null);
  assert.equal(document.querySelector('.deck-overlay'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
