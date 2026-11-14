# S4b — native WHIP/WHEP relay

Implements `LivePeer`, a WebRTC resource for native publishing/receiving with an HTTPS
transport without the Core's cookies, without redirects and with Location restricted to the same
origin. It discovers ICE with OPTIONS, negotiates stereo Opus with post-DSP capture and
publishes the complete offer after gathering candidates. DELETE releases the resource.
A publisher reservation made before creating the capture prevents a second attempt
from taking the tap of the active program. Microphone access is not requested.

`scripts/android_live_fixture.py` runs real Community and MediaMTX pinned by digest
in an ephemeral environment: private database, Ed25519 signature from the Core, MediaMTX HTTP
authentication and TLS with the runner's temporary CA. It does not use public services.
The alias 10.0.2.2→loopback affects only the resolver of the disposable Core, to reproduce
the AVD gateway address, keeping hostname and TLS verification.

The runner starts the relay in the main suite and when the filter includes
`LiveRelayTest`; it can also be enabled with `SOUNDSIBLE_ANDROID_LIVE_FIXTURE=1`.
Requires Docker. The resources are deleted at the end, even on failure.

Targeted validation: Core HTTP and TLS → signed session → authenticated WHIP → MediaMTX
→ WHEP → native decoded PCM. Verifies energy, independent local mute,
pause/silence, resume, continuity when closing the Activity and rejection of another
publisher without damaging the active capture. The relay always uses HTTPS.

This does not yet connect Live with the shared controls: missing are the UI bridge,
lease/socket and host metadata in background, listening integrated with MediaSession,
chat, reconnection and DJ validation through the relay. It also does not demonstrate STUN/TURN
connectivity over the Internet or acoustic listening on physical hardware. It does not declare parity.
