# S6: offline and distribution

## S6a: Available offline

[Approved decision](OFFLINE_DECISION.md), 2026-10-03. Prepare acquired music
files from the three-dot menus of a song/collection. There is no preparation
action in the shell and no implicit acquisition of previews. Collections take
their current members, even if the local search filters the visible rows.

## Data and transport

OfflineStore (application singleton) uses SQLite in private storage,
with limited metadata per song, state, bytes/total, digest and attempt ticket.
Identity bound to the origin and to the account id confirmed in native auth; the cookie
stays in EngineConnection/Keystore and never crosses to JS. The UI cannot register
an offline account or supply file paths. Maximum 1,000 copies per profile.
Playlists keep members/duplicates and are filtered to ready files when disconnected.
Albums/artists are derived from local metadata; artwork uses a placeholder.

One sequential worker, one transfer in flight, authenticated GET of the engine's local
stream with private origin/TLS and redirects rejected. It does not call providers.
Bodies with unknown/incorrect length, without a recognized duration or truncated
are not published. .part file, fsync, media verification and SHA-256 come before
rename and the ready state. The hash is checked again after a restart and an mtime change; lengths
are checked too. Names are derived from the SHA-256 of the id, never from paths from JS.

No eviction. Default limit 2 GiB, options 512 MiB/2 GiB/8 GiB; it reserves
16 MiB of real space. A space failure does not delete other songs. Cancelling or
removing invalidates the ticket, cancels the Call/body and deletes only its own files.
Duplicates/overlapping collections share one copy per id. Logout/change of
server/account and an observed 401 delete the profile and cancel preparation.

OfflineService dataSync only starts through an explicit action with the Activity in the foreground,
with a localized notification. It stops when the queue finishes and handles the OS timeout.
It does not resume network work automatically at startup: after process death, the incomplete
attempts remain interrupted and partials/orphans are cleaned up. Retry is explicit.
SQLite keeps complete copies and metadata; it does not persist the media program.
Reference for the service limit: [Android](https://developer.android.com/develop/background-work/services/fgs/timeout).

## Program and UX

OfflineDataSource resolves a complete file when the local stream is opened, keeping
id/UUID/queue and the same ExoPlayer. The file URI never crosses JS. Range/seek are served by
FileDataSource. Generation is also checked on reads; reset closes the program.
With network, an explicit complete copy is also reused without transferring audio.
Without the engine, startup restores the verified profile and the available library;
auth is only considered revoked when there is a real 401 response, not on a network failure.

The library contains songs/albums/artists/playlists from the same surface.
Its menu opens the "Only on this device" filter and space/progress/failure management.
The song/collection menu offers preparation, a ready mark and removal/cancellation.
When disconnected, only a queue of available members is activated, keeping the
chosen index and duplicates. Remote search/DJ/Live are not advertised as offline.
There are no deferred mutations and no invented synchronization on reconnect.

## Acceptance

Tests for conversion/menus/overlay, APK/lint, real HTTP/HTTPS engine path, deduplicated
batch, fully unreachable engine, playback/seek/pause/close and
Activity recreation. Limits, partial/invalid body, cancellation and local logout.
The helper runs a persistent phase, a real force-stop of the APK and another offline phase,
checking the hash and same-size corruption. Results in HANDOFF/evidence.
The restart phase is excluded from the main suite and the helper invokes it with
its own arguments; do not run it on its own without the two-phase protocol.
The APK and the test APK are installed once; `am instrument` runs the phases and
`am force-stop` separates the processes. Gradle connectedDebugAndroidTest uninstalls
the app after each run and must not be used for both persistent phases.
`scripts/android.py integration --offline-restart-only` repeats only that
protocol, keeps the earlier main evidence and does not validate the main suite.
The normal integration first runs the whole suite and then the protocol.

The validation found an earlier failure in the WebM preview proxy over HTTPS:
the mtime that counts reads/LRU also generated the send_file ETag.
A Media3 If-Range stopped matching after the first read and received
200 with the whole body. The revision of each cache commit/remux now generates
an ETag that is stable between reads; Last-Modified does not advertise recency as a content
change. Old caches keep Range without a validator until they are reacquired.
The tests cover 206/304, same-size replacement and old entries;
Program retries for 429/503 keep budget and cooldown. The transport
allows a single new GET exchange if a reused socket disappears before
receiving headers (EOF); it does not apply to a new connection, TLS/certificate, timeout,
cancellation, partial body or HTTP response. It does not resume playback after an
observed error and does not add program retries. Policy covered by native tests.

S6a does not enable a release. Keep the [gates](RELEASE_GATES.md) for full parity,
permanent signature and update; physical acceptance of sound/car remains separate.
