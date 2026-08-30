# OE Runtime SDK · `@openenthrium/oe-runtime-sdk`

Embed AI agent execution directly in your Node.js application. Same engine as [OE Runtime CLI](https://www.openenthrium.com/runtime.html) — no subprocess, no HTTP overhead, just a function call.

[![npm](https://img.shields.io/npm/v/@openenthrium/oe-runtime-sdk?color=4f46e5)](https://www.npmjs.com/package/@openenthrium/oe-runtime-sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-4f46e5.svg)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/blob/main/LICENSE)

---

## Install

```bash
npm install @openenthrium/oe-runtime-sdk
```

Install only the connector dependencies your agents actually use:

```bash
npm install pg           # PostgreSQL
npm install mysql2       # MySQL / MariaDB
npm install mongodb      # MongoDB
npm install ioredis      # Redis
npm install ssh2         # SSH / SFTP
npm install kafkajs      # Kafka
npm install @aws-sdk/client-s3  # S3 / object storage
npm install googleapis   # Gmail, Google Drive
```

---

## Usage

### Run a SKILL.md skill (recommended)

Pass the skill folder — the SDK resolves `agent.yaml` + `SKILL.md` inside it automatically.

```js
const { runAgent } = require("@openenthrium/oe-runtime-sdk");

const result = await runAgent(
  "./skills/sql-databases",  // folder containing SKILL.md + agent.yaml
  "./oe-config.json",
  { topic: "Q3 sales" }      // optional params
);

console.log(result.output);
console.log(result.toolCalls); // connector tools called
```

### Run from an agent.yaml file path

```js
const { runAgent } = require("@openenthrium/oe-runtime-sdk");

const result = await runAgent(
  "./my-agent/agent.yaml",
  "./oe-config.json"
);

console.log(result.output);
```

### Run from inline objects (no file I/O)

```js
const { runAgentFromObject } = require("@openenthrium/oe-runtime-sdk");

const agent = {
  name: "Database Analyst",
  skills: [{ path: "./", trigger_type: "auto" }],
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
const result = await runAgent("./my-agent/agent.yaml", "./oe-config.json", {}, {
  onToolCall:   (name)         => console.log(`→ ${name}`),
  onToolResult: (name, result) => console.log(`↳ ${result}`),
  onDone:       (output)       => console.log("Done:", output),
  onError:      (err)          => console.error("Error:", err),
});
```

---

## oe-config.json

Same config used by OE Runtime CLI — no changes needed:

```json
{
  "llm": { "provider": "openai", "model": "gpt-4o", "apiKey": "sk-..." },
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

---

## Supported LLM Providers

`openai` · `anthropic` · `azure` · `groq` · `gemini` · `ollama` · `mistral` · `deepseek` · `together` · `fireworks` · `bedrock` · and more

---

## Part of Open Enthrium

| | |
|---|---|
| ⚡ **Runtime CLI** | [@openenthrium/oe-runtime](https://www.npmjs.com/package/@openenthrium/oe-runtime) — standalone binary / npx |
| 🖥️ **Platform** | [open-enthrium-ai-platform](https://github.com/enthrium/open-enthrium-ai-platform) — full web app with workspaces, RAG, Agent Builder |
| 🔌 **MCP Server** | [open-enthrium-ai-mcp-server](https://github.com/enthrium/open-enthrium-ai-mcp-server) — connect Claude Code, Cursor, Windsurf to enterprise data |
| 🌐 **Website** | [openenthrium.com](https://www.openenthrium.com) |

---

## License

[Apache-2.0](https://github.com/enthrium/open-enthrium-ai-agent-runtime/blob/main/LICENSE) — free to use, modify, and deploy for any purpose, including commercial use.
