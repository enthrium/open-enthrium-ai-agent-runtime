const router = require("express").Router();
const { authenticate, requireAdmin, requireManagerOrAdmin } = require("../middleware/auth");
const { canAddConnector, getTierFromDB } = require("../utils/tier");
const { logActivity }                = require("../utils/activityLog");

const SUPPORTED_TYPES = [
  "postgresql", "mysql", "mssql", "oracle", "mongodb",
  "redis", "sqlite", "snowflake", "bigquery", "cockroachdb", "elasticsearch",
  "rest-api", "gmail", "slack", "jira", "confluence", "notion", "hubspot",
  "freshdesk", "zendesk", "github", "zoho-mail", "gdrive", "ssh",
  "onedrive", "dropbox", "box",
  // Search
  "perplexity-search", "google-search", "bing-search",
  // OCR
  "azure-vision", "google-vision", "aws-textract", "tesseract-ocr",
  // Image generation
  "openai-image", "flux", "stable-diffusion", "ideogram",
  // Speech & audio
  "elevenlabs", "openai-tts", "azure-speech", "google-tts",
  // Video generation
  "runway", "kling", "pika",
  // Music generation
  "suno", "udio",
];

function generateSlug(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "") || "connector";
}

// Public-to-all-authenticated: connector type catalog (needed by workspace users too)
router.get("/connection-masters", authenticate, async (req, res) => {
  try {
    const masters = await req.db.connectionMaster.findMany({
      orderBy: [{ category: "asc" }, { label: "asc" }],
    });
    res.json({ masters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(authenticate, requireManagerOrAdmin);

const SENSITIVE_AUTH_KEYS = new Set([
  "password", "privateKey", "apiToken", "apiKey", "botToken", "appPassword",
  "bearerToken", "integrationToken", "privateAppToken", "personalAccessToken",
  "keyFileJson", "refreshToken", "accessToken", "clientSecret",
]);

// List connectors for a workspace
router.get("/workspaces/:workspaceId/connectors", async (req, res) => {
  try {
    const workspaceId = parseInt(req.params.workspaceId);
    const [connectors, totalConnectors, tier] = await Promise.all([
      req.db.connector.findMany({
        where:   { workspaceId },
        orderBy: { createdAt: "asc" },
        select:  { id: true, name: true, slug: true, type: true, config: true, authConfig: true, status: true, lastTestedAt: true, createdAt: true }
      }),
      req.db.connector.count(),
      getTierFromDB(req.db),
    ]);
    // Return non-sensitive auth fields (host, port, username, email, etc.) for edit pre-fill
    const sanitized = connectors.map(({ authConfig, ...c }) => {
      const auth = authConfig ? JSON.parse(authConfig) : {};
      const publicAuth = Object.fromEntries(Object.entries(auth).filter(([k]) => !SENSITIVE_AUTH_KEYS.has(k)));
      return { ...c, publicAuth };        // slug is already in ...c
    });
    res.json({ connectors: sanitized, totalConnectors, tier: { maxConnectors: isFinite(tier.maxConnectors) ? tier.maxConnectors : null } });
  } catch (err) {
    console.error("[connectors] GET failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Check slug availability (legacy — kept for backward compat)
router.get("/connectors/check-slug", async (req, res) => {
  const { slug, excludeId } = req.query;
  if (!slug) return res.json({ available: false });
  const clean = slug.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!clean) return res.json({ available: false });
  const existing = await req.db.connector.findUnique({ where: { slug: clean }, select: { id: true } });
  const available = !existing || (excludeId && existing.id === parseInt(excludeId));
  res.json({ available });
});

// Check name availability (globally unique across all workspaces)
router.get("/connectors/check-name", async (req, res) => {
  const { name, excludeId } = req.query;
  const clean = name?.trim();
  if (!clean) return res.json({ available: false, suggestion: null });
  const existing = await req.db.connector.findFirst({ where: { name: clean }, select: { id: true } });
  const available = !existing || (excludeId && existing.id === parseInt(excludeId));
  let suggestion = null;
  if (!available) {
    let suffix = 1;
    while (await req.db.connector.findFirst({ where: { name: `${clean}-${suffix}` } })) suffix++;
    suggestion = `${clean}-${suffix}`;
  }
  res.json({ available, suggestion });
});

// Create connector
router.post("/workspaces/:workspaceId/connectors", async (req, res) => {
  const workspaceId = parseInt(req.params.workspaceId);
  const { name, slug: providedSlug, type, config, authConfig } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: "Name required" });
  let typeIsValid = SUPPORTED_TYPES.includes(type);
  if (!typeIsValid) {
    const master = await req.db.connectionMaster.findUnique({ where: { key: type }, select: { fields: true } });
    typeIsValid = !!master?.fields;
  }
  if (!typeIsValid) return res.status(400).json({ error: `Unsupported connector type: ${type}` });

  const existing = await req.db.connector.count();
  if (!await canAddConnector(existing, req.db)) {
    const tier = await getTierFromDB(req.db);
    return res.status(403).json({ error: `Tier limit reached. Max ${tier.maxConnectors} connector(s) allowed across the instance.` });
  }

  // Auto-suffix name to keep it globally unique (mysql → mysql-1 → mysql-2 …)
  let finalName = name.trim();
  const baseName = finalName;
  let nameSuffix = 1;
  while (await req.db.connector.findFirst({ where: { name: finalName } })) {
    finalName = `${baseName}-${nameSuffix++}`;
  }
  const slug = finalName; // slug mirrors name

  const connector = await req.db.connector.create({
    data: {
      workspaceId,
      name:       finalName,
      slug,
      type,
      config:     config     ? JSON.stringify(config)     : null,
      authConfig: authConfig ? JSON.stringify(authConfig) : null,
      status:     "active",
    },
    select: { id: true, name: true, slug: true, type: true, config: true, status: true, createdAt: true }
  });

  await logActivity(req.db, req.user, "connector.created", { workspaceId, name: connector.name, type });
  res.json({ connector });
});

// Update connector
router.put("/workspaces/:workspaceId/connectors/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, slug, config, authConfig, status } = req.body;
    const data = {};
    if (name   !== undefined) data.name   = name.trim();
    if (slug   !== undefined) data.slug   = slug ? slug.toLowerCase().replace(/[^a-z0-9]/g, "") || null : null;
    if (config !== undefined) data.config = config ? JSON.stringify(config) : null;
    if (status !== undefined) data.status = status;

    if (authConfig !== undefined) {
      if (!authConfig) {
        data.authConfig = null;
      } else {
        // Merge with existing: blank fields in the edit form mean "keep existing"
        const existing = await req.db.connector.findUnique({ where: { id }, select: { authConfig: true } });
        const existingAuth = existing?.authConfig ? JSON.parse(existing.authConfig) : {};
        const merged = { ...existingAuth };
        for (const [k, v] of Object.entries(authConfig)) {
          if (v !== "" && v !== null && v !== undefined) merged[k] = v;
        }
        data.authConfig = JSON.stringify(merged);
      }
    }

    const connector = await req.db.connector.update({
      where:  { id },
      data,
      select: { id: true, name: true, slug: true, type: true, config: true, status: true, lastTestedAt: true }
    });
    res.json({ connector });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(400).json({ error: "Slug is already in use by another connector. Choose a different slug." });
    }
    console.error("[connectors] PUT failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Test connector connection
router.post("/workspaces/:workspaceId/connectors/:id/test", async (req, res) => {
  const id        = parseInt(req.params.id);
  const connector = await req.db.connector.findUnique({ where: { id } });
  if (!connector) return res.status(404).json({ error: "Connector not found" });

  const cfg  = connector.config     ? JSON.parse(connector.config)     : {};
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};

  let success = false;
  let message = "";

  try {
    if (connector.type === "postgresql") {
      const { Pool } = require("pg");
      const pool = new Pool({
        connectionString: cfg.url || undefined,
        host:     cfg.host || "localhost",
        port:     parseInt(cfg.port || "5432"),
        database: cfg.database || undefined,
        user:     auth.username || undefined,
        password: auth.password || undefined,
        ssl:      cfg.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 8000,
      });
      await pool.query("SELECT 1");
      await pool.end();
      success = true; message = "Connected successfully.";
    } else if (connector.type === "mysql") {
      const mysql = require("mysql2/promise");
      const TIMEOUT_MS = 8000;
      const connPromise = mysql.createConnection({
        host:           cfg.host     || "localhost",
        port:           parseInt(cfg.port || "3306"),
        database:       cfg.database || undefined,
        user:           auth.username || undefined,
        password:       auth.password || undefined,
        connectTimeout: TIMEOUT_MS,
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out")), TIMEOUT_MS)
      );
      const conn = await Promise.race([connPromise, timeoutPromise]);
      await conn.ping();
      await conn.execute("SELECT 1");
      await conn.end();
      success = true; message = "Connected successfully.";
    } else if (connector.type === "mssql") {
      const mssql = require("mssql");
      const pool  = await mssql.connect({
        server:   cfg.host     || "localhost",
        port:     parseInt(cfg.port || "1433"),
        database: cfg.database || undefined,
        user:     auth.username || undefined,
        password: auth.password || undefined,
        options: {
          encrypt:                cfg.encrypt !== false,
          trustServerCertificate: cfg.trustServerCertificate || false,
        },
        connectionTimeout: 8000,
        requestTimeout:    8000,
      });
      await pool.request().query("SELECT 1 AS ok");
      await pool.close();
      success = true; message = "Connected successfully.";
    } else if (connector.type === "oracle") {
      const oracledb = require("oracledb");
      const connectString = cfg.connectString ||
        `${cfg.host || "localhost"}:${cfg.port || "1521"}/${cfg.serviceName || cfg.sid || "ORCL"}`;
      const conn = await oracledb.getConnection({
        user: auth.username || undefined, password: auth.password || undefined, connectString,
      });
      await conn.execute("SELECT 1 FROM DUAL");
      await conn.close();
      success = true; message = "Connected successfully.";
    } else if (connector.type === "mongodb") {
      const { MongoClient } = require("mongodb");
      const { buildUri } = require("../utils/tools/adapters/mongodb");
      const uri    = buildUri(cfg, auth);
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
      await client.connect();
      await client.db(cfg.database || "admin").command({ ping: 1 });
      await client.close();
      success = true; message = "Connected successfully.";
    } else if (connector.type === "gmail") {
      const { google }  = require("googleapis");
      const { makeOAuth2Client } = require("../utils/tools/adapters/gmail");
      if (!auth.refreshToken) throw new Error("Not connected — please reconnect via the Integrations tab.");
      const oauth2 = await makeOAuth2Client(req.db);
      oauth2.setCredentials({ access_token: auth.accessToken, refresh_token: auth.refreshToken, expiry_date: auth.expiresAt });
      const gmail = google.gmail({ version: "v1", auth: oauth2 });
      const profile = await gmail.users.getProfile({ userId: "me" });
      success = true; message = `Connected as ${profile.data.emailAddress}`;
    } else if (connector.type === "gdrive") {
      const { google }  = require("googleapis");
      const { makeOAuth2Client } = require("../utils/tools/adapters/gmail");
      if (!auth.refreshToken) throw new Error("Not connected — please reconnect via the Integrations tab.");
      const oauth2 = await makeOAuth2Client(req.db, connector.workspaceId);
      oauth2.setCredentials({ access_token: auth.accessToken, refresh_token: auth.refreshToken, expiry_date: auth.expiresAt });
      const drive = google.drive({ version: "v3", auth: oauth2 });
      const res = await drive.about.get({ fields: "user" });
      success = true; message = `Connected as ${res.data.user.emailAddress}`;
    } else if (["slack","jira","confluence","notion","hubspot","freshdesk","zendesk","github"].includes(connector.type)) {
      const { ADAPTERS } = require("../utils/tools/registry");
      const adapter = ADAPTERS[connector.type];
      const ok = await adapter.testConnection(auth);
      if (!ok) throw new Error("Connection test failed — check your credentials.");
      success = true; message = "Connected successfully.";
    } else if (connector.type === "zoho-mail") {
      const nodemailer = require("nodemailer");
      const port = parseInt(auth.smtpPort || "465");
      const transport = nodemailer.createTransport({
        host:   auth.smtpHost || "smtp.zoho.com",
        port,
        secure: port === 465,
        auth: { user: auth.email, pass: auth.appPassword },
        connectionTimeout: 8000,
      });
      await transport.verify();
      success = true; message = `Connected as ${auth.email}`;
    } else if (connector.type === "ssh") {
      const { Client } = require("ssh2");
      await new Promise((resolve, reject) => {
        const conn = new Client();
        const timer = setTimeout(() => { conn.end(); reject(new Error("Connection timed out")); }, 10000);
        conn.on("ready", () => { clearTimeout(timer); conn.end(); resolve(); });
        conn.on("error", err => { clearTimeout(timer); reject(err); });
        const cfg2 = { host: auth.host || cfg.host, port: parseInt(auth.port || cfg.port || "22"), username: auth.username || cfg.username };
        if (auth.privateKey || cfg.privateKey) cfg2.privateKey = auth.privateKey || cfg.privateKey;
        conn.connect(cfg2);
      });
      success = true; message = `Connected to ${auth.host || cfg.host} as ${auth.username || cfg.username}`;
    } else if (connector.type === "redis") {
      const Redis = require("ioredis");
      const client = new Redis({
        host: cfg.host || "localhost",
        port: parseInt(cfg.port || "6379"),
        password: auth.password || undefined,
        db: parseInt(cfg.db || "0"),
        tls: cfg.tls ? {} : undefined,
        connectTimeout: 8000,
        lazyConnect: true,
      });
      await client.connect();
      await client.ping();
      await client.quit();
      success = true; message = "Connected successfully.";
    } else if (connector.type === "sqlite") {
      const Database = require("better-sqlite3");
      const db = new Database(cfg.filename || ":memory:", { timeout: 8000 });
      db.prepare("SELECT 1").get();
      db.close();
      success = true; message = `Connected to ${cfg.filename || ":memory:"}`;
    } else if (connector.type === "cockroachdb") {
      const { Pool } = require("pg");
      const pool = new Pool({
        host:     cfg.host     || "localhost",
        port:     parseInt(cfg.port || "26257"),
        database: cfg.database || "defaultdb",
        user:     auth.username || undefined,
        password: auth.password || undefined,
        ssl:      cfg.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 8000,
      });
      await pool.query("SELECT 1");
      await pool.end();
      success = true; message = "Connected successfully.";
    } else if (connector.type === "snowflake") {
      const snowflake = require("snowflake-sdk");
      await new Promise((resolve, reject) => {
        const c = snowflake.createConnection({
          account:   cfg.account,
          username:  auth.username,
          password:  auth.password,
          database:  cfg.database,
          schema:    cfg.schema   || "PUBLIC",
          warehouse: cfg.warehouse,
          role:      cfg.role     || undefined,
        });
        c.connect(err => {
          if (err) { reject(err); return; }
          c.execute({ sqlText: "SELECT 1", complete: (err2) => { c.destroy(() => {}); err2 ? reject(err2) : resolve(); } });
        });
      });
      success = true; message = "Connected successfully.";
    } else if (connector.type === "bigquery") {
      const { BigQuery } = require("@google-cloud/bigquery");
      const credentials = auth.keyFileJson ? JSON.parse(auth.keyFileJson) : undefined;
      const bq = new BigQuery({ projectId: cfg.projectId, credentials });
      await bq.query({ query: "SELECT 1", timeoutMs: 8000 });
      success = true; message = `Connected to project ${cfg.projectId}`;
    } else if (connector.type === "elasticsearch") {
      const { Client } = require("@elastic/elasticsearch");
      const esAuth = auth.apiKey
        ? { auth: { apiKey: auth.apiKey } }
        : (auth.username ? { auth: { username: auth.username, password: auth.password || "" } } : {});
      const esClient = new Client({ node: cfg.node || "http://localhost:9200", ...esAuth, requestTimeout: 8000 });
      const info = await esClient.info();
      await esClient.close();
      success = true; message = `Connected — Elasticsearch ${info.version?.number || ""}`;
    } else if (connector.type === "onedrive") {
      if (!auth.refreshToken && !auth.accessToken) throw new Error("Not connected — complete OAuth flow first.");
      const { data } = await require("axios").get("https://graph.microsoft.com/v1.0/me/drive", { headers: { Authorization: `Bearer ${auth.accessToken}` }, timeout: 8000 });
      success = true; message = `Connected to OneDrive (${data.owner?.user?.displayName || data.driveType || "personal"})`;
    } else if (connector.type === "dropbox") {
      if (!auth.accessToken) throw new Error("Not connected — complete OAuth flow first.");
      const { data } = await require("axios").post("https://api.dropboxapi.com/2/users/get_current_account", null, { headers: { Authorization: `Bearer ${auth.accessToken}` }, timeout: 8000 });
      success = true; message = `Connected as ${data.email || data.name?.display_name || "Dropbox user"}`;
    } else if (connector.type === "box") {
      if (!auth.accessToken) throw new Error("Not connected — complete OAuth flow first.");
      const { data } = await require("axios").get("https://api.box.com/2.0/users/me", { headers: { Authorization: `Bearer ${auth.accessToken}` }, timeout: 8000 });
      success = true; message = `Connected as ${data.login || data.name || "Box user"}`;
    } else if (connector.type === "rest-api") {
      const axios = require("axios");
      const baseUrl = (cfg.baseUrl || "").replace(/\/$/, "");
      if (!baseUrl) throw new Error("Base URL not configured");
      const headers = {};
      if (auth.apiKey)      headers[auth.headerName || "X-API-Key"] = auth.apiKey;
      if (auth.bearerToken) headers["Authorization"] = `Bearer ${auth.bearerToken}`;
      await axios.get(baseUrl + (cfg.healthPath || "/"), { headers, timeout: 8000 });
      success = true; message = "API reachable.";
    }
  } catch (err) {
    message = err.message || err.errors?.[0]?.message || err.code || String(err) || "Connection failed";
  }

  await req.db.connector.update({
    where: { id },
    data:  { status: success ? "active" : "error", lastTestedAt: new Date() }
  });

  res.json({ success, message });
});

// Delete connector
router.delete("/workspaces/:workspaceId/connectors/:id", async (req, res) => {
  const id        = parseInt(req.params.id);
  const connector = await req.db.connector.findUnique({ where: { id }, select: { name: true, type: true } });
  if (!connector) return res.status(404).json({ error: "Not found" });
  await req.db.connector.delete({ where: { id } });
  await logActivity(req.db, req.user, "connector.deleted", { name: connector.name, type: connector.type });
  res.json({ success: true });
});


module.exports = router;
