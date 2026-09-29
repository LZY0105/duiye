const DEFAULT_MAX_TURNS = 6;
const MESSAGE_ROLES = new Set(['user', 'assistant']);

/**
 * 版本化的存储键。
 *
 * 和 document-session.js 的 ls_pdf_doc_views 同一套约定：键名固定，版本写在
 * 载荷里。读到不认识的版本时整份丢弃，而不是半读半用。
 */
const STORAGE_KEY = 'ls_agent_conversations';
const STORAGE_VERSION = 1;

/**
 * 最多留多少个文档页的会话。
 *
 * 一次读一本书，翻过的页都算一个会话；给足够多的余量，超出后淘汰最久没写
 * 过的那一个，所以它不会在 localStorage 里无限长。
 */
const MAX_SESSIONS = 32;

export function createAgentSessionKey(documentId, page) {
  const normalizedDocumentId = String(documentId ?? '').trim();
  const normalizedPage = Number(page);

  if (!normalizedDocumentId) {
    throw new TypeError('Agent session requires a document ID.');
  }
  if (!Number.isInteger(normalizedPage) || normalizedPage < 1) {
    throw new TypeError('Agent session requires a positive page number.');
  }

  // JSON 数组编码避免文档 ID 自身包含分隔符时发生碰撞。
  return JSON.stringify([normalizedDocumentId, normalizedPage]);
}

function requireSessionKey(sessionKey) {
  const key = String(sessionKey ?? '').trim();
  if (!key) throw new TypeError('Agent conversation requires a session key.');
  return key;
}

function snapshot(conversation) {
  return {
    sessionKey: conversation.sessionKey,
    pendingRequestId: conversation.pendingRequestId,
    messages: conversation.messages.map((message) => ({ ...message })),
  };
}

function trimHistory(messages, maxTurns) {
  const limit = maxTurns * 2;
  if (messages.length <= limit) return messages;

  const retained = messages.slice(-limit);

  // 历史必须从用户问题开始，不能留下失去问题的孤立回答。
  while (retained[0]?.role === 'assistant') retained.shift();

  return retained;
}

/**
 * 一条消息里真正属于"对话"的部分。
 *
 * 内存里的消息还带着 id、status 这些只对当前这一屏有意义的东西——落盘时要
 * 把它们剥掉，读回来时也不认它们。role 不是 user/assistant、content 不是非空
 * 字符串的，一律当作没有。
 */
function toStoredMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (!MESSAGE_ROLES.has(message.role)) return null;

  const content = typeof message.content === 'string'
    ? message.content.trim()
    : '';
  if (!content) return null;

  return { role: message.role, content };
}

/**
 * 只留下成对的 user → assistant。
 *
 * 末尾那条还没得到回答的 user 消息不进这里——它是一次正在飞的请求，刷新之后
 * 不能假装它已经被回答过。孤立的 assistant、连续两条 user，同样丢掉。
 */
function completeTurns(messages) {
  if (!Array.isArray(messages)) return [];

  const turns = [];

  for (let index = 0; index < messages.length; index += 1) {
    const question = toStoredMessage(messages[index]);
    if (!question || question.role !== 'user') continue;

    const answer = toStoredMessage(messages[index + 1]);
    if (!answer || answer.role !== 'assistant') continue;

    turns.push(question, answer);
    index += 1;
  }

  return turns;
}

function isUsableStorage(candidate) {
  return Boolean(candidate)
    && typeof candidate.getItem === 'function'
    && typeof candidate.setItem === 'function';
}

/**
 * 拿得到的 localStorage，或者 null。
 *
 * 沙箱里的 iframe 读这个属性本身就可能抛 SecurityError，所以连取属性都要包
 * 起来。拿不到就是纯内存模式：会话照常可用，只是不跨刷新。
 */
function resolveStorage(storage) {
  if (storage !== undefined) {
    return isUsableStorage(storage) ? storage : null;
  }

  try {
    return isUsableStorage(globalThis.localStorage)
      ? globalThis.localStorage
      : null;
  } catch (_) {
    return null;
  }
}

export function createAgentConversationStore({
  maxTurns = DEFAULT_MAX_TURNS,
  storage,
} = {}) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new TypeError('Agent conversation maxTurns must be a positive integer.');
  }

  const backing = resolveStorage(storage);
  const conversations = new Map();

  /**
   * 单调不减的写入时刻。
   *
   * 同一毫秒里连着写十几个会话时 Date.now() 会给出同一个数，32 条上限淘汰谁
   * 就成了看 Map 的顺序。加一个递增计数当平局判据，淘汰顺序才确定。
   */
  let lastUpdatedAt = 0;
  const nextUpdatedAt = () => {
    lastUpdatedAt = Math.max(Date.now(), lastUpdatedAt + 1);
    return lastUpdatedAt;
  };

  const restore = () => {
    if (!backing) return;

    let parsed = null;
    try {
      const raw = backing.getItem(STORAGE_KEY);
      if (typeof raw !== 'string' || !raw) return;
      parsed = JSON.parse(raw);
    } catch (_) {
      // 坏 JSON、存储不可用：当作没有历史，而不是让整个面板起不来。
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.version !== STORAGE_VERSION) return;
    if (!Array.isArray(parsed.sessions)) return;

    const restored = [];

    for (const entry of parsed.sessions) {
      if (!entry || typeof entry !== 'object') continue;

      let sessionKey = '';
      try {
        sessionKey = requireSessionKey(entry.sessionKey);
      } catch (_) {
        continue;
      }

      const messages = trimHistory(
        completeTurns(entry.messages),
        maxTurns,
      );
      if (messages.length === 0) continue;

      restored.push({
        sessionKey,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
        messages,
      });
    }

    restored.sort((a, b) => b.updatedAt - a.updatedAt);

    for (const entry of restored.slice(0, MAX_SESSIONS)) {
      conversations.set(entry.sessionKey, {
        sessionKey: entry.sessionKey,
        pendingRequestId: null,
        updatedAt: entry.updatedAt,
        messages: entry.messages,
      });
      lastUpdatedAt = Math.max(lastUpdatedAt, entry.updatedAt);
    }
  };

  const persist = () => {
    if (!backing) return;

    const sessions = [];

    for (const conversation of conversations.values()) {
      // 只写完整的轮次：末尾那条还在等回答的 user 消息留在内存里，不进这里。
      const messages = completeTurns(conversation.messages);
      if (messages.length === 0) continue;

      sessions.push({
        sessionKey: conversation.sessionKey,
        updatedAt: conversation.updatedAt,
        messages,
      });
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    let payload = '';
    try {
      payload = JSON.stringify({
        version: STORAGE_VERSION,
        sessions: sessions.slice(0, MAX_SESSIONS),
      });
    } catch (_) {
      return;
    }

    try {
      backing.setItem(STORAGE_KEY, payload);
    } catch (_) {
      // 超额、隐私模式、配额被别的模块吃光——内存会话继续用。
    }
  };

  const evictOldest = () => {
    while (conversations.size > MAX_SESSIONS) {
      let oldestKey = null;
      let oldestAt = Infinity;

      for (const conversation of conversations.values()) {
        if (conversation.updatedAt < oldestAt) {
          oldestAt = conversation.updatedAt;
          oldestKey = conversation.sessionKey;
        }
      }

      if (oldestKey === null) return;
      conversations.delete(oldestKey);
    }
  };

  const ensure = (sessionKey) => {
    const key = requireSessionKey(sessionKey);

    if (!conversations.has(key)) {
      conversations.set(key, {
        sessionKey: key,
        pendingRequestId: null,
        updatedAt: 0,
        messages: [],
      });
    }

    return conversations.get(key);
  };

  restore();

  return Object.freeze({
    get(sessionKey) {
      return snapshot(ensure(sessionKey));
    },

    append(sessionKey, message = {}) {
      if (!MESSAGE_ROLES.has(message.role)) {
        throw new TypeError('Agent message role must be user or assistant.');
      }

      const content = String(message.content ?? '').trim();
      if (!content) {
        throw new TypeError('Agent message content must not be empty.');
      }

      const conversation = ensure(sessionKey);
      conversation.messages.push({
        ...message,
        role: message.role,
        content,
      });
      conversation.messages = trimHistory(
        conversation.messages,
        maxTurns,
      );
      conversation.updatedAt = nextUpdatedAt();
      evictOldest();
      persist();

      return snapshot(conversation);
    },

    setPending(sessionKey, requestId) {
      const conversation = ensure(sessionKey);
      conversation.pendingRequestId = requestId || null;
      // pending 只属于这一屏：它不落盘，所以这里也不产生一次写。
      return snapshot(conversation);
    },

    clearPending(sessionKey, requestId = null) {
      const conversation = ensure(sessionKey);

      if (
        requestId === null
        || conversation.pendingRequestId === requestId
      ) {
        conversation.pendingRequestId = null;
      }

      return snapshot(conversation);
    },

    clear(sessionKey) {
      const key = requireSessionKey(sessionKey);
      conversations.delete(key);
      persist();

      return {
        sessionKey: key,
        pendingRequestId: null,
        messages: [],
      };
    },
  });
}
