# OE Runtime SDK

Embed AI agent execution directly in your Node.js application. Same engine as [OE Runtime CLI](https://www.openenthrium.com/runtime.html) — no subprocess, no HTTP overhead, just a function call.

## Install

```bash
npm install @openenthrium/oe-runtime-sdk
```

Install only the connector dependencies your agents actually use:

```bash
# PostgreSQL / MySQL / SQLite
npm install pg          # PostgreSQL
npm install mysql2      # MySQL / MariaDB
npm install better-sqlite3  # SQLite

# MongoDB
npm install mongodb

# Redis
npm install ioredis

# Kafka / RabbitMQ
npm install kafkajs

# S3 / object storage
npm install @aws-sdk/client-s3

# SSH
npm install ssh2

# Gmail / Google Drive
npm install googleapis
```

## Usage

### From file paths

```js
const { runAgent } = require("@openenthrium/oe-runtime-sdk");

const result = await runAgent(
  "./agent.yaml",       // path to your agent
  "./oe-config.json",   // path to your config
  { topic: "Q3 sales" } // optional params
);

console.log(result.output);
console.log(result.toolCalls); // list of connector tools called
```

### From objects (no file I/O)

```js
const { runAgentFromObject } = require("@openenthrium/oe-runtime-sdk");

const agent = {
  name: "Database Analyst",
  instructions: "You are a SQL analyst.",
  steps: [{ name: "Query", content: "List all tables and their row counts." }],
  connectors: [{ connection_name: "My Database", connection_type: "postgresql" }],
};

const config = {
  llm: { provider: "openai", model: "gpt-4o", apiKey: "sk-..." },
  connectors: [{
    connection_name: "My Database",
    connection_type: "postgresql",
    host: "localhost", port: 5432,
    database: "mydb", user: "postgres", password: "secret"
  }]
};

const result = await runAgentFromObject(agent, config, {});
console.log(result.output);
```

### With hooks (streaming tool calls)

```js
const { runAgent } = require("@openenthrium/oe-runtime-sdk");

const result = await runAgent("./agent.yaml", "./oe-config.json", {}, {
  onToolCall:   (name)         => console.log(`→ ${name}`),
  onToolResult: (name, result) => console.log(`↳ ${result}`),
  onDone:       (output)       => console.log("Done:", output),
  onError:      (err)          => console.error("Error:", err),
});
```

## Config file format

Same `oe-config.json` used by OE Runtime CLI — no changes needed:

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o",
    "apiKey": "YOUR_OPENAI_API_KEY"
  },
  "server": {
    "enabled": false,
    "port": 3333,
    "apiKey": "your-secret-api-key"
  },
  "connectors": [
    {
      "connection_name": "My Database",
      "connection_type": "postgresql",
      "host": "localhost",
      "port": 5432,
      "database": "mydb",
      "user": "postgres",
      "password": "YOUR_DB_PASSWORD"
    }
  ]
}
```

## Supported LLM providers

OpenAI, Anthropic, Azure OpenAI, Groq, Mistral, Ollama, Google Gemini, AWS Bedrock, and any OpenAI-compatible endpoint.

## Supported connectors

30+ connector types — PostgreSQL, MySQL, MongoDB, Redis, Elasticsearch, S3, GitHub, Slack, Gmail, Jira, Confluence, Notion, HubSpot, Kafka, MQTT, LDAP, GraphQL, Web3/Blockchain, SSH, shell, SFTP, and more.

See [OE Runtime Connector Catalog](https://www.openenthrium.com/runtime.html) for the full list.

## Links

- [OE Runtime CLI](https://www.openenthrium.com/runtime.html)
- [Skills library](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-skills.zip)
- [GitHub](https://github.com/enthrium/open-enthrium-ai-agent-runtime)
- [Open Enthrium](https://www.openenthrium.com)
