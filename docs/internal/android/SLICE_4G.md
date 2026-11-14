# S4g — Cancellation and recovery of Live media

LivePeer allows invalidating a handshake immediately from the player looper.
It cancels the SDP/ICE waits and the HTTP calls outside the main thread. The
native close stays in its worker; DELETE of the resource has a limit of2s. The
Locations behind `/media/` keep exactly one prefix and stay bound
to the HTTPS origin, without credentials in the URL or fragments.

Host and listener have up to three retries, with waits of1/2/4s and deadline30s.
The listener keeps the pause/playback intent, volume and MediaSession
identity when replacing the peer. An explicit close or a new generation cancels
the old work; exhaustion ends the audio and leaves the manual retry. The host
reconnects in the same room and keeps sending the pause heartbeat while it recovers
media. Losing the lease socket for10s removes the host so that it does not keep publishing
indefinitely after losing the room.

The disposable relay offers strict fixture controls to cut a real
MediaMTX peer per room/role, and a TLS OPTIONS response that takes10s. These
controls only exist in scripts/android_live_fixture.py, outside the production
Community application. The extended acceptance cuts publisher and listener;
it keeps the listener paused during recovery and verifies PCM after returning.
The handshake must be cancelled in less than3s without a network exception on main.

Validation:14/0 in148.745s, runner exit0, normal APK/test APK/JVM56/lint
without temporary CA pass. See evidence/s4g.json. It includes the real UI and all the
earlier Live classes; it does not replace the main regression or Browser4.
Pending: exhaustion/lease and long
polling test, process death/resume409 and service reset during handshake. Afterwards
the final Live regression and the remaining phone/DJ/Auto rows are closed.
It does not enable merge or release; the PR stays for manual review.
