#!/usr/bin/env node
"use strict";

const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const samplesDir = path.resolve(__dirname, "../cli/samples");
const outFile    = path.resolve(__dirname, "../cli/oe-runtime.postman_collection.json");

// ── scan samples ─────────────────────────────────────────────────────────────

const sampleItems = fs
  .readdirSync(samplesDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(d => {
    const agentFile = path.join(samplesDir, d.name, "agent.yaml");
    if (!fs.existsSync(agentFile)) return null;

    const rawYaml  = fs.readFileSync(agentFile, "utf8");
    const agentDef = yaml.load(rawYaml);

    const connectorList = (agentDef.connectors || [])
      .map(c => `${c.connection_name} (${c.connection_type})`)
      .join(", ");

    const description = [
      agentDef.description || "",
      connectorList ? `Connectors: ${connectorList}` : "",
    ].filter(Boolean).join("\n");

    return {
      name: agentDef.name || d.name,
      request: {
        method: "POST",
        header: [
          { key: "Content-Type", value: "application/json" },
          { key: "x-api-key",    value: "{{api_key}}" },
        ],
        body: {
          mode: "raw",
          raw: JSON.stringify({ yaml: rawYaml, params: {}, input: null }, null, 2),
          options: { raw: { language: "json" } },
        },
        url: {
          raw:  "{{base_url}}/run",
          host: ["{{base_url}}"],
          path: ["run"],
        },
        description,
      },
    };
  })
  .filter(Boolean);

// ── build collection ─────────────────────────────────────────────────────────

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
  item: [
    {
      name: "Health Check",
      request: {
        method: "GET",
        header: [{ key: "x-api-key", value: "{{api_key}}" }],
        url: {
          raw:  "{{base_url}}/health",
          host: ["{{base_url}}"],
          path: ["health"],
        },
        description: "Liveness check — returns runtime version.",
      },
    },
    {
      name: "Run Agent (inline YAML)",
      request: {
        method: "POST",
        header: [
          { key: "Content-Type", value: "application/json" },
          { key: "x-api-key",    value: "{{api_key}}" },
        ],
        body: {
          mode: "raw",
          raw:  JSON.stringify({ yaml: "name: Hello World\nsteps:\n  - name: Say hello\n    content: Say hello world", params: {}, input: null }, null, 2),
          options: { raw: { language: "json" } },
        },
        url: {
          raw:  "{{base_url}}/run",
          host: ["{{base_url}}"],
          path: ["run"],
        },
        description: "Run an agent by passing YAML inline. Returns { success, output, duration_ms }.",
      },
    },
    {
      name: "Run Agent (from file on disk)",
      request: {
        method: "POST",
        header: [
          { key: "Content-Type", value: "application/json" },
          { key: "x-api-key",    value: "{{api_key}}" },
        ],
        body: {
          mode: "raw",
          raw:  JSON.stringify({ file: "/path/to/your/agent.yaml", params: {}, input: null }, null, 2),
          options: { raw: { language: "json" } },
        },
        url: {
          raw:  "{{base_url}}/run-file",
          host: ["{{base_url}}"],
          path: ["run-file"],
        },
        description: "Run an agent from a YAML file path on the server's disk. Returns { success, output, duration_ms }.",
      },
    },
    {
      name:        "Samples",
      description: "One request per sample agent — each sends the full agent YAML to POST /run.",
      item:        sampleItems,
    },
  ],
};

fs.writeFileSync(outFile, JSON.stringify(collection, null, 2) + "\n");
console.log(`✅  Generated ${outFile} (${sampleItems.length} samples)`);
