<div align="center">

<h1>Open Enthrium AI Agent Runtime</h1>
<h3>OE Runtime · Standalone AI Agent Executor · Apache-2.0 · Windows · Linux · macOS</h3>

**Run AI agents against any enterprise data source — no cloud, no platform, just a single binary.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-4f46e5.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/enthrium/open-enthrium-ai-agent-runtime?color=4f46e5&label=latest)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases)
[![Windows](https://img.shields.io/badge/Windows-Download-0078D4?logo=windows&logoColor=white)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-win.exe)
[![Linux](https://img.shields.io/badge/Linux-Download-E95420?logo=linux&logoColor=white)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-linux)
[![macOS](https://img.shields.io/badge/macOS-Download-000000?logo=apple&logoColor=white)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-macos)
[![npm](https://img.shields.io/npm/v/@openenthrium/oe-runtime?color=4f46e5&label=npm)](https://www.npmjs.com/package/@openenthrium/oe-runtime)
[![Website](https://img.shields.io/badge/Website-openenthrium.com-4f46e5)](https://www.openenthrium.com)
[![Discord](https://img.shields.io/badge/Discord-Community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/vWsZ24Msn)

</div>

---

## What is Open Enthrium AI Agent Runtime?

Open Enthrium AI Agent Runtime (OE Runtime) is a standalone, cross-platform binary that reads a declarative YAML agent file, connects to your enterprise data sources, and runs an AI-powered workflow — locally or as an HTTP API server.

- **No LangChain. No Python. No code.** Agents are plain YAML files.
- **No install.** Single binary for Windows, Linux, and macOS. No Node.js, no Docker on the target machine.
- **45+ connector categories.** PostgreSQL, MySQL, MongoDB, S3, Slack, GitHub, SSH, REST API, Kafka, and more — all built in.
- **Agent chains.** Chain agents together in YAML — auto chains fire in sequence; manual chains pause for human approval in CLI (y/n prompt), HTTP (`/approve-chain`), or any MCP-enabled AI chat (`approve_chain` tool).
- **HTTP server mode.** `--serve` turns the runtime into a persistent API server any app can call.
- **Messaging platform integration.** Receive messages from Telegram, Slack, WhatsApp, Teams and run agents in response — same YAML agents, same connectors, universal command language (`/run`, `/agents`, `/approve`, `/status`).
- **Project system.** `oe-project.json` registers multiple agents by name, sets a default agent, and links projects together — one config, many agents.
- **Self-hosted.** Runs entirely on your own machine. No call-home. Own your data.

---

## Sample Library

Download [oe-runtime-samples.zip](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-samples.zip) for 24 ready-to-run starter kits — each with a complete `agent.yaml` + `oe-config.json`:

**Getting started** — `hello-world` · `chains` · `my-ai-project`

**By connector** — `sql-databases` · `nosql-cache` · `file-storage` · `cloud-drives` · `email` · `team-messaging` · `telegram` · `productivity-crm` · `rest-api` · `graphql` · `ssh` · `message-queues` · `iot-messaging` · `web-search` · `ocr-vision` · `image-generation` · `speech-audio` · `video-generation` · `music-generation` · `blockchain-web3` · `directory-identity`

---

## Quick Start via npm (Recommended)

No binary download needed — `npx` handles everything automatically.

**1. Edit `oe-config.json`** with your LLM key and connector credentials

```json
{
  "llm": {
    "provider": "openai",
    "apiKey": "sk-...",
    "model": "gpt-4o"
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
    },
    {
      "connection_name": "My Telegram Bot",
      "connection_type": "telegram",
      "baseUrl": "https://api.telegram.org/botYOUR_BOT_TOKEN"
    }
  ],
  "server": {
    "enabled": false,
    "port": 3333,
    "apiKey": "your-secret"
  }
}
```

**2. Edit `agent.yaml`** if needed — adjust the instructions or steps for your use case

Agents are plain YAML files. No Python. No framework to learn.

```yaml
name: DB Summary Agent
description: Queries a database and sends a summary to Telegram
instructions: |
  You are a data analyst. Query the database for key metrics,
  summarise the findings clearly, and send the report to Telegram.
  Complete all steps fully before writing your report.
steps:
  - name: Query metrics
    content: |
      Run exactly this query against My Database, no other queries:
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public';
      Summarise the results.
  - name: Get chat ID
    content: |
      Call My Telegram Bot:
      GET /getUpdates with params: { "limit": "1" }
      Extract the chat_id from the most recent message.
  - name: Send report
    content: |
      Send the summary via My Telegram Bot:
      POST /sendMessage with body:
      {
        "chat_id": "<chat_id from previous step>",
        "text": "<your summary>",
        "parse_mode": "Markdown"
      }
connectors:
  - connection_name: My Database
    connection_type: postgresql
  - connection_name: My Telegram Bot
    connection_type: telegram
```

### YAML Agent Reference

| Field | Required | Description |
|---|---|---|
| `name` | No | Display name shown in terminal |
| `description` | No | Short description |
| `instructions` | Yes | System prompt — what the agent does and how |
| `params` | No | Named parameters; substituted via `{{name}}` in prompt and steps |
| `connectors` | No | Connector references matched to credentials in `oe-config.json` |
| `steps` | No | Named workflow steps injected sequentially into the system prompt |
| `maxRounds` | No | Max LLM tool-call iterations (default: 25) |
| `chains` | No | Agents to run after this one completes — see Agent Chains below |

**`chains` syntax:**
```yaml
chains:
  - next_agent: ./followup.yaml     # relative path from this agent file
    trigger_type: auto              # fires immediately, output passed as context

  - next_agent: ./notify.yaml
    trigger_type: manual            # CLI: y/n prompt · HTTP: /approve-chain · MCP: approve_chain tool
```

**3. Run it**

```bash
npx -y @openenthrium/oe-runtime agent.yaml --config oe-config.json
```

> **Note:** `-y` skips npx's install confirmation prompt — without it, npx blocks waiting for keyboard input and the agent never runs.

---

## Download & Run

**1. Download the binary and a sample kit**

| Platform | Binary |
|---|---|
| Windows | [oe-runtime-win.exe](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-win.exe) |
| Linux | [oe-runtime-linux](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-linux) |
| macOS | [oe-runtime-macos](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-macos) |
| Sample kit | [oe-runtime-samples.zip](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-samples.zip) — includes agent.yaml + oe-config.json |
| Postman collection | [oe-runtime.postman_collection.json](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime.postman_collection.json) |

```bash
# Linux — make executable
chmod +x oe-runtime-linux

# macOS — make executable
chmod +x oe-runtime-macos
```

**2. Edit `oe-config.json`** with your LLM key and connector credentials

**3. Run your agent**

```bash
# Windows
oe-runtime-win.exe agent.yaml --config oe-config.json

# Linux
./oe-runtime-linux agent.yaml --config oe-config.json

# macOS
./oe-runtime-macos agent.yaml --config oe-config.json

# With runtime parameters
./oe-runtime-linux report.yaml --config oe-config.json \
  --param company="Tesla" \
  --param recipient="ceo@company.com"
```

---

## HTTP Server Mode

Turn the runtime into a persistent HTTP API — call agents from mobile apps, web services, or any HTTP client.

**Step 1 — Enable server mode in `oe-config.json`:**

```json
{
  "llm": { "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o" },
  "server": {
    "enabled": true,
    "port": 3333,
    "apiKey": "your-secret-api-key"
  },
  "connectors": [ ... ]
}
```

> Set **`"enabled": true`** to activate server mode on startup.

**Step 2 — Start in serve mode:**

```bash
# Windows
oe-runtime-win.exe --serve --config oe-config.json

# Linux
./oe-runtime-linux --serve --config oe-config.json

# macOS
./oe-runtime-macos --serve --config oe-config.json

# 🚀  OE Runtime Server  v1.7.0
#      Run AI agents via HTTP
# Listening  http://localhost:3333
```

### Endpoints

All endpoints require the `x-api-key` header when `server.apiKey` is set in your config.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check — returns `{ "status": "ok", "version": "..." }` |
| `GET` | `/status` | Health + project info + connector list + uptime |
| `POST` | `/command` | Universal command endpoint — `{ "text": "/run agent-name" }` |
| `POST` | `/run` | Run an agent from an inline YAML string |
| `POST` | `/run-file` | Run an agent from a YAML file path on disk |
| `POST` | `/approve-chain` | Approve or reject a pending manual chain |
| `POST` | `/webhook/telegram` | Telegram webhook receiver (enabled via `server.webhook`) |
| `POST` | `/webhook/slack` | Slack webhook receiver (enabled via `server.webhook`) |

**POST /run** — body (inline YAML):
```json
{
  "yaml": "name: My Agent\nsteps:\n  - name: Run\n    content: Execute the task",
  "params": {},
  "input": "run"
}
```

**POST /run-file** — body (file path on server disk):
```json
{
  "file": "/path/to/agent.yaml",
  "params": { "topic": "AI trends" },
  "input": "run"
}
```

**Response** (both /run and /run-file):
```json
{
  "success": true,
  "output": "Agent output...",
  "chains": [
    { "agent": "Follow-up Agent", "output": "Chain complete ✅", "chains": [], "pending_chains": [] }
  ],
  "pending_chains": [
    { "chain_id": "abc123xyz", "next_agent": "./notify.yaml", "output_preview": "Agent output..." }
  ],
  "duration_ms": 1234
}
```

**POST /approve-chain** — approve or reject a manual chain:
```json
{ "chain_id": "abc123xyz", "approved": true }
```

Response:
```json
{ "success": true, "approved": true, "output": "...", "chains": [], "pending_chains": [], "duration_ms": 890 }
```

**Example curl:**
```bash
# Health check
curl http://localhost:3333/health -H "x-api-key: your-secret"

# Run agent from inline YAML
curl -X POST http://localhost:3333/run \
  -H "x-api-key: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"yaml": "name: Hi\nsteps:\n  - name: Greet\n    content: Say hi!", "params": {}, "input": "run"}'

# Run agent from file on disk (with chain support)
curl -X POST http://localhost:3333/run-file \
  -H "x-api-key: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"file": "/path/to/agent.yaml", "params": {}, "input": "run"}'

# Approve a pending manual chain
curl -X POST http://localhost:3333/approve-chain \
  -H "x-api-key: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"chain_id":"abc123xyz","approved":true}'
```

---

## Project System

`oe-project.json` sits alongside `oe-config.json` and registers multiple agents by name — so any interface (Telegram, Slack, HTTP, MCP) can invoke them by name rather than file path.

```json
{
  "name": "Sales Pipeline",
  "version": "1.0.0",
  "description": "Outbound sales automation",
  "author": "Your Name",
  "tags": ["sales", "outbound"],
  "agents": [
    { "name": "prospecting",  "file": "./prospecting.yaml",  "description": "Find and qualify leads" },
    { "name": "outreach",     "file": "./outreach.yaml",     "description": "Send personalised emails" },
    { "name": "chat",         "file": "./chat-bot.yaml",     "description": "Conversational assistant", "default": true }
  ],
  "links": [
    { "name": "support", "project": "../support-project/oe-project.json" }
  ]
}
```

| Field | Description |
|---|---|
| `name`, `version`, `author`, `tags` | Project metadata |
| `agents[].name` | Short name used to invoke the agent (`/run prospecting`) |
| `agents[].file` | Path to the YAML agent file (relative to `oe-project.json`) |
| `agents[].default` | `true` — runs this agent when user sends a plain message (no command) |
| `links` | Cross-project references — run agents from linked projects |

See the [`my-ai-project`](samples/my-ai-project/) sample for a full working example.

---

## Messaging Platforms (Telegram, Slack, WhatsApp, Teams)

OE Runtime's HTTP server can receive messages from any webhook-based messaging platform and run agents in response — no separate bot framework needed.

**`oe-config.json` — enable webhook receiver:**

```json
{
  "llm": { "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o" },
  "server": {
    "enabled": true,
    "port": 3333,
    "publicUrl": "https://your-public-domain.com",
    "webhook": true
  },
  "connectors": [
    {
      "connection_name": "My Telegram Bot",
      "connection_type": "telegram",
      "baseUrl": "https://api.telegram.org/botYOUR_BOT_TOKEN",
      "auto_reply": true,
      "rate_limit": { "messages_per_minute": 20 },
      "history": { "enabled": true, "max_messages": 10 }
    },
    {
      "connection_name": "My Slack Bot",
      "connection_type": "slack",
      "botToken": "xoxb-YOUR-BOT-TOKEN",
      "auto_reply": true,
      "rate_limit": { "messages_per_minute": 10 },
      "history": { "enabled": true, "max_messages": 10 }
    }
  ]
}
```

OE Runtime automatically calls Telegram's `setWebhook` on startup. For Slack, paste the URL shown in the terminal into your Slack app's Event Subscriptions.

**Universal command language** — same commands work from Telegram, Slack, HTTP, or MCP:

| Command | Action |
|---|---|
| `/run <name>` | Run agent by name (from `oe-project.json`) |
| `/run <path>` | Run agent by file path |
| `/agents` | List all registered agents |
| `/approve` | Approve a pending manual chain |
| `/cancel` | Cancel a pending chain |
| `/status` | Health check — LLM, connectors, uptime |
| `/help` | Show all commands |
| Any message | Runs the `"default": true` agent |

**Supported platforms:**

| Platform | Webhook endpoint | Auto-registers |
|---|---|---|
| Telegram | `POST /webhook/telegram` | ✅ Yes — calls `setWebhook` on startup |
| Slack | `POST /webhook/slack` | No — paste URL in Slack Event Subscriptions |
| WhatsApp (Meta) | `POST /webhook/whatsapp` | No — paste URL in Meta Developer dashboard |
| GitHub | `POST /webhook/github` | No — paste URL in repo webhook settings |

See the [`telegram`](samples/telegram/) sample for a full working example.

---

## Binary vs Node.js Mode

Both the **standalone binary** and **`npx @openenthrium/oe-runtime`** exclude Oracle, MSSQL, SQLite, and Snowflake — these use native C++ addons that cannot be bundled into a single executable. npx downloads the same binary under the hood, so it has the same limitation.

If you need any of these four, run with Node.js directly instead:
```bash
git clone https://github.com/enthrium/open-enthrium-ai-agent-runtime.git
cd open-enthrium-ai-agent-runtime/server
yarn install
node cli/index.js agent.yaml --config oe-config.json
# or serve mode
node cli/index.js --serve --config oe-config.json
```

All other connectors (PostgreSQL, MySQL, MongoDB, Redis, S3, Slack, GitHub, REST API, SSH, etc.) work directly with the binary or npx — no Node.js clone required.

---

## Connector Catalog

**Connectors across multiple categories** — built in, no custom code required.

| Category | Examples |
|---|---|
| **SQL Databases** | PostgreSQL, MySQL, MSSQL, Oracle, SQLite, Snowflake, BigQuery, Redshift |
| **NoSQL / Cache** | MongoDB, Redis, Elasticsearch, DynamoDB, Cassandra, Couchbase |
| **Object Storage** | AWS S3, GCS, Azure Blob, MinIO, Cloudflare R2, Backblaze B2 |
| **Cloud Drives** | Google Drive, OneDrive, SharePoint, Dropbox, Box |
| **Filesystem** | Local directories — list, read, write, search files |
| **Email** | Gmail, Outlook, Zoho Mail, SMTP, IMAP, SendGrid |
| **Team Messaging** | Slack, Microsoft Teams, Discord, Telegram |
| **CRM / Productivity** | HubSpot, Salesforce, Notion, Airtable, Confluence |
| **Issue Tracking** | GitHub, Jira, GitLab, Linear |
| **REST API** | Any HTTP/REST endpoint — bearer, API key, basic auth |
| **GraphQL** | Any GraphQL endpoint |
| **SSH / SFTP** | Remote command execution and file transfer |
| **Message Queues** | Kafka, AWS SQS, Azure Service Bus, Google Pub/Sub, RabbitMQ |
| **IoT / MQTT** | MQTT brokers, AWS IoT |
| **Search** | Perplexity, Google Custom Search, Bing |
| **LDAP / Directory** | Active Directory, OpenLDAP, Azure AD |
| **OCR / Vision** | Azure Vision, Google Vision, AWS Textract |
| **Image Generation** | OpenAI gpt-image-1, FLUX, Stable Diffusion, Ideogram |
| **Speech & Audio** | ElevenLabs, OpenAI TTS, Azure Speech, Google TTS |
| **Video Generation** | Runway, Kling, Pika |
| **Music Generation** | kie.ai, Udio |
| **Web3 / Blockchain** | Ethereum, Polygon, Solana via web3.js / ethers.js |
| **Helpdesk** | Zendesk, Freshdesk, Intercom |
| **ERP** | SAP, Oracle ERP, Microsoft Dynamics |
| **+ more** | Healthcare (FHIR), Marketing, Analytics, Finance, HR, E-commerce, ... |

---


## Supported LLM Providers

`openai` · `anthropic` · `azure` · `groq` · `gemini` · `ollama` · `mistral` · `deepseek` · `together` · `fireworks` · `bedrock` · and more

---

## Part of Open Enthrium

OE Agent Runtime is the open-source standalone execution layer of the [Open Enthrium](https://openenthrium.com) platform.

| | |
|---|---|
| 🖥️ **Platform** | [open-enthrium-ai-platform](https://github.com/enthrium/open-enthrium-ai-platform) — full web app with workspaces, RAG, Agent Builder, DLP |
| 🔌 **MCP Server** | [open-enthrium-ai-mcp-server](https://github.com/enthrium/open-enthrium-ai-mcp-server) — connect Claude Code, Cursor, Windsurf to enterprise data |
| 🌐 **Website** | [openenthrium.com](https://openenthrium.com) |

---

## Contributing

→ See **[CONTRIBUTING.md](CONTRIBUTING.md)** for how to add sample agents and connector adapters.

---

## License

[Apache-2.0](LICENSE) — free to use, modify, and deploy for any purpose, including commercial use.
No usage limits. No telemetry. No call-home.

---

<div align="center">

**[⭐ Star this repo](https://github.com/enthrium/open-enthrium-ai-agent-runtime)** &nbsp;·&nbsp; **[🌐 Website](https://www.openenthrium.com)** &nbsp;·&nbsp; **[🔌 MCP Server](https://github.com/enthrium/open-enthrium-ai-mcp-server)**

</div>
