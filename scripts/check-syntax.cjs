#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const files = [
  ...readdirSync(root).filter((file) => file.endsWith(".cjs")).map((file) => path.join(root, file)),
  ...readdirSync(path.join(root, "src")).filter((file) => file.endsWith(".cjs")).map((file) => path.join(root, "src", file)),
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
