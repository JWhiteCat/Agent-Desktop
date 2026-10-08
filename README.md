# Agent Desktop

[简体中文](README.zh-CN.md)

A desktop client for [Cursor CLI](https://cursor.com/cli) (`agent`), [Codex CLI](https://github.com/openai/codex) (`codex`), and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`). Conversations are grouped by project. The window streams thinking, tool calls, and replies, and keeps a local history. The interface supports Simplified Chinese and English.

Agent Desktop runs the CLIs on your computer through the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Choose a CLI, model, and mode for each conversation.

## Features

- Manage multiple projects and search, pin, archive, and fork conversations
- Work in Agent, Plan, or Ask mode, with question cards and one-click plan execution
- Stream replies and tool calls, attach images and files, open local file links, and preview or copy link destinations
- Use desktop right-click menus to copy selected text and paste into chat and other editable fields
- Choose models with saved favorites, context length, reasoning effort, and Fast settings
- Start conversations in isolated git worktrees and review changes and diffs
- Import and resume Cursor, Codex, and Claude history
- Manage MCP servers and skills, track usage, and receive completion notifications
- Chat with your [Grok Bot](https://cursor.com/docs/grok-bot) bots, authenticated with `CURSOR_API_KEY`. The list merges the Grok Bot desktop app's cache with names you add in Settings, you can create bots by name, and files bots send are shown when the Grok Bot desktop app has cached them
- Use the same interface remotely over the LAN or an SSH reverse tunnel, with Chinese/English and light/dark themes

See the [user guide](docs/user-guide.md) for detailed behavior and shortcuts.

## Requirements

- [Node.js 24 LTS](https://nodejs.org/en/download) is recommended; Node 22.12+ (22.x) and Node 26+ are also supported by the current toolchain
- At least one authenticated CLI: Cursor CLI, Codex CLI, or Claude Code. Codex and Claude can use the binaries bundled with their adapters
- `git` on `PATH` for git diffs and isolated worktrees

See [CLI setup](docs/cli-setup.md) for installation, automatic detection, authentication, and updates. [Linux requirements and packaging](docs/development.md#linux-startup-and-packages) are documented separately.

## Quick start

From the project directory:

```bash
npm ci --include=dev --include=optional
npm run dev
```

On Windows, double-click [start-dev.bat](start-dev.bat) to install dependencies and start development mode, or [start-preview.bat](start-preview.bat) to build and launch a production preview. On Linux, run [start-dev.sh](start-dev.sh) or [start-preview.sh](start-preview.sh). The first run needs internet access to download dependencies and Electron.

1. Open **Settings → CLI** and select Cursor, Codex, or Claude. Sign in or configure an API key; Cursor prefers `CURSOR_API_KEY` when no key is saved in Settings.
2. Add a project folder, then choose a CLI, model, and mode in the composer.
3. Send a task and review the resulting file changes in the changes panel.

## Documentation

The [documentation index](docs/README.md) links to all guides. Each guide has an English and Simplified Chinese version.

| Guide | Contents |
| --- | --- |
| [CLI setup](docs/cli-setup.md) | Installation, CLI paths, authentication, and updates |
| [User guide](docs/user-guide.md) | Projects, conversations, models, attachments, shortcuts, and Plan mode |
| [MCP and skills](docs/integrations.md) | App-managed and native CLI configuration |
| [Usage statistics](docs/usage-stats.md) | Token counts, cost estimates, account quota, and Codex session accounting |
| [Remote control](docs/remote-control.md) | LAN access, SSH tunnels, access tokens, and server setup |
| [Data storage](docs/data-storage.md) | Local data, CLI history, forks, worktrees, and multiple windows |
| [Development guide](docs/development.md) | Startup, Linux packaging, commands, testing, localization, and module layout |

## Contributing

See the [development guide](docs/development.md) for the project structure and detailed test and packaging instructions. Run the offline checks before submitting code changes:

```bash
npm test
npm run typecheck
```

Live checks use `composer-2.5[fast=true]` and require CLI authentication; see [commands and tests](docs/development.md#commands-and-tests).
