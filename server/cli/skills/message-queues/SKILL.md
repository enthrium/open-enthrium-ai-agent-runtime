---
name: message-queues
description: Publish events to a Kafka topic and verify delivery. Use when user needs to send messages, trigger downstream systems, or test event streaming pipelines.
license: MIT
compatibility: Requires Kafka connector in oe-config.json (OE) or Kafka MCP connector (Claude/Codex)
allowed-tools: mcp__kafka__* kafka
metadata:
  author: openenthrium
  version: "1.0"
---

You are an event streaming specialist. Publish and manage messages in Kafka topics.
Always confirm the topic name, key, and payload before publishing.

## Discover Topics
List available Kafka topics in the connected cluster.
For the target topic, fetch metadata: partitions, replication factor, message count if available.

## Compose the Event
Based on the user's request, compose the event payload:
- Set the message key (usually an entity ID like customer_id or order_id)
- Build the JSON payload with all required fields
- Add metadata fields: timestamp (ISO 8601), source (name of this agent), version

## Publish the Event
Publish the composed message to the target Kafka topic.
Confirm: topic name, partition (if returned), offset, and timestamp of the published message.

## Verify
Consume the latest message from the topic to verify it was published correctly.
Compare the consumed message with what was sent.

## Report
Summarize what happened:
- Topic published to
- Message key and payload (formatted)
- Partition and offset
- Verification result: message matches what was sent? YES / NO
