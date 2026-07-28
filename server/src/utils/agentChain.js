const { getLLMConfig }        = require("../providers/llm");
const { executeTool }         = require("./tools/registry");
const engine                  = require("../engine");
const { conditionMet }        = engine;

async function runChainedAgent(agent, db, inputContext, depth, chatContext) {
  const run = await db.agentRun.create({
    data: { agentId: agent.id, status: "running", triggerType: "chained", input: inputContext?.slice(0, 2000) || null, triggeredFromWorkspaceId: chatContext?.workspaceId || null },
  });

  try {
    const connectorIds = JSON.parse(agent.connectorIds || "[]");
    const connectors   = connectorIds.length
      ? await db.connector.findMany({ where: { id: { in: connectorIds }, status: "active" } })
      : [];

    const workspace = await db.workspace.findUnique({ where: { id: agent.workspaceId } });

    let appendToPrompt = "\n\nIMPORTANT: This is an automated chained run. Execute immediately using available tools. Do not ask for clarification.";
    if (workspace?.agentMemoryEnabled) {
      const pastRuns = await db.agentRun.findMany({
        where: { agentId: agent.id, status: "success" },
        orderBy: { completedAt: "desc" },
        take: workspace.agentMemoryRuns || 5,
      });
      if (pastRuns.length) {
        const memoryBlock = pastRuns.reverse().map((r, i) =>
          `Run ${i + 1} (${r.completedAt?.toISOString().slice(0, 10)}): ${(r.output || "").slice(0, 500)}`
        ).join("\n\n");
        appendToPrompt += `\n\n--- MEMORY FROM PREVIOUS RUNS ---\n${memoryBlock}\n--- END MEMORY ---`;
      }
    }

    const llmConfig  = await getLLMConfig();
    const agentSpec  = {
      systemPrompt:   agent.systemPrompt,
      workflow:       JSON.parse(agent.workflow || "[]"),
      params:         JSON.parse(agent.params   || "[]"),
      maxRounds:      workspace?.defaultAgentMaxRounds || 25,
      input:          inputContext ? `Context from previous agent:\n\n${inputContext}\n\nNow execute your task.` : "Execute the agent task now.",
      appendToPrompt,
    };

    const allToolCallNames = [];
    const { output: fullOutput } = await engine.run(agentSpec, llmConfig, connectors, {
      toolExecutor: (name, args, conns) => executeTool(name, args, conns, db),
      onToolCall:   (name) => allToolCallNames.push(name),
    });

    await db.agentRun.update({
      where: { id: run.id },
      data: { status: "success", output: fullOutput, completedAt: new Date() },
    });
    console.log(`[chain] Agent "${agent.name}" (depth=${depth}) completed.`);

    if (chatContext?.workspaceId) {
      await db.chat.create({
        data: {
          workspaceId: chatContext.workspaceId,
          threadId:    chatContext.threadId || null,
          role:        "assistant",
          content:     `**@${agent.slug}** *(chained)* — ${fullOutput}`,
          toolCalls:   allToolCallNames.length ? JSON.stringify(allToolCallNames) : null,
        },
      });
    }

    // Continue chain
    await maybeChain(agent, fullOutput, db, depth, chatContext);

  } catch (err) {
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: "error", error: err.message, completedAt: new Date() },
    });
    if (chatContext?.workspaceId) {
      await db.chat.create({
        data: {
          workspaceId: chatContext.workspaceId,
          threadId:    chatContext.threadId || null,
          role:        "assistant",
          content:     `**@${agent.slug}** *(chained)* — ❌ Error: ${err.message}`,
        },
      });
    }
    console.error(`[chain] Agent "${agent.name}" failed:`, err.message);
  }
}

async function maybeChain(agent, output, db, depth = 0, chatContext) {
  const workspace = await db.workspace.findUnique({ where: { id: agent.workspaceId } });
  const maxDepth  = workspace?.maxChainDepth || 5;
  if (depth >= maxDepth) { console.warn(`[chain] Max depth (${maxDepth}) reached at agent "${agent.name}"`); return { pendingApprovals: 0 }; }

  const chains = agent.chains
    ? JSON.parse(agent.chains)
    : agent.nextAgent
      ? [{ condition: agent.nextAgentCondition || "always", nextAgent: agent.nextAgent }]
      : [];

  if (!chains.length) return { pendingApprovals: 0 };

  let pendingApprovals = 0;

  for (const chain of chains) {
    if (!chain.nextAgent) continue;
    if (!conditionMet(chain.condition || "always", output)) {
      console.log(`[chain] Condition "${chain.condition}" not met → skipping "${chain.nextAgent}"`);
      continue;
    }
    const nextAgent = await db.agent.findFirst({ where: { slug: chain.nextAgent } });
    if (!nextAgent) { console.warn(`[chain] Next agent "${chain.nextAgent}" not found`); continue; }

    if (chain.triggerType === "manual") {
      const timeoutAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
      await db.chainApproval.create({
        data: {
          workspaceId:   chatContext?.workspaceId || agent.workspaceId,
          sourceAgentId: agent.id,
          sourceRunId:   chatContext?.runId || 0,
          threadId:      chatContext?.threadId || null,
          nextAgentSlug: chain.nextAgent,
          condition:     chain.condition || "always",
          runOutput:     (output || "").slice(0, 2000),
          status:        "pending",
          timeoutAt,
        }
      });
      pendingApprovals++;
      console.log(`[chain] "${agent.name}" → "${chain.nextAgent}" queued for manual approval`);
      continue;
    }

    console.log(`[chain] "${agent.name}" → "${nextAgent.name}" (condition: ${chain.condition}, depth: ${depth + 1})`);
    await runChainedAgent(nextAgent, db, output, depth + 1, chatContext);
  }

  return { pendingApprovals };
}

module.exports = { maybeChain, runChainedAgent };
