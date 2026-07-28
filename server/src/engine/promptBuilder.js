/**
 * Build the full system prompt from a plain agentSpec object.
 *
 * agentSpec: {
 *   systemPrompt: string,
 *   workflow: [{ name: string, content: string }]   ← already a parsed array
 * }
 */
function buildSystemPrompt(agentSpec) {
  const steps = agentSpec.workflow || [];

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

module.exports = { buildSystemPrompt };
