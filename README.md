<div align="center">

<h1>Open Enthrium AI Agent Runtime</h1>
<h3>aka OE Runtime · Standalone AI Agent Executor · Apache-2.0 · Windows · Linux · macOS</h3>

**Run AI agents against any enterprise data source — no cloud, no platform, just a single binary.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-4f46e5.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/enthrium/open-enthrium-ai-agent-runtime?color=4f46e5&label=latest)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases)
[![Windows](https://img.shields.io/badge/Windows-Download-0078D4?logo=windows&logoColor=white)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-win.exe)
[![Linux](https://img.shields.io/badge/Linux-Download-E95420?logo=linux&logoColor=white)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-linux)
[![macOS](https://img.shields.io/badge/macOS-Download-000000?logo=apple&logoColor=white)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-macos)
[![Website](https://img.shields.io/badge/Website-openenthrium.com-4f46e5)](https://www.openenthrium.com)
[![Discord](https://img.shields.io/badge/Discord-Community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/vWsZ24Msn)

</div>

---

## What is OE Agent Runtime?

OE Agent Runtime is a standalone, cross-platform binary that reads a declarative YAML agent file, connects to your enterprise data sources, and runs an AI-powered workflow — locally or as an HTTP API server.

- **No LangChain. No Python. No code.** Agents are plain YAML files.
- **No install.** Single binary for Windows, Linux, and macOS. No Node.js, no Docker on the target machine.
- **45+ connector categories.** PostgreSQL, MySQL, MongoDB, S3, Slack, GitHub, SSH, REST API, Kafka, and 2,600+ more — all built in.
- **HTTP server mode.** `--serve` turns the runtime into a persistent API server any app can call.
- **Self-hosted.** Runs entirely on your own machine. No call-home. Own your data.

---

## Download

| Platform | Binary |
|---|---|
| **Windows** | [oe-runtime-win.exe](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-win.exe) |
| **Linux** | [oe-runtime-linux](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-linux) |
| **macOS** | [oe-runtime-macos](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-macos) |
| **Sample library** | [oe-runtime-samples.zip](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-samples.zip) — 20 ready-to-run starter kits |
| **Postman collection** | [oe-runtime.postman_collection.json](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime.postman_collection.json) |

> Binaries are built automatically via GitHub Actions on every version tag across all three platforms simultaneously.

---

## Quick Start

**1. Download the binary and a starter kit**

```bash
# Linux / macOS — make executable
chmod +x oe-runtime-linux

# Download a sample kit (includes agent.yaml + oe-config.json)
# https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-samples.zip
```

**2. Edit `oe-config.json`** with your LLM key and connector credentials

```json
{
  "llm": {
    "provider": "openai",
    "apiKey": "sk-...",
    "model": "gpt-4o"
  },
  "connectors": [
    {
      "connection_name": "my-db",
      "connection_type": "postgresql",
      "host": "localhost",
      "port": 5432,
      "database": "mydb",
      "user": "postgres",
      "password": "secret"
    }
  ]
}
```

**3. Run your agent**

```bash
# Windows
oe-runtime-win.exe agent.yaml --config oe-config.json

# Linux / macOS
./oe-runtime-linux agent.yaml --config oe-config.json

# With runtime parameters
./oe-runtime-linux report.yaml --config oe-config.json \
  --param company="Tesla" \
  --param recipient="ceo@company.com"
```

---

## Writing Agents

Agents are plain YAML files. No Python. No framework to learn.

```yaml
name: DB Summary Agent
description: Queries a database and emails a summary report
instructions: |
  You are a data analyst. Query the database for key metrics,
  summarise the findings clearly, and email the report to the recipient.
steps:
  - name: Query metrics
    content: |
      Run: SELECT table_name, table_rows
           FROM information_schema.tables
           WHERE table_schema = DATABASE()
           ORDER BY table_rows DESC;
      Summarise the top 10 tables by row count.
  - name: Send report
    content: |
      Email a clean report to {{recipient}}.
      Subject: Database Summary — TODAY'S DATE
connectors:
  - connection_name: my-db
    connection_type: mysql
  - connection_name: Company Email
    connection_type: smtp
params:
  - name: recipient
    default: team@yourcompany.com
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

---

## HTTP Server Mode

Turn the runtime into a persistent HTTP API — call agents from mobile apps, web services, or any HTTP client.

```bash
# Start in serve mode
oe-runtime-win.exe --serve --config oe-config.json
# 🚀  OE Runtime Server  v1.4.1
# Listening  http://localhost:3333
```

Or set it in `oe-config.json`:

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

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check — returns `{ status, version }` |
| `POST` | `/run` | Run an agent from an inline YAML string |
| `POST` | `/run-file` | Run an agent from a YAML file path on the server |

```bash
curl -X POST http://localhost:3333/run \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-api-key" \
  -d '{
    "yaml": "name: Hello\nsteps:\n  - name: ping\n    content: say hello",
    "params": {}
  }'
```

```json
{ "success": true, "output": "Hello! How can I help you today?", "duration_ms": 1823 }
```

---

## Connector Catalog

**2,600+ connectors across 45+ categories** — built in, no custom code required.

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

> **Binary vs Node.js mode**
>
> The standalone binary works for all connector categories **except** Oracle, MSSQL, SQLite, and Snowflake — these use native C++ addons that cannot be bundled into a single executable.
>
> If you need any of these four, run with Node.js instead:
> ```bash
> git clone https://github.com/enthrium/open-enthrium-ai-agent-runtime.git
> cd open-enthrium-ai-agent-runtime/server
> yarn install
> node cli/index.js agent.yaml --config oe-config.json
> # or serve mode
> node cli/index.js --serve --config oe-config.json
> ```
> All other connectors (PostgreSQL, MySQL, MongoDB, Redis, S3, Slack, GitHub, REST API, SSH, etc.) work directly with the binary — no Node.js required.

---

## Sample Library

Download [oe-runtime-samples.zip](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-samples.zip) for 20 ready-to-run starter kits — each with a complete `agent.yaml` + `oe-config.json`:

`sql-databases` · `nosql-cache` · `file-storage` · `cloud-drives` · `email` · `team-messaging` · `productivity-crm` · `rest-api` · `graphql` · `ssh` · `message-queues` · `iot-messaging` · `web-search` · `ocr-vision` · `image-generation` · `speech-audio` · `video-generation` · `music-generation` · `blockchain-web3` · `directory-identity`

---

## Supported LLM Providers

`openai` · `anthropic` · `azure` · `groq` · `gemini` · `ollama` · `mistral` · `deepseek` · `together` · `fireworks` · `bedrock` · and more

---

## Part of Open Enthrium

OE Agent Runtime is the open-source standalone execution layer of the [Open Enthrium](https://openenthrium.com) platform.

| | |
|---|---|
| 🖥️ **Platform (Docker)** | [open-enthrium-community](https://github.com/enthrium/open-enthrium-ai-platform) — full web app with workspaces, RAG, Agent Builder, DLP |
| 🔌 **MCP Server** | [open-enthrium-ai-mcp-server](https://github.com/enthrium/open-enthrium-ai-mcp-server) — connect Claude Code, Cursor, Windsurf to enterprise data |
| 🌐 **Website** | [openenthrium.com](https://openenthrium.com) |

---

## License

[Apache-2.0](LICENSE) — free to use, modify, and deploy for any purpose, including commercial use.
No usage limits. No telemetry. No call-home.

---

<div align="center">

**[⭐ Star this repo](https://github.com/enthrium/open-enthrium-ai-agent-runtime)** &nbsp;·&nbsp; **[🌐 Website](https://www.openenthrium.com)** &nbsp;·&nbsp; **[🔌 MCP Server](https://github.com/enthrium/open-enthrium-ai-mcp-server)**

</div>
