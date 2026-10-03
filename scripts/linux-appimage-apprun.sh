#!/usr/bin/env bash
set -euo pipefail

# electron-builder 26.15 copies linux.extraFiles after generating its AppRun.
# Keep Chromium's sandbox enabled even when the host restricts user namespaces;
# let Electron explain the error rather than silently weakening its security.
app_dir="${APPDIR:-$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)}"
export LD_LIBRARY_PATH="$app_dir/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export XDG_DATA_DIRS="$app_dir/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
unset ELECTRON_RUN_AS_NODE
exec "$app_dir/agent-desktop" "$@"
