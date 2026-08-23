const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { mergePreviousInstallation, preserveOperationalConfig, writeStagedFiles } = require("../setup.cjs");

test("rerunning setup preserves valid operational preferences", () => {
  const config = {
    port: 43871,
    linkPreview: false,
    wakeMode: false,
    wakeDefaultCwd: "",
    wakeAllowedRoots: [],
    wakePiCommand: "pi",
    wakePiCommandArgs: [],
    wakeOpenTerminal: true,
  };

  preserveOperationalConfig(config, {
    port: 44000,
    linkPreview: true,
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
    wakePiCommand: "custom-pi",
    wakePiCommandArgs: ["--profile", "wake"],
    wakeOpenTerminal: false,
  });

  assert.deepEqual(config, {
    port: 44000,
    linkPreview: true,
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
    wakePiCommand: "custom-pi",
    wakePiCommandArgs: ["--profile", "wake"],
    wakeOpenTerminal: false,
  });
});

test("rerunning setup preserves config when the previous state file is missing", async () => {
  const config = {
    chatId: 42,
    allowedUserId: 42,
    port: 43871,
    wakeMode: false,
    wakeAllowedRoots: [],
    wakeOpenTerminal: true,
  };
  const state = { offset: 7, mappings: [], pendingReplies: [], topics: [] };
  const read = async (file) => {
    if (file.endsWith("pi-notify-telegram.json")) {
      return JSON.stringify({ ...config, port: 44000, wakeMode: true, wakeAllowedRoots: ["F:\\"], wakeOpenTerminal: false });
    }
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };
  const merged = await mergePreviousInstallation(config, state, { chat: { id: 42 }, from: { id: 42 } }, read);
  assert.equal(merged.config.port, 44000);
  assert.equal(merged.config.wakeMode, true);
  assert.deepEqual(merged.config.wakeAllowedRoots, ["F:\\"]);
  assert.equal(merged.config.wakeOpenTerminal, false);
  assert.equal(merged.state, state);
});

test("stages all setup files before replacing their destinations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-notify-telegram-setup-stage-"));
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  try {
    await Promise.all([writeFile(first, "old one"), writeFile(second, "old two")]);
    await writeStagedFiles([
      { file: first, content: "one", options: { mode: 0o600 } },
      { file: second, content: "two", options: { mode: 0o600 } },
    ]);
    assert.equal(await readFile(first, "utf8"), "one");
    assert.equal(await readFile(second, "utf8"), "two");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rerunning setup ignores invalid operational preferences", () => {
  const config = {
    port: 43871,
    linkPreview: false,
    wakeMode: false,
    wakeDefaultCwd: "",
    wakeAllowedRoots: [],
    wakePiCommand: "pi",
    wakePiCommandArgs: [],
    wakeOpenTerminal: true,
  };

  preserveOperationalConfig(config, {
    port: 0,
    linkPreview: "yes",
    wakeMode: 1,
    wakeDefaultCwd: null,
    wakeAllowedRoots: ["F:\\", 42],
    wakePiCommand: "",
    wakePiCommandArgs: [null],
    wakeOpenTerminal: "yes",
  });

  assert.deepEqual(config, {
    port: 43871,
    linkPreview: false,
    wakeMode: false,
    wakeDefaultCwd: "",
    wakeAllowedRoots: [],
    wakePiCommand: "pi",
    wakePiCommandArgs: [],
    wakeOpenTerminal: true,
  });
});
