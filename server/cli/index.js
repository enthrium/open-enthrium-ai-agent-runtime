#!/usr/bin/env node
"use strict";

const fs       = require("fs");
const path     = require("path");
const yaml     = require("js-yaml");
const readline = require("readline");

const engine              = require("../src/engine");
const { prepareConnectors } = require("../src/utils/prepareConnectors");
const VERSION             = require("../package.json").version;

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

const agentFile   = args[0];
let   configFile  = "oe-config.json";
let   inputMsg    = null;
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

const config    = loadConfig(configFile);
const llmConfig = config.llm;

if (!llmConfig?.provider || !llmConfig?.apiKey) {
  console.error("\nError: config.json must have { llm: { provider, apiKey, model } }\n");
  process.exit(1);
}

// ── connector matching ───────────────────────────────────────────────────────
// YAML lists connectors by name+type only (no secrets).
// Config has credentials. Match by name first, then by type.

// prepareConnectors is now in src/utils/prepareConnectors.js (shared with SDK).
// Wrap it here to preserve the CLI-specific "no config entry" warning.
function prepareConnectorsWithWarning(yamlConnectors, configConnectors) {
  const result = prepareConnectors(yamlConnectors, configConnectors);
  // Warn for any connector that got empty creds (no config match)
  (yamlConnectors || []).forEach((yc, i) => {
    if (result[i]?.authConfig === "{}") {
      const name = yc.connection_name || yc.name;
      const type = yc.connection_type || yc.type;
      console.warn(`  ⚠  No config entry for connector "${name}" (${type}) — tool calls will fail`);
    }
  });
  return result;
}

// ── manual approval prompt ────────────────────────────────────────────────────

function askApproval(agentName) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  Approve? (y/n): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ── chain runner ──────────────────────────────────────────────────────────────

async function runChains(chains, output, currentAgentFile, depth) {
  const MAX_DEPTH = 5;
  if (!chains?.length) return;
  if (depth >= MAX_DEPTH) {
    console.warn(`\n  ⚠  Max chain depth (${MAX_DEPTH}) reached — stopping`);
    return;
  }

  for (const chain of chains) {
    const nextAgent   = chain.next_agent   || chain.nextAgent;
    const triggerType = chain.trigger_type || chain.triggerType || "auto";

    if (!nextAgent) continue;

    console.log(`\n${"─".repeat(52)}`);
    console.log(`  🔗  Chain: ${nextAgent}`);
    console.log(`      Trigger    : ${triggerType}`);

    if (triggerType === "manual") {
      console.log(`      Output     : ${output.slice(0, 120)}${output.length > 120 ? "…" : ""}`);
      const approved = await askApproval(nextAgent);
      if (!approved) {
        console.log(`  ⏭  Chain rejected\n`);
        continue;
      }
    }

    const nextPath = path.resolve(path.dirname(path.resolve(currentAgentFile)), nextAgent);
    if (!fs.existsSync(nextPath)) {
      console.warn(`  ⚠  Chain agent not found: ${nextPath}`);
      continue;
    }

    await runAgent(nextPath, output, depth);
  }
}

// ── agent runner ──────────────────────────────────────────────────────────────

async function runAgent(agentFile, inputContext, depth = 0) {
  const agentYaml  = yaml.load(fs.readFileSync(agentFile, "utf8"));
  const connectors = prepareConnectorsWithWarning(agentYaml.connectors, config.connectors);

  const agentSpec = {
    systemPrompt: agentYaml.systemPrompt || agentYaml.system_prompt || agentYaml.instructions || "",
    workflow:     agentYaml.steps        || agentYaml.workflow       || [],
    params:       agentYaml.params       || [],
    paramValues,
    maxRounds:    agentYaml.maxRounds    || 25,
    input:        inputContext
      ? `Context from previous agent:\n\n${inputContext}\n\nNow execute your task.`
      : inputMsg,
  };

  const line = "─".repeat(52);

  console.log(`\n${line}`);
  if (depth === 0) {
    console.log(`  🚀   OE Runtime Standalone  v${VERSION}`);
    console.log(`        Run AI agents via CLI`);
  } else {
    console.log(`  🔗   Chained Agent  (depth: ${depth})`);
  }
  console.log(`${line}`);
  console.log(`\n🤖  ${agentYaml.name || path.basename(agentFile)}`);
  if (agentYaml.description) console.log(`    ${agentYaml.description}`);
  console.log(`\n    LLM        ${llmConfig.provider} / ${llmConfig.model || "default"}`);
  if (connectors.length) {
    console.log(`    Connectors ${connectors.map(c => `${c.name} (${c.type})`).join(", ")}`);
  }
  if (agentYaml.chains?.length) {
    console.log(`    Chains     ${agentYaml.chains.map(c => c.next_agent || c.nextAgent).join(", ")}`);
  }
  console.log(`\n${line}\n`);

  const { output } = await engine.run(agentSpec, llmConfig, connectors, {
    onToolCall:   (name)         => console.log(`  🔧  ${name}`),
    onToolResult: (name, result) => console.log(`      ↳ ${result.slice(0, 300)}${result.length > 300 ? "…" : ""}`),
    onError:      (err)          => { throw err; },
  });

  console.log(`\n${line}\n`);
  console.log(output);
  console.log(`\n✅  Done${depth > 0 ? ` — ${agentYaml.name || path.basename(agentFile)}` : ""}\n`);

  // Process chains after this agent completes
  await runChains(agentYaml.chains, output, agentFile, depth + 1);

  return output;
}

// ── kick off ──────────────────────────────────────────────────────────────────

runAgent(agentFile, null, 0).catch(err => {
  console.error(`\nFatal: ${err.message}\n`);
  process.exit(1);
});

} // end single-run mode
