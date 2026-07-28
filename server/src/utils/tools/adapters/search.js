"use strict";
const axios = require("axios");

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_search`,
        description: `Search the web using "${connector.name}" and return the top results with titles, URLs, and snippets.`,
        parameters: {
          type: "object",
          properties: {
            query:       { type: "string",  description: "Search query" },
            num_results: { type: "number",  description: "Number of results to return (default 5, max 10)" },
          },
          required: ["query"],
        },
      },
    },
  ];
}

function getAnthropicToolDefinitions(connector) {
  return getToolDefinitions(connector).map(t => ({
    name:         t.function.name,
    description:  t.function.description,
    input_schema: t.function.parameters,
  }));
}

async function executeTool(action, args, connector) {
  const auth  = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const cfg   = connector.config     ? JSON.parse(connector.config)     : {};
  const creds = { ...cfg, ...auth };
  const type  = connector.type;
  const query = args.query || "";
  const num   = Math.min(args.num_results || 5, 10);

  if (action !== "search") return `Unknown action: ${action}`;

  // ── Perplexity ────────────────────────────────────────────────────────────
  if (type === "perplexity-search") {
    const resp = await axios.post(
      "https://api.perplexity.ai/chat/completions",
      {
        model:    "sonar",
        messages: [{ role: "user", content: query }],
        max_tokens: 1024,
      },
      { headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" } }
    );
    const answer = resp.data.choices?.[0]?.message?.content || "";
    const citations = (resp.data.citations || []).slice(0, num).map((url, i) => `[${i + 1}] ${url}`).join("\n");
    return `${answer}\n\nSources:\n${citations}`.trim();
  }

  // ── Google Custom Search ──────────────────────────────────────────────────
  if (type === "google-search") {
    const resp = await axios.get("https://www.googleapis.com/customsearch/v1", {
      params: { key: creds.apiKey, cx: creds.searchEngineId, q: query, num },
    });
    const items = resp.data.items || [];
    return items.map((r, i) => `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet || ""}`).join("\n\n") || "No results found.";
  }

  // ── Bing Web Search ───────────────────────────────────────────────────────
  if (type === "bing-search") {
    const resp = await axios.get("https://api.bing.microsoft.com/v7.0/search", {
      params:  { q: query, count: num },
      headers: { "Ocp-Apim-Subscription-Key": creds.apiKey },
    });
    const results = resp.data.webPages?.value || [];
    return results.map((r, i) => `${i + 1}. ${r.name}\n   ${r.url}\n   ${r.snippet || ""}`).join("\n\n") || "No results found.";
  }

  return `Unsupported search connector type: ${type}`;
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
