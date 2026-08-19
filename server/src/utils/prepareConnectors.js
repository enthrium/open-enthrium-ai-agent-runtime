"use strict";
const fs  = require("fs");
const os  = require("os");

/**
 * Merge YAML connector declarations (name+type only, no secrets)
 * with config-file credentials, producing the connector objects
 * the engine expects: { id, name, type, status, authConfig, config }.
 *
 * configConnectors supports both array format (canonical) and legacy
 * object format { "Name": { type, ...creds } }.
 */
function prepareConnectors(yamlConnectors, configConnectors) {
  // Normalise config to array
  let cfgArray;
  if (Array.isArray(configConnectors)) {
    cfgArray = configConnectors;
  } else if (configConnectors && typeof configConnectors === "object") {
    cfgArray = Object.entries(configConnectors).map(([name, cfg]) => ({
      connection_name: name,
      connection_type: cfg.type,
      ...cfg,
    }));
  } else {
    cfgArray = [];
  }

  return (yamlConnectors || []).map((yc, i) => {
    // Accept both new (connection_*) and legacy (name/type) field names
    const ycName = yc.connection_name || yc.name;
    const ycType = yc.connection_type || yc.type;

    // Match by name first, then fall back to type
    const cc = cfgArray.find(c => (c.connection_name || c.name) === ycName)
            || cfgArray.find(c => (c.connection_type || c.type) === ycType);

    if (!cc) {
      return { id: i + 1, name: ycName, type: ycType, status: "active", authConfig: "{}", config: "{}" };
    }

    const { connection_name, connection_type, name, type, ...creds } = cc;
    const resolvedName = connection_name || name || ycName;
    const resolvedType = connection_type || type || ycType;

    // Expand privateKeyPath → inline PEM (normalize CRLF for ssh2)
    if (creds.privateKeyPath) {
      const keyPath = creds.privateKeyPath.replace(/^~/, os.homedir());
      creds.privateKey = fs.readFileSync(keyPath, "utf8").replace(/\r\n/g, "\n");
      delete creds.privateKeyPath;
    }
    if (creds.privateKey) {
      creds.privateKey = creds.privateKey.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
    }

    return {
      id:         i + 1,
      name:       resolvedName,
      type:       resolvedType,
      status:     "active",
      authConfig: JSON.stringify(creds),
      config:     JSON.stringify(creds),
    };
  });
}

module.exports = { prepareConnectors };
