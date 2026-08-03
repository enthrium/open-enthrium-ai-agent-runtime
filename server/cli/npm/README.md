# OE Runtime · `@openenthrium/oe-runtime`

**Run AI agents against 2,600+ enterprise data sources — databases, APIs, files, SSH, messaging, and more. One binary. One YAML agent. One config file.**

[![npm](https://img.shields.io/npm/v/@openenthrium/oe-runtime?color=4f46e5)](https://www.npmjs.com/package/@openenthrium/oe-runtime)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-4f46e5.svg)](https://github.com/enthrium/open-enthrium-ai-agent-runtime/blob/main/LICENSE)
[![Website](https://img.shields.io/badge/Website-openenthrium.com-4f46e5)](https://www.openenthrium.com/runtime.html)
[![Discord](https://img.shields.io/badge/Discord-Community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/vWsZ24Msn)

---

## What is OE Runtime?

OE Runtime is a standalone binary that reads a declarative YAML agent file, connects to your enterprise data sources, and runs an AI-powered workflow — locally or as an HTTP API server. No Python, no LangChain, no code.

---

## Quick Start

**1. Create your config file** (`oe-config.json`)

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

**2. Create your agent file** (`agent.yaml`)

```yaml
name: DB Summary Agent
description: Summarises recent activity in the database
instructions: You are a data analyst. Use the available tools to answer questions about the database.
steps:
  - name: Check recent orders
    content: Query the last 10 orders and summarise the results.
connectors:
  - connection_name: my-db
    connection_type: postgresql
```

**3. Run it**

macOS / Linux:
```bash
npx -y @openenthrium/oe-runtime run agent.yaml --config oe-config.json
```

Windows:
```bash
npx -y @openenthrium/oe-runtime run agent.yaml --config oe-config.json
```

> **Note:** `-y` skips npx's install confirmation prompt — without it, npx blocks waiting for keyboard input and the agent never runs.

---

## Run Modes

| Mode | Command | Best for |
|---|---|---|
| **CLI** | `npx -y @openenthrium/oe-runtime run agent.yaml --config oe-config.json` | One-shot agent runs, scripts, CI/CD |
| **HTTP Server** | `npx -y @openenthrium/oe-runtime --serve --config oe-config.json` | Persistent API server any app can call |

---

## Supported Connectors

**2,600+ connectors across 45+ categories:**

| Category | Examples |
|---|---|
| **SQL Databases** | PostgreSQL, MySQL, MSSQL, Oracle, SQLite, Snowflake, BigQuery, Redshift |
| **NoSQL / Cache** | MongoDB, Redis, Elasticsearch, DynamoDB, Cassandra |
| **Object Storage** | AWS S3, GCS, Azure Blob, MinIO, Cloudflare R2 |
| **Cloud Drives** | Google Drive, OneDrive, Dropbox, Box |
| **Filesystem** | Local directories — list, read, write, search |
| **Email** | Gmail, Outlook, Zoho Mail, SMTP |
| **Team Messaging** | Slack, Microsoft Teams, Discord, Telegram |
| **CRM** | HubSpot, Salesforce, Notion, Airtable |
| **Issue Tracking** | GitHub, Jira, GitLab, Linear |
| **REST API** | Any HTTP/REST endpoint |
| **SSH / SFTP** | Remote command execution, file transfer |
| **Message Queues** | Kafka, AWS SQS, Google Pub/Sub, RabbitMQ |
| **+ more** | LDAP, OCR, Image Generation, Healthcare, ERP, Web3, ... |

---

## Links

- [Full Documentation](https://www.openenthrium.com/runtime.html)
- [GitHub Repository](https://github.com/enthrium/open-enthrium-ai-agent-runtime)
- [Sample Agents](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-samples.zip) — 20 ready-to-use agent YAML files
- [Discord Community](https://discord.com/invite/vWsZ24Msn)
- [OE Platform](https://www.openenthrium.com/platform.html) — full web app with Agent Builder, RAG, workspaces
- [OE MCP Server](https://www.openenthrium.com/mcp.html) — connect Claude Code, Cursor & Windsurf to enterprise data

---

## License

[Apache-2.0](https://github.com/enthrium/open-enthrium-ai-agent-runtime/blob/main/LICENSE) — free to use, modify, and deploy for any purpose including commercial use.
