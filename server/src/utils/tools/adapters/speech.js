"use strict";
const axios = require("axios");
const path  = require("path");
const fs    = require("fs");
const os    = require("os");

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_text_to_speech`,
        description: `Convert text to speech audio using "${connector.name}". Returns a URL or base64 audio.`,
        parameters: {
          type: "object",
          properties: {
            text:      { type: "string", description: "Text to convert to speech" },
            voice:     { type: "string", description: "Voice ID or name to use (provider-specific)" },
            language:  { type: "string", description: "Language code (e.g. 'en-US', 'fr-FR'). Optional." },
            speed:     { type: "number", description: "Speaking speed multiplier (0.5 to 2.0, default 1.0)" },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_list_voices`,
        description: `List available voices from "${connector.name}".`,
        parameters: { type: "object", properties: {}, required: [] },
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

  // ── ElevenLabs ────────────────────────────────────────────────────────────
  if (type === "elevenlabs") {
    if (action === "list_voices") {
      const resp = await axios.get("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": creds.apiKey },
      });
      const voices = (resp.data.voices || []).map(v => `${v.name} (${v.voice_id})`).join("\n");
      return `Available voices:\n${voices}`;
    }
    if (action === "text_to_speech") {
      const voiceId = args.voice || creds.voiceId || "EXAVITQu4vr4xnSDxMaL";
      const resp    = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: args.text, model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
        { headers: { "xi-api-key": creds.apiKey, "Content-Type": "application/json" }, responseType: "arraybuffer" }
      );
      const tmpFile = path.join(os.tmpdir(), `oe-tts-${Date.now()}.mp3`);
      fs.writeFileSync(tmpFile, resp.data);
      return `Audio generated and saved to: ${tmpFile} (${Math.round(resp.data.byteLength / 1024)}KB MP3)`;
    }
  }

  // ── OpenAI TTS ────────────────────────────────────────────────────────────
  if (type === "openai-tts") {
    if (action === "list_voices") {
      return "Available voices: alloy, echo, fable, onyx, nova, shimmer";
    }
    if (action === "text_to_speech") {
      const resp = await axios.post(
        "https://api.openai.com/v1/audio/speech",
        { model: "tts-1", input: args.text, voice: args.voice || creds.voice || "alloy", speed: args.speed || 1.0 },
        { headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" }, responseType: "arraybuffer" }
      );
      const tmpFile = path.join(os.tmpdir(), `oe-tts-${Date.now()}.mp3`);
      fs.writeFileSync(tmpFile, resp.data);
      return `Audio generated and saved to: ${tmpFile} (${Math.round(resp.data.byteLength / 1024)}KB MP3)`;
    }
  }

  // ── Azure Cognitive Speech ────────────────────────────────────────────────
  if (type === "azure-speech") {
    if (action === "list_voices") {
      const region = creds.region || "eastus";
      const token  = await axios.post(
        `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`,
        null,
        { headers: { "Ocp-Apim-Subscription-Key": creds.subscriptionKey } }
      );
      const resp = await axios.get(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
        { headers: { Authorization: `Bearer ${token.data}` } }
      );
      const voices = (resp.data || []).slice(0, 20).map(v => `${v.ShortName} (${v.Locale})`).join("\n");
      return `Available voices (first 20):\n${voices}`;
    }
    if (action === "text_to_speech") {
      const region = creds.region || "eastus";
      const voice  = args.voice || "en-US-JennyNeural";
      const lang   = args.language || "en-US";
      const ssml   = `<speak version='1.0' xml:lang='${lang}'><voice name='${voice}'>${args.text}</voice></speak>`;
      const token  = await axios.post(
        `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`,
        null,
        { headers: { "Ocp-Apim-Subscription-Key": creds.subscriptionKey } }
      );
      const resp = await axios.post(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        ssml,
        {
          headers: { Authorization: `Bearer ${token.data}`, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3" },
          responseType: "arraybuffer",
        }
      );
      const tmpFile = path.join(os.tmpdir(), `oe-tts-${Date.now()}.mp3`);
      fs.writeFileSync(tmpFile, resp.data);
      return `Audio generated and saved to: ${tmpFile} (${Math.round(resp.data.byteLength / 1024)}KB MP3)`;
    }
  }

  // ── Google Text-to-Speech ─────────────────────────────────────────────────
  if (type === "google-tts") {
    if (action === "list_voices") {
      const resp = await axios.get(
        `https://texttospeech.googleapis.com/v1/voices?key=${creds.apiKey}`
      );
      const voices = (resp.data.voices || []).slice(0, 20).map(v => `${v.name} (${v.languageCodes?.join(", ")})`).join("\n");
      return `Available voices (first 20):\n${voices}`;
    }
    if (action === "text_to_speech") {
      const lang  = args.language || "en-US";
      const voice = args.voice    || "en-US-Standard-A";
      const resp  = await axios.post(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${creds.apiKey}`,
        {
          input:       { text: args.text },
          voice:       { languageCode: lang, name: voice },
          audioConfig: { audioEncoding: "MP3", speakingRate: args.speed || 1.0 },
        }
      );
      const audio   = Buffer.from(resp.data.audioContent, "base64");
      const tmpFile = path.join(os.tmpdir(), `oe-tts-${Date.now()}.mp3`);
      fs.writeFileSync(tmpFile, audio);
      return `Audio generated and saved to: ${tmpFile} (${Math.round(audio.byteLength / 1024)}KB MP3)`;
    }
  }

  return `Unsupported action "${action}" for speech connector type: ${type}`;
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
