const axios = require("axios");

function cfg(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function client({ subdomain, email, apiToken }) {
  return axios.create({
    baseURL: `https://${subdomain}.zendesk.com/api/v2`,
    auth: { username: `${email}/token`, password: apiToken },
    headers: { "Content-Type": "application/json" },
  });
}

const TOOLS = c => [
  { action: "search_tickets", desc: `Search Zendesk tickets via ${c.name}.`,
    params: { query: { type: "string", description: "Search query (e.g. status:open priority:high)." } }, required: ["query"] },
  { action: "get_ticket",     desc: `Get a Zendesk ticket by ID via ${c.name}.`,
    params: { ticketId: { type: "number", description: "Ticket ID." } }, required: ["ticketId"] },
  { action: "create_ticket",  desc: `Create a Zendesk ticket via ${c.name}.`,
    params: { subject:        { type: "string", description: "Ticket subject." },
              comment:        { type: "string", description: "Initial comment / description." },
              requesterEmail: { type: "string", description: "Requester email address." },
              priority:       { type: "string", description: "Priority: low, normal, high, urgent." } }, required: ["subject","comment"] },
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
  if (!creds.subdomain || !creds.apiToken) return "Zendesk not configured. Please add credentials in Integrations.";
  const api = client(creds);

  try {
    if (action === "search_tickets") {
      const res = await api.get(`/search.json?query=type:ticket ${encodeURIComponent(args.query)}&per_page=15`);
      const results = res.data.results || [];
      if (!results.length) return "No tickets found.";
      return results.map(t => `[#${t.id}] ${t.subject} — Status: ${t.status}, Priority: ${t.priority}`).join("\n");
    }

    if (action === "get_ticket") {
      const res = await api.get(`/tickets/${args.ticketId}.json`);
      const t = res.data.ticket;
      return JSON.stringify({ id: t.id, subject: t.subject, status: t.status, priority: t.priority, created: t.created_at, description: t.description?.slice(0, 500) }, null, 2);
    }

    if (action === "create_ticket") {
      const { subject, comment, requesterEmail, priority = "normal" } = args;
      const body = { ticket: { subject, comment: { body: comment }, priority } };
      if (requesterEmail) body.ticket.requester = { email: requesterEmail };
      const res = await api.post("/tickets.json", body);
      return `Created ticket #${res.data.ticket.id}: ${subject}`;
    }

    return `Unknown Zendesk action: ${action}`;
  } catch (err) {
    return `Zendesk error: ${err.response?.data?.description || err.message}`;
  }
}

async function testConnection(authConfig) {
  try {
    const res = await client(authConfig).get("/tickets.json?per_page=1");
    return Array.isArray(res.data.tickets);
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
