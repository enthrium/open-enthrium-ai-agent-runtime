const router = require("express").Router();
const { authenticate, requireAdmin, requireManagerOrAdmin, requireCommercial } = require("../middleware/auth");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

// Check workspace membership — admins/managers pass through; regular users must be a member
async function wsMember(req, slug) {
  const ws = await req.db.workspace.findUnique({ where: { slug } });
  if (!ws) return null;
  if (req.user.role === "admin" || req.user.role === "manager") return ws;
  const m = await req.db.workspaceUser.findFirst({ where: { userId: req.user.id, workspaceId: ws.id } });
  return m ? ws : false; // null = not found, false = not a member
}

// List workspaces for current user
router.get("/", authenticate, async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const include = {
    _count: { select: { documents: true, chats: true } },
    createdBy: { select: { id: true, name: true, email: true } },
  };
  const workspaces = isAdmin
    ? await req.db.workspace.findMany({ orderBy: { createdAt: "desc" }, include })
    : await req.db.workspace.findMany({
        where: { users: { some: { userId: req.user.id } } },
        orderBy: { createdAt: "desc" },
        include,
      });
  res.json({ workspaces });
});

// Agent runs across all workspaces the current user manages
router.get("/agent-runs", authenticate, requireManagerOrAdmin, async (req, res) => {
  try {
    const { period = "all" } = req.query;
    const days = { "7d": 7, "30d": 30 }[period];
    const startedAt = days ? { gte: new Date(Date.now() - days * 86400000) } : undefined;

    const isAdmin = req.user.role === "admin";
    let workspaceFilter = undefined;
    if (!isAdmin) {
      const memberships = await req.db.workspaceUser.findMany({ where: { userId: req.user.id }, select: { workspaceId: true } });
      const workspaceIds = memberships.map(m => m.workspaceId);
      workspaceFilter = { agent: { workspaceId: { in: workspaceIds } } };
    }

    const runs = await req.db.agentRun.findMany({
      where: { ...(startedAt ? { startedAt } : {}), ...workspaceFilter },
      orderBy: { startedAt: "desc" },
      take: 200,
      include: {
        agent: { select: { id: true, name: true, workspaceId: true, workspace: { select: { id: true, name: true } } } },
        triggeredBy: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ runs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Member-accessible project routes ─────────────────────────────────────────

// List projects (workspace member or manager/admin)
router.get("/:slug/projects", authenticate, async (req, res) => {
  try {
    const ws = await wsMember(req, req.params.slug);
    if (ws === null)  return res.status(404).json({ error: "Workspace not found" });
    if (ws === false) return res.status(403).json({ error: "Access denied" });
    const projects = await req.db.project.findMany({
      where:   { workspaceId: ws.id },
      include: { _count: { select: { agents: true, runs: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ projects });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List agents for a project (workspace member or manager/admin)
router.get("/:slug/projects/:projectId/agents", authenticate, async (req, res) => {
  try {
    const ws = await wsMember(req, req.params.slug);
    if (!ws) return res.status(ws === null ? 404 : 403).json({ error: !ws ? "Access denied" : "Not found" });
    const agents = await req.db.projectAgent.findMany({
      where:   { projectId: parseInt(req.params.projectId) },
      orderBy: { createdAt: "asc" },
    });
    res.json({ agents });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Run agent — SSE (workspace member or manager/admin)
router.post("/:slug/projects/:projectId/agents/:agentId/run", authenticate, async (req, res) => {
  try {
    const ws = await wsMember(req, req.params.slug);
    if (!ws) return res.status(403).json({ error: "Access denied" });

    const { input = "", triggerType = "manual" } = req.body;
    const { getLLMConfig } = require("../providers/llm");
    const yaml    = require("js-yaml");
    const engine  = require("../engine");
    const fs      = require("fs");
    const path    = require("path");

    const SKILLS_DIR = path.resolve(__dirname, "../../cli/skills");

    function resolveSkillPath(folderPath) {
      if (!folderPath) return null;
      if (path.isAbsolute(folderPath)) return folderPath;
      return path.resolve(__dirname, "../../../", folderPath);
    }

    const [project, agent] = await Promise.all([
      req.db.project.findUnique({ where: { id: parseInt(req.params.projectId) } }),
      req.db.projectAgent.findUnique({ where: { id: parseInt(req.params.agentId) } }),
    ]);
    if (!project || !agent) return res.status(404).json({ error: "Not found" });

    // ── Resolve sources: disk (folderPath) takes priority over DB blobs ──────────
    let llmConfig    = await getLLMConfig();
    let yamlContent  = agent.yamlContent;
    let skillContent = "";  // SKILL.md is disk-only, never in DB
    let oeConfigObj  = (() => { try { return JSON.parse(project.oeConfig || "{}"); } catch { return {}; } })();

    const absPath = agent.folderPath ? resolveSkillPath(agent.folderPath) : null;
    if (absPath && fs.existsSync(absPath)) {
      try { yamlContent  = fs.readFileSync(path.join(absPath, "agent.yaml"), "utf8"); } catch {}
      try { skillContent = fs.readFileSync(path.join(absPath, "SKILL.md"), "utf8"); } catch {}
      try {
        const diskCfg = JSON.parse(fs.readFileSync(path.join(absPath, "oe-config.json"), "utf8"));
        oeConfigObj = diskCfg;
        const key = diskCfg.llm?.apiKey || "";
        if (key && !/YOUR_API_KEY|sk-\.\.\.|placeholder/i.test(key)) llmConfig = diskCfg.llm;
      } catch {}
    }

    // Build connectors; auto-set shell cwd to skill folder
    const connectors = (oeConfigObj.connectors || []).map((c, i) => {
      const { connection_name, connection_type, ...creds } = c;
      if (connection_type === "shell" && absPath && (!creds.cwd || creds.cwd === ".")) {
        creds.cwd = absPath;
      }
      return {
        id:         i + 1,
        name:       connection_name,
        type:       connection_type,
        status:     "active",
        authConfig: JSON.stringify(creds),
        config:     JSON.stringify(creds),
        ...creds,
      };
    });

    const doc        = (() => { try { return yaml.load(yamlContent) || {}; } catch { return {}; } })();

    // Extract SKILL.md body (strip YAML frontmatter)
    function skillMdBody(content) {
      if (!content) return "";
      const s = content.trim();
      if (!s.startsWith("---")) return s;
      const end = s.indexOf("---", 3);
      return end === -1 ? s : s.slice(end + 3).trim();
    }
    const skillPrompt = skillMdBody(skillContent);

    const agentSpec  = {
      systemPrompt: skillPrompt || doc.instructions || doc.system_prompt || doc.systemPrompt || "",
      workflow:     (doc.steps || []).map(s => ({ name: s.name || "", content: s.content || "" })),
      params: [], maxRounds: 25, input: input || "Run",
    };
    const refNames      = (doc.connectors || []).map(c => c.connection_name);
    const filteredConns = refNames.length ? connectors.filter(c => refNames.includes(c.name)) : connectors;

    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");

    const run = await req.db.projectRun.create({
      data: { projectId: project.id, agentId: agent.id, triggeredByUserId: req.user?.id || null, status: "running", input: input || null, triggerType: triggerType || "manual" },
    });

    const { executeTool } = require("../utils/tools/registry");
    await engine.run(agentSpec, llmConfig, filteredConns, {
      toolExecutor: (name, args, conns) => executeTool(name, args, conns, req.db),
      onToolCall:   (name) => res.write(`data: ${JSON.stringify({ tool_call: name })}\n\n`),
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

// Cancel run (workspace member or manager/admin)
router.post("/:slug/projects/:projectId/runs/:runId/cancel", authenticate, async (req, res) => {
  try {
    const ws = await wsMember(req, req.params.slug);
    if (!ws) return res.status(403).json({ error: "Access denied" });
    await req.db.$executeRaw`UPDATE ProjectRun SET cancelRequested = 1 WHERE id = ${parseInt(req.params.runId)}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List project runs (workspace member or manager/admin)
router.get("/:slug/project-runs", authenticate, async (req, res) => {
  try {
    const ws = await wsMember(req, req.params.slug);
    if (!ws) return res.status(ws === null ? 404 : 403).json({ error: "Not found" });
    const { period = "all" } = req.query;
    const days = { "7d": 7, "30d": 30 }[period];
    const startFilter = days ? { gte: new Date(Date.now() - days * 86400000) } : undefined;
    const runs = await req.db.projectRun.findMany({
      where: {
        project: { workspaceId: ws.id },
        ...(startFilter ? { startedAt: startFilter } : {}),
      },
      orderBy: { startedAt: "desc" },
      take: 300,
      include: {
        project:     { select: { id: true, name: true } },
        agent:       { select: { id: true, name: true, fileName: true } },
        triggeredBy: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ runs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clear all project runs (manager/admin only — destructive)
router.delete("/:slug/project-runs", authenticate, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    await req.db.projectRun.deleteMany({ where: { project: { workspaceId: workspace.id } } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get single workspace
router.get("/:slug", authenticate, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({
    where: { slug: req.params.slug },
    include: { documents: { orderBy: { createdAt: "desc" } }, _count: { select: { chats: true } } }
  });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  res.json({ workspace });
});

// Create workspace (manager or admin)
router.post("/", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { name, systemPrompt } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + uuidv4().slice(0, 6);
  const workspace = await req.db.workspace.create({
    data: { name, slug, systemPrompt: systemPrompt || null, createdByUserId: req.user.id || null },
    include: { createdBy: { select: { id: true, name: true, email: true } } }
  });

  // Auto-add creator as member (skip superadmin who has no DB row)
  if (req.user.id !== 0) {
    await req.db.workspaceUser.create({ data: { userId: req.user.id, workspaceId: workspace.id } });
  }

  res.json({ workspace });
});

// Update workspace (manager or admin)
router.put("/:slug", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { name, systemPrompt, embedEnabled, temperature, chatHistory, queryRefusalResponse, starterPrompts } = req.body;
  const workspace = await req.db.workspace.update({
    where: { slug: req.params.slug },
    data: {
      ...(name && { name }),
      ...(systemPrompt !== undefined && { systemPrompt: systemPrompt || null }),
      ...(embedEnabled !== undefined && { embedEnabled: Boolean(embedEnabled) }),
      ...(temperature !== undefined && { temperature: parseFloat(temperature) }),
      ...(chatHistory !== undefined && { chatHistory: parseInt(chatHistory) }),
      ...(queryRefusalResponse !== undefined && { queryRefusalResponse: queryRefusalResponse || null }),
      ...(starterPrompts !== undefined && { starterPrompts: JSON.stringify(starterPrompts) }),
    }
  });
  res.json({ workspace });
});

// Delete workspace (manager or admin)
router.delete("/:slug", authenticate, requireManagerOrAdmin, async (req, res) => {
  await req.db.workspace.delete({ where: { slug: req.params.slug } });
  res.json({ success: true });
});

// Add user to workspace (manager or admin)
router.post("/:slug/users", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { userId } = req.body;
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  await req.db.workspaceUser.upsert({
    where: { userId_workspaceId: { userId: parseInt(userId), workspaceId: workspace.id } },
    create: { userId: parseInt(userId), workspaceId: workspace.id },
    update: {}
  });
  res.json({ success: true });
});

// Remove user from workspace (manager or admin)
router.delete("/:slug/users/:userId", authenticate, requireManagerOrAdmin, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  await req.db.workspaceUser.deleteMany({
    where: { userId: parseInt(req.params.userId), workspaceId: workspace.id }
  });
  res.json({ success: true });
});

// ── Manager: all agent runs across managed workspaces ────────────────────────
router.get("/agent-runs", authenticate, requireManagerOrAdmin, async (req, res) => {
  try {
    const { period = "all" } = req.query;
    const days = { "7d": 7, "30d": 30 }[period];
    const startedAt = days ? { gte: new Date(Date.now() - days * 86400000) } : undefined;

    const workspaces = await req.db.workspace.findMany({
      where: req.user.role === "admin" ? undefined : { users: { some: { userId: req.user.id } } },
      select: { id: true },
    });
    const workspaceIds = workspaces.map(w => w.id);

    const agents = await req.db.agent.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { id: true },
    });
    const agentIds = agents.map(a => a.id);

    const runs = await req.db.agentRun.findMany({
      where: { agentId: { in: agentIds }, ...(startedAt ? { startedAt } : {}) },
      orderBy: { startedAt: "desc" },
      take: 200,
      include: {
        agent: { select: { id: true, name: true, workspaceId: true, workspace: { select: { id: true, name: true } } } },
        triggeredBy: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ runs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── User-facing agent routes ──────────────────────────────────────────────────
// Helpers
function isManagerOrAdmin(user) { return user.role === "admin" || user.role === "manager"; }

async function assertWorkspaceMember(db, user, workspaceId) {
  if (user.role === "admin") return true;
  const member = await db.workspaceUser.findFirst({ where: { userId: user.id, workspaceId } });
  return !!member;
}
// ── Knowledge Base Sharing ────────────────────────────────────────────────────

router.get("/:slug/kb-shares", authenticate, requireCommercial, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Not found" });
    const [outgoing, incoming] = await Promise.all([
      req.db.workspaceKBShare.findMany({
        where: { sourceWorkspaceId: workspace.id },
        include: { targetWorkspace: { select: { id: true, slug: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
      req.db.workspaceKBShare.findMany({
        where: { targetWorkspaceId: workspace.id },
        include: { sourceWorkspace: { select: { id: true, slug: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    res.json({ outgoing, incoming });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/:slug/kb-shares", authenticate, requireCommercial, async (req, res) => {
  try {
    const featureSetting = await req.db.setting.findUnique({ where: { key: "feature.kbSharing" } });
    if (featureSetting?.value !== "true") return res.status(403).json({ error: "Knowledge Base Sharing is disabled on this installation." });

    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceMember(req.db, req.user, workspace.id)) return res.status(403).json({ error: "Access denied" });
    const target = await req.db.workspace.findUnique({ where: { slug: req.body.targetWorkspaceSlug } });
    if (!target) return res.status(404).json({ error: "Target workspace not found" });
    if (target.id === workspace.id) return res.status(400).json({ error: "Cannot share with yourself" });
    const share = await req.db.workspaceKBShare.create({
      data: { sourceWorkspaceId: workspace.id, targetWorkspaceId: target.id },
      include: { targetWorkspace: { select: { id: true, slug: true, name: true } } },
    });
    res.json({ share });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Already shared with this workspace" });
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:slug/kb-shares/:id", authenticate, requireCommercial, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Not found" });
    if (!await assertWorkspaceMember(req.db, req.user, workspace.id)) return res.status(403).json({ error: "Access denied" });
    await req.db.workspaceKBShare.delete({ where: { id: parseInt(req.params.id), sourceWorkspaceId: workspace.id } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/:slug/peer-workspaces", authenticate, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Not found" });
    const workspaces = await req.db.workspace.findMany({
      where: { id: { not: workspace.id } },
      select: { id: true, slug: true, name: true },
      orderBy: { name: "asc" },
    });
    res.json({ workspaces });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Workspace DLP Policies ────────────────────────────────────────────────────

router.get("/:slug/dlp-policies", authenticate, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const links = await req.db.workspaceDlpPolicy.findMany({
      where: { workspaceId: workspace.id },
      include: { policy: true },
      orderBy: { createdAt: "asc" },
    });
    res.json({ policies: links.map(l => ({ linkId: l.id, ...l.policy })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/:slug/dlp-policies", authenticate, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const policy = await req.db.dlpPolicy.findUnique({ where: { id: parseInt(req.body.policyId) } });
    if (!policy) return res.status(404).json({ error: "Policy not found" });
    const link = await req.db.workspaceDlpPolicy.create({
      data: { workspaceId: workspace.id, policyId: policy.id },
      include: { policy: true },
    });
    res.json({ policy: { linkId: link.id, ...link.policy } });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Policy already assigned to this workspace" });
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:slug/dlp-policies/:linkId", authenticate, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    await req.db.workspaceDlpPolicy.delete({
      where: { id: parseInt(req.params.linkId), workspaceId: workspace.id },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Agent config (inline connector credentials) ───────────────────────────────

router.get("/:slug/agent-config", authenticate, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const config = (() => { try { return JSON.parse(workspace.agentConfig || "{}"); } catch { return {}; } })();
    res.json({ config });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/:slug/agent-config", authenticate, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { config } = req.body;
    await req.db.workspace.update({
      where: { slug: req.params.slug },
      data:  { agentConfig: JSON.stringify(config) },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
