"use strict";
const axios = require("axios");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");

function buildHeaders(creds) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (creds.bearerToken) headers["Authorization"] = `Bearer ${creds.bearerToken}`;
  if (creds.apiKey)      headers[creds.headerName || "X-API-Key"] = creds.apiKey;
  if (creds.username && creds.password)
    headers["Authorization"] = "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  if (creds.headers && typeof creds.headers === "object") Object.assign(headers, creds.headers);
  return headers;
}

function buildParams(creds, extra) {
  const params = { ...(extra || {}) };
  if (creds.queryParamName && creds.apiKey) params[creds.queryParamName] = creds.apiKey;
  return params;
}

function getToolDefinitions(connector) {
  const desc   = (method) => `Perform an HTTP ${method} request against the "${connector.name}" API.`;
  const pathP  = { path:   { type: "string",  description: "URL path (e.g. /users or /generate)" } };
  const qP     = { params: { type: "object",  description: "Query parameters as key-value pairs", additionalProperties: { type: "string" } } };
  const bodyP  = { body:   { type: "object",  description: "JSON request body", additionalProperties: true } };

  return [
    { type: "function", function: { name: `conn_${connector.id}_get`,    description: desc("GET"),    parameters: { type: "object", properties: { ...pathP, ...qP },          required: ["path"] } } },
    { type: "function", function: { name: `conn_${connector.id}_post`,   description: desc("POST"),   parameters: { type: "object", properties: { ...pathP, ...bodyP },        required: ["path", "body"] } } },
    { type: "function", function: { name: `conn_${connector.id}_put`,    description: desc("PUT"),    parameters: { type: "object", properties: { ...pathP, ...bodyP },        required: ["path", "body"] } } },
    { type: "function", function: { name: `conn_${connector.id}_patch`,  description: desc("PATCH"),  parameters: { type: "object", properties: { ...pathP, ...bodyP },        required: ["path", "body"] } } },
    { type: "function", function: { name: `conn_${connector.id}_delete`, description: desc("DELETE"), parameters: { type: "object", properties: { ...pathP, ...qP },          required: ["path"] } } },
  ];
}

function getAnthropicToolDefinitions(connector) {
  return getToolDefinitions(connector).map(t => ({
    name:         t.function.name,
    description:  t.function.description,
    input_schema: t.function.parameters,
  }));
}

async function executeTool(action, args, connector) {
  const cfg   = connector.config     ? JSON.parse(connector.config)     : {};
  const auth  = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const creds = { ...cfg, ...auth };

  const baseUrl = (creds.baseUrl || "").replace(/\/$/, "");
  if (!baseUrl) return "Connector base URL not configured. Add baseUrl to oe-config.json.";

  const headers = buildHeaders(creds);
  const params  = buildParams(creds, args.params);
  const url     = baseUrl + (args.path || "");
  const opts    = { headers, params, timeout: 300000, responseType: "arraybuffer" };

  try {
    let res;
    if (action === "get")    res = await axios.get(url, opts);
    if (action === "post")   res = await axios.post(url,  args.body || {}, opts);
    if (action === "put")    res = await axios.put(url,   args.body || {}, opts);
    if (action === "patch")  res = await axios.patch(url, args.body || {}, opts);
    if (action === "delete") res = await axios.delete(url, opts);
    if (!res) return "Unknown HTTP action.";

    const contentType = (res.headers["content-type"] || "").toLowerCase();

    // Binary response — save audio/video to a temp file and return the path
    if (
      contentType.includes("audio/") ||
      contentType.includes("video/") ||
      contentType.includes("application/octet-stream")
    ) {
      const ext = contentType.includes("audio/mpeg") ? ".mp3"
                : contentType.includes("audio/wav")  ? ".wav"
                : contentType.includes("audio/ogg")  ? ".ogg"
                : contentType.includes("video/mp4")  ? ".mp4"
                : ".bin";
      const tmpFile = path.join(os.tmpdir(), `oe-output-${Date.now()}${ext}`);
      fs.writeFileSync(tmpFile, Buffer.from(res.data));
      return `Audio/video saved to: ${tmpFile}`;
    }

    // JSON or text
    const text = Buffer.from(res.data).toString("utf8");
    try {
      const parsed = JSON.parse(text);

      // OpenAI-style image response with b64_json — save each image to a temp file
      if (Array.isArray(parsed?.data) && parsed.data[0]?.b64_json) {
        const saved = parsed.data.map((item, i) => {
          const tmpFile = path.join(os.tmpdir(), `oe-image-${Date.now()}-${i}.png`);
          fs.writeFileSync(tmpFile, Buffer.from(item.b64_json, "base64"));
          return { ...item, b64_json: undefined, local_path: tmpFile };
        });
        return JSON.stringify({ ...parsed, data: saved }, null, 2).slice(0, 8000);
      }

      return JSON.stringify(parsed, null, 2).slice(0, 8000);
    } catch { return text.slice(0, 8000); }

  } catch (err) {
    if (err.response) {
      const body = Buffer.isBuffer(err.response.data)
        ? Buffer.from(err.response.data).toString("utf8").slice(0, 500)
        : String(err.response.data || "").slice(0, 500);
      return `API error ${err.response.status}: ${body}`;
    }
    return `Request error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
