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

attempt() {
  xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- bash -c '
    pulseaudio --start --exit-idle-time=-1
    pactl load-module module-null-sink sink_name=soundsible_test >/dev/null
    pactl set-default-sink soundsible_test
    exec python3 "$@"
  ' smoke "$smoke" --artifacts "$1" "${@:2}"
}

# WebKit under Xvfb, without a GPU, now and then loses its web process or
# stops answering WebDriver (seen on Debian 12 and openSUSE), and the next
# run on the same runner passes. A second attempt keeps that from failing a
# package; a broken package fails both. The first attempt's evidence stays.
if attempt "$artifacts" "$@"; then
  exit 0
fi
echo "::warning title=Linux UI smoke retried::The first attempt failed; its evidence is in ${artifacts}/first-attempt."
mkdir -p "$artifacts/first-attempt"
find "$artifacts" -mindepth 1 -maxdepth 1 ! -name first-attempt -exec mv {} "$artifacts/first-attempt/" \;
attempt "$artifacts" "$@"
