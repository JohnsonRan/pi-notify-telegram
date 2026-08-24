const assert = require("node:assert/strict");
const test = require("node:test");

const {
  dashboardText,
  parseSessionAction,
  sendTopicChatAction,
  syncTopicDashboard,
} = require("../src/telegram/dashboard.cjs");

const secret = { botToken: `123456:${"a".repeat(32)}`, chatId: 42 };
const sessionId = "12345678-1234-1234-1234-123456789abc";

test("creates, pins, and edits one dashboard per session topic", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 99 } : true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const state = { secret, dashboardQueues: new Map(), chatActionSentAt: new Map() };
  const topic = { sessionId, threadId: 700, cwd: "C:\\Work", name: "Work" };
  try {
    await syncTopicDashboard(state, topic, { phase: "Working", detail: "npm test" });
    await syncTopicDashboard(state, topic, { phase: "Ready", detail: "Waiting for input" });
    assert.equal(topic.dashboardMessageId, 99);
    assert.deepEqual(calls.slice(0, 3).map((item) => item.method), ["sendMessage", "pinChatMessage", "editMessageText"]);
    assert.match(dashboardText(topic), /Status: Ready/);
    assert.equal(parseSessionAction(`session:${sessionId}:continue`).action, "continue");
  } finally {
    global.fetch = originalFetch;
  }
});

test("throttles repeated Telegram chat actions", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const state = { secret, chatActionSentAt: new Map() };
    const topic = { sessionId, threadId: 700 };
    assert.equal(await sendTopicChatAction(state, topic), true);
    assert.equal(await sendTopicChatAction(state, topic), false);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
