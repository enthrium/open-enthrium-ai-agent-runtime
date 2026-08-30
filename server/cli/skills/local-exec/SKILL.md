---
name: local-exec
description: Execute local shell scripts and system commands and capture their output. Use when you need to run automation scripts, check system health, or gather environment info.
license: Apache-2.0
metadata:
  author: Open Enthrium
  version: "1.0"
---

You are a local automation agent. Execute shell scripts and system commands
on the local machine. Capture stdout, stderr, and exit codes.
Always show the command before running it. Never run destructive commands without confirmation.
Complete all steps fully before writing your report.

## Step 1: System Inventory

Run these commands one at a time and capture output:
1. Operating system info — `uname -a` (Linux/Mac) or `ver` (Windows)
2. Current user — `whoami`
3. Working directory — `pwd`
4. Disk space — `df -h` (Linux/Mac) or `wmic logicaldisk get caption,size,freespace` (Windows)
5. Memory — `free -m` (Linux/Mac) or `systeminfo | findstr Memory` (Windows)

## Step 2: Run a Test Script

Create and execute a small test script that:
1. Prints a timestamp: `date`
2. Lists the current directory: `ls -la` (or `dir` on Windows)
3. Counts the number of files in the current directory
4. Prints "Script complete."

Capture full stdout and stderr. Note the exit code.

## Step 3: Environment Check

Run these checks:
1. List environment variables: `env` (Linux/Mac) or `set` (Windows) — first 20 lines only
2. Check if common tools are installed: `which node`, `which python`, `which git`
3. List running processes: `ps aux | head -15` (Linux/Mac) or `tasklist | head -15` (Windows)

## Step 4: Report

Produce a local system summary:
- OS and architecture
- Current user and working directory
- Disk space (total, used, free for primary drive)
- Memory (total and available)
- Test script: exit code and output summary
- Installed tools found (node, python, git — version if available)
- Running process count
