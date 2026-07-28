const axios = require("axios");

function auth(connector) { return connector.authConfig ? JSON.parse(connector.authConfig) : {}; }
function cfg(connector)  { return connector.config    ? JSON.parse(connector.config)    : {}; }

async function getToken(connector, db) {
  const a = auth(connector);
  const c = cfg(connector);
  if (!a.refreshToken) return a.accessToken;
  if (a.expiresAt && Date.now() < a.expiresAt - 60000) return a.accessToken;
  const { data } = await axios.post("https://api.dropboxapi.com/oauth2/token",
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refreshToken, client_id: c.appKey, client_secret: c.appSecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const newAuth = { ...a, accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 14400) * 1000 };
  if (db) await db.connector.update({ where: { id: connector.id }, data: { authConfig: JSON.stringify(newAuth) } });
  return data.access_token;
}

function api(token) {
  return axios.create({ baseURL: "https://api.dropboxapi.com/2", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
}

const TOOLS = c => [
  { action: "list_files", desc: `List files/folders in Dropbox via ${c.name}.`,
    params: { path: { type: "string", description: 'Folder path e.g. "/Documents" or "" for root.' } }, required: [] },
  { action: "read_file",  desc: `Read the text content of a Dropbox file via ${c.name}.`,
    params: { path: { type: "string", description: "File path in Dropbox e.g. /Reports/q1.csv" } }, required: ["path"] },
  { action: "search",     desc: `Search files in Dropbox via ${c.name}.`,
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
  try {
    if (action === "list_files") {
      const res = await api(token).post("/files/list_folder", { path: args.path || "", limit: 100 });
      const entries = res.data.entries || [];
      return entries.map(e => `${e[".tag"] === "folder" ? "📁" : "📄"} ${e.name} (path: ${e.path_display})`).join("\n") || "Empty folder.";
    }
    if (action === "read_file") {
      const res = await axios.post("https://content.dropboxapi.com/2/files/download", null, {
        headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: args.path }) },
        responseType: "text"
      });
      return String(res.data).slice(0, 8000);
    }
    if (action === "search") {
      const res = await api(token).post("/files/search_v2", { query: args.query, options: { max_results: 20 } });
      const matches = res.data.matches || [];
      return matches.map(m => `${m.metadata?.metadata?.name} (${m.metadata?.metadata?.path_display})`).join("\n") || "No results.";
    }
    return `Unknown Dropbox action: ${action}`;
  } catch (err) { return `Dropbox error: ${err.response?.data?.error_summary || err.message}`; }
}

async function testConnection(authConfig, config, db, connectorId) {
  try {
    const connector = { authConfig: JSON.stringify(authConfig), config: JSON.stringify(config || {}), id: connectorId };
    const token = await getToken(connector, db);
    const res = await axios.post("https://api.dropboxapi.com/2/users/get_current_account", null, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return !!res.data.account_id;
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection, getToken };
