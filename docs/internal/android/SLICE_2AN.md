# S2an — NORMAL output handoff

The "Transfer playback" button of each connected device delegates to the service.
NativeDeviceSession verifies a destination of the same account with an active socket,
publishes the recent native queue/position and then calls Core handoff. The
operation uses the serial worker of the actor, without blocking the player looper.
The periodic report is deferred while there is a handoff. Do not send a session
captured by JavaScript or a stale state from the periodic refresh.

The generation, cookie identity, profile, actor socket/revision and pending
future bound each step. A change of queue/index/preferences/transport between
the publication and the sending cancels the operation. Logout/reset cancels the request
and resolves the future as disconnected. Core pauses the origin when sending to the destination;
the screen does not pause optimistically if the publication/preflight fails.

DJ does not offer this button yet: it needs serialization/restoration of its own
workspace and route. Do not downgrade a DJ session to NORMAL. This
vertical also does not close Radio/pending catalog or complete parity.

Acceptance: DevicesUi + DeviceSession4/0 HTTP/TLS,31.965s; runner exit0 and
normal APK/test APK without temporary CA, JVM56/0 and lint pass. Log
`/tmp/soundsible-outgoing-native.log`. UI 210 files/1614 tests and typecheck pass
after adding transfer in EN/ES/FR/ZH. The FR/ZH translations were added after
the native runner; do not claim physical navigation or four languages in the WebView.

DevicesUiTest validates the real button, two occurrences/index/position 54s/shuffle/
repeat all received by a remote Core socket and pause of the origin service.
The peer validates the received contract, it does not decode audio; DeviceSession validates
restoration/PCM on Android separately. Guest Live/DJ are not transferred here.
