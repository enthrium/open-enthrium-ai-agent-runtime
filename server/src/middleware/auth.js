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

module.exports = { authenticate, requireAdmin, requireManagerOrAdmin, requireManagerOrAdminOrUser, requireCommercial };
