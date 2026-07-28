const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

router.get("/status", async (req, res) => {
  const adminCount = await req.db.user.count({ where: { role: "admin" } });
  res.json({ setupComplete: adminCount > 0 });
});

router.post("/complete", async (req, res) => {
  const adminCount = await req.db.user.count({ where: { role: "admin" } });
  if (adminCount > 0) return res.status(400).json({ error: "Setup already completed" });

  const { name, email, password, settings = {} } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const hash = await bcrypt.hash(password, 12);
  const user = await req.db.user.create({
    data: { email: email.toLowerCase(), password: hash, name, role: "admin" }
  });

  // Save all LLM/embedding settings generically
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || value === null || value === "") continue;
    await req.db.setting.upsert({
      where: { key },
      create: { key, value: String(value) },
      update: { value: String(value) }
    });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

module.exports = router;
