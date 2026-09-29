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

// ── 持久化 ────────────────────────────────────────────────────────────────
//
// Node 里没有 localStorage，所以这些用例注入自己的 storage。它刻意只实现
// getItem / setItem 两个方法——store 也只能依赖这两个，否则 test_pdf_workspace
// 里那个只有三个方法的假 localStorage 就会把它绊倒。

const AGENT_STORAGE_KEY = 'ls_agent_conversations';

function createFakeStorage() {
  const data = new Map();
  const state = { failWrites: false };

  return {
    data,
    state,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (state.failWrites) throw new Error('storage quota exceeded');
      data.set(key, String(value));
    },
    /** 落盘的那份载荷，没写过就是 null。 */
    stored: () => {
      const raw = data.get(AGENT_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function appendTurn(store, sessionKey, question, answer) {
  store.append(sessionKey, { role: 'user', content: question });
  store.append(sessionKey, { role: 'assistant', content: answer });
}

test('restores a completed conversation in a fresh store', () => {
  const storage = createFakeStorage();
  const key = createAgentSessionKey('document-a', 4);

  const first = createAgentConversationStore({ storage });
  first.append(key, {
    id: 'request-1:user',
    role: 'user',
    content: '解释这个公式',
    status: 'done',
  });
  first.append(key, {
    id: 'request-1:assistant',
    role: 'assistant',
    content: '这是容斥原理。',
    status: 'done',
  });

  const second = createAgentConversationStore({ storage });

  assert.deepEqual(second.get(key).messages, [
    { role: 'user', content: '解释这个公式' },
    { role: 'assistant', content: '这是容斥原理。' },
  ]);

  // id、status 这类只对当前这一屏有意义的东西不进存储。
  const raw = JSON.stringify(storage.stored());
  assert.equal(raw.includes('"status"'), false);
  assert.equal(raw.includes('"id"'), false);
  assert.equal(raw.includes('pendingRequestId'), false);
});

test('keeps restored document and page conversations isolated', () => {
  const storage = createFakeStorage();
  const page4 = createAgentSessionKey('document-a', 4);
  const page5 = createAgentSessionKey('document-a', 5);
  const otherDoc = createAgentSessionKey('document-b', 4);

  const first = createAgentConversationStore({ storage });
  appendTurn(first, page4, '这一页的问题', '这一页的回答');

  const second = createAgentConversationStore({ storage });
  assert.equal(second.get(page4).messages.length, 2);
  assert.equal(second.get(page5).messages.length, 0);
  assert.equal(second.get(otherDoc).messages.length, 0);
});

test('does not restore a pending request after a reload', () => {
  const storage = createFakeStorage();
  const key = createAgentSessionKey('document-a', 4);

  const first = createAgentConversationStore({ storage });
  appendTurn(first, key, '第一问', '第一答');
  first.setPending(key, 'request-1');
  assert.equal(first.get(key).pendingRequestId, 'request-1');

  const second = createAgentConversationStore({ storage });

  assert.equal(second.get(key).pendingRequestId, null);
  assert.equal(JSON.stringify(storage.stored()).includes('request-1'), false);
});

test('does not persist a user message that has no answer yet', () => {
  const storage = createFakeStorage();
  const key = createAgentSessionKey('document-a', 4);

  const store = createAgentConversationStore({ storage });
  appendTurn(store, key, '第一问', '第一答');
  store.append(key, { role: 'user', content: '还在等回答的问题' });

  // 内存里它必须留着——请求正挂在它身上。
  assert.deepEqual(
    store.get(key).messages.map((message) => message.content),
    ['第一问', '第一答', '还在等回答的问题'],
  );
  assert.deepEqual(
    storage.stored().sessions[0].messages.map((message) => message.content),
    ['第一问', '第一答'],
  );

  const second = createAgentConversationStore({ storage });
  assert.deepEqual(
    second.get(key).messages.map((message) => message.content),
    ['第一问', '第一答'],
  );
});

test('ignores corrupt storage without failing to start', () => {
  const key = createAgentSessionKey('document-a', 4);

  for (const raw of [
    '{not json',
    JSON.stringify({ version: 99, sessions: [] }),
    JSON.stringify({ sessions: [] }),
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ version: 1, sessions: 'nope' }),
  ]) {
    const storage = createFakeStorage();
    storage.data.set(AGENT_STORAGE_KEY, raw);

    const store = createAgentConversationStore({ storage });
    assert.equal(
      store.get(key).messages.length,
      0,
      `bad payload must not be half-applied: ${raw}`,
    );

    // 而且坏数据之后会话照常可用，第一次写入会把它整个盖掉。
    appendTurn(store, key, '新问题', '新回答');
    assert.equal(
      createAgentConversationStore({ storage }).get(key).messages.length,
      2,
    );
  }
});

test('ignores illegal sessions, roles and empty content on load', () => {
  const key = createAgentSessionKey('document-a', 4);
  const validKey = createAgentSessionKey('document-a', 5);
  const storage = createFakeStorage();

  storage.data.set(AGENT_STORAGE_KEY, JSON.stringify({
    version: 1,
    sessions: [
      {
        sessionKey: key,
        updatedAt: 3,
        messages: [
          { role: 'system', content: '不能由客户端加入系统消息' },
          { role: 'user', content: '   ' },
          { role: 'assistant', content: '' },
        ],
      },
      { sessionKey: '', updatedAt: 4, messages: [] },
      { sessionKey: validKey, messages: 'nope' },
      {
        sessionKey: validKey,
        updatedAt: 5,
        messages: [
          { role: 'user', content: '  合法问题  ' },
          { role: 'assistant', content: '合法回答' },
        ],
      },
    ],
  }));

  const store = createAgentConversationStore({ storage });

  assert.equal(store.get(key).messages.length, 0);
  assert.deepEqual(store.get(validKey).messages, [
    { role: 'user', content: '合法问题' },
    { role: 'assistant', content: '合法回答' },
  ]);
});

test('applies maxTurns to restored history', () => {
  const storage = createFakeStorage();
  const key = createAgentSessionKey('document-a', 4);

  const first = createAgentConversationStore({ storage, maxTurns: 2 });
  for (let turn = 1; turn <= 3; turn += 1) {
    appendTurn(first, key, `问题 ${turn}`, `回答 ${turn}`);
  }

  const second = createAgentConversationStore({ storage, maxTurns: 2 });

  assert.deepEqual(
    second.get(key).messages.map((message) => message.content),
    ['问题 2', '回答 2', '问题 3', '回答 3'],
  );
});

test('keeps the memory conversation alive when storage writes fail', () => {
  const storage = createFakeStorage();
  const key = createAgentSessionKey('document-a', 4);

  const store = createAgentConversationStore({ storage });
  appendTurn(store, key, '第一问', '第一答');
  storage.state.failWrites = true;

  assert.doesNotThrow(() => appendTurn(store, key, '第二问', '第二答'));
  assert.equal(store.get(key).messages.length, 4);
  assert.doesNotThrow(() => store.get(key));
  assert.doesNotThrow(() => store.clear(key));
  assert.equal(store.get(key).messages.length, 0);

  // 写不进去的时候磁盘还停在最后一次成功的那一份。
  assert.deepEqual(
    storage.stored().sessions[0].messages.map((message) => message.content),
    ['第一问', '第一答'],
  );
});

test('falls back to a memory-only store when storage is unavailable', () => {
  for (const storage of [null, {}, { getItem: () => null }]) {
    const store = createAgentConversationStore({ storage });
    const key = createAgentSessionKey('document-a', 4);

    appendTurn(store, key, '问题', '回答');
    assert.equal(store.get(key).messages.length, 2);
    assert.deepEqual(store.clear(key).messages, []);
  }
});

test('clear removes one conversation and persists the removal', () => {
  const storage = createFakeStorage();
  const key = createAgentSessionKey('document-a', 4);
  const neighbour = createAgentSessionKey('document-b', 7);

  const store = createAgentConversationStore({ storage });
  appendTurn(store, key, '要清掉的问题', '要清掉的回答');
  appendTurn(store, neighbour, '邻居的问题', '邻居的回答');

  const cleared = store.clear(key);
  assert.equal(cleared.sessionKey, key);
  assert.equal(cleared.pendingRequestId, null);
  assert.deepEqual(cleared.messages, []);

  const reloaded = createAgentConversationStore({ storage });
  assert.equal(reloaded.get(key).messages.length, 0);
  assert.equal(reloaded.get(key).pendingRequestId, null);
  assert.deepEqual(
    reloaded.get(neighbour).messages.map((message) => message.content),
    ['邻居的问题', '邻居的回答'],
  );
  assert.equal(storage.stored().sessions.length, 1);
});

test('keeps only the newest 32 sessions', () => {
  const storage = createFakeStorage();
  const store = createAgentConversationStore({ storage });
  const keys = [];

  for (let page = 1; page <= 40; page += 1) {
    const key = createAgentSessionKey('big-book', page);
    keys.push(key);
    appendTurn(store, key, `问题 ${page}`, `回答 ${page}`);
  }

  assert.equal(storage.stored().sessions.length, 32);

  const reloaded = createAgentConversationStore({ storage });
  assert.equal(reloaded.get(keys[39]).messages.length, 2, '最新的一页还在');
  assert.equal(reloaded.get(keys[8]).messages.length, 2, '边界上的那一页还在');
  assert.equal(reloaded.get(keys[7]).messages.length, 0, '最旧的一批已经淘汰');
  assert.equal(reloaded.get(keys[0]).messages.length, 0, '最早的那一页已经淘汰');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;