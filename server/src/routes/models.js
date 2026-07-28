const router = require("express").Router();
const { authenticate } = require("../middleware/auth");
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

const STATIC_MODELS = {
  openai:     ["gpt-4o","gpt-4o-mini","gpt-4-turbo","gpt-4-turbo-preview","gpt-4","gpt-3.5-turbo","o1","o1-mini","o1-preview","o3-mini"],
  anthropic:  ["claude-opus-4-8","claude-sonnet-4-6","claude-3-5-sonnet-20241022","claude-3-5-haiku-20241022","claude-3-opus-20240229","claude-3-sonnet-20240229","claude-3-haiku-20240307"],
  gemini:     ["gemini-2.0-flash","gemini-2.0-flash-lite","gemini-2.0-pro-exp","gemini-1.5-pro","gemini-1.5-flash","gemini-1.5-flash-8b"],
  groq:       ["llama-3.3-70b-versatile","llama-3.1-70b-versatile","llama-3.1-8b-instant","llama3-70b-8192","llama3-8b-8192","mixtral-8x7b-32768","gemma2-9b-it","gemma-7b-it"],
  mistral:    ["mistral-large-latest","mistral-medium-latest","mistral-small-latest","open-mistral-nemo","open-mixtral-8x22b","open-mixtral-8x7b","codestral-latest","ministral-8b-latest","ministral-3b-latest"],
  deepseek:   ["deepseek-chat","deepseek-reasoner"],
  perplexity: ["llama-3.1-sonar-huge-128k-online","llama-3.1-sonar-large-128k-online","llama-3.1-sonar-small-128k-online","llama-3.1-8b-instruct","llama-3.1-70b-instruct"],
  xai:        ["grok-2-latest","grok-2-vision-latest","grok-beta","grok-vision-beta"],
  togetherai: ["meta-llama/Llama-3.3-70B-Instruct-Turbo","meta-llama/Llama-3.1-405B-Instruct-Turbo","meta-llama/Llama-3.1-70B-Instruct-Turbo","meta-llama/Llama-3.1-8B-Instruct-Turbo","meta-llama/Llama-3-70b-chat-hf","mistralai/Mixtral-8x7B-Instruct-v0.1","mistralai/Mistral-7B-Instruct-v0.3","Qwen/Qwen2.5-72B-Instruct-Turbo","deepseek-ai/DeepSeek-R1","deepseek-ai/DeepSeek-V3"],
  fireworks:  ["accounts/fireworks/models/llama-v3p3-70b-instruct","accounts/fireworks/models/llama-v3p1-405b-instruct","accounts/fireworks/models/llama-v3p1-70b-instruct","accounts/fireworks/models/llama-v3p1-8b-instruct","accounts/fireworks/models/mixtral-8x7b-instruct","accounts/fireworks/models/deepseek-r1","accounts/fireworks/models/deepseek-v3","accounts/fireworks/models/qwen2p5-72b-instruct"],
  openrouter: ["openai/gpt-4o","openai/gpt-4o-mini","openai/o1","anthropic/claude-3.5-sonnet","anthropic/claude-3-opus","google/gemini-2.0-flash-exp","google/gemini-pro-1.5","meta-llama/llama-3.3-70b-instruct","deepseek/deepseek-r1","deepseek/deepseek-chat","mistralai/mistral-large-2411","x-ai/grok-2-1212","x-ai/grok-beta"],
  nvidiaNim:  ["meta/llama-3.3-70b-instruct","meta/llama-3.1-405b-instruct","meta/llama-3.1-70b-instruct","meta/llama-3.1-8b-instruct","microsoft/phi-3-mini-128k-instruct","mistralai/mistral-large","mistralai/mixtral-8x22b-instruct-v0.1","google/gemma-2-27b-it"],
  sambanova:  ["Meta-Llama-3.3-70B-Instruct","Meta-Llama-3.1-405B-Instruct","Meta-Llama-3.1-70B-Instruct","Meta-Llama-3.1-8B-Instruct","Qwen2.5-72B-Instruct","Qwen2.5-Coder-32B-Instruct","DeepSeek-R1","DeepSeek-V3"],
  ollama:     ["llama3.2","llama3.1","llama3","mistral","mixtral","phi3","phi4","gemma2","qwen2.5","deepseek-r1","codellama","nomic-embed-text"],
  lmstudio:   [],
  "generic-openai": [],
};

async function getStoredApiKey() {
  const s = await db.setting.findUnique({ where: { key: "llm_api_key" } });
  return s?.value || null;
}

async function getStoredBaseUrl() {
  const s = await db.setting.findUnique({ where: { key: "llm_base_url" } });
  return s?.value || null;
}

router.get("/:provider", authenticate, async (req, res) => {
  const { provider } = req.params;
  let { apiKey, baseUrl } = req.query;

  // Masked value from admin settings — use the DB key instead
  if (apiKey === "********" || !apiKey) apiKey = null;
  if (!baseUrl) baseUrl = null;

  try {
    // OpenAI — try live fetch with provided or stored key
    if (provider === "openai") {
      const key = apiKey || await getStoredApiKey();
      if (key) {
        try {
          const { default: OpenAI } = await import("openai");
          const client = new OpenAI({ apiKey: key });
          const list = await client.models.list();
          const models = list.data
            .filter(m => m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3"))
            .sort((a, b) => b.created - a.created)
            .map(m => m.id);
          if (models.length) return res.json({ models });
        } catch { /* fall through to static */ }
      }
      return res.json({ models: STATIC_MODELS.openai });
    }

    // Ollama — try live fetch from local server
    if (provider === "ollama") {
      const url = (baseUrl || await getStoredBaseUrl() || "http://localhost:11434").replace(/\/v1\/?$/, "");
      try {
        const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        const json = await r.json();
        const models = (json.models || []).map(m => m.name);
        if (models.length) return res.json({ models });
      } catch { /* fall through to static */ }
      return res.json({ models: STATIC_MODELS.ollama });
    }

    // All other providers — return static list
    res.json({ models: STATIC_MODELS[provider] || [] });
  } catch (err) {
    res.json({ models: STATIC_MODELS[provider] || [], error: err.message });
  }
});

module.exports = router;
