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

/**
 * Run an agent from file paths.
 *
 * @param {string} agentPath   - Path to agent.yaml
 * @param {string} configPath  - Path to oe-config.json
 * @param {object} params      - Optional key/value params (replaces {{param}} in prompts)
 * @param {object} hooks       - Optional hooks: { onToolCall, onToolResult, onDone, onError }
 * @returns {Promise<{ output: string, toolCalls: string[] }>}
 */
async function runAgent(agentPath, configPath, params = {}, hooks = {}) {
  const agentYaml = yaml.load(fs.readFileSync(path.resolve(agentPath), "utf8"));
  const config    = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
  return _run(agentYaml, config, params, hooks);
}

/**
 * Run an agent from already-parsed objects.
 *
 * @param {object} agentYaml  - Parsed agent YAML object
 * @param {object} config     - Parsed oe-config.json object { llm, connectors, server }
 * @param {object} params     - Optional key/value params
 * @param {object} hooks      - Optional hooks: { onToolCall, onToolResult, onDone, onError }
 * @returns {Promise<{ output: string, toolCalls: string[] }>}
 */
async function runAgentFromObject(agentYaml, config, params = {}, hooks = {}) {
  return _run(agentYaml, config, params, hooks);
}

function _run(agentYaml, config, params, hooks) {
  const connectors = prepareConnectors(agentYaml.connectors, config.connectors);

  const agentSpec = {
    systemPrompt: agentYaml.systemPrompt || agentYaml.system_prompt || agentYaml.instructions || "",
    workflow:     agentYaml.steps        || agentYaml.workflow       || [],
    params:       agentYaml.params       || [],
    paramValues:  params || {},
    maxRounds:    agentYaml.maxRounds    || 25,
    input:        null,
  };

  return engine.run(agentSpec, config.llm, connectors, hooks);
}

module.exports = { runAgent, runAgentFromObject };
