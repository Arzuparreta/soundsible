#!/usr/bin/env bash
# Run a CI install command until it succeeds, riding out a flaky mirror.
#
#   scripts/ci_retry.sh [--cleanup 'shell command'] -- command args...
#
# Up to five attempts with growing waits (about two minutes in all). The
# cleanup runs between attempts, for a download that leaves a broken partial
# behind (sdkmanager's "unknown archive" after a cut-off zip). A command that
# keeps failing still fails the job, with every attempt's output in the log.
set -uo pipefail

cleanup=""
if [ "${1:-}" = "--cleanup" ]; then
  cleanup="$2"
  shift 2
fi
[ "${1:-}" = "--" ] && shift

attempts=5
for attempt in $(seq 1 "$attempts"); do
  "$@" && exit 0
  status=$?
  if [ "$attempt" -eq "$attempts" ]; then
    echo "::error::$1 failed $attempts times (exit $status)"
    exit "$status"
  fi
  wait=$((attempt * 10))
  echo "::warning::$1 failed (exit $status), attempt $attempt/$attempts; retrying in ${wait}s"
  [ -n "$cleanup" ] && bash -c "$cleanup"
  sleep "$wait"
done
