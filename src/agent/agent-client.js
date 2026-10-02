import { t } from '../core/i18n.js';

const configuredProxyUrl = typeof import.meta !== 'undefined'
  ? import.meta.env?.VITE_AGENT_PROXY_URL
  : '';

const configuredAccessToken = typeof import.meta !== 'undefined'
  ? import.meta.env?.VITE_AGENT_ACCESS_TOKEN
  : '';

const DEFAULT_PROXY_URL = 'http://127.0.0.1:8787';

const AGENT_PROXY_URL = (configuredProxyUrl || DEFAULT_PROXY_URL).replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 65_000;
const HEALTH_TIMEOUT_MS = 3_000;
const MAX_HISTORY_MESSAGES = 12;

/**
 * 只有真正指向本机的地址才算本地。
 *
 * 用 URL 解析出来的 hostname 比，不做子串匹配——`localhost.example.com` 里含有
 * `localhost`，按子串判会把它当成本机，而它其实是一台远程主机，提示词也就跟着错。
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * 面向用户的固定提示，存的是翻译键而不是译文。
 *
 * 译文必须在出错那一刻才取：模块只加载一次，而用户随时可以在设置里换语言。把
 * t() 的结果放进模块级常量，等于在加载时把当时的语言定死，换语言之后这里会一直
 * 说着旧语言。
 */
const ERROR_KEYS = {
  connectLocal: 'agent.error.connectLocal',
  connectRemote: 'agent.error.connectRemote',
  timeoutLocal: 'agent.error.timeoutLocal',
  timeoutRemote: 'agent.error.timeoutRemote',
  malformedReply: 'agent.error.malformedReply',
  requestFailed: 'agent.error.requestFailed',
  invalidRequest: 'agent.error.invalidRequest',
  invalidClientToken: 'agent.error.invalidClientToken',
  originNotAllowed: 'agent.error.originNotAllowed',
  serviceMisconfigured: 'agent.error.serviceMisconfigured',
  upstreamTimeout: 'agent.error.upstreamTimeout',
  upstreamUnreachable: 'agent.error.upstreamUnreachable',
  upstreamRejected: 'agent.error.upstreamRejected',
  invalidUpstreamResponse: 'agent.error.invalidUpstreamResponse',
  historyTooLarge: 'agent.error.historyTooLarge',
  tooManyRequests: 'agent.error.tooManyRequests',
  serviceUnavailable: 'agent.error.serviceUnavailable',
};

/**
 * 服务端已知的错误码。
 *
 * 这些是唯一的权威分类依据；服务端的 `message` 一律不展示——它可能带着令牌、
 * 内网地址或页面内容，而且措辞会随版本漂移。未知错误码落到响应状态兜底。
 */
const ERROR_CODE_KEYS = {
  invalid_client_token: ERROR_KEYS.invalidClientToken,
  origin_not_allowed: ERROR_KEYS.originNotAllowed,
  upstream_not_configured: ERROR_KEYS.serviceMisconfigured,
  invalid_proxy_configuration: ERROR_KEYS.serviceMisconfigured,
  upstream_timeout: ERROR_KEYS.upstreamTimeout,
  upstream_unreachable: ERROR_KEYS.upstreamUnreachable,
  upstream_rejected: ERROR_KEYS.upstreamRejected,
  invalid_upstream_response: ERROR_KEYS.invalidUpstreamResponse,
  history_too_large: ERROR_KEYS.historyTooLarge,
  invalid_json: ERROR_KEYS.invalidRequest,
  invalid_version: ERROR_KEYS.invalidRequest,
  invalid_page: ERROR_KEYS.invalidRequest,
  invalid_question_text: ERROR_KEYS.invalidRequest,
  invalid_text_origin: ERROR_KEYS.invalidRequest,
  invalid_user_question: ERROR_KEYS.invalidRequest,
  invalid_messages: ERROR_KEYS.invalidRequest,
  invalid_message: ERROR_KEYS.invalidRequest,
  invalid_message_role: ERROR_KEYS.invalidRequest,
  invalid_message_content: ERROR_KEYS.invalidRequest,
  invalid_message_order: ERROR_KEYS.invalidRequest,
  unsupported_content_type: ERROR_KEYS.invalidRequest,
};

/**
 * 取一条提示的译文，并把助手名称按当前语言代入。
 *
 * 名称会出现在句子中间（"关闭页问后…"），所以不能把名称拼进语言文件的值里；不带
 * 占位符的键也会走这里，多给的变量被 t() 忽略。
 */
function errorMessage(key) {
  return t(key, { name: t('agent.name') });
}

function isLocalAddress(baseUrl) {
  try {
    // WHATWG URL 会把 IPv6 主机写成 `[::1]`，方括号要剥掉再比。
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return LOCAL_HOSTNAMES.has(hostname);
  } catch {
    // 解析不出来的一律当作远程：宁可用更保守的远程措辞，也不谎称是本机。
    return false;
  }
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  let normalized = messages
    .filter((message) => (
      (message?.role === 'user' || message?.role === 'assistant')
      && message?.status !== 'error'
    ))
    .map((message) => ({
      role: message.role,
      content: String(message.content ?? '').trim(),
    }))
    .filter((message) => Boolean(message.content))
    .slice(-MAX_HISTORY_MESSAGES);

  // 上下文不能从失去对应问题的孤立回答开始。
  while (normalized[0]?.role === 'assistant') {
    normalized = normalized.slice(1);
  }

  return normalized;
}

function failure(answer, payload = {}) {
  return {
    version: payload.version ?? 1,
    ok: false,
    source: payload.source ?? 'cpp-proxy',
    answer,
  };
}

function hasAnswer(payload) {
  return typeof payload?.answer === 'string' && payload.answer.trim() !== '';
}

/**
 * 一个失败响应该说什么。
 *
 * 顺序是：已知错误码 → 响应状态 → 兜底。状态这一层必须独立于响应体是否存在，
 * 否则 502 返回一页 HTML 时会退化成「响应格式不对」，把「服务暂时不可用」这个
 * 真正有用的信息丢掉。
 */
function failureMessage(responseOk, status, payload) {
  const code = typeof payload?.error === 'string' ? payload.error : '';
  if (Object.prototype.hasOwnProperty.call(ERROR_CODE_KEYS, code)) {
    return errorMessage(ERROR_CODE_KEYS[code]);
  }

  if (status === 401) return errorMessage(ERROR_KEYS.invalidClientToken);
  if (status === 403) return errorMessage(ERROR_KEYS.originNotAllowed);
  if (status === 429) return errorMessage(ERROR_KEYS.tooManyRequests);
  if (status >= 500) return errorMessage(ERROR_KEYS.serviceUnavailable);
  if (responseOk || (status >= 200 && status < 300)) return errorMessage(ERROR_KEYS.malformedReply);
  return errorMessage(ERROR_KEYS.requestFailed);
}

function defaultFetch(url, options) {
  return globalThis.fetch(url, options);
}

/**
 * 一个绑定了地址、超时与计时器的客户端。
 *
 * 工厂存在的理由是测试：要证明超时覆盖到响应体读取，就不能真等 65 秒，只能把
 * 计时器换成可控的。生产代码走下面的默认实例，调用方式没有变化。
 */
export function createAgentClient({
  baseUrl = AGENT_PROXY_URL,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
  accessToken = configuredAccessToken,
  fetchImpl = defaultFetch,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  const endpoint = String(baseUrl ?? '').replace(/\/+$/, '');
  const local = isLocalAddress(endpoint);

  const tokenHeaders = () => (
    accessToken ? { 'X-Duiye-Agent-Token': accessToken } : {}
  );

  /**
   * 发请求并把响应体一并读完，全程受同一个计时器管辖。
   *
   * 计时器在读到响应头之后不能解除：那时正文还没来，剩下的下载同样可能永远不结
   * 束。读正文期间被 abort 打断的 AbortError 要原样抛出去，它是超时，不是「响应
   * 格式不对」。
   */
  async function readJson(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });

      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }

      return { response, payload };
    } finally {
      clearTimer(timer);
    }
  }

  async function getAgentProxyHealth() {
    try {
      const { response, payload } = await readJson(
        `${endpoint}/health`,
        {
          method: 'GET',
          headers: tokenHeaders(),
        },
        healthTimeoutMs,
      );

      if (!response.ok || !payload?.ok) {
        return { ok: false, ready: false, mode: 'unavailable' };
      }

      return {
        ok: true,
        ready: payload.ready === true,
        mode: typeof payload.mode === 'string' ? payload.mode : 'unknown',
      };
    } catch {
      return { ok: false, ready: false, mode: 'offline' };
    }
  }

  async function requestAgent({
    version = 1,
    page,
    questionText,
    userQuestion,
    messages,
    textOrigin,
  }) {
    const normalizedUserQuestion = typeof userQuestion === 'string'
      ? userQuestion.trim()
      : '';

    const normalizedMessages = normalizeMessages(messages);

    try {
      const { response, payload } = await readJson(`${endpoint}/v1/agent/answer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...tokenHeaders(),
        },
        body: JSON.stringify({
          version,
          page,
          questionText,
          ...(version === 2
            ? { messages: normalizedMessages }
            : normalizedUserQuestion
              ? { userQuestion: normalizedUserQuestion }
              : {}),
          textOrigin,
        }),
      }, requestTimeoutMs);

      if (!response.ok || payload?.ok !== true) {
        return failure(failureMessage(response.ok, response.status, payload), payload ?? {});
      }

      // 200 不等于成功：缺 answer 的响应一旦放过去，界面会拿 undefined 当回答。
      if (!hasAnswer(payload)) return failure(errorMessage(ERROR_KEYS.malformedReply), payload);

      return payload;
    } catch (error) {
      // 浏览器的连接异常分不出断网、跨域、证书还是服务故障，所以两种提示都不说
      // 死原因，只给出用户能采取的动作。
      if (error?.name === 'AbortError') {
        return failure(errorMessage(local ? ERROR_KEYS.timeoutLocal : ERROR_KEYS.timeoutRemote));
      }
      return failure(errorMessage(local ? ERROR_KEYS.connectLocal : ERROR_KEYS.connectRemote));
    }
  }

  return Object.freeze({
    baseUrl: endpoint,
    isLocal: local,
    requestAgent,
    getAgentProxyHealth,
  });
}

const defaultClient = createAgentClient();

export const requestAgent = defaultClient.requestAgent;
export const getAgentProxyHealth = defaultClient.getAgentProxyHealth;
