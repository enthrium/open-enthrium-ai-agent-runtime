const router   = require("express").Router();
const http     = require("http");
const { authenticate } = require("../middleware/auth");
const { similaritySearch } = require("../utils/vectorStore");
const { getLLMClient, getSetting } = require("../providers/llm");
const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ── Chat agent run tracking ────────────────────────────────────────────────────
// Persists across HTTP requests within the same server process (MCP chain spans two requests)
const pendingChatRunMap    = new Map(); // chainId → projectRunId

// ── Native chain approval state ───────────────────────────────────────────────
// Stores paused chain state when a manual-approval skill is reached in run_agent.
// chainId → { remainingSkills, completedOutputs, connectors, llmConfig, agentInput, doc, absPath, pa }
const pendingNativeChainMap = new Map();

// ── MCP helpers ───────────────────────────────────────────────────────────────
let _mcpReqId = 1;

function mcpJsonRpcToUrl(serverUrl, method, params = {}, apiKey = null) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: _mcpReqId++, method, params });
    const parsed = new URL(serverUrl.endsWith("/mcp") ? serverUrl : `${serverUrl}/mcp`);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? require("https") : http;
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname,
      method:   "POST",
      headers,
    };
    const req = transport.request(opts, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ result: null }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("MCP timeout")); });
    req.write(body);
    req.end();
  });
}

// Returns { tools, toolServerMap: Map<toolName, { url, apiKey }> }
async function getMcpTools(db) {
  const allTools = [];
  const toolServerMap = new Map();
  try {
    const servers = await db.mcpServer.findMany({ where: { enabled: true }, orderBy: { id: "asc" } });
    await Promise.all(servers.map(async srv => {
      try {
        const res = await mcpJsonRpcToUrl(srv.url, "tools/list", {}, srv.apiKey);
        const tools = res.result?.tools || [];
        for (const t of tools) {
          if (!toolServerMap.has(t.name)) {
            toolServerMap.set(t.name, { url: srv.url, apiKey: srv.apiKey });
            allTools.push(t);
          }
        }
      } catch { /* server unavailable — skip */ }
    }));
  } catch { /* db error — return empty */ }
  return { tools: allTools, toolServerMap };
}

async function callMcpTool(name, toolArgs, toolServerMap) {
  const srv = toolServerMap?.get(name);
  if (!srv) return `MCP error: unknown tool "${name}"`;
  try {
    const res = await mcpJsonRpcToUrl(srv.url, "tools/call", { name, arguments: toolArgs || {} }, srv.apiKey);
    if (res.error) return `Error: ${res.error.message}`;
    const content = res.result?.content || [];
    return content.map(c => c.text || JSON.stringify(c)).join("\n").slice(0, 8000);
  } catch (err) { return `MCP error: ${err.message}`; }
}

// ── Read available agents from DB (source of truth for agent.yaml + oe-config) ─
// SKILL.md lives on disk; agent.yaml lives only in DB (ProjectAgent.yamlContent).
async function getAgentsContext(db, workspaceId) {
  try {
    const agents = await db.projectAgent.findMany({
      where: { project: { workspaceId } },
      select: { name: true, description: true, folderPath: true },
      orderBy: { createdAt: "asc" },
    });
    if (!agents.length) return null;
    const list = agents.map(a => `  • ${a.name}${a.description ? " — " + a.description : ""}`).join("\n");
    return `\nAVAILABLE AUTOMATION AGENTS:\n${list}`;
  } catch { return null; }
}

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

  const agentsContext = await getAgentsContext(req.db, workspace.id);
  const systemPrompt  = guardrail + basePrompt + docSection + (agentsContext || "");

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

    // ── Try MCP (non-blocking — falls back to plain chat if MCP is down) ──
    const { tools: mcpTools, toolServerMap } = await getMcpTools(req.db).catch(() => ({ tools: [], toolServerMap: new Map() }));
    const hasMcpTools = mcpTools.length > 0;

    // Build a human-readable summary of available data connectors for the system prompt
    // Read connector names from the DB (the built-in OE MCP server's connectorConfig)
    const connectorSummary = await (async () => {
      try {
        const defaultSrv = await req.db.mcpServer.findFirst({ where: { isDefault: true, enabled: true } });
        if (!defaultSrv?.connectorConfig) return "";
        const cfg = JSON.parse(defaultSrv.connectorConfig);
        const connectors = cfg.connectors || [];
        if (connectors.length === 0) return "";
        const lines = connectors.map((c, i) => `- ${c.name} (${c.type}) → tools: conn_${i + 1}_*`);
        return `\n\nAVAILABLE DATA CONNECTORS:\n${lines.join("\n")}\nThese are the data sources you can query. When asked to list connectors or data sources, enumerate them from the list above — do not call log_list or any other tool just to answer that question.`;
      } catch { return ""; }
    })();

    // When tools are available relax the strict doc-only guardrail
    const effectiveSystem = hasMcpTools
      ? basePrompt + docSection + (agentsContext || "") + connectorSummary + `

You also have access to automation tools (listed in your tool definitions). Follow these rules when using tools:

DATABASE QUERIES: Never guess column or table names. Always explore the schema first:
1. Call the query tool with: SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' (postgres) or SHOW TABLES (mysql)
2. Then DESCRIBE or SELECT column_name FROM information_schema.columns WHERE table_name = '...' to get columns
3. Only then write the business query using the real column names

AGENTS: When the user asks to run an agent, call list_agents first to get the file path, then call run_agent with that path. Never tell the user to go to the Projects section — run it directly using the tools.
- If run_agent returns a pending_skill_chain, ALWAYS include the chain_id verbatim in your reply, e.g.: "A manual skill is waiting — **[skill_name]** — approve, skip, or abort? (chain_id: \`abc123\`)". This is critical so the chain_id is preserved in conversation history.
- When the user says approve / skip / abort: if the user message contains chain_id:\`...\`, extract and use that chain_id directly. Otherwise look for the chain_id in your previous message in this conversation. If you cannot find it, call list_pending_skills first to get the current chain_id.
- Call approve_chain with the chain_id and: approved:true = run the skill; approved:false = skip and continue; abort:true = stop the pipeline.
- Never ask the user to supply the chain_id themselves.
CHARTS: If the user's message contains words like "chart", "graph", "visualize", or "plot", you MUST output the data ONLY as a \`\`\`chart JSON block — never as a markdown table, never as prose. Format (strict):
\`\`\`chart
{"type":"bar","labels":["Label1","Label2"],"datasets":[{"label":"Series","data":[10,20]}]}
\`\`\`
Supported types: bar, line, pie. Use real data from the query. This is mandatory — do not tell the user to use Excel or any external tool.

GENERAL: After tool results, summarize clearly. If a tool errors, try an alternative approach before giving up.`
      : systemPrompt;

    const MAX_TOOL_ROUNDS = 25;

    // ── Platform-native agent tools ───────────────────────────────────────────
    // list_agents + run_agent are handled here using req.db + engine directly.
    // agent.yaml comes from DB; SKILL.md (raw source) comes from disk.
    // approve_chain is also handled natively for platform chains (no MCP needed).
    const PLATFORM_AGENT_TOOLS = new Set(["list_agents", "run_agent", "approve_chain"]);

    async function callPlatformAgentTool(name, toolInput) {
      // ── list_agents ──────────────────────────────────────────────────────────
      if (name === "list_agents") {
        const agents = await req.db.projectAgent.findMany({
          where:   { project: { workspaceId: workspace.id } },
          select:  { name: true, description: true, folderPath: true },
          orderBy: { createdAt: "asc" },
        });
        if (!agents.length) return "No agents available in this workspace.";
        return agents.map(a =>
          `• ${a.name}${a.description ? ": " + a.description : ""}\n  file: ${a.folderPath}`
        ).join("\n\n");
      }

      // ── run_agent ────────────────────────────────────────────────────────────
      if (name === "run_agent") {
        const { file, input: agentInput = "" } = toolInput || {};
        if (!file) return "Error: file path is required";

        // Find agent in DB by folderPath (normalize slashes)
        const normalised = path.resolve(file);
        const folderName = path.basename(normalised);
        let pa = await req.db.projectAgent.findFirst({
          where: { folderPath: normalised, project: { workspaceId: workspace.id } },
          include: { project: true },
        });
        if (!pa) pa = await req.db.projectAgent.findFirst({
          where: { folderPath: { endsWith: folderName }, project: { workspaceId: workspace.id } },
          include: { project: true },
        });
        if (!pa) return `Agent not found: ${file}`;

        // agent.yaml from DB (source of truth)
        const yamlContent = pa.yamlContent || "";
        const doc = (() => { try { return yaml.load(yamlContent) || {}; } catch { return {}; } })();
        const absPath = path.isAbsolute(pa.folderPath)
          ? pa.folderPath
          : path.resolve(__dirname, "../../../", pa.folderPath);

        // Connectors from DB oeConfig — built identically to workspaces.js run endpoint
        const oeConfigObj = (() => { try { return JSON.parse(pa.project?.oeConfig || "{}"); } catch { return {}; } })();
        const refNames = (doc.connectors || []).map(c => c.connection_name);
        let connectors = (oeConfigObj.connectors || []).map((c, i) => {
          const { connection_name, connection_type, ...creds } = c;
          if (connection_type === "shell" && (!creds.cwd || creds.cwd === ".")) creds.cwd = absPath;
          return {
            id:         i + 1,
            name:       connection_name,
            type:       connection_type,
            status:     "active",
            authConfig: JSON.stringify(creds),
            config:     JSON.stringify(creds),
            ...creds,
          };
        });
        if (refNames.length) connectors = connectors.filter(c => refNames.includes(c.name));

        const { getLLMConfig } = require("../providers/llm");
        const { executeTool }  = require("../utils/tools/registry");
        const engine           = require("../engine");
        const llmConfig        = await getLLMConfig();

        // Helper: strip YAML frontmatter from SKILL.md
        function stripFrontmatter(s) {
          const t = (s || "").trim();
          if (!t.startsWith("---")) return t;
          const end = t.indexOf("---", 3);
          return end === -1 ? t : t.slice(end + 3).trim();
        }

        // Helper: resolve and read SKILL.md for one skill entry (path or name)
        function readSkillMd(skillEntry) {
          const skillPath = skillEntry?.path || skillEntry?.name || skillEntry;
          if (!skillPath) return "";
          const sub = path.isAbsolute(String(skillPath))
            ? String(skillPath)
            : path.resolve(absPath, String(skillPath));
          try { return fs.readFileSync(path.join(sub, "SKILL.md"), "utf8"); } catch { return ""; }
        }

        // Shared helper: run one skill and return output string
        async function runOneSkill(prompt, stepInput) {
          const agentSpec = {
            systemPrompt: prompt,
            workflow:     (doc.steps || []).map(s => ({ name: s.name || "", content: s.content || "" })),
            params:       [],
            maxRounds:    25,
            input:        stepInput,
          };
          const r = await engine.run(agentSpec, llmConfig, connectors, {
            toolExecutor: (tname, targs, conns) => executeTool(tname, targs, conns, req.db),
            onToolCall:   () => {},
            onToolResult: () => {},
          });
          return r.output || "";
        }

        // Build step input for index i, given prior outputs
        function buildStepInput(i, priorOutputs) {
          return i === 0
            ? (agentInput || "Execute the task now.")
            : `${agentInput ? agentInput + "\n\n" : ""}Context from previous steps:\n\n${priorOutputs.map((o, j) => `**Step ${j + 1}:**\n${o}`).join("\n\n")}\n\nNow execute your step.`;
        }

        try {
          // Chain agent: skills[] array in yaml → run each skill in sequence, pausing at manual ones
          if (Array.isArray(doc.skills) && doc.skills.length > 0) {
            const outputs = [];

            for (let i = 0; i < doc.skills.length; i++) {
              const skillEntry = doc.skills[i];
              const skillName  = skillEntry?.name || skillEntry?.path || `Step ${i + 1}`;
              const isManual   = skillEntry?.approval === "manual" || skillEntry?.type === "manual" || skillEntry?.trigger_type === "manual";

              if (isManual) {
                // Pause here — store remaining skills and context for approve_chain to resume
                const chainId = `native-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                pendingNativeChainMap.set(chainId, {
                  remainingSkills:  doc.skills.slice(i),   // includes this manual skill
                  completedOutputs: outputs,
                  connectors, llmConfig, agentInput,
                  doc, absPath, pa,
                  readSkillMd, stripFrontmatter, buildStepInput, runOneSkill,
                });

                return `✋ Paused — manual approval required for **${skillName}**.\n\nchain_id: \`${chainId}\`\n\nSay **approve** to run this step, or **cancel** to stop.`;
              }

              // Auto skill — run immediately, stream output directly to chat
              const skillMd = readSkillMd(skillEntry);
              const prompt  = stripFrontmatter(skillMd) || doc.instructions || doc.system_prompt || doc.systemPrompt || "";
              const t0auto  = Date.now();
              const out     = await runOneSkill(prompt, buildStepInput(i, outputs));
              outputs.push(out);

              // Persist this skill run to the log (use actual trigger_type from agent.yaml)
              try {
                const rawPath  = (skillEntry?.path || "").replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/$/, "");
                const skName   = rawPath && rawPath !== "." ? rawPath.split("/").pop() : null;
                const skTrigger   = (skillEntry?.trigger_type || skillEntry?.triggerType || "auto").toLowerCase();
                await req.db.projectRun.create({ data: {
                  projectId: pa.projectId, agentId: pa.id,
                  triggeredByUserId: chatUserId || null,
                  triggerType: skTrigger, triggeredFrom: "chat", skillName: skName,
                  status: "success", input: agentInput || null, output: out,
                  startedAt: new Date(t0auto), completedAt: new Date(),
                }});
              } catch {}

              // Stream this step's output to chat now so the user sees it without LLM summarization
              // Also accumulate into fullResponse so it's saved to DB and re-renders on page reload
              const autoChunk = `\n\n**▶ ${skillName}** (auto):\n${out}\n`;
              fullResponse += autoChunk;
              safeWrite(`data: ${JSON.stringify({ chunk: autoChunk })}\n\n`);
            }

            // All skills completed without a manual gate
            return `Chain complete — all ${outputs.length} auto skill(s) ran.`;

          } else {
            // Single-skill agent: root SKILL.md or first-skills[0] fallback
            let skillDir = absPath;
            if (!fs.existsSync(path.join(absPath, "SKILL.md"))) {
              const s = (doc.skills || [])[0];
              if (s?.path) {
                const sub = path.isAbsolute(s.path) ? s.path : path.resolve(absPath, s.path);
                if (fs.existsSync(sub)) skillDir = sub;
              }
            }
            let skillContent = "";
            try { skillContent = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"); } catch {}

            const agentSpec = {
              systemPrompt: stripFrontmatter(skillContent) || doc.instructions || doc.system_prompt || doc.systemPrompt || "",
              workflow:     (doc.steps || []).map(s => ({ name: s.name || "", content: s.content || "" })),
              params:       [],
              maxRounds:    25,
              input:        agentInput,
            };

            const result = await engine.run(agentSpec, llmConfig, connectors, {
              toolExecutor: (tname, targs, conns) => executeTool(tname, targs, conns, req.db),
              onToolCall:   () => {},
              onToolResult: () => {},
            });
            return result.output || "Agent completed with no output.";
          }
        } catch (err) {
          return `Agent error: ${err.message}`;
        }
      }

      // ── approve_chain (native) ────────────────────────────────────────────────
      if (name === "approve_chain") {
        const chainId = (toolInput?.chain_id || toolInput?.chainId || "").trim();
        const isAbort = toolInput?.abort === true;

        const state = pendingNativeChainMap.get(chainId);
        if (!state) {
          // Not a native chain — delegate to MCP
          return await callMcpTool("approve_chain", toolInput, toolServerMap);
        }

        pendingNativeChainMap.delete(chainId);

        if (isAbort) return "Chain cancelled.";

        const { remainingSkills, completedOutputs, doc: sd, absPath: sabs, connectors: sconns, llmConfig: sllm, agentInput: sInput, pa: spa } = state;

        // Reconstruct helpers using stored closures
        const { readSkillMd, stripFrontmatter, buildStepInput, runOneSkill } = state;

        const outputs = [...completedOutputs];
        const startIdx = completedOutputs.length; // global step index offset

        for (let j = 0; j < remainingSkills.length; j++) {
          const skillEntry = remainingSkills[j];
          const skillName  = skillEntry?.name || skillEntry?.path || `Step ${startIdx + j + 1}`;
          const isManual   = skillEntry?.approval === "manual" || skillEntry?.type === "manual" || skillEntry?.trigger_type === "manual";

          if (isManual && j > 0) {
            // Another manual gate in the remaining chain — pause again
            const nextId = `native-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            pendingNativeChainMap.set(nextId, { ...state, remainingSkills: remainingSkills.slice(j), completedOutputs: outputs });
            const soFar = outputs.length
              ? "\n\nCompleted steps so far:\n" + outputs.map((o, k) => `**Step ${k + 1}:** ${o.slice(0, 200)}${o.length > 200 ? "…" : ""}`).join("\n\n")
              : "";
            return `✋ **Manual approval required** for step **${skillName}**.${soFar}\n\nCall \`approve_chain\` with \`chain_id: "${nextId}"\` to continue.`;
          }

          const skillMd  = readSkillMd(skillEntry);
          const prompt   = stripFrontmatter(skillMd) || sd.instructions || sd.system_prompt || sd.systemPrompt || "";
          const t0aprv   = Date.now();
          const out      = await runOneSkill(prompt, buildStepInput(startIdx + j, outputs));
          outputs.push(out);

          // Persist this skill run to the log (use actual trigger_type from agent.yaml)
          if (!spa) console.warn("[native-chain log] spa (pa) missing from state — skill not logged");
          if (spa) {
            try {
              const rawPath2  = (skillEntry?.path || "").replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/$/, "");
              const skName    = rawPath2 && rawPath2 !== "." ? rawPath2.split("/").pop() : null;
              const skTrigger = (skillEntry?.trigger_type || skillEntry?.triggerType || (isManual ? "manual" : "auto")).toLowerCase();
              await req.db.projectRun.create({ data: {
                projectId: spa.projectId, agentId: spa.id,
                triggeredByUserId: chatUserId || null,
                triggerType: skTrigger, triggeredFrom: "chat", skillName: skName,
                status: "success", input: sInput || null, output: out,
                startedAt: new Date(t0aprv), completedAt: new Date(),
              }});
            } catch(e) { console.error("[native-chain log] approve skill save failed:", e.message); }
          }

          // Stream this step's output to chat directly; accumulate so it's saved to DB
          const approvedChunk = `\n\n**▶ ${skillName}** (approved):\n${out}\n`;
          fullResponse += approvedChunk;
          safeWrite(`data: ${JSON.stringify({ chunk: approvedChunk })}\n\n`);
        }

        return `Chain complete — all ${outputs.length} skill(s) ran.`;
      }
    }

    // Routes tool calls: platform-native for agent tools, MCP for everything else
    async function callTool(name, toolInput) {
      if (PLATFORM_AGENT_TOOLS.has(name)) return await callPlatformAgentTool(name, toolInput);
      return await callMcpTool(name, toolInput, toolServerMap);
    }

    // ── Chat-triggered agent run tracking ────────────────────────────────────
    // Mirrors project-page runs (triggerType="chat") so they appear in run logs.
    // pendingChatRunMap (module-level) bridges run_agent and approve_chain across requests.

    async function trackAgentTool(toolName, toolInput, result) {
      try {
        if (toolName === "run_agent") {
          const agentFile = toolInput.file;
          if (!agentFile) return;
          // path.resolve normalises slashes (forward→back on Windows)
          // so "D:/agents/chain-starter" matches DB "D:\\agents\\chain-starter"
          const agentDir  = path.resolve(path.dirname(agentFile));
          const folderName = path.basename(agentDir);
          let pa = await req.db.projectAgent.findFirst({
            where: { folderPath: agentDir, project: { workspaceId: workspace.id } },
          });
          // Fallback: match by last folder segment (handles any remaining slash differences)
          if (!pa) {
            pa = await req.db.projectAgent.findFirst({
              where: { folderPath: { endsWith: folderName }, project: { workspaceId: workspace.id } },
            });
          }
          if (!pa) return; // file-only agent with no project — skip

          // Extract chain_id if MCP paused for manual approval
          const chainMatch = result.match(/chain_id\s*:\s*([a-zA-Z0-9_-]+)/);
          const isPending  = !!chainMatch;
          const chainId    = chainMatch?.[1]?.trim() || null;

          const run = await req.db.projectRun.create({
            data: {
              projectId:         pa.projectId,
              agentId:           pa.id,
              triggeredByUserId: chatUserId,
              triggerType:       "chat",
              triggeredFrom:     "chat",
              status:            isPending ? "pending" : "success",
              input:             toolInput.input || null,
              output:            isPending ? null : result,
              completedAt:       isPending ? null : new Date(),
              startedAt:         new Date(),
            },
          });

          // Store runId in module-level Map so approve_chain (next request) can find it
          if (isPending && chainId) pendingChatRunMap.set(chainId, run.id);
        }

        if (toolName === "approve_chain") {
          const chainId = (toolInput.chain_id || toolInput.chainId || "").trim();
          if (!chainId) return;

          const runId = pendingChatRunMap.get(chainId);
          if (!runId) return; // not a chat-triggered run (e.g. agent-page run)

          const isAbort = toolInput.abort === true;
          const isError = result.toLowerCase().includes("error") || result.toLowerCase().includes("failed");
          const status  = isAbort ? "cancelled" : (isError ? "error" : "success");

          await req.db.projectRun.update({
            where: { id: runId },
            data:  { status, output: result, completedAt: new Date() },
          });
          pendingChatRunMap.delete(chainId); // clean up
        }
      } catch (e) {
        console.warn("[Chat] Agent run tracking failed:", e.message);
      }
    }

    // ── Anthropic path ─────────────────────────────────────────────────────
    if (provider === "anthropic") {
      if (hasMcpTools) {
        // Tool-aware streaming loop
        const anthropicTools = mcpTools.map(t => ({
          name: t.name, description: t.description,
          input_schema: t.inputSchema || { type: "object", properties: {} },
        }));
        const msgs = [...historyMessages, { role: "user", content: message }];

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const stream = await client.messages.create({
            model: model || "claude-sonnet-4-6", max_tokens: 4096,
            system: effectiveSystem, messages: msgs,
            tools: anthropicTools, temperature, stream: true,
          });

          let stopReason = "";
          const blocks   = {};   // index → block accumulator
          let   textAcc  = "";

          for await (const ev of stream) {
            if (ev.type === "message_start")  inputTokens  += ev.message?.usage?.input_tokens  || 0;
            if (ev.type === "message_delta")  { outputTokens += ev.usage?.output_tokens || 0; stopReason = ev.delta?.stop_reason || stopReason; }
            if (ev.type === "content_block_start") blocks[ev.index] = { ...ev.content_block, _jsonAcc: "" };
            if (ev.type === "content_block_delta") {
              const b = blocks[ev.index];
              if (!b) continue;
              if (ev.delta.type === "text_delta") {
                textAcc      += ev.delta.text;
                fullResponse += ev.delta.text;
                safeWrite(`data: ${JSON.stringify({ chunk: ev.delta.text })}\n\n`);
              } else if (ev.delta.type === "input_json_delta") {
                b._jsonAcc += ev.delta.partial_json;
              }
            }
          }

          if (stopReason === "tool_use") {
            // Reconstruct full assistant message
            const assistantContent = Object.values(blocks).map(b => {
              if (b.type === "text")     return { type: "text", text: textAcc };
              if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: JSON.parse(b._jsonAcc || "{}") };
              return b;
            });
            msgs.push({ role: "assistant", content: assistantContent });

            const toolResults = [];
            for (const b of Object.values(blocks).filter(b => b.type === "tool_use")) {
              const toolInput = JSON.parse(b._jsonAcc || "{}");
              safeWrite(`data: ${JSON.stringify({ tool_call: b.name })}\n\n`);
              const result = await callTool(b.name, toolInput);
              await trackAgentTool(b.name, toolInput, result);
              toolResults.push({ type: "tool_result", tool_use_id: b.id, content: result });
            }
            msgs.push({ role: "user", content: toolResults });
          } else {
            break; // end_turn — text already streamed above
          }
        }
      } else {
        // Plain streaming (no tools)
        const stream = await client.messages.create({
          model: model || "claude-sonnet-4-6", max_tokens: 4096,
          system: effectiveSystem,
          messages: [...historyMessages, { role: "user", content: message }],
          temperature, stream: true,
        });
        for await (const ev of stream) {
          if (ev.type === "message_start")  inputTokens  = ev.message?.usage?.input_tokens  || 0;
          if (ev.type === "message_delta")  outputTokens = ev.usage?.output_tokens || 0;
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            const chunk = ev.delta.text;
            fullResponse += chunk;
            safeWrite(`data: ${JSON.stringify({ chunk })}\n\n`);
          }
        }
      }

    // ── OpenAI / Ollama path ───────────────────────────────────────────────
    } else {
      if (hasMcpTools) {
        // Tool-aware streaming loop
        const openaiTools = mcpTools.map(t => ({
          type: "function",
          function: {
            name: t.name, description: t.description,
            parameters: t.inputSchema || { type: "object", properties: {} },
          },
        }));
        const msgs = [{ role: "system", content: effectiveSystem }, ...historyMessages, { role: "user", content: message }];

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const stream = await client.chat.completions.create({
            model, messages: msgs, tools: openaiTools, tool_choice: "auto",
            max_tokens: 4096, temperature, stream: true,
            ...(provider === "openai" ? { stream_options: { include_usage: true } } : {}),
          });

          let   finishReason   = "";
          const tcAccum        = {};   // index → {id, name, args}
          let   roundHasTools  = false;

          for await (const part of stream) {
            if (part.usage) {
              inputTokens  += part.usage.prompt_tokens     || 0;
              outputTokens += part.usage.completion_tokens || 0;
            }
            const choice = part.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;

            const delta = choice.delta;
            if (delta.content) {
              fullResponse += delta.content;
              safeWrite(`data: ${JSON.stringify({ chunk: delta.content })}\n\n`);
            }
            if (delta.tool_calls) {
              roundHasTools = true;
              for (const tc of delta.tool_calls) {
                if (!tcAccum[tc.index]) tcAccum[tc.index] = { id: "", name: "", args: "" };
                if (tc.id)                     tcAccum[tc.index].id   += tc.id;
                if (tc.function?.name)         tcAccum[tc.index].name += tc.function.name;
                if (tc.function?.arguments)    tcAccum[tc.index].args += tc.function.arguments;
              }
            }
          }

          if (finishReason === "tool_calls" || roundHasTools) {
            const toolCallsList = Object.values(tcAccum);
            msgs.push({
              role: "assistant",
              // Gemini's OpenAI-compat endpoint rejects content:null — use "" which works for all providers
              content: "",
              tool_calls: toolCallsList.map(tc => ({
                id: tc.id, type: "function",
                function: { name: tc.name, arguments: tc.args },
              })),
            });
            for (const tc of toolCallsList) {
              safeWrite(`data: ${JSON.stringify({ tool_call: tc.name })}\n\n`);
              const toolInput = JSON.parse(tc.args || "{}");
              const result = await callTool(tc.name, toolInput);
              await trackAgentTool(tc.name, toolInput, result);
              msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
            }
          } else {
            break; // stop — text already streamed
          }
        }

        if (!inputTokens && !outputTokens && fullResponse) {
          inputTokens  = Math.ceil((effectiveSystem.length + message.length) / 4);
          outputTokens = Math.ceil(fullResponse.length / 4);
        }
      } else {
        // Plain streaming (no tools)
        const stream = await client.chat.completions.create({
          model,
          messages: [{ role: "system", content: effectiveSystem }, ...historyMessages, { role: "user", content: message }],
          temperature, max_tokens: 4096, stream: true,
          ...(provider === "openai" ? { stream_options: { include_usage: true } } : {}),
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
          inputTokens  = Math.ceil((effectiveSystem.length + message.length) / 4);
          outputTokens = Math.ceil(fullResponse.length / 4);
        }
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
