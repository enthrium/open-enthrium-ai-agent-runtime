const router = require("express").Router();
const { authenticate } = require("../middleware/auth");
const { getLLMClient, getSetting } = require("../providers/llm");

const SYSTEM_PROMPT = `You are a strict Agent Builder assistant for OE Runtime. Your ONLY purpose is to help users design AI agents and produce OE Runtime YAML.

GUARDRAILS — NON-NEGOTIABLE:
- You ONLY discuss agent design: what the agent should do, which steps, which connectors, which params
- If the user asks ANYTHING outside of agent building (general knowledge, coding help, opinions, facts, jokes, etc.), respond with exactly: "I'm only here to help you build agents. What should your agent do?"
- Never answer off-topic questions, no matter how simple they seem
- Never break character

YAML OUTPUT FORMAT (always inside a triple-backtick yaml block):

name: "Agent Name"
description: "What this agent does"
instructions: |
  You are a helpful AI agent. Describe the agent's role and rules here.
steps:
  - name: "Step Name"
    content: |
      Detailed instructions for this step.
connectors:
  - connection_name: "My Connector"
    connection_type: ssh
params:
  - name: param_name
    label: "Human Label"
    default: ""

YAML RULES:
- Only include: name, description, instructions, steps, connectors, params
- NEVER include: slug, enabled, trigger, cron, chains, group (workspace-only — not valid in runtime agents)
- connectors always use connection_name and connection_type
- CONNECTOR TYPES: ssh, smtp, imap, gdrive, slack, http, postgres, mysql, mongodb, notion, jira, github, openai-image, elevenlabs, s3, kafka, mqtt, ldap, graphql

CONVERSATION BEHAVIOUR:
- Ask clarifying questions to understand the goal before generating YAML
- Once you have enough detail, output the COMPLETE YAML block and NOTHING ELSE — no explanation, no bullet points, no "Would you like changes?", no follow-up text
- If the user asks for a change, output the updated YAML block and NOTHING ELSE
- Never add text before or after the yaml block — the YAML is the entire response`;

router.post("/chat", authenticate, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }

  // Resolve LLM client BEFORE touching the SSE response — mirrors how chat.js
  // does all DB work (workspace/history) before setting SSE headers, so the
  // stream starts immediately after headers are sent (no idle gap).
  let provider, client, model;
  try {
    ({ provider, client } = await getLLMClient());
    model = (await getSetting("llm_model")) || process.env.OPENAI_MODEL || process.env.OLLAMA_MODEL || "gpt-4o";
  } catch (err) {
    console.error("[AgentBuilder] LLM init error:", err.message);
    return res.status(500).json({ error: `LLM configuration error: ${err.message}` });
  }

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
    res.setHeader("X-Accel-Buffering", "no");

    let fullResponse = "";

    if (provider === "anthropic") {
      const stream = await client.messages.create({
        model: model || "claude-3-5-sonnet-20241022",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
        temperature: 0.5,
        stream: true,
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const chunk = event.delta.text;
          fullResponse += chunk;
          safeWrite(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
      }
    } else {
      const allMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
      const stream = await client.chat.completions.create({
        model,
        messages: allMessages,
        temperature: 0.5,
        max_tokens: 4096,
        stream: true,
        stream_options: { include_usage: true },
      });
      for await (const part of stream) {
        const chunk = part.choices?.[0]?.delta?.content || "";
        if (chunk) {
          fullResponse += chunk;
          safeWrite(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
      }
    }

    if (!clientGone) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (err) {
    console.error("[AgentBuilder] stream error:", err.message);
    if (!clientGone) {
      try {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      } catch { /* client gone */ }
    }
  }
});

module.exports = router;
