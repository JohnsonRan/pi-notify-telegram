const net = require("node:net");
const path = require("node:path");
const { PROTOCOL_VERSION, attachLineReader, sendLine } = require("../bridge/protocol.cjs");
const { pruneExpiredBrokerState, queuePersist, readBrokerState, trimMappings } = require("./state.cjs");
const { formatWakeExitDetail, normalizePiCommands } = require("../telegram/control.cjs");
const { escapeHtml, renderTelegramChunkPairs, renderTelegramHtml, splitMarkdown } = require("../telegram/format.cjs");
const { AGENT_DIR } = require("../shared/paths.cjs");
const { errorMessage, telegramCall, telegramFormattedCall } = require("../telegram/api.cjs");
const {
  deliverPendingForSession,
  enqueueStream,
  pollTelegram,
  releaseWakeFollowups,
  syncTelegramCommandMenu,
  withTopicRetry,
  __test: telegramRouterTest,
} = require("../telegram/router.cjs");
const { WakeLauncher } = require("../wake/launcher.cjs");
const { version: PACKAGE_VERSION } = require("../../package.json");

const STATE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function sendNotification(state, client, message) {
  const title = String(message.title || "Pi").slice(0, 256);
  const body = String(message.body || "");
  const sessionId = String(message.sessionId || client.sessionId);
  const bodySources = splitMarkdown(body, 3200);
  const bodyHtml = bodySources.map(renderTelegramHtml);
  const sent = await withTopicRetry(
    state,
    sessionId,
    message.cwd || client.cwd,
    message.sessionName || client.sessionName,
    async (topic) => {
      let result;
      for (let index = 0; index < bodyHtml.length; index += 1) {
        const first = index === 0;
        const last = index === bodyHtml.length - 1;
        const html = first
          ? `<b>${escapeHtml(title)}</b>${bodyHtml[index] ? `\n\n${bodyHtml[index]}` : ""}`
          : bodyHtml[index];
        const plain = first
          ? `${title}${bodySources[index] ? `\n\n${bodySources[index]}` : ""}`
          : bodySources[index];
        result = await telegramFormattedCall(state.secret, "sendMessage", {
          chat_id: state.secret.chatId,
          message_thread_id: topic.threadId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: !state.secret.linkPreview },
          ...(last ? {
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Reply to Pi...",
            },
          } : {}),
        }, plain);
      }
      return { result, topic };
    },
  );
  const topic = sent.topic;
  const sentMessage = sent.result;
  const mapping = {
    messageId: sentMessage.message_id,
    threadId: topic.threadId,
    sessionId,
    cwd: String(message.cwd || client.cwd),
    createdAt: Date.now(),
  };
  state.mappings.set(mapping.messageId, mapping);
  trimMappings(state);
  await queuePersist(state);
  return sentMessage;
}

function handleStreamRequest(state, client, message) {
  if (!client.registered || message.sessionId !== client.sessionId || !Number.isSafeInteger(message.draftId)) {
    return Promise.reject(new Error("Invalid stream request"));
  }
  const text = String(message.text || "");
  return enqueueStream(state, client.sessionId, () => withTopicRetry(
    state,
    client.sessionId,
    client.cwd,
    client.sessionName,
    async (topic) => {
      if (message.type === "streamDraft") {
        const sourceChunks = splitMarkdown(text);
        const tail = sourceChunks[sourceChunks.length - 1] || "";
        const preview = sourceChunks.length > 1 ? `…${tail}` : tail;
        const html = renderTelegramHtml(preview);
        await telegramFormattedCall(state.secret, "sendMessageDraft", {
          chat_id: state.secret.chatId,
          message_thread_id: topic.threadId,
          draft_id: message.draftId,
          text: html,
          ...(html ? { parse_mode: "HTML" } : {}),
        }, preview);
        return;
      }
      if (message.type === "streamFinal" && text.trim()) {
        const chunks = renderTelegramChunkPairs(text);
        for (const chunk of chunks) {
          await telegramFormattedCall(state.secret, "sendMessage", {
            chat_id: state.secret.chatId,
            message_thread_id: topic.threadId,
            text: chunk.html,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: !state.secret.linkPreview },
          }, chunk.source);
        }
      }
    },
  ));
}

function schedulePendingRetry(state, pending) {
  if (pending.retryTimer) return;
  pending.retryCount = (pending.retryCount || 0) + 1;
  if (pending.retryCount > 5) {
    state.pendingReplies.delete(pending.deliveryId);
    queuePersist(state).catch(() => {});
    telegramCall(state.secret, "sendMessage", {
      chat_id: state.secret.chatId,
      ...(Number.isSafeInteger(pending.threadId) ? { message_thread_id: pending.threadId } : {}),
      text: "Pi could not accept this reply after several retries. Please send it again.",
    }).catch((error) => console.warn(`[pi-notify-telegram] Cannot report failed reply: ${errorMessage(error)}`));
    return;
  }
  queuePersist(state).catch(() => {});
  const delay = Math.min(8_000, 500 * 2 ** (pending.retryCount - 1));
  pending.retryTimer = setTimeout(() => {
    pending.retryTimer = undefined;
    if (state.pendingReplies.has(pending.deliveryId) && !deliverPendingReply(state, pending)) {
      schedulePendingRetry(state, pending);
    }
  }, delay);
  pending.retryTimer.unref?.();
}

function handleBrokerRequest(state, client, message) {
  if (!message || message.auth !== state.secret.bridgeSecret) {
    client.socket.destroy(new Error("Telegram bridge authentication failed"));
    return;
  }
  if (message.type === "register") {
    if (message.version !== PROTOCOL_VERSION || typeof message.clientId !== "string" || typeof message.sessionId !== "string") {
      client.socket.destroy(new Error("Invalid Telegram bridge registration"));
      return;
    }
    client.clientId = message.clientId;
    client.sessionId = message.sessionId;
    client.cwd = typeof message.cwd === "string" ? message.cwd : "";
    client.sessionName = typeof message.sessionName === "string" ? message.sessionName : "";
    client.wakeChild = message.wakeChild === true;
    client.commands = normalizePiCommands(message.commands);
    const previousCommands = state.sessionCommands.get(client.sessionId);
    const commandsChanged = JSON.stringify(previousCommands || []) !== JSON.stringify(client.commands);
    state.sessionCommands.set(client.sessionId, client.commands);
    const topic = state.topics.get(client.sessionId);
    if (topic && commandsChanged) {
      topic.commands = client.commands;
      queuePersist(state).catch(() => {});
      syncTelegramCommandMenu(state).catch((error) => console.warn(`[pi-notify-telegram] Cannot sync bot commands: ${errorMessage(error)}`));
    }
    client.registered = true;
    if (!client.wakeChild && state.wakeReservations.has(client.sessionId)) {
      state.wakeLauncher.cancel(client.sessionId);
      state.wakeReservations.delete(client.sessionId);
    }
    for (const [registeredSessionId, registeredClient] of state.clientsBySession) {
      if (registeredClient === client && registeredSessionId !== client.sessionId) state.clientsBySession.delete(registeredSessionId);
    }
    const previous = state.clientsBySession.get(client.sessionId);
    if (previous && previous !== client) previous.socket.destroy();
    state.clients.set(client.clientId, client);
    state.clientsBySession.set(client.sessionId, client);
    sendLine(client.socket, { type: "registered", version: PROTOCOL_VERSION });
    if (client.wakeChild) deliverPendingForSession(state, client.sessionId);
    else releaseWakeFollowups(state, client.sessionId);
    return;
  }
  if (message.type === "replyAck" && client.registered && typeof message.deliveryId === "string") {
    const pending = state.pendingReplies.get(message.deliveryId);
    if (!pending || pending.sessionId !== client.sessionId) return;
    if (message.ok === true) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
      state.pendingReplies.delete(message.deliveryId);
      for (const [messageId, mapping] of state.mappings) {
        if (messageId === pending.notificationMessageId ||
            (mapping.sessionId === pending.sessionId &&
             (!pending.threadId || mapping.threadId === pending.threadId) &&
             mapping.createdAt <= pending.createdAt)) {
          state.mappings.delete(messageId);
        }
      }
      queuePersist(state).catch((error) => console.warn(`[pi-notify-telegram] Cannot persist reply ACK: ${errorMessage(error)}`));
    } else {
      schedulePendingRetry(state, pending);
    }
    return;
  }
  if (message.type === "streamDraft") {
    handleStreamRequest(state, client, message).catch((error) => {
      console.warn(`[pi-notify-telegram] Draft stream failed: ${errorMessage(error)}`);
    });
    return;
  }
  if (message.type === "streamFinal") {
    if (typeof message.requestId !== "string") return;
    handleStreamRequest(state, client, message).then(() => {
      if (client.wakeChild) releaseWakeFollowups(state, client.sessionId);
      sendLine(client.socket, { type: "result", requestId: message.requestId, ok: true });
    }).catch((error) => {
      sendLine(client.socket, { type: "result", requestId: message.requestId, ok: false, error: errorMessage(error) });
    });
    return;
  }
  if (message.type !== "notify" || !client.registered || typeof message.requestId !== "string") return;

  sendNotification(state, client, message).then((sent) => {
    sendLine(client.socket, { type: "result", requestId: message.requestId, ok: true, messageId: sent.message_id });
  }).catch((error) => {
    sendLine(client.socket, { type: "result", requestId: message.requestId, ok: false, error: errorMessage(error) });
  });
}

function closeLeader(state) {
  if (state.closePromise) return state.closePromise;
  state.closed = true;
  state.pollController?.abort();
  if (state.cleanupTimer) clearInterval(state.cleanupTimer);
  for (const pending of state.pendingReplies.values()) {
    if (pending.retryTimer) clearTimeout(pending.retryTimer);
  }
  const sockets = new Set([...state.clients.values()].map((client) => client.socket));
  for (const socket of sockets) socket.destroy();
  state.clients.clear();
  state.clientsBySession.clear();
  state.closePromise = new Promise((resolve, reject) => {
    if (!state.server.listening) {
      resolve();
      return;
    }
    state.server.close((error) => error ? reject(error) : resolve());
    state.server.closeAllConnections?.();
  });
  return state.closePromise;
}

async function startLocalLeader(secret) {
  const server = net.createServer({ pauseOnConnect: true });
  const acquired = await new Promise((resolve, reject) => {
    const onBindError = (error) => {
      if (error?.code === "EADDRINUSE") resolve(false);
      else reject(error);
    };
    server.once("error", onBindError);
    server.listen(secret.port, "127.0.0.1", () => {
      server.off("error", onBindError);
      resolve(true);
    });
  });
  if (!acquired) return undefined;

  let stored;
  try {
    stored = await readBrokerState();
  } catch (error) {
    server.close();
    throw error;
  }
  const state = {
    secret,
    pid: process.pid,
    packageVersion: PACKAGE_VERSION,
    startedAt: Date.now(),
    offset: stored.offset,
    mappings: new Map(stored.mappings.map((item) => [item.messageId, item])),
    pendingReplies: new Map(stored.pendingReplies.map((item) => [item.deliveryId, item])),
    topics: new Map(stored.topics.map((item) => [item.sessionId, item])),
    sessionCommands: new Map(stored.topics.map((item) => [item.sessionId, Array.isArray(item.commands) ? item.commands : []])),
    commandMenuSignature: undefined,
    topicPromises: new Map(),
    streamQueues: new Map(),
    clients: new Map(),
    clientsBySession: new Map(),
    wakeReservations: new Set(),
    foregroundStartups: new Set(),
    wakeLauncher: undefined,
    persistQueue: Promise.resolve(),
    cleanupTimer: undefined,
    pollController: undefined,
    closePromise: undefined,
    closed: false,
    server,
  };
  state.wakeLauncher = new WakeLauncher({
    piCommand: secret.wakePiCommand,
    piCommandArgs: secret.wakePiCommandArgs,
    openTerminal: secret.wakeOpenTerminal,
    terminalSpecDir: path.join(AGENT_DIR, "terminal-launches"),
    onExit: async ({ sessionId, code, signal, cancelled, stderr }) => {
      if (state.foregroundStartups.has(sessionId)) return;
      state.wakeReservations.delete(sessionId);
      if (code === 0 || cancelled) return;
      const topic = state.topics.get(sessionId);
      if (!topic) return;
      const detail = formatWakeExitDetail(stderr);
      await sendBrokerText(state, [
        `Background Pi exited before completing (${signal || `code ${code}`}).`,
        ...(detail ? ["", detail] : []),
      ].join("\n"), { threadId: topic.threadId });
    },
  });
  pruneExpiredBrokerState(state);
  queuePersist(state).catch((error) => console.warn(`[pi-notify-telegram] Cannot normalize state: ${errorMessage(error)}`));
  state.cleanupTimer = setInterval(() => {
    if (pruneExpiredBrokerState(state)) {
      queuePersist(state).catch((error) => console.warn(`[pi-notify-telegram] Cannot clean state: ${errorMessage(error)}`));
    }
  }, STATE_CLEANUP_INTERVAL_MS);
  state.cleanupTimer.unref?.();

  server.on("connection", (socket) => {
    socket.setNoDelay(true);
    const client = { socket, registered: false };
    attachLineReader(socket, (message) => handleBrokerRequest(state, client, message), () => socket.destroy());
    socket.on("close", () => {
      if (client.clientId && state.clients.get(client.clientId) === client) state.clients.delete(client.clientId);
      if (client.sessionId && state.clientsBySession.get(client.sessionId) === client) {
        state.clientsBySession.delete(client.sessionId);
        if (!state.topics.has(client.sessionId)) state.sessionCommands.delete(client.sessionId);
      }
    });
    socket.on("error", () => {});
    socket.resume();
  });
  server.on("error", (error) => console.warn(`[pi-notify-telegram] Broker error: ${errorMessage(error)}`));
  server.on("close", () => {
    state.closed = true;
    if (state.cleanupTimer) clearInterval(state.cleanupTimer);
  });
  server.unref?.();
  syncTelegramCommandMenu(state).catch((error) => console.warn(`[pi-notify-telegram] Cannot sync bot commands: ${errorMessage(error)}`));
  pollTelegram(state).catch((error) => console.warn(`[pi-notify-telegram] Poller stopped: ${errorMessage(error)}`));
  return state;
}

module.exports = Object.freeze({
  closeLeader,
  startLocalLeader,
  __test: Object.freeze({ enqueueStream, ...telegramRouterTest }),
});
