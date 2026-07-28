#!/usr/bin/env bash
# Download a static FFmpeg binary for desktop consumer bundles (optional build step).
#
# Outputs:
#   desktop-shell/packaging/vendor/ffmpeg          (PyInstaller embed, dev)
#   desktop-shell/src-tauri/binaries/ffmpeg-${TARGET}  (Tauri externalBin sibling)
#
# Usage:
#   ./desktop-shell/scripts/fetch-ffmpeg.sh
#   BUNDLE_FFMPEG=1 ./desktop-shell/scripts/build-sidecar.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENDOR_DIR="$ROOT/desktop-shell/packaging/vendor"
BIN_DIR="$ROOT/desktop-shell/src-tauri/binaries"
TARGET="$(rustc --print host-tuple)"
CACHE="$ROOT/desktop-shell/build/ffmpeg-cache"
mkdir -p "$VENDOR_DIR" "$BIN_DIR" "$CACHE"

case "$TARGET" in
  x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)
    ARCHIVE="$CACHE/ffmpeg-linux64.tar.xz"
    URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
    ;;
  x86_64-pc-windows-msvc)
    ARCHIVE="$CACHE/ffmpeg-n8.1.2-31-g8c9502e9b0-win64-gpl.zip"
    URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-28-13-32/ffmpeg-n8.1.2-31-g8c9502e9b0-win64-gpl-8.1.zip"
    SHA256="e88033629ebecd56d01e6b5b2e693f07d3ec3ed0d14188fc18d7d0bc9c3e6709"
    ;;
  aarch64-pc-windows-msvc)
    ARCHIVE="$CACHE/ffmpeg-n8.1.2-31-g8c9502e9b0-winarm64-gpl.zip"
    URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-28-13-32/ffmpeg-n8.1.2-31-g8c9502e9b0-winarm64-gpl-8.1.zip"
    SHA256="a77a0d57d4cdf18d749ef056be515c25e8a80732e16f7e1e31357ba5c19606d6"
    ;;
  *)
    echo "fetch-ffmpeg: unsupported target $TARGET — install ffmpeg via OS package manager" >&2
    exit 0
    ;;
esac

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Downloading FFmpeg for $TARGET …"
  curl -fsSL "$URL" -o "$ARCHIVE"
fi

if [[ -n "${SHA256:-}" ]]; then
  ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  if [[ "$ACTUAL_SHA256" != "$SHA256" ]]; then
    rm -f "$ARCHIVE"
    echo "fetch-ffmpeg: checksum mismatch for $TARGET" >&2
    echo "expected: $SHA256" >&2
    echo "actual:   $ACTUAL_SHA256" >&2
    exit 1
  fi
fi

WORK="$CACHE/extract-$$"
rm -rf "$WORK"
mkdir -p "$WORK"

if [[ "$ARCHIVE" == *.zip ]]; then
  unzip -q "$ARCHIVE" -d "$WORK"
  FF="$(find "$WORK" -name ffmpeg.exe -type f | head -1)"
  OUT_NAME="ffmpeg-${TARGET}.exe"
else
  tar -xJf "$ARCHIVE" -C "$WORK"
  FF="$(find "$WORK" -name ffmpeg -type f | head -1)"
  OUT_NAME="ffmpeg-${TARGET}"
fi

if [[ -z "$FF" || ! -f "$FF" ]]; then
  echo "fetch-ffmpeg: could not find ffmpeg in archive" >&2
  exit 1
fi

install -m 755 "$FF" "$VENDOR_DIR/ffmpeg"
install -m 755 "$FF" "$BIN_DIR/$OUT_NAME"
rm -rf "$WORK"

echo "FFmpeg vendor: $VENDOR_DIR/ffmpeg"
echo "FFmpeg Tauri:  $BIN_DIR/$OUT_NAME"
