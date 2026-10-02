#!/usr/bin/env node

import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const client = await import('../src/agent/agent-client.js');

/**
 * 错误提示走真实的语言引擎，不塞一个假的 t()。
 *
 * 假的那层会让「根本没接线」的代码照样通过——它测的是替身，不是被测的模块。这里
 * 从 src/core/i18n.js 取真的词表，只有 i18n 在 setLang 里重译页面时需要 DOM，
 * 给一个查不到节点的空壳就够了，不必为它引入 jsdom。
 */
const i18n = await import('../src/core/i18n.js');

globalThis.document = globalThis.document ?? { querySelectorAll: () => [] };
await i18n.initI18n();
// detect() 按 navigator 猜起始语言；随即将它定死，免得断言跟着宿主机器走。
await i18n.setLang('zh-CN');

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

function unparsableResponse(status, ok = false) {
  return { ok, status, json: async () => { throw new Error('Unexpected token < in JSON'); } };
}

/**
 * 可控计时器：记录被排定的超时回调，由测试自己决定何时让它触发。
 *
 * 没有它就得为「响应体读到一半超时」真等 65 秒——或者更糟，为了好测而把生产超时
 * 调小，那是拿产品行为换测试便利。
 */
function manualTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimer(fn, ms) {
      const handle = { fn, ms, cleared: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle) handle.cleared = true;
    },
  };
}

/** 让已排定的微任务跑完，这样计时器触发时请求确实停在读响应体上。 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const LOCAL_CONNECT = '无法连接本地 Agent 代理，请确认代理程序已启动。';
const REMOTE_CONNECT = '无法连接 Agent 服务，请检查网络连接，稍后重试。';
const LOCAL_TIMEOUT = '本地 Agent 代理响应超时，请确认代理程序仍在运行，稍后重试。';
const REMOTE_TIMEOUT = 'Agent 服务响应超时，请检查网络连接，稍后重试。';
const MALFORMED = 'Agent 服务返回的内容异常，请重试。';
const SERVICE_UNAVAILABLE = 'Agent 服务暂时不可用，请稍后重试。';

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

await check('forwards v2 conversation messages without local metadata', async () => {
  let requestBody;

  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return jsonResponse({
      version: 2,
      ok: true,
      source: 'cpp-mock',
      answer: '后续回答',
    });
  };

  const result = await client.requestAgent({
    version: 2,
    page: 4,
    questionText: '当前页包含容斥原理公式。',
    textOrigin: 'LAYER',
    messages: [
      {
        id: 'request-1:user',
        role: 'user',
        content: '  第一个公式表示什么？  ',
        status: 'done',
      },
      {
        id: 'request-1:assistant',
        role: 'assistant',
        content: '它表示交集补集的大小。',
        status: 'done',
      },
      {
        id: 'request-2:user',
        role: 'user',
        content: '为什么符号正负交替？',
        status: 'done',
      },
    ],
  });

  assert.deepEqual(requestBody, {
    version: 2,
    page: 4,
    questionText: '当前页包含容斥原理公式。',
    messages: [
      {
        role: 'user',
        content: '第一个公式表示什么？',
      },
      {
        role: 'assistant',
        content: '它表示交集补集的大小。',
      },
      {
        role: 'user',
        content: '为什么符号正负交替？',
      },
    ],
    textOrigin: 'LAYER',
  });
  assert.equal(result.version, 2);
  assert.equal(result.answer, '后续回答');
});

console.log('\nAgent client · error classification');

await check('tells a local connection failure from a remote one', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const local = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(local.ok, false);
  assert.equal(local.answer, LOCAL_CONNECT);

  const remoteClient = client.createAgentClient({ baseUrl: 'https://agent.example.com' });
  const remote = await remoteClient.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(remote.ok, false);
  assert.equal(remote.answer, REMOTE_CONNECT);
});

await check('classifies the actual hostname instead of matching substrings', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const lookalike = client.createAgentClient({ baseUrl: 'https://localhost.example.com' });
  assert.equal(lookalike.isLocal, false, 'localhost.example.com 不是本机');
  assert.equal(
    (await lookalike.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' })).answer,
    REMOTE_CONNECT,
  );

  assert.equal(client.createAgentClient({ baseUrl: 'http://127.0.0.1:8787' }).isLocal, true);
  assert.equal(client.createAgentClient({ baseUrl: 'http://LOCALHOST:8787' }).isLocal, true);
  assert.equal(client.createAgentClient({ baseUrl: 'http://[::1]:8787' }).isLocal, true);
  assert.equal(
    client.createAgentClient({ baseUrl: 'https://agent.example.com' }).isLocal,
    false,
  );
  // 解析不出来的地址不谎称是本机。
  assert.equal(client.createAgentClient({ baseUrl: 'not a url' }).isLocal, false);
});

await check('maps every known server error code to a fixed message', async () => {
  const cases = [
    ['invalid_client_token', 401, '访问凭证无效，请联系应用维护者。'],
    ['origin_not_allowed', 403, '当前访问来源未获授权，请联系应用维护者。'],
    ['upstream_not_configured', 503, 'Agent 服务配置异常，请联系应用维护者。'],
    ['invalid_proxy_configuration', 503, 'Agent 服务配置异常，请联系应用维护者。'],
    ['upstream_timeout', 504, '模型回复超时，请稍后重试。'],
    ['upstream_unreachable', 502, 'Agent 服务暂时无法连接模型，请稍后重试。'],
    ['upstream_rejected', 502, '模型服务暂时无法处理请求，请稍后重试。'],
    ['invalid_upstream_response', 502, '模型返回的内容异常，请重试。'],
    ['history_too_large', 400, '当前页对话过长，请清空当前页对话后重试。'],
    ['invalid_messages', 400, '请求内容不符合要求，请检查后重试。'],
  ];

  for (const [error, status, expected] of cases) {
    globalThis.fetch = async () => jsonResponse(
      { version: 2, ok: false, error, message: '服务端内部细节不应展示' },
      { ok: false, status },
    );
    const result = await client.requestAgent({
      version: 2,
      page: 1,
      questionText: 'x',
      textOrigin: 'LAYER',
      messages: [{ role: 'user', content: 'q' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.answer, expected, `${error} 应映射到固定提示`);
    assert.equal(result.version, 2);
  }
});

await check('never mistakes a rejected upstream for an invalid client token', async () => {
  globalThis.fetch = async () => jsonResponse(
    { version: 1, ok: false, error: 'upstream_rejected' },
    { ok: false, status: 401 },
  );
  const result = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(result.answer, '模型服务暂时无法处理请求，请稍后重试。');
  assert.ok(!result.answer.includes('凭证'));
});

await check('falls back to the response status for unknown error codes', async () => {
  const cases = [
    [401, '访问凭证无效，请联系应用维护者。'],
    [403, '当前访问来源未获授权，请联系应用维护者。'],
    [429, '请求过于频繁，请稍后重试。'],
    [500, SERVICE_UNAVAILABLE],
    [502, SERVICE_UNAVAILABLE],
    [503, SERVICE_UNAVAILABLE],
    [404, 'Agent 请求失败，请稍后重试。'],
  ];

  for (const [status, expected] of cases) {
    globalThis.fetch = async () => jsonResponse(
      { version: 1, ok: false, error: 'error_code_from_the_future' },
      { ok: false, status },
    );
    const result = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
    assert.equal(result.answer, expected, `状态 ${status} 应给出对应提示`);
  }
});

await check('keeps the status meaning when the error body is not JSON', async () => {
  globalThis.fetch = async () => unparsableResponse(401);
  assert.equal(
    (await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' })).answer,
    '访问凭证无效，请联系应用维护者。',
  );

  // 502 返回一页 HTML：要说服务暂时不可用，而不是「响应格式不对」。
  globalThis.fetch = async () => unparsableResponse(502);
  assert.equal(
    (await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' })).answer,
    SERVICE_UNAVAILABLE,
  );
});

await check('keeps a known configuration error readable without echoing the server message', async () => {
  globalThis.fetch = async () => jsonResponse({
    version: 1,
    ok: false,
    error: 'upstream_not_configured',
    message: '本地 Agent 代理尚未配置上游模型。',
  }, { ok: false, status: 503 });

  const result = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(result.ok, false);
  assert.equal(result.answer, 'Agent 服务配置异常，请联系应用维护者。');
  assert.equal(result.source, 'cpp-proxy');
});

await check('never leaks an unknown server message or raw response body', async () => {
  const secrets = [
    'sk-live-abc123',
    'https://internal.example.com/v1/agent/answer',
    'X-Duiye-Agent-Token',
    '页面内容片段',
  ];
  globalThis.fetch = async () => jsonResponse({
    version: 1,
    ok: false,
    error: 'error_code_from_the_future',
    message: `token=${secrets[0]} url=${secrets[1]} header=${secrets[2]} body=${secrets[3]}`,
  }, { ok: false, status: 502 });

  const result = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(result.answer, SERVICE_UNAVAILABLE);
  for (const secret of secrets) {
    assert.ok(!result.answer.includes(secret), `提示里不应出现 ${secret}`);
  }
});

console.log('\nAgent client · timeout');

await check('lets a client-side timeout cover the whole request', async () => {
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };

  const local = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(local.ok, false);
  assert.equal(local.answer, LOCAL_TIMEOUT);
  assert.ok(!local.answer.includes('模型'), '客户端超时不能归因于模型故障');

  const remoteClient = client.createAgentClient({ baseUrl: 'https://agent.example.com' });
  const remote = await remoteClient.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(remote.answer, REMOTE_TIMEOUT);
  assert.ok(!remote.answer.includes('模型'));
});

await check('still times out when the headers arrive but the body never finishes', async () => {
  const timers = manualTimers();
  const bound = client.createAgentClient({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  globalThis.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });

  const pending = bound.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  await flush();

  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 65_000, '请求超时仍是 65 秒');
  assert.equal(timers.scheduled[0].cleared, false, '读到响应体之前计时器必须还在');

  timers.scheduled[0].fn();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.answer, LOCAL_TIMEOUT, '响应体读取中断不能被当成「无效响应」');
  assert.equal(timers.scheduled[0].cleared, true, '超时之后计时器同样要清理');
});

await check('clears the timer on a normal completion', async () => {
  const timers = manualTimers();
  const bound = client.createAgentClient({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  globalThis.fetch = async () => jsonResponse({ version: 1, ok: true, source: 'cpp-mock', answer: 'ok' });

  const result = await bound.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });

  assert.equal(result.answer, 'ok');
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 65_000);
  assert.equal(timers.scheduled[0].cleared, true);
});

console.log('\nAgent client · response validation');

await check('rejects a successful response without a usable answer', async () => {
  const cases = [
    { version: 1, ok: true, source: 'cpp-mock' },
    { version: 1, ok: true, answer: '   ' },
    { version: 1, ok: true, answer: 42 },
    { version: 1, ok: true, answer: null },
  ];

  for (const payload of cases) {
    globalThis.fetch = async () => jsonResponse(payload);
    const result = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
    assert.equal(result.ok, false, `${JSON.stringify(payload)} 不能被当成成功`);
    assert.equal(result.answer, MALFORMED);
  }
});

await check('reports malformed proxy replies without throwing', async () => {
  globalThis.fetch = async () => unparsableResponse(200, true);
  const result = await client.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  assert.equal(result.ok, false);
  assert.equal(result.answer, MALFORMED);
});

console.log('\nAgent client · health');

await check('reads the health state without exposing configuration details', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8787/health');
    assert.equal(options.method, 'GET');
    return jsonResponse({ version: 1, ok: true, ready: true, mode: 'upstream' });
  };
  const health = await client.getAgentProxyHealth();
  assert.deepEqual(health, { ok: true, ready: true, mode: 'upstream' });
});

await check('gives the health check its own short, body-inclusive timeout', async () => {
  const timers = manualTimers();
  const bound = client.createAgentClient({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  globalThis.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });

  const pending = bound.getAgentProxyHealth();
  await flush();

  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 3_000, '健康检查仍是 3 秒');

  timers.scheduled[0].fn();
  const health = await pending;

  assert.deepEqual(health, { ok: false, ready: false, mode: 'offline' });
  assert.equal(timers.scheduled[0].cleared, true);
});

await check('reports an unreachable proxy as offline without configuration details', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const health = await client.getAgentProxyHealth();
  assert.deepEqual(health, { ok: false, ready: false, mode: 'offline' });
});

console.log('\nAgent client · i18n');

/** 客户端能产出的全部固定提示。路由错了词表再全也没用，所以两边都要验。 */
const AGENT_ERROR_KEYS = [
  'agent.error.connectLocal',
  'agent.error.connectRemote',
  'agent.error.timeoutLocal',
  'agent.error.timeoutRemote',
  'agent.error.malformedReply',
  'agent.error.requestFailed',
  'agent.error.invalidRequest',
  'agent.error.invalidClientToken',
  'agent.error.originNotAllowed',
  'agent.error.serviceMisconfigured',
  'agent.error.upstreamTimeout',
  'agent.error.upstreamUnreachable',
  'agent.error.upstreamRejected',
  'agent.error.invalidUpstreamResponse',
  'agent.error.historyTooLarge',
  'agent.error.tooManyRequests',
  'agent.error.serviceUnavailable',
];

const LANGS = ['zh-CN', 'zh-TW', 'en'];
const packs = {};
for (const lang of LANGS) {
  packs[lang] = (await import(`../src/core/lang/${lang}.js`)).default;
}

function abortingFetch() {
  return async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  };
}

await check('ships the same agent error keys in all three languages', async () => {
  for (const lang of LANGS) {
    const keys = Object.keys(packs[lang]).filter((key) => key.startsWith('agent.')).sort();
    assert.deepEqual(keys, [...AGENT_ERROR_KEYS].sort(), `${lang} 的 agent.* 键集合应与其余语言一致`);

    for (const key of AGENT_ERROR_KEYS) {
      const text = packs[lang][key];
      assert.equal(typeof text, 'string', `${lang} 的 ${key} 不是字符串`);
      assert.ok(text.trim().length > 0, `${lang} 的 ${key} 是空的`);
      assert.ok(!text.includes('{{'), `${lang} 的 ${key} 留了没填的占位符`);
    }
  }

  // 键齐不等于翻过：把中文原样抄进另外两份也算「齐全」。
  for (const key of AGENT_ERROR_KEYS) {
    assert.notEqual(packs.en[key], packs['zh-CN'][key], `${key} 的英文与简体中文相同`);
    assert.notEqual(packs['zh-TW'][key], packs['zh-CN'][key], `${key} 的繁体与简体中文相同`);
  }
});

await check('translates every classified failure in all three languages', async () => {
  const localBound = client.createAgentClient({ baseUrl: 'http://127.0.0.1:8787' });
  const remoteBound = client.createAgentClient({ baseUrl: 'https://agent.example.com' });

  const cases = [
    { key: 'agent.error.connectLocal', fetch: () => { throw new TypeError('Failed to fetch'); } },
    { key: 'agent.error.connectRemote', remote: true, fetch: () => { throw new TypeError('Failed to fetch'); } },
    { key: 'agent.error.timeoutLocal', fetch: abortingFetch() },
    { key: 'agent.error.timeoutRemote', remote: true, fetch: abortingFetch() },
    { key: 'agent.error.malformedReply', fetch: () => jsonResponse({ version: 2, ok: true }, { status: 200 }) },
    { key: 'agent.error.requestFailed', fetch: () => jsonResponse({ ok: false, error: 'tea_pot' }, { ok: false, status: 418 }) },
    { key: 'agent.error.invalidRequest', fetch: () => jsonResponse({ ok: false, error: 'invalid_page' }, { ok: false, status: 400 }) },
    { key: 'agent.error.invalidClientToken', fetch: () => jsonResponse({ ok: false, error: 'invalid_client_token' }, { ok: false, status: 401 }) },
    { key: 'agent.error.originNotAllowed', fetch: () => jsonResponse({ ok: false, error: 'origin_not_allowed' }, { ok: false, status: 403 }) },
    { key: 'agent.error.serviceMisconfigured', fetch: () => jsonResponse({ ok: false, error: 'upstream_not_configured' }, { ok: false, status: 503 }) },
    { key: 'agent.error.upstreamTimeout', fetch: () => jsonResponse({ ok: false, error: 'upstream_timeout' }, { ok: false, status: 504 }) },
    { key: 'agent.error.upstreamUnreachable', fetch: () => jsonResponse({ ok: false, error: 'upstream_unreachable' }, { ok: false, status: 502 }) },
    { key: 'agent.error.upstreamRejected', fetch: () => jsonResponse({ ok: false, error: 'upstream_rejected' }, { ok: false, status: 502 }) },
    { key: 'agent.error.invalidUpstreamResponse', fetch: () => jsonResponse({ ok: false, error: 'invalid_upstream_response' }, { ok: false, status: 502 }) },
    { key: 'agent.error.historyTooLarge', fetch: () => jsonResponse({ ok: false, error: 'history_too_large' }, { ok: false, status: 400 }) },
    { key: 'agent.error.tooManyRequests', fetch: () => jsonResponse({ ok: false, error: 'slow_down' }, { ok: false, status: 429 }) },
    { key: 'agent.error.serviceUnavailable', fetch: () => jsonResponse({ ok: false, error: 'error_code_from_the_future' }, { ok: false, status: 503 }) },
  ];

  for (const lang of LANGS) {
    await i18n.setLang(lang);

    for (const { key, remote, fetch: stub } of cases) {
      globalThis.fetch = stub;
      const bound = remote ? remoteBound : localBound;
      const result = await bound.requestAgent({ page: 3, questionText: '这一页讲了什么', textOrigin: 'LAYER' });

      assert.equal(result.ok, false);
      assert.equal(result.answer, packs[lang][key], `${lang} 下 ${key} 的提示不对`);
    }
  }
});

await check('re-reads the language on the next failure instead of freezing it at load', async () => {
  // 同一个客户端实例连着出错三次，中间只换语言：提示必须跟着换。
  const bound = client.createAgentClient({ baseUrl: 'http://127.0.0.1:8787' });
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  await i18n.setLang('zh-CN');
  const simplified = await bound.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  await i18n.setLang('en');
  const english = await bound.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });
  await i18n.setLang('zh-TW');
  const traditional = await bound.requestAgent({ page: 1, questionText: 'x', textOrigin: 'LAYER' });

  assert.equal(simplified.answer, packs['zh-CN']['agent.error.connectLocal']);
  assert.equal(english.answer, packs.en['agent.error.connectLocal']);
  assert.equal(traditional.answer, packs['zh-TW']['agent.error.connectLocal']);
  assert.notEqual(simplified.answer, english.answer);
  assert.notEqual(english.answer, traditional.answer);
});

await i18n.setLang('zh-CN');

globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
