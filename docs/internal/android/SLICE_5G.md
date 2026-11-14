# S5g: trust and artwork between UIDs

CarExternal2 + CarLegacy2 + CarLibrary2,6/0 HTTP/TLS; runner exit0 and APK/test
APK/JVM54/lint without CA. [Evidence](evidence/s5g.json) records hashes and duration.

Probe included only in the test APK: service in a process of another UID and notification
listener. Without authorization, browse is rejected. The system authorizes
the listener temporarily; browse and real reading of PNG through an opaque URI
work between UIDs, while writing stays denied. The authorization
is removed in finally. The Java probe uses only Android APIs, without dependencies
on the main APK or credentials/cookies.

On this AVD API36 the notification manager authorization did not update
the old secure list that Media3 queries. PlaybackService accepts as a fallback
the trust of the system media manager (API28+), only when Media3
has verified package/UID. Private queue permissions are not extended.
[Identity contract](https://developer.android.com/reference/androidx/media3/session/MediaSession.ControllerInfo#isPackageNameVerified()).

It does not test the Google Auto host, DHU or physical listening. Controls and URI revocation
after logout from another UID are still pending; not full parity/release.
