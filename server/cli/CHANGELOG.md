# Changelog

All notable changes to Open Enterprise are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [v1.4.7] — 2026-08-01

### Added
- **Community Docker image** — `open-enterprise-ai-platform` repo now builds and pushes `openenterprise/open-enterprise-community` to Docker Hub independently on every release tag; commercial and community images are fully separate
- **OE MCP multi-platform binaries** — `oe-mcp-win.exe`, `oe-mcp-linux`, `oe-mcp-macos` built and attached to every GitHub release in `open-enterprise-ai-mcp-server`; samples zip (`oe-mcp-samples.zip`) included
- **`@openenterprise/oe-mcp` npm package** — published to npm automatically on every release; `npx @openenterprise/oe-mcp` works on any machine without a manual binary download
- **OE Runtime multi-platform binaries** — `oe-runtime-win.exe`, `oe-runtime-linux`, `oe-runtime-macos` + Postman collection built and attached to every GitHub release in `open-enterprise-ai-agent-runtime`
- **Automated website version bumps** — `mcp.html` and `runtime.html` download link versions update automatically when a release tag is pushed; no manual edits needed

### Changed
- **Monorepo** — `open-enterprise-commercial` is now the single source of truth; one tag push fans out to all four repos (`open-enterprise-ai-platform`, `open-enterprise-ai-mcp-server`, `open-enterprise-ai-agent-runtime`) via GitHub Actions sync workflows
- **Root docs managed from monorepo** — `README.md`, `CONTRIBUTING.md`, `LICENSE`, and `SECURITY.md` for the MCP and runtime public repos are now authored inside `server/mcp/` and `server/cli/` and synced on every release
- **Sync workflows use force-push for tags** — stale tags in target repos are overwritten cleanly; no more manual tag cleanup between retags

---

## [v1.4.1] — 2026-07-28

### Added
- **OE MCP Server** — new standalone binary (`oe-mcp-win.exe`, `oe-mcp-linux`, `oe-mcp-macos`) that exposes enterprise connectors as MCP tools; AI apps (Claude Code, Cursor, Windsurf, Claude Desktop) connect via stdio or HTTP serve mode
- **`--stdio` mode** — Claude Code VS Code extension launches `oe-mcp-win.exe` as a child process automatically; no manual server start required
- **`--serve` mode** — `oe-mcp --serve --port 4040 oe-mcp.yaml` starts an HTTP MCP server; Cursor, Windsurf, and cloud deployments connect via URL
- **Persistent memory tools** — `memory_set`, `memory_get`, `memory_delete`, `memory_list` tools available in every MCP session; state stored in `oe-mcp-memory.json` next to the config file and survives restarts
- **Filesystem connector** — new `filesystem` adapter with 8 tools: `list_dir`, `read_file`, `write_file`, `append_file`, `delete_file`, `make_dir`, `file_info`, `search_files`; directory traversal blocked via `safePath()` security check; 50 KB read limit
- **MCP sample configs** — ready-to-use `oe-mcp.yaml` starter files for: PostgreSQL, MySQL, MongoDB, GitHub, Slack, Google Drive, SSH, filesystem, Oracle, Salesforce (coming soon), ServiceNow (coming soon), and a multi-connector example
- **`open-enterprise-ai-agent-runtime` repo** — dedicated public repo for the OE Runtime binary; own CI pipeline builds `oe-runtime-win.exe`, `oe-runtime-linux`, `oe-runtime-macos` on every version tag
- **`open-enterprise-ai-mcp-server` repo** — dedicated public repo for the OE MCP binary; own CI pipeline builds all platform binaries + `oe-mcp-samples.zip` on every version tag

### Changed
- **Repo restructure** — `server/cli/` moved to `open-enterprise-ai-agent-runtime`; `server/mcp/` moved to `open-enterprise-ai-mcp-server`; community and commercial repos now contain only the core platform (`server/src/`, frontend, workflows)
- **`runtime-release.yml` removed** from community CI — runtime binary builds are now owned by the `open-enterprise-ai-agent-runtime` repo
- **`registry.js`** — added `filesystem`, `local-file`, `local-fs` aliases routing to the new filesystem adapter

---

## [v1.4.0] — 2026-07-26

### Added
- **Commercial overlay architecture** — drop a `commercial/` folder next to the community repo to unlock commercial features; no env vars, no license keys; folder presence is detected at startup by both the server and Vite
- **`@commercial` / `@core` Vite aliases** — commercial frontend pages import community utilities via `@core/context/`, `@core/components/`, etc.; community builds to a stub when the folder is absent
- **`server/src/data/connectionTypes.json`** — 2,654 connector type entries as the single source of truth; replaces the hardcoded array in both the seed script and the connector screen JSX
- **`generate:postman` script** — `yarn generate:postman` (or `node scripts/generate-postman.js`) auto-builds `cli/oe-runtime.postman_collection.json` from all `cli/samples/*/agent.yaml` files; 21 sample requests in a "Samples" folder, one per sample agent
- **Postman collection auto-generated on release** — `runtime-release.yml` runs `generate:postman` before uploading to GitHub Releases so every release ships a fresh, complete collection

### Changed
- **Repo flattened** — `app/server/`, `app/frontend/`, `app/processor/` moved to root-level `server/`, `frontend/`, `processor/`; Yarn workspace root is now the repo root
- **Commercial pages moved out of community** — Agent Builder, Users, Developer (APIs + Embed), SSO, Compliance, Violations, Activity Log, Tier Limits, Token Usage, Vectors pages now live in `commercial/frontend/pages/` and are injected via `commercialRoutes`; community ships without them
- **Community sidebar cleaned** — Users, Developer (APIs, Embed), and Vectors nav links removed; those sections only appear when commercial is present
- **Connector seed reads from JSON** — `seed-connection-masters.js` no longer has a hardcoded list; it reads `server/src/data/connectionTypes.json` at runtime
- **Docker entrypoint seeds connection masters** — `entrypoint.sh` runs `seed-connection-masters.js` after `db push` so connector types are always populated on first boot

### Fixed
- **Connector screen showing all "Soon"** — `connectionMaster` table was empty on fresh installs; fixed by seeding from `connectionTypes.json` on startup
- **Login broken after commercial folder added** — `isEnterpriseLicense` reference removed from `/api/instance` route; replaced with `isCommercial` boolean from `fs.existsSync` check
- **`requireCommercial` middleware using stale env vars** — updated to use `fs.existsSync` folder detection, consistent with server startup logic

---

## [v1.3.9] — 2026-07-25

### Added
- **Telegram sample** — 21st sample agent (`telegram/agent.yaml` + `oe-config.json`); uses Telegram Bot API via the generic REST adapter; bot token embedded in `baseUrl`; agent reads `chat_id` automatically from `getUpdates` and sends a summary notification back to the chat
- **`"telegram"` connector type** — registered in `registry.js` routing to `restApi`; no custom SDK required

### Changed
- **Config-driven adapters — all HTTP API endpoints moved to YAML** — vendor-specific endpoint paths and request bodies are now defined in `agent.yaml` step `content` and `baseUrl` in `oe-config.json`; the runtime binary contains zero hardcoded API endpoints
- **`rest-api.js` enhanced** — added `PUT`, `PATCH`, `DELETE` HTTP methods; universal `arraybuffer` response handling with automatic binary detection (audio/video saved to temp files with correct extension); `b64_json` detection saves OpenAI image responses as temp PNG files and returns `local_path` instead of raw base64; flexible auth: `bearerToken`, `apiKey` + `headerName`, Basic Auth, custom `headers` object, `queryParamName` for query-string auth
- **`registry.js` simplified** — removed 6 specialized HTTP adapters (`search`, `ocr`, `imageGen`, `speech`, `videoGen`, `musicGen`); all their connection types now route to `restApi`; added `"google-drive"`, `"gmail-rest"`, and `"telegram"` aliases pointing to `restApi`
- **`cli/index.js` — `loadConfig()` tolerates literal newlines in SSH private keys** — state-machine JSON pre-parser escapes bare newlines inside string values before `JSON.parse`; private keys with raw line breaks now load without `SyntaxError`
- **10 sample configs updated to config-driven pattern** — `cloud-drives`, `email`, `image-generation`, `music-generation`, `ocr-vision`, `rest-api`, `speech-audio`, `ssh`, `video-generation`, `web-search`; each now uses `baseUrl` + auth credential in `oe-config.json` and API endpoint paths in `agent.yaml` step content
- **`cloud-drives` sample** — `connection_type: google-drive`; uses Google Drive REST API v3 (`bearerToken` + `baseUrl`); no googleapis SDK dependency
- **`email` sample** — `connection_type: gmail-rest`; uses Gmail REST API (`bearerToken` + `baseUrl`); no SMTP/IMAP; inbox read via `GET /messages`, send via `POST /messages/send` with base64url RFC 2822 body
- **`music-generation` sample** — switched from deprecated Suno Studio API to kie.ai (`https://api.kie.ai/api/v1`); uses `POST /generate` + polling `GET /generate/<taskId>`; model `V4_5`
- **`image-generation` sample** — uses `gpt-image-1` via `POST /images/generations`; `b64_json` response auto-saved to temp PNG; agent reports `local_path`
- **`ssh` sample** — `privateKey` now inline PEM string in `oe-config.json` instead of `privateKeyPath`
- **`rest-api` sample** — `baseUrl` updated to `https://jsonplaceholder.typicode.com` (public, no auth required)
- **Website hero updated** — h1 changed to "Enterprise AI Platform & Agent Runtime"; hero paragraph and FAQ JSON-LD updated to match
- **README "What is Open Enterprise?" updated** — dual positioning as Enterprise AI Platform and AI Agent Runtime
- **`document.title` set to custom branding name** — enterprise license `brandingName` now applied to browser tab title
- **`Cache-Control: no-store`** added to `/api/instance` response

### Fixed
- **Login screen version** — `app/package.json` version kept in sync with `app/server/package.json` so the login screen displays the correct version number

---

## [v1.3.8] — 2026-07-24

### Changed
- CHANGELOG updated with v1.3.6 and v1.3.7 entries

---

## [v1.3.7] — 2026-07-24

### Fixed
- **Connector config format corrected across all 20 samples** — `oe-config.json` connectors were using a keyed object format (`{"Name": {type, ...}}`) that did not match the array-based lookup in `prepareConnectors()`; all 20 sample `oe-config.json` files updated to the canonical array format with `connection_name` and `connection_type` fields
- **All 20 blog posts updated** — Config File code block in every agent blog post now shows the correct array connector format
- **`prepareConnectors()` backward-compatible** — `cli/index.js` updated to accept both array format `[{connection_name, connection_type, ...creds}]` and the legacy object format `{"Name": {type, ...creds}}`; both now work without error

---

## [v1.3.6] — 2026-07-24

### Added
- **`commercial.html`** — standalone Commercial page (hero, 12 feature cards, dedicated services, infrastructure, who-it's-for, CTA); linked from nav and footer across all pages
- **20 agent how-to blog posts** — one post per sample agent covering YAML, config, download, run commands, API server usage, 8 use cases, and copy-button code blocks (`blog/ai-*.html`)
- **"How-To Guides" section in `runtime.html`** — card grid linking all 20 blog posts directly from the runtime page
- **All 20 blog posts in `blog/index.html`** — agent blog cards added to the blog index
- **All 20 blog URLs in `sitemap.xml`** — with `lastmod 2026-07-24`
- **Website + Runtime links in `README.md`** — added `openenterprise.info` and `runtime.html` links to the "What is Open Enterprise?" bullet list

### Changed
- `index.html` — `#commercial` section replaced with a compact teaser pointing to `commercial.html`; nav, mobile nav, and footer updated to link to `commercial.html`

---

## [v1.3.5] — 2026-07-23

### Added
- **Sample library** — `cli/samples/` folder with 20 capability-specific starter kits, each containing a ready-to-run `agent.yaml` + `oe-config.json` (SQL, NoSQL, S3, Cloud Drives, Email, Slack, SSH, REST API, GraphQL, GitHub, Kafka, Web Search, OCR, Image Generation, Speech, Video, Music, Blockchain, LDAP, MQTT)
- **`oe-runtime-samples.zip`** — all 20 sample kits bundled and uploaded automatically on every release tag; always downloadable from `/releases/latest/download/oe-runtime-samples.zip`
- **`server.enabled` config flag** — set `server.enabled: true` in `oe-config.json` to activate HTTP server mode without the `--serve` CLI flag; `--serve` still works as a quick override
- **Per-capability "Download starter kit" buttons** on runtime website — each of the 20 capability cards generates and downloads the matching `agent.yaml` + `oe-config.json` directly in the browser
- **Platform-coloured download buttons** on runtime website — Windows (blue), Linux (orange), macOS (dark)

### Changed
- `server.js` banner version now reads from `package.json` instead of a hardcoded string — always accurate after a version bump
- README download table and quickstart updated to reference the sample library instead of the generic example files
- Website and app "Sample Library" button replaces the old "Config Template" + "Sample Agent" buttons everywhere

### Removed
- `oe-config.example.json` and `agent.example.yaml` — superseded by the sample library; all 20 starters provide capability-specific configs

---

## [v1.3.4] — 2026-07-23

### Changed
- Removed Discord links from app sidebar footer and user menu

---

## [v1.3.3] — 2026-07-23

### Added
- **OE Runtime HTTP server mode** — `oe-runtime --serve` turns the binary into a persistent HTTP API server; call agents from mobile apps, web apps, or any HTTP client without Node.js or Docker on the client
- **`POST /run`** — execute an agent by passing YAML inline in the request body
- **`POST /run-file`** — execute an agent from a YAML file path on the server's disk
- **`GET /health`** — liveness check returning runtime version
- **API key auth** — set `server.apiKey` in `oe-config.json` to protect all endpoints with an `x-api-key` header
- **Configurable port** — set `server.port` in `oe-config.json` (default: 3333)
- **Runtime page in app** — new sidebar nav item with download buttons, CLI usage, HTTP server mode docs, Postman collection download, and 20-category capabilities table
- **Postman collection download** — one-click download of a ready-to-import collection with all server endpoints pre-filled

### Changed
- README redesigned — Mermaid architecture diagram, OE Runtime download table, YAML tutorial, connector catalog, runtime vs platform comparison, competitor comparison (LangGraph, CrewAI, AutoGen, Dify)
- Website repositioned as "Self-Hosted Enterprise AI Agent Runtime" across title, hero, meta, and JSON-LD
- Website nav — Discord removed, Docker Hub as plain link, OE Runtime as pill button
- Connector count updated to 2,673 across 45+ categories throughout all surfaces

### Fixed
- OE Runtime pill text vertical alignment on website nav

---

## [v1.3.2] — 2026-07-22

### Added
- **Search connectors** — Perplexity, Google Custom Search, Bing
- **OCR connectors** — Azure Vision, Google Vision, AWS Textract, Tesseract
- **Image Generation connectors** — OpenAI (`gpt-image-1`), FLUX (Together AI), Stable Diffusion, Ideogram
- **Speech & Audio connectors** — ElevenLabs, OpenAI TTS, Azure Speech, Google TTS
- **Video Generation connectors** — Runway, Kling, Pika (async job polling included)
- **Music Generation connectors** — Suno, Udio (async job polling included)
- **CLI `--param key=value` flag** — inject agent parameters at runtime; substitutes `{{param_name}}` placeholders in agent prompts (repeatable flag)
- **`onToolResult` hook** — tool call results now printed to terminal with `↳` prefix so you can see exactly what each tool returned
- **Cross-platform runtime** — `oe-runtime-win.exe` (Windows), `oe-runtime-linux` (Linux), `oe-runtime-macos` (macOS) all built automatically on release
- Connector catalog now at **2,673 entries** across 45+ categories

### Fixed
- OpenAI image generation: removed unsupported `style` and `response_format` params that caused 400 errors
- Image generation errors now returned as strings to the LLM instead of throwing (agent sees the error and can retry)
- Default OpenAI image model changed from `dall-e-3` to `gpt-image-1`

---

## [v1.3.1] — 2026-07-20

### Changed
- Community telemetry enabled by default in Docker builds

---

## [v1.3.0] — 2026-07-20

### Added
- Discord community badge and links across README and UI
- Telemetry bootstrap for aggregated usage insights (no PII)
- AI Ecosystem messaging on login page and marketing copy

### Fixed
- SSO / OAuth redirect ports corrected to 3000/3001

---

## [v1.2.9] — 2026-07-19

### Changed
- Docker image name now derived automatically from the GitHub repository name (no hardcoded values)

---

## [v1.2.8] — 2026-07-18

### Fixed
- CI workflow uses `DOCKER_IMAGE` repository variable for Docker Hub image name

---

## [v1.2.7] — 2026-07-18

### Fixed
- CI auto-detects repository name to resolve the correct Docker Hub image path

---

## [v1.2.6] — 2026-07-18

### Added
- Workspace sharing enforcement — agents and connectors respect workspace-level share settings
- Branding controls gated to enterprise license (white-label, custom logo, colors)

### Fixed
- Agent Builder SSE streaming hang and frontend rendering issues
- SSO port configuration

---

## [v1.2.5] — 2026-07-18

### Added
- Agent Builder — conversational YAML designer with live preview
- Visual Flow and YAML tabs in the Agent Builder right panel
- Save-to-Marketplace and Download-YAML actions on agent templates
- Agent Builder chat persisted to `localStorage` across navigation

---

## [v1.2.4] — 2026-07-15

### Added
- Enterprise license gate for commercial features (SSO, tier limits, DLP purge, Agent Builder)
- Marketplace two-tab layout (Browse / My Agents) with shared `AgentVisualFlow` component
- Editable YAML drawer and step validation in Agent Builder

### Changed
- Version badge moved to sidebar
- Footer updated to `www.openenterprise.info`

---

## [v1.2.3] — 2026-07-14

### Changed
- README "Who It's For" section rewritten as a product pitch
- Infrastructure & Deployment section added (K8s, HA, multi-region, cloud options)

---

## [v1.2.2] — 2026-07-13

### Fixed
- Workspace creation reference corrected — Community Edition has no Admin Panel for this flow

---

## [v1.2.1] — 2026-07-13

### Changed
- README updated with license tier documentation, JWT notes, and enterprise feature list

---

## [v1.2.0] — 2026-07-13

### Added
- Connector catalog expanded to **1,541 entries** across 39 categories
- 8 new native adapters: S3-compatible storage, Kafka/SQS/Pub-Sub, MQTT/IoT, LDAP/Active Directory, GraphQL, Web3/Blockchain, OneDrive/Dropbox/Box, SFTP

---

## [v1.1.0] — 2026-07-09

### Added
- `oe-runtime` CLI binary — run any agent YAML locally with `oe-runtime agent.yaml`
- Connector Library UI — browse and filter all connector types by category
- Dynamic credential forms per connector type
- CI Docker build now triggers on version tags

---

## [v1.0.0] — 2026-07-08

### Added
- Initial release of Open Enterprise Community Edition
- Multi-LLM support: 17+ providers (OpenAI, Anthropic, Azure OpenAI, Groq, Gemini, Ollama, Mistral, and more)
- RAG pipeline: ingestion queue, chunking, embedding, vector upsert, similarity search, cited responses
- 8 vector database adapters: LanceDB (default), Pinecone, Qdrant, Chroma, Weaviate, PgVector, Milvus, Zilliz
- 7 embedding providers: OpenAI, Azure, Ollama, Cohere, Gemini, and more
- AI Assistant / Chat: SSE streaming, RAG, tool calling, conversation threads, @connector and @agent routing
- Workspaces: CRUD, user roles, per-workspace LLM and vector DB overrides
- Agent system: CRUD, slug addressing, YAML export, run history, SSE streaming, cron scheduling, group tagging
- Sequential agent chaining with `always / on_success / on_critical / on_warning` conditions
- DLP governance: block / warn / redact / audit policies, custom regex, violations audit log with CSV export
- Token usage dashboard: per-user input/output/embedding token costs with period filters
- Activity log: admin action timeline with category filters
- Dashboard: run counts, success/error rates, 30-day trend charts
- Single Docker container deployment (`docker compose up`)
