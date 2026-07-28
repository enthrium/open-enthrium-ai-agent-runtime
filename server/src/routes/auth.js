const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { authenticate } = require("../middleware/auth");

const SUPER_ADMIN = {
  email:    process.env.SUPER_ADMIN_EMAIL,
  password: process.env.SUPER_ADMIN_PASSWORD,
  name:     process.env.SUPER_ADMIN_NAME || "Super Admin",
};

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  // Super admin from .env — bypasses DB entirely
  if (SUPER_ADMIN.email && SUPER_ADMIN.password && email.toLowerCase() === SUPER_ADMIN.email.toLowerCase() && password === SUPER_ADMIN.password) {
    const token = jwt.sign(
      { id: 0, email: SUPER_ADMIN.email, role: "admin", name: SUPER_ADMIN.name },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    return res.json({ token, user: { id: 0, email: SUPER_ADMIN.email, name: SUPER_ADMIN.name, role: "admin" } });
  }

  const user = await req.db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || user.suspended) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

router.get("/me", authenticate, async (req, res) => {
  if (req.user.id === 0) {
    return res.json({ user: { id: 0, email: SUPER_ADMIN.email, name: SUPER_ADMIN.name, role: "admin" } });
  }
  const user = await req.db.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, name: true, role: true }
  });
  res.json({ user });
});

router.put("/me", authenticate, async (req, res) => {
  const { name, currentPassword, newPassword } = req.body;

  // Super admin — only allow name update (password lives in .env)
  if (req.user.id === 0) {
    return res.status(400).json({ error: "Super admin credentials are managed via .env" });
  }

  const user = await req.db.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: "User not found" });

  const updates = {};
  if (name !== undefined) updates.name = name.trim();

  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: "Current password required" });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(400).json({ error: "Current password is incorrect" });
    if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
    updates.password = await bcrypt.hash(newPassword, 10);
  }

  const updated = await req.db.user.update({
    where: { id: req.user.id },
    data: updates,
    select: { id: true, email: true, name: true, role: true }
  });

  res.json({ user: updated });
});

module.exports = router;
