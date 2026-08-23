const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { daemonLogPath, installDaemonLogging } = require("../src/daemon-log.cjs");

test("writes bounded daemon diagnostics", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-telegram-log-test-"));
  const logPath = daemonLogPath(directory);
  const captured = [];
  const consoleObject = {
    log: (...args) => captured.push(["log", ...args]),
    warn: (...args) => captured.push(["warn", ...args]),
    error: (...args) => captured.push(["error", ...args]),
  };
  try {
    installDaemonLogging({
      logPath,
      maxBytes: 96,
      consoleObject,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    consoleObject.log("started", { pid: 42 });
    consoleObject.warn("x".repeat(160));

    const content = readFileSync(logPath, "utf8");
    assert.match(content, /earlier daemon output truncated/);
    assert.match(content, /\[warn\]/);
    assert.ok(Buffer.byteLength(content) <= 128);
    assert.deepEqual(captured, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mirrors daemon diagnostics when requested", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-telegram-log-test-"));
  const captured = [];
  const consoleObject = {
    log: (...args) => captured.push(["log", ...args]),
    warn: (...args) => captured.push(["warn", ...args]),
    error: (...args) => captured.push(["error", ...args]),
  };
  try {
    installDaemonLogging({
      logPath: daemonLogPath(directory),
      consoleObject,
      mirror: true,
    });
    consoleObject.error("failed", 7);
    assert.deepEqual(captured, [["error", "failed", 7]]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
