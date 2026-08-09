"use strict";

// ══════════════════════════════════════════════════════════════════════════════
//  Open Enthrium — Connector Adapter Template
//  Copy this file, rename it to <your-connector>.js, and implement the three
//  exported functions below.
//
//  Steps to contribute a new connector:
//  1. Copy this file  →  adapters/your-connector.js
//  2. Add an entry    →  server/src/data/connectionTypes.json
//     { "id": "your-connector", "label": "Your Connector", "color": "bg-blue-600", "initial": "YC", "cat": "Your Category" }
//  3. Restart the server — auto-discovery picks up your file immediately.
//
//  That's it. No registry edits, no seed script changes required.
// ══════════════════════════════════════════════════════════════════════════════

// ── Tool definitions (OpenAI format) ─────────────────────────────────────────
// Return an array of tools this connector exposes to the agent.
// Each tool becomes a callable function in the agentic loop.
function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_your_action`,
        description: `What this action does on "${connector.name}"`,
        parameters: {
          type: "object",
          properties: {
            your_param: { type: "string", description: "Describe what this param does" },
          },
          required: ["your_param"],
        },
      },
    },
    // Add more tools here…
  ];
}

// ── Tool definitions (Anthropic format) ──────────────────────────────────────
// Converts OpenAI-style definitions to Anthropic's input_schema format.
// In most cases you don't need to change this — just keep it as-is.
function getAnthropicToolDefinitions(connector) {
  return getToolDefinitions(connector).map(t => ({
    name:         t.function.name,
    description:  t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ── Execute ───────────────────────────────────────────────────────────────────
// Called by the engine when the agent invokes one of your tools.
//
// Parameters:
//   action    — the part after conn_<id>_  (e.g. "your_action")
//   args      — object of parsed arguments from the agent
//   connector — connector row from DB: connector.id, connector.name, connector.auth (JSON string)
//   db        — Prisma client (available if you need to persist anything)
//
// Return a string — the engine sends it back to the LLM as the tool result.
async function executeTool(action, args, connector, db) {
  const auth = JSON.parse(connector.auth || "{}");
  // auth contains whatever fields the user configured (apiKey, baseUrl, etc.)

  if (action === "your_action") {
    // TODO: implement your logic here
    // const result = await yourApiCall(auth.apiKey, args.your_param);
    return JSON.stringify({ result: "replace with real implementation" });
  }

  return `Unknown action: ${action}`;
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
