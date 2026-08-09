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
const apiKeyRoutes     = require("./routes/apiKeys");
const connectorRoutes  = require("./routes/connectors");
const oauthRoutes      = require("./routes/oauth");
const agentRoutes        = require("./routes/agents");
const marketplaceRoutes  = require("./routes/marketplace");
const scheduler        = require("./utils/scheduler");
const v1Routes         = require("./routes/v1");
const swaggerUi        = require("swagger-ui-express");
const openApiSpec      = { ...require("./docs/openapi.json"), info: { ...require("./docs/openapi.json").info, version } };
const ingestionQueue   = require("./utils/ingestionQueue");

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.SERVER_PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => { req.db = prisma; next(); });

const commercialRoutesPath = path.resolve(__dirname, "../../commercial/routes");
const isCommercial = fs.existsSync(commercialRoutesPath);
if (isCommercial) {
  try {
    require(commercialRoutesPath).register(app);
    console.log("[Commercial] Routes loaded");
  } catch (e) {
    console.log("[Commercial] Failed to load routes:", e.message);
  }
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
app.use("/api/admin/api-keys",  apiKeyRoutes);
app.use("/api/admin",          connectorRoutes);
app.use("/api/oauth",          oauthRoutes);
app.use("/api/admin",          agentRoutes);
app.use("/api/marketplace",    marketplaceRoutes);

// Swagger UI — public, must be registered before the authenticated v1 router
app.get("/api/v1/docs/openapi.json", (_req, res) => res.json(openApiSpec));

// Postman Collection v2.1 — grouped by tag so every endpoint lands in the right folder
app.get("/api/v1/docs/postman.json", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const METHOD_ORDER = ["get","post","put","patch","delete"];

  // Build tag → items map
  const folders = {};
  (openApiSpec.tags || []).forEach(t => { folders[t.name] = { name: t.name, description: t.description, item: [] }; });

  Object.entries(openApiSpec.paths || {}).forEach(([rawPath, pathObj]) => {
    METHOD_ORDER.forEach(method => {
      const op = pathObj[method];
      if (!op) return;
      const tag = op.tags?.[0] || "Other";
      if (!folders[tag]) folders[tag] = { name: tag, item: [] };

      // Convert {param} → :param for Postman path variable syntax
      const postmanPath = rawPath.replace(/\{(\w+)\}/g, ":$1");
      const urlRaw = `{{base_url}}/api/v1${postmanPath}`;
      const pathParts = ["api", "v1", ...postmanPath.replace(/^\//, "").split("/")];

      const headers = [];
      if (["post","put","patch"].includes(method) && op.requestBody?.content?.["application/json"]) {
        headers.push({ key: "Content-Type", value: "application/json", type: "text" });
      }

      // Build body
      let body = { mode: "none" };
      const jsonSchema = op.requestBody?.content?.["application/json"]?.schema;
      if (jsonSchema?.properties) {
        const example = Object.fromEntries(Object.entries(jsonSchema.properties).map(([k,v]) => [k, v.example ?? `<${v.type}>`]));
        body = { mode: "raw", raw: JSON.stringify(example, null, 2), options: { raw: { language: "json" } } };
      }
      const multipartSchema = op.requestBody?.content?.["multipart/form-data"]?.schema;
      if (multipartSchema?.properties) {
        body = { mode: "formdata", formdata: Object.keys(multipartSchema.properties).map(k => ({ key: k, type: k === "file" ? "file" : "text", src: k === "file" ? [] : undefined })) };
      }

      const pathVars = (op.parameters || []).filter(p => p.in === "path").map(p => ({ key: p.name, value: "", description: p.description || "" }));
      const queryVars = (op.parameters || []).filter(p => p.in === "query").map(p => ({ key: p.name, value: String(p.schema?.default ?? ""), description: p.description || "", disabled: !p.required }));

      folders[tag].item.push({
        name: op.summary || `${method.toUpperCase()} ${rawPath}`,
        request: {
          method: method.toUpperCase(),
          header: headers,
          body,
          url: {
            raw: urlRaw,
            host: ["{{base_url}}"],
            path: pathParts,
            variable: pathVars.length ? pathVars : undefined,
            query: queryVars.length ? queryVars : undefined,
          },
          description: op.description || "",
        },
      });
    });
  });

  const collection = {
    info: {
      name: openApiSpec.info.title,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      description: openApiSpec.info.description,
    },
    auth: { type: "bearer", bearer: [{ key: "token", value: "emb_your_key_here", type: "string" }] },
    item: Object.values(folders),
    variable: [
      { key: "base_url", value: baseUrl, type: "string" },
    ],
  };

  res.setHeader("Content-Disposition", "attachment; filename=\"open-enthrium-postman.json\"");
  res.json(collection);
});

app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customSiteTitle: "Open Enthrium API Docs",
  customCss: ".swagger-ui .topbar { display: none }",
  swaggerOptions: { persistAuthorization: true, defaultModelsExpandDepth: -1 },
}));

app.use("/api/v1",         v1Routes);

app.get("/api/health", (_req, res) => res.json({ status: "ok", version }));

// Feature flags — readable by any authenticated user
app.get("/api/features", async (req, res) => {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["feature.kbSharing", "feature.agentSharing", "feature.connectorSharing"] } },
    });
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({
      kbSharing:        s["feature.kbSharing"]        === "true",
      agentSharing:     s["feature.agentSharing"]     === "true",
      connectorSharing: s["feature.connectorSharing"] === "true",
    });
  } catch { res.json({ kbSharing: false, agentSharing: false, connectorSharing: false }); }
});

// Sync any new connector types added since last startup (community adapters, new JSON entries).
// Uses createMany + skipDuplicates — fast single bulk call, never overwrites existing rows.
async function syncConnectionMasters(db) {
  try {
    const all         = require("./data/connectionTypes.json");
    const adapterDir  = path.join(__dirname, "utils/tools/adapters");
    const implemented = new Set(fs.readdirSync(adapterDir).map(f => f.replace(".js", "")));
    const HTTP        = JSON.stringify([
      { key: "baseUrl", label: "Base URL",            type: "text", required: true,  placeholder: "https://api.example.com/v1" },
      { key: "headers", label: "Auth Headers (JSON)", type: "json", required: false, placeholder: '{"Authorization":"Bearer YOUR_TOKEN"}' },
    ]);

    // Fetch existing keys to avoid duplicates (skipDuplicates not supported on all DBs)
    const existing = new Set(
      (await db.connectionMaster.findMany({ select: { key: true } })).map(r => r.key)
    );

    const newEntries = all
      .filter(t => !existing.has(t.id))
      .map(t => ({
        key:         t.id,
        label:       t.label,
        category:    t.cat,
        color:       t.color,
        initial:     t.initial,
        adapterType: implemented.has(t.id) ? t.id : "rest-api",
        fields:      HTTP,
      }));

    if (newEntries.length > 0) {
      await db.connectionMaster.createMany({ data: newEntries });
      console.log(`[Connectors] Auto-synced ${newEntries.length} new connector type(s)`);
    }
  } catch (err) {
    console.warn("[Connectors] Sync skipped:", err.message);
  }
}

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
  await syncConnectionMasters(prisma);
  await recoverPendingJobs();
  await scheduler.init(prisma);
  try { await require("./telemetry/bootstrap")(prisma); } catch {}
});
