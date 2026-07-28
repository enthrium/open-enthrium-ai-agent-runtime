"use strict";
const axios = require("axios");

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_generate_music`,
        description: `Generate music or audio from a text prompt using "${connector.name}". Returns audio URLs (generation may be async).`,
        parameters: {
          type: "object",
          properties: {
            prompt:      { type: "string",  description: "Description of the music to generate (genre, mood, instruments, tempo, etc.)" },
            duration:    { type: "number",  description: "Duration in seconds (default 30, max 240)" },
            title:       { type: "string",  description: "Optional song title" },
            instrumental:{ type: "boolean", description: "If true, generate instrumental music without vocals" },
          },
          required: ["prompt"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_check_status`,
        description: `Check the status of a music generation job. Pass the job_id returned by generate_music.`,
        parameters: {
          type: "object",
          properties: {
            job_id: { type: "string", description: "Job ID returned by generate_music" },
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

  // ── Suno ──────────────────────────────────────────────────────────────────
  if (type === "suno") {
    if (action === "generate_music") {
      const resp = await axios.post(
        "https://studio-api.suno.ai/api/external/generate/",
        {
          prompt:        args.prompt,
          tags:          args.prompt,
          title:         args.title || "Generated Track",
          make_instrumental: args.instrumental || false,
          wait_audio:    false,
        },
        { headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" } }
      );
      const clips = resp.data || [];
      if (Array.isArray(clips) && clips.length) {
        const ids = clips.map(c => c.id).join(", ");
        return `Music generation started. Clip IDs: ${ids}. Use check_status with any ID to get the audio URL.`;
      }
      return `Music generation started. Response: ${JSON.stringify(resp.data).slice(0, 200)}`;
    }
    if (action === "check_status") {
      const resp = await axios.get(
        `https://studio-api.suno.ai/api/external/clips/?ids=${args.job_id}`,
        { headers: { Authorization: `Bearer ${creds.apiKey}` } }
      );
      const clip = (resp.data?.clips || resp.data)?.[0];
      if (!clip) return "Clip not found.";
      if (clip.status === "complete") return `Music ready:\n  Title: ${clip.title}\n  URL: ${clip.audio_url}\n  Duration: ${clip.duration}s`;
      return `Status: ${clip.status}. Check again in a few seconds.`;
    }
  }

  // ── Udio ──────────────────────────────────────────────────────────────────
  if (type === "udio") {
    if (action === "generate_music") {
      const resp = await axios.post(
        "https://www.udio.com/api/generate-proxy",
        {
          prompt:     args.prompt,
          samplerOptions: { seed: -1 },
        },
        { headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" } }
      );
      const trackIds = (resp.data?.track_ids || []).join(", ");
      return trackIds
        ? `Music generation started. Track IDs: ${trackIds}. Use check_status to get the audio URL.`
        : `Music generation started. Response: ${JSON.stringify(resp.data).slice(0, 200)}`;
    }
    if (action === "check_status") {
      const resp = await axios.get(
        `https://www.udio.com/api/songs?songIds=${args.job_id}`,
        { headers: { Authorization: `Bearer ${creds.apiKey}` } }
      );
      const song = (resp.data?.songs || [])[0];
      if (!song) return "Song not found.";
      if (song.finished) return `Music ready:\n  Title: ${song.title || "Track"}\n  URL: ${song.song_path}`;
      return `Status: generating. Check again in a few seconds.`;
    }
  }

  return `Unsupported action "${action}" for music connector type: ${type}`;
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
