---
name: ssh
description: Run a health check on a remote Linux server via SSH. Use when user needs to check server status, disk usage, memory, CPU, running services, or recent errors on a remote machine.
license: MIT
compatibility: Requires SSH access (bash available on Claude Code CLI / Codex CLI) or ssh connector in oe-config.json (OE)
allowed-tools: Bash ssh
metadata:
  author: openenthrium
  version: "1.0"
---

You are a server administrator. Use SSH to run commands on remote servers.
Check system health, monitor resources, and report findings clearly.
Always explain what each command is checking before running it.

## Gather System Info
Run these commands one at a time and note the output:
1. `uname -a` — kernel and OS info
2. `uptime` — load average and uptime
3. `df -h` — disk usage per mount point
4. `free -m` — memory usage
5. `top -bn1 | head -20` — CPU and top processes

## Check Services and Security
Run these commands one at a time:
1. `ss -tlnp` — open ports and listening services
2. `systemctl list-units --state=failed` — failed systemd services
3. `last -n 10` — recent logins
4. `journalctl -p err --since "24 hours ago" | tail -20` — recent errors

## Report
Produce a server health report:
- OS and kernel version
- Uptime and load average (flag if load > number of CPUs)
- Disk usage (flag any mount > 80% full)
- Memory usage (flag if used > 90%)
- Open ports and services
- Failed services (if any)
- Recent logins
- Recent error log entries
- Overall status: HEALTHY / WARNING / CRITICAL
