const { Client }     = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SSEClientTransport }   = require("@modelcontextprotocol/sdk/client/sse.js");
const axios = require("axios");

function getConfig(connector) {
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const cfg  = connector.config     ? JSON.parse(connector.config)     : {};
  return {
    sseUrl:  auth.baseUrl  || cfg.baseUrl  || auth.sseUrl  || cfg.sseUrl  || "",
    command: auth.command  || cfg.command  || "",
    args:    auth.args     || cfg.args     || [],
    bearerToken: auth.bearerToken || cfg.bearerToken || "",
  };
}

async function withMcpClient(config, fn) {
  const client = new Client({ name: "open-enterprise", version: "1.0.0" }, { capabilities: {} });

  let transport;
  if (config.sseUrl) {
    const headers = config.bearerToken ? { Authorization: `Bearer ${config.bearerToken}` } : {};
    transport = new SSEClientTransport(new URL(config.sseUrl), { requestInit: { headers } });
  } else if (config.command) {
    transport = new StdioClientTransport({ command: config.command, args: config.args });
  } else {
    throw new Error("MCP connector requires either sseUrl or command.");
  }

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_list_tools`,
        description: `List all tools available on the MCP server "${connector.name}".`,
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_call_tool`,
        description: `Call a specific tool on the MCP server "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            tool:      { type: "string", description: "Tool name to call" },
            arguments: { type: "object", description: "Arguments to pass to the tool", additionalProperties: true },
          },
          required: ["tool"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_list_resources`,
        description: `List resources exposed by the MCP server "${connector.name}".`,
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_read_resource`,
        description: `Read a resource from the MCP server "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            uri: { type: "string", description: "Resource URI" },
          },
          required: ["uri"],
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
  const config = getConfig(connector);

  try {
    if (action === "list_tools") {
      return await withMcpClient(config, async client => {
        const { tools } = await client.listTools();
        return tools.map(t => `${t.name}: ${t.description || ""}`).join("\n") || "No tools found.";
      });
    }

    if (action === "call_tool") {
      if (!args.tool) return "Tool name required.";
      return await withMcpClient(config, async client => {
        const result = await client.callTool({ name: args.tool, arguments: args.arguments || {} });
        const content = result.content || [];
        return content.map(c => c.text || JSON.stringify(c)).join("\n").slice(0, 8000);
      });
    }

    if (action === "list_resources") {
      return await withMcpClient(config, async client => {
        const { resources } = await client.listResources();
        return resources.map(r => `${r.uri} — ${r.name || ""}`).join("\n") || "No resources found.";
      });
    }

    if (action === "read_resource") {
      if (!args.uri) return "Resource URI required.";
      return await withMcpClient(config, async client => {
        const result = await client.readResource({ uri: args.uri });
        const content = result.contents || [];
        return content.map(c => c.text || JSON.stringify(c)).join("\n").slice(0, 8000);
      });
    }

    return `Unknown MCP action: ${action}`;
  } catch (err) {
    return `MCP error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
