const { Client } = require("ssh2");

function getConfig(connector) {
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const cfg  = connector.config     ? JSON.parse(connector.config)     : {};
  return {
    host:       auth.host       || cfg.host       || "localhost",
    port:       parseInt(auth.port || cfg.port || "22"),
    username:   auth.username   || cfg.username   || "root",
    password:   auth.password   || cfg.password   || undefined,
    privateKey: auth.privateKey || cfg.privateKey || undefined,
    passphrase: auth.passphrase || cfg.passphrase || undefined,
  };
}

function withSftp(cfg, fn) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        Promise.resolve(fn(sftp))
          .then(r => { conn.end(); resolve(r); })
          .catch(e => { conn.end(); reject(e); });
      });
    });
    conn.on("error", reject);
    const connectCfg = { host: cfg.host, port: cfg.port, username: cfg.username };
    if (cfg.privateKey) { connectCfg.privateKey = cfg.privateKey; if (cfg.passphrase) connectCfg.passphrase = cfg.passphrase; }
    else if (cfg.password) connectCfg.password = cfg.password;
    conn.connect(connectCfg);
  });
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_list`,
        description: `List files and directories on the SFTP server "${connector.name}".`,
        parameters: { type: "object", properties: { path: { type: "string", description: "Remote directory path (default: /)" } }, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_read`,
        description: `Read a text file from the SFTP server "${connector.name}".`,
        parameters: { type: "object", properties: { path: { type: "string", description: "Full remote file path" } }, required: ["path"] },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_write`,
        description: `Write content to a file on the SFTP server "${connector.name}".`,
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_delete`,
        description: `Delete a file on the SFTP server "${connector.name}".`,
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ];
}

function getAnthropicToolDefinitions(connector) {
  return getToolDefinitions(connector).map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

async function executeTool(action, args, connector) {
  const cfg = getConfig(connector);
  if (!cfg.password && !cfg.privateKey) return "SFTP not configured: provide password or privateKey.";

  try {
    if (action === "list") {
      return await withSftp(cfg, sftp => new Promise((res, rej) => {
        sftp.readdir(args.path || "/", (err, list) => {
          if (err) return rej(err);
          res(list.map(f => `${f.longname}`).join("\n"));
        });
      }));
    }
    if (action === "read") {
      return await withSftp(cfg, sftp => new Promise((res, rej) => {
        const chunks = [];
        const stream = sftp.createReadStream(args.path);
        stream.on("data", d => chunks.push(d));
        stream.on("end", () => res(Buffer.concat(chunks).toString("utf8").slice(0, 8000)));
        stream.on("error", rej);
      }));
    }
    if (action === "write") {
      return await withSftp(cfg, sftp => new Promise((res, rej) => {
        const stream = sftp.createWriteStream(args.path);
        stream.on("close", () => res(`Written: ${args.path}`));
        stream.on("error", rej);
        stream.end(args.content || "");
      }));
    }
    if (action === "delete") {
      return await withSftp(cfg, sftp => new Promise((res, rej) => {
        sftp.unlink(args.path, err => err ? rej(err) : res(`Deleted: ${args.path}`));
      }));
    }
    return `Unknown SFTP action: ${action}`;
  } catch (err) {
    return `SFTP error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
