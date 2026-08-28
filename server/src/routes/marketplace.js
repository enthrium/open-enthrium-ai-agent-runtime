const router = require("express").Router();
const { authenticate } = require("../middleware/auth");
const path = require("path");
const fs   = require("fs");

const SKILLS_DIR = path.resolve(__dirname, "../../cli/skills");

function readSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR)
    .filter(f => fs.statSync(path.join(SKILLS_DIR, f)).isDirectory())
    .map(folder => {
      const yamlPath   = path.join(SKILLS_DIR, folder, "agent.yaml");
      const configPath = path.join(SKILLS_DIR, folder, "oe-config.json");
      const yaml   = fs.existsSync(yamlPath)   ? fs.readFileSync(yamlPath,   "utf8") : null;
      const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
      return { folder, yaml, config };
    })
    .filter(s => s.yaml);
}

// GET /api/marketplace/skills
router.get("/skills", authenticate, (req, res) => {
  try {
    res.json({ skills: readSkills() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/marketplace/skills/:folder/yaml
router.get("/skills/:folder/yaml", authenticate, (req, res) => {
  const file = path.join(SKILLS_DIR, req.params.folder, "agent.yaml");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", "text/yaml");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.folder}.yaml"`);
  res.send(fs.readFileSync(file, "utf8"));
});

// GET /api/marketplace/skills/:folder/config
router.get("/skills/:folder/config", authenticate, (req, res) => {
  const file = path.join(SKILLS_DIR, req.params.folder, "oe-config.json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.folder}.oe-config.json"`);
  res.send(fs.readFileSync(file, "utf8"));
});

module.exports = router;
