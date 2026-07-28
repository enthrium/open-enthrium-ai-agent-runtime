const axios = require("axios");

function cfg(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function client({ domain, email, apiToken }) {
  return axios.create({
    baseURL: `https://${domain}/rest/api/3`,
    auth: { username: email, password: apiToken },
    headers: { "Content-Type": "application/json" },
  });
}

const TOOLS = c => [
  { action: "search_issues", desc: `Search Jira issues via ${c.name} using JQL.`,
    params: { jql:        { type: "string", description: "JQL query (e.g. project=MYPROJ AND status=Open)" },
              maxResults: { type: "number", description: "Max results (default 10)." } }, required: ["jql"] },
  { action: "get_issue",    desc: `Get details of a Jira issue via ${c.name}.`,
    params: { issueKey: { type: "string", description: "Issue key (e.g. PROJ-123)" } }, required: ["issueKey"] },
  { action: "create_issue", desc: `Create a Jira issue via ${c.name}.`,
    params: { project:     { type: "string", description: "Project key (e.g. PROJ)" },
              summary:     { type: "string", description: "Issue summary/title." },
              description: { type: "string", description: "Issue description." },
              issueType:   { type: "string", description: "Issue type (e.g. Bug, Task, Story). Default: Task." } },
    required: ["project","summary"] },
];

function getToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({
    type: "function",
    function: { name: `conn_${connector.id}_${t.action}`, description: t.desc,
      parameters: { type: "object", properties: t.params, required: t.required } },
  }));
}

function getAnthropicToolDefinitions(connector) {
  return TOOLS(connector).map(t => ({
    name: `conn_${connector.id}_${t.action}`, description: t.desc,
    input_schema: { type: "object", properties: t.params, required: t.required },
  }));
}

async function executeTool(action, args, connector) {
  const creds = cfg(connector);
  if (!creds.domain || !creds.apiToken) return "Jira not configured. Please add credentials in Integrations.";
  const api = client(creds);

  try {
    if (action === "search_issues") {
      const { jql, maxResults = 10 } = args;
      const res = await api.get(`/search?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(maxResults, 25)}&fields=summary,status,assignee,priority`);
      const issues = res.data.issues || [];
      if (!issues.length) return "No issues found.";
      return issues.map(i => `${i.key}: ${i.fields.summary} [${i.fields.status?.name}]`).join("\n");
    }

    if (action === "get_issue") {
      const res = await api.get(`/issue/${args.issueKey}`);
      const f = res.data.fields;
      return JSON.stringify({ key: res.data.key, summary: f.summary, status: f.status?.name, assignee: f.assignee?.displayName, priority: f.priority?.name, description: f.description }, null, 2);
    }

    if (action === "create_issue") {
      const { project, summary, description = "", issueType = "Task" } = args;
      const res = await api.post("/issue", {
        fields: { project: { key: project }, summary, issuetype: { name: issueType },
          description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: description }] }] } },
      });
      return `Created issue ${res.data.key}: ${summary}`;
    }

    return `Unknown Jira action: ${action}`;
  } catch (err) {
    return `Jira error: ${err.response?.data?.errorMessages?.join(", ") || err.message}`;
  }
}

async function testConnection(authConfig) {
  try {
    const res = await client(authConfig).get("/myself");
    return !!res.data.accountId;
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
