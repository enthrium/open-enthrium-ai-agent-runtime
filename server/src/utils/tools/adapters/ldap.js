const { Client } = require("ldapts");

function getConfig(connector) {
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const cfg  = connector.config     ? JSON.parse(connector.config)     : {};
  return {
    url:          auth.url          || cfg.url          || auth.baseUrl || cfg.baseUrl || "ldap://localhost:389",
    bindDN:       auth.bindDN       || cfg.bindDN       || "",
    bindPassword: auth.bindPassword || cfg.bindPassword || auth.password || cfg.password || "",
    baseDN:       auth.baseDN       || cfg.baseDN       || "",
  };
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_search`,
        description: `Search the LDAP/Active Directory "${connector.name}" for users, groups, or objects.`,
        parameters: {
          type: "object",
          properties: {
            filter: { type: "string", description: "LDAP filter, e.g. (objectClass=person) or (mail=user@example.com)" },
            base:   { type: "string", description: "Search base DN (uses configured baseDN if omitted)" },
            attributes: { type: "array", items: { type: "string" }, description: "Attributes to return (default: all)" },
          },
          required: ["filter"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_get_user`,
        description: `Look up a specific user in "${connector.name}" by username or email.`,
        parameters: {
          type: "object",
          properties: {
            username: { type: "string", description: "sAMAccountName, uid, or email" },
          },
          required: ["username"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_list_groups`,
        description: `List all groups in the LDAP directory "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            base: { type: "string", description: "Base DN to search (optional)" },
          },
          required: [],
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
  if (!config.url) return "LDAP URL not configured.";

  const client = new Client({ url: config.url, tlsOptions: { rejectUnauthorized: false } });

  try {
    if (config.bindDN) await client.bind(config.bindDN, config.bindPassword);

    if (action === "search") {
      const { searchEntries } = await client.search(args.base || config.baseDN, {
        filter: args.filter,
        attributes: args.attributes || ["*"],
        scope: "sub",
        sizeLimit: 100,
      });
      return JSON.stringify(searchEntries, null, 2).slice(0, 8000);
    }

    if (action === "get_user") {
      const filter = args.username.includes("@")
        ? `(mail=${args.username})`
        : `(|(sAMAccountName=${args.username})(uid=${args.username}))`;
      const { searchEntries } = await client.search(config.baseDN, { filter, scope: "sub", sizeLimit: 5 });
      return searchEntries.length
        ? JSON.stringify(searchEntries[0], null, 2).slice(0, 4000)
        : "User not found.";
    }

    if (action === "list_groups") {
      const { searchEntries } = await client.search(args.base || config.baseDN, {
        filter: "(objectClass=group)",
        attributes: ["cn", "description", "member"],
        scope: "sub",
        sizeLimit: 200,
      });
      return searchEntries.map(g => g.cn).join("\n") || "No groups found.";
    }

    return `Unknown LDAP action: ${action}`;
  } catch (err) {
    return `LDAP error: ${err.message}`;
  } finally {
    await client.unbind().catch(() => {});
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
