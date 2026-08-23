const { randomUUID } = require("node:crypto");
const { readFile, rename, unlink, writeFile } = require("node:fs/promises");
const { STATE_PATH } = require("./paths.cjs");

const MAX_MAPPINGS = 200;
const MAX_PENDING_REPLIES = 1000;
const MAX_TOPICS = 2000;
const STATE_ENTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function readBrokerState(statePath = STATE_PATH) {
  try {
    const raw = JSON.parse(await readFile(statePath, "utf8"));
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
    if (error instanceof SyntaxError) throw new Error(`Telegram state contains invalid JSON: ${statePath}`, { cause: error });
    throw error;
  }
}

async function persistBrokerState(state, statePath = STATE_PATH) {
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  const mappings = [...state.mappings.values()].slice(-MAX_MAPPINGS);
  const pendingReplies = [...state.pendingReplies.values()]
    .slice(-MAX_PENDING_REPLIES)
    .map(({ retryTimer: _retryTimer, ...item }) => item);
  const topics = [...state.topics.values()].slice(-MAX_TOPICS);
  try {
    await writeFile(temporary, `${JSON.stringify({ offset: state.offset, mappings, pendingReplies, topics }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, statePath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
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

module.exports = Object.freeze({
  MAX_MAPPINGS,
  MAX_PENDING_REPLIES,
  MAX_TOPICS,
  persistBrokerState,
  pruneExpiredBrokerState,
  queuePersist,
  readBrokerState,
  trimMappings,
});
