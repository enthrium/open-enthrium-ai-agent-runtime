const { Kafka } = require("kafkajs");

function getClient(connector) {
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const cfg  = connector.config     ? JSON.parse(connector.config)     : {};

  const brokers  = (auth.brokers || cfg.brokers || auth.baseUrl || cfg.baseUrl || "localhost:9092")
    .split(",").map(b => b.trim().replace(/^https?:\/\//, ""));
  const clientId = auth.clientId || cfg.clientId || "open-enterprise";

  const kafkaCfg = { clientId, brokers };

  const username = auth.username || cfg.username;
  const password = auth.password || cfg.password;
  if (username && password) {
    kafkaCfg.ssl  = true;
    kafkaCfg.sasl = { mechanism: "plain", username, password };
  }

  return { kafka: new Kafka(kafkaCfg), defaultTopic: auth.topic || cfg.topic || "" };
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_produce`,
        description: `Publish a message to a Kafka topic on "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            topic:   { type: "string", description: "Topic name" },
            message: { type: "string", description: "Message value (string or JSON string)" },
            key:     { type: "string", description: "Optional message key" },
          },
          required: ["message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_consume`,
        description: `Read recent messages from a Kafka topic on "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Topic name" },
            limit: { type: "number", description: "Max messages to read (default 10)" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_list_topics`,
        description: `List all topics on the Kafka cluster "${connector.name}".`,
        parameters: { type: "object", properties: {}, required: [] },
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
  const { kafka, defaultTopic } = getClient(connector);

  try {
    if (action === "produce") {
      const topic = args.topic || defaultTopic;
      if (!topic) return "Topic name required.";
      const producer = kafka.producer();
      await producer.connect();
      await producer.send({ topic, messages: [{ key: args.key || null, value: args.message }] });
      await producer.disconnect();
      return `Message published to topic "${topic}".`;
    }

    if (action === "consume") {
      const topic = args.topic || defaultTopic;
      if (!topic) return "Topic name required.";
      const limit  = Math.min(parseInt(args.limit) || 10, 50);
      const groupId = `oe-consumer-${Date.now()}`;
      const consumer = kafka.consumer({ groupId });
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });

      const messages = [];
      await new Promise((resolve) => {
        consumer.run({
          eachMessage: async ({ message }) => {
            messages.push(`[${message.offset}] ${message.value?.toString()}`);
            if (messages.length >= limit) resolve();
          },
        });
        setTimeout(resolve, 5000);
      });
      await consumer.disconnect();
      return messages.length ? messages.join("\n") : "No messages received.";
    }

    if (action === "list_topics") {
      const admin = kafka.admin();
      await admin.connect();
      const topics = await admin.listTopics();
      await admin.disconnect();
      return topics.join("\n") || "No topics found.";
    }

    return `Unknown Kafka action: ${action}`;
  } catch (err) {
    return `Kafka error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
