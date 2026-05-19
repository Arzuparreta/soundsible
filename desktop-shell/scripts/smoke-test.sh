#!/usr/bin/env bash
# Headless desktop appliance smoke test (engine health + optional sidecar/Tauri build).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON="${SOUNDSIBLE_PYTHON:-$ROOT/venv/bin/python3}"
WITH_SIDECAR=0
WITH_TAURI=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--with-sidecar] [--with-tauri]

  default       Run pytest desktop engine smoke (Python dev engine)
  --with-sidecar  Build PyInstaller sidecar first, then smoke-test it
  --with-tauri    Also run \`npm run build\` in desktop-shell (requires WebKit/GTK deps)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-sidecar) WITH_SIDECAR=1 ;;
    --with-tauri) WITH_TAURI=1 ;;
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
  "$ROOT/desktop-shell/scripts/build-sidecar.sh"
  SIDECAR="$(find "$ROOT/desktop-shell/src-tauri/binaries" -maxdepth 1 -name 'soundsible-engine*' -type f | head -1)"
  export SOUNDSIBLE_ENGINE_BIN="$SIDECAR"
  echo "==> Sidecar smoke ($SIDECAR)"
  "$PYTHON" -m pytest tests/test_desktop_engine_smoke.py::test_desktop_engine_smoke_sidecar -q
fi

if [[ "$WITH_TAURI" -eq 1 ]]; then
  echo "==> Tauri build"
  cd "$ROOT/desktop-shell"
  npm ci
  npm run build
  echo "Tauri build OK"
fi

echo "Smoke test passed."
