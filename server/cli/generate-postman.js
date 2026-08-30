#!/usr/bin/env node
"use strict";

/**
 * generate-postman.js
 *
 * Generates oe-runtime.postman_collection.json from the skills/ folder.
 * Run before each release:  node generate-postman.js
 *
 * Structure:
 *   - Core endpoints (Health Check, Run inline, Run from file, Approve Chain)
 *   - Skills folder — one request per skills/<name>/agent.yaml
 */

const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const OUT_FILE      = path.join(__dirname, "oe-runtime.postman_collection.json");
const SAMPLES_DIR   = path.join(__dirname, "skills");

// ── helpers ───────────────────────────────────────────────────────────────────

function jsonBody(obj) {
  return {
    mode: "raw",
    raw: JSON.stringify(obj, null, 2),
    options: { raw: { language: "json" } },
  };
}

function postRequest(name, urlPath, body, description, responses = []) {
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
    response: responses,
  };
}

function getRequest(name, urlPath, description, responses = []) {
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
    response: responses,
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
    "Run an agent by passing YAML inline.\n\nReturns:\n  { success, agent, output, pending_skill_chain, duration_ms }\n\n- pending_skill_chain: present when a manual skill is paused awaiting approval\n  { chain_id, skill_name } — use chain_id with POST /approve-chain to continue\n\nNote: skills: with relative SKILL.md paths require /run-file instead."
  ),

  postRequest(
    "Run Agent (from file on disk)",
    "/run-file",
    {
      file:   "/path/to/your/agent.yaml",
      params: {},
      input:  "run",
    },
    "Run an agent from a YAML file path on the server's disk.\n\nReturns:\n  { success, agent, output, pending_skill_chain, duration_ms }\n\n- pending_skill_chain: present when a manual skill is paused awaiting approval\n  { chain_id, skill_name } — use chain_id with POST /approve-chain to continue"
  ),

  postRequest(
    "Approve Chain",
    "/approve-chain",
    { chain_id: "{{chain_id}}", approved: true, abort: false },
    "Approve, skip, or abort a paused manual skill.\n\n  approved: true   — run the skill and continue\n  approved: false  — skip the skill and continue\n  abort: true      — stop the entire pipeline immediately\n\nGet chain_id from pending_skill_chain.chain_id in a /run or /run-file response.\nchain_id is one-time use — consumed on first call.\n\nReturns:\n  { success, approved, output, pending_skill_chain, duration_ms }\n\nIf pending_skill_chain is present, another skill is waiting — call /approve-chain again."
  ),
];

// ── samples ───────────────────────────────────────────────────────────────────

function buildProjectFolder(sampleDir) {
  const projectFile = path.join(sampleDir, "oe-project.json");
  if (!fs.existsSync(projectFile)) return null;

  let project;
  try { project = JSON.parse(fs.readFileSync(projectFile, "utf8")); }
  catch { console.warn(`  ⚠  Could not parse ${projectFile}`); return null; }

  const folderName = project.name || path.basename(sampleDir);
  const agents     = project.agents || [];
  const items      = [];

  for (const agent of agents) {
    const agentFile = path.join(sampleDir, agent.file);
    if (!fs.existsSync(agentFile)) continue;
    const rawYaml = fs.readFileSync(agentFile, "utf8");
    items.push(postRequest(
      agent.name + (agent.default ? " (default)" : ""),
      "/run",
      { yaml: rawYaml.replace(/\r\n/g, "\n"), params: {}, input: "run" },
      agent.description || ""
    ));
  }

  return { name: folderName, description: project.description || "", item: items };
}

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

  // Check if this agent uses SKILL.md (skills: field present)
  const hasSkills = Array.isArray(parsed.skills) && parsed.skills.length > 0;

  // Read SKILL.md description if present
  let skillDesc = "";
  if (hasSkills) {
    const skillMdPath = path.join(sampleDir, "SKILL.md");
    if (fs.existsSync(skillMdPath)) {
      const skillContent = fs.readFileSync(skillMdPath, "utf8");
      // Extract steps from ## Step N: headings
      const steps = [...skillContent.matchAll(/^##\s+Step\s+\d+[:\s]+(.+)$/gm)]
        .map(m => `  • ${m[1].trim()}`).join("\n");
      if (steps) skillDesc = `\nSteps:\n${steps}`;
    }
  }

  const description = [
    agentDesc,
    connectors ? `Connectors: ${connectors}` : "",
    hasSkills  ? "Powered by SKILL.md" : "",
    skillDesc,
  ].filter(Boolean).join("\n");

  // SKILL.md agents use /run-file (SKILL.md path must resolve on disk)
  if (hasSkills) {
    return postRequest(
      agentName,
      "/run-file",
      { file: agentFile.replace(/\\/g, "/"), params: {}, input: "run" },
      description
    );
  }

  return postRequest(
    agentName,
    "/run",
    { yaml: rawYaml.replace(/\r\n/g, "\n"), params: {}, input: "run" },
    description
  );
}

function buildSamplesFolder() {
  if (!fs.existsSync(SAMPLES_DIR)) {
    console.warn("  ⚠  skills/ directory not found — skipping");
    return { name: "Skills", description: "Sample agents", item: [] };
  }

  const entries = fs.readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  const items = [];
  for (const entry of entries) {
    const dir = path.join(SAMPLES_DIR, entry);

    // oe-project.json → multi-agent folder
    const folder = buildProjectFolder(dir);
    if (folder) {
      items.push(folder);
      console.log(`  ✓  ${entry}  →  folder "${folder.name}" (${folder.item.length} agents)`);
      continue;
    }

    // single agent.yaml
    const req = buildSampleRequest(dir);
    if (req) {
      items.push(req);
      console.log(`  ✓  ${entry}  →  "${req.name}"`);
    }
  }

  return {
    name:        "Skills",
    description: "One request per sample agent — each sends the full agent YAML to POST /run.",
    item:        items,
  };
}

// ── assemble & write ──────────────────────────────────────────────────────────

function generate() {
  console.log("Generating Postman collection from skills/…\n");

  const samplesFolder = buildSamplesFolder();

  const collection = {
    info: {
      name:        "OE Runtime API",
      description: "OE Runtime HTTP server endpoints. Start the server with: oe-runtime --serve --config oe-config.json",
      schema:      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    variable: [
      { key: "base_url", value: "http://localhost:3333", type: "string" },
      { key: "api_key",  value: "your-secret-api-key",    type: "string" },
    ],
    item: [...coreItems, samplesFolder],
  };

  const json = JSON.stringify(collection, null, 2);
  fs.writeFileSync(OUT_FILE, json, "utf8");

  console.log(`\n✅  Written ${samplesFolder.item.length} samples → ${path.basename(OUT_FILE)}`);
}

generate();
