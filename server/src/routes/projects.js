"use strict";
const router  = require("express").Router({ mergeParams: true });
const { authenticate, requireManagerOrAdmin } = require("../middleware/auth");
const { getLLMConfig } = require("../providers/llm");
const engine  = require("../engine");
const yaml    = require("js-yaml");
const fs      = require("fs");
const path    = require("path");
const https   = require("https");

router.use(authenticate, requireManagerOrAdmin);

// ── Directories ──────────────────────────────────────────────────────────────
const SKILLS_DIR  = path.resolve(__dirname, "../../cli/skills");   // templates (read-only source)
const IMPORTS_DIR = path.resolve(__dirname, "../../../agents");    // D:\Open-Enthrium\app\agents — all imports land here
if (!fs.existsSync(IMPORTS_DIR)) fs.mkdirSync(IMPORTS_DIR, { recursive: true });

// Resolve folderPath (relative "cli/skills/docx" or absolute) → absolute
function resolveSkillPath(folderPath) {
  if (!folderPath) return null;
  if (path.isAbsolute(folderPath)) return folderPath;
  // "cli/skills/docx" → D:\Open-Enthrium\app\server\cli\skills\docx
  return path.resolve(__dirname, "../../", folderPath);
}

// ── GitHub fetch helpers (server-side — no CORS, no browser rate limit) ──────
const GH_TEXT_EXTS = new Set([".md",".txt",".yaml",".yml",".json",".py",".js",".ts",
  ".jsx",".tsx",".sh",".html",".css",".xml",".csv",".toml",".ini",".env",".rb",".go",
  ".rs",".java",".cpp",".c",".h",".sql",".graphql",".proto",".gitignore",".dockerignore"]);
const GH_MAX_FILES = 200; // max text files downloaded per import
const GH_MAX_DEPTH = 6;   // max directory nesting depth

function ghIsText(name) { const d = name.lastIndexOf("."); return d >= 0 && GH_TEXT_EXTS.has(name.slice(d).toLowerCase()); }

function httpsGet(rawUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers:  { "User-Agent": "open-enthrium-platform/1.0", "Accept": "application/vnd.github+json", ...extraHeaders },
    };
    https.get(opts, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

// Recurse into all subdirectories up to GH_MAX_DEPTH, download all text files up to GH_MAX_FILES
async function ghFetchDir(apiUrl, relDir, fileMap, depth) {
  if (depth > GH_MAX_DEPTH) return;
  if (Object.keys(fileMap).length >= GH_MAX_FILES) return;

  const { status, body } = await httpsGet(apiUrl);
  if (status === 403) throw new Error("GitHub API rate limit — wait a minute and try again.");
  if (status === 404) throw new Error("Repo or path not found. Is the URL pointing to a public folder?");
  if (status !== 200) throw new Error(`GitHub API returned ${status}.`);
  const items = JSON.parse(body);
  if (!Array.isArray(items)) throw new Error("Expected a folder URL (not a file URL).");

  for (const item of items) {
    if (Object.keys(fileMap).length >= GH_MAX_FILES) break;
    const rel = relDir ? `${relDir}/${item.name}` : item.name;
    if (item.type === "file" && ghIsText(item.name)) {
      const { status: s, body: content } = await httpsGet(item.download_url);
      if (s === 200) fileMap[rel] = content;
    } else if (item.type === "dir") {
      await ghFetchDir(item.url, rel, fileMap, depth + 1);
    }
  }
}

async function fetchGithubSkill(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.*)/);
  if (!m) throw new Error("Paste a GitHub folder URL like: https://github.com/owner/repo/tree/main/path/to/skill");
  const [, owner, repo, branch, basePath] = m;
  const fileMap = {};
  await ghFetchDir(
    `https://api.github.com/repos/${owner}/${repo}/contents/${basePath}?ref=${branch}`,
    "", fileMap, 0
  );
  if (Object.keys(fileMap).length === 0) throw new Error("No importable files found at that URL.");
  const skillName = basePath.split("/").filter(Boolean).pop() || "imported-skill";
  return { fileMap, skillName };
}

// ── Inject real LLM config from DB into fileMap["oe-config.json"] ────────────
async function injectLlmIntoFileMap(db, fileMap) {
  try {
    const llmKeys = ["llm_provider","llm_api_key","llm_model","llm_base_url","llm_azure_endpoint","llm_azure_deployment"];
    const llmRows = await db.setting.findMany({ where: { key: { in: llmKeys } } });
    const llmS    = Object.fromEntries(llmRows.map(r => [r.key, r.value]));
    if (!llmS.llm_provider && !llmS.llm_api_key) return;
    const existing = fileMap["oe-config.json"] ? JSON.parse(fileMap["oe-config.json"]) : {};
    existing.llm = {
      provider: llmS.llm_provider || existing.llm?.provider || "openai",
      model:    llmS.llm_model    || existing.llm?.model    || "gpt-4o",
      apiKey:   llmS.llm_api_key  || existing.llm?.apiKey   || "",
      ...(llmS.llm_base_url         ? { baseURL:         llmS.llm_base_url         } : {}),
      ...(llmS.llm_azure_endpoint   ? { azureEndpoint:   llmS.llm_azure_endpoint   } : {}),
      ...(llmS.llm_azure_deployment ? { azureDeployment: llmS.llm_azure_deployment } : {}),
    };
    fileMap["oe-config.json"] = JSON.stringify(existing, null, 2);
  } catch {}
}

// ── Auto-generate agent.yaml + oe-config.json when not in fileMap ────────────
function autoFillMissingFiles(fileMap, safeName) {
  // Parse SKILL.md frontmatter for name/description
  let skillName = safeName.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  let skillDesc = "";
  const skillMd = fileMap["SKILL.md"] || fileMap["skill.md"] || "";
  if (skillMd) {
    const fm = skillMd.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      try {
        const front = yaml.load(fm[1]) || {};
        if (front.name)        skillName = front.name;
        if (front.description) skillDesc = front.description;
      } catch {}
    }
    if (!skillDesc) {
      // First non-heading, non-blank line after frontmatter
      const body = skillMd.replace(/^---[\s\S]*?---\n?/, "");
      const line  = body.split("\n").find(l => l.trim() && !l.startsWith("#"));
      if (line) skillDesc = line.trim().slice(0, 120);
    }
  }

  // Detect if any scripts/ files exist — if so, add shell connector
  const hasScripts = Object.keys(fileMap).some(k => k.startsWith("scripts/"));

  // ── agent.yaml ───────────────────────────────────────────────────────────────
  if (!fileMap["agent.yaml"] && !fileMap["agent.yml"]) {
    const connBlock = hasScripts
      ? `connectors:\n  - connection_name: shell\n    connection_type: shell\n    cwd: "."\n`
      : "";
    fileMap["agent.yaml"] = [
      `name: ${skillName}`,
      skillDesc ? `description: "${skillDesc.replace(/"/g, "'")}"` : "",
      `skills:\n  - path: ./\n    trigger_type: auto`,
      connBlock,
    ].filter(Boolean).join("\n") + "\n";
  }

  // ── oe-config.json ───────────────────────────────────────────────────────────
  if (!fileMap["oe-config.json"]) {
    const connectors = hasScripts
      ? [{ connection_name: "shell", connection_type: "shell", cwd: "." }]
      : [];
    fileMap["oe-config.json"] = JSON.stringify({
      llm: { provider: "openai", model: "gpt-4o" },
      connectors,
    }, null, 2);
  }
}

// ── Write files + create DB entry ─────────────────────────────────────────────
function writeSkillToDisk(safeName, fileMap) {
  const skillDir = path.join(IMPORTS_DIR, safeName);
  for (const [rel, content] of Object.entries(fileMap)) {
    const fullPath = path.join(skillDir, rel);
    if (!fullPath.startsWith(skillDir)) continue; // path-traversal guard
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  return skillDir; // absolute path stored in DB
}

async function createSkillProject(db, workspaceId, userId, safeName, fileMap, folderPath) {
  const yamlContent = fileMap["agent.yaml"] || fileMap["agent.yml"] || "";
  const oeConfigStr = fileMap["oe-config.json"] || "{}";

  let doc = {};
  try { doc = yaml.load(yamlContent) || {}; } catch {}

  let oeConfigObj = {};
  try { oeConfigObj = JSON.parse(oeConfigStr); } catch {}

  // Derive name: YAML > folder name
  const agentName = doc.name || safeName.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const agentDesc = doc.description || null;

  return db.project.create({
    data: {
      workspaceId,
      name:            agentName,
      description:     agentDesc,
      oeConfig:        JSON.stringify(oeConfigObj),
      createdByUserId: userId || null,
      agents: {
        create: [{
          name:        agentName,
          description: agentDesc,
          fileName:    "agent.yaml",
          yamlContent,
          folderPath,
          isDefault:   true,
        }],
      },
    },
    include: { agents: { orderBy: { createdAt: "asc" } }, _count: { select: { agents: true, runs: true } } },
  });
}

// ── Read local folder into fileMap (text files only, depth-limited) ──────────
function readLocalDir(absDir, relBase, fileMap, depth) {
  if (depth > 8 || Object.keys(fileMap).length >= GH_MAX_FILES) return;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (Object.keys(fileMap).length >= GH_MAX_FILES) break;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      readLocalDir(path.join(absDir, e.name), rel, fileMap, depth + 1);
    } else if (e.isFile() && ghIsText(e.name)) {
      try { fileMap[rel] = fs.readFileSync(path.join(absDir, e.name), "utf8"); } catch {}
    }
  }
}

// ── Import skill (GitHub URL, local path, or raw files) ──────────────────────
router.post("/import-skill", async (req, res) => {
  try {
    const { source, url, localPath, files, name: nameOverride } = req.body;
    let fileMap   = {};
    let skillName = nameOverride || "imported-skill";

    if (source === "github") {
      if (!url) return res.status(400).json({ error: "url required" });
      const result = await fetchGithubSkill(url);
      fileMap   = result.fileMap;
      skillName = nameOverride || result.skillName;

    } else if (source === "local") {
      if (!localPath) return res.status(400).json({ error: "localPath required" });
      const absPath = path.isAbsolute(localPath) ? localPath : path.resolve(localPath);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
        return res.status(400).json({ error: "Path not found or is not a directory" });
      }
      skillName = nameOverride || path.basename(absPath);

      // ── Already inside IMPORTS_DIR → register without copying ────────────────
      const normalAbs    = absPath.toLowerCase();
      const normalImports = IMPORTS_DIR.toLowerCase();
      if (normalAbs.startsWith(normalImports)) {
        const folderName  = path.basename(absPath);
        const folderPath  = absPath; // absolute — resolveSkillPath returns as-is

        // Read just agent.yaml + oe-config.json from disk for DB fields
        const yamlPath = path.join(absPath, "agent.yaml");
        const cfgPath  = path.join(absPath, "oe-config.json");
        const yamlContent = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, "utf8") : "";
        let   oeConfigObj = {};
        if (fs.existsSync(cfgPath)) { try { oeConfigObj = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {} }

        // Auto-generate if missing, then inject LLM config from DB
        const localFileMap = {};
        readLocalDir(absPath, "", localFileMap, 0);
        autoFillMissingFiles(localFileMap, folderName);
        await injectLlmIntoFileMap(req.db, localFileMap);
        if (localFileMap["agent.yaml"] && !fs.existsSync(yamlPath)) fs.writeFileSync(yamlPath, localFileMap["agent.yaml"], "utf8");
        // Always write oe-config.json to disk (with injected LLM config)
        if (localFileMap["oe-config.json"]) fs.writeFileSync(cfgPath, localFileMap["oe-config.json"], "utf8");
        try { oeConfigObj = JSON.parse(localFileMap["oe-config.json"]); } catch {}

        let doc = {};
        try { doc = yaml.load(yamlContent || localFileMap["agent.yaml"] || "") || {}; } catch {}
        const agentName = doc.name || folderName.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

        const project = await req.db.project.create({
          data: {
            workspaceId: parseInt(req.params.workspaceId),
            name: agentName, description: doc.description || null,
            oeConfig: JSON.stringify(oeConfigObj),
            createdByUserId: req.user?.id || null,
            agents: { create: [{ name: agentName, description: doc.description || null, fileName: "agent.yaml", yamlContent: yamlContent || localFileMap["agent.yaml"] || "", folderPath, isDefault: true }] },
          },
          include: { agents: { orderBy: { createdAt: "asc" } }, _count: { select: { agents: true, runs: true } } },
        });
        return res.json({ project });
      }

      // ── Outside SKILLS_DIR → read + copy ─────────────────────────────────────
      readLocalDir(absPath, "", fileMap, 0);

    } else if (source === "files") {
      fileMap   = files || {};
      let doc = {};
      try { doc = yaml.load(fileMap["agent.yaml"] || "") || {}; } catch {}
      skillName = nameOverride || doc.name || "imported-skill";

    } else {
      return res.status(400).json({ error: "source must be 'github', 'local', or 'files'" });
    }

    // ── Copy flow (github + files + local-outside-IMPORTS_DIR) — writes to app/agents/ ──
    const baseName = skillName.toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/^-+|-+$/g, "") || "skill";
    let safeName = baseName;
    let counter  = 1;
    while (fs.existsSync(path.join(IMPORTS_DIR, safeName))) {
      safeName = `${baseName}-${counter++}`;
    }

    await injectLlmIntoFileMap(req.db, fileMap);
    autoFillMissingFiles(fileMap, safeName);
    const folderPath = writeSkillToDisk(safeName, fileMap); // returns absolute path

    const project = await createSkillProject(
      req.db, parseInt(req.params.workspaceId), req.user?.id, safeName, fileMap, folderPath
    );

    res.json({ project });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Scan cli/skills/ and register/link unregistered subfolders ───────────────
router.post("/scan-skills", async (req, res) => {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return res.json({ created: 0, linked: 0, skipped: 0, projects: [] });

    const wid     = parseInt(req.params.workspaceId);
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
    const created = [];
    let linked = 0, skipped = 0;

    for (const entry of entries) {
      const folderPath = `cli/skills/${entry.name}`;
      const skillDir   = path.join(SKILLS_DIR, entry.name);
      const yamlPath   = path.join(skillDir, "agent.yaml");
      if (!fs.existsSync(yamlPath)) continue;

      // Read files from disk
      const fileMap = {};
      for (const fname of ["agent.yaml", "SKILL.md", "skill.md", "oe-config.json"]) {
        const fp = path.join(skillDir, fname);
        if (fs.existsSync(fp)) fileMap[fname] = fs.readFileSync(fp, "utf8");
      }

      // Derive agent name from YAML
      let doc = {};
      try { doc = yaml.load(fileMap["agent.yaml"] || "") || {}; } catch {}
      const agentName = doc.name || entry.name.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

      // Case 1: already linked (folderPath already set on an agent in this workspace)
      const alreadyLinked = await req.db.projectAgent.findFirst({
        where: { folderPath, project: { workspaceId: wid } },
      });
      if (alreadyLinked) { skipped++; continue; }

      // Case 2: project exists with matching name but folderPath = "" → link it
      const existingAgent = await req.db.projectAgent.findFirst({
        where: {
          folderPath: "",
          name:       { equals: agentName, mode: "insensitive" },
          project:    { workspaceId: wid },
        },
      });
      if (existingAgent) {
        // Update folderPath + refresh yamlContent from disk (SKILL.md lives on disk only)
        await req.db.projectAgent.update({
          where: { id: existingAgent.id },
          data: {
            folderPath,
            yamlContent: fileMap["agent.yaml"] || existingAgent.yamlContent,
          },
        });
        linked++;
        continue;
      }

      // Case 3: not in DB at all → create new project + agent
      await injectLlmIntoFileMap(req.db, fileMap);
      const project = await createSkillProject(req.db, wid, req.user?.id, entry.name, fileMap, folderPath);
      created.push(project);
    }

    res.json({ created: created.length, linked, skipped, projects: created });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── List projects ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const projects = await req.db.project.findMany({
      where:   { workspaceId: parseInt(req.params.workspaceId) },
      include: { _count: { select: { agents: true, runs: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ projects });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Create project ────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { name, description, manifest, oeConfig, agents = [] } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });

    const project = await req.db.project.create({
      data: {
        workspaceId:     parseInt(req.params.workspaceId),
        name,
        description:     description || null,
        manifest:        manifest  ? JSON.stringify(manifest)  : null,
        oeConfig:        oeConfig  ? JSON.stringify(oeConfig)  : null,
        createdByUserId: req.user?.id || null,
        agents: {
          create: agents.map(a => ({
            name:        a.name,
            description: a.description || null,
            fileName:    a.fileName    || "agent.yaml",
            yamlContent: a.yamlContent || "",
            filesJson:   a.filesJson   || "{}",
            folderPath:  a.folderPath  || "",
            isDefault:   a.isDefault   || false,
          })),
        },
      },
      include: { agents: { orderBy: { createdAt: "asc" } }, _count: { select: { agents: true, runs: true } } },
    });
    res.json({ project });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get project ───────────────────────────────────────────────────────────────
router.get("/:projectId", async (req, res) => {
  try {
    const project = await req.db.project.findFirst({
      where:   { id: parseInt(req.params.projectId), workspaceId: parseInt(req.params.workspaceId) },
      include: { agents: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json({ project });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Update project ────────────────────────────────────────────────────────────
router.put("/:projectId", async (req, res) => {
  try {
    const { name, description, oeConfig, manifest } = req.body;
    const project = await req.db.project.update({
      where: { id: parseInt(req.params.projectId) },
      data: {
        ...(name        !== undefined && { name }),
        ...(description !== undefined && { description: description || null }),
        ...(oeConfig    !== undefined && { oeConfig: JSON.stringify(oeConfig) }),
        ...(manifest    !== undefined && {
          manifest: JSON.stringify(manifest),
          ...(manifest.name        && { name:        manifest.name }),
          ...(manifest.description !== undefined && { description: manifest.description || null }),
        }),
      },
      include: { agents: { orderBy: { createdAt: "asc" } } },
    });

    // Write oe-config.json to disk for any agent that has a folderPath
    if (oeConfig !== undefined) {
      for (const agent of (project.agents || [])) {
        if (!agent.folderPath) continue;
        const absPath = resolveSkillPath(agent.folderPath);
        if (!absPath) continue;
        try { fs.writeFileSync(path.join(absPath, "oe-config.json"), JSON.stringify(oeConfig, null, 2), "utf8"); } catch {}
      }
    }

    res.json({ project });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete project ────────────────────────────────────────────────────────────
router.delete("/:projectId", async (req, res) => {
  try {
    // Collect disk folders before deleting from DB (cascade deletes agents too)
    const project = await req.db.project.findFirst({
      where:   { id: parseInt(req.params.projectId), workspaceId: parseInt(req.params.workspaceId) },
      include: { agents: true },
    });

    await req.db.project.delete({ where: { id: parseInt(req.params.projectId) } });

    // Remove disk folder for each agent that lives inside IMPORTS_DIR
    if (project) {
      const folderPaths = [...new Set(
        (project.agents || []).map(a => a.folderPath).filter(Boolean)
      )];
      for (const fp of folderPaths) {
        const absPath = resolveSkillPath(fp);
        // Only delete folders that are inside IMPORTS_DIR (never cli/skills or absolute outside paths)
        if (absPath && absPath.startsWith(IMPORTS_DIR) && fs.existsSync(absPath)) {
          try { fs.rmSync(absPath, { recursive: true, force: true }); } catch {}
        }
      }
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Agents ────────────────────────────────────────────────────────────────────
router.get("/:projectId/agents", async (req, res) => {
  try {
    const agents = await req.db.projectAgent.findMany({
      where:   { projectId: parseInt(req.params.projectId) },
      orderBy: { createdAt: "asc" },
    });
    // For disk-based agents, serve live files from disk
    for (const agent of agents) {
      if (!agent.folderPath) continue;
      const absPath = resolveSkillPath(agent.folderPath);
      if (!absPath) continue;
      try { agent.yamlContent  = fs.readFileSync(path.join(absPath, "agent.yaml"), "utf8"); } catch {}
      try { agent.skillContent = fs.readFileSync(path.join(absPath, "SKILL.md"),   "utf8"); } catch { agent.skillContent = ""; } // virtual — not in DB
    }
    res.json({ agents });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/:projectId/agents", async (req, res) => {
  try {
    const { name, description, fileName, yamlContent, filesJson, folderPath, isDefault } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const agent = await req.db.projectAgent.create({
      data: {
        projectId:   parseInt(req.params.projectId),
        name,
        description: description || null,
        fileName:    fileName    || "agent.yaml",
        yamlContent: yamlContent || "",
        filesJson:   filesJson   || "{}",
        folderPath:  folderPath  || "",
        isDefault:   !!isDefault,
      },
    });
    res.json({ agent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/:projectId/agents/:agentId", async (req, res) => {
  try {
    const { name, description, fileName, yamlContent, skillContent, filesJson, folderPath, isDefault } = req.body;

    const current = await req.db.projectAgent.findUnique({ where: { id: parseInt(req.params.agentId) } });
    const effectiveFolderPath = folderPath ?? current?.folderPath;

    // DB: store only agent.yaml (yamlContent) — SKILL.md lives on disk only
    const agent = await req.db.projectAgent.update({
      where: { id: parseInt(req.params.agentId) },
      data: {
        ...(name        !== undefined && { name }),
        ...(description !== undefined && { description: description || null }),
        ...(fileName    !== undefined && { fileName }),
        ...(yamlContent !== undefined && { yamlContent }),
        ...(filesJson   !== undefined && { filesJson }),
        ...(folderPath  !== undefined && { folderPath }),
        ...(isDefault   !== undefined && { isDefault: !!isDefault }),
      },
    });

    // Write to disk when folderPath is set
    if (effectiveFolderPath) {
      const absPath = resolveSkillPath(effectiveFolderPath);
      if (absPath) {
        try {
          if (yamlContent  !== undefined) fs.writeFileSync(path.join(absPath, "agent.yaml"), yamlContent,  "utf8");
          if (skillContent !== undefined) fs.writeFileSync(path.join(absPath, "SKILL.md"),   skillContent, "utf8");
        } catch {}
      }
    }

    // Return agent with SKILL.md content from disk (virtual field)
    if (effectiveFolderPath) {
      const absPath = resolveSkillPath(effectiveFolderPath);
      try { agent.skillContent = fs.readFileSync(path.join(absPath, "SKILL.md"), "utf8"); } catch { agent.skillContent = ""; }
    }

    res.json({ agent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/:projectId/agents/:agentId", async (req, res) => {
  try {
    await req.db.projectAgent.delete({ where: { id: parseInt(req.params.agentId) } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Run agent (SSE) ───────────────────────────────────────────────────────────
function skillMdBody(content) {
  if (!content) return "";
  const s = content.trim();
  if (!s.startsWith("---")) return s;
  const end = s.indexOf("---", 3);
  return end === -1 ? s : s.slice(end + 3).trim();
}

router.post("/:projectId/agents/:agentId/run", async (req, res) => {
  try {
    const { input = "", triggerType = "manual" } = req.body;
    let [project, agent] = await Promise.all([
      req.db.project.findUnique({ where: { id: parseInt(req.params.projectId) } }),
      req.db.projectAgent.findUnique({ where: { id: parseInt(req.params.agentId) } }),
    ]);
    if (!project || !agent) return res.status(404).json({ error: "Not found" });

    // ── Resolve sources from disk when folderPath is set ────────────────────────
    let llmConfig   = await getLLMConfig();
    let yamlContent = agent.yamlContent;
    let skillContent = "";  // SKILL.md is disk-only, never in DB
    let oeConfigObj = (() => { try { return JSON.parse(project.oeConfig || "{}"); } catch { return {}; } })();

    if (agent.folderPath) {
      const absPath = resolveSkillPath(agent.folderPath);
      if (absPath && fs.existsSync(absPath)) {
        try { yamlContent  = fs.readFileSync(path.join(absPath, "agent.yaml"),    "utf8"); } catch {}
        try { skillContent = fs.readFileSync(path.join(absPath, "SKILL.md"),      "utf8"); } catch {}
        try {
          const diskCfg = JSON.parse(fs.readFileSync(path.join(absPath, "oe-config.json"), "utf8"));
          oeConfigObj = diskCfg;
          const key = diskCfg.llm?.apiKey || "";
          if (key && !/YOUR_API_KEY|sk-\.\.\.|placeholder/i.test(key)) llmConfig = diskCfg.llm;
        } catch {}
      }
    }

    // Build connector list; auto-set shell cwd to skill folder
    const absPath = agent.folderPath ? resolveSkillPath(agent.folderPath) : null;
    const connectors = (oeConfigObj.connectors || []).map((c, i) => {
      const conn = { id: i + 1, name: c.connection_name, type: c.connection_type, ...c };
      if (conn.type === "shell" && absPath && (!conn.cwd || conn.cwd === ".")) {
        conn.cwd = absPath;
      }
      return conn;
    });

    // Parse YAML → agentSpec
    const doc = (() => { try { return yaml.load(yamlContent) || {}; } catch { return {}; } })();
    const skillPrompt = skillMdBody(skillContent);
    const agentSpec = {
      systemPrompt: skillPrompt || doc.instructions || doc.system_prompt || doc.systemPrompt || "",
      workflow:     (doc.steps || []).map(s => ({ name: s.name || "", content: s.content || "" })),
      params:       [],
      maxRounds:    25,
      input,
    };

    // Filter connectors by what YAML declares (if any)
    const refNames      = (doc.connectors || []).map(c => c.connection_name);
    const filteredConns = refNames.length ? connectors.filter(c => refNames.includes(c.name)) : connectors;

    // SSE
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");

    const run = await req.db.projectRun.create({
      data: {
        projectId:         project.id,
        agentId:           agent.id,
        triggeredByUserId: req.user?.id || null,
        status:            "running",
        input:             input || null,
        triggerType:       triggerType || "manual",
      },
    });

    const { executeTool } = require("../utils/tools/registry");

    await engine.run(agentSpec, llmConfig, filteredConns, {
      toolExecutor: (name, args, conns) => executeTool(name, args, conns, req.db),
      onToolCall:   (name) => res.write(`data: ${JSON.stringify({ tool_call: name })}\n\n`),
      onToolResult: (name, result) => res.write(`data: ${JSON.stringify({ tool_result: name, output: result.slice(0, 500) })}\n\n`),
      checkCancel:  async () => {
        const [r] = await req.db.$queryRaw`SELECT cancelRequested FROM ProjectRun WHERE id = ${run.id}`;
        return r?.cancelRequested || false;
      },
      onDone: async (output) => {
        await req.db.projectRun.update({ where: { id: run.id }, data: { status: "success", output, completedAt: new Date() } });
        res.write(`data: ${JSON.stringify({ done: true, output, runId: run.id })}\n\n`);
        res.end();
      },
      onError: async (err) => {
        await req.db.projectRun.update({ where: { id: run.id }, data: { status: "error", error: err.message, completedAt: new Date() } }).catch(() => {});
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      },
    });
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── File tree (reads disk, no DB writes) ─────────────────────────────────────
function buildTree(absDir, relBase, depth) {
  if (depth > 12) return [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return []; }
  const nodes = [];
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      nodes.push({ name: e.name, path: rel, type: "dir", children: buildTree(path.join(absDir, e.name), rel, depth + 1) });
    } else if (e.isFile()) {
      const stat = fs.statSync(path.join(absDir, e.name));
      nodes.push({ name: e.name, path: rel, type: "file", size: stat.size });
    }
  }
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

router.get("/:projectId/tree", async (req, res) => {
  try {
    const project = await req.db.project.findFirst({
      where: { id: parseInt(req.params.projectId), workspaceId: parseInt(req.params.workspaceId) },
      include: { agents: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) return res.status(404).json({ error: "Not found" });
    const agent = project.agents.find(a => a.folderPath) || project.agents[0];
    if (!agent?.folderPath) return res.json({ tree: [], rootName: project.name });
    const absPath = resolveSkillPath(agent.folderPath);
    if (!absPath || !fs.existsSync(absPath)) return res.json({ tree: [], rootName: project.name });
    res.json({ tree: buildTree(absPath, "", 0), rootName: path.basename(absPath) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/:projectId/file", async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: "path required" });
    const project = await req.db.project.findFirst({
      where: { id: parseInt(req.params.projectId), workspaceId: parseInt(req.params.workspaceId) },
      include: { agents: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) return res.status(404).json({ error: "Not found" });
    const agent = project.agents.find(a => a.folderPath) || project.agents[0];
    if (!agent?.folderPath) return res.status(404).json({ error: "No folder" });
    const absBase = resolveSkillPath(agent.folderPath);
    if (!absBase) return res.status(404).json({ error: "Folder not found" });
    const absFile = path.resolve(absBase, filePath);
    if (!absFile.startsWith(absBase + path.sep) && absFile !== absBase) return res.status(403).json({ error: "Access denied" });
    if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) return res.status(404).json({ error: "File not found" });
    const TEXT_EXTS = new Set([".md",".txt",".yaml",".yml",".json",".py",".js",".ts",".jsx",".tsx",".sh",".html",".css",".xml",".csv",".toml",".ini",".rb",".go",".rs",".java",".cpp",".c",".h",".sql",".graphql",".env",".gitignore",".dockerignore"]);
    const ext = path.extname(absFile).toLowerCase();
    if (!TEXT_EXTS.has(ext) && ext !== "") return res.json({ content: null, binary: true });
    const content = fs.readFileSync(absFile, "utf8");
    res.json({ content, binary: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Cancel run ────────────────────────────────────────────────────────────────
router.post("/:projectId/runs/:runId/cancel", async (req, res) => {
  try {
    await req.db.$executeRaw`UPDATE ProjectRun SET cancelRequested = 1 WHERE id = ${parseInt(req.params.runId)}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
