# Contributing to Open Enthrium AI Agent Runtime

Thank you for your interest in contributing. This document covers the repo structure, what belongs here vs the platform repo, and how to submit a contribution.

## Before You Start

Open an issue first before writing code. This lets us align on whether the change fits the project direction before you invest time building it. PRs that arrive without a prior discussion may be closed even if the code is good.

---

## What Belongs Here vs the Platform Repo

This repo contains the **standalone runtime binary** — the CLI entry point, HTTP server mode, and sample agents.

| Contribution | Where it goes |
|---|---|
| New connector adapter (e.g. Salesforce, SAP) | [open-enthrium-ai-platform](https://github.com/enthrium/open-enthrium-ai-platform) → `server/src/utils/tools/adapters/` |
| New sample agent (`agent.yaml` + `oe-config.json`) | **This repo** → `server/cli/samples/<name>/` |
| Bug in CLI entry point or HTTP server mode | **This repo** → `server/cli/` |
| Bug in agent execution engine | [open-enthrium-ai-platform](https://github.com/enthrium/open-enthrium-ai-platform) → `server/src/engine/` |
| MCP server binary or MCP samples | [open-enthrium-ai-mcp-server](https://github.com/enthrium/open-enthrium-ai-mcp-server) |

---

## Repo Structure

```
open-enthrium-ai-agent-runtime/
├── server/
│   ├── cli/
│   │   ├── index.js          # oe-runtime CLI entry point
│   │   ├── server.js         # HTTP server mode (--serve)
│   │   └── samples/          # Ready-to-run sample agents
│   │       └── <name>/
│   │           ├── agent.yaml
│   │           └── oe-config.json
│   ├── src/                  # Shared adapter source (synced from platform repo)
│   │   └── utils/tools/
│   │       ├── registry.js
│   │       └── adapters/
│   ├── scripts/
│   │   ├── inject-sea.js     # Node.js SEA binary build script
│   │   └── generate-postman.js
│   ├── package.json
│   └── sea-config.json
└── .github/
    └── workflows/
        └── release.yml       # Builds binaries + updates website on tag
```

---

## Adding a Sample Agent

Sample agents are the most valuable contribution to this repo. Each sample demonstrates a real-world use case for a specific connector category.

1. Create a folder under `server/cli/samples/<capability-name>/`
2. Add `agent.yaml` — a working agent definition
3. Add `oe-config.json` — a redacted config with placeholder credentials
4. Test it locally: `node server/cli/index.js server/cli/samples/<name>/agent.yaml`
5. Open a PR with the sample name and what connector it demonstrates

**Existing samples for reference:**
`sql-databases` · `nosql-cache` · `file-storage` · `cloud-drives` · `email` · `team-messaging` · `rest-api` · `graphql` · `ssh` · `message-queues` · `web-search` · `image-generation` · `speech-audio` · `video-generation` · `music-generation` · `blockchain-web3` · `directory-identity` · `iot-messaging` · `ocr-vision` · `productivity-crm`

---

## Building the Binary Locally

Requires Node.js 22+.

```bash
cd server
yarn install
yarn build:win    # Windows
yarn build:linux  # Linux
yarn build:macos  # macOS
```

The binary is output to `server/cli/dist/`.

---

## How to Submit a PR

1. Fork the repo and create a branch from `main`
2. Name your branch descriptively: `feat/salesforce-sample`, `fix/serve-port-flag`, `docs/quickstart`
3. Keep PRs focused — one fix or feature per PR
4. Fill in the PR template completely
5. All PRs require at least one approval from a maintainer before merging

---

## Code Standards

- Match the style of the surrounding code
- No commented-out code
- No `console.log` left in production paths
- If you add a new dependency, explain why an existing one couldn't work

---

## Reporting Bugs

Use the Bug Report issue template. Include:
- What you did
- What you expected
- What actually happened
- Your environment (OS, binary version, LLM provider)

---

## Security Issues

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md).

---

## Questions

Open a GitHub Discussion rather than an issue if you have a question about how something works or whether an idea is worth pursuing.
