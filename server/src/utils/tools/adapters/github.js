const axios = require("axios");

function cfg(connector) {
  return connector.authConfig ? JSON.parse(connector.authConfig) : {};
}

function parseRepo(repoUrl) {
  if (!repoUrl) return {};
  const m = repoUrl.replace(/\.git$/, "").match(/github\.com\/([^/]+)\/([^/]+)/);
  return m ? { owner: m[1], repo: m[2] } : {};
}

function client({ personalAccessToken }) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (personalAccessToken) headers.Authorization = `Bearer ${personalAccessToken}`;
  return axios.create({ baseURL: "https://api.github.com", headers });
}

const TOOLS = (c, defaultRepo) => [
  { action: "search_issues", desc: `Search GitHub issues and PRs in ${defaultRepo || c.name}.`,
    params: { query: { type: "string", description: `Search query. Example: repo:${defaultRepo || "owner/repo"} is:open label:bug` } }, required: ["query"] },
  { action: "get_issue",     desc: `Get a GitHub issue by number from ${defaultRepo || c.name}.`,
    params: { owner:  { type: "string", description: `Repo owner (default: ${defaultRepo?.split("/")[0] || "owner"})` },
              repo:   { type: "string", description: `Repo name (default: ${defaultRepo?.split("/")[1] || "repo"})` },
              number: { type: "number", description: "Issue number." } }, required: ["number"] },
  { action: "list_files",    desc: `List files/directories in ${defaultRepo || c.name} at a given path.`,
    params: { path: { type: "string", description: 'Path inside the repo (default: "" = root).' } }, required: [] },
  { action: "read_file",     desc: `Read the contents of a file from ${defaultRepo || c.name}.`,
    params: { path: { type: "string", description: "File path inside the repo, e.g. src/index.js" } }, required: ["path"] },
  { action: "create_issue",  desc: `Create a GitHub issue in ${defaultRepo || c.name}.`,
    params: { owner:  { type: "string", description: "Repo owner." },
              repo:   { type: "string", description: "Repo name." },
              title:  { type: "string", description: "Issue title." },
              body:   { type: "string", description: "Issue body/description." },
              labels: { type: "array",  items: { type: "string" }, description: "Labels to apply." } }, required: ["title"] },
  { action: "write_file",   desc: `Create or update a file in ${defaultRepo || c.name}. Automatically handles SHA for updates.`,
    params: { path:    { type: "string", description: "File path inside the repo, e.g. blog/my-post.html" },
              content: { type: "string", description: "Full file content as plain text." },
              message: { type: "string", description: "Commit message, e.g. 'feat: publish blog — What is RAG?'" },
              branch:  { type: "string", description: "Branch to commit to (default: repo default branch)." } }, required: ["path", "content"] },
  { action: "delete_file", desc: `Delete a file from ${defaultRepo || c.name}. Automatically fetches the required SHA.`,
    params: { path:    { type: "string", description: "File path inside the repo, e.g. blog/old-post.html" },
              message: { type: "string", description: "Commit message, e.g. 'revert: remove blog post — old-post'" },
              branch:  { type: "string", description: "Branch to delete from (default: repo default branch)." } }, required: ["path"] },
];

function getToolDefinitions(connector) {
  const { repoUrl } = cfg(connector);
  const { owner, repo } = parseRepo(repoUrl);
  const defaultRepo = owner && repo ? `${owner}/${repo}` : null;
  return TOOLS(connector, defaultRepo).map(t => ({
    type: "function",
    function: { name: `conn_${connector.id}_${t.action}`, description: t.desc,
      parameters: { type: "object", properties: t.params, required: t.required } },
  }));
}

function getAnthropicToolDefinitions(connector) {
  const { repoUrl } = cfg(connector);
  const { owner, repo } = parseRepo(repoUrl);
  const defaultRepo = owner && repo ? `${owner}/${repo}` : null;
  return TOOLS(connector, defaultRepo).map(t => ({
    name: `conn_${connector.id}_${t.action}`, description: t.desc,
    input_schema: { type: "object", properties: t.params, required: t.required },
  }));
}

async function executeTool(action, args, connector) {
  const creds = cfg(connector);
  if (!creds.repoUrl) return "GitHub connector not configured. Please add a repository URL in Integrations.";

  const { owner: defOwner, repo: defRepo } = parseRepo(creds.repoUrl);
  const api = client(creds);

  const owner  = args.owner  || defOwner;
  const repo   = args.repo   || defRepo;

  try {
    if (action === "search_issues") {
      const res = await api.get(`/search/issues?q=${encodeURIComponent(args.query)}&per_page=15`);
      const items = res.data.items || [];
      if (!items.length) return "No issues found.";
      return items.map(i => `[${i.repository_url?.split("/").slice(-2).join("/")}#${i.number}] ${i.title} (${i.state})`).join("\n");
    }

    if (action === "get_issue") {
      const res = await api.get(`/repos/${owner}/${repo}/issues/${args.number}`);
      const i = res.data;
      return JSON.stringify({ number: i.number, title: i.title, state: i.state, author: i.user?.login, labels: i.labels?.map(l => l.name), body: i.body?.slice(0, 1000), created: i.created_at }, null, 2);
    }

    if (action === "list_files") {
      const filePath = args.path || "";
      const res = await api.get(`/repos/${owner}/${repo}/contents/${filePath}`);
      const items = Array.isArray(res.data) ? res.data : [res.data];
      return items.map(f => `${f.type === "dir" ? "📁" : "📄"} ${f.path}`).join("\n") || "Empty directory.";
    }

    if (action === "read_file") {
      const res = await api.get(`/repos/${owner}/${repo}/contents/${args.path}`);
      const content = Buffer.from(res.data.content, "base64").toString("utf8");
      return content.slice(0, 8000);
    }

    if (action === "create_issue") {
      const { title, body = "", labels = [] } = args;
      const res = await api.post(`/repos/${owner}/${repo}/issues`, { title, body, labels });
      return `Created issue #${res.data.number}: ${title}\n${res.data.html_url}`;
    }

    if (action === "write_file") {
      const { path, content, message = `Update ${args.path}`, branch } = args;
      const encoded = Buffer.from(content).toString("base64");

      // Fetch existing SHA if file already exists (required by GitHub API for updates)
      let sha;
      try {
        const url = `/repos/${owner}/${repo}/contents/${path}` + (branch ? `?ref=${branch}` : "");
        const existing = await api.get(url);
        sha = existing.data.sha;
      } catch (_) {
        // File does not exist yet — create mode
      }

      const payload = { message, content: encoded };
      if (sha) payload.sha = sha;
      if (branch) payload.branch = branch;

      const res = await api.put(`/repos/${owner}/${repo}/contents/${path}`, payload);
      const verb = sha ? "Updated" : "Created";
      return `${verb} ${path}\nCommit: ${res.data.commit.sha}\n${res.data.content.html_url}`;
    }

    if (action === "delete_file") {
      const { path, message = `Delete ${args.path}`, branch } = args;

      // Fetch SHA — required by GitHub API to delete
      let sha;
      try {
        const url = `/repos/${owner}/${repo}/contents/${path}` + (branch ? `?ref=${branch}` : "");
        const existing = await api.get(url);
        sha = existing.data.sha;
      } catch (_) {
        return `File not found: ${path}`;
      }

      const payload = { message, sha };
      if (branch) payload.branch = branch;

      const res = await api.delete(`/repos/${owner}/${repo}/contents/${path}`, { data: payload });
      return `Deleted ${path}\nCommit: ${res.data.commit.sha}`;
    }

    return `Unknown GitHub action: ${action}`;
  } catch (err) {
    return `GitHub error: ${err.response?.data?.message || err.message}`;
  }
}

async function testConnection(authConfig) {
  try {
    const { owner, repo } = parseRepo(authConfig.repoUrl);
    if (!owner || !repo) return false;
    const res = await client(authConfig).get(`/repos/${owner}/${repo}`);
    return !!res.data.id;
  } catch { return false; }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool, testConnection };
