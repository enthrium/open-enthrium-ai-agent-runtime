"use strict";
const { execSync }                      = require("child_process");
const { copyFileSync, mkdirSync, existsSync } = require("fs");
const path                              = require("path");

const platform = process.platform;
const isMcp    = process.argv.includes("--mcp");

const outName = isMcp
  ? (platform === "win32"  ? "oe-mcp-win.exe"
   : platform === "darwin" ? "oe-mcp-macos"
   :                         "oe-mcp-linux")
  : (platform === "win32"  ? "oe-runtime-win.exe"
   : platform === "darwin" ? "oe-runtime-macos"
   :                         "oe-runtime-linux");

const outDir  = isMcp ? "mcp/dist" : "cli";
const outPath = `${outDir}/${outName}`;
const blob    = isMcp ? "mcp/sea-prep.blob" : "cli/sea-prep.blob";

// On Windows CI, process.execPath may be a runner-wrapped binary that produces
// a broken SEA. Allow overriding with CANONICAL_NODE_EXE env var.
const nodeSrc = (platform === "win32" && process.env.CANONICAL_NODE_EXE && existsSync(process.env.CANONICAL_NODE_EXE))
  ? process.env.CANONICAL_NODE_EXE
  : process.execPath;

console.log(`Using node binary: ${nodeSrc}`);
mkdirSync(outDir, { recursive: true });
copyFileSync(nodeSrc, outPath);

const macFlag = platform === "darwin" ? " --macho-segment-name NODE_SEA" : "";
execSync(
  `npx postject "${outPath}" NODE_SEA_BLOB "${blob}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2${macFlag}`,
  { stdio: "inherit" }
);

if (platform === "darwin") {
  execSync(`codesign --sign - "${outPath}"`, { stdio: "inherit" });
}

if (platform !== "win32") {
  execSync(`chmod +x "${outPath}"`);
}

console.log(`\n✅  ${outPath} ready`);
