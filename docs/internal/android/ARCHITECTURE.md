# Architecture and contracts of the Android port

## Source and scope

Base inspected to prepare the port:
`26be603c9712f5599507ca1fc7a43255040f1ce2`, 2026-10-02. Review the current symbols
before each slice: the commit is a historical reference, not a permanent pin.

Capacitor packages local Solid assets and provides the bridge to Android.
The configuration lives in `ui_web/capacitor.config.json` to resolve dependencies
from the client's single package/lockfile. The Gradle project is kept in
`android/`; `cap sync` generates its links to plugins. Do not introduce another frontend,
a copy of the screens or a second JavaScript lockfile.

## S0 foundation (historical reference)

- Entry `ui_web/src/mobile/main.tsx`: shared visual preferences, locale and startup;
  it does not import session, stores, socket, audio or Community.
- `AndroidStart` uses the client's logo, tokens and dictionaries. No forms
  that pretend to connect and no buttons for nonexistent features.
- `nativeBuildInfo()` requires Android and queries the native plugin `App.getInfo`.
  It exposes platform, applicationId, version and build; a failure does not invent success.
- `vite.android.config.ts` reuses the web HTML and startup plugin, changes the
  entry and relative base, and excludes publicDir/PWA. The output is isolated.
- `MainActivity` is a Kotlin `BridgeActivity`. There is no media service,
  downloads, account transport or camera/microphone permissions yet.
- Android requires TLS for network traffic in this delivery and declares `allowBackup=false`. The transfer and
  credential storage rules must be verified in S1. LAN HTTP needs an explicit implementation in the connection slice.

The metadata attributes on the mount element exist to test the
bridge. They do not carry credentials and do not constitute a new server protocol.

## Connection and authentication: differences that must not be hidden

| Current contract | Source and consequence for Android |
| --- | --- |
| `apiOrigin()` uses the page origin | `ui_web/src/lib/config.ts`; the package's local origin is not the remote engine. |
| REST carries `same-origin` cookies | `ui_web/src/lib/http.ts`; changing only the URL does not preserve the session. |
| User session, roles and namespaces | `ui_web/src/lib/session.ts`, `shared/api/routes/auth.py`; do not mount stores before knowing the account. |
| HttpOnly cookie, SameSite=Lax | Server login; CORS with credentials alone does not solve a local WebView. |
| Socket.IO opens against `apiOrigin()` | `ui_web/src/lib/socket.ts`, `shared/api/__init__.py`; authenticate it as the same account as REST. |
| Pairing and scopes | `shared/api/routes/pairing.py`, `shared/hardening.py`; do not assume that `library:read` enables the whole app. |
| iOS client browses the car contract | `ios/SoundsibleKit/`, `/api/car/*`; on its own it does not cover discovery, acquisition, editing and Live. |

The first slice keeps account login as the contract of the full client. The
native transport must keep the session and authenticated resources in the context of
the selected instance. Test cookie jar, Socket.IO and streaming as a single
path before generalizing the adapter. Pairing is complementary;
do not turn a limited token into owner/admin or disable authorization to
make the UI work. Never put passwords or tokens in query strings, logs,
metadata, plaintext web preferences or shared URLs.

Inventory the URLs of REST, Socket.IO, cover, preview, podcast stream and audio when
connecting: relative routes must resolve against the engine; external links do not
receive its credential. Preserve cancellation, timeouts, multipart, Range, ETags,
401/403 and account isolation. After changing server/account, cancel previous
jobs and clear caches, playback and socket before mounting the next one.

## S1 transport decision

`EngineConnection`/`EnginePlugin` implement REST and Socket.IO with OkHttp and the
Java [Socket.IO](https://github.com/socketio/socket.io-client-java) client.
The local plugin uses the [Capacitor bridge](https://capacitorjs.com/docs/internal/android/custom-code).
It does not change CORS, SameSite or the engine's authentication/scopes. It does not add bearer/owner.
`sb_session` is obtained from the HttpOnly `Set-Cookie` and is kept in memory and in
private preferences encrypted with AES-GCM with a non-exportable Keystore key;
`allowBackup=false` prevents exporting that session. The address is stored without a secret.
The bridge only returns status, body and ETag/Content-Type/Content-Range from REST;
it does not return Set-Cookie. Capacitor logging is disabled so login is not recorded.

`http.request` keeps its web fetch and allows installing a transport from the
native entry. `mobile/engine.ts` serializes JSON/multipart, propagates timeout/abort,
rebuilds status/ETags and discards responses from previous generations. Cancelling
before the executor registers the call is also recorded in Kotlin.
304 and 401/403 keep their meanings. There is no production API change.

Android **blocks cleartext by default**. The only OS exception is the reserved
alias `soundsible-private.invalid`; the transport internally rewrites HTTP
to that alias, keeps the original `Host` and resolves exclusively the private IPs
of the selected instance. The resolution is captured per client;
it cannot jump to another server when the selection changes. It includes RFC1918,
loopback, IPv6 ULA and Tailscale 100.64/10. Redirects are not accepted; for HTTPS there is no
alias or certificate exception. The WebView loads local assets, never a
remote page with the bridge; external images are read without cookies or account
headers (HTTPS, maximum 8 MiB and timeout). External HTTP does not receive the LAN exception.

Authenticated covers are resolved as
`https://localhost/__engine/<generation>/api/static/cover/<id>`. MainActivity
intercepts only that resource, verifies the generation, uses the same native cookie and
responds `no-store`. There is no image cache shared between accounts. The socket
uses the same client/cookie and only forwards event names with generation, without
personal payloads. Logout/switch destroy the socket, cancel calls, unmount
the library and clear metadata; any late callback checks its epoch.
The identity is revalidated before each refresh and when returning to the foreground.

The connected UI is a **development read-only** surface:
`mobile/LibraryBrowser`, the shared row `MusicListRowView`, virtualization,
covers and existing dictionaries. `musicLibraryRows` shares the selection and
recency ordering of files and saved songs with the web library;
the identity helpers avoid duplicating promoted songs. `MusicListRow` is still the
web account/playback adapter over that same view. `stores/index`, audio or
Community are not imported from Android. Song buttons announce `aria-disabled`;
collections do navigate. This does not represent action parity: when integrating
S2 the full UI must be connected to the native runtime, avoiding a permanent fork
of Library. Search here only filters the user's own library; it is not discovery.

The instrumented integration uses three real disposable instances; it covers HTTP and HTTPS,
roles, cookie/artwork/socket, encrypted persistence, revocation, generations and
passwordless. The HTTPS fixture uses a CA generated for that run and a correct IP
SAN; Android/OkHttp verify the chain and hostname with normal trust plus that
ephemeral CA in a generated debug override. The keys live in TemporaryDirectory,
the public CA/debug config are ignored in git and always deleted; at the end
the normal APK is recompiled without the test CA. Release never includes it.
Rejection of incorrect TLS and the happy path are tested on that real engine.
The specific public HTTPS instance and real DNS/Tailscale/network/device remain
as pending deployment acceptance; they are not what the fixture CA tests.


## Audio: one programme, one owner

Reference: `ui_web/src/lib/audio/contracts.ts`, `audio.ts`, `audio/transport.ts`,
`audio/graph.ts`, `audio/mixer.ts` and NORMAL/DJ stores. It is not enough to hook Play
to `ExoPlayer` while keeping the web mixer active in parallel.

The native media service will own playback and authoritative state,
even with the UI suspended. Solid shares intent, navigation and planning;
bridge commands and events will reconcile snapshots with generations so as not to
apply old confirmations after changing song, seek or pause.

The current `AudioService` interface contains synchronous operations, snapshots and
`MediaStream` capture: an asynchronous bridge cannot impersonate it by returning false
successes. Delimit/adapt those contracts with tests before replacing the runtime.
System events must go through the same state as the Solid controls.

[Media3](https://developer.android.com/media/media3/session/background-playback)
provides session, service, decoding and controls, but does not implement our
EQ, filters, echo, limiter or all DJ techniques. Before the DJ slice, test
a real mix of two authenticated sources and its PCM capture. Record the
chosen solution and its cost; do not promise that two ExoPlayers are equivalent to the graph.
Preserve routes by `queueId`, bounded recovery and outgoing audio during
preparation failures. The transition scheduler cannot depend on JavaScript
timers when the WebView is suspended.

## Live and car

`ui_web/src/lib/community.ts`, `audio/capture.ts` and `docs/LIVE.md` define that
Live takes the programme **after mixing/effects/limiter and before local volume and
mute**. The native programme needs that same capture point and a
tested path to the relay/WebRTC. Listening to another room must not rebroadcast it.
The "On air" UI is not proof of received audio: validate with a separate listener.
Declare and test the foreground/background conditions, without attributing to the web
a broadcast continuity that it does not guarantee today.

Android Auto requires `MediaLibraryService`/`MediaSession`, safe navigation of the
`/api/car/*` tree and controls consistent with the queue. Do not render the free DJ
workspace in the car. The existence of the service or an AAOS emulator does not prove Android
Auto: [DHU](https://developer.android.com/training/cars/testing/dhu) still requires
a phone compatible with Android Auto. Record that physical gate separately.
An AAOS application installed in the car is another package/delivery, outside the initial
mobile port; do not confuse AAOS with Android Auto.

## Shared maintenance

A relevant Solid change triggers an Android build from the same sources. The
specific adapters receive contract tests; avoid platform conditionals
scattered across screens. Update core/CLI/Android together,
check plugin compatibility, pin dependencies and keep the Gradle Wrapper
verified. The commercial version comes exclusively from `shared/version.py`
via `scripts/version_sync.py --print`; do not copy a version into Gradle.


## Native programme S2a

`EngineConnection.shared` shares the origin/cookie/generation in the process.
The Activity releases its socket and MediaController, keeping the audio service.
`PlaybackService` contains ExoPlayer/MediaLibrarySession and one OkHttp client per
epoch; the reset listeners cancel that client and empty the programme.
Sources have an internal generation in their URI, removed before HTTP;
an old source cannot adopt the new cookie even if the origin is reused.
Range follows the Media3 DataSpec. There is no audio cache and no authenticated redirects.

`PlaybackPlugin` builds native ids/metadata/URLs, validates commands against the
generation and exposes snapshots; resolving a command does not claim audible audio. JS does not
receive the cookie or an authenticated URL. The playing state comes from ExoPlayer and metadata
comes from MediaSession. A state callback from another generation is ignored.
External controllers must be trusted; only the app's own UID replaces the queue.

The Activity observes; it does not contain the player or stop it when Solid unmounts.
When moving to background the JS ticker is paused; focus/noisy/foreground/notification
belong to Android. Logout and switching do stop the programme. HTTP 401 is exposed
as a status to revalidate identity; other failures do not claim playback and
allow an explicit retry. Source/id/position are bound to the current account.
There is no programme persistence after process death and no Auto navigation implemented.
See [contract/continuation](SLICE_2.md) and [S2a evidence](evidence/s2a.json).

### Asynchronous contract implemented in S2c

`ui_web/src/lib/program/runtime.ts` separates typed commands and snapshots of an
output from the synchronous mixing contracts. `mobile/playback.ts` provides the
Capacitor adapter and `components/ProgramTransport.tsx` observes the state to
render transport/seek/modes. AndroidStart already uses this path. Ordering of
snapshots by generation and sequence, serialized commands, callback cleanup
and acceptance pending states are tested without instantiating audio in JS.

It does not yet replace the NORMAL stores/actions or mount AuthenticatedPlayer; those
routes must be adapted to the contract before removing LibraryBrowser. Do not interpret
the availability of a component in `components/` as migration of the browser:
the web UI keeps its current runtime. See [S2c](SLICE_2.md#s2c-asynchronous-runtime-and-solid-transport).

### Queue by occurrences in S2d

ProgramQueue observes native entries with a UUID per occurrence. The bridge sends
select/move/remove with generation, index, key and order fingerprint; PlaybackService
validates its real queue when it receives the custom command, before editing it. It only grants
that command to the app's UID; it does not receive URI/cookie from JS. The Solid and OS controls
keep observing a single player. Virtualization with a stable key and real measurement
of each row avoids rebuilding the DOM on ticks or overlapping controls while editing.
The seek follows the current key, kept when it is moved and cleared when it is replaced
by another entry with the same id and index.

### Insertions from the library in S2e

The same custom command adds append/insertAfter. Sources and UUIDs are created in
the service from metadata; the total limit and the batch are validated before mutating.
insertAfter stores and validates the current occurrence in addition to the order, to reject a
menu opened before an OS transition. Deferred selection does not cross accounts.
There is no programme rebuild and no autoplay when filling an empty queue.
The menu and its outlets reuse the shared presentation without mixing stores.
[Contract and shuffle semantics](SLICE_2.md#s2e-adding-from-library-and-collections).

### Explicit programme recovery in S2f

playing and the playWhenReady intent are distinct player states. The error is
classified natively; retry uses the custom command restricted to the UID and guards of
epoch/order/occurrence, also validating the service's current error. prepare
keeps the programme and respects the current intent without rebuilding sources.
Audio does not retry in the background or resume on a generic network signal.
The UI can observe the service during an identity revalidation failure without
inventing an authenticated account. A 401 also clears that state; a 403 is not
turned into logout. [S2f contract](SLICE_2.md#s2f-explicit-connection-recovery).


### Programme artwork (S2g)

Native metadata carries an internal URI created from id/generation, never a URL
supplied by JS. `ProgramArtwork`, installed as the session's BitmapLoader, downloads
the authenticated thumbnail through EngineConnection and delivers the bitmap to the standard
Android notification/metadata provider. Concurrency, bytes, dimensions and time
are limited; the only retained result is the last one of the active generation,
without a disk cache. Reset cancels both the future and the Call before the next account.
Image errors are not propagated to the player and do not erase login.
The programme/queue UI uses the existing private local proxy and the shared gradient;
the proxy now limits bytes and revalidates the generation before publishing. See
[S2g contract and limits](SLICE_2.md#s2g-private-cover-art-for-the-program-and-session).


### Programme closure (S2h)

`stop` goes through the service's custom command, with a UID/generation guard and
programToken; it works without REST/cookie. The programme receives a UUID identity when
replacing the queue or inserting into an empty one; append/insertion/refill/metadata
editing and navigation keep it in the extras of each occurrence. The order
has its separate queueToken. This way a refill does not veto closure, but a command
captured before opening another programme does not close it. For callers without
programToken the old queueToken validation is kept; never infer the
current programme for a stale command. Row edits keep token/key.
Closure and Autoplay HTTP/HTTPS test both identities and an old generation.
The first correction based only on generation passed Autoplay but failed Closure;
it is replaced by this stable identity and does not represent the final contract. The
service empties sources, intent/modes/error and audio/artwork resources. The plugin
waits for the closed state received over IPC before resolving. It does not change identity;
a new queue does not inherit intent/modes or keys. Media3 removes the notification
because of the empty timeline, keeping the player/session while controllers exist.
[S2h contract](SLICE_2.md#s2h-explicit-program-close).

### Explicit phone copies (S6a)

OfflineStore belongs to the application, not to the Activity. SQLite and private
files store only complete copies of acquired music and limited metadata,
bound to the origin and account that the native transport confirmed. OfflineService
executes explicit preparation in foreground; generation/tickets cancel obsolete
results. OfflineDataSource delivers the verified file to the same Media3 and
preserves Range/seek. There is no second engine and no file URI/cookie in JavaScript.
The local library is derived from those copies; logout/switch/observed 401 delete
profile and jobs. See [S6a contract, limits and acceptance](SLICE_6.md).


### Native import S2y

MigrateView shares jobs/guide/controls with the web without audio stores; the Android
adapter uses ACTION_OPEN_DOCUMENT and a normal POST /api/migration/jobs. An
opaque single-use token is transported, never a content URI or bytes/base64. ImportFiles binds the
grant to generation, profile and session fingerprint, with TTL and a cancellable lease;
ImportStreamBody limits to 100MiB and chunks of 64KiB. Metadata query off the UI thread,
bounded workers/queue and CancellationSignal/deadline 120s; upload 120s. The parser
validates format/bytes after choosing a document with MIME application/* or text/*.
Abortable and irrevocable view scope, coalesced polling and review of mutations
protect account/progress. The address for continuing on a computer is the real
origin of the engine, never the package's localhost. See SLICE_2Y and HANDOFF for local evidence
and limits: do not claim real/cloud exports or full parity via CSV.

### Confirmed removal and local recovery (S2aa)

DELETE + private snapshot without the file precede `retireSource` and offline removal.
The global per-source command requires UID/generation; it does not use an ephemeral queue
order. Reverse local ranges preserve keys/programme identity and previews.
Radio/autoplay cancel the pending plan and exclude removed local IDs. The
bridge resolves only after observing absence; an empty result requires closing the programme.

Offline invalidates the ticket and marks a recoverable error before the filesystem. Failures
keep the row/retained bytes for quota and show a failed removal, with
recovery from the manager. A copy whose file was removed from another client
is not purged automatically: local metadata of the same profile allows cleanup
confirmed by GET even if DELETE returns 404. See SLICE_2AA for evidence
and limits; S2ab accepts a deliberately delayed real response in Radio and autoplay HTTP/HTTPS.


### Shared account and history (S2ac)

AccountSettingsView receives user/actions without an audio runtime; Android confirms
receipt and no-store auth/state within the same identity and abortable scope.
Password changes keep the cookie in the native transport/Keystore. The UI does not publish
cookies. Logout respects the bootstrap busy state and confirms before closing.

SearchHistoryStorage shares semantics with the web and injects the Android namespace by
origin/account. Only current responses remember queries; disabling deletes
both domains of the profile, without affecting other accounts. Recent entries can be executed
and removed. See SLICE_2AC for HTTP/HTTPS acceptance and limits.


### Shared appearance and visual preferences (S2ad)

AppearanceSettingsView and DisplayPreferencesView receive values/actions, without
importing audio stores. Web adapters keep the existing controllers;
Android uses createNativeAppearance with the boot theme table and shared visual
persistence. Theme/size/contrast belong to the installation, not to the
engine profile. Language uses the shared dictionaries.

The integrated SystemBars keeps the icon style when the OS configuration changes.
SoundsibleAppearance only accepts hex colours from the palette for the decor/WebView background
and legacy bars; it does not transport credentials or playback state. Reapplying
on a media query change and on foreground keeps even an explicit palette
when Capacitor restores its window. NativeSettings offers Account/Appearance/
Accessibility; Back first consumes the internal section. Configurable haptics/navigation
and the remaining settings are not part of this acceptance.
