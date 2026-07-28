const mqtt = require("mqtt");

function getConfig(connector) {
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const cfg  = connector.config     ? JSON.parse(connector.config)     : {};
  return {
    brokerUrl: auth.brokerUrl || cfg.brokerUrl || auth.baseUrl || cfg.baseUrl || "mqtt://localhost:1883",
    username:  auth.username  || cfg.username  || undefined,
    password:  auth.password  || cfg.password  || undefined,
    clientId:  auth.clientId  || cfg.clientId  || `oe-${Date.now()}`,
  };
}

function connect(config) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(config.brokerUrl, {
      clientId: config.clientId,
      username: config.username,
      password: config.password,
      connectTimeout: 10000,
    });
    client.on("connect", () => resolve(client));
    client.on("error", reject);
  });
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_publish`,
        description: `Publish a message to an MQTT topic on "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            topic:   { type: "string", description: "MQTT topic" },
            message: { type: "string", description: "Message payload" },
            qos:     { type: "number", description: "QoS level (0, 1, or 2). Default 0." },
          },
          required: ["topic", "message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_subscribe`,
        description: `Subscribe to an MQTT topic and read recent messages from "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            topic:   { type: "string", description: "MQTT topic or wildcard (e.g. sensors/#)" },
            timeout: { type: "number", description: "Seconds to listen (default 5, max 30)" },
          },
          required: ["topic"],
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
  const config = getConfig(connector);

  try {
    if (action === "publish") {
      const client = await connect(config);
      await new Promise((res, rej) =>
        client.publish(args.topic, args.message, { qos: args.qos || 0 }, err => err ? rej(err) : res())
      );
      client.end();
      return `Published to "${args.topic}".`;
    }

    if (action === "subscribe") {
      const client  = await connect(config);
      const timeout = Math.min(parseInt(args.timeout) || 5, 30) * 1000;
      const messages = [];

      await new Promise((resolve) => {
        client.subscribe(args.topic, { qos: 1 });
        client.on("message", (topic, payload) => {
          messages.push(`[${topic}] ${payload.toString()}`);
        });
        setTimeout(resolve, timeout);
      });
      client.end();
      return messages.length ? messages.join("\n") : "No messages received within timeout.";
    }

    return `Unknown MQTT action: ${action}`;
  } catch (err) {
    return `MQTT error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
