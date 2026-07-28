const { embed } = require("../../providers/embedding");
const getSetting = require("./_settings");
const { v5: uuidv5 } = require("uuid");

const UUID_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

async function getConfig(cfg = {}) {
  const url    = cfg.url    || (await getSetting("vector_db_url"))     || "http://localhost:8080";
  const apiKey = cfg.apiKey || (await getSetting("vector_db_api_key")) || null;
  return { url, apiKey };
}

function className(workspaceSlug) {
  return "Ws" + workspaceSlug.split(/[-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

async function req(baseUrl, apiKey, method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok && res.status !== 422) {
    const text = await res.text();
    throw new Error(`Weaviate ${method} ${path}: ${res.status} ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function ensureClass(baseUrl, apiKey, cls, vectorDim) {
  try {
    await req(baseUrl, apiKey, "GET", `/v1/schema/${cls}`);
  } catch {
    await req(baseUrl, apiKey, "POST", "/v1/schema", {
      class: cls,
      vectorizer: "none",
      properties: [
        { name: "documentUid", dataType: ["text"], tokenization: "field" },
        { name: "text",        dataType: ["text"] },
        { name: "metadata",    dataType: ["text"] },
      ],
    });
  }
}

async function upsertChunksBatched(workspaceSlug, documentUid, chunks, options = {}, config = {}) {
  const { batchSize = 50, onProgress, shouldCancel } = options;
  const { url, apiKey } = await getConfig(config);
  const cls = className(workspaceSlug);

  let chunksProcessed = 0, embeddingTokens = 0, embeddingModel = null;
  let classReady = false;

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (shouldCancel && await shouldCancel()) return { chunksProcessed, embeddingTokens, embeddingModel };

    const batch = chunks.slice(i, i + batchSize);
    const { embeddings, tokensUsed, model } = await embed(batch.map(c => c.text));
    embeddingTokens += tokensUsed;
    if (!embeddingModel) embeddingModel = model;

    if (!classReady) {
      await ensureClass(url, apiKey, cls, embeddings[0].length);
      classReady = true;
    }

    const objects = batch.map((c, j) => ({
      class:  cls,
      id:     uuidv5(`${documentUid}_${i + j}`, UUID_NS),
      vector: embeddings[j],
      properties: {
        documentUid,
        text:     c.text,
        metadata: JSON.stringify(c.metadata || {}),
      },
    }));

    await req(url, apiKey, "POST", "/v1/batch/objects", { objects });

    chunksProcessed += batch.length;
    if (onProgress) await onProgress(chunksProcessed);
  }
  return { chunksProcessed, embeddingTokens, embeddingModel };
}

async function similaritySearch(workspaceSlug, query, topK = 5, config = {}) {
  try {
    const { url, apiKey } = await getConfig(config);
    const cls = className(workspaceSlug);
    const { embeddings } = await embed([query]);
    const gql = {
      query: `{
        Get {
          ${cls}(
            nearVector: { vector: [${embeddings[0].join(",")}] }
            limit: ${topK}
          ) {
            text metadata documentUid
            _additional { certainty }
          }
        }
      }`,
    };
    const data = await req(url, apiKey, "POST", "/v1/graphql", gql);
    const hits = data?.data?.Get?.[cls] || [];
    return hits.map(h => ({
      text:     h.text || "",
      metadata: (() => { try { return JSON.parse(h.metadata || "{}"); } catch { return {}; } })(),
      score:    h._additional?.certainty || 0,
    }));
  } catch {
    return [];
  }
}

async function deleteDocumentChunks(workspaceSlug, documentUid, config = {}) {
  try {
    const { url, apiKey } = await getConfig(config);
    const cls = className(workspaceSlug);
    await req(url, apiKey, "DELETE", "/v1/batch/objects", {
      match: {
        class: cls,
        where: {
          operator:  "Equal",
          path:      ["documentUid"],
          valueText: documentUid,
        },
      },
    });
  } catch {}
}

module.exports = { upsertChunksBatched, similaritySearch, deleteDocumentChunks };
