const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");

function getTransport(auth) {
  const port = parseInt(auth.smtpPort || "465");
  return nodemailer.createTransport({
    host:   auth.smtpHost || "smtppro.zoho.in",
    port,
    secure: port === 465,
    auth: {
      user: auth.email,
      pass: auth.appPassword,
    },
  });
}

function getImapClient(auth) {
  return new ImapFlow({
    host:   auth.imapHost || "imappro.zoho.in",
    port:   parseInt(auth.imapPort || "993"),
    secure: true,
    auth: {
      user: auth.email,
      pass: auth.appPassword,
    },
    logger: false,
  });
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_send_email`,
        description: `Send an outbound email via Zoho Mail (${connector.name}). Use for sales outreach, follow-ups, or notifications.`,
        parameters: {
          type: "object",
          properties: {
            to:      { type: "string", description: "Recipient email address (or comma-separated list)." },
            subject: { type: "string", description: "Email subject line." },
            body:    { type: "string", description: "Email body (plain text or HTML)." },
            cc:      { type: "string", description: "CC email addresses (optional, comma-separated)." },
            replyTo: { type: "string", description: "Reply-to email address (optional)." },
          },
          required: ["to", "subject", "body"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_search_emails`,
        description: `Search emails in a Zoho Mail inbox folder. Use to find replies, bounces, or messages from specific senders.`,
        parameters: {
          type: "object",
          properties: {
            folder:      { type: "string",  description: "Mailbox folder to search. Default: INBOX." },
            from:        { type: "string",  description: "Filter by sender email address (optional)." },
            subject:     { type: "string",  description: "Filter by subject keyword (optional)." },
            since_days:  { type: "number",  description: "Only return emails from the last N days. Default: 7." },
            limit:       { type: "number",  description: "Max emails to return. Default: 50." },
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_read_email`,
        description: `Read the full body of a specific email by its UID.`,
        parameters: {
          type: "object",
          properties: {
            uid:    { type: "string", description: "Email UID returned from search_emails." },
            folder: { type: "string", description: "Mailbox folder. Default: INBOX." },
          },
          required: ["uid"]
        }
      }
    }
  ];
}

function getAnthropicToolDefinitions(connector) {
  return [
    {
      name: `conn_${connector.id}_send_email`,
      description: `Send an outbound email via Zoho Mail (${connector.name}). Use for sales outreach, follow-ups, or notifications.`,
      input_schema: {
        type: "object",
        properties: {
          to:      { type: "string", description: "Recipient email address (or comma-separated list)." },
          subject: { type: "string", description: "Email subject line." },
          body:    { type: "string", description: "Email body (plain text or HTML)." },
          cc:      { type: "string", description: "CC email addresses (optional, comma-separated)." },
          replyTo: { type: "string", description: "Reply-to email address (optional)." },
        },
        required: ["to", "subject", "body"]
      }
    },
    {
      name: `conn_${connector.id}_search_emails`,
      description: `Search emails in a Zoho Mail inbox folder. Use to find replies, bounces, or messages from specific senders.`,
      input_schema: {
        type: "object",
        properties: {
          folder:      { type: "string", description: "Mailbox folder to search. Default: INBOX." },
          from:        { type: "string", description: "Filter by sender email address (optional)." },
          subject:     { type: "string", description: "Filter by subject keyword (optional)." },
          since_days:  { type: "number", description: "Only return emails from the last N days. Default: 7." },
          limit:       { type: "number", description: "Max emails to return. Default: 50." },
        },
        required: []
      }
    },
    {
      name: `conn_${connector.id}_read_email`,
      description: `Read the full body of a specific email by its UID.`,
      input_schema: {
        type: "object",
        properties: {
          uid:    { type: "string", description: "Email UID returned from search_emails." },
          folder: { type: "string", description: "Mailbox folder. Default: INBOX." },
        },
        required: ["uid"]
      }
    }
  ];
}

async function executeTool(action, args, connector) {
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};

  if (!auth.email || !auth.appPassword) {
    return "Zoho Mail not configured. Please add your email and app password in the connector settings.";
  }

  if (action === "send_email") {
    const { to, subject, body, cc, replyTo } = args;
    if (!to || !subject || !body) return "Missing required fields: to, subject, body.";

    const isHtml = /<[a-z][\s\S]*>/i.test(body);
    const mail = {
      from:    auth.fromName ? `${auth.fromName} <${auth.email}>` : auth.email,
      to,
      subject,
      ...(isHtml ? { html: body } : { text: body }),
      ...(cc      ? { cc }      : {}),
      ...(replyTo ? { replyTo } : {}),
    };

    try {
      const transport = getTransport(auth);
      await transport.sendMail(mail);
      return `Email sent to ${to} with subject "${subject}".`;
    } catch (err) {
      return `Zoho Mail error: ${err.message}`;
    }
  }

  if (action === "search_emails") {
    const folder    = args.folder     || "INBOX";
    const sinceDays = args.since_days || 7;
    const limit     = args.limit      || 50;

    const since = new Date();
    since.setDate(since.getDate() - sinceDays);

    const client = getImapClient(auth);
    try {
      await client.connect();
      await client.mailboxOpen(folder);

      const searchCriteria = { since };
      if (args.from)    searchCriteria.from    = args.from;
      if (args.subject) searchCriteria.subject = args.subject;

      const messages = [];
      for await (const msg of client.fetch(searchCriteria, {
        uid: true, envelope: true, bodyStructure: true, size: true
      })) {
        messages.push({
          uid:     String(msg.uid),
          from:    msg.envelope.from?.[0]?.address || "",
          fromName:msg.envelope.from?.[0]?.name    || "",
          subject: msg.envelope.subject || "(no subject)",
          date:    msg.envelope.date?.toISOString() || "",
          size:    msg.size,
        });
        if (messages.length >= limit) break;
      }

      await client.logout();
      if (messages.length === 0) return `No emails found in ${folder} matching the criteria.`;
      return JSON.stringify(messages, null, 2);
    } catch (err) {
      try { await client.logout(); } catch {}
      return `IMAP search error: ${err.message}`;
    }
  }

  if (action === "read_email") {
    const folder = args.folder || "INBOX";
    const uid    = args.uid;
    if (!uid) return "Missing required field: uid.";

    const client = getImapClient(auth);
    try {
      await client.connect();
      await client.mailboxOpen(folder);

      let result = null;
      for await (const msg of client.fetch({ uid: parseInt(uid) }, {
        uid: true, envelope: true, bodyParts: ["TEXT", "1", "1.1", "2"]
      })) {
        const parts = msg.bodyParts;
        let body = "";
        for (const [, content] of parts) {
          if (content) body += content.toString("utf8");
        }
        result = {
          uid:     String(msg.uid),
          from:    msg.envelope.from?.[0]?.address || "",
          fromName:msg.envelope.from?.[0]?.name    || "",
          subject: msg.envelope.subject || "(no subject)",
          date:    msg.envelope.date?.toISOString() || "",
          body:    body.slice(0, 3000),
        };
        break;
      }

      await client.logout();
      if (!result) return `Email with UID ${uid} not found.`;
      return JSON.stringify(result, null, 2);
    } catch (err) {
      try { await client.logout(); } catch {}
      return `IMAP read error: ${err.message}`;
    }
  }

  return `Unknown Zoho Mail action: ${action}`;
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
