"use strict";

const fs    = require("fs");
const path  = require("path");
const yaml  = require("js-yaml");
const os    = require("os");
const https = require("https");
const http  = require("http");

const engine  = require("../src/engine");
const VERSION = require("../package.json").version;

const serverStartTime = Date.now();

// ── in-memory stores ──────────────────────────────────────────────────────────
// chain_id  → { nextPath, contextOutput, params, depth }
const pendingChains = new Map();

// "platform:chat_id" → { chain_id, next_agent }
const pendingApprovals = new Map();

function makeChainId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── connector matching ────────────────────────────────────────────────────────

function prepareConnectors(yamlConnectors, configConnectors) {
  let cfgArray;
  if (Array.isArray(configConnectors)) {
    cfgArray = configConnectors;
  } else if (configConnectors && typeof configConnectors === "object") {
    cfgArray = Object.entries(configConnectors).map(([name, cfg]) => ({
      connection_name: name,
      connection_type: cfg.type,
      ...cfg,
    }));
  } else {
    cfgArray = [];
  }

  return (yamlConnectors || []).map((yc, i) => {
    const ycName = yc.connection_name || yc.name;
    const ycType = yc.connection_type || yc.type;

    const cc = cfgArray.find(c => (c.connection_name || c.name) === ycName)
            || cfgArray.find(c => (c.connection_type || c.type) === ycType);

    if (!cc) {
      console.warn(`  ⚠  No config entry for connector "${ycName}" (${ycType})`);
      return { id: i + 1, name: ycName, type: ycType, status: "active", authConfig: "{}", config: "{}" };
    }

    const { connection_name, connection_type, name, type, ...creds } = cc;
    const resolvedName = connection_name || name || ycName;
    const resolvedType = connection_type || type || ycType;

    if (creds.privateKeyPath) {
      const keyPath = creds.privateKeyPath.replace(/^~/, os.homedir());
      creds.privateKey = fs.readFileSync(keyPath, "utf8").replace(/\r\n/g, "\n");
      delete creds.privateKeyPath;
    }
    if (creds.privateKey) {
      creds.privateKey = creds.privateKey.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
    }

    return {
      id:         i + 1,
      name:       resolvedName,
      type:       resolvedType,
      status:     "active",
      authConfig: JSON.stringify(creds),
      config:     JSON.stringify(creds),
    };
  });
}

function buildAgentSpec(agentYaml, params, input) {
  return {
    systemPrompt: agentYaml.systemPrompt || agentYaml.system_prompt || agentYaml.instructions || "",
    workflow:     agentYaml.steps        || agentYaml.workflow       || [],
    params:       agentYaml.params       || [],
    paramValues:  params  || {},
    maxRounds:    agentYaml.maxRounds    || 25,
    input:        input   || null,
  };
}

// ── chain-aware agent runner ──────────────────────────────────────────────────

const MAX_DEPTH = 5;

async function runAgentServer(agentFile, agentYaml, config, input, params, depth = 0) {
  const connectors = prepareConnectors(agentYaml.connectors, config.connectors);
  const agentSpec  = buildAgentSpec(agentYaml, params, input);

  const { output } = await engine.run(agentSpec, config.llm, connectors, {
    onToolCall:   () => {},
    onToolResult: () => {},
    onError:      (err) => { throw err; },
  });

  const result = {
    agent:          agentYaml.name || (agentFile ? path.basename(agentFile) : "inline"),
    output,
    chains:         [],
    pending_chains: [],
  };

  if (!agentYaml.chains?.length || depth >= MAX_DEPTH) return result;

  for (const chain of agentYaml.chains) {
    const nextAgent   = chain.next_agent   || chain.nextAgent;
    const triggerType = chain.trigger_type || chain.triggerType || "auto";

    if (!nextAgent) continue;

    const nextPath = agentFile
      ? path.resolve(path.dirname(path.resolve(agentFile)), nextAgent)
      : null;

    if (!nextPath || !fs.existsSync(nextPath)) {
      result.chains.push({ agent: nextAgent, error: "chain agent file not found: " + (nextPath || nextAgent) });
      continue;
    }

    const contextInput = `Context from previous agent:\n\n${output}\n\nNow execute your task.`;

    if (triggerType === "manual") {
      const chainId = makeChainId();
      pendingChains.set(chainId, {
        nextPath,
        contextOutput: output,
        params,
        depth: depth + 1,
      });
      result.pending_chains.push({
        chain_id:       chainId,
        next_agent:     nextAgent,
        output_preview: output.slice(0, 300),
      });
    } else {
      let nextYaml;
      try { nextYaml = yaml.load(fs.readFileSync(nextPath, "utf8")); }
      catch (e) { result.chains.push({ agent: nextAgent, error: "Failed to load YAML: " + e.message }); continue; }

      try {
        const chainResult = await runAgentServer(nextPath, nextYaml, config, contextInput, params, depth + 1);
        result.chains.push(chainResult);
      } catch (err) {
        result.chains.push({ agent: nextYaml.name || path.basename(nextPath), error: err.message });
      }
    }
  }

  return result;
}

// ── project loader ────────────────────────────────────────────────────────────

function loadProject(cwd) {
  const projectFile = path.join(cwd, "oe-project.json");
  if (!fs.existsSync(projectFile)) return null;
  try {
    const project = JSON.parse(fs.readFileSync(projectFile, "utf8"));
    console.log(`  Project  ${project.name}${project.version ? " v" + project.version : ""}  (${(project.agents || []).length} agents)`);
    return project;
  } catch (e) {
    console.warn(`  ⚠  Failed to load oe-project.json: ${e.message}`);
    return null;
  }
}

function resolveAgentFile(project, target, cwd) {
  // 1. Look up by name in project registry
  if (project?.agents) {
    const agent = project.agents.find(a => a.name === target);
    if (agent) return path.resolve(cwd, agent.file);
  }

  // 2. Treat as file path (relative or absolute)
  const filePath = path.resolve(cwd, target);
  if (fs.existsSync(filePath)) return filePath;

  return null;
}

function getDefaultAgentFile(project, cwd) {
  if (!project?.agents) return null;
  const def = project.agents.find(a => a.default === true);
  if (!def) return null;
  return path.resolve(cwd, def.file);
}

// ── command parser ────────────────────────────────────────────────────────────

function parseCommand(text) {
  const t = (text || "").trim();

  if (t.startsWith("/run ")) return { action: "run",      target: t.slice(5).trim() };
  if (t === "/run")           return { action: "run",      target: null };
  if (t === "/agents")        return { action: "agents" };
  if (t === "/projects")      return { action: "projects" };
  if (t === "/status")        return { action: "status" };
  if (t === "/help")          return { action: "help" };

  // Approve shortcuts
  const lower = t.toLowerCase();
  if (t === "/approve" || lower === "yes" || lower === "y")
    return { action: "approve" };

  // Cancel shortcuts
  if (t === "/cancel" || lower === "no" || lower === "n")
    return { action: "cancel" };

  // Unknown slash command
  if (t.startsWith("/")) return { action: "unknown", command: t };

  // Plain text — route to default agent
  return { action: "chat", text: t };
}

// ── response formatters ───────────────────────────────────────────────────────

function formatHelp() {
  return [
    "⚡ *OE Runtime — Commands*",
    "",
    "/run <name>    Run agent by name",
    "/run <path>    Run agent by file path",
    "/agents        List available agents",
    "/approve       Approve pending chain",
    "/cancel        Cancel pending chain",
    "/status        Health check",
    "/projects      List linked projects",
    "/help          Show this message",
  ].join("\n");
}

function formatAgentsList(project) {
  if (!project?.agents?.length) {
    return "No agents registered.\nAdd an oe-project.json to register agents.";
  }
  const lines = ["📋 *Available agents:*\n"];
  for (const a of project.agents) {
    const tag = a.default ? " _(default)_" : "";
    lines.push(`• /run ${a.name}${tag}`);
    if (a.description) lines.push(`  ${a.description}`);
  }
  lines.push("\nUse /run <name> to execute");
  return lines.join("\n");
}

function formatProjectsList(project) {
  if (!project?.links?.length) {
    return "No linked projects configured.";
  }
  const lines = ["🔗 *Linked projects:*\n"];
  for (const l of project.links) {
    lines.push(`• ${l.name}  →  ${l.project}`);
  }
  return lines.join("\n");
}

function formatStatus(config, project) {
  const uptimeMs = Date.now() - serverStartTime;
  const mins     = Math.floor(uptimeMs / 60000);
  const secs     = Math.floor((uptimeMs % 60000) / 1000);

  const lines = [
    `✅ *OE Runtime v${VERSION}*`,
    `   LLM: ${config.llm?.provider} / ${config.llm?.model || "default"}`,
    `   Uptime: ${mins}m ${secs}s`,
    "",
    "*Connectors:*",
  ];

  for (const c of (config.connectors || [])) {
    const type = c.connection_type || c.type;
    lines.push(`  • ${c.connection_name || c.name} (${type})`);
  }

  if (project) {
    lines.push("");
    lines.push(`*Project:* ${project.name}${project.version ? " v" + project.version : ""}`);
    if (project.author) lines.push(`*Author:* ${project.author}`);
    lines.push(`*Agents:* ${project.agents?.length || 0} registered`);
    if (project.links?.length) {
      lines.push(`*Links:* ${project.links.map(l => l.name).join(", ")}`);
    }
  }

  return lines.join("\n");
}

// ── webhook message handler (platform-agnostic) ───────────────────────────────
// Every incoming message from any platform runs through here.
// Returns a string — the reply to send back.

async function handleWebhookMessage({ platform, config, project, cwd, chatId, user, text }) {
  const chatKey = `${platform}:${chatId}`;

  // ── check for pending chain approval ────────────────────────────────────────
  const pendingApproval = pendingApprovals.get(chatKey);

  if (pendingApproval) {
    const cmd = parseCommand(text);

    if (cmd.action === "approve") {
      pendingApprovals.delete(chatKey);

      const pending = pendingChains.get(pendingApproval.chain_id);
      if (!pending) return "Chain expired or already used.";
      pendingChains.delete(pendingApproval.chain_id);

      let nextYaml;
      try { nextYaml = yaml.load(fs.readFileSync(pending.nextPath, "utf8")); }
      catch (e) { return `❌ Failed to load chain agent: ${e.message}`; }

      const contextInput = `Context from previous agent:\n\n${pending.contextOutput}\n\nNow execute your task.`;

      const result = await runAgentServer(
        pending.nextPath, nextYaml, config, contextInput, pending.params, pending.depth
      );

      // Further pending chains?
      if (result.pending_chains?.length) {
        const pc = result.pending_chains[0];
        pendingApprovals.set(chatKey, { chain_id: pc.chain_id, next_agent: pc.next_agent });
        return `${result.output}\n\n⏸ *Next chain:* ${pc.next_agent}\nReply YES to approve or NO to cancel.`;
      }

      return result.output;

    } else if (cmd.action === "cancel") {
      pendingChains.delete(pendingApproval.chain_id);
      pendingApprovals.delete(chatKey);
      return "⏹ Chain cancelled.";

    } else {
      return `⏸ *Pending chain:* ${pendingApproval.next_agent}\nReply YES to approve or NO to cancel.`;
    }
  }

  // ── parse command ────────────────────────────────────────────────────────────
  const cmd = parseCommand(text);

  // ── helper: run an agent file and handle pending chains ───────────────────
  async function runAndReply(agentFile, input = null, params = {}) {
    let agentYaml;
    try { agentYaml = yaml.load(fs.readFileSync(agentFile, "utf8")); }
    catch (e) { return `❌ Failed to load agent: ${e.message}`; }

    console.log(`[Webhook/${platform}] Running: ${path.basename(agentFile)}`);

    const agentParams = { message: text, chat_id: String(chatId), user, ...params };
    const result      = await runAgentServer(agentFile, agentYaml, config, input, agentParams, 0);

    if (result.pending_chains?.length) {
      const pc = result.pending_chains[0];
      pendingApprovals.set(chatKey, { chain_id: pc.chain_id, next_agent: pc.next_agent });
      return `${result.output}\n\n⏸ *Next chain:* ${pc.next_agent}\nReply YES to approve or NO to cancel.`;
    }

    return result.output;
  }

  switch (cmd.action) {

    case "run": {
      if (!cmd.target) {
        return "Usage: /run <agent-name>  or  /run <path/to/agent.yaml>";
      }
      const agentFile = resolveAgentFile(project, cmd.target, cwd);
      if (!agentFile) {
        return `❌ Agent not found: *${cmd.target}*\nUse /agents to see available agents.`;
      }
      return runAndReply(agentFile);
    }

    case "agents":
      return formatAgentsList(project);

    case "projects":
      return formatProjectsList(project);

    case "status":
      return formatStatus(config, project);

    case "help":
      return formatHelp();

    case "approve":
      return "No pending chain to approve. Use /run <agent> first.";

    case "cancel":
      return "No pending chain to cancel.";

    case "unknown":
      return `Unknown command: ${cmd.command}\nType /help to see available commands.`;

    case "chat": {
      // Route to default agent if set
      const defaultFile = getDefaultAgentFile(project, cwd);
      if (defaultFile && fs.existsSync(defaultFile)) {
        return runAndReply(defaultFile);
      }
      // No default agent — show help
      return formatHelp();
    }
  }
}

// ── HTTP / HTTPS POST helper ──────────────────────────────────────────────────

function apiPost(url, body) {
  return new Promise((resolve, reject) => {
    const raw    = JSON.stringify(body);
    const parsed = new URL(url);
    const mod    = parsed.protocol === "https:" ? https : http;

    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(raw),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end",  ()    => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

// Send a Telegram message (retries as plain text if Markdown fails)
async function sendTelegramMessage(baseUrl, chatId, text) {
  try {
    await apiPost(`${baseUrl}/sendMessage`, {
      chat_id:    chatId,
      text:       text.slice(0, 4096),
      parse_mode: "Markdown",
    });
  } catch (_) {
    await apiPost(`${baseUrl}/sendMessage`, {
      chat_id: chatId,
      text:    text.slice(0, 4096),
    });
  }
}

// ── webhook route mounter ─────────────────────────────────────────────────────
// Registers /webhook/* endpoints BEFORE auth middleware.

function mountWebhookRoutes(app, config, project, cwd) {
  const allConnectors = config.connectors || [];

  // Webhook config lives in config.server.webhook
  const webhookConfig = config.server?.webhook;
  if (!webhookConfig?.enabled) return [];

  const autoReply = webhookConfig.auto_reply !== false;

  // Messaging connectors that get a webhook endpoint
  const messagingConnectors = allConnectors.filter(c => {
    const type = c.connection_type || c.type;
    return ["telegram", "slack", "github"].includes(type);
  });

  if (!messagingConnectors.length) {
    console.warn("  ⚠  OE Webhook enabled but no messaging connectors found (telegram/slack/github)");
    return [];
  }

  const mounted = [];

  for (const conn of messagingConnectors) {
    const type  = conn.connection_type || conn.type;
    const wPath = `/webhook/${type}`;

    app.post(wPath, async (req, res) => {
      const body = req.body;

      let chatId, user, text;

      if (type === "telegram") {
        const msg = body.message || body.edited_message || body.channel_post;
        if (!msg) return res.sendStatus(200);
        chatId = msg.chat?.id;
        user   = msg.from?.first_name || msg.from?.username || "User";
        text   = msg.text || "(non-text message)";

      } else if (type === "slack") {
        // Handle Slack URL verification challenge
        if (body.type === "url_verification") return res.json({ challenge: body.challenge });
        const event = body.event || {};
        // Ignore bot messages to avoid loops
        if (event.bot_id) return res.sendStatus(200);
        chatId = event.channel;
        user   = event.user || "User";
        text   = event.text || "";

      } else if (type === "github") {
        const event = req.headers["x-github-event"] || "unknown";
        chatId = "github";
        user   = body.sender?.login || "GitHub";
        text   = `/run github-handler --event ${event}`;

      } else {
        chatId = "webhook";
        user   = "webhook";
        text   = JSON.stringify(body);
      }

      // Respond immediately — Telegram retries if no 200 within 60s
      res.sendStatus(200);

      if (!chatId) return;

      const preview = (text || "").slice(0, 80);
      console.log(`[Webhook/${type}] ← ${user}: ${preview}${preview.length === 80 ? "…" : ""}`);

      try {
        const reply = await handleWebhookMessage({
          platform: type,
          config,
          project,
          cwd,
          chatId,
          user,
          text,
        });

        if (autoReply && reply) {
          if (type === "telegram") {
            await sendTelegramMessage(conn.baseUrl, chatId, reply);
            console.log(`[Webhook/${type}] → reply sent to chat ${chatId}`);
          }
          // Slack / Teams reply functions added here as platforms are supported
        }

      } catch (err) {
        console.error(`[Webhook/${type}] Error: ${err.message}`);
        if (autoReply && type === "telegram" && chatId) {
          try {
            await sendTelegramMessage(conn.baseUrl, chatId, `❌ ${err.message}`);
          } catch (_) {}
        }
      }
    });

    mounted.push({ type, path: wPath, conn });
  }

  return mounted;
}

// Auto-register webhooks with external services
async function registerWebhooks(config, mountedRoutes) {
  if (!mountedRoutes.length) return;

  const publicUrl = (config.server?.publicUrl || "").replace(/\/$/, "");
  const line      = "─".repeat(52);

  console.log(`\n${line}`);
  console.log(`  🔗  Webhook Endpoints`);
  console.log(`${line}`);

  for (const { type, path: wPath, conn } of mountedRoutes) {
    const name = conn.connection_name || type;

    if (type === "telegram") {
      if (!publicUrl) {
        console.log(`  ⚠  ${name}`);
        console.log(`      Set config.server.publicUrl to auto-register.`);
        console.log(`      Manual: curl -X POST "${conn.baseUrl}/setWebhook" \\`);
        console.log(`                   -d '{"url":"https://YOUR_URL${wPath}"}'`);
        continue;
      }
      const webhookUrl = `${publicUrl}${wPath}`;
      try {
        await apiPost(`${conn.baseUrl}/setWebhook`, {
          url:             webhookUrl,
          allowed_updates: ["message", "edited_message", "channel_post"],
        });
        console.log(`  ✅  ${name}`);
        console.log(`      Auto-registered: ${webhookUrl}`);
      } catch (err) {
        console.error(`  ❌  ${name}  Registration failed: ${err.message}`);
        console.log(`      Manual: curl -X POST "${conn.baseUrl}/setWebhook" \\`);
        console.log(`                   -d '{"url":"${webhookUrl}"}'`);
      }

    } else if (type === "slack") {
      const webhookUrl = publicUrl ? `${publicUrl}${wPath}` : `https://YOUR_URL${wPath}`;
      console.log(`  ℹ  ${name}`);
      console.log(`      Paste in Slack app → Event Subscriptions:`);
      console.log(`      ${webhookUrl}`);

    } else if (type === "github") {
      const webhookUrl = publicUrl ? `${publicUrl}${wPath}` : `https://YOUR_URL${wPath}`;
      console.log(`  ℹ  ${name}`);
      console.log(`      Paste in GitHub repo → Settings → Webhooks:`);
      console.log(`      ${webhookUrl}`);
    }
  }

  console.log(`${line}\n`);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

exports.start = function start(config) {
  const express = require("express");
  const app     = express();

  const port   = config.server?.port   || 3333;
  const apiKey = config.server?.apiKey || null;
  const cwd    = process.cwd();

  app.use(express.json({ limit: "4mb" }));

  // Load project (oe-project.json) from current working directory
  const project = loadProject(cwd);

  // ── /webhook/* routes — NO auth, called by Telegram / Slack / GitHub ────────
  const mountedRoutes = mountWebhookRoutes(app, config, project, cwd);

  // ── API key auth (all routes below this are protected) ───────────────────────
  if (apiKey) {
    app.use((req, res, next) => {
      const provided = req.headers["x-api-key"]
                    || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
      if (provided !== apiKey) return res.status(401).json({ error: "Unauthorized" });
      next();
    });
  }

  // ── GET /health ──────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: VERSION });
  });

  // ── GET /status ──────────────────────────────────────────────────────────────
  app.get("/status", (_req, res) => {
    const uptimeMs   = Date.now() - serverStartTime;
    const connectors = (config.connectors || [])
      .map(c => ({ name: c.connection_name || c.name, type: c.connection_type || c.type }));

    res.json({
      status:     "ok",
      version:    VERSION,
      uptime_ms:  uptimeMs,
      llm:        { provider: config.llm?.provider, model: config.llm?.model },
      connectors,
      project:    project ? { name: project.name, version: project.version, agents: project.agents?.length || 0 } : null,
    });
  });

  // ── POST /command — universal command endpoint (same as chat commands) ───────
  // Body: { text: string, platform?: string, chat_id?: string, user?: string }
  app.post("/command", async (req, res) => {
    const { text, platform = "http", chat_id = "api", user = "api" } = req.body || {};
    if (!text) return res.status(400).json({ error: "text is required" });

    const t0 = Date.now();
    try {
      const reply = await handleWebhookMessage({ platform, config, project, cwd, chatId: chat_id, user, text });
      res.json({ success: true, reply, duration_ms: Date.now() - t0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, duration_ms: Date.now() - t0 });
    }
  });

  // ── POST /run ────────────────────────────────────────────────────────────────
  app.post("/run", async (req, res) => {
    const { yaml: yamlText, params = {}, input = null } = req.body || {};
    if (!yamlText) return res.status(400).json({ error: "yaml is required" });

    let agentYaml;
    try { agentYaml = yaml.load(yamlText); }
    catch (e) { return res.status(400).json({ error: "Invalid YAML: " + e.message }); }

    const t0 = Date.now();
    try {
      const result = await runAgentServer(null, agentYaml, config, input, params, 0);
      res.json({ success: true, ...result, duration_ms: Date.now() - t0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, duration_ms: Date.now() - t0 });
    }
  });

  // ── POST /run-file ───────────────────────────────────────────────────────────
  app.post("/run-file", async (req, res) => {
    const { file, params = {}, input = null } = req.body || {};
    if (!file)                   return res.status(400).json({ error: "file is required" });
    if (!fs.existsSync(file))    return res.status(404).json({ error: "file not found: " + file });

    let agentYaml;
    try { agentYaml = yaml.load(fs.readFileSync(file, "utf8")); }
    catch (e) { return res.status(400).json({ error: "Invalid YAML: " + e.message }); }

    const t0 = Date.now();
    try {
      const result = await runAgentServer(file, agentYaml, config, input, params, 0);
      res.json({ success: true, ...result, duration_ms: Date.now() - t0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, duration_ms: Date.now() - t0 });
    }
  });

  // ── POST /approve-chain ──────────────────────────────────────────────────────
  app.post("/approve-chain", async (req, res) => {
    const { chain_id, approved = true } = req.body || {};
    if (!chain_id) return res.status(400).json({ error: "chain_id is required" });

    const pending = pendingChains.get(chain_id);
    if (!pending) return res.status(404).json({ error: "chain_id not found or already used" });

    pendingChains.delete(chain_id);

    if (!approved) return res.json({ success: true, approved: false, message: "Chain rejected" });

    const { nextPath, contextOutput, params, depth } = pending;

    let agentYaml;
    try { agentYaml = yaml.load(fs.readFileSync(nextPath, "utf8")); }
    catch (e) { return res.status(500).json({ success: false, error: "Failed to load chain agent: " + e.message }); }

    const contextInput = `Context from previous agent:\n\n${contextOutput}\n\nNow execute your task.`;
    const t0 = Date.now();

    try {
      const result = await runAgentServer(nextPath, agentYaml, config, contextInput, params, depth);
      res.json({ success: true, approved: true, ...result, duration_ms: Date.now() - t0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, duration_ms: Date.now() - t0 });
    }
  });

  // ── start listening ──────────────────────────────────────────────────────────
  app.listen(port, async () => {
    const line = "─".repeat(52);
    console.log(`\n${line}`);
    console.log(`  🚀  OE Runtime Server  v${VERSION}`);
    console.log(`      Run AI agents via HTTP`);
    console.log(`${line}`);
    console.log(`  Listening  http://localhost:${port}`);
    console.log(`  GET  /health          — liveness check`);
    console.log(`  GET  /status          — health + project + connectors`);
    console.log(`  POST /command         — universal command endpoint`);
    console.log(`  POST /run             — run agent from inline YAML`);
    console.log(`  POST /run-file        — run agent from YAML file on disk`);
    console.log(`  POST /approve-chain   — approve or reject a pending manual chain`);

    if (mountedRoutes.length) {
      for (const { type, path: wPath } of mountedRoutes) {
        console.log(`  POST ${wPath.padEnd(20)}— ${type} webhook receiver`);
      }
    }

    if (apiKey) {
      console.log(`  Auth  x-api-key required  (webhooks + /health exempt)`);
    } else {
      console.log(`  Auth  none  (set config.server.apiKey to protect)`);
    }

    console.log(`${line}\n`);

    // Auto-register webhooks after server is listening
    if (mountedRoutes.length) {
      await registerWebhooks(config, mountedRoutes);
    }
  });
};
