const router = require("express").Router();
const { authenticate, requireManagerOrAdmin } = require("../middleware/auth");
const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");

router.use(authenticate, requireManagerOrAdmin);

const SAMPLES_DIR = path.resolve(__dirname, "../../cli/skills");

// ── List templates ─────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  try {
    const entries = fs.readdirSync(SAMPLES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const dir = path.join(SAMPLES_DIR, e.name);
        let name    = e.name;
        let version = "1.0.0";
        let description = "";
        let tags    = [];
        let agentCount = 0;

        // Prefer oe-project.json metadata
        const projFile = path.join(dir, "oe-project.json");
        if (fs.existsSync(projFile)) {
          try {
            const m = JSON.parse(fs.readFileSync(projFile, "utf8"));
            if (m.name)        name        = m.name;
            if (m.version)     version     = m.version;
            if (m.description) description = m.description;
            if (Array.isArray(m.tags)) tags = m.tags;
            agentCount = (m.agents || []).length;
          } catch {}
        }

        // Fallback: read name from the first YAML file
        if (agentCount === 0) {
          const yamls = fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f));
          agentCount = yamls.length;
          if (!fs.existsSync(projFile) && yamls[0]) {
            try {
              const doc = yaml.load(fs.readFileSync(path.join(dir, yamls[0]), "utf8")) || {};
              if (doc.name) name = doc.name;
              if (doc.description) description = doc.description;
            } catch {}
          }
        }

        return { id: e.name, name, version, description, tags, agentCount };
      });

    res.json({ templates: entries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get template files ─────────────────────────────────────────────────────────
router.get("/:templateId", (req, res) => {
  try {
    const dir = path.join(SAMPLES_DIR, path.basename(req.params.templateId));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      return res.status(404).json({ error: "Template not found" });

    const fileMap = {};
    for (const fname of fs.readdirSync(dir)) {
      const fpath = path.join(dir, fname);
      if (!fs.statSync(fpath).isFile()) continue;
      if (fname.startsWith(".")) continue;
      fileMap[fname] = fs.readFileSync(fpath, "utf8");
    }
    res.json({ fileMap });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
