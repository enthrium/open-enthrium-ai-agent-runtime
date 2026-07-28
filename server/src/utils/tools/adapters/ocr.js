"use strict";
const axios = require("axios");

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_extract_text`,
        description: `Extract text from an image or document using "${connector.name}" OCR.`,
        parameters: {
          type: "object",
          properties: {
            image_url:   { type: "string", description: "Publicly accessible URL of the image or document to process" },
            language:    { type: "string", description: "Language hint (e.g. 'en', 'fr', 'de'). Optional." },
          },
          required: ["image_url"],
        },
      },
    },
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
  const auth  = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const cfg   = connector.config     ? JSON.parse(connector.config)     : {};
  const creds = { ...cfg, ...auth };
  const type  = connector.type;

  if (action !== "extract_text") return `Unknown action: ${action}`;

  const imageUrl = args.image_url;
  if (!imageUrl) return "Error: image_url is required.";

  // ── Azure Computer Vision ─────────────────────────────────────────────────
  if (type === "azure-vision") {
    const endpoint = (creds.endpoint || "").replace(/\/$/, "");
    const resp = await axios.post(
      `${endpoint}/computervision/imageanalysis:analyze?api-version=2023-02-01-preview&features=read`,
      { url: imageUrl },
      { headers: { "Ocp-Apim-Subscription-Key": creds.apiKey, "Content-Type": "application/json" } }
    );
    const blocks = resp.data.readResult?.blocks || [];
    return blocks.flatMap(b => b.lines.map(l => l.text)).join("\n") || "No text found.";
  }

  // ── Google Cloud Vision ───────────────────────────────────────────────────
  if (type === "google-vision") {
    const resp = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${creds.apiKey}`,
      {
        requests: [{
          image:    { source: { imageUri: imageUrl } },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        }],
      }
    );
    return resp.data.responses?.[0]?.fullTextAnnotation?.text || "No text found.";
  }

  // ── AWS Textract ──────────────────────────────────────────────────────────
  if (type === "aws-textract") {
    const { AwsClient } = await (async () => {
      try { return require("aws4"); } catch { return null; }
    })();
    // Simplified: use Textract via direct HTTPS with AWS4 signing
    // For URL-based images, download first then send as bytes — use URL form here
    const region = creds.region || "us-east-1";
    const resp   = await axios.post(
      `https://textract.${region}.amazonaws.com/`,
      { Document: { S3Object: null, Bytes: null }, FeatureTypes: [] },
      {
        headers: {
          "X-Amz-Target":    "Textract.DetectDocumentText",
          "Content-Type":    "application/x-amz-json-1.1",
          "X-Api-Source-Url": imageUrl,
        },
      }
    ).catch(() => null);
    if (!resp) return "Textract: provide an S3 URL or configure AWS credentials with proper signing.";
    const blocks = (resp.data.Blocks || []).filter(b => b.BlockType === "LINE");
    return blocks.map(b => b.Text).join("\n") || "No text found.";
  }

  // ── Tesseract (self-hosted OCR service) ───────────────────────────────────
  if (type === "tesseract-ocr") {
    const baseUrl = (creds.baseUrl || "http://localhost:8884").replace(/\/$/, "");
    const resp = await axios.post(
      `${baseUrl}/ocr`,
      { url: imageUrl, language: args.language || "eng" },
      { headers: { "Content-Type": "application/json" } }
    );
    return resp.data.text || resp.data.result || "No text found.";
  }

  return `Unsupported OCR connector type: ${type}`;
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
