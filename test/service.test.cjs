const assert = require("node:assert/strict");
const test = require("node:test");

const { launchAgent, systemdUnit, windowsTaskCommand, windowsTaskXml } = require("../service.cjs");

test("builds a quoted Windows Scheduled Task command", () => {
  assert.equal(
    windowsTaskCommand("C:\\Program Files\\node.exe", "C:\\Pi Agent\\daemon.cjs"),
    '"C:\\Program Files\\node.exe" "C:\\Pi Agent\\daemon.cjs"',
  );
});

test("builds a supervised unlimited-runtime Windows task", () => {
  const task = windowsTaskXml("C:\\node.exe", "C:\\Pi\\daemon.cjs", "DESKTOP\\User");
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count><\/RestartOnFailure>/);
  assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(task, /<LogonType>InteractiveToken<\/LogonType>/);
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
