const jwt    = require("jsonwebtoken");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

const _commercialExists = fs.existsSync(path.resolve(__dirname, "../../../commercial/routes"));

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token provided" });

  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

function requireManagerOrAdmin(req, res, next) {
  if (req.user?.role !== "admin" && req.user?.role !== "manager") {
    return res.status(403).json({ error: "Manager or admin access required" });
  }
  next();
}

async function authenticateApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "API key required. Use: Authorization: Bearer emb_..." });
  }
  const rawKey = header.slice(7);
  if (!rawKey.startsWith("emb_")) {
    return res.status(401).json({ error: "Invalid API key format" });
  }
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const apiKey  = await req.db.apiKey.findFirst({ where: { keyHash, revoked: false } });
  if (!apiKey) return res.status(401).json({ error: "Invalid or revoked API key" });

  await req.db.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
  req.apiKey = apiKey;
  next();
}

function requireManagerOrAdminOrUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  next();
}

function requireCommercial(req, res, next) {
  if (!_commercialExists) {
    return res.status(403).json({ error: "This feature requires a commercial license." });
  }
  next();
}

module.exports = { authenticate, requireAdmin, requireManagerOrAdmin, requireManagerOrAdminOrUser, authenticateApiKey, requireCommercial };
