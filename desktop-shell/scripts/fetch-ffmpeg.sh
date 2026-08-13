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
  # Windows pins a concrete build so the checksum is meaningful. BtbN prunes its
  # daily autobuild releases after about two weeks and keeps only the last build
  # of each month, so pin month-end tags (autobuild-YYYY-MM-<last day>-HH-MM) or
  # the download starts returning 404 once the daily release rotates out.
  x86_64-pc-windows-msvc)
    ARCHIVE="$CACHE/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl.zip"
    URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1.zip"
    SHA256="cc4156d51387566ea8ba653fc3a04897bdf812fddf652428d9030bbf7ae24835"
    ;;
  aarch64-pc-windows-msvc)
    ARCHIVE="$CACHE/ffmpeg-n8.1.2-34-g9b6c8969e0-winarm64-gpl.zip"
    URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n8.1.2-34-g9b6c8969e0-winarm64-gpl-8.1.zip"
    SHA256="abf3b41c200ce5346b9bb5be6fe634c4720d891778d8921f7b36b76d002b3c96"
    ;;
  *)
    echo "fetch-ffmpeg: unsupported target $TARGET — install ffmpeg via OS package manager" >&2
    exit 0
    ;;
esac

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Downloading FFmpeg for $TARGET …"
  if ! curl -fsSL "$URL" -o "$ARCHIVE"; then
    rm -f "$ARCHIVE"
    echo "fetch-ffmpeg: could not download $URL" >&2
    echo "if this is a 404, the pinned upstream release was pruned — repin to a" >&2
    echo "month-end autobuild tag and refresh the checksum above" >&2
    exit 1
  fi
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
