#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v vp >/dev/null 2>&1; then
  echo "Vite+ is required. Install it with: curl -fsSL https://vite.plus | bash" >&2
  echo "Then open a new terminal and run bash scripts/setup.sh again." >&2
  exit 1
fi

vp i --frozen-lockfile
node apps/web/scripts/warm-dep-cache.ts
