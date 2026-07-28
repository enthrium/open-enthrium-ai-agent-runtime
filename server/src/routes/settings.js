const router = require("express").Router();
const { authenticate, requireAdmin } = require("../middleware/auth");
const { logActivity } = require("../utils/activityLog");

router.use(authenticate, requireAdmin);

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
