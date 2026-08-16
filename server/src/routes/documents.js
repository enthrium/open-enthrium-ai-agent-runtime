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
  res.json({ documents });
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
  const headers = token ? { Authorization: `Bearer ${token}`, "User-Agent": "OpenEnthrium" } : { "User-Agent": "OpenEnthrium" };

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

// Google Drive folder picker removed — cloud connector sync is no longer supported
router.get("/:slug/gdrive-folders", authenticate, requireManagerOrAdmin, (req, res) => {
  res.json({ folders: [] });
});

// Cloud connector endpoints removed — cloud sync via connectors is no longer supported
router.get("/:slug/cloud-connectors", authenticate, requireManagerOrAdmin, (req, res) => {
  res.json({ connectors: [] });
});
router.get("/:slug/gdrive-connectors", authenticate, requireManagerOrAdmin, (req, res) => {
  res.json({ connectors: [] });
});

// Google Drive ingest removed — cloud connector sync is no longer supported
router.post("/:slug/ingest-gdrive-folder", authenticate, requireManagerOrAdmin, (req, res) => {
  res.status(410).json({ error: "Cloud connector sync has been removed." });
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

// Cloud storage ingestion removed — cloud connector sync is no longer supported
router.post("/:slug/ingest-cloud-folder", authenticate, requireManagerOrAdmin, (req, res) => {
  res.status(410).json({ error: "Cloud connector sync has been removed." });
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
