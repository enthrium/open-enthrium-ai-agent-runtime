const router = require("express").Router();
const { authenticate, requireManagerOrAdmin } = require("../middleware/auth");
const { executeTool } = require("../utils/tools/registry");
const { getLLMConfig } = require("../providers/llm");
const engine    = require("../engine");
const scheduler = require("../utils/scheduler");

router.use(authenticate, requireManagerOrAdmin);

// List agents for a workspace
router.get("/workspaces/:workspaceId/agents", async (req, res) => {
  try {
    const workspaceId = parseInt(req.params.workspaceId);
    const agents = await req.db.agent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
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

// Create agent
router.post("/workspaces/:workspaceId/agents", async (req, res) => {
  try {
    const workspaceId = parseInt(req.params.workspaceId);
    const { name, description, systemPrompt, connectorIds, triggerType, cronExpression, enabled, visualize, maxRounds } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });
    const agent = await req.db.agent.create({
      data: {
        workspaceId,
        name:           name.trim(),
        description:    description?.trim() || null,
        systemPrompt:   systemPrompt?.trim() || null,
        connectorIds:   JSON.stringify(connectorIds || []),
        triggerType:    triggerType || "manual",
        cronExpression: cronExpression || null,
        enabled:        enabled !== false,
        visualize:      visualize === true,
        maxRounds:      maxRounds ? Math.min(100, Math.max(1, parseInt(maxRounds))) : null,
        createdByUserId: req.user.id || null,
      },
    });
    scheduler.scheduleAgent(agent, req.db);
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update agent
router.put("/workspaces/:workspaceId/agents/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, slug, description, group, nextAgent, nextAgentCondition, chains, systemPrompt, workflow, connectorIds, triggerType, cronExpression, enabled, params, visualize, maxRounds } = req.body;
    const data = {};
    if (name                !== undefined) data.name                = name.trim();
    if (slug                !== undefined) data.slug                = slug?.trim() || null;
    if (description         !== undefined) data.description         = description?.trim() || null;
    if (group               !== undefined) data.group               = group?.trim() || null;
    if (nextAgent           !== undefined) data.nextAgent           = nextAgent?.trim() || null;
    if (nextAgentCondition  !== undefined) data.nextAgentCondition  = data.nextAgent ? (nextAgentCondition?.trim() || null) : null;
    if (chains              !== undefined) data.chains              = typeof chains === "string" ? chains : JSON.stringify(chains || []);
    if (systemPrompt        !== undefined) data.systemPrompt        = systemPrompt?.trim() || null;
    if (workflow            !== undefined) data.workflow            = typeof workflow === "string" ? workflow : JSON.stringify(workflow || []);
    if (connectorIds        !== undefined) data.connectorIds        = JSON.stringify(connectorIds);
    if (triggerType         !== undefined) data.triggerType         = triggerType;
    if (cronExpression      !== undefined) data.cronExpression      = cronExpression || null;
    if (enabled             !== undefined) data.enabled             = enabled;
    if (params              !== undefined) data.params              = typeof params === "string" ? params : JSON.stringify(params || []);
    if (visualize           !== undefined) data.visualize           = visualize === true;
    if (maxRounds           !== undefined) data.maxRounds           = maxRounds ? Math.min(100, Math.max(1, parseInt(maxRounds))) : null;
    const agent = await req.db.agent.update({ where: { id }, data });
    scheduler.scheduleAgent(agent, req.db);
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete agent
router.delete("/workspaces/:workspaceId/agents/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    scheduler.unscheduleAgent(id);
    await req.db.agent.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get run history for an agent
router.get("/workspaces/:workspaceId/agents/:id/runs", async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    const runs = await req.db.agentRun.findMany({
      where: { agentId },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a running agent run
router.post("/workspaces/:workspaceId/agents/:id/runs/:runId/cancel", async (req, res) => {
  try {
    const runId = parseInt(req.params.runId);
    await req.db.$executeRaw`UPDATE AgentRun SET cancelRequested = 1 WHERE id = ${runId}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run an agent (manual trigger)
router.post("/workspaces/:workspaceId/agents/:id/run", async (req, res) => {
  const agentId     = parseInt(req.params.id);
  const workspaceId = parseInt(req.params.workspaceId);
  const { input }   = req.body;

  const agent = await req.db.agent.findUnique({ where: { id: agentId } });
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  // Create a pending run record
  const run = await req.db.agentRun.create({
    data: { agentId, status: "running", triggerType: "manual", input: input || null },
  });

  // Stream SSE back
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const connectorIds = JSON.parse(agent.connectorIds || "[]");
    const connectors   = connectorIds.length
      ? await req.db.connector.findMany({ where: { id: { in: connectorIds }, status: "active" } })
      : [];

    const llmConfig  = await getLLMConfig();
    const agentSpec  = {
      systemPrompt: agent.systemPrompt,
      workflow:     JSON.parse(agent.workflow || "[]"),
      params:       JSON.parse(agent.params   || "[]"),
      maxRounds:    5,
      input,
    };

    await engine.run(agentSpec, llmConfig, connectors, {
      toolExecutor: (name, args, conns) => executeTool(name, args, conns, req.db),
      onToolCall:   (name) => res.write(`data: ${JSON.stringify({ tool_calls: [name] })}\n\n`),
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
    });
  } catch (err) {
    // onError hook already handled DB + SSE; guard against double-end
    if (!res.writableEnded) {
      await req.db.agentRun.update({ where: { id: run.id }, data: { status: "error", error: err.message, completedAt: new Date() } }).catch(() => {});
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

module.exports = router;
