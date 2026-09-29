# Agent Desktop

[中文](README.zh-CN.md)

A desktop client for [Cursor CLI](https://cursor.com/cli) (`agent`), [Codex CLI](https://github.com/openai/codex) (`codex`), and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`). Conversations are grouped by project. The window streams thinking, tool calls, and replies, and keeps a local history. The interface supports Simplified Chinese and English.

The app does not call a model itself. The main process starts the Cursor CLI, Codex CLI, or Claude Code adapter on this machine and talks to it over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). The composer picks Cursor, Codex, or Claude. A new conversation uses that choice and remembers it. In an existing conversation, switching CLI keeps the messages already on screen and starts the next message as a new session on the CLI you picked. The sidebar marks each one Cursor, Codex, or Claude.

## Features

- Multi-project sidebar: add, rename, reorder, collapse, and search conversations. Search matches the title, the preview, and the project name
- Fork a conversation from the header, the sidebar, a message, or by sending `/fork`, preserving its history as context for the next message
- Slash commands in a conversation: typing `/` lists `/fork` and the commands the CLI advertises. `/fork` runs in the app; other commands are sent as the next message
- Three modes: Agent (can edit files and run commands), Plan (read-only plan; pick answers and run the plan in one click), Ask (read-only Q&A)
- Model picker: Cursor, Codex, and Claude each remember favorite models, a default model, and each model’s context length, reasoning effort, and Fast. Codex lists reasoning effort per model, for example Ultra on Astra. Claude lists the effort levels the adapter advertises for the current model. Each project remembers the last model chosen for that CLI
- A new Cursor conversation can run in an isolated git worktree. Codex and Claude have no worktree switch
- Changes panel with two tabs: files edited in this conversation, and the git branch, status, and diff of the working directory
- After a turn, the files changed in that turn are listed under the reply; click one to see its diff
- When a turn finishes, the reply shows elapsed time, tokens, the model used, and a cost estimate from public list prices. Codex also shows “本轮周额度” with the cumulative weekly and 5-hour allowance usage attributed to that session by Codex, when available; the tooltip explains the cumulative scope. New ChatGPT-authenticated Codex turns add “本轮预估周额度”, the change in the account's weekly used percentage during that turn. Missing or incomplete readings are marked accordingly. Account quota is shown in Settings → Usage
- Import CLI history from `~/.cursor/chats`, `~/.codex/sessions`, and `~/.claude/projects`, grouped into projects by working directory
- Continue a saved session with ACP `session/load`, or rebuild the transcript from CLI storage. Copying the session id lets you resume a Cursor chat in a terminal with `agent --resume`
- System notification when a task finishes; clicking it returns to that conversation. A finished run that is not on screen leaves an unread dot
- Theme: follow the system, dark, or light
- Language: follow the system, Simplified Chinese, or English; changes take effect immediately and persist across restarts
- Settings are a left-hand list: CLI, MCP, Skill, Models, Usage, Defaults, Notifications, Remote control, and Appearance and history. The CLI page detects Cursor, Codex, and Claude separately, and holds paths, API keys, sign-in, and an Update button next to sign-in. Updates show progress and the command result, then refresh the version and model list. The Models page uses Cursor / Codex / Claude tabs for favorites and the default model. History import lives on the Appearance and history page
- Usage: account quota for Cursor and Codex (5-hour, weekly, or monthly windows and the next reset, when the account returns them). Claude account quota is not shown yet. Cursor models and other models also show that pool’s tokens and the account’s price. Other models uses the included API usage percent only. On-demand spend shows used and limit on the same line, and tokens when the account returns them, without repeating the price. Below that, token totals for the last 1, 7, and 30 days and a paginated list of every past session with its models and cumulative usage. Local costs use [Cursor’s public prices](https://cursor.com/docs/models-and-pricing) for Cursor and [OpenAI API prices](https://developers.openai.com/api/docs/pricing) for Codex. These are usage estimates, not subscription bills. Auto and models missing from the price list are shown as unpriced
- Remote control: scan a QR code on the LAN, or open the same page from the public internet through an SSH reverse tunnel

## Requirements

- Node.js 22.12 or newer
- At least one CLI: a Cursor CLI that is signed in or has an API key, Codex CLI (the bundled Codex is used when `codex` is not on this machine), or Claude Code (the adapter's bundled Claude is used when `claude` is not on this machine)
- The git tab of the changes panel needs `git` on `PATH`

Install Cursor CLI:

```powershell
# Windows (PowerShell)
irm 'https://cursor.com/install?win32=true' | iex
```

```bash
# macOS / Linux
curl https://cursor.com/install -fsS | bash
```

Install Codex CLI:

```bash
npm install -g @openai/codex
```

A separate install is optional. The app drives Codex through `@agentclientprotocol/codex-acp`. When the path in Settings is empty and `codex` is not on `PATH`, it uses the Codex shipped with the adapter. Settings then says it is using the built-in Codex.

Install Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
```

A separate install is optional. The app drives Claude Code through `@agentclientprotocol/claude-agent-acp`. When the path in Settings is empty and no native `claude` binary is on `PATH`, it uses the Claude binary shipped with the adapter. Settings then says it is using the built-in Claude. On Windows, npm's `claude`, `claude.cmd`, and `claude.ps1` shims are skipped: the adapter spawns `CLAUDE_CODE_EXECUTABLE` directly, and spawning that shell script fails with `EINVAL`.

The app looks for the CLIs automatically:

| OS | Cursor | Codex | Claude |
| --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\cursor-agent` | `codex` on `PATH` | `claude.exe` on `PATH`, or `%USERPROFILE%\.local\bin\claude.exe` |
| macOS / Linux | `~/.local/bin/agent`, `/usr/local/bin/agent`, `/opt/homebrew/bin/agent` | `~/.local/bin/codex`, `/usr/local/bin/codex`, `/opt/homebrew/bin/codex`, and `PATH` | `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, and `PATH` |

If nothing is found, set the executable or install directory in Settings.

Cursor auth prefers a [Cursor API key](https://cursor.com/dashboard/api). A key saved in Settings overrides the `CURSOR_API_KEY` environment variable. Without a key, the app uses the browser login saved by `agent login`.

Codex auth prefers the key in Settings, then `CODEX_API_KEY`, then `OPENAI_API_KEY`. If none of those are set, it uses ChatGPT sign-in.

Claude auth prefers the key in Settings, then `ANTHROPIC_API_KEY`. If either is set, Claude Code bills the API and does not use a Claude subscription. If neither is set, it uses the login stored in `~/.claude`. The login button runs the adapter's Claude.ai login.

### Updating a CLI

Open Settings → CLI and click **更新** to the right of that CLI's login button. The desktop app runs the update on this computer, including when you use the remote page. The button shows **更新中…** while it runs, and the card keeps the result or error for review. A successful update refreshes that CLI's version and model list.

Cursor and native Claude Code use their `update` command. Codex installed through npm is updated in its existing installation prefix; Homebrew installations use Homebrew. Unsupported installations show instructions instead of updating a different copy. Built-in Codex and Claude versions are updated with Agent Desktop, so their Update buttons are disabled. Install a standalone CLI and select it in Settings to update it separately.

## Development

The window is Electron, the UI is React, and both sides are TypeScript, built with electron-vite.

```bash
npm install
npm run dev
```

Windows one-click startup requires Node.js 22.12 or newer, including npm:

- Double-click `start-dev.bat` to install dependencies, ensure the Electron runtime is installed, and start development mode with hot reload.
- Double-click `start-preview.bat` to install dependencies, ensure the Electron runtime is installed, build, and launch the production preview.

The first run needs internet access to download dependencies and Electron. Later runs reuse installed dependencies and the runtime. Both scripts work from any working directory and keep the window open on failure. If the Electron download fails, check your network, proxy, or `ELECTRON_MIRROR` environment variable and retry.

| Command | What it does |
| --- | --- |
| `npm run dev` | Open the development window |
| `npm test` | Offline unit tests. Does not call a model |
| `npm run test:live` | One very short prompt with Grok 4.7 500K High Fast |
| `npm run typecheck` | Typecheck |
| `npm run build` | Compile into `out/` |
| `npm run preview` | Preview the compiled app |
| `npm run dist` | Package installers into `release/` |

`npm test` does not talk to Cursor CLI, Codex, or Claude. `npm run test:live` is the one that does: in a temporary empty directory, Ask mode calls `grok-4.7[context=500k,reasoning_effort=high,fast=true]` with the prompt `Reply with exactly ok`. The machine must be signed in or have `CURSOR_API_KEY` set. High still spends a small number of thinking tokens.

Package targets: Windows NSIS, macOS DMG, and Linux AppImage.

Press `F12` to open DevTools. Links that leave the app open in the system browser.

## Usage

### Interface language

Open **Settings → Appearance and history → Language** (中文：**设置 → 外观与历史 → 语言**) and choose **System**, **简体中文**, or **English**. The default is System: Chinese desktop OS locales use Simplified Chinese, and other locales use English. The preference is saved in `state.json`; desktop and remote pages share it, including the desktop OS language when System is selected. Changing the language updates the interface without restarting the app or an agent session.

Navigation, settings, dialogs, tool summaries, usage explanations, dates, relative times, and application notifications use the selected language. New application notices and automatic conversation titles keep their source identifiers so they can also change language later. User names and messages, model replies, CLI output, and older saved text without these identifiers retain their original wording.

Translations live in `src/shared/locales/`. Chinese source text is the fallback, with English translations split into core, shell, settings, and message catalogs. Use `useT()` from the renderer's `lib/i18n.ts` inside components and `t()` from `@shared/i18n` elsewhere; translate static menu sources when rendering them. Use named placeholders such as `{count}` for dynamic values. Tests cover catalog placeholders, language fallback and persistence, and localized rendering while preserving conversation content.

### Working with projects

1. Add a project folder. The agent works in that directory, or, for a new Cursor conversation, in that conversation’s own worktree. Removing a project deletes it from this app only. Files on disk stay.
2. On the home screen, pick the project, type a task or use one of the example prompts, choose a model and mode, and send. The three most recent conversations in that project are listed under the composer.
3. Manage conversations in the sidebar: pin, archive, rename (double-click the title), fork, sync from CLI storage, copy the session id, or delete. Syncing replaces the transcript shown here. Codex restores per-turn tokens and available durations from its rollout log. Other CLIs may drop duration and token records stored only by this app.
4. Open the changes panel to review edits, or open the working directory in Cursor or the file manager. After a task finishes, the conversation lists the files changed in that turn. Click a file name to expand the diff.

Project model choices are independent for Cursor, Codex, and Claude. Changing one CLI's selection or favorites preserves the other CLIs' remembered models.

The model picker also remembers each model's context length, reasoning effort (including Thinking), and Fast setting separately for each CLI. Options are saved as soon as you select them, without sending a message. Switching back to a model restores its options, including after an app restart; choosing a favorite model uses the same saved options. Preferences live in `state.json` and are shared with the remote page. Existing conversations keep their selected variant, and opening an older conversation does not overwrite these preferences. If a saved combination is no longer offered by the CLI, the picker selects an available variant.

Opening or refreshing a conversation keeps streamed messages that arrive while history is loading. Syncing an empty CLI transcript preserves the local conversation. Deleting a conversation, changing CLI configuration, or quitting also stops a CLI process that is still preparing the saved session.

The Git tab compares against the working files, including edits made after staging in a repository with no commits yet.

Shortcuts (on macOS, Ctrl is ⌘):

| Shortcut | Action |
| --- | --- |
| Ctrl+N | Go home and start a new conversation |
| Ctrl+K, Ctrl+Shift+F | Focus sidebar search |
| Ctrl+B | Show or hide the sidebar |
| Ctrl+Shift+D | Show or hide the changes panel |
| Ctrl+, | Open Settings |
| Enter | Send |
| Shift+Enter | New line |
| Esc | Stop the current run |

The composer picks the CLI, the mode, and the model, and can turn on full access (`--force`). On the home screen the CLI applies to the new conversation. Inside a conversation, switching CLI keeps the transcript already shown and starts the next message as a new session on that CLI. The same choice is saved as the default under Settings → CLI. Full access lets the CLI run commands without confirming each one. For Claude, full access is `bypassPermissions`; Agent without it is `acceptEdits`, so file edits are accepted and commands still ask. Ask mode stays on Claude's default permission mode and the app rejects edit and command prompts. Sandbox (`--sandbox`) is a default under Settings → Defaults: follow the CLI, enabled, or disabled. It applies to Cursor. It is not a composer toggle, and Claude does not use it. On the home screen, a new Cursor conversation can also switch between the project directory and an isolated git worktree (`--worktree`).

In a conversation, typing `/` opens a command menu. Arrow keys move through it, Enter or Tab selects, and Esc closes the menu without stopping a run. `/fork` forks locally. A command that takes input is inserted as `/name ` with its hint under the box; Enter then sends it. Commands with no input run immediately. The list also includes whatever the CLI sends in ACP `available_commands_update`. The first `/` in a conversation that already has a CLI session loads that session so those commands can appear. A new conversation and the home screen do not start the CLI. They reuse the last command list that CLI announced, kept on this machine, and the menu stays hidden until a list exists. The next real session refreshes that list. Text that starts with `/` and matches nothing is still sent as a normal message.

## Plan mode

Cursor does not expose an AskQuestion tool to ACP clients. Codex Plan is a collaboration mode (`collaboration_mode=plan`); its approval mode stays read-only, and it is not Cursor’s `modeId: plan`. Claude Plan is the adapter's `plan` permission mode. All three get a short instruction in front of Plan messages, wrapped in an `<agent_desktop_client>` tag. That tag is stripped when CLI history is imported. The instruction asks the model to work like this:

- When it needs a choice, the model emits a fenced code block whose language is `questions` and whose body is JSON. The UI renders it as option cards. After you pick and press Continue, the choice is sent as the next message. Skip lets the model proceed on its own judgment. Only the latest round of cards can be submitted.
- Once the requirements are clear, Cursor uses CreatePlan, and Codex and Claude emit a plan, to produce a name, a summary, and a Markdown body. The UI shows a plan card: name, summary, todos, and an expandable full plan. Cursor also offers Open plan file (`~/.cursor/plans/*.plan.md`). Codex and Claude hide that button when there is no such file.
- Run plan switches the composer to Agent mode and sends a message to implement the plan. Only the latest plan shows this button.

Under ACP, the CLI auto-approves a SwitchMode the model starts, and it does not tell the client. If Cursor or Claude switches mode during a Plan turn, the app immediately sets the session mode back to Plan so it does not start editing files.

## MCP and skills

Add MCP servers in Settings. When enabled, new and resumed sessions pass them in ACP `mcpServers` (stdio, HTTP, or SSE). The list lives in this app’s `state.json`. It does not rewrite `~/.cursor/mcp.json`.

An enabled skill is written to `~/.cursor/skills/<name>/SKILL.md`, to Codex paths `~/.agents/skills/<name>/SKILL.md` and `~/.codex/skills/<name>/SKILL.md`, and to `~/.claude/skills/<name>/SKILL.md`. The name may contain only lowercase letters, digits, and hyphens, and it needs a description. The CLI uses that description to decide whether to apply the skill. Disabling or deleting a skill removes only directories this app created. A same-named directory that this app did not create is left in place, and save reports that it could not be overwritten.

After MCP, skills, the CLI path, the API key, or the sandbox setting changes, an idle CLI process exits. The new configuration is used on the next message.

## Usage stats

The top of Usage in Settings shows account quota for Cursor and Codex. Claude account quota is not connected. Cursor shows the current billing cycle: Cursor models, other models, the next reset, and on-demand spend when that cap exists. Cursor models and other models also show that pool’s tokens (input, output, cache read, and cache write) and the account’s price for it, split the way the account labels them. Other models uses the included API usage percent. The plan’s included dollar cap is not shown on that row, because that figure stops at the purchased amount and is not this pool’s spend. On-demand shows used and limit beside the bar, and adds tokens when the account returns on-demand rows, without repeating the price. Codex shows whatever windows the account returns, often 5 hours and weekly, each with its next reset. A window that is not present is left out. Codex signed in with only an API key has no subscription windows, and the card says so. These figures come from the account, not from the local estimate below.

Usage in Settings totals tokens from conversations on this machine for the last 1, 7, and 30 days, and lists an estimated cost per model. Model names are short, for example “Grok 4.7 500K High Fast”, without the full parameter string. The session list below includes every past conversation. Each row shows the models used, cumulative tokens, and cost, and it is not limited by the day range above. More than 20 rows are paginated. Conversations with no token record are still listed, with the cost left blank. When a turn finishes, the reply also shows that turn’s duration, tokens, model, and estimated cost. Codex tokens come from cumulative usage differences in the local rollout log, covering every model request in a turn. Repeated snapshots are counted once. Input excludes cache, and reasoning tokens are already included in output. Codex prices each request separately so several short requests do not accidentally trigger long-context rates. Other CLIs use their reported turn usage; cache reads and writes are counted separately. Cursor uses [Cursor’s public prices](https://cursor.com/docs/models-and-pricing). Codex uses [OpenAI API prices](https://developers.openai.com/api/docs/pricing), in USD per million tokens. Each CLI is priced separately, including when it uses the same model. These are usage estimates, not subscription bills or remaining quota. Cursor estimates omit the Teams Token Rate. Amounts under one cent are shown to four decimal places. Auto and models missing from the price list show tokens only, with the cost marked unpriced. In the totals above, a turn copied by a fork is counted once. The session list sums each conversation’s own records, so the same turn appears in both the original and the fork.

For Codex signed in with ChatGPT, the reply footer shows “本轮周额度” to the right of the price. The consumer usage service, `/wham/usage/thread_usage/query_v2`, attributes weekly and 5-hour allowance percentages and balance credits to the Codex session ID. Concurrent independent conversations and separate forks are excluded from the request. Small percentages retain useful precision, and service readings above 100% are preserved. Each reading is cumulative for the session within the service's current allowance windows and must not be summed across reply footers; the tooltip explains this cumulative scope. Account-wide remaining quota appears in Settings → Usage. Account snapshots and differences between them never substitute for session consumption. API-key sessions do not query ChatGPT subscription usage.

New ChatGPT-authenticated Codex turns also show “本轮预估周额度 …%” beside session consumption. This estimate covers one user message and its reply: the weekly **used** percentage after the turn minus the value before the model request. For example, 30% to 30.5% displays “本轮预估周额度 0.5%”. The initial account read waits at most three seconds before the request proceeds; a failed or timed-out read does not prevent sending. Stopping during this wait prevents the request. When a turn finishes, including a stopped or failed turn that produces a result, a second read runs asynchronously for up to three seconds without delaying the completion notification. Reset timestamps may differ by up to one second, but both must be valid and later than the ending observation. Missing or invalid observations, unknown or changed reset periods, a reset during the turn, or a negative difference show “本轮预估周额度 暂无数据”. A valid zero displays 0%; tiny positive values display <0.0001%, and other values use up to four decimal places. The tooltip shows the starting and ending readings and the formula. Other conversations, other clients, and reporting delays can affect this account estimate; 0% only means the reported percentage did not change.

The estimate and its two observations are saved with that reply. History refreshes, token repairs, session-accounting retries, and app restarts preserve them without resampling. The footer preserves existing valid estimates, including zero. For saved replies without a valid estimate, it recalculates from complete saved starting and ending observations using the same rules, without a network request or a storage migration. A late ending read is discarded if another turn starts, the conversation is deleted or reimported, or its CLI session changes. Old replies without a starting observation are not backfilled. API-key turns have no subscription estimate.

The service reports `available`, `partial`, or `unavailable`; a missing field is never treated as zero. A missing allowance window is omitted. Partial records show their available amounts with an incomplete-data label. Unavailable records show “服务未返回”; this does not establish that accounting is pending or will eventually become available. Missing readings show “暂无数据”. The app refreshes after completion and when a saved conversation is opened, with up to three retries separated by 30 seconds, 2 minutes, and 5 minutes for missing or incomplete data. Refreshing history updates only the latest completed result for the current Codex session, rather than querying the same session separately for every old reply. Turn tokens and public-price estimates remain available. These reads submit no model prompt, do not delay sending or completing a turn, and time out after eight seconds.

Legacy `account/usage/read({threadId})` remains a fallback for enterprise estimated credits and USD when its billing route is supported. It does not provide consumer allowance percentages. Codex converts HTTP 403/404 from that legacy billing route into `threadUsage: null`, so a null result alone does not mean the session used no quota or that its thread ID is wrong. Consumer reporting uses the v2 service instead, but that service can also return `unavailable` without identifying a reason. Credits are never converted into weekly or 5-hour percentages, and only an explicit valid zero is displayed as zero.

Known limitation: completed ACP sessions created by Codex 0.157.0 and 0.159.0 have returned no attributed allowance data even when local token records exist. An older 0.156.1 session returning a percentage does not validate the current runtime or establish a version-related cause. Diagnostics must use the executable actually selected by Settings → CLI and the affected conversation's native thread ID. Local token counts and shared account snapshots cannot supply exact independent allowance percentages when the backend omits them. The optional `data_as_of` timestamp belongs to the service response; a timestamp from a batch containing an older available session does not prove coverage or pending accounting for a newer unavailable session.

Codex history import and sync also restore usage and quota snapshots from rollout logs. When an older saved result can be matched unambiguously to a logged turn, opening the conversation or Usage corrects its token record and restores a missing quota snapshot while preserving messages, duration, and existing readings. Copied fork records are corrected together. Missing logs leave usage unavailable or the older record unchanged; the adapter's last request is not presented as a full turn. Logs follow `CODEX_HOME` when set, otherwise `~/.codex`. Each new result remembers its CLI, so switching CLI later preserves its original pricing.

## Remote control

Turn the switch on under Remote control in Settings. The app listens on the LAN (port `8765` by default) and serves the same UI as the desktop app. A phone or another computer on the same network can open it by scanning the QR code. The QR code includes the project or conversation currently open on the computer. If the computer has more than one network interface, pick another address from the dropdown.

Turn on public access and the app opens a reverse tunnel with the local OpenSSH client. A gateway on the server owns the public port (default `8765`) and forwards each request to the computer named in the link. Several computers can share that one port at the same time. Each link is different, for example `http://43.167.166.239:8765/c/<computer-id>/?token=...`. The id is created the first time it is needed and stored on this machine. Resetting the link does not change it. The default server is `root@43.167.166.239`. The SSH user, server address, and public port can all be changed. Set up your own server with the steps below before using it. Once the tunnel is up, the public link appears in the address dropdown and in the QR code. Changing the address or port reconnects. After a drop, it retries at 1, 2, 5, and 10 seconds.

- The link carries an access token. The phone remembers it after the first open. In the same browser, public tokens for different computers are stored separately. Anyone with the link can fully control this app (send tasks, change settings), so do not share it. Reset link issues a new token. Old LAN and public links, and phones already connected, stop working immediately.
- Remote settings responses and state updates redact Cursor, Codex, and Claude API keys and the access token. Saving blank key fields from the phone preserves the keys configured on the desktop. The phone cannot change remote-control settings. Buttons that only make sense on the computer, such as Open in Cursor and Open in file manager, are hidden. Adding a project requires typing a path on the computer by hand.
- The server is HTTP only. There is no encryption. Use the LAN only on a network you trust. A public link is plaintext on the path and on this server, so enable it only on a server you control. The first time you enable it, Windows Firewall may prompt you; allow access on private networks.
- The public tunnel uses the machine’s default SSH key and logs in with `BatchMode`, so it never asks for a password. Each computer connects the tunnel to a Unix socket on the server, `/run/agent-desktop/<computer-id>`, and does not bind the public port itself. The server must allow socket forwarding (`AllowStreamLocalForwarding yes`) and set `StreamLocalBindUnlink yes`. Otherwise a socket file left behind after a disconnect blocks the next connection. The gateway listens on the public port and forwards the page. Open that public port in the cloud security group. The app does not change the server while it is running.
- At a screen width of 720px or less, the sidebar becomes a drawer, and the changes panel and Settings become full screen. Settings categories switch in a horizontal bar at the top.
- In development, page requests are forwarded to the Vite dev server, and only to that one address. An absolute URL in the request line is not followed. Hot reload does not go through the proxy; refresh the phone by hand after a change.

If the gateway is temporarily unreachable while SSH remains connected, health checks continue with retry backoff and restore the public link when the gateway becomes reachable. Health responses from a previous SSH connection are ignored after reconnecting, and stopping public access cancels further retries.

### Set up your own public server

From the project directory, one command logs into your Linux server over SSH, writes the sshd settings the tunnel needs, and installs the shared-port gateway:

```bash
npm run setup:public-server -- --user root --host your-server --port 8765
```

`--user` is the SSH user. `--host` is a domain or IP. `--port` is the public port the phone opens. Add `--ssh-port` when SSH listens somewhere other than 22. See every flag with `npm run setup:public-server -- --help`.

The script uses a passphrase-less default key: `~/.ssh/id_rsa`, `id_ecdsa`, or `id_ed25519`. If none exists, it generates `~/.ssh/id_ed25519`. If that public key cannot log in yet, the terminal asks for the SSH password once and writes the key into that user’s `authorized_keys`. If the server only accepts a different private key, point `--identity` at it. The script still installs the default public key, because the app opens the tunnel with the default key only. A non-root user must be able to `sudo`; enter the password when prompted. If the server has no `python3`, the script installs it with apt, dnf, yum, or apk.

The script backs up `sshd_config` first. If `sshd -t` fails, it restores the backup, then `reload`s sshd without dropping the current login. With systemd, the gateway runs as a service on the public port you chose. Without systemd, it runs in the background. If firewalld or ufw is running, that port is opened. Older builds bound the public port themselves. Before upgrading, turn public access off on those clients, then run this script.

When the command succeeds, enter the same SSH user, server address, and public port under Remote control, then turn on remote control and public access. Open the public port in the cloud security group.

With no arguments, the script configures port `8765` on the default server `root@43.167.166.239`. If you are already logged into the server and `public-gateway.py` is next to the script, you can also run `sudo bash scripts/setup-public-server.sh 8765`.

## Data

Projects, conversation metadata, and settings are stored in `data/` under Electron’s userData directory:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Agent Desktop\data` |
| macOS | `~/Library/Application Support/Agent Desktop/data` |
| Linux | `~/.config/Agent Desktop/data` |

`state.json` stores projects, the conversation list, and settings, including MCP servers, skill bodies, and the default CLI. Each conversation remembers whether it uses Cursor, Codex, or Claude. Messages for each conversation live in `threads/`. Cursor session records stay in `~/.cursor/chats`, Codex records stay in `~/.codex/sessions`, and Claude records stay in `~/.claude/projects`. The app reads and resumes those records and creates separate copies when forking. Enabled skills are written to `~/.cursor/skills`, `~/.agents/skills`, `~/.codex/skills`, and `~/.claude/skills`. Codex and Claude conversations do not use a git worktree.

A full fork copies the CLI session into an independent conversation: Cursor copies a consistent database snapshot, while Codex and Claude use their adapters' native fork support. Forking at a message keeps history through that message. When a CLI cannot copy that exact point, or native copying fails, the app saves the selected history and sends it as context with the fork's next message. This includes prior replies and tool results. The pending context survives restarts and failed sends and is cleared after a successful reply. CLI history sync also restores these copied messages. A fork whose context has not yet been delivered must complete a message before syncing. The source conversation is preserved.

During development, `AGENT_DESKTOP_USER_DATA` points userData at another directory.

Several windows can be open at once. Each process writes its Chromium cache (GPU cache, HTTP cache, localStorage) under `agent-desktop-sessions/<pid>` in the system temp directory, so the processes do not lock each other’s files. Projects and conversations still share the `data/` directory above. If two windows write the same data, the later write wins. On exit, the process deletes its own cache directory. Directories left by a crash are removed on the next launch.

## Layout

```
src/main              Electron main process
  index.ts            Window, IPC, notifications, and shutdown
  sessions.ts         Conversation scheduling, ACP process lifetime, and streamed turns
  session/provider.ts CLI launch, authentication, session options, and Plan prompts
  session/requests.ts ACP questions and permission decisions through a turn interface
  session/usage.ts    Delayed result usage writes and cancellable account-usage retries
  cli.ts              Find and spawn Cursor CLI
  codex.ts            Codex adapter: models, login, mode ids
  claude.ts           Claude adapter: models, login, mode ids
  claude-history.ts   Import transcripts from ~/.claude/projects
  acp.ts              Newline-delimited JSON-RPC, including Plan-mode hints
  window.ts           Window, title-bar theme, per-process cache directory
  store.ts            state.json and per-conversation files
  thread-history.ts   Fork conversations and sync records from CLI storage
  cli-catalog.ts      Model list, CLI detection, and sign-in
  remote.ts           LAN HTTP server
  public-tunnel.ts    Public SSH reverse tunnel
  remote-runtime.ts   Turn the LAN server and public tunnel on from settings
  quota.ts            Cursor and Codex account quota
  ipc/                IPC split by projects, conversations, settings, CLI, usage, and local actions
src/preload           The API the renderer is allowed to call
src/renderer/src      React UI
  store.ts            Public entry point for state and actions
  store/              State core, persistence, models, commands, threads, and initialization
  components/Items.tsx Message dispatch and adapters to the UI store
  components/items/   Markdown, messages, tools, plans, questions, and result views
  components/settings Settings pages
  lib/model-prefs.ts  Which model is selected. The choice is not kept in UI state
src/shared            Types, prices, usage, quota, slash commands, and Plan question blocks shared by the main process and the UI
scripts               Public gateway (public-gateway.py), server installer (setup-public-server.sh), and the local one-shot setup (setup-public-server.mjs)
test                  Offline unit tests, plus the live smoke test
```

### Module boundaries

`SessionManager` owns process lifetime and turn scheduling. The modules in `main/session/` receive only the dependencies they need: an ACP request channel for provider options, turn state and an item callback for questions, and a small store interface for usage refreshes. They do not import the session manager. Starting a new turn, disposing a conversation, and shutdown cancel account-usage retries through the usage module.

The renderer keeps `store.ts` as its public entry point. Modules inside `store/` import the state core and specific helpers directly; they do not import that entry point. Initialization connects API events to the relevant actions. Thread history loading and buffering of concurrent streamed items stay together so splitting the modules preserves their ordering.

`components/Items.tsx` connects messages to the store. Components in `components/items/` receive model catalogs and question actions through props or the shared turn context. The shared context and basic controls live below the message views, avoiding circular imports between Markdown, questions, and plans. Existing imports from `store.ts`, `Items.tsx`, and `main/sessions.ts` remain supported.
