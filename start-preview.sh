#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -s)" in
  Linux) exec bash "$project_dir/scripts/start-linux.sh" preview "$@" ;;
  Darwin) exec bash "$project_dir/scripts/start-mac.sh" preview "$@" ;;
  *) printf '%s\n' 'Unsupported platform. Use Windows .bat launchers or a Linux/macOS terminal.' >&2; exit 1 ;;
esac
