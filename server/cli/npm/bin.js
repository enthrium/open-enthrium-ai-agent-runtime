#!/usr/bin/env node
"use strict";

// Set INIT_CWD so the runtime resolves relative paths (agent.yaml, oe-config.json)
// from the directory where the user ran npx/node, not from inside the npm package.
process.env.INIT_CWD = process.env.INIT_CWD || process.cwd();

require("./bundle");
