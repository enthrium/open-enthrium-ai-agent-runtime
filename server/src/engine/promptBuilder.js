/**
 * Build the full system prompt from an agentSpec or a DB agent object.
 *
 * Accepts workflow as either:
 *   - a parsed array  [{ name, content }]  (agentSpec from CLI / engine)
 *   - a JSON string   "[{...}]"            (DB agent from Platform routes)
 */
function buildSystemPrompt(agentSpec) {
  const raw   = agentSpec.workflow ?? agentSpec.steps ?? [];
  const steps = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;

  const todayDate  = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const dateHeader = `SYSTEM: Today's date is ${todayDate}. Use this exact date whenever instructions say "today's date" or "TODAY".`;

  if (!steps.length) return dateHeader + "\n\n" + (agentSpec.systemPrompt || "");

  const parts = [dateHeader];
  if (agentSpec.systemPrompt?.trim()) parts.push(agentSpec.systemPrompt.trim());

  steps.forEach((step, i) => {
    const header = `step_${i + 1}: — ${step.name || `Step ${i + 1}`}`;
    const body   = step.content?.trim() || "";
    parts.push(body ? `${header}\n\n${body}` : header);
  });

  return parts.join("\n\n");
}

function applyParams(template, paramDefs, paramValues) {
  let result = template || "";
  for (const p of (paramDefs || [])) {
    const val = String(paramValues?.[p.name] ?? p.default ?? "");
    result = result.split(`{{${p.name}}}`).join(val);
  }
  return result;
}

module.exports = { buildSystemPrompt, applyParams };
