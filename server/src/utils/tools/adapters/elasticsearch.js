const { Client } = require("@elastic/elasticsearch");

function cfg(connector) {
  return connector.config    ? JSON.parse(connector.config)    : {};
}
function auth(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function client(connector) {
  const c = cfg(connector);
  const a = auth(connector);
  const opts = { node: c.node || "http://localhost:9200", requestTimeout: 15000 };
  if (a.apiKey)                       opts.auth = { apiKey: a.apiKey };
  else if (a.username || a.password)  opts.auth = { username: a.username, password: a.password };
  return new Client(opts);
}

const TOOLS = c => {
  const idx = JSON.parse(c.config || "{}").index || "your-index";
  return [
    { action: "search",   desc: `Search documents in ${c.name} (Elasticsearch).`,
      params: { index: { type: "string", description: `Index name (default: ${idx})` },
                query: { type: "object", description: 'Elasticsearch query DSL e.g. {"match":{"field":"value"}}' },
                size:  { type: "number", description: "Max results (default 10)" } }, required: [] },
    { action: "get",      desc: `Get a document by ID from ${c.name}.`,
      params: { index: { type: "string", description: `Index name (default: ${idx})` },
                id:    { type: "string", description: "Document ID." } }, required: ["id"] },
    { action: "index_doc",desc: `Index (upsert) a document in ${c.name}.`,
      params: { index:    { type: "string", description: `Index name (default: ${idx})` },
                id:       { type: "string", description: "Document ID (optional, auto-generated if omitted)." },
                document: { type: "object", description: "Document body to index." } }, required: ["document"] },
  ];
};

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
  const c   = cfg(connector);
  const es  = client(connector);
  const idx = args.index || c.index || "default";

  try {
    if (action === "search") {
      const res = await es.search({ index: idx, size: args.size || 10,
        body: args.query ? { query: args.query } : { query: { match_all: {} } } });
      const hits = res.hits?.hits || [];
      if (!hits.length) return "No documents found.";
      return JSON.stringify(hits.map(h => ({ _id: h._id, _score: h._score, ...h._source })), null, 2);
    }

    if (action === "get") {
      const res = await es.get({ index: idx, id: args.id });
      return JSON.stringify({ _id: res._id, ...res._source }, null, 2);
    }

    if (action === "index_doc") {
      const res = await es.index({ index: idx, id: args.id || undefined, document: args.document });
      return `Document ${res.result}: _id=${res._id} in index "${idx}"`;
    }

    return `Unknown Elasticsearch action: ${action}`;
  } catch (err) {
    return `Elasticsearch error: ${err.message}`;
  }
}

async function testConnection(authConfig, config) {
  const connector = { config: JSON.stringify(config || {}), authConfig: JSON.stringify(authConfig || {}) };
  try {
    const es = client(connector);
    await es.ping();
    return true;
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
