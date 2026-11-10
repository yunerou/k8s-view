# Changelog

## Unreleased

- Add a local MCP server and standalone stdio bridge for Claude Code and Codex CLI/IDE, with 11 pipeline/job/log tools, workspace routing and setup commands for POSIX/PowerShell.
- Require VS Code modal approval for all MCP actions, cancel pending actions on disconnect, and avoid automatically replaying mutations.
- Add private discovery files, loopback authentication, bounded log output and automated HTTP/stdio lifecycle coverage. Live macOS smoke passed for Claude Code and Codex CLI/IDE (reads and retry-job approval/decline). Remote, Linux runtime and Windows ACL smoke verification remains pending.

## 0.0.1

- Initial release: pipeline/job tree by repository, Full view with DAG, run/retry/cancel/play with variables, live job logs, status bar, notifications, and per-host token management with expiration warnings.
