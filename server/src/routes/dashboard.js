const router = require("express").Router();
const { authenticate, requireCommercial } = require("../middleware/auth");
const { getTierFromDB, getAgentRunsThisMonth } = require("../utils/tier");

const EMBEDDING_RATES = {
  "text-embedding-3-small": 0.02  / 1_000_000,
  "text-embedding-3-large": 0.13  / 1_000_000,
  "text-embedding-ada-002": 0.10  / 1_000_000,
};

const LLM_RATES = {
  "gpt-4o":                     { in: 2.50  / 1e6, out: 10.00 / 1e6 },
  "gpt-4o-mini":                { in: 0.15  / 1e6, out:  0.60 / 1e6 },
  "gpt-4-turbo":                { in: 10.00 / 1e6, out: 30.00 / 1e6 },
  "claude-3-5-sonnet-20241022": { in: 3.00  / 1e6, out: 15.00 / 1e6 },
  "claude-3-5-haiku-20241022":  { in: 0.80  / 1e6, out:  4.00 / 1e6 },
  "claude-3-opus-20240229":     { in: 15.00 / 1e6, out: 75.00 / 1e6 },
  "claude-3-haiku-20240307":    { in: 0.25  / 1e6, out:  1.25 / 1e6 },
};

function calcEmbeddingCost(tokens, model) {
  return (tokens || 0) * (EMBEDDING_RATES[model] || 0.10 / 1_000_000);
}

function calcLLMCost(inputTokens, outputTokens, model) {
  const r = LLM_RATES[model] || { in: 2.50 / 1e6, out: 10.00 / 1e6 };
  return (inputTokens || 0) * r.in + (outputTokens || 0) * r.out;
}

function last30Days() {
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (29 - i));
    return d.toISOString().slice(0, 10);
  });
}

function groupByDay(items, dateField) {
  const map = {};
  for (const item of items) {
    const day = new Date(item[dateField]).toISOString().slice(0, 10);
    map[day] = (map[day] || 0) + 1;
  }
  return last30Days().map(d => ({ date: d, count: map[d] || 0 }));
}

function statusSeries(counts) {
  return [
    { name: "Ready",   value: counts.ready   || 0, color: "#22c55e" },
    { name: "Failed",  value: counts.failed  || 0, color: "#ef4444" },
    { name: "Partial", value: counts.partial || 0, color: "#f59e0b" },
    { name: "Active",  value: (counts.ingesting || 0) + (counts.queued || 0), color: "#6366f1" },
  ].filter(s => s.value > 0);
}

// Manager stats — scoped to user's workspaces (admin sees all)
router.get("/manager", authenticate, async (req, res) => {
  const db = req.db;

  let workspaceIds;
  if (req.user.role === "admin") {
    const all = await db.workspace.findMany({ select: { id: true } });
    workspaceIds = all.map(w => w.id);
  } else {
    const memberships = await db.workspaceUser.findMany({
      where: { userId: req.user.id },
      select: { workspaceId: true }
    });
    workspaceIds = memberships.map(m => m.workspaceId);
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);

  const agentIds = (await db.agent.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { id: true } })).map(a => a.id);

  const [workspaces, documents, agentRuns] = await Promise.all([
    db.workspace.findMany({
      where: { id: { in: workspaceIds } },
      include: { _count: { select: { documents: true, chats: true } } }
    }),
    db.document.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { status: true, chunkCount: true, createdAt: true }
    }),
    agentIds.length ? db.agentRun.findMany({
      where: { agentId: { in: agentIds }, startedAt: { gte: thirtyDaysAgo } },
      select: { startedAt: true, status: true, triggerType: true }
    }) : Promise.resolve([]),
  ]);

  const statusCounts = {};
  let totalVectors = 0;
  for (const d of documents) {
    statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
    totalVectors += d.chunkCount || 0;
  }

  res.json({
    workspaceCount:   workspaces.length,
    documentCount:    documents.length,
    vectorCount:      totalVectors,
    activeIngestions: (statusCounts.ingesting || 0) + (statusCounts.queued || 0),
    agentRunCount:    agentRuns.length,
    agentRunSuccess:  agentRuns.filter(r => r.status === "success").length,
    agentRunErrors:   agentRuns.filter(r => r.status === "error").length,
    agentRunsByTrigger: [
      { name: "Manual",    value: agentRuns.filter(r => r.triggerType !== "scheduled").length, color: "#6366f1" },
      { name: "Scheduled", value: agentRuns.filter(r => r.triggerType === "scheduled").length, color: "#f59e0b" },
    ].filter(s => s.value > 0),
    documentsByStatus:  statusSeries(statusCounts),
    agentRunActivity:   groupByDay(agentRuns, "startedAt"),
    docsByWorkspace: workspaces
      .map(ws => ({
        name:      ws.name.length > 18 ? ws.name.slice(0, 18) + "…" : ws.name,
        documents: ws._count.documents,
        chats:     ws._count.chats,
      }))
      .sort((a, b) => b.documents - a.documents)
      .slice(0, 8),
    ingestActivity: groupByDay(
      documents.filter(d => new Date(d.createdAt) >= thirtyDaysAgo),
      "createdAt"
    ),
  });
});

// Admin stats — platform-wide
router.get("/admin", authenticate, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const db = req.db;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);

  const tier = await getTierFromDB(db);

  const [users, workspaces, documents, recentUserChats, allAssistantChats, connectorCount, agentRunsThisMonth, recentAgentRuns] = await Promise.all([
    db.user.findMany({ select: { id: true, role: true, createdAt: true } }),
    db.workspace.findMany({
      select: { id: true, name: true, _count: { select: { documents: true, chats: true } } }
    }),
    db.document.findMany({
      select: { status: true, chunkCount: true, embeddingTokens: true, embeddingModel: true, createdAt: true, size: true }
    }),
    db.chat.findMany({
      where: { role: "user", createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true }
    }),
    db.chat.findMany({
      where: { role: "assistant" },
      select: { inputTokens: true, outputTokens: true, model: true }
    }),
    db.connector.count(),
    getAgentRunsThisMonth(db),
    db.agentRun.findMany({
      where: { startedAt: { gte: thirtyDaysAgo } },
      select: { startedAt: true, status: true, triggerType: true }
    }),
  ]);

  // Document stats
  const statusCounts = {};
  let totalVectors = 0, totalEmbedTokens = 0, totalEmbedCost = 0, totalStorageBytes = 0;
  for (const d of documents) {
    statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
    totalVectors     += d.chunkCount || 0;
    totalEmbedTokens += d.embeddingTokens || 0;
    totalEmbedCost   += calcEmbeddingCost(d.embeddingTokens, d.embeddingModel);
    totalStorageBytes += d.size || 0;
  }
  const storageUsedGb = totalStorageBytes / (1024 ** 3);

  // LLM stats
  let llmInputTokens = 0, llmOutputTokens = 0, llmCost = 0;
  for (const c of allAssistantChats) {
    llmInputTokens  += c.inputTokens  || 0;
    llmOutputTokens += c.outputTokens || 0;
    llmCost         += calcLLMCost(c.inputTokens, c.outputTokens, c.model);
  }

  res.json({
    // Summary counts
    userCount:        users.length,
    workspaceCount:   workspaces.length,
    documentCount:    documents.length,
    vectorCount:      totalVectors,
    chatCount:        allAssistantChats.length,
    activeIngestions: (statusCounts.ingesting || 0) + (statusCounts.queued || 0),
    // Cost
    embeddingTokens:  totalEmbedTokens,
    embeddingCostUsd: totalEmbedCost,
    llmInputTokens,
    llmOutputTokens,
    llmCostUsd:       llmCost,
    totalCostUsd:     totalEmbedCost + llmCost,
    // Charts
    documentsByStatus: statusSeries(statusCounts),
    usersByRole: [
      { name: "Admin",   value: users.filter(u => u.role === "admin").length,   color: "#6366f1" },
      { name: "Manager", value: users.filter(u => u.role === "manager").length, color: "#f59e0b" },
      { name: "User",    value: users.filter(u => u.role === "user").length,    color: "#22c55e" },
    ].filter(u => u.value > 0),
    topWorkspaces: workspaces
      .sort((a, b) => b._count.chats - a._count.chats)
      .slice(0, 8)
      .map(ws => ({
        name:      ws.name.length > 16 ? ws.name.slice(0, 16) + "…" : ws.name,
        chats:     ws._count.chats,
        documents: ws._count.documents,
      })),
    // Usage vs limits — commercial only; null means unlimited (Infinity can't serialize to JSON)
    usage: (process.env.LICENSE_TYPE === "enterprise" && process.env.LICENSE_EDITION === "Open Enterprise Commercial" && process.env.LICENSE_PRICE === "custom") ? {
      tierName:             tier.name,
      workspaceCount:       workspaces.length,
      workspaceLimit:       isFinite(tier.maxWorkspaces)        ? tier.maxWorkspaces        : null,
      userCount:            users.length,
      userLimit:            isFinite(tier.maxUsers)             ? tier.maxUsers             : null,
      connectorCount,
      connectorLimit:       isFinite(tier.maxConnectors)        ? tier.maxConnectors        : null,
      agentRunsThisMonth,
      agentRunsLimit:       isFinite(tier.maxAgentRunsPerMonth) ? tier.maxAgentRunsPerMonth : null,
      storageUsedGb:        parseFloat(storageUsedGb.toFixed(3)),
      storageUsedBytes:     totalStorageBytes,
      storageLimitGb:       isFinite(tier.ingestionSpaceGb)     ? tier.ingestionSpaceGb     : null,
    } : null,
    agentRunCount:    recentAgentRuns.length,
    agentRunSuccess:  recentAgentRuns.filter(r => r.status === "success").length,
    agentRunErrors:   recentAgentRuns.filter(r => r.status === "error").length,
    agentRunsByTrigger: [
      { name: "Manual",    value: recentAgentRuns.filter(r => r.triggerType !== "scheduled").length, color: "#6366f1" },
      { name: "Scheduled", value: recentAgentRuns.filter(r => r.triggerType === "scheduled").length, color: "#f59e0b" },
    ].filter(s => s.value > 0),
    chatActivity:     groupByDay(recentUserChats, "createdAt"),
    agentRunActivity: groupByDay(recentAgentRuns, "startedAt"),
    ingestActivity:   groupByDay(
      documents.filter(d => new Date(d.createdAt) >= thirtyDaysAgo),
      "createdAt"
    ),
    userGrowth: groupByDay(
      users.filter(u => new Date(u.createdAt) >= thirtyDaysAgo),
      "createdAt"
    ),
  });
});

module.exports = router;
