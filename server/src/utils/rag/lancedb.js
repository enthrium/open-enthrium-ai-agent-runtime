const path = require("path");
const { embed } = require("../../providers/embedding");

let lancedb;
async function getDb() {
  if (!lancedb) lancedb = await import("@lancedb/lancedb");
  const dbPath = path.join(__dirname, "../../../storage/lancedb");
  return lancedb.connect(dbPath);
}

async function ensureFtsIndex(table) {
  try {
    const indices = await table.listIndices();
    if (!indices.some(idx => idx.indexType === "FTS")) {
      await table.createIndex("text", { config: lancedb.Index.fts() });
    }
  } catch {}
}

async function upsertChunksBatched(workspaceSlug, documentUid, chunks, options = {}) {
  const { batchSize = 10, onProgress, shouldCancel } = options;
  const db = await getDb();
  const tableName = `ws_${workspaceSlug.replace(/-/g, "_")}`;

  let chunksProcessed = 0;
  let embeddingTokens  = 0;
  let embeddingModel   = null;

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (shouldCancel && await shouldCancel()) return { chunksProcessed, embeddingTokens, embeddingModel };

    const batch = chunks.slice(i, i + batchSize);
    const { embeddings, tokensUsed, model } = await embed(batch.map(c => c.text));

    embeddingTokens += tokensUsed;
    if (!embeddingModel) embeddingModel = model;

    const records = batch.map((c, j) => ({
      id:          `${documentUid}_${i + j}`,
      documentUid,
      text:        c.text,
      metadata:    JSON.stringify(c.metadata || {}),
      vector:      embeddings[j],
    }));

    try {
      const table = await db.openTable(tableName);
      await table.add(records);
    } catch {
      const table = await db.createTable(tableName, records);
      await ensureFtsIndex(table);
    }

    chunksProcessed += batch.length;
    if (onProgress) await onProgress(chunksProcessed);
  }

  try {
    const table = await db.openTable(tableName);
    await ensureFtsIndex(table);
  } catch {}

  return { chunksProcessed, embeddingTokens, embeddingModel };
}

async function similaritySearch(workspaceSlug, query, topK = 5) {
  const db = await getDb();
  const tableName = `ws_${workspaceSlug.replace(/-/g, "_")}`;
  try {
    const { embeddings } = await embed([query]);
    const table = await db.openTable(tableName);
    const fetchK = Math.max(topK * 3, 20);

    const [vectorResults, ftsResults] = await Promise.all([
      table.search(embeddings[0]).limit(fetchK).toArray(),
      table.search(query, "fts").limit(fetchK).toArray().catch(() => []),
    ]);

    const RRF_K = 60;
    const scores = {}, texts = {}, metas = {};
    vectorResults.forEach((r, i) => { scores[r.id] = (scores[r.id] || 0) + 1 / (RRF_K + i + 1); texts[r.id] = r.text; metas[r.id] = r.metadata; });
    ftsResults.forEach((r, i)    => { scores[r.id] = (scores[r.id] || 0) + 1 / (RRF_K + i + 1); texts[r.id] = r.text; metas[r.id] = r.metadata; });

    return Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, score]) => ({ text: texts[id], metadata: JSON.parse(metas[id] || "{}"), score }));
  } catch (err) {
    console.error(`[lancedb] similaritySearch failed for workspace "${workspaceSlug}":`, err?.message || err);
    return [];
  }
}

async function deleteDocumentChunks(workspaceSlug, documentUid) {
  const db = await getDb();
  const tableName = `ws_${workspaceSlug.replace(/-/g, "_")}`;
  try {
    const table = await db.openTable(tableName);
    await table.delete(`documentUid = '${documentUid}'`);
  } catch {}
}

module.exports = { upsertChunksBatched, similaritySearch, deleteDocumentChunks };
