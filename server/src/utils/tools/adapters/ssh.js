const { Client } = require("ssh2");

function getConfig(connector) {
  const auth   = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const config = connector.config     ? JSON.parse(connector.config)     : {};
  return {
    host:       auth.host        || config.host        || "localhost",
    port:       parseInt(auth.port || config.port || "22"),
    username:   auth.username    || config.username    || "root",
    privateKey: auth.privateKey  || config.privateKey  || null,
    passphrase: auth.passphrase  || config.passphrase  || undefined,
    password:   auth.password    || config.password    || undefined,
  };
}

function runCommand(cfg, command, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = "";
    let stderr = "";
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      conn.end();
      if (err) reject(err);
      else resolve({ stdout: output, stderr });
    };

    const timer = setTimeout(() => done(new Error(`Command timed out after ${timeout / 1000}s`)), timeout);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); return done(err); }
        stream
          .on("close", () => { clearTimeout(timer); done(); })
          .on("data",  d => { output += d.toString(); })
          .stderr.on("data", d => { stderr += d.toString(); });
      });
    });

    conn.on("error", err => { clearTimeout(timer); done(err); });

    const connectCfg = { host: cfg.host, port: cfg.port, username: cfg.username };
    if (cfg.privateKey) {
      connectCfg.privateKey = cfg.privateKey;
      if (cfg.passphrase) connectCfg.passphrase = cfg.passphrase;
    } else if (cfg.password) {
      connectCfg.password = cfg.password;
    }
    conn.connect(connectCfg);
  });
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_exec`,
        description: `Run a shell command on the remote server via SSH (${connector.name}). Use for security audits, log inspection, process checks, port scans, disk usage, and system diagnostics.`,
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute on the remote server." },
            timeout: { type: "number", description: "Timeout in seconds (default 30, max 120)." },
          },
          required: ["command"],
        },
      },
    },
  ];
}

function getAnthropicToolDefinitions(connector) {
  return [
    {
      name: `conn_${connector.id}_exec`,
      description: `Run a shell command on the remote server via SSH (${connector.name}). Use for security audits, log inspection, process checks, port scans, disk usage, and system diagnostics.`,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute on the remote server." },
          timeout: { type: "number", description: "Timeout in seconds (default 30, max 120)." },
        },
        required: ["command"],
      },
    },
  ];
}

async function executeTool(action, args, connector) {
  if (action !== "exec") return `Unknown SSH action: ${action}`;

  const cfg = getConfig(connector);
  if (!cfg.privateKey && !cfg.password) return "SSH connector not configured: provide privateKeyPath or password.";

  const { command, timeout } = args;
  if (!command) return "Missing required field: command.";

  const timeoutMs = Math.min((parseInt(timeout) || 30), 120) * 1000;

  try {
    const { stdout, stderr } = await runCommand(cfg, command, timeoutMs);
    const out = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim();
    return out || "(no output)";
  } catch (err) {
    return `SSH error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
