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

## macOS startup and packages

macOS 13 Ventura or newer is supported, with separate Apple Silicon (arm64) and Intel (x64) builds. Packages include Electron and the bundled Codex/Claude binaries; users do not need Node.js. Source development and packaging need the Node.js environment above, and Git features need local `git`.

Run from a terminal in your desktop session; the launchers support the system's Bash 3.2:

```bash
bash start-dev.sh
bash start-preview.sh
# Or use the platform-specific commands:
npm run dev:mac
npm run preview:mac
```

The root launchers detect macOS/Linux automatically. macOS does not require Linux DISPLAY/Wayland variables. The first launch installs missing dependencies and Electron; subsequent launches reuse them offline. Pass `--install` to refresh locked dependencies. Preview builds first and stops on build failure. Launching from another directory or a path containing spaces is supported.

Install dependencies and build on a Mac matching the target architecture. Do not copy node_modules from Windows/Linux or cross-package with a dependency tree installed for another architecture:

```bash
npm ci --include=dev --include=optional
node node_modules/electron/install.js
npm run dist:mac          # DMG for the host architecture
npm run dist:mac:arm64    # Build on Apple Silicon
npm run dist:mac:x64      # Build on Intel
npm run dist:mac:dir      # Unpacked app for the host architecture
# Substitute the actual version and host architecture:
npm run verify:mac -- release/agent-desktop-0.1.0-mac-arm64.dmg arm64
```

The output is `agent-desktop-<version>-mac-<arch>.dmg`; packaging commands never publish. Applications use account-free ad-hoc signatures, without Developer ID or notarization. The current electron-builder v26 configuration sets `identity: "-"`, `hardenedRuntime: false`, `notarize: false`, and a Terminal automation usage description. [Signing configuration reference](https://www.electron.build/v26/docs/mac/)

Download the DMG for your chip, drag the app into Applications, eject the image, and launch from Finder. If Gatekeeper blocks the first launch, verify the download source and SHA256, then find the app in **System Settings → Privacy & Security → Open Anyway**. This grants an exception for this app without disabling Gatekeeper globally. [Apple's first-launch instructions](https://support.apple.com/102445)

The first toolbar command may ask permission to control Terminal. After a denial, allow Agent Desktop under **Privacy & Security → Automation** and retry; development builds may appear as Electron. Editor buttons can open installed VS Code/Cursor apps even without their `code`/`cursor` launchers. Closing a window keeps conversations running; click the Dock to reopen, or a completion notification to open its conversation. ⌘Q retains the active-task quit confirmation.

`verify:mac` mounts the DMG and copies its app into a temporary directory. It checks the signature, architecture of all three executables, bundled CLI versions, both ACP initialize handshakes, runner arguments, and the real window/preload IPC with a mock CLI. It does not call models or read user logins, and cleans up processes and the mount. A Mac graphical session is required.

On macOS, `/var` is an alias of `/private/var`. Offline tests use the physical temporary directory so child working directories and fixture expectations agree. Separate directory-alias regressions cover worktree subdirectories, missing shared child paths and snapshot display paths, ensuring fixture normalization does not hide application bugs.

Validation record: this change was implemented on Windows. Native macOS packaging and automatic smoke checks must run in the new CI; they are not recorded as passed here. Manual acceptance is pending on both Apple Silicon and Intel for browser-download first launch, Terminal permission allow/deny, editors, attachments/clipboard, Git diffs, all three real CLI login/send/stop flows, Dock/notifications, and quit behavior. The minimum macOS 13 version also needs separate hardware acceptance.

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
- **Linux ARM64 is not a release target yet.** Electron, optional Codex/Claude binaries, and their adapters must match the target architecture. Linux distribution commands still build x64 only; macOS ARM64 uses the separate native build flow above.

## Windows portable package

Build on **Windows x64**. Optional agent binaries are installed for the machine that runs the build, so packaging on another architecture does not produce a matching portable executable.

Double-click `build-portable.bat` in the project root. It checks Node.js 22.12 or newer, installs dependencies and the Electron runtime, then packages the app. From a terminal in the project directory:

```bash
npm ci --include=dev --include=optional
npm run dist:win:portable
```

The result is `release/agent-desktop-<version>-win-x64-portable.exe`. It does not install: launching it unpacks the application into a temporary directory and starts it. Settings and history stay in `%APPDATA%\Agent Desktop`, the same location used by the NSIS installer. `npm run dist` on Windows still builds that installer.

The first package build may download Electron and the electron-builder NSIS and 7-Zip tools. The executable is unsigned, so Windows SmartScreen may ask for confirmation the first time it runs.

## GitHub releases

Write the changes under `## [Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md). Other files in the working tree must already be committed. `master` must not be behind or diverged from `origin/master`. Then publish `0.2.0` with one command:

```bat
release.bat 0.2.0
```

```bash
npm run release -- 0.2.0
```

The script moves those notes into `## [0.2.0] - YYYY-MM-DD` and commits that on `master`. It then creates `release/0.2.0`, sets the `package.json` and `package-lock.json` version there, and pushes `master`, the release branch, and the annotated tag `v0.2.0`. The version commit stays on the release branch.

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs for `v*` tags and `release/*` branches. A branch push only checks that the name is three numeric parts and matches `package.json`. A tag push also checks that `release/X.Y.Z` exists and points at the tagged commit. Other names, such as `v1` or `release/next`, fail and do not publish. Only tags build Windows x64 portable/NSIS, Linux x64 AppImage/Debian, and macOS arm64/x64 DMGs. The macOS matrix installs native optional dependencies on `macos-15` (arm64) and `macos-15-intel` (x64), then runs types, offline tests, packaging and `verify:mac`. The Release notes come from that version's changelog. electron-builder uses `--publish never`; `gh` uploads the files.

The workflow rejects missing or empty version notes before building. It installs and checks Electron explicitly, requires all six installers, and generates `SHA256SUMS.txt`. Windows assets use `agent-desktop-<version>-win-x64-portable.exe` and `agent-desktop-<version>-win-x64-setup.exe`; macOS assets use `agent-desktop-<version>-mac-arm64.dmg` and `agent-desktop-<version>-mac-x64.dmg`. Any platform failure or missing/empty installer prevents publication. The Release stays a draft until all assets are uploaded, then becomes Latest. Retrying can resume a draft; it will not overwrite a public release.

After the workflow succeeds, do not commit to `release/X.Y.Z` and do not move the tag. If the script stops during a push, inspect the existing branch and tag and finish the remaining pushes; it does not delete or roll back completed work. The script returns to `master` after preparing the release.

Run tests with `NODE_ENV=test` if your terminal inherits `NODE_ENV=production` from a desktop launcher (PowerShell: `$env:NODE_ENV = 'test'`). React's development JSX runtime is needed by component tests.

## Commands and tests

| Command | What it does |
| --- | --- |
| `npm run dev` | Open the development window |
| `npm run dev:linux` / `npm run preview:linux` | Linux startup with dependency/runtime checks |
| `npm run dev:mac` / `npm run preview:mac` | macOS startup with dependency/runtime checks |
| `npm test` | Offline unit tests. Does not call a model |
| `npm run test:live` | Short text and attachment checks with Composer 2.5 Fast |
| `npm run typecheck` | Typecheck the app and all tests without running them |
| `npm run typecheck:tests` | Typecheck test fixtures, mocks, and assertions only |
| `npm run build` | Compile into `out/` |
| `npm run preview` | Preview the compiled app |
| `npm run dist` | Package installers into `release/` |
| `npm run dist:win:portable` | Build the Windows x64 portable executable without publishing |
| `npm run dist:linux` | Build Linux x64 AppImage and Debian packages without publishing |
| `npm run dist:linux:dir` | Build the unpacked Linux x64 application |
| `npm run dist:mac` / `npm run dist:mac:dir` | Build the host Mac's DMG / unpacked application without publishing |
| `npm run dist:mac:arm64` / `npm run dist:mac:x64` | Build the matching architecture on a native Mac |
| `npm run verify:mac -- DMG ARCH` | Verify the packaged app offline on a Mac matching ARCH |
| `release.bat 0.2.0` / `npm run release -- 0.2.0` | Publish that version from the Unreleased changelog |
| `npm run icons` | Regenerate PNGs, Windows `icon.ico` and macOS `icon.icns` from `resources/icons/icon.svg` |

The application icon source is `resources/icons/icon.svg`. Alternative designs live in `docs/icons/`, compared in `docs/icons/preview.png`. Switch to another design with `npm run icons -- docs/icons/agent-hub.svg` (copies it to `icon.svg`, then regenerates), and refresh the comparison after editing a candidate with `npm run icons -- --preview`. The script renders with the project's own Electron, so no extra dependency is needed.

`npm test` does not talk to Cursor CLI, Codex, or Claude. `npm run test:live` calls `composer-2.5[fast=true]` in Ask mode in temporary directories: one check asks `Reply with exactly ok`, and another verifies native image recognition plus reading an original managed file outside the workspace. The text check uses `CURSOR_API_KEY` when set, otherwise the saved CLI login; the attachment check requires `CURSOR_API_KEY`. Run only the attachment check with `npm run test:live -- test/live/attachment-smoke.test.ts`.

Run a focused check with `npm test -- test/claude.test.ts test/turn-usage.test.ts`. These tests isolate Claude discovery from the user's home directory, load the usage preload from paths containing spaces, and clean up their temporary fixtures. Windows-only checks are reported as skipped on other platforms.

Working-file snapshots use Electron's `original-fs` in the desktop process and normal Node filesystem APIs in Node tests. Workspace `.asar` archives remain physical files, subject to the same size limits as other files; scanning must not open them as virtual directories and retain handles that block game or application updates. Run `npm test -- test/turn-files.test.ts test/turn-files-electron.test.ts` for snapshot coverage. The Windows Electron regression checks archive replacement while the scanning process is still alive, in ordinary directories, Git repositories, and containers with a child repository. Restart the desktop client after rebuilding this main-process fix to release archive handles cached by an older instance.

Toolbar command checks live in `test/toolbar-terminal.test.ts` and `test/toolbar-runner.test.ts`. They build the standalone runner in a temporary directory and verify literal arguments, Windows `.cmd` shims, startup failures, output, and exit codes. On Windows, setting `AGENT_DESKTOP_CONSOLE_SMOKE=1` opts into a real new-console check that reads the console buffer and sends Enter to close it. Set `AGENT_DESKTOP_CONSOLE_EXECUTABLE` and `AGENT_DESKTOP_CONSOLE_RUNNER` to the packaged executable and its `resources/toolbar-runner.cjs` to repeat that check against an unpacked build. The normal test run does not open terminal windows.

Package targets: Windows NSIS, Windows x64 portable executable, macOS DMG, and Linux x64 AppImage / Debian (`.deb`).

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
  lib/find.ts         Find in conversation: matching, text indexing for highlight ranges, and find shortcuts
  lib/panel-layout.ts Resizable panel widths as CSS variables, saved in settings or, on the remote page, browser storage
src/shared            Types, Cursor / OpenAI / Anthropic price tables, usage, quota, slash commands, and Plan question blocks shared by the main process and the UI
scripts               Public gateway (public-gateway.py), server installer (setup-public-server.sh), and the local one-shot setup (setup-public-server.mjs)
test                  Offline unit tests, plus the live smoke test
```

### Module boundaries

`SessionManager` owns process lifetime and turn scheduling. The modules in `main/session/` receive only the dependencies they need: an ACP request channel for provider options, turn state and an item callback for questions, and a small store interface for usage refreshes. They do not import the session manager. Starting a new turn, disposing a conversation, and shutdown cancel account-usage retries through the usage module.

The renderer keeps `store.ts` as its public entry point. Modules inside `store/` import the state core and specific helpers directly; they do not import that entry point. Initialization connects API events to the relevant actions. Thread history loading and buffering of concurrent streamed items stay together so splitting the modules preserves their ordering.

`components/Items.tsx` connects messages to the store. Components in `components/items/` receive model catalogs and question actions through props or the shared turn context. The shared context and basic controls live below the message views, avoiding circular imports between Markdown, questions, and plans. Existing imports from `store.ts`, `Items.tsx`, and `main/sessions.ts` remain supported.
