const router  = require("express").Router({ mergeParams: true });
const { authenticate, requireManagerOrAdmin } = require("../middleware/auth");
const { getLLMConfig } = require("../providers/llm");
const engine  = require("../engine");
const yaml    = require("js-yaml");

router.use(authenticate, requireManagerOrAdmin);

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
      where:   { id: parseInt(req.params.projectId) },
      data:    {
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
    res.json({ project });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete project ────────────────────────────────────────────────────────────
router.delete("/:projectId", async (req, res) => {
  try {
    await req.db.project.delete({ where: { id: parseInt(req.params.projectId) } });
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
    res.json({ agents });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/:projectId/agents", async (req, res) => {
  try {
    const { name, description, fileName, yamlContent, isDefault } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const agent = await req.db.projectAgent.create({
      data: {
        projectId:   parseInt(req.params.projectId),
        name,
        description: description || null,
        fileName:    fileName    || "agent.yaml",
        yamlContent: yamlContent || "",
        isDefault:   !!isDefault,
      },
    });
    res.json({ agent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/:projectId/agents/:agentId", async (req, res) => {
  try {
    const { name, description, fileName, yamlContent, isDefault } = req.body;
    const agent = await req.db.projectAgent.update({
      where: { id: parseInt(req.params.agentId) },
      data:  {
        ...(name        !== undefined && { name }),
        ...(description !== undefined && { description: description || null }),
        ...(fileName    !== undefined && { fileName }),
        ...(yamlContent !== undefined && { yamlContent }),
        ...(isDefault   !== undefined && { isDefault: !!isDefault }),
      },
    });
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
router.post("/:projectId/agents/:agentId/run", async (req, res) => {
  try {
    const { input = "" } = req.body;
    const [project, agent] = await Promise.all([
      req.db.project.findUnique({ where: { id: parseInt(req.params.projectId) } }),
      req.db.projectAgent.findUnique({ where: { id: parseInt(req.params.agentId) } }),
    ]);
    if (!project || !agent) return res.status(404).json({ error: "Not found" });

    // LLM: platform config (workspace LLM settings)
    const llmConfig = await getLLMConfig();

    // Connectors: from project's oe-config.json
    const oeConfig = (() => { try { return JSON.parse(project.oeConfig || "{}"); } catch { return {}; } })();
    const connectors = (oeConfig.connectors || []).map((c, i) => ({
      id:   i + 1,
      name: c.connection_name,
      type: c.connection_type,
      ...c,
    }));

    // Parse YAML → agentSpec
    const doc = (() => { try { return yaml.load(agent.yamlContent) || {}; } catch { return {}; } })();
    const agentSpec = {
      systemPrompt: doc.instructions || doc.system_prompt || doc.systemPrompt || "",
      workflow:     (doc.steps || []).map(s => ({ name: s.name || "", content: s.content || "" })),
      params:       [],
      maxRounds:    25,
      input,
    };

    // Filter connectors by what YAML declares (if any)
    const refNames = (doc.connectors || []).map(c => c.connection_name);
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
      },
    });

    const { executeTool } = require("../utils/tools/registry");

    await engine.run(
      agentSpec,
      llmConfig,
      filteredConns,
      {
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
      }
    );
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── Cancel run ────────────────────────────────────────────────────────────────
router.post("/:projectId/runs/:runId/cancel", async (req, res) => {
  try {
    await req.db.$executeRaw`UPDATE ProjectRun SET cancelRequested = 1 WHERE id = ${parseInt(req.params.runId)}`;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
