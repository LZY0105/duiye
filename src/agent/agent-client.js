const configuredProxyUrl = typeof import.meta !== 'undefined'
  ? import.meta.env?.VITE_AGENT_PROXY_URL
  : '';

const configuredAccessToken = typeof import.meta !== 'undefined'
  ? import.meta.env?.VITE_AGENT_ACCESS_TOKEN
  : '';

const AGENT_PROXY_URL = (configuredProxyUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 65_000;
const HEALTH_TIMEOUT_MS = 3_000;

function clientTokenHeaders() {
  return configuredAccessToken
    ? { 'X-Duiye-Agent-Token': configuredAccessToken }
    : {};
}

function failure(answer, payload = {}) {
  return {
    version: payload.version ?? 1,
    ok: false,
    source: payload.source ?? 'cpp-proxy',
    answer,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function responsePayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Checks whether the local development proxy is running and configured.
 * This endpoint intentionally never returns the upstream URL, model or key.
 */
export async function getAgentProxyHealth() {
  try {
    const response = await fetchWithTimeout(
      `${AGENT_PROXY_URL}/health`,
      {
        method: 'GET',
       headers: clientTokenHeaders(),
      },
      HEALTH_TIMEOUT_MS,
    );
    const payload = await responsePayload(response);
    if (!response.ok || !payload?.ok) return { ok: false, ready: false, mode: 'unavailable' };
    return {
      ok: true,
      ready: payload.ready === true,
      mode: typeof payload.mode === 'string' ? payload.mode : 'unknown',
    };
  } catch {
    return { ok: false, ready: false, mode: 'offline' };
  }
}

export async function requestAgent({
  version = 1,
  page,
  questionText,
  userQuestion,
  textOrigin,
}) {
  const normalizedUserQuestion = typeof userQuestion === 'string'
    ? userQuestion.trim()
    : '';

  try {
    const response = await fetchWithTimeout(`${AGENT_PROXY_URL}/v1/agent/answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...clientTokenHeaders(),
      },
      body: JSON.stringify({
        version,
        page,
        questionText,
        ...(normalizedUserQuestion
          ? { userQuestion: normalizedUserQuestion }
          : {}),
        textOrigin,
      }),
    }, REQUEST_TIMEOUT_MS);

    const payload = await responsePayload(response);
    if (!payload) return failure('本地 Agent 代理返回了无效响应。');
    if (!response.ok || !payload.ok) {
      return failure(payload.message ?? '本地 Agent 代理请求失败。', payload);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      return failure('本地 Agent 代理请求超时，请检查上游模型状态。');
    }
    return failure('无法连接本地 Agent 代理，请确认代理程序正在运行。');
  }
}