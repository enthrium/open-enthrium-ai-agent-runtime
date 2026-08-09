const { embed } = require("../../providers/embedding");
const getSetting = require("./_settings");

let _client = null;
let _clientKey = null;

async function getClient(cfg = {}) {
  const url    = cfg.url    || (await getSetting("vector_db_url"))     || "http://localhost:8000";
  const apiKey = cfg.apiKey || (await getSetting("vector_db_api_key")) || "";
  const key = `${url}:${apiKey}`;
  if (!_client || _clientKey !== key) {
    const { ChromaClient } = await import("chromadb");
    _client = new ChromaClient({
      path: url,
      ...(apiKey ? { auth: { provider: "token", credentials: apiKey } } : {}),
    });
    _clientKey = key;
  }
  return _client;
}

function colName(workspaceSlug) {
  return `ws_${workspaceSlug.replace(/-/g, "_")}`;
}

async function upsertChunksBatched(workspaceSlug, documentUid, chunks, options = {}, config = {}) {
  const { batchSize = 50, onProgress, shouldCancel } = options;
  const client     = await getClient(config);
  const collection = await client.getOrCreateCollection({ name: colName(workspaceSlug) });

  let chunksProcessed = 0, embeddingTokens = 0, embeddingModel = null;

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (shouldCancel && await shouldCancel()) return { chunksProcessed, embeddingTokens, embeddingModel };

    const batch = chunks.slice(i, i + batchSize);
    const { embeddings, tokensUsed, model } = await embed(batch.map(c => c.text));
    embeddingTokens += tokensUsed;
    if (!embeddingModel) embeddingModel = model;

    await collection.upsert({
      ids:        batch.map((_, j) => `${documentUid}_${i + j}`),
      documents:  batch.map(c => c.text),
      embeddings,
      metadatas:  batch.map(c => ({ documentUid, ...(c.metadata || {}) })),
    });

    chunksProcessed += batch.length;
    if (onProgress) await onProgress(chunksProcessed);
  }
  return { chunksProcessed, embeddingTokens, embeddingModel };
}

async function similaritySearch(workspaceSlug, query, topK = 5, config = {}) {
  try {
    const client     = await getClient(config);
    const collection = await client.getOrCreateCollection({ name: colName(workspaceSlug) });
    const { embeddings } = await embed([query]);
    const results = await collection.query({
      queryEmbeddings: [embeddings[0]],
      nResults: topK,
      include: ["documents", "metadatas", "distances"],
    });
    return (results.ids[0] || []).map((_, i) => ({
      text:     results.documents[0][i],
      metadata: results.metadatas[0][i] || {},
      score:    1 - (results.distances[0][i] || 0),
    }));
  } catch {
    return [];
  }
}

async function deleteDocumentChunks(workspaceSlug, documentUid, config = {}) {
  try {
    const client     = await getClient(config);
    const collection = await client.getOrCreateCollection({ name: colName(workspaceSlug) });
    await collection.delete({ where: { documentUid } });
  } catch {}
}

module.exports = { upsertChunksBatched, similaritySearch, deleteDocumentChunks };
