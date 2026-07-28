const { S3Client, ListBucketsCommand, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

function getClient(connector) {
  const auth = connector.authConfig ? JSON.parse(connector.authConfig) : {};
  const cfg  = connector.config     ? JSON.parse(connector.config)     : {};

  const accessKeyId     = auth.accessKeyId     || cfg.accessKeyId     || "";
  const secretAccessKey = auth.secretAccessKey || cfg.secretAccessKey || "";
  const region          = auth.region          || cfg.region          || "us-east-1";
  const endpoint        = auth.endpoint        || cfg.endpoint        || auth.baseUrl || cfg.baseUrl || undefined;

  return {
    client: new S3Client({
      region,
      credentials: accessKeyId ? { accessKeyId, secretAccessKey } : undefined,
      endpoint,
      forcePathStyle: !!endpoint,
    }),
    defaultBucket: auth.bucket || cfg.bucket || "",
  };
}

function getToolDefinitions(connector) {
  return [
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_list_buckets`,
        description: `List all S3 buckets accessible from "${connector.name}".`,
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_list_objects`,
        description: `List objects in a bucket on "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            bucket: { type: "string", description: "Bucket name (uses configured default if omitted)" },
            prefix: { type: "string", description: "Optional key prefix to filter" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_get_object`,
        description: `Read/download an object from "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            bucket: { type: "string" },
            key:    { type: "string", description: "Object key" },
          },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_put_object`,
        description: `Upload/write an object to "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            bucket:  { type: "string" },
            key:     { type: "string" },
            content: { type: "string", description: "Text content to upload" },
          },
          required: ["key", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: `conn_${connector.id}_delete_object`,
        description: `Delete an object from "${connector.name}".`,
        parameters: {
          type: "object",
          properties: {
            bucket: { type: "string" },
            key:    { type: "string" },
          },
          required: ["key"],
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
  const { client, defaultBucket } = getClient(connector);
  const bucket = args.bucket || defaultBucket;

  try {
    if (action === "list_buckets") {
      const res = await client.send(new ListBucketsCommand({}));
      return (res.Buckets || []).map(b => `${b.Name} (created: ${b.CreationDate})`).join("\n") || "No buckets found.";
    }
    if (action === "list_objects") {
      if (!bucket) return "Bucket name required.";
      const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: args.prefix || undefined, MaxKeys: 100 }));
      return (res.Contents || []).map(o => `${o.Key} (${o.Size} bytes)`).join("\n") || "Empty bucket.";
    }
    if (action === "get_object") {
      if (!bucket) return "Bucket name required.";
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: args.key }));
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8").slice(0, 8000);
    }
    if (action === "put_object") {
      if (!bucket) return "Bucket name required.";
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: args.key, Body: args.content || "" }));
      return `Uploaded: s3://${bucket}/${args.key}`;
    }
    if (action === "delete_object") {
      if (!bucket) return "Bucket name required.";
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: args.key }));
      return `Deleted: s3://${bucket}/${args.key}`;
    }
    return `Unknown S3 action: ${action}`;
  } catch (err) {
    return `S3 error: ${err.message}`;
  }
}

module.exports = { getToolDefinitions, getAnthropicToolDefinitions, executeTool };
