const axios = require("axios");

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_query`,
        description: `Run a GraphQL query against "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            query:     { type: "string", description: "GraphQL query string" },
            variables: { type: "object", description: "Optional variables", additionalProperties: true },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_mutate`,
        description: `Run a GraphQL mutation against "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            mutation:  { type: "string", description: "GraphQL mutation string" },
            variables: { type: "object", description: "Optional variables", additionalProperties: true },
          },
          required: ["mutation"],
        },
      },
    },
  ];
}

function getAnthropicToolDefinitions(connector) {
  return getToolDefinitions(connector).map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

async function executeTool(action, args, connector) {
  const cfg  = connector.config    ? JSON.parse(connector.config)    : {};
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};

  const endpoint = (cfg.baseUrl || auth.baseUrl || "").replace(/\/$/, "");
  if (!endpoint) return "GraphQL endpoint (baseUrl) not configured.";

  const headers = { "Content-Type": "application/json" };
  if (auth.bearerToken) headers["Authorization"] = `Bearer ${auth.bearerToken}`;
  if (auth.apiKey)      headers[auth.headerName || "X-API-Key"] = auth.apiKey;
  if (auth.headers) {
    try { Object.assign(headers, typeof auth.headers === "string" ? JSON.parse(auth.headers) : auth.headers); } catch {}
  }

  const body = action === "query"
    ? { query: args.query, variables: args.variables || {} }
    : { query: args.mutation, variables: args.variables || {} };

  try {
    const res = await axios.post(endpoint, body, { headers, timeout: 30000 });
    if (res.data.errors) return `GraphQL errors: ${JSON.stringify(res.data.errors, null, 2)}`;
    return JSON.stringify(res.data.data, null, 2).slice(0, 8000);
  } catch (err) {
    return `GraphQL error: ${err.response?.status} ${err.response?.statusText || err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
