const { embed } = require("../../providers/embedding");
const getSetting = require("./_settings");

let _pinecone = null;
let _pineconeKey = null;

async function getIndex(cfg = {}) {
  const apiKey    = cfg.apiKey || (await getSetting("vector_db_api_key")) || "";
  const indexName = cfg.index  || (await getSetting("vector_db_index"))   || "openenterprise";
  if (!_pinecone || _pineconeKey !== apiKey) {
    const { Pinecone } = await import("@pinecone-database/pinecone");
    _pinecone    = new Pinecone({ apiKey });
    _pineconeKey = apiKey;
  }
  return _pinecone.index(indexName);
}

async function upsertChunksBatched(workspaceSlug, documentUid, chunks, options = {}, config = {}) {
  const { batchSize = 100, onProgress, shouldCancel } = options;
  const index = await getIndex(config);
  const ns    = index.namespace(workspaceSlug);

  let chunksProcessed = 0, embeddingTokens = 0, embeddingModel = null;

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (shouldCancel && await shouldCancel()) return { chunksProcessed, embeddingTokens, embeddingModel };

    const batch = chunks.slice(i, i + batchSize);
    const { embeddings, tokensUsed, model } = await embed(batch.map(c => c.text));
    embeddingTokens += tokensUsed;
    if (!embeddingModel) embeddingModel = model;

    await ns.upsert(batch.map((c, j) => ({
      id:       `${documentUid}_${i + j}`,
      values:   embeddings[j],
      metadata: { documentUid, text: c.text, ...(c.metadata || {}) },
    })));

    chunksProcessed += batch.length;
    if (onProgress) await onProgress(chunksProcessed);
  }
  return { chunksProcessed, embeddingTokens, embeddingModel };
}

async function similaritySearch(workspaceSlug, query, topK = 5, config = {}) {
  try {
    const index = await getIndex(config);
    const ns    = index.namespace(workspaceSlug);
    const { embeddings } = await embed([query]);
    const results = await ns.query({ vector: embeddings[0], topK, includeMetadata: true });
    return (results.matches || []).map(m => ({
      text:     m.metadata?.text || "",
      metadata: Object.fromEntries(
        Object.entries(m.metadata || {}).filter(([k]) => k !== "text" && k !== "documentUid")
      ),
      score: m.score,
    }));
  } catch {
    return [];
  }
}

async function deleteDocumentChunks(workspaceSlug, documentUid, config = {}) {
  try {
    const index = await getIndex(config);
    const ns    = index.namespace(workspaceSlug);
    await ns.deleteMany({ documentUid });
  } catch {}
}

module.exports = { upsertChunksBatched, similaritySearch, deleteDocumentChunks };
