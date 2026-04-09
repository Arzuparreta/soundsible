#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PY="$ROOT_DIR/venv/bin/python"

if [[ ! -x "$VENV_PY" ]]; then
  echo "ERROR: venv python not found at $VENV_PY"
  exit 1
fi

before="$("$VENV_PY" -c "import yt_dlp; print(yt_dlp.version.__version__)" 2>/dev/null || echo "not-installed")"
echo "yt-dlp before: $before"

"$VENV_PY" -m pip install -U yt-dlp

after="$("$VENV_PY" -c "import yt_dlp; print(yt_dlp.version.__version__)")"
echo "yt-dlp after:  $after"

"$VENV_PY" -c "import yt_dlp, requests; print('verify-ok')"
echo "yt-dlp update complete."
