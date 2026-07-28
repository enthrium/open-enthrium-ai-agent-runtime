const Redis = require("ioredis");

function cfg(connector) {
  return connector.config   ? JSON.parse(connector.config)   : {};
}
function auth(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function client(connector) {
  const c = cfg(connector);
  const a = auth(connector);
  return new Redis({
    host:     c.host     || "localhost",
    port:     parseInt(c.port || "6379"),
    password: a.password || undefined,
    db:       parseInt(c.db || "0"),
    tls:      c.tls ? {} : undefined,
    lazyConnect: true,
    connectTimeout: 8000,
    commandTimeout: 10000,
  });
}

const TOOLS = c => [
  { action: "get",    desc: `Get the value of a key from ${c.name}.`,
    params: { key: { type: "string", description: "The Redis key." } }, required: ["key"] },
  { action: "set",    desc: `Set a key-value pair in ${c.name}.`,
    params: { key: { type: "string" }, value: { type: "string" }, ttl: { type: "number", description: "TTL in seconds (optional)." } }, required: ["key","value"] },
  { action: "del",    desc: `Delete one or more keys from ${c.name}.`,
    params: { keys: { type: "array", items: { type: "string" }, description: "Keys to delete." } }, required: ["keys"] },
  { action: "keys",   desc: `List keys matching a pattern in ${c.name}.`,
    params: { pattern: { type: "string", description: 'Pattern e.g. "user:*"' } }, required: ["pattern"] },
  { action: "hgetall",desc: `Get all fields of a hash key from ${c.name}.`,
    params: { key: { type: "string" } }, required: ["key"] },
  { action: "lrange", desc: `Get a range of elements from a list in ${c.name}.`,
    params: { key: { type: "string" }, start: { type: "number", description: "Start index (0)." }, stop: { type: "number", description: "Stop index (-1 for all)." } }, required: ["key"] },
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
  const r = client(connector);
  try {
    await r.connect();

    if (action === "get") {
      const val = await r.get(args.key);
      return val === null ? `Key "${args.key}" not found.` : val;
    }
    if (action === "set") {
      if (args.ttl) await r.set(args.key, args.value, "EX", args.ttl);
      else          await r.set(args.key, args.value);
      return `OK — set "${args.key}"`;
    }
    if (action === "del") {
      const n = await r.del(...args.keys);
      return `Deleted ${n} key(s).`;
    }
    if (action === "keys") {
      const keys = await r.keys(args.pattern || "*");
      return keys.length ? keys.slice(0, 200).join("\n") : "No keys matched.";
    }
    if (action === "hgetall") {
      const hash = await r.hgetall(args.key);
      return hash && Object.keys(hash).length ? JSON.stringify(hash, null, 2) : `Hash "${args.key}" not found or empty.`;
    }
    if (action === "lrange") {
      const items = await r.lrange(args.key, args.start ?? 0, args.stop ?? -1);
      return items.length ? JSON.stringify(items, null, 2) : `List "${args.key}" not found or empty.`;
    }
    return `Unknown Redis action: ${action}`;
  } catch (err) {
    return `Redis error: ${err.message}`;
  } finally {
    r.disconnect();
  }
}

async function testConnection(authConfig, config) {
  const connector = { config: JSON.stringify(config || {}), authConfig: JSON.stringify(authConfig || {}) };
  const r = client(connector);
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch { return false; }
  finally { r.disconnect(); }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
