const DEFAULT_OPS = ["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN"];

function getAllowedOps(connector) {
  try {
    const cfg = connector.config ? JSON.parse(connector.config) : {};
    return cfg.allowedOps?.length ? cfg.allowedOps : DEFAULT_OPS;
  } catch { return DEFAULT_OPS; }
}

function isSafe(sql, allowedOps) {
  const pattern = new RegExp(`^\\s*(${allowedOps.join("|")})\\s`, "i");
  return pattern.test(sql.trim());
}

function getToolDefinitions(connector) {
  const ops = getAllowedOps(connector);
  return [{
    type: "function",
    function: {
      name: `conn_${connector.id}_query`,
      description: `Execute a SQL statement on the "${connector.name}" ${connector.type} database. Allowed operations: ${ops.join(", ")}.`,
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: `SQL statement using allowed operations: ${ops.join(", ")}.` }
        },
        required: ["sql"]
      }
    }
  }];
}

// Anthropic tool_use format
function getAnthropicToolDefinitions(connector) {
  const ops = getAllowedOps(connector);
  return [{
    name: `conn_${connector.id}_query`,
    description: `Execute a SQL statement on the "${connector.name}" ${connector.type} database. Allowed operations: ${ops.join(", ")}.`,
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: `SQL statement using allowed operations: ${ops.join(", ")}.` }
      },
      required: ["sql"]
    }
  }];
}

function applySafeLimit(sql, dialect, maxRows) {
  const n     = maxRows > 0 ? maxRows : 100;
  const clean = sql.replace(/;+\s*$/, "").trim();
  if (/\bLIMIT\b/i.test(clean)) return clean;
  if (/\bTOP\s+\d+\b/i.test(clean)) return clean;
  if (/FETCH\s+FIRST\b/i.test(clean)) return clean;
  if (/\bROWNUM\b/i.test(clean)) return clean;
  if (/^\s*SELECT\s+(?:COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(clean)) return clean;
  if (dialect === "mssql")  return clean.replace(/^(\s*SELECT\s+)/i, `$1TOP ${n} `);
  if (dialect === "oracle") return clean + `\nFETCH FIRST ${n} ROWS ONLY`;
  return clean + ` LIMIT ${n}`;
}

async function executeTool(action, args, connector) {
  if (action !== "query") return "Unknown action.";

  const sql        = (args.sql || "").trim();
  const allowedOps = getAllowedOps(connector);
  if (!sql) return "No SQL provided.";
  if (!isSafe(sql, allowedOps)) return `Operation not allowed. Permitted: ${allowedOps.join(", ")}.`;

  const isSelect = /^\s*SELECT\b/i.test(sql);
  const cfg  = connector.config   ? JSON.parse(connector.config)   : {};
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const maxRows = cfg.maxRows || 100;

  try {
    if (connector.type === "postgresql") {
      const { Pool } = require("pg");
      const pool = new Pool({
        connectionString: cfg.url || undefined,
        host:     cfg.host     || auth.host     || "localhost",
        port:     parseInt(cfg.port || auth.port || "5432"),
        database: cfg.database || auth.database || undefined,
        user:     auth.username || auth.user || cfg.user || undefined,
        password: auth.password || cfg.password || undefined,
        ssl:      cfg.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 10000,
        query_timeout: 30000,
      });
      const result = await pool.query(isSelect ? applySafeLimit(sql, "postgresql", maxRows) : sql);
      await pool.end();
      if (!result.rows.length) return "Query returned no results.";
      return JSON.stringify(result.rows, null, 2);
    }

    if (connector.type === "mysql") {
      const mysql = require("mysql2/promise");
      const conn = await mysql.createConnection({
        host:     cfg.host     || auth.host     || "localhost",
        port:     parseInt(cfg.port || auth.port || "3306"),
        database: cfg.database || auth.database || undefined,
        user:     auth.username || auth.user || cfg.user || undefined,
        password: auth.password || cfg.password || undefined,
        ssl:      cfg.ssl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 10000,
      });
      const [rows] = await conn.execute(isSelect ? applySafeLimit(sql, "mysql", maxRows) : sql);
      await conn.end();
      if (!rows.length) return "Query returned no results.";
      return JSON.stringify(rows, null, 2);
    }

    if (connector.type === "mssql") {
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
        connectionTimeout: 10000,
        requestTimeout:    30000,
      });
      const result = await pool.request().query(isSelect ? applySafeLimit(sql, "mssql", maxRows) : sql);
      await pool.close();
      if (!result.recordset?.length) return "Query returned no results.";
      return JSON.stringify(result.recordset, null, 2);
    }

    if (connector.type === "oracle") {
      const oracledb = require("oracledb");
      oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
      const connectString = cfg.connectString ||
        `${cfg.host || "localhost"}:${cfg.port || "1521"}/${cfg.serviceName || cfg.sid || "ORCL"}`;
      const conn = await oracledb.getConnection({
        user:          auth.username || undefined,
        password:      auth.password || undefined,
        connectString,
      });
      const result = await conn.execute(isSelect ? applySafeLimit(sql, "oracle", maxRows) : sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      await conn.close();
      if (!result.rows?.length) return "Query returned no results.";
      return JSON.stringify(result.rows, null, 2);
    }

    if (connector.type === "cockroachdb") {
      const { Pool } = require("pg");
      const pool = new Pool({
        host:     cfg.host     || "localhost",
        port:     parseInt(cfg.port || "26257"),
        database: cfg.database || "defaultdb",
        user:     auth.username || undefined,
        password: auth.password || undefined,
        ssl:      cfg.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 10000,
      });
      const result = await pool.query(isSelect ? applySafeLimit(sql, "postgresql", maxRows) : sql);
      await pool.end();
      if (!result.rows.length) return "Query returned no results.";
      return JSON.stringify(result.rows, null, 2);
    }

    if (connector.type === "sqlite") {
      const Database = require("better-sqlite3");
      const db = new Database(cfg.filename || ":memory:", { readonly: isSelect });
      const stmt = db.prepare(isSelect ? applySafeLimit(sql, "sqlite", maxRows) : sql);
      const rows = isSelect ? stmt.all() : [stmt.run()];
      db.close();
      if (!rows.length) return "Query returned no results.";
      return JSON.stringify(rows, null, 2);
    }

    if (connector.type === "snowflake") {
      const snowflake = require("snowflake-sdk");
      const conn = await new Promise((resolve, reject) => {
        const c = snowflake.createConnection({
          account:   cfg.account,
          username:  auth.username,
          password:  auth.password,
          database:  cfg.database,
          schema:    cfg.schema   || "PUBLIC",
          warehouse: cfg.warehouse,
          role:      cfg.role     || undefined,
        });
        c.connect(err => err ? reject(err) : resolve(c));
      });
      const rows = await new Promise((resolve, reject) => {
        conn.execute({ sqlText: isSelect ? applySafeLimit(sql, "snowflake", maxRows) : sql,
          complete: (err, _stmt, rows) => err ? reject(err) : resolve(rows || []) });
      });
      conn.destroy(() => {});
      if (!rows.length) return "Query returned no results.";
      return JSON.stringify(rows, null, 2);
    }

    if (connector.type === "bigquery") {
      const { BigQuery } = require("@google-cloud/bigquery");
      const credentials = auth.keyFileJson ? JSON.parse(auth.keyFileJson) : undefined;
      const bq = new BigQuery({ projectId: cfg.projectId, credentials });
      const [rows] = await bq.query({ query: isSelect ? applySafeLimit(sql, "bigquery", maxRows) : sql,
        defaultDataset: cfg.dataset ? { datasetId: cfg.dataset, projectId: cfg.projectId } : undefined });
      if (!rows.length) return "Query returned no results.";
      return JSON.stringify(rows, null, 2);
    }

    return `Unsupported database type: ${connector.type}`;
  } catch (err) {
    return `Database error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
