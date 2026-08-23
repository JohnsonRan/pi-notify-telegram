#!/usr/bin/env node

const path = require("node:path");
const { daemonLogPath, installDaemonLogging } = require("./src/daemon-log.cjs");

process.env.PI_TELEGRAM_DAEMON = "1";

const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent");
const logPath = installDaemonLogging({
  logPath: daemonLogPath(agentDir),
  mirror: process.stdout.isTTY || process.stderr.isTTY,
});
console.log(`[pi-notify-telegram] Wake daemon starting (pid ${process.pid}, log ${logPath})`);

const { runWakeDaemon } = require("./src/runtime.cjs");

runWakeDaemon().catch((error) => {
  console.error(`[pi-notify-telegram] Wake daemon failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
