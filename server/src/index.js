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
const oauthRoutes      = require("./routes/oauth");
const agentRoutes      = require("./routes/agents");
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
app.use("/api/oauth",          oauthRoutes);
app.use("/api/admin",          agentRoutes);
app.use("/api/admin/workspaces/:workspaceId/projects", projectRoutes);
app.use("/api/admin/templates", templateRoutes);

app.get("/api/health", (_req, res) => res.json({ status: "ok", version }));

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
});
