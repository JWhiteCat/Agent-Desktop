# Development guide

[Documentation](README.md) · [Project home](../README.md) · [简体中文](development.zh-CN.md)

The window is Electron, the UI is React, and both sides are TypeScript, built with electron-vite.

```bash
npm ci --include=dev --include=optional
npm run dev
```

Windows one-click startup requires Node.js 22.12 or newer, including npm:

- Double-click `start-dev.bat` to install dependencies, ensure the Electron runtime is installed, and start development mode with hot reload.
- Double-click `start-preview.bat` to install dependencies, ensure the Electron runtime is installed, build, and launch the production preview.

The first run needs internet access to download dependencies and Electron. Later runs reuse installed dependencies and the runtime. Both scripts work from any working directory and keep the window open on failure. If the Electron download fails, check your network, proxy, or `ELECTRON_MIRROR` environment variable and retry.

## Linux startup and packages

The Linux packages target **x86-64 / amd64**, with a glibc-based desktop and an active X11 or Wayland session. Run the application as your normal desktop user. A headless server, a plain SSH session, and Alpine/musl are not supported desktop environments. The app uses native Linux window decorations; desktop notifications and opening links/files depend on your desktop services.

Install Node.js as described in [CLI setup](cli-setup.md#requirements). For a minimal **Ubuntu 24.04** desktop, the main runtime and integration dependencies are:

```bash
sudo apt update
sudo apt install git openssh-client xdg-utils libgtk-3-0t64 libnss3 libgbm1 \
  libasound2t64 libsecret-1-0 libnotify4 libxss1 libxtst6
```

On Ubuntu 22.04 or Debian 12, use `libgtk-3-0` and `libasound2` instead of the two `t64` names. Other distributions use different package names. `openssh-client` supplies `ssh` and `ssh-keygen` for public remote control; `git` is needed for project operations.

Linux one-click launchers are also available in the project root, alongside the Windows `.bat` files:

- `start-dev.sh`: check/install dependencies and Electron, then start development mode with hot reload.
- `start-preview.sh`: check/install dependencies and Electron, build once, then open the production preview.

From a terminal in the project directory:

```bash
./start-dev.sh
./start-preview.sh
```

In a file manager that supports executable scripts, choose **Run in Terminal**. Some file managers open `.sh` files in an editor instead; use the terminal commands above in that case. If an archive/download did not preserve executable permissions, use `bash start-dev.sh` / `bash start-preview.sh`, or run `chmod +x start-dev.sh start-preview.sh` once. Use `--help` for usage or `--install` to refresh dependencies.

The existing npm commands remain available:

```bash
npm run dev:linux       # Check dependencies, ensure Electron, and start hot reload
npm run preview:linux   # Check dependencies, build, and open production preview
```

The launcher also works from another directory, including paths containing spaces:

```bash
bash "/path/to/Agent-Desktop/start-dev.sh"
bash "/path/to/Agent-Desktop/start-preview.sh"
```

The first run downloads missing dependencies using the lockfile and downloads the Electron runtime. Later runs reuse a complete local dependency tree and runtime without an install/network request. After pulling dependency or lockfile changes, run `npm run dev:linux -- --install` (or `npm ci --include=dev --include=optional`) to refresh dependencies. Do not omit optional dependencies: bundled agent binaries are platform-specific. Download failures leave an error in the terminal; check the network/proxy or `ELECTRON_MIRROR`, then retry.

Build on **Linux x64**, with dependencies installed on that machine:

```bash
npm ci --include=dev --include=optional
npm run dist:linux       # AppImage and .deb in release/, never publishes
npm run dist:linux:dir   # Unpacked app in release/linux-unpacked/
```

The first package build may download Electron and electron-builder tools. Packages include the application icon, a Development-category desktop entry, and a matching desktop/window identity. Install the `.deb` on a Debian-based desktop to add it to the application menu, or run the AppImage directly (replace the glob with the exact filename if several versions are present):

```bash
sudo apt install ./release/agent-desktop-*-linux-*.deb
# Or use the portable AppImage:
chmod +x release/agent-desktop-*-linux-x86_64.AppImage
./release/agent-desktop-*-linux-x86_64.AppImage
```

**AppImage and sandbox troubleshooting:**

- The pinned electron-builder uses the FUSE 2 AppImage runtime. If it reports a missing `libfuse.so.2`, install `libfuse2t64` on Ubuntu 24.04, or `libfuse2` on Ubuntu 22.04 / Debian 12. Install the compatibility library, not a replacement for FUSE 3. If FUSE is unavailable, `./release/agent-desktop-*-linux-x86_64.AppImage --appimage-extract-and-run` avoids mounting the image. See the [AppImage FUSE guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).
- FUSE and Chromium sandboxing are separate requirements. The included AppImage launcher retains Chromium's sandbox and does not silently disable it when user namespaces are unavailable. Extraction does not fix a sandbox error. On systems that restrict user namespaces or apply AppArmor policies, prefer the `.deb` installed through the system package manager, or ask the administrator for a distribution-supported application-specific configuration. Do not run the app with `sudo`, disable AppArmor globally, or add sandbox-disabling flags. See [Electron's sandbox guidance](https://www.electronjs.org/docs/latest/tutorial/sandbox).
- For a missing shared-library error, install that library with your distribution's package manager. A terminal without `DISPLAY` or `WAYLAND_DISPLAY` cannot open the desktop app; use a terminal inside the graphical session.
- **ARM64 is not a release target yet.** Changing only electron-builder's architecture flag is insufficient: Electron, optional Codex/Claude binaries, and their adapters must all match the target architecture. Native ARM64 startup and packaging still need separate validation; the supplied distribution commands intentionally build x64 only.

## Commands and tests

| Command | What it does |
| --- | --- |
| `npm run dev` | Open the development window |
| `npm run dev:linux` / `npm run preview:linux` | Linux startup with dependency/runtime checks |
| `npm test` | Offline unit tests. Does not call a model |
| `npm run test:live` | Short text and attachment checks with Composer 2.5 Fast |
| `npm run typecheck` | Typecheck the app and all tests without running them |
| `npm run typecheck:tests` | Typecheck test fixtures, mocks, and assertions only |
| `npm run build` | Compile into `out/` |
| `npm run preview` | Preview the compiled app |
| `npm run dist` | Package installers into `release/` |
| `npm run dist:linux` | Build Linux x64 AppImage and Debian packages without publishing |
| `npm run dist:linux:dir` | Build the unpacked Linux x64 application |

`npm test` does not talk to Cursor CLI, Codex, or Claude. `npm run test:live` calls `composer-2.5[fast=true]` in Ask mode in temporary directories: one check asks `Reply with exactly ok`, and another verifies native image recognition plus reading an original managed file outside the workspace. The text check uses `CURSOR_API_KEY` when set, otherwise the saved CLI login; the attachment check requires `CURSOR_API_KEY`. Run only the attachment check with `npm run test:live -- test/live/attachment-smoke.test.ts`.

Run a focused check with `npm test -- test/claude.test.ts test/turn-usage.test.ts`. These tests isolate Claude discovery from the user's home directory, load the usage preload from paths containing spaces, and clean up their temporary fixtures. Windows-only checks are reported as skipped on other platforms.

Package targets: Windows NSIS, macOS DMG, and Linux x64 AppImage / Debian (`.deb`).

`npm test -- test/linux-launcher.test.ts test/linux-packaging.test.ts` checks Linux startup, repeated/offline starts, failure handling, package metadata/icons, desktop identity, and the AppImage launcher without downloading packages or launching an agent. A real graphical-session smoke test is still needed for each target distribution.

Press `F12` to open DevTools. Links that leave the app open in the system browser.

## Localization

Translations live in `src/shared/locales/`. Chinese source text is the fallback, with English translations split into core, shell, settings, and message catalogs. Use `useT()` from the renderer's `lib/i18n.ts` inside components and `t()` from `@shared/i18n` elsewhere; translate static menu sources when rendering them. Use named placeholders such as `{count}` for dynamic values. Tests cover catalog placeholders, language fallback and persistence, and localized rendering while preserving conversation content.

## Layout

```
src/main              Electron main process
  index.ts            Window, IPC, notifications, and shutdown
  sessions.ts         Conversation scheduling, ACP process lifetime, and streamed turns
  reducer.ts          Streamed ACP updates, including the Claude API model on a usage update
  session/provider.ts CLI launch, authentication, session options, and Plan prompts
  session/requests.ts ACP questions and permission decisions through a turn interface
  session/usage.ts    Delayed result usage writes and cancellable account-usage retries
  cli.ts              Find and spawn Cursor CLI
  git.ts              Create and remove worktrees for Codex and Claude conversations
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
  grokbot.ts          Grok Bot roster and cached transcripts from the Grok Bot desktop app, and the /v0/grokbot session API client
  grokbot-files.ts    Cached Grok Bot files by SHA-256, served through the grokbot-file:// protocol
  grokbot-cache.ts    Bounded on-disk cache of recent Grok Bot messages, cursors, and session ids
  ipc/                IPC split by projects, conversations, settings, CLI, usage, and local actions
src/preload           The API the renderer is allowed to call
src/renderer/src      React UI
  store.ts            Public entry point for state and actions
  store/              State core, persistence, models, commands, threads, and initialization
  components/Items.tsx Message dispatch and adapters to the UI store
  components/items/   Markdown, messages, tools, plans, questions, and result views
  components/settings Settings pages
  lib/model-prefs.ts  Which model is selected. The choice is not kept in UI state
src/shared            Types, Cursor / OpenAI / Anthropic price tables, usage, quota, slash commands, and Plan question blocks shared by the main process and the UI
scripts               Public gateway (public-gateway.py), server installer (setup-public-server.sh), and the local one-shot setup (setup-public-server.mjs)
test                  Offline unit tests, plus the live smoke test
```

### Module boundaries

`SessionManager` owns process lifetime and turn scheduling. The modules in `main/session/` receive only the dependencies they need: an ACP request channel for provider options, turn state and an item callback for questions, and a small store interface for usage refreshes. They do not import the session manager. Starting a new turn, disposing a conversation, and shutdown cancel account-usage retries through the usage module.

The renderer keeps `store.ts` as its public entry point. Modules inside `store/` import the state core and specific helpers directly; they do not import that entry point. Initialization connects API events to the relevant actions. Thread history loading and buffering of concurrent streamed items stay together so splitting the modules preserves their ordering.

`components/Items.tsx` connects messages to the store. Components in `components/items/` receive model catalogs and question actions through props or the shared turn context. The shared context and basic controls live below the message views, avoiding circular imports between Markdown, questions, and plans. Existing imports from `store.ts`, `Items.tsx`, and `main/sessions.ts` remain supported.
