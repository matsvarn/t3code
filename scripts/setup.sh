#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v vp >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:$PATH"
fi

if ! command -v vp >/dev/null 2>&1; then
  echo "Vite+ is required. Install it with: curl -fsSL https://vite.plus | bash" >&2
  echo "Then open a new terminal and run bash scripts/setup.sh again." >&2
  exit 1
fi

if [[ "$(uname -s)" == "Linux" ]]; then
  for tool in make g++ python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "Linux node-pty requires make, g++ and Python 3." >&2
      echo "Ubuntu/Debian: sudo apt-get install build-essential python3" >&2
      echo "Install host prerequisites separately, then run setup again." >&2
      exit 1
    fi
  done
fi

vp i --frozen-lockfile
node apps/web/scripts/warm-dep-cache.ts
