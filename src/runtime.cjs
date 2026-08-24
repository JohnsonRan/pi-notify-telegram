#!/usr/bin/env node

/**
 * TelegraPi runtime for Pi.
 *
 * Pi processes share one localhost broker. The broker owns Telegram long polling,
 * while each connected Pi process injects replies with pi.sendUserMessage().
 */

const { clientStateFor, initializeState, requestArtifact, requestNotification, requestQuestion } = require("./bridge/client.cjs");
const { closeLeader, startLocalLeader } = require("./broker/server.cjs");
const { readSettings: readSecret } = require("./shared/settings.cjs");
const { attach } = require("./session/streaming.cjs");
const { errorMessage } = require("./telegram/api.cjs");

async function notify(pi, ctx, notification, title, body) {
  if (!pi || typeof pi.on !== "function" || typeof pi.sendUserMessage !== "function") {
    throw new Error("TelegraPi requires the Pi ExtensionAPI");
  }
  const state = clientStateFor(pi, ctx, notification);
  if (state.ready) await state.ready;
  else await initializeState(pi, ctx);
  await requestNotification(state, title, body);
}

async function askQuestion(pi, ctx, question, options) {
  const state = clientStateFor(pi, ctx, {
    sessionId: ctx?.sessionManager?.getSessionId?.() || "",
    cwd: ctx?.cwd || "",
  });
  if (state.ready) await state.ready;
  else await initializeState(pi, ctx);
  const result = await requestQuestion(state, question, options);
  return String(result.answer || "");
}

async function sendFile(pi, ctx, filePath, caption = "") {
  const state = clientStateFor(pi, ctx, {
    sessionId: ctx?.sessionManager?.getSessionId?.() || "",
    cwd: ctx?.cwd || "",
  });
  if (state.ready) await state.ready;
  else await initializeState(pi, ctx);
  await requestArtifact(state, filePath, caption);
}

async function runWakeDaemon() {
  const secret = await readSecret();
  if (!secret.wakeMode) throw new Error("wakeMode is disabled in pi-telegram-operator.json");
  let stopping = false;
  for (;;) {
    const leader = await startLocalLeader(secret);
    if (!leader) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    const stop = () => {
      stopping = true;
      closeLeader(leader).catch((error) => console.warn(`[pi-telegram-operator] Cannot stop broker cleanly: ${errorMessage(error)}`));
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
  askQuestion,
  attach,
  notify,
  runWakeDaemon,
  sendFile,
});
