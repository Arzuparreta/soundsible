#!/usr/bin/env bash
# Regenerate bundle + tray icons from branding/logo-mark.svg (DT3).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SVG="$ROOT/branding/logo-mark.svg"
ICONS="$ROOT/desktop-shell/src-tauri/icons"
TMP="$(mktemp /tmp/soundsible-icon-XXXXXX.png)"

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

if [[ ! -f "$SVG" ]]; then
  echo "Missing logo source: $SVG" >&2
  exit 1
fi

mkdir -p "$ICONS"
rsvg-convert -w 512 -h 512 "$SVG" -o "$TMP"
rsvg-convert -w 32 -h 32 "$SVG" -o "$ICONS/tray-idle.png"

cd "$ROOT/desktop-shell"
npx tauri icon "$TMP" -o src-tauri/icons

echo "Generated bundle icons and tray-idle.png from $SVG"
