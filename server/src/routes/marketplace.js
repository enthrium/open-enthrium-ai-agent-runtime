const router = require("express").Router();
const { authenticate } = require("../middleware/auth");
const path = require("path");
const fs   = require("fs");

const SAMPLES_DIR = path.resolve(__dirname, "../../cli/samples");

function readSamples() {
  if (!fs.existsSync(SAMPLES_DIR)) return [];
  return fs.readdirSync(SAMPLES_DIR)
    .filter(f => fs.statSync(path.join(SAMPLES_DIR, f)).isDirectory())
    .map(folder => {
      const yamlPath   = path.join(SAMPLES_DIR, folder, "agent.yaml");
      const configPath = path.join(SAMPLES_DIR, folder, "oe-config.json");
      const yaml   = fs.existsSync(yamlPath)   ? fs.readFileSync(yamlPath,   "utf8") : null;
      const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
      return { folder, yaml, config };
    })
    .filter(s => s.yaml);
}

// GET /api/marketplace/samples
router.get("/samples", authenticate, (req, res) => {
  try {
    res.json({ samples: readSamples() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/marketplace/samples/:folder/yaml
router.get("/samples/:folder/yaml", authenticate, (req, res) => {
  const file = path.join(SAMPLES_DIR, req.params.folder, "agent.yaml");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", "text/yaml");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.folder}.yaml"`);
  res.send(fs.readFileSync(file, "utf8"));
});

// GET /api/marketplace/samples/:folder/config
router.get("/samples/:folder/config", authenticate, (req, res) => {
  const file = path.join(SAMPLES_DIR, req.params.folder, "oe-config.json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.folder}.oe-config.json"`);
  res.send(fs.readFileSync(file, "utf8"));
});

module.exports = router;
