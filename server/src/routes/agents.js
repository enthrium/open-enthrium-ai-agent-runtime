const router = require("express").Router();
const { authenticate, requireManagerOrAdmin } = require("../middleware/auth");
const { getLLMConfig } = require("../providers/llm");
const engine = require("../engine");

router.use(authenticate, requireManagerOrAdmin);

// ── List agents for a workspace ───────────────────────────────────────────────
router.get("/workspaces/:workspaceId/agents", async (req, res) => {
  try {
    const workspaceId = parseInt(req.params.workspaceId);
    const agents = await req.db.agent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      include: {
        runs: {
          orderBy: { startedAt: "desc" },
          take: 1,
          select: { status: true, startedAt: true, completedAt: true },
        },
      },
    });
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create agent ──────────────────────────────────────────────────────────────
router.post("/workspaces/:workspaceId/agents", async (req, res) => {
  try {
    const workspaceId = parseInt(req.params.workspaceId);
    const { name, description, systemPrompt, workflow, connectorIds } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });
    const agent = await req.db.agent.create({
      data: {
        workspaceId,
        name:           name.trim(),
        description:    description?.trim() || null,
        systemPrompt:   systemPrompt?.trim() || null,
        workflow:       typeof workflow === "string" ? workflow : JSON.stringify(workflow || []),
        connectorIds:   typeof connectorIds === "string" ? connectorIds : JSON.stringify(connectorIds || []),
        createdByUserId: req.user.id || null,
      },
    });
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update agent ──────────────────────────────────────────────────────────────
router.put("/workspaces/:workspaceId/agents/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, systemPrompt, workflow, connectorIds, enabled } = req.body;
    const data = {};
    if (name         !== undefined) data.name         = name.trim();
    if (description  !== undefined) data.description  = description?.trim() || null;
    if (systemPrompt !== undefined) data.systemPrompt = systemPrompt?.trim() || null;
    if (workflow     !== undefined) data.workflow     = typeof workflow === "string" ? workflow : JSON.stringify(workflow || []);
    if (connectorIds !== undefined) data.connectorIds = typeof connectorIds === "string" ? connectorIds : JSON.stringify(connectorIds || []);
    if (enabled      !== undefined) data.enabled      = enabled;
    const agent = await req.db.agent.update({ where: { id }, data });
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete agent ──────────────────────────────────────────────────────────────
router.delete("/workspaces/:workspaceId/agents/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await req.db.agent.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Run history ───────────────────────────────────────────────────────────────
router.get("/workspaces/:workspaceId/agents/:id/runs", async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    const runs = await req.db.agentRun.findMany({
      where: { agentId },
      orderBy: { startedAt: "desc" },
      take: 10,
    });
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cancel a run ──────────────────────────────────────────────────────────────
router.post("/workspaces/:workspaceId/agents/:id/runs/:runId/cancel", async (req, res) => {
  try {
    const runId = parseInt(req.params.runId);
    await req.db.$executeRaw`UPDATE AgentRun SET cancelRequested = 1 WHERE id = ${runId}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Run agent (SSE) ───────────────────────────────────────────────────────────
router.post("/workspaces/:workspaceId/agents/:id/run", async (req, res) => {
  const agentId     = parseInt(req.params.id);
  const workspaceId = parseInt(req.params.workspaceId);
  const { input }   = req.body;

  const [agent, workspace] = await Promise.all([
    req.db.agent.findUnique({ where: { id: agentId } }),
    req.db.workspace.findUnique({ where: { id: workspaceId } }),
  ]);
  if (!agent)     return res.status(404).json({ error: "Agent not found" });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  // Build connector list from workspace agentConfig (inline credentials)
  const agentConfig = (() => { try { return JSON.parse(workspace.agentConfig || "{}"); } catch { return {}; } })();
  const allConnectors = (agentConfig.connectors || []).map((c, i) => ({
    id:   i + 1,
    name: c.connection_name,
    type: c.connection_type,
    ...c, // spread all credential fields (bearerToken, baseUrl, host, password, etc.)
  }));

  // Filter to connectors the agent declared
  const referencedNames = (() => { try { return JSON.parse(agent.connectorIds || "[]"); } catch { return []; } })();
  const connectors = referencedNames.length
    ? allConnectors.filter(c => referencedNames.includes(c.name))
    : allConnectors; // if agent declares none, give it all

  const run = await req.db.agentRun.create({
    data: {
      agentId,
      triggeredByUserId: req.user.id || null,
      status:      "running",
      input:       input || null,
    },
  });

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");

  const { executeTool } = require("../utils/tools/registry");

  try {
    const llmConfig = await getLLMConfig();
    const steps     = (() => { try { return JSON.parse(agent.workflow || "[]"); } catch { return []; } })();

    await engine.run(
      {
        systemPrompt: agent.systemPrompt,
        workflow:     steps,
        params:       [],
        maxRounds:    25,
        input,
      },
      llmConfig,
      connectors,
      {
        toolExecutor: (name, args, conns) => executeTool(name, args, conns, req.db),
        onToolCall:   (name) => res.write(`data: ${JSON.stringify({ tool_call: name })}\n\n`),
        checkCancel:  async () => {
          const [cr] = await req.db.$queryRaw`SELECT cancelRequested FROM AgentRun WHERE id = ${run.id}`;
          return cr?.cancelRequested;
        },
        onDone: async (output) => {
          await req.db.agentRun.update({ where: { id: run.id }, data: { status: "success", output, completedAt: new Date() } });
          res.write(`data: ${JSON.stringify({ done: true, output, runId: run.id })}\n\n`);
          res.end();
        },
        onError: async (err) => {
          await req.db.agentRun.update({ where: { id: run.id }, data: { status: "error", error: err.message, completedAt: new Date() } });
          res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
          res.end();
        },
      }
    );
  } catch (err) {
    if (!res.writableEnded) {
      await req.db.agentRun.update({ where: { id: run.id }, data: { status: "error", error: err.message, completedAt: new Date() } }).catch(() => {});
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

module.exports = router;
