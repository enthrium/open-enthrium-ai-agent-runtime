"use strict";

const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// Works in both monorepo context (../src/) and npm-installed context (./src/)
const srcDir = fs.existsSync(path.join(__dirname, "src", "engine"))
  ? path.join(__dirname, "src")
  : path.join(__dirname, "..", "src");

const engine                = require(path.join(srcDir, "engine"));
const { prepareConnectors } = require(path.join(srcDir, "utils", "prepareConnectors"));

// ── SKILL.md parser ───────────────────────────────────────────────────────────

function parseSkillMd(content) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) return null;
  const front = yaml.load(fmMatch[1]) || {};
  if (!front.name || !front.description) return null;
  const body  = fmMatch[2] || "";

  // Split on ## headings — preamble becomes systemPrompt, headings become steps
  const parts    = body.split(/^## /m);
  const preamble = parts[0].trim();
  const steps    = parts.slice(1).map(s => {
    const nl = s.indexOf("\n");
    return {
      name:    nl > -1 ? s.slice(0, nl).trim() : s.trim(),
      content: nl > -1 ? s.slice(nl + 1).trim() : "",
    };
  });

  return {
    name:         front.name,
    description:  front.description,
    systemPrompt: preamble,
    workflow:     steps,
    params:       front.params || [],
    maxRounds:    front["max-rounds"] || 25,
    allowedTools: front["allowed-tools"]
      ? front["allowed-tools"].split(/\s+/).filter(Boolean)
      : null,
  };
}

// ── Skills pipeline ───────────────────────────────────────────────────────────
// Runs each auto skill in sequence, passing the previous output as context.
// Manual skills are skipped in the SDK (no interactive approval available).

async function runSkills(skills, parentOutput, agentFile, config, params, hooks, depth = 0) {
  const MAX_DEPTH = 5;
  if (!skills?.length || depth >= MAX_DEPTH) return parentOutput || "";

  let lastOutput = parentOutput || "";

  for (const skill of skills) {
    const skillPath   = skill.path;
    const triggerType = (skill.trigger_type || skill.triggerType || "auto").toLowerCase();
    if (!skillPath) continue;

    // Manual skills require interactive approval — skip in SDK context
    if (triggerType === "manual") {
      if (hooks.onSkipManual) hooks.onSkipManual(skillPath);
      continue;
    }

    // Resolve SKILL.md path relative to the agent file
    const resolved = skillPath.toLowerCase().endsWith(".md")
      ? skillPath
      : path.join(skillPath, "SKILL.md");
    const fullPath = agentFile
      ? path.join(path.dirname(agentFile), resolved)
      : resolved;

    if (!fs.existsSync(fullPath)) {
      if (hooks.onError) hooks.onError(new Error(`SKILL.md not found: ${fullPath}`));
      continue;
    }

    const content   = fs.readFileSync(fullPath, "utf8");
    const skillSpec = parseSkillMd(content);
    if (!skillSpec) {
      if (hooks.onError) hooks.onError(new Error(`Invalid SKILL.md: ${fullPath}`));
      continue;
    }

    // Resolve connectors — skill.connectors scopes to named connectors if declared
    const parentYaml     = agentFile ? (yaml.load(fs.readFileSync(agentFile, "utf8")) || {}) : {};
    const allConnectors  = prepareConnectors(parentYaml.connectors, config.connectors);
    const connectorNames = skill.connectors;
    const connectors = Array.isArray(connectorNames)
      ? allConnectors.filter(c => connectorNames.includes(c.connection_name || c.name))
      : (skillSpec.allowedTools
          ? allConnectors.filter(c => skillSpec.allowedTools.some(t =>
              t === (c.connection_type || c.type) || t === (c.connection_name || c.name)))
          : allConnectors);

    // First skill gets original parent output directly; subsequent skills get chained context
    const contextInput = lastOutput
      ? `Context from previous step:\n\n${lastOutput}\n\nNow execute your task.`
      : "Execute your task.";

    const agentSpec = {
      systemPrompt: skillSpec.systemPrompt || "",
      workflow:     skillSpec.workflow     || [],
      params:       skillSpec.params       || [],
      paramValues:  params                 || {},
      maxRounds:    skillSpec.maxRounds,
      input:        contextInput,
    };

    try {
      const { output } = await engine.run(agentSpec, config.llm, connectors, hooks);
      lastOutput = output;
    } catch (err) {
      if (hooks.onError) hooks.onError(err);
      else throw err;
    }
  }

  return lastOutput;
}

// ── Core runner ───────────────────────────────────────────────────────────────

async function _run(agentYaml, config, params, hooks, agentFile = null) {
  const connectors = prepareConnectors(agentYaml.connectors, config.connectors);

  const agentSpec = {
    systemPrompt: agentYaml.systemPrompt || agentYaml.system_prompt || agentYaml.instructions || "",
    workflow:     agentYaml.steps        || agentYaml.workflow       || [],
    params:       agentYaml.params       || [],
    paramValues:  params                 || {},
    maxRounds:    agentYaml.maxRounds    || 25,
    input:        null, // engine default: "Execute the agent task now using the available tools."
  };

  // Skip LLM call when no instructions or steps — go straight to skills
  const hasWork = agentSpec.systemPrompt.trim() || agentSpec.workflow?.length;
  let output = "";

  if (hasWork) {
    const result = await engine.run(agentSpec, config.llm, connectors, hooks);
    output = result.output;
  }

  // Run skills pipeline if present
  if (agentYaml.skills?.length) {
    output = await runSkills(agentYaml.skills, output, agentFile, config, params, hooks);
  }

  return { output, toolCalls: [] };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run an agent from file paths.
 *
 * @param {string} agentPath   - Path to agent.yaml
 * @param {string} configPath  - Path to oe-config.json
 * @param {object} params      - Optional key/value params (replaces {{param}} in prompts)
 * @param {object} hooks       - Optional hooks: { onToolCall, onToolResult, onDone, onError, onSkipManual }
 * @returns {Promise<{ output: string, toolCalls: string[] }>}
 */
async function runAgent(agentPath, configPath, params = {}, hooks = {}) {
  const resolvedAgent = path.resolve(agentPath);
  const agentYaml     = yaml.load(fs.readFileSync(resolvedAgent, "utf8"));
  const config        = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
  return _run(agentYaml, config, params, hooks, resolvedAgent);
}

/**
 * Run an agent from already-parsed objects.
 *
 * @param {object} agentYaml  - Parsed agent YAML object
 * @param {object} config     - Parsed oe-config.json object { llm, connectors, server }
 * @param {object} params     - Optional key/value params
 * @param {object} hooks      - Optional hooks: { onToolCall, onToolResult, onDone, onError, onSkipManual }
 * @returns {Promise<{ output: string, toolCalls: string[] }>}
 */
async function runAgentFromObject(agentYaml, config, params = {}, hooks = {}) {
  return _run(agentYaml, config, params, hooks, null);
}

module.exports = { runAgent, runAgentFromObject };
