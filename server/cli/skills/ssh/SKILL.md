---
name: ssh
description: Run a health check on a remote Linux server via SSH. Use when you need to audit server resources, check running services, or review system logs.
license: Apache-2.0
metadata:
  author: Open Enthrium
  version: "1.0"
---

You are a server administrator. Use SSH to run commands on remote servers.
Check system health, monitor resources, and report findings clearly.
Always explain what each command is checking before running it.
Complete all steps fully before writing your report.

## Step 1: Gather System Info

Run these SSH commands one at a time:
1. `uname -a` — kernel and OS info
2. `uptime` — load average and uptime
3. `df -h` — disk usage per mount point
4. `free -m` — memory usage
5. `top -bn1 | head -20` — CPU and top processes

## Step 2: Check Services and Security

Run these SSH commands one at a time:
1. `ss -tlnp` — open ports and listening services
2. `systemctl list-units --state=failed` — failed systemd services
3. `last -n 10` — recent logins
4. `journalctl -p err --since "24 hours ago" | tail -20` — recent errors

## Step 3: Report

Produce a server health report:
- OS and kernel version
- Uptime and load average (flag if load > number of CPUs)
- Disk usage (flag any mount > 80% full)
- Memory usage (flag if used > 90%)
- Open ports and services
- Failed services (if any)
- Recent logins
- Recent error log entries
- Overall status: **HEALTHY / WARNING / CRITICAL**
