#!/usr/bin/env node
"use strict";

const fs       = require("fs");
const path     = require("path");
const https    = require("https");
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

// An explicit agent-file argument always means single-run mode, even if the
// config has server.enabled: true.  Only auto-start the server when no agent
// file was passed on the command line.
const _hasExplicitAgentArg = args.length > 0 && !args[0].startsWith("--");

if ((!args.length || args.includes("--help") || args.includes("-h")) && !(_serverEnabledViaCfg && !_hasExplicitAgentArg)) usage();

// ── serve mode ───────────────────────────────────────────────────────────────

if (args.includes("--serve") || (_serverEnabledViaCfg && !_hasExplicitAgentArg)) {
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

let   agentArg    = args[0];
let   configFile  = null;          // resolved below after we know agentFile dir
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

// ── resolve agent file — accept folder or .yaml path ─────────────────────────
// If a folder is passed, look for agent.yaml inside it.

// Always resolve to an absolute path immediately — npx changes cwd internally,
// so any relative path would break later path.resolve calls inside runSkills/runPlugins.
let agentFile = path.resolve(agentArg);
if (fs.existsSync(agentFile) && fs.statSync(agentFile).isDirectory()) {
  agentFile = path.join(agentFile, "agent.yaml");
}

// ── resolve oe-config.json ────────────────────────────────────────────────────
// Priority: --config flag → same folder as agent.yaml → cwd

if (!configFile) {
  const agentDir     = path.dirname(path.resolve(agentFile));
  const siblingCfg   = path.join(agentDir, "oe-config.json");
  const cwdCfg       = path.join(process.cwd(), "oe-config.json");
  configFile = fs.existsSync(siblingCfg) ? siblingCfg
             : fs.existsSync(cwdCfg)     ? cwdCfg
             : siblingCfg;               // will fail below with a clear error
}

// ── load files ───────────────────────────────────────────────────────────────

if (!fs.existsSync(agentFile)) {
  console.error(`\nError: agent file not found: ${agentFile}\n`);
  process.exit(1);
}
if (!fs.existsSync(configFile)) {
  console.error(`\nError: oe-config.json not found.`);
  console.error(`  Looked in: ${path.dirname(path.resolve(agentFile))} and ${process.cwd()}`);
  console.error(`  Use --config <path> to specify a custom location.\n`);
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

// ── SKILL.md parser ───────────────────────────────────────────────────────────
// Parses SKILL.md content into an agentSpec the engine understands.
// Text before first ## heading → systemPrompt.
// Each ## Section → workflow step.

function parseSkillMd(content, label = "SKILL.md") {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error(`Invalid SKILL.md (missing frontmatter): ${label}`);

  const front = yaml.load(fmMatch[1]) || {};
  const body  = fmMatch[2] || "";

  if (!front.name)        throw new Error(`SKILL.md missing required field: name (${label})`);
  if (!front.description) throw new Error(`SKILL.md missing required field: description (${label})`);

  // Split body on ## headings — preamble becomes system prompt, headings become steps
  const parts    = body.split(/^## /m);
  const preamble = parts[0].trim();
  const steps    = parts.slice(1).map(s => {
    const nl      = s.indexOf("\n");
    const name    = nl > -1 ? s.slice(0, nl).trim() : s.trim();
    const content = nl > -1 ? s.slice(nl + 1).trim() : "";
    return { name, content };
  });

  const allowedTools = front["allowed-tools"]
    ? front["allowed-tools"].split(/\s+/).filter(Boolean)
    : null;

  return {
    name:         front.name,
    description:  front.description,
    systemPrompt: preamble || body.trim(),
    workflow:     steps,
    params:       front.params || [],
    paramValues:  {},
    maxRounds:    front["max-rounds"] || 25,
    allowedTools,
  };
}

// ── All connectors from oe-config.json (for skills / plugins) ─────────────────
// Skills declare allowed-tools, not connectors. We give them all configured
// connectors (reusing prepareConnectors so the engine gets the right format)
// and let allowed-tools filter them down.

function allConnectorsFromConfig() {
  const all = config.connectors;
  if (!all?.length) return [];
  // Pass config connectors as both yaml declarations and credentials —
  // prepareConnectors will match each entry to itself and produce the correct engine format.
  return prepareConnectors(all, all);
}

// ── Remote SKILL.md fetcher ────────────────────────────────────────────────────
// Converts github.com/…/tree/… URLs to raw.githubusercontent.com URLs automatically.

function toRawUrl(url) {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/tree\/([^/]+)\/(.*)/);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/SKILL.md`;
  return url.endsWith(".md") ? url : url.replace(/\/?$/, "/SKILL.md");
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const rawUrl = toRawUrl(url);
    https.get(rawUrl, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching: ${rawUrl}`));
      }
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end",  () => resolve(data));
    }).on("error", reject);
  });
}

// ── Run a parsed SKILL.md spec ─────────────────────────────────────────────────

async function runSkillSpec(skillSpec, label, inputContext) {
  const all        = allConnectorsFromConfig();
  const connectors = skillSpec.allowedTools
    ? all.filter(c => skillSpec.allowedTools.some(t =>
        t === c.type || t === c.name ||
        t.startsWith(`mcp__${c.name.toLowerCase().replace(/\s+/g, "_")}`)
      ))
    : all;

  const agentSpec = {
    ...skillSpec,
    paramValues,
    input: inputContext
      ? `Context from previous step:\n\n${inputContext}\n\nNow execute your task.`
      : inputMsg,
  };

  const line = "─".repeat(52);
  console.log(`\n${line}`);
  console.log(`  🧩  Skill: ${label}`);
  if (skillSpec.description) console.log(`      ${skillSpec.description}`);
  console.log(`      LLM   ${llmConfig.provider} / ${llmConfig.model || "default"}`);
  if (connectors.length) {
    console.log(`      Tools ${connectors.map(c => `${c.name} (${c.type})`).join(", ")}`);
  }
  console.log(`${line}\n`);

  const { output } = await engine.run(agentSpec, llmConfig, connectors, {
    onToolCall:   (name)         => console.log(`  🔧  ${name}`),
    onToolResult: (name, result) => console.log(`      ↳ ${result.slice(0, 300)}${result.length > 300 ? "…" : ""}`),
    onError:      (err)          => { throw err; },
  });

  console.log(`\n${line}\n`);
  console.log(output);
  console.log(`\n✅  Skill done — ${label}\n`);

  return output;
}

// ── Skills runner — agent.yaml skills: block ───────────────────────────────────
// Each entry: { path: "./skill-folder", trigger_type: "auto" | "manual" }
// Resolves ./skill-folder/SKILL.md relative to the parent agent file.

async function runSkills(skills, output, currentAgentFile, depth) {
  const MAX_DEPTH = 5;
  if (!skills?.length) return output;
  if (depth >= MAX_DEPTH) {
    console.warn(`\n  ⚠  Max skill depth (${MAX_DEPTH}) reached — stopping`);
    return output;
  }

  let lastOutput = output;

  for (const skill of skills) {
    const skillPath   = skill.path;
    const triggerType = skill.trigger_type || skill.triggerType || "auto";
    if (!skillPath) continue;

    const label    = path.basename(skillPath);
    const fullPath = path.resolve(path.dirname(path.resolve(currentAgentFile)), skillPath, "SKILL.md");

    console.log(`\n${"─".repeat(52)}`);
    console.log(`  🧩  Skill   : ${label}`);
    console.log(`      Trigger : ${triggerType}`);

    if (triggerType === "manual") {
      console.log(`      Output  : ${lastOutput.slice(0, 120)}${lastOutput.length > 120 ? "…" : ""}`);
      const approved = await askApproval(label);
      if (!approved) { console.log(`  ⏭  Skill skipped\n`); continue; }
    }

    if (!fs.existsSync(fullPath)) {
      console.warn(`  ⚠  SKILL.md not found: ${fullPath}`);
      continue;
    }

    const skillSpec = parseSkillMd(fs.readFileSync(fullPath, "utf8"), fullPath);
    lastOutput      = await runSkillSpec(skillSpec, label, lastOutput);
  }

  return lastOutput;
}

// ── Plugins runner — agent.yaml plugins: block ─────────────────────────────────
// Each entry: { url: "https://github.com/…", trigger_type: "auto" | "manual" }
// Fetches SKILL.md from the URL and executes it.

async function runPlugins(plugins, output, depth) {
  const MAX_DEPTH = 5;
  if (!plugins?.length) return output;
  if (depth >= MAX_DEPTH) {
    console.warn(`\n  ⚠  Max plugin depth (${MAX_DEPTH}) reached — stopping`);
    return output;
  }

  let lastOutput = output;

  for (const plugin of plugins) {
    const url         = plugin.url;
    const triggerType = plugin.trigger_type || plugin.triggerType || "auto";
    if (!url) continue;

    const label = url.split("/").filter(Boolean).slice(-2).join("/");

    console.log(`\n${"─".repeat(52)}`);
    console.log(`  🔌  Plugin  : ${label}`);
    console.log(`      URL     : ${url}`);
    console.log(`      Trigger : ${triggerType}`);

    if (triggerType === "manual") {
      console.log(`      Output  : ${lastOutput.slice(0, 120)}${lastOutput.length > 120 ? "…" : ""}`);
      const approved = await askApproval(label);
      if (!approved) { console.log(`  ⏭  Plugin skipped\n`); continue; }
    }

    let content;
    try {
      console.log(`      Fetching SKILL.md…`);
      content = await fetchUrl(url);
    } catch (err) {
      console.warn(`  ⚠  Failed to fetch plugin: ${err.message}`);
      continue;
    }

    const skillSpec = parseSkillMd(content, url);
    lastOutput      = await runSkillSpec(skillSpec, label, lastOutput);
  }

  return lastOutput;
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

  // Process chains → skills → plugins after this agent completes
  await runChains(agentYaml.chains, output, agentFile, depth + 1);
  let pipelineOutput = await runSkills(agentYaml.skills, output, agentFile, depth + 1);
  pipelineOutput     = await runPlugins(agentYaml.plugins, pipelineOutput, depth + 1);

  return pipelineOutput;
}

// ── kick off ──────────────────────────────────────────────────────────────────

runAgent(agentFile, null, 0).catch(err => {
  console.error(`\nFatal: ${err.message}\n`);
  process.exit(1);
});

} // end single-run mode
