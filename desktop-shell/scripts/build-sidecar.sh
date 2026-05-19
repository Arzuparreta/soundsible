#!/usr/bin/env bash
# Build the PyInstaller desktop engine sidecar for Tauri externalBin bundling.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON="${SOUNDSIBLE_PYTHON:-$ROOT/venv/bin/python3}"
SPEC="$ROOT/desktop-shell/packaging/soundsible-engine.spec"
BIN_DIR="$ROOT/desktop-shell/src-tauri/binaries"
TARGET="$(rustc --print host-tuple)"
OUTPUT="$BIN_DIR/soundsible-engine-${TARGET}"

if [[ ! -x "$PYTHON" ]]; then
  PYTHON=python3
fi

if [[ ! -f "$ROOT/requirements.txt" ]]; then
  echo "Missing repo requirements at $ROOT/requirements.txt" >&2
  exit 1
fi

echo "Using Python: $PYTHON"
echo "Target triple: $TARGET"

"$PYTHON" -m pip install -q -r "$ROOT/desktop-shell/packaging/requirements-sidecar.txt"

mkdir -p "$BIN_DIR"
cd "$ROOT"

"$PYTHON" -m PyInstaller "$SPEC" --noconfirm --clean --distpath "$ROOT/dist" --workpath "$ROOT/build/pyinstaller-sidecar"

DIST_EXE="$ROOT/dist/soundsible-engine.exe"
DIST_BIN="$ROOT/dist/soundsible-engine"
if [[ -f "$DIST_EXE" ]]; then
  cp "$DIST_EXE" "$OUTPUT"
elif [[ -f "$DIST_BIN" ]]; then
  install -m 755 "$DIST_BIN" "$OUTPUT"
else
  echo "PyInstaller did not produce dist/soundsible-engine(.exe)" >&2
  exit 1
fi

echo "Sidecar ready: $OUTPUT"
echo "Tauri externalBin expects: desktop-shell/src-tauri/binaries/soundsible-engine-${TARGET}"
