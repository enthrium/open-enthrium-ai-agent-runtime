const router = require("express").Router();
const { authenticate, requireAdmin, requireManagerOrAdmin, requireCommercial } = require("../middleware/auth");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { getToolDefinitions, getAnthropicToolDefinitions, executeTool } = require("../utils/tools/registry");
const { getLLMClient, getSetting } = require("../providers/llm");
const { canRunAgent, incrementAgentRun, getTierFromDB } = require("../utils/tier");

function friendlyToolName(rawName, connectors) {
  const connId = rawName.match(/^conn_(\d+)_/)?.[1];
  const action = rawName.replace(/^conn_\d+_/, "");
  if (connId) {
    const conn = (connectors || []).find(c => c.id === parseInt(connId));
    return conn ? conn.name : action;
  }
  return rawName.replace(/_/g, " ");
}

function applyParams(template, paramDefs, paramValues) {
  let result = template || "";
  for (const p of (paramDefs || [])) {
    const val = String(paramValues?.[p.name] ?? p.default ?? "");
    result = result.split(`{{${p.name}}}`).join(val);
  }
  return result;
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
  const { name, systemPrompt, embedEnabled, temperature, chatHistory, queryRefusalResponse, starterPrompts, defaultAgentMaxRounds, maxChainDepth, agentMemoryEnabled, agentMemoryRuns } = req.body;
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
      ...(defaultAgentMaxRounds !== undefined && { defaultAgentMaxRounds: Math.max(1, Math.min(100, parseInt(defaultAgentMaxRounds) || 25)) }),
      ...(maxChainDepth !== undefined && { maxChainDepth: Math.max(1, Math.min(100, parseInt(maxChainDepth) || 5)) }),
      ...(agentMemoryEnabled !== undefined && { agentMemoryEnabled: Boolean(agentMemoryEnabled) }),
      ...(agentMemoryRuns !== undefined && { agentMemoryRuns: Math.max(1, Math.min(20, parseInt(agentMemoryRuns) || 5)) }),
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
function toAgentSlug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

// Active connectors for this workspace (owned + shared)
router.get("/:slug/connectors", authenticate, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const [owned, sharedIn] = await Promise.all([
      req.db.connector.findMany({
        where: { workspaceId: workspace.id, status: "active" },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, slug: true, type: true }
      }),
      req.db.connectorShare.findMany({
        where: { grantedWorkspaceId: workspace.id, connector: { status: "active" } },
        include: { connector: { select: { id: true, name: true, slug: true, type: true } } },
      }),
    ]);
    const connectors = [
      ...owned.map(c => ({ ...c, _owned: true })),
      ...sharedIn.map(s => ({ ...s.connector, _owned: false })),
    ];
    res.json({ connectors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export agent as portable JSON
router.get("/:slug/agents/:id/export", authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    if (!await assertWorkspaceMember(req.db, req.user, workspace.id)) return res.status(403).json({ error: "Access denied" });

    const agent = await req.db.agent.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const connectorIds = JSON.parse(agent.connectorIds || "[]");
    const connectors = connectorIds.length
      ? await req.db.connector.findMany({ where: { id: { in: connectorIds } }, select: { id: true, name: true, slug: true, type: true } })
      : [];

    res.json({
      oe_agent: "1.0",
      name:           agent.name,
      slug:           agent.slug || "",
      description:    agent.description || "",
      group:          agent.group || "",
      systemPrompt:   agent.systemPrompt || "",
      instructions:   agent.systemPrompt || "",
      steps:          agent.workflow ? JSON.parse(agent.workflow) : null,
      params:         JSON.parse(agent.params || "[]"),
      chains:         agent.chains ? JSON.parse(agent.chains) : [],
      connectorIds:   connectorIds,
      connectors:     connectors.map(c => ({ type: c.type, name: c.name })),
      trigger: {
        type: agent.triggerType,
        ...(agent.cronExpression ? { cron: agent.cronExpression } : {}),
      },
      triggerType:    agent.triggerType,
      cronExpression: agent.cronExpression || null,
      enabled:        agent.enabled,
      visualize:      agent.visualize || false,
      nextAgent:      agent.nextAgent || null,
      nextAgentCondition: agent.nextAgentCondition || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Import agent from portable JSON
router.post("/:slug/agents/import", authenticate, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const { agentJson } = req.body;
    if (!agentJson?.name) return res.status(400).json({ error: "Invalid agent file — missing name field" });

    const activeConnectors = await req.db.connector.findMany({
      where: { workspaceId: workspace.id, status: "active" },
      select: { id: true, type: true, name: true, slug: true }
    });

    const matchedIds = [];
    const unmatchedTypes = [];
    for (const c of (agentJson.connectors || [])) {
      const match = activeConnectors.find(ac => ac.name === (c.connection_name || c.name) && ac.type === (c.connection_type || c.type))
        || activeConnectors.find(ac => ac.name === (c.connection_name || c.name));
      if (match) matchedIds.push(match.id);
      else unmatchedTypes.push(c.name || c.type);
    }

    let importedSlug = agentJson.slug?.trim() || toAgentSlug(agentJson.name || "imported-agent");
    const slugExists  = await req.db.agent.findFirst({ where: { slug: importedSlug } });
    if (slugExists) importedSlug = importedSlug + "-" + Math.random().toString(36).slice(2, 7);

    const agent = await req.db.agent.create({
      data: {
        workspaceId:     workspace.id,
        name:            agentJson.name || "Imported Agent",
        slug:            importedSlug,
        systemPrompt:    agentJson.systemPrompt || agentJson.instructions || null,
        workflow:        (() => {
          if (agentJson.steps?.length) {
            // steps[] from YAML: {name, content} → stored as workflow
            const s = agentJson.steps.map((s, i) => ({ id: String(i + 1), name: s.name || `Step ${i+1}`, content: s.content || s.instructions || "" }));
            return JSON.stringify(s);
          }
          if (agentJson.workflow) return JSON.stringify(agentJson.workflow);
          return null;
        })(),
        group:              agentJson.group?.trim() || null,
        description:        agentJson.description || null,
        nextAgent:          agentJson.next_agent?.trim() || agentJson.nextAgent?.trim() || null,
        nextAgentCondition: agentJson.next_agent_condition?.trim() || agentJson.nextAgentCondition?.trim() || null,
        chains:             agentJson.chains?.length ? JSON.stringify(agentJson.chains) : null,
        params:             JSON.stringify(agentJson.params || []),
        connectorIds:    JSON.stringify(matchedIds),
        triggerType:     agentJson.trigger?.type || agentJson.triggerType || "manual",
        cronExpression:  agentJson.trigger?.cron || agentJson.cronExpression || null,
        enabled:         agentJson.enabled !== false,
        createdByUserId: req.user.id || null,
      },
      include: { createdBy: { select: { id: true, name: true, email: true } }, runs: true }
    });

    const scheduler = require("../utils/scheduler");
    scheduler.scheduleAgent(agent, req.db);

    res.json({ agent, unmatchedTypes, slugRenamed: slugExists ? importedSlug : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update agent via YAML (resolves connector names server-side)
router.put("/:slug/agents/:id/yaml", authenticate, async (req, res) => {
  try {
    const id        = parseInt(req.params.id);
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    if (!await assertWorkspaceMember(req.db, req.user, workspace.id)) return res.status(403).json({ error: "Access denied" });

    const agent = await req.db.agent.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const { agentJson } = req.body;
    if (!agentJson?.name) return res.status(400).json({ error: "Missing name field" });

    const activeConnectors = await req.db.connector.findMany({
      where: { workspaceId: workspace.id, status: "active" },
      select: { id: true, type: true, name: true }
    });
    const matchedIds = [];
    for (const c of (agentJson.connectors || [])) {
      const match = activeConnectors.find(ac => ac.name === c.name && ac.type === c.type);
      if (match) matchedIds.push(match.id);
    }

    const updated = await req.db.agent.update({
      where: { id },
      data: {
        name:               agentJson.name,
        slug:               agentJson.slug?.trim() || agent.slug,
        description:        agentJson.description || null,
        group:              agentJson.group?.trim() || null,
        systemPrompt:       agentJson.instructions || agentJson.systemPrompt || null,
        workflow:           (() => {
          if (agentJson.steps?.length) {
            const s = agentJson.steps.map((s, i) => ({ id: String(i + 1), name: s.name || `Step ${i+1}`, content: s.content || s.instructions || "" }));
            return JSON.stringify(s);
          }
          if (agentJson.workflow) return JSON.stringify(agentJson.workflow);
          return null;
        })(),
        nextAgent:          agentJson.next_agent?.trim() || agentJson.nextAgent?.trim() || null,
        nextAgentCondition: agentJson.next_agent_condition?.trim() || agentJson.nextAgentCondition?.trim() || null,
        chains:             agentJson.chains?.length ? JSON.stringify(agentJson.chains) : null,
        params:             JSON.stringify(agentJson.params || []),
        connectorIds:       JSON.stringify(matchedIds),
        triggerType:        agentJson.trigger?.type || agentJson.triggerType || "manual",
        cronExpression:     agentJson.trigger?.cron || agentJson.cronExpression || null,
        enabled:            agentJson.enabled !== false,
      },
    });

    const scheduler = require("../utils/scheduler");
    scheduler.scheduleAgent(updated, req.db);

    res.json({ agent: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Check agent slug availability (system-wide)
router.get("/agents/check-slug", authenticate, async (req, res) => {
  try {
    const { slug, excludeId } = req.query;
    if (!slug) return res.json({ available: false });
    const where = { slug };
    if (excludeId) where.id = { not: parseInt(excludeId) };
    const exists = await req.db.agent.findFirst({ where });
    res.json({ available: !exists });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List agents — workspace agents + agents shared with this workspace
router.get("/:slug/agents", authenticate, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const include = {
      createdBy: { select: { id: true, name: true, email: true } },
      runs: { orderBy: { startedAt: "desc" }, take: 1, select: { id: true, status: true, startedAt: true } }
    };

    const ownedWhere = { workspaceId: workspace.id };
    if (!isManagerOrAdmin(req.user)) ownedWhere.createdByUserId = req.user.id;

    const [ownedAgents, shares] = await Promise.all([
      req.db.agent.findMany({ where: ownedWhere, orderBy: { createdAt: "desc" }, include }),
      req.db.agentShare.findMany({
        where: { grantedWorkspaceId: workspace.id },
        include: { agent: { include } },
      }),
    ]);

    const agents = [
      ...ownedAgents.map(a => ({ ...a, _owned: true })),
      ...shares.map(s => ({ ...s.agent, _owned: false })),
    ];

    res.json({ agents });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create agent
router.post("/:slug/agents", authenticate, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const { name, description, systemPrompt, workflow, group, nextAgent, nextAgentCondition, chains, connectorIds, triggerType, cronExpression, enabled, params } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });

    const agentSlug = req.body.slug?.trim() || toAgentSlug(name.trim());
    const slugTaken = await req.db.agent.findFirst({ where: { slug: agentSlug } });
    if (slugTaken) return res.status(409).json({ error: `Agent ID "${agentSlug}" is already taken. Please choose a different one.` });

    const agent = await req.db.agent.create({
      data: {
        workspaceId:        workspace.id,
        name:               name.trim(),
        slug:               agentSlug,
        description:        description?.trim() || null,
        systemPrompt:       systemPrompt?.trim() || null,
        workflow:           workflow ? JSON.stringify(workflow) : null,
        group:              group?.trim() || null,
        nextAgent:          nextAgent?.trim() || null,
        nextAgentCondition: nextAgent?.trim() ? (nextAgentCondition?.trim() || null) : null,
        chains:             chains?.length ? JSON.stringify(chains) : null,
        params:         JSON.stringify(params || []),
        connectorIds:   JSON.stringify(connectorIds || []),
        triggerType:    triggerType || "manual",
        cronExpression: cronExpression || null,
        enabled:        enabled !== false,
        createdByUserId: req.user.id || null,
      },
      include: { createdBy: { select: { id: true, name: true, email: true } }, runs: true }
    });
    const scheduler = require("../utils/scheduler");
    scheduler.scheduleAgent(agent, req.db);
    res.json({ agent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update agent — managers can update any; users only their own
router.put("/:slug/agents/:id", authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const existing = await req.db.agent.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!existing) return res.status(404).json({ error: "Agent not found" });
    if (!isManagerOrAdmin(req.user) && existing.createdByUserId !== req.user.id)
      return res.status(403).json({ error: "Not allowed" });

    const { name, description, systemPrompt, workflow, group, nextAgent, nextAgentCondition, chains, connectorIds, triggerType, cronExpression, enabled, slug, params } = req.body;
    const data = {};
    if (name                !== undefined) data.name                = name.trim();
    if (description         !== undefined) data.description         = description?.trim() || null;
    if (systemPrompt        !== undefined) data.systemPrompt        = systemPrompt?.trim() || null;
    if (workflow            !== undefined) data.workflow            = workflow ? JSON.stringify(workflow) : null;
    if (group               !== undefined) data.group               = group?.trim() || null;
    if (nextAgent           !== undefined) data.nextAgent           = nextAgent?.trim() || null;
    if (nextAgentCondition  !== undefined) data.nextAgentCondition  = data.nextAgent ? (nextAgentCondition?.trim() || null) : null;
    if (chains              !== undefined) data.chains              = chains?.length ? JSON.stringify(chains) : null;
    if (params         !== undefined) data.params         = JSON.stringify(params);
    if (connectorIds   !== undefined) data.connectorIds   = JSON.stringify(connectorIds);
    if (triggerType    !== undefined) data.triggerType    = triggerType;
    if (triggerType === "manual") data.cronExpression = null;
    else if (cronExpression !== undefined) data.cronExpression = cronExpression || null;
    if (enabled        !== undefined) data.enabled        = enabled;
    if (slug !== undefined) {
      const newSlug = slug?.trim() || toAgentSlug((name || existing.name).trim());
      if (newSlug !== existing.slug) {
        const slugTaken = await req.db.agent.findFirst({ where: { slug: newSlug } });
        if (slugTaken) return res.status(409).json({ error: `Agent ID "${newSlug}" is already taken. Please choose a different one.` });
      }
      data.slug = newSlug;
    }

    const agent = await req.db.agent.update({
      where: { id },
      data,
      include: { createdBy: { select: { id: true, name: true, email: true } }, runs: { orderBy: { startedAt: "desc" }, take: 1 } }
    });
    const scheduler = require("../utils/scheduler");
    scheduler.scheduleAgent(agent, req.db);
    res.json({ agent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete agent — managers can delete any; users only their own
router.delete("/:slug/agents/:id", authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const existing = await req.db.agent.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!existing) return res.status(404).json({ error: "Agent not found" });
    if (!isManagerOrAdmin(req.user) && existing.createdByUserId !== req.user.id)
      return res.status(403).json({ error: "Not allowed" });

    const scheduler = require("../utils/scheduler");
    scheduler.unscheduleAgent(id);
    await req.db.agent.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cancel a running agent run
router.post("/:slug/agents/:agentId/runs/:runId/cancel", authenticate, async (req, res) => {
  try {
    const runId = parseInt(req.params.runId);
    await req.db.$executeRaw`UPDATE AgentRun SET cancelRequested = 1 WHERE id = ${runId}`;
    await req.db.agentRun.update({
      where: { id: runId },
      data: { status: "cancelled", output: "⛔ Run stopped by user.", completedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// All runs for a workspace (owned agents + shared agents visible to this workspace)
router.get("/:slug/agent-runs", authenticate, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    // Collect agent IDs: own agents + agents shared to this workspace
    const shares = await req.db.agentShare.findMany({
      where: { grantedWorkspaceId: workspace.id },
      select: { agentId: true },
    });
    const sharedAgentIds = shares.map(s => s.agentId);

    const agentFilter = {
      OR: [
        // Own agents — all their runs
        { agent: { workspaceId: workspace.id } },
        // Any run triggered from this workspace (shared agents, chained agents, etc.)
        { triggeredFromWorkspaceId: workspace.id },
      ],
    };
    const { period } = req.query;
    const days = { "7d": 7, "30d": 30 }[period];
    if (days) agentFilter.startedAt = { gte: new Date(Date.now() - days * 86400000) };

    const runs = await req.db.agentRun.findMany({
      where: agentFilter,
      orderBy: { startedAt: "desc" },
      take: 200,
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        triggeredBy: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ runs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clear agent run logs for this workspace
router.delete("/:slug/agent-runs", authenticate, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    if (!await assertWorkspaceMember(req.db, req.user, workspace.id)) return res.status(403).json({ error: "Access denied" });

    const { count } = await req.db.agentRun.deleteMany({
      where: {
        OR: [
          { agent: { workspaceId: workspace.id } },
          { triggeredFromWorkspaceId: workspace.id },
        ],
      },
    });
    res.json({ deleted: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Run history for an agent
router.get("/:slug/agents/:id/runs", authenticate, async (req, res) => {
  try {
    const agentId = parseInt(req.params.id);
    const runs = await req.db.agentRun.findMany({
      where: { agentId },
      orderBy: { startedAt: "desc" },
      take: 20
    });
    res.json({ runs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Run an agent — SSE stream, user-accessible
router.post("/:slug/agents/:id/run", authenticate, async (req, res) => {
  const agentId = parseInt(req.params.id);
  const { input, params: runParams } = req.body;

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  if (!await assertWorkspaceMember(req.db, req.user, workspace.id)) return res.status(403).json({ error: "Access denied" });

  const agent = await req.db.agent.findFirst({ where: { id: agentId, workspaceId: workspace.id } });
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const run = await req.db.agentRun.create({
    data: { agentId, status: "running", triggerType: "manual", input: input || null, triggeredByUserId: req.user?.id || null, triggeredFromWorkspaceId: workspace.id },
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify({ runId: run.id })}\n\n`);

  try {
    const allowed = await canRunAgent(req.db);
    if (!allowed) {
      const tier = await getTierFromDB(req.db);
      await req.db.agentRun.update({ where: { id: run.id }, data: { status: "error", error: "Run limit reached", completedAt: new Date() } });
      res.write(`data: ${JSON.stringify({ error: `Agent run limit reached. Max ${tier.maxAgentRunsPerMonth} runs/month.` })}\n\n`);
      res.end();
      return;
    }
    await incrementAgentRun(req.db);

    const connectorIds = JSON.parse(agent.connectorIds || "[]");
    const connectors   = connectorIds.length
      ? await req.db.connector.findMany({ where: { id: { in: connectorIds }, status: "active" } })
      : [];

    const { buildSystemPrompt } = require("../utils/workflowEngine");
    const paramDefs   = JSON.parse(agent.params || "[]");
    const systemPrompt = applyParams(
      buildSystemPrompt(agent) || "You are a helpful AI agent. Complete the task given to you using the available tools.",
      paramDefs, runParams
    );
    const userMessage  = input?.trim() || "Execute the agent task now using the available tools. Do not ask for clarification.";

    const { provider, client } = await getLLMClient();
    const model = (await getSetting("llm_model")) || process.env.OPENAI_MODEL || process.env.OLLAMA_MODEL || "gpt-4o";
    const MAX_ROUNDS = workspace.defaultAgentMaxRounds || 25;
    let fullOutput = "";
    const runToolCallNames = [];
    const hasWorkflow = (JSON.parse(agent.workflow || "[]")).length > 0;

    let wasCancelled = false;
    if (provider === "anthropic") {
      const tools = [...getAnthropicToolDefinitions(connectors)];
      const msgs  = [{ role: "user", content: userMessage }];
      let madeToolCall = false;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const cancelCheck = await req.db.agentRun.findUnique({ where: { id: run.id }, select: { cancelRequested: true } });
        if (cancelCheck?.cancelRequested) { wasCancelled = true; fullOutput = "⛔ Run stopped by user."; break; }
        const resp = await client.messages.create({
          model: model || "claude-sonnet-4-6",
          max_tokens: 4096, system: systemPrompt, messages: msgs,
          tools: tools.length ? tools : undefined, temperature: 0.3,
        });
        if (resp.stop_reason !== "tool_use" || !tools.length) {
          if (hasWorkflow && tools.length && !madeToolCall && round === 0) {
            msgs.push({ role: "assistant", content: resp.content });
            msgs.push({ role: "user", content: "Do not plan or summarise. Call your first tool RIGHT NOW." });
            continue;
          }
          fullOutput = resp.content?.find(b => b.type === "text")?.text || "";
          break;
        }
        madeToolCall = true;
        const toolUseBlocks = resp.content.filter(b => b.type === "tool_use");
        const names = toolUseBlocks.map(b => friendlyToolName(b.name, connectors));
        runToolCallNames.push(...names);
        res.write(`data: ${JSON.stringify({ tool_calls: names })}\n\n`);
        msgs.push({ role: "assistant", content: resp.content });
        const toolResults = [];
        for (const tb of toolUseBlocks) {
          const result = await executeTool(tb.name, tb.input, connectors, req.db);
          toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: String(result) });
        }
        msgs.push({ role: "user", content: toolResults });
        if (round === MAX_ROUNDS - 1) {
          const finalResp = await client.messages.create({
            model: model || "claude-sonnet-4-6",
            max_tokens: 4096, system: systemPrompt, messages: msgs, temperature: 0.3,
          });
          fullOutput = finalResp.content?.find(b => b.type === "text")?.text || "";
        }
      }
    } else {
      const tools    = [...getToolDefinitions(connectors)];
      const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
      let madeToolCall = false;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const cancelCheck = await req.db.agentRun.findUnique({ where: { id: run.id }, select: { cancelRequested: true } });
        if (cancelCheck?.cancelRequested) { wasCancelled = true; fullOutput = "⛔ Run stopped by user."; break; }
        const reqBody = { model, messages, temperature: 0.3, max_tokens: 4096 };
        if (tools.length) { reqBody.tools = tools; reqBody.tool_choice = "auto"; }
        const resp   = await client.chat.completions.create(reqBody);
        const choice = resp.choices[0];
        if (choice.finish_reason !== "tool_calls" || !tools.length) {
          if (hasWorkflow && tools.length && !madeToolCall && round === 0) {
            messages.push(choice.message);
            messages.push({ role: "user", content: "Do not plan or summarise. Call your first tool RIGHT NOW." });
            continue;
          }
          fullOutput = choice.message.content || "";
          break;
        }
        madeToolCall = true;
        const toolCalls = choice.message.tool_calls || [];
        const names = toolCalls.map(tc => friendlyToolName(tc.function.name, connectors));
        runToolCallNames.push(...names);
        res.write(`data: ${JSON.stringify({ tool_calls: names })}\n\n`);
        messages.push(choice.message);
        for (const tc of toolCalls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* */ }
          const result = await executeTool(tc.function.name, args, connectors, req.db);
          messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
        }
        if (round === MAX_ROUNDS - 1) {
          const finalResp = await client.chat.completions.create({ model, messages, temperature: 0.3, max_tokens: 4096 });
          fullOutput = finalResp.choices[0].message.content || "";
        }
      }
    }

    // Final cancel check — catches the race where cancel was requested
    // while an LLM call was in-flight and the loop exited via natural finish_reason
    if (!wasCancelled) {
      const finalCancel = await req.db.agentRun.findUnique({ where: { id: run.id }, select: { cancelRequested: true } });
      if (finalCancel?.cancelRequested) { wasCancelled = true; fullOutput = "⛔ Run stopped by user."; }
    }

    // Append tool call summary to output for logs
    if (!wasCancelled && runToolCallNames.length) {
      const counts = runToolCallNames.reduce((acc, n) => { acc[n] = (acc[n] || 0) + 1; return acc; }, {});
      const summary = Object.entries(counts).map(([n, c]) => `  ✅ ${n}${c > 1 ? ` ×${c}` : ""}`).join("\n");
      fullOutput += `\n\n---\n🔧 Tool calls:\n${summary}`;
    }

    if (!wasCancelled) {
      await req.db.agentRun.update({
        where: { id: run.id },
        data:  { status: "success", output: fullOutput, completedAt: new Date() },
      });
      const { maybeChain } = require("../utils/agentChain");
      maybeChain(agent, fullOutput, req.db, 0, { workspaceId: workspace.id, runId: run.id }).catch(e => console.error("[chain]", e.message));
    }

    res.write(`data: ${JSON.stringify({ done: true, output: fullOutput, cancelled: wasCancelled })}\n\n`);
    res.end();
  } catch (err) {
    await req.db.agentRun.update({
      where: { id: run.id },
      data:  { status: "error", error: err.message, completedAt: new Date() },
    });
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── Agent Sharing ─────────────────────────────────────────────────────────────

// List shares for agents in this workspace
router.get("/:slug/agent-shares", authenticate, requireCommercial, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const shares = await req.db.agentShare.findMany({
      where: { agent: { workspaceId: workspace.id } },
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        grantedWorkspace: { select: { id: true, slug: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({ shares });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create a share
router.post("/:slug/agent-shares", authenticate, requireCommercial, requireManagerOrAdmin, async (req, res) => {
  try {
    const featureSetting = await req.db.setting.findUnique({ where: { key: "feature.agentSharing" } });
    if (featureSetting?.value === "false") return res.status(403).json({ error: "Agent Sharing is disabled on this installation." });

    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const { agentId, grantedWorkspaceId } = req.body;
    const agent = await req.db.agent.findFirst({ where: { id: agentId, workspaceId: workspace.id } });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const granted = await req.db.workspace.findUnique({ where: { id: grantedWorkspaceId } });
    if (!granted) return res.status(404).json({ error: "Target workspace not found" });
    if (granted.id === workspace.id) return res.status(400).json({ error: "Cannot share with your own workspace" });

    const share = await req.db.agentShare.upsert({
      where: { agentId_grantedWorkspaceId: { agentId, grantedWorkspaceId } },
      create: { agentId, grantedWorkspaceId },
      update: {},
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        grantedWorkspace: { select: { id: true, slug: true, name: true } },
      },
    });
    res.json({ share });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a share
router.delete("/:slug/agent-shares/:shareId", authenticate, requireCommercial, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const share = await req.db.agentShare.findFirst({
      where: { id: parseInt(req.params.shareId), agent: { workspaceId: workspace.id } },
    });
    if (!share) return res.status(404).json({ error: "Share not found" });

    await req.db.agentShare.delete({ where: { id: share.id } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Connector Shares ─────────────────────────────────────────────────────────

router.get("/:slug/connector-shares", authenticate, requireCommercial, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const shares = await req.db.connectorShare.findMany({
      where: { connector: { workspaceId: workspace.id } },
      include: {
        connector: { select: { id: true, name: true, slug: true, type: true } },
        grantedWorkspace: { select: { id: true, slug: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({ shares });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/:slug/connector-shares", authenticate, requireCommercial, requireManagerOrAdmin, async (req, res) => {
  try {
    const featureSetting = await req.db.setting.findUnique({ where: { key: "feature.connectorSharing" } });
    if (featureSetting?.value === "false") return res.status(403).json({ error: "Connector Sharing is disabled on this installation." });
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { connectorId, grantedWorkspaceId } = req.body;
    const connector = await req.db.connector.findFirst({ where: { id: connectorId, workspaceId: workspace.id } });
    if (!connector) return res.status(404).json({ error: "Connector not found" });
    const granted = await req.db.workspace.findUnique({ where: { id: grantedWorkspaceId } });
    if (!granted) return res.status(404).json({ error: "Target workspace not found" });
    if (granted.id === workspace.id) return res.status(400).json({ error: "Cannot share with your own workspace" });
    const share = await req.db.connectorShare.upsert({
      where: { connectorId_grantedWorkspaceId: { connectorId, grantedWorkspaceId } },
      create: { connectorId, grantedWorkspaceId },
      update: {},
      include: {
        connector: { select: { id: true, name: true, slug: true, type: true } },
        grantedWorkspace: { select: { id: true, slug: true, name: true } },
      },
    });
    res.json({ share });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/:slug/connector-shares/:shareId", authenticate, requireCommercial, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const share = await req.db.connectorShare.findFirst({
      where: { id: parseInt(req.params.shareId), connector: { workspaceId: workspace.id } },
    });
    if (!share) return res.status(404).json({ error: "Share not found" });
    await req.db.connectorShare.delete({ where: { id: share.id } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Chain Approvals ──────────────────────────────────────────────────────────

router.get("/:slug/chain-approvals", authenticate, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const approvals = await req.db.chainApproval.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { sourceAgent: { select: { id: true, name: true, slug: true } } },
    });
    res.json({ approvals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/:slug/chain-approvals/:id", authenticate, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    const { decision } = req.body; // "approved" | "rejected"
    if (!["approved", "rejected"].includes(decision)) return res.status(400).json({ error: "Invalid decision" });

    const approval = await req.db.chainApproval.findFirst({
      where: { id: parseInt(req.params.id), workspaceId: workspace.id, status: "pending" },
    });
    if (!approval) return res.status(404).json({ error: "Approval not found or already decided" });

    await req.db.chainApproval.update({
      where: { id: approval.id },
      data: { status: decision, decidedAt: new Date(), decidedByUserId: req.user?.id || null },
    });

    const chatCtx = { workspaceId: workspace.id, threadId: approval.threadId || null };

    const nextAgent = await req.db.agent.findFirst({ where: { slug: approval.nextAgentSlug } });

    if (decision === "approved") {
      if (nextAgent) {
        await req.db.chat.create({
          data: { workspaceId: workspace.id, threadId: chatCtx.threadId, role: "assistant",
            content: `*✅ Approved — running @${approval.nextAgentSlug}…*` },
        });
        const { runChainedAgent } = require("../utils/agentChain");
        runChainedAgent(nextAgent, req.db, approval.runOutput, 0, chatCtx).catch(e => console.error("[approval]", e.message));
      }
    } else {
      if (nextAgent) {
        await req.db.agentRun.create({
          data: {
            agentId: nextAgent.id,
            status: "rejected",
            triggerType: "chained",
            input: (approval.runOutput || "").slice(0, 2000) || null,
            output: "❌ Chain rejected by user — agent was not started.",
            triggeredFromWorkspaceId: workspace.id,
            completedAt: new Date(),
          },
        });
      }
      await req.db.chat.create({
        data: { workspaceId: workspace.id, threadId: chatCtx.threadId, role: "assistant",
          content: `*❌ Chain rejected — @${approval.nextAgentSlug} will not run.*` },
      });
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clear all non-pending approvals for this workspace
router.delete("/:slug/chain-approvals", authenticate, requireManagerOrAdmin, async (req, res) => {
  try {
    const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    await req.db.chainApproval.deleteMany({
      where: { workspaceId: workspace.id, status: { not: "pending" } },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

module.exports = router;
