// Thin re-export — logic lives in engine/promptBuilder.js
// All Platform routes (chat, scheduler, v1, workspaces) import from here
// and continue to work without any changes.
module.exports = require("../engine/promptBuilder");
