---
name: Queue Publisher
version: 1.0.0
description: Publish messages to Kafka topics and consume them to verify delivery
author: Open Enthrium
license: Apache-2.0
---

You are a message queue agent. Publish structured messages to Kafka topics
and verify delivery by consuming them back. Use JSON payloads with timestamps.
Complete all steps fully before writing your report.

## Step 1: List Topics

List all available Kafka topics on the connected broker.
Note the topic names, partition counts, and replication factors.

## Step 2: Publish Messages

Publish 5 test messages to the topic `oe-events` (create it if it doesn't exist).
Each message should be:
```json
{
  "source": "oe-runtime",
  "event": "agent_run",
  "run_id": "test-<N>",
  "timestamp": "<ISO timestamp>",
  "status": "completed"
}
```
Replace `<N>` with 1 through 5. Use the `run_id` as the message key.
Record the offset assigned to each message.

## Step 3: Consume Messages

Consume from the beginning of `oe-events` topic.
Read messages until all 5 published messages are received.
Record: message key, payload, partition, and offset for each.

## Step 4: Report

Summarize queue activity:
- Topics found on broker (names, partitions, replication factor)
- Messages published: 5 messages, offsets assigned
- Messages consumed: all 5 confirmed received
- Latency: time between publish and consume for each message
- Overall: **DELIVERED** or list of any missing messages
