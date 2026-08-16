# Contributing to Open Enthrium AI Agent Runtime

## Adding a Connector Adapter

Connector adapters live in the platform repo — contributions there work across Runtime, Platform, and MCP automatically.

→ **[open-enthrium-ai-platform](https://github.com/enthrium/open-enthrium-ai-platform/blob/main/CONTRIBUTING.md)**

---

## Adding a Sample Agent

Sample agents are the main contribution to this repo. Each sample shows a real-world use case for a connector.

### Step 1 — Create your sample folder

```
server/cli/samples/your-connector/
├── agent.yaml        ← agent definition
└── oe-config.json    ← redacted config with placeholder credentials
```

### Step 2 — Test it locally

```bash
node server/cli/index.js server/cli/samples/your-connector/agent.yaml \
  --config server/cli/samples/your-connector/oe-config.json
```

### Step 3 — Open a PR

Include the connector name and what the sample demonstrates.

**Existing samples for reference:**
`sql-databases` · `nosql-cache` · `file-storage` · `cloud-drives` · `email` · `team-messaging` · `rest-api` · `graphql` · `ssh` · `local-exec` · `message-queues` · `web-search` · `image-generation` · `speech-audio` · `video-generation` · `music-generation` · `blockchain-web3` · `directory-identity` · `iot-messaging` · `ocr-vision` · `productivity-crm` · `telegram` · `chains` · `blog-to-video`

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

Output: `server/cli/dist/`

---

## Guidelines

- Never commit real credentials — use placeholders in `oe-config.json`
- One sample per connector category
- Test your sample locally before opening a PR
- Open an issue first if you're unsure whether a sample fits
