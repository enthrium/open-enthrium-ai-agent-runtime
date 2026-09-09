"use strict";
const router = require("express").Router();
const http   = require("http");
const { authenticate, requireAdmin } = require("../middleware/auth");

function pushConnectorConfigToMcp(connectorConfig) {
  try {
    const parsed  = JSON.parse(connectorConfig);
    const connectors = parsed.connectors || parsed;
    if (!Array.isArray(connectors)) return;
    const mcpPort = parseInt(process.env.MCP_PORT) || 3003;
    const body    = JSON.stringify({ connectors });
    const req = http.request({
      hostname: "127.0.0.1", port: mcpPort, path: "/config", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, () => {});
    req.on("error", () => {}); // silent — MCP may not be running
    req.write(body);
    req.end();
  } catch { /* invalid JSON — ignore */ }
}

// All routes require admin
router.use(authenticate, requireAdmin);

// GET /api/admin/mcp-servers
router.get("/", async (req, res) => {
  try {
    const servers = await req.db.mcpServer.findMany({ orderBy: { id: "asc" } });
    res.json({ servers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/mcp-servers
router.post("/", async (req, res) => {
  const { name, url, apiKey } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Name is required" });
  if (!url?.trim())  return res.status(400).json({ error: "URL is required" });
  try {
    new URL(url); // validate URL format
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }
  try {
    const server = await req.db.mcpServer.create({
      data: { name: name.trim(), url: url.trim(), apiKey: apiKey?.trim() || null },
    });
    res.status(201).json({ server });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/mcp-servers/:id
router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, url, apiKey, enabled } = req.body;
  try {
    const existing = await req.db.mcpServer.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "MCP server not found" });

    const { connectorConfig } = req.body;
    const data = {};
    if (typeof enabled === "boolean") data.enabled = enabled;

    if (!existing.isDefault) {
      if (name?.trim()) data.name = name.trim();
      if (url?.trim()) {
        try { new URL(url); } catch { return res.status(400).json({ error: "Invalid URL format" }); }
        data.url = url.trim();
      }
      data.apiKey = apiKey?.trim() || null;
    } else {
      if (name?.trim()) data.name = name.trim();
      // Default server: allow updating connector config JSON
      if (connectorConfig !== undefined) {
        if (connectorConfig === null || connectorConfig === "") {
          data.connectorConfig = null;
        } else {
          try { JSON.parse(connectorConfig); } catch { return res.status(400).json({ error: "connectorConfig must be valid JSON" }); }
          data.connectorConfig = connectorConfig;
        }
      }
    }

    const server = await req.db.mcpServer.update({ where: { id }, data });

    // If connector config was updated on the default server, push it live immediately
    if (existing.isDefault && data.connectorConfig !== undefined && data.connectorConfig) {
      pushConnectorConfigToMcp(data.connectorConfig);
    }

    res.json({ server });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/mcp-servers/:id
router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const existing = await req.db.mcpServer.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "MCP server not found" });
    if (existing.isDefault) return res.status(403).json({ error: "Cannot delete the built-in MCP server" });
    await req.db.mcpServer.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
