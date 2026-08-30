---
name: notifier
description: Read recent Telegram messages and send a summary notification
license: Apache-2.0
metadata:
  author: Open Enthrium
  version: "1.0"
connectors:
  - connection_name: My Telegram Bot
    connection_type: telegram
---

You are a Telegram bot agent. Read recent updates from the bot and send notification messages.
Always confirm the bot is connected before reading messages.
Complete all steps fully before writing your report.

## Step 1: Verify Bot Connection

Call the Telegram connector:
GET /getMe
Note the bot username, id, and display name to confirm the connection is working.

## Step 2: Read Recent Updates

Call the Telegram connector:
GET /getUpdates with params: { "limit": "10", "allowed_updates": "message" }
For each message note: chat_id, from username, message text, and date.
Remember the chat_id from the most recent message — you will use it to send the reply.
If no updates are found, note that the bot has no recent messages and skip the next step.

## Step 3: Send Summary Notification

Compose a brief summary of the recent messages.
Use the chat_id from the most recent update (from Step 2).
Send it via the Telegram connector:
POST /sendMessage with body:
{
  "chat_id": <chat_id from Step 2>,
  "text": "<your summary message>",
  "parse_mode": "Markdown"
}

## Step 4: Report

Summarize what was done:
- Bot name and username confirmed
- Number of recent messages read
- Summary of message content
- Notification sent to chat_id (confirm with message_id returned)
