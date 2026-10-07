# S2al — Dispositivo nativo y traspaso NORMAL

PlaybackService owns a Core Socket.IO device session. It verifies the cookie
against auth/state and the native profile before joining playback_register;
its stable UUID is scoped by origin/account. Generation, cookie identity, profile,
socket identity and revision guard commands and late worker responses. Reset
cancels requests and closes the socket off the player looper. Verification failures
do not purge complete offline copies. A rejected credential waits for a changed
identity; transport errors retry with cooldown.

Real playback events pause/play/seek/next/previous without Activity. NORMAL state
uses the shared playbackSession wire format, bounded to five preceding and forty
following occurrences. Source addresses and Core cookies never enter that state.
Core handoff restores queue/index, position and shuffle/repeat via native sources.
Frequent position reporting is throttled to15s, serialized/coalesced; failed writes
have8s cooldown and owner changes invalidate all queued effects.

Current scope is NORMAL with resolved entries. DJ, Radio workspace, pending catalog
entries, device-list UI and outgoing user handoff still need completion; do not
claim multidispositivo parity from this slice alone. Guest Live remains separate.

DeviceSessionTest uses independent real Core cookies for a second member session
and a different account. It verifies native registration in Core, background
controls/PCM, duplicate occurrences, wrong-account404, actual Core handoff and
logout. The first runs exposed two real Core bugs: playback_register socket events
bypassed Flask user binding and registered in the default scope; remote pause
replaced track/position with null/zero, making immediate resume race native state
publication. Registration now resolves and binds its authenticated account for
that event; pause preserves the target's full existing state. Directed Core tests
cover account scope/context restoration, unowned registration and pause/resume
retention:14/0. Native resume reuses matching bounded queue occurrences instead
of rebuilding keys or truncating the rest of the queue.

Final acceptance: HTTP/TLS2/0 in15.639s, integration exit0; normal APK, test
APK, JVM56/0 and lint pass without temporary fixture CA. Log:
`/tmp/soundsible-device-session-final-native.log`. Earlier HTTP passed; TLS
caught the pause race. No UI changes in this slice.
