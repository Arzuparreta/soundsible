#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PYTHON="${SOUNDSIBLE_PYTHON:-$ROOT/venv/bin/python3}"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON=python3
fi
echo "PyInstaller sidecar build not yet wired. Dev uses: $PYTHON soundsible_engine.py"
echo "See docs/appliance-rework-plan.md for packaging follow-up."
