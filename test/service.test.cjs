const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { launchAgent, systemdUnit, windowsTaskCommand, windowsTaskXml } = require("../service.cjs");

test("builds a quoted Windows Scheduled Task command", () => {
  assert.equal(
    windowsTaskCommand("C:\\Program Files\\node.exe", "C:\\Pi Agent\\daemon.cjs"),
    '"C:\\Program Files\\node.exe" "C:\\Pi Agent\\daemon.cjs"',
  );
});

test("builds a hidden supervised unlimited-runtime Windows task", () => {
  const task = windowsTaskXml(
    "C:\\node.exe",
    "C:\\Pi\\daemon.cjs",
    "DESKTOP\\User",
    "C:\\Windows\\System32\\wscript.exe",
    "C:\\Pi\\daemon-windows.vbs",
  );
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count><\/RestartOnFailure>/);
  assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(task, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(task, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/);
  assert.match(task, /\/\/B \/\/NoLogo &quot;C:\\Pi\\daemon-windows\.vbs&quot; &quot;C:\\node\.exe&quot; &quot;C:\\Pi\\daemon\.cjs&quot;/);
});

test("Windows launcher waits for the daemon and returns its exit code", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi telegram service test-"));
  const fakeDaemon = path.join(directory, "fake daemon.cjs");
  const marker = path.join(directory, "finished.txt");
  writeFileSync(fakeDaemon, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done"); process.exitCode = 7;\n`);
  try {
    const child = spawnSync("cscript.exe", [
      "//B",
      "//NoLogo",
      path.resolve(__dirname, "../daemon-windows.vbs"),
      process.execPath,
      fakeDaemon,
    ], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 7, child.stderr);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds a restartable Linux systemd user unit", () => {
  const unit = systemdUnit("/usr/bin/node", "/home/me/pi notify/daemon.cjs", "/home/me/.pi/agent", "/home/me/bin:/usr/bin");
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/me\/pi notify\/daemon\.cjs"/);
  assert.match(unit, /Environment="PATH=\/home\/me\/bin:\/usr\/bin"/);
  assert.match(unit, /PassEnvironment=DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("builds a keep-alive macOS LaunchAgent with escaped paths", () => {
  const plist = launchAgent("/opt/A&B/node", "/Users/me/pi<notify>/daemon.cjs", "/Users/me/.pi/agent", "/opt/homebrew/bin:/usr/bin");
  assert.match(plist, /com\.johnsonran\.pi-notify-telegram/);
  assert.match(plist, /\/opt\/A&amp;B\/node/);
  assert.match(plist, /pi&lt;notify&gt;\/daemon\.cjs/);
  assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/bin/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});
