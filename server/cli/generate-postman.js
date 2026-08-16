#!/usr/bin/env node
"use strict";

/**
 * generate-postman.js
 *
 * Generates oe-runtime.postman_collection.json from the samples/ folder.
 * Run before each release:  node generate-postman.js
 *
 * Structure:
 *   - Core endpoints (Health Check, Run inline, Run from file, Approve Chain)
 *   - Samples folder — one request per samples/<name>/agent.yaml
 */

const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const OUT_FILE      = path.join(__dirname, "oe-runtime.postman_collection.json");
const SAMPLES_DIR   = path.join(__dirname, "samples");

// ── helpers ───────────────────────────────────────────────────────────────────

function jsonBody(obj) {
  return {
    mode: "raw",
    raw: JSON.stringify(obj, null, 2),
    options: { raw: { language: "json" } },
  };
}

function postRequest(name, urlPath, body, description) {
  return {
    name,
    request: {
      method: "POST",
      header: [
        { key: "Content-Type", value: "application/json" },
        { key: "x-api-key",    value: "{{api_key}}" },
      ],
      body: jsonBody(body),
      url: {
        raw:  `{{base_url}}${urlPath}`,
        host: ["{{base_url}}"],
        path: [urlPath.replace(/^\//, "")],
      },
      description,
    },
  };
}

function getRequest(name, urlPath, description) {
  return {
    name,
    request: {
      method: "GET",
      header: [{ key: "x-api-key", value: "{{api_key}}" }],
      url: {
        raw:  `{{base_url}}${urlPath}`,
        host: ["{{base_url}}"],
        path: [urlPath.replace(/^\//, "")],
      },
      description,
    },
  };
}

// ── core endpoints ────────────────────────────────────────────────────────────

const coreItems = [
  getRequest(
    "Health Check",
    "/health",
    "Liveness check — returns runtime version."
  ),

  postRequest(
    "Run Agent (inline YAML)",
    "/run",
    {
      yaml:   "name: Hello World\nsteps:\n  - name: Say hello\n    content: Say hello world",
      params: {},
      input:  "run",
    },
    "Run an agent by passing YAML inline.\n\nReturns:\n  { success, agent, output, chains, pending_chains, duration_ms }\n\nNote: chains: with relative next_agent paths require /run-file instead (path resolution needs a base directory)."
  ),

  postRequest(
    "Run Agent (from file on disk)",
    "/run-file",
    {
      file:   "/path/to/your/agent.yaml",
      params: {},
      input:  "run",
    },
    "Run an agent from a YAML file path on the server's disk.\n\nReturns:\n  { success, agent, output, chains, pending_chains, duration_ms }\n\n- chains: array of auto-chain results (nested, recursive)\n- pending_chains: array of manual chains awaiting approval via POST /approve-chain"
  ),

  postRequest(
    "Approve Chain",
    "/approve-chain",
    { chain_id: "PASTE_CHAIN_ID_HERE", approved: true },
    "Approve or reject a pending manual chain.\n\nGet the chain_id from pending_chains[] in a /run or /run-file response.\n\nBody:\n  { chain_id: string, approved: boolean }\n\nResponse (approved):\n  { success: true, approved: true, agent, output, chains, pending_chains, duration_ms }\n\nResponse (rejected):\n  { success: true, approved: false, message: \"Chain rejected\" }\n\nNote: chain_id is one-time use — consumed on first call (approved or rejected)."
  ),
];

// ── samples ───────────────────────────────────────────────────────────────────

function buildSampleRequest(sampleDir) {
  const agentFile = path.join(sampleDir, "agent.yaml");
  if (!fs.existsSync(agentFile)) return null;

  const rawYaml  = fs.readFileSync(agentFile, "utf8");
  let   parsed;
  try   { parsed = yaml.load(rawYaml); }
  catch { console.warn(`  ⚠  Could not parse ${agentFile}`); return null; }

  const agentName  = parsed.name        || path.basename(sampleDir);
  const agentDesc  = parsed.description || "";
  const connectors = (parsed.connectors || [])
    .map(c => `${c.connection_name} (${c.connection_type || c.connection_name})`)
    .join(", ");

  const description = [agentDesc, connectors ? `Connectors: ${connectors}` : ""]
    .filter(Boolean).join("\n");

  return postRequest(
    agentName,
    "/run",
    { yaml: rawYaml.replace(/\r\n/g, "\n"), params: {}, input: "run" },
    description
  );
}

function buildSamplesFolder() {
  if (!fs.existsSync(SAMPLES_DIR)) {
    console.warn("  ⚠  samples/ directory not found — skipping");
    return { name: "Samples", description: "Sample agents", item: [] };
  }

  const entries = fs.readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  const items = [];
  for (const entry of entries) {
    const req = buildSampleRequest(path.join(SAMPLES_DIR, entry));
    if (req) {
      items.push(req);
      console.log(`  ✓  ${entry}  →  "${req.name}"`);
    }
  }

  return {
    name:        "Samples",
    description: "One request per sample agent — each sends the full agent YAML to POST /run.",
    item:        items,
  };
}

// ── assemble & write ──────────────────────────────────────────────────────────

function generate() {
  console.log("Generating Postman collection from samples/…\n");

  const samplesFolder = buildSamplesFolder();

  const collection = {
    info: {
      name:        "OE Runtime API",
      description: "OE Runtime HTTP server endpoints. Start the server with: oe-runtime --serve --config oe-config.json",
      schema:      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    variable: [
      { key: "base_url", value: "http://localhost:3333", type: "string" },
      { key: "api_key",  value: "your-api-key",          type: "string" },
    ],
    item: [...coreItems, samplesFolder],
  };

  const json = JSON.stringify(collection, null, 2);
  fs.writeFileSync(OUT_FILE, json, "utf8");

  console.log(`\n✅  Written ${samplesFolder.item.length} samples → ${path.basename(OUT_FILE)}`);
}

generate();
