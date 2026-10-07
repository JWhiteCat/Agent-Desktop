# MCP and skills

[Documentation](README.md) · [Project home](../README.md) · [简体中文](integrations.zh-CN.md)

Add MCP servers in Settings. When enabled, new and resumed sessions pass them in ACP `mcpServers` (stdio, HTTP, or SSE). The list lives in this app’s `state.json`. It does not rewrite `~/.cursor/mcp.json`.

An enabled skill is written to `~/.cursor/skills/<name>/SKILL.md`, to Codex paths `~/.agents/skills/<name>/SKILL.md` and `~/.codex/skills/<name>/SKILL.md`, and to `~/.claude/skills/<name>/SKILL.md`. The name may contain only lowercase letters, digits, and hyphens, and it needs a description. The CLI uses that description to decide whether to apply the skill. Disabling or deleting a skill removes only directories this app created. A same-named directory that this app did not create is left in place, and save reports that it could not be overwritten.

## All local

The All local section of the MCP and Skill pages scans each CLI's own configuration on this machine. You can add, edit, enable, disable, and delete entries directly in those native files:

| CLI | User MCP | Project MCP | Skill folders |
| --- | --- | --- | --- |
| Cursor | `~/.cursor/mcp.json` | `<project>/.cursor/mcp.json` | `~/.cursor/skills`, `<project>/.cursor/skills` |
| Codex | `[mcp_servers.*]` in `~/.codex/config.toml` | `<project>/.codex/config.toml` | `~/.agents/skills`, `~/.codex/skills`, `<project>/.agents/skills`, `<project>/.codex/skills` |
| Claude | `mcpServers` in `~/.claude.json`, plus `projects[<path>].mcpServers` (local scope) | `<project>/.mcp.json` | `~/.claude/skills`, `<project>/.claude/skills` |

Projects are the ones added to the sidebar. A new entry asks for the CLI and the scope: user, or one of the projects.

- MCP: Codex uses its native `enabled = false`. Edits to `config.toml` replace only that server's `[mcp_servers.<name>]` table and its subtables, so the rest of the file and its comments stay as they were. Cursor and Claude have no disable switch. A disabled server is moved out of the file into `local-config/disabled-mcp.json` in this app's data folder and written back when enabled. Codex servers defined as inline tables under `[mcp_servers]` are read-only. Codex does not support the SSE transport.
- Skills: disabling moves the folder to `local-config/disabled-skills/`, and enabling moves it back. Deleting moves the folder to the trash. Editing rewrites only `name`, `description`, and the body of `SKILL.md`. Other frontmatter keys and other files in the folder are kept. When the folder name matches the old name, renaming the skill renames the folder too.
- Read-only sources: CLI built-in skills (`~/.cursor/skills-cursor`, `~/.codex/skills/.system`) and plugin skills (`~/.cursor/plugins`, `~/.codex/plugins`, `~/.claude/plugins`) are overwritten when the CLI updates, so you can only view them and open their folders. Skill folders created by this app are marked This app and are edited in that section.
- Safety: before this app first changes a configuration file, it saves a copy next to it as `<file>.agent-desktop.bak`. Each write compares the file with what was listed. If another program has changed it, the write is refused and you need to refresh.
- The remote page can use these features too, without the Open file and Open folder buttons.

After MCP, skills, the CLI path, the API key, or the sandbox setting changes, an idle CLI process exits. The new configuration is used on the next message.
