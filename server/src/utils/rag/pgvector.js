const { embed } = require("../../providers/embedding");
const getSetting = require("./_settings");
const { v5: uuidv5 } = require("uuid");

const UUID_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

let _pool = null, _poolKey = null;

async function getPool(cfg = {}) {
  const connStr = cfg.url || (await getSetting("vector_db_url")) || "";
  if (!_pool || _poolKey !== connStr) {
    const { Pool } = require("pg");
    const pgvector = require("pgvector/pg");
    _pool = new Pool({ connectionString: connStr });
    await pgvector.registerTypes(_pool);
    _poolKey = connStr;
  }
  return _pool;
}

async function ensureTable(pool, dim) {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id            TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      document_uid  TEXT NOT NULL,
      text          TEXT NOT NULL,
      metadata      JSONB,
      embedding     vector(${dim})
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_emb_workspace ON embeddings(workspace_slug)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_emb_document  ON embeddings(document_uid)");
}

let _tableReady = false;

async function upsertChunksBatched(workspaceSlug, documentUid, chunks, options = {}, config = {}) {
  const { batchSize = 50, onProgress, shouldCancel } = options;
  const pool = await getPool(config);

  let chunksProcessed = 0, embeddingTokens = 0, embeddingModel = null;

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (shouldCancel && await shouldCancel()) return { chunksProcessed, embeddingTokens, embeddingModel };

    const batch = chunks.slice(i, i + batchSize);
    const { embeddings, tokensUsed, model } = await embed(batch.map(c => c.text));
    embeddingTokens += tokensUsed;
    if (!embeddingModel) embeddingModel = model;

    if (!_tableReady) {
      await ensureTable(pool, embeddings[0].length);
      _tableReady = true;
    }

    const pgvector = require("pgvector/pg");
    for (let j = 0; j < batch.length; j++) {
      const id = uuidv5(`${documentUid}_${i + j}`, UUID_NS);
      await pool.query(
        `INSERT INTO embeddings (id, workspace_slug, document_uid, text, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, text = EXCLUDED.text`,
        [id, workspaceSlug, documentUid, batch[j].text, batch[j].metadata || {}, pgvector.toSql(embeddings[j])]
      );
    }

    chunksProcessed += batch.length;
    if (onProgress) await onProgress(chunksProcessed);
  }
  return { chunksProcessed, embeddingTokens, embeddingModel };
}

async function similaritySearch(workspaceSlug, query, topK = 5, config = {}) {
  try {
    const pool = await getPool(config);
    const pgvector = require("pgvector/pg");
    const { embeddings } = await embed([query]);
    const { rows } = await pool.query(
      `SELECT text, metadata, 1 - (embedding <=> $1) AS score
       FROM embeddings
       WHERE workspace_slug = $2
       ORDER BY embedding <=> $1
       LIMIT $3`,
      [pgvector.toSql(embeddings[0]), workspaceSlug, topK]
    );
    return rows.map(r => ({ text: r.text, metadata: r.metadata || {}, score: parseFloat(r.score) }));
  } catch {
    return [];
  }
}

async function deleteDocumentChunks(workspaceSlug, documentUid, config = {}) {
  try {
    const pool = await getPool(config);
    await pool.query(
      "DELETE FROM embeddings WHERE workspace_slug = $1 AND document_uid = $2",
      [workspaceSlug, documentUid]
    );
  } catch {}
}

module.exports = { upsertChunksBatched, similaritySearch, deleteDocumentChunks };
