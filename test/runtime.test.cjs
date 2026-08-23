const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const runtimePath = path.resolve(__dirname, "../src/runtime.cjs");
const runtime = require(runtimePath);

test("validates split secret/config settings", () => {
  const settings = runtime.__test.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    allowedUserId: 42,
    bridgeSecret: "b".repeat(64),
    port: 43871,
  });
  assert.equal(settings.chatId, 42);
  assert.equal(settings.port, 43871);
  assert.equal(settings.linkPreview, false);
  const enabled = runtime.__test.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    linkPreview: true,
  });
  assert.equal(enabled.linkPreview, true);
  assert.throws(() => runtime.__test.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    wakeMode: true,
  }), /wakeAllowedRoots/);
  const wake = runtime.__test.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
  });
  assert.equal(wake.wakeMode, true);
  assert.equal(wake.wakeOpenTerminal, true);
  assert.deepEqual(wake.wakeAllowedRoots, ["F:\\"]);
  const background = runtime.__test.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
    wakeOpenTerminal: false,
  });
  assert.equal(background.wakeOpenTerminal, false);
  assert.throws(() => runtime.__test.validateSettings(`123456:${"a".repeat(32)}`, {
    chatId: 42,
    bridgeSecret: "b".repeat(64),
    wakeMode: true,
    wakeAllowedRoots: ["F:\\"],
    wakeOpenTerminal: "false",
  }), /wakeOpenTerminal must be a boolean/);
});

test("waits for foreground wake registration and stop state", async () => {
  const client = { wakeChild: true, registered: true, socket: { destroyed: false } };
  const state = {
    clientsBySession: new Map(),
    wakeLauncher: { isRunning: () => false },
  };
  setTimeout(() => state.clientsBySession.set("session", client), 10);
  assert.equal(await runtime.__test.waitForWakeRegistration(state, "session", 200), client);
  assert.equal(await runtime.__test.waitForWakeRegistration(state, "missing", 10), undefined);
  assert.equal(await runtime.__test.waitForWakeStop(state, "session", 10), true);
});

test("formats bounded wake process diagnostics for Telegram", () => {
  assert.equal(runtime.__test.formatWakeExitDetail("\u001b[31mconfig failed\u001b[0m\n"), "config failed");
  const detail = runtime.__test.formatWakeExitDetail("x".repeat(2000));
  assert.equal(detail.length, 1600);
  assert.ok(detail.startsWith("…"));
});

test("formats live main-agent and subagent progress", () => {
  assert.equal(runtime.__test.summarizeToolArgs("read", { path: "src/runtime.cjs" }), "src/runtime.cjs");
  const text = runtime.__test.formatLiveStatus({
    startedAt: 1_000,
    turnIndex: 1,
    toolName: "subagent",
    toolArgs: { workflowScript: "return await runs.run(...)" },
    partialResult: {
      details: {
        progress: [
          { index: 0, agent: "scout", status: "completed" },
          { index: 1, agent: "reviewer", status: "running", currentTool: "bash", currentPath: "test" },
        ],
      },
    },
  }, 13_500);
  assert.match(text, /Main agent · Turn 2 · 12s/);
  assert.match(text, /Subagents · 1\/2 done · 1 running/);
  assert.match(text, /✓ scout · completed/);
  assert.match(text, /⏳ reviewer · bash · test/);
});

test("maps Pi command names to Telegram-safe aliases and restores them", () => {
  const commands = runtime.__test.normalizePiCommands([
    { name: "review", description: "Review code", source: "extension" },
    { name: "reload-runtime", description: "Reload", source: "extension" },
    { name: "skill:frontend-design", description: "Design", source: "skill" },
    { name: "status", description: "Pi status", source: "extension" },
    { name: "telegram-wake", description: "internal", source: "extension" },
  ]);
  assert.equal(commands.length, 4);
  assert.equal(commands[0].telegramName, "review");
  assert.equal(commands[1].telegramName, "reload_runtime");
  assert.notEqual(commands[3].telegramName, "status");
  const skill = commands.find((command) => command.name === "skill:frontend-design");
  assert.equal(runtime.__test.translateTelegramCommand({ commands }, `/${skill.telegramName} mobile`), "/skill:frontend-design mobile");
});

test("builds stable topic names, chunks text, and rejects unthreaded fallback routing", () => {
  assert.equal(runtime.__test.topicName("1234567890", "C:/work/demo", ""), "demo · 12345678");
  const chunks = runtime.__test.splitTelegramText("x".repeat(9000));
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  const state = {
    topics: new Map(),
    mappings: new Map([[10, { messageId: 10, sessionId: "latest" }]]),
  };
  assert.equal(runtime.__test.findReplyTarget(state, { text: "unthreaded" }), undefined);
  assert.equal(runtime.__test.findReplyTarget(state, { reply_to_message: { message_id: 10 } }).sessionId, "latest");
});

test("prunes stale mappings and undelivered replies but retains topics", () => {
  const now = Date.now();
  const old = now - 31 * 24 * 60 * 60 * 1000;
  const fresh = now - 29 * 24 * 60 * 60 * 1000;
  const state = {
    mappings: new Map([[1, { createdAt: old }], [2, { createdAt: fresh }]]),
    pendingReplies: new Map([["old", { createdAt: old }], ["fresh", { createdAt: fresh }]]),
    topics: new Map([["session", { createdAt: old }]]),
  };
  assert.equal(runtime.__test.pruneExpiredBrokerState(state, now), true);
  assert.deepEqual([...state.mappings.keys()], [2]);
  assert.deepEqual([...state.pendingReplies.keys()], ["fresh"]);
  assert.deepEqual([...state.topics.keys()], ["session"]);
  assert.equal(runtime.__test.pruneExpiredBrokerState(state, now), false);
});

test("falls back to plain text only after a deterministic Telegram Bad Request", async () => {
  const originalFetch = global.fetch;
  const payloads = [];
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (payloads.length === 1) {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    await runtime.__test.telegramFormattedCall(
      { botToken: `123456:${"a".repeat(32)}` },
      "sendMessage",
      { text: "<b>broken", parse_mode: "HTML" },
      "plain fallback",
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].parse_mode, "HTML");
  assert.equal(payloads[1].parse_mode, undefined);
  assert.equal(payloads[1].text, "plain fallback");
});

test("routes two Pi sessions through separate private topics and streams output", () => {
  const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notify-telegram-test-"));
fs.writeFileSync(path.join(dir, "pi-notify-telegram.secret"), "123456:${"a".repeat(32)}\n");
fs.writeFileSync(path.join(dir, "pi-notify-telegram.json"), JSON.stringify({ chatId: 42, allowedUserId: 42, bridgeSecret: "${"b".repeat(64)}", port: 43989, wakeMode: true, wakeDefaultCwd: dir, wakeAllowedRoots: [dir], wakeOpenTerminal: false }));
fs.writeFileSync(path.join(dir, "pi-notify-telegram.state.json"), JSON.stringify({ offset: 0, mappings: [], pendingReplies: [], topics: [] }));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_TELEGRAM_DAEMON = "1";

let nextThread = 700;
let nextMessage = 100;
let updatesSent = false;
const notificationByThread = new Map();
const notificationMessages = [];
const drafts = [];
const finalMessages = [];
const botCommandMenus = [];

global.fetch = async (url, options) => {
  const method = url.split("/").pop();
  const body = JSON.parse(options.body);
  if (method === "setMyCommands") {
    botCommandMenus.push(body.commands);
    return response(true);
  }
  if (method === "createForumTopic") {
    const threadId = ++nextThread;
    return response({ message_thread_id: threadId, name: body.name });
  }
  if (method === "sendMessageDraft") {
    drafts.push(body);
    return response(true);
  }
  if (method === "sendMessage") {
    const sent = { message_id: ++nextMessage, chat: { id: 42 }, message_thread_id: body.message_thread_id };
    if (body.reply_markup) {
      notificationByThread.set(body.message_thread_id, sent.message_id);
      notificationMessages.push(body);
    } else finalMessages.push(body);
    return response(sent);
  }
  if (method === "getUpdates") {
    if (!updatesSent && notificationByThread.size === 2) {
      updatesSent = true;
      const threads = [...notificationByThread.keys()].sort((a, b) => a - b);
      return response(threads.map((threadId, index) => ({
        update_id: index + 1,
        message: {
          message_id: 200 + index,
          message_thread_id: threadId,
          text: index === 0 ? "/ctx_stats" : "/status",
          chat: { id: 42 },
          from: { id: 42, is_bot: false },
        },
      })));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    return response([]);
  }
  throw new Error("Unexpected Telegram method: " + method);
};

function response(result) {
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
}

function fakePi(name) {
  const handlers = new Map();
  const injected = [];
  return {
    handlers,
    injected,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    getSessionName() { return name; },
    getCommands() {
      return [
        { name: "ctx-stats", description: "Show context stats", source: "extension" },
        { name: "skill:frontend-design", description: "Design a frontend", source: "skill" },
        { name: "telegram-wake", description: "internal", source: "extension" },
      ];
    },
    sendUserMessage(text, options) { injected.push({ text, options }); },
  };
}

async function emit(pi, event, payload, ctx) {
  for (const handler of pi.handlers.get(event) || []) await handler(payload, ctx);
}

(async () => {
  const runtime = require(${JSON.stringify(runtimePath)});
  const pi1 = fakePi("Agent One");
  const pi2 = fakePi("Agent Two");
  const ctx1 = { cwd: "C:/repo/one", isIdle: () => true, sessionManager: { getSessionId: () => "session-one" } };
  const ctx2 = { cwd: "C:/repo/two", isIdle: () => true, sessionManager: { getSessionId: () => "session-two" } };
  runtime.attach(pi1);
  runtime.attach(pi2);
  await emit(pi1, "session_start", {}, ctx1);
  await emit(pi2, "session_start", {}, ctx2);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const start = { role: "assistant", content: [] };
  const partial = { role: "assistant", content: [{ type: "text", text: "Streaming hello" }] };
  await emit(pi1, "agent_start", {}, ctx1);
  await emit(pi1, "turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await emit(pi1, "tool_execution_start", { toolCallId: "sub-1", toolName: "subagent", args: { agent: "reviewer", task: "review it" } }, ctx1);
  await emit(pi1, "tool_execution_update", {
    toolCallId: "sub-1",
    toolName: "subagent",
    args: { agent: "reviewer", task: "review it" },
    partialResult: { details: { progress: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read", currentPath: "src/runtime.cjs" }] } },
  }, ctx1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await emit(pi1, "tool_execution_end", { toolCallId: "sub-1", toolName: "subagent", result: {}, isError: false }, ctx1);
  await emit(pi1, "message_start", { message: start }, ctx1);
  await emit(pi1, "message_update", { message: partial }, ctx1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await emit(pi1, "message_end", { message: partial }, ctx1);
  await emit(pi1, "agent_settled", {}, ctx1);

  await Promise.all([
    runtime.notify(pi1, ctx1, { sessionId: "session-one", cwd: ctx1.cwd }, "Question <one>", "Reply **one**"),
    runtime.notify(pi2, ctx2, { sessionId: "session-two", cwd: ctx2.cwd }, "Question two", "Reply two"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const state = JSON.parse(fs.readFileSync(path.join(dir, "pi-notify-telegram.state.json"), "utf8"));
  const result = {
    pi1: pi1.injected,
    pi2: pi2.injected,
    topicCount: state.topics.length,
    topicThreads: state.topics.map((topic) => topic.threadId).sort((a, b) => a - b),
    mappings: state.mappings.length,
    pendingReplies: state.pendingReplies.length,
    notificationMessages,
    drafts,
    finalMessages,
    botCommandMenus,
  };
  console.log(JSON.stringify(result));
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim());
  assert.deepEqual(result.pi1.map((item) => item.text), ["/ctx-stats"]);
  assert.deepEqual(result.pi2.map((item) => item.text), ["/status"]);
  assert.equal(result.topicCount, 2);
  assert.deepEqual(result.topicThreads, [701, 702]);
  assert.equal(result.mappings, 0);
  assert.equal(result.pendingReplies, 0);
  assert.ok(result.notificationMessages.some((message) => message.parse_mode === "HTML" && message.link_preview_options?.is_disabled === true && message.text.includes("<b>Question &lt;one&gt;</b>") && message.text.includes("Reply <b>one</b>")));
  assert.ok(result.drafts.some((draft) => draft.text.includes("Main agent · Turn 1")));
  assert.ok(result.drafts.some((draft) => draft.text.includes("Subagents · 0/1 done · 1 running") && draft.text.includes("reviewer · read · src/runtime.cjs")));
  assert.ok(result.drafts.some((draft) => draft.parse_mode === "HTML" && draft.text === "Streaming hello"));
  assert.ok(result.finalMessages.some((message) => message.parse_mode === "HTML" && message.link_preview_options?.is_disabled === true && message.text === "Streaming hello"));
  assert.ok(result.botCommandMenus.some((commands) => commands.some((command) => command.command === "new")));
  assert.ok(result.botCommandMenus.some((commands) => commands.some((command) => command.command === "ctx_stats")));
  assert.ok(result.botCommandMenus.every((commands) => commands.every((command) => command.command !== "telegram_wake")));
  assert.equal(result.pi1[0].options.expandPromptTemplates, true);
});
