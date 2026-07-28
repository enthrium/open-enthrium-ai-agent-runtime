const router  = require("express").Router();
const multer  = require("multer");
const { authenticate } = require("../middleware/auth");
const { getSetting }   = require("../providers/llm");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── TTS ───────────────────────────────────────────────────────────────────────

router.post("/tts", authenticate, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  const provider = (await getSetting("tts_provider")) || "native";
  const safeText = text.slice(0, 4096);

  try {
    if (provider === "elevenlabs") {
      const apiKey  = await getSetting("tts_elevenlabs_key");
      const voiceId = (await getSetting("tts_elevenlabs_voice_id")) || "21m00Tcm4TlvDq8ikWAM";
      if (!apiKey) return res.status(400).json({ error: "ElevenLabs API key not configured" });

      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method:  "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body:    JSON.stringify({ text: safeText, model_id: "eleven_monolingual_v1" })
      });
      if (!resp.ok) throw new Error(`ElevenLabs error: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      return res.send(buf);
    }

    // OpenAI or generic-openai
    const { default: OpenAI } = await import("openai");
    let client;

    if (provider === "generic-openai") {
      const baseURL = await getSetting("tts_generic_base_url");
      const apiKey  = (await getSetting("tts_generic_api_key")) || "none";
      if (!baseURL) return res.status(400).json({ error: "Generic TTS base URL not configured" });
      client = new OpenAI({ apiKey, baseURL });
    } else {
      const apiKey = (await getSetting("llm_api_key")) || process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(400).json({ error: "OpenAI API key not configured" });
      client = new OpenAI({ apiKey });
    }

    const voice = (await getSetting("tts_voice")) || "alloy";
    const model = (await getSetting("tts_model")) || "tts-1";
    const gVoice = provider === "generic-openai" ? ((await getSetting("tts_generic_voice")) || "alloy") : voice;

    const mp3 = await client.audio.speech.create({ model, voice: gVoice, input: safeText });
    const buf = Buffer.from(await mp3.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (err) {
    console.error("[TTS]", err.message);
    res.status(500).json({ error: "TTS failed: " + err.message });
  }
});

// ── STT ───────────────────────────────────────────────────────────────────────

router.post("/stt", authenticate, upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "audio file required" });

  const provider = (await getSetting("stt_provider")) || "native";

  try {
    if (provider === "deepgram") {
      const apiKey = await getSetting("stt_deepgram_key");
      if (!apiKey) return res.status(400).json({ error: "Deepgram API key not configured" });

      const resp = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true", {
        method:  "POST",
        headers: { "Authorization": `Token ${apiKey}`, "Content-Type": req.file.mimetype || "audio/webm" },
        body:    req.file.buffer
      });
      if (!resp.ok) throw new Error(`Deepgram error: ${resp.status}`);
      const data = await resp.json();
      const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      return res.json({ transcript });
    }

    // OpenAI Whisper or generic-openai
    const { default: OpenAI } = await import("openai");
    let client;

    if (provider === "generic-openai") {
      const baseURL = await getSetting("stt_generic_base_url");
      const apiKey  = (await getSetting("stt_generic_api_key")) || "none";
      if (!baseURL) return res.status(400).json({ error: "Generic STT base URL not configured" });
      client = new OpenAI({ apiKey, baseURL });
    } else {
      const apiKey = (await getSetting("llm_api_key")) || process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(400).json({ error: "OpenAI API key not configured" });
      client = new OpenAI({ apiKey });
    }

    const audioFile = new File([req.file.buffer], "audio.webm", { type: req.file.mimetype || "audio/webm" });
    const result = await client.audio.transcriptions.create({ file: audioFile, model: "whisper-1" });
    res.json({ transcript: result.text });
  } catch (err) {
    console.error("[STT]", err.message);
    res.status(500).json({ error: "STT failed: " + err.message });
  }
});

module.exports = router;
