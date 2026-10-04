#!/usr/bin/env bash
# Build and sign the Soundsible Android APK with a local throwaway debug key.
#
# The key proves the APK came from this source tree and makes it installable;
# it is NOT a Play release identity (see docs/ANDROID.md). The keystore lives
# at android/keystores/debug.keystore and is gitignored.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$REPO_ROOT/android"
KEYSTORE="$ANDROID_DIR/keystores/debug.keystore"
ALIAS="androiddebugkey"

if ! command -v keytool >/dev/null 2>&1; then
  echo "error: keytool (JDK) is required" >&2
  exit 1
fi

if [ ! -f "$KEYSTORE" ]; then
  echo "Generating local debug key at android/keystores/debug.keystore ..."
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 3650 \
    -storepass android -keypass android \
    -dname "CN=Soundsible Debug, OU=Debug, O=Soundsible, L=Local, ST=Local, C=US"
else
  echo "Reusing existing debug key at android/keystores/debug.keystore"
fi

if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  for candidate in "$HOME/Android/Sdk" "/opt/android-sdk" "/usr/lib/android-sdk"; do
    if [ -d "$candidate" ]; then
      export ANDROID_HOME="$candidate"
      break
    fi
  done
fi
echo "ANDROID_HOME=${ANDROID_HOME:-<unset>}"

cd "$ANDROID_DIR"
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleRelease

APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK" ]; then
  echo "error: expected APK not found at $APK" >&2
  exit 1
fi

# Verify the signature the same way a device installer would check it.
BUILD_TOOLS_BIN=""
if [ -n "${ANDROID_HOME:-}" ]; then
  BUILD_TOOLS_BIN="$(ls -d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1)"
fi
APKSIGNER=""
if [ -n "$BUILD_TOOLS_BIN" ] && [ -x "${BUILD_TOOLS_BIN}apksigner" ]; then
  APKSIGNER="${BUILD_TOOLS_BIN}apksigner"
elif command -v apksigner >/dev/null 2>&1; then
  APKSIGNER="apksigner"
fi
if [ -n "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs "$APK"
else
  echo "warning: apksigner not found; skipping signature verification" >&2
fi

echo
echo "Signed APK: $APK"
ls -lh "$APK"
sha256sum "$APK"
