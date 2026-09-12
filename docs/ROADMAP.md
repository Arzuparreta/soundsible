# Roadmap

Soundsible is a self-hosted music service for discovering, listening to,
keeping, organising, mixing and sharing music through its own connected
clients. The server holds your library and listening profile; the clients
bring that experience to your devices.

> **discover → listen → keep and organise → mix with DJ → share**

OpenSubsonic gives you another way to use your library. Compatibility with
other apps complements Soundsible's own experience; it does not fulfil our
commitments to offline listening, cars or watches on its own.

## Available foundations

- Unified library and external search, acquisition and tagging, folder import,
  and album, artist, genre and year browsing. SQLite is the canonical library;
  JSON is an export. Catalog metadata and artist/title resolution support the
  whole product.
- NORMAL playback and the editable two-deck [DJ workflow](AUTO_MODE.md),
  currently in beta, with local recommendations, Autoplay and Radio.
- Web/PWA and desktop beta. [Native iOS code](IOS.md) includes offline download
  and storage management, but nobody has installed or run the app on a device.
  Its behaviour remains theoretical; producing an IPA does not validate it.
- [Live](LIVE.md) broadcasts the program to a browser listening room.
- [OpenSubsonic](OPENSUBSONIC.md) exposes the music library to compatible clients,
  including library search, playlists and streaming with transcoding.

These are implemented capabilities, not a claim that every device combination
has been validated. Client guides describe their specific limits; physical
phone, car and watch behaviour needs evidence on those devices.

## Priorities and direction

The immediate priority is dependable everyday use on existing surfaces, followed
by acquisition resilience and DJ refinement. New device coverage is a long-term
commitment. Work can proceed independently where dependencies allow; these
sections are not a sequence in which every item blocks the next. There are no
promised delivery dates.

### 1. Reliable everyday listening

Make playback, seeking, pause/resume, library navigation and search dependable
across the existing web/PWA, desktop and iOS surfaces. Keep playback state and
controls understandable through interruptions, background use and reconnection.

Acceptance requires reproducible checks for those journeys on each affected
surface. Browser automation alone does not establish locked-phone or car
reliability. Resolve failures in existing listening journeys before expanding
device coverage.

### 2. Discover and keep music

Make the path from a search result to a correctly identified, playable library
track resilient to provider failures, with clear progress and recoverable errors.
A durable library serves listening, discovery and DJ as well as external clients.

Next work:

- Read existing ReplayGain / R128 file tags alongside engine loudness analysis.
- Keep yt-dlp current in containers and add a scheduled extraction canary that
  reports upstream breakage.
- Extend acquisition source selection so YouTube is replaceable. Existing
  search provider modules and the lossless provider layer are useful foundations;
  they do not yet make the main acquisition journey independent of YouTube.

Later improvements include smart playlists over listening history, ratings,
year, genre and BPM, plus richer artist biographies and images.

### 3. An integrated DJ

Refine musical direction, requests, route editing and transitions as part of
normal Soundsible use. Leaving beta requires evidence that requested tracks
survive direction changes, route edits produce predictable playback, exhausted
candidate pools recover, and preparation failures preserve the audible session
and offer recovery. Evaluate transition quality through listening as well as
automated checks, including conservative handoffs when analysis is unavailable.

The [DJ guide](AUTO_MODE.md) describes what is available today. These acceptance
conditions do not imply that the existing workflow is missing or already proven
ready to leave beta.

### 4. Soundsible on your devices

Consolidate web/PWA and desktop, and install and validate iOS for the first time,
before expanding coverage. Our long-term direction includes our
own Android client, car interfaces and watch experience, with interactions suited
to each device. A watch need not reproduce the desktop DJ workspace.

Extend offline listening across our own clients: download music from your
Soundsible server, listen while disconnected, then synchronise on reconnection.
The server remains part of the product even when a client is temporarily offline.
Treat the existing iOS code as unvalidated and check downloads, storage limits,
disconnected playback and reconnection on each supported client.

[Car integration](CAR_INTEGRATION.md) distinguishes existing media controls from
future library browsing on car displays. Platform permissions, distribution and
physical-device validation remain delivery dependencies. The iOS AltStore PAL
path is still **not verified**; see [iOS distribution](IOS.md).

### 5. Share the listening experience

Live already broadcasts the actual program, including DJ transitions. Next,
make participation explicitly opt-in and make relay choice clear. It is currently
on by default; [Live](LIVE.md) documents that behaviour and links to the existing
self-hosted relay instructions.

Federated Live relays remain exploratory, with no delivery commitment.

### 6. Interoperability and portability

Maintain OpenSubsonic as another way to browse and play the same library,
without requiring it for the complete Soundsible journey. Its standard library
surface does not expose Soundsible's external search, acquisition or DJ session.

Planned additions:

- External scrobbling to ListenBrainz, Last.fm and Maloja. The existing Subsonic
  `scrobble` endpoint records local plays; it is not external scrobbling.
- ListenBrainz recommendations alongside local signals.
- M3U and OPML import / export, alongside the existing
  [music migration](MUSIC_MIGRATION.md) workflow.

Offline, car or watch features in third-party apps depend on those apps and
need client-specific validation. They are useful options, not substitutes for
Soundsible's own device roadmap.

## Product boundaries

- **Server-based service.** A standalone client that needs no Soundsible server
  is outside scope. The server may run on the same machine as the player.
- **Self-hosted.** A hosted Soundsible subscription service is not planned.
- **Music and existing podcast support.** Video is outside scope.
- **Metadata-led organisation.** Folder-tree browsing is not planned.
- **Acquisition for listening and the library.** A general-purpose downloader
  is outside scope.

## Shipped

See the [releases](https://github.com/Arzuparreta/soundsible/releases) and commit
history for delivered changes. Future commitments above are not release claims.

## Internals

Working notes, not commitments. They go stale and are not maintained for
readers: [Layer Contracts](LAYER_CONTRACTS.md) ·
[Premium Quality Contract](PREMIUM_QUALITY_CONTRACT.md) ·
[Appliance Rework Plan](appliance-rework-plan.md) ·
[UI Rebuild Plan](UI_REBUILD_PLAN.md).
