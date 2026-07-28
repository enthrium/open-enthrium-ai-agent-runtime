const cron = require("node-cron");
const { getToolDefinitions, getAnthropicToolDefinitions, executeTool } = require("./tools/registry");
const { getLLMClient, getSetting } = require("../providers/llm");

function applyParams(template, paramDefs, paramValues) {
  let result = template || "";
  for (const p of (paramDefs || [])) {
    const val = String(paramValues?.[p.name] ?? p.default ?? "");
    result = result.split(`{{${p.name}}}`).join(val);
  }
  return result;
}

const jobs = new Map(); // agentId -> cron.ScheduledTask

async function runAgent(agent, db) {
  const run = await db.agentRun.create({
    data: { agentId: agent.id, status: "running", triggerType: "scheduled", input: null },
  });

  try {
    const connectorIds = JSON.parse(agent.connectorIds || "[]");
    const connectors   = connectorIds.length
      ? await db.connector.findMany({ where: { id: { in: connectorIds }, status: "active" } })
      : [];

    const workspace    = await db.workspace.findUnique({ where: { id: agent.workspaceId } });
    const paramDefs    = JSON.parse(agent.params || "[]");
    const { buildSystemPrompt } = require("./workflowEngine");
    const systemPrompt = applyParams(
      buildSystemPrompt(agent) || "You are a helpful AI agent. Complete the task given to you using the available tools.",
      paramDefs, null
    ) + "\n\nIMPORTANT: This is an automated scheduled run. Execute the task immediately using the available tools. Do not ask for clarification.";

    const userTask = "Run the scheduled agent task.";

    const { provider, client } = await getLLMClient();
    const model = (await getSetting("llm_model")) || process.env.OPENAI_MODEL || process.env.OLLAMA_MODEL || "gpt-4o";

    const MAX_ROUNDS = workspace?.defaultAgentMaxRounds || 25;
    let fullOutput = "";

    if (provider === "anthropic") {
      const tools = getAnthropicToolDefinitions(connectors);
      const msgs  = [{ role: "user", content: userTask }];

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const resp = await client.messages.create({
          model: model || "claude-3-5-sonnet-20241022",
          max_tokens: 4096,
          system: systemPrompt,
          messages: msgs,
          tools: tools.length ? tools : undefined,
          temperature: 0.3,
        });

        if (resp.stop_reason !== "tool_use" || !tools.length) {
          fullOutput = resp.content?.find(b => b.type === "text")?.text || "";
          break;
        }

        const toolUseBlocks = resp.content.filter(b => b.type === "tool_use");
        msgs.push({ role: "assistant", content: resp.content });
        const toolResults = [];
        for (const tb of toolUseBlocks) {
          const result = await executeTool(tb.name, tb.input, connectors, db);
          toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: String(result) });
        }
        msgs.push({ role: "user", content: toolResults });

        if (round === MAX_ROUNDS - 1) {
          const finalResp = await client.messages.create({
            model: model || "claude-3-5-sonnet-20241022",
            max_tokens: 4096, system: systemPrompt, messages: msgs, temperature: 0.3,
          });
          fullOutput = finalResp.content?.find(b => b.type === "text")?.text || "";
        }
      }
    } else {
      const tools    = getToolDefinitions(connectors);
      const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userTask }];

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const reqBody = { model, messages, temperature: 0.3, max_tokens: 4096 };
        if (tools.length) { reqBody.tools = tools; reqBody.tool_choice = "auto"; }

        const resp   = await client.chat.completions.create(reqBody);
        const choice = resp.choices[0];

        if (choice.finish_reason !== "tool_calls" || !tools.length) {
          fullOutput = choice.message.content || "";
          break;
        }

        messages.push(choice.message);
        for (const tc of choice.message.tool_calls || []) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* */ }
          const result = await executeTool(tc.function.name, args, connectors, db);
          messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
        }

        if (round === MAX_ROUNDS - 1) {
          const finalResp = await client.chat.completions.create({ model, messages, temperature: 0.3, max_tokens: 4096 });
          fullOutput = finalResp.choices[0].message.content || "";
        }
      }
    }

    await db.agentRun.update({
      where: { id: run.id },
      data:  { status: "success", output: fullOutput, completedAt: new Date() },
    });
    console.log(`[scheduler] Agent "${agent.name}" (id=${agent.id}) completed.`);

    // Chain to next agent if configured
    const { maybeChain } = require("./agentChain");
    await maybeChain(agent, fullOutput, db);
  } catch (err) {
    await db.agentRun.update({
      where: { id: run.id },
      data:  { status: "error", error: err.message, completedAt: new Date() },
    });
    console.error(`[scheduler] Agent "${agent.name}" failed:`, err.message);
  }
}

function scheduleAgent(agent, db) {
  if (jobs.has(agent.id)) {
    jobs.get(agent.id).stop();
    jobs.delete(agent.id);
  }
  if (!agent.enabled || agent.triggerType !== "scheduled" || !agent.cronExpression) return;
  if (!cron.validate(agent.cronExpression)) {
    console.warn(`[scheduler] Invalid cron "${agent.cronExpression}" for agent ${agent.id}`);
    return;
  }
  const task = cron.schedule(agent.cronExpression, () => runAgent(agent, db));
  jobs.set(agent.id, task);
  console.log(`[scheduler] Scheduled agent "${agent.name}" (id=${agent.id}) with cron "${agent.cronExpression}"`);
}

function unscheduleAgent(agentId) {
  if (jobs.has(agentId)) {
    jobs.get(agentId).stop();
    jobs.delete(agentId);
    console.log(`[scheduler] Removed job for agent id=${agentId}`);
  }
}

async function init(db) {
  // Mark any runs that were mid-flight when the server last died
  const orphaned = await db.agentRun.updateMany({
    where: { status: "running" },
    data:  { status: "error", error: "Server restarted mid-run", completedAt: new Date() },
  });
  if (orphaned.count > 0) console.log(`[scheduler] Marked ${orphaned.count} orphaned run(s) as error.`);

  const agents = await db.agent.findMany({
    where: { triggerType: "scheduled", enabled: true },
  });
  for (const agent of agents) {
    scheduleAgent(agent, db);
  }
  console.log(`[scheduler] Initialized ${agents.length} scheduled agent(s).`);
}

module.exports = { init, scheduleAgent, unscheduleAgent, runAgent };
