#!/usr/bin/env node

const { randomBytes, randomUUID } = require("node:crypto");
const { readFile, rename, unlink, writeFile } = require("node:fs/promises");
const net = require("node:net");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { CONFIG_PATH, DEFAULT_PORT, SECRET_PATH, STATE_PATH } = require("./src/paths.cjs");

async function brokerIsRunning() {
  let port;
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    port = Number(config.port || DEFAULT_PORT);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (running) => {
      socket.destroy();
      resolve(running);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function call(token, method, payload, timeoutMs = 35_000) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json();
  if (!response.ok || result?.ok !== true) throw new Error(result?.description || `HTTP ${response.status}`);
  return result.result;
}

function hiddenQuestion(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Run setup in an interactive terminal or set TELEGRAM_BOT_TOKEN temporarily");
  }
  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const previousRaw = stdin.isRaw;
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(previousRaw));
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("Setup cancelled"));
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function preserveOperationalConfig(config, previousConfig) {
  const validators = {
    port: (value) => Number.isInteger(value) && value >= 1024 && value <= 65535,
    linkPreview: (value) => typeof value === "boolean",
    wakeMode: (value) => typeof value === "boolean",
    wakeDefaultCwd: (value) => typeof value === "string",
    wakeAllowedRoots: (value) => Array.isArray(value) && value.every((root) => typeof root === "string"),
    wakePiCommand: (value) => typeof value === "string" && value.length > 0,
    wakePiCommandArgs: (value) => Array.isArray(value) && value.every((argument) => typeof argument === "string"),
    wakeOpenTerminal: (value) => typeof value === "boolean",
  };

  for (const [key, isValid] of Object.entries(validators)) {
    if (isValid(previousConfig[key])) config[key] = previousConfig[key];
  }
  return config;
}

async function readOptionalJson(file, read = readFile) {
  try {
    return JSON.parse(await read(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function mergePreviousInstallation(config, state, selected, read = readFile) {
  let previousConfig;
  let previousState;
  try {
    [previousConfig, previousState] = await Promise.all([
      readOptionalJson(CONFIG_PATH, read),
      readOptionalJson(STATE_PATH, read),
    ]);
  } catch (error) {
    throw new Error("Existing Telegram config/state is invalid; move it aside before rerunning setup", { cause: error });
  }
  if (previousConfig?.chatId !== selected.chat.id || previousConfig?.allowedUserId !== selected.from.id) {
    return { config, state };
  }
  preserveOperationalConfig(config, previousConfig);
  if (previousState) {
    state = {
      offset: Math.max(state.offset, Number(previousState.offset) || 0),
      mappings: Array.isArray(previousState.mappings) ? previousState.mappings : [],
      pendingReplies: Array.isArray(previousState.pendingReplies) ? previousState.pendingReplies : [],
      topics: Array.isArray(previousState.topics) ? previousState.topics : [],
    };
  }
  return { config, state };
}

async function writeStagedFiles(entries) {
  const staged = entries.map((entry) => ({ ...entry, temporary: `${entry.file}.${process.pid}.${randomUUID()}.tmp` }));
  try {
    await Promise.all(staged.map((entry) => writeFile(entry.temporary, entry.content, entry.options)));
    for (const entry of staged) await rename(entry.temporary, entry.file);
  } finally {
    await Promise.all(staged.map((entry) => unlink(entry.temporary).catch(() => {})));
  }
}

async function main() {
  if (await brokerIsRunning()) {
    throw new Error("The Telegram broker is running. Stop all Pi sessions before running setup.");
  }
  stdout.write("Create a dedicated bot with @BotFather and enable Threaded Mode before continuing.\n");
  const token = String(process.env.TELEGRAM_BOT_TOKEN || await hiddenQuestion("Bot token (hidden): ")).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Invalid Telegram bot token");

  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    const bot = await call(token, "getMe", {});
    stdout.write(`Connected to @${bot.username || bot.first_name}.\n`);

    const webhook = await call(token, "getWebhookInfo", {});
    if (webhook.url) {
      const answer = (await terminal.question(`This bot has a webhook (${webhook.url}). Remove it? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") throw new Error("A webhook prevents Telegram long polling");
      await call(token, "deleteWebhook", { drop_pending_updates: false });
    }

    const existing = await call(token, "getUpdates", { offset: -1, timeout: 0, allowed_updates: ["message"] });
    let offset = existing.length > 0 ? existing[existing.length - 1].update_id + 1 : 0;
    const nonce = randomBytes(6).toString("hex");
    const expectedStart = `/start ${nonce}`;
    stdout.write(`Open this bot on your iPhone and send exactly:\n\n${expectedStart}\n\n`);
    await terminal.question("Press Enter after sending it...");

    stdout.write("Waiting for the one-time setup message...\n");
    const deadline = Date.now() + 90_000;
    let selected;
    while (!selected && Date.now() < deadline) {
      const updates = await call(token, "getUpdates", { offset, timeout: 10, allowed_updates: ["message"] }, 20_000);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.message;
        if (message?.chat?.type === "private" && message?.from?.is_bot !== true && message.text === expectedStart) {
          selected = message;
        }
      }
    }
    if (!selected) throw new Error("The expected private setup message was not received within 90 seconds");

    const validationTopic = await call(token, "createForumTopic", {
      chat_id: selected.chat.id,
      name: "Pi threaded-mode validation",
    });
    await call(token, "sendMessageDraft", {
      chat_id: selected.chat.id,
      message_thread_id: validationTopic.message_thread_id,
      draft_id: 1,
      text: "Streaming validation",
    });
    await call(token, "deleteForumTopic", {
      chat_id: selected.chat.id,
      message_thread_id: validationTopic.message_thread_id,
    });

    let config = {
      chatId: selected.chat.id,
      allowedUserId: selected.from.id,
      bridgeSecret: randomBytes(32).toString("hex"),
      port: DEFAULT_PORT,
      linkPreview: false,
      wakeMode: false,
      wakeDefaultCwd: "",
      wakeAllowedRoots: [],
      wakePiCommand: "pi",
      wakePiCommandArgs: [],
      wakeOpenTerminal: true,
    };
    let state = { offset, mappings: [], pendingReplies: [], topics: [] };
    ({ config, state } = await mergePreviousInstallation(config, state, selected));

    await writeStagedFiles([
      { file: SECRET_PATH, content: `${token}\n`, options: { mode: 0o600 } },
      { file: CONFIG_PATH, content: `${JSON.stringify(config, null, 2)}\n`, options: { mode: 0o600 } },
      { file: STATE_PATH, content: `${JSON.stringify(state, null, 2)}\n`, options: { mode: 0o600 } },
    ]);
    await call(token, "sendMessage", {
      chat_id: selected.chat.id,
      text: "Pi threaded Telegram extension is configured successfully.",
    });
    stdout.write(`Saved token to ${SECRET_PATH}\n`);
    stdout.write(`Saved routing config to ${CONFIG_PATH}\n`);
    stdout.write("Setup complete. Return to Pi and ask it to finish the migration.\n");
  } finally {
    terminal.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ mergePreviousInstallation, preserveOperationalConfig, writeStagedFiles });
