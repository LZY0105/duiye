const DEFAULT_MAX_TURNS = 6;
const MESSAGE_ROLES = new Set(['user', 'assistant']);

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

export function createAgentConversationStore({
  maxTurns = DEFAULT_MAX_TURNS,
} = {}) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new TypeError('Agent conversation maxTurns must be a positive integer.');
  }

  const conversations = new Map();

  const ensure = (sessionKey) => {
    const key = requireSessionKey(sessionKey);

    if (!conversations.has(key)) {
      conversations.set(key, {
        sessionKey: key,
        pendingRequestId: null,
        messages: [],
      });
    }

    return conversations.get(key);
  };

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

      return snapshot(conversation);
    },

    setPending(sessionKey, requestId) {
      const conversation = ensure(sessionKey);
      conversation.pendingRequestId = requestId || null;
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
  });
}