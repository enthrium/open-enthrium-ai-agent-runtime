const { embed } = require("../../providers/embedding");
const getSetting = require("./_settings");
const { v5: uuidv5 } = require("uuid");

const UUID_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

let _client = null, _clientKey = null;

async function getClient(cfg = {}) {
  const url    = cfg.url    || (await getSetting("vector_db_url"))     || "http://localhost:6333";
  const apiKey = cfg.apiKey || (await getSetting("vector_db_api_key")) || "";
  const key = `${url}:${apiKey}`;
  if (!_client || _clientKey !== key) {
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    _client    = new QdrantClient({ url, ...(apiKey ? { apiKey } : {}) });
    _clientKey = key;
  }
  return _client;
}

function colName(workspaceSlug) {
  return `ws_${workspaceSlug.replace(/-/g, "_")}`;
}

async function ensureCollection(client, name, vectorSize) {
  try {
    await client.getCollection(name);
  } catch {
    await client.createCollection(name, {
      vectors: { size: vectorSize, distance: "Cosine" },
    });
    await client.createPayloadIndex(name, {
      field_name: "documentUid",
      field_schema: "keyword",
    });
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

    await client.upsert(col, {
      wait: true,
      points: batch.map((c, j) => ({
        id:      uuidv5(`${documentUid}_${i + j}`, UUID_NS),
        vector:  embeddings[j],
        payload: { documentUid, text: c.text, ...(c.metadata || {}) },
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
    const results = await client.search(colName(workspaceSlug), {
      vector: embeddings[0],
      limit: topK,
      with_payload: true,
    });
    return results.map(r => ({
      text:     r.payload?.text || "",
      metadata: Object.fromEntries(
        Object.entries(r.payload || {}).filter(([k]) => k !== "text" && k !== "documentUid")
      ),
      score: r.score,
    }));
  } catch {
    return [];
  }
}

async function deleteDocumentChunks(workspaceSlug, documentUid, config = {}) {
  try {
    const client = await getClient(config);
    await client.delete(colName(workspaceSlug), {
      wait: true,
      filter: { must: [{ key: "documentUid", match: { value: documentUid } }] },
    });
  } catch {}
}

module.exports = { upsertChunksBatched, similaritySearch, deleteDocumentChunks };
