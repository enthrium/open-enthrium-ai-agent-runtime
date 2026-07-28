"use strict";
const axios = require("axios");
const fs    = require("fs");
const os    = require("os");
const path  = require("path");

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_generate_image`,
        description: `Generate an image from a text prompt using "${connector.name}". Returns the image URL.`,
        parameters: {
          type: "object",
          properties: {
            prompt:       { type: "string", description: "Detailed description of the image to generate. Include all style, mood, and visual direction here (e.g. minimalist, bold, photorealistic)." },
            size:         { type: "string", description: "Image size: '1024x1024', '1792x1024', or '1024x1792'" },
            dalle_style:  { type: "string", description: "OpenAI DALL-E rendering style only: 'vivid' (hyper-real) or 'natural' (realistic). Do NOT use brand style words here — put those in the prompt." },
            n:            { type: "number", description: "Number of images to generate (default 1, max 4)" },
          },
          required: ["prompt"],
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

  if (action !== "generate_image") return `Unknown action: ${action}`;

  const prompt = args.prompt || "";
  const n      = Math.min(args.n || 1, 4);
  const size   = args.size  || "1024x1024";

  // ── OpenAI DALL-E / GPT-Image ─────────────────────────────────────────────
  if (type === "openai-image") {
    const model      = creds.model || "gpt-image-1";
    const dalleStyle = ["vivid", "natural"].includes(args.dalle_style) ? args.dalle_style : "vivid";
    const body = { model, prompt, n: model === "dall-e-3" ? 1 : n, size };
    let resp;
    try {
      resp = await axios.post(
        "https://api.openai.com/v1/images/generations",
        body,
        { headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" } }
      );
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.response?.data || err.message;
      return `OpenAI image error (${err.response?.status}): ${typeof detail === "object" ? JSON.stringify(detail) : detail}`;
    }
    const results = [];
    for (const d of (resp.data.data || [])) {
      if (d.url) {
        results.push(`Image URL: ${d.url}`);
      } else if (d.b64_json) {
        const outFile = path.join(os.tmpdir(), `oe-image-${Date.now()}.png`);
        fs.writeFileSync(outFile, Buffer.from(d.b64_json, "base64"));
        results.push(`Image saved to: ${outFile}`);
      }
    }
    return results.length ? results.join("\n") : "Image generated but no URL or data returned.";
  }

  // ── FLUX (via Together AI) ────────────────────────────────────────────────
  if (type === "flux") {
    const model = creds.model || "black-forest-labs/FLUX.1-schnell-Free";
    const resp  = await axios.post(
      "https://api.together.xyz/v1/images/generations",
      { model, prompt, n, width: 1024, height: 1024, steps: 4 },
      { headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" } }
    );
    const urls = (resp.data.data || []).map(d => d.url || d.b64_json);
    return urls.length === 1 ? `Image generated: ${urls[0]}` : urls.map((u, i) => `Image ${i + 1}: ${u}`).join("\n");
  }

  // ── Stable Diffusion (Stability AI) ──────────────────────────────────────
  if (type === "stable-diffusion") {
    const [w, h] = (size || "1024x1024").split("x").map(Number);
    const resp   = await axios.post(
      "https://api.stability.ai/v2beta/stable-image/generate/core",
      { prompt, output_format: "webp", aspect_ratio: w >= h ? "16:9" : "9:16" },
      {
        headers:      { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" },
        responseType: "json",
      }
    );
    const image = resp.data.image;
    if (!image) return "Stable Diffusion returned no image.";
    return `Image generated (base64 webp, ${image.length} chars). You can embed it as: data:image/webp;base64,${image.slice(0, 40)}...`;
  }

  // ── Ideogram ──────────────────────────────────────────────────────────────
  if (type === "ideogram") {
    const resp = await axios.post(
      "https://api.ideogram.ai/generate",
      { image_request: { prompt, resolution: "RESOLUTION_1024_1024", style_type: args.style || "REALISTIC", num_images: n } },
      { headers: { "Api-Key": creds.apiKey, "Content-Type": "application/json" } }
    );
    const urls = (resp.data.data || []).map(d => d.url);
    return urls.length === 1 ? `Image generated: ${urls[0]}` : urls.map((u, i) => `Image ${i + 1}: ${u}`).join("\n");
  }

  return `Unsupported image generation connector type: ${type}`;
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
