const TIERS = {
  starter: {
    maxConnectors: 10,
    maxAgentRunsPerMonth: 500,
    ingestionSpaceGb: 100,
    bullmq: false, sso: false, customBranding: false, ha: false,
  },
  professional: {
    maxConnectors: 50,
    maxAgentRunsPerMonth: 5000,
    ingestionSpaceGb: 1024,
    bullmq: true, sso: false, customBranding: true, ha: false,
  },
  enterprise: {
    maxConnectors: Infinity,
    maxAgentRunsPerMonth: Infinity,
    ingestionSpaceGb: Infinity,
    bullmq: true, sso: true, customBranding: true, ha: true,
  },
};

// Sync fallback (no DB) — used when db is not available
function getTier() {
  const name = (process.env.OE_TIER || "starter").toLowerCase();
  const base = TIERS[name] || TIERS.starter;
  return { name, ...base };
}

// Async — checks DB settings first, then env, then defaults
async function getTierFromDB(db) {
  if (!db) return getTier();

  try {
    const rows = await db.setting.findMany({
      where: { key: { in: ["tier.maxConnectors", "tier.maxAgentRunsPerMonth", "tier.ingestionSpaceGb", "tier.maxWorkspaces", "tier.maxUsers"] } },
    });
    const s = {};
    for (const r of rows) s[r.key] = r.value;

    return {
      name: "custom",
      maxConnectors:        s["tier.maxConnectors"]        ? Number(s["tier.maxConnectors"])        : Infinity,
      maxAgentRunsPerMonth: s["tier.maxAgentRunsPerMonth"] ? Number(s["tier.maxAgentRunsPerMonth"]) : Infinity,
      ingestionSpaceGb:     s["tier.ingestionSpaceGb"]     ? Number(s["tier.ingestionSpaceGb"])     : Infinity,
      maxWorkspaces:        s["tier.maxWorkspaces"]        ? Number(s["tier.maxWorkspaces"])        : Infinity,
      maxUsers:             s["tier.maxUsers"]             ? Number(s["tier.maxUsers"])             : Infinity,
      bullmq: true, sso: true, customBranding: true, ha: true,
    };
  } catch {
    return getTier();
  }
}

async function canAddConnector(currentCount, db) {
  const tier = await getTierFromDB(db);
  return currentCount < tier.maxConnectors;
}

// Returns YYYY-MM string for the current month
function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

async function getAgentRunsThisMonth(db) {
  if (!db) return 0;
  try {
    const [monthRow, countRow] = await Promise.all([
      db.setting.findUnique({ where: { key: "usage.agentRuns.month" } }),
      db.setting.findUnique({ where: { key: "usage.agentRuns.count" } }),
    ]);
    if (monthRow?.value !== currentMonthKey()) return 0;
    return parseInt(countRow?.value || "0");
  } catch { return 0; }
}

async function incrementAgentRun(db) {
  if (!db) return;
  const month = currentMonthKey();
  try {
    const monthRow = await db.setting.findUnique({ where: { key: "usage.agentRuns.month" } });
    if (monthRow?.value !== month) {
      // New month — reset
      await Promise.all([
        db.setting.upsert({ where: { key: "usage.agentRuns.month" }, create: { key: "usage.agentRuns.month", value: month }, update: { value: month } }),
        db.setting.upsert({ where: { key: "usage.agentRuns.count" }, create: { key: "usage.agentRuns.count", value: "1" }, update: { value: "1" } }),
      ]);
    } else {
      const current = parseInt((await db.setting.findUnique({ where: { key: "usage.agentRuns.count" } }))?.value || "0");
      await db.setting.upsert({
        where:  { key: "usage.agentRuns.count" },
        create: { key: "usage.agentRuns.count", value: String(current + 1) },
        update: { value: String(current + 1) },
      });
    }
  } catch { /* non-fatal */ }
}

async function canRunAgent(db) {
  const tier = await getTierFromDB(db);
  if (!isFinite(tier.maxAgentRunsPerMonth)) return true;
  const used = await getAgentRunsThisMonth(db);
  return used < tier.maxAgentRunsPerMonth;
}

module.exports = { getTier, getTierFromDB, canAddConnector, getAgentRunsThisMonth, incrementAgentRun, canRunAgent };
