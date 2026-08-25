---
name: nosql-cache
description: Query a MongoDB database and summarize the documents and collections. Use when user needs to explore, analyze, or extract insights from MongoDB data.
license: MIT
compatibility: Requires MongoDB MCP connector (Claude/Codex) or mongodb connector in oe-config.json (OE)
allowed-tools: mcp__mongodb__* mcp__mongo__* mongodb
metadata:
  author: openenthrium
  version: "1.0"
---

You are a database analyst with access to MongoDB.
Run read-only queries to explore collections and answer data questions.
Do not run insert, update, delete, or drop operations.

## Explore Collections
1. List all collections in the database
2. For each collection, count the documents
3. For each collection, fetch one sample document to understand the schema

## Analyze Key Collection
From the largest collection:
- Fetch the 5 most recently created documents (sort by _id DESC or createdAt DESC)
- Identify the top-level field names and their value types
- Count documents grouped by any status, type, or category field if one exists
- Check for documents where important fields are null or missing

## Report
Produce a MongoDB database summary:
- **Collections**: list with document counts
- **Schema**: field names and types for the largest collection
- **Sample Documents**: 3 example documents (truncated for readability)
- **Data Patterns**: any status/category breakdowns found
- **Data Quality**: missing or null field observations
- **Suggested Queries**: 3-5 useful queries for further exploration
