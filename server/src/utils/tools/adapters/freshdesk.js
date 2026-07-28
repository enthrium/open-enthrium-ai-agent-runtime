const axios = require("axios");

function cfg(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function client({ domain, apiKey }) {
  return axios.create({
    baseURL: `https://${domain}/api/v2`,
    auth: { username: apiKey, password: "X" },
    headers: { "Content-Type": "application/json" },
  });
}

const TOOLS = c => [
  { action: "list_tickets",  desc: `List support tickets from Freshdesk via ${c.name}.`,
    params: { status:   { type: "string", description: "Filter by status: open, pending, resolved, closed." },
              priority: { type: "string", description: "Filter by priority: low, medium, high, urgent." } }, required: [] },
  { action: "get_ticket",   desc: `Get a Freshdesk ticket by ID via ${c.name}.`,
    params: { ticketId: { type: "number", description: "Ticket ID." } }, required: ["ticketId"] },
  { action: "create_ticket", desc: `Create a Freshdesk support ticket via ${c.name}.`,
    params: { subject:     { type: "string", description: "Ticket subject." },
              description: { type: "string", description: "Ticket description." },
              email:       { type: "string", description: "Requester email." },
              priority:    { type: "number", description: "Priority: 1=low, 2=medium, 3=high, 4=urgent. Default: 2." } }, required: ["subject","description","email"] },
];

const STATUS_MAP = { open: 2, pending: 3, resolved: 4, closed: 5 };
const PRIORITY_MAP = { low: 1, medium: 2, high: 3, urgent: 4 };

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
  if (!creds.domain || !creds.apiKey) return "Freshdesk not configured. Please add credentials in Integrations.";
  const api = client(creds);

  try {
    if (action === "list_tickets") {
      const params = new URLSearchParams({ per_page: "15" });
      if (args.status)   params.set("status",   STATUS_MAP[args.status]   || 2);
      if (args.priority) params.set("priority", PRIORITY_MAP[args.priority] || 2);
      const res = await api.get(`/tickets?${params}`);
      const tickets = res.data || [];
      if (!tickets.length) return "No tickets found.";
      return tickets.map(t => `[#${t.id}] ${t.subject} — Status: ${t.status}, Priority: ${t.priority}`).join("\n");
    }

    if (action === "get_ticket") {
      const res = await api.get(`/tickets/${args.ticketId}`);
      const t = res.data;
      return JSON.stringify({ id: t.id, subject: t.subject, status: t.status, priority: t.priority, requester: t.requester_id, created: t.created_at, description: t.description_text?.slice(0, 500) }, null, 2);
    }

    if (action === "create_ticket") {
      const { subject, description, email, priority = 2 } = args;
      const res = await api.post("/tickets", { subject, description, email, priority, source: 2 });
      return `Created ticket #${res.data.id}: ${subject}`;
    }

    return `Unknown Freshdesk action: ${action}`;
  } catch (err) {
    return `Freshdesk error: ${err.response?.data?.description || err.message}`;
  }
}

async function testConnection(authConfig) {
  try {
    const res = await client(authConfig).get("/tickets?per_page=1");
    return Array.isArray(res.data);
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
