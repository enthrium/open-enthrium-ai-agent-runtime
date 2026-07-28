function parseVizConfig(instructions) {
  const s = instructions || "";
  const type =
    /pie\s+chart/i.test(s) ? "pie" :
    /bar\s+chart/i.test(s) ? "bar" :
    /line\s+chart/i.test(s) ? "line" : "auto";

  const limitMatch = s.match(/top\s+(\d+)/i);
  const limit = limitMatch ? parseInt(limitMatch[1]) : null;

  const style = /donut/i.test(s) ? "donut" : "solid";

  const legend =
    /legend.*right|right.*legend/i.test(s) ? "right" :
    /legend.*bottom|bottom.*legend/i.test(s) ? "bottom" :
    /no\s+legend|legend.*none/i.test(s) ? "none" : "right";

  const groupOthers = /group.*others?|others?.*group/i.test(s);

  return { type, limit, style, legend, groupOthers };
}

function buildVisualization(rawResults, instructions) {
  if (!rawResults?.length) return null;

  const cfg = parseVizConfig(instructions);

  for (let i = rawResults.length - 1; i >= 0; i--) {
    const viz = _tryBuild(rawResults[i], cfg);
    if (viz) return viz;
  }
  return null;
}

function _tryBuild(raw, cfg) {
  if (!raw || typeof raw !== "string") return null;

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }

  // Plain number
  if (typeof parsed === "number") {
    return { type: "stat", data: [{ label: "Result", value: parsed }], style: cfg.style, legend: cfg.legend };
  }

  // Single object: { count: 47 }
  if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    const numKeys = keys.filter(k => typeof parsed[k] === "number" || (!isNaN(Number(parsed[k])) && parsed[k] !== ""));
    if (numKeys.length === 1) return { type: "stat", data: [{ label: numKeys[0], value: Number(parsed[numKeys[0]]) }], style: cfg.style, legend: cfg.legend };
    if (numKeys.length > 1) return _applyConfig({ type: "bar", data: numKeys.map(k => ({ label: k, value: Number(parsed[k]) })) }, cfg);
    return null;
  }

  if (!Array.isArray(parsed) || !parsed.length) return null;
  const first = parsed[0];
  if (typeof first !== "object" || first === null) return null;

  const keys = Object.keys(first);
  const numKey = keys.find(k => parsed.every(r => r[k] !== undefined && !isNaN(Number(r[k])) && r[k] !== ""));
  const labelKey = keys.find(k => k !== numKey && typeof first[k] === "string");

  // Single row
  if (parsed.length === 1) {
    const numKeys = keys.filter(k => !isNaN(Number(first[k])) && first[k] !== "");
    if (numKeys.length === 1) return { type: "stat", data: [{ label: numKeys[0], value: Number(first[numKeys[0]]) }], style: cfg.style, legend: cfg.legend };
    if (numKeys.length > 1) return _applyConfig({ type: "bar", data: numKeys.map(k => ({ label: k, value: Number(first[k]) })) }, cfg);
    return null;
  }

  // Multiple rows
  if (numKey && labelKey) {
    const detectedType = cfg.type !== "auto" ? cfg.type : (/date|time|month|year|week|day|hour/i.test(labelKey) ? "line" : "bar");
    const data = parsed.map(r => ({ label: String(r[labelKey]), value: Number(r[numKey]) }));
    return _applyConfig({ type: detectedType, data }, cfg);
  }

  if (numKey) {
    const data = parsed.map((r, i) => ({ label: String(i + 1), value: Number(r[numKey]) }));
    return _applyConfig({ type: cfg.type !== "auto" ? cfg.type : "bar", data }, cfg);
  }

  return null;
}

function _applyConfig(viz, cfg) {
  let data = viz.data;

  if (cfg.limit && data.length > cfg.limit) {
    const sorted = [...data].sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, cfg.limit);
    if (cfg.groupOthers) {
      const othersValue = sorted.slice(cfg.limit).reduce((s, d) => s + d.value, 0);
      top.push({ label: "Others", value: othersValue });
    }
    data = top;
  }

  return { type: viz.type, data, style: cfg.style, legend: cfg.legend };
}

module.exports = { buildVisualization };
