#!/usr/bin/env bash
# Run linux_ui_smoke.py the way every Linux package is checked: on a virtual
# display, with its own session bus and a sound server that plays into a null
# sink. Arguments after the artifacts directory go to the smoke unchanged.
#
#   run-linux-ui-smoke.sh ARTIFACTS --app /usr/bin/soundsible-desktop --engine /usr/bin/soundsible-engine
#   run-linux-ui-smoke.sh ARTIFACTS --flatpak io.github.Arzuparreta.Soundsible \
#     --app /app/bin/soundsible-desktop --engine soundsible-engine
set -euo pipefail

artifacts="$1"
shift
smoke="$(cd "$(dirname "$0")" && pwd)/linux_ui_smoke.py"
mkdir -p "$artifacts"

# Containers start without a runtime directory, and PulseAudio and Flatpak
# both put their sockets there.
if [[ -z "${XDG_RUNTIME_DIR:-}" || ! -w "${XDG_RUNTIME_DIR}" ]]; then
  XDG_RUNTIME_DIR="$(mktemp -d)"
  chmod 700 "$XDG_RUNTIME_DIR"
  export XDG_RUNTIME_DIR
fi

exec xvfb-run -a dbus-run-session -- bash -c '
  pulseaudio --start --exit-idle-time=-1
  pactl load-module module-null-sink sink_name=soundsible_test >/dev/null
  exec python3 "$@"
' smoke "$smoke" --artifacts "$artifacts" "$@"
