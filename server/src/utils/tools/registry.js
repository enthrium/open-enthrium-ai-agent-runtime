const path = require("path");
const fs   = require("fs");

// Auto-discover adapters: community contributors only need to drop a .js file
// into adapters/ — no registry edit required. Filename (sans .js) = type key.
const _discovered = {};
for (const file of fs.readdirSync(path.join(__dirname, "adapters"))) {
  if (!file.endsWith(".js") || file.startsWith("_")) continue;
  const key = file.slice(0, -3);
  try {
    _discovered[key] = require(`./adapters/${key}`);
  } catch (err) {
    console.warn(`[registry] Failed to load adapter "${file}": ${err.message}`);
  }
}

const database       = _discovered["database"];
const restApi        = require("./adapters/rest-api");
const mongodb        = require("./adapters/mongodb");
const gmail          = require("./adapters/gmail");
const slack          = require("./adapters/slack");
const jira           = require("./adapters/jira");
const confluence     = require("./adapters/confluence");
const notion         = require("./adapters/notion");
const hubspot        = require("./adapters/hubspot");
const freshdesk      = require("./adapters/freshdesk");
const zendesk        = require("./adapters/zendesk");
const github         = require("./adapters/github");
const zohoMail       = require("./adapters/zoho-mail");
const gdrive         = require("./adapters/gdrive");
const redis          = require("./adapters/redis");
const elasticsearch  = require("./adapters/elasticsearch");
const onedrive       = require("./adapters/onedrive");
const dropbox        = require("./adapters/dropbox");
const box            = require("./adapters/box");
const ssh            = require("./adapters/ssh");
const sftp           = require("./adapters/sftp");
const s3             = require("./adapters/s3");
const kafka          = require("./adapters/kafka");
const mqttAdapter    = require("./adapters/mqtt");
const ldap           = require("./adapters/ldap");
const graphql        = require("./adapters/graphql");
const web3           = require("./adapters/web3");
const mcpClient      = require("./adapters/mcp-client");
const filesystem     = require("./adapters/filesystem");

const ADAPTERS = {
  // SQL databases
  postgresql:    database,
  mysql:         database,
  mssql:         database,
  oracle:        database,
  cockroachdb:   database,
  sqlite:        database,
  snowflake:     database,
  bigquery:      database,
  mariadb:       database,
  tidb:          database,
  timescaledb:   database,
  singlestore:   database,
  db2:           database,
  teradata:      database,
  duckdb:        database,
  // MySQL-compatible
  planetscale:   database,
  "vitess":      database,
  // PostgreSQL-compatible
  neon:          database,
  supabase:      database,
  "cratedb":     database,
  "questdb":     database,
  "yugabyte":    database,
  "greenplum":   database,
  "redshift":    database,
  "alloydb":     database,
  // NoSQL / in-memory
  mongodb:       mongodb,
  redis:         redis,
  elasticsearch: elasticsearch,
  // File & object storage
  "aws-s3":      s3,
  "gcs":         s3,
  "azure-blob":  s3,
  "minio":       s3,
  "cloudflare-r2": s3,
  "wasabi":      s3,
  "backblaze-b2": s3,
  // SFTP
  sftp:          sftp,
  ftp:           sftp,
  // Messaging / queues
  kafka:         kafka,
  "apache-kafka": kafka,
  rabbitmq:      kafka,
  activemq:      kafka,
  "aws-sqs":     kafka,
  "azure-service-bus": kafka,
  "google-pubsub": kafka,
  // MQTT / IoT
  mqtt:          mqttAdapter,
  "aws-iot":     mqttAdapter,
  "hivemq":      mqttAdapter,
  "mosquitto":   mqttAdapter,
  // LDAP / Directory
  ldap:          ldap,
  "active-directory": ldap,
  "azure-ad":    ldap,
  openldap:      ldap,
  // GraphQL
  graphql:       graphql,
  "hasura":      graphql,
  "graphcms":    graphql,
  "fauna":       graphql,
  // Web3 / Blockchain
  web3:          web3,
  ethereum:      web3,
  polygon:       web3,
  solana:        web3,
  "binance-smart-chain": web3,
  avalanche:     web3,
  arbitrum:      web3,
  optimism:      web3,
  "infura":      web3,
  "alchemy":     web3,
  moralis:       web3,
  // Local filesystem
  filesystem:    filesystem,
  "local-file":  filesystem,
  "local-fs":    filesystem,
  // MCP protocol
  mcp:           mcpClient,
  "mcp-server":  mcpClient,
  // OAuth cloud storage
  onedrive:        onedrive,
  dropbox:         dropbox,
  box:             box,
  gdrive:          gdrive,
  "google-drive":  restApi,
  sharepoint:      onedrive,
  // Messaging bots — baseUrl includes token, endpoints in agent.yaml
  "telegram":    restApi,
  // REST / HTTP (explicit + fallback)
  "rest-api":    restApi,
  "http":        restApi,
  // Specific SaaS adapters
  gmail:         gmail,
  "gmail-rest":  restApi,
  slack:         slack,
  jira:          jira,
  confluence:    confluence,
  notion:        notion,
  hubspot:       hubspot,
  freshdesk:     freshdesk,
  zendesk:       zendesk,
  github:        github,
  "zoho-mail":   zohoMail,
  ssh:           ssh,
  // Search — baseUrl + bearerToken in oe-config.json, endpoints in agent.yaml
  "perplexity-search": restApi,
  "perplexity":        restApi,
  "google-search":     restApi,
  "bing-search":       restApi,
  // OCR — baseUrl + apiKey/headerName in oe-config.json, endpoints in agent.yaml
  "azure-vision":   restApi,
  "google-vision":  restApi,
  "aws-textract":   restApi,
  "tesseract-ocr":  restApi,
  // Image generation — baseUrl + bearerToken in oe-config.json, endpoints in agent.yaml
  "openai-image":     restApi,
  "flux":             restApi,
  "stable-diffusion": restApi,
  "ideogram":         restApi,
  // Speech & audio — baseUrl + apiKey/headerName in oe-config.json, endpoints in agent.yaml
  "elevenlabs":   restApi,
  "openai-tts":   restApi,
  "azure-speech": restApi,
  "google-tts":   restApi,
  // Video generation — baseUrl + bearerToken in oe-config.json, endpoints in agent.yaml
  "runway": restApi,
  "kling":  restApi,
  "pika":   restApi,
  // Music generation — baseUrl + bearerToken in oe-config.json, endpoints in agent.yaml
  "suno": restApi,
  "udio": restApi,
};

// Resolve a connector type → adapter.
// Priority: explicit ADAPTERS map → auto-discovered by filename → rest-api fallback.
function resolve(type) {
  return ADAPTERS[type] || _discovered[type] || restApi;
}

function getToolDefinitions(connectors) {
  const tools = [];
  for (const c of connectors) tools.push(...resolve(c.type).getToolDefinitions(c));
  return tools;
}

function getAnthropicToolDefinitions(connectors) {
  const tools = [];
  for (const c of connectors) tools.push(...resolve(c.type).getAnthropicToolDefinitions(c));
  return tools;
}

async function executeTool(toolName, args, connectors, db) {
  const match = toolName.match(/^conn_(\d+)_(.+)$/);
  if (!match) return `Unknown tool: ${toolName}`;

  const connectorId = parseInt(match[1]);
  const action      = match[2];
  const connector   = connectors.find(c => c.id === connectorId);
  if (!connector) return "Connector not found.";

  return resolve(connector.type).executeTool(action, args, connector, db);
}

// Set of connector type keys that have a native adapter file (used by the API to mark implemented)
const implementedTypes = new Set(Object.keys(_discovered));

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, ADAPTERS, implementedTypes };
