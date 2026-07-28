const router = require("express").Router();
const { authenticate, requireAdmin, requireManagerOrAdmin, requireManagerOrAdminOrUser, requireCommercial } = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { logActivity } = require("../utils/activityLog");
const { getTierFromDB } = require("../utils/tier");

router.use(authenticate);

// ── Users (admin only) ────────────────────────────────────────────────────────

router.get("/users", requireManagerOrAdmin, async (req, res) => {
  const users = await req.db.user.findMany({
    where:  { NOT: { email: "support@openenterprise.info" } },
    select: { id: true, email: true, name: true, role: true, suspended: true, createdAt: true }
  });
  res.json({ users });
});

router.post("/users", requireAdmin, async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  const exists = await req.db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (exists) return res.status(409).json({ error: "Email already in use" });

  const [tier, currentCount] = await Promise.all([
    getTierFromDB(req.db),
    req.db.user.count({ where: { NOT: { email: "support@openenterprise.info" } } }),
  ]);
  if (isFinite(tier.maxUsers) && currentCount >= tier.maxUsers) {
    return res.status(403).json({ error: `Tier limit reached. Max ${tier.maxUsers} user(s) allowed.` });
  }

  if (!["user", "manager", "admin"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  if (role === "admin" && req.user.id !== 0) {
    return res.status(403).json({ error: "Only the super admin can create admin users" });
  }

  const hash = await bcrypt.hash(password, 12);
  const user = await req.db.user.create({
    data: { email: email.toLowerCase(), password: hash, name, role: role || "user" },
    select: { id: true, email: true, name: true, role: true, createdAt: true }
  });

  await logActivity(req.db, req.user, "user.created", { name, email: email.toLowerCase(), role: role || "user" });
  res.json({ user });
});

router.put("/users/:id", requireAdmin, async (req, res) => {
  const { name, email, role, suspended, password } = req.body;
  const data = {};
  if (name !== undefined) data.name = name;
  if (email !== undefined) {
    const normalized = email.toLowerCase();
    const conflict = await req.db.user.findFirst({
      where: { email: normalized, NOT: { id: parseInt(req.params.id) } }
    });
    if (conflict) return res.status(409).json({ error: "Email already in use" });
    data.email = normalized;
  }
  if (role !== undefined) {
    if (!["user", "manager", "admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (role === "admin" && req.user.id !== 0) {
      return res.status(403).json({ error: "Only the super admin can assign the admin role" });
    }
    data.role = role;
  }
  if (suspended !== undefined) data.suspended = suspended;
  if (password) data.password = await bcrypt.hash(password, 12);

  const user = await req.db.user.update({
    where: { id: parseInt(req.params.id) },
    data,
    select: { id: true, email: true, name: true, role: true, suspended: true }
  });

  if (role !== undefined) {
    await logActivity(req.db, req.user, "user.role_changed", { targetEmail: user.email, newRole: role });
  }
  if (suspended !== undefined) {
    await logActivity(req.db, req.user, suspended ? "user.suspended" : "user.unsuspended", { targetEmail: user.email });
  }

  res.json({ user });
});

router.delete("/users/:id", requireAdmin, async (req, res) => {
  const user = await req.db.user.findUnique({
    where: { id: parseInt(req.params.id) },
    select: { email: true, name: true }
  });
  await req.db.user.delete({ where: { id: parseInt(req.params.id) } });
  await logActivity(req.db, req.user, "user.deleted", { targetEmail: user?.email });
  res.json({ success: true });
});

// ── Workspaces list (manager or admin) ───────────────────────────────────────

async function getMemberWorkspaceIds(db, userId) {
  const memberships = await db.workspaceUser.findMany({ where: { userId }, select: { workspaceId: true } });
  return memberships.map(m => m.workspaceId);
}

router.get("/workspaces", requireManagerOrAdminOrUser, async (req, res) => {
  let where = {};
  if (req.user.role !== "admin") {
    const ids = await getMemberWorkspaceIds(req.db, req.user.id);
    where = { id: { in: ids } };
  }
  const workspaces = await req.db.workspace.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { documents: true, chats: true, users: true, connectors: true, agents: true } },
      createdBy: { select: { id: true, name: true, email: true } },
    }
  });
  res.json({ workspaces });
});

router.post("/workspaces", requireManagerOrAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  const [tier, currentCount] = await Promise.all([
    getTierFromDB(req.db),
    req.db.workspace.count(),
  ]);
  if (isFinite(tier.maxWorkspaces) && currentCount >= tier.maxWorkspaces) {
    return res.status(403).json({ error: `Tier limit reached. Max ${tier.maxWorkspaces} workspace(s) allowed.` });
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + uuidv4().slice(0, 6);
  const workspace = await req.db.workspace.create({
    data: { name, slug, createdByUserId: req.user.id || null },
    include: {
      _count: { select: { documents: true, chats: true, users: true, connectors: true, agents: true } },
      createdBy: { select: { id: true, name: true, email: true } },
    }
  });

  // Auto-add creator as member (skip superadmin who has no DB row)
  if (req.user.id !== 0) {
    await req.db.workspaceUser.create({ data: { userId: req.user.id, workspaceId: workspace.id } });
  }

  await logActivity(req.db, req.user, "workspace.created", { name, slug });
  res.json({ workspace });
});

router.delete("/workspaces/:id", requireManagerOrAdmin, async (req, res) => {
  const ws = await req.db.workspace.findUnique({
    where: { id: parseInt(req.params.id) },
    select: { name: true, slug: true }
  });
  await req.db.workspace.delete({ where: { id: parseInt(req.params.id) } });
  await logActivity(req.db, req.user, "workspace.deleted", { name: ws?.name, slug: ws?.slug });
  res.json({ success: true });
});

// ── Workspace detail (manager or admin — General + Members) ─────────────────

router.get("/workspaces/:id", requireManagerOrAdmin, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({
    where: { id: parseInt(req.params.id) },
    include: {
      users: {
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
        orderBy: { createdAt: "asc" }
      },
      _count: { select: { documents: true, chats: true } }
    }
  });
  if (!workspace) return res.status(404).json({ error: "Not found" });
  res.json({ workspace });
});

router.put("/workspaces/:id", requireManagerOrAdmin, async (req, res) => {
  const { name, systemPrompt, temperature, chatHistory, queryRefusalResponse, starterPrompts, vectorDbProvider, vectorDbConfig, embedEnabled, defaultAgentMaxRounds } = req.body;
  const workspace = await req.db.workspace.update({
    where: { id: parseInt(req.params.id) },
    data: {
      ...(name && { name }),
      ...(systemPrompt !== undefined && { systemPrompt: systemPrompt || null }),
      ...(temperature !== undefined && { temperature: parseFloat(temperature) }),
      ...(chatHistory !== undefined && { chatHistory: parseInt(chatHistory) }),
      ...(queryRefusalResponse !== undefined && { queryRefusalResponse: queryRefusalResponse || null }),
      ...(starterPrompts !== undefined && { starterPrompts: JSON.stringify(starterPrompts) }),
      ...(embedEnabled !== undefined && { embedEnabled: Boolean(embedEnabled) }),
      ...(req.body.dlpEnabled !== undefined && { dlpEnabled: Boolean(req.body.dlpEnabled) }),
      ...(defaultAgentMaxRounds !== undefined && { defaultAgentMaxRounds: Math.max(1, Math.min(100, parseInt(defaultAgentMaxRounds) || 25)) }),
      ...(req.body.maxChainDepth !== undefined && { maxChainDepth: Math.max(1, Math.min(20, parseInt(req.body.maxChainDepth) || 5)) }),
      ...(vectorDbProvider !== undefined && req.user.role === "admin" && { vectorDbProvider: vectorDbProvider || null }),
      ...(vectorDbConfig !== undefined && req.user.role === "admin" && { vectorDbConfig: vectorDbConfig ? JSON.stringify(vectorDbConfig) : null }),
    }
  });
  await logActivity(req.db, req.user, "workspace.updated", { workspaceId: workspace.id, name: workspace.name });
  res.json({ workspace });
});

router.post("/workspaces/:id/members", requireManagerOrAdmin, async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const { userId } = req.body;
  await req.db.workspaceUser.upsert({
    where: { userId_workspaceId: { userId: parseInt(userId), workspaceId } },
    create: { userId: parseInt(userId), workspaceId },
    update: {}
  });
  const target = await req.db.user.findUnique({ where: { id: parseInt(userId) }, select: { email: true, name: true } });
  const ws = await req.db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
  await logActivity(req.db, req.user, "workspace.member_added", {
    workspaceName: ws?.name,
    userEmail: target?.email
  });
  res.json({ success: true });
});

router.delete("/workspaces/:id/members/:userId", requireManagerOrAdmin, async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const userId      = parseInt(req.params.userId);
  await req.db.workspaceUser.deleteMany({ where: { userId, workspaceId } });
  const target = await req.db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const ws = await req.db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
  await logActivity(req.db, req.user, "workspace.member_removed", {
    workspaceName: ws?.name,
    userEmail: target?.email
  });
  res.json({ success: true });
});

// ── Chats (manager or admin) ──────────────────────────────────────────────────

router.get("/chats", requireManagerOrAdmin, async (req, res) => {
  const { workspaceId, page = "1", limit = "20", since } = req.query;
  const where = workspaceId ? { workspaceId: parseInt(workspaceId) } : {};
  if (since) where.createdAt = { gte: new Date(since) };
  const take = Math.min(parseInt(limit) || 20, 100);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  const [chats, total] = await Promise.all([
    req.db.chat.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        workspace: { select: { id: true, name: true, slug: true } },
        user:      { select: { id: true, name: true, email: true } }
      }
    }),
    req.db.chat.count({ where })
  ]);
  res.json({ chats, total });
});

router.delete("/chats/:id", requireManagerOrAdmin, async (req, res) => {
  await req.db.chat.delete({ where: { id: parseInt(req.params.id) } });
  res.json({ success: true });
});

router.delete("/workspaces/:id/chats", requireManagerOrAdmin, async (req, res) => {
  const ws = await req.db.workspace.findUnique({
    where: { id: parseInt(req.params.id) },
    select: { name: true }
  });
  const { count } = await req.db.chat.deleteMany({ where: { workspaceId: parseInt(req.params.id) } });
  await logActivity(req.db, req.user, "chat.cleared", { workspaceName: ws?.name, count });
  res.json({ success: true, deleted: count });
});

// ── Token Usage (admin only) ──────────────────────────────────────────────────

// Chat LLM pricing per 1M tokens (USD).
const MODEL_PRICING = {
  // OpenAI
  "gpt-4o":                      { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":                 { input: 0.15,  output: 0.60  },
  "gpt-4-turbo":                 { input: 10.00, output: 30.00 },
  "gpt-4":                       { input: 30.00, output: 60.00 },
  "gpt-3.5-turbo":               { input: 0.50,  output: 1.50  },
  "o1":                          { input: 15.00, output: 60.00 },
  "o1-mini":                     { input: 3.00,  output: 12.00 },
  "o3-mini":                     { input: 1.10,  output: 4.40  },
  // Anthropic
  "claude-3-5-sonnet-20241022":  { input: 3.00,  output: 15.00 },
  "claude-3-5-haiku-20241022":   { input: 0.80,  output: 4.00  },
  "claude-3-opus-20240229":      { input: 15.00, output: 75.00 },
  "claude-3-sonnet-20240229":    { input: 3.00,  output: 15.00 },
  "claude-3-haiku-20240307":     { input: 0.25,  output: 1.25  },
  "claude-sonnet-4-5":           { input: 3.00,  output: 15.00 },
  "claude-sonnet-4-6":           { input: 3.00,  output: 15.00 },
  "claude-opus-4-8":             { input: 15.00, output: 75.00 },
  "claude-haiku-4-5-20251001":   { input: 0.80,  output: 4.00  },
  // Groq
  "llama-3.1-70b-versatile":     { input: 0.59,  output: 0.79  },
  "llama-3.1-8b-instant":        { input: 0.05,  output: 0.08  },
  "mixtral-8x7b-32768":          { input: 0.24,  output: 0.24  },
  "gemma2-9b-it":                { input: 0.20,  output: 0.20  },
};

// Embedding pricing per 1M tokens (USD). Local models = $0.
const EMBEDDING_PRICING = {
  "text-embedding-3-small":   0.02,
  "text-embedding-3-large":   0.13,
  "text-embedding-ada-002":   0.10,
  "text-embedding-004":       0.025,  // Gemini
  "embed-english-v3.0":       0.10,   // Cohere
  "embed-multilingual-v3.0":  0.10,   // Cohere
  "nomic-embed-text":         0,      // Ollama local
};

function computeCost(inputTokens, outputTokens, model) {
  if (!model) return 0;
  const key = Object.keys(MODEL_PRICING).find(k => model.toLowerCase().includes(k.toLowerCase()));
  if (!key) return 0;
  const p = MODEL_PRICING[key];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

function computeEmbeddingCost(tokens, model) {
  if (!model || !tokens) return 0;
  const key = Object.keys(EMBEDDING_PRICING).find(k => model.toLowerCase().includes(k.toLowerCase()));
  if (key === undefined) return 0;
  return (tokens / 1_000_000) * EMBEDDING_PRICING[key];
}

router.get("/token-usage", requireAdmin, requireCommercial, async (req, res) => {
  const { period = "all" } = req.query;
  const days = { "7d": 7, "30d": 30 }[period];
  const createdAt = days ? { gte: new Date(Date.now() - days * 86400000) } : undefined;

  const [chats, docs, users] = await Promise.all([
    req.db.chat.findMany({
      where: { role: "assistant", ...(createdAt ? { createdAt } : {}) },
      select: { userId: true, inputTokens: true, outputTokens: true, model: true }
    }),
    req.db.document.findMany({
      where: {
        status: { in: ["ready", "partial"] },
        uploadedByUserId: { not: null },
        ...(createdAt ? { createdAt } : {})
      },
      select: { uploadedByUserId: true, embeddingTokens: true, embeddingModel: true }
    }),
    req.db.user.findMany({
      where: { NOT: { email: "support@openenterprise.info" } },
      select: { id: true, name: true, email: true, role: true }
    })
  ]);

  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  const agg = {};

  const getOrCreate = (userId) => {
    const key = userId ?? "__system__";
    if (!agg[key]) {
      agg[key] = {
        user:            userMap[userId] || { name: "System / API", email: "—", role: "—" },
        messages:        0,
        inputTokens:     0,
        outputTokens:    0,
        embeddingTokens: 0,
        chatCost:        0,
        embeddingCost:   0,
      };
    }
    return agg[key];
  };

  for (const c of chats) {
    const row = getOrCreate(c.userId);
    row.messages++;
    row.inputTokens  += c.inputTokens  || 0;
    row.outputTokens += c.outputTokens || 0;
    row.chatCost     += computeCost(c.inputTokens || 0, c.outputTokens || 0, c.model);
  }

  for (const d of docs) {
    const row = getOrCreate(d.uploadedByUserId);
    row.embeddingTokens += d.embeddingTokens || 0;
    row.embeddingCost   += computeEmbeddingCost(d.embeddingTokens || 0, d.embeddingModel);
  }

  const usage = Object.values(agg).map(r => ({
    ...r,
    totalCost: r.chatCost + r.embeddingCost,
  })).sort((a, b) => b.totalCost - a.totalCost);

  res.json({ usage });
});

// ── Agents (admin only) ──────────────────────────────────────────────────────

router.get("/agents", requireManagerOrAdminOrUser, async (req, res) => {
  try {
    let workspaceFilter = {};
    if (req.user.role !== "admin") {
      const ids = await getMemberWorkspaceIds(req.db, req.user.id);
      workspaceFilter = { workspaceId: { in: ids } };
    }
    const agents = await req.db.agent.findMany({
      where: workspaceFilter,
      orderBy: { createdAt: "desc" },
      include: {
        workspace: { select: { id: true, name: true, slug: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        _count: { select: { runs: true } },
        runs: { orderBy: { startedAt: "desc" }, take: 1, select: { status: true } },
      },
    });
    res.json({ agents });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/agents/:id", requireAdmin, async (req, res) => {
  try {
    await req.db.agent.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Agent Runs Log (admin only) ──────────────────────────────────────────────

router.get("/agent-runs", requireManagerOrAdminOrUser, async (req, res) => {
  try {
    const { period = "all", page = "1", limit = "20" } = req.query;
    const days = { "7d": 7, "30d": 30 }[period];
    const startedAt = days ? { gte: new Date(Date.now() - days * 86400000) } : undefined;
    let where = startedAt ? { startedAt } : {};
    if (req.user.role !== "admin") {
      const ids = await getMemberWorkspaceIds(req.db, req.user.id);
      where = { ...where, agent: { workspaceId: { in: ids } } };
    }
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

    const [runs, total] = await Promise.all([
      req.db.agentRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take,
        skip,
        include: {
          agent: { select: { id: true, name: true, workspaceId: true, workspace: { select: { id: true, name: true } } } },
          triggeredBy: { select: { id: true, name: true, email: true } },
        },
      }),
      req.db.agentRun.count({ where }),
    ]);
    res.json({ runs, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/agent-runs/:id", requireAdmin, async (req, res) => {
  try {
    await req.db.agentRun.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Activity Log (admin only) ─────────────────────────────────────────────────

router.get("/activity", requireAdmin, requireCommercial, async (req, res) => {
  const logs = await req.db.activityLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 500
  });
  res.json({ logs });
});

// ── Purge routes (admin only) ──────────────────────────────────────────────────

function purgeWhere(query, dateField = "createdAt") {
  const where = {};
  if (query.workspaceId) where.workspaceId = parseInt(query.workspaceId);
  const range = {};
  if (query.from) range.gte = new Date(query.from);
  if (query.to)   range.lte = new Date(query.to);
  if (Object.keys(range).length) where[dateField] = range;
  return where;
}

router.delete("/purge/chats", requireAdmin, async (req, res) => {
  const where = purgeWhere(req.query);
  const { count } = await req.db.chat.deleteMany({ where });
  res.json({ message: `Purged ${count} chat message(s).` });
});

router.delete("/purge/agent-runs", requireAdmin, async (req, res) => {
  const base = purgeWhere(req.query, "startedAt");
  if (req.query.workspaceId) {
    base.agent = { workspaceId: parseInt(req.query.workspaceId) };
    delete base.workspaceId;
  }
  const { count } = await req.db.agentRun.deleteMany({ where: base });
  res.json({ message: `Purged ${count} agent run(s).` });
});

router.delete("/purge/agent-memory", requireAdmin, async (req, res) => {
  const base = purgeWhere(req.query, "startedAt");
  if (req.query.workspaceId) {
    base.agent = { workspaceId: parseInt(req.query.workspaceId) };
    delete base.workspaceId;
  }
  const { count } = await req.db.agentRun.updateMany({ where: base, data: { output: null } });
  res.json({ message: `Cleared memory from ${count} agent run(s).` });
});

router.delete("/purge/threads", requireAdmin, async (req, res) => {
  const where = purgeWhere(req.query);
  const { count } = await req.db.thread.deleteMany({ where });
  res.json({ message: `Purged ${count} thread(s) and their chat history.` });
});

router.delete("/purge/dlp-violations", requireAdmin, requireCommercial, async (req, res) => {
  const where = purgeWhere(req.query);
  const { count } = await req.db.dlpViolation.deleteMany({ where });
  res.json({ message: `Purged ${count} DLP violation record(s).` });
});

// ── Vectors (admin only) ──────────────────────────────────────────────────────

const path = require("path");

async function getLanceDb() {
  const lancedb = await import("@lancedb/lancedb");
  const dbPath  = path.join(__dirname, "../../storage/lancedb");
  return lancedb.connect(dbPath);
}

router.get("/vectors", requireAdmin, async (req, res) => {
  try {
    const db         = await getLanceDb();
    const tableNames = await db.tableNames();

    const workspaces = await req.db.workspace.findMany({
      select: { id: true, name: true, slug: true }
    });
    const kbShares = await req.db.workspaceKBShare.findMany({
      include: {
        sourceWorkspace: { select: { id: true, name: true, slug: true } },
        targetWorkspace: { select: { id: true, name: true, slug: true } },
      }
    });

    const wsMap = {};
    for (const ws of workspaces) {
      wsMap[`ws_${ws.slug.replace(/-/g, "_")}`] = ws;
    }

    const tables = tableNames.map(name => {
      const workspace = wsMap[name] || null;
      const shares = workspace
        ? kbShares
            .filter(s => s.sourceWorkspaceId === workspace.id)
            .map(s => ({ id: s.id, targetWorkspace: s.targetWorkspace }))
        : [];
      return { name, workspace, shares };
    });

    res.json({ tables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/vectors/:tableName", requireAdmin, async (req, res) => {
  try {
    const db = await getLanceDb();
    await db.dropTable(req.params.tableName);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Copy all chunks from orphaned table into target workspace's table, then drop orphaned table
router.post("/vectors/:tableName/assign", requireAdmin, async (req, res) => {
  const { targetWorkspaceSlug } = req.body;
  if (!targetWorkspaceSlug) return res.status(400).json({ error: "targetWorkspaceSlug required" });

  const workspace = await req.db.workspace.findUnique({ where: { slug: targetWorkspaceSlug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  try {
    const db      = await getLanceDb();
    const srcName = req.params.tableName;
    const dstName = `ws_${targetWorkspaceSlug.replace(/-/g, "_")}`;

    if (srcName === dstName) return res.status(400).json({ error: "Table already belongs to this workspace" });

    const srcTable  = await db.openTable(srcName);
    const arrowRows = await srcTable.toArrow();
    const docMap    = {};

    if (arrowRows.numRows > 0) {
      // Copy vectors using Arrow format
      try {
        const dstTable = await db.openTable(dstName);
        await dstTable.add(arrowRows);
      } catch {
        await db.createTable(dstName, arrowRows);
      }

      // Extract documentUid + metadata from Arrow columns (toArray doesn't exist on Table)
      const uidCol  = arrowRows.getChild("documentUid");
      const metaCol = arrowRows.getChild("metadata");
      if (uidCol && metaCol) {
        for (let i = 0; i < arrowRows.numRows; i++) {
          const uid  = uidCol.get(i);
          const meta = metaCol.get(i);
          if (!docMap[uid]) docMap[uid] = { count: 0, metadata: meta };
          docMap[uid].count++;
        }
      }

      // Reconstruct Document records
      for (const [uid, { count, metadata }] of Object.entries(docMap)) {
        let name = uid;
        let type = "file";
        try {
          const m = JSON.parse(metadata || "{}");
          if (m.source) name = m.source.split(/[\\/]/).pop() || name;
          if (m.type)   type = m.type;
        } catch {}

        const existing = await req.db.document.findFirst({ where: { uid, workspaceId: workspace.id } });
        if (!existing) {
          await req.db.document.create({
            data: {
              uid,
              name,
              type,
              workspaceId:     workspace.id,
              status:          "ready",
              chunkCount:      count,
              chunksProcessed: count,
              totalChunks:     count,
            }
          });
        }
      }
    }

    await db.dropTable(srcName);
    res.json({ success: true, moved: arrowRows.numRows, documents: Object.keys(docMap).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DLP Policies ──────────────────────────────────────────────────────────────

router.get("/dlp/policies", requireAdmin, requireCommercial, async (req, res) => {
  const policies = await req.db.dlpPolicy.findMany({ orderBy: { createdAt: "asc" } });
  res.json({ policies });
});

router.post("/dlp/policies", requireAdmin, requireCommercial, async (req, res) => {
  const { name, category, pattern, action } = req.body;
  if (!name || !category) return res.status(400).json({ error: "name and category are required" });
  const policy = await req.db.dlpPolicy.create({
    data: { name, category, pattern: pattern || "", action: action || "block", enabled: true }
  });
  res.json({ policy });
});

router.put("/dlp/policies/:id", requireAdmin, requireCommercial, async (req, res) => {
  const { name, category, pattern, action, enabled } = req.body;
  const policy = await req.db.dlpPolicy.update({
    where: { id: parseInt(req.params.id) },
    data: { name, category, pattern, action, enabled }
  });
  res.json({ policy });
});

router.delete("/dlp/policies/:id", requireAdmin, requireCommercial, async (req, res) => {
  await req.db.dlpPolicy.delete({ where: { id: parseInt(req.params.id) } });
  res.json({ success: true });
});

router.get("/dlp/violations", requireAdmin, requireCommercial, async (req, res) => {
  const violations = await req.db.dlpViolation.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ violations });
});

module.exports = router;
