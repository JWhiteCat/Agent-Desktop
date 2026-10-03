#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bash scripts/start-linux.sh [dev|preview] [--install]' \
    'Start Agent Desktop on Linux. --install refreshes dependencies with npm ci.'
}

die() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

mode=dev
if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == dev || "${1:-}" == preview ]]; then
  mode="$1"
  shift
fi
install=false
if [[ "${1:-}" == --install ]]; then
  install=true
  shift
fi
[[ $# -eq 0 ]] || { usage >&2; die 'Unknown argument.'; }

[[ "$(uname -s)" == Linux ]] || die 'This launcher is for Linux.'
[[ "$EUID" -ne 0 ]] || die 'Run Agent Desktop as a regular desktop user, not as root.'
[[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]] || \
  die 'No graphical session found. Run this in your Linux desktop terminal (X11 or Wayland).'

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_dir"
command -v node >/dev/null 2>&1 || die 'Install Node.js 24 LTS (or 22.12+) with npm first: https://nodejs.org/'
command -v npm >/dev/null 2>&1 || die 'npm is missing. Install Node.js with npm: https://nodejs.org/'
node_version="$(node --version)"
if [[ "$node_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  # Electron 44 needs >=22.12; Vitest 5 supports 22.12+, 24.x, or >=26.
  (( (major == 22 && minor >= 12) || major == 24 || major >= 26 )) || \
    die "Unsupported Node.js $node_version. Use Node.js 24 LTS, 22.12+ (22.x), or 26+."
else
  die "Cannot identify a supported stable Node.js version: $node_version"
fi

# npm ls only inspects local dependencies, so a ready checkout can start offline.
# Use --install (or npm ci) after pulling dependency-lock changes.
if [[ "$install" == true ]] || ! npm ls --depth=0 --include=dev --include=optional >/dev/null 2>&1; then
  printf '%s\n' 'Installing locked project dependencies...'
  npm ci --include=dev --include=optional --no-audit --no-fund || \
    die 'Dependency installation failed. Check your network/npm configuration and retry.'
fi

electron_ready() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    try {
      const root = path.dirname(require.resolve("electron/package.json"));
      const relative = fs.readFileSync(path.join(root, "path.txt"), "utf8").trim();
      if (!relative) process.exit(1);
      fs.accessSync(path.join(root, "dist", relative), fs.constants.X_OK);
    } catch { process.exit(1); }
  '
}

# Electron 44 downloads its runtime on demand; do not download again if ready.
if ! electron_ready; then
  printf '%s\n' 'Installing the Electron runtime...'
  node node_modules/electron/install.js || \
    die 'Electron download failed. Check your network, proxy, or ELECTRON_MIRROR and retry.'
  electron_ready || die 'Electron is still unavailable. Check the downloaded runtime and its executable permissions.'
fi

# A desktop app must not inherit Electron's Node-only mode from a parent tool.
unset ELECTRON_RUN_AS_NODE
if [[ "$mode" == preview ]]; then
  export NODE_ENV=production
  npm run build
else
  export NODE_ENV=development
fi
printf 'Starting Agent Desktop (%s)...\n' "$mode"
exec npm run "$mode"
