const router    = require("express").Router();
const rateLimit = require("express-rate-limit");
const { similaritySearch }        = require("../utils/vectorStore");
const { getLLMClient, getSetting } = require("../providers/llm");

router.use(rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment before sending another message." } }));

// GET /api/embed/:slug/config — public workspace info for the embed page
router.get("/:slug/config", async (req, res) => {
  const ws = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!ws || !ws.embedEnabled) return res.status(404).json({ error: "Workspace not found" });
  res.json({
    name:          ws.name,
    starterPrompts: (() => { try { return JSON.parse(ws.starterPrompts || "[]"); } catch { return []; } })(),
  });
});

// POST /api/embed/:slug/chat — public SSE streaming chat (anonymous, embedEnabled only)
router.post("/:slug/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace || !workspace.embedEnabled) return res.status(404).json({ error: "Workspace not found" });

  const temperature   = workspace.temperature ?? 0.7;
  const topK = parseInt((await getSetting("rag_top_k")) || "15");
  const kbShares = await req.db.workspaceKBShare.findMany({
    where: { targetWorkspaceId: workspace.id },
    include: { sourceWorkspace: { select: { slug: true, name: true } } },
  });
  const [ownSources, ...sharedResults] = await Promise.all([
    similaritySearch(workspace.slug, message, topK),
    ...kbShares.map(s => similaritySearch(s.sourceWorkspace.slug, message, topK).catch(() => [])),
  ]);
  const sources = [...ownSources, ...sharedResults.flat()]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, topK);
  const context = sources.map((s, i) => `[Source ${i + 1}]: ${s.text}`).join("\n\n");

  const basePrompt = workspace.systemPrompt ||
`You are a knowledgeable assistant for this workspace. Follow these rules strictly:
- Answer questions ONLY based on the documents provided in the context below.
- Do NOT use any general knowledge or outside information.
- Provide thorough, complete, and well-structured answers.`;

  const refusalMsg   = workspace.queryRefusalResponse || "There is no relevant information in this workspace to answer your query.";
  const systemPrompt = context.length > 0
    ? `${basePrompt}\n\n--- Ingested Document Context ---\nThe following content was extracted from files uploaded/ingested into this workspace.\n\n${context}\n--- End of Ingested Context ---\n\nIf the answer cannot be found in the ingested context above, respond with: "${refusalMsg}"`
    : `${basePrompt}\n\nNo ingested documents found. Respond with: "${refusalMsg}"`;

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const { provider, client } = await getLLMClient();
    const model = (await getSetting("llm_model")) || process.env.OPENAI_MODEL || "gpt-4o";
    let fullResponse = "";

    if (provider === "anthropic") {
      const stream = await client.messages.create({
        model: model || "claude-3-5-sonnet-20241022",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
        temperature,
        stream: true,
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          fullResponse += event.delta.text;
          res.write(`data: ${JSON.stringify({ chunk: event.delta.text })}\n\n`);
        }
      }
    } else {
      const stream = await client.chat.completions.create({
        model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: message }],
        temperature,
        max_tokens: 4096,
        stream: true,
      });
      for await (const part of stream) {
        const chunk = part.choices?.[0]?.delta?.content || "";
        if (chunk) {
          fullResponse += chunk;
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, sources })}\n\n`);
    res.end();
  } catch (err) {
    console.error("[embed chat]", err.message);
    res.write(`data: ${JSON.stringify({ error: "Failed to get response." })}\n\n`);
    res.end();
  }
});

module.exports = router;
