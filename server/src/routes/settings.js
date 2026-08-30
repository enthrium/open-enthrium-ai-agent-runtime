const router = require("express").Router();
const { authenticate, requireAdmin } = require("../middleware/auth");
const { logActivity } = require("../utils/activityLog");

router.use(authenticate, requireAdmin);

// ── Export LLM settings as oe-config snippet (real key, admin only) ───────────
router.get("/oe-config", async (req, res) => {
  const rows = await req.db.setting.findMany();
  const s    = rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
  const llm  = {
    provider: s.llm_provider || "openai",
    model:    s.llm_model    || "gpt-4o",
    apiKey:   s.llm_api_key  || "",
    ...(s.llm_base_url ? { baseUrl: s.llm_base_url } : {}),
  };
  res.json({ llm });
});

router.get("/", async (req, res) => {
  const settings = await req.db.setting.findMany();
  const safe = settings.reduce((acc, s) => {
    const isSensitive = s.key.includes("api_key") || s.key.toLowerCase().includes("secret");
    const isEmpty = !s.value || s.value === "null" || s.value === "undefined";
    acc[s.key] = isSensitive ? (isEmpty ? null : "********") : s.value;
    return acc;
  }, {});
  res.json({ settings: safe });
});

router.put("/", async (req, res) => {
  const { settings } = req.body;
  const changedKeys = [];

  for (const [key, value] of Object.entries(settings || {})) {
    if (value === "********") continue;
    const isSensitive = key.includes("api_key") || key.toLowerCase().includes("secret");
    const isEmpty = value === null || value === undefined || value === "" || value === "null";
    if (isEmpty && isSensitive) {
      await req.db.setting.deleteMany({ where: { key } });
      continue;
    }
    await req.db.setting.upsert({
      where:  { key },
      create: { key, value: String(value) },
      update: { value: String(value) }
    });
    changedKeys.push(isSensitive ? `${key} (updated, value hidden)` : `${key}=${value}`);
  }

  if (changedKeys.length > 0) {
    await logActivity(req.db, req.user, "settings.updated", { changed: changedKeys });
  }

  res.json({ success: true });
});

module.exports = router;
