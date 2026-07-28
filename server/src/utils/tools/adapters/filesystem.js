"use strict";
const fs   = require("fs");
const path = require("path");

function cfg(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : connector;
}

// Prevent directory traversal attacks
function safePath(basePath, filePath) {
  const resolved = path.resolve(basePath, filePath);
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new Error(`Access denied: path is outside basePath (${basePath})`);
  }
  return resolved;
}

const TOOLS = c => [
  {
    action: "list_dir",
    desc: `List files and folders in a directory on the local filesystem via ${c.name}.`,
    params: {
      dir: { type: "string", description: "Directory path relative to basePath. Use '.' for root." },
    },
    required: ["dir"],
  },
  {
    action: "read_file",
    desc: `Read the contents of a file on the local filesystem via ${c.name}.`,
    params: {
      file: { type: "string", description: "File path relative to basePath." },
    },
    required: ["file"],
  },
  {
    action: "write_file",
    desc: `Write or overwrite a file on the local filesystem via ${c.name}.`,
    params: {
      file:    { type: "string", description: "File path relative to basePath." },
      content: { type: "string", description: "Content to write." },
    },
    required: ["file", "content"],
  },
  {
    action: "append_file",
    desc: `Append content to an existing file on the local filesystem via ${c.name}.`,
    params: {
      file:    { type: "string", description: "File path relative to basePath." },
      content: { type: "string", description: "Content to append." },
    },
    required: ["file", "content"],
  },
  {
    action: "delete_file",
    desc: `Delete a file on the local filesystem via ${c.name}.`,
    params: {
      file: { type: "string", description: "File path relative to basePath." },
    },
    required: ["file"],
  },
  {
    action: "make_dir",
    desc: `Create a directory (and any missing parents) on the local filesystem via ${c.name}.`,
    params: {
      dir: { type: "string", description: "Directory path relative to basePath." },
    },
    required: ["dir"],
  },
  {
    action: "file_info",
    desc: `Get metadata (size, modified date, type) of a file or directory via ${c.name}.`,
    params: {
      file: { type: "string", description: "File or directory path relative to basePath." },
    },
    required: ["file"],
  },
  {
    action: "search_files",
    desc: `Search for files by name pattern recursively via ${c.name}.`,
    params: {
      pattern: { type: "string", description: "Filename pattern to match (e.g. '*.js', 'README*')." },
      dir:     { type: "string", description: "Directory to search in relative to basePath. Use '.' for all." },
    },
    required: ["pattern", "dir"],
  },
];

function getToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({
    type: "function",
    function: {
      name:        `conn_${connector.id}_${t.action}`,
      description: t.desc,
      parameters:  { type: "object", properties: t.params, required: t.required },
    },
  }));
}

function getAnthropicToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({
    name:         `conn_${connector.id}_${t.action}`,
    description:  t.desc,
    input_schema: { type: "object", properties: t.params, required: t.required },
  }));
}

function matchPattern(filename, pattern) {
  const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return regex.test(filename);
}

function searchRecursive(dir, pattern, results = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (matchPattern(entry.name, pattern)) results.push(fullPath);
      if (entry.isDirectory()) searchRecursive(fullPath, pattern, results);
    }
  } catch {}
  return results;
}

async function executeTool(action, args, connector) {
  const { basePath } = cfg(connector);
  if (!basePath) return "filesystem connector requires a basePath in config.";

  try {
    if (action === "list_dir") {
      const target = safePath(basePath, args.dir || ".");
      const entries = fs.readdirSync(target, { withFileTypes: true });
      if (entries.length === 0) return "Directory is empty.";
      return entries.map(e => `${e.isDirectory() ? "[dir] " : "[file]"} ${e.name}`).join("\n");
    }

    if (action === "read_file") {
      const target = safePath(basePath, args.file);
      if (!fs.existsSync(target)) return `File not found: ${args.file}`;
      const content = fs.readFileSync(target, "utf8");
      return content.length > 50000 ? content.slice(0, 50000) + "\n\n[truncated — file too large]" : content;
    }

    if (action === "write_file") {
      const target = safePath(basePath, args.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, args.content, "utf8");
      return `Written: ${args.file}`;
    }

    if (action === "append_file") {
      const target = safePath(basePath, args.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, args.content, "utf8");
      return `Appended to: ${args.file}`;
    }

    if (action === "delete_file") {
      const target = safePath(basePath, args.file);
      if (!fs.existsSync(target)) return `File not found: ${args.file}`;
      fs.unlinkSync(target);
      return `Deleted: ${args.file}`;
    }

    if (action === "make_dir") {
      const target = safePath(basePath, args.dir);
      fs.mkdirSync(target, { recursive: true });
      return `Directory created: ${args.dir}`;
    }

    if (action === "file_info") {
      const target = safePath(basePath, args.file);
      if (!fs.existsSync(target)) return `Not found: ${args.file}`;
      const stat = fs.statSync(target);
      return JSON.stringify({
        path:     args.file,
        type:     stat.isDirectory() ? "directory" : "file",
        size:     `${(stat.size / 1024).toFixed(1)} KB`,
        modified: stat.mtime.toISOString(),
        created:  stat.birthtime.toISOString(),
      }, null, 2);
    }

    if (action === "search_files") {
      const target = safePath(basePath, args.dir || ".");
      const results = searchRecursive(target, args.pattern);
      if (results.length === 0) return `No files matching "${args.pattern}" found.`;
      return results.map(r => path.relative(basePath, r)).join("\n");
    }

    return `Unknown action: ${action}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
