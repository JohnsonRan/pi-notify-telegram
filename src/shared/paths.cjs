const path = require("node:path");

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent");
const SECRET_PATH = path.join(AGENT_DIR, "pi-telegram-operator.secret");
const CONFIG_PATH = path.join(AGENT_DIR, "pi-telegram-operator.json");
const STATE_PATH = path.join(AGENT_DIR, "pi-telegram-operator.state.json");
const DEFAULT_PORT = 43871;
const WINDOWS_DAEMON_MARKER = "--pi-telegram-operator-service-daemon";

module.exports = Object.freeze({
  AGENT_DIR,
  CONFIG_PATH,
  DEFAULT_PORT,
  SECRET_PATH,
  STATE_PATH,
  WINDOWS_DAEMON_MARKER,
});
