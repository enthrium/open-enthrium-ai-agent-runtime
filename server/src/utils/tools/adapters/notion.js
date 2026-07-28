const axios = require("axios");

function cfg(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function client({ integrationToken }) {
  return axios.create({
    baseURL: "https://api.notion.com/v1",
    headers: { Authorization: `Bearer ${integrationToken}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
  });
}

const TOOLS = c => [
  { action: "search",      desc: `Search Notion pages and databases via ${c.name}.`,
    params: { query: { type: "string", description: "Search query." } }, required: ["query"] },
  { action: "get_page",    desc: `Get content of a Notion page via ${c.name}.`,
    params: { pageId: { type: "string", description: "Notion page ID." } }, required: ["pageId"] },
  { action: "create_page", desc: `Create a new Notion page via ${c.name}.`,
    params: { parentId: { type: "string", description: "Parent page ID to create the page under." },
              title:    { type: "string", description: "Page title." },
              content:  { type: "string", description: "Page content (plain text)." } }, required: ["parentId","title"] },
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
  if (!creds.integrationToken) return "Notion not configured. Please add credentials in Integrations.";
  const api = client(creds);

  try {
    if (action === "search") {
      const res = await api.post("/search", { query: args.query, page_size: 10 });
      const results = res.data.results || [];
      if (!results.length) return "No results found.";
      return results.map(r => {
        const title = r.properties?.title?.title?.[0]?.plain_text || r.properties?.Name?.title?.[0]?.plain_text || "(untitled)";
        return `[${r.id}] ${title} (${r.object})`;
      }).join("\n");
    }

    if (action === "get_page") {
      const [page, blocks] = await Promise.all([
        api.get(`/pages/${args.pageId}`),
        api.get(`/blocks/${args.pageId}/children?page_size=50`),
      ]);
      const title = Object.values(page.data.properties || {}).find(p => p.type === "title")?.title?.[0]?.plain_text || "(untitled)";
      const content = (blocks.data.results || []).map(b => {
        const type = b.type;
        return b[type]?.rich_text?.map(t => t.plain_text).join("") || "";
      }).filter(Boolean).join("\n");
      return `Title: ${title}\n\n${content.slice(0, 3000)}`;
    }

    if (action === "create_page") {
      const { parentId, title, content = "" } = args;
      const res = await api.post("/pages", {
        parent: { page_id: parentId },
        properties: { title: { title: [{ type: "text", text: { content: title } }] } },
        children: content ? [{ object: "block", type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: content.slice(0, 2000) } }] } }] : [],
      });
      return `Created Notion page: ${title} (ID: ${res.data.id})`;
    }

    return `Unknown Notion action: ${action}`;
  } catch (err) {
    return `Notion error: ${err.response?.data?.message || err.message}`;
  }
}

async function testConnection(authConfig) {
  try {
    const res = await client(authConfig).post("/search", { page_size: 1 });
    return Array.isArray(res.data.results);
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
