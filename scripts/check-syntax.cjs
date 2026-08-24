#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function collectCommonJsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectCommonJsFiles(file);
    return entry.name.endsWith(".cjs") ? [file] : [];
  });
}

const files = [
  ...readdirSync(root).filter((file) => file.endsWith(".cjs")).map((file) => path.join(root, file)),
  ...collectCommonJsFiles(path.join(root, "src")),
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
