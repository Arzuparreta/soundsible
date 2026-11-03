#!/usr/bin/env bash
# One emulator shard of the Android suite. Runs inside the emulator action, so
# Stream from the start: dumping only at the end loses early tests when Android's
# circular buffer wraps. The EXIT trap also runs on failures/signalled shutdown.
set -u
shard=$1
count=$2
code=0
mkdir -p android/build
adb logcat -v threadtime > android/build/emulator.log 2>&1 &
logcat_pid=$!
finish() {
  status=$?
  trap - EXIT
  kill "$logcat_pid" 2>/dev/null || true
  wait "$logcat_pid" 2>/dev/null || true
  printf '\nAndroid shard %s/%s exit=%s\n' "$shard" "$count" "$status" >> android/build/emulator.log
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$shard" = 0 ]; then python scripts/android.py smoke || code=$?; fi
if [ "$code" = 0 ]; then python scripts/android.py integration --shard "$shard/$count" || code=$?; fi
if [ "$code" = 0 ] && [ "$shard" = 0 ]; then
  python scripts/android.py install && adb exec-out screencap -p > android/build/startup.png || code=$?
fi
exit "$code"
