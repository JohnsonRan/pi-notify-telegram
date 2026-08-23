#!/usr/bin/env node

/**
 * Telegram companion for pi-notify.
 *
 * Pi processes share one localhost broker. The broker owns Telegram long polling,
 * while each connected Pi process injects replies with pi.sendUserMessage().
 */

const { clientStateFor, initializeState, requestNotification } = require("./bridge-client.cjs");
const { closeLeader, startLocalLeader } = require("./broker-server.cjs");
const { readSettings: readSecret } = require("./settings.cjs");
const { attach } = require("./streaming.cjs");
const { errorMessage } = require("./telegram-api.cjs");

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
      closeLeader(leader).catch((error) => console.warn(`[pi-notify-telegram] Cannot stop broker cleanly: ${errorMessage(error)}`));
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
});
