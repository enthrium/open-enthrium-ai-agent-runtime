"use strict";
const axios = require("axios");

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_generate_video`,
        description: `Generate a video from a text prompt or image using "${connector.name}". Returns a job ID or video URL (generation is async — use check_status to poll).`,
        parameters: {
          type: "object",
          properties: {
            prompt:    { type: "string", description: "Text description of the video to generate" },
            image_url: { type: "string", description: "Optional: starting image URL for image-to-video generation" },
            duration:  { type: "number", description: "Video duration in seconds (provider limits apply, typically 4–16s)" },
            ratio:     { type: "string", description: "Aspect ratio: '16:9', '9:16', or '1:1'" },
          },
          required: ["prompt"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_check_status`,
        description: `Check the status of a video generation job from "${connector.name}". Pass the job_id returned by generate_video.`,
        parameters: {
          type: "object",
          properties: {
            job_id: { type: "string", description: "Job ID returned by generate_video" },
          },
          required: ["job_id"],
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

  // ── Runway ────────────────────────────────────────────────────────────────
  if (type === "runway") {
    if (action === "generate_video") {
      const body = {
        promptText: args.prompt,
        model:      "gen4_turbo",
        ratio:      args.ratio || "1280:720",
        duration:   args.duration || 5,
      };
      if (args.image_url) body.promptImage = args.image_url;
      const resp = await axios.post(
        "https://api.dev.runwayml.com/v1/image_to_video",
        body,
        { headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json", "X-Runway-Version": "2024-11-06" } }
      );
      const jobId = resp.data.id;
      return `Video generation started. Job ID: ${jobId}. Use check_status with this ID to get the video URL (usually ready in 30–90 seconds).`;
    }
    if (action === "check_status") {
      const resp = await axios.get(
        `https://api.dev.runwayml.com/v1/tasks/${args.job_id}`,
        { headers: { Authorization: `Bearer ${creds.apiKey}`, "X-Runway-Version": "2024-11-06" } }
      );
      const task   = resp.data;
      const status = task.status;
      if (status === "SUCCEEDED") return `Video ready: ${task.output?.[0] || "URL not available"}`;
      if (status === "FAILED")    return `Video generation failed: ${task.failure || "Unknown error"}`;
      return `Status: ${status}. Progress: ${task.progress || 0}%. Check again in a few seconds.`;
    }
  }

  // ── Kling (Kuaishou) ──────────────────────────────────────────────────────
  if (type === "kling") {
    if (action === "generate_video") {
      const endpoint = args.image_url
        ? "https://api.klingai.com/v1/videos/image2video"
        : "https://api.klingai.com/v1/videos/text2video";
      const body = {
        model_name:    "kling-v1",
        prompt:        args.prompt,
        duration:      String(args.duration || 5),
        aspect_ratio:  args.ratio || "16:9",
      };
      if (args.image_url) body.image = args.image_url;
      const resp = await axios.post(endpoint, body, {
        headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
      });
      const jobId = resp.data.data?.task_id;
      return `Video generation started. Task ID: ${jobId}. Use check_status to poll for completion.`;
    }
    if (action === "check_status") {
      const resp = await axios.get(
        `https://api.klingai.com/v1/videos/text2video/${args.job_id}`,
        { headers: { Authorization: `Bearer ${creds.apiKey}` } }
      );
      const task   = resp.data.data;
      const status = task?.task_status;
      if (status === "succeed") return `Video ready: ${task.task_result?.videos?.[0]?.url || "URL not available"}`;
      if (status === "failed")  return `Video generation failed: ${task.task_status_msg || "Unknown error"}`;
      return `Status: ${status}. Check again in a few seconds.`;
    }
  }

  // ── Pika ──────────────────────────────────────────────────────────────────
  if (type === "pika") {
    if (action === "generate_video") {
      const resp = await axios.post(
        "https://api.pika.art/v1/generate",
        {
          promptText:    args.prompt,
          image:         args.image_url || null,
          options: {
            duration:     args.duration || 3,
            aspectRatio:  args.ratio    || "16:9",
            frameRate:    24,
          },
        },
        { headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" } }
      );
      const jobId = resp.data.id || resp.data.jobId;
      return `Video generation started. Job ID: ${jobId}. Use check_status to poll for completion.`;
    }
    if (action === "check_status") {
      const resp = await axios.get(
        `https://api.pika.art/v1/jobs/${args.job_id}`,
        { headers: { Authorization: `Bearer ${creds.apiKey}` } }
      );
      const job    = resp.data;
      const status = job.status;
      if (status === "finished" || status === "completed") return `Video ready: ${job.videos?.[0]?.url || job.url || "URL not available"}`;
      if (status === "failed")                             return `Video generation failed: ${job.error || "Unknown error"}`;
      return `Status: ${status}. Check again in a few seconds.`;
    }
  }

  return `Unsupported action "${action}" for video connector type: ${type}`;
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
