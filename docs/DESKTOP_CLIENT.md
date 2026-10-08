# Desktop client connections and Linux integration

The desktop installer includes a Tauri shell and the optional local station
engine. It can now connect to a station you already run natively, in Docker,
on your LAN or behind HTTPS. Audio plays on the computer running the client.
The interface and audio engine remain the shared SolidJS/Web Audio player;
Linux desktop controls are implemented in Rust.

The Linux package embeds FFmpeg and ffprobe inside the optional engine. It does
not install those tools into `/usr/bin` or replace the distribution's packages.

## Choosing a connection

On first launch, enter the station's HTTP/HTTPS address and choose **Connect to
server**, or choose **Use this computer as server** to select a local music
folder. Addresses such as `http://localhost:5005`, a LAN IP or a domain work.
The known `/player/` and `/player/desktop/` entries may also be pasted. Soundsible
must be served at the origin root; reverse-proxy subpaths are not supported.
TLS certificates must validate normally.

The app remembers one server and the selected mode. **Change connection…** is
available in the window menu and tray. Selecting a different connection closes
this client's player. It does not stop the external station. Engine controls
and phone-pairing tray actions are disabled for external connections; use the
station's existing Settings for its management and pairing flows.

The station supplies the player and its existing login. Cookies are persistent
and isolated by station origin, including its port. The app does not save
passwords or obtain the local engine's owner credential for external stations.
Older stations can still open their player; the desktop menu explains when
native media controls need an updated station. A missing media bridge does not
block ordinary playback.

Closing hides the app when a usable tray is present. Without tray support,
closing exits; the window menu and MPRIS **Raise**/**Quit** remain available.
Global shell shortcuts are best-effort on desktops that support them.

## Linux controls

The app exports `org.mpris.MediaPlayer2.soundsible` on the session bus and uses
MPRIS for desktop media widgets and multimedia keys. Play/pause, next/previous,
seek, volume, shuffle and repeat use the same player actions as the UI. DJ next
uses the DJ skip action while playing. Navigating a paused queue stays paused;
**Stop** pauses and seeks to the beginning without deleting the queue.

Metadata describes the programme, rather than an individual overlapping DJ
deck. Covers go through a bounded local cache so desktop widgets do not receive
session cookies or authenticated artwork URLs. A renderer that stops reporting
is cleared after 30 seconds; reconnecting its bridge restores controls.

While the programme plays, the app requests a suspend inhibitor through
[XDG Desktop Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Inhibit.html),
falling back to logind. Pausing, stopping, changing connection,
losing the renderer or quitting releases it. Screen locking is allowed. The OS
may deny inhibition, and explicit suspension remains subject to desktop policy;
a missing service never prevents playback.

## Isolation and compatibility

`desktop-client.json` stores connection preferences, and
`desktop-appearance.json` stores the client window palette in Soundsible's
configuration directory. Neither changes the external station configuration.
WebView session data lives under `desktop-webviews/`, partitioned by origin.
A station's `config.json` or `music_dir.json` alone is not proof of a desktop
installation: legacy local-mode restoration also requires the desktop's own
`desktop-owner-token` marker and a valid saved music folder.

The bundled configuration window has local desktop permissions. Each player
window has only media/appearance permissions for its selected origin and its
own connection generation. Changing connections destroys that window; stale
publishers are rejected. All application commands have explicit Tauri ACLs in
`build.rs`, including commands used by the local configuration screen.
The supervisor stops only processes represented by its own retained child
handle; a PID found on disk never establishes ownership.

No public REST endpoints or station authentication formats change. The new
optional desktop bridge advertises media capabilities and exchanges programme
snapshots, transport commands and appearance. Browsers/PWAs continue using
Media Session. Linux uses one native media session to avoid duplicate key
handling. The connection modes are shared with Windows; MPRIS and power
inhibition compile only on Linux.

## Validation and remaining physical checks

Desktop Build installs the actual Linux `.deb` and drives it with Tauri's
WebKit WebDriver against an independent packaged station. The smoke test plays
real WAV files and checks advancing audio position, MPRIS transport/volume,
paused navigation, remote command denial, persisted connection preferences,
absence of a client engine, and station survival after client exit. A persisted
runtime state deliberately points at the independent station to guard against
accidental termination. It also monitors MPRIS property signals when changing
connections so notification-driven widgets clear the previous track. Screenshots,
process measurements and logs are uploaded
as `linux-ui-evidence`.

Tauri's `TAURI_WEBVIEW_AUTOMATION=true` environment enables WebKit WebDriver
only on its first WebContext. Automated runs therefore share that context and
use disposable XDG directories. Normal launches use the per-origin WebView
directories; the smoke test does not prove cookie-store partitioning.

Rust tests also run on a disposable D-Bus session and exercise acquire/release
of a fake suspend portal. This validates lifecycle and flags, not a physical
computer's power policy. The complete frontend browser suite covers all four
CI profiles; existing Windows installer automation remains required.

For a local installed package, provide a session bus, X server, null audio sink,
`tauri-driver`, `WebKitWebDriver`, `busctl` and Python, then run:

```sh
xvfb-run -a dbus-run-session -- bash -c '
  pulseaudio --start --exit-idle-time=-1
  pactl load-module module-null-sink sink_name=soundsible_test
  python desktop-shell/scripts/linux_ui_smoke.py \
    --app /usr/bin/soundsible-desktop \
    --engine /usr/bin/soundsible-engine \
    --artifacts /tmp/soundsible-linux-ui
'
```

Before calling real-device acceptance complete, listen through NORMAL and DJ
on Linux with the window hidden, use physical multimedia keys, verify the
tray/restore/quit flow, and check automatic suspend and screen locking. Record
the distribution, desktop and X11/Wayland session. A virtual display/null sink
cannot prove audible output, desktop compositor behavior or physical power
policy. The automated process/RSS evidence is a baseline, not a comparison
against Firefox/PWA and not proof that native audio is necessary.

A separate native audio engine, GTK/Qt interface, multiple station profiles,
offline downloads and song notifications are outside this delivery.
