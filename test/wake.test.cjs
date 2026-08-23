const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdtemp, mkdir, realpath, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WakeLauncher, parseControlCommand, resolveWakeCwd } = require("../src/wake.cjs");

test("parses General-topic wake commands", () => {
  assert.deepEqual(parseControlCommand("/new F:\\Work | inspect this"), {
    command: "new",
    cwd: "F:\\Work",
    prompt: "inspect this",
  });
  assert.deepEqual(parseControlCommand("/new | hello"), { command: "new", cwd: "", prompt: "hello" });
  assert.deepEqual(parseControlCommand("/sessions@my_bot"), { command: "sessions" });
  assert.equal(parseControlCommand("normal text"), undefined);
});

test("resolves wake cwd only inside configured roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-telegram-wake-"));
  const child = path.join(root, "project");
  await mkdir(child);
  try {
    assert.equal(await resolveWakeCwd("project", root, [root]), await realpath(child));
    await assert.rejects(resolveWakeCwd(path.dirname(root), root, [root]), /outside wakeAllowedRoots/);
    await assert.rejects(resolveWakeCwd("missing", root, [root]), /does not exist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launches one full-permission Pi process per session", async () => {
  const calls = [];
  let child;
  const launcher = new WakeLauncher({
    piCommand: "pi-test",
    spawn(command, args, options) {
      child = new EventEmitter();
      child.pid = 123;
      calls.push({ command, args, options });
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
  });
  const first = await launcher.launch({ sessionId: "session-1", cwd: process.cwd(), sessionName: "Test", prompt: "hello" });
  const second = await launcher.launch({ sessionId: "session-1", cwd: process.cwd(), sessionName: "Test", prompt: "again" });
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pi-test");
  assert.deepEqual(calls[0].args, ["--session-id", "session-1", "--name", "Test", "--print", "--approve", "Telegram message:\nhello"]);
  assert.equal(calls[0].options.windowsHide, true);
  child.emit("exit", 0, null);
  assert.equal(launcher.isRunning("session-1"), false);

  for (const prompt of ["--help", "--no-tools", "--session-id other", "@sensitive-file"]) {
    await launcher.launch({ sessionId: prompt, cwd: process.cwd(), sessionName: "Test", prompt });
    assert.equal(calls.at(-1).args.at(-1), `Telegram message:\n${prompt}`);
    child.emit("exit", 0, null);
  }
});
