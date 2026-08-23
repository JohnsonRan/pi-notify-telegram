#!/usr/bin/env node

process.env.PI_TELEGRAM_DAEMON = "1";

const { runWakeDaemon } = require("./src/runtime.cjs");

runWakeDaemon().catch((error) => {
  console.error(`[pi-notify-telegram] Wake daemon failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
