const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

async function getSetting(key) {
  const s = await db.setting.findUnique({ where: { key } });
  return s?.value || null;
}

// Providers that use the OpenAI SDK with a custom baseURL
const OPENAI_COMPATIBLE = {
  groq:        { baseURL: "https://api.groq.com/openai/v1" },
  togetherai:  { baseURL: "https://api.together.xyz/v1" },
  mistral:     { baseURL: "https://api.mistral.ai/v1" },
  openrouter:  { baseURL: "https://openrouter.ai/api/v1" },
  perplexity:  { baseURL: "https://api.perplexity.ai" },
  deepseek:    { baseURL: "https://api.deepseek.com/v1" },
  xai:         { baseURL: "https://api.x.ai/v1" },
  fireworks:   { baseURL: "https://api.fireworks.ai/inference/v1" },
  // Google Gemini exposes an OpenAI-compatible endpoint
  gemini:      { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" },
  nvidiaNim:   { baseURL: "https://integrate.api.nvidia.com/v1" },
  sambanova:   { baseURL: "https://api.sambanova.ai/v1" },
  litellm:     { baseURL: null, apiKey: "no-key", localBaseUrlKey: "llm_base_url", localDefault: "http://localhost:4000" },
  // Local providers
  ollama:      { baseURL: null, apiKey: "ollama", localBaseUrlKey: "llm_base_url", localDefault: "http://localhost:11434/v1" },
  lmstudio:    { baseURL: null, apiKey: "lmstudio", localBaseUrlKey: "llm_base_url", localDefault: "http://localhost:1234/v1" },
  "generic-openai": { baseURL: null, localBaseUrlKey: "llm_base_url", localDefault: "" },
};

async function getLLMClient() {
  const { default: OpenAI } = await import("openai");
  const provider = (await getSetting("llm_provider")) || process.env.LLM_PROVIDER || "openai";
  const apiKey = (await getSetting("llm_api_key")) || null;

  // Azure (special case — needs endpoint + deployment in URL)
  if (provider === "azure") {
    const endpoint = (await getSetting("llm_azure_endpoint")) || process.env.AZURE_OPENAI_ENDPOINT;
    const deployment = (await getSetting("llm_azure_deployment")) || process.env.AZURE_OPENAI_DEPLOYMENT;
    const azureKey = (await getSetting("llm_api_key")) || process.env.AZURE_OPENAI_API_KEY;
    return {
      provider: "azure",
      client: new OpenAI({
        apiKey: azureKey,
        baseURL: `${endpoint}/openai/deployments/${deployment}`,
        defaultQuery: { "api-version": "2024-08-01-preview" },
        defaultHeaders: { "api-key": azureKey }
      })
    };
  }

  // Anthropic (separate SDK)
  if (provider === "anthropic") {
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropicKey = apiKey || process.env.ANTHROPIC_API_KEY;
    return { provider: "anthropic", client: new Anthropic({ apiKey: anthropicKey }) };
  }

  // Standard OpenAI
  if (provider === "openai") {
    return { provider: "openai", client: new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY }) };
  }

  // All OpenAI-compatible providers
  const compat = OPENAI_COMPATIBLE[provider];
  if (compat) {
    let baseURL = compat.baseURL;
    if (!baseURL) {
      baseURL = (await getSetting(compat.localBaseUrlKey)) || compat.localDefault;
    }
    const key = apiKey || compat.apiKey || "no-key";
    return { provider, client: new OpenAI({ apiKey: key, baseURL }) };
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}

async function chat(messages, { stream = false, systemPrompt = null, temperature = 0.7 } = {}) {
  const { provider, client } = await getLLMClient();
  const model = (await getSetting("llm_model"))
    || process.env.OPENAI_MODEL
    || process.env.OLLAMA_MODEL
    || "gpt-4o";

  const allMessages = systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...messages]
    : messages;

  if (provider === "anthropic") {
    const system = allMessages.find(m => m.role === "system")?.content;
    const userMsgs = allMessages.filter(m => m.role !== "system");
    const response = await client.messages.create({
      model: model || "claude-3-5-sonnet-20241022",
      max_tokens: 4096,
      system: system || undefined,
      messages: userMsgs,
      temperature,
      stream
    });
    if (stream) return response;
    return response.content[0].text;
  }

  const response = await client.chat.completions.create({ model, messages: allMessages, temperature, stream });
  if (stream) return response;
  return response.choices[0].message.content;
}

/**
 * Read LLM settings from DB and return a plain config object
 * that can be passed directly to engine.run() or createLLMClient().
 */
async function getLLMConfig() {
  const provider = (await getSetting("llm_provider")) || process.env.LLM_PROVIDER || "openai";
  const apiKey   = (await getSetting("llm_api_key"))  || null;
  const model    = (await getSetting("llm_model"))    || process.env.OPENAI_MODEL || process.env.OLLAMA_MODEL || "gpt-4o";

  if (provider === "azure") {
    return {
      provider,
      apiKey:          apiKey || process.env.AZURE_OPENAI_API_KEY,
      model,
      azureEndpoint:   (await getSetting("llm_azure_endpoint"))   || process.env.AZURE_OPENAI_ENDPOINT,
      azureDeployment: (await getSetting("llm_azure_deployment"))  || process.env.AZURE_OPENAI_DEPLOYMENT,
    };
  }

  const compat = OPENAI_COMPATIBLE[provider];
  if (compat?.localBaseUrlKey) {
    return { provider, apiKey: apiKey || compat.apiKey || "no-key", model,
             baseURL: (await getSetting(compat.localBaseUrlKey)) || compat.localDefault };
  }

  return { provider, apiKey, model };
}

module.exports = { chat, getLLMClient, getLLMConfig, getSetting };
