# S5a: Android Auto, library and program selection

Validated on AVD API36: **12/0 HTTP/TLS,94.079s**, runner exit0. Combined block
CarLibrary2 + CarLegacy2 + CatalogSearch2 + TransportReset2 + Connection4.
APK/test APK/JVM54/lint without temporary CA pass; Core car/playback11/0.
[evidence](evidence/s5a.json) records provenance and limits. Development, not release.

MediaLibraryService serves `/api/car/home`, `/api/car/items` and authenticated search
over acquired music/podcasts. Search results are filtered before the
limit200. The published feed folders resolve only acquired episodes
of the profile; an unknown feed returns404. Radio excludes episodes before the limit.
Modern search and classic `playFromSearch` are tested; there is no tested voice
recognition or implicit search/acquisition in external providers.

Selection by published ID for the active generation/identity; the caller's title/URI/extras
do not create sources. ProgramQueue builds native music/podcast. External
controllers require trusted and do not receive arbitrary append or a private queue
command. Auto media descriptor and MEDIA_PLAY_FROM_SEARCH entry packaged; no
Android Automotive OS or Car App Library templates.

Classic browse without pages uses the sentinel Int.MAX_VALUE: response limited to1000,
the offline maximum. Normal pages1..200, registry1000 IDs and counts500 parents;
worker queues16 and bodies256KiB. Offline hash/integrity outside the audio looper.
The initial subscription notifies the total of children; proactive update pending.
Requests/futures finish on reset/close. Server identity/cookies/URLs are not
published in IPC metadata.

Explicit complete copies in "Available offline". APIs503 allow the local
tree and real playback. An observed401 clears copies/program/grants;403 returns
permission denied without changing account. Expired cookie without401 and offline covers
after process death are not accepted yet.

CarArtworkProvider not exported: opaque URI with read grant to the browser. Private native
loader, registry400/cache32 PNG of up to2MiB. It revokes registrations and clears the cache when
the account changes/closes. It does not revoke bytes or FDs that the client already received. The
read/color/cache and revocation tests are sameUID; grants to an external UID are pending.

Diagnoses fixed: legacy limit/pagination, JPEG rounding in the test,
JSON null GUID interpreted as text when selecting Radio, missing feed
browse, a test that queued offline without starting OfflineService and the lint requirement for
play-from-search. Obsolete async transport returned an unchecked exception that could
kill OkHttp: now IOException through callback with a generation/origin guard,
tested on HTTP/TLS and same server. Independent fix f2a10c32.

Official sources: [Android Auto media](https://developer.android.com/training/cars/media/auto),
[MediaLibraryService](https://developer.android.com/media/media3/session/serve-content).
The legacy/sentinel compatibility was also verified in the Media3 bytecode
included by Gradle; real protocols run with MediaBrowser/MediaController.
Do not claim that sameUID is Google Auto or that AVD proves listening/physical car.

S5b pending: proactive/background changes, reconnection, controls/metadata during
DJ, generation guard in initial browse, expired cookie/offline and external UID
client. Host/DHU and full physical acceptance belong to beta.
