"use strict";

const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const os   = require("os");

const engine = require("../src/engine");

const VERSION = require("../package.json").version;

// ── connector matching (mirrors index.js) ────────────────────────────────────

function prepareConnectors(yamlConnectors, configConnectors) {
  return (yamlConnectors || []).map((yc, i) => {
    const ycName = yc.connection_name || yc.name;
    const ycType = yc.connection_type || yc.type;

    const cc = (configConnectors || []).find(c => (c.connection_name || c.name) === ycName)
            || (configConnectors || []).find(c => (c.connection_type || c.type) === ycType);

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

function runBatch(agentSpec, llmConfig, connectors) {
  return new Promise((resolve, reject) => {
    engine.run(agentSpec, llmConfig, connectors, {
      onToolCall:   () => {},
      onToolResult: () => {},
      onDone:  resolve,
      onError: reject,
    }).catch(reject);
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────────

exports.start = function start(config) {
  const express = require("express");
  const app     = express();

  const port   = (config.server && config.server.port)   || 3333;
  const apiKey = (config.server && config.server.apiKey) || null;

  app.use(express.json({ limit: "4mb" }));

  // Optional API key auth — all routes including /health
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

    const connectors = prepareConnectors(agentYaml.connectors, config.connectors);
    const agentSpec  = buildAgentSpec(agentYaml, params, input);
    const t0 = Date.now();

    try {
      const output = await runBatch(agentSpec, config.llm, connectors);
      res.json({ success: true, output, duration_ms: Date.now() - t0 });
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

    const connectors = prepareConnectors(agentYaml.connectors, config.connectors);
    const agentSpec  = buildAgentSpec(agentYaml, params, input);
    const t0 = Date.now();

    try {
      const output = await runBatch(agentSpec, config.llm, connectors);
      res.json({ success: true, output, duration_ms: Date.now() - t0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, duration_ms: Date.now() - t0 });
    }
  });

  app.listen(port, () => {
    const line = "─".repeat(52);
    console.log(`\n${line}`);
    console.log(`  🚀  OE Runtime Server  v${VERSION}`);
    console.log(`${line}`);
    console.log(`  Listening  http://localhost:${port}`);
    console.log(`  GET  /health      — liveness check`);
    console.log(`  POST /run         — run agent from inline YAML`);
    console.log(`  POST /run-file    — run agent from YAML file on disk`);
    if (apiKey) {
      console.log(`  Auth  x-api-key header required`);
    } else {
      console.log(`  Auth  none (set config.server.apiKey to protect)`);
    }
    console.log(`${line}\n`);
  });
};
