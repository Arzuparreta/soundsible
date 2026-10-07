#!/usr/bin/env bash
# One emulator shard of the Android suite. Runs inside the emulator action, so
# the logcat is saved even when a step fails: a failing case is diagnosed from it.
set -u
shard=$1
count=$2
code=0
mkdir -p android/build
if [ "$shard" = 0 ]; then python scripts/android.py smoke || code=$?; fi
if [ "$code" = 0 ]; then python scripts/android.py integration --shard "$shard/$count" || code=$?; fi
if [ "$code" = 0 ] && [ "$shard" = 0 ]; then
  python scripts/android.py install && adb exec-out screencap -p > android/build/startup.png || code=$?
fi
adb logcat -d > android/build/emulator.log || true
exit "$code"
