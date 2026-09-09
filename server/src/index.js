require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));

const authRoutes      = require("./routes/auth");
const workspaceRoutes = require("./routes/workspaces");
const documentRoutes  = require("./routes/documents");
const chatRoutes      = require("./routes/chat");
const threadRoutes    = require("./routes/threads");
const adminRoutes     = require("./routes/admin");
const settingsRoutes  = require("./routes/settings");
const modelsRoutes    = require("./routes/models");
const audioRoutes      = require("./routes/audio");
const dashboardRoutes  = require("./routes/dashboard");
const embedRoutes      = require("./routes/embed");
const oauthRoutes      = require("./routes/oauth");
const agentRoutes      = require("./routes/agents");
const mcpServerRoutes  = require("./routes/mcpServers");
const projectRoutes    = require("./routes/projects");
const templateRoutes   = require("./routes/templates");
const ingestionQueue   = require("./utils/ingestionQueue");

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.SERVER_PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => { req.db = prisma; next(); });

const commercialRoutesPath = path.resolve(__dirname, "../../commercial/routes");
// isCommercial: folder must exist AND LICENSE_TYPE must not be forced to "community"
const isCommercial = fs.existsSync(commercialRoutesPath)
  && (process.env.LICENSE_TYPE || "commercial").toLowerCase() !== "community";
if (isCommercial) {
  try {
    require(commercialRoutesPath).register(app);
    console.log("[Commercial] Routes loaded");
  } catch (e) {
    console.log("[Commercial] Failed to load routes:", e.message);
  }
} else if (fs.existsSync(commercialRoutesPath)) {
  console.log("[Commercial] Folder present but LICENSE_TYPE=community — running as community");
}

app.get("/api/instance", async (req, res) => {
  const isEnterprise = isCommercial;

  const licenseType = isEnterprise ? "enterprise"                : "community";
  const edition     = isEnterprise ? "Open Enthrium Commercial" : "Open Enthrium Community";
  const price       = isEnterprise ? "custom"                    : "free";

  try {
    const [brandingName, brandingUrl, brandingLogo] = await Promise.all([
      req.db.setting.findUnique({ where: { key: "branding_name" } }),
      req.db.setting.findUnique({ where: { key: "branding_url"  } }),
      req.db.setting.findUnique({ where: { key: "branding_logo" } }),
    ]);
    res.set("Cache-Control", "no-store");
    res.json({
      licenseType,
      edition,
      price,
      brandingName: brandingName?.value || null,
      brandingUrl:  brandingUrl?.value  || null,
      brandingLogo: brandingLogo?.value || null,
    });
  } catch {
    res.set("Cache-Control", "no-store");
    res.json({ licenseType, edition, price, brandingName: null, brandingUrl: null, brandingLogo: null });
  }
});

app.use("/api/auth",       authRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/documents",  documentRoutes);
app.use("/api/chat",       chatRoutes);
app.use("/api/threads",    threadRoutes);
app.use("/api/admin",      adminRoutes);
app.use("/api/settings",   settingsRoutes);
app.use("/api/models",     modelsRoutes);
app.use("/api/audio",      audioRoutes);
app.use("/api/dashboard",  dashboardRoutes);
app.use("/api/embed",          embedRoutes);
app.use("/api/oauth",          oauthRoutes);
app.use("/api/admin",          agentRoutes);
app.use("/api/admin/workspaces/:workspaceId/projects", projectRoutes);
app.use("/api/admin/templates",   templateRoutes);
app.use("/api/admin/mcp-servers", mcpServerRoutes);

app.get("/api/health", (_req, res) => res.json({ status: "ok", version }));

// MCP status — any authenticated user can read this
app.get("/api/mcp-status", async (req, res) => {
  try {
    const http = require("http");
    const mcpPort = parseInt(process.env.MCP_PORT) || 3003;

    // Get all enabled MCP servers from DB
    const servers = await prisma.mcpServer.findMany({ where: { enabled: true }, orderBy: { id: "asc" } });
    const defaultSrv = servers.find(s => s.isDefault);

    // Only probe the MCP process if the built-in server is enabled in DB
    // (process keeps running even when disabled — don't report it as "connected")
    let onlineTools = 0;
    let online = false;
    if (defaultSrv) {
      try {
        const health = await new Promise((resolve, reject) => {
          const r = http.get(`http://127.0.0.1:${mcpPort}/health`, resp => {
            let d = ""; resp.on("data", c => d += c);
            resp.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
          });
          r.on("error", reject);
          r.setTimeout(2000, () => { r.destroy(); reject(new Error("timeout")); });
          r.end();
        });
        if (health?.status === "ok") { online = true; onlineTools = health.tools || 0; }
      } catch {}
    }
    let connectors = [];
    if (defaultSrv?.connectorConfig) {
      try {
        const cfg = JSON.parse(defaultSrv.connectorConfig);
        connectors = (cfg.connectors || []).map((c, i) => ({
          name: c.name, type: c.type, toolPrefix: `conn_${i + 1}_`,
        }));
      } catch {}
    }

    // External servers (non-default, enabled)
    const externalServers = servers.filter(s => !s.isDefault).map(s => ({
      name: s.name, url: s.url,
    }));

    res.json({
      online,
      tools: onlineTools,
      connectors,
      externalServers,
      serverCount: servers.length,
    });
  } catch {
    res.json({ online: false, tools: 0, connectors: [], externalServers: [], serverCount: 0 });
  }
});

// Feature flags — readable by any authenticated user
app.get("/api/features", async (req, res) => {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["feature.kbSharing"] } },
    });
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({
      kbSharing: s["feature.kbSharing"] === "true",
    });
  } catch { res.json({ kbSharing: false }); }
});

async function recoverPendingJobs() {
  try {
    const stuck = await prisma.document.findMany({
      where:   { status: { in: ["queued", "ingesting"] } },
      include: { workspace: true }
    });
    if (!stuck.length) return;

    console.log(`[Queue] Recovering ${stuck.length} interrupted document(s)…`);

    for (const doc of stuck) {
      if (doc.type === "website-crawl") continue; // crawler tracker docs have no chunks of their own

      const reset = { status: "queued", chunksProcessed: 0, cancelRequested: false, errorMessage: null };

      if (doc.type === "url") {
        await prisma.document.update({ where: { uid: doc.uid }, data: reset });
        ingestionQueue.enqueue(prisma, doc.workspace, doc, doc.name, "url");
      } else if (doc.sourcePath && fs.existsSync(doc.sourcePath)) {
        await prisma.document.update({ where: { uid: doc.uid }, data: reset });
        const sourceType = doc.type === "ocr" ? "ocr" : "file";
        const keepFile   = !doc.sourcePath.includes("uploads");
        ingestionQueue.enqueue(prisma, doc.workspace, doc, doc.sourcePath, sourceType, keepFile);
      } else {
        await prisma.document.update({
          where: { uid: doc.uid },
          data:  { status: "failed", errorMessage: "Source file unavailable after server restart. Please re-upload." }
        });
      }
    }
  } catch (err) {
    console.error("[Queue] Recovery error:", err.message);
  }
}

// Serve built frontend in production
if (process.env.NODE_ENV === "production") {
  const path = require("path");
  const publicDir = path.join(__dirname, "../../public");
  app.use(express.static(publicDir));
  app.get("*", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
}

app.listen(PORT, async () => {
  console.log(`Open Enthrium server running on port ${PORT}`);
  await recoverPendingJobs();
  await seedDefaultMcpServer();
  await startMcpServer();
});

async function seedDefaultMcpServer() {
  try {
    const existing = await prisma.mcpServer.findFirst({ where: { isDefault: true } });
    if (!existing) {
      const mcpPort = parseInt(process.env.MCP_PORT) || 3003;
      await prisma.mcpServer.create({
        data: {
          name:      "Open Enthrium MCP",
          url:       `http://127.0.0.1:${mcpPort}`,
          isDefault: true,
          enabled:   true,
        },
      });
      console.log("[MCP] Default MCP server entry created in DB");
    }
  } catch (e) {
    console.warn("[MCP] Could not seed default MCP server:", e.message);
  }
}

// ── Auto-start MCP server ────────────────────────────────────────────────────
async function startMcpServer() {
  const mcpScript = path.resolve(__dirname, "../mcp/index.js");
  const mcpPort   = parseInt(process.env.MCP_PORT) || 3003;

  if (!fs.existsSync(mcpScript)) {
    console.log("[MCP] mcp/index.js not found — skipping auto-start");
    return;
  }

  // Read LLM config from DB so MCP can run agents with the platform's LLM
  let llmEnv = {};
  try {
    const keys   = ["llm_provider","llm_api_key","llm_model","llm_base_url","llm_azure_endpoint","llm_azure_deployment"];
    const rows   = await prisma.setting.findMany({ where: { key: { in: keys } } });
    const s      = Object.fromEntries(rows.map(r => [r.key, r.value]));
    llmEnv = {
      OE_LLM_PROVIDER:           s.llm_provider           || "",
      OE_LLM_API_KEY:            s.llm_api_key            || "",
      OE_LLM_MODEL:              s.llm_model              || "",
      OE_LLM_BASE_URL:           s.llm_base_url           || "",
      OE_LLM_AZURE_ENDPOINT:     s.llm_azure_endpoint     || "",
      OE_LLM_AZURE_DEPLOYMENT:   s.llm_azure_deployment   || "",
    };
  } catch (e) {
    console.warn("[MCP] Could not read LLM config from DB:", e.message);
  }

  // Read connector config for the built-in MCP server from DB
  let connectorConfig = null;
  try {
    const defaultSrv = await prisma.mcpServer.findFirst({ where: { isDefault: true } });
    if (defaultSrv?.connectorConfig) {
      connectorConfig = JSON.parse(defaultSrv.connectorConfig);
    }
  } catch (e) {
    console.warn("[MCP] Could not read connector config from DB:", e.message);
  }

  // Helper — push LLM + connector config to a running MCP via POST /config
  function pushConfig() {
    const payload = {};
    if (llmEnv.OE_LLM_PROVIDER || llmEnv.OE_LLM_API_KEY) {
      payload.llm = {
        provider:         llmEnv.OE_LLM_PROVIDER,
        apiKey:           llmEnv.OE_LLM_API_KEY,
        model:            llmEnv.OE_LLM_MODEL,
        baseURL:          llmEnv.OE_LLM_BASE_URL          || undefined,
        azureEndpoint:    llmEnv.OE_LLM_AZURE_ENDPOINT    || undefined,
        azureDeployment:  llmEnv.OE_LLM_AZURE_DEPLOYMENT  || undefined,
      };
    }
    if (connectorConfig) payload.connectors = connectorConfig.connectors || connectorConfig;
    if (!Object.keys(payload).length) return;
    const connCount = Array.isArray(payload.connectors) ? payload.connectors.length : 0;
    console.log(`[MCP] Pushing config to MCP → ${connCount} connector(s)`);
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: "127.0.0.1", port: mcpPort, path: "/config", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { const r = JSON.parse(d); if (!r.ok) console.warn("[MCP] Config push returned not-ok:", d); }
        catch {}
      });
    });
    req.on("error", (e) => console.warn(`[MCP] Config push failed: ${e.message}`));
    req.write(body);
    req.end();
  }

  // Check if MCP is already running on that port before spawning
  const http = require("http");
  const check = http.get(`http://127.0.0.1:${mcpPort}/health`, (res) => {
    let d = "";
    res.on("data", c => d += c);
    res.on("end", () => {
      try {
        const body = JSON.parse(d);
        console.log(`[MCP] Already running → http://localhost:${mcpPort} (${body.tools} tools)`);
      } catch {
        console.log(`[MCP] Already running → http://localhost:${mcpPort}`);
      }
      // Push LLM config to the running MCP so it uses the platform's provider
      pushConfig();
    });
  });

  check.on("error", () => {
    // Not running — spawn it
    const { spawn } = require("child_process");
    const args = [mcpScript];
    const mcpProc = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env:   { ...process.env, ...llmEnv },
    });

    mcpProc.stdout.on("data", d => process.stdout.write(`[MCP] ${d}`));
    mcpProc.stderr.on("data", d => process.stderr.write(`[MCP] ${d}`));
    mcpProc.on("exit", code => console.log(`[MCP] Server exited with code ${code}`));

    console.log(`[MCP] Server starting → http://localhost:${mcpPort}`);
    // Give it 3s to start then push LLM + connector config
    setTimeout(pushConfig, 3000);
  });

  check.setTimeout(2000, () => { check.destroy(); });
  check.end();
}
