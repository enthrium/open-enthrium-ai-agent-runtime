const router = require("express").Router();
const jwt    = require("jsonwebtoken");
const axios  = require("axios");
const { authenticate, requireAdmin } = require("../middleware/auth");

const FRONTEND_URL  = process.env.FRONTEND_URL        || "http://localhost:3000";
const CALLBACK_BASE = process.env.OAUTH_CALLBACK_BASE || "http://localhost:3001";
const CALLBACK_URL  = `${CALLBACK_BASE}/api/sso/callback`;

const PROVIDERS = {
  google: {
    name:        "Google",
    authUrl:     "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl:    "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scope:       "openid email profile",
    getEmail:    d => d.email,
  },
  microsoft: {
    name:        "Microsoft",
    authUrl:     "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl:    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userInfoUrl: "https://graph.microsoft.com/v1.0/me",
    scope:       "openid email User.Read",
    getEmail:    d => d.mail || d.userPrincipalName,
  },
  github: {
    name:        "GitHub",
    authUrl:     "https://github.com/login/oauth/authorize",
    tokenUrl:    "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user/emails",
    scope:       "user:email",
    getEmail:    d => {
      if (Array.isArray(d)) {
        const primary = d.find(e => e.primary && e.verified);
        return primary?.email || d[0]?.email;
      }
      return d.email;
    },
  },
  facebook: {
    name:        "Facebook",
    authUrl:     "https://www.facebook.com/v18.0/dialog/oauth",
    tokenUrl:    "https://graph.facebook.com/v18.0/oauth/access_token",
    userInfoUrl: "https://graph.facebook.com/me?fields=email",
    scope:       "email",
    getEmail:    d => d.email,
  },
  apple: {
    name:        "Apple",
    authUrl:     "https://appleid.apple.com/auth/authorize",
    tokenUrl:    "https://appleid.apple.com/auth/token",
    userInfoUrl: null,
    scope:       "name email",
    getEmail:    d => d.email,
    note:        "Apple requires a private key (p8) to generate the client secret. Contact support to enable.",
  },
  zoho: {
    name:        "Zoho",
    authUrl:     "https://accounts.zoho.com/oauth/v2/auth",
    tokenUrl:    "https://accounts.zoho.com/oauth/v2/token",
    userInfoUrl: "https://accounts.zoho.com/oauth/v2/userinfo",
    scope:       "openid email",
    getEmail:    d => d.email,
  },
};

const SSO_ERROR_MESSAGES = {
  not_configured:    "SSO is not configured",
  unknown_provider:  "Unknown SSO provider",
  no_email:          "SSO provider did not return an email address",
  user_not_found:    "No account found for this email. Contact your administrator.",
  account_suspended: "Your account has been suspended",
  use_password_login: "This account must use password login",
  apple_not_supported: "Apple SSO requires additional server-side setup",
};

function getSetting(db, key) {
  return db.setting.findUnique({ where: { key } }).then(r => r?.value ?? null);
}

// ── Public: login page checks this on load ────────────────────────────────────
router.get("/config", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const [enabled, provider, clientId] = await Promise.all([
      getSetting(req.db, "sso.enabled"),
      getSetting(req.db, "sso.provider"),
      getSetting(req.db, "sso.clientId"),
    ]);
    const active = enabled === "true" && !!provider && !!clientId;
    res.json({ enabled: active, provider: active ? provider : null, callbackUrl: CALLBACK_URL });
  } catch {
    res.json({ enabled: false, provider: null, callbackUrl: CALLBACK_URL });
  }
});

// ── Admin: save SSO config ────────────────────────────────────────────────────
router.put("/config", authenticate, requireAdmin, async (req, res) => {
  const { provider, clientId, clientSecret, enabled } = req.body;
  const upsert = (key, value) => req.db.setting.upsert({
    where:  { key },
    create: { key, value: String(value) },
    update: { value: String(value) },
  });
  if (provider  !== undefined)                        await upsert("sso.provider",      provider);
  if (clientId  !== undefined)                        await upsert("sso.clientId",      clientId);
  if (clientSecret && clientSecret !== "********")    await upsert("sso.clientSecret",  clientSecret);
  if (enabled   !== undefined)                        await upsert("sso.enabled",       String(enabled));
  res.json({ success: true });
});

// ── Public: start OAuth flow ──────────────────────────────────────────────────
router.get("/start", async (req, res) => {
  try {
    const [enabled, provider, clientId] = await Promise.all([
      getSetting(req.db, "sso.enabled"),
      getSetting(req.db, "sso.provider"),
      getSetting(req.db, "sso.clientId"),
    ]);
    if (enabled !== "true" || !provider || !clientId)
      return res.redirect(`${FRONTEND_URL}/login?sso_error=not_configured`);

    if (provider === "apple")
      return res.redirect(`${FRONTEND_URL}/login?sso_error=apple_not_supported`);

    const p = PROVIDERS[provider];
    if (!p) return res.redirect(`${FRONTEND_URL}/login?sso_error=unknown_provider`);

    const state  = Buffer.from(JSON.stringify({ ts: Date.now() })).toString("base64url");
    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  CALLBACK_URL,
      response_type: "code",
      scope:         p.scope,
      state,
    });
    res.redirect(`${p.authUrl}?${params}`);
  } catch (err) {
    console.error("[SSO] start error:", err.message);
    res.redirect(`${FRONTEND_URL}/login?sso_error=${encodeURIComponent(err.message)}`);
  }
});

// ── Public: OAuth callback ────────────────────────────────────────────────────
router.get("/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}/login?sso_error=${encodeURIComponent(error)}`);
  if (!code)  return res.redirect(`${FRONTEND_URL}/login?sso_error=no_code`);

  try {
    const [provider, clientId, clientSecret] = await Promise.all([
      getSetting(req.db, "sso.provider"),
      getSetting(req.db, "sso.clientId"),
      getSetting(req.db, "sso.clientSecret"),
    ]);
    if (!provider || !clientId || !clientSecret)
      return res.redirect(`${FRONTEND_URL}/login?sso_error=not_configured`);

    const p = PROVIDERS[provider];

    // Exchange code for access token
    const tokenHeaders = { "Content-Type": "application/x-www-form-urlencoded" };
    if (provider === "github") tokenHeaders["Accept"] = "application/json";

    const { data: tokens } = await axios.post(
      p.tokenUrl,
      new URLSearchParams({
        grant_type:    "authorization_code",
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  CALLBACK_URL,
      }),
      { headers: tokenHeaders }
    );

    const accessToken = tokens.access_token;
    if (!accessToken) throw new Error("No access token returned");

    // Get user info / email
    const { data: userInfo } = await axios.get(p.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        "application/json",
        ...(provider === "github" ? { "User-Agent": "OpenEnterprise-SSO" } : {}),
      },
    });

    const email = p.getEmail(userInfo)?.toLowerCase();
    if (!email) return res.redirect(`${FRONTEND_URL}/login?sso_error=no_email`);

    // Block super admin from OAuth
    const superEmail = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();
    if (superEmail && email === superEmail)
      return res.redirect(`${FRONTEND_URL}/login?sso_error=use_password_login`);

    // Look up user in DB
    const user = await req.db.user.findUnique({ where: { email } });
    if (!user)         return res.redirect(`${FRONTEND_URL}/login?sso_error=user_not_found`);
    if (user.suspended) return res.redirect(`${FRONTEND_URL}/login?sso_error=account_suspended`);

    // Issue JWT — same structure as password login, with sso flag
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name, sso: true },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.redirect(`${FRONTEND_URL}/login?sso_token=${token}`);
  } catch (err) {
    console.error("[SSO] callback error:", err.message);
    const msg = err.response?.data?.error_description || err.response?.data?.error || err.message;
    res.redirect(`${FRONTEND_URL}/login?sso_error=${encodeURIComponent(msg)}`);
  }
});

module.exports = { router, SSO_ERROR_MESSAGES };
