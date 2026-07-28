const axios = require("axios");

function cfg(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function client(token) {
  return axios.create({
    baseURL: "https://slack.com/api",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

const TOOLS = c => [
  { action: "post_message",    desc: `Post a message to a Slack channel via ${c.name}.`,
    params: { channel: { type: "string", description: "Channel name or ID (e.g. #general)" },
              text:    { type: "string", description: "Message text to post." } }, required: ["channel","text"] },
  { action: "list_channels",   desc: `List public Slack channels via ${c.name}.`,   params: {}, required: [] },
  { action: "search_messages", desc: `Search Slack messages via ${c.name}.`,
    params: { query: { type: "string", description: "Search query." } }, required: ["query"] },
];

function getToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({
    type: "function",
    function: {
      name: `conn_${connector.id}_${t.action}`,
      description: t.desc,
      parameters: { type: "object", properties: t.params, required: t.required },
    },
  }));
}

function getAnthropicToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({
    name: `conn_${connector.id}_${t.action}`,
    description: t.desc,
    input_schema: { type: "object", properties: t.params, required: t.required },
  }));
}

async function executeTool(action, args, connector) {
  const { botToken } = cfg(connector);
  if (!botToken) return "Slack not configured. Please add credentials in Integrations.";
  const api = client(botToken);

  try {
    if (action === "post_message") {
      const { channel, text } = args;
      const res = await api.post("/chat.postMessage", { channel, text });
      if (!res.data.ok) return `Slack error: ${res.data.error}`;
      return `Message posted to ${channel}.`;
    }

    if (action === "list_channels") {
      const res = await api.get("/conversations.list?types=public_channel&limit=50");
      if (!res.data.ok) return `Slack error: ${res.data.error}`;
      const channels = (res.data.channels || []).map(c => `#${c.name} (${c.num_members} members)`);
      return channels.length ? channels.join("\n") : "No channels found.";
    }

    if (action === "search_messages") {
      const res = await api.get(`/search.messages?query=${encodeURIComponent(args.query)}&count=10`);
      if (!res.data.ok) return `Slack error: ${res.data.error}`;
      const matches = res.data.messages?.matches || [];
      if (!matches.length) return "No messages found.";
      return matches.map(m => `[${m.channel?.name}] ${m.username}: ${m.text}`).join("\n\n");
    }

    return `Unknown Slack action: ${action}`;
  } catch (err) {
    return `Slack error: ${err.response?.data?.error || err.message}`;
  }
}

async function testConnection(authConfig) {
  try {
    const res = await client(authConfig.botToken).get("/auth.test");
    return res.data.ok;
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
