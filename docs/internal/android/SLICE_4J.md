# S4j — Receiver recovery, reset and system focus

The acceptance uses the runner's real Community and MediaMTX. A
fixture-only intervention rejects the read authorization of the selected stream;
it does not replace the transport, the socket or the Android retry policy.
Exactly four attempts are observed (initial and three retries), IDLE state
with an error and no further attempts. Removing the rejection and manually
preparing/playing restores the receiver, keeps the volume and allows audio focus.

A second owner requests transient focus through AudioManager: Live
is ducked while keeping playWhenReady, and resumes playback when focus
returns. An AUDIO_BECOMING_NOISY broadcast from the system UID pauses; it does not leave the
receiver or the room and requires explicit resumption.

During a real TLS OPTIONS request stalled for ten seconds, logging out removes the receiver
in less than three seconds. Eight seconds later there are no retries or WHEP
resources, and preparing/playing the owner from the previous generation does not reactivate it.
The account is restored only to clean up the test room with signed authorization.

LiveRecoveryTest: HTTP and TLS, recovery and reset, four tests without failures, 56.701s.
Also record the runner output and normal checks in evidence/s4j.json.
It does not test physical acoustics or the full principal/browser regression. Exhaustion and
reset of the publisher require separate acceptance; do not declare full parity.
