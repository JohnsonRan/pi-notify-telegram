#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { daemonLogPath } = require("./src/daemon-log.cjs");

const SERVICE_NAME = "pi-notify-telegram";
const WINDOWS_TASK = "PiNotifyTelegram";
const MAC_LABEL = "com.johnsonran.pi-notify-telegram";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent");
const DAEMON_PATH = path.join(__dirname, "daemon.cjs");
const WINDOWS_DAEMON_LAUNCHER_PATH = path.join(__dirname, "daemon-windows.vbs");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

function systemdPath() {
  return path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

function launchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

function windowsTaskCommand(nodePath = process.execPath, daemonPath = DAEMON_PATH) {
  return `"${nodePath}" "${daemonPath}"`;
}

function windowsTaskXml(
  nodePath = process.execPath,
  daemonPath = DAEMON_PATH,
  userId = `${process.env.USERDOMAIN || ""}\\${process.env.USERNAME || ""}`,
  wscriptPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"),
  launcherPath = WINDOWS_DAEMON_LAUNCHER_PATH,
) {
  const argumentsText = `//B //NoLogo "${launcherPath}" "${nodePath}" "${daemonPath}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(userId)}</UserId></LogonTrigger></Triggers>\n<Principals><Principal id="Author"><UserId>${xml(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowStartOnDemand>true</AllowStartOnDemand><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>\n<Actions Context="Author"><Exec><Command>${xml(wscriptPath)}</Command><Arguments>${xml(argumentsText)}</Arguments><WorkingDirectory>${xml(path.dirname(daemonPath))}</WorkingDirectory></Exec></Actions>\n</Task>\n`;
}

function systemdUnit(nodePath = process.execPath, daemonPath = DAEMON_PATH, agentDir = AGENT_DIR, environmentPath = process.env.PATH || "") {
  return `[Unit]\nDescription=Pi Telegram wake broker\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${JSON.stringify(nodePath)} ${JSON.stringify(daemonPath)}\nEnvironment=${JSON.stringify(`PI_CODING_AGENT_DIR=${agentDir}`)}\nEnvironment=${JSON.stringify(`PATH=${environmentPath}`)}\nPassEnvironment=DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
}

function launchAgent(nodePath = process.execPath, daemonPath = DAEMON_PATH, agentDir = AGENT_DIR, environmentPath = process.env.PATH || "") {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${MAC_LABEL}</string>\n<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(daemonPath)}</string></array>\n<key>EnvironmentVariables</key><dict><key>PI_CODING_AGENT_DIR</key><string>${xml(agentDir)}</string><key>PATH</key><string>${xml(environmentPath)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n</dict></plist>\n`;
}

function installWindows() {
  const file = path.join(os.tmpdir(), `${SERVICE_NAME}-${process.pid}.xml`);
  writeFileSync(file, `\uFEFF${windowsTaskXml()}`, { encoding: "utf16le" });
  try {
    run("schtasks.exe", ["/Create", "/TN", WINDOWS_TASK, "/XML", file, "/F"]);
  } finally {
    rmSync(file, { force: true });
  }
  run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK]);
}

function uninstallWindows() {
  try { run("schtasks.exe", ["/End", "/TN", WINDOWS_TASK]); } catch {}
  run("schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
}

function installLinux() {
  const file = systemdPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, systemdUnit());
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
}

function uninstallLinux() {
  try { run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]); } catch {}
  rmSync(systemdPath(), { force: true });
  run("systemctl", ["--user", "daemon-reload"]);
}

function installMac() {
  const file = launchAgentPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, launchAgent());
  try { run("launchctl", ["bootout", `gui/${process.getuid()}`, file]); } catch {}
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, file]);
}

function uninstallMac() {
  const file = launchAgentPath();
  try { run("launchctl", ["bootout", `gui/${process.getuid()}`, file]); } catch {}
  rmSync(file, { force: true });
}

function serviceAction(action) {
  if (process.platform === "win32") {
    if (action === "install") return installWindows();
    if (action === "uninstall") return uninstallWindows();
    if (action === "start") return run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK]);
    if (action === "stop") return run("schtasks.exe", ["/End", "/TN", WINDOWS_TASK]);
    if (action === "status") return run("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK, "/V", "/FO", "LIST"]);
  } else if (process.platform === "darwin") {
    const target = `gui/${process.getuid()}/${MAC_LABEL}`;
    if (action === "install") return installMac();
    if (action === "uninstall") return uninstallMac();
    if (action === "start") return run("launchctl", ["bootstrap", `gui/${process.getuid()}`, launchAgentPath()]);
    if (action === "stop") return run("launchctl", ["bootout", `gui/${process.getuid()}`, launchAgentPath()]);
    if (action === "status") return run("launchctl", ["print", target]);
  } else {
    if (action === "install") return installLinux();
    if (action === "uninstall") return uninstallLinux();
    if (["start", "stop", "status"].includes(action)) return run("systemctl", ["--user", action, SERVICE_NAME]);
  }
  throw new Error(`Unknown action: ${action}`);
}

if (require.main === module) {
  const action = String(process.argv[2] || "status").toLowerCase();
  if (!["install", "uninstall", "start", "stop", "status"].includes(action)) {
    console.error("Usage: node service.cjs <install|uninstall|start|stop|status>");
    process.exit(2);
  }

  try {
    serviceAction(action);
    if (action === "install") console.log(`Installed and started ${SERVICE_NAME} for ${process.platform}.`);
    if (action === "status") console.log(`Daemon log: ${daemonLogPath(AGENT_DIR)}`);
    if (action === "uninstall") console.log(`Uninstalled ${SERVICE_NAME} for ${process.platform}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = Object.freeze({ launchAgent, serviceAction, systemdUnit, windowsTaskCommand, windowsTaskXml });
