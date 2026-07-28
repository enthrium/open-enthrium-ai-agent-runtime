const axios = require("axios");

function cfg(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function client({ domain, email, apiToken }) {
  return axios.create({
    baseURL: `https://${domain}/wiki/rest/api`,
    auth: { username: email, password: apiToken },
    headers: { "Content-Type": "application/json" },
  });
}

const TOOLS = c => [
  { action: "search_pages", desc: `Search Confluence pages via ${c.name}.`,
    params: { query:    { type: "string", description: "Search query." },
              spaceKey: { type: "string", description: "Optional space key to limit search." } }, required: ["query"] },
  { action: "get_page",    desc: `Get content of a Confluence page by ID via ${c.name}.`,
    params: { pageId: { type: "string", description: "Confluence page ID." } }, required: ["pageId"] },
  { action: "list_spaces", desc: `List Confluence spaces via ${c.name}.`, params: {}, required: [] },
];

function getToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({
    type: "function",
    function: { name: `conn_${connector.id}_${t.action}`, description: t.desc,
      parameters: { type: "object", properties: t.params, required: t.required } },
  }));
}

function getAnthropicToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({
    name: `conn_${connector.id}_${t.action}`, description: t.desc,
    input_schema: { type: "object", properties: t.params, required: t.required },
  }));
}

async function executeTool(action, args, connector) {
  const creds = cfg(connector);
  if (!creds.domain || !creds.apiToken) return "Confluence not configured. Please add credentials in Integrations.";
  const api = client(creds);

  try {
    if (action === "search_pages") {
      const { query, spaceKey } = args;
      let cql = `type=page AND text~"${query}"`;
      if (spaceKey) cql += ` AND space.key="${spaceKey}"`;
      const res = await api.get(`/content/search?cql=${encodeURIComponent(cql)}&limit=10`);
      const results = res.data.results || [];
      if (!results.length) return "No pages found.";
      return results.map(r => `[${r.id}] ${r.title} (Space: ${r.space?.name})`).join("\n");
    }

    if (action === "get_page") {
      const res = await api.get(`/content/${args.pageId}?expand=body.storage`);
      const text = res.data.body?.storage?.value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "";
      return `Title: ${res.data.title}\n\n${text.slice(0, 3000)}`;
    }

    if (action === "list_spaces") {
      const res = await api.get("/space?limit=25&type=global");
      const spaces = res.data.results || [];
      return spaces.map(s => `${s.key}: ${s.name}`).join("\n") || "No spaces found.";
    }

    return `Unknown Confluence action: ${action}`;
  } catch (err) {
    return `Confluence error: ${err.response?.data?.message || err.message}`;
  }
}

async function testConnection(authConfig) {
  try {
    const res = await client(authConfig).get("/space?limit=1");
    return Array.isArray(res.data.results);
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
