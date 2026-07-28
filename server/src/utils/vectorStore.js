const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

const ADAPTERS = ["lancedb", "chroma", "pinecone", "qdrant", "weaviate", "pgvector", "milvus", "zilliz"];

async function resolveAdapter(workspaceSlug) {
  let provider = null;
  let config = {};

  // Workspace-level override takes priority
  if (workspaceSlug) {
    const ws = await db.workspace.findUnique({
      where: { slug: workspaceSlug },
      select: { vectorDbProvider: true, vectorDbConfig: true },
    });
    if (ws?.vectorDbProvider) {
      provider = ws.vectorDbProvider;
      try { config = ws.vectorDbConfig ? JSON.parse(ws.vectorDbConfig) : {}; } catch { config = {}; }
    }
  }

  // Fall back to instance-level setting
  if (!provider) {
    const s = await db.setting.findUnique({ where: { key: "vector_db_provider" } });
    provider = s?.value || process.env.VECTOR_DB_PROVIDER || "lancedb";
  }

  if (!ADAPTERS.includes(provider)) {
    console.warn(`[vectorStore] Unknown provider "${provider}", falling back to lancedb`);
    provider = "lancedb";
  }

  const mod = require(`./adapters/${provider}`);

  // If workspace has custom config, bind it so callers don't need to pass it
  if (Object.keys(config).length > 0) {
    return {
      upsertChunksBatched: (slug, uid, chunks, opts) => mod.upsertChunksBatched(slug, uid, chunks, opts, config),
      similaritySearch:    (slug, query, topK)       => mod.similaritySearch(slug, query, topK, config),
      deleteDocumentChunks:(slug, uid)               => mod.deleteDocumentChunks(slug, uid, config),
    };
  }

  return mod;
}

async function upsertChunks(workspaceSlug, documentUid, chunks) {
  const adapter = await resolveAdapter(workspaceSlug);
  const result  = await adapter.upsertChunksBatched(workspaceSlug, documentUid, chunks, { batchSize: chunks.length });
  return result.chunksProcessed;
}

async function upsertChunksBatched(workspaceSlug, documentUid, chunks, options = {}) {
  const adapter = await resolveAdapter(workspaceSlug);
  return adapter.upsertChunksBatched(workspaceSlug, documentUid, chunks, options);
}

async function similaritySearch(workspaceSlug, query, topK = 5) {
  const adapter = await resolveAdapter(workspaceSlug);
  return adapter.similaritySearch(workspaceSlug, query, topK);
}

async function deleteDocumentChunks(workspaceSlug, documentUid) {
  const adapter = await resolveAdapter(workspaceSlug);
  return adapter.deleteDocumentChunks(workspaceSlug, documentUid);
}

module.exports = { upsertChunks, upsertChunksBatched, similaritySearch, deleteDocumentChunks };
