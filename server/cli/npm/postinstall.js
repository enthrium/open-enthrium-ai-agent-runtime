#!/usr/bin/env node
"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const VERSION = require("./package.json").version;

const BINARY = {
  win32:  "oe-runtime-win.exe",
  linux:  "oe-runtime-linux",
  darwin: "oe-runtime-macos",
}[process.platform];

if (!BINARY) {
  console.error(`OE Runtime: unsupported platform "${process.platform}"`);
  process.exit(1);
}

const URL  = `https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/download/v${VERSION}/${BINARY}`;
const DEST = path.join(__dirname, "bin", BINARY);

function download(url, dest, redirects) {
  if (redirects > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + ".tmp";
    const file = fs.createWriteStream(tmp);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(tmp);
        return download(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(tmp);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          fs.renameSync(tmp, dest);
          resolve();
        });
      });
    }).on("error", (err) => {
      file.close();
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      reject(err);
    });
  });
}

(async () => {
  console.log(`OE Runtime: downloading binary for ${process.platform}...`);
  await download(URL, DEST, 0);
  if (process.platform !== "win32") fs.chmodSync(DEST, "755");
  console.log("OE Runtime: ready.");
})().catch((err) => {
  console.error("OE Runtime: failed to download binary —", err.message);
  console.error(`Download manually from: ${URL}`);
  process.exit(1);
});
