// 把答案匹配的计算交给原生层——如果那一侧接上了的话。
//
// 这个文件是**契约**。C++ 那一侧要实现的东西长什么样，由这里规定；反过来说，
// 照着这里实现出来的东西，一定能插进去。
//
// ── 为什么留这个口 ────────────────────────────────────────────────────────
//
// 匹配引擎现在是纯 JS（question-matcher.js 连带二十来个模块），在四本真实教材上
// 508/508 零错误。它不慢，但它是**逐题** O(候选数) 的字符串比对：一本 2986 页的
// 习题册整本跑一遍，在平板上要等。以后把这段搬到 C++ 是一条明确的路。
//
// 留口而不是等到那天再改，是因为那天要动的地方不止一处：matchQuestion 是同步调
// 用 matchPage 的，换成跨 JNI 就变异步，而它上下全是闸门逻辑。现在把这一步先做
// 成异步、把契约钉死、用假实现测过，那天就只剩下写 C++。
//
// ── 闸门不经过这一层 ──────────────────────────────────────────────────────
//
// 这是整件事最要紧的一条。matching-engine.js 开头写着它存在的理由：把
// 「角色 → 配对身份 → 文本质量 → 索引 → 匹配」这个顺序收在一处，因为它散到调用
// 方之后，实测有 52/60 的错书组合拿到了 HIGH 置信度的答案。
//
// 所以原生实现拿到的是**已经过闸**的输入，交回来的是**还要再过一次闸**的输出：
//
//   · 它收到 pairStatus，但那是给它做参考的，不是让它去判断的
//   · 它交回来的每一条结论，JS 都会用 applyPairPermissions 再钳一次
//
// 也就是说：一个写错了的、甚至怀有恶意的原生实现，最多只能让答案变差，不能让
// 一个未经确认的配对给出 AUTO_MATCH。这条性质由 JS 保证，不指望 C++ 自觉。
//
// ── 契约 ──────────────────────────────────────────────────────────────────
//
// 服务名 "match"，op "matchPage"。载荷是 JSON（桥不解析，两头各自读）。
//
// 请求：
//   {
//     questions: [{ label, text, page, ... }],   // 这一页上的题
//     answerIndex: {                             // 答案册的索引
//       entries: [{ label, text, page, ... }],
//       byLabel: { "1.1.55": [下标, ...] },      // Map 序列化成普通对象
//       quality: "USABLE" | "DEGRADED" | "OPAQUE",
//     },
//     alignment: { ... },        // alignOutlines 的结果
//     exercisePage: 31,
//     answerPageCount: 313,
//     questionCount: 508,
//     pairStatus: "VERIFIED_PAIR" | "UNKNOWN_PAIR",
//     formulaPolicy: "STRICT",
//     limits: { ... },
//   }
//
// 回复（done）：
//   { matches: [{ rung, matched, asserted, confidence, question, answer,
//                 region, cappedBy, reasonCodes }] }
//
// rung 取 RUNG 里那五个之一。形状要和 JS 那份 matchPage 返回的一致——判据不是
// 「跑得通」，是 test/ 下那几套回归换了实现之后照样全绿。
//
// chunk：可以按题一条一条先交回来（Sink 支持），但现在的调用方不消费中间结果，
// 整页一次交回也完全成立。

import { PROXY_SERVICES, PROXY_ERRORS, request } from '../native/native-proxy.js';
import { describeProxy } from '../native/native-proxy.js';

/** 原生那一位接上了没有。上层用它决定要不要把计算交下去。 */
export async function nativeMatcherReady() {
  const { loaded, services } = await describeProxy();
  return loaded && services.some((s) => s?.name === PROXY_SERVICES.MATCH && s.ready === true);
}

/**
 * 造一个符合 matching-engine 的 matcher 契约的对象。
 *
 * 签名和 JS 那份 matchPage 一样，只是返回 Promise：
 *
 *   matcher(questions, answerIndex, options) -> Promise<match[]>
 *
 * 直接传给 preparePair({ matcher })。原生那一位没接上时，`request` 会以
 * UNIMPLEMENTED 拒绝，而 matching-engine 收到拒绝会退回 JS 实现——所以把它接上
 * 是安全的，哪怕 C++ 那侧还没写。
 */
export function createNativeMatcher({ onChunk = null } = {}) {
  return function matchPageNatively(questions, answerIndex, options = {}) {
    // signal 和 limits 里可能有函数、AbortSignal 这类过不了 JSON 的东西，
    // 挑着送。桥那一侧真正要用的就是下面这些。
    const payload = {
      questions,
      answerIndex: serializeIndex(answerIndex),
      alignment: options.alignment ?? null,
      exercisePage: options.exercisePage ?? null,
      answerPageCount: options.answerPageCount ?? null,
      questionCount: options.questionCount ?? null,
      pairStatus: options.pairStatus ?? null,
      formulaPolicy: options.formulaPolicy ?? null,
      limits: options.limits ?? {},
    };

    const pending = request({
      service: PROXY_SERVICES.MATCH,
      op: 'matchPage',
      payload,
      onChunk,
    });

    // 上层把 AbortSignal 一路传下来，到这里变成「撤回这件活」。
    options.signal?.addEventListener?.('abort', () => pending.cancel(), { once: true });

    return pending.then((result) => {
      const matches = result?.matches;
      if (!Array.isArray(matches)) {
        // 形状不对当作没接上，让上层退回 JS 实现。比返回一个半截结果安全：
        // 半截结果会一路走到界面上，而界面分不出「引擎说没有」和「引擎坏了」。
        const error = new Error('原生匹配返回的不是 { matches: [...] }');
        error.code = PROXY_ERRORS.UNIMPLEMENTED;
        throw error;
      }
      return matches;
    });
  };
}

/**
 * 索引里的 Map 过不了 JSON，转成普通对象。
 *
 * byLabel 是 label → 条目列表。JS 那边用 Map 是因为它在热路径上被查几百次；
 * 跨桥只需要形状对。
 */
function serializeIndex(index) {
  if (!index) return null;
  const byLabel = index.byLabel instanceof Map
    ? Object.fromEntries(index.byLabel)
    : (index.byLabel ?? null);
  return { ...index, byLabel };
}
