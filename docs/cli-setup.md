# CLI setup

[Documentation](README.md) · [Project home](../README.md) · [简体中文](cli-setup.zh-CN.md)

## Requirements

- [Node.js 24 LTS](https://nodejs.org/en/download) is recommended. Node 22.12+ (22.x) and Node 26+ also satisfy the current Electron and test toolchain requirements
- At least one CLI: a Cursor CLI that is signed in or has an API key, Codex CLI (the bundled Codex is used when `codex` is not on this machine), or Claude Code (the adapter's bundled Claude is used when `claude` is not on this machine)
- The git tab of the changes panel needs `git` on `PATH`

### Install Cursor CLI

```powershell
# Windows (PowerShell)
irm 'https://cursor.com/install?win32=true' | iex
```

```bash
# macOS / Linux
curl https://cursor.com/install -fsS | bash
```

### Install Codex CLI

```bash
npm install -g @openai/codex
```

A separate install is optional. The app drives Codex through `@agentclientprotocol/codex-acp`. When the path in Settings is empty and `codex` is not on `PATH`, it uses the Codex shipped with the adapter. Settings then says it is using the built-in Codex.

### Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

A separate install is optional. The app drives Claude Code through `@agentclientprotocol/claude-agent-acp`. When the path in Settings is empty and no native `claude` binary is on `PATH`, it uses the Claude binary shipped with the adapter. Settings then says it is using the built-in Claude. On Windows, npm's `claude`, `claude.cmd`, and `claude.ps1` shims are skipped: the adapter spawns `CLAUDE_CODE_EXECUTABLE` directly, and spawning that shell script fails with `EINVAL`.

### CLI detection

The app looks for the CLIs automatically:

| OS | Cursor | Codex | Claude |
| --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` | `codex` on `PATH` | `claude.exe` on `PATH`, or `%USERPROFILE%\.local\bin\claude.exe` |
| macOS / Linux | `~/.local/bin/agent`, `/usr/local/bin/agent`, `/opt/homebrew/bin/agent` | `~/.local/bin/codex`, `/usr/local/bin/codex`, `/opt/homebrew/bin/codex`, and `PATH` | `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, and `PATH` |

If nothing is found, set the executable or install directory in Settings.

### Authentication

Cursor auth prefers a [Cursor API key](https://cursor.com/dashboard/api). A key saved in Settings overrides the `CURSOR_API_KEY` environment variable. Without a key, the app uses the browser login saved by `agent login`.

Codex auth prefers the key in Settings, then `CODEX_API_KEY`, then `OPENAI_API_KEY`. If none of those are set, it uses ChatGPT sign-in.

Claude auth prefers the key in Settings, then `ANTHROPIC_API_KEY`. If either is set, Claude Code bills the API and does not use a Claude subscription. If neither is set, it uses the login stored in `~/.claude`. The login button runs the adapter's Claude.ai login.

## Updating a CLI

Open Settings → CLI and click **Update** to the right of that CLI's login button. The desktop app runs the update on this computer, including when you use the remote page. The button shows **Updating…** while it runs, and the card keeps the result or error for review. A successful update refreshes that CLI's version and model list.

Cursor and native Claude Code use their `update` command. Codex installed through npm is updated in its existing installation prefix; Homebrew installations use Homebrew. Unsupported installations show instructions instead of updating a different copy. Built-in Codex and Claude versions are updated with Agent Desktop, so their Update buttons are disabled. Install a standalone CLI and select it in Settings to update it separately.
