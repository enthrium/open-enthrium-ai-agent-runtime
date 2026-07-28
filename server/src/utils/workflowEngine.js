function applyParams(template, paramDefs, paramValues) {
  let result = template || "";
  for (const p of (paramDefs || [])) {
    const val = String(paramValues?.[p.name] ?? p.default ?? "");
    result = result.split(`{{${p.name}}}`).join(val);
  }
  return result;
}

// Builds the full system prompt by combining the preamble (systemPrompt)
// with step_1 / step_2 / step_3 sections from the workflow steps field.
// If no steps are defined, returns the raw systemPrompt unchanged.
function buildSystemPrompt(agent) {
  const steps = JSON.parse(agent.workflow || "[]");

  // Inject today's date so agents never hallucinate a date from training data
  const todayDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const dateHeader = `SYSTEM: Today's date is ${todayDate}. Use this exact date whenever instructions say "today's date" or "TODAY".`;

  if (!steps.length) return dateHeader + "\n\n" + (agent.systemPrompt || "");

  const parts = [dateHeader];
  if (agent.systemPrompt?.trim()) parts.push(agent.systemPrompt.trim());

  steps.forEach((step, i) => {
    const header = `step_${i + 1}: — ${step.name || `Step ${i + 1}`}`;
    const body   = step.content?.trim() || "";
    parts.push(body ? `${header}\n\n${body}` : header);
  });

  return parts.join("\n\n");
}

module.exports = { buildSystemPrompt, applyParams };
