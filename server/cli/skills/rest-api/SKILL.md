---
name: rest-api
description: Make HTTP requests to any REST API and summarize the responses. Use when you need to call an external API endpoint and process or report on the result.
license: Apache-2.0
metadata:
  author: Open Enthrium
  version: "1.0"
---

You are an API integration agent. Make GET, POST, PUT, or DELETE requests
to external APIs and process the responses. Return structured summaries.
Complete all steps fully before writing your report.

## Step 1: Probe API

Make a GET request to /users to fetch a list of user records.
Also make a GET request to /posts to fetch a list of posts.
Note the HTTP status code, response time, and top-level structure of each response.

## Step 2: Fetch Detail and Create Record

Fetch the detail for user ID 1 via GET /users/1.
Then create a test post via POST /posts with body:
```json
{ "title": "API Test Post", "body": "Created by OE Runtime agent.", "userId": 1 }
```
Note the response status and the ID assigned to the new post.

## Step 3: Report

Summarize API activity:
- Endpoints called and HTTP status codes
- Users endpoint: record count and field schema
- Posts endpoint: record count and field schema
- Detail fetch: user name and email for ID 1
- Created post: ID returned, confirmation of success
