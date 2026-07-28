const router = require("express").Router();
const { authenticate } = require("../middleware/auth");

function requireSuperAdmin(req, res, next) {
  if (req.user?.id !== 0) return res.status(403).json({ error: "Super admin only" });
  next();
}

router.use(authenticate, requireSuperAdmin);

const CONFIG_KEYS = [
  "tier.maxWorkspaces",
  "tier.maxUsers",
  "tier.maxConnectors",
  "tier.maxAgentRunsPerMonth",
  "tier.ingestionSpaceGb",
  "storage.uploadPath",
  "storage.maxFileSizeMb",
  "feature.kbSharing",
  "feature.agentSharing",
  "feature.connectorSharing",
];

// GET /api/superadmin/config
router.get("/config", async (req, res) => {
  const rows = await req.db.setting.findMany({
    where: { key: { in: CONFIG_KEYS } },
  });
  const config = {};
  for (const r of rows) config[r.key] = r.value;
  res.json({ config });
});

// PUT /api/superadmin/config
router.put("/config", async (req, res) => {
  const { config } = req.body;
  if (!config || typeof config !== "object") return res.status(400).json({ error: "config object required" });

  for (const [key, value] of Object.entries(config)) {
    if (!CONFIG_KEYS.includes(key)) continue;
    await req.db.setting.upsert({
      where:  { key },
      create: { key, value: String(value) },
      update: { value: String(value) },
    });
  }

  res.json({ success: true });
});

module.exports = router;
