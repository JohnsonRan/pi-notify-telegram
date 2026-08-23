#!/usr/bin/env node

/**
 * Telegram companion for pi-notify.
 *
 * Pi processes share one localhost broker. The broker owns Telegram long polling,
 * while each connected Pi process injects replies with pi.sendUserMessage().
 */

const { spawn } = require("node:child_process");
const { createHash, randomInt, randomUUID } = require("node:crypto");
const { readFile, writeFile, rename } = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const {
  escapeHtml,
  renderTelegramChunks,
  renderTelegramHtml,
  splitMarkdown,
} = require("./format.cjs");
const { WakeLauncher, parseControlCommand, resolveWakeCwd } = require("./wake.cjs");

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent");
const SECRET_PATH = path.join(AGENT_DIR, "pi-notify-telegram.secret");
const CONFIG_PATH = path.join(AGENT_DIR, "pi-notify-telegram.json");
const STATE_PATH = path.join(AGENT_DIR, "pi-notify-telegram.state.json");
const DAEMON_PATH = path.join(__dirname, "..", "daemon.cjs");
const DEFAULT_PORT = 43871;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_MAPPINGS = 200;
const MAX_PENDING_REPLIES = 1000;
const MAX_TOPICS = 2000;
const REQUEST_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 3_000;
const PROTOCOL_VERSION = 2;
const STREAM_THROTTLE_MS = 300;
const DELIVERY_DEDUPE_MAX = 512;
const STATE_ENTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const clientStates = new WeakMap();
const attachedApis = new WeakSet();
let localLeaderPromise;
let daemonLaunchPromise;

const CONTROL_COMMANDS = Object.freeze([
  { command: "new", description: "Create a new Pi session" },
  { command: "sessions", description: "List known Pi sessions" },
  { command: "status", description: "Show the Pi wake broker status" },
  { command: "help", description: "Show Telegram wake commands" },
]);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizePiCommands(commands) {
  const used = new Set(CONTROL_COMMANDS.map((item) => item.command));
  const result = [];
  for (const item of Array.isArray(commands) ? commands : []) {
    const name = String(item?.name || "").trim();
    if (!name || name === "telegram-wake") continue;
    const normalized = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
    let telegramName = normalized || `pi_${hash}`;
    if (telegramName.length > 32 || used.has(telegramName)) {
      telegramName = `${(normalized || "pi").slice(0, 25)}_${hash}`.slice(0, 32);
    }
    let suffix = 1;
    const base = telegramName.slice(0, 29);
    while (used.has(telegramName)) telegramName = `${base}_${suffix++}`.slice(0, 32);
    used.add(telegramName);
    const description = String(item?.description || `${item?.source || "Pi"} command: /${name}`)
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 256) || `Run /${name}`;
    result.push({ name, telegramName, description, source: String(item?.source || "extension") });
    if (result.length >= 96) break;
  }
  return result;
}

function translateTelegramCommand(topic, text) {
  const value = String(text || "");
  const match = value.match(/^\/([^\s@]+)(?:@\w+)?([\s\S]*)$/);
  if (!match) return value;
  const command = Array.isArray(topic?.commands)
    ? topic.commands.find((item) => item.telegramName === match[1] || item.name === match[1])
    : undefined;
  return command ? `/${command.name}${match[2] || ""}` : value;
}

function asInteger(value, name) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} must be a safe integer`);
  return number;
}

function validateSettings(botTokenValue, raw) {
  const botToken = String(botTokenValue || "").trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error("Telegram bot token is invalid");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Telegram config must be a JSON object");
  const chatId = asInteger(raw.chatId, "chatId");
  const allowedUserId = asInteger(raw.allowedUserId ?? chatId, "allowedUserId");
  const bridgeSecret = String(raw.bridgeSecret || "").trim();
  if (!/^[a-f0-9]{32,128}$/i.test(bridgeSecret)) throw new Error("bridgeSecret is invalid");
  const port = raw.port === undefined ? DEFAULT_PORT : asInteger(raw.port, "port");
  if (port < 1024 || port > 65535) throw new Error("port must be between 1024 and 65535");
  const linkPreview = raw.linkPreview === true;
  const wakeMode = raw.wakeMode === true;
  const wakeDefaultCwd = String(raw.wakeDefaultCwd || "").trim();
  const wakeAllowedRoots = Array.isArray(raw.wakeAllowedRoots)
    ? raw.wakeAllowedRoots.map((root) => String(root || "").trim()).filter(Boolean)
    : [];
  if (wakeMode && wakeAllowedRoots.length === 0) throw new Error("wakeAllowedRoots must contain at least one directory when wakeMode is enabled");
  const wakePiCommand = String(raw.wakePiCommand || "pi").trim() || "pi";
  const wakePiCommandArgs = Array.isArray(raw.wakePiCommandArgs)
    ? raw.wakePiCommandArgs.map((argument) => String(argument))
    : [];
  return Object.freeze({
    botToken,
    chatId,
    allowedUserId,
    bridgeSecret,
    port,
    linkPreview,
    wakeMode,
    wakeDefaultCwd,
    wakeAllowedRoots: Object.freeze(wakeAllowedRoots),
    wakePiCommand,
    wakePiCommandArgs: Object.freeze(wakePiCommandArgs),
  });
}

async function readSecret() {
  let token;
  let configText;
  try {
    [token, configText] = await Promise.all([readFile(SECRET_PATH, "utf8"), readFile(CONFIG_PATH, "utf8")]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Telegram setup is incomplete. Run the installed pi-notify-telegram setup.cjs first.");
    }
    throw error;
  }
  try {
    return validateSettings(token, JSON.parse(configText));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Telegram config contains invalid JSON: ${CONFIG_PATH}`);
    throw error;
  }
}

async function telegramCall(secret, method, payload, timeoutMs = 20_000) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${secret.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Telegram ${method} failed: ${errorMessage(error)}`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram ${method} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || result?.ok !== true) {
    throw new Error(`Telegram ${method} failed: ${result?.description || `HTTP ${response.status}`}`);
  }
  return result.result;
}

async function telegramFormattedCall(secret, method, payload, plainText) {
  try {
    return await telegramCall(secret, method, payload);
  } catch (error) {
    if (!payload.parse_mode || !/Bad Request|parse entities|unsupported.*tag|can't find end tag/i.test(errorMessage(error))) throw error;
    const fallback = { ...payload, text: String(plainText ?? "") };
    delete fallback.parse_mode;
    return telegramCall(secret, method, fallback);
  }
}

function sendLine(socket, value) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function attachLineReader(socket, onMessage, onError) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
      socket.destroy(new Error("Telegram bridge frame is too large"));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (error) {
        onError(error);
      }
    }
  });
}

async function readBrokerState() {
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, "utf8"));
    const offset = Number.isSafeInteger(raw?.offset) && raw.offset >= 0 ? raw.offset : 0;
    const mappings = Array.isArray(raw?.mappings)
      ? raw.mappings
          .filter((item) => item && Number.isSafeInteger(item.messageId) && Number.isSafeInteger(item.threadId) && typeof item.sessionId === "string")
          .slice(-MAX_MAPPINGS)
      : [];
    const pendingReplies = Array.isArray(raw?.pendingReplies)
      ? raw.pendingReplies.filter((item) => item && typeof item.deliveryId === "string" && typeof item.sessionId === "string" && typeof item.text === "string").slice(-MAX_PENDING_REPLIES)
      : [];
    const topics = Array.isArray(raw?.topics)
      ? raw.topics.filter((item) => item && typeof item.sessionId === "string" && Number.isSafeInteger(item.threadId)).slice(-MAX_TOPICS)
      : [];
    return { offset, mappings, pendingReplies, topics };
  } catch (error) {
    if (error?.code === "ENOENT") return { offset: 0, mappings: [], pendingReplies: [], topics: [] };
    if (error instanceof SyntaxError) throw new Error(`Telegram state contains invalid JSON: ${STATE_PATH}`, { cause: error });
    throw error;
  }
}

async function persistBrokerState(state) {
  const temporary = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  const mappings = [...state.mappings.values()].slice(-MAX_MAPPINGS);
  const pendingReplies = [...state.pendingReplies.values()]
    .slice(-MAX_PENDING_REPLIES)
    .map(({ retryTimer: _retryTimer, ...item }) => item);
  const topics = [...state.topics.values()].slice(-MAX_TOPICS);
  await writeFile(temporary, `${JSON.stringify({ offset: state.offset, mappings, pendingReplies, topics }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_PATH);
}

function queuePersist(state) {
  state.persistQueue = state.persistQueue
    .catch(() => {})
    .then(() => persistBrokerState(state));
  return state.persistQueue;
}

function trimMappings(state) {
  while (state.mappings.size > MAX_MAPPINGS) {
    state.mappings.delete(state.mappings.keys().next().value);
  }
}

function pruneExpiredBrokerState(state, now = Date.now()) {
  const cutoff = now - STATE_ENTRY_RETENTION_MS;
  let changed = false;
  for (const [messageId, mapping] of state.mappings) {
    if (Number.isFinite(mapping.createdAt) && mapping.createdAt < cutoff) {
      state.mappings.delete(messageId);
      changed = true;
    }
  }
  for (const [deliveryId, pending] of state.pendingReplies) {
    if (Number.isFinite(pending.createdAt) && pending.createdAt < cutoff) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
      state.pendingReplies.delete(deliveryId);
      changed = true;
    }
  }
  return changed;
}

function topicName(sessionId, cwd, sessionName) {
  const base = String(sessionName || path.basename(String(cwd || "")) || "Pi").replace(/[\r\n\u0000-\u001f]+/g, " ").trim();
  return `${base || "Pi"} · ${String(sessionId).slice(0, 8)}`.slice(0, 128);
}

async function ensureTopic(state, sessionId, cwd, sessionName) {
  const existing = state.topics.get(sessionId);
  if (existing) return existing;
  const inflight = state.topicPromises.get(sessionId);
  if (inflight) return inflight;

  const promise = (async () => {
    if (state.topics.size >= MAX_TOPICS) throw new Error(`Telegram topic limit reached (${MAX_TOPICS})`);
    const created = await telegramCall(state.secret, "createForumTopic", {
      chat_id: state.secret.chatId,
      name: topicName(sessionId, cwd, sessionName),
    });
    const topic = {
      sessionId,
      threadId: created.message_thread_id,
      name: created.name,
      cwd: String(cwd || ""),
      commands: state.sessionCommands.get(sessionId) || [],
      createdAt: Date.now(),
    };
    state.topics.set(sessionId, topic);
    await queuePersist(state);
    syncTelegramCommandMenu(state).catch((error) => console.warn(`[pi-notify-telegram] Cannot sync bot commands: ${errorMessage(error)}`));
    return topic;
  })().finally(() => state.topicPromises.delete(sessionId));
  state.topicPromises.set(sessionId, promise);
  return promise;
}

function isStaleTopicError(error) {
  return /message thread not found|topic.*(?:closed|not found|deleted)|thread.*not found/i.test(errorMessage(error));
}

async function withTopicRetry(state, sessionId, cwd, sessionName, operation) {
  let topic = await ensureTopic(state, sessionId, cwd, sessionName);
  try {
    return await operation(topic);
  } catch (error) {
    if (!isStaleTopicError(error)) throw error;
    state.topics.delete(sessionId);
    await queuePersist(state);
    topic = await ensureTopic(state, sessionId, cwd, sessionName);
    return operation(topic);
  }
}

function findReplyTarget(state, message) {
  const threadId = message?.message_thread_id;
  if (Number.isSafeInteger(threadId)) {
    const topic = [...state.topics.values()].find((candidate) => candidate.threadId === threadId);
    if (topic) {
      const mapping = [...state.mappings.values()].reverse().find((candidate) => candidate.threadId === threadId);
      return mapping || { sessionId: topic.sessionId, threadId, createdAt: Date.now() };
    }
  }
  const replyId = message?.reply_to_message?.message_id;
  if (Number.isSafeInteger(replyId) && state.mappings.has(replyId)) return state.mappings.get(replyId);
  return undefined;
}

function splitTelegramText(value) {
  return splitMarkdown(value);
}

function enqueueStream(state, sessionId, task) {
  const previous = state.streamQueues.get(sessionId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  state.streamQueues.set(sessionId, next);
  next.finally(() => {
    if (state.streamQueues.get(sessionId) === next) state.streamQueues.delete(sessionId);
  });
  return next;
}

function connectedTarget(state, sessionId) {
  const client = state.clientsBySession.get(sessionId);
  return client?.registered && !client.socket.destroyed ? client : undefined;
}

function deliverPendingReply(state, pending) {
  const client = connectedTarget(state, pending.sessionId);
  if (!client) return false;
  sendLine(client.socket, { type: "reply", ...pending });
  return true;
}

function deliverPendingForSession(state, sessionId) {
  for (const pending of state.pendingReplies.values()) {
    if (pending.sessionId === sessionId && !pending.holdForWake) deliverPendingReply(state, pending);
  }
}

async function syncTelegramCommandMenu(state) {
  const commands = state.secret.wakeMode ? [...CONTROL_COMMANDS] : [];
  const seen = new Set(commands.map((item) => item.command));
  for (const topic of state.topics.values()) {
    for (const item of Array.isArray(topic.commands) ? topic.commands : []) {
      if (seen.has(item.telegramName) || commands.length >= 100) continue;
      seen.add(item.telegramName);
      commands.push({ command: item.telegramName, description: item.description.slice(0, 48) });
    }
  }
  let published = commands;
  for (;;) {
    const signature = JSON.stringify(published);
    if (signature === state.commandMenuSignature) return;
    try {
      await telegramCall(state.secret, "setMyCommands", {
        scope: { type: "chat", chat_id: state.secret.chatId },
        commands: published,
      });
      state.commandMenuSignature = signature;
      return;
    } catch (error) {
      if (!/BOT_COMMANDS_TOO_MUCH/i.test(errorMessage(error)) || published.length <= CONTROL_COMMANDS.length + 10) throw error;
      published = published.slice(0, Math.max(CONTROL_COMMANDS.length, published.length - 10));
    }
  }
}

async function sendBrokerText(state, text, options = {}) {
  return telegramCall(state.secret, "sendMessage", {
    chat_id: state.secret.chatId,
    text: String(text),
    link_preview_options: { is_disabled: true },
    ...(Number.isSafeInteger(options.threadId) ? { message_thread_id: options.threadId } : {}),
    ...(Number.isSafeInteger(options.replyTo) ? { reply_to_message_id: options.replyTo } : {}),
  });
}

async function launchWakeSession(state, topic, prompt, replyTo) {
  if (state.wakeReservations.has(topic.sessionId)) return { started: false, reserved: true };
  state.wakeReservations.add(topic.sessionId);
  try {
    const cwd = await resolveWakeCwd(topic.cwd, state.secret.wakeDefaultCwd, state.secret.wakeAllowedRoots);
    if (connectedTarget(state, topic.sessionId)) {
      state.wakeReservations.delete(topic.sessionId);
      return { started: false, connected: true };
    }
    for (const pending of state.pendingReplies.values()) {
      if (pending.sessionId === topic.sessionId) pending.holdForWake = true;
    }
    queuePersist(state).catch(() => {});
    const launched = await state.wakeLauncher.launch({
      sessionId: topic.sessionId,
      cwd,
      sessionName: topic.name,
      prompt,
    });
    if (launched.started) {
      await sendBrokerText(state, `Waking Pi session ${topic.sessionId.slice(0, 8)}…`, {
        threadId: topic.threadId,
        replyTo,
      });
    } else if (!state.wakeLauncher.isRunning(topic.sessionId)) {
      state.wakeReservations.delete(topic.sessionId);
    }
    return launched;
  } catch (error) {
    state.wakeReservations.delete(topic.sessionId);
    throw error;
  }
}

async function handleControlMessage(state, message) {
  const parsed = parseControlCommand(message.text);
  const replyOptions = {
    replyTo: message.message_id,
    ...(Number.isSafeInteger(message.message_thread_id) ? { threadId: message.message_thread_id } : {}),
  };
  if (!parsed) {
    await sendBrokerText(state, "Use /new, /sessions, /status, or /help in All Topics.", replyOptions);
    return;
  }
  if (parsed.command === "help") {
    await sendBrokerText(state, [
      "Pi Telegram wake commands:",
      "/new <cwd> | <prompt> — create and run a session",
      "/new <cwd> — create a session topic without running it",
      "/new | <prompt> — use wakeDefaultCwd",
      "/sessions — list known session topics",
      "/status — show broker status",
    ].join("\n"), replyOptions);
    return;
  }
  if (parsed.command === "status") {
    await sendBrokerText(state, [
      "Pi Telegram wake broker is running.",
      `Connected Pi sessions: ${state.clientsBySession.size}`,
      `Background Pi sessions: ${state.wakeLauncher.runningSessionIds().length}`,
      `Known topics: ${state.topics.size}`,
    ].join("\n"), replyOptions);
    return;
  }
  if (parsed.command === "sessions") {
    const topics = [...state.topics.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20);
    const text = topics.length === 0
      ? "No Pi session topics are known yet."
      : ["Known Pi sessions:", ...topics.map((topic) => `${topic.name || "Pi"} · ${topic.sessionId.slice(0, 8)} · ${topic.cwd || "no cwd"}`)].join("\n");
    await sendBrokerText(state, text, replyOptions);
    return;
  }

  const cwd = await resolveWakeCwd(parsed.cwd, state.secret.wakeDefaultCwd, state.secret.wakeAllowedRoots);
  const sessionId = randomUUID();
  const sessionName = path.basename(cwd) || "Pi";
  const topic = await ensureTopic(state, sessionId, cwd, sessionName);
  await sendBrokerText(state, `New Pi session ${sessionId.slice(0, 8)}\nWorking directory: ${cwd}`, { threadId: topic.threadId });
  if (parsed.prompt) await launchWakeSession(state, topic, parsed.prompt);
}

async function queueTelegramReply(state, target, message, holdForWake = false) {
  const pending = {
    deliveryId: randomUUID(),
    text: message.text,
    telegramMessageId: message.message_id,
    notificationMessageId: target.messageId,
    threadId: target.threadId || message.message_thread_id,
    sessionId: target.sessionId,
    createdAt: Date.now(),
    ...(holdForWake ? { holdForWake: true } : {}),
  };
  state.pendingReplies.set(pending.deliveryId, pending);
  await queuePersist(state);
  const delivered = holdForWake ? false : deliverPendingReply(state, pending);
  return { pending, delivered };
}

function releaseWakeFollowups(state, sessionId) {
  for (const pending of state.pendingReplies.values()) {
    if (pending.sessionId !== sessionId || !pending.holdForWake) continue;
    delete pending.holdForWake;
    deliverPendingReply(state, pending);
  }
  queuePersist(state).catch(() => {});
}

async function handleTelegramMessage(state, message) {
  if (!message || typeof message.text !== "string") return;
  if (message.chat?.id !== state.secret.chatId || message.from?.id !== state.secret.allowedUserId) return;
  if (message.from?.is_bot === true || message.text.trim().startsWith("/start")) return;

  const threadIsKnown = Number.isSafeInteger(message.message_thread_id) &&
    [...state.topics.values()].some((topic) => topic.threadId === message.message_thread_id);
  if (state.secret.wakeMode && !threadIsKnown) {
    try {
      await handleControlMessage(state, message);
    } catch (error) {
      await sendBrokerText(state, `Command failed: ${errorMessage(error)}`, {
        replyTo: message.message_id,
        ...(Number.isSafeInteger(message.message_thread_id) ? { threadId: message.message_thread_id } : {}),
      }).catch(() => {});
    }
    return;
  }

  const target = findReplyTarget(state, message);
  if (!target) {
    await telegramCall(state.secret, "sendMessage", {
      chat_id: state.secret.chatId,
      text: "No active Pi session is available for this topic.",
      reply_to_message_id: message.message_id,
      ...(Number.isSafeInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {}),
    }).catch((error) => console.warn(`[pi-notify-telegram] ${errorMessage(error)}`));
    return;
  }

  const targetTopic = state.topics.get(target.sessionId);
  message = { ...message, text: translateTelegramCommand(targetTopic, message.text) };

  let holdForWake = false;
  if (!connectedTarget(state, target.sessionId) && state.secret.wakeMode) {
    const topic = state.topics.get(target.sessionId);
    if (topic) {
      if (state.wakeLauncher.isRunning(target.sessionId) || state.wakeReservations.has(target.sessionId)) {
        holdForWake = true;
      } else {
        try {
          const launched = await launchWakeSession(state, topic, message.text, message.message_id);
          if (launched.started) return;
          holdForWake = launched.reserved === true;
        } catch (error) {
          await sendBrokerText(state, `Could not wake Pi: ${errorMessage(error)}`, {
            threadId: message.message_thread_id,
            replyTo: message.message_id,
          }).catch(() => {});
          return;
        }
      }
    }
  }

  if (pruneExpiredBrokerState(state)) queuePersist(state).catch(() => {});
  if (state.pendingReplies.size >= MAX_PENDING_REPLIES) {
    await telegramCall(state.secret, "sendMessage", {
      chat_id: state.secret.chatId,
      ...(Number.isSafeInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {}),
      text: "Pi reply queue is full. Please try again after pending replies are delivered.",
    });
    return;
  }

  const queued = await queueTelegramReply(state, target, message, holdForWake);
  if (!queued.delivered) {
    await telegramCall(state.secret, "sendMessage", {
      chat_id: state.secret.chatId,
      text: holdForWake
        ? "Reply queued behind the session's current wake turn."
        : "Reply queued until the target Pi session reconnects.",
      reply_to_message_id: message.message_id,
      ...(Number.isSafeInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {}),
    }).catch((error) => console.warn(`[pi-notify-telegram] ${errorMessage(error)}`));
  }
}

async function pollTelegram(state) {
  while (!state.closed) {
    try {
      const updates = await telegramCall(state.secret, "getUpdates", {
        offset: state.offset,
        timeout: 25,
        allowed_updates: ["message"],
      }, 35_000);
      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id)) continue;
        state.offset = Math.max(state.offset, update.update_id + 1);
        await handleTelegramMessage(state, update.message);
      }
      if (updates.length > 0) await queuePersist(state);
    } catch (error) {
      if (!state.closed) {
        console.warn(`[pi-notify-telegram] Poll failed: ${errorMessage(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }
}

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
        const sourceChunks = splitTelegramText(text);
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
        const sourceChunks = splitTelegramText(text);
        const htmlChunks = renderTelegramChunks(text);
        for (let index = 0; index < htmlChunks.length; index += 1) {
          await telegramFormattedCall(state.secret, "sendMessage", {
            chat_id: state.secret.chatId,
            message_thread_id: topic.threadId,
            text: htmlChunks[index],
            parse_mode: "HTML",
            link_preview_options: { is_disabled: !state.secret.linkPreview },
          }, sourceChunks[index] || "");
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
    state.sessionCommands.set(client.sessionId, client.commands);
    const topic = state.topics.get(client.sessionId);
    if (topic) {
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
    wakeLauncher: undefined,
    persistQueue: Promise.resolve(),
    cleanupTimer: undefined,
    closed: false,
    server,
  };
  state.wakeLauncher = new WakeLauncher({
    piCommand: secret.wakePiCommand,
    piCommandArgs: secret.wakePiCommandArgs,
    onExit: async ({ sessionId, code, signal, cancelled }) => {
      state.wakeReservations.delete(sessionId);
      if (code === 0 || cancelled) return;
      const topic = state.topics.get(sessionId);
      if (!topic) return;
      await sendBrokerText(state, `Background Pi exited before completing (${signal || `code ${code}`}).`, { threadId: topic.threadId });
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
      if (client.sessionId && state.clientsBySession.get(client.sessionId) === client) state.clientsBySession.delete(client.sessionId);
    });
    socket.on("error", () => {});
    socket.resume();
  });
  server.on("error", (error) => console.warn(`[pi-notify-telegram] Broker error: ${errorMessage(error)}`));
  server.on("close", () => {
    state.closed = true;
    if (state.cleanupTimer) clearInterval(state.cleanupTimer);
    localLeaderPromise = undefined;
  });
  server.unref?.();
  syncTelegramCommandMenu(state).catch((error) => console.warn(`[pi-notify-telegram] Cannot sync bot commands: ${errorMessage(error)}`));
  pollTelegram(state).catch((error) => console.warn(`[pi-notify-telegram] Poller stopped: ${errorMessage(error)}`));
  return state;
}

async function launchDetachedWakeDaemon() {
  if (!daemonLaunchPromise) {
    daemonLaunchPromise = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DAEMON_PATH], {
        detached: true,
        env: { ...process.env, PI_TELEGRAM_DAEMON: "1" },
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      child.once("error", reject);
    }).finally(() => {
      daemonLaunchPromise = undefined;
    });
  }
  return daemonLaunchPromise;
}

async function ensureLocalLeader(secret) {
  if (!localLeaderPromise) {
    localLeaderPromise = startLocalLeader(secret).catch((error) => {
      localLeaderPromise = undefined;
      throw error;
    });
  }
  const leader = await localLeaderPromise;
  // Another process may own the port now but disappear before our next retry.
  if (!leader) localLeaderPromise = undefined;
  return leader;
}

function registerClient(state) {
  if (!state.socket || state.socket.destroyed) return;
  sendLine(state.socket, {
    type: "register",
    version: PROTOCOL_VERSION,
    auth: state.secret.bridgeSecret,
    clientId: state.clientId,
    sessionId: state.sessionId,
    cwd: state.cwd,
    sessionName: state.sessionName,
    commands: state.commands,
    wakeChild: process.env.PI_TELEGRAM_WAKE_CHILD === "1",
  });
}

function rejectPending(state, error) {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pending.clear();
}

function scheduleReconnect(state) {
  if (state.closed || state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = undefined;
    connectClient(state).catch(() => scheduleReconnect(state));
  }, 1_000);
  state.reconnectTimer.unref?.();
}

async function connectClient(state) {
  if (state.closed) throw new Error("Telegram bridge client is closed");
  if (state.connected && state.socket && !state.socket.destroyed) return;
  if (state.connectPromise) return state.connectPromise;

  state.connectPromise = (async () => {
    const attempt = () => new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: state.secret.port });
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        socket.setNoDelay(true);
        state.socket = socket;
        state.connected = false;
        const timer = setTimeout(() => {
          state.handshake = undefined;
          socket.destroy();
          reject(new Error("Telegram bridge handshake timed out"));
        }, HANDSHAKE_TIMEOUT_MS);
        state.handshake = {
          resolve: () => {
            clearTimeout(timer);
            state.handshake = undefined;
            state.connected = true;
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            state.handshake = undefined;
            reject(error);
          },
        };
        attachLineReader(socket, (message) => handleClientMessage(state, message), (error) => socket.destroy(error));
        socket.on("close", () => {
          if (state.socket !== socket) return;
          state.handshake?.reject(new Error("Telegram bridge disconnected during handshake"));
          state.connected = false;
          state.socket = undefined;
          rejectPending(state, new Error("Telegram bridge disconnected"));
          scheduleReconnect(state);
        });
        socket.on("error", () => {});
        registerClient(state);
      });
    });

    try {
      await attempt();
    } catch (firstError) {
      if (state.secret.wakeMode && process.env.PI_TELEGRAM_DAEMON !== "1") {
        await launchDetachedWakeDaemon();
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          await attempt();
          return;
        } catch {}
      }
      await ensureLocalLeader(state.secret);
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await attempt();
      } catch {
        throw firstError;
      }
    }
  })().finally(() => {
    state.connectPromise = undefined;
  });
  return state.connectPromise;
}

function handleClientMessage(state, message) {
  if (message?.type === "registered") {
    if (message.version !== PROTOCOL_VERSION) {
      state.handshake?.reject(new Error("Telegram bridge protocol version mismatch"));
      state.socket?.destroy();
      return;
    }
    state.handshake?.resolve();
    return;
  }
  if (message?.type === "result" && typeof message.requestId === "string") {
    const pending = state.pending.get(message.requestId);
    if (!pending) return;
    state.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message);
    else pending.reject(new Error(message.error || "Telegram notification failed"));
    return;
  }
  if (message?.type !== "reply" || typeof message.text !== "string" || typeof message.deliveryId !== "string") return;
  const sendAck = (ok, error) => sendLine(state.socket, {
    type: "replyAck",
    auth: state.secret.bridgeSecret,
    deliveryId: message.deliveryId,
    ok,
    ...(error ? { error } : {}),
  });
  if (state.seenDeliveries.has(message.deliveryId)) {
    sendAck(true);
    return;
  }
  const liveSessionId = state.ctx?.sessionManager?.getSessionId?.();
  if (message.sessionId !== state.sessionId || liveSessionId !== message.sessionId) {
    if (typeof liveSessionId === "string" && liveSessionId !== state.sessionId) {
      state.sessionId = liveSessionId;
      state.cwd = String(state.ctx?.cwd || state.cwd);
      registerClient(state);
    }
    sendAck(false, "Target Pi session is not active in this process");
    return;
  }
  try {
    if (state.ctx?.isIdle?.() === false) {
      state.pi.sendUserMessage(message.text, { deliverAs: "steer", expandPromptTemplates: true });
    } else {
      state.pi.sendUserMessage(message.text, { expandPromptTemplates: true });
    }
    rememberDelivery(state, message.deliveryId);
    sendAck(true);
  } catch (error) {
    const detail = errorMessage(error);
    sendAck(false, detail);
    console.warn(`[pi-notify-telegram] Cannot inject reply: ${detail}`);
  }
}

function hydrateSeenDeliveries(state) {
  state.seenDeliveries.clear();
  const entries = state.ctx?.sessionManager?.getEntries?.() || [];
  for (const entry of entries.slice(-DELIVERY_DEDUPE_MAX * 2)) {
    if (entry?.type !== "custom" || entry.customType !== "pi_notify_telegram_delivery") continue;
    const deliveryId = entry.data?.deliveryId;
    if (typeof deliveryId === "string") state.seenDeliveries.add(deliveryId);
  }
  while (state.seenDeliveries.size > DELIVERY_DEDUPE_MAX) {
    state.seenDeliveries.delete(state.seenDeliveries.values().next().value);
  }
}

function rememberDelivery(state, deliveryId) {
  state.seenDeliveries.add(deliveryId);
  while (state.seenDeliveries.size > DELIVERY_DEDUPE_MAX) {
    state.seenDeliveries.delete(state.seenDeliveries.values().next().value);
  }
  state.pi.appendEntry?.("pi_notify_telegram_delivery", { deliveryId });
}

function availablePiCommands(pi) {
  try {
    return (typeof pi.getCommands === "function" ? pi.getCommands() : [])
      .filter((command) => command && typeof command.name === "string")
      .map((command) => ({
        name: command.name,
        description: command.description,
        source: command.source,
      }));
  } catch {
    return [];
  }
}

function clientStateFor(pi, ctx, notification) {
  let state = clientStates.get(pi);
  if (!state) {
    state = {
      pi,
      ctx,
      secret: undefined,
      clientId: randomUUID(),
      sessionId: String(notification.sessionId || ctx?.sessionManager?.getSessionId?.() || ""),
      cwd: String(notification.cwd || ctx?.cwd || ""),
      sessionName: String(pi.getSessionName?.() || ""),
      commands: availablePiCommands(pi),
      socket: undefined,
      connected: false,
      ready: undefined,
      connectPromise: undefined,
      handshake: undefined,
      reconnectTimer: undefined,
      pending: new Map(),
      seenDeliveries: new Set(),
      closed: false,
    };
    clientStates.set(pi, state);
    hydrateSeenDeliveries(state);
    const refreshSession = (_event, liveCtx) => {
      if (!liveCtx?.sessionManager) return;
      state.ctx = liveCtx;
      const nextSessionId = String(liveCtx.sessionManager.getSessionId() || "");
      const nextCwd = String(liveCtx.cwd || "");
      const nextSessionName = String(pi.getSessionName?.() || "");
      const nextCommands = availablePiCommands(pi);
      const changed = state.sessionId !== nextSessionId || state.cwd !== nextCwd || state.sessionName !== nextSessionName ||
        JSON.stringify(state.commands) !== JSON.stringify(nextCommands);
      state.sessionId = nextSessionId;
      state.cwd = nextCwd;
      state.sessionName = nextSessionName;
      state.commands = nextCommands;
      if (changed) {
        hydrateSeenDeliveries(state);
        registerClient(state);
      }
    };
    pi.on("session_start", refreshSession);
    pi.on("session_info_changed", refreshSession);
    pi.on("session_shutdown", () => {
      state.closed = true;
      if (state.currentStream?.timer) clearTimeout(state.currentStream.timer);
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      rejectPending(state, new Error("Pi session shut down"));
      state.socket?.destroy();
      clientStates.delete(pi);
    });
  }
  state.ctx = ctx;
  const nextSessionId = String(notification.sessionId || "");
  const nextCwd = String(notification.cwd || "");
  const nextSessionName = String(pi.getSessionName?.() || "");
  const nextCommands = availablePiCommands(pi);
  const changed = state.sessionId !== nextSessionId || state.cwd !== nextCwd || state.sessionName !== nextSessionName ||
    JSON.stringify(state.commands) !== JSON.stringify(nextCommands);
  state.sessionId = nextSessionId;
  state.cwd = nextCwd;
  state.sessionName = nextSessionName;
  state.commands = nextCommands;
  if (changed) {
    hydrateSeenDeliveries(state);
    if (state.connected) registerClient(state);
  }
  return state;
}

async function requestBroker(state, payload, timeoutLabel) {
  await connectClient(state);
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error(`${timeoutLabel} timed out`));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    state.pending.set(requestId, { resolve, reject, timer });
    sendLine(state.socket, {
      ...payload,
      auth: state.secret.bridgeSecret,
      requestId,
      sessionId: state.sessionId,
    });
  });
}

function requestNotification(state, title, body) {
  return requestBroker(state, {
    type: "notify",
    title: String(title ?? "Pi"),
    body: String(body ?? ""),
    cwd: state.cwd,
    sessionName: state.sessionName,
  }, "Telegram notification");
}

async function initializeState(pi, ctx) {
  const notification = {
    sessionId: ctx?.sessionManager?.getSessionId?.() || "",
    cwd: ctx?.cwd || "",
  };
  const state = clientStateFor(pi, ctx, notification);
  if (!state.ready) {
    state.ready = (async () => {
      if (!state.secret) state.secret = await readSecret();
      await connectClient(state);
      return state;
    })().catch((error) => {
      state.ready = undefined;
      throw error;
    });
  }
  return state.ready;
}

function assistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

async function sendStream(state, type, stream) {
  if (state.ready) await state.ready;
  if (type === "streamFinal") {
    const payload = { type, draftId: stream.draftId, text: stream.text };
    try {
      await requestBroker(state, payload, "Telegram stream finalization");
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await requestBroker(state, payload, "Telegram stream finalization retry");
    }
    return;
  }
  await connectClient(state);
  sendLine(state.socket, {
    type,
    auth: state.secret.bridgeSecret,
    sessionId: state.sessionId,
    draftId: stream.draftId,
    text: stream.text,
  });
}

function scheduleStreamDraft(state) {
  const stream = state.currentStream;
  if (!stream || stream.timer) return;
  stream.timer = setTimeout(() => {
    stream.timer = undefined;
    if (state.currentStream !== stream || stream.text === stream.lastSent) return;
    stream.lastSent = stream.text;
    sendStream(state, "streamDraft", stream).catch((error) => {
      console.warn(`[pi-notify-telegram] Cannot stream draft: ${errorMessage(error)}`);
    });
  }, STREAM_THROTTLE_MS);
  stream.timer.unref?.();
}

function attach(pi) {
  if (!pi || typeof pi.on !== "function" || attachedApis.has(pi)) return;
  attachedApis.add(pi);

  pi.on("session_start", (_event, ctx) => {
    return initializeState(pi, ctx).catch((error) => {
      console.warn(`[pi-notify-telegram] Cannot initialize: ${errorMessage(error)}`);
    });
  });

  pi.on("message_start", (event) => {
    if (event.message?.role !== "assistant") return;
    const state = clientStates.get(pi);
    if (!state || state.closed) return;
    const stream = {
      draftId: randomInt(1, 2_147_483_647),
      text: assistantText(event.message),
      lastSent: undefined,
      timer: undefined,
    };
    state.currentStream = stream;
    stream.lastSent = stream.text;
    sendStream(state, "streamDraft", stream).catch((error) => {
      console.warn(`[pi-notify-telegram] Cannot start stream: ${errorMessage(error)}`);
    });
  });

  pi.on("message_update", (event) => {
    const state = clientStates.get(pi);
    const stream = state?.currentStream;
    if (!stream || event.message?.role !== "assistant") return;
    stream.text = assistantText(event.message);
    scheduleStreamDraft(state);
  });

  pi.on("message_end", (event) => {
    const state = clientStates.get(pi);
    const stream = state?.currentStream;
    if (!state || !stream || event.message?.role !== "assistant") return;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = undefined;
    stream.text = assistantText(event.message);
    state.currentStream = undefined;
    sendStream(state, "streamFinal", stream).catch((error) => {
      console.warn(`[pi-notify-telegram] Cannot finalize stream: ${errorMessage(error)}`);
    });
  });
}

async function notify(pi, ctx, notification, title, body) {
  if (!pi || typeof pi.on !== "function" || typeof pi.sendUserMessage !== "function") {
    throw new Error("Telegram companion requires the Pi ExtensionAPI");
  }
  const state = clientStateFor(pi, ctx, notification);
  if (state.ready) await state.ready;
  else await initializeState(pi, ctx);
  await requestNotification(state, title, body);
}

async function runWakeDaemon() {
  const secret = await readSecret();
  if (!secret.wakeMode) throw new Error("wakeMode is disabled in pi-notify-telegram.json");
  let stopping = false;
  for (;;) {
    const leader = await startLocalLeader(secret);
    if (!leader) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    const stop = () => {
      stopping = true;
      leader.server?.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise((resolve) => leader.server.once("close", resolve));
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (stopping) return;
  }
}

module.exports = Object.freeze({
  attach,
  notify,
  runWakeDaemon,
  __test: Object.freeze({ assistantText, findReplyTarget, handleControlMessage, normalizePiCommands, pruneExpiredBrokerState, splitTelegramText, startLocalLeader, telegramFormattedCall, topicName, translateTelegramCommand, validateSettings }),
});
