const router = require("express").Router();
const { authenticate, requireManagerOrAdmin } = require("../middleware/auth");
const { deleteDocumentChunks } = require("../utils/vectorStore");
const { getLLMClient, getSetting } = require("../providers/llm");
const { getTierFromDB } = require("../utils/tier");
const ingestionQueue = require("../utils/ingestionQueue");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const UPLOAD_DIR     = path.join(__dirname, "../../storage/uploads/");
const OCR_UPLOAD_DIR = path.join(__dirname, "../../storage/ocr-uploads/");
const upload    = multer({ dest: UPLOAD_DIR });
const uploadOcr = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(OCR_UPLOAD_DIR, { recursive: true }); cb(null, OCR_UPLOAD_DIR); },
    filename:    (req, file, cb) => { cb(null, require("uuid").v4() + path.extname(file.originalname).toLowerCase()); }
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Storage info for the documents panel
router.get("/:slug/storage-info", authenticate, async (req, res) => {
  try {
    const tier = await getTierFromDB(req.db);
    const maxFileSizeSetting = await req.db.setting.findUnique({ where: { key: "storage.maxFileSizeMb" } });
    const maxFileSizeMb = maxFileSizeSetting?.value ? parseInt(maxFileSizeSetting.value) : 100;
    const result = await req.db.document.aggregate({ _sum: { size: true } });
    const usedBytes = result._sum.size || 0;
    res.json({
      usedBytes,
      usedGb:      parseFloat((usedBytes / (1024 ** 3)).toFixed(3)),
      limitGb:     isFinite(tier.ingestionSpaceGb) ? tier.ingestionSpaceGb : null,
      maxFileSizeMb,
    });
  } catch (err) {
    console.error("[documents] storage-info error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// List documents for a workspace
router.get("/:slug", authenticate, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  const documents = await req.db.document.findMany({
    where:   { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" }
  });
  const connectorIds = [...new Set(documents.map(d => d.connectorId).filter(Boolean))];
  const connectors = connectorIds.length
    ? await req.db.connector.findMany({ where: { id: { in: connectorIds } }, select: { id: true, name: true } })
    : [];
  const connectorMap = Object.fromEntries(connectors.map(c => [c.id, c.name]));
  const enriched = documents.map(d => ({ ...d, connectorName: d.connectorId ? connectorMap[d.connectorId] : undefined }));
  res.json({ documents: enriched });
});

// Upload file(s)
router.post("/:slug/upload", authenticate, requireManagerOrAdmin, upload.single("file"), async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  if (!req.file)   return res.status(400).json({ error: "No file uploaded" });

  // Enforce max file size (default 100 MB, overridable by super admin)
  const maxFileSizeSetting = await req.db.setting.findUnique({ where: { key: "storage.maxFileSizeMb" } });
  const maxFileSizeMb = maxFileSizeSetting?.value ? parseInt(maxFileSizeSetting.value) : 100;
  if (req.file.size > maxFileSizeMb * 1024 * 1024) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `File too large. Max allowed: ${maxFileSizeMb} MB` });
  }

  // Enforce storage limit
  const tier = await getTierFromDB(req.db);
  if (isFinite(tier.ingestionSpaceGb)) {
    const result = await req.db.document.aggregate({ _sum: { size: true } });
    const usedBytes = result._sum.size || 0;
    const limitBytes = tier.ingestionSpaceGb * 1024 * 1024 * 1024;
    if (usedBytes + req.file.size > limitBytes) {
      fs.unlink(req.file.path, () => {});
      const usedGb = (usedBytes / (1024 ** 3)).toFixed(2);
      return res.status(400).json({ error: `Storage limit reached (${usedGb} / ${tier.ingestionSpaceGb} GB used)` });
    }
  }

  const uid     = uuidv4();
  const batchId = req.headers["x-batch-id"] ? `upload:${req.headers["x-batch-id"]}` : null;
  const doc = await req.db.document.create({
    data: {
      uid,
      name:        req.file.originalname,
      type:        req.file.mimetype,
      size:        req.file.size,
      workspaceId: workspace.id,
      status:      "queued",
      sourcePath:  req.file.path,
      batchId
    }
  });

  ingestionQueue.enqueue(req.db, workspace, doc, req.file.path, "file", false, req.user.id);
  res.json({ document: doc });
});

// Ingest URL
router.post("/:slug/ingest-url", authenticate, requireManagerOrAdmin, handleUrlIngest);
router.post("/:slug/url",        authenticate, requireManagerOrAdmin, handleUrlIngest);

async function handleUrlIngest(req, res) {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const uid = uuidv4();
  const doc = await req.db.document.create({
    data: { uid, name: url, type: "url", workspaceId: workspace.id, status: "queued" }
  });

  ingestionQueue.enqueue(req.db, workspace, doc, url, "url", false, req.user.id);
  res.json({ document: doc });
}

// Ingest GitHub repository
router.post("/:slug/ingest-github", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { repoUrl, token, branch = "main" } = req.body;
  if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });

  // Parse owner/repo from URL or shorthand
  let owner, repo;
  try {
    const cleaned = repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
    const match   = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/) || cleaned.match(/^([^/]+)\/([^/]+)$/);
    if (!match) throw new Error();
    [, owner, repo] = match;
  } catch {
    return res.status(400).json({ error: "Invalid GitHub repo URL. Use format: https://github.com/owner/repo or owner/repo" });
  }

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const axios  = require("axios");
  const os     = require("os");
  const headers = token ? { Authorization: `Bearer ${token}`, "User-Agent": "OpenEnterprise" } : { "User-Agent": "OpenEnterprise" };

  // Supported text/code extensions
  const TEXT_EXTS = new Set([
    ".js",".jsx",".ts",".tsx",".mjs",".cjs",
    ".py",".rb",".go",".java",".cs",".php",".swift",".kt",".rs",".cpp",".c",".h",".hpp",
    ".md",".txt",".rst",".adoc",".mdx",
    ".json",".yaml",".yml",".toml",".ini",".env",".conf",".config",
    ".sh",".bash",".zsh",".fish",
    ".sql",".html",".css",".scss",".sass",".less",".xml",".csv",
    ".tf",".hcl",".dockerfile",
  ]);
  const SKIP_DIRS = new Set(["node_modules",".git","dist","build","vendor",".next","__pycache__",".cache","coverage"]);

  let tree;
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      { headers }
    );
    tree = data.tree;
  } catch (err) {
    const msg = err.response?.status === 404
      ? `Repo "${owner}/${repo}" not found (or branch "${branch}" doesn't exist)`
      : err.response?.status === 401 ? "Invalid GitHub token"
      : `GitHub API error: ${err.response?.data?.message || err.message}`;
    return res.status(400).json({ error: msg });
  }

  // Filter to text files, skip ignored dirs and large blobs
  const files = tree.filter(f => {
    if (f.type !== "blob") return false;
    const parts = f.path.split("/");
    if (parts.some(p => SKIP_DIRS.has(p))) return false;
    const ext = path.extname(f.path).toLowerCase();
    if (!TEXT_EXTS.has(ext) && !["dockerfile","makefile","procfile","gemfile","rakefile","cmakelists.txt"].includes(path.basename(f.path).toLowerCase())) return false;
    if (f.size && f.size > 500_000) return false; // skip >500KB files
    return true;
  }).slice(0, 200); // max 200 files per ingest

  if (!files.length) return res.status(400).json({ error: "No supported text/code files found in repository" });

  const tmpDir = path.join(os.tmpdir(), `oe-github-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  let queued = 0, skipped = 0;
  for (const file of files) {
    try {
      const rawUrl  = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
      const { data: content } = await axios.get(rawUrl, { headers, responseType: "text" });

      const safeFilename = file.path.replace(/\//g, "__");
      const tmpPath = path.join(tmpDir, safeFilename);
      fs.writeFileSync(tmpPath, content, "utf8");
      const stat = fs.statSync(tmpPath);

      const uid = uuidv4();
      const doc = await req.db.document.create({
        data: {
          uid,
          name:        `${owner}/${repo}/${file.path}`,
          type:        path.extname(file.path).slice(1) || "txt",
          size:        stat.size,
          workspaceId: workspace.id,
          status:      "queued",
          sourcePath:  tmpPath,
        }
      });
      ingestionQueue.enqueue(req.db, workspace, doc, tmpPath, "file", false, req.user.id);
      queued++;
    } catch { skipped++; }
  }

  res.json({ queued, skipped, total: files.length, repo: `${owner}/${repo}`, branch });
});

// List Google Drive folders (for picker UI)
router.get("/:slug/gdrive-folders", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { connectorId } = req.query;
  if (!connectorId) return res.status(400).json({ error: "connectorId required" });

  const connector = await req.db.connector.findUnique({ where: { id: parseInt(connectorId) } });
  if (!connector || connector.type !== "gdrive") return res.status(404).json({ error: "Google Drive connector not found" });

  try {
    const { buildDriveClient } = require("../utils/tools/adapters/gdrive");
    const authConfig = JSON.parse(connector.authConfig || "{}");
    const drive = await buildDriveClient(authConfig, req.db, connector.workspaceId);
    const res2 = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      pageSize: 50,
      fields: "files(id, name)",
      orderBy: "name",
    });
    res.json({ folders: res2.data.files || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all cloud storage connectors (gdrive, onedrive, dropbox, box)
const PROVIDER_LABELS = { gdrive: "Google Drive", onedrive: "OneDrive", dropbox: "Dropbox", box: "Box" };
router.get("/:slug/cloud-connectors", authenticate, requireManagerOrAdmin, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  const connectors = await req.db.connector.findMany({ where: { workspaceId: workspace.id, type: { in: ["gdrive", "onedrive", "dropbox", "box"] } } });
  res.json({ connectors: connectors.map(c => ({ id: c.id, name: c.name, type: c.type, provider: PROVIDER_LABELS[c.type] || c.type })) });
});

// Keep backward-compat alias
router.get("/:slug/gdrive-connectors", authenticate, requireManagerOrAdmin, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  const connectors = await req.db.connector.findMany({ where: { workspaceId: workspace.id, type: "gdrive" } });
  res.json({ connectors: connectors.map(c => ({ id: c.id, name: c.name, provider: "Google Drive" })) });
});

// Ingest all files from a Google Drive folder
router.post("/:slug/ingest-gdrive-folder", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { connectorId, folderId, folderName } = req.body;
  if (!connectorId || !folderId) return res.status(400).json({ error: "connectorId and folderId required" });

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const connector = await req.db.connector.findUnique({ where: { id: parseInt(connectorId) } });
  if (!connector || connector.type !== "gdrive") return res.status(404).json({ error: "Google Drive connector not found" });

  try {
    const { buildDriveClient } = require("../utils/tools/adapters/gdrive");
    const { google } = require("googleapis");
    const XLSX = require("xlsx");
    const authConfig = JSON.parse(connector.authConfig || "{}");
    const drive = await buildDriveClient(authConfig, req.db, connector.workspaceId);

    const SUPPORTED_MIME = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "text/plain",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/json",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.document",
    ];

    // Detect if it's a single file or a folder
    const fileMeta = await drive.files.get({ fileId: folderId, fields: "id, name, mimeType" }).catch(() => null);
    const isFile = fileMeta && fileMeta.data.mimeType !== "application/vnd.google-apps.folder";

    let files;
    if (isFile) {
      files = SUPPORTED_MIME.includes(fileMeta.data.mimeType) ? [fileMeta.data] : [];
      if (!files.length) return res.status(400).json({ error: `File type "${fileMeta.data.mimeType}" is not supported` });
    } else {
      const listRes = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        pageSize: 200,
        fields: "files(id, name, mimeType, size)",
      });
      files = (listRes.data.files || []).filter(f => SUPPORTED_MIME.includes(f.mimeType));
      if (!files.length) return res.status(400).json({ error: "No supported files found in this Drive folder" });
    }

    const GDRIVE_TMP = path.join(__dirname, "../../storage/gdrive-tmp/");
    fs.mkdirSync(GDRIVE_TMP, { recursive: true });

    let queued = 0, skipped = 0;

    for (const file of files) {
      try {
        const isGSheet = file.mimeType === "application/vnd.google-apps.spreadsheet";
        const isGDoc   = file.mimeType === "application/vnd.google-apps.document";
        const tmpName  = uuidv4() + (isGSheet ? ".csv" : isGDoc ? ".txt" : path.extname(file.name) || ".bin");
        const tmpPath  = path.join(GDRIVE_TMP, tmpName);
        const writer   = fs.createWriteStream(tmpPath);

        if (isGSheet) {
          const exportRes = await drive.files.export({ fileId: file.id, mimeType: "text/csv" }, { responseType: "stream" });
          await new Promise((resolve, reject) => {
            exportRes.data.pipe(writer);
            exportRes.data.on("end", resolve);
            exportRes.data.on("error", reject);
          });
        } else if (isGDoc) {
          const exportRes = await drive.files.export({ fileId: file.id, mimeType: "text/plain" }, { responseType: "stream" });
          await new Promise((resolve, reject) => {
            exportRes.data.pipe(writer);
            exportRes.data.on("end", resolve);
            exportRes.data.on("error", reject);
          });
        } else {
          const dlRes = await drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "stream" });
          await new Promise((resolve, reject) => {
            dlRes.data.pipe(writer);
            dlRes.data.on("end", resolve);
            dlRes.data.on("error", reject);
          });
        }

        const stat = fs.statSync(tmpPath);
        const docName = isGSheet ? file.name + ".csv" : isGDoc ? file.name + ".txt" : file.name;
        const uid = uuidv4();
        const doc = await req.db.document.create({
          data: {
            uid,
            name:        docName,
            type:        path.extname(tmpName).slice(1) || "bin",
            size:        stat.size,
            workspaceId: workspace.id,
            status:      "queued",
            sourcePath:  tmpPath,
            connectorId: connector.id,
          }
        });
        ingestionQueue.enqueue(req.db, workspace, doc, tmpPath, "file", false, req.user.id);
        queued++;
      } catch { skipped++; }
    }

    res.json({ queued, skipped, total: files.length, folder: folderName || folderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ingest local folder
router.post("/:slug/ingest-folder", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: "folderPath required" });

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const SUPPORTED = [".pdf", ".doc", ".docx", ".txt", ".md", ".csv", ".xlsx", ".xls", ".json"];

  function scanDir(dir) {
    let results = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return results; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) results.push(...scanDir(full));
      else if (e.isFile() && SUPPORTED.includes(path.extname(e.name).toLowerCase())) results.push(full);
    }
    return results;
  }

  let files;
  try { files = scanDir(folderPath); }
  catch { return res.status(400).json({ error: "Folder not found or not accessible: " + folderPath }); }

  if (!files.length) return res.status(400).json({ error: "No supported files found in folder" });

  const folderBatchId = `folder:${folderPath.trim()}`;
  const docs = await Promise.all(files.map(async filePath => {
    const name = path.basename(filePath);
    const uid  = uuidv4();
    const stat = fs.statSync(filePath);
    const doc  = await req.db.document.create({
      data: {
        uid,
        name,
        type:        path.extname(name).slice(1),
        size:        stat.size,
        workspaceId: workspace.id,
        status:      "queued",
        sourcePath:  filePath,
        batchId:     folderBatchId
      }
    });
    ingestionQueue.enqueue(req.db, workspace, doc, filePath, "file", true, req.user.id);
    return doc;
  }));

  res.json({ queued: docs.length, documents: docs });
});

// OCR — save image immediately, queue LLM Vision extraction as a background job
router.post("/:slug/ocr", authenticate, requireManagerOrAdmin, uploadOcr.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Image file required" });

  const ALLOWED = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/tiff", "image/bmp"];
  if (!ALLOWED.includes(req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "Unsupported image type" });
  }

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: "Workspace not found" }); }

  const docName = req.file.originalname.replace(/\.[^.]+$/, "") + " (OCR)";
  const uid     = uuidv4();
  const batchId = req.headers["x-batch-id"] ? `ocr:${req.headers["x-batch-id"]}` : null;
  const doc = await req.db.document.create({
    data: { uid, name: docName, type: "ocr", size: req.file.size, workspaceId: workspace.id, status: "queued", sourcePath: req.file.path, uploadedByUserId: req.user.id, batchId }
  });

  // LLM Vision call happens inside the queue worker — client gets response immediately
  ingestionQueue.enqueue(req.db, workspace, doc, req.file.path, "ocr", false, req.user.id);
  res.json({ document: doc });
});

// Ingest entire website (BFS crawl) — queued immediately, crawl runs in background
router.post("/:slug/ingest-website", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { startUrl, maxPages = 20, maxDepth = 2 } = req.body;
  if (!startUrl) return res.status(400).json({ error: "startUrl required" });

  try { new URL(startUrl); } catch { return res.status(400).json({ error: "Invalid URL" }); }

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const uid = uuidv4();
  const crawlParams = JSON.stringify({ startUrl, maxPages: parseInt(maxPages), maxDepth: parseInt(maxDepth) });
  const doc = await req.db.document.create({
    data: { uid, name: `Website: ${startUrl}`, type: "website-crawl", workspaceId: workspace.id, status: "queued", sourcePath: crawlParams, uploadedByUserId: req.user.id }
  });

  // BFS crawl + per-page ingestion happens entirely in the queue worker
  ingestionQueue.enqueue(req.db, workspace, doc, crawlParams, "website-crawl", false, req.user.id);
  res.json({ document: doc });
});

// Cancel in-progress ingestion
router.post("/:slug/:uid/cancel", authenticate, requireManagerOrAdmin, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const doc = await req.db.document.findFirst({
    where: { uid: req.params.uid, workspaceId: workspace.id }
  });
  if (!doc) return res.status(404).json({ error: "Document not found" });
  if (!["queued", "ingesting"].includes(doc.status)) {
    return res.status(400).json({ error: "Document is not currently being ingested" });
  }

  // If still queued (not yet picked up), mark partial/failed immediately
  if (doc.status === "queued") {
    await req.db.document.update({
      where: { uid: doc.uid },
      data:  { status: "failed", errorMessage: "Cancelled before ingestion started" }
    });
    return res.json({ cancelled: true });
  }

  // If already ingesting, set the flag and the queue worker will stop between batches
  await req.db.document.update({
    where: { uid: doc.uid },
    data:  { cancelRequested: true }
  });
  res.json({ cancelling: true });
});

// Retry a failed/partial document
router.post("/:slug/:uid/retry", authenticate, requireManagerOrAdmin, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const doc = await req.db.document.findFirst({ where: { uid: req.params.uid, workspaceId: workspace.id } });
  if (!doc) return res.status(404).json({ error: "Document not found" });

  if (doc.type !== "url" && (!doc.sourcePath || !fs.existsSync(doc.sourcePath))) {
    return res.status(400).json({ error: "Source file no longer available. Please re-upload." });
  }

  // Delete any partial vectors first
  await deleteDocumentChunks(workspace.slug, doc.uid);

  const updated = await req.db.document.update({
    where: { uid: doc.uid },
    data:  { status: "queued", chunkCount: 0, chunksProcessed: 0, totalChunks: 0, cancelRequested: false, errorMessage: null }
  });

  const source     = doc.type === "url" ? doc.name : doc.sourcePath;
  const sourceType = doc.type === "url" ? "url" : "file";
  const keepFile   = doc.sourcePath && !doc.sourcePath.includes("uploads");
  ingestionQueue.enqueue(req.db, workspace, updated, source, sourceType, keepFile, req.user.id);
  res.json({ document: updated });
});

// Unified cloud storage ingestion (Google Drive, OneDrive, Dropbox, Box)
router.post("/:slug/ingest-cloud-folder", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { connectorId, resourceId, resourceUrl } = req.body;
  if (!connectorId || !resourceId) return res.status(400).json({ error: "connectorId and resourceId required" });

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const connector = await req.db.connector.findUnique({ where: { id: parseInt(connectorId) } });
  if (!connector) return res.status(404).json({ error: "Connector not found" });

  if (connector.type === "gdrive") return res.status(400).json({ error: "Use /ingest-gdrive-folder for Google Drive" });

  const CLOUD_TMP = path.join(__dirname, "../../storage/cloud-tmp/");
  fs.mkdirSync(CLOUD_TMP, { recursive: true });

  try {
    let files = [];

    if (connector.type === "onedrive") {
      const { getToken } = require("../utils/tools/adapters/onedrive");
      const token = await getToken(connector, req.db);
      const axios = require("axios");
      const headers = { Authorization: `Bearer ${token}` };

      // Detect file vs folder
      const meta = await axios.get(`https://graph.microsoft.com/v1.0/me/drive/items/${resourceId}`, { headers }).catch(() => null);
      if (meta?.data?.file) {
        files = [{ id: resourceId, name: meta.data.name, downloadFn: async () => (await axios.get(`https://graph.microsoft.com/v1.0/me/drive/items/${resourceId}/content`, { headers, responseType: "arraybuffer" })).data }];
      } else {
        const list = await axios.get(`https://graph.microsoft.com/v1.0/me/drive/items/${resourceId}/children?$top=200`, { headers });
        files = (list.data.value || []).filter(f => f.file).map(f => ({ id: f.id, name: f.name,
          downloadFn: async () => (await axios.get(`https://graph.microsoft.com/v1.0/me/drive/items/${f.id}/content`, { headers, responseType: "arraybuffer" })).data }));
      }
    }

    if (connector.type === "dropbox") {
      const { getToken } = require("../utils/tools/adapters/dropbox");
      const token = await getToken(connector, req.db);
      const axios = require("axios");
      const listRes = await axios.post("https://api.dropboxapi.com/2/files/list_folder",
        { path: resourceId.startsWith("/") ? resourceId : `/${resourceId}` },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
      files = (listRes.data.entries || []).filter(e => e[".tag"] === "file").map(f => ({ id: f.id, name: f.name, path: f.path_display,
        downloadFn: async () => (await axios.post("https://content.dropboxapi.com/2/files/download", null, {
          headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: f.path_display }) }, responseType: "arraybuffer" })).data }));
    }

    if (connector.type === "box") {
      const { getToken } = require("../utils/tools/adapters/box");
      const token = await getToken(connector, req.db);
      const axios = require("axios");
      const headers = { Authorization: `Bearer ${token}` };
      const meta = await axios.get(`https://api.box.com/2.0/files/${resourceId}`, { headers }).catch(() => null);
      if (meta?.data?.type === "file") {
        files = [{ id: resourceId, name: meta.data.name, downloadFn: async () => (await axios.get(`https://api.box.com/2.0/files/${resourceId}/content`, { headers, responseType: "arraybuffer" })).data }];
      } else {
        const list = await axios.get(`https://api.box.com/2.0/folders/${resourceId}/items?limit=200`, { headers });
        files = (list.data.entries || []).filter(e => e.type === "file").map(f => ({ id: f.id, name: f.name,
          downloadFn: async () => (await axios.get(`https://api.box.com/2.0/files/${f.id}/content`, { headers, responseType: "arraybuffer" })).data }));
      }
    }

    if (!files.length) return res.status(400).json({ error: "No supported files found" });

    // Download and queue
    const SUPPORTED = [".pdf", ".docx", ".doc", ".txt", ".csv", ".xlsx", ".xls", ".json", ".md"];
    const queued = [];
    for (const file of files) {
      const ext = path.extname(file.name).toLowerCase();
      if (!SUPPORTED.includes(ext)) continue;
      try {
        const buf = await file.downloadFn();
        const tmpPath = path.join(CLOUD_TMP, `${Date.now()}-${file.name}`);
        fs.writeFileSync(tmpPath, Buffer.from(buf));
        const uid2 = require("uuid").v4();
        const doc = await req.db.document.create({ data: { uid: uid2, name: file.name, workspaceId: workspace.id, status: "queued", sourcePath: tmpPath, type: connector.type, connectorId: connector.id, uploadedByUserId: req.user?.id || null } });
        ingestionQueue.enqueue(req.db, workspace, doc, tmpPath, "file", false, req.user.id);
        queued.push(file.name);
      } catch { /* skip individual failures */ }
    }

    res.json({ ok: true, queued: queued.length, files: queued });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retry all failed/partial documents in a workspace
router.post("/:slug/retry-all", authenticate, requireManagerOrAdmin, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const docs = await req.db.document.findMany({
    where: { workspaceId: workspace.id, status: { in: ["failed", "partial"] } }
  });

  let queued = 0, skipped = 0;
  for (const doc of docs) {
    const source     = doc.type === "url" ? doc.name : doc.sourcePath;
    const sourceType = doc.type === "url" ? "url" : doc.type === "ocr" ? "ocr" : "file";
    if (sourceType !== "url" && (!source || !fs.existsSync(source))) { skipped++; continue; }

    await deleteDocumentChunks(workspace.slug, doc.uid);
    const updated = await req.db.document.update({
      where: { uid: doc.uid },
      data:  { status: "queued", chunkCount: 0, chunksProcessed: 0, totalChunks: 0, cancelRequested: false, errorMessage: null }
    });
    const keepFile = source && !source.includes("uploads");
    ingestionQueue.enqueue(req.db, workspace, updated, source, sourceType, keepFile, req.user.id);
    queued++;
  }

  res.json({ queued, skipped });
});

// Delete document + its vectors
router.delete("/:slug/:uid", authenticate, requireManagerOrAdmin, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const doc = await req.db.document.findFirst({ where: { uid: req.params.uid, workspaceId: workspace.id } });

  // If the doc is currently ingesting, set cancel flag first
  if (doc && doc.status === "ingesting") {
    await req.db.document.update({ where: { uid: doc.uid }, data: { cancelRequested: true } });
    // Small delay to let the current batch finish before deletion
    await new Promise(r => setTimeout(r, 500));
  }

  await deleteDocumentChunks(workspace.slug, req.params.uid);
  await req.db.document.deleteMany({ where: { uid: req.params.uid, workspaceId: workspace.id } });
  res.json({ success: true });
});

module.exports = router;
