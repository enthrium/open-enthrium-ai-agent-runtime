const router = require("express").Router();
const { authenticate } = require("../middleware/auth");
const { similaritySearch } = require("../utils/vectorStore");
const { getLLMClient, getSetting } = require("../providers/llm");
const { getToolDefinitions, getAnthropicToolDefinitions, executeTool } = require("../utils/tools/registry");
const { canRunAgent, incrementAgentRun, getTierFromDB } = require("../utils/tier");

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

function friendlyToolName(rawName, connectors) {
  const connId = rawName.match(/^conn_(\d+)_/)?.[1];
  const action = rawName.replace(/^conn_\d+_/, "");
  if (connId) {
    const conn = (connectors || []).find(c => c.id === parseInt(connId));
    return conn ? conn.name : action;
  }
  return rawName.replace(/_/g, " ");
}

function applyParams(template, paramDefs, paramValues) {
  let result = template || "";
  for (const p of (paramDefs || [])) {
    const val = String(paramValues?.[p.name] ?? p.default ?? "");
    result = result.split(`{{${p.name}}}`).join(val);
  }
  return result;
}

async function resolveThreadId(db, threadUid) {
  if (!threadUid) return null;
  const thread = await db.thread.findUnique({ where: { uid: threadUid } });
  return thread?.id ?? null;
}

router.get("/:slug/history", authenticate, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  const threadId = await resolveThreadId(req.db, req.query.threadId || null);
  const chats = await req.db.chat.findMany({
    where: { workspaceId: workspace.id, threadId },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json({ messages: chats.reverse().map(c => ({ ...c, sources: c.sources ? JSON.parse(c.sources) : [], toolCalls: c.toolCalls ? JSON.parse(c.toolCalls).map(name => ({ name, done: true })) : undefined })) });
});

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

  // ── @agent-slug mention routing ────────────────────────────────────────────
  const mentionMatch = message.match(/^@([\w-]+)(?:\s+([\s\S]*))?$/);
  if (mentionMatch) {
    const agentSlug  = mentionMatch[1];
    const rawInput   = mentionMatch[2]?.trim() || "";
    const chatParams = {};
    const paramRe    = /([\w]+)\s*=\s*(?:"([^"]*)"|(\S+))/g;
    let pm;
    while ((pm = paramRe.exec(rawInput)) !== null) chatParams[pm[1]] = pm[2] ?? pm[3];
    const agentInput = rawInput.replace(paramRe, "").trim();
    let agent = await req.db.agent.findFirst({ where: { workspaceId: workspace.id, slug: agentSlug } });
    let isSharedAgent = false;
    if (!agent) {
      const share = await req.db.agentShare.findFirst({
        where: { grantedWorkspaceId: workspace.id, agent: { slug: agentSlug } },
        include: { agent: true },
      });
      if (share) { agent = share.agent; isSharedAgent = true; }
    }
    // Shared agents run with owner's defaults only — no param override allowed
    if (isSharedAgent && (Object.keys(chatParams).length > 0 || agentInput)) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`data: ${JSON.stringify({ chunk: `**@${agentSlug}**: params not allowed on shared agents.` })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, sources: [] })}\n\n`);
      res.end();
      return;
    }
    // ── @connector-slug routing ────────────────────────────────────────────
    if (!agent) {
      let connBySlug = await req.db.connector.findFirst({
        where: { workspaceId: workspace.id, slug: agentSlug, status: "active" }
      });
      if (!connBySlug) {
        // Also check connectors shared into this workspace
        const sharedConn = await req.db.connectorShare.findFirst({
          where: { grantedWorkspaceId: workspace.id, connector: { slug: agentSlug, status: "active" } },
          include: { connector: true },
        });
        if (sharedConn) connBySlug = sharedConn.connector;
      }
      if (connBySlug) {
        const connectors = [connBySlug];
        const userMessage = agentInput || "Show me what you can do with this connector.";
        const connSystemPrompt = `You are a database/integration query assistant with direct access to ${connBySlug.name} (${connBySlug.type}). Always use the available tools to retrieve and present the data requested by the user. Never refuse a data query — use the tool to fetch the answer. Be concise and clear.`;

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        let connClientGone = false;
        req.on("close", () => { connClientGone = true; });

        try {
          const allowed = await canRunAgent(req.db);
          if (!allowed) {
            res.write(`data: ${JSON.stringify({ error: "Agent run limit reached." })}\n\n`);
            return res.end();
          }
          await incrementAgentRun(req.db);

          const { provider, client } = await getLLMClient();
          const model = (await getSetting("llm_model")) || process.env.OPENAI_MODEL || "gpt-4o";
          const MAX_ROUNDS = 5;
          let fullOutput = "";
          const connToolCallNames = [];

          if (provider === "anthropic") {
            const tools = getAnthropicToolDefinitions(connectors);
            const msgs = [{ role: "user", content: userMessage }];
            for (let round = 0; round < MAX_ROUNDS; round++) {
              const callOpts = { model: model || "claude-sonnet-4-6", max_tokens: 4096, system: connSystemPrompt, messages: msgs, tools: tools.length ? tools : undefined, temperature: 0.3 };
              if (round === 0 && tools.length) callOpts.tool_choice = { type: "any" };
              const resp = await client.messages.create(callOpts);
              if (resp.stop_reason !== "tool_use" || !tools.length) { fullOutput = resp.content?.find(b => b.type === "text")?.text || ""; break; }
              const toolUseBlocks = resp.content.filter(b => b.type === "tool_use");
              const names = toolUseBlocks.map(b => friendlyToolName(b.name, connectors));
              connToolCallNames.push(...names);
              if (!connClientGone) res.write(`data: ${JSON.stringify({ tool_calls: names })}\n\n`);
              msgs.push({ role: "assistant", content: resp.content });
              const toolResults = [];
              for (const tb of toolUseBlocks) { const result = await executeTool(tb.name, tb.input, connectors, req.db); toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: String(result) }); }
              msgs.push({ role: "user", content: toolResults });
              if (round === MAX_ROUNDS - 1) { const fr = await client.messages.create({ model: model || "claude-sonnet-4-6", max_tokens: 4096, system: connSystemPrompt, messages: msgs, temperature: 0.3 }); fullOutput = fr.content?.find(b => b.type === "text")?.text || ""; }
            }
          } else {
            const tools = getToolDefinitions(connectors);
            const messages = [{ role: "system", content: connSystemPrompt }, { role: "user", content: userMessage }];
            for (let round = 0; round < MAX_ROUNDS; round++) {
              const reqBody = { model, messages, temperature: 0.3, max_tokens: 4096 };
              if (tools.length) { reqBody.tools = tools; reqBody.tool_choice = "auto"; }
              const resp = await client.chat.completions.create(reqBody);
              const choice = resp.choices[0];
              if (choice.finish_reason !== "tool_calls" || !tools.length) { fullOutput = choice.message.content || ""; break; }
              messages.push(choice.message);
              const names = (choice.message.tool_calls || []).map(tc => friendlyToolName(tc.function.name, connectors));
              connToolCallNames.push(...names);
              if (!connClientGone) res.write(`data: ${JSON.stringify({ tool_calls: names })}\n\n`);
              for (const tc of choice.message.tool_calls || []) {
                let args = {}; try { args = JSON.parse(tc.function.arguments); } catch { /**/ }
                const result = await executeTool(tc.function.name, args, connectors, req.db);
                messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
              }
              if (round === MAX_ROUNDS - 1) { const fr = await client.chat.completions.create({ model, messages, temperature: 0.3, max_tokens: 4096 }); fullOutput = fr.choices[0].message.content || ""; }
            }
          }

          const replyContent = `**@${agentSlug}** — ${fullOutput}`;
          await req.db.chat.create({ data: { workspaceId: workspace.id, threadId, role: "assistant", content: replyContent, toolCalls: connToolCallNames.length ? JSON.stringify(connToolCallNames) : null } });
          if (!connClientGone) res.write(`data: ${JSON.stringify({ done: true, content: replyContent, sources: [], agentRun: true })}\n\n`);
        } catch (err) {
          console.error("[connector @mention]", err.message);
          if (!connClientGone) res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        }
        if (!connClientGone) res.end();
        return;
      }
    }
    // ── end @connector-slug routing ────────────────────────────────────────

    if (agent) {
      const run = await req.db.agentRun.create({
        data: { agentId: agent.id, status: "running", triggerType: "chat", input: agentInput || null, triggeredByUserId: chatUserId, triggeredFromWorkspaceId: workspace.id },
      });
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`data: ${JSON.stringify({ run_id: run.id })}\n\n`);

      let agentClientGone = false;
      req.on("close", () => { agentClientGone = true; });
      function agentSafeWrite(data) {
        if (agentClientGone) return;
        try { res.write(data); } catch { agentClientGone = true; }
      }

      try {
        const { canRunAgent, incrementAgentRun } = require("../utils/tier");
        const allowed = await canRunAgent(req.db);
        if (!allowed) {
          await req.db.agentRun.update({ where: { id: run.id }, data: { status: "error", error: "Run limit reached", completedAt: new Date() } });
          res.write(`data: ${JSON.stringify({ error: "Agent run limit reached." })}\n\n`);
          return res.end();
        }
        await incrementAgentRun(req.db);

        const connectorIds = JSON.parse(agent.connectorIds || "[]");
        const connectors   = connectorIds.length ? await req.db.connector.findMany({ where: { id: { in: connectorIds }, status: "active" } }) : [];

        const paramDefs    = JSON.parse(agent.params || "[]");
        const { buildSystemPrompt } = require("../utils/workflowEngine");
        let systemPrompt = applyParams(
          buildSystemPrompt(agent) || "You are a helpful AI agent. Complete the task given to you using the available tools.",
          paramDefs, chatParams
        );

        // Inject memory from past runs
        if (workspace.agentMemoryEnabled) {
          const pastRuns = await req.db.agentRun.findMany({
            where: { agentId: agent.id, status: "success" },
            orderBy: { completedAt: "desc" },
            take: workspace.agentMemoryRuns || 5,
          });
          if (pastRuns.length) {
            const memoryBlock = pastRuns.reverse().map((r, i) =>
              `Run ${i + 1} (${r.completedAt?.toISOString().slice(0, 10)}): ${(r.output || "").slice(0, 500)}`
            ).join("\n\n");
            systemPrompt += `\n\n--- MEMORY FROM PREVIOUS RUNS ---\n${memoryBlock}\n--- END MEMORY ---`;
          }
        }

        const workflowSteps = JSON.parse(agent.workflow || "[]");
        const allStepText = [agent.systemPrompt || "", ...workflowSteps.map(s => s.content || "")].join(" ");
        const shouldVisualize = agent.visualize || /chart/i.test(allStepText);

        const userMessage = agentInput || "Execute the agent task now.";

        const { provider, client } = await getLLMClient();
        const { getToolDefinitions, getAnthropicToolDefinitions, executeTool } = require("../utils/tools/registry");
        const model = (await getSetting("llm_model")) || process.env.OPENAI_MODEL || "gpt-4o";
        const MAX_ROUNDS = agent.maxRounds || workspace.defaultAgentMaxRounds || 25;
        let fullOutput = "";
        let wasCancelled = false;
        const agentToolCallNames = [];
        const allRawResults = [];
        const hasWorkflow = (JSON.parse(agent.workflow || "[]")).length > 0;

        if (provider === "anthropic") {
          const tools = getAnthropicToolDefinitions(connectors);
          const msgs  = [{ role: "user", content: userMessage }];
          let madeToolCall = false;
          for (let round = 0; round < MAX_ROUNDS; round++) {
            const [crPre] = await req.db.$queryRaw`SELECT cancelRequested FROM AgentRun WHERE id = ${run.id}`;
            if (crPre?.cancelRequested) { wasCancelled = true; fullOutput = "⛔ Run stopped by user."; break; }
            const resp = await client.messages.create({ model: model || "claude-sonnet-4-6", max_tokens: 4096, system: systemPrompt, messages: msgs, tools: tools.length ? tools : undefined, temperature: 0.3 });
            if (resp.stop_reason !== "tool_use" || !tools.length) {
              if (hasWorkflow && tools.length && !madeToolCall && round === 0) {
                msgs.push({ role: "assistant", content: resp.content });
                msgs.push({ role: "user", content: "Do not plan or summarise. Call your first tool RIGHT NOW." });
                continue;
              }
              fullOutput = resp.content?.find(b => b.type === "text")?.text || ""; break;
            }
            madeToolCall = true;
            const toolUseBlocks = resp.content.filter(b => b.type === "tool_use");
            const names = toolUseBlocks.map(b => friendlyToolName(b.name, connectors));
            agentToolCallNames.push(...names);
            agentSafeWrite(`data: ${JSON.stringify({ tool_calls: names })}\n\n`);
            msgs.push({ role: "assistant", content: resp.content });
            const toolResults = [];
            for (const tb of toolUseBlocks) { const result = await executeTool(tb.name, tb.input, connectors, req.db); allRawResults.push(String(result)); toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: String(result) }); }
            msgs.push({ role: "user", content: toolResults });
            const [cr0] = await req.db.$queryRaw`SELECT cancelRequested FROM AgentRun WHERE id = ${run.id}`;
            if (cr0?.cancelRequested) { wasCancelled = true; fullOutput = "⛔ Run stopped by user."; break; }
            if (round === MAX_ROUNDS - 1) { const fr = await client.messages.create({ model: model || "claude-sonnet-4-6", max_tokens: 4096, system: systemPrompt, messages: msgs, temperature: 0.3 }); fullOutput = fr.content?.find(b => b.type === "text")?.text || ""; }
          }
        } else {
          const tools    = getToolDefinitions(connectors);
          const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
          let madeToolCall = false;
          for (let round = 0; round < MAX_ROUNDS; round++) {
            const [crPre] = await req.db.$queryRaw`SELECT cancelRequested FROM AgentRun WHERE id = ${run.id}`;
            if (crPre?.cancelRequested) { wasCancelled = true; fullOutput = "⛔ Run stopped by user."; break; }
            const reqBody = { model, messages, temperature: 0.3, max_tokens: 4096 };
            if (tools.length) { reqBody.tools = tools; reqBody.tool_choice = "auto"; }
            const resp   = await client.chat.completions.create(reqBody);
            const choice = resp.choices[0];
            if (choice.finish_reason !== "tool_calls" || !tools.length) {
              if (hasWorkflow && tools.length && !madeToolCall && round === 0) {
                messages.push(choice.message);
                messages.push({ role: "user", content: "Do not plan or summarise. Call your first tool RIGHT NOW." });
                continue;
              }
              fullOutput = choice.message.content || ""; break;
            }
            madeToolCall = true;
            messages.push(choice.message);
            const names = (choice.message.tool_calls || []).map(tc => friendlyToolName(tc.function.name, connectors));
            agentToolCallNames.push(...names);
            agentSafeWrite(`data: ${JSON.stringify({ tool_calls: names })}\n\n`);
            for (const tc of choice.message.tool_calls || []) {
              let args = {}; try { args = JSON.parse(tc.function.arguments); } catch { /**/ }
              const result = await executeTool(tc.function.name, args, connectors, req.db);
              allRawResults.push(String(result));
              messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
            }
            const [cr1] = await req.db.$queryRaw`SELECT cancelRequested FROM AgentRun WHERE id = ${run.id}`;
            if (cr1?.cancelRequested) { wasCancelled = true; fullOutput = "⛔ Run stopped by user."; break; }
            if (round === MAX_ROUNDS - 1) { const fr = await client.chat.completions.create({ model, messages, temperature: 0.3, max_tokens: 4096 }); fullOutput = fr.choices[0].message.content || ""; }
          }
        }

        // Final race-condition check — catches cancel set while last LLM call was in-flight
        if (!wasCancelled) {
          const [crFinal] = await req.db.$queryRaw`SELECT cancelRequested FROM AgentRun WHERE id = ${run.id}`;
          if (crFinal?.cancelRequested) { wasCancelled = true; fullOutput = "⛔ Run stopped by user."; }
        }

        if (wasCancelled) {
          await req.db.agentRun.update({ where: { id: run.id }, data: { status: "cancelled", output: fullOutput, completedAt: new Date() } });
          agentSafeWrite(`data: ${JSON.stringify({ done: true, content: `**@${agentSlug}** — Run stopped by user.`, agentRun: true })}\n\n`);
          if (!agentClientGone) res.end();
          return;
        }

        await req.db.agentRun.update({ where: { id: run.id }, data: { status: "success", output: fullOutput, completedAt: new Date() } });

        const { buildVisualization } = require("../utils/buildVisualization");
        const vizObj = shouldVisualize ? buildVisualization(allRawResults, allStepText) : null;
        if (vizObj) fullOutput = fullOutput.replace(/```[\w]*\n?[\s\S]*?```/g, "").trim();

        // Chain to next agent if configured
        const { maybeChain } = require("../utils/agentChain");
        maybeChain(agent, fullOutput, req.db, 0, { workspaceId: workspace.id, threadId }).catch(e => console.error("[chain]", e.message));

        const agentChains = agent.chains ? JSON.parse(agent.chains) : (agent.nextAgent ? [{ nextAgent: agent.nextAgent }] : []);
        const autoChains   = agentChains.filter(c => c.nextAgent && c.triggerType !== "manual");
        const manualChains = agentChains.filter(c => c.nextAgent && c.triggerType === "manual");
        const chainNote = [
          autoChains.length   ? `*🔗 Chaining to ${autoChains.map(c => `@${c.nextAgent}`).join(", ")}…*`       : "",
          manualChains.length ? `*⏸ Awaiting approval to run ${manualChains.map(c => `@${c.nextAgent}`).join(", ")} — check Approvals tab*` : "",
        ].filter(Boolean).map(s => `\n\n${s}`).join("");
        await req.db.chat.create({ data: { workspaceId: workspace.id, threadId, role: "assistant", content: `**@${agentSlug}** — ${fullOutput}${chainNote}`, toolCalls: agentToolCallNames.length ? JSON.stringify(agentToolCallNames) : null, visualization: vizObj ? JSON.stringify(vizObj) : null } });
        if (!agentClientGone) {
          res.write(`data: ${JSON.stringify({ done: true, content: `**@${agentSlug}** — ${fullOutput}${chainNote}`, sources: [], agentRun: true, visualization: vizObj || null })}\n\n`);
        }
      } catch (err) {
        await req.db.agentRun.update({ where: { id: run.id }, data: { status: "error", error: err.message, completedAt: new Date() } });
        if (!agentClientGone) res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }
      if (!agentClientGone) res.end();
      return;
    }
  }
  // ── end @mention routing ───────────────────────────────────────────────────

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
    // No sharing — use own results as-is
    sources = taggedOwn.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, topK);
  } else {
    // Guarantee each source (own + each shared workspace) a fair share of slots
    // so a high-scoring own workspace can't crowd out all shared content
    const numSources  = 1 + taggedSharedGroups.length;
    const baseSlots   = Math.floor(topK / numSources);
    const extraSlots  = topK - baseSlots * numSources;

    const byScore     = arr => [...arr].sort((a, b) => (b.score || 0) - (a.score || 0));
    const ownSorted   = byScore(taggedOwn);
    const sharedSorted = taggedSharedGroups.map(byScore);

    // Guaranteed slots from each source
    const guaranteed = [
      ...ownSorted.slice(0, baseSlots),
      ...sharedSorted.flatMap(arr => arr.slice(0, baseSlots)),
    ];
    // Remaining candidates compete for extra slots
    const remaining = [
      ...ownSorted.slice(baseSlots),
      ...sharedSorted.flatMap(arr => arr.slice(baseSlots)),
    ].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, extraSlots);

    sources = [...guaranteed, ...remaining].sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  const context = sources.map((s, i) => {
    const label = s._wsName ? `[Source ${i + 1} from "${s._wsName}"]` : `[Source ${i + 1}]`;
    return `${label}: ${s.text}`;
  }).join("\n\n");

  const history = await req.db.chat.findMany({
    where: { workspaceId: workspace.id, threadId },
    orderBy: { createdAt: "desc" },
    take: historyLimit
  });
  // desc + reverse() = ascending order (oldest→newest), most recent historyLimit messages
  // bypassDlp="warn": after reverse, ends with [..., original_user_msg, warn_notice] — skip both
  // normal: after reverse, ends with [..., current_user_msg] — skip 1
  const skipCount = bypassDlp === "warn" ? 2 : 1;
  const historyMessages = history.reverse().slice(0, -skipCount).reduce((acc, c) => {
    let content = c.content || "";
    if (c.role === "assistant") {
      // Exclude DLP-only messages (block/warn) — LLM should never see these
      if (content.startsWith("🚫 **Your message was blocked**") ||
          content.startsWith("⚠️ **Security Warning:**")) return acc;
      // Strip DLP notice prefix from audit/redact messages, keep only the LLM response
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

  // Load active connectors for this workspace
  const connectors = await req.db.connector.findMany({
    where: { workspaceId: workspace.id, status: "active" }
  });

  // ── DLP scan ────────────────────────────────────────────────────────────────
  let dlpNoticePrefix = "";
  if (!bypassDlp) {
    const { scanMessage } = require("../utils/dlpScanner");
    const dlpPolicies = workspace.dlpEnabled
      ? await req.db.dlpPolicy.findMany({ where: { enabled: true } })
      : [];
    if (dlpPolicies.length > 0) {
      const { blocked, violations, redactedText } = scanMessage(message, dlpPolicies);
      console.log("[DLP] violations:", violations.map(v => `${v.policyName}:${v.action}`), "| blocked:", blocked, "| bypassDlp:", bypassDlp);

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

      // 1. Block — reject entirely, save to DB
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

      // 2. Redact — auto: apply masking silently, prepend notice, continue to LLM
      const redactHits = violations.filter(v => v.action === "redact");
      if (redactHits.length > 0) {
        message = redactedText;
        const names = [...new Set(redactHits.map(v => v.policyName))].join(", ");
        dlpNoticePrefix = `> 🔒 **Redaction Notice:** Sensitive content was detected by the "${names}" policy. Your message has been redacted and logged before sending to the AI.\n\n`;
      }

      // 3. Warn — pause, ask user; save notice to DB immediately so it persists
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

      // 4. Audit — log only, prepend notice, continue to LLM
      const auditHits = violations.filter(v => v.action === "audit");
      if (auditHits.length > 0) {
        const names = [...new Set(auditHits.map(v => v.policyName))].join(", ");
        dlpNoticePrefix = `> 📋 **Audit Notice:** Your message was logged for compliance (${names}).\n\n`;
      }
    }
  }
  // ── End DLP ─────────────────────────────────────────────────────────────────

  const refusalMsg = workspace.queryRefusalResponse ||
    "There is no relevant information in this workspace to answer your query.";

  const basePrompt = workspace.systemPrompt ||
`You are a knowledgeable AI assistant for this workspace. You have access to the following capabilities — use them in this priority order:

1. INGESTED DOCUMENT CONTEXT (highest priority)
   - The Document Context section below contains text extracted from files uploaded or ingested into this workspace, including files shared from other workspaces.
   - Sources labelled [Source N] are from this workspace. Sources labelled [Source N from "Workspace Name"] are from a shared workspace called "Workspace Name".
   - Always answer from this context first. Present all relevant data, tables, and details exactly as found. Do not summarise or truncate.
   - If the context contains a partial dataset (e.g. sample rows from a CSV), present what is available and note it may be a sample.

2. LIVE CONNECTORS / TOOLS (only when context is insufficient)
   - If the document context does not contain the answer and live connectors are available, use them to fetch real-time data.
   - Use connectors ONLY for live queries (current records, counts, status) — not for data already present in the document context.

3. AGENTS (triggered by @mention in user messages)
   - Agents from this workspace or shared workspaces can be triggered with @agentslug.
   - When a user mentions @agentslug, route the task to that agent.

STRICT RULES:
- Answer ONLY from the provided context, tool results, or agent outputs. Do NOT use general knowledge or outside information.
- Provide thorough, complete, and well-structured answers.
- Include all relevant details, steps, lists, or tables present in the source documents.
- If a process has multiple steps, list every step in full.
- Use bullet points, numbered lists, or markdown tables when the answer contains multiple items.
- Only respond with the refusal message if there is genuinely no relevant information anywhere in the context or tool results.`;

  const docSection = context.length > 0
    ? `\n\n--- Document Context ---\n${context}\n--- End of Context ---\n\nThe context above contains the relevant data from ingested files. Present all data, tables, lists, or information from it that helps answer the question. If the context contains only a partial dataset (e.g. a sample of rows), present what is available and note it may be a sample. Only use the response "${refusalMsg}" if the context contains absolutely no information related to the question.`
    : `\n\nNo documents found in this workspace. Respond with: "${refusalMsg}"`;

  // Only expose connectors in the prompt when we'll actually use them (no RAG context found)
  const connectorSection = connectors.length > 0 && context.length === 0
    ? `\n\n--- Live Connectors ---\n${connectors.map(c => `- ${c.name} (${c.type})`).join("\n")}
Use these connectors to fetch live data. If no relevant data is found via connectors, respond with: "${refusalMsg}"
--- End of Connectors ---`
    : "";

  const guardrail = `STRICT OUTPUT CONSTRAINT: You are a workspace-scoped assistant. You MUST follow these rules above everything else:
1. Answer ONLY from the Document Context or tool results provided below.
2. If the answer is not in the context, respond with ONLY this exact text: "${refusalMsg}" — nothing else.
3. Do NOT generate safety warnings, disclaimers, privacy advice, or any content not found in the context.
4. Do NOT use phrases like "I'm sorry", "I can't assist", "I should warn you", or any variation. Your only allowed non-answer is: "${refusalMsg}"

`;

  const systemPrompt = guardrail + basePrompt + connectorSection + docSection;

  let fullResponse = "";
  let inputTokens  = 0;
  let outputTokens = 0;
  let allToolCallNames = [];
  let clientGone = false;
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

    // ── Tool calling path (connectors active AND no RAG context found) ──
    // If RAG already found relevant ingested content, skip connectors and answer from context.
    if (connectors.length > 0 && context.length === 0) {
      const allowed = await canRunAgent(req.db);
      if (!allowed) {
        const tier = await getTierFromDB(req.db);
        res.write(`data: ${JSON.stringify({ error: `Agent run limit reached. Max ${tier.maxAgentRunsPerMonth} agent runs allowed per month.` })}\n\n`);
        res.end();
        return;
      }
      await incrementAgentRun(req.db);

      const MAX_TOOL_ROUNDS = 5;

      if (provider === "anthropic") {
        const tools    = getAnthropicToolDefinitions(connectors);
        const msgs     = [...historyMessages, { role: "user", content: message }];

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const resp = await client.messages.create({
            model:      model || "claude-3-5-sonnet-20241022",
            max_tokens: 4096,
            system:     systemPrompt,
            messages:   msgs,
            tools,
            temperature,
          });

          inputTokens  += resp.usage?.input_tokens  || 0;
          outputTokens += resp.usage?.output_tokens || 0;

          if (resp.stop_reason !== "tool_use") {
            fullResponse = resp.content?.[0]?.text || "";
            break;
          }

          const toolUseBlocks = resp.content.filter(b => b.type === "tool_use");
          const names = toolUseBlocks.map(b => friendlyToolName(b.name, connectors));
          allToolCallNames.push(...names);
          res.write(`data: ${JSON.stringify({ tool_calls: names })}\n\n`);

          msgs.push({ role: "assistant", content: resp.content });
          const toolResults = [];
          for (const tb of toolUseBlocks) {
            const result = await executeTool(tb.name, tb.input, connectors, req.db);
            toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: String(result) });
          }
          msgs.push({ role: "user", content: toolResults });

          // Safety: on last round force a final answer without tools
          if (round === MAX_TOOL_ROUNDS - 1) {
            const finalResp = await client.messages.create({
              model: model || "claude-3-5-sonnet-20241022",
              max_tokens: 4096, system: systemPrompt, messages: msgs, temperature,
            });
            fullResponse  = finalResp.content?.[0]?.text || "";
            inputTokens  += finalResp.usage?.input_tokens  || 0;
            outputTokens += finalResp.usage?.output_tokens || 0;
          }
        }

        res.write(`data: ${JSON.stringify({ chunk: fullResponse })}\n\n`);

      } else {
        // OpenAI-compatible multi-round tool calling
        const tools    = getToolDefinitions(connectors);
        const messages = [
          { role: "system", content: systemPrompt },
          ...historyMessages,
          { role: "user", content: message }
        ];

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const resp = await client.chat.completions.create({
            model, messages, tools, tool_choice: "auto", temperature, max_tokens: 4096,
          });

          inputTokens  += resp.usage?.prompt_tokens     || 0;
          outputTokens += resp.usage?.completion_tokens || 0;

          const choice = resp.choices[0];

          if (choice.finish_reason !== "tool_calls") {
            fullResponse = choice.message.content || "";
            break;
          }

          const toolCalls = choice.message.tool_calls || [];
          const names = toolCalls.map(tc => friendlyToolName(tc.function.name, connectors));
          allToolCallNames.push(...names);
          res.write(`data: ${JSON.stringify({ tool_calls: names })}\n\n`);

          messages.push(choice.message);
          for (const tc of toolCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments); } catch { /* invalid json */ }
            const result = await executeTool(tc.function.name, args, connectors, req.db);
            messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
          }

          // Safety: on last round force a final answer without tools
          if (round === MAX_TOOL_ROUNDS - 1) {
            const finalResp = await client.chat.completions.create({
              model, messages, temperature, max_tokens: 4096,
            });
            fullResponse  = finalResp.choices[0].message.content || "";
            inputTokens  += finalResp.usage?.prompt_tokens     || 0;
            outputTokens += finalResp.usage?.completion_tokens || 0;
          }
        }

        res.write(`data: ${JSON.stringify({ chunk: fullResponse })}\n\n`);
      }

    // ── Standard streaming path (no connectors) ────────────────────────────
    } else if (provider === "anthropic") {
      const userMsgs = [...historyMessages, { role: "user", content: message }];
      const stream = await client.messages.create({
        model: model || "claude-3-5-sonnet-20241022",
        max_tokens: 4096,
        system: systemPrompt,
        messages: userMsgs,
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
      const allMessages = [{ role: "system", content: systemPrompt }, ...historyMessages, { role: "user", content: message }];
      const stream = await client.chat.completions.create({
        model,
        messages: allMessages,
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

    const sourcesData = sources.length > 0
      ? JSON.stringify(sources.map(s => ({ text: s.text.slice(0, 200), metadata: s.metadata })))
      : null;

    // Normalize LLM refusal phrasings to the workspace-configured refusal message
    const normalizedFull = normalizeRefusal(fullResponse, refusalMsg);
    const wasNormalized = normalizedFull !== fullResponse;
    if (wasNormalized) fullResponse = normalizedFull;

    await req.db.chat.create({
      data: {
        workspaceId: workspace.id,
        threadId,
        userId:      chatUserId,
        role:        "assistant",
        content:     dlpNoticePrefix + fullResponse,
        sources:     sourcesData,
        toolCalls:   allToolCallNames?.length ? JSON.stringify(allToolCallNames) : null,
        inputTokens,
        outputTokens,
        model
      }
    });

    if (!clientGone) {
      const doneEvt = { done: true, sources };
      // If response was normalized, send corrected content so frontend replaces accumulated text
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
