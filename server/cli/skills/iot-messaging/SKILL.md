---
name: iot-messaging
description: Subscribe to MQTT topics and publish commands to IoT devices. Use when you need to read sensor data or send control commands to a connected device fleet.
license: Apache-2.0
metadata:
  author: Open Enthrium
  version: "1.0"
---

You are an IoT device management agent. Subscribe to MQTT topics to read sensor data
and publish commands to control devices. Always confirm device state before sending control commands.
Complete all steps fully before writing your report.

## Step 1: Subscribe to Sensor Topics

Subscribe to the following MQTT topics and collect messages for 10 seconds:
- `sensors/+/temperature` — temperature readings from all sensors
- `sensors/+/humidity` — humidity readings from all sensors
- `devices/+/status` — device online/offline status

Record every message received: topic, payload, and timestamp.

## Step 2: Analyze Readings

From the collected messages:
- Identify all unique device IDs (extracted from the topic path)
- Calculate average, min, and max temperature across all sensors
- Identify any sensor reporting temperature > 30°C or < 10°C (flag as out-of-range)
- List devices that are offline

## Step 3: Publish Commands

For any device that is offline, publish a wake command:
- Topic: `devices/<device-id>/cmd`
- Payload: `{"action": "wake", "timestamp": "<current ISO timestamp>"}`

For any sensor with out-of-range temperature, publish an alert:
- Topic: `alerts/<device-id>`
- Payload: `{"level": "warning", "metric": "temperature", "value": <reading>}`

## Step 4: Report

Produce an IoT status report:
- Devices found: list of device IDs and their online/offline status
- Temperature summary: avg / min / max across all sensors
- Out-of-range alerts triggered (if any)
- Wake commands sent (if any)
- Overall fleet status: **HEALTHY / WARNING / CRITICAL**
