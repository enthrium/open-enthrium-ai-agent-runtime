<div align="center">

<h1>Open Enthrium AI Agent Runtime</h1>
<h3>Standalone AI Agent Executor · Apache-2.0 · Windows · Linux · macOS</h3>

**Run SKILL.md agents and YAML workflows against any enterprise data source — no cloud, no platform, just a single binary.**

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

## What is OE Runtime?

A standalone binary that reads a declarative agent file, connects to your enterprise data sources, and runs an AI workflow — locally or as an HTTP API server. No Python. No LangChain. No Docker required.

Supports two agent formats:

- **SKILL.md** — portable Markdown-based agent skills ([agentskills.io](https://agentskills.io) spec). The same file runs on Claude, Cursor, Windsurf, or OE Runtime unchanged.
- **agent.yaml** — OE-native YAML format with inline steps, chains, and scheduling.

---

## Quick Start

```bash
npx -y @openenthrium/oe-runtime ./skills/hello-world
```

Or download a binary from the [releases page](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest) and run:

```bash
# Windows
oe-runtime-win.exe ./skills/hello-world

# Linux / macOS
./oe-runtime-linux ./skills/hello-world
```

OE Runtime automatically finds `oe-config.json` in the agent's folder or your current directory.

---

## Running SKILL.md Agents

A SKILL.md skill is a Markdown file — frontmatter carries the metadata, `## Step` headings define the workflow. Connector wiring stays in `agent.yaml` + `oe-config.json`, keeping the skill itself portable.

**Folder structure:**

```
my-skill/
├── SKILL.md          ← the portable skill (agentskills.io format)
├── agent.yaml        ← wires SKILL.md to your connectors
└── oe-config.json    ← LLM key + connector credentials
```

**agent.yaml:**

```yaml
name: SQL Database Analyst
description: Query a database and summarise results in plain English
connectors:
  - connection_name: My Database
    connection_type: postgresql
skills:
  - path: ./SKILL.md
    trigger_type: auto
```

**SKILL.md:**

```markdown
---
name: SQL Database Analyst
version: 1.0.0
description: Query a database and summarise results in plain English
author: Your Name
license: Apache-2.0
---

You are a data analyst. Use the available database tools to answer the user's question clearly.

## Step 1: Explore Schema
List the available tables and understand the data structure.

## Step 2: Query
Run the most relevant query for the user's request.

## Step 3: Report
Summarise the findings in plain English with key numbers highlighted.
```

**oe-config.json:**

```json
{
  "llm": { "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o" },
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

**Run it:**

```bash
npx -y @openenthrium/oe-runtime ./my-skill
```

Pass the folder — OE Runtime resolves `agent.yaml` inside it automatically.

---

## Skills Library

Download [oe-runtime-skills.zip](https://github.com/enthrium/open-enthrium-ai-agent-runtime/releases/latest/download/oe-runtime-skills.zip) — 27 ready-to-run skills covering:

`sql-databases` · `nosql-cache` · `email` · `team-messaging` · `cloud-drives` · `file-storage` · `web-search` · `rest-api` · `graphql` · `ssh` · `image-generation` · `speech-audio` · `video-generation` · `music-generation` · `ocr-vision` · `iot-messaging` · `message-queues` · `blockchain-web3` · `productivity-crm` · `directory-identity` · `local-exec` · `hello-world` · and more

Each skill has a `SKILL.md` + `agent.yaml` + `oe-config.json` ready to go.

---

## HTTP Server Mode

Enable server mode in `oe-config.json`:

```json
{
  "llm": { "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o" },
  "server": { "enabled": true, "port": 3333, "apiKey": "your-secret" },
  "connectors": [ ... ]
}
```

Start:

```bash
npx -y @openenthrium/oe-runtime --serve --config oe-config.json
```

**Endpoints:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `POST` | `/run` | Run an agent from inline YAML |
| `POST` | `/run-file` | Run an agent from a file path on disk |
| `POST` | `/approve-chain` | Approve or reject a pending manual chain |

```bash
# Run a SKILL.md agent via HTTP
curl -X POST http://localhost:3333/run-file \
  -H "x-api-key: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"file": "/path/to/my-skill/agent.yaml", "params": {}, "input": "run"}'
```

---

## Embed in Node.js (SDK)

```bash
npm install @openenthrium/oe-runtime-sdk
```

```js
const { runAgent } = require("@openenthrium/oe-runtime-sdk");

const result = await runAgent("./my-skill/agent.yaml", "./oe-config.json");
console.log(result.output);
```

→ [npm package](https://www.npmjs.com/package/@openenthrium/oe-runtime-sdk)

---

## Supported LLM Providers

`openai` · `anthropic` · `azure` · `groq` · `gemini` · `ollama` · `mistral` · `deepseek` · `together` · `fireworks` · `bedrock` · and more

---

## Part of Open Enthrium

| | |
|---|---|
| 🖥️ **Platform** | [open-enthrium-ai-platform](https://github.com/enthrium/open-enthrium-ai-platform) — full web app with workspaces, RAG, Agent Builder |
| 🔌 **MCP Server** | [open-enthrium-ai-mcp-server](https://github.com/enthrium/open-enthrium-ai-mcp-server) — connect Claude Code, Cursor, Windsurf to enterprise data |
| 📦 **Node.js SDK** | [@openenthrium/oe-runtime-sdk](https://www.npmjs.com/package/@openenthrium/oe-runtime-sdk) |
| 🌐 **Website** | [openenthrium.com](https://www.openenthrium.com) |

---

## Contributing

→ See **[CONTRIBUTING.md](CONTRIBUTING.md)** for how to add skills and connector adapters.

---

## License

[Apache-2.0](LICENSE) — free to use, modify, and deploy for any purpose, including commercial use.
No usage limits. No telemetry. No call-home.

---

<div align="center">

**[⭐ Star this repo](https://github.com/enthrium/open-enthrium-ai-agent-runtime)** &nbsp;·&nbsp; **[🌐 Website](https://www.openenthrium.com)** &nbsp;·&nbsp; **[🔌 MCP Server](https://github.com/enthrium/open-enthrium-ai-mcp-server)**

</div>
