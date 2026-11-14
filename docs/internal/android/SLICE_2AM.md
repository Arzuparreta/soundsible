# S2am — Device controls from Android

The playback identity comes from PlaybackService through the
SoundsiblePlayback bridge, bound to the native generation. Settings shows the phone
as "this" and the devices of the same account; pause/play/previous/next
are sent over authenticated HTTP to Core and reach their sockets. Do not import the
web store/player to identify Android: it would create another audio owner.

Commands are serialized per interaction; controls are disabled for devices
without a socket. Requests/listener are cancelled on unmount. Identity/generation and
the component's lifetime prevent a late response from showing data from the previous
account or sending a command after the change. The list is refreshed on the first
mount, by button and every 10s while the screen is visible.

Full UI 210 files/1613 tests and TypeScript pass. DevicesUiTest validates the
real WebView buttons against a second Core socket authenticated over HTTP/TLS;
combined acceptance DevicesUi + DeviceSession4/0 HTTP/TLS, 31.097s.
The first test discovered that `/api/devices` did not expose `socket_active`,
a property expected by the shared web UI: Core now derives it from active_sid.
Re-registration already preserved the socket; do not attribute the failure to it.
Core tests 15/0. Runner exit0; normal APK/test APK without a temporary CA, JVM56/0 and lint pass.
Log `/tmp/soundsible-devices-final-native.log`. Output handoff and the DJ/Radio workspace remain
pending: this screen does not replace them. Development, not a release.
