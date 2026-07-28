"use strict";
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

const ALL = require(path.resolve(__dirname, "../src/data/connectionTypes.json"))
  .map(t => ({ key: t.id, label: t.label, color: t.color, initial: t.initial, cat: t.cat }));

// â”€â”€ Field templates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const HTTP = JSON.stringify([
  { key: "baseUrl",  label: "Base URL",             type: "text",     required: true,  placeholder: "https://api.example.com/v1" },
  { key: "headers",  label: "Auth Headers (JSON)",   type: "json",     required: false, placeholder: '{"Authorization":"Bearer YOUR_TOKEN"}' },
]);

const DB = JSON.stringify([
  { key: "host",     label: "Host",                  type: "text",     required: true,  placeholder: "localhost" },
  { key: "port",     label: "Port",                  type: "number",   required: false, placeholder: "3306" },
  { key: "user",     label: "Username",              type: "text",     required: true,  placeholder: "root" },
  { key: "password", label: "Password",              type: "password", required: true  },
  { key: "database", label: "Database",              type: "text",     required: true,  placeholder: "mydb" },
  { key: "ssl",      label: "Use SSL",               type: "boolean",  required: false },
]);

const MONGO = JSON.stringify([
  { key: "connectionString", label: "Connection String", type: "text", required: true, placeholder: "mongodb://localhost:27017/mydb" },
]);

const REDIS = JSON.stringify([
  { key: "host",     label: "Host",     type: "text",     required: true,  placeholder: "localhost" },
  { key: "port",     label: "Port",     type: "number",   required: false, placeholder: "6379" },
  { key: "password", label: "Password", type: "password", required: false },
]);

const ES = JSON.stringify([
  { key: "url",      label: "URL",      type: "text",     required: true,  placeholder: "http://localhost:9200" },
  { key: "username", label: "Username", type: "text",     required: false },
  { key: "password", label: "Password", type: "password", required: false },
  { key: "apiKey",   label: "API Key",  type: "password", required: false },
]);

const SSH = JSON.stringify([
  { key: "host",           label: "Host",             type: "text",     required: true,  placeholder: "your-server.com" },
  { key: "port",           label: "Port",             type: "number",   required: false, placeholder: "22" },
  { key: "username",       label: "Username",         type: "text",     required: true,  placeholder: "ubuntu" },
  { key: "privateKeyPath", label: "Private Key Path", type: "text",     required: false, placeholder: "~/.ssh/id_rsa" },
  { key: "password",       label: "Password",         type: "password", required: false },
]);

const GDRIVE = JSON.stringify([
  { key: "clientId",     label: "Client ID",     type: "text",     required: true },
  { key: "clientSecret", label: "Client Secret", type: "password", required: true },
  { key: "accessToken",  label: "Access Token",  type: "password", required: false },
  { key: "refreshToken", label: "Refresh Token", type: "password", required: true },
]);

const GITHUB = JSON.stringify([
  { key: "token", label: "Personal Access Token", type: "password", required: true, placeholder: "ghp_..." },
  { key: "owner", label: "Owner / Org",           type: "text",     required: false },
  { key: "repo",  label: "Repository",            type: "text",     required: false },
]);

const SMTP = JSON.stringify([
  { key: "host",   label: "SMTP Host",    type: "text",     required: true,  placeholder: "smtp.zoho.com" },
  { key: "port",   label: "Port",         type: "number",   required: false, placeholder: "465" },
  { key: "secure", label: "Use SSL",      type: "boolean",  required: false },
  { key: "user",   label: "Email",        type: "text",     required: true },
  { key: "pass",   label: "App Password", type: "password", required: true },
]);

// â”€â”€ Field templates â€” new capability categories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const APIKEY = JSON.stringify([
  { key: "apiKey", label: "API Key", type: "password", required: true },
]);

const PERPLEXITY_SEARCH = JSON.stringify([
  { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "pplx-..." },
]);

const GOOGLE_SEARCH = JSON.stringify([
  { key: "apiKey",          label: "API Key",           type: "password", required: true },
  { key: "searchEngineId",  label: "Search Engine ID (cx)", type: "text", required: true },
]);

const BING_SEARCH = JSON.stringify([
  { key: "apiKey", label: "Ocp-Apim-Subscription-Key", type: "password", required: true },
]);

const AZURE_VISION = JSON.stringify([
  { key: "endpoint", label: "Endpoint", type: "text",     required: true, placeholder: "https://YOUR_RESOURCE.cognitiveservices.azure.com" },
  { key: "apiKey",   label: "API Key",  type: "password", required: true },
]);

const GOOGLE_VISION = JSON.stringify([
  { key: "apiKey", label: "API Key", type: "password", required: true },
]);

const AWS_TEXTRACT = JSON.stringify([
  { key: "accessKeyId",     label: "Access Key ID",     type: "text",     required: true },
  { key: "secretAccessKey", label: "Secret Access Key", type: "password", required: true },
  { key: "region",          label: "Region",            type: "text",     required: true, placeholder: "us-east-1" },
]);

const TESSERACT_OCR = JSON.stringify([
  { key: "baseUrl", label: "Service URL", type: "text", required: true, placeholder: "http://localhost:8884" },
]);

const OPENAI_IMAGE = JSON.stringify([
  { key: "apiKey", label: "OpenAI API Key", type: "password", required: true },
  { key: "model",  label: "Model",          type: "text",     required: false, placeholder: "dall-e-3" },
]);

const FLUX_IMAGE = JSON.stringify([
  { key: "apiKey", label: "Together AI API Key", type: "password", required: true },
  { key: "model",  label: "Model",               type: "text",     required: false, placeholder: "black-forest-labs/FLUX.1-schnell-Free" },
]);

const STABILITY_IMAGE = JSON.stringify([
  { key: "apiKey", label: "Stability AI API Key", type: "password", required: true },
]);

const IDEOGRAM_IMAGE = JSON.stringify([
  { key: "apiKey", label: "Ideogram API Key", type: "password", required: true },
]);

const ELEVENLABS = JSON.stringify([
  { key: "apiKey",  label: "API Key",          type: "password", required: true },
  { key: "voiceId", label: "Default Voice ID", type: "text",     required: false, placeholder: "EXAVITQu4vr4xnSDxMaL" },
]);

const OPENAI_TTS = JSON.stringify([
  { key: "apiKey", label: "OpenAI API Key",  type: "password", required: true },
  { key: "voice",  label: "Default Voice",   type: "text",     required: false, placeholder: "alloy" },
]);

const AZURE_SPEECH = JSON.stringify([
  { key: "subscriptionKey", label: "Subscription Key", type: "password", required: true },
  { key: "region",          label: "Region",           type: "text",     required: true, placeholder: "eastus" },
]);

const GOOGLE_TTS = JSON.stringify([
  { key: "apiKey", label: "API Key", type: "password", required: true },
]);

const RUNWAY_FIELDS = JSON.stringify([
  { key: "apiKey", label: "Runway API Key", type: "password", required: true },
]);

const KLING_FIELDS = JSON.stringify([
  { key: "apiKey", label: "Kling API Key", type: "password", required: true },
]);

const PIKA_FIELDS = JSON.stringify([
  { key: "apiKey", label: "Pika API Key", type: "password", required: true },
]);

const SUNO_FIELDS = JSON.stringify([
  { key: "apiKey", label: "Suno API Key", type: "password", required: true },
]);

const UDIO_FIELDS = JSON.stringify([
  { key: "apiKey", label: "Udio API Key", type: "password", required: true },
]);

// â”€â”€ Adapter type overrides â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const DB_KEYS = new Set([
  "postgresql","mysql","mssql","oracle","cockroachdb","sqlite","snowflake","bigquery",
  "mariadb","supabase","neon","planetscale","timescaledb","yugabyte","cratedb",
  "amazon-aurora","azure-sql","amazon-redshift","alloydb","tidb","singlestore",
  "vitess","trino","databricks","apache-druid","turso","rethinkdb",
]);

const adapterMap = {
  // SQL databases
  postgresql: ["database", DB], mysql: ["database", DB], mssql: ["database", DB],
  oracle: ["database", DB], cockroachdb: ["database", DB], sqlite: ["database", DB],
  snowflake: ["database", DB], bigquery: ["database", DB], mariadb: ["database", DB],
  supabase: ["database", DB], neon: ["database", DB], planetscale: ["database", DB],
  timescaledb: ["database", DB], yugabyte: ["database", DB], cratedb: ["database", DB],
  "amazon-aurora": ["database", DB], "azure-sql": ["database", DB],
  "amazon-redshift": ["database", DB], alloydb: ["database", DB],
  tidb: ["database", DB], singlestore: ["database", DB], vitess: ["database", DB],
  trino: ["database", DB], databricks: ["database", DB], "apache-druid": ["database", DB],
  turso: ["database", DB], rethinkdb: ["database", DB],
  // NoSQL
  mongodb: ["mongodb", MONGO], "azure-cosmos": ["mongodb", MONGO],
  redis: ["redis", REDIS], upstash: ["redis", REDIS],
  elasticsearch: ["elasticsearch", ES],
  // Files / native protocols
  ssh: ["ssh", SSH], "sftp-generic": ["ssh", SSH],
  // Google
  gdrive: ["gdrive", GDRIVE], gmail: ["gmail", GDRIVE],
  // Code
  github: ["github", GITHUB],
  // Mail
  "zoho-mail": ["zoho-mail", SMTP],
  // Known app adapters that have native code but work via HTTP config
  slack: ["slack", HTTP], jira: ["jira", HTTP], confluence: ["confluence", HTTP],
  notion: ["notion", HTTP], hubspot: ["hubspot", HTTP],
  freshdesk: ["freshdesk", HTTP], zendesk: ["zendesk", HTTP],
  onedrive: ["onedrive", HTTP], dropbox: ["dropbox", HTTP], box: ["box", HTTP],
  // Search
  "perplexity-search": ["perplexity-search", PERPLEXITY_SEARCH],
  "google-search":     ["google-search",     GOOGLE_SEARCH],
  "bing-search":       ["bing-search",       BING_SEARCH],
  // OCR
  "azure-vision":  ["azure-vision",  AZURE_VISION],
  "google-vision": ["google-vision", GOOGLE_VISION],
  "aws-textract":  ["aws-textract",  AWS_TEXTRACT],
  "tesseract-ocr": ["tesseract-ocr", TESSERACT_OCR],
  // Image generation
  "openai-image":     ["openai-image",     OPENAI_IMAGE],
  "flux":             ["flux",             FLUX_IMAGE],
  "stable-diffusion": ["stable-diffusion", STABILITY_IMAGE],
  "ideogram":         ["ideogram",         IDEOGRAM_IMAGE],
  // Speech
  "elevenlabs":   ["elevenlabs",   ELEVENLABS],
  "openai-tts":   ["openai-tts",   OPENAI_TTS],
  "azure-speech": ["azure-speech", AZURE_SPEECH],
  "google-tts":   ["google-tts",   GOOGLE_TTS],
  // Video generation
  "runway": ["runway", RUNWAY_FIELDS],
  "kling":  ["kling",  KLING_FIELDS],
  "pika":   ["pika",   PIKA_FIELDS],
  // Music generation
  "suno": ["suno", SUNO_FIELDS],
  "udio": ["udio", UDIO_FIELDS],
};


// â”€â”€ Seed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function main() {
  console.log(`Seeding ${ALL.length} connection masters...`);
  let live = 0, soon = 0;

  for (const entry of ALL) {
    const override = adapterMap[entry.key];
    const adapterType = override ? override[0] : "rest-api";
    const fields      = override ? override[1] : HTTP;

    if (fields) live++; else soon++;

    await db.connectionMaster.upsert({
      where:  { key: entry.key },
      update: { label: entry.label, category: entry.cat, color: entry.color, initial: entry.initial, adapterType, fields },
      create: { key: entry.key, label: entry.label, category: entry.cat, color: entry.color, initial: entry.initial, adapterType, fields },
    });
  }

  const dbTotal = await db.connectionMaster.count();
  console.log(`Done. Upserted: ${ALL.length}, DB total: ${dbTotal}`);
}

main().catch(console.error).finally(() => db.$disconnect());
