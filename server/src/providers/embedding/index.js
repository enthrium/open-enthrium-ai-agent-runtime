const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

async function getSetting(key) {
  const s = await db.setting.findUnique({ where: { key } });
  return s?.value || null;
}

/**
 * Embed texts and return { embeddings, tokensUsed, model }.
 * tokensUsed is the actual count from the API response (0 for local providers).
 */
async function embed(texts) {
  const { default: OpenAI } = await import("openai");

  const provider = (await getSetting("embedding_provider")) || process.env.EMBEDDING_PROVIDER || "openai";
  const model    = (await getSetting("embedding_model"))    || process.env.EMBEDDING_MODEL    || "text-embedding-3-small";

  let res;

  if (provider === "azure") {
    const endpoint   = (await getSetting("embedding_azure_endpoint"))   || (await getSetting("llm_azure_endpoint"))   || process.env.AZURE_OPENAI_ENDPOINT;
    const deployment = (await getSetting("embedding_azure_deployment")) || process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
    const apiKey     = (await getSetting("embedding_api_key")) || (await getSetting("llm_api_key")) || process.env.AZURE_OPENAI_API_KEY;
    const client = new OpenAI({
      apiKey,
      baseURL: `${endpoint}/openai/deployments/${deployment}`,
      defaultQuery: { "api-version": "2024-08-01-preview" },
      defaultHeaders: { "api-key": apiKey }
    });
    res = await client.embeddings.create({ model, input: texts });

  } else if (provider === "ollama") {
    const rawUrl = (await getSetting("embedding_base_url")) || (await getSetting("llm_base_url")) || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    const baseURL = rawUrl.replace(/\/v1\/?$/, "") + "/v1";
    const client = new OpenAI({ baseURL, apiKey: "ollama" });
    res = await client.embeddings.create({ model: model || "nomic-embed-text", input: texts });

  } else if (provider === "lmstudio" || provider === "generic-openai") {
    const rawUrl = (await getSetting("embedding_base_url")) || process.env.EMBEDDING_BASE_URL || "http://localhost:1234/v1";
    const apiKey = (await getSetting("embedding_api_key")) || "lmstudio";
    const client = new OpenAI({ baseURL: rawUrl, apiKey });
    res = await client.embeddings.create({ model, input: texts });

  } else if (provider === "gemini") {
    const apiKey = (await getSetting("embedding_api_key")) || process.env.GEMINI_API_KEY;
    const client = new OpenAI({ apiKey, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" });
    res = await client.embeddings.create({ model: model || "text-embedding-004", input: texts });

  } else if (provider === "cohere") {
    const apiKey = (await getSetting("embedding_api_key")) || process.env.COHERE_API_KEY;
    const client = new OpenAI({ apiKey, baseURL: "https://api.cohere.com/compatibility/v1" });
    res = await client.embeddings.create({ model: model || "embed-english-v3.0", input: texts });

  } else {
    // Default: OpenAI
    const apiKey = (await getSetting("embedding_api_key")) || (await getSetting("llm_api_key")) || process.env.OPENAI_API_KEY;
    const client = new OpenAI({ apiKey });
    res = await client.embeddings.create({ model, input: texts });
  }

  return {
    embeddings: res.data.map(d => d.embedding),
    tokensUsed: res.usage?.total_tokens || 0,
    model:      model
  };
}

module.exports = { embed };
