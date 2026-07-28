const axios = require("axios");

function cfg(connector) { return connector.config    ? JSON.parse(connector.config)    : {}; }
function auth(connector) { return connector.authConfig ? JSON.parse(connector.authConfig) : {}; }

async function getToken(connector, db) {
  const a = auth(connector);
  const c = cfg(connector);
  if (!a.refreshToken) return a.accessToken;
  if (a.expiresAt && Date.now() < a.expiresAt - 60000) return a.accessToken;
  const tenantId = c.tenantId || "common";
  const { data } = await axios.post(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refreshToken, client_id: c.clientId, client_secret: c.clientSecret, scope: "Files.Read.All offline_access User.Read" }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const newAuth = { ...a, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, refreshToken: data.refresh_token || a.refreshToken };
  if (db) await db.connector.update({ where: { id: connector.id }, data: { authConfig: JSON.stringify(newAuth) } });
  return data.access_token;
}

function client(token) {
  return axios.create({ baseURL: "https://graph.microsoft.com/v1.0", headers: { Authorization: `Bearer ${token}` } });
}

const TOOLS = c => [
  { action: "list_files", desc: `List files/folders in OneDrive via ${c.name}.`,
    params: { itemId: { type: "string", description: 'Item ID or path. Use "root" for root folder.' } }, required: [] },
  { action: "read_file",  desc: `Read the text content of a OneDrive file via ${c.name}.`,
    params: { itemId: { type: "string", description: "OneDrive file item ID." } }, required: ["itemId"] },
  { action: "search",     desc: `Search files in OneDrive via ${c.name}.`,
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
      const id = args.itemId || "root";
      const res = await api.get(`/me/drive/items/${id}/children?$top=100`);
      const items = res.data.value || [];
      return items.map(i => `${i.folder ? "📁" : "📄"} ${i.name} (id: ${i.id})`).join("\n") || "Empty folder.";
    }
    if (action === "read_file") {
      const res = await api.get(`/me/drive/items/${args.itemId}/content`, { responseType: "text" });
      return String(res.data).slice(0, 8000);
    }
    if (action === "search") {
      const res = await api.get(`/me/drive/root/search(q='${encodeURIComponent(args.query)}')?$top=20`);
      const items = res.data.value || [];
      return items.map(i => `${i.name} (id: ${i.id})`).join("\n") || "No results.";
    }
    return `Unknown OneDrive action: ${action}`;
  } catch (err) { return `OneDrive error: ${err.response?.data?.error?.message || err.message}`; }
}

async function testConnection(authConfig, config, db, connectorId) {
  try {
    const connector = { authConfig: JSON.stringify(authConfig), config: JSON.stringify(config || {}), id: connectorId };
    const token = await getToken(connector, db);
    const res = await client(token).get("/me/drive");
    return !!res.data.id;
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection, getToken, client: (t) => client(t) };
