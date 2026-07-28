const { google } = require("googleapis");

async function getGoogleCredentials(db, workspaceId) {
  let clientId     = process.env.GOOGLE_CLIENT_ID;
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (db && workspaceId) {
    const rows = await db.setting.findMany({
      where: { key: { in: [
        `oauth.google.clientId.ws.${workspaceId}`,
        `oauth.google.clientSecret.ws.${workspaceId}`,
      ]}}
    });
    for (const r of rows) {
      if (r.key === `oauth.google.clientId.ws.${workspaceId}`     && r.value) clientId     = r.value;
      if (r.key === `oauth.google.clientSecret.ws.${workspaceId}` && r.value) clientSecret = r.value;
    }
  }
  return { clientId, clientSecret };
}

async function makeOAuth2Client(db, workspaceId, callbackPath = "/api/oauth/gmail/callback", overrides = {}) {
  const { clientId: dbId, clientSecret: dbSecret } = await getGoogleCredentials(db, workspaceId);
  const clientId     = overrides.clientId     || dbId;
  const clientSecret = overrides.clientSecret || dbSecret;
  const callbackBase = process.env.OAUTH_CALLBACK_BASE || "http://localhost:3001";
  return new google.auth.OAuth2(clientId, clientSecret, `${callbackBase}${callbackPath}`);
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_send_email`,
        description: `Send an email via the connected Gmail account (${connector.name}). Use when the user asks to email, notify, or send a message.`,
        parameters: {
          type: "object",
          properties: {
            to:      { type: "string", description: "Recipient email address." },
            subject: { type: "string", description: "Email subject line." },
            body:    { type: "string", description: "Plain text email body." },
          },
          required: ["to", "subject", "body"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_search_emails`,
        description: `Search emails in the connected Gmail account (${connector.name}). Use when the user asks to find, look up, or check emails.`,
        parameters: {
          type: "object",
          properties: {
            query:      { type: "string", description: "Gmail search query (e.g. 'from:someone@gmail.com subject:invoice')" },
            maxResults: { type: "number", description: "Max emails to return (default 5, max 20)." },
          },
          required: ["query"]
        }
      }
    }
  ];
}

function getAnthropicToolDefinitions(connector) {
  return [
    {
      name: `conn_${connector.id}_send_email`,
      description: `Send an email via the connected Gmail account (${connector.name}).`,
      input_schema: {
        type: "object",
        properties: {
          to:      { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject line." },
          body:    { type: "string", description: "Plain text email body." },
        },
        required: ["to", "subject", "body"]
      }
    },
    {
      name: `conn_${connector.id}_search_emails`,
      description: `Search emails in the connected Gmail account (${connector.name}).`,
      input_schema: {
        type: "object",
        properties: {
          query:      { type: "string", description: "Gmail search query." },
          maxResults: { type: "number", description: "Max emails to return (default 5, max 20)." },
        },
        required: ["query"]
      }
    }
  ];
}

async function buildGmailClient(authConfig, db, workspaceId) {
  const oauth2 = await makeOAuth2Client(db, workspaceId, "/api/oauth/gmail/callback", {
    clientId:     authConfig.clientId,
    clientSecret: authConfig.clientSecret,
  });
  oauth2.setCredentials({
    access_token:  authConfig.accessToken,
    refresh_token: authConfig.refreshToken,
    expiry_date:   authConfig.expiresAt,
  });
  return google.gmail({ version: "v1", auth: oauth2 });
}

async function executeTool(action, args, connector, db) {
  const authConfig = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  if (!authConfig.refreshToken) return "Gmail not connected. Please connect via the Integrations tab.";

  try {
    const gmail = await buildGmailClient(authConfig, db, connector.workspaceId);

    if (action === "send_email") {
      const { to, subject, body } = args;
      if (!to || !subject || !body) return "Missing required fields: to, subject, body.";

      const raw = Buffer.from(
        `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
      ).toString("base64url");

      await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      return `Email sent to ${to} with subject "${subject}".`;
    }

    if (action === "search_emails") {
      const { query, maxResults = 5 } = args;
      const safeMax = Math.min(parseInt(maxResults) || 5, 20);

      const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: safeMax });
      const messages = list.data.messages || [];
      if (!messages.length) return `No emails found for query: "${query}"`;

      const details = await Promise.all(
        messages.map(m =>
          gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"] })
        )
      );

      const results = details.map(r => {
        const headers = r.data.payload?.headers || [];
        const get = name => headers.find(h => h.name === name)?.value || "";
        return { from: get("From"), subject: get("Subject"), date: get("Date"), snippet: r.data.snippet };
      });

      return JSON.stringify(results, null, 2);
    }

    return `Unknown Gmail action: ${action}`;
  } catch (err) {
    return `Gmail error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, makeOAuth2Client, getGoogleCredentials };
