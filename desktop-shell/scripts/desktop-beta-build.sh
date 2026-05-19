#!/usr/bin/env bash
# One-shot consumer beta build: sidecar + FFmpeg + Tauri bundles.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export SOUNDSIBLE_REPO_ROOT="$ROOT"

echo "==> Sidecar + FFmpeg"
BUNDLE_FFMPEG=1 "$ROOT/desktop-shell/scripts/build-sidecar.sh"

echo "==> Engine smoke (sidecar)"
SIDECAR="$(find "$ROOT/desktop-shell/src-tauri/binaries" -maxdepth 1 -name 'soundsible-engine*' -type f | head -1)"
export SOUNDSIBLE_ENGINE_BIN="$SIDECAR"
export PYTHONPATH="$ROOT"
"$ROOT/venv/bin/python3" -m pytest "$ROOT/tests/test_desktop_engine_smoke.py::test_desktop_engine_smoke_sidecar" -q

echo "==> Tauri bundles"
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "ERROR: webkit2gtk-4.1 not found. Install Tauri Linux deps first, e.g." >&2
  echo "  Arch: sudo pacman -S webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg base-devel" >&2
  echo "  Debian: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev librsvg2-dev" >&2
  exit 1
fi
cd "$ROOT/desktop-shell"
npm ci
npm run build

echo ""
echo "Done. Installers:"
find "$ROOT/desktop-shell/src-tauri/target/release/bundle" -type f \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' -o -name '*.msi' -o -name '*.exe' \) 2>/dev/null || true
echo "Next: run Gate A1 in docs/DESKTOP_BETA.md on a clean VM using the artifact above."
