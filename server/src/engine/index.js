const { createLLMClient }                                         = require("./llm");
const { buildSystemPrompt }                                       = require("./promptBuilder");
const { getToolDefinitions, getAnthropicToolDefinitions, executeTool } = require("../utils/tools/registry");

function applyParams(template, paramDefs, paramValues) {
  let result = template || "";
  for (const p of (paramDefs || [])) {
    const val = String(paramValues?.[p.name] ?? p.default ?? "");
    result = result.split(`{{${p.name}}}`).join(val);
  }
  return result;
}

function conditionMet(condition, output) {
  switch (condition) {
    case "always":      return true;
    case "on_success":  return true;
    case "on_critical": return /CRITICAL|🚨/i.test(output || "");
    case "on_warning":  return /WARNING|CRITICAL|⚠️|🚨/i.test(output || "");
    default:            return true;
  }
}

function friendlyToolName(rawName, connectors) {
  const connId = rawName.match(/^conn_(\d+)_/)?.[1];
  if (connId) {
    const conn = (connectors || []).find(c => c.id === parseInt(connId));
    return conn ? conn.name : rawName.replace(/^conn_\d+_/, "");
  }
  return rawName.replace(/_/g, " ");
}

/**
 * Run an agent. Pure function — no Prisma, no Express, no SSE.
 * All side-effects go through hooks.
 *
 * agentSpec: {
 *   systemPrompt:   string,
 *   workflow:       [{ name, content }],   ← parsed array
 *   params:         [{ name, default }],
 *   paramValues:    object,
 *   maxRounds:      number,
 *   input:          string,
 *   appendToPrompt: string,
 * }
 *
 * llmConfig: { provider, apiKey, model, baseURL?, azureEndpoint?, azureDeployment? }
 *
 * connectors: [{ id, name, type, config, authConfig, ... }]
 *
 * hooks: {
 *   onToolCall(friendlyName):         called each time a tool fires
 *   onDone(output, toolCallNames):    called on clean completion
 *   onError(err):                     called on failure
 *   checkCancel():                    async fn, return true to abort mid-run
 *   toolExecutor(name, args, conns):  optional override — use to inject db in web layer
 * }
 *
 * Returns: { output, toolCalls }
 */
async function run(agentSpec, llmConfig, connectors, hooks = {}) {
  const { onToolCall, onDone, onError, checkCancel } = hooks;

  // Allow caller to inject db-aware tool executor (web layer);
  // fall back to registry directly with null db (CLI / standalone).
  const execTool = hooks.toolExecutor
    || ((name, args, conns) => executeTool(name, args, conns, null));

  // Build system prompt
  const basePrompt   = buildSystemPrompt(agentSpec);
  let   systemPrompt = applyParams(basePrompt, agentSpec.params || [], agentSpec.paramValues);
  if (agentSpec.appendToPrompt) systemPrompt += "\n\n" + agentSpec.appendToPrompt;

  const userMessage  = agentSpec.input?.trim() || "Execute the agent task now using the available tools.";
  const MAX_ROUNDS   = agentSpec.maxRounds || 25;
  const hasWorkflow  = (agentSpec.workflow || []).length > 0;

  const { provider, client, model } = await createLLMClient(llmConfig);

  let fullOutput       = "";
  const allToolCalls   = [];

  try {
    if (provider === "anthropic") {
      const tools = getAnthropicToolDefinitions(connectors);
      const msgs  = [{ role: "user", content: userMessage }];
      let madeToolCall = false;

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const resp = await client.messages.create({
          model: model || "claude-sonnet-4-6",
          max_tokens: 4096,
          system: systemPrompt,
          messages: msgs,
          tools: tools.length ? tools : undefined,
          temperature: 0.3,
        });

        if (resp.stop_reason !== "tool_use" || !tools.length) {
          if (hasWorkflow && tools.length && !madeToolCall && round === 0) {
            msgs.push({ role: "assistant", content: resp.content });
            msgs.push({ role: "user", content: "Do not plan or summarise. Call your first tool RIGHT NOW." });
            continue;
          }
          fullOutput = resp.content?.find(b => b.type === "text")?.text || "";
          break;
        }

        madeToolCall = true;
        const toolUseBlocks = resp.content.filter(b => b.type === "tool_use");

        for (const tb of toolUseBlocks) {
          const name = friendlyToolName(tb.name, connectors);
          allToolCalls.push(name);
          onToolCall?.(name);
        }

        msgs.push({ role: "assistant", content: resp.content });
        const toolResults = [];
        for (const tb of toolUseBlocks) {
          const result = await execTool(tb.name, tb.input, connectors);
          hooks.onToolResult?.(friendlyToolName(tb.name, connectors), String(result));
          toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: String(result) });
        }
        msgs.push({ role: "user", content: toolResults });

        if (checkCancel && await checkCancel()) { fullOutput = "[Run cancelled by user]"; break; }

        if (round === MAX_ROUNDS - 1) {
          const fr = await client.messages.create({
            model: model || "claude-sonnet-4-6", max_tokens: 4096,
            system: systemPrompt, messages: msgs, temperature: 0.3,
          });
          fullOutput = fr.content?.find(b => b.type === "text")?.text || "";
        }
      }

    } else {
      const tools    = getToolDefinitions(connectors);
      const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
      let madeToolCall = false;

      for (let round = 0; round < MAX_ROUNDS; round++) {
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
          fullOutput = choice.message.content || "";
          break;
        }

        madeToolCall = true;
        messages.push(choice.message);

        for (const tc of choice.message.tool_calls || []) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /**/ }
          const name = friendlyToolName(tc.function.name, connectors);
          allToolCalls.push(name);
          onToolCall?.(name);
          const result = await execTool(tc.function.name, args, connectors);
          hooks.onToolResult?.(name, String(result));
          messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
        }

        if (checkCancel && await checkCancel()) { fullOutput = "[Run cancelled by user]"; break; }

        if (round === MAX_ROUNDS - 1) {
          const fr = await client.chat.completions.create({ model, messages, temperature: 0.3, max_tokens: 4096 });
          fullOutput = fr.choices[0].message.content || "";
        }
      }
    }

    onDone?.(fullOutput, allToolCalls);
    return { output: fullOutput, toolCalls: allToolCalls };

  } catch (err) {
    onError?.(err);
    throw err;
  }
}

module.exports = { run, conditionMet };
