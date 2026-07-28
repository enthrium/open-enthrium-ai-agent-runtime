const axios = require("axios");

function cfg(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function client({ privateAppToken }) {
  return axios.create({
    baseURL: "https://api.hubapi.com",
    headers: { Authorization: `Bearer ${privateAppToken}`, "Content-Type": "application/json" },
  });
}

const TOOLS = c => [
  { action: "search_contacts", desc: `Search HubSpot contacts via ${c.name}.`,
    params: { query: { type: "string", description: "Search query (name, email, company)." } }, required: ["query"] },
  { action: "get_contact",     desc: `Get a HubSpot contact by ID via ${c.name}.`,
    params: { contactId: { type: "string", description: "HubSpot contact ID." } }, required: ["contactId"] },
  { action: "create_contact",  desc: `Create a HubSpot contact via ${c.name}.`,
    params: { email:     { type: "string", description: "Contact email." },
              firstName: { type: "string", description: "First name." },
              lastName:  { type: "string", description: "Last name." },
              company:   { type: "string", description: "Company name." } }, required: ["email"] },
  { action: "search_deals",    desc: `Search HubSpot deals via ${c.name}.`,
    params: { query: { type: "string", description: "Deal name or keyword." } }, required: ["query"] },
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
  if (!creds.privateAppToken) return "HubSpot not configured. Please add credentials in Integrations.";
  const api = client(creds);

  try {
    if (action === "search_contacts") {
      const res = await api.post("/crm/v3/objects/contacts/search", {
        query: args.query, limit: 10,
        properties: ["firstname","lastname","email","company","phone"],
      });
      const results = res.data.results || [];
      if (!results.length) return "No contacts found.";
      return results.map(r => {
        const p = r.properties;
        return `[${r.id}] ${p.firstname || ""} ${p.lastname || ""} <${p.email}> — ${p.company || ""}`;
      }).join("\n");
    }

    if (action === "get_contact") {
      const res = await api.get(`/crm/v3/objects/contacts/${args.contactId}?properties=firstname,lastname,email,company,phone,createdate`);
      return JSON.stringify(res.data.properties, null, 2);
    }

    if (action === "create_contact") {
      const { email, firstName = "", lastName = "", company = "" } = args;
      const res = await api.post("/crm/v3/objects/contacts", {
        properties: { email, firstname: firstName, lastname: lastName, company },
      });
      return `Created contact: ${firstName} ${lastName} <${email}> (ID: ${res.data.id})`;
    }

    if (action === "search_deals") {
      const res = await api.post("/crm/v3/objects/deals/search", {
        query: args.query, limit: 10,
        properties: ["dealname","amount","dealstage","closedate"],
      });
      const results = res.data.results || [];
      if (!results.length) return "No deals found.";
      return results.map(r => {
        const p = r.properties;
        return `[${r.id}] ${p.dealname} — Stage: ${p.dealstage}, Amount: ${p.amount || "N/A"}`;
      }).join("\n");
    }

    return `Unknown HubSpot action: ${action}`;
  } catch (err) {
    return `HubSpot error: ${err.response?.data?.message || err.message}`;
  }
}

async function testConnection(authConfig) {
  try {
    const res = await client(authConfig).get("/crm/v3/objects/contacts?limit=1");
    return Array.isArray(res.data.results);
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
