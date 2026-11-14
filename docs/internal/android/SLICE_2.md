# S2: first native audio program

## First vertical slice

A real song from the library goes from the Solid row to an authenticated Android
Media3 service: play/pause/seek/end, metadata/position and lock screen controls
follow the same state, even with the Activity recreated or in the
background. A single NORMAL source/queue at the start; no DJ, Live, offline or publishing.
This slice is the base of the complete S2 (podcasts, radio, previews and handoff), not
permission for a reduced alpha.

## Concrete work

1. Read `AudioService` and the current stores. Define asynchronous commands/snapshots and
   generations before mounting `AuthenticatedPlayer`. Do not fake synchronous
   operations by returning success from a bridge that is still pending.
2. Add MediaLibraryService/MediaSession and an HTTP source that uses the protected
   cookie of EngineConnection. Preserve Range and 401/403 errors without exposing
   the secret through JS/URLs and without following authenticated redirects. The current WebView
   proxy only supports covers: do not use it as audio transport.
3. Extract/adapt the shared runtime: library and rows use the same
   contracts; the Android variant does not import/instantiate AudioContext or HTMLAudio.
   Go back to using complete Solid routes/actions as the runtime becomes available;
   remove the temporary read surface when it has a tested replacement.
4. Keep the service as the owner of the program, with focus/pause policy and
   OS commands. The foreground Activity only observes; it does not publish another state or
   rebuild a queue on rotation/recreation.
5. Logout/switch cancels audio and resources before another account; a revoked 401
   stops the service. A dropped network keeps recoverable state without claiming that
   it is playing. Do not enable Web Audio as a fallback on Android.

## Tests and delivery

Extend the disposable fixture with its own short audio and real Range responses.
In an instrumented APK: queue order and occurrences, position/seek, pause/end,
recreation/background, focus, metadata/media controls, 401, server down and
account switch in flight. Test the valid HTTPS happy path pending from S1.
Separate observed state/progress from acoustic listening: the emulator does not prove
Bluetooth, calls, Android Auto or a real car.

Run contract tests, build/lint/Android and the four browser profiles after
UI changes. Update matrix/evidence/HANDOFF and close with a focused commit.
Push authorized for this line of work; PR/merge/publishing not requested.


## Contract of the first slice (S2a)

`SoundsiblePlayback.command` is asynchronous. Its resolution confirms acceptance of the
command by the controller, not audible sound: `playing` only comes from
`ExoPlayer.isPlaying`. Native state: generation, queue id/index/ids,
position/duration in ms, readiness and error/HTTP status. Occurrences keep
their index even if they repeat an id. The synchronous mixing interface
`AudioService` is not adapted yet; that change belongs to the integration of the complete runtime.

`PlaybackService` hosts an ExoPlayer and a MediaLibrarySession. `PlaybackPlugin`
connects an app MediaController and only receives ids/metadata, never URLs or
cookies from JS. Commands are validated against the EngineConnection generation.
The origin/cookie live in a process connection: destroying the Activity closes
its socket/controller, not the playback connection. Logout/configuration
cancel the audio client and empty the program. There is no resumption after process
death in this slice; do not persist a private queue as if it had been approved.

The OkHttp DataSource shares the private HTTP/HTTPS policy of S1. Each source
includes an internal generation that is checked before sending the cookie, and is
removed before the HTTP request. It preserves Range; it does not follow redirects or use an audio cache.
401 stops the attempt and the UI revalidates identity to return to login; 403 is
shown as permission denied. Other failures keep the queue and allow retrying
with Play. There is no Web Audio fallback and no local download.

OS controls observe the same session. Only the application UID can
replace the queue; external clients must be trusted and do not receive commands
to inject sources. The service does not offer a browsing catalog yet:
**MediaLibrarySession does not mean Android Auto is implemented**. Title/artist
are native metadata; S2g adds private cover art to the session/notification.

The development surface enables local files in the shared Solid rows/virtualization
and offers basic transport/seek. Preview songs remain
visible and disabled. Development queue limited to 1,000 files; editing,
shuffle/repeat, large batched queue and complete routes remain pending.
Do not mark the whole NORMAL or the complete S2 as finished.

## Continuation after S2a

1. Integrate the asynchronous program contract with the authenticated Solid runtime,
   removing the temporary controls and keeping the queue actions/state.
2. Extend sources: previews, podcasts/resume/±15s and radio with real cases,
   origin protection, authorized persistence and provider errors.
3. Add native session artwork, acceptance of notification/lockscreen,
   noise/headphone disconnection and phone networks; foreground with the app removed
   from recents and an explicit process death/resumption policy.
4. Keep DJ/Live/Android Auto/offline as independent gates. Do not publish.

Primary references used for service/foreground/controllers and transport:
[background playback](https://developer.android.com/media/media3/session/background-playback),
[network stacks](https://developer.android.com/media/media3/exoplayer/network-stacks).

## S2b: native queue modes

The native bridge accepts `shuffle` with a required boolean `enabled` and `repeat`
with a required `mode` (0 off, 1 one song, 2 whole queue). It validates generation and
available command before mutating the controller. Snapshot/event add `shuffle`,
`repeat`, `hasNext` and `hasPrevious`; these come from Media3, they are not computed with
`index + 1`. Indexes still identify occurrences in the original order.

The modes survive recreation/background together with the service and are reset
when the account/origin changes or on logout. They are not persisted after process
death. This slice is the native contract: the buttons and the shared Solid typing
will be added with the authenticated runtime; do not claim that the UI already offers these
actions. The next slice is still to integrate that asynchronous runtime, without
adapting the synchronous mixing interface with fake successes.

Semantics of modes and indexes: [Media3 playlists](https://developer.android.com/media/media3/exoplayer/playlists).

## S2c: asynchronous runtime and Solid transport

`ui_web/src/lib/program/runtime.ts` defines the single-output program without
importing Solid, Capacitor, mixer stores or Web Audio. Contract with commands
as a typed union (queue/play/pause/seek/next/previous/stop/shuffle/repeat), native
snapshot and subscription. Android provides `nativeProgramTransport`; each snapshot
includes `sequence`, increasing during the lifetime of the plugin. That sequence is not a
clock and is not persisted: it prevents a delayed response from replacing a more
recent event of the same generation. The generation prevents crossing accounts.

The runtime listens before reading the initial snapshot, serializes the commands and
publishes pending only until their acceptance. It does not derive `playing` from Play or from the
resolution of the promise. A failure does not poison the next explicit attempt.
Unbind discards previous responses/errors and commands still waiting; it releases
even a subscription whose registration finishes later. It does not cancel the audio by itself:
logout/configuration still use the native EngineConnection cleanup; destroying
the UI only stops observing and does not destroy the service program.

`ProgramTransport.tsx` replaces the controls JSX embedded in AndroidStart and
does not import the global mixing store. It offers accessible shuffle and repeat, pending,
play/pause/seek and navigation according to the native `hasNext`/`hasPrevious`: repeat-all can
go back from the last occurrence. A dragged seek is not lost with the ticks,
and it is cleared when the occurrence changes even if the id repeats.

This step starts the shared integration, **it does not mount AuthenticatedPlayer yet nor
remove the temporary LibraryBrowser**. Before doing so, explicitly adapt the
NORMAL actions/routes and the queue state to the asynchronous contract: the synchronous mixing
AudioService is not compatible. The component is available for future
adapters; it is not claimed that the browser already uses this runtime. Pending sources,
artwork, DJ/Live/Auto/offline and physical acceptance keep their gates.

## S2d: NORMAL queue by occurrences

The snapshot adds `items` (key/id/title/artist/album) and `queueToken`, a
SHA-256 fingerprint of the order of the keys. Each entry receives a native UUID in
MediaMetadata.extras when the queue is created; repeating an id keeps independent entries.
The keys survive in the service across Activity recreation, are not persisted after
process death and are not accepted from JS when creating sources. URI/cookies are not exported.

Typed commands `select`/`move`/`remove` carry index/key/queueToken and generation;
move includes toIndex. They are sent as a custom MediaSession command available
only to the app UID. The service validates session/generation, the fingerprint of its real
queue, key and indexes before editing. A request with an old order is rejected,
even if the song id still exists. Asynchronous acceptance does not promise that
the new controller snapshot has arrived: the UI keeps observing events.

Selecting an occurrence jumps to its start and requires an explicit Play. Moving or
removing another row uses the Media3 operations, keeping position and
play/pause state of the current one. Removing the current one delegates the next element to Media3;
if there is no successor, it ends. Removing the last entry stops and empties the program.
The shuffle/repeat modes are kept with these edits and with an empty queue; logout or
account/origin switch still reset them. Semantics of modifications:
[Media3 playlists](https://developer.android.com/media/media3/exoplayer/playlists).

`ProgramQueue` shows the rows with `MusicListRowView`, active selection by
occurrence and separate editing controls. It virtualizes the panel without importing
stores/Web Audio; it measures real rows also in editing. Stable keys keep the
DOM between ticks and reorders; it restores focus when moving a node that is still present.
Action labels include the index to distinguish repeated titles.

It is still the Android development surface, not the complete NORMAL UI or
an Android Auto catalog. Limit of 1,000 files, no append/acquisition,
previews/podcasts/radio/artwork/handoff or resumption. No alpha or offline.

## S2e: adding from library and collections

Local LibraryBrowser rows open the shared menu (sheet on touch,
popover with mouse) with "Add after current" and "Add to queue".
Previews do not offer this menu; there is no new acquisition. The callbacks do not import
mixing stores and do not promise confirmation before observing the service.

`append` carries tracks/queueToken; `insertAfter` adds index/key of the current
occurrence at the time the menu opened. Both carry the generation and go through the custom command
restricted to the UID. The service checks its real order; for insertAfter it also checks
that the anchor is still the current one, even if an OS command changed the
song without changing the order. It rejects old actions without modifying anything.
A deferred selection from the sheet cannot be carried over to another account.

The native factory shared with `queue` only accepts ids/metadata: it does not use URI,
cookie or key from JS. Each insertion creates new UUIDs, also for repeated ids.
It validates the whole batch before adding, the total limit of 1,000 and the limits of
id/metadata. It does not rebuild existing entries. Media3 keeps the current
occurrence, position, play/pause and modes when adding during playback or pause.
An empty queue is explicitly prepared in pause, even if stop/clear had
kept playWhenReady. prepare/play is not called on a non-empty queue as an
implicit retry of an error. The program is not persisted after process death.

"After" means the next position of the visible queue. With shuffle active,
Media3 keeps the random order where possible; it is not promised that this new row
plays immediately afterwards. See [Media3 playlist/shuffle](https://developer.android.com/media/media3/exoplayer/playlists).

The verified HTTP/HTTPS integration checks real actions from the menu,
new/existing keys, insertion in the middle, pause/position/modes, append while
playing, Activity recreation, old anchor after OS navigation, old
generation/order and invalid/too large batches without partial modification. See
[handoff and final results](HANDOFF_HISTORY.md#s2e-delivery).

## S2f: explicit connection recovery

The snapshot distinguishes `playing` (native audio actually in progress),
`playWhenReady` (Play intention) and `errorKind`: connection/server/auth/permission/
source or empty. The classification follows the native cause chain: 401/403 have
their own semantics; 408/429/5xx are recoverable; HTTP read/connection errors
are connection. Certificates/handshake and source errors do not offer Retry.
TLS trust, private routing, origin and cookie are not changed.

The transport shows buffering and allows Pause even when there is no audio yet.
It shows the recoverable error with Retry, without deriving success from accepting a command.
The `retry` command captures generation, queue fingerprint and current key/index; the service
validates that data and that its real error is still recoverable. It only runs prepare
on the same player: it keeps sources, keys, index, position and the most
recent Play/pause intention. A pause stays paused after Retry; a Play
intention resumes only when Retry is requested. The command does not replace the queue or start a
new session. It does not offer automatic recovery when the network comes back.

The audio datasource disables the transparent OkHttp retry. The Media3
policy returns TIME_UNSET for the retry delay, in addition to a minimum of zero: only
changing the minimum does not by itself define all the retry behavior.
Reference: [load policy](https://developer.android.com/reference/androidx/media3/exoplayer/upstream/DefaultLoadErrorHandlingPolicy).
A connection read timeout still bounds a blocked read; no
global timeout is imposed that would cut long songs. prepare/error semantics and
intention: [player events](https://developer.android.com/media/media3/exoplayer/listening-to-player-events).

When the Activity is recreated with an unreachable server, the service program is shown
without needing another library response. No identity is invented and no
offline library is stored. Connection Retry revalidates the account with its native cookie;
network failures keep the program, 401 clears it even if the identity of this Activity
had not been resolved, and 403 keeps the permission state without treating it as
a network outage. Logout/switch still delete the session before another account.

The test uses a WAV response truncated after its headers (original
Content-Length) in the isolated fixture, not a JS error. For recreation it simulates an unavailable API
with 503 and permission denied with 403, and then restores the same verified HTTP/HTTPS server.
It verifies paused position, keys/modes, absence of automatic requests after a
failure, resume with Play intention, rejection of Retry on 403 and cleanup by a 401
stream even without a resolved identity. Local startup does not wait for that revalidation. Still untested:
real server shutdown, loss of phone coverage and acoustic acceptance.
It does not implement audio cache, persistence after process death or approved offline.


## S2g: private cover art for the program and session

`ProgramQueue.items` creates `artworkUri` from the validated id and the native generation:
`soundsible-artwork://<generation>/<id>`. JS still sends only ids/metadata;
it cannot supply origin, image URI or cookie to the program. The BitmapLoader
`ProgramArtwork` fetches `/api/static/cover/<id>?size=thumb` on the selected origin,
with the native cookie and the same private HTTPS/HTTP policy as EngineConnection.
It does not follow redirects, does not try a public image on errors and does not use disk.
The session uses `MediaLibrarySession.Builder.setBitmapLoader`; the standard
notification provider publishes that cover art. API checked against the Media3 JARs pinned
in the project and the [MediaSession documentation](https://developer.android.com/reference/androidx/media3/session/MediaSession.Builder#setBitmapLoader(androidx.media3.common.util.BitmapLoader)).

Two workers and up to 16 waiting jobs limit concurrency. Each request has
a global timeout of 8 seconds and a maximum body of 2 MiB, even without Content-Length.
Decoding inspects dimensions before allocating a bitmap: maximum 16 megapixels
of source and sampling down to 512 px per side. PNG/JPEG/WebP are supported. Only
the last future/bitmap is kept in memory to avoid duplicate downloads for notification and
session. Errors are discarded to allow another attempt when the same image is requested;
there is no automatic network retry and no invalidation when an already
loaded cover is edited while it is still the last requested URI (also between duplicates). That refresh is pending integration of the events
with the complete program.

Logout/server switch cancel futures and HTTP and discard the in-memory result.
Generation and origin are checked before reading and publishing; a late response from another
account does not complete the future. Destroying the Activity keeps the service/loader; destroying
the service releases them. 404 failures, invalid bytes and excessive size only affect the
image: they do not empty the program, do not generate an audio error and do not turn an image 401
into a logout. The audio/identity transport keeps its own revocation rules.

The Solid program and queue surfaces reuse `coverUrl`/`coverStyle` and the authenticated local
proxy of S1. The existing gradient stays underneath if the image fails.
The proxy now also limits the private body to 2 MiB and revalidates the generation during
the read and before delivering it; its responses are still `no-store`.
The decoding limits above apply to the native session loader,
not to the WebView decoder.

Instrumentation: real cover art from two accounts over HTTP and verified HTTPS, images
from other accounts without leaking the private color (placeholder or rejection), external URI/query rejected,
duplicates, 404/invalid bytes/excessive body, in-flight cancellation and a later account.
The program verifies the Android session metadata bitmap and the large icon of the
notification with the correct private color, in addition to the existing cases of
recreation, duplicates/editing, focus and recovery. The engine thumbnail encoder
is JPEG: the tests allow three points per channel, they do not require a pixel identical to the PNG.
This does not prove acoustic listening, physical lock screen, Bluetooth or Android Auto.


## S2h: explicit program close

The × button in the header has the localized accessible label “Cerrar reproductor”
and a minimum area of 44 × 44 px. It sends `stop` with captured generation and queueToken; it does not
clear UI state in advance. Only the app's own UID can send that custom command.
The service verifies generation and queue fingerprint, even without cookie/network available:
a late close of another program is rejected. It does not depend on REST and does not delete the account.

On the player looper: pause, stop, emptying of sources/occurrences, reset of
shuffle/repeat and intention, cancellation/cleanup of the cover art loader and of the
audio client, including eviction of idle connections of the retained client. In the
pinned Media3 version, stop keeps a previous error. If it is still present after
emptying, prepare on an empty timeline clears it and another stop leaves STATE_IDLE;
there is no audio source or network request in that preparation. This was verified in the
real ExoPlayerImpl JARs (`stopInternal`/`prepare`) and in the instrumented 503 case.

The service response confirms the mutation. The plugin also waits to observe
over IPC an empty queue, false intention, default modes, idle and null error before
resolving the snapshot (maximum 3 seconds, keeping generation/controller). A
snapshot without items uses index -1, empty metadata and zero position/duration. The runtime
serializes later actions; it does not present success based on an empty local
queue. The confirmation error stays visible if it is rejected/not observed.

The empty timeline makes the standard Media3 manager remove the notification and foreground;
an update is requested without cancelling a manual notification id.
The session/player stay available while there are bound controllers. A
session is not released underneath the Activity and resumption is not saved to disk. The
cover art loader discards its single result and cancels jobs, keeping
its executor for a later activation; destroy releases that executor.

Closing the program and removing the task from recents are different actions.
onTaskRemoved is not overridden: the pinned version keeps playback when there is
foreground and some session with isPlaying true; otherwise it calls
pauseAllPlayersAndStopSelf. Final destruction depends on the remaining bindings.
[Service contract](https://developer.android.com/reference/androidx/media3/session/MediaSessionService) and
[background playback](https://developer.android.com/media/media3/session/background-playback).
The test uses finishAndRemoveTask, a bound instrumentation MediaController and
reopening on API 36, keeping key/playing. It does not test a physical swipe, process
death, headphones/calls/Bluetooth or manufacturer policies.

Close cases over HTTP/verified HTTPS: Play, pause, buffering with delayed headers,
503 audio error and 503 API; Android session metadata/artwork and notification
removed; same cookie/generation; a recreated Activity does not rebuild the queue. An
obsolete queueToken is rejected. A later append has new keys and stays
paused with default modes; explicitly activating a row plays again.
A response from the delayed stream does not revive the program after closing.
The library is revalidated over the network when the API is restored: this is not offline persistence.


## S2i: previews guarded by the engine proxy

The `ProgramTrack` contract requires `source: local | preview`. JS only sends id,
title, artist and album. The same conversion controls rows, menus and mixed queues;
it excludes podcasts and previews without a valid eleven-character ASCII id. The preview id
is `Track.id`, even if a different `youtube_id` exists. Filtering out non-playable
entries keeps the selected index and the duplicates; each occurrence
receives a new UUID. Native rejects the whole batch before modifying the program
if a source/id/metadata is not valid.

Media3 builds `/api/static/stream/<id>` or `/api/preview/stream/<id>`. The
internal generation and occurrence markers are removed before the HTTP request.
EngineConnection keeps cookie, selected origin, private HTTP, verified
TLS and rejection of redirects. stream-url is not used and no external URL is received
from the bridge. Previews have a placeholder in program, queue and native
metadata; library thumbnails keep their secure transport.

The audio GET starts or shares the engine acquisition. There is no prefetch of
bytes and no speculative Android downloads. PreviewProgram belongs to the service,
queries the status of the current preview every second with a single request in flight
and publishes MediaSession extras associated with generation/UUID. The snapshot adds
`preview` (or null), with `key`, `preparation`, `retryAttempt`, `retryPending` and
`retryNotBeforeMs`. Preparation keeps the states/fields of the existing API;
a missing value is unknown. Polling ends on ready/unavailable/error/change/close; cold is only polled
while the player is still buffering. Its
network failure does not replace the audio error; 401 pauses and exposes an expired session.
`playing` is always ExoPlayer.isPlaying, never a queued/streamable response.

Only 429/503 previews have automatic retry: two retries at most,
started within the thirty seconds after the first failure. Retry-After accepts
seconds and an HTTP date; without a valid value the waits are two and four seconds.
A wait greater than the budget ends in a recoverable error keeping its
cooldown. The budget belongs to the explicit attempt/UUID/generation and is not
renewed by ranges or seeks. Manual Retry renews the budget only after the
cooldown; Play/Prepare and selecting the same failed occurrence cannot
skip it. Local files keep the S2f policy. Pause does not force Play when
bytes arrive or when a retry completes.

Changing/removing an occurrence, replacing the queue, closing the program, switching account or
destroying the service cancels its own interest, polling, load and wait. Moving the same
UUID keeps the attempt. Audio calls are tracked until callEnd or
callFailed, including open bodies that no longer appear in the OkHttp
dispatcher. Cancellation does not invoke a global cancel per video: closing the reader lets
the engine cancel only when no other reader/prefetch interest remains.
Recreating/destroying the Activity releases the controller, without ending the program.

The fixture extends the disposable engine with a localhost provider, AAC/MP4
with initial index, fragmented MP4 and WebM/Opus synthesized by ffmpeg. It only replaces resolution; routes,
cache, decode verification, prefix/rate and Range are the real ones. It never
resolves outside the fixture. The failure/progress controls stay isolated on
localhost. The Python test checks cache/ranges and that closing one reader does not
cut another; instrumentation checks the packaged HTTP/HTTPS path.
Live provider, phone, physical listening, Bluetooth/car/physical lockscreen and
resumption after process death still have no acceptance. The engine cache is not an
Android offline cache. See evidence and handoff before continuing.


In `X-Soundsible-Playback-Cache: progressive` responses, PreviewExtractors
builds the fragmented MP4 extractor without the initial MFRA read at the end of the
file. The default Media3 factory enables that flag even with zero flags;
this was checked in the bytecode of the pinned dependency. Reading the end of an incomplete
spool caused a real timeout in instrumentation. For complete files the normal
extractors and index are kept; MP4 with initial index keeps seek.
The snapshot includes native `seekable` and the UI disables seek when Media3 does not
offer it, even if the duration is known. No seek map is invented for fragments.


## S2j: search and explicit saving of songs

First discovery vertical: search local and catalog songs from
Discover, resolve a recording without audio identity and play it through the same
native program. Save/remove uses `/api/library/saved/set`, never the acquisition
`/api/catalog/save`. Confirmation only comes from the server; the library
revalidates saved and resolves its previews with the shared index. Remote
albums/artists, acquisition/import and complete discovery remain in the matrix.

`lib/catalogTrack.ts` extracts the pure conversion that the web client also uses;
it does not import stores/Web Audio. The native screen shares SearchField/MusicListRowView,
identities and Saved builders. Resolve keeps catalog/provider keys and adds
the exact video id. An acquired copy is preferred if the index recognizes it.
Playback from search explicitly switches to one song; it does not invent sources
for results not yet resolved and does not prepare the whole search unexpectedly.

Query debounce/cancellation, search and account epoch, most recent action and
AbortSignal prevent an old resolution from replacing the program. A menu
captures query/account/intention; it stops acting after a change or teardown. Sent
mutations stay in their account and refresh only a current surface. Offline
does not search or prepare previews: the S6a Available offline library is used.
Errors, empty results, Retry and partial providers use shared texts.

Fixtures replace external providers and downloader candidates, keeping
real routes, ranking/dedupe, matching/confidence/cache, permissions and Saved. Tests
cover out-of-order responses, resolution cancellation, bookmark confirmation
and removal without acquisition. The APK must prove search → save →
Library → native audio, isolation when alternating accounts and real HTTP/HTTPS. Do not
attribute live provider validation or physical listening to fixtures.
