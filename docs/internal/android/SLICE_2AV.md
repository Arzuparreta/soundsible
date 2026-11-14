# S2av — Sign in by scanning a pairing code

User decision (2026-10-06): on Android the pairing QR code starts a
full session of the account that shows it, not the restricted token
(`library:read` + `playback:control`) that iOS uses.

Core: `POST /api/pairing/sessions/claim` accepts `credential: "session"`. Only with
the sheet open (auto_confirm + display_active) does it claim the code, create an ordinary
session of that account (HttpOnly cookie, scopes of its role, device name and
type) and link it to the pairing record; it appears in Paired
devices and is revoked from there. Hidden code → 409 `pairing_display_required`
without consuming it. Normal sessions cannot be revoked through that route. Core pairing7 +
auth/multiuser/subsonic78/0.

Android: the "Scan pairing code" button opens `PairingScanActivity` (CameraX + ZXing core,
without Google Play services; camera permission only when pressed). It returns only
text in the `soundsible_pairing` format; the WebView validates the origin (http/https without
credentials, query or fragment, exact paths, consistent claim/player) and the code
(engine alphabet). Alternative: a typed code with the server address.
Camera denied/unavailable opens manual entry. The device name
(`DeviceName`, shared with S2au) also names the normal login sessions,
previously fixed as "Soundsible Android".

QR: the engine only suggests its LAN IP (or nothing on loopback). The sheet in Settings →
Devices now uses the address it is viewed from (web) or the connected
server (Android), and only from loopback does it fall back to the engine's suggestion.
This also benefits iOS.

PairingTest HTTP/TLS: hidden code rejected and not consumed; code typed with a
hyphen/lowercase signs in as owner with a session named after the device;
revoking from Devices on the phone itself disconnects it; denied camera
offers manual entry; scanned QR (Activity result stubbed with
espresso-intents) signs in the same way. The real scanner opens CameraX on AVD and Back
returns cancelled without a code. Block 20/0 HTTP/TLS, 235.817s + runner exit0 +
APK/test APK/JVM59/lint (lint detected getMainExecutor API28, fixed).
UI215/1637 + TS. Logs `/tmp/soundsible-pairing-native.log`,
`/tmp/soundsible-pairing-block-native.log`; evidence/s2av.json.
Not tested: decoding a real QR code through a physical camera (JVM tests the decoder with
a luminance plane with stride; the AVD does not show the QR code to the sensor).
