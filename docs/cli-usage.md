# Command-Line Interface (`agent-desktop` / `agd`)

[Documentation](README.md) · [Project home](../README.md) · [简体中文](cli-usage.zh-CN.md)

Agent Desktop ships with a built-in CLI (`agent-desktop` and its short alias `agd`). It reuses the packaged Electron runtime (`ELECTRON_RUN_AS_NODE=1`), so no separate Node.js installation is required.

## Installing to PATH

1. Open **Settings → CLI** in the desktop app and find **App CLI (agent-desktop / agd)**.
2. Click **Install command to PATH**, then open a new terminal to use `agent-desktop` or `agd`.
   - **Windows**: adds the app's `bin` directory to your user `PATH` (no administrator privileges required). If you move a portable build, reinstall from Settings.
   - **macOS**: symlinks into `/usr/local/bin` when writable, otherwise `~/.local/bin`.
   - **Linux**: installs into `~/.local/bin`. AppImage builds generate managed wrapper scripts targeting `$APPIMAGE`; reinstall if you move the AppImage file.
3. From a source checkout, you can also run the built bundle directly:
   ```bash
   npm run build
   npm run cli -- status
   ```

## Dual-Mode Runtime

- **Attached mode (default when desktop is running)**: connects to the running desktop instance over local IPC (Windows Named Pipe or macOS/Linux Unix Domain Socket with a `0600` random token). Threads created, run, or stopped from the CLI appear live in the desktop UI, reuse warm ACP sessions, and avoid `state.json` write conflicts.
- **Headless mode (automatic fallback)**: when the desktop app is closed, the CLI runs `Store` and `SessionManager` directly in-process, sharing the same projects, settings, skills, and history. An exclusive `data/cli-headless.lock` prevents concurrent headless writers from corrupting `state.json`.

Runtime control flags:

- `--attach-only`: fail with exit code `4` if no desktop instance is running.
- `--headless`: force standalone headless execution; fails with exit code `5` if a desktop instance is running.
- `--user-data <dir>`: override the `userData` directory (equivalent to `AGENT_DESKTOP_USER_DATA`).

## Common Commands

```bash
# Inspect mode (attached/headless), data dir, and backend CLIs
agd status
agd status --json

# Inspect backend CLIs and models
agd cli list
agd cli models codex

# Manage projects
agd projects list
agd projects add .

# Inspect and manage threads
agd threads list
agd threads list --project . --running
agd threads show <threadId> --tail 20
agd threads create --project . --cli codex --mode agent
agd threads fork <threadId>
agd threads sync <threadId>
agd threads delete <threadId>

# Run a prompt with live streaming (also accepts piped stdin)
agd run "Fix the login race condition" --cli codex --mode agent
git diff | agd run --mode ask "Review these changes"

# Continue a thread, attach files/screenshots, or use an isolated git worktree
agd run "Add unit tests" --thread <threadId> --file ./error.png --worktree

# Dispatch asynchronously and watch/stop later (attached mode)
agd run "Draft release notes" --detach --json
agd watch <threadId>
agd stop <threadId>

# Structured output for scripts and automation
agd run "List TODOs" --mode ask --format jsonl
agd run "Summarize architecture" --mode ask --json
```

## Handling Interactive Questions

When an Agent or Plan run raises a blocking question:

- **Interactive TTY**: prompts in the terminal by default (`--on-question interactive`).
- **Non-TTY / scripts**: defaults to `--on-question fail`, exiting with code `3` and printing `questionId` and options so scripts never hang. Respond or skip via:
  ```bash
  agd answer <threadId> <questionId> --answers '[{"questionId":"...","selectedOptionIds":["..."]}]'
  agd answer <threadId> <questionId> --skip
  ```

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Runtime error or failed agent turn |
| `2` | Invalid CLI arguments |
| `3` | Agent asked a question under `--on-question fail` |
| `4` | `--attach-only` specified but desktop app is not running |
| `5` | Concurrency conflict (desktop running with `--headless`, or another headless CLI holds the data lock) |
| `130` | Interrupted by `Ctrl+C` (`SIGINT`) |
