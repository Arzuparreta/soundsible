#!/usr/bin/env bash
# Headless desktop engine smoke test (engine health + optional sidecar build).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON="${SOUNDSIBLE_PYTHON:-$ROOT/venv/bin/python3}"
WITH_SIDECAR=0
WITH_FFMPEG=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--with-sidecar] [--with-ffmpeg]

  default       Run pytest desktop engine smoke (Python dev engine)
  --with-sidecar  Build PyInstaller sidecar first, then smoke-test it
  --with-ffmpeg   Pass BUNDLE_FFMPEG=1 to the sidecar build (static FFmpeg)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-sidecar) WITH_SIDECAR=1 ;;
    --with-ffmpeg) WITH_FFMPEG=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

if [[ ! -x "$PYTHON" ]]; then
  PYTHON=python3
fi

cd "$ROOT"
export PYTHONPATH="$ROOT"

echo "==> Python engine smoke"
"$PYTHON" -m pip install -q -r requirements.txt
"$PYTHON" -m pytest tests/test_desktop_engine_smoke.py::test_desktop_engine_smoke_python -q

if [[ "$WITH_SIDECAR" -eq 1 ]]; then
  echo "==> Building sidecar"
  if [[ "$WITH_FFMPEG" -eq 1 ]]; then
    BUNDLE_FFMPEG=1 "$ROOT/desktop-shell/scripts/build-sidecar.sh"
  else
    "$ROOT/desktop-shell/scripts/build-sidecar.sh"
  fi
  SIDECAR="$(find "$ROOT/desktop-shell/src-tauri/binaries" -maxdepth 1 -name 'soundsible-engine*' -type f | head -1)"
  export SOUNDSIBLE_ENGINE_BIN="$SIDECAR"
  echo "==> Sidecar smoke ($SIDECAR)"
  "$PYTHON" -m pytest tests/test_desktop_engine_smoke.py::test_desktop_engine_smoke_sidecar -q
fi

echo "Smoke test passed."
