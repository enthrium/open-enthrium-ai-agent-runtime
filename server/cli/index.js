#!/usr/bin/env node
"use strict";

const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const engine = require("../src/engine");

// ── arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function usage() {
  console.log(`
oe-runtime — Open Enthrium Agent Runner

Usage:
  oe-runtime <agent.yaml> [options]   Run an agent once
  oe-runtime --serve     [options]    Start an HTTP API server

Options:
  --config <file>      Config file with LLM keys + connector creds  (default: oe-config.json)
  --input  <text>      User message / context to pass to the agent  (single-run only)
  --param  key=value   Set a param value (repeatable); substitutes {{key}} in the agent prompt
  --help               Show this help

Examples:
  oe-runtime security-monitor.yaml
  oe-runtime outbound-sales.yaml --config ~/my-config.json
  oe-runtime blog-publisher.yaml --input "publish topic: AI trends 2025"
  oe-runtime logo-generator.yaml --param company_name="TechFlow" --param style="minimalist"
  oe-runtime --serve
  oe-runtime --serve --config /etc/oe/prod-config.json
`);
  process.exit(0);
}

// ── config loader — tolerates literal newlines in private keys ───────────────

function loadConfig(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try { return JSON.parse(raw); } catch (_) {}
  // Walk the string as a state machine, escaping bare newlines inside JSON strings
  let out = ""; let inStr = false; let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc)            { out += c; esc = false; continue; }
    if (c === "\\" && inStr) { out += c; esc = true; continue; }
    if (c === '"')      { out += c; inStr = !inStr; continue; }
    if (inStr && c === "\r") continue;          // drop bare CR
    if (inStr && c === "\n") { out += "\\n"; continue; } // escape bare LF
    out += c;
  }
  return JSON.parse(out);
}

// ── detect config file early (needed to check server.enabled) ────────────────

let _earlyCfgFile = "oe-config.json";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config" && args[i + 1]) { _earlyCfgFile = args[i + 1]; break; }
}
let _serverEnabledViaCfg = false;
if (fs.existsSync(_earlyCfgFile)) {
  try { _serverEnabledViaCfg = loadConfig(_earlyCfgFile)?.server?.enabled === true; }
  catch (e) {}
}

if ((!args.length || args.includes("--help") || args.includes("-h")) && !_serverEnabledViaCfg) usage();

// ── serve mode ───────────────────────────────────────────────────────────────

if (args.includes("--serve") || _serverEnabledViaCfg) {
  const cfgFile = _earlyCfgFile;
  if (!fs.existsSync(cfgFile)) {
    console.error(`\nError: config file not found: ${cfgFile}`);
    console.error(`Download a starter kit from the Sample Library: https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-samples.zip\n`);
    process.exit(1);
  }
  const serveCfg = loadConfig(cfgFile);
  if (!serveCfg.llm?.provider || !serveCfg.llm?.apiKey) {
    console.error("\nError: config must have { llm: { provider, apiKey, model } }\n");
    process.exit(1);
  }
  require("./server").start(serveCfg);
} else {

// ── single-run mode ──────────────────────────────────────────────────────────

const agentFile  = args[0];
let configFile   = "oe-config.json";
let inputMsg     = null;
const paramValues = {};

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--config" && args[i + 1]) { configFile = args[++i]; continue; }
  if (args[i] === "--input"  && args[i + 1]) { inputMsg   = args[++i]; continue; }
  if (args[i] === "--param"  && args[i + 1]) {
    const pair = args[++i];
    const eq   = pair.indexOf("=");
    if (eq > 0) paramValues[pair.slice(0, eq)] = pair.slice(eq + 1);
    continue;
  }
}

// ── load files ───────────────────────────────────────────────────────────────

if (!fs.existsSync(agentFile)) {
  console.error(`\nError: agent file not found: ${agentFile}\n`);
  process.exit(1);
}
if (!fs.existsSync(configFile)) {
  console.error(`\nError: config file not found: ${configFile}`);
  console.error(`Download a starter kit from the Sample Library: https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-samples.zip\n`);
  process.exit(1);
}

const agentYaml = yaml.load(fs.readFileSync(agentFile, "utf8"));
const config    = loadConfig(configFile);

// ── connector matching ───────────────────────────────────────────────────────
// YAML lists connectors by name+type only (no secrets).
// Config has credentials. Match by name first, then by type.

function prepareConnectors(yamlConnectors, configConnectors) {
  // Support object format { "Name": { type, ...creds } } as well as legacy array format
  let cfgArray;
  if (Array.isArray(configConnectors)) {
    cfgArray = configConnectors;
  } else if (configConnectors && typeof configConnectors === "object") {
    cfgArray = Object.entries(configConnectors).map(([name, cfg]) => ({
      connection_name: name,
      connection_type: cfg.type,
      ...cfg,
    }));
  } else {
    cfgArray = [];
  }

  return (yamlConnectors || []).map((yc, i) => {
    // Normalise YAML connector fields — accept both new (connection_*) and legacy (name/type)
    const ycName = yc.connection_name || yc.name;
    const ycType = yc.connection_type || yc.type;

    // Match by name first, then fall back to type
    const cc = cfgArray.find(c => (c.connection_name || c.name) === ycName)
            || cfgArray.find(c => (c.connection_type || c.type) === ycType);

    if (!cc) {
      console.warn(`  ⚠  No config entry for connector "${ycName}" (${ycType}) — tool calls will fail`);
      return { id: i + 1, name: ycName, type: ycType, status: "active", authConfig: "{}", config: "{}" };
    }

    const { connection_name, connection_type, name, type, ...creds } = cc;
    const resolvedName = connection_name || name || ycName;
    const resolvedType = connection_type || type || ycType;

    // Support privateKeyPath so users don't have to embed raw keys in JSON.
    // Normalize line endings — Windows \r\n breaks ssh2 key parsing.
    if (creds.privateKeyPath) {
      const keyPath = creds.privateKeyPath.replace(/^~/, require("os").homedir());
      creds.privateKey = fs.readFileSync(keyPath, "utf8").replace(/\r\n/g, "\n");
      delete creds.privateKeyPath;
    }
    // Also normalize inline privateKey if provided
    if (creds.privateKey) {
      creds.privateKey = creds.privateKey.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
    }

    return {
      id:         i + 1,
      name:       resolvedName,
      type:       resolvedType,
      status:     "active",
      authConfig: JSON.stringify(creds),
      config:     JSON.stringify(creds),
    };
  });
}

const connectors = prepareConnectors(agentYaml.connectors, config.connectors);
const llmConfig  = config.llm;

if (!llmConfig?.provider || !llmConfig?.apiKey) {
  console.error("\nError: config.json must have { llm: { provider, apiKey, model } }\n");
  process.exit(1);
}

// ── normalise agentSpec ──────────────────────────────────────────────────────
// YAML fields → engine contract fields

const agentSpec = {
  systemPrompt: agentYaml.systemPrompt || agentYaml.system_prompt || agentYaml.instructions || "",
  workflow:     agentYaml.steps        || agentYaml.workflow       || [],
  params:       agentYaml.params       || [],
  paramValues:  paramValues,
  maxRounds:    agentYaml.maxRounds    || 25,
  input:        inputMsg,
};

// ── run ──────────────────────────────────────────────────────────────────────

const line = "─".repeat(60);

console.log(`\n🤖  ${agentYaml.name || path.basename(agentFile)}`);
if (agentYaml.description) console.log(`    ${agentYaml.description}`);
console.log(`\n    LLM        ${llmConfig.provider} / ${llmConfig.model || "default"}`);
if (connectors.length) {
  console.log(`    Connectors ${connectors.map(c => `${c.name} (${c.type})`).join(", ")}`);
}
console.log(`\n${line}\n`);

engine.run(agentSpec, llmConfig, connectors, {
  onToolCall:   (name)         => console.log(`  🔧  ${name}`),
  onToolResult: (name, result) => console.log(`      ↳ ${result.slice(0, 300)}${result.length > 300 ? "…" : ""}`),
  onDone: (output) => {
    console.log(`\n${line}\n`);
    console.log(output);
    console.log("\n✅  Done\n");
  },
  onError: (err) => {
    console.error(`\n❌  ${err.message}\n`);
    process.exit(1);
  },
}).catch(err => {
  console.error(`\nFatal: ${err.message}\n`);
  process.exit(1);
});

} // end single-run mode
