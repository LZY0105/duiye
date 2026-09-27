#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  createAgentConversationStore,
  createAgentSessionKey,
} from '../src/agent/agent-conversation.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

test('builds a stable key from document ID and page', () => {
  assert.equal(
    createAgentSessionKey('document-a', 4),
    '["document-a",4]',
  );
  assert.notEqual(
    createAgentSessionKey('document-a', 4),
    createAgentSessionKey('document-a', 5),
  );
  assert.notEqual(
    createAgentSessionKey('document-a', 4),
    createAgentSessionKey('document-b', 4),
  );

  assert.throws(() => createAgentSessionKey('', 4), /document ID/);
  assert.throws(() => createAgentSessionKey('document-a', 0), /page number/);
});

test('starts each page conversation empty', () => {
  const store = createAgentConversationStore();

  assert.deepEqual(store.get('document-a::page-4'), {
    sessionKey: 'document-a::page-4',
    pendingRequestId: null,
    messages: [],
  });
});

test('keeps document and page conversations isolated', () => {
  const store = createAgentConversationStore();

  store.append('document-a::page-4', {
    role: 'user',
    content: '解释这个公式',
  });
  store.append('document-a::page-4', {
    role: 'assistant',
    content: '这是容斥原理。',
  });

  assert.equal(store.get('document-a::page-4').messages.length, 2);
  assert.equal(store.get('document-a::page-5').messages.length, 0);
  assert.equal(store.get('document-b::page-4').messages.length, 0);
});

test('returns snapshots that cannot mutate stored history', () => {
  const store = createAgentConversationStore();

  store.append('document-a::page-4', {
    role: 'user',
    content: '原始问题',
  });

  const copy = store.get('document-a::page-4');
  copy.messages[0].content = '被外部修改';
  copy.messages.push({ role: 'assistant', content: '伪造回答' });

  const stored = store.get('document-a::page-4');
  assert.equal(stored.messages.length, 1);
  assert.equal(stored.messages[0].content, '原始问题');
});

test('keeps only the newest complete turns', () => {
  const store = createAgentConversationStore({ maxTurns: 2 });
  const key = 'document-a::page-4';

  for (let turn = 1; turn <= 3; turn += 1) {
    store.append(key, { role: 'user', content: `问题 ${turn}` });
    store.append(key, { role: 'assistant', content: `回答 ${turn}` });
  }

  assert.deepEqual(
    store.get(key).messages.map((message) => message.content),
    ['问题 2', '回答 2', '问题 3', '回答 3'],
  );
});

test('does not let an old request clear a newer request', () => {
  const store = createAgentConversationStore();
  const key = 'document-a::page-4';

  store.setPending(key, 'request-old');
  store.setPending(key, 'request-new');
  store.clearPending(key, 'request-old');

  assert.equal(store.get(key).pendingRequestId, 'request-new');

  store.clearPending(key, 'request-new');
  assert.equal(store.get(key).pendingRequestId, null);
});

test('rejects invalid roles and empty content', () => {
  const store = createAgentConversationStore();

  assert.throws(
    () => store.append('document-a::page-4', {
      role: 'system',
      content: '不能由客户端加入系统消息',
    }),
    /role/,
  );

  assert.throws(
    () => store.append('document-a::page-4', {
      role: 'user',
      content: '   ',
    }),
    /content/,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;