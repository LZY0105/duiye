#!/usr/bin/env node

import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const client = await import('../src/agent/agent-client.js');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

console.log('Agent client');

await check('forwards the page payload to the loopback proxy', async () => {
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return jsonResponse({ version: 1, ok: true, source: 'cpp-mock', answer: 'ok' });
  };

  const result = await client.requestAgent({
    page: 7,
    questionText: '求导数',
    textOrigin: 'LAYER',
  });

  assert.equal(seen.url, 'http://127.0.0.1:8787/v1/agent/answer');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.options.body), {
    version: 1,
    page: 7,
    questionText: '求导数',
    textOrigin: 'LAYER',
  });
  assert.deepEqual(result, { version: 1, ok: true, source: 'cpp-mock', answer: 'ok' });
});

await check('forwards a trimmed custom question separately from page text', async () => {
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return jsonResponse({
      version: 1,
      ok: true,
      source: 'cpp-mock',
      answer: '100 摄氏度',
    });
  };

  const result = await client.requestAgent({
    page: 3,
    questionText: '水在标准大气压下的沸点是 100 摄氏度。',
    userQuestion: '  水的沸点是多少？  ',
    textOrigin: 'LAYER',
  });

  assert.deepEqual(requestBody, {
    version: 1,
    page: 3,
    questionText: '水在标准大气压下的沸点是 100 摄氏度。',
    userQuestion: '水的沸点是多少？',
    textOrigin: 'LAYER',
  });
  assert.equal(result.answer, '100 摄氏度');
});

await check('keeps a configured proxy error readable to the user', async () => {
  globalThis.fetch = async () => jsonResponse({
    version: 1,
    ok: false,
    error: 'upstream_not_configured',
    message: '本地 Agent 代理尚未配置上游模型。',
  }, { ok: false, status: 503 });

  const result = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(result.ok, false);
  assert.equal(result.answer, '本地 Agent 代理尚未配置上游模型。');
  assert.equal(result.source, 'cpp-proxy');
});

await check('reports malformed proxy replies without throwing', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } });
  const result = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(result.ok, false);
  assert.equal(result.answer, '本地 Agent 代理返回了无效响应。');
});

await check('reports an aborted request as a timeout', async () => {
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  const result = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(result.ok, false);
  assert.equal(result.answer, '本地 Agent 代理请求超时，请检查上游模型状态。');
});

await check('reads the health state without exposing configuration details', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8787/health');
    assert.equal(options.method, 'GET');
    return jsonResponse({ version: 1, ok: true, ready: true, mode: 'upstream' });
  };
  const health = await client.getAgentProxyHealth();
  assert.deepEqual(health, { ok: true, ready: true, mode: 'upstream' });
});

globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;