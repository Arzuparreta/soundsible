# S5h: playback and revocation from another UID

CarExternalTest2/0 HTTP/TLS, runner exit0; normal APK/test APK/JVM54/lint without CA.
[evidence](evidence/s5h.json) identifies source and duration. Only tests change.

The authorized listener uses playFromMediaId from another process/UID. Its controller
observes the canonical member-track ID and playing; the native program produces non-silent
local PCM. The opaque URI allows a second open before logout. After
clearSession/logout, the same UID and the same URI no longer allow a new read.
Rejection without trust, real PNG decode and denied write are kept.

Revocation does not remove bytes already received or open descriptors. No Google Auto
host, external DJ, external handover/focus, physical listening or full parity.
