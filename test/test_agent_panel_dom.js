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
  'MouseEvent',
  'PointerEvent',
  'localStorage',
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

// ── 那颗按钮能拖 ─────────────────────────────────────────────────────────────
// jsdom 不排版：这一层当作 1000×600，按钮在右边正中（938, 276），48 见方。

const LAYER_BOX = { left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 };

function mountDraggable({ saved } = {}) {
  localStorage.clear();
  if (saved !== undefined) localStorage.setItem('ls_agent_fab', saved);
  document.body.innerHTML = '<main id="root"></main>';
  let opened = 0;
  let placed = 0;
  const panel = createAgentPanel(document.querySelector('#root'), {
    onOpen: () => { opened += 1; },
    onPlace: () => { placed += 1; },
  });
  panel.setAvailable(true);
  const layer = document.querySelector('.pdf-agent-layer');
  const fab = document.querySelector('[data-role="agent-fab"]');
  layer.getBoundingClientRect = () => LAYER_BOX;
  fab.getBoundingClientRect = () => ({ left: 938, top: 276, width: 48, height: 48, right: 986, bottom: 324 });
  const pointer = (type, x, y) => fab.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 3, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y,
  }));
  // 拖完松手之后浏览器补的那一下 click：返回 false 就是被吞了。
  const click = () => fab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return { panel, layer, fab, pointer, click, opened: () => opened, placed: () => placed };
}

await test('drag: follows the finger, snaps to the nearer side on release, remembers where', () => {
  const v = mountDraggable();
  v.pointer('pointerdown', 962, 300);
  v.pointer('pointermove', 965, 302);
  assert.ok(!v.fab.classList.contains('is-dragging'), '抖一两个像素不算拖');
  v.pointer('pointermove', 200, 150);
  assert.ok(v.fab.classList.contains('is-dragging'));
  assert.equal(v.fab.style.left, '176px', '按下去的那一点一直在手指底下');
  assert.equal(v.fab.style.top, '126px');

  v.pointer('pointerup', 200, 150);
  assert.ok(!v.fab.classList.contains('is-dragging'));
  assert.equal(v.fab.style.left, '', '松手以后交回样式表');
  assert.equal(v.fab.style.top, '');
  assert.ok(v.layer.classList.contains('is-fab-left'), '离左边近，吸到左边');
  assert.equal(v.layer.style.getPropertyValue('--agent-fab-y'), '25.000%', '高度照放下的地方：正中 150 / 600');
  assert.deepEqual(JSON.parse(localStorage.getItem('ls_agent_fab')), { side: 'left', y: 0.25 });
  assert.deepEqual(v.panel.placement(), { side: 'left', y: 0.25 });
  assert.equal(v.placed(), 1, '告诉工作区：贴边的工具栏要按新的那一边再量');

  assert.equal(v.click(), false, '拖完补的那一下 click 被吞了');
  assert.equal(v.opened(), 0, '拖一下不是点开');
  v.panel.destroy();
});

await test('drag: a press that barely moves is still a tap', () => {
  const v = mountDraggable();
  v.pointer('pointerdown', 962, 300);
  v.pointer('pointermove', 967, 303);
  v.pointer('pointerup', 967, 303);
  assert.equal(v.click(), true);
  assert.equal(v.opened(), 1);
  assert.equal(localStorage.getItem('ls_agent_fab'), null, '没拖就不记');
  assert.equal(v.placed(), 0);
  v.panel.destroy();
});

await test('drag: the click swallowed after a drag does not swallow the next tap', () => {
  const v = mountDraggable();
  v.pointer('pointerdown', 962, 300);
  v.pointer('pointermove', 600, 300);
  v.pointer('pointerup', 600, 300);
  // 这一回浏览器没补 click（手指挪远了它就不补）：下一次按下去时那个「吞」要清掉。
  v.pointer('pointerdown', 962, 300);
  v.pointer('pointerup', 962, 300);
  assert.equal(v.click(), true);
  assert.equal(v.opened(), 1);
  v.panel.destroy();
});

await test('drag: stays inside the workspace and out of the pane headers', () => {
  const v = mountDraggable();
  v.panel.setSafeArea(80, 0);
  assert.equal(v.layer.style.getPropertyValue('--agent-fab-top-min'), '94px', '栏头下面再留 14px');
  v.pointer('pointerdown', 962, 300);
  v.pointer('pointermove', 10, 5);
  assert.equal(v.fab.style.left, '14px');
  assert.equal(v.fab.style.top, '94px', '拖不进栏头');
  v.pointer('pointermove', 2000, 2000);
  assert.equal(v.fab.style.left, `${1000 - 48 - 14}px`);
  assert.equal(v.fab.style.top, `${600 - 48 - 14}px`);
  v.pointer('pointerup', 2000, 2000);
  assert.ok(!v.layer.classList.contains('is-fab-left'), '右下角：吸到右边');
  v.panel.destroy();
});

await test('drag: the layer under the finger losing its implicit capture is not the end of the drag', () => {
  // 平板上实测：手指按在图标（或液态玻璃挂的哪一层）上，浏览器把指针隐式交给那一层；拖起来时按钮把指针要过来，
  // 那一层收到 lostpointercapture、冒泡到按钮——当成松手的话，按钮只挪两个像素就吸回去了。
  const v = mountDraggable();
  const icon = v.fab.querySelector('svg');
  v.pointer('pointerdown', 962, 300);
  v.pointer('pointermove', 900, 300);
  icon.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 3, pointerType: 'touch' }));
  assert.ok(v.fab.classList.contains('is-dragging'), '还在拖');
  v.pointer('pointermove', 300, 200);
  assert.equal(v.fab.style.left, '276px', '接着跟手');
  // 按钮自己丢了指针（系统把这一下收走了）才算完。
  v.fab.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 3, pointerType: 'touch' }));
  assert.ok(!v.fab.classList.contains('is-dragging'));
  assert.ok(v.layer.classList.contains('is-fab-left'));
  v.panel.destroy();
});

await test('drag: a remembered place comes back; a broken record falls back to the middle of the right edge', () => {
  let v = mountDraggable({ saved: JSON.stringify({ side: 'left', y: 0.3 }) });
  assert.ok(v.layer.classList.contains('is-fab-left'));
  assert.equal(v.layer.style.getPropertyValue('--agent-fab-y'), '30.000%');
  v.panel.destroy();

  v = mountDraggable({ saved: '{not json' });
  assert.ok(!v.layer.classList.contains('is-fab-left'));
  assert.equal(v.layer.style.getPropertyValue('--agent-fab-y'), '50.000%');
  assert.deepEqual(v.panel.placement(), { side: 'right', y: 0.5 });
  v.panel.destroy();

  v = mountDraggable({ saved: JSON.stringify({ side: 'top', y: 0.3 }) });
  assert.deepEqual(v.panel.placement(), { side: 'right', y: 0.5 }, '只认左右两边');
  v.panel.destroy();
  localStorage.clear();
});

await test('drag: the button keeps the browser from taking the gesture and is placed with left / top', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/styles/pdf.css', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const at = css.indexOf('.pdf-agent-fab {');
  const rule = css.slice(at, css.indexOf('\n}', at));
  assert.ok(/touch-action: none;/.test(rule), '拖到一半不能被当成滚动收走');
  assert.ok(/left: calc\(100% - 48px - var\(--agent-fab-right, 14px\)\);/.test(rule), '两边都用 left 写，吸过去才有一个属性可以动');
  assert.ok(/calc\(var\(--agent-fab-y, 50%\) - 24px\)/.test(rule));
  assert.ok(!/translateY\(-50%\)/.test(rule), '不靠 transform 居中：液态玻璃把它的 transform 设成 none');
  assert.ok(/\.pdf-agent-layer\.is-fab-left \.pdf-agent-fab \{ left: var\(--agent-fab-left, 14px\); \}/.test(css));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;