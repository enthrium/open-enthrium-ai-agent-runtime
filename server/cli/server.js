"use strict";

const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const os   = require("os");

const engine = require("../src/engine");

const VERSION = require("../package.json").version;

// ── in-memory store for pending manual chains ────────────────────────────────
// chain_id → { nextPath, contextOutput, params, depth }
const pendingChains = new Map();

function makeChainId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── connector matching (mirrors index.js) ────────────────────────────────────

function prepareConnectors(yamlConnectors, configConnectors) {
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
    const ycName = yc.connection_name || yc.name;
    const ycType = yc.connection_type || yc.type;

    const cc = cfgArray.find(c => (c.connection_name || c.name) === ycName)
            || cfgArray.find(c => (c.connection_type || c.type) === ycType);

    if (!cc) {
      console.warn(`  ⚠  No config entry for connector "${ycName}" (${ycType})`);
      return { id: i + 1, name: ycName, type: ycType, status: "active", authConfig: "{}", config: "{}" };
    }

    const { connection_name, connection_type, name, type, ...creds } = cc;
    const resolvedName = connection_name || name || ycName;
    const resolvedType = connection_type || type || ycType;

    if (creds.privateKeyPath) {
      const keyPath = creds.privateKeyPath.replace(/^~/, os.homedir());
      creds.privateKey = fs.readFileSync(keyPath, "utf8").replace(/\r\n/g, "\n");
      delete creds.privateKeyPath;
    }
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

function buildAgentSpec(agentYaml, params, input) {
  return {
    systemPrompt: agentYaml.systemPrompt || agentYaml.system_prompt || agentYaml.instructions || "",
    workflow:     agentYaml.steps        || agentYaml.workflow       || [],
    params:       agentYaml.params       || [],
    paramValues:  params  || {},
    maxRounds:    agentYaml.maxRounds    || 25,
    input:        input   || null,
  };
}

// ── chain-aware agent runner ──────────────────────────────────────────────────
//
// Returns:
// {
//   agent:          string,               — agent name or filename
//   output:         string,               — LLM output
//   chains:         [...],                — results of auto chains (recursive)
//   pending_chains: [{ chain_id, next_agent, condition, output_preview }]
// }

const MAX_DEPTH = 5;

async function runAgentServer(agentFile, agentYaml, config, input, params, depth = 0) {
  const connectors = prepareConnectors(agentYaml.connectors, config.connectors);
  const agentSpec  = buildAgentSpec(agentYaml, params, input);

  const { output } = await engine.run(agentSpec, config.llm, connectors, {
    onToolCall:   () => {},
    onToolResult: () => {},
    onError:      (err) => { throw err; },
  });

  const result = {
    agent:          agentYaml.name || (agentFile ? path.basename(agentFile) : "inline"),
    output,
    chains:         [],
    pending_chains: [],
  };

  if (!agentYaml.chains?.length || depth >= MAX_DEPTH) return result;

  for (const chain of agentYaml.chains) {
    const nextAgent   = chain.next_agent   || chain.nextAgent;
    const triggerType = chain.trigger_type || chain.triggerType || "auto";

    if (!nextAgent) continue;

    // Resolve file path (only works for /run-file; /run inline has no base dir)
    const nextPath = agentFile
      ? path.resolve(path.dirname(path.resolve(agentFile)), nextAgent)
      : null;

    if (!nextPath || !fs.existsSync(nextPath)) {
      result.chains.push({ agent: nextAgent, error: "chain agent file not found: " + (nextPath || nextAgent) });
      continue;
    }

    const contextInput = `Context from previous agent:\n\n${output}\n\nNow execute your task.`;

    if (triggerType === "manual") {
      // Store pending — caller must POST /approve-chain to fire it
      const chainId = makeChainId();
      pendingChains.set(chainId, {
        nextPath,
        contextOutput: output,
        params,
        depth: depth + 1,
      });
      result.pending_chains.push({
        chain_id:       chainId,
        next_agent:     nextAgent,
        condition,
        output_preview: output.slice(0, 300),
      });
    } else {
      // Auto — run immediately, nested in response
      let nextYaml;
      try { nextYaml = yaml.load(fs.readFileSync(nextPath, "utf8")); }
      catch (e) { result.chains.push({ agent: nextAgent, error: "Failed to load YAML: " + e.message }); continue; }

      try {
        const chainResult = await runAgentServer(nextPath, nextYaml, config, contextInput, params, depth + 1);
        result.chains.push(chainResult);
      } catch (err) {
        result.chains.push({ agent: nextYaml.name || path.basename(nextPath), error: err.message });
      }
    }
  }

  return result;
}

// ── HTTP server ──────────────────────────────────────────────────────────────

exports.start = function start(config) {
  const express = require("express");
  const app     = express();

  const port   = (config.server && config.server.port)   || 3333;
  const apiKey = (config.server && config.server.apiKey) || null;

  app.use(express.json({ limit: "4mb" }));

  // Optional API key auth
  if (apiKey) {
    app.use((req, res, next) => {
      const provided = req.headers["x-api-key"]
                    || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
      if (provided !== apiKey) return res.status(401).json({ error: "Unauthorized" });
      next();
    });
  }

  // ── GET /health ─────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: VERSION });
  });

  // ── POST /run  (inline YAML string) ─────────────────────────────────────────
  app.post("/run", async (req, res) => {
    const { yaml: yamlText, params = {}, input = null } = req.body || {};

    if (!yamlText) return res.status(400).json({ error: "yaml is required" });

    let agentYaml;
    try { agentYaml = yaml.load(yamlText); }
    catch (e) { return res.status(400).json({ error: "Invalid YAML: " + e.message }); }

    const t0 = Date.now();
    try {
      // No agentFile — manual chains won't resolve relative paths, but auto chains will warn
      const result = await runAgentServer(null, agentYaml, config, input, params, 0);
      res.json({ success: true, ...result, duration_ms: Date.now() - t0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, duration_ms: Date.now() - t0 });
    }
  });

  // ── POST /run-file  (path to YAML on disk) ───────────────────────────────────
  app.post("/run-file", async (req, res) => {
    const { file, params = {}, input = null } = req.body || {};

    if (!file) return res.status(400).json({ error: "file is required" });
    if (!fs.existsSync(file)) return res.status(404).json({ error: "file not found: " + file });

    let agentYaml;
    try { agentYaml = yaml.load(fs.readFileSync(file, "utf8")); }
    catch (e) { return res.status(400).json({ error: "Invalid YAML: " + e.message }); }

    const t0 = Date.now();
    try {
      const result = await runAgentServer(file, agentYaml, config, input, params, 0);
      res.json({ success: true, ...result, duration_ms: Date.now() - t0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, duration_ms: Date.now() - t0 });
    }
  });

  // ── POST /approve-chain ──────────────────────────────────────────────────────
  // Approve or reject a pending manual chain.
  //
  // Body: { chain_id: string, approved: boolean }
  //
  // Response (approved):
  //   { success: true, agent, output, chains, pending_chains, duration_ms }
  //
  // Response (rejected / not found):
  //   { success: true, approved: false, message: string }

  app.post("/approve-chain", async (req, res) => {
    const { chain_id, approved = true } = req.body || {};

    if (!chain_id) return res.status(400).json({ error: "chain_id is required" });

    const pending = pendingChains.get(chain_id);
    if (!pending) {
      return res.status(404).json({ error: "chain_id not found or already used" });
    }

    // Consume the pending entry (one-time approval)
    pendingChains.delete(chain_id);

    if (!approved) {
      return res.json({ success: true, approved: false, message: "Chain rejected" });
    }

    const { nextPath, contextOutput, params, depth } = pending;

    let agentYaml;
    try { agentYaml = yaml.load(fs.readFileSync(nextPath, "utf8")); }
    catch (e) { return res.status(500).json({ success: false, error: "Failed to load chain agent: " + e.message }); }

    const contextInput = `Context from previous agent:\n\n${contextOutput}\n\nNow execute your task.`;
    const t0 = Date.now();

    try {
      const result = await runAgentServer(nextPath, agentYaml, config, contextInput, params, depth);
      res.json({ success: true, approved: true, ...result, duration_ms: Date.now() - t0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, duration_ms: Date.now() - t0 });
    }
  });

  app.listen(port, () => {
    const line = "─".repeat(52);
    console.log(`\n${line}`);
    console.log(`  🚀  OE Runtime Server  v${VERSION}`);
    console.log(`      Run AI agents via HTTP`);
    console.log(`${line}`);
    console.log(`  Listening  http://localhost:${port}`);
    console.log(`  GET  /health          — liveness check`);
    console.log(`  POST /run             — run agent from inline YAML`);
    console.log(`  POST /run-file        — run agent from YAML file on disk`);
    console.log(`  POST /approve-chain   — approve or reject a pending manual chain`);
    if (apiKey) {
      console.log(`  Auth  x-api-key header required`);
    } else {
      console.log(`  Auth  none (set config.server.apiKey to protect)`);
    }
    console.log(`${line}\n`);
  });
};
