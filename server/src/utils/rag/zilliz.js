const { embed } = require("../../providers/embedding");
const getSetting = require("./_settings");

let _client = null, _clientKey = null;

async function getClient(cfg = {}) {
  const address = cfg.url    || (await getSetting("vector_db_url"))     || "";
  const token   = cfg.apiKey || (await getSetting("vector_db_api_key")) || "";
  const key = `${address}:${token}`;
  if (!_client || _clientKey !== key) {
    const { MilvusClient } = require("@zilliz/milvus2-sdk-node");
    _client    = new MilvusClient({ address, token, ssl: true });
    _clientKey = key;
  }
  return _client;
}

function colName(workspaceSlug) {
  return `ws_${workspaceSlug.replace(/[-]/g, "_")}`;
}

async function ensureCollection(client, name, dim) {
  const exists = await client.hasCollection({ collection_name: name });
  if (!exists.value) {
    await client.createCollection({
      collection_name: name,
      fields: [
        { name: "id",           data_type: "VarChar", max_length: 128, is_primary_key: true },
        { name: "documentUid", data_type: "VarChar", max_length: 128 },
        { name: "text",         data_type: "VarChar", max_length: 65535 },
        { name: "metadata",     data_type: "VarChar", max_length: 65535 },
        { name: "embedding",    data_type: "FloatVector", dim },
      ],
    });
    await client.createIndex({
      collection_name: name,
      field_name:      "embedding",
      index_type:      "AUTOINDEX",
      metric_type:     "COSINE",
    });
    await client.loadCollection({ collection_name: name });
  }
}

async function upsertChunksBatched(workspaceSlug, documentUid, chunks, options = {}, config = {}) {
  const { batchSize = 50, onProgress, shouldCancel } = options;
  const client = await getClient(config);
  const col    = colName(workspaceSlug);

  let chunksProcessed = 0, embeddingTokens = 0, embeddingModel = null;
  let collectionReady = false;

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (shouldCancel && await shouldCancel()) return { chunksProcessed, embeddingTokens, embeddingModel };

    const batch = chunks.slice(i, i + batchSize);
    const { embeddings, tokensUsed, model } = await embed(batch.map(c => c.text));
    embeddingTokens += tokensUsed;
    if (!embeddingModel) embeddingModel = model;

    if (!collectionReady) {
      await ensureCollection(client, col, embeddings[0].length);
      collectionReady = true;
    }

    await client.insert({
      collection_name: col,
      data: batch.map((c, j) => ({
        id:          `${documentUid}_${i + j}`.slice(0, 128),
        documentUid: documentUid.slice(0, 128),
        text:        (c.text || "").slice(0, 65535),
        metadata:    JSON.stringify(c.metadata || {}).slice(0, 65535),
        embedding:   embeddings[j],
      })),
    });

    chunksProcessed += batch.length;
    if (onProgress) await onProgress(chunksProcessed);
  }
  return { chunksProcessed, embeddingTokens, embeddingModel };
}

async function similaritySearch(workspaceSlug, query, topK = 5, config = {}) {
  try {
    const client = await getClient(config);
    const { embeddings } = await embed([query]);
    const results = await client.search({
      collection_name: colName(workspaceSlug),
      vectors:         [embeddings[0]],
      vector_type:     "FloatVector",
      limit:           topK,
      output_fields:   ["text", "metadata", "documentUid"],
      metric_type:     "COSINE",
    });
    return (results.results || []).map(r => ({
      text:     r.text || "",
      metadata: (() => { try { return JSON.parse(r.metadata || "{}"); } catch { return {}; } })(),
      score:    r.score,
    }));
  } catch {
    return [];
  }
}

async function deleteDocumentChunks(workspaceSlug, documentUid, config = {}) {
  try {
    const client = await getClient(config);
    await client.deleteEntities({
      collection_name: colName(workspaceSlug),
      expr: `documentUid == "${documentUid}"`,
    });
  } catch {}
}

module.exports = { upsertChunksBatched, similaritySearch, deleteDocumentChunks };
