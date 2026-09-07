export async function requestAgent({
  page,
  questionText,
  textOrigin,
}) {
  return {
    version: 1,
    ok: true,
    source: 'mock',
    answer: `模拟 Agent 已收到第 ${page} 页文字，字符数：${questionText.length}，来源：${textOrigin}`,
  };
}