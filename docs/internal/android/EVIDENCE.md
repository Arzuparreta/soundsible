# Android port evidence

One row per block validated since 2026-10-06. Earlier work: `evidence/*.json` and
`SLICE_*.md` (S0–S2av). The `/tmp` logs do not survive a reboot; the row and the
commit are the reference. "Normal" = normal APK + test APK + JVM + runner lint.

| Date | Block | Commit | Native | Other | Log |
| --- | --- | --- | --- | --- | --- |
| 2026-11-12 | Settings → Scrobbling (parity with the web) | This PR | No native run: the tab does not cross the native boundary. It renders the shared `ScrobblingView` over `request`; scrobbling is done by the Core from the `PUT /api/playback/state` that `NativeDeviceSession` already publishes, with no Kotlin changes. Last.fm authorization link as `<a target="_blank">`: opening it in the system browser has not been checked on an emulator | Vitest: `SettingsScrobbling.test.tsx` (4 cases: native transport, response from another account discarded, read retry, unreachable server) and `ScrobblingPanel.test.tsx` (12); `android_parity_inventory.py` does not list `scrobbling.*` keys as web-only | — |
| 2026-11-09 | Relay download tolerates 504 from GitHub's browser route | PR #434 | Two official routes to the same immutable MediaMTX asset are alternated within the existing six attempts; version, byte limit and SHA-256 are kept. No instrumentation retries | 63 Python download/diagnostics/release tests and Ruff passed; a real download of 28345997 bytes from the official API matches the pinned hash. Metadata JSON or different bytes are rejected | `/tmp/soundsible-pr434-download-fallback-tests.log`; `docs/internal/android/CI_DIAGNOSTICS.md` |
| 2026-11-09 | Diagnostics for delivery/application of remote handoff | PR #434 | Shard 7 still has the failure resuming the laptop with an empty target queue. DEBUG phases for registration, delivery, owner and exception, without metadata or credentials; snapshot diagnostics and fixture flags on failure. Does not change behavior, timeout or assertions | Native and JVM compilation; CI for the new head pending. Earlier shards 1/5 failed before instrumentation because of six HTTP 504 responses while downloading MediaMTX, with no demonstrated relation to the queue | `docs/internal/android/CI_DIAGNOSTICS.md`; `/tmp/soundsible-pr434-shard7-second.log` |
| 2026-11-09 | Live recovers stopped media even if ICE stays connected | This PR | RTP progress policy independent of PCM; the reconnection budget only resets with sustained flow. HTTP/TLS regression cuts the sender's media without closing ICE/sockets and requires recovery that keeps volume, intent and room; final native run pending in CI | Local instrumentation compilation, 102 JVM tests and lint; the policy covers silence, startup, short bursts, pause/suppression and counter reset. No new physical acceptance | `docs/internal/android/CI_DIAGNOSTICS.md`; `/tmp/soundsible-live-reconnect-review-local.log` |
| 2026-11-09 | Initial emulator check tolerates ADB reconnection after boot | PR #433 | Failures observed before installing or running the app: identity query with `error: closed` or empty exit 255. Bounded recovery of preparation shared with APK acceptance; instrumentation is not retried and a non-emulated device is rejected. Native CI for the new head pending | 59 Python release/diagnostics tests passed; they include recovery, timeout, immediate rejection of a physical device/permissions and preservation of the error. Ruff passed | `docs/internal/android/CI_DIAGNOSTICS.md`; `/tmp/soundsible-release433-adb-tests.log` |
| 2026-11-09 | Consistency of artist/album profiles, shared picker, menus and Discover recovery | This PR | Native presentation keeps controllers, IDs, generation and offline actions; audio and transport are not changed. Android checks for the PR pending; no new physical acceptance | TypeScript and UI: 234 files / 1938 tests; includes native profile, content selection, menu scope and review state. Full browser4: Chromium 414/0 and 74 skips; WebKit 401/0 and 87 skips. GitHub pending | `docs/internal/design/VIEW_REDESIGN.md`; `/tmp/soundsible-redesign-unit-ready.log`; `/tmp/soundsible-redesign-chromium-final.log`; `/tmp/soundsible-redesign-webkit.log` |
| 2026-11-07 | Show/car artwork in the square 640 variant, with per-account selection in the engine | This PR | Preparation and `:app:assembleDebug :app:testDebugUnitTest :app:lintDebug` passed on the combined #423/#424 base. Device panel without an SDK available; no new emulator run or physical listening | Full Core 2688/0 + one skip, plus final radios; UI 1871/0 and TypeScript; HTTP contracts, tombstone and account isolation. Chromium 384/0 and 74 skips; WebKit 371/0 and 87 skips. Remote checks on the PR | `.codex/artifacts/android-final.log`; `docs/internal/audits/2026-11-07-artwork-requests.md` |
| 2026-11-06 | Collection identity independent of source/occurrence: show, DJ, catalog, playlists and offline | PR #423 | Build/JVM/lint and instrumentation compilation passed locally; CI detected music IDs inherited when cloning radio/PCM fixtures: they are reset when distinct songs are created and the car radio enumerates items, with a SQLite/HTTP regression test. The REST bridge exposes `X-Soundsible-Collection` so that the canonical reader is actually negotiated, verified from the WebView. Acquisition publishes its snapshot after SQLite confirms, with concurrent reads covered; music also excludes podcasts in the canonical reader. Offline removal keeps the music references, even if they match the file's initial ID; native deletion tests adapted to the contract. `CollectionIdentityTest` and the native suite run in CI. Local Device panel without an Android platform available (`No android devices were found on host local`); no physical listening | Single collection resource with ETag on web/Android; Python regression, Vitest and browser4 on the PR. Swift 52/0; migration rehearsed on a SQLite copy of the incident account | `/tmp/soundsible-collection-android-final.log`, `/tmp/soundsible-collection-ui-final.log`, `/tmp/soundsible-collection-python-final.log`, `/tmp/soundsible-collection-chromium-final.log`, `/tmp/soundsible-collection-webkit-final.log` |
| 2026-10-28 | DJ P14: session demand, Core cancellation and refinement from the start, including a silent armed standby | This PR | AVD API 36: `DjRefinementTest`, `ProgramDjBlocksTest`, `PlannerRetirementTest`, 7/0; `ProgramDjRecoveryTest`, 14/0 over HTTP/TLS, including silent adoption without restarting the clock or pause, rejection during an audible mix and keeping the prepared deck with mixing disabled; real APK and test APK | `:app:compileDebugKotlin`, `:app:testDebugUnitTest`, `:app:lintDebug` passed; protocol and real cancellation of the child process/HTTP request in Python, web stores/HTTP. No new physical listening acceptance | `/tmp/soundsible-dj-android-prepare.log`, `/tmp/soundsible-dj-android-gradle.log`, `/tmp/soundsible-dj-android-integration.log`, `/tmp/soundsible-dj-android-recovery-final.log`; checks of this PR |
| 2026-10-25 | DJ P12: explicit local meter, coverage when relocating cues and degradation of incomplete metric plans; contract kept in the session | 2ca8ccf2 | Local JVM `ProgramDjPlanTest`, `ProgramMixCurveTest` and `ProgramDeckEffectsTest`: 23/0, Kotlin compiler from the Gradle cache and JDK 21 in Docker. Eight shared metric vectors, including 3/4, 6/8, half/double pulse with the same meter, relocation and fallback outside coverage. Build/lint/emulators in the PR checks; no local SDK or physical listening | UI 1772/0; full Chromium 353/0 + 71 skips and full WebKit 344/0 + 80 skips. AAC → SQLite → cold/warm HTTP on all endpoints, including song/artist requests; previous cache invalidated and compact summary. Real detector limits and references in `docs/internal/dj/P12.md`; synthetic signals do not demonstrate general accuracy | `/tmp/dj-p12-jvm-latest.log`, `/tmp/dj-p12-final-focused3.log`, `/tmp/dj-p12-ui-final3.log`, `/tmp/dj-p12-chromium-serial.log`, `/tmp/dj-p12-webkit.log`; PR checks |
| 2026-10-25 | DJ P7: automatic per-pair selection, echo and long mix without profiles; removal of `automation` (P10) | d678f625 | Local JVM `ProgramDjPlanTest`, `ProgramMixCurveTest` and `ProgramDeckEffectsTest`: 21/0, Kotlin compiler from the Gradle cache and JDK 21 in Docker. Long and echo vectors keep points, duration and effects; `ProgramDjRecoveryTest` requests refinement without a profile. Build/lint/emulators in the PR checks. No local SDK or physical listening | AAC → SQLite → HTTP on explicit sources, legacy, placement, repair and refinement; old profiles ignored. UI 1762/0 + types; full Chromium and WebKit suites, results in checks and logs | `/tmp/dj-p7-jvm.log`, `/tmp/dj-p7-http-paths.log`, `/tmp/dj-p7-echo-http.log`, `/tmp/dj-p7-ui.log`, `/tmp/dj-p7-chromium.log`, `/tmp/dj-p7-webkit.log`, `/tmp/dj-p7-core-final.log` |
| 2026-10-24 | DJ P9: echo at a measured outgoing beat, shared contract and session export; automatic echo not enabled (P7) | a8a22618 | Local JVM `ProgramDjPlanTest` + `ProgramMixCurveTest` + `ProgramDeckEffectsTest`: 21/0, Kotlin compiler from the Gradle cache and local JDK. `ProgramMixOutputTest` HTTP/TLS keeps echo with an explicit period; build/lint/emulators in the CI of this PR. No local SDK or physical listening | AAC → SQLite → HTTP at 90/137 BPM; five echo vectors in native PCM and real Web Audio (44.1/48 kHz, speeds 1/1.04, opposite stereo). UI 1761/0 + types; Chromium 353/0 and 71 skipped; WebKit 344/0 and 80 skipped. First Chromium pass invalidated by duplicated HMR URLs: repeated in full with a new Vite. Checks on this PR | `/tmp/soundsible-p9-aac.log`, `/tmp/soundsible-p9-ui.log`, `/tmp/soundsible-p9-chromium-final.log`, `/tmp/soundsible-p9-webkit.log`; native results in the PR checks |
| 2026-10-24 | DJ P8: measured sections and reliable pulse; shared vectors for exit, drop, short outro and the 25 % limit | 90b6c7e9 | Local JVM `ProgramDjPlanTest` + `ProgramMixCurveTest` 14/0, Kotlin compiler from the Gradle cache and local JDK; build/lint/emulators in the CI of this PR. No local SDK or physical listening | AAC → SQLite → `dj-plan` and `dj-transition`; UI 1747/0 + types; Chromium 351/0 and 71 skipped; WebKit 340 passed/80 skipped/2 timeouts, both repeated three times without failure (6/0), no changes to web sources | `/tmp/dj-p8-audio-http.log`, `/tmp/dj-p8-npm.log`, `/tmp/dj-p8-chromium.log`, `/tmp/dj-p8-webkit.log`, `/tmp/dj-p8-webkit-recheck.log` |
| 2026-10-24 | External selection with DJ active: immediate new session, valid after automatic route reloads; sources and placement only in the shell | This PR | DjContextTest and CarDjTest check shell editing and replacement by external click/menu and car selection; build, JVM and emulators in the checks of this PR (no local SDK; corrected the assumption of the placement test: it compares the song chosen in the route, whose first title can vary) | UI 1741; browser4 on this PR | /tmp/soundsible-dj-unit.log, /tmp/soundsible-dj-chromium.log, /tmp/soundsible-dj-webkit.log |
| 2026-10-23 | DJ P5: pending refinement with retries before committing the second deck | 31f696bc | Local JVM 2/0 with JDK 21; new HTTP `DjRefinementTest` (two pending → measured, not repeated afterwards), included in the full native CI suite of the PR. No physical listening | Full Core 2212 passed/1 skipped and final DJ/fixture regression 84/0; UI 1736/0; browser4: Chromium 349 passed/71 skipped, WebKit 340/80 | `/tmp/soundsible-p5-core.log`, `/tmp/soundsible-p5-pool-final.log`, `/tmp/soundsible-p5-ui2.log`, `/tmp/soundsible-p5-chromium-final.log`, `/tmp/soundsible-p5-webkit.log`; full native results in the PR checks |
| 2026-10-06 | S2at SEND invitations + pending item menu | bf9fac69 | 8/0 HTTP/TLS 66.4s + normal | UI 211/1620 | /tmp/soundsible-incoming-invite-native.log |
| 2026-10-06 | S2au Server and device settings | 90e9d1ef | 22/0 HTTP/TLS 280.5s + normal | UI 213/1631 | /tmp/soundsible-settings-block-native.log |
| 2026-10-06 | S2av session by QR/code | 118b2389 | 20/0 HTTP/TLS 235.8s + normal (JVM 59) | Core 78, UI 215/1637 | /tmp/soundsible-pairing-block-native.log |
| 2026-10-06 | S2aw song menu: artist/album, not interested, play on another device | bf30a361 | 22/0 HTTP/TLS 237.3s + normal (SongMenu + 9 classes that use the menu) | UI 216/1643 | /tmp/soundsible-song-menu-native.log |
| 2026-10-06 | Podcasts: Top/recommended (subscribe, reason, not interested) and "downloaded only" | ef28dddf | PodcastTop 1/0 HTTP + Podcast/PodcastDirectory 4/0 HTTP/TLS, 52.0s + normal. Waits for "Downloaded" in those tests were ambiguous with the new button: they now look at the row. Fixture: simulated Apple ranking (it previously went out to the internet) | UI 216/1646, Core fixture 1/0 | /tmp/soundsible-podcasts-native.log |
| 2026-10-06 | Library: sort/filter songs (preferences shared with the web), albums in engine order and genre/year | 72bbe127 | 12/0 in 167.4s + normal: impact radius (FileDeletion, OfflineRemoval, EntityBookmarks, Connection, CollectionProfile, LibraryActions, Offline); HTTP except classes without a variant | UI 216/1648 | /tmp/soundsible-library-native.log |
| 2026-10-06 | Queue with the web's lanes (context/requests), "Clear requests", "Resume" from another device | 3ecf6b78 | QueueLanes 1/0 HTTP + impact radius 11 HTTP methods (Playback, Radio, Autoplay, Device*, LibraryActions, DevicesUi, PlannerRetirement) 265.3s + normal; Radio/Autoplay adjusted to the web rule (the request goes after the current one) | UI 217/1654 | /tmp/soundsible-queue-native.log, /tmp/soundsible-queue-native-2.log |
| 2026-10-06 | Catalog download with engine verification and "Choose version", DJ "Change session", settings search | 02dcecff | 11/0 HTTP 140.7s + normal (Acquisition downloads through the new path, CatalogSearch, CollectionReview×4, CollectionProfile×2, DjContext, SettingsServer, DevicesUi) | UI 217/1659 | /tmp/soundsible-catalog-dj-settings-native.log |
| 2026-10-06 | Auto: exhausted car socket is removed and retried after 30 s | c0bc6aaf | Without the fix CarEvents fails ("Exhausted socket replaced…"); with it CarEvents(http) + CarLibrary + CarDj 5/0 146.5s + normal | — | /tmp/soundsible-car-exhaustion-native.log |
| 2026-10-06 | DJ "Request all" in a group, session change and contextual offline permission | 18edb7ed | DjContext + DeviceDjSession HTTP 2/0, 15.249s; real permission deny 1/0 (6.045s) and allow 1/0 (6.424s), copies completed; normal APK/JVM/lint | UI 217/1660 + TypeScript | /tmp/soundsible-dj-group-final3.log, /tmp/soundsible-notification-deny.log, /tmp/soundsible-notification-allow.log |
| 2026-10-06 | Isolation of the desktop smoke tests | f06b0525 | — | Desktop smoke + acquisition fixture 6/0 (53.06s); empty test folders prevent migrating the personal profile/cache | /tmp/soundsible-core-isolation.log |
| 2026-10-06 | UI regression and the four browser profiles | 18edb7ed | — | UI 217/1660 + TS; Chromium mobile/desktop 278/0, 66 skips (8.9m); WebKit mobile/desktop 269/0, 75 skips (8.6m), full suites in the CI image/1 worker. Local Chromium aborted with SIGILL from the browser library; clean container | /tmp/soundsible-final-ui2.log, /tmp/soundsible-final-chromium-container.log, /tmp/soundsible-final-webkit.log |
| 2026-10-06 | Full Core regression | f06b0525 | — | pytest 1792/0, 788.45s; TMPDIR on disk and isolated smoke tests | /tmp/soundsible-final-core-clean.log |
| 2026-10-06 | Native regression and case isolation; shared clock without redundant restarts | b862562e | Main HTTP/TLS: 211 run, 7 initial failures (fixture selection/counters and intermittent clock). Fixed: exact row for artwork, replay counter relative to the previous resolution, removal of a real candidate; shared output avoids repeated play and recoverable decoder pause. Mixes/recovery/catalog 53/54 (710.142s), the only failure was a double fixture cleanup; fixed, repeated and Connection/PlannerRetirement/Live/Auto 18/0 + normal APK/JVM/lint. The final main suite is checked again in CI | Offline smoke 1/0; Ruff and diff-check | /tmp/soundsible-final-native.log, /tmp/soundsible-audio-recovery-final.log, /tmp/soundsible-native-final-corrections.log, /tmp/soundsible-final-smoke.log |
| 2026-10-06 | Offline/Live process restarts | 685d7009 | Offline prepare + force-stop/offline 2/0 (6.478s + 3.246s); Live prepare + force-stop/resume 2/0 (4.998s + 4.494s). The runner grants the permission for these protocols without a dialog; allow/deny acceptance remains in fresh install rehearsals | Normal APK/JVM/lint | /tmp/soundsible-final-offline-restart2.log, /tmp/soundsible-final-live-restart.log |
| 2026-10-08 | Download from the native queue and the native catalog with the disc position (track, disc, year, album artist in Media3) | 4019329f | Queue: QueueLanes, Metadata, Lyrics, CarLegacy 7/0 HTTP/TLS 37.7s; catalog: Acquisition, CatalogSearch, CollectionProfile, CollectionReview, DeviceCatalogSession, QueueLanes 19/0 HTTP/TLS 203.8s; normal APK/JVM/lint; JVM ProgramRelease 4/0 | UI 217/1678 + TS; Core 1836/0; WebKit 287/0; Chromium 295/1: music-links "separate tab" unstable also on main (4/10 on main, 8/10 on the branch with 3 workers) | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-integration.log, …/android-integration2.log |
| 2026-10-08 | Disc position in queue handoff between devices | fe010168 | DeviceSession, DeviceDjSession, DeviceReconnect, DeviceCatalogSession, DevicesUi, QueueLanes 11/0 HTTP/TLS 192.6s + normal APK/JVM/lint; JVM ProgramRelease 5/0 | — | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-integration3.log |
| 2026-10-08 | Saved songs keep their disc; the album or queue row replaces the whole disc of a saved preview | 044024da, 5a0eefce | Catalog (044024da): Acquisition, CatalogSearch, CollectionProfile, DeviceCatalogSession 10/0 HTTP/TLS; queue (5a0eefce): QueueLanes, PendingQueueMenu, Metadata, Acquisition 7/0 HTTP/TLS; normal APK/JVM/lint | UI 218/1684 + TS; WebKit 287/0 and Chromium 295/1 (music-links "separate tab", unstable also on main) on d04ed311 | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-integration6.log, /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-integration7.log |
| 2026-10-08 | AcquisitionTest without a race: the fixture holds the download until the test has seen it in progress | 3cacd3bf | AcquisitionTest 3 consecutive rounds, 2/0 each (HTTP/TLS) | Earlier CI failure on the v0.21.0 commit (shard 1, run 37787098297), green on rerun | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-acq-1.log, …/android-acq-3.log |
| 2026-10-08 | DJ tick without close if the mix has failed; Live relay reader with retry on 404 | ccaf0711 | LiveHost, LiveRelay, LiveListener, DjNetwork, DjContext, DjProgram, ProgramDjRecovery 2 rounds 28/0 each (HTTP/TLS) + live-restart protocol OK | UI 218/1685 + TS; Chromium 296/0; WebKit 287/0 | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-flaky-1.log, …/android-flaky-2.log, …/android-flaky-restart.log |
| 2026-10-08 | CoverPickerTest: second choice if MediaProvider could not open the newly inserted image | 7f2d77e7 | CoverPicker 3 rounds, 2/0 each (HTTP/TLS) | CI failure (#316, shard 1): logcat with "Failed to prepare synthetic picker path" and "Cannot open content uri" | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-cover-1.log, …/android-cover-3.log |
| 2026-10-09 | ProgramMixOutputTest: after the corrective seek of the standby deck, wait until decoder and mix report it ready for 300 ms in a row | #322 | Full ProgramMixOutput 38/0 + CancelPreroll HTTP/TLS 2 more rounds, 2/0 each | CI failure on main (run 37851116718, shard 2) and on a docs PR (run 37806904135): "Corrected standby cue did not rebuffer" at ~3 s, not at the 15 s limit | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/ef8b274f-c9f6-4846-b61c-8cd35597bd7a/scratchpad/aint2.log, …/aint-cancel-2.log, …/aint-cancel-3.log |

The full run of the delivery commit and the checks for all platforms
are available in [PR #300](https://github.com/Arzuparreta/soundsible/pull/300/checks).
The earlier local results do not replace those checks of the current head.

- PR #300 review: both P2 confirmed. REST transport reused per origin/generation,
  pool removed on reset; the devices socket keeps its own lifecycle transport.
  Auto collections paginated in Core (maximum 200 per response), total kept;
  legacy bridge aggregates pages up to 1000 and stays compatible with earlier responses.
  Core: test with 405 playlists/podcasts, non-overlapping pages and invalid parameters;
  Connection/CarLibrary instrumentation adds reuse/reset and pages/legacy for 405 collections.
  Compilation and native acceptance of the corrected commit are validated in the PR CI.
- Later CI regression: the TLS transport removed in background no longer aborts
  CarLibrary. The suite reached 87 cases and detected artwork cancellation that could
  complete with an error before the listener, offline callbacks after destroying the
  Activity and two position captures taken before the pause settled. Artwork
  cancels results of removed generations; OfflinePlugin rejects late
  calls (deterministic test of permission call/response after destroy);
  IncomingTrack waits for a stable position without widening the tolerance. Full
  regression of the corrected head pending in the PR checks.

## Distribution preparation (2026-10-07)

- PR #300 merged; Android run of `main` 37601072712: build/JVM/lint and
  four shards passed. The previous run failed on the paused position of
  DjContextTest; the reference is now taken from a new connection to the service,
  not from the optimistic state of the previous controller. Tolerance kept (150 ms).
- Release and versioning tooling: 35 tests passed. Additional tests
  check incomplete gates, reservation of codes from failed drafts, complete native
  checks, immutability and rejection of receipts from another APK.
- Permanent key/backup: identical exports of the certificate from two
  physical disks; public SHA-256 in SIGNING.json. Secrets restricted to main.
- App Links: PR Arzuparreta.github.io #11 merged; HTTPS endpoint returns
  200 and application/json, with association to the permanent package/certificate.
- DjContextTest with a reference confirmed by the service: HTTP/TLS 2/0,
  normal APK/JVM/lint passed; log /tmp/soundsible-alpha-dj-confirmed.log.
- Local public APK of commit 1a7332fb: permanent signature and four ABIs verified;
  StartupTest release 1/0; update from a baseline signed with the same key
  keeps encrypted cookie, account, language/theme and offline metadata/copies. Offline
  prepare/seed/update/PCM 4/0; downgrade, different signature and truncated APK rejected.
  App Links: domain verified by Android, cold/warm open through real HTTPS
  resolution and unrelated routes not claimed. Receipt in android/build/alpha/release-acceptance.json;
  log /tmp/soundsible-alpha-release-acceptance4.log. Publishing from main requires
  repeating the acceptance on its exact APK in the release workflow.
- Public website: PR soundsible.github.io #14 merged/deployed; 84 logic tests,
  Astro build/check of 114 pages and browser/accessibility 24/0 in the CI image.
  Android links are not shown while there is no prerelease with all the assets.


## Public alpha and final review (2026-10-07)

- PR #304 merged into main `88033c20e8953335e2e06ab1c973ece43f7b5968`.
  Codex completed the review of the final head, with no new findings. The
  confirmed problems were fixed: real public base and its harness for updates,
  historical SDK, main guard before publishing, semantic comparison of
  offline copies, required lint, targeted restarts and visible App Links payload.
  The supposed UnboundLocalError was ruled out after checking the existing initialization.
  Release tooling: 20 tests and Ruff passed; offline snapshot: 2 cases passed.
- [Android CI of main](https://github.com/Arzuparreta/soundsible/actions/runs/37620771168):
  build/JVM/lint and four shards passed.
  [Shared CI](https://github.com/Arzuparreta/soundsible/actions/runs/37620771136)
  passed, including tests, lint, security, UI/browser and version consistency.
- [Publishing workflow](https://github.com/Arzuparreta/soundsible/actions/runs/37623396866)
  passed. [Immutable metadata of the public alpha](https://api.github.com/repos/Arzuparreta/soundsible/releases/405757139),
  public code 2, source main `88033c20`, permanent signature and four ABIs.
  APK SHA-256: `2e243da454af6f6457085a274376e9b955cce0d7e77b3ce5316322cd14d0d4f8`.
  All downloaded assets pass SHA256SUMS. The public receipt confirms
  update preserving account/settings/offline, downgrade/different signature/corrupt
  APK rejected, startup, offline PCM and App Links with cold/warm payload.
  First synthetic base with code 1; later releases use the real public APK.
  Public prerelease, without moving the global latest (release ID 405574473).
- Later local rehearsal: private candidate code 3, without reservation or publishing,
  installed over the downloaded public APK code 2, seeded with its own
  harness. All acceptance flags passed, including preservation of
  account/settings/offline. Logs /tmp/soundsible-alpha-published-upgrade-{plan,build,acceptance}.log.
- [Deployed website](https://github.com/Arzuparreta/soundsible.github.io/actions/runs/37624949108):
  live browser check of ES/EN downloads/checksums, native Android button,
  capsule preserved when sending to the saved web player and invalid capsule without
  an Android action. Screenshots /tmp/soundsible-alpha-download-{en,es}.png and
  /tmp/soundsible-alpha-android-sharing.png.
- No physical phone: listening, Bluetooth, car and real providers remain
  pending for beta; this automated evidence does not replace them.

## 2026-10-10 — Podcast country and rankings (PR #342)

- Native directory: globe selector, show and episode rankings by
  country, categories and resolution of the exact episode to the existing native
  controller; keeps personalized recommendations and copies acquired through RSS.
  Playback settings and their search include the country. State isolated by
  generation, with late results discarded when the account/connection changes.
- Validation: 1705 UI tests and typecheck; Python podcast fixture; parity
  inventory without the new country/rankings texts among the web-only gaps.
  HTTP run on AVD API 36: PodcastCountryTest, PodcastTopTest and
  PodcastDirectoryTest, 4 cases passed, plus JVM/lint/development APK.
  Logs: /tmp/podcast-native-{all-final,fixture,integration}.log.
  No publishing; the native transport is not modified.

- Fix to the rankings fixture: its records include the observed
  headers so that the cookie isolation check also covers
  charts and lookup. Python regression passed; joint HTTP/TLS run of
  PodcastTest, PodcastCountryTest, PodcastTopTest and PodcastDirectoryTest on
  AVD API 36: 7 cases passed, plus JVM/lint/development APK.
  Logs: /tmp/podcast-cookie-{fixture,integration}.log.

## 2026-10-11 · Play items on another device

- Branch `codex/remote-play-any-track`, commit that includes this entry: the song,
  unresolved catalog and episode menus send a portable description
  through the account's devices transport. A single request does not
  need a file in the library or a handoff session. The account guards
  and the occurrence restrictions in the DJ route are kept.
- `DeviceCatalogSessionTest` verifies reception of stream, catalog reference
  and episode, replacement of the show and native PCM over HTTP and TLS. Joint
  regression with `DeviceSessionTest` and `DevicesUiTest`: 6 cases passed on AVD
  API 36; JVM, lint and development APK passed. Log:
  `/tmp/soundsible-remote-android-integration.log`.
- Adapter logic and sending covered by Vitest; the server validates the
  descriptions and keeps device isolation per account. The native
  transport is not modified and no release is published.
- Follow-up of PR #344: the four CI shards detected obsolete
  expectations in `SongMenuTest` and `PendingQueueMenuTest` (request sent
  message and remote action for pending references). Both classes fixed
  and run together over HTTP/TLS: 4 cases passed on AVD API 36,
  plus JVM/lint/development APK. Log:
  `/tmp/soundsible-pr344-android-integration.log`. Delivery also requires
  all GitHub checks passed on the latest commit of the PR.

## 2026-10-11 · Dependency security and Live diagnostics in CI

- Branch `codex/dependency-security-block-1`, commit that includes this entry.
  The main run 38135594239 failed in `LiveListenerTest.httpCoreRelay`, in the
  PCM check after the Activity is closed. The test now first verifies
  new PCM after recovering WHEP and counts audible buffers inside the
  callback, without depending on sampling the latest RMS every 50 ms. It requires 50
  non-silent buffers after the close; it keeps the timeout and does not add retries.
- Three full HTTP/TLS runs of the final class: 6 cases passed on
  AVD API 36, plus JVM/lint/development APK in each run. Logs:
  `/tmp/soundsible-android-live-repeat-{1,2,3}.log`. On failure, the following are printed:
  controller state/volume, decoded/audible buffers and those of the publisher,
  and the latest RMS, to distinguish source, transport and lifecycle.
- The artifacts of the failed run do not show that the close stopped the receiver;
  it stayed active until the cleanup of the assertion. The passed repetitions
  do not prove the absence of every race either. The four shards of the PR are the
  final gate; new failures are not hidden through reruns without diagnostics.
- Review of the last 25 Android runs: 18 passed, 4 failed, 3 cancelled.
  The other failures were the incomplete cookie registration of the podcast
  fixtures and old menu expectations, already fixed on main. There was no
  demonstrated common cause. Production audio/transports are not modified
  and no release is published. Plan and pending dependency alerts in
  `docs/internal/audits/DEPENDENCY_UPDATE_PLAN.md`.

## 2026-10-11 · Compatible maintenance block 2

- Branch `codex/dependency-maintenance-block-2`: Node 24.21.0, Vite 8.3.4 and
  coordinated Capacitor 8.5.3. JDK 21 and the Android minimums are kept. The
  recovery globs move out of TSX to avoid the Vite scan failure; lazy
  loading and recovery with an alternative URL keep their contracts.
- AVD API 36: StartupTest, PlaybackTest and LiveListenerTest, 5 cases passed
  (Live HTTP/TLS), plus JVM/lint/development APK. Log:
  `/tmp/soundsible-block2-android.log`. Does not include local OfflineRestartTest;
  the four shards of the latest head on GitHub are still required.
- Node/JDK are selected only in the validation commands; the global
  runtimes are not modified. No alpha is published and the parity
  or offline gates are not opened. Plan in `docs/internal/audits/DEPENDENCY_UPDATE_PLAN.md`.

## 2026-10-12 · Block 3: OkHttp 5 transport

- Branch `codex/dependency-major-transports`: OkHttp 5.4.0 in the Android artifact,
  also selected for Media3 and Socket.IO. SDKs and TLS policy unchanged.
  5.5.0 rejected by the AAR gate: it requires compileSdk 37; compileSdk 36 is kept.
- AVD API 36: StartupTest, PlaybackTest and LiveListenerTest, 5 cases passed
  (playback and Live HTTP/TLS), 0 failures/skips; 64 JVM tests, lint and
  development APK passed. Logs: `/tmp/soundsible-okhttp-integration.log` and
  `/tmp/soundsible-okhttp-gradle.log`. Python environment with the block 2 lock.
  The first attempt with `.venv` ended before the tests due to a startup timeout
  of the community fixture; timeouts and assertions were not modified.
- OkHttp AndroidX initializer present in the merged manifest. The
  four full shards of the latest head and the Windows packaging remain
  the remote gate; this does not demonstrate physical listening and does not publish an alpha.

- Fix after CI: shards 0/3 reproduced an Engine.IO `StackOverflowError`
  when closing polling with the OkHttp executor stopped. The five Socket.IO
  call factories use `SocketIoCallFactory`: the error callback is queued on
  EventThread before closing again, which avoids the reentrancy. The JVM test
  reproduces the error without the adapter and passes with it.
  EntityBookmarksTest, LiveRecoveryTest, LivePollingTest and TransportResetTest:
  11 native HTTP/TLS cases passed, no failures/skips; 65 JVM tests.
  Log `/tmp/soundsible-socketio-integration.log`, baseline with the overflow:
  `/tmp/soundsible-socketio-baseline.xml`. CI must be repeated on the new head.

## 2026-10-12 · Block 3: AGP 9, Gradle 9 and compileSdk 37

- Branch `codex/dependency-android-agp9`: AGP 9.3.3 with built-in Kotlin, Gradle
  9.8.1, compileSdk 37 (`android-37.0`), minSdk 24/targetSdk 36 unchanged,
  OkHttp 5.5.0, CameraX 1.6.2 and AndroidX updated. JDK 21 from the toolchain.
- 65 JVM tests, lint without errors, debug/test APK and release signed with a
  temporary keystore (`apksigner verify`). Logs `/tmp/soundsible-agp93-build.log`.
- AGP 9.4.1 discarded: its `android-test-engine` 1.0.1 truncates arguments with
  commas (`notClass`, `class`); log `/tmp/soundsible-agp94-args.log`. With 9.3.3
  the values arrive complete (`/tmp/soundsible-agp93-args.log`).
- AVD API 36, full suite without shards: 215 cases, 210 passed; failures only
  TLS (`/tmp/soundsible-agp93-integration.log`). `main` baseline with the same
  filter: OfflineTest/ProgramPcmTest TLS also fail
  (`/tmp/soundsible-main-tls-baseline.log`). Local cause: keep-alive TLS connection
  closed by the fixture and offline download without retry. CarLibrary,
  CatalogSearch and Podcast isolated: 7/7 (`/tmp/soundsible-branch-car-podcast.log`).
  The four shards of the latest head on GitHub remain the gate.

## 2026-10-13 · Offline download: idle socket closed by the server

- `OfflineStore` downloaded with `retryOnConnectionFailure(false)` and without
  repair: if the server had closed the reused keep-alive socket, the
  copy ended in `network` (`unexpected end of stream`/`EOFException` before
  the headers). It now uses the player's rule (`AudioConnectionRepair`):
  only that failure, with no new connection in the call and without cancelling, evicts the
  idle sockets from the pool and repeats the GET once. A body is never repeated.
- Without evicting the pool, the retry took another idle socket that the TLS
  fixture also cut (in the middle of the body): OfflineTest/ProgramPcmTest TLS
  failed in 3 of 4 rounds (`/tmp/soundsible-offline-repair-without-evict.log`).
  With the eviction, 3 of 3 rounds and then Offline, ProgramPcm, OfflineRestart,
  OfflineRemoval, CarOfflineExpiry and OfflinePluginLifecycle HTTP/TLS 9/0 twice
  (`/tmp/soundsible-offline-repair-1.log`, `-2.log`); 65 JVM and lint.

## 2026-10-13 · Player: retry on a new socket

- `PlaybackService` already repeated the audio GET once when a pool socket
  died before the headers (`AudioConnectionRepair`), but the retry
  could take another idle socket that was equally old. It now first evicts the
  idle sockets from its own pool, like the offline download.
- Playback, TransportReset, Closure, Radio, Autoplay, ProgramPcm, Offline,
  CarLibrary and CarEvents HTTP/TLS, 5 rounds of 18 cases: the repair triggered
  without cancelling (`Headers failed; connected=false cancelled=false`) and
  playback continued. 17 cases pass in all 5 rounds; CarLibrary TLS failed
  in 3 because of its offline copy: pool socket cut by the TLS fixture in the middle
  of the body (~2.8 MB), unrelated to the player; handled separately. 65 JVM
  and lint. Logs `/tmp/soundsible-player-evict-{1..5}.log`.

## 2026-10-13 · Offline download: one dedicated socket per copy

- With the retry from #353, CarLibrary TLS kept failing (3 of 5 rounds): the
  copy took a socket from the pool and the TLS fixture cut it in the middle of the body
  (~2.8 MB), a failure that cannot be retried without repeating the body. Each
  copy now uses a pool without idle connections: it opens its own socket and
  closes it when done. One TLS handshake per song is negligible compared with the
  download. The retry from #353 no longer has a purpose and is removed.
- Playback, TransportReset, Closure, Radio, Autoplay, ProgramPcm, Offline,
  CarLibrary, CarEvents, OfflineRestart, OfflineRemoval, CarOfflineExpiry and
  OfflinePluginLifecycle HTTP/TLS: 23/0 in 3 rounds
  (`/tmp/soundsible-offline-fresh-{1..3}.log`); 65 JVM and lint.

## 2026-11-03 · Live silence diagnostics in CI

- Main `9986f87b`, run `41548539741`, shard 6: only
  `LiveListenerTest.tlsCoreRelay` fails, while waiting for audible PCM after recovering
  WHEP and closing the Activity. State READY/playing, PCM callbacks active,
  synthetic source active and RMS zero; publisher/reader still connected.
  The original artifacts do not contain enough metrics to attribute
  the cause. Retry of the same head requested, without changing assertions.
- Branch `fix/android-live-ci-diagnostics`: timeline of phases, PCM, focus,
  gain, peer states and WebRTC/relay statistics; continuous logcat
  with cleanup by trap and error code preserved. Guide:
  [CI_DIAGNOSTICS](CI_DIAGNOSTICS.md).
- Instrumentation compilation, 80 JVM tests and lint passed; eight
  Python tests for metrics redaction, WebRTC dependency and preservation
  of evidence/exit code passed; Ruff and `git diff --check` passed.
  Local log `/tmp/soundsible-android-ci-final-validation.log`. Native acceptance
  of the new traces and the PR checks pending in GitHub.
