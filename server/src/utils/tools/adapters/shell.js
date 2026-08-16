"use strict";

const { exec }  = require("child_process");
const path      = require("path");
const os        = require("os");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConfig(connector) {
  const auth   = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const config = connector.config     ? JSON.parse(connector.config)     : {};
  return {
    cwd:     auth.cwd     || config.cwd     || process.cwd(),
    timeout: parseInt(auth.timeout || config.timeout || "30"),
    shell:   auth.shell   || config.shell   || (os.platform() === "win32" ? "cmd" : "bash"),
  };
}

function runCommand(command, cfg) {
  const timeoutMs = Math.min(cfg.timeout, 300) * 1000;
  const cwd = path.resolve(cfg.cwd);
  const shellOpt = cfg.shell === "cmd"
    ? { shell: "cmd.exe" }
    : { shell: cfg.shell === "sh" ? "/bin/sh" : "/bin/bash" };

  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4, ...shellOpt }, (err, stdout, stderr) => {
      if (err && err.killed) {
        resolve({ stdout: stdout || "", stderr: stderr || "", exit_code: -1, error: `Command timed out after ${cfg.timeout}s` });
      } else {
        resolve({ stdout: stdout || "", stderr: stderr || "", exit_code: err ? (err.code ?? 1) : 0 });
      }
    });
  });
}

function formatResult({ stdout, stderr, exit_code, error }) {
  const parts = [];
  if (error)               parts.push(`Error: ${error}`);
  if (stdout.trim())       parts.push(stdout.trim());
  if (stderr.trim())       parts.push(`STDERR:\n${stderr.trim()}`);
  parts.push(`exit_code: ${exit_code}`);
  return parts.join("\n\n").slice(0, 8000);
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name:        `conn_${connector.id}_exec`,
        description: `Run a shell command on the local machine (${connector.name}). Use to execute Python, PHP, Node.js, Java, Bash scripts or any installed CLI tool. Returns stdout, stderr, and exit code.`,
        parameters: {
          type:       "object",
          properties: {
            command: { type: "string", description: "The shell command to run (e.g. 'python3 script.py --arg value')." },
            cwd:     { type: "string", description: "Working directory override. Defaults to the cwd set in oe-config.json." },
            timeout: { type: "number", description: "Timeout in seconds (default from config, max 300)." },
          },
          required: ["command"],
        },
      },
    },
  ];
}

function getAnthropicToolDefinitions(connector) {
  return getToolDefinitions(connector).map(t => ({
    name:         t.function.name,
    description:  t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ─── Execute ──────────────────────────────────────────────────────────────────

async function executeTool(action, args, connector) {
  if (action !== "exec") return `Unknown shell action: ${action}`;

  const { command, cwd: cwdOverride, timeout: timeoutOverride } = args;
  if (!command) return "Missing required field: command.";

  const cfg = getConfig(connector);
  if (cwdOverride)     cfg.cwd     = cwdOverride;
  if (timeoutOverride) cfg.timeout = Math.min(parseInt(timeoutOverride), 300);

  try {
    const result = await runCommand(command, cfg);
    return formatResult(result);
  } catch (err) {
    return `Shell error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
