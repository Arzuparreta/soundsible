# Desktop client connections

The Windows desktop installer includes a Tauri shell and the optional local
station engine. It can also connect to a station you already run natively, in
Docker, on your LAN or behind HTTPS. Audio plays on the computer running the
client. The interface and audio engine are the shared SolidJS/Web Audio
player, rendered by WebView2, so media keys and the Windows media overlay come
from the player's Media Session as they do in a browser.

There is no Linux client; see [Desktop app](DESKTOP_BETA.md#no-linux-app).

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

Closing hides the app when a usable tray is present. Without tray support,
closing exits. Global shell shortcuts are best-effort.

## Isolation and compatibility

`desktop-client.json` stores connection preferences, and
`desktop-appearance.json` stores the client window palette in Soundsible's
configuration directory. Neither changes the external station configuration.
WebView session data lives under `desktop-webviews/`, partitioned by origin.
A station's `config.json` or `music_dir.json` alone is not proof of a desktop
installation: legacy local-mode restoration also requires the desktop's own
`desktop-owner-token` marker and a valid saved music folder.

The bundled configuration window has local desktop permissions. Each player
window has only the handshake and appearance permissions for its selected
origin and its own connection generation. Changing connections destroys that
window; stale callers are rejected. All application commands have explicit
Tauri ACLs in `build.rs`, including commands used by the local configuration
screen. The supervisor stops only processes represented by its own retained
child handle; a PID found on disk never establishes ownership.

The desktop bridge a player window receives answers a handshake and sets the
window's palette. It once also carried programme snapshots and transport
commands for the Linux app's MPRIS service; players from stations of that era
still call them, so the shell keeps both as no-ops and answers the handshake
with `media: false`, which leaves those players on their Media Session.

Installer automation and what still needs a human: [Desktop app](DESKTOP_BETA.md#what-ci-proves).
