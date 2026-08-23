const { spawn } = require("node:child_process");
const { realpath, stat } = require("node:fs/promises");
const path = require("node:path");

function parseControlCommand(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\/(new|sessions|status|help)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  const command = match[1].toLowerCase();
  const argument = String(match[2] || "").trim();
  if (command !== "new") return { command };
  const separator = argument.indexOf("|");
  if (separator < 0) return { command, cwd: argument, prompt: "" };
  return {
    command,
    cwd: argument.slice(0, separator).trim(),
    prompt: argument.slice(separator + 1).trim(),
  };
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveWakeCwd(value, defaultCwd, allowedRoots) {
  const requested = String(value || defaultCwd || "").trim();
  if (!requested) throw new Error("No working directory was provided and wakeDefaultCwd is not configured");
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(String(defaultCwd || ""), requested);
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Working directory does not exist: ${resolved}`);
  const cwd = await realpath(resolved);
  const roots = await Promise.all(allowedRoots.map(async (root) => {
    const resolvedRoot = path.resolve(root);
    return realpath(resolvedRoot).catch(() => resolvedRoot);
  }));
  if (roots.length === 0 || !roots.some((root) => isPathInside(root, cwd))) {
    throw new Error(`Working directory is outside wakeAllowedRoots: ${cwd}`);
  }
  return cwd;
}

class WakeLauncher {
  constructor(options = {}) {
    this.piCommand = String(options.piCommand || "pi");
    this.piCommandArgs = Array.isArray(options.piCommandArgs) ? [...options.piCommandArgs] : [];
    this.spawn = options.spawn || spawn;
    this.running = new Map();
    this.cancelled = new Set();
    this.onExit = typeof options.onExit === "function" ? options.onExit : () => {};
  }

  isRunning(sessionId) {
    return this.running.has(sessionId);
  }

  runningSessionIds() {
    return [...this.running.keys()];
  }

  cancel(sessionId) {
    const child = this.running.get(sessionId);
    if (!child) return false;
    this.cancelled.add(sessionId);
    child.kill();
    return true;
  }

  async launch({ sessionId, cwd, sessionName, prompt }) {
    if (this.running.has(sessionId)) return { started: false, process: this.running.get(sessionId) };
    const args = [
      ...this.piCommandArgs,
      "--session-id", sessionId,
      "--name", String(sessionName || path.basename(cwd) || "Telegram"),
      "--print",
      "--approve",
      `Telegram message:\n${String(prompt || "")}`,
    ];
    const child = this.spawn(this.piCommand, args, {
      cwd,
      env: { ...process.env, PI_TELEGRAM_WAKE_CHILD: "1" },
      stdio: "ignore",
      windowsHide: true,
    });
    this.running.set(sessionId, child);
    try {
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      this.running.delete(sessionId);
      throw error;
    }
    child.once("exit", (code, signal) => {
      if (this.running.get(sessionId) === child) this.running.delete(sessionId);
      const cancelled = this.cancelled.delete(sessionId);
      Promise.resolve(this.onExit({ sessionId, cwd, code, signal, cancelled })).catch(() => {});
    });
    return { started: true, process: child };
  }
}

module.exports = Object.freeze({
  WakeLauncher,
  isPathInside,
  parseControlCommand,
  resolveWakeCwd,
});
