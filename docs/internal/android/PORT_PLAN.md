# Slices and parity matrix

## Progress rule

Each slice ends with implementation, relevant tests, evidence, an update
of the handoff and a focused commit. Completing a slice does not mean a release.
The functional inventory of 2026-10-06 is implemented: phone, NORMAL,
DJ, Live, Android Auto, account/settings and offline B. The test closure and the PR
are recorded in [HANDOFF](HANDOFF.md) and [EVIDENCE](EVIDENCE.md). The following
matrix keeps the historical references per capability; the functional
pending items of those cuts were completed in the later blocks of EVIDENCE.
It is not equivalent to a release: signing/update/App Links are gates of
[RELEASE_GATES](RELEASE_GATES.md), and phone/Bluetooth/DHU/car require
physical acceptance for beta. Public providers are not validated with fixtures.
A checkbox only changes with evidence; interfaces and workflows do not count as
validated behavior. Keep capabilities added to Solid visible while
the port is developed so that parity is not frozen on an old inventory.

## Order and dependencies

| Slice | Work | Dependency and verifiable output |
| --- | --- | --- |
| S0 | Documentation, Solid entry, Capacitor, Kotlin project, build/CI | Local APK started and native bridge verified; no connection or audio. |
| S1 | Server, session, library and events | [Connection specification](SLICE_1.md); same account in REST, images and socket. |
| S2 | NORMAL playback, podcasts, radio, previews, queue | S1; Media3 service, authenticated/Range streaming, controls and reconnection. |
| S3 | DJ and program execution | S2 + test of native mixing/effects/capture; Solid planning and robust execution in background. |
| S4 | Live receiver and broadcaster | S3 + real program capture; independent listener hears the correct broadcast. |
| S5 | Android Auto | S2/S3; library service, consistent state/control and DHU/device evidence. |
| S6 | Offline and distribution | Offline decision resolved; implementation if approved, signing and update verified. |

Offline B is approved (2026-10-03): explicit copies of acquired music,
"Available offline" inside menus. Its implementation and acceptance are
brought forward in cut S6a; they do not replace the remaining parity or enable alpha.
The user authorizes continuing autonomously until full parity and pushing progress.
PR #300 was reviewed and merged on 2026-10-07. The user later authorized
preparing the signing/channel and completing merge/release when the gates of
RELEASE_GATES are closed. Physical acceptance remains a beta requirement.

## Capability inventory and acceptance

| Required capability | Current reference | Android acceptance | Android status |
| --- | --- | --- | --- |
| Startup/UI/accessibility/locales/themes | `ui_web/src/boot`, `lib/i18n.tsx`, `styles/`, `tests/browser` | APK without network loads assets, logo, fonts and locale; size, safe areas, keyboard and Back reviewed | S0; S2z native Back in details/modals/tabs and root minimized without losing program/session; evidence in HANDOFF |
| Account/configuration/permissions | `lib/session.ts`, `routes/Settings.tsx`, `/api/auth/*` | Account persisted and roles respected; logout/switch without leak; settings available according to permissions | Login/logout/roles and persistence S1; S2ac shared Account, edit/confirmed password, logout and history per origin/account HTTP/HTTPS accepted; S2ad shared Appearance/language/size/contrast HTTP/HTTPS accepted, shared regression in progress; S2ak: shared admin People, creation/invite/disabled and member denial HTTP/TLS accepted; S2au admin Library/Downloads/Community/About and device name/paired devices with shared views HTTP/TLS accepted; S2av sign-in by QR/pairing code (full, revocable session) HTTP/TLS accepted; remote acceptance pending |
| Library, entities, favorites, playlists, metadata | `routes/Library.tsx`, `components/MusicListRow.tsx`, stores, `trackActions.tsx` | Same actions and saved states; recoverable updates and errors | Reading/collections/covers/events S1; S2n explicit favorites/filter and create/add playlist confirmed; S2o rename/duplicate/delete/order/cover and membership per occurrence conditioned; S2r editor/IPC and S2s editing without rehash with text/sidecar/offline copy validated; S2t album/artist bookmarks of acquired items confirmed; entity/song actions and order/filters completed in later blocks |
| Search/discovery/acquisition/import | `routes/Search.tsx`, `lib/catalogItem.ts`, `routes/Migrate.tsx`, downloads | Flow discover → save/acquire → play; failed providers and progress; native file picker | S2j: song search, resolution, save/removal and native playback; S2x real acquisition with progress/retry/cancel and identity promotion validated; S2y OS picker/stream and shared jobs with CSV/restore/playlist HTTP/HTTPS validated; collections and verified download with version selector completed in later blocks |
| NORMAL and queue | `lib/audio/contracts.ts`, stores | Order/occurrences, transport and row actions; seek/switch/end; failures without double audio | S2i: mixed local/preview queue and bounded 429/503 retry; explicit close without losing the account, private artwork for program/queue/session/notification, explicit connection recovery, files, queue by occurrences, editing and insertion from library, seek/end/focus/service, asynchronous contract and Solid controls with shuffle/repeat; context/requests lanes, clearing requests and resuming from another device completed in later blocks |
| Podcasts/radio/previews | `types/podcast.ts`, stores, `lib/api.ts` | Real streaming and files, resume and ±15s, correct range and temporary preparation | S2i: saved previews through proxy, full/progressive cache and Range with fixture; S2k: episodes through proxy, acquired files, resume/±15s and native progress; S2l: directory/following and real acquisition with retry/cancel; S2m: NORMAL Radio in service, seed/pause/position and manual priority, retry in background; S2p profiles and refill in background validated; S2q first native autoplay vertical, preferences/threshold/repeat/refill; Radio/autoplay, recommendations and downloaded filter completed in later blocks; live provider outside the fixture |
| DJ | `components/AutoMode.tsx`, `stores/dj.ts`, `audio/mixer.ts`, `docs/AUTO_MODE.md` | Sessions/contexts, direction, editing, requests, techniques/FX, dominant metadata, fallback and recovery | S3b runs Core → two decoders → one AudioTrack; seven techniques/FX, dominant metadata, From current and opening from sources, profiles/direction, editing, refill and effective replan, mix toggle confirmed, controls/focus/noisy on AVD and return to NORMAL validated. Recovery before mixing accepted. Musical/fixed requests, repair, contextual/source change keeping the current one and requests, route menus and bridge ownership validated; recovery of an input without PCM and of a pending body accepted. Both PCM inputs stopped and return of a healthy one, and queue1000/trim/append/resume through service+MediaController validated HTTP/TLS. DjNetworkTest covers persistent 503 on both streams; group requests and session switch implemented. Final regression in EVIDENCE; physical acceptance pending |
| Lyrics/sharing/multi-device | `components/LyricsPanel.tsx`, `lib/share.ts`, `stores/runtime.ts` | Timed lyrics, sharing and invites/deep links; registration, handoff and controls on the correct account | S2w acquired/preview shared lyrics with native seek validated; S2ah sharing a song through the native chooser, common capsule or text, validated HTTP/TLS with intercepted Intent; S2ai public VIEW/SEND reception cold/warm and recreate HTTP/TLS validated; S2aj: registration by invite pasted in connection, cookie/profile/isolated library/recreate/reuse rejected HTTP/TLS accepted; S2at invite shared as text (SEND) without changing origin/account until explicit action, with signed-in session warning and sign-out only when using it, HTTP/TLS accepted; public bridge/App Links (VIEW of https links): release gate; S2al registration/remote controls without Activity and incoming NORMAL handoff HTTP/TLS accepted; S2am device list/controls from Settings and socket_active contract accepted; S2an outgoing NORMAL and S2ao DJ workspace incoming/outgoing, controls and rejection of invalid profile HTTP/TLS accepted; S2ap Radio/Autoplay ownership incoming/outgoing and Stop with manual kept HTTP/TLS accepted; S2aq long reconnection, S2ar/S2as deferred catalog and S2at pending occurrence menu with removal only accepted |
| Live listening | `lib/community.ts` | Room, controls, chat/directory, reconnection and room end; do not recapture received audio | S4b–S4e: real WHEP TLS, PCM/MediaSession, controls/guest metadata/chat, directory and UI HTTP/TLS accepted; end/stop-prepare/return to NORMAL and no recapture. S4f: public artwork validated in MediaSession; S4g: real listener cut recovers keeping pause/volume; S4h: authorization before WHEP, rejection without PCM, lease loss and polling35s accepted; S4i: process restart with encrypted cookie, same room/seq/PCM accepted; S4j: real exhaustion, manual recovery, reset during TLS, system focus/noisy accepted HTTP/TLS; S4l: decks/mix/pause/visible thumbnail and public share through chooser accepted; final regression in EVIDENCE; physical acceptance pending |
| Live broadcasting | `audio/capture.ts`, `docs/LIVE.md` | Full program to the relay; independent local volume; pauses/silence; listener hears and reconnects | S4a–S4e: NORMAL program Core HTTP/TLS → PCM JNI without microphone → WHIP TLS/MediaMTX → WHEP/PCM; local mute/silence/resume, host service/heartbeat without Activity, title/chat/end and real UI. S4f: real DJ to the relay with transition metadata and public NORMAL artwork validated HTTP/TLS; S4g: real publisher cut recovers same room/PCM and cancellable TLS handshake; S4h: authorization before WHIP and real lease loss in background accepted; S4i: resume409 removes real publisher, keeps room/seq and protects late cleanup; restart accepted; S4k: publisher exhaustion in background keeps music/KEY, explicit recovery same room and reset during retry accepted HTTP/TLS; S4l: decks/mix/pause/visible thumbnail and public share through chooser accepted; final regression in EVIDENCE; physical acceptance pending |
| Native audio/lockscreen/Bluetooth | PlaybackService Media3 | State/position/metadata, focus and pause policies on emulator; calls/Bluetooth and physical evidence for beta | Service/metadata/artwork/notification/focus tested on emulator; phone, calls/Bluetooth and physical lockscreen pending |
| Android Auto | `/api/car/*`, `docs/CAR_INTEGRATION.md` | Browse/play/control, errors/network and metadata during DJ in the media contract; DHU and car for beta | S5a: authenticated tree, canonical selection, music/podcasts/Radio, search/playFromSearch, artwork by opaque URI, offline503 and401, modern/classic protocols HTTP/TLS validated in block12/0 + normal APK/test/JVM54/lint. S5b: tree events in background with Activity closed, KEY/PCM and unsubscribe accepted8/0 + normal. S5c: root/search/play of copies with expired cookie and APIs503 accepted8/0 + normal. S5d: cache/completed copy/removal signals update Auto with Activity closed or expired cookie,8/0 + extension2/0 + normal. S5e: modern/classic browsers keep DJ on browse/pause/seek/resume and reflect the dominant song,2/0 HTTP/TLS + normal. S5f: closed transport/retry503 and reconnection recover labels with Activity closed keeping NORMAL KEY/PCM,2/0 + normal. S5g: other UID without trust rejected; authorized listener reads opaque artwork, write denied,6/0 HTTP/TLS + normal. S5h: other UID playFromMediaId produces PCM/canonical ID and logout prevents reopening the granted URI,2/0 HTTP/TLS + normal. Active program labels and retry exhaustion fixed/validated in CarDjTest/CarEventsTest; physical host/DHU for beta |
| Offline | [Approved decision](OFFLINE_DECISION.md) | Full copies, flights/space/account/UI validated | S6a implemented/validated on emulator; evidence in HANDOFF. Alpha additionally requires full parity |
| Updates/distribution | [Release gates](RELEASE_GATES.md) | Permanent key, consistent version/code, update keeps data and session | Pending |

The references are entry points, not an exhaustive list of endpoints.
Before implementing each row, inventory the current screens/actions and
their tests. Do not mark parity if the screen exists but its action is disabled.

## Evidence per capability

Record date, commit/build-info (including `dirty`), command/case, result,
artifact/log and environment (browser, emulator, phone, car, provider/relay).
Separate logic, packaging, integration and listening. Do not reuse the
WebKit green as Android evidence or the Android green as acoustic acceptance.
Repeat only the affected layers when changing a contract and keep the full
gates required by AGENTS for shared changes.

S2aa adds confirmed removal of acquired items and local references/copies; a copy
deleted by another client remains removable. Four HTTP/HTTPS cases and recoverable
filesystem manager validated. See [evidence](evidence/s2aa.json). S2ab accepts the deliberately
delayed planner in Radio/autoplay HTTP/HTTPS; clean main53+restart2
accepted. Historical record of S2ab; the later closure is in EVIDENCE. It is not equivalent to a release.
