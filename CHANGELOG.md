# OE Runtime — Changelog

All notable changes to the OE Agent Runtime are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
- Source of truth moved to monorepo (`open-enterprise-commercial`); one tag fans out to all repos
- `README.md`, `CONTRIBUTING.md`, `LICENSE`, `SECURITY.md`, `CHANGELOG.md` managed from monorepo

---

## [v1.4.1] — 2026-07-28

### Changed
- Dedicated public repo `open-enterprise-ai-agent-runtime` established with own CI pipeline building all three platform binaries

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
