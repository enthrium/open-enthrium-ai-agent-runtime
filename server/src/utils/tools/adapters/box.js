const axios = require("axios");

function auth(connector) { return connector.authConfig ? JSON.parse(connector.authConfig) : {}; }
function cfg(connector)  { return connector.config    ? JSON.parse(connector.config)    : {}; }

async function getToken(connector, db) {
  const a = auth(connector);
  const c = cfg(connector);
  if (!a.refreshToken) return a.accessToken;
  if (a.expiresAt && Date.now() < a.expiresAt - 60000) return a.accessToken;
  const { data } = await axios.post("https://api.box.com/oauth2/token",
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refreshToken, client_id: c.clientId, client_secret: c.clientSecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const newAuth = { ...a, accessToken: data.access_token, refreshToken: data.refresh_token || a.refreshToken, expiresAt: Date.now() + data.expires_in * 1000 };
  if (db) await db.connector.update({ where: { id: connector.id }, data: { authConfig: JSON.stringify(newAuth) } });
  return data.access_token;
}

function client(token) {
  return axios.create({ baseURL: "https://api.box.com/2.0", headers: { Authorization: `Bearer ${token}` } });
}

const TOOLS = c => [
  { action: "list_files", desc: `List files/folders in Box via ${c.name}.`,
    params: { folderId: { type: "string", description: 'Folder ID. Use "0" for root.' } }, required: [] },
  { action: "read_file",  desc: `Read the text content of a Box file via ${c.name}.`,
    params: { fileId: { type: "string", description: "Box file ID." } }, required: ["fileId"] },
  { action: "search",     desc: `Search files in Box via ${c.name}.`,
    params: { query: { type: "string", description: "Search query." } }, required: ["query"] },
];

function getToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({ type: "function", function: { name: `conn_${connector.id}_${t.action}`, description: t.desc, parameters: { type: "object", properties: t.params, required: t.required } } }));
}
function getAnthropicToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({ name: `conn_${connector.id}_${t.action}`, description: t.desc, input_schema: { type: "object", properties: t.params, required: t.required } }));
}

async function executeTool(action, args, connector, db) {
  const token = await getToken(connector, db);
  const api = client(token);
  try {
    if (action === "list_files") {
      const id = args.folderId || "0";
      const res = await api.get(`/folders/${id}/items?limit=100`);
      const entries = res.data.entries || [];
      return entries.map(e => `${e.type === "folder" ? "📁" : "📄"} ${e.name} (id: ${e.id})`).join("\n") || "Empty folder.";
    }
    if (action === "read_file") {
      const res = await api.get(`/files/${args.fileId}/content`, { responseType: "text" });
      return String(res.data).slice(0, 8000);
    }
    if (action === "search") {
      const res = await api.get(`/search?query=${encodeURIComponent(args.query)}&limit=20`);
      const entries = res.data.entries || [];
      return entries.map(e => `${e.name} (id: ${e.id}, type: ${e.type})`).join("\n") || "No results.";
    }
    return `Unknown Box action: ${action}`;
  } catch (err) { return `Box error: ${err.response?.data?.message || err.message}`; }
}

async function testConnection(authConfig, config, db, connectorId) {
  try {
    const connector = { authConfig: JSON.stringify(authConfig), config: JSON.stringify(config || {}), id: connectorId };
    const token = await getToken(connector, db);
    const res = await client(token).get("/users/me");
    return !!res.data.id;
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection, getToken };
