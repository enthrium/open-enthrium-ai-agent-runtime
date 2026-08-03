#!/usr/bin/env node
"use strict";

const path      = require("path");
const fs        = require("fs");
const { spawn } = require("child_process");

const BINARY = {
  win32:  "oe-runtime-win.exe",
  linux:  "oe-runtime-linux",
  darwin: "oe-runtime-macos",
}[process.platform];

if (!BINARY) {
  console.error(`OE Runtime: unsupported platform "${process.platform}"`);
  process.exit(1);
}

const BIN_PATH = path.join(__dirname, "bin", BINARY);

if (!fs.existsSync(BIN_PATH)) {
  console.error("OE Runtime: binary not found. Try reinstalling: npm install -g @openenthrium/oe-runtime");
  process.exit(1);
}

const cwd = process.env.INIT_CWD || process.cwd();
const child = spawn(BIN_PATH, process.argv.slice(2), { stdio: "inherit", cwd });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("OE Runtime:", err.message);
  process.exit(1);
});
