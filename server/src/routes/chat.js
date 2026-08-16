const router = require("express").Router();
const { authenticate } = require("../middleware/auth");
const { similaritySearch } = require("../utils/vectorStore");
const { getLLMClient, getSetting } = require("../providers/llm");

function normalizeRefusal(response, refusalMsg) {
  const trimmed = (response || "").trim();
  if (trimmed.length > 300) return response;
  const lower = trimmed.toLowerCase();
  const indicators = [
    "there is no relevant information in this workspace",
    "there's no relevant information in this workspace",
    "no relevant information in this workspace",
    "i'm sorry, i can't assist",
    "i'm sorry, i cannot assist",
    "i cannot assist with that",
    "i can't assist with that",
    "i'm unable to assist with that",
    "i don't have relevant information",
    "i'm sorry, i don't have",
  ];
  return indicators.some(ind => lower.includes(ind)) ? refusalMsg : response;
}

async function resolveThreadId(db, threadUid) {
  if (!threadUid) return null;
  const thread = await db.thread.findUnique({ where: { uid: threadUid } });
  return thread?.id ?? null;
}

// ── GET history ───────────────────────────────────────────────────────────────

router.get("/:slug/history", authenticate, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const threadId = await resolveThreadId(req.db, req.query.threadId || null);
  const chats = await req.db.chat.findMany({
    where: { workspaceId: workspace.id, threadId },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json({
    messages: chats.reverse().map(c => ({
      ...c,
      sources: c.sources ? JSON.parse(c.sources) : [],
    }))
  });
});

// ── POST chat ─────────────────────────────────────────────────────────────────

router.post("/:slug", authenticate, async (req, res) => {
  const { message: _message, threadId: threadUid, bypassDlp } = req.body;
  let message = _message;
  if (!message) return res.status(400).json({ error: "Message required" });

  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const threadId     = await resolveThreadId(req.db, threadUid || null);
  const temperature  = workspace.temperature ?? 0.7;
  const historyLimit = (workspace.chatHistory ?? 20) * 2;

  const chatUserId = req.user.id === 0 ? null : req.user.id;
  if (!bypassDlp) {
    await req.db.chat.create({
      data: { workspaceId: workspace.id, threadId, userId: chatUserId, role: "user", content: message }
    });
  }

  // ── RAG retrieval ─────────────────────────────────────────────────────────

  const topK = parseInt((await getSetting("rag_top_k")) || "15");
  const kbShares = await req.db.workspaceKBShare.findMany({
    where: { targetWorkspaceId: workspace.id },
    include: { sourceWorkspace: { select: { slug: true, name: true } } },
  });
  const [ownSources, ...sharedResultArrays] = await Promise.all([
    similaritySearch(workspace.slug, message, topK),
    ...kbShares.map(s =>
      similaritySearch(s.sourceWorkspace.slug, message, topK).catch(err => {
        console.error(`[KB Share] search failed for "${s.sourceWorkspace.slug}":`, err.message);
        return [];
      })
    ),
  ]);

  const taggedOwn = ownSources.map(s => ({ ...s, _wsName: null }));
  const taggedSharedGroups = sharedResultArrays.map((arr, i) =>
    arr.map(s => ({ ...s, _wsName: kbShares[i].sourceWorkspace.name }))
  );

  let sources;
  if (taggedSharedGroups.length === 0) {
    sources = taggedOwn.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, topK);
  } else {
    const numSources  = 1 + taggedSharedGroups.length;
    const baseSlots   = Math.floor(topK / numSources);
    const extraSlots  = topK - baseSlots * numSources;
    const byScore     = arr => [...arr].sort((a, b) => (b.score || 0) - (a.score || 0));
    const ownSorted   = byScore(taggedOwn);
    const sharedSorted = taggedSharedGroups.map(byScore);
    const guaranteed  = [
      ...ownSorted.slice(0, baseSlots),
      ...sharedSorted.flatMap(arr => arr.slice(0, baseSlots)),
    ];
    const remaining   = [
      ...ownSorted.slice(baseSlots),
      ...sharedSorted.flatMap(arr => arr.slice(baseSlots)),
    ].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, extraSlots);
    sources = [...guaranteed, ...remaining].sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  const context = sources.map((s, i) => {
    const label = s._wsName ? `[Source ${i + 1} from "${s._wsName}"]` : `[Source ${i + 1}]`;
    return `${label}: ${s.text}`;
  }).join("\n\n");

  // ── History ───────────────────────────────────────────────────────────────

  const history = await req.db.chat.findMany({
    where: { workspaceId: workspace.id, threadId },
    orderBy: { createdAt: "desc" },
    take: historyLimit
  });
  const skipCount = bypassDlp === "warn" ? 2 : 1;
  const historyMessages = history.reverse().slice(0, -skipCount).reduce((acc, c) => {
    let content = c.content || "";
    if (c.role === "assistant") {
      if (content.startsWith("🚫 **Your message was blocked**") ||
          content.startsWith("⚠️ **Security Warning:**")) return acc;
      for (const prefix of ["> 🔒 **Redaction Notice:**", "> 📋 **Audit Notice:**"]) {
        if (content.startsWith(prefix)) {
          const split = content.indexOf("\n\n");
          if (split !== -1) content = content.slice(split + 2).trim();
          if (!content) return acc;
          break;
        }
      }
    }
    acc.push({ role: c.role, content });
    return acc;
  }, []);

  // ── DLP scan ──────────────────────────────────────────────────────────────

  let dlpNoticePrefix = "";
  if (!bypassDlp) {
    const { scanMessage } = require("../utils/dlpScanner");
    const dlpPolicies = workspace.dlpEnabled
      ? await req.db.dlpPolicy.findMany({ where: { enabled: true } })
      : [];
    if (dlpPolicies.length > 0) {
      const { blocked, violations, redactedText } = scanMessage(message, dlpPolicies);

      for (const v of violations) {
        await req.db.dlpViolation.create({
          data: {
            policyId:      v.policyId,
            policyName:    v.policyName,
            action:        v.action,
            userId:        req.user?.id || null,
            userEmail:     req.user?.email || null,
            workspaceId:   workspace.id || null,
            workspaceName: workspace.name || null,
            snippet:       v.snippet,
          }
        }).catch(e => console.error("[DLP] violation insert failed:", e.message));
      }

      const sseHeaders = () => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
      };

      if (blocked) {
        const names = [...new Set(violations.filter(v => v.action === "block").map(v => v.policyName))].join(", ");
        const blockMsg = `🚫 **Your message was blocked** by your organization's security policy (${names}). Please remove sensitive content and try again.`;
        try {
          await req.db.chat.create({ data: { workspaceId: workspace.id, threadId, userId: chatUserId, role: "assistant", content: blockMsg } });
        } catch (e) {
          console.error("[DLP] blocked message save failed:", e.message);
        }
        sseHeaders();
        res.write(`data: ${JSON.stringify({ chunk: blockMsg })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true, sources: [] })}\n\n`);
        return res.end();
      }

      const redactHits = violations.filter(v => v.action === "redact");
      if (redactHits.length > 0) {
        message = redactedText;
        const names = [...new Set(redactHits.map(v => v.policyName))].join(", ");
        dlpNoticePrefix = `> 🔒 **Redaction Notice:** Sensitive content was detected by the "${names}" policy. Your message has been redacted and logged before sending to the AI.\n\n`;
      }

      const warnHits = violations.filter(v => v.action === "warn");
      if (warnHits.length > 0) {
        const names = [...new Set(warnHits.map(v => v.policyName))];
        const warnMsg = `⚠️ **Security Warning:** Your message was flagged by the "${names.join('", "')}" policy and has been logged. You can choose to send it anyway or cancel.`;
        await req.db.chat.create({ data: { workspaceId: workspace.id, threadId, userId: chatUserId, role: "assistant", content: warnMsg } }).catch(() => {});
        sseHeaders();
        res.write(`data: ${JSON.stringify({ dlp: { action: "warn", policyNames: names, message: warnMsg } })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true, sources: [] })}\n\n`);
        return res.end();
      }

      const auditHits = violations.filter(v => v.action === "audit");
      if (auditHits.length > 0) {
        const names = [...new Set(auditHits.map(v => v.policyName))].join(", ");
        dlpNoticePrefix = `> 📋 **Audit Notice:** Your message was logged for compliance (${names}).\n\n`;
      }
    }
  }

  // ── System prompt ─────────────────────────────────────────────────────────

  const refusalMsg = workspace.queryRefusalResponse ||
    "There is no relevant information in this workspace to answer your query.";

  const basePrompt = workspace.systemPrompt ||
`You are a knowledgeable AI assistant for this workspace.

CAPABILITIES:
1. INGESTED DOCUMENT CONTEXT (highest priority)
   - The Document Context section below contains text extracted from files uploaded or ingested into this workspace, including files shared from other workspaces.
   - Sources labelled [Source N] are from this workspace. Sources labelled [Source N from "Workspace Name"] are from a shared workspace called "Workspace Name".
   - Always answer from this context first. Present all relevant data, tables, and details exactly as found. Do not summarise or truncate.
   - If the context contains a partial dataset (e.g. sample rows from a CSV), present what is available and note it may be a sample.

STRICT RULES:
- Answer ONLY from the provided context. Do NOT use general knowledge or outside information.
- Provide thorough, complete, and well-structured answers.
- Include all relevant details, steps, lists, or tables present in the source documents.
- If a process has multiple steps, list every step in full.
- Use bullet points, numbered lists, or markdown tables when the answer contains multiple items.
- Only respond with the refusal message if there is genuinely no relevant information in the context.`;

  const docSection = context.length > 0
    ? `\n\n--- Document Context ---\n${context}\n--- End of Context ---\n\nThe context above contains the relevant data from ingested files. Present all data, tables, lists, or information from it that helps answer the question. Only use the response "${refusalMsg}" if the context contains absolutely no information related to the question.`
    : `\n\nNo documents found in this workspace. Respond with: "${refusalMsg}"`;

  const guardrail = `STRICT OUTPUT CONSTRAINT: You are a workspace-scoped assistant. You MUST follow these rules above everything else:
1. Answer ONLY from the Document Context provided below.
2. If the answer is not in the context, respond with ONLY this exact text: "${refusalMsg}" — nothing else.
3. Do NOT generate safety warnings, disclaimers, privacy advice, or any content not found in the context.
4. Do NOT use phrases like "I'm sorry", "I can't assist", "I should warn you", or any variation. Your only allowed non-answer is: "${refusalMsg}"

`;

  const systemPrompt = guardrail + basePrompt + docSection;

  // ── Stream response ───────────────────────────────────────────────────────

  let fullResponse = "";
  let inputTokens  = 0;
  let outputTokens = 0;
  let clientGone   = false;
  req.on("close", () => { clientGone = true; });

  function safeWrite(data) {
    if (clientGone) return;
    try { res.write(data); } catch { clientGone = true; }
  }

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (dlpNoticePrefix) {
      safeWrite(`data: ${JSON.stringify({ chunk: dlpNoticePrefix })}\n\n`);
    }

    const { provider, client } = await getLLMClient();
    const model = (await getSetting("llm_model")) || process.env.OPENAI_MODEL || process.env.OLLAMA_MODEL || "gpt-4o";

    if (provider === "anthropic") {
      const stream = await client.messages.create({
        model: model || "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [...historyMessages, { role: "user", content: message }],
        temperature,
        stream: true
      });
      for await (const event of stream) {
        if (event.type === "message_start")  inputTokens  = event.message?.usage?.input_tokens  || 0;
        if (event.type === "message_delta")  outputTokens = event.usage?.output_tokens || 0;
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const chunk = event.delta.text;
          fullResponse += chunk;
          safeWrite(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
      }
    } else {
      const stream = await client.chat.completions.create({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...historyMessages, { role: "user", content: message }],
        temperature,
        max_tokens: 4096,
        stream: true,
        stream_options: { include_usage: true }
      });
      for await (const part of stream) {
        if (part.usage) {
          inputTokens  = part.usage.prompt_tokens     || 0;
          outputTokens = part.usage.completion_tokens || 0;
        }
        const chunk = part.choices?.[0]?.delta?.content || "";
        if (chunk) {
          fullResponse += chunk;
          safeWrite(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
      }
      if (!inputTokens && !outputTokens && fullResponse) {
        inputTokens  = Math.ceil((systemPrompt.length + message.length) / 4);
        outputTokens = Math.ceil(fullResponse.length / 4);
      }
    }

    // ── Save & done ───────────────────────────────────────────────────────

    const sourcesData = sources.length > 0
      ? JSON.stringify(sources.map(s => ({ text: s.text.slice(0, 200), metadata: s.metadata })))
      : null;

    const normalizedFull = normalizeRefusal(fullResponse, refusalMsg);
    const wasNormalized  = normalizedFull !== fullResponse;
    if (wasNormalized) fullResponse = normalizedFull;

    await req.db.chat.create({
      data: {
        workspaceId: workspace.id,
        threadId,
        userId:      chatUserId,
        role:        "assistant",
        content:     dlpNoticePrefix + fullResponse,
        sources:     sourcesData,
        inputTokens,
        outputTokens,
        model
      }
    });

    if (!clientGone) {
      const doneEvt = { done: true, sources };
      if (wasNormalized) doneEvt.content = dlpNoticePrefix + fullResponse;
      res.write(`data: ${JSON.stringify(doneEvt)}\n\n`);
      res.end();
    }
  } catch (err) {
    console.error("Chat error:", err.message);
    if (!clientGone) {
      try {
        res.write(`data: ${JSON.stringify({ error: "Failed to get response. Check your LLM configuration." })}\n\n`);
        res.end();
      } catch { /* client already gone */ }
    }
  }
});

// ── DELETE history ────────────────────────────────────────────────────────────

router.delete("/:slug/history", authenticate, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const where = { workspaceId: workspace.id };
  if (req.query.threadId === "none") {
    where.threadId = null;
  } else if (req.query.threadId) {
    where.threadId = parseInt(req.query.threadId);
  }
  await req.db.chat.deleteMany({ where });
  res.json({ success: true });
});

module.exports = router;
