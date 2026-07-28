const { MongoClient } = require("mongodb");

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_find`,
        description: `Search documents in the "${connector.name}" MongoDB database. Use for filtering, retrieving, and looking up records.`,
        parameters: {
          type: "object",
          properties: {
            collection: { type: "string",  description: "Collection name to query." },
            filter:     { type: "object",  description: "MongoDB filter (e.g. {\"status\": \"active\"}). Use {} for all." },
            projection: { type: "object",  description: "Fields to include/exclude (optional)." },
            limit:      { type: "number",  description: "Max results to return (default 20, max 100)." },
          },
          required: ["collection", "filter"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_aggregate`,
        description: `Run a MongoDB aggregation pipeline on the "${connector.name}" database. Use for grouping, counting, summing, or analytics.`,
        parameters: {
          type: "object",
          properties: {
            collection: { type: "string", description: "Collection name." },
            pipeline:   { type: "array",  description: "Aggregation pipeline stages (e.g. [{\"$group\": {\"_id\": \"$status\", \"count\": {\"$sum\": 1}}}])." },
          },
          required: ["collection", "pipeline"]
        }
      }
    }
  ];
}

function getAnthropicToolDefinitions(connector) {
  return [
    {
      name: `conn_${connector.id}_find`,
      description: `Search documents in the "${connector.name}" MongoDB database.`,
      input_schema: {
        type: "object",
        properties: {
          collection: { type: "string",  description: "Collection name to query." },
          filter:     { type: "object",  description: "MongoDB filter document." },
          projection: { type: "object",  description: "Fields to include/exclude (optional)." },
          limit:      { type: "number",  description: "Max results (default 20, max 100)." },
        },
        required: ["collection", "filter"]
      }
    },
    {
      name: `conn_${connector.id}_aggregate`,
      description: `Run a MongoDB aggregation pipeline on the "${connector.name}" database.`,
      input_schema: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Collection name." },
          pipeline:   { type: "array",  description: "Aggregation pipeline stages." },
        },
        required: ["collection", "pipeline"]
      }
    }
  ];
}

function buildUri(cfg, auth) {
  if (cfg.uri) return cfg.uri;
  const creds = auth.username ? `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password || "")}@` : "";
  const host  = cfg.host || "localhost";
  const port  = cfg.port || "27017";
  const db    = cfg.database ? `/${cfg.database}` : "";
  return `mongodb://${creds}${host}:${port}${db}`;
}

async function executeTool(action, args, connector) {
  const cfg  = connector.config     ? JSON.parse(connector.config)     : {};
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const uri  = buildUri(cfg, auth);

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db(cfg.database || undefined);

    if (action === "find") {
      const { collection, filter = {}, projection, limit = 20 } = args;
      if (!collection) return "Collection name required.";
      const safeLimit = Math.min(parseInt(limit) || 20, 100);
      const opts = projection ? { projection } : {};
      const docs = await db.collection(collection).find(filter, opts).limit(safeLimit).toArray();
      if (!docs.length) return "No documents found.";
      return JSON.stringify(docs, null, 2);
    }

    if (action === "aggregate") {
      const { collection, pipeline = [] } = args;
      if (!collection) return "Collection name required.";
      if (!Array.isArray(pipeline)) return "Pipeline must be an array.";
      const hasLimit = pipeline.some(s => "$limit" in s);
      const safePipeline = hasLimit ? pipeline : [...pipeline, { $limit: 100 }];
      const docs = await db.collection(collection).aggregate(safePipeline).toArray();
      if (!docs.length) return "Aggregation returned no results.";
      return JSON.stringify(docs, null, 2);
    }

    return `Unknown MongoDB action: ${action}`;
  } catch (err) {
    return `MongoDB error: ${err.message}`;
  } finally {
    await client.close().catch(() => {});
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, buildUri };
