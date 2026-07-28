// Built-in pattern library — each entry has a regex factory (fresh instance per call)
const BUILTIN_PATTERNS = {
  passwords:    () => /(?:password|passwd|pwd|secret|token|pass)\s*[:=]\s*\S+/gi,
  ip_addresses: () => /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  api_keys:     () => /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bpoa]-[0-9A-Za-z\-]+|Bearer\s+[A-Za-z0-9\-._~+/]{20,})/g,
  credit_cards: () => /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
};

/**
 * Scan a message against active DLP policies.
 * Returns: { blocked, violations, redactedText }
 *   - blocked: true if any policy with action="block" matched
 *   - violations: [{ policyId, policyName, action, snippet }]
 *   - redactedText: message with redacted content (or original if nothing to redact)
 */
function scanMessage(text, policies = []) {
  const violations = [];
  let redactedText = text;
  let blocked = false;

  for (const policy of policies) {
    if (!policy.enabled) continue;

    let regex;
    try {
      // Use built-in pattern if available, otherwise compile custom pattern
      const builtin = BUILTIN_PATTERNS[policy.category];
      regex = builtin ? builtin() : new RegExp(policy.pattern, "gi");
    } catch (_) {
      continue; // skip malformed patterns
    }

    const matches = text.match(regex);
    if (!matches || matches.length === 0) continue;

    const snippet = text;

    violations.push({
      policyId:   policy.id,
      policyName: policy.name,
      action:     policy.action,
      snippet,
    });

    if (policy.action === "block") {
      blocked = true;
    }

    if (policy.action === "redact") {
      redactedText = redactedText.replace(regex, "[REDACTED]");
    }
  }

  return { blocked, violations, redactedText };
}

module.exports = { scanMessage };
