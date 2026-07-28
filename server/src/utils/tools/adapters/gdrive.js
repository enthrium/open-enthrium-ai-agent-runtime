const { google } = require("googleapis");
const { makeOAuth2Client } = require("./gmail");

async function buildDriveClient(authConfig, db, workspaceId) {
  const oauth2 = await makeOAuth2Client(db, workspaceId, "/api/oauth/gmail/callback", {
    clientId:     authConfig.clientId,
    clientSecret: authConfig.clientSecret,
  });
  oauth2.setCredentials({
    access_token:  authConfig.accessToken,
    refresh_token: authConfig.refreshToken,
    expiry_date:   authConfig.expiresAt,
  });
  return google.drive({ version: "v3", auth: oauth2 });
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_list_files`,
        description: `List files in the connected Google Drive (${connector.name}). Use to find files by name or type.`,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query e.g. 'name contains apollo' or 'mimeType=text/csv'" },
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_read_file`,
        description: `Download and read a CSV or Excel file from Google Drive (${connector.name}). Returns rows as JSON. Use to read prospect lists, data exports, etc.`,
        parameters: {
          type: "object",
          properties: {
            fileId:   { type: "string", description: "Google Drive file ID (from list_files)." },
            fileName: { type: "string", description: "File name to search for if fileId is unknown." },
            limit:    { type: "number", description: "Max rows to return (default 100)." },
            offset:   { type: "number", description: "Skip first N rows — use for pagination." },
          },
          required: []
        }
      }
    }
    ,
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_write_file`,
        description: `Update an existing CSV or text file in Google Drive (${connector.name}). Use after reading and modifying rows to write the updated data back.`,
        parameters: {
          type: "object",
          properties: {
            fileId:   { type: "string",  description: "Google Drive file ID to overwrite." },
            fileName: { type: "string",  description: "File name to search for if fileId is unknown." },
            rows:     { type: "array",   description: "Array of row objects — the full updated dataset to write back.", items: { type: "object" } },
          },
          required: ["rows"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_update_rows`,
        description: `Partially update rows in a CSV file in Google Drive (${connector.name}) without reading the whole file. Finds rows where matchColumn equals one of matchValues and sets setColumn to setValue. All other rows are preserved unchanged. Use this instead of write_file when updating a small number of rows in a large file.`,
        parameters: {
          type: "object",
          properties: {
            fileId:      { type: "string", description: "Google Drive file ID." },
            fileName:    { type: "string", description: "File name to search for if fileId is unknown." },
            matchColumn: { type: "string", description: "Column name to match against (e.g. 'Email')." },
            matchValues: { type: "array",  description: "List of values to match in matchColumn (e.g. list of email addresses).", items: { type: "string" } },
            setColumn:   { type: "string", description: "Column name to update (e.g. 'First Email Sent')." },
            setValue:    { type: "string", description: "Value to set in setColumn for matched rows (e.g. 'yes')." },
          },
          required: ["matchColumn", "matchValues", "setColumn", "setValue"]
        }
      }
    }
  ];
}

function getAnthropicToolDefinitions(connector) {
  return [
    {
      name: `conn_${connector.id}_list_files`,
      description: `List files in the connected Google Drive (${connector.name}).`,
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query e.g. 'name contains apollo'" },
        },
        required: []
      }
    },
    {
      name: `conn_${connector.id}_read_file`,
      description: `Download and read a CSV or Excel file from Google Drive (${connector.name}). Returns rows as JSON.`,
      input_schema: {
        type: "object",
        properties: {
          fileId:   { type: "string", description: "Google Drive file ID (from list_files)." },
          fileName: { type: "string", description: "File name to search for if fileId is unknown." },
          limit:    { type: "number", description: "Max rows to return (default 100)." },
          offset:   { type: "number", description: "Skip first N rows — use for pagination." },
        },
        required: []
      }
    },
    {
      name: `conn_${connector.id}_write_file`,
      description: `Update an existing CSV file in Google Drive (${connector.name}). Use after modifying rows to write the updated data back.`,
      input_schema: {
        type: "object",
        properties: {
          fileId:   { type: "string", description: "Google Drive file ID to overwrite." },
          fileName: { type: "string", description: "File name to search for if fileId is unknown." },
          rows:     { type: "array",  description: "Full updated array of row objects to write back.", items: { type: "object" } },
        },
        required: ["rows"]
      }
    },
    {
      name: `conn_${connector.id}_update_rows`,
      description: `Partially update rows in a CSV file in Google Drive (${connector.name}) without reading the whole file. Finds rows where matchColumn equals one of matchValues and sets setColumn to setValue. All other rows are preserved. Use this instead of write_file when updating a small number of rows in a large file.`,
      input_schema: {
        type: "object",
        properties: {
          fileId:      { type: "string", description: "Google Drive file ID." },
          fileName:    { type: "string", description: "File name to search for if fileId is unknown." },
          matchColumn: { type: "string", description: "Column name to match against (e.g. 'Email')." },
          matchValues: { type: "array",  description: "List of values to match (e.g. list of email addresses).", items: { type: "string" } },
          setColumn:   { type: "string", description: "Column name to update (e.g. 'First Email Sent')." },
          setValue:    { type: "string", description: "Value to set for matched rows (e.g. 'yes')." },
        },
        required: ["matchColumn", "matchValues", "setColumn", "setValue"]
      }
    }
  ];
}

function rowsToCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape  = val => {
    const s = String(val ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map(row => headers.map(h => escape(row[h])).join(","))].join("\n");
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map(line => {
    const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) || [];
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (vals[i] || "").replace(/^"|"$/g, "").trim();
    });
    return row;
  });
}

async function executeTool(action, args, connector, db) {
  const authConfig = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  if (!authConfig.refreshToken) return "Google Drive not connected. Please reconnect via the Integrations tab.";

  try {
    const drive = await buildDriveClient(authConfig, db, connector.workspaceId);

    if (action === "list_files") {
      const q = args.query
        ? `${args.query} and trashed=false`
        : "trashed=false";
      const res = await drive.files.list({
        q,
        pageSize: 20,
        fields: "files(id, name, mimeType, size, modifiedTime)",
      });
      const files = res.data.files || [];
      if (!files.length) return "No files found.";
      return JSON.stringify(files.map(f => ({
        id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime
      })), null, 2);
    }

    if (action === "read_file") {
      let fileId   = args.fileId;
      let mimeType = "";

      if (!fileId && args.fileName) {
        const res = await drive.files.list({
          q: `name contains '${args.fileName}' and trashed=false`,
          pageSize: 5,
          fields: "files(id, name, mimeType)",
        });
        const files = res.data.files || [];
        if (!files.length) return `No file found matching "${args.fileName}".`;
        fileId   = files[0].id;
        mimeType = files[0].mimeType;
      }

      if (!fileId) return "Provide fileId or fileName.";

      if (!mimeType) {
        const meta = await drive.files.get({ fileId, fields: "mimeType" });
        mimeType = meta.data.mimeType;
      }

      let rows = [];

      const isExcel = mimeType.includes("spreadsheetml") || mimeType.includes("excel") || mimeType.includes("openxmlformats");
      const isGSheet = mimeType.includes("google-apps.spreadsheet");

      if (isGSheet) {
        // Export Google Sheet as CSV
        const res = await drive.files.export({ fileId, mimeType: "text/csv" }, { responseType: "text" });
        rows = parseCSV(res.data);
      } else if (isExcel) {
        // Download Excel file and parse with xlsx
        const XLSX = require("xlsx");
        const res  = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
        const wb   = XLSX.read(res.data, { type: "buffer" });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      } else {
        // Assume CSV
        const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
        rows = parseCSV(res.data);
      }

      const limit  = args.limit  || 100;
      const offset = args.offset || 0;
      const page   = rows.slice(offset, offset + limit);

      return JSON.stringify({ total: rows.length, offset, returned: page.length, rows: page }, null, 2);
    }

    if (action === "write_file") {
      let fileId = args.fileId;

      if (!fileId && args.fileName) {
        const res = await drive.files.list({
          q: `name contains '${args.fileName}' and trashed=false`,
          pageSize: 5,
          fields: "files(id, name, mimeType)",
        });
        const files = res.data.files || [];
        if (!files.length) return `No file found matching "${args.fileName}".`;
        fileId = files[0].id;
      }

      if (!fileId) return "Provide fileId or fileName to write.";

      const csvContent = rowsToCSV(args.rows || []);

      await drive.files.update({
        fileId,
        media: { mimeType: "text/csv", body: csvContent },
      });

      return `File updated successfully. ${(args.rows || []).length} rows written.`;
    }

    if (action === "update_rows") {
      let fileId = args.fileId;
      let mimeType = "";

      if (!fileId && args.fileName) {
        const res = await drive.files.list({
          q: `name contains '${args.fileName}' and trashed=false`,
          pageSize: 5, fields: "files(id, name, mimeType)",
        });
        const files = res.data.files || [];
        if (!files.length) return `No file found matching "${args.fileName}".`;
        fileId   = files[0].id;
        mimeType = files[0].mimeType;
      }
      if (!fileId) return "Provide fileId or fileName for update_rows.";

      if (!mimeType) {
        const meta = await drive.files.get({ fileId, fields: "mimeType" });
        mimeType = meta.data.mimeType;
      }

      // Read full file
      let rows = [];
      const isGSheet = mimeType.includes("google-apps.spreadsheet");
      if (isGSheet) {
        const res = await drive.files.export({ fileId, mimeType: "text/csv" }, { responseType: "text" });
        rows = parseCSV(res.data);
      } else {
        const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
        rows = parseCSV(res.data);
      }

      const matchSet = new Set((args.matchValues || []).map(v => String(v).trim().toLowerCase()));
      let updatedCount = 0;
      for (const row of rows) {
        const cellVal = String(row[args.matchColumn] ?? "").trim().toLowerCase();
        if (matchSet.has(cellVal)) {
          row[args.setColumn] = args.setValue;
          updatedCount++;
        }
      }

      const csvContent = rowsToCSV(rows);
      await drive.files.update({ fileId, media: { mimeType: "text/csv", body: csvContent } });
      return `Updated ${updatedCount} row(s): set "${args.setColumn}" = "${args.setValue}" where "${args.matchColumn}" matched. Total rows preserved: ${rows.length}.`;
    }

    return `Unknown Google Drive action: ${action}`;
  } catch (err) {
    return `Google Drive error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, buildDriveClient };
