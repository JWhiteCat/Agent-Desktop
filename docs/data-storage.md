# Data storage

[Documentation](README.md) · [Project home](../README.md) · [简体中文](data-storage.zh-CN.md)

Projects, conversation metadata, and settings are stored in `data/` under Electron’s userData directory:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Agent Desktop\data` |
| macOS | `~/Library/Application Support/Agent Desktop/data` |
| Linux | `~/.config/Agent Desktop/data` |

`state.json` stores projects, the conversation list, and settings, including MCP servers, skill bodies, the default CLI, Grok Bot names added by hand, and the widths of the resizable panels. Grok Bot files are not copied: they are read from the Grok Bot desktop app's own cache when shown, and saved only where you choose. `grokbot-cache.json` keeps recent Grok Bot messages so a bot opens quickly after a restart: for each bot name, its API session id, read position, and recent messages (file names and hashes, not file bytes). It is tied to the API key by a 16-character SHA-256 prefix (the key itself is not stored), keeps at most 20 bots and about 256 KiB of messages per bot, and drops older messages first. Deleting it only makes the next visit load the full history. Each conversation remembers whether it uses Cursor, Codex, or Claude. Messages for each conversation live in `threads/`. Cursor session records stay in `~/.cursor/chats`, Codex records stay in `~/.codex/sessions`, and Claude records stay in `~/.claude/projects`. The app reads and resumes those records and creates separate copies when forking. Enabled skills are written to `~/.cursor/skills`, `~/.agents/skills`, `~/.codex/skills`, and `~/.claude/skills`. MCP servers and skills disabled in the All local section are held under `local-config/` in the data folder. Worktrees for Codex and Claude conversations live under `worktrees/<repo>/<branch>-<suffix>` in the data folder, on a branch named `agent-desktop/<branch>-<suffix>`. Deleting a conversation or project runs `git worktree remove` when no other conversation or project uses that worktree or one of its subdirectories. A worktree with uncommitted or untracked files is kept. The branch is deleted with `git branch -d`, so a branch with unmerged commits stays. A saved worktree conversation reports a missing directory instead of silently resuming in the main project.

## Forked conversations

A full fork copies the CLI session into an independent conversation: Cursor copies a consistent database snapshot, while Codex and Claude use their adapters' native fork support. Forking at a message keeps history through that message. When a CLI cannot copy that exact point, or native copying fails, the app saves the selected history and sends it as context with the fork's next message. This includes prior replies and tool results. The pending context survives restarts and failed sends and is cleared after a successful reply. CLI history sync also restores these copied messages. A fork whose context has not yet been delivered must complete a message before syncing. The source conversation is preserved.

## Development profiles and multiple windows

During development, `AGENT_DESKTOP_USER_DATA` points userData at another directory.

Several windows can be open at once. Each process writes its Chromium cache (GPU cache, HTTP cache, localStorage) under the profile’s private `userData/session-cache/<pid>` directory, so the processes do not lock each other’s files. Projects and conversations still share the `data/` directory above. If two windows write the same data, the later write wins. On exit, the process deletes its own cache directory. Directories left by a crash are removed on the next launch.
