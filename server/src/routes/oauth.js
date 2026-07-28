const router    = require("express").Router();
const { authenticate, requireManagerOrAdmin } = require("../middleware/auth");
const { makeOAuth2Client, getGoogleCredentials } = require("../utils/tools/adapters/gmail");

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

const GDRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
];

const FRONTEND_URL  = process.env.FRONTEND_URL        || "http://localhost:3000";
const CALLBACK_BASE = process.env.OAUTH_CALLBACK_BASE || "http://localhost:3001";

function generateSlug(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "") || "connector";
}

async function uniqueSlug(db, base) {
  if (!base) base = "connector";
  let slug = base, suffix = 2;
  while (await db.connector.findUnique({ where: { slug } })) slug = `${base}${suffix++}`;
  return slug;
}

async function uniqueName(db, base) {
  if (!base) base = "connector";
  let name = base, suffix = 1;
  while (await db.connector.findFirst({ where: { name } })) name = `${base}-${suffix++}`;
  return name;
}

async function workspaceRedirect(db, workspaceId, type, success) {
  try {
    const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } });
    if (ws?.slug) return `${FRONTEND_URL}/workspace/${ws.slug}?oauth_${success ? "success" : "error"}=${encodeURIComponent(type)}&ws=${workspaceId}`;
  } catch {}
  return `${FRONTEND_URL}?oauth_${success ? "success" : "error"}=${encodeURIComponent(type)}&ws=${workspaceId}`;
}

// Check if Google OAuth is configured for a workspace
router.get("/gmail/status", authenticate, async (req, res) => {
  const workspaceId = parseInt(req.query.workspaceId);
  const { clientId } = await getGoogleCredentials(req.db, workspaceId || undefined);
  res.json({ configured: !!clientId });
});

// Save per-workspace Google OAuth credentials
router.post("/gmail/configure", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { clientId, clientSecret, workspaceId } = req.body;
  if (!clientId?.trim() || !clientSecret?.trim() || !workspaceId) {
    return res.status(400).json({ error: "Client ID, Client Secret and workspaceId are required" });
  }
  try {
    const wsId = parseInt(workspaceId);
    await req.db.setting.upsert({
      where:  { key: `oauth.google.clientId.ws.${wsId}` },
      create: { key: `oauth.google.clientId.ws.${wsId}`,     value: clientId.trim() },
      update: { value: clientId.trim() },
    });
    await req.db.setting.upsert({
      where:  { key: `oauth.google.clientSecret.ws.${wsId}` },
      create: { key: `oauth.google.clientSecret.ws.${wsId}`, value: clientSecret.trim() },
      update: { value: clientSecret.trim() },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete per-workspace Google OAuth credentials
router.delete("/gmail/configure", authenticate, requireManagerOrAdmin, async (req, res) => {
  const workspaceId = parseInt(req.query.workspaceId);
  if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
  try {
    await req.db.setting.deleteMany({
      where: { key: { in: [
        `oauth.google.clientId.ws.${workspaceId}`,
        `oauth.google.clientSecret.ws.${workspaceId}`,
      ]}}
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Returns the Google OAuth URL — frontend calls this via axios then does window.location.href
router.get("/gmail/start", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { workspaceId, connectionName, connectionSlug } = req.query;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });

  const wsId = parseInt(workspaceId);
  const { clientId } = await getGoogleCredentials(req.db, wsId);
  if (!clientId) return res.status(400).json({ error: "Google Client ID not configured. Add it in the Integrations tab." });

  const state  = Buffer.from(JSON.stringify({ workspaceId: wsId, connectionName: connectionName || "", connectionSlug: connectionSlug || "" })).toString("base64url");
  const oauth2 = await makeOAuth2Client(req.db, wsId);
  const url    = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
    scope:       GMAIL_SCOPES,
    state,
  });
  res.json({ url });
});

// Gmail OAuth callback — exchange code, store connector, redirect to frontend
router.get("/gmail/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${FRONTEND_URL}?oauth_error=missing_params`);

  let workspaceId, connectionName, connectionSlug;
  try {
    ({ workspaceId, connectionName, connectionSlug } = JSON.parse(Buffer.from(state, "base64url").toString()));
  } catch {
    return res.redirect(`${FRONTEND_URL}?oauth_error=invalid_state`);
  }

  try {
    const oauth2 = await makeOAuth2Client(req.db, workspaceId);
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    // Get the user's Gmail address
    const { google } = require("googleapis");
    const oauth2Api  = google.oauth2({ version: "v2", auth: oauth2 });
    const { data: userInfo } = await oauth2Api.userinfo.get();
    const email = userInfo.email;

    const db = req.db || require("../utils/prisma");

    // Upsert: one Gmail connector per workspace per email
    const existing = await db.connector.findFirst({
      where: { workspaceId, type: "gmail", name: email }
    });

    const authConfig = JSON.stringify({
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:    tokens.expiry_date,
    });

    const connName = connectionName?.trim() || email;
    if (existing) {
      await db.connector.update({
        where: { id: existing.id },
        data:  { authConfig, status: "active", lastTestedAt: new Date() }
      });
    } else {
      const finalName = await uniqueName(db, connName);
      await db.connector.create({
        data: {
          workspaceId,
          name:       finalName,
          type:       "gmail",
          slug:       finalName,
          config:     JSON.stringify({ email }),
          authConfig,
          status:     "active",
        }
      });
    }

    res.redirect(await workspaceRedirect(req.db, workspaceId, "gmail", true));
  } catch (err) {
    console.error("[oauth/gmail] callback error:", err.message);
    res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

// ── Google Drive OAuth ──────────────────────────────────────────────────────

router.get("/gdrive/start", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { workspaceId, connectionName, connectionSlug } = req.query;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });

  const wsId = parseInt(workspaceId);
  const { clientId } = await getGoogleCredentials(req.db, wsId);
  if (!clientId) return res.status(400).json({ error: "Google Client ID not configured. Add it in the Gmail integration tab first." });

  const state  = Buffer.from(JSON.stringify({ workspaceId: wsId, connectionName: connectionName || "", connectionSlug: connectionSlug || "" })).toString("base64url");
  const oauth2 = await makeOAuth2Client(req.db, wsId, "/api/oauth/gdrive/callback");
  const url    = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
    scope:       GDRIVE_SCOPES,
    state,
  });
  res.json({ url });
});

router.get("/gdrive/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${FRONTEND_URL}?oauth_error=missing_params`);

  let workspaceId, connectionName, connectionSlug;
  try {
    ({ workspaceId, connectionName, connectionSlug } = JSON.parse(Buffer.from(state, "base64url").toString()));
  } catch {
    return res.redirect(`${FRONTEND_URL}?oauth_error=invalid_state`);
  }

  try {
    const oauth2 = await makeOAuth2Client(req.db, workspaceId, "/api/oauth/gdrive/callback");
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    const { google } = require("googleapis");
    const oauth2Api  = google.oauth2({ version: "v2", auth: oauth2 });
    const { data: userInfo } = await oauth2Api.userinfo.get();
    const email = userInfo.email;

    const db = req.db || require("../utils/prisma");

    const existing = await db.connector.findFirst({
      where: { workspaceId, type: "gdrive", name: email }
    });

    const authConfig = JSON.stringify({
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:    tokens.expiry_date,
    });

    const connName = connectionName?.trim() || email;
    if (existing) {
      await db.connector.update({
        where: { id: existing.id },
        data:  { authConfig, status: "active", lastTestedAt: new Date() }
      });
    } else {
      const finalName = await uniqueName(db, connName);
      await db.connector.create({
        data: {
          workspaceId,
          name:       finalName,
          type:       "gdrive",
          slug:       finalName,
          slug,
          config:     JSON.stringify({ email }),
          authConfig,
          status:     "active",
        }
      });
    }

    res.redirect(await workspaceRedirect(req.db, workspaceId, "gdrive", true));
  } catch (err) {
    console.error("[oauth/gdrive] callback error:", err.message);
    res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

// ── OneDrive OAuth ───────────────────────────────────────────────────────────

router.post("/onedrive/configure", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { clientId, clientSecret, tenantId, workspaceId } = req.body;
  if (!clientId?.trim() || !clientSecret?.trim() || !workspaceId) return res.status(400).json({ error: "clientId, clientSecret, workspaceId required" });
  const wsId = parseInt(workspaceId);
  await req.db.setting.upsert({ where: { key: `oauth.onedrive.clientId.ws.${wsId}` },     create: { key: `oauth.onedrive.clientId.ws.${wsId}`,     value: clientId.trim() },     update: { value: clientId.trim() } });
  await req.db.setting.upsert({ where: { key: `oauth.onedrive.clientSecret.ws.${wsId}` }, create: { key: `oauth.onedrive.clientSecret.ws.${wsId}`, value: clientSecret.trim() }, update: { value: clientSecret.trim() } });
  if (tenantId?.trim()) await req.db.setting.upsert({ where: { key: `oauth.onedrive.tenantId.ws.${wsId}` }, create: { key: `oauth.onedrive.tenantId.ws.${wsId}`, value: tenantId.trim() }, update: { value: tenantId.trim() } });
  res.json({ success: true });
});

router.get("/onedrive/start", authenticate, requireManagerOrAdmin, async (req, res) => {
  const wsId = parseInt(req.query.workspaceId);
  if (!wsId) return res.status(400).json({ error: "workspaceId required" });
  const get = async key => (await req.db.setting.findUnique({ where: { key } }))?.value;
  const clientId = await get(`oauth.onedrive.clientId.ws.${wsId}`);
  const tenantId = (await get(`oauth.onedrive.tenantId.ws.${wsId}`)) || "common";
  if (!clientId) return res.status(400).json({ error: "OneDrive not configured. Add credentials in Integrations." });
  const { connectionName = "", connectionSlug = "" } = req.query;
  const state = Buffer.from(JSON.stringify({ workspaceId: wsId, connectionName, connectionSlug })).toString("base64url");
  const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: `${CALLBACK_BASE}/api/oauth/onedrive/callback`, scope: "Files.Read.All offline_access User.Read", state });
  res.json({ url: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params}` });
});

router.get("/onedrive/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${FRONTEND_URL}?oauth_error=missing_params`);
  let workspaceId, connectionName, connectionSlug;
  try { ({ workspaceId, connectionName, connectionSlug } = JSON.parse(Buffer.from(state, "base64url").toString())); } catch { return res.redirect(`${FRONTEND_URL}?oauth_error=invalid_state`); }
  try {
    const db = req.db;
    const get = async key => (await db.setting.findUnique({ where: { key } }))?.value;
    const clientId     = await get(`oauth.onedrive.clientId.ws.${workspaceId}`);
    const clientSecret = await get(`oauth.onedrive.clientSecret.ws.${workspaceId}`);
    const tenantId     = (await get(`oauth.onedrive.tenantId.ws.${workspaceId}`)) || "common";
      const axios = require("axios");
    const { data: tokens } = await axios.post(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: `${CALLBACK_BASE}/api/oauth/onedrive/callback`, scope: "Files.Read.All offline_access User.Read" }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const { data: me } = await axios.get("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const email = me.mail || me.userPrincipalName;
    const authConfig = JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
    const config = JSON.stringify({ clientId, clientSecret, tenantId, email });
    const existing = await db.connector.findFirst({ where: { workspaceId, type: "onedrive", name: email } });
    if (existing) await db.connector.update({ where: { id: existing.id }, data: { authConfig, config, status: "active", lastTestedAt: new Date() } });
    else {
      const finalName = await uniqueName(db, connectionName?.trim() || email);
      await db.connector.create({ data: { workspaceId, name: finalName, type: "onedrive", slug: finalName, config, authConfig, status: "active" } });
    }
    res.redirect(await workspaceRedirect(req.db, workspaceId, "onedrive", true));
  } catch (err) { res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(err.message)}`); }
});

// ── Dropbox OAuth ─────────────────────────────────────────────────────────────

router.post("/dropbox/configure", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { appKey, appSecret, workspaceId } = req.body;
  if (!appKey?.trim() || !appSecret?.trim() || !workspaceId) return res.status(400).json({ error: "appKey, appSecret, workspaceId required" });
  const wsId = parseInt(workspaceId);
  await req.db.setting.upsert({ where: { key: `oauth.dropbox.appKey.ws.${wsId}` },    create: { key: `oauth.dropbox.appKey.ws.${wsId}`,    value: appKey.trim() },    update: { value: appKey.trim() } });
  await req.db.setting.upsert({ where: { key: `oauth.dropbox.appSecret.ws.${wsId}` }, create: { key: `oauth.dropbox.appSecret.ws.${wsId}`, value: appSecret.trim() }, update: { value: appSecret.trim() } });
  res.json({ success: true });
});

router.get("/dropbox/start", authenticate, requireManagerOrAdmin, async (req, res) => {
  const wsId = parseInt(req.query.workspaceId);
  if (!wsId) return res.status(400).json({ error: "workspaceId required" });
  const get = async key => (await req.db.setting.findUnique({ where: { key } }))?.value;
  const appKey = await get(`oauth.dropbox.appKey.ws.${wsId}`);
  if (!appKey) return res.status(400).json({ error: "Dropbox not configured. Add credentials in Integrations." });
  const { connectionName = "", connectionSlug = "" } = req.query;
  const state = Buffer.from(JSON.stringify({ workspaceId: wsId, connectionName, connectionSlug })).toString("base64url");
  const params = new URLSearchParams({ client_id: appKey, response_type: "code", redirect_uri: `${CALLBACK_BASE}/api/oauth/dropbox/callback`, token_access_type: "offline", state });
  res.json({ url: `https://www.dropbox.com/oauth2/authorize?${params}` });
});

router.get("/dropbox/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${FRONTEND_URL}?oauth_error=missing_params`);
  let workspaceId, connectionName, connectionSlug;
  try { ({ workspaceId, connectionName, connectionSlug } = JSON.parse(Buffer.from(state, "base64url").toString())); } catch { return res.redirect(`${FRONTEND_URL}?oauth_error=invalid_state`); }
  try {
    const db = req.db;
    const get = async key => (await db.setting.findUnique({ where: { key } }))?.value;
    const appKey    = await get(`oauth.dropbox.appKey.ws.${workspaceId}`);
    const appSecret = await get(`oauth.dropbox.appSecret.ws.${workspaceId}`);
      const axios = require("axios");
    const { data: tokens } = await axios.post("https://api.dropboxapi.com/oauth2/token",
      new URLSearchParams({ grant_type: "authorization_code", code, client_id: appKey, client_secret: appSecret, redirect_uri: `${CALLBACK_BASE}/api/oauth/dropbox/callback` }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const { data: me } = await axios.post("https://api.dropboxapi.com/2/users/get_current_account", null, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const email = me.email;
    const authConfig = JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null });
    const config = JSON.stringify({ appKey, appSecret, email });
    const existing = await db.connector.findFirst({ where: { workspaceId, type: "dropbox", name: email } });
    if (existing) await db.connector.update({ where: { id: existing.id }, data: { authConfig, config, status: "active", lastTestedAt: new Date() } });
    else {
      const finalName = await uniqueName(db, connectionName?.trim() || email);
      await db.connector.create({ data: { workspaceId, name: finalName, type: "dropbox", slug: finalName, config, authConfig, status: "active" } });
    }
    res.redirect(await workspaceRedirect(req.db, workspaceId, "dropbox", true));
  } catch (err) { res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(err.message)}`); }
});

// ── Box OAuth ─────────────────────────────────────────────────────────────────

router.post("/box/configure", authenticate, requireManagerOrAdmin, async (req, res) => {
  const { clientId, clientSecret, workspaceId } = req.body;
  if (!clientId?.trim() || !clientSecret?.trim() || !workspaceId) return res.status(400).json({ error: "clientId, clientSecret, workspaceId required" });
  const wsId = parseInt(workspaceId);
  await req.db.setting.upsert({ where: { key: `oauth.box.clientId.ws.${wsId}` },     create: { key: `oauth.box.clientId.ws.${wsId}`,     value: clientId.trim() },     update: { value: clientId.trim() } });
  await req.db.setting.upsert({ where: { key: `oauth.box.clientSecret.ws.${wsId}` }, create: { key: `oauth.box.clientSecret.ws.${wsId}`, value: clientSecret.trim() }, update: { value: clientSecret.trim() } });
  res.json({ success: true });
});

router.get("/box/start", authenticate, requireManagerOrAdmin, async (req, res) => {
  const wsId = parseInt(req.query.workspaceId);
  if (!wsId) return res.status(400).json({ error: "workspaceId required" });
  const get = async key => (await req.db.setting.findUnique({ where: { key } }))?.value;
  const clientId = await get(`oauth.box.clientId.ws.${wsId}`);
  if (!clientId) return res.status(400).json({ error: "Box not configured. Add credentials in Integrations." });
  const { connectionName = "", connectionSlug = "" } = req.query;
  const state = Buffer.from(JSON.stringify({ workspaceId: wsId, connectionName, connectionSlug })).toString("base64url");
  const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: `${CALLBACK_BASE}/api/oauth/box/callback`, state });
  res.json({ url: `https://account.box.com/api/oauth2/authorize?${params}` });
});

router.get("/box/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(error)}`);
  if (!code || !state) return res.redirect(`${FRONTEND_URL}?oauth_error=missing_params`);
  let workspaceId, connectionName, connectionSlug;
  try { ({ workspaceId, connectionName, connectionSlug } = JSON.parse(Buffer.from(state, "base64url").toString())); } catch { return res.redirect(`${FRONTEND_URL}?oauth_error=invalid_state`); }
  try {
    const db = req.db;
    const get = async key => (await db.setting.findUnique({ where: { key } }))?.value;
    const clientId     = await get(`oauth.box.clientId.ws.${workspaceId}`);
    const clientSecret = await get(`oauth.box.clientSecret.ws.${workspaceId}`);
      const axios = require("axios");
    const { data: tokens } = await axios.post("https://api.box.com/oauth2/token",
      new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: `${CALLBACK_BASE}/api/oauth/box/callback` }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const { data: me } = await axios.get("https://api.box.com/2.0/users/me", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const email = me.login;
    const authConfig = JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
    const config = JSON.stringify({ clientId, clientSecret, email });
    const existing = await db.connector.findFirst({ where: { workspaceId, type: "box", name: email } });
    if (existing) await db.connector.update({ where: { id: existing.id }, data: { authConfig, config, status: "active", lastTestedAt: new Date() } });
    else {
      const finalName = await uniqueName(db, connectionName?.trim() || email);
      await db.connector.create({ data: { workspaceId, name: finalName, type: "box", slug: finalName, config, authConfig, status: "active" } });
    }
    res.redirect(await workspaceRedirect(req.db, workspaceId, "box", true));
  } catch (err) { res.redirect(`${FRONTEND_URL}?oauth_error=${encodeURIComponent(err.message)}`); }
});

module.exports = router;
