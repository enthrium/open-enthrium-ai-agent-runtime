const router = require("express").Router();
const crypto = require("crypto");
const { authenticate, requireManagerOrAdmin } = require("../middleware/auth");
const { logActivity } = require("../utils/activityLog");

router.use(authenticate, requireManagerOrAdmin);

// List all API keys (never returns raw key)
router.get("/", async (req, res) => {
  const keys = await req.db.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { id: true, name: true, email: true } } }
  });
  res.json({ keys });
});

// Create new API key — returns raw key ONCE
router.post("/", async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Name required" });

  const rawKey   = "emb_" + crypto.randomBytes(16).toString("hex");
  const keyHash  = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 12);

  const apiKey = await req.db.apiKey.create({
    data: { name: name.trim(), keyHash, keyPrefix, createdById: req.user.id || null },
    include: { createdBy: { select: { id: true, name: true, email: true } } }
  });

  await logActivity(req.db, req.user, "apikey.created", { name: name.trim(), prefix: keyPrefix });
  res.json({ apiKey, rawKey });
});

// Revoke an API key (soft)
router.patch("/:id/revoke", async (req, res) => {
  const apiKey = await req.db.apiKey.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!apiKey) return res.status(404).json({ error: "API key not found" });

  await req.db.apiKey.update({ where: { id: apiKey.id }, data: { revoked: true } });
  await logActivity(req.db, req.user, "apikey.revoked", { name: apiKey.name, prefix: apiKey.keyPrefix });
  res.json({ success: true });
});

// Delete an API key (hard)
router.delete("/:id", async (req, res) => {
  const apiKey = await req.db.apiKey.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!apiKey) return res.status(404).json({ error: "API key not found" });

  await req.db.apiKey.delete({ where: { id: apiKey.id } });
  await logActivity(req.db, req.user, "apikey.deleted", { name: apiKey.name, prefix: apiKey.keyPrefix });
  res.json({ success: true });
});

module.exports = router;
