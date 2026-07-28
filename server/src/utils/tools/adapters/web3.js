const axios = require("axios");

let _id = 1;
function rpc(url, method, params = []) {
  return axios.post(url, { jsonrpc: "2.0", id: _id++, method, params }, { timeout: 30000 });
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_call`,
        description: `Call a JSON-RPC / Web3 method on "${connector.name}" (Ethereum, Solana, or any JSON-RPC node).`,
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", description: "RPC method name, e.g. eth_blockNumber, eth_getBalance, solana getSlot" },
            params: { type: "array",  description: "Array of parameters for the method", items: {} },
          },
          required: ["method"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_get_balance`,
        description: `Get the native token balance of an address on "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            address: { type: "string", description: "Wallet address" },
          },
          required: ["address"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_get_block`,
        description: `Get block information from "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            block: { type: "string", description: "Block number (hex) or 'latest'" },
          },
          required: [],
        },
      },
    },
  ];
}

function getAnthropicToolDefinitions(connector) {
  return getToolDefinitions(connector).map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

async function executeTool(action, args, connector) {
  const cfg  = connector.config    ? JSON.parse(connector.config)    : {};
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};

  const rpcUrl = cfg.baseUrl || auth.baseUrl || auth.rpcUrl || cfg.rpcUrl || "";
  if (!rpcUrl) return "Web3 RPC URL (baseUrl) not configured.";

  try {
    if (action === "call") {
      const res = await rpc(rpcUrl, args.method, args.params || []);
      if (res.data.error) return `RPC error: ${JSON.stringify(res.data.error)}`;
      return JSON.stringify(res.data.result, null, 2);
    }
    if (action === "get_balance") {
      const res = await rpc(rpcUrl, "eth_getBalance", [args.address, "latest"]);
      if (res.data.error) return `RPC error: ${JSON.stringify(res.data.error)}`;
      const hex = res.data.result;
      const wei = BigInt(hex);
      const eth = Number(wei) / 1e18;
      return `Balance: ${hex} wei (${eth.toFixed(6)} ETH)`;
    }
    if (action === "get_block") {
      const res = await rpc(rpcUrl, "eth_getBlockByNumber", [args.block || "latest", false]);
      if (res.data.error) return `RPC error: ${JSON.stringify(res.data.error)}`;
      return JSON.stringify(res.data.result, null, 2).slice(0, 4000);
    }
    return `Unknown action: ${action}`;
  } catch (err) {
    return `Web3 error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
