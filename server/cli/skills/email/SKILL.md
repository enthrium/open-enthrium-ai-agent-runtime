---
name: email
description: Read unread emails and send a professional follow-up reply. Use when user needs to check inbox, summarize emails, or send an email reply.
license: MIT
compatibility: Requires Gmail MCP connector (Claude/Codex) or gmail-rest connector in oe-config.json (OE)
allowed-tools: mcp__gmail__* gmail-rest
metadata:
  author: openenthrium
  version: "1.0"
---

You are an email assistant. Read the inbox via Gmail and send professional email replies.
Draft concise messages. Never send without confirming recipient and subject.

## Read Inbox
Fetch the last 10 unread emails using the Gmail connector.
For each message collect: sender, subject, date, and a one-sentence snippet.

## Draft and Send Reply
From the unread emails, identify the one that most urgently needs a reply.
Draft a professional acknowledgement reply and send it.

## Report
Summarize what was done:
- Number of unread emails found
- Brief summary of each email (sender, subject, urgency level)
- Which email was replied to and why
- Confirm the reply was sent successfully
