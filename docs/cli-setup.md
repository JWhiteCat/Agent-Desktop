# CLI setup

[Documentation](README.md) · [Project home](../README.md) · [简体中文](cli-setup.zh-CN.md)

## Requirements

- [Node.js 24 LTS](https://nodejs.org/en/download) is recommended. Node 22.12+ (22.x) and Node 26+ also satisfy the current Electron and test toolchain requirements
- At least one authenticated CLI. Cursor, Codex, Claude, and Antigravity are supported.
- The git tab of the changes panel needs `git` on `PATH`

## Install from Agent Desktop

Choose a CLI in the composer or open **Settings → CLI** and click **Install**. Agent Desktop downloads and verifies the release on the host computer and stores it under `data/cli/` in the app data directory. This is available on Windows x64, macOS x64 and arm64, and Linux x64. Sign in or enter your API key after installation.

The app uses the configured path first, then an existing installation, then its managed version. Codex and Claude use native versions matched to the included ACP adapters. For Antigravity, **Install** downloads Google’s official `agy` and checks that `agy acp` starts before activating it. After upgrading from a release that installed the Antigravity ACP Registry server, click **Install** to get `agy` if the app cannot find it on your system.

## Optional standalone installation

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

The app uses `@agentclientprotocol/codex-acp` to run the detected Codex executable.

### Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

The app uses `@agentclientprotocol/claude-agent-acp` to run the detected Claude executable. On Windows, npm's `claude`, `claude.cmd`, and `claude.ps1` shims are skipped: the adapter spawns `CLAUDE_CODE_EXECUTABLE` directly, and spawning that shell script fails with `EINVAL`.

### Install Antigravity CLI

To run the app-managed `agy` from a terminal, copy its executable path from **Settings → CLI → Antigravity CLI**. Agent Desktop keeps that copy under `data/cli/antigravity-cli/`. For regular terminal use of the managed copy, set `AGY_CLI_DISABLE_AUTO_UPDATE=true` in that shell so updates continue through Agent Desktop.

To use the `agy` command by name on `PATH`, follow the [official installation guide](https://antigravity.google/docs/getting-started?tab=cli) to install version 1.5.0 or later. Open a new terminal and run `agy --version` to verify. In Agent Desktop, click **Check again** on the Antigravity card.

### CLI detection

The app looks for the CLIs automatically:

| OS | Cursor | Codex | Claude | Antigravity |
| --- | --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` | `codex` on `PATH` | `claude.exe` on `PATH`, or `%USERPROFILE%\.local\bin\claude.exe` | `agy.exe` on `PATH`, or `%LOCALAPPDATA%\agy\bin\agy.exe` |
| macOS / Linux | `~/.local/bin/agent`, `/usr/local/bin/agent`, `/opt/homebrew/bin/agent` | `~/.local/bin/codex`, `/usr/local/bin/codex`, `/opt/homebrew/bin/codex`, and `PATH` | `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, and `PATH` | `agy` on `PATH` or in common locations such as `~/.local/bin` |

For a custom installation, set the executable or install directory in Settings.

macOS packages do not need a separate Node.js installation: the Codex and Claude ACP adapters use the app runtime. Finder launches usually do not inherit a terminal's initialized PATH. Discovery adds common locations including `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`, retaining inherited PATH precedence. For a CLI installed in a nonstandard directory by nvm or another manager, select its executable or installation prefix in Settings; `~/`, quoted paths and spaces are supported. The app does not run shell startup files.

CLI detection results are cached per provider in `cli-info-cache.json` in the app's data directory, including across restarts. Opening Settings, switching tabs, or changing the interface language reuses the cache. Automatic detection runs only when no valid cache exists. The cache includes missing-CLI results and has no timed expiration.

Changing a CLI's path or API key, finishing a login, or finishing an update triggers detection for that CLI. Use **Check again** to refresh manually, including after installing, updating, or changing CLI authentication outside the app. Remote pages share the desktop main process's cache. Authentication configuration is stored only as a digest in this cache, without an additional plaintext copy of API keys.

### Authentication

Cursor auth prefers a [Cursor API key](https://cursor.com/dashboard/api). A key saved in Settings overrides the `CURSOR_API_KEY` environment variable. The app passes it to the CLI as `CURSOR_API_KEY`, not as a command-line argument, so it does not appear in process listings. Without a key, the app uses the browser login saved by `agent login`.

Codex auth prefers the key in Settings, then `CODEX_API_KEY`, then `OPENAI_API_KEY`. If none of those are set, it uses ChatGPT sign-in. The app passes the system proxy Chromium would use for `https://chatgpt.com` to Codex. `HTTP_PROXY` and `HTTPS_PROXY` already set in the environment take precedence.

Claude auth prefers the key in Settings, then `ANTHROPIC_API_KEY`. If either is set, Claude Code bills the API and does not use a Claude subscription. If neither is set, it uses the login stored in `~/.claude`. The login button runs the adapter's Claude.ai login.

Antigravity uses the Gemini API key in Settings first, then `GEMINI_API_KEY`, then the credentials saved by the selected Antigravity runtime. The login button opens Google's personal account sign-in. For Gemini Enterprise or terminal sign-in, use the [Antigravity CLI authentication guide](https://antigravity.google/docs/ide/extensions/acp/#authentication).

Both app-managed and standalone installations of `agy` use the CLI’s sign-in and session store and support the CLI sandbox setting. Conversations started with the older ACP Registry server continue to use that server and its separate sign-in and session store. Antigravity exposes the models and thinking levels available to your account. Use **Settings → Appearance & History → Import** to import existing Antigravity conversations. The conversation menu can reload an imported transcript. Forking starts a separate session and sends the copied history with its first prompt.

Antigravity reads MCP from `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json`. Its local skills include `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`, and the project's `.agents/skills`.

## Updating a CLI

Open Settings → CLI and click **Update** to the right of that CLI's login button. The desktop app runs the update on this computer, including when you use the remote page. The button shows **Updating…** while it runs, and the card keeps the result or error for review. A successful update refreshes that CLI's version and model list.

Cursor, native Claude Code, and Antigravity use their `update` command. Codex installed through npm is updated in its existing installation prefix, and Homebrew installations use Homebrew. Unsupported installations show instructions for updating. Managed builds use the same verified download flow as installation. Codex and Claude versions follow the adapters in each Agent Desktop release. The managed Cursor version follows the app’s verified release catalog.
