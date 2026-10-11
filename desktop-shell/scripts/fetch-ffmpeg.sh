#!/usr/bin/env bash
# Download static FFmpeg and ffprobe binaries for desktop consumer bundles (optional build step).
#
# Outputs:
#   desktop-shell/packaging/vendor/{ffmpeg,ffprobe}[.exe] (PyInstaller)
#   desktop-shell/src-tauri/binaries/{ffmpeg,ffprobe}-${TARGET}[.exe] (Tauri)
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
  x86_64-unknown-linux-gnu)
    ARCHIVE="$CACHE/ffmpeg-n8.1.3-9-g29e619e767-linux64-gpl-8.1.tar.xz"
    URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-linux64-gpl-8.1.tar.xz"
    SHA256="97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79"
    ;;
  aarch64-unknown-linux-gnu)
    ARCHIVE="$CACHE/ffmpeg-n8.1.3-9-g29e619e767-linuxarm64-gpl-8.1.tar.xz"
    URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-linuxarm64-gpl-8.1.tar.xz"
    SHA256="10523d1e0be6b3ce62a9708cc50815c4b5eb5f36ae147fbe2afeecda6f2d6845"
    ;;
  # Windows pins a concrete build so the checksum is meaningful. BtbN prunes its
  # daily autobuild releases after about two weeks and keeps only the last build
  # of each month, so pin month-end tags (autobuild-YYYY-MM-<last day>-HH-MM) or
  # the download starts returning 404 once the daily release rotates out.
  x86_64-pc-windows-msvc)
    ARCHIVE="$CACHE/ffmpeg-n8.1.3-9-g29e619e767-win64-gpl.zip"
    URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip"
    SHA256="7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa"
    ;;
  # Keep the last verified Windows ARM64 binary: the September 8.1.3 build
  # crashes with STATUS_ACCESS_VIOLATION in the packaged real-audio CI smoke.
  # Revisit this pin only when a replacement passes that same native smoke.
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
  # On Windows curl asks the certificate's revocation server too, and a hosted
  # runner that cannot reach it fails the whole build (CRYPT_E_REVOCATION_OFFLINE
  # on the v0.16.0 release PR). Best effort still refuses a certificate it can
  # see is revoked, and the Windows archives are held to the pinned checksums
  # below either way. Other builds ignore the flag.
  if ! curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --ssl-revoke-best-effort "$URL" -o "$ARCHIVE"; then
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
  SUFFIX=".exe"
else
  tar -xJf "$ARCHIVE" -C "$WORK"
  SUFFIX=""
fi

for TOOL in ffmpeg ffprobe; do
  SOURCE="$(find "$WORK" -name "${TOOL}${SUFFIX}" -type f | head -1)"
  if [[ -z "$SOURCE" || ! -f "$SOURCE" ]]; then
    echo "fetch-ffmpeg: could not find $TOOL in archive" >&2
    exit 1
  fi
  install -m 755 "$SOURCE" "$VENDOR_DIR/${TOOL}${SUFFIX}"
  install -m 755 "$SOURCE" "$BIN_DIR/${TOOL}-${TARGET}${SUFFIX}"
  echo "Media tool vendor: $VENDOR_DIR/${TOOL}${SUFFIX}"
  echo "Media tool Tauri:  $BIN_DIR/${TOOL}-${TARGET}${SUFFIX}"
done
rm -rf "$WORK"
