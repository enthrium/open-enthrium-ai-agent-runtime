const OPENAI_COMPATIBLE = {
  groq:             { baseURL: "https://api.groq.com/openai/v1" },
  togetherai:       { baseURL: "https://api.together.xyz/v1" },
  mistral:          { baseURL: "https://api.mistral.ai/v1" },
  openrouter:       { baseURL: "https://openrouter.ai/api/v1" },
  perplexity:       { baseURL: "https://api.perplexity.ai" },
  deepseek:         { baseURL: "https://api.deepseek.com/v1" },
  xai:              { baseURL: "https://api.x.ai/v1" },
  fireworks:        { baseURL: "https://api.fireworks.ai/inference/v1" },
  gemini:           { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" },
  nvidiaNim:        { baseURL: "https://integrate.api.nvidia.com/v1" },
  sambanova:        { baseURL: "https://api.sambanova.ai/v1" },
  litellm:          { baseURL: null, apiKey: "no-key", localDefault: "http://localhost:4000" },
  ollama:           { baseURL: null, apiKey: "ollama", localDefault: "http://localhost:11434/v1" },
  lmstudio:         { baseURL: null, apiKey: "lmstudio", localDefault: "http://localhost:1234/v1" },
  "generic-openai": { baseURL: null, localDefault: "" },
};

/**
 * Create an LLM client from a plain config object — no Prisma, no DB.
 *
 * config: { provider, apiKey, model, baseURL?, azureEndpoint?, azureDeployment? }
 * Returns: { provider, client, model }
 */
async function createLLMClient(config) {
  const openaiPkg = require("openai");
  const OpenAI    = openaiPkg.OpenAI || openaiPkg.default || openaiPkg;
  const provider  = config.provider || "openai";
  const model    = config.model    || "gpt-4o";

  if (provider === "azure") {
    const endpoint   = config.azureEndpoint   || process.env.AZURE_OPENAI_ENDPOINT;
    const deployment = config.azureDeployment || process.env.AZURE_OPENAI_DEPLOYMENT;
    const key        = config.apiKey          || process.env.AZURE_OPENAI_API_KEY;
    return {
      provider: "azure", model,
      client: new OpenAI({
        apiKey: key,
        baseURL: `${endpoint}/openai/deployments/${deployment}`,
        defaultQuery: { "api-version": "2024-08-01-preview" },
        defaultHeaders: { "api-key": key },
      }),
    };
  }

  if (provider === "anthropic") {
    const Anthropic = require("@anthropic-ai/sdk");
    return {
      provider: "anthropic", model,
      client: new Anthropic({ apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY }),
    };
  }

  if (provider === "openai") {
    return {
      provider: "openai", model,
      client: new OpenAI({ apiKey: config.apiKey || process.env.OPENAI_API_KEY }),
    };
  }

  const compat = OPENAI_COMPATIBLE[provider];
  if (compat) {
    const baseURL = config.baseURL || compat.baseURL || compat.localDefault;
    const key     = config.apiKey  || compat.apiKey  || "no-key";
    return { provider, model, client: new OpenAI({ apiKey: key, baseURL }) };
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}

module.exports = { createLLMClient, OPENAI_COMPATIBLE };
