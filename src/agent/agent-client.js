const AGENT_PROXY_URL = 'http://127.0.0.1:8787';

export async function requestAgent({
  version = 1,
  page,
  questionText,
  textOrigin,
}) {
  try {
    const response = await fetch(`${AGENT_PROXY_URL}/v1/agent/answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version,
        page,
        questionText,
        textOrigin,
      }),
    });

    let payload;

    try {
      payload = await response.json();
    } catch {
      return {
        version: 1,
        ok: false,
        source: 'cpp-proxy',
        answer: '本地 Agent 代理返回了无效响应。',
      };
    }

    if (!response.ok || !payload.ok) {
      return {
        version: payload.version ?? 1,
        ok: false,
        source: payload.source ?? 'cpp-proxy',
        answer: payload.message ?? '本地 Agent 代理请求失败。',
      };
    }

    return payload;
  } catch {
    return {
      version: 1,
      ok: false,
      source: 'cpp-proxy',
      answer: '无法连接本地 Agent 代理，请确认代理程序正在运行。',
    };
  }
}
