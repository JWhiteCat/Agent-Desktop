# CLI setup

[Documentation](README.md) · [Project home](../README.md) · [简体中文](cli-setup.zh-CN.md)

## Requirements

- [Node.js 24 LTS](https://nodejs.org/en/download) is recommended. Node 22.12+ (22.x) and Node 26+ also satisfy the current Electron and test toolchain requirements
- At least one authenticated CLI. Cursor, Codex, Claude, and Antigravity are supported.
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

### Install Antigravity CLI

Install `agy` 1.5.0 or later with the [official installer](https://antigravity.google/docs/cli/install/). Verify with `agy --version`, then select **Antigravity CLI** under **Settings → CLI** or in the composer. Agent Desktop launches the installed CLI with `agy acp`.

### CLI detection

The app looks for the CLIs automatically:

| OS | Cursor | Codex | Claude | Antigravity |
| --- | --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` | `codex` on `PATH` | `claude.exe` on `PATH`, or `%USERPROFILE%\.local\bin\claude.exe` | `agy.exe` on `PATH`, or `%LOCALAPPDATA%\agy\bin\agy.exe` |
| macOS / Linux | `~/.local/bin/agent`, `/usr/local/bin/agent`, `/opt/homebrew/bin/agent` | `~/.local/bin/codex`, `/usr/local/bin/codex`, `/opt/homebrew/bin/codex`, and `PATH` | `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, and `PATH` | `agy` on `PATH` or in common locations such as `~/.local/bin` |

If nothing is found, set the executable or install directory in Settings.

macOS packages do not need a separate Node.js installation: bundled Codex/Claude adapters use the app runtime. Finder launches usually do not inherit a terminal's initialized PATH. Discovery adds common locations including `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`, retaining inherited PATH precedence. For a CLI installed in a nonstandard directory by nvm or another manager, select its executable or installation prefix in Settings; `~/`, quoted paths and spaces are supported. The app does not run shell startup files.

CLI detection results are cached per provider in `cli-info-cache.json` in the app's data directory, including across restarts. Opening Settings, switching tabs, or changing the interface language reuses the cache. Automatic detection runs only when no valid cache exists. The cache includes missing-CLI results and has no timed expiration.

Changing a CLI's path or API key, finishing a login, or finishing an update triggers detection for that CLI. Use **Check again** to refresh manually, including after installing, updating, or changing CLI authentication outside the app. Remote pages share the desktop main process's cache. Authentication configuration is stored only as a digest in this cache, without an additional plaintext copy of API keys.

### Authentication

Cursor auth prefers a [Cursor API key](https://cursor.com/dashboard/api). A key saved in Settings overrides the `CURSOR_API_KEY` environment variable. The app passes it to the CLI as `CURSOR_API_KEY`, not as a command-line argument, so it does not appear in process listings. Without a key, the app uses the browser login saved by `agent login`.

Codex auth prefers the key in Settings, then `CODEX_API_KEY`, then `OPENAI_API_KEY`. If none of those are set, it uses ChatGPT sign-in. The app passes the system proxy Chromium would use for `https://chatgpt.com` to Codex. `HTTP_PROXY` and `HTTPS_PROXY` already set in the environment take precedence.

Claude auth prefers the key in Settings, then `ANTHROPIC_API_KEY`. If either is set, Claude Code bills the API and does not use a Claude subscription. If neither is set, it uses the login stored in `~/.claude`. The login button runs the adapter's Claude.ai login.

Antigravity uses the Gemini API key in Settings first, then `GEMINI_API_KEY`, then the credentials already saved by `agy`. The login button opens Google's personal account sign-in. For Gemini Enterprise or terminal sign-in, use the [Antigravity CLI authentication guide](https://antigravity.google/docs/ide/extensions/acp/#authentication).

Antigravity exposes the models and thinking levels available to your account. Use **Settings → Appearance & History → Import** to import existing Antigravity conversations. The conversation menu can reload an imported transcript. Forking starts a separate session and sends the copied history with its first prompt.

Antigravity reads MCP from `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json`. Its local skills include `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`, and the project's `.agents/skills`.

## Updating a CLI

Open Settings → CLI and click **Update** to the right of that CLI's login button. The desktop app runs the update on this computer, including when you use the remote page. The button shows **Updating…** while it runs, and the card keeps the result or error for review. A successful update refreshes that CLI's version and model list.

Cursor, native Claude Code, and Antigravity use their `update` command. Codex installed through npm is updated in its existing installation prefix, and Homebrew installations use Homebrew. Unsupported installations show instructions for updating. Built-in Codex and Claude versions are updated with Agent Desktop, so their Update buttons are disabled. Install a standalone CLI and select it in Settings to update it separately.
