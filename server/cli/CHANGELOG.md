# OE Runtime — Changelog

All notable changes to the OE Agent Runtime are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [v1.6.5] — 2026-08-08

### Added
- OE MCP: Persistent action log (`oe-mcp-log.json`) with `log_list` and `log_clear` MCP tools

---

## [v1.6.4] — 2026-08-07

### Changed
- Version bump to align with platform release v1.6.4

---

## [v1.6.3] — 2026-08-07

### Added
- **blog-to-video sample** — new 22nd starter kit; fetches a blog post, plans 6 slides, generates DALL-E 3 images + OpenAI TTS narration, assembles and exports an MP4 via Canva; requires `bearerToken` in the Canva connector config
- **video-generation sample** — rewritten to use the same Canva pipeline (DALL-E 3 + TTS + Canva export); 5 slides, topic driven via `--param topic=...`

### Fixed
- **REST API adapter** (`src/utils/tools/adapters/rest-api.js`) — POST/PUT/PATCH bodies are now serialized as URL-encoded form data when the connector sets `Content-Type: application/x-www-form-urlencoded`; previously all bodies were sent as JSON regardless of the Content-Type header

---

## [v1.6.2] — 2026-08-06

### Added
- **Startup banners** — standalone CLI mode now prints a banner on start (`OE Runtime Standalone vX.X.X / Run AI agents via CLI`); server mode banner updated to match (`OE Runtime Server vX.X.X / Run AI agents via HTTP`)
- **VERSION constant** — `index.js` now reads version from `package.json` for use in the banner

### Fixed
- **blockchain-web3 sample** — `oe-config.json` now uses free public RPC (`https://eth.llamarpc.com`); removed incorrect `provider`/`apiKey`/`network` fields

---

## [v1.6.1] — 2026-08-04

### Fixed
- **Agent YAML example** — Telegram send step now explicitly uses `sendMessage` endpoint and discovers `chat_id` dynamically via `getUpdates`; query step restricted with "no other queries" to prevent LLM from running extra queries

---

## [v1.6.0] — 2026-08-04

### Changed
- **CLI README** — restructured Quick Start to 3 steps (config → agent.yaml → run); agent.yaml example + YAML Agent Reference moved inline under step 2; Writing Agents section removed; Download & Run simplified; HTTP Server Mode expanded with per-platform commands, full endpoint docs, and curl examples
- **npm README** — fully aligned with CLI README; added Sample Library, Connector Catalog, Supported LLM Providers, Contributing, and Part of Open Enthrium sections; sample count updated to 21
- **Contributing section** — added to both READMEs with hyperlinks to GitHub issues and PR pages
- **Connector examples** — telegram config corrected to use `baseUrl`; connection names updated to match actual samples (`My Database`, `My Telegram Bot`, `YOUR_DB_PASSWORD`)

---

## [v1.4.8] — 2026-08-01

### Changed
- GitHub Release notes now populated automatically from this CHANGELOG on every release
- `release.yml` managed from the monorepo — no manual edits needed in this repo

---

## [v1.4.7] — 2026-08-01

### Added
- **Multi-platform binaries** — `oe-runtime-win.exe`, `oe-runtime-linux`, `oe-runtime-macos` + Postman collection built and attached to every GitHub Release
- **Automated website version bumps** — `runtime.html` download link versions update automatically on release tag

### Changed
- Source of truth moved to monorepo (`enthrium-commercial`); one tag fans out to all repos
- `README.md`, `CONTRIBUTING.md`, `LICENSE`, `SECURITY.md`, `CHANGELOG.md` managed from monorepo

---

## [v1.4.1] — 2026-07-28

### Changed
- Dedicated public repo `open-enthrium-ai-agent-runtime` established with own CI pipeline building all three platform binaries

---

## [v1.3.9] — 2026-07-25

### Added
- **Telegram sample** — bot reads `chat_id` from `getUpdates` and sends summary notifications; uses generic REST adapter
- **`"telegram"` connector type** — registered in registry, no custom SDK required

### Changed
- **Config-driven adapters** — all vendor API endpoint paths moved to `agent.yaml`; zero hardcoded endpoints in the binary
- **`rest-api.js`** — added `PUT`, `PATCH`, `DELETE` methods; `arraybuffer` response handling; `b64_json` auto-saves OpenAI images as temp PNG; flexible auth (`bearerToken`, `apiKey`, Basic Auth, custom headers, query-string auth)
- 10 sample configs updated to config-driven pattern: `cloud-drives`, `email`, `image-generation`, `music-generation`, `ocr-vision`, `rest-api`, `speech-audio`, `ssh`, `video-generation`, `web-search`

---

## [v1.3.7] — 2026-07-24

### Fixed
- **Connector config format** — all 20 sample `oe-config.json` files corrected to canonical array format with `connection_name` and `connection_type`; `prepareConnectors()` updated to accept both array and legacy object formats

---

## [v1.3.5] — 2026-07-23

### Added
- **20-sample library** — `cli/samples/` with ready-to-run `agent.yaml` + `oe-config.json` for SQL, NoSQL, S3, Cloud Drives, Email, Slack, SSH, REST API, GraphQL, GitHub, Kafka, Web Search, OCR, Image Generation, Speech, Video, Music, Blockchain, LDAP, MQTT
- **`oe-runtime-samples.zip`** — all 20 starters bundled and uploaded automatically on every release
- **`server.enabled` config flag** — activate HTTP server mode from config without `--serve` CLI flag
- **Platform-coloured download buttons** — Windows (blue), Linux (orange), macOS (dark)

---

## [v1.3.3] — 2026-07-23

### Added
- **HTTP server mode** — `oe-runtime --serve` starts a persistent HTTP API server
- **`POST /run`** — execute an agent by passing YAML inline in the request body
- **`POST /run-file`** — execute an agent from a YAML file path on disk
- **`GET /health`** — liveness check returning runtime version
- **API key auth** — set `server.apiKey` in `oe-config.json` to protect all endpoints
- **Configurable port** — set `server.port` in `oe-config.json` (default: 3333)

---

## [v1.3.2] — 2026-07-22

### Added
- **8 new connector types** — Search (Perplexity, Google, Bing), OCR (Azure Vision, Google Vision, AWS Textract, Tesseract), Image Generation, Speech & Audio, Video Generation, Music Generation
- **`--param key=value` flag** — inject parameters at runtime; substitutes `{{param_name}}` in agent prompts
- **`onToolResult` hook** — tool call results printed to terminal with `↳` prefix
- **Cross-platform builds** — `oe-runtime-win.exe`, `oe-runtime-linux`, `oe-runtime-macos` built automatically on release

---

## [v1.1.0] — 2026-07-09

### Added
- **`oe-runtime` CLI binary** — run any agent YAML locally with `oe-runtime agent.yaml`
- Sequential agent chaining with `always / on_success / on_critical / on_warning` conditions
- CI build pipeline triggering on version tags
