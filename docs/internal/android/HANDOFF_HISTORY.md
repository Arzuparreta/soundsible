# Android port history

Preserved record of progress and diagnostics. For current decisions and status,
read [HANDOFF.md](HANDOFF.md); this history contains superseded results.

# Android port handoff

## Read before continuing

This file is the entry point for another agent/contributor. It does not require
chat history or private memory. See the [guide](../ANDROID.md),
[architecture](ARCHITECTURE.md), [plan and parity](PORT_PLAN.md),
[first slice](SLICE_1.md), [offline](OFFLINE_DECISION.md) and
[release](RELEASE_GATES.md).

## User decisions that remain in force

- Android APK with shared Solid UI and a native layer; maintain it from the same repo.
- S0 was the documentation and a minimal APK. The user then asked to "push and go for
  the next slice": S0 was pushed and S1 implements connection/read-only library.
- Full goal: phone, DJ, Live and Android Auto. Do not publish a partial
  alpha; CI artifacts are development builds and may be publicly accessible.
- Offline B approved on 2026-10-03: already acquired music, explicit copies,
  "Available offline" in three-dot menus. No preparation button
  in shells. One library, centralized space/progress. See OFFLINE_DECISION.
- There is no Android phone of our own. Keep emulator, remote devices and
  real phone/car separate; do not call CI acoustic acceptance.
- Every implementation ends with a commit and push on a branch, never directly to main.
  Current authorization (updated 2026-10-05): continue until full parity,
  commit/push and leave the PR open with all checks passing for the user's manual
  review. Do not merge or enable automerge. Prepare alpha documentation
  and instructions; do not publish a release before its review and merge.
  This instruction revokes any earlier merge/release authorization.
  The user confirms keeping full parity before alpha (no partial alpha).
  Do not delegate without authorization.
- Respect AGENTS: central version, no local `npm run build`, full suite
  of four profiles before opening a PR that touches `ui_web`, and current remote base
  and impact label when opening the authorized PR after parity is complete; leave it open.
- The iOS app is independent Swift, not synchronized Solid. Its runtime still has
  no device validation. Keep the iOS/PAL warnings.

## Current continuation status

S3a is validated on clean commit d049f40481dc1626d2d037186241dedffe794ed7
(dirty=false): main 78/0, restart prepare 1/0 and force-stop/offline 1/0 with real PCM
and per-profile preference. Normal APK/test APK/JVM27/lint pass after
removing the temporary CA. Log /tmp/soundsible-s3a-main-isolated-clean-native.log;
current XML confirms 78/0/0/0. Replaces the earlier clean main 73 from before DSP.
Targeted WAV/FLAC, Radio/parser/Autoplay6 and Python planner 79 also pass.
See [S3a](SLICE_3A.md) and [evidence](evidence/s3a.json). The first main 78/2
failed because it assumed two tracks in the album extended by Radio; the diagnostic is kept
and the own PCM album fixture fixes the problem without deleting other rows.

Next: integrate and compile [DJ mixing](SLICE_3B.md), test two private
decoders mono16k/stereo48k normalized to stereo48k, with a single AudioTrack,
FX/limiter and post-DSP/pre-volume output. Spike integrated in sources and tests: Kotlin Native/test compilation, JVM36/0
and lint pass (/tmp/soundsible-s3b-mix-foundation-fixed.log). AudioTrack HTTP/TLS2/0 passes on clean 16ed5d83: spectrum 440/880, normalized
formats, independent local volume and continuity after releasing the outgoing input;
normal APK/test/JVM36/lint passes, log /tmp/soundsible-s3b-mix-looper-native.log.
Not connected to the service and DJ not accepted. Pause/resume and real clearSession also pass HTTP/TLS2 and normal build
on clean 4b6489ee, log /tmp/soundsible-s3b-mix-pause-native.log.
Seek with real marker 440→1320 also passes HTTP/TLS2 and normal build
on clean 6d0626a0, log /tmp/soundsible-s3b-mix-seek-replacement-native.log.
Dominance 25/75% with physical clock and direct cut also pass HTTP/TLS4
on clean 5f762ba1, normal APK/test/JVM38/lint passes, log
/tmp/soundsible-s3b-mix-direct-native.log. Real failure of the incoming decoder during blend passes HTTP/TLS6 on clean f001e95a,
outgoing PCM/ramp and dominance restored, normal APK/test/JVM38/lint
passes. Log /tmp/soundsible-s3b-mix-recovery-native.log. Piecewise clock and late failure at 95% pass HTTP/TLS8 on clean ca242c26,
normal APK/test/JVM41/lint passes. Log /tmp/soundsible-s3b-mix-clock-resume-native.log.
Seven techniques/FX pass HTTP/TLS18 on clean e0499c4e: bass/filter/long/echo
with real spectra, structural/direct and regressions; normal APK/test/JVM41/lint
passes. Log /tmp/soundsible-s3b-mix-fx-ready-native.log. Real WAV+FLAC passes HTTP/TLS2 on clean f5178e54, normal APK/test/JVM41/lint
passes, log /tmp/soundsible-s3b-mix-codec-native.log. EOS HTTP/TLS2/0 and normal
APK/test/JVM41/lint pass on clean f180e8ea, log
/tmp/soundsible-s3b-eos-silence-native.log. Tempo HTTP/TLS2/0 and normal
APK/test/JVM41/lint pass on clean b2e208b8, log
/tmp/soundsible-s3b-tempo-native.log. Cue/preroll HTTP/TLS2/0 and normal
APK/test/JVM41/lint pass on clean e7e36547, log
/tmp/soundsible-s3b-cue-native.log. Cancellation and standby seek HTTP/TLS2/0
and normal APK/test/JVM41/lint pass on clean 53717d2f, log
/tmp/soundsible-s3b-cancel-reservation-native.log. Rate return HTTP/TLS2/0
and normal APK/test/JVM41/lint pass on clean 5b5dbed8, log
/tmp/soundsible-s3b-rate-return-native.log. Full spike regression 32/0
and normal APK/test/JVM41/lint pass on clean f2e7a921, log
/tmp/soundsible-s3b-complete-spike-native.log; per-input levels included.
LongBlend48s HTTP/TLS2/0 and normal APK/test/JVM48/lint pass on clean bbfcd056,
log /tmp/soundsible-s3b-long-end-native.log; fromKey7 JVM policy green.
Early/late loss of input/output HTTP/TLS8/0 and normal APK/test/JVM48/lint
pass on clean b210eeb3, log /tmp/soundsible-s3b-outgoing-loss-native.log.
Stable ProgramPlayerRouter facade connected to PlaybackService on top of the existing
NORMAL backend; targeted APK2/0 and normal APK/test/JVM48/lint pass on 71ab534b
in /tmp/soundsible-s3b-router-fixed-native.log. Event forwarding and isolation
when replacing the backend accepted; full NORMAL regression still pending.
Switching backend requires the previous one stopped and the next one without requested play;
the facade keeps the MediaSession identity.
DJ integration in sources: ProgramDjPlanner/Core, ProgramDjSession/route,
ProgramMixPlayer/single focus, mixed tap and From current command in the menu.
Kotlin Native/test, JVM48 and lint pass in
/tmp/soundsible-s3b-dj-e2e-foundation.log. First end-to-end flow accepted on clean
9d64d5a3: DJ HTTP/TLS2 + NORMAL PlaybackTest HTTP/TLS2, all green;
normal APK/test/JVM48/lint passes. Log /tmp/soundsible-s3b-dj-normal-native.log.
DjProgramTest runs real Core, bridge/service, mixed PCM in background,
dominance, pause, Activity recreation and return to NORMAL. Do not declare DJ parity.
Missing: refill/direction/full editing and extending recovery/phase/OS controls.
Reserve full suites for closing the block; use targeted runs during integration.

DJ continuation: editable route that keeps the committed occurrences, replan
of the future and refill on the same backend; native settings with profile/direction/
sources and profiles in the three-dot menu. Targeted DJ HTTP/TLS + NORMAL4/0,
normal APK/test/JVM/lint pass in /tmp/soundsible-s3b-dj-route-native.log on the
working tree (dirty=true), not clean-commit evidence. Targeted UI 18/0 and
TypeScript pass in /tmp/soundsible-s3b-dj-settings-ui.log. The test verifies
append/move/remove while paused and profile change without replacing the current occurrence
or advancing its position. It does not demonstrate long refill or effective replacement of the future:
the two-track source set can run out. Missing: direction/sources UI,
start from sources only, real refill and decoder recovery in production.

Direction UI added to the three-dot menu: energy, familiarity and prompt,
with include/exclude retained. Editor bound to the program identity; retryable
error and closing when the owner changes. Targeted 20/0 and TypeScript pass in
/tmp/soundsible-s3b-dj-direction-ui.log. Still missing: proving that Core applies a
real prompt to the future, and completing source selection and start without a song.

Collection menus allow starting DJ without a seed, adding or removing a collection
as a source with account/program guards and payload limits. Targeted UI 22/0
and TypeScript in /tmp/soundsible-s3b-dj-sources-ui.log. DJ HTTP/TLS2/0 and normal
APK/test/JVM/lint pass in /tmp/soundsible-s3b-dj-sources-native.log (dirty=true):
Core picks a real opening from the source set and creates a new program identity.
Pending: effective refill with more than eight candidates and effective change of sources.

Refill and effective replacement of sources accepted: DJ HTTP/TLS2/0, normal
APK/test/JVM49/lint in /tmp/soundsible-s3b-dj-refill-resampler-native.log
(dirty=true). The test jumps within a set of ten acquired tracks, forces
refill 9→10, switches to PCM sources and keeps KEY/pause/position of the current input.
It found a real failure: Sonic.reset clears the 48k target when stopping/reusing the decoder.
ProgramResampler configures 48k on every stream and delegates both flushes explicitly;
dedicated JVM regression passes (/tmp/soundsible-s3b-resampler-unit.log).
Failed diagnostics are kept in /tmp/soundsible-s3b-dj-refill-native.log and
/tmp/soundsible-s3b-dj-refill-fixed-native.log. Next block: recovery
in production, DJ session controls/focus and full service/UI regression.

Full UI regression passes 198 files/1556 tests + TypeScript, log
/tmp/soundsible-s3b-dj-direction-parity-full-ui.log. The editor uses the shared
parseDjDirection (without the web mixer): recognized text is translated to controls/include/exclude;
sliders keep fractional values. Test of "smoother" and retry keeps
exclusions, targeted 2/0 in /tmp/soundsible-s3b-dj-direction-intent-ui.log.

Media3 controller kept across NORMAL→DJ→NORMAL accepted on the working tree:
DJ HTTP/TLS2 + NORMAL2, all green; normal APK/test/JVM49/lint pass in
/tmp/soundsible-s3b-dj-session-controls-native.log. The same MediaController
observes dominant metadata and pauses/resumes DJ before/after recreating the Activity.
It does not yet test DJ focus/noisy, device/car or full recovery.

Full native regression on clean 255d07b8: main 120/3, log
/tmp/soundsible-s3b-full-native.log. PlannerRetirement HTTP Radio/Autoplay fail
because they assume the first candidate is member-radio-*, and ProgramPcm HTTP fails because it looks for
member-track outside virtualized rows. Fixes: select the own candidate
within the real plan and find the song through the UI. Targeted retirement 4 + PCM 2 pass in
/tmp/soundsible-s3b-focus-retirement-pcm-fixed-native.log; in that same run DJ2 fails
because a noisy broadcast sent from the shell does not reach a NOT_EXPORTED receiver.
Do not present 120/0 or an updated restart: the main failure prevents the restart phases.
DJ HTTP/TLS2/0 with real temporary focus loss and noisy simulated by system UID
on a rooted AVD accepted; normal APK/test/JVM49/lint passes, log
/tmp/soundsible-s3b-dj-system-focus-native.log (dirty=true). It does not prove physical
headphones. The integration scripts require an AVD; this case also requires su.
Outgoing recovery without an applied window: if the current input fails and the
successor has prepared PCM, the controller promotes it with a direct cut.
ProgramDjRecoveryTest uses the real controller, HTTP404 in the decoder and successor PCM
48k/stereo that is not silent. HTTP/TLS2/0 and normal APK/test/JVM49/lint pass in
/tmp/soundsible-s3b-dj-outgoing-direct-pcm-native.log (dirty=true). The case uses
mixing=false to ensure there is no armed window; it does not yet prove a network
failure during a committed mix or its starvation. It is a test of the production controller
in isolation, not of the full bridge/service flow.
The real TLS failure when closing SSL connections on the main thread is fixed:
own audio pool/dispatcher, retirement on a worker and shutdown of its executor.
See evidence/s3b.json. Remaining DJ/Live/Auto/Settings/signing/update
are still pending; continue until parity without closing per slice. Then leave the
PR open with checks passing for manual review, without merge or automerge.
Do not publish a release before review and merge; prepare alpha information.
Final browser4 must be repeated before opening the PR.

The "DJ mix" preference is connected to Core through confirmed PATCH/GET, cache
per profile and native state published to Settings. It shares the audio preferences
worker with leveling; it does not share its value or its commands. Disabling mixing
keeps a transition that is already prepared and applies DIRECT/full duration to the
following ones. DJ2 + PCM2 HTTP/TLS pass together with normal APK/test/JVM49/lint in
/tmp/soundsible-s3b-mixing-settings-native.log (dirty=true on 12a872d0).
The test verifies full duration and absence of mixed PCM with mixing off,
and enables it again before refill. UI 198 files/1557 tests and TypeScript pass
in /tmp/soundsible-s3b-mixing-settings-full-ui.log. Offline restart on clean 12a872d0
passes prepare 1 + force-stop/offline 1, with a subsequent normal build in
/tmp/soundsible-s3b-restart-offline-native.log. It does not replace main 120/3:
current full regression and browser4 are still pending. Next: bounded recovery
of missing PCM during a committed transition; do not declare DJ parity.

ProgramTransport shows observed planner states: planning/warming,
degraded (pending transitions), exhausted and terminal errors. The controls
remain bound to the current program; ready clears earlier feedback. Targeted 14/0
and TypeScript pass in /tmp/soundsible-s3b-dj-phase-{ui,typecheck}.log. This UI
was added after preparing the starvation artifact; do not attribute APK
acceptance of that run to it. browser4 regression remains pending before the PR.

Bounded recovery during a mix accepted: ProgramDjRecoveryTest 6/0 HTTP/TLS,
normal APK/test/JVM49/lint without CA in /tmp/soundsible-s3b-starvation-ramp-fixed-native.log.
It retires an input that stops supplying PCM for 2s if the other one has audio;
pause does not consume the timeout. It keeps epoch/clock and tests non-silent stereo 48k PCM
AFTER the ramp. Isolated real controller case, without demonstrating
yet a stalled network download in the bridge/service flow. Asset prepare
on 0f26f348 dirty=true; final sources dirty on 1ab49ea6. Do not claim a full main
green or DJ parity. /tmp/soundsible-s3b-starvation-post-recovery-pcm-native.log
keeps a real race that was found: the controller re-armed before the ramp
finished. It now requires the end of the rendered ramp and physical clock, and retiring the decoder
does not start another restoration. If BOTH inputs are missing there is no healthy audio to
recover; this case is not covered by this watchdog.

The following delivery sections are historical; use the last one and PORT_PLAN
to know what is missing. S2s keeps audio/ID when editing metadata/sidecar; S2t adds
bookmarks on acquired entities and confirmed refresh. The failures found
in regression (Saved refresh and shared auth budget) are fixed.
Last main APK: **73 tests + two persistent offline phases pass**, sources
prepared from clean commit 46a6c3d; normal APK/test APK/JVM20/lint pass
without temporary CA. Log /tmp/soundsible-s2af-main-clean.log.
Last full S2ad browser runs: Chromium 278/66 and WebKit 269/75, no failures,
sequential with 1 worker like CI, including Appearance/header/links. Repeat four profiles before the final PR.
S2u OS picker and S2v sidecar priority validated; S2w acquired/preview lyrics
uses the shared panel with native runtime and passes HTTP/HTTPS. Missing: full library/
Discover/Settings, DJ, Live, Android Auto, signing and update.
S2x acquisition and S2y shared import/DocumentsUI picker HTTP/HTTPS
validated. S2z Back navigation validated with program/session preservation;
continue without closing per slice. First main on 502947d: 45 cases,
one failure in closing after Radio refill. The first fix passed Autoplay but
failed Closure in the second main (45 cases, two failures). Final contract:
programToken stable during refills, different when opening a new queue; stop
validates program identity + UID/generation, with an order guard for old callers
without programToken. Closure and Autoplay HTTP/HTTPS (4 cases) and normal APK/test/unit/
lint without temporary CA pass. Repeat main + two offline phases before
replacing the previous result. The files in
integration-results are only updated if it passes: do not use the old XML of 35
as the result of this failed run. Next block:
[delete acquired](SLICE_2AA.md).
No PR open for manual review yet; keep full alpha gates and continue.

## S0 delivery

Branch: `feat/android-port-foundation`. Inspected base:
`26be603c9712f5599507ca1fc7a43255040f1ce2`, 2026-10-02.
For the final S0 commit use `git log --oneline --grep='Android port foundation'`;
do not confuse the base hash with the commit of this implementation.

Implemented: documentation and gates; Kotlin/Capacitor project with sources and
Wrapper; local Solid assets separated from the engine bundle; shared startup,
locale/preferences/fonts; real native information; prepare/build/install/
smoke helper; instrumented test and workflow without publishing. The Android dictionaries
include the four existing languages. No engine API changed.

Not implemented **in S0**: server/account/sockets, playback of any mode, local
downloads, DJ, Live, media service, Android Auto, permanent signing, updater
or publishing. The shell does not import those runtimes or request their permissions.

## S0 validation

Final local run: 2026-10-02. The current APK test
carries `dirty=true` metadata because it was built in the implementation tree;
it is not a clean artifact of a release commit.

- Typecheck and Vitest: **1,320 tests / 137 files pass**.
- Full mobile/desktop Chromium: **278 pass / 66 skipped due to platform conditions**.
- Full mobile/desktop WebKit: **269 pass / 75 skipped due to platform conditions**.
- Debug APK + test APK + lint: **build succeeds**, API 36/JDK 21.
- API 36 emulator, bridge, startup and offline reopening: **1 instrumented test passes**, including Spanish locale and dark theme after recreating the activity.
- Ruff check/format and central version: correct. Actionlint, diff and internal links: correct.

Problem found and fixed: running Gradle tasks without a module also tried
to compile the tests of the generated Cordova libraries and conflicted with their
old Kotlin stdlib. The helper targets `:app:*`, which tests and packages our
app with its dependencies. No libraries in node_modules were altered and no
global Kotlin override was added to hide it.

[S0 evidence summary](evidence/s0.json) and
[startup screenshot](evidence/startup-api36.png): the standalone screenshot uses the
English/system-light defaults; the instrumented test demonstrates Spanish/dark.
The initial reopening failure was a race in the test, which queried the old
DOM before navigation started. Recreating the activity and waiting for its new
WebView verifies the real startup.

Reproducible results are in `android/app/build/reports/`,
`android/app/build/outputs/androidTest-results/` and future CI artifacts. Temporary local
toolchain: `/home/arsu/.cache/soundsible/android-toolchain`; **do not depend on
that path on other machines**. Export SDK/JDK as in ANDROID.md. The S0 CI environment
was defined, but at that time it had not been run on GitHub. A push to a feature
branch does not trigger the workflow filtered to main/dev; do not present CI as verified.

## S1 delivery and current evidence

Branch `feat/android-port-foundation`. S0 pushed as `3c9ff98`.
For the S1 commit: `git log --oneline --grep='native account transport'`.

Implemented: validated origin, account and passwordless login, cookie encrypted in
Keystore, REST/multipart/abort/ETags, private covers without cache across accounts,
Socket.IO per identity, logout/switch/revocation, manual/foreground refresh,
read-only library and collections using the shared Solid visual row.
Engine CORS and auth are not modified; no playback runtime is imported.
Public HTTP remains blocked by Android; native alias reserved for private IP,
Host preserved and DNS verified. See the technical decision in ARCHITECTURE.

Reproducible real test: `python scripts/android.py build` and, with the engine's Python
and a booted AVD, `python scripts/android.py integration`. The helper creates
three engines in new directories and shuts them down. Do not point fixtures at the personal
engine. `android/build/fixture.log` and Gradle reports keep local evidence;
the metadata of the checks before the commit says `dirty=true`.

Final results/evidence: [S1](evidence/s1.json) and [screenshot](evidence/library-api36.png).
Typecheck/Vitest: 1,330 tests in 141 files; backend contracts: 43 pass;
APK/lint and API 36 integration: 5 tests pass, including WebView with a real cover.
Full browser suite: Chromium 278 pass/66 skipped; WebKit 269 pass/75
skipped in the final repetition. An earlier run had a scroll failure
in Discover; it passed three times in isolation and then in the full suite without source
changes. The evidence keeps both results.
 Do not confuse the first two
failed tests (AVD network disabled / reading generation as Long) with
the corrected result. The private HTTP policy is also checked at the
Android level: example.com does not allow cleartext. The fixture control client uses
the same private routing but does not attach a cookie; a generic OkHttp is correctly
blocked by the OS policy.

Positive HTTPS is already tested with a real engine and an ephemeral CA/verified hostname,
in addition to rejecting HTTP announced as HTTPS. The test CA is removed and
the normal APK is rebuilt without it. No private key or test trust is
committed. Deployment acceptance still open: concrete public HTTPS
instance, real LAN/Tailscale DNS and phone. The library does not yet offer all
web actions or podcasts/discovery; do not mark full parity.


## S2a delivery: first native program

The user asked to continue after the S1 push (`d0cb3a3`). S2a implements
the first cut of [S2](SLICE_2.md), not all of S2. Find the commit with
`git log --oneline --grep='native NORMAL program'`. Push authorized on this branch;
do not open a PR or publish for completing this cut.

Implemented: MediaLibraryService/ExoPlayer service, MediaSession/MediaController,
authenticated file streaming with native cookie and Range, focus/noisy/foreground,
basic queue with occurrences, Play/Pause/seek/Previous/Next and snapshots of
metadata/position/error. Solid uses the shared rows and temporary controls;
it does not import AudioService/Web Audio or invent synchronous success. Active only for
files; saved previews remain visible/disabled.

The connection now belongs to the process (`EngineConnection.shared`). Destroying the Activity
releases the controller/socket and cancels its REST calls by unique namespace; it does not destroy the
program. Background suspends the JS ticker. Logout/switch/401 before another
login clear the session, advance the generation and cancel audio; old sources cannot
adopt a new cookie. Epoch URI is internal only and removed from HTTP.
The current queue is not persisted after process death. Only the own UID replaces the
queue; external OS clients must be trusted. No Android Auto catalog yet.

Tests/screenshot: [S2a](evidence/s2a.json) and [program](evidence/program-api36.png).
Typecheck/Vitest: 1,331 tests / 142 files. Backend auth/socket/Range contracts:
49 pass. APK/lint and API 36 integration: 7 tests pass, including media
notification/session token, Range, focus and revocation. Reopening without network: 1 passes
and 6 fixtures are skipped. Full Chromium: 278 pass/66 skipped; full WebKit:
269 pass/75 skipped. An initial scroll failure on artist passed three times
in isolation and then in the full suite without source changes; evidence keeps
both runs. Selection of the second occurrence is verified by tapping the
row of a real playlist, in addition to native commands.

The fixtures add synthetic WAV files, Range auditing without cookies and local-only
failure/revocation controls. The test seeks to the end of a generated 600 s tone
to force Media3 to read a new range; a 60 s file was preloaded
entirely and the seek did not need HTTP. Do not use personal music or change the engine
so that an invented test gets Range. Another fix: onConnect returned
empty commands, so they are granted explicitly with the queue restriction.
The startup test selects the screen heading, not the retained loader.

Material limitations: temporary UI, limit of 1,000 files, no artwork in the
notification, no resumption after process death and no previews/podcasts/radio.
MediaLibrarySession does not demonstrate Auto; token/media commands on the emulator do not
validate the lock screen, Bluetooth, disconnection/calls or listening on a phone.
Gates for public HTTPS server/DNS/Tailscale and car remain open. Offline
still has no decision and is not implemented here. No alpha.

## Next concrete task

Continue according to the last cut proposed at the end of this file. S2e and S2f
already cover library insertion and explicit recovery of the local program. See the proposal at the end of this handoff and [S2](SLICE_2.md).
Then adapt full routes/actions before mounting AuthenticatedPlayer or
retiring LibraryBrowser. Previews/podcasts/resume/±15s/radio sources, artwork and
phone/Auto acceptance keep their gates. Do not introduce a second Web Audio owner.

Before working: `git status --short --branch`, read AGENTS and verify the current
files. Update this handoff with every slice: commit, tests/evidence,
pending capability and next step. Do not carry old results forward as current.

## S2b delivery: native queue modes

Continuation of S2a on the same branch: asynchronous `shuffle`/`repeat` commands and
snapshots with modes and availability of next/previous according to Media3. It keeps
the original occurrence indexes; keeps modes in background/recreation and
resets them on account/origin reset. Required parameters and invalid modes
are rejected without mutation. See [S2b contract](SLICE_2.md#s2b-native-queue-modes).

This cut only modifies Kotlin/Android tests and documentation. It does not add buttons
or the typing of these fields to Solid; that stays with the asynchronous integration
with the authenticated runtime, which remains the next priority slice. It does not
mark NORMAL complete, S2 complete or alpha ready. The browser suite is not run again
for this cut because there are no changes in `ui_web`.

Local validation: APK on API 36, **7 instrumented tests pass / 0 skipped**, with
HTTP and HTTPS program verified, modes through the real bridge, modes kept
after recreation/background, rejection of invalid repeat, return to sequential and
clearing of both modes on logout. The S1 and S2a tests are kept. The helper
rebuilds the normal APK without the fixture CA and runs lint. Specific evidence:
[evidence/s2b.json](evidence/s2b.json). The emulator does not prove acoustic acceptance,
Bluetooth or car. The GitHub workflow has not been run and no release has been published.

The user asked to push all pending work: the local branches for the
iOS seek audit and fix were pushed, in addition to this Android line. Uncommitted
changes from the reliability worktree were kept in
`wip/reliability-worktree-backup`: a backup that is **not validated for integration**, created
without altering its working tree/index and excluding its local `.venv` link.

## S2c delivery: asynchronous observation and Solid controls

The program now has a typed contract independent of Capacitor/Solid/Web
Audio in `ui_web/src/lib/program/runtime.ts`. AndroidStart uses that runtime and the
`ProgramTransport` component instead of its embedded commands/listener/JSX.
Shuffle/repeat become available in the development UI. Responses
are ordered by generation and native sequence; commands are serialized and
pending callbacks are discarded when an account is unlinked. An accepted Play is not
turned into playing state by JS logic. UI cleanup does not stop the service.

The runtime is the first part of the shared integration. **AuthenticatedPlayer is not
mounted, LibraryBrowser has not been retired, and the browser does not use this
new runtime yet**. Keep these limitations when reporting parity. The
synchronous AudioService contract is still the mixing one and must not be replaced.
The next cut must adapt queue actions/state and NORMAL routes to this
contract, with selection by occurrences and asynchronous operations; then extend
sources/artwork according to SLICE_2. Do not introduce AudioContext/HTMLAudio on Android.

The specific tests check commands in order, initial response/late command
versus new events, errors from another account ignored, waiting commands
invalidated, late listener released, retry after failure and stable dragged seek
with ticks. The instrumented test taps Shuffle and selects Repeat in
the real Solid before checking Media3, background and recreation.

Practical warning for the continuation: `integration` runs Gradle on the
prepared assets; after changing Solid, run `scripts/android.py build` first.
The first S2c run skipped that step and failed with the S2b controls still
packaged. The guide now shows both commands and the evidence keeps the failure.

### Next proposed cut: S2d, NORMAL queue by occurrences

Show the current program from the native snapshot (including metadata for each
entry), allow selecting/moving/removing an occurrence by index and keep
position/modes when editing another row. Extend the runtime command union,
validate generation/limits in Kotlin and observe the result; do not rebuild the whole
queue from the library for each action. Reuse the shared row presentation
without importing adapters that pull in `stores`/Web Audio; audit
`PlayerTrackList`/`MusicLinks`/`MusicListRow` before mounting them directly.

Acceptance: two rows with the same id are distinguishable in selection/removal,
moving another row does not restart the current song, removing the current one has an explicit
transition and the last row empties the program; keep modes, OS controls and
recreation, reject a late edit from another account. Test through the packaged UI
and HTTP/HTTPS fixtures, in addition to contracts and four browser profiles. This cut
does not resolve previews/podcasts/radio and does not by itself replace the whole library;
it reduces another concrete block before mounting the full routes.

### S2c final validation

Typecheck/Vitest: **1,339 tests / 144 files**. Debug/test APK and lint correct;
API 36 integration **7 pass / 0 skipped / 0 failures**, including real Solid controls
with HTTP/HTTPS and loader removed before the screenshot. Full Chromium:
**278 pass / 66 skipped**. Full WebKit, readonly/1 worker after Chromium
and without emulator: **269 pass / 75 skipped / 0 failures**. No changes to shared
sources during the suites. Central version, APK signature, absence of fixture
CA/Web Audio in the artifact, diff and internal links verified. The 49 backend tests of S2a
are not attributed again to this cut without backend changes.

[S2c evidence](evidence/s2c.json) and [visible screenshot](evidence/program-s2c-api36.png).
The evidence keeps validation metadata with dirty=true; it is not a release.
To identify the final commit: `git log --oneline --grep='asynchronous program runtime'`.

## S2d delivery: NORMAL queue by occurrences

The development UI observes metadata of all service entries, shows
their order and allows selecting/moving/removing a specific appearance. A native UUID
per entry and the order fingerprint prevent confusing duplicates or executing
a stale edit. Validation happens in PlaybackService through a custom command
private to the app UID, before editing ExoPlayer; the whole queue is not replaced.
See [S2d contract](SLICE_2.md#s2d-normal-queue-by-occurrences).

Selecting requests start/Play. Moving/removing another entry keeps position and pause;
removing the current one follows Media3 semantics, and removing the last one empties and stops. The modes
are kept, even with an empty queue, until account/origin reset. Metadata/keys
remain in the service when the Activity is recreated. There is no persistence of queue/keys.
ProgramQueue reuses the shared pure row, virtualizes and measures the real height of
rows with visible controls; it does not import the adapters with stores/audio.

Initial failures fixed: missing ResizeObserver mock in jsdom; focus lost
when moving a DOM node (even though it kept its identity); old error constants
rejected by Media3 lint. The first functional integration passed but the
screenshot showed overlapping rows while editing: the fixed estimate did not measure their growth.
The controls were separated from the shared row and each element is measured; the instrumented
test now checks rectangles without overlap. Chromium was interrupted
for this fix and its full run is repeated with frozen sources.

### Next proposed cut: S2e, library actions towards NORMAL

Add next and add to end from library/collection rows, with
native insertion commands that create UUIDs and sources from ids/metadata (without
URI/cookie from JS). Keep the existing song, position, pause/modes and keys;
validate generation, expected order and queue limit in the service. Reuse
shared menus/presentation through callbacks without importing mixing stores.
Test new occurrences of a repeated id, insertion after the current one, empty
queue, limits and rejection of an old action, plus recreation/OS controls.

S2e will continue with local files: acquisition and the real transport of previews
need a later specific cut. Do not consider full editing,
AuthenticatedPlayer routes, podcasts/radio/artwork/DJ/Live/Auto/offline resolved.

### S2d final validation

Typecheck/Vitest: **1,344 tests / 145 files**. Debug/test APK and lint correct;
API 36 integration **7 pass / 0 skipped / 0 failures**, HTTP and HTTPS verified,
real edits from Solid, incorrect fingerprint/key/generation rejected
and rectangles without overlaps. The screenshot waits for the current row/panel in the viewport
and two frames after the instant scroll. Full Chromium: **278 pass /
66 skipped**; full WebKit readonly/1 worker: **269 pass / 75 skipped /
0 failures**, after Chromium and without emulator.

During the final Chromium run only ProgramTransport was adjusted, imported by Android
and tests (not by the web graph): there was no HMR or page reload. Unit/APK were repeated
with that change. WebKit ran afterwards, with all sources frozen.
Central version, APK signature, absence of fixture CA/Web Audio, diff and links
verified. Old backend tests and the unexecuted GitHub CI are not attributed here.

[S2d evidence](evidence/s2d.json) and [visible queue](evidence/queue-s2d-api36.png).
Validation metadata keeps dirty=true; it is not a release. Final commit:
`git log --oneline --grep='edit NORMAL queue by native occurrence'`.

### S2e delivery

Add after the current one/to the end from local library and
collection rows. Uses shared menus/outlets and asynchronous commands towards the single
native player. Does not import mixing stores. Native source factory shared
with queue replacement, new UUID per entry; JS only provides metadata.
Generation/order guards and, for insertAfter, the currently selected occurrence.
Batch and total capacity are validated before mutating. An empty queue is left prepared in
pause. In shuffle "Then" is a visible position, not a promise of the next audio.
Details: [S2e](SLICE_2.md#s2e-adding-from-library-and-collections).

### S2e final validation

Typecheck/Vitest: **1,348 tests / 146 files**. Debug/test APK and lint correct;
API 36 integration **7 pass / 0 skipped / 0 failures** with HTTP/HTTPS verified.
Full Chromium: **278 pass / 66 skipped**. Full WebKit readonly/1 worker:
**269 pass / 75 skipped / 0 failures**, after Chromium and with the emulator stopped.
No changes to web graph sources during both suites. APK signature, central
version, absence of fixture CA/Web Audio, diff and local links verified.

The instrumented HTTP test initially failed because it selected the "first row": the sockets
test had added a catalog entry without a real WAV. Waiting for READY
revealed the source error. Now the test opens the menu of the fixture song by its
label and waits for prepared audio before the seek. HTTPS passed those attempts; both
pass at the end. The failure was not hidden and the position test was not removed.

[S2e evidence](evidence/s2e.json) and [menu in viewport](evidence/menu-s2e-api36.png).
The screenshot uses only the synthetic account/data of the TLS fixture. Validation metadata
keeps dirty=true and the previous base; it is not a release. The clean APK after the
commit must use that new HEAD and dirty=false. Commit: `git log --oneline
--grep='insert library tracks into native NORMAL queue'`. No GitHub CI, PR/merge or
device acoustic acceptance is attributed to these local checks.

### Next proposed cut: S2f, connection recovery of the NORMAL program

Before acquisition/previews and before retiring LibraryBrowser, define and test the
recovery of the local program when the server is lost/restored. Keep queue,
occurrences, position and pause; show a recoverable state and explicit retry without
artificial relogin or duplicated playback. Distinguish network, 401 and 403; logout
still empties before another account. Test a real stream/network cut, HTTP/HTTPS
recovery and recreation while disconnected, without turning it into offline or
audio cache. First audit the current behavior of Media3 and the datasource;
do not add unlimited automatic retry or skip certificates. Acquisition/preview,
full routes, podcasts/radio/artwork/DJ/Live/Android Auto and offline remain separate.

### S2f delivery: explicit program recovery

The snapshot separates playing from the playWhenReady intent and classifies native errors.
Retry only for connection/server, with generation/fingerprint/key/index validated against
the service's current error and occurrence; prepare keeps the queue and the
most recent intent. Pause works during buffering/failure. There is no audio retry
in background (explicit Media3 policy and OkHttp transparent retry
inactive). Certificates/handshake, source, 401 and 403 do not get that Retry.

The Activity shows the service's program even if it cannot revalidate identity;
local startup does not wait for a remote request. Refresh uses the native cookie without
reconfiguring or replacing the program. A 401 also clears if there is no resolved identity
yet; a 403 shows permission and allows revalidating with Refresh. Logout/switch
remain available and clear before another account. No library or
audio is persisted. The connected composition is used if a program exists, to keep the useful width
of the queue when identity fails. [S2f contract](SLICE_2.md#s2f-explicit-connection-recovery).

Instrumented tests: really truncated WAV read after headers, HTTP/HTTPS
verified, preservation of keys/index/position/pause/modes, absence of new
audio requests after an error, recreation with API 503, 403 revalidation without logout,
Retry with Play intent kept and a 401 stream that clears without resolved identity.
For a truncated read do not use ConnectionResetError in the fixture generator:
the engine middleware suppresses it as a client disconnect and leaves an incomplete
response waiting for timeout. RuntimeError after headers closes the body.

Failures fixed during validation: an old test assumed that the Pause label implied
isPlaying; now it can cancel the intent in buffering, so the native state is awaited
before seek. The first screenshot showed a narrow queue with the start composition
when identity was lost; connected is used and a width equal to the useful area is required.
The initial assertion forgot the scrollbar: it now uses real clientWidth and padding,
with a one-pixel tolerance, in addition to Retry inside the viewport. Partial WebKit
was interrupted for this revision; only its full repetition counts.

### S2f final validation

Typecheck/Vitest: **1,350 tests / 146 files**. Debug/test APK and lint correct;
API 36 integration **7 pass / 0 skipped / 0 failures** with HTTP and verified HTTPS
fixtures, including real truncated read, Play/pause intent, 401/403 before
resolving identity and measurement of the useful width. Final screenshot reviewed.
Full Chromium: **278 pass / 66 skipped**; full WebKit readonly/1 worker:
**269 pass / 75 skipped / 0 failures**, after Chromium and the APK/unit work,
with the emulator stopped and sources frozen. During/after Chromium its web graph
did not change and there was no HMR/page reload; the later changes were AndroidStart
(native entry only), fixtures/tests and Kotlin. Partial WebKit does not count.

Central version, APK signature, absence of fixture CA/Web Audio, fixture Ruff,
diff and local links verified. [S2f evidence](evidence/s2f.json) and
[recovery screenshot](evidence/recovery-s2f-api36.png), synthetic data only.
Validation metadata keeps dirty=true/previous base; the clean build after
the commit uses that HEAD and dirty=false. Commit: `git log --oneline
--grep='recover native program after connection loss'`. Backend checks
from other slices, GitHub CI and physical acceptance are not attributed. No release/alpha.

### Next proposed cut: S2g, program covers and notification

Complete metadata/artwork of the native occurrences and of the media session,
reusing engine covers. Create the image source from the id in native code;
do not send cookies/engine URI from JS or use a public fetch for a private image.
Validate generation/origin, byte/decoding/time limits and cancellation;
prevent late responses or cache from showing a previous account. Placeholder
when the cover is missing or the server fails; an artwork failure does not cut audio or require
login because of an image 404. Test real HTTP/HTTPS images, duplicates/change of
occurrence, Activity recreation, logout/account switch, missing/invalid image and
notification/MediaSession on the emulator. First audit DefaultMediaNotificationProvider
/BitmapLoader and the exact APIs of the pinned version. Do not present the notification as
an Android Auto catalog or physical acceptance. Full UI/routes, acquisition/previews,
podcasts/radio/DJ/Live, process death and offline decision remain pending.


### S2g delivery: private program covers and notification

`ProgramQueue` creates artworkUri from id/generation. `ProgramArtwork` is the native BitmapLoader
of MediaLibrarySession: private cookie/origin, private HTTP/verified HTTPS,
without redirects or public fallback. Two workers/16 queued jobs; 8 seconds,
2 MiB, dimension inspection up to 16 megapixels and sampling to 512 px. It retains
only the last future in memory; reset cancels HTTP/futures and discards the result.
Errors do not clear the session or change the player. The URI/bytes/cookie do not return to JS.
The program/queue UI reuses covers/gradients and the private proxy from S1, now with a
body limit and generation revalidation during reading/before the response.
[S2g contract](SLICE_2.md#s2g-private-cover-art-for-the-program-and-session).

The instrumentation verifies the Android session bitmap and the notification large icon
with a real private cover, in addition to HTTP/HTTPS, duplicates, Activity,
focus and the existing recovery cases. A separate image loader fails
with audio active without changing index/playing/error or clearing the cookie. Images from
another account never show its private color; an engine placeholder or a
rejection is accepted. 404, invalid bytes, excessive body and logout during a slow
response, followed by login of another account, are tested. There is no physical lockscreen/Bluetooth test,
and no Android Auto catalog. The correct metadata/notification image does not demonstrate
acoustic sound.

The first run failed in four assertions because it required exact RGB for the synthetic PNG:
the engine generates a JPEG thumb, with one-point differences per channel. The
assertion was fixed to tolerate up to three points, keeping account discrimination.
The expectation for a foreign image was also adjusted: the endpoint can respond with a
placeholder, not necessarily 404. The final review extended the privacy test
to channels with the same tolerance and released references to cancelled jobs.

### S2g final validation

Typecheck/Vitest: **1,350 tests / 146 files**, no failures. APK/test APK/lint and
API 36 integration: **9 tests, zero failures/errors/skipped**, HTTP and HTTPS verified
with earlier S1/passwordless cases kept. Full Chromium: **278 pass /
66 skipped**; full WebKit: **269 pass / 75 skipped**, no failures. UI sources
frozen before unit/Chromium and APK preparation; later changes only native,
instrumentation and documentation. WebKit ran after all native work and Chromium,
with the emulator stopped, read-only mount and one worker. GitHub CI was not run.

Ruff/check/format, central version synchronization, diff and local links pass.
Normal APK signed, without fixture CA/resources; native JS still has no AudioContext or
mixing runtime. [S2g evidence](evidence/s2g.json) and
[queue screenshot](evidence/queue-artwork-s2g-api36.png) with synthetic data. The JSON
records the dirty validation build on the previous commit; the normal APK is
regenerated clean after the commit of this cut. No artifact is a release.

### Next proposed cut: S2h, explicit closing of the native program

Starting point: `PlaybackPlugin.command("stop")` does stop/clear from the controller
and resolves an immediate snapshot; it does not yet reset playWhenReady/modes or confirm the
mutation through the service's custom command. `ProgramArtwork` retains the last
result until reset/destroy. Add a visible action to close the program,
with asynchronous confirmation from the service and cleanup of the loader without switching account. Empty sources/occurrences,
reset intent/modes, remove metadata/cover/notification and release resources
without clearing login or library. It must work even with the API unreachable and must not leave
a queue that reappears when the Activity is recreated; a later activation creates another
program with new keys, without autoplay coming from an old intent.
Review the pinned Media3 APIs for empty state/foreground/notification, and the
semantics of removing the task from recents versus closing the program. Test UI +
MediaController + notification with Play, pause, buffering/error, server 503,
recreation and new playback, without introducing persistence/process death or
assuming untested swipe behavior on a phone. Keep focus/noise
with their documented physical acceptance limits. This cut is still a
development cut: full routes, acquisition/previews, podcasts/radio, DJ/Live,
Android Auto and the offline decision remain pending.


### S2h delivery: explicit program closing

× in the Solid header, with a localized aria-label and 44 × 44 px, sends stop with
queueToken/generation. The service's custom command validates the own UID and the queue;
it does not require REST or a cookie to close. It pauses, empties sources/occurrences, resets
modes/intent/error and cancels audio/artwork; the plugin waits to see the empty state
over IPC before resolving. Identity, session or library are not changed. The empty
snapshot uses index -1 and zero metadata/progress. Media3 removes the notification because of an empty
timeline; the session/player is kept while controllers are bound.
[S2h contract](SLICE_2.md#s2h-explicit-program-close).

The pinned APIs/JARs of MediaSessionService,
MediaNotificationManager and ExoPlayerImpl were inspected. Stop retains a previous error: after emptying,
prepare without sources and another stop clear that error without network or autoplay. The bitmap
loader has a clear independent of the account to cancel jobs and discard its
last result. The audio client is cancelled and evicts idle connections. The
account connection and library reading remain independent of the program.

Instrumented closing from Play, pause, delayed audio headers and 503 error,
with the API returning 503 in each case. Queue/UI/notification and Android metadata/artwork
are left empty; cookie/generation do not change. Activity recreation does not rebuild the
queue. An obsolete fingerprint is rejected. A later append creates new keys, stays
paused and uses default modes; an explicit activation from the library plays
again. Delayed audio responses do not resurrect the program.

Recents is not equivalent to closing the program. onTaskRemoved is not modified: in the pinned
version it requires foreground and isPlaying to keep it; otherwise it calls
pauseAllPlayersAndStopSelf. The finishAndRemoveTask/reopen case on API 36 keeps
playing/key and then allows closing, with an instrumentation controller bound.
It is not a physical test of swipe/lockscreen/headphones/Bluetooth, nor of process death or
manufacturer policy. Persistence/offline and publishing were not implemented.

The initial failures were resolved without removing acceptance: the startup helper
without a server was not valid for configured recreation; stop really retained the
error and it was fixed; the 320 px screenshot showed the title narrowed by the controls,
and the header was split. Then the S2f recovery test depended on modes inherited
from stop: it now configures shuffle/repeat before interrupting, keeping its
preservation assertions. The full suites are repeated after the final UI change.

### S2h final validation

Typecheck/Vitest: **1,351 tests / 146 files**, zero failures. APK/test APK/lint and
API 36 integration: **11 tests, zero failures/errors/skipped**, HTTP/HTTPS verified
and S1/passwordless cases kept. Full Chromium: **278 pass / 66 skipped**;
First S2h WebKit suite: **268 pass / 75 skipped / 1 failure** in the mobile queue menu.
The case passed three times in isolation without source/assertion changes; the final full
repetition passed **269 / 75 skipped / zero failures**. The cause of the initial
timeout was not confirmed; the evidence keeps it and does not present it as a fixed bug.
The green count had been written before verifying the first summary and was
corrected before the push. The final unit and
Chromium suites ran after fixing the header; later changes only
instrumentation/documentation. WebKit ran after all native work and Chromium,
with UI sources frozen, emulator stopped, read-only mount and one worker.
GitHub CI and acoustic/physical acceptance were not run.

Ruff/check/format, central version, diff, local links and APK signature pass. Normal
APK without fixture CA/resources; native bundle without AudioContext/mixing runtime.
[S2h evidence](evidence/s2h.json), [header/closing](evidence/close-open-s2h-api36.png)
and [closed with API unreachable](evidence/close-unreachable-s2h-api36.png), all synthetic.
The JSON records the dirty build on the previous commit; after the commit the
clean normal APK is regenerated with its source_revision. No release/alpha.

### S2i proposal (implemented below)

First vertical for saved songs that today are shown but not played.
First audit the real sources/ids of Track/source=preview and the current contract
`/api/preview/stream/<video_id>`, prefetch/status/cancel and progressive-preview of the engine.
Introduce a source discriminant in ProgramTrack/native metadata, keeping
occurrence UUIDs and selecting by index even with mixed local/preview.
Native builds the source from a validated id; it does not receive URL/CDN/cookie from JS, and does not
use stream-url to send the engine session to an external provider.

Reuse the engine's current preparation/errors/transitions: cancellation by
queue/generation/closing, real pending preparation without faking playing, progress and
Range over the proxy, 401/403/429/503 and bounded Retry without replacing the program. Remove
the preview disabling only for the flow that is really validated. Keep
safe covers/placeholder and do not extend acquisition, podcasts/radio or DJ by
assumption. Test the real engine route with an isolated synthetic provider, full/progressive engine
cache, duplicates/mixing, Activity/background/closing and verified HTTP/
HTTPS. Fixtures do not test a live provider or physical listening. No
temporary engine cache implies approved Android offline; the decision remains open.


### S2i delivery: saved previews in the native program

The library allows playing saved songs with source preview and mixing
local/previews without losing the occurrence index or UUID. The shared descriptor
only accepts metadata and id; the service builds the engine proxy and keeps
cookie/origin/TLS in native code. It does not request stream-url or send credentials to the
provider. Program, queue and Android metadata use a placeholder for preview.
[S2i contract](SLICE_2.md#s2i-previews-guarded-by-the-engine-proxy).

The service observes real preparation of the current preview with one request in flight,
extras associated with generation/UUID and playing state exclusively from Media3.
It stops polling when ready/unavailable, error, change or closing arrives; cold is only
polled while the player is still buffering. Cancelling removes only its own readers and
waits. Audio registers open bodies until callEnd/callFailed; Activity
recreation does not cancel the program. Seek reflects isCurrentMediaItemSeekable.

429/503 allow two retries started within thirty seconds of the first
failure, respecting Retry-After and keeping the pause intent and the queue. When the
budget is exhausted an explicit Retry appears, disabled during cooldown. Play goes through
the service's custom command with index/UUID/token/generation; the
Prepare/Play guards and selection of the same occurrence also prevent skipping cooldown.
Local files keep the previous policy.

The instrumentation uses real engine routes/cache/Range and a localhost provider
with synthetic indexed MP4 AAC, fragmented MP4 and WebM Opus. An initial MFRA
read at the end of the progressive spool that blocked the fragmented extractor was fixed:
only progressive responses use that extractor without tail reading; complete
files keep the normal index. A Play that initially
prepared before validating cooldown was also fixed. Both regressions are covered. The
adjustments to startup/recreation and UUID helpers and the wait for cache commit
keep the assertions: reader EOF does not mean the commit is finished.

### S2i validation

Typecheck/Vitest: 1,355 tests, 146 files. Native Retry: two unit tests.
Python: 57 route/cache/fixture tests, including the real engine and shared readers.
APK/test APK/lint and API 36 integration: 13 tests, zero failures/errors/skipped,
with HTTP, verified HTTPS and passwordless. Sources frozen in the final pass.
Full Chromium: 278 pass / 66 skipped. Full WebKit: 269 pass / 75
skipped. Zero failures; sequential run, emulator stopped, WebKit with read-only
mount and one worker. [S2i evidence](evidence/s2i.json).
The integration removes its temporary CA and rebuilds the normal APK when it finishes.
After the commit it is generated again from a clean HEAD and source_revision is verified;
the evidence JSON records the instrumentation build on the previous commit.
No GitHub CI, live provider or acoustic/physical acceptance was run.

### Next proposed cut: S2j, search and explicit saving of songs

Audit the real search/acquisition and Library contract before extending the UI.
First bounded vertical: search songs on the selected engine, distinguish
local/preview results, explicitly save a song and play it through
the same native program. Reuse the sanitized descriptor, occurrence identity,
proxy and S2i guards; do not introduce another player or speculative acquisition.
Define empty states, cancellable search and obsolete responses by query and
generation; check permissions/errors and that saving does not confuse a bookmark with
local acquisition. Validate the packaged UI and real routes with a synthetic fixture,
HTTP/HTTPS, duplicates and account switch. The current authorization allows continuing
this scope and reviewing the pending parity in PORT_PLAN.md without asking again for
approval of each cut. Podcasts/radio, DJ/Live and Android Auto remain open.
Offline B is approved; S6a is implemented before continuing S2j.
S2i is a development artifact, not a release or a public alpha.


## S6a delivery: Available offline

Implementation pushed as `724a67f` on `feat/android-port-foundation`. Explicit
copies of acquired music from song/collection menus; manager and local
filter in the library menu. There is no preparation in shells and no acquisition of
previews. SQLite/private files, quotas/reservation, media/hash verification,
worker/foreground service and cancellation by account/generation/ticket. NORMAL uses
the same Media3 through OfflineDataSource. See [S6a contract](SLICE_6.md).

Offline HTTP/HTTPS checks a deduplicated batch, unreachable engine, playback,
seek/pause/closing, Activity recreation, limit, partial/invalid file,
cancellation without resurrection and local logout. The persistent protocol installs
APK/tests **once** and uses `am instrument` in two phases with `am force-stop` between
them: it restores profile/copy, plays without API and detects corruption of the same
size. `connectedDebugAndroidTest` uninstalls when it finishes; it cannot be used to retain
data between phases. A finally block that used transport after forgetting the origin
initially hid that reinstallation; both test problems were fixed.

S6a validation: typecheck/Vitest **1,363 tests / 149 files** at the offline
checkpoint; **59 Python** (58 routes/cache and one real fixture). **4 native
unit tests** (two for retry and two for socket repair). Full main suite
API 36: **15 tests, zero failures/errors/skipped**. Corrected restart protocol:
**two phases of one test, zero failures**, via `scripts/android.py integration
--offline-restart-only`. The helper keeps the main suite XML separately
and logs/result.json of each phase. Normal APK/test APK/lint pass and do not carry a temporary
CA. [S6a evidence](evidence/s6a.json). The four browser suites will be repeated
before the cumulative PR required by AGENTS; do not reuse S2i as the S6a result.
GitHub CI, physical listening and car acceptance were not run.

The full pass found an ETag bound to mtime/LRU in previews and an EOF on a
reused TLS socket before headers. The proxy now uses a stable commit/
remux revision; it accepts old caches without a validator. Audio allows a new GET
exchange only for that EOF on a reused connection, never for body/timeout/TLS/
cancellation/HTTP error. That repair was observed in the full pass; cooldown
and the 429/503 budget remain covered. Details and limits in SLICE_6.

Instrumentation build: metadata of the previous HEAD (`ccec0f9`), `dirty=true`;
do not present that APK as a clean release build. It will be rebuilt from a clean
HEAD after closing the next cut. S6a does not close parity or enable alpha.
Current authorization: continue S2j and the full matrix, push progress; then
open PR with checks passing for manual review; no merge or automerge.


## S2j delivery: search and explicit saving

The authorized continuation implements Discover for songs: selected catalog,
local/direct/pending-resolution results, bookmark/removal confirmed
by the API and native playback. `catalogTrack` is a pure function shared with
web, with the same earlier catalogItem exports. The web player is not imported.
The Saved identity index and resolved links recognize the current preview and avoid
rematching. The last query/action/account prevails; menus capture their context.
Do not acquire files, add speculative sources or offer offline search.
[S2j contract and acceptance](SLICE_2.md#s2j-search-and-explicit-saving-of-songs).

Final validation: **1,373 tests / 151 files** of typecheck/Vitest; **60 Python
tests** of routes/cache and fixtures; **4 native unit tests**. API 36 APK suite:
**17 main tests and two restart phases**, zero failures/errors/skipped.
HTTP/HTTPS walkthroughs: search, play, save/remove, Library, switch account
without leakage and recover 403 with Retry. Normal APK/test APK/lint pass after removing
the ephemeral CA. Full Chromium: **278 pass / 66 skipped**; full WebKit:
**269 pass / 75 skipped**, sequential run, one worker and readonly mount.
[S2j evidence](evidence/s2j.json). No CI/live provider/device/car accepted.

The first full pass detected fixture interference: playing Saved
prepared the next song B and the preview test expected a cold cache. The
test control now clears only the known synthetic entries and rejects
cleanup with active fills; PreviewTest requests that initial state. The
buffering/progressive assertions are kept, without changing the real cache policy.
The full repetition passes. Instrumentation metadata: previous HEAD, dirty;
regenerate the normal APK from a clean HEAD after the commit.

Next vertical after closing S2j: podcasts and radio in the same service,
with real resume/±15s and sources authorized by the engine; first inventory the current
contracts and actions. Entity discovery, acquisition/import,
settings/editing/lyrics/handoff, DJ/Live/Auto and signing/update remain open.
The user requires keeping full parity before integrating/publishing alpha.


### S2k: podcasts, implemented below

[End-to-end contract and acceptance](SLICE_2K.md); results below.

First, subscriptions and episodes through the real engine routes, authorized proxy
playback in the same Media3, resume and ±15s. The service must save
progress in background and isolate it by origin/account and stable episode identity;
completed episodes restart from zero. GUID/enclosure are not preview video IDs.
Do not accept an arbitrary URL or forward the engine cookie to the provider: use tokens
minted by the engine and build the internal source there. Include cancellation,
Range/seek, Activity recreation, account switch and token expiration with a
synthetic provider; do not weaken SSRF for the fixture. The library must keep
the identity of acquired episodes in addition to songs.

Radio means NORMAL music recommendations (`startRadio` and
GeneratedQueueController), not internet stations. After podcasts, keep
the seed that is already playing and the manual insertions when activating that planning;
do not depend on WebView timers in background. Direction/DJ/Live remain pending.


## S2k delivery: episodes, resume and ±15s

First podcast vertical implemented: real subscriptions/episodes, refresh/
pagination, authorized proxy streaming in the same Media3, private progress of the
service in background, enclosure/feed/GUID aliases and ±15s controls from the native
position. The library keeps acquired episodes separate from music: the engine does not
retain the enclosure in Track; it is joined by feed/GUID and the descriptor is enriched from
RSS. Acquired file and streaming share progress; completed restarts at zero.
The snapshot does not deliver audio tokens/URLs. Each range/open mints a fresh token.
Offline B copies remain limited to music. See [S2k contract](SLICE_2K.md).

Validation: typecheck/Vitest **1,380 tests / 153 files**; **6 native unit tests**;
**109 Python** for preview/cache, podcasts/RSS/tokens/reader and fixtures. The
podcast fixture test was repeated after adding the acquired copy: it also passes.
API 36 main suite: **20 tests, zero failures/errors/skipped**, plus **two persistent
offline phases**. After extending aliases/recovery and the acquired test,
**three final podcast tests pass** (HTTP, verified HTTPS and native store).
They check resume after recreation/closing, ±15s and limits, pause during 503
recovery, switching from streaming to the acquired file with progress, profile isolation,
completion when duration is removed and a provider without cookies. Normal APK/test APK/lint
pass and the temporary CA is removed. [S2k evidence](evidence/s2k.json).

The last four full browser suites are S2j; they must be repeated on the
final HEAD before the cumulative PR. Do not present those tests as validation of the
podcast APK or mark CI/live provider/phone/car as accepted. Instrumentation
build on the previous HEAD, dirty; regenerate a clean APK after the commit.
The helper now archives filtered tests in integration-targeted/<class>, without
replacing the full suite or its restart phases in integration-results.

Verified fixes: DataSource must allow reopening after close for seek,
without reviving a cancelled occurrence. The proxy closes the upstream Response on end/cancel/
failure. Tests initially expected a shell without a server after recreating the session and then
tapped the queue row with the same name; they now wait for Library and select within
PodcastBrowser. The acquired fixture required album in the real model; it was fixed,
with a Python test of the file/range. Assertions and SSRF were not weakened.

Next authorized work: extend podcasts with directory and follow/unfollow,
real acquisition/progress and episode actions; then NORMAL Radio.
Continue without closing the turn at a checkpoint. DJ/Live/Auto, full UI/actions,
signing/update and the other PORT_PLAN rows remain requirements before the
open PR for manual review. No partial alpha has been published and nothing has been integrated into main.

## S2l: podcast directory and acquisition

[S2l contract](SLICE_2L.md). Implemented: search, RSS without implicit subscription,
confirmed follow/unfollow and durable acquisition with failure/retry/cancel from
three-dot menus. Unfollow keeps files. Streaming and acquired share
progress. A GUID without a matching feed/RSS never joins different shows. The queue removes
completed items: refresh Library when they disappear, confirm the file there.
Observation is aborted on disconnect and resumed on reconnect.

Local results: UI **1,387 tests / 154 files**; Python **44 tests** of pump,
recovery, persistence, podcasts and the real acquisition fixture. Two HTTP/
HTTPS directory APK tests pass. Main regression: **22 tests, zero failures/skipped**
according to TestRunner, plus **two persistent offline phases** that pass. The helper
finished correctly and removed the temporary CA. Its normal build already included Radio
sources under development: it is not a clean APK of the S2l commit and does not validate Radio. The last full browser runs are still S2j.

Ruff check passes. Format check of fixture/test passes; shared/api/__init__.py has
historical formatting outside the change, and it is not reformatted entirely for this slice. Its
change closes the upstream Response of the podcast downloader through a context manager.

Active continuation: native NORMAL Radio. Do not close at this checkpoint. No PR has been
created, main has not been integrated and no release has been published; full parity remains mandatory.

## S2m: first native NORMAL Radio vertical

[Contract and pending items](SLICE_2M.md), [evidence](evidence/s2m.json).
Real planner `/api/discovery/music/plan`, service owner, stable seed,
lookahead and cancellation by account/closing/replacement. Activating on the current one keeps
occurrence, pause and position. Manual append goes ahead of recommendations;
Stop Radio removes only its future occurrences. The snapshot distinguishes recommendations.
Preview/radio extras coexist. Replacing the queue is done in the service and observed
over IPC with a new token even if the IDs repeat.

Validation: UI **1,389 / 154** before S2n; Python **14** planner and real fixture
with synthetic acquisition/Range stream. APK **three tests** (HTTP, verified HTTPS,
bounded decoder). Main regression **25 tests, zero failures/skipped**, plus **two
persistent offline phases that pass**. The final Radio test checks an initial 503 failure,
retry with Activity CREATED, return/recreation, seed/pause/seek kept,
deduplication, manual append ahead and Stop Radio keeping the two manual
requests. Do not confuse this vertical with fully accepted Radio/autoplay:
automatic refill after advancing, full profile/UI, extended recovery/cancellation
and live provider remain pending. DJ/Live/Auto keep their gates.

The first failures were in the setup: transport before configuring the origin, then
a command before the first snapshot. The real ready state was awaited. The fixture
stats endpoint had a repeated Flask name: radio_stats is now unique. The assertions
were not weakened. Normal APK/lint are rebuilt without the temporary CA; while S2n
is in progress the tree/build are dirty, not a clean release artifact.

Active S2n continuation: explicit favourites, row filter/states and playlist
picker without the web audio runtime. Its **37 backend tests** and **1,395 /156 UI**
pass before the last prompt guards. APK still pending. Its sources
are separate from the S2m commit; do not consider actions accepted only because of scaffolding.
Continue until parity and then open the PR for manual review as authorized; do not finish at
this checkpoint or change the requirement to a partial alpha.

## S2n: favourites and playlist membership validated

[Contract](SLICE_2N.md), [evidence](evidence/s2n.json). PUT favourites with explicit
and idempotent intent; the earlier toggle keeps its contract. Unmarking a deleted
song does not save it again. Acquired songs do not need to resolve another
video when marked. Shared rows and the favourites filter reflect the confirmed snapshot.
The create/add picker shares styles/texts, confirms the ID in the playlist and refreshes
before closing; a preview is saved by identity without acquisition. A replaced account
aborts the picker and closes the prompt; captured callbacks do not migrate.

UI **1,396 tests /157 files**; Python **44** manager/promotion/routes; APK **two
HTTP/verified HTTPS**, including favourite/unmark/filter, file kept,
playlist created with a confirmed ID and owner without the member's playlist. There is no HTML
audio. Normal APK/test/lint passes without temporary CA. The last full regression is still
S2m **25 + two restart**, prior to the S2n APK; full browser runs are still S2j.
Repeat both on the final head before the PR. Build source_revision previous,
dirty: not a clean artifact or release. The favourite filter does not persist mark metadata
on cold offline startup; do not confuse it with S6a music copies.

Continuation: full playlist management/actions, full Radio/autoplay and
the rest of PORT_PLAN parity. Keep commit/push on the branch per validated work,
continue without ending the turn at a slice. Open PR for manual review only when the gates are closed.

## S2o: playlist management validated

[Contract](SLICE_2O.md), [evidence](evidence/s2o.json). Rename/duplicate/delete,
persisted order and acquired cover in menus. Filtered rows keep the
original occurrence even if they repeat an ID. New editing routes require a captured
snapshot; 409 keeps concurrent changes and old engines do not receive an
unconditional fallback write. The whole payload is validated before modifying.

UI **1,400 tests /159 files**, Python **149**, APK **two HTTP/verified HTTPS**
pass. The walkthrough confirms membership and order on the server and on screen before
capturing the next operation. The first failures were test observations
made before the refresh: adding a song and sorting returned before the UI
was updated; the CAS guards are kept. The AutoMode test left a timer after teardown:
the fixture now drains timers and cleanup, without modifying the product gesture; commit
`1e1f2fe` pushed separately. The UI repetition has no uncaught errors.

The last full APK suite is still S2m 25 + two restart phases; full browser runs S2j.
Repeat on the final head before the PR. Instrumentation dirty/previous HEAD, not a release.
Active continuation: profiles/refill/cancellation of NORMAL Radio, autoplay and the rest
of the matrix. Do not finish at a checkpoint; the open PR for manual review requires full parity.

## S2p: Radio profiles and background refill

[Contract](SLICE_2P.md). The current song menu adds Familiar/Balanced/Explore
with observed selection; replanning keeps current and pause. The UI command sends
key and the service rejects an old occurrence even if the queue token stays the same.

UI **1,401 tests /159 files** passes. APK **two HTTP/verified HTTPS** pass in
`/tmp/soundsible-s2p-native-observed.log`: advance to the threshold, Activity CREATED,
planner/refill without WebView, growth without new duplications, return to the seed,
Explore from the real menu, pause/key kept, stale command rejected, Stop
Radio keeps three manual occurrences. Do not confuse an intentionally duplicated manual append
with duplication of recommendations.

Fixes from the walkthrough: periodic snapshots could capture a token from before
the planner's initial response; the helper queries fresh state before commands
and fails immediately on rejection. Explore can return `degraded` with
valid local recommendations: check candidates in addition to ready/degraded.
evaluateJavascript strings are JSON, not unquoted text. A pass under
load left the WebView unresponsive; the sequential repetition reached the real
diagnostic and the final one passes. Write guards are not weakened and success is not invented.

The previous full suite is still S2m 25 + restart2; browser S2j. Instrumentation
on S2o HEAD dirty, development. Continue [S2q autoplay](SLICE_2Q.md) and the full
matrix; no checkpoint ends the authorization for an open PR for manual review after parity.

## S2q: first NORMAL autoplay vertical validated

Dirty sources after S2p `e059b85` (pushed). [S2q contract](SLICE_2Q.md).
AutoplayProgram loads/writes the real preference in a native worker, serial/
generation guards, moving seed, manual threshold, repeat/podcasts/Radio, manual priority and
closing. RadioProgram shares intent/decoder/retry without sharing the session; a short
batch checks the runway again. The queue distinguishes Autoplay/Radio, setting in the
program three-dot menu and observed response. Deterministic fixtures set the
preference to false per account; the product default is still true.

UI **1,402 /159**, four real Python fixtures and Ruff pass. APK two HTTP/HTTPS
pass in `/tmp/soundsible-s2q-native-confirmed.log`; real menu, manual threshold,
background refill, confirmed disable, repeat, Radio and closing. Normal APK/lint
without CA also passes. Final full suite **31, zero failures/skipped**, plus **two persistent
offline phases that pass**, log `/tmp/soundsible-s2q-native-main-final.log`. Normal APK/test/lint
passes without temporary CA. The first suite had two PlaylistManagement failures:
Move up assumed there were only two lists, but LibraryActions created a third one.
It now observes the previous position and verifies swap/preservation; the full
repetition passes. The last full browser run is still S2j; repeat before the final PR.

The tests fixed the use of the index before observing the runway and the expectation of
enabling autoplay with three future manual requests: the guard was correct.
The repeat case advances first to isolate that policy from the manual threshold. Remaining:
podcast/cancellation/account with a pending planner and extended recovery before
calling autoplay complete. [S2r metadata](SLICE_2R.md) is the next contract,
not implementation. Continue without finishing at a checkpoint until parity and the open PR for manual review.

Active S2r continuation: metadata form extracted without stores/web audio and
Native REST adapter, not yet connected to program/shell. Typecheck and three
presentation tests pass; Native metadata/artwork and APK walkthrough pending.
These files do not belong to the S2q acceptance APK or to the autoplay commit.
Keep separate commits and continue until parity/open PR for manual review as authorized.


## S2r: first metadata/covers vertical

[Contract/evidence and pending items](SLICE_2R.md). Shared visual editor without stores
or web audio, REST adapter captured per account, metadata update in
Media3 preserving sources/occurrences and offline labels in SQLite. Two APK tests
HTTP/HTTPS pass on WAV; UI 1,405/160 and Python 49 pass. Real multipart and private
bitmap confirmed; a synthetic File does not accept the OS picker. Fix WAV metadata/artwork
sidecar and null album_artist fallback.

**It is not full editing yet**: formats with tags can rehash/change ID
with the historical routes. Continue with an editing contract that preserves audio/ID
and tests of formats with tags before closing this row. Last full APK
S2q31 + restart2; browser S2j. No open PR for manual review until the full matrix; continue
without finishing at a checkpoint. Instrumentation dirty/previous HEAD, development.


## S2s: editing that preserves audio/identity

[Contract and evidence](SLICE_2S.md). New track-labels routes edit canonical and
sidecar without tags/rehash. Android requires storage=library and the original ID; old
engines fail explicitly without a destructive fallback. Resolves the limit of
formats with tags noted in S2r. UI 1,409/161; Python 66 + four fixtures pass;
APK FLAC and WAV, HTTP/HTTPS, four walkthroughs pass with audio SHA-256 preserved.
Normal APK/lint without CA pass. OS picker and extended APK acceptance pending.

Instrumentation sources dirty relative to S2r; regenerate from a clean commit and
repeat main suite + restart. Last full browser runs S2j; repeat four
profiles before the PR. Library/entities parity, DJ/Live/Auto,
signing/update continue; do not consider the matrix complete or publish a partial alpha.


## S2t continuation and S2s regression

Commits S2r `76099a2` and S2s `1cce3ca` pushed. The S2s main suite on assets
prepared from a clean HEAD finished **33 tests, one failure, zero skipped** in
`/tmp/soundsible-s2s-main.log`; it did not reach the restart phases or the normal rebuild.
The HTTP CatalogSearch failure opened a menu with Save after confirming Saved on the
server: a concurrent refresh could return without waiting for the snapshot that replaced it.
Do not weaken the assertion. The last fully green regression is still S2q31+restart2.

Fix in development: createAccountRefresh coalesces by epoch and waits for the
queued observation; the previous account does not requeue or release the current one. Two
contract tests pass. [S2t](SLICE_2T.md) adds bookmark actions for acquired album/artist,
shared pure identity helpers and a saved-entities snapshot per account; it does not save
songs or files. UI **1,416/163**, Python saved-entities **15** pass.
Joint CatalogSearch + EntityBookmarks APK walkthrough in progress; repeat main
and restart after fixing all its failures. Do not present S2t as validated yet.
Authorized to continue until the full matrix, open PR for manual review; do not finish per slice.


## S2t: acquired bookmarks validated

[Contract and pending items](SLICE_2T.md), [evidence](evidence/s2t.json). Save/Remove in
album/artist menus and header with library identity. Private snapshot per account,
same pure identity as web, without saving/acquiring songs or starting audio.
UI **1,416/163**, Python **15**, APK **four HTTP/HTTPS tests of EntityBookmarks and
CatalogSearch pass**; normal APK/test/lint without CA passes. Refresh fixed and pushed
separately `190c5b4`; the Saved assertion was not weakened. The initial bookmark failures
were an unconfigured wait after recreate and a checkmark included in textContent.

Repeat main/restart now: the last full S2s33 had a Saved failure, the last
green S2q31+restart2. Full browser S2j runs are still not equivalent to the current HEAD.
Pending: external entities/bookmark lists/Discover navigation, real OS
picker, remaining library, DJ/Live/Auto and signing/update. Do not close the turn
at a checkpoint or publish a partial alpha. Instrumentation dirty/previous HEAD.


## Fixture auth isolation, continuation

The S2t35 main had a LibraryActions HTTP failure: owner login received 429
because of the budget accumulated by earlier cases. Repro Connection+EntityBookmarks+
LibraryActions **8, one failure**, status audit confirms 429; repetition with
FixtureIsolationListener **8, zero failures/skipped**, normal APK/lint without CA passes.
[Details and commands/evidence](AUTH_FIXTURE_ISOLATION.md). Real Python proves that
10 failed attempts→401, next→429, unauthorized reset does not alter the limit,
authorized fixture reset allows login. It does not change production protection.

The integration helper installs a listener to reset only auth_login between cases;
it does not delete accounts/cookies/queues/copies and leaves offline restart with its protocol.
Run main/restart again on the final HEAD. [S2u](SLICE_2U.md) OS
picker is still a contract/draft (reproducible draft in docs/internal/android/drafts/CoverPickerTest.java),
not accepted; move it to androidTest and test it after closing this regression.
Continue until full parity; open PR for manual review still pending.


## Final S2t main regression

On assets prepared from clean HEAD `cf01599`, the final repetition of
`/tmp/soundsible-s2t-main-isolated.log` passes **35 main tests, zero failures/
skipped**, plus **two persistent offline phases** after force-stop. The helper finishes
correctly, removes the CA and the normal APK/test/unit/lint rebuild passes. Do not confuse
this result with the S2s33/S2t35 main runs that failed before the fixes.

Next work: move the S2u draft to androidTest and validate the real OS picker (tap,
Back, content URI/bitmap). Also review artwork priority: the installed Media3
BitmapLoader prefers embedded artworkData over artworkUri, which can hide
an edited sidecar without rewriting audio. It needs a metadata/cover test with
FLAC audio that carries embedded artwork and media session verification before considering
that case accepted. It is not fixed yet; do not call parity complete.

The cumulative diff detected a final blank line in catalogTrack inherited from S2j; removed
without changing logic. Full browser runs remain S2j until the repetition before the PR.
Continue until all parity gates, then open the PR for manual review as authorized.


## S2u real OS picker

[Details](SLICE_2U.md). Instrumentation now in androidTest, draft removed. Two
HTTP/HTTPS cases pass: real tap, Back without writing, selection of the private PNG
seeded through MediaStore, normal content grant and bitmap received by the engine.
Photo Picker darkens/resamples the thumbnail and animates its sheet: identify the
green/magenta pattern by geometry, reject ambiguity and require stability before the tap.
Do not extend permissions or simulate callback/File. A later lint asked for @SdkSuppress
instead of @RequiresApi; fixed. Normal APK/test/unit/lint without CA pass
in /tmp/soundsible-s2u-normal.log.

Sidecar priority over embedded artwork closed later in S2v; see the last
section. The remaining matrix and publishing remain pending.


## S2v sidecar and embedded cover

[Contract/evidence](SLICE_2V.md), [record](evidence/s2v.json). ProgramArtwork gives
priority to the private URI over embedded; an expired generation fails without fallback
to the previous image. Without a URI it keeps embedded; without both, null. Four real
HTTP/HTTPS FLAC tests pass, including edited green in the media session and SHA-256/ID/
queue/position/copies preserved. Normal APK/test/unit/lint without CA passes.

The FLAC fixture now contains an embedded cover and Radio copies the real format; Python
WAV/FLAC two tests pass. The first attempt assumed artworkData in the merged metadata
of the MediaController: it can be omitted when the app provides a URI. The FLAC source
is verified with MediaMetadataRetriever and the system session separately.

Shared timed lyrics completed later in S2w. Continue library actions,
Discover/acquisition/import/Settings, DJ/Live/Auto and release gates. Last full
main S2t35+restart2; after S2u/S2v an extended final regression is needed.
Do not close per slice; continue until the open PR for manual review with full parity.


## S2w shared native lyrics

[Details](SLICE_2W.md), [evidence](evidence/s2w.json). Web LyricsPanel adapter
with the same stores; audio-pure LyricsPanelView with injected track/position/seek
and abortable requests. Android opens it from the program menu, own scroller,
no podcasts, no offline action. The panel closes when the account/program changes.

UI 1,419/164 passes; two HTTP/HTTPS cases on API36 pass for acquired and saved preview:
seek 20s, highlight/aria-current, pause/keys/token preserved, closing/logout without
previous panel/program. A preview in Library is not acquired: metadata lookup with
sourceKind verified or unverified; unverified only text without timings. The fixture
uses the real cache DB, not an IPC mock. Logs /tmp/soundsible-s2w-ui-preview.log and
/tmp/soundsible-s2w-native-preview.log. Assets dirty from 9bc041d. Normal APK/test/unit/lint without CA passes. Live/physical LRCLIB provider pending.

Acquisition from previews completed later in S2x; see the last section. Keep identity in playback when promoting
a preview to acquired; do not replace occurrences or start another output. The rest of
Discover/import/Settings/share/multi-device, DJ/Live/Auto, signing/update
and release gates remain pending. Do not close the turn per slice.


## S2x acquisition and promotion without changing occurrence

[Contract](SLICE_2X.md), [evidence](evidence/s2x.json). Download menus in Library/
Search, real queue with shared web rows, confirmed progress/retry/cancel/clear
private per account. downloader_update events and polling while active.
Exact keys keep the acquired marker with hash even if the preview is still playing;
it does not replace URI/keys/token/position or output during acquisition.

UI 1,425/167, Python pipeline 1 and APK2 HTTP/HTTPS pass. Native pause 20s, fail/retry,
acquired with real hash and marker, active cancelSearch without file, explicit local
playback and stop. Normal APK/test/unit/lint without CA passes. The first attempt left
Search before resolving/accepting the job; the test was fixed, not the account/
unmount guard. The test restores Saved/controls and deletes only files of its fixture.

The fixture replaces only _download_audio with synthetic bytes; processing/tags/hash/
store/queue/pool/personal transaction remain real. Python demonstrates that Range/owner
does not see or remove member jobs/late cancel does not promote a file. No live YouTube
or physical listening accepted. Sources assets dirty from b364905.

Continue import: the current baseline is Migrate.tsx and migrationApi jobs/upload/
start/control/decision, not only the legacy preview/import-playlist APIs. Reuse the
view with injected navigation/account/lifetime and the real OS picker for exports.
Inventory multipart limits and accepted formats before modifying transport.
Then the rest of library/Discover/Settings/share/multi-device, DJ/Live/Auto,
signing/update/release gates. Last full main 35+restart2; now 41 main tests
expected plus restart2 and browser4 to repeat on the final implementation.
Do not close per slice; continue until full parity and the open PR for manual review as authorized.


## S2y delivery: shared migration and OS grant with streaming

[Contract](SLICE_2Y.md), [evidence](evidence/s2y.json). MigrateView keeps the guide,
selection, progress, controls/review and web restore; Migrate is a router adapter.
The Android surface injects the real /migrate origin, chooser and Playlists opening.
Irrevocable AbortSignal/lifetime and job revision prevent old
restore/poll responses from overwriting a confirmed mutation. Unmount aborts queries/upload;
a picker cancellation keeps the guide and does not create a job. The shared ToastOutlet
makes native errors/confirmations visible.

ACTION_OPEN_DOCUMENT only delivers an opaque token and metadata to JS; private URI,
profile, generation and session fingerprint stay native. Token once/10min,
normal request keeps HTTP/401 errors, 64KiB stream and 100MiB cap, without base64.
Document metadata uses bounded workers/queue, CancellationSignal and deadline;
content reading and lease are closed on cancellation/change/destroy/timeout.
MIME application/* and text/* avoids excluding exports because of provider variants;
the parser validates content/extension. No broad permissions and no persisted grants.

UI 1,430/167 and migration backend 30 pass. APK2 HTTP/HTTPS without failures/skips:
real picker, cancellation without job, CSV/matcher member-track, restore on return,
start/completion, exact playlist and Open library lands on Playlists, without HTML
audio. Normal APK/test/unit/lint without temporary CA passes. Stream tests cover known/unknown
size, limit, no replay, closing and invalidated account.

Fixes during acceptance: the JS generation can be an Integer (getLong alone
is not enough); isolate the persisted guide per case; navigate OS Recents/Downloads;
KeyEvent with keyboard source and MotionEvent with TOOL_TYPE_FINGER. Tool type UNKNOWN
did not prove a finger tap in DocumentsUI. Never simulate a picker result.

Sources assets dirty from 4be3e2d; not an alpha artifact. Cloud/other manufacturer
document providers, real Spotify/Apple exports and complex controls/
review cases in the APK remain pending extended acceptance (shared backend and UI
contracts tested). [S2z](SLICE_2Z.md) is the next slice: real Back for
menus/overlays, collections/podcasts/tabs and minimized root without stopping the program.
Last full main 35+restart2; now 43 main expected+restart2;
repeat full and browser4 on the final implementation. Then complete the rest of
library/Discover/Settings/share/multi-device, DJ/Live/Auto, signing/update and
open PR for manual review as authorized. Do not finish per slice.


## S2z delivery: system Back and navigation cleanup

[Contract](SLICE_2Z.md), [evidence](evidence/s2z.json). App.backButton prioritizes the
top menu/modal and handlers with a Solid owner for detail/tab; at the root it
minimizes without touching audio/session. The Library detail query and Podcast feed are
cancelled on going back; old responses do not reopen a view. A late listener after
unmount is removed and does not minimize another instance. Do not simulate Escape or DOM buttons.

UI 1,438/168 and APK2 HTTP/HTTPS pass. KeyEvent keyboard/FROM_SYSTEM: collection →
Playlists → Songs; close menu, editor and lyrics; show → directory → Library;
Downloads → Library; root minimizes and returning keeps keys/token/pause 20s/cookie.
Revocation with a menu open removes the window/personal data and empties the program.
The cookie is only compared natively, never printed. Normal APK/test/unit/lint
without temporary CA passes. Assets dirty from 8cfd77c.

Fixed an orphaned overlay registration after unmounting Outlet: discardOverlays
clears history scopes/listeners without navigating underneath; account reset
uses it together with closing the popover. A protected modal consumes Back until it finishes or
until the account is lost. The first attempt passed navigation/minimize, but the helper
expected the app without a server on return; the test was fixed for a real connected app.
No acceptance of hardware/predictive gesture/manufacturers.

Now 45 main tests expected +restart2; repeat the full main and
browser4 because of global cleanup and recent shared extractions. Continue
the remaining library actions (remove file and references/program/copy),
entities/Discover/Settings/share/multi-device, DJ/Live/Auto and signing/update.
Do not close the turn per slice or publish before parity; open PR for manual review afterwards.

## S2aa continuation: deletion and recoverable filesystem

Implementation connected and base acceptance in [SLICE_2AA](SLICE_2AA.md).
Full UI 1,465/172 passes; explicit JVM 17 and backend lifecycle 12 pass. Four
base native HTTP/HTTPS cases pass: duplicated local removal with preview/keys/
pause 20s preserved, playlist references, pool of another owner, successor,
closing of the last source and filesystem error with recovery from the manager.
Extension for a copy deleted by another client validated HTTP/HTTPS: final set of 4
passes in /tmp/soundsible-s2aa-progress-native.log, APK/test APK/JVM17/lint pass without
temporary CA. Assets 37d1669 dirty=true. Fixed progress.value=undefined which
aborted rendering of the manager in WebView while there was no known size; a strict
test reproduces the earlier failure. Do not automatically purge copies because of remote membership.

Evidence correction: the old runs that only assembled the test APK
and generated lint unit models do not prove JVM execution. The explicit
17 run does; the helper now adds testDebugUnitTest to the normal closing without CA.
Prepare a clean commit and repeat the extended main 49 + two offline phases;
do not replace the historical green 35 with old XML or with targeted 4. Continue
without closing per slice until full parity and the open PR for manual review as authorized.


## Clean S2aa main

Assets from dc29b73, dirty=false: main 49, zero failures/errors/skips;
prepare 1 + force-stop/offline 1 pass in the persistent protocol. Normal APK,
test APK, JVM17 and lint pass after removing the temporary CA. Log
/tmp/soundsible-s2aa-main-clean.log, current XML android/build/integration-results.
This result replaces the historical 35+2, not the failed 45 of S2z.

During this run the [S2ab](SLICE_2AB.md) fixture/draft were prepared, without
changing native code or assets of dc29b73. The later local recovery fix
(restoreOffline(false), keep the online library) is pending specific
instrumentation; do not attribute it to the earlier clean artifact. UI 1465/172
passes in /tmp/soundsible-s2aa-online-recovery-ui.log. Next: incorporate the draft
PlannerRetirementTest and check HTTP/HTTPS Radio/autoplay, together with the new
connected library assertion in OfflineRemovalTest. Then continue the rest of
parity; open PR for manual review still pending.


Later local recovery validated: restoreOffline(false) updates the state of
copies while keeping the connected library. Native HTTP/HTTPS requires not showing an
unreachable station and not losing a saved preview after a filesystem error; two
cases within targeted 6 pass (/tmp/soundsible-s2ab-native.log), assets 4e04083
dirty=true. UI 1465/172 and normal APK/test APK/JVM17/lint without CA pass. It is not equivalent
to a new clean main. S2ab four cases of the same set also pass;
record its delivery separately and continue the remaining parity.


## S2ab: real pending response discarded

[Contract/evidence](SLICE_2AB.md). The fixture delays an already computed response,
it does not alter the planner body; cooperative gevent delay and loopback/header control,
bounded to 5s/one call. Python WAV/FLAC 2 passes. Native 4 HTTP/HTTPS Radio/autoplay
pass in /tmp/soundsible-s2ab-native.log (targeted 6 with OfflineRemoval 2), assets
4e04083 dirty=true. DELETE confirmed during pending; old response delivered,
new refill without the removed ID; keeps key/programToken/pause 20s and modes. Cleanup
restores preferences and synthetic sources, drains the delay before the next case.
Normal APK/test APK/JVM17/lint without CA pass. Main 53+restart2 pending;
last clean dc29b73 49+2. Continue remaining Settings/Discover/library,
DJ/Live/Auto/signing/update and then the open PR for manual review; do not finish per slice.


## Clean S2ab main

Assets 03e3446 dirty=false: main 53, zero failures/errors/skips, plus two
persistent offline phases prepare/force-stop/offline. Normal APK/test APK/JVM17/
lint without CA pass in /tmp/soundsible-s2ab-main-clean.log. Current archive in
android/build/integration-results. Replaces main 49 of dc29b73. During the
regression only UI sources of [Settings S2ac](SLICE_2AC.md) advanced, without touching
native sources or assets of the clean artifact. UI 1481/175 passes; Settings still
requires an instrumented HTTP/HTTPS walkthrough and acceptance of a rotated session.
Continue without stopping per slice until full parity and the open PR for manual review.


## S2ac: shared Account and per-profile history

AccountSettingsView and SearchHistoryStorage reused by web/Android without audio
stores. Mutations confirm receipt and snapshot within a cancellable scope;
logout respects the revalidation busy state. Native HTTP/HTTPS2 passes: cancelled
and rejected edits, confirmed profile, password/encrypted cookie rotated and decrypted by a
new connection, real event reconnections, preservation of keys/program/
pause 20s/copy and Activity, confirmed logout and new login with new credentials.
Owner/member keep independent history preferences.

UI 1484/176 and normal APK/test APK/JVM17/lint pass. Assets 06004af dirty=true;
clean main 55+restart2 pending, the last clean artifact 03e3446 has 53+2.
Full browser regression accepted: Chromium 278/66 and WebKit 269/75,
no failures; see SLICE_2AC/evidence/s2ac.json.
Initial failures of the username locator and logout during revalidation fixed
and archived; do not reuse their results as green.

Continue Appearance/accessibility according to SLICE_2AD, then the remaining Settings/Discover,
DJ/Live/Auto and signing/update. No open PR for manual review yet; do not close per
slice. Full alpha gates in force.


## S2ad: Appearance validated on Android, shared regression pending

Main 55 on aad83d4 dirty=false found an OfflineTest TLS failure when
resuming after the second recreation. Original HTTP/TLS2 replay passes;
the helper now waits for an enabled button and UI out of boot. Do not replace the
clean main 53+restart2 of 03e3446 until main 57+restart2 is repeated.

Appearance implemented in sources: six themes, Capacitor SystemBars for
icon contrast, limited bridge for the window background, real changes of the
OS night mode, language, size and contrast. Native HTTP/TLS2 passes, keeps
program/pause 20s/copy/session in Activity and offline 503. Normal APK/test APK/JVM17/lint
without CA pass. UI 1489/179 serial passes. Evidence in SLICE_2AD and
 evidence/s2ad.json; do not attribute physical acceptance to the emulator.

Chromium regression found a clickable header title smaller than 44px when measuring
all controls; fixed with min-height 44px. The test measures the row in a single frame.
Ctrl-click links wait for stable geometry and a new tab with a
context/foreground fixture. Targeted Chromium 28 pass/20 skipped; four full
profiles pending. The last earlier serial run 268 pass/66 skipped/10 failures;
do not consider that run or its partial predecessors green.

Continue without closing the slice: finish the four-profile regression, commit/push,
prepare a clean artifact and main 57+restart2. S2ae Discover inventoried in
SLICE_2AE; remaining Settings, DJ, Live, Auto and signing/update remain pending.
Full alpha gates in force; open PR for manual review only when they are met.


## Full S2ad regression accepted

Chromium 278/66 and WebKit 269/75, zero failures, the four full profiles
sequential with 1 worker like CI. Logs /tmp/soundsible-s2ad-{chromium,webkit}-ci-worker.log.
A real popup keeps Ctrl-click/foreground, waits for DOMContentLoaded and the full
detail page; eight repetitions with trace pass. With 8 workers one case keeps waiting for the
URL even after DOM readiness; do not declare that run green. S2ae during
the runs only changed Native and added shared views not yet connected; the
measured web entries remained the same. Full UI with S2ae bases is repeated
before preparing a clean artifact/main 57+restart2. No parity or alpha.

Full UI 1504/185 passes in /tmp/soundsible-s2ae-foundation-full-ui.log on
dc841c9 (only evidence docs pending). Everything delivered is kept in
feat/android-port-foundation; S2ae still without real all/feed/detail screens.
Prepare a clean artifact after saving this evidence; freeze Native and
assets during main 57+restart2. S2ae UI can advance after prepare,
but do not prepare again or touch native sources/tests while the runner is running.


## Clean S2ad main and S2ae UI in development

8329de5 dirty=false: main 57, zero failures/errors/skips; restart prepare 1
and force-stop/offline 1 pass. Normal APK/test APK/JVM17/lint without CA pass in
/tmp/soundsible-s2ad-main-clean.log. Replaces the accepted main 53; it does not delete the
failed diagnostic 55 aad83d4. Native source and assets remained frozen.

Later S2ae UI NOT included in that artifact: Discover/discography web views
already delegate to pure layouts; Android feed/songs-artists-albums/detail pages with
candidates/related/discography and collection Play/shuffle connected in sources.
The resolved songs menu reuses songMenu from Library, including offline inside the
menu. Targeted UI 26/7 passes /tmp/soundsible-s2ae-connected-ui.log. Dirty state
on the branch: collection downloads/review still being implemented, new layouts
require the UI suite/four profiles and their own Android HTTP/HTTPS. No S2ae parity
or release yet. The earlier Native freeze was lifted when runner 0 finished.

### S2ae continuation: connected screens and collections, validation pending

See SLICE_2AE: Discover/Artist views connected in web and Android; reversible
navigation, search of four types, native queue and confirmed jobs controller.
UI 1516/187 and fixture Core 1 pass. Six new controller tests pass.
Chromium in progress (/tmp/soundsible-s2ae-chromium.log), then WebKit. Targeted
HTTP/TLS integration in progress (/tmp/soundsible-s2ae-profile-native.log), development
artifact prepared dirty. Do not accept Native S2ae or replace main 57
until there are results. Native sources/fixtures/assets frozen during that run.
End-to-end collection acquisition/review still pending; no PR/release.

S2ae update: Chromium 278/66 passes. First targeted Native 4 failures: fixture-ID and
save/remove regression in previews; both fixed, pytest 1 and targeted 18/2
pass. New targeted Native /tmp/soundsible-s2ae-profile-native-fixed.log in
progress; do not accept until there are results. WebKit /tmp/soundsible-s2ae-webkit.log is still
in progress. SLICE_2AF inventories the next Settings and requires a real DSP effect,
not cosmetic switches. Keep continuity until all authorized gates.

Final targeted S2ae acceptance: 6/0 HTTP/TLS in
/tmp/soundsible-s2ae-final-directed-native.log; own integration-targeted XML,
main 57/restart2 kept. Normal APK/test/JVM17/lint pass without temporary CA.
UI 1522/188, fixture Core 1 and browser4 278/66+269/75 pass. Core acquires a file
with metadata and plays the local source on the new Play; Back restores the query and
real scroll. Core review/cancel/retry and acquisition without a previous preview remain
pending. See the last section of SLICE_2AE; continue without closing the turn per slice.

### Android review and feedback accepted; next Settings acceptance

/tmp/soundsible-s2ae-review-links-native.log: 16/0 HTTP/TLS, 14 review/profile/search
plus 2 feedback; normal APK/test APK/JVM17/lint pass without temporary CA. Acquisition
without a previous Save/preview links the confirmed job identity with the local file
without creating saved items. The first review run failed 4 and is kept as a diagnostic;
the repetition confirms choosing real version/skip/cancel/retry. Feedback uses View
without the VIBRATE permission or flags to ignore the system; on/off persists across Activity,
an OS rejection does not touch program/session. No acceptance of physical sensation.

Learning and diagnostics UI added AFTER the prepare of that artifact; do not confuse them
with its Native acceptance. The controller confirms PATCH/GET, confirmed DELETE reset,
cancellable scope; diagnostics only measures what the engine delivers, unknown on
failure/disconnection. Targeted Learning 4 and diagnostics 2 pass. Repeat full UI,
prepare a new artifact and test Core HTTP/TLS. Missing: browser4 regression of the new
views before the PR and an extended clean main with restart2. The last clean
main is still 8329de5 57+2. Continue pending Settings, DJ/Live/Auto/signing/update,
commit/push and finally the open PR for manual review with full parity. Do not close per slice.

Settings 6 accepted in /tmp/soundsible-s2af-settings-recovery-native.log; normal
APK/test APK/JVM17/lint and CA removal pass. Learning off prevents events, Cancel
does not send DELETE, a real reset deletes member and keeps owner, Activity keeps the
preference and 503 uses offline/general Retry without invented defaults. UI 1534/192
passes; Browser4 next. Settings Playback Autoplay Native has a view/tests
prepared, still without a route or APK acceptance. The last clean main is still 57+2;
prepare an extended clean 73+2 after commits. DSP/other Settings/DJ/Live/Auto/
signing/update remain pending. Continue until the authorized open PR for manual review.

### Autoplay Settings confirmed and shared regression closed

/tmp/soundsible-s2af-autoplay-native.log ends 0: 10 HTTP/TLS cases, Autoplay 2
extended with Settings, Closure 2 and Learning/Feedback/Appearance 6. Normal APK/test
APK/JVM20/lint pass, temporary CA removed. Program and preferences survive
Activity; the toggle changes real refill/removal. UI 1536/192 passes. Full Browser4
Chromium 278/66 and WebKit 269/75 without failures, sequential 1 worker and readonly WebKit.
Web sources of those walkthroughs remained the same during both runs;
the later Native Autoplay and the loudness test do not change the web entry.

ProgramLoudness and shared/contracts/loudness_gain.tsv are the S3a rule base;
TS38 and JVM3 pass. No AudioSink/PCM tap or leveling/mixing delivered yet. See
SLICE_3A. Immediate next step: commit/push, prepare a clean commit and main
73+restart2 with Native/tests/fixtures/assets frozen until the normal build.
Do not yet replace the last clean main 57+2. During that regression
future unprepared UI for Subsonic/other Settings can advance, but not native
sources, fixtures or test resources of the artifact. Then S3/DJ/Live/Auto/
signing/update and the authorized open PR for manual review. No closing per slice.

### S2ag continuation during the clean S2af main

Main 73 on 46a6c3d dirty=false is in progress; do not yet replace 57+restart2.
Native sources/tests, fixtures, JVM resources and assets remain frozen until
both restart phases and the normal build finish. Later Subsonic UI does not belong
to the artifact being run. SLICE_2AG documents the contract and pending acceptance.

Extraction of the shared view and the scope/confirmation controller pass 21 connected
tests in 5 files, typecheck correct, log
/tmp/soundsible-s2ag-connected-ui.log. Two earlier screen test diagnostics
failed because of incorrect labels and because of mounting with && outside a reactive Show;
fixed with real labels and real mount/unmount. Android route connected,
JS clipboard adapter pending a native plugin and HTTP/TLS acceptance. Do not mark
Subsonic end to end yet; do not claim browser4 coverage of this new extraction.
Continue main, commit/push of accepted evidence and Subsonic plugin/tests,
then DSP/DJ/Live/Auto/signing/update and the open PR for manual review. Do not close per slice.

### Clean S2af main accepted

46a6c3d37793c4b49f94d372e6b5e9287baed039 dirty=false: main 73/0,
restart prepare 1/0 and force-stop/offline 1/0; normal APK/test APK/JVM20/lint pass
without temporary CA. Runner /tmp/soundsible-s2af-main-clean.log ends 0. Current XML
integration-results confirms 73 and the two result.json files confirm 1+1. Replaces
main 57; do not attribute the later Subsonic work to this artifact. Native freeze
lifted when the runner finished. Continue S2ag end to end and DSP/DJ/Live/Auto.

### Targeted Native S2ag Subsonic accepted

/tmp/soundsible-s2ag-account-fixed-native.log ends 0 with 4/0 HTTP/TLS:
extended Subsonic 2 and Account 2, normal APK/test APK/JVM20/lint without CA pass.
Mint/replacement/revoke change real auth formPOST/rest, OS copies with sensitivity,
Activity without password, confirmed member-owner switch without foreign state or
secrets; program/keys/pause/session intact before the explicit logout. The
first targeted 2 also passes; the first extension of 4 fails 2 because it chose the header Sign out,
the diagnostic is kept and the Account locator is fixed.
UI 1547/195 passes. Browser4 of the shared Subsonic view next/in progress; the last
clean main is still 73+restart2 on 46a6c3d. Native freeze lifted.
Continue DSP S3a and remaining Settings, DJ/Live/Auto/signing/update. No alpha yet.

### S2ag browser4 regression accepted and DSP in sources

Chromium 278/66 + WebKit 269/75, zero failures, full sequential suites 1 worker,
readonly WebKit; logs /tmp/soundsible-s2ag-{chromium,webkit}.log. Own Vite
stopped. The web UI did not change during the runs. DSP changes only Native and docs,
not yet compiled/tested; see SLICE_3A. Do not prepare or run heavy Gradle
during browsers. Now compile processor/kernel/tap and the confirmed Core worker;
connect Native Track/context/Settings and demonstrate real PCM before accepting.
Do not close at S2ag: remaining Settings, DJ/Live/Auto/signing/update/open PR for manual review
continue as authorized, alpha only with full parity.


## Continuity snapshot 2026-10-06: dcdd6a3b, regression in progress

# Android port handoff

## Decisions in force

- Branch `feat/android-port-foundation`; everything enters main through a PR.
- Complete phone, DJ, Live and Android Auto parity before alpha. The
  debug artifacts are development builds and do not prove a release.
- Commit/push validated implementations. When parity is complete, leave the
  **PR open with checks passing for manual review**. **No merge, automerge
  or release** before the user's review and merge. Prepare alpha instructions.
- Offline B approved: acquired music, explicit copies, "Available
  offline" only in three-dot menus; no preparation in shells and no auto-eviction.
- Shared Solid UI with native adapters. The iOS app is independent Swift;
  do not describe it as a synchronized Solid port. Keep the unverified PAL warning.
- The user has no physical Android device. AVD/PCM/CI do not prove listening, headphones,
  Bluetooth or a real car. Full physical gates for beta, according to RELEASE_GATES.
- Work until parity, without closing per slice. Use targeted runs during fixes and
  full suites when closing blocks. Do not delegate without authorization.

## Current status

Last validated blocks: recovery of stalled PCM during a DJ mix
(`0b070887`) and DJ → Radio keeping song/position/pause. `0f26f348` added the
confirmed mixing preference and `1ab49ea6` observed planner feedback.
There is no full parity and no final PR yet.

- Phone: NORMAL, podcasts, Radio/Autoplay, library/collections/bookmarks,
  acquisition/review/import, metadata, lyrics, Account/Appearance/Feedback/
  Learning/Subsonic and offline have validated verticals. See PORT_PLAN for
  remaining actions; share/multi-device and remaining Settings not closed.
- DSP S3a: leveling and post-DSP/pre-volume capture, PCM and per-profile preference.
  Clean main 78/0 on `d049f404`; it predates DJ.
- DJ S3b: real Core, two decoders normalized to stereo48k, one AudioTrack,
  seven techniques/FX, dominant metadata, pause/background, contextual opening and
  from sources, profiles/direction, editing, effective refill and replan of the future,
  MediaSession/focus/noisy controls on AVD, return to NORMAL and confirmed mixing off.
  Recovery of a decoder before the mix and of an input without PCM during the mix
  accepted with the real controller in isolation. Core repair, pins on replanning and the
  "Cued" state and musical placement accepted. Refinement before preparation connected and recovery of an input
  with a pending body validated in the service. Both inputs unavailable pending. Do not declare DJ parity.
- Live and Android Auto: pending. Permanent signing/public update: pending.

## Evidence that matters when continuing

- Full regression **130/0** on clean prepared `d7e95c44`,
  `/tmp/soundsible-s3b-regression-native.log`; restart prepare 1/offline 1 and normal
  APK/test/JVM52/lint pass. Instrumented runtime 1835.188s. It predates the
  network/settings block described below; it is not equivalent to full parity.
  Historical 120/3 in `soundsible-s3b-full-native.log`; fixes included in 130.
- DJ recovery 6/0 HTTP/TLS + normal APK/test/JVM49/lint without CA:
  `/tmp/soundsible-s3b-starvation-ramp-fixed-native.log`. Non-silent PCM after
  the ramp, pause excluded from the timeout, epoch and clock retained. Asset prepare
  `0f26f348` dirty; final sources dirty on `1ab49ea6`. The earlier diagnostic
  `starvation-post-recovery-pcm-native.log` found re-arming before the ramp finished;
  fixed with a render guard + physical clock. It does not cover absence of both inputs
  or a stalled download in the bridge/service flow.
- Mixing off DJ2+PCM2/0, normal APK/test/JVM49/lint:
  `/tmp/soundsible-s3b-mixing-settings-native.log` (dirty on `12a872d0`).
  Full songs; a transition that is already prepared keeps its decision.
- Clean offline restart `12a872d0`: prepare 1 + force-stop/offline 1 and normal build,
  `/tmp/soundsible-s3b-restart-offline-native.log`.
- DJ → Radio: DjProgramTest 2/0 HTTP/TLS, normal APK/test/JVM49/lint without CA,
  `/tmp/soundsible-s3b-radio-mode-native.log`. The same MediaController controls
  NORMAL → DJ → NORMAL/Radio; KEY, position and pause retained when leaving DJ.
  Artifact on `0b070887` dirty; final sources dirty on `ba697dc4`.
  Includes planner UI feedback. Full runtime 158.6s, without a comparable baseline.
- Repair/pins/cued: DJ2 + Recovery6, **8/0 HTTP/TLS**, normal APK/test/JVM52/lint
  without CA in `/tmp/soundsible-s3b-repair-native.log`, on `be2894fc` dirty.
  Core repairs a future of 16; keeps requests by KEY and depth, including
  an effective change of sources. Snapshot/epoch/revision/floor reject obsolete
  results; committed inputs cannot be removed/reordered. Insert after
  respects floor. UI 198/1561 + TS in `/tmp/soundsible-s3b-repair-full-ui.log`.
  It does not yet prove musical placement, refinement, all negatives of
  Core responses or a long session up to the limit of 1000 occurrences.
- Placement: DJ2/0 HTTP/TLS, normal APK/test/JVM52/lint without CA in
  `/tmp/soundsible-s3b-placement-native.log` on `cebf7246` dirty. `dj-place`
  computes insertion/bridges/following transition; the user request is kept from
  its acceptance. 503 keeps the fallback in the queue; a computed response delayed 2s
  does not revert Move or duplicate the request. Changing sources keeps both requests,
  including two occurrences of the same recording. Anonymous fixture controls
  without a header rejected 403. It does not test distant fixed placement or all variants
  of bridges, refinement or a long session. UI 198/1564 + TS passes.
- Full UI: **198 files/1564 tests + TypeScript**, last log
  `/tmp/soundsible-s3b-placement-full-ui.log`.
- The last green Browser4 predates S3: Chromium 278/66 skips + WebKit 269/75 skips,
  `/tmp/soundsible-s2ag-{chromium,webkit}.log`. Repeat the four before the PR.
- Durable evidence: [S3a](evidence/s3a.json), [S3b](evidence/s3b.json).
  Raw local results in `android/build/integration-results` and targeted
  folders; do not replace the failed main with a successful targeted run.

## Active work and next step

Placement (`3c832ce9`) pushed. Long history: Recovery 8/0 HTTP/TLS and normal
build pass on `3c832ce9` dirty; queue of 1000 trimmed without audio reset,
append retaining KEY/position/pause/epoch, bounded exclusion of 80 listened tracks.
Log `/tmp/soundsible-s3b-history-native.log`. Refinement connected to Core before preparing the decoder: Recovery 8 + DJ2,
10/0 HTTP/TLS, normal APK/test/JVM52/lint pass on `9bed92e6` dirty.
Log `/tmp/soundsible-s3b-refine-native.log`. Native guards accept an uncommitted
proposal and reject an obsolete snapshot/prepared cue. Additional measured real Core test 2/0 HTTP/TLS, normal build passes,
`/tmp/soundsible-s3b-measured-native.log` on `d7167176` dirty.
It queries real analysis of synthetic files; measured transition applied
with exact fromKey and outCue before playback. Remaining negatives pending.
Continue network recovery in the service and the remaining parity items. The DJ fixture bounds failures/delays around
the real Core; it does not replace its valid responses with a fake planner.
Current main regression **130/0 + restart prepare 1/offline 1 + normal build**
passes on clean prepared `d7e95c44`:
`/tmp/soundsible-s3b-regression-native.log`, session exec78409 ended exit 0. Instrumented runtime 1835.188s.
Main freeze lifted. Network/settings block validated in checkout `/tmp/soundsible-android-next`
on `c3d392d6` dirty and moved to the main checkout without changing its sources:
- planner/refiner bind memo and guards to settingsRevision; the same pair is queried again
  after changing profile. Measured 2 and NORMAL 2 pass in range-native (suite 6/2 fails
  because of an insufficient fixture; it does not replace the main evidence).
- Incoming stream delivers 600000 bytes (~3.125s), stalls 22s through Range,
  a counter confirms a pending body during recovery. Network 2/0 HTTP/TLS and
  normal APK/test/JVM52/lint in `/tmp/soundsible-s3b-network-buffered-native.log`.
- MediaController.play after 503 prepares a temporary error keeping KEY and PCM;
  no automatic reauth for 401/403. It does not modify UI or real user data.
Diagnostics: the first network-native 6/1 fails the WebView 5s callback after recreate in
NORMAL HTTP; the repetition passes NORMAL but the one-shot stall is not stable with Range.
Range-native 6/2 shows that 64000 bytes do not start the decoder before the block;
600000 bytes and a pending counter fix the fixture. Do not declare successes from those
failed runs or recovery if the block had already ended.

Main/remote `acbd83d7` include the car podcast contract, evidence 130 and
validated network/settings. DJ menus from song/use as source under validation
on that HEAD dirty: UI 198/1568 + TS pass; Context2 + DJ2 native 4/0 HTTP/TLS pass, 123.203s,
(`/tmp/soundsible-s3b-context-native.log`). The runner ends exit 1 because of lint of the
unconnected Auto draft (old LibraryResult constants). Fixed to
SessionError; separate normal build APK/test APK/JVM52/lint passes
(`/tmp/soundsible-s3b-context-normal-build.log`), DJ sources unchanged.
New ProgramCarLibrary.kt is under development in the main checkout; not integrated/validated
or committed. Root HANDOFF/evidence are updated when network is closed. The clone has
the same network changes; do not copy them again after editing the main checkout.
Worktree failed with a new read-only ref; an independent clone worked. Commit/push do
work; do not ask the user for action. Keep heavy suites serial; future
full runs can use an isolated checkout to keep editing another copy.
Menu from song/use as source validated: KEY/position/pause retained,
previous lead removed when the context changes and explicit requests retained.
Route/queue menus with shared song actions validated: Context2/0
HTTP/TLS, normal APK/test/JVM52/lint, 19.962s instrumented,
`/tmp/soundsible-s3b-route-menu-native.log` on `4f75ba17` dirty.
Removal by KEY preserves current/position/pause; existing source selected
and disabled. UI 198/1570 + TS.
Fixed placement from the Add to route menu: Context2/0 HTTP/TLS, real Core places
before target KEY 18 (beyond horizon 16), keeps KEY/position/pause.
Normal APK/test/JVM52/lint; 22.075s instrumented,
`/tmp/soundsible-s3b-fixed-placement-native.log` on `182a8dff` dirty.
UI 199/1576 + TS. The picker follows the current order of the same program; it blocks a
removed/committed target and account/program change.
Sources + bridge ownership validated on `1eec3df3` dirty: Context2 +
Blocks2 + DJ2 + Recovery10 + Network2, 18/0 HTTP/TLS; 332.005s instrumented;
normal APK/test APK/JVM54/lint, `/tmp/soundsible-s3b-owned-block-native.log`.
UI 200/1581 + TS. Removing a source keeps request/current/pause; the last source is
protected. Bridge/owner travel as a block; an audible bridge protects the owner
and pending bridges, and placement/repair start after the committed block.
Blocks2 supplies controlled ownership rows to a production session with
real HTTP/TLS/decoders; do not claim that Core generated bridges in all cases.
Next DJ: remaining negatives, both inputs unavailable and a long session
up to 1000 in service/controller, then the current main regression.

Phone S2ah: song sharing integrated into the main checkout and validated on
`23c5c416` dirty. Share2 + LibraryActions2 + DjContext2, 6/0 HTTP/TLS, 57.095s;
normal APK/test APK/JVM54/lint without CA in `/tmp/soundsible-s2ah-share-native.log`.
UI 201/1584 + TS. The native picker uses the common public capsule or local/podcast text;
Intent intercepted in tests, no delivery to a recipient and no physical test.
See [S2ah](SLICE_2AH.md). Receiving/deep links/invites and multi-device pending.
Clone `/tmp/soundsible-android-next`, branch `feat/android-phone-continuation` on
`1eec3df3`: sharing already copied to the main checkout; do not copy old files again.
New incomingTrack parser in development for public capsules/native open URL;
no automatic connection or autoplay. Native receiving implemented, under S2ai validation. See SLICE_2AI.md. UI 204/1595 + TS pass. Incoming2 + Share2 on 9450752c dirty compiles; the first block 4/2 detects a replay on recreate: BridgeActivity.load redispatches getIntent. Fixed in SharePlugin by discarding the restored initial dispatch; repetition in /tmp/soundsible-s2ai-incoming-recreate-native.log, do not declare it accepted until exit 0 and normal build. The first compile failed because of a nullable only in the test, already fixed. Sources frozen during the runner. IncomingTrackTest clears pending public preferences at the start/end.
Old network work preserved in the clone's stash; do not apply it on top of new sources.

Android Auto: browse draft in ProgramCarLibrary, requires integration, selection,
Radio, covers/offline and host acceptance. Live and signing remain pending.

In future runs, **freeze Native sources/tests, fixtures, assets and resources
until the end of the runner, including the normal build without CA**. Do not attribute a run to
sources changed after its prepare.

Then: close DJ refinement, remaining negatives and long session,
network recovery in production and full regression; continue Live receiver/
sender, Android Auto, the rest of the phone matrix and signing/update. Final gate:
parity + checks + open PR for manual review; never automatic merge.

## How to work without repeating the whole history

Read [PORT_PLAN](PORT_PLAN.md), [RELEASE_GATES](RELEASE_GATES.md),
[architecture](ARCHITECTURE.md), [offline](OFFLINE_DECISION.md) and the relevant slice
([S3b](SLICE_3B.md) now). The [history](HANDOFF_HISTORY.md) keeps all the old
progress, failures and commands; consult only the relevant block.

- Follow AGENTS: no npm run build in ui_web, central version, branch and commit,
  full browser4 before the PR, current remote fetch/ancestry and a single impact label.
- JDK21: `/home/arsu/.cache/soundsible/android-toolchain/jdk/jdk-21.0.12.1+1`;
  SDK: `/home/arsu/.cache/soundsible/android-toolchain/sdk`. Export JAVA_HOME,
  ANDROID_HOME and add their bin to PATH. Gradle only targets `:app:*`.
- Prepare with `.venv/bin/python scripts/android.py prepare`; integration with
  `scripts/android.py integration`, targeted through
  `ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class`.
  `integration --offline-restart-only` runs without a class filter.
- Heavy suites sequential. Chromium before readonly WebKit, one worker, as in
  AGENTS. Do not touch the personal engine. Dedicated fixtures 5097/5098/5099 and a synthetic
  account; do not log real cookies/credentials or secret exception messages.
- Do not assume an external PCM API in a WebRTC AAR: SamplesReadyCallback is not injection.
  Initial Live research without implementation/chosen dependency: upstream
  JavaAudioDeviceModule uses AudioRecord; the AudioRecordDataCallback setter in the consulted
  GetStream sources is not passed to the constructor. Test program injection
  without microphone and independent receiving before integrating rooms/broadcast claim.
  Sources consulted: [ADM upstream](https://webrtc.googlesource.com/src/+/main/modules/audio_device/g3doc/audio_device_module.md),
  [JavaAudioDeviceModule GetStream](https://github.com/GetStream/webrtc-android/blob/main/stream-webrtc-android/src/main/java/org/webrtc/audio/JavaAudioDeviceModule.java).

S2ai receiving validated on 9450752c dirty: Incoming2 + Share2, 4/0 HTTP/TLS,
29.504s, normal APK/test APK/JVM54/lint without CA passes (runner exit 0).
Log /tmp/soundsible-s2ai-incoming-recreate-native.log. UI 204/1595 + TS.
Recreate does not re-execute a consumed intent; new VIEW/SEND keep KEY/position/pause
until an explicit Play. The first nullable compile and the next 4/2 replay fixed;
do not count those runs as green. SLICE_2AI/evidence/s2ai.json keep the limits:
public bridge/App Links, offline cached-match, invites/multi-device pending.
Freeze lifted. Next DJ: both inputs unavailable in Recovery.

DJ both PCM inputs: Recovery2/0 HTTP/TLS on 450b207d dirty,
46.949s; normal APK/test APK/JVM54/lint without CA passes. Log
/tmp/soundsible-s3b-both-inputs-native.log. Both decoders paused during an overlap
>2s: no removal without a healthy counterpart; when outgoing returns there is recovery,
non-silent PCM 48k and epoch/clock retained. It does not test a permanent failure of both
network sources. Pending: Core negatives and queue of 1000 in service/controller.

S2ai offline finished: on f0e02058 dirty Incoming2/0 HTTP/TLS, 19.214s;
normal APK/test APK/JVM54/lint without CA passes, UI 204/1595 + TS.
/tmp/soundsible-s2ai-incoming-offline-confirmed-native.log. New copies store a
validated youtube_id and receiving resolves a complete copy with APIs 503. Old copies
without identity must be prepared again for matching. Earlier attempts without an AVD
and the test compile because of an obsolete OkHttp API are not functional evidence; fixed.
Sources unfrozen; AVD restarted headless is still connected. Next: queue of 1000
DJ through service/controller; then Core negatives and the current regression.

Long service/controller queue validated on 6bd23fc4 dirty: DJ2/0 HTTP/TLS,
23.115s; APK/test APK/JVM54/lint without CA passes, runner exit 0.
/tmp/soundsible-s3b-service-history-native.log. Real DJ Core + append up to 1000,
MediaController seek 996/6000ms, trim to 4 preserves KEY/token/position/pause,
append to 5 and resume of non-silent PCM 48k. It is bounded stress through seek, not
1000 natural songs or a soak of days. Sources unfrozen. Next:
Core/refiner negatives and the current main regression; Auto/Live/phone/signing pending.

Current main regression in progress on dcdd6a3b (tracked clean; includes the
unconnected/uncommitted ProgramCarLibrary draft): /tmp/soundsible-android-dcdd-regression-native.log,
session exec62863, 144 tests. Freeze root Native/UI assets/fixtures until the end of the
runner including the normal build. Do not declare a result until the final exit.
Isolated checkout /tmp/soundsible-auto-next, feat/android-auto-continuation,
cloned from dcdd6a3b. Auto source in development there: scoped ProgramCarLibrary tree,
PlaybackService browse/getItem/setMediaItems of published IDs, ignores client
URI/metadata, normalizes podcast and Radio. Pending futures end on reset/close;
401/403 distinguished. Offline tree from ready copies, fallback root only with
real copies. New CarLibraryTest uses a real MediaBrowser HTTP/TLS for tree,
unknown ID/other account, forged URI/metadata and playback/PCM/account reset.
Not compiled/run yet: run after the regression finishes to avoid
heavy suites in parallel. Do NOT copy the old root Auto draft over the new clone.
Pending Auto: validate APIs/signatures/tests, subscriptions, safe artwork,
Radio/podcasts/offline acceptance, Automotive descriptor and host/DHU. Do not claim
the Auto host is tested by a sameUID MediaBrowser. Official source:
https://developer.android.com/media/media3/session/serve-content.
Headless AVD exec76258; it must be kept alive for the remaining suites.

The dcdd regression in progress found CatalogSearchTest HTTP: the global menu selector
by aria-label chooses the new queue row before the Discover result and waits for a
Save action that this row does not offer. The snapshot shows Remove from queue and no
Save. Fix prepared only in cloneAuto: scope the menu helper to
[data-testid=android-catalog-search]. Do not change the frozen root or claim the fix is
validated yet. Integrate and run targeted Catalog2 when the main run finishes.

CloneAuto initial compile Kotlin + androidTest passes with 1 worker/Xmx512m,
/tmp/soundsible-auto-compile.log. It does not run suites or occupy the AVD. Later changes:
total childCount for subscriptions (not the size of the first page), copy
integrity only in a worker, Android Auto metadata + automotive_app_desc media according to
https://developer.android.com/training/cars/media/auto. CarLibraryTest extended
with offline prep/API 503; new compile /tmp/soundsible-auto-counts-compile.log
exec pending. Native Auto runtime not tested; do not move sources to root yet.

Auto clone: providers/cache added there, NOT root. ProgramCarArtwork +
non-exported CarArtworkProvider/read grants with opaque URI, registry 400/cache 32 images
up to 2MiB, existing private BitmapLoader, invalidation on account/close. Browse/getItem
decorate playable IDs without engine URL; CarLibraryTest reads a synthetic red image/cache
503 and rejects an old URI. /tmp/soundsible-auto-art-compile.log compile Kotlin+test passes.
The last LRU fix avoids async eviction of a reused URI, not recompiled yet. Auto runtime waits for the
main suite (40/144 with 2 Catalog failures, at the time of writing). SLICE_4A in the clone keeps the
contract/limits; do not claim external host car permission from a sameUID harness.

## Handoff archived on 2026-10-06 (up to S2av)

Replaced by the concise HANDOFF. Full previous content:

# Android port handoff

### Decisions in force

- Main branch `feat/android-port-foundation`; all changes go through a PR.
- Complete phone, DJ, Live and Android Auto before alpha. Development is not a release.
- Validate, commit and push; when parity is closed, **PR open with checks passing for
  manual review**. **No merge, automerge or release** before the user's review/merge.
- Offline B: explicit copies of acquired music, "Available offline" in
  three-dot menus. No implicit acquisition, preparation in shells or auto-eviction.
- Shared Solid UI with native adapters. iOS is independent Swift;
  do not describe it as a synchronized Solid port. Keep the unverified PAL warnings.
- The user has no physical phone. AVD/PCM/CI do not prove listening, Bluetooth
  or a real car; full physical acceptance for beta according to RELEASE_GATES.
- Keep working after each slice. Do not delegate without authorization. Do not finish
  because a commit is complete. Heavy suites serial; targeted runs during fixes.

### Current status and evidence

Main: `feat/android-port-foundation`. Full parity and final PR still pending;
check git/origin for the current HEAD.
See [PORT_PLAN](PORT_PLAN.md), [RELEASE_GATES](RELEASE_GATES.md) and the evidence;
the [history](HANDOFF_HISTORY.md) keeps earlier diagnostics and snapshots.

- Phone: library/collections/bookmarks, NORMAL, podcasts, Radio/Autoplay,
  acquisition/review/import, metadata/lyrics, Account/Appearance/Feedback/
  Learning/Subsonic and offline have validated verticals. Shared song menus
  in route/queue; DJ sources and placement from menus are validated.
- S2ah sharing: native chooser, common public capsule or local/podcast text.
  Share2 + LibraryActions2 + DjContext2, 6/0 HTTP/TLS on 23c5c416 dirty;
  normal APK/test APK/JVM54/lint without CA. Intent intercepted: no delivery to the recipient.
- S2ai receiving: cold/warm VIEW/SEND intents, before login, explicit Play,
  latest-wins tokens and recreate without replay. Incoming2 + Share2, 4/0 HTTP/TLS,
  29.504s on 9450752c dirty. Real fix: BridgeActivity redispatches the initial intent;
  SharePlugin discards only the initial dispatch of a restored instance.
- S2ai offline: Incoming2/0 HTTP/TLS, 19.214s on f0e02058 dirty; normal APK/test
  APK/JVM54/lint. New copies keep a validated youtube_id; with APIs 503 the
  link resolves the local copy. Old copies without identity must be prepared
  again for matching. Last full UI 204/1595 + TS passes.
- DJ S3b: real Core, two stereo48k decoders/one AudioTrack, techniques/FX,
  planner/refiner/repair/placement, source removal, bridge ownership,
  playback/pause/background/focus/MediaController and PCM/network recovery validated
  in blocks. Sources/owned blocks 18/0 HTTP/TLS + normal APK/test/JVM54/lint.
  Blocks uses controlled ownership with real decoders; not all audio
  combinations generate bridges in Core. See evidence/s3b.json for the exact scope.
- Both PCM inputs: 2/0 HTTP/TLS, 46.949s on 450b207d dirty. No removal
  without a healthy counterpart; when outgoing returns, non-silent PCM, epoch/clock retained.
  It does not test a permanent failure of both network streams.
- Long service/controller queue: 2/0 HTTP/TLS, 23.115s on 6bd23fc4 dirty.
  Real DJ Core + append 1000; MediaController seek 996/6000ms, trim to 4 retains
  KEY/token/position/pause, append to 5 and PCM resume. No soak of 1000 natural songs.
- The last green main 130/0 on clean d7e95c44 predates the
  earlier changes. Restart prepare 1/offline 1 and normal APK/test/JVM52/lint pass there.
- The last green Browser4 predates S3: Chromium 278/66 skips, WebKit 269/75 skips.
  Repeat all profiles before the PR; never replace them with targeted tests.
- Live and permanent signing/public update remain pending. Invitations,
  multi-device, remaining settings and the public bridge/App Links remain pending.

### Last integrated block and next work

S5a Auto: code moved from `/tmp/soundsible-auto-next` without changes after validation.
**12/0 HTTP/TLS, 94.079s, runner exit 0** in `/tmp/soundsible-auto-search-connection-native.log`.
CarLibrary2 + CarLegacy2 + CatalogSearch2 + TransportReset2 + Connection4.
APK/test APK/JVM54/lint pass without temporary CA. Core car/playback 11/0.
See [S5a](SLICE_5A.md) and [evidence/s5a.json](evidence/s5a.json).

Includes authenticated tree, canonical selection, Radio/podcasts, search over the
acquired library/playFromSearch, offline copies with 503 and covers granted
through an opaque URI. 401 clears copies/program/grants. Modern/classic SameUID does not prove
the Google Auto host, external trusted classification or grants to another UID.

Main regression on dcdd6a3b: 144/2, 1984.904s, exit 1; failures only in CatalogSearch
because of a global selector that opened a queue row. Normal/restart skipped by the runner.
Fix c1b8c6b4 confirmed in a joint block; keep the failed record in
s3b.json. The earlier green main 130/0 is not equivalent to a green current regression.

Next S5b: update of subscriptions/tree in background, reconnection and
controls/metadata during DJ; review offline when the cookie expires without an observed
401. Fix the root/children guard against a generation that changes between
capturing the epoch and reading identity (return a typed error, never a callback exception).
S5c allows local root/copies/search with a verified profile after the cookie expires;
Core folders denied and placeholder artwork. 8/0 HTTP/TLS, 60.403s + normal
APK/test/JVM54/lint without CA. See SLICE_5C and evidence/s5c.json. Covers are a
native process cache; do not claim offline covers after process death.
Host/DHU and external permissions remain pending; physical acceptance for beta.

S5b validated: 8/0 HTTP/TLS, 50.108s, exit 0 + normal APK/test/JVM54/lint without CA.
See SLICE_5B and evidence/s5b.json. The car's lazy native socket updates labels and
playlist counts after closing the Activity, keeps KEY/PCM and respects unsubscribe.
A concurrent 401 returns expired authentication to pending browse calls; a reset because of
disconnection keeps another reason. Root/children tolerate an epoch change when reading
identity. There is no active suite after exec21942; AVD5554 is still available.

S5c validated and pushed 6c906d2f: an expired cookie without 401 does not delete copies with
backend 503; local root/search/play and logout tested in block 8/0, 60.403s, exit 0.
There is no active suite after exec24330.

S5d validated: local copies observer, block 8/0 HTTP/TLS 101.090s and
completed in background 2/0, 38.286s; both normal APK/test/JVM54/lint without CA.
See SLICE_5D/evidence/s5d.json. There is no active suite after exec53504.

S5e validated: CarDjTest2/0 HTTP/TLS + normal APK/test/JVM54/lint without CA;
see SLICE_5E/evidence/s5e.json. Modern/classic browsers keep the DJ program
on browse/pause/seek/resume and reflect the dominant song. No active suite after 49040.

S5f validated: CarEventsTest2/0 HTTP/TLS + normal APK/test/JVM54/lint without CA.
Transport close + handshake 503 observed, reconnection recovers a lost label
with the Activity closed and keeps NORMAL KEY/PCM. Production unchanged; the fixture
speeds up heartbeat only in the test. See SLICE_5F/evidence/s5f.json. No active suite after 6518.

S5g validated: external without trust rejected and authorized listener browse/read PNG
through an opaque URI, write denied. CarExternal2 + Legacy2 + Library2, 6/0 HTTP/TLS
+ normal APK/test/JVM54/lint; see SLICE_5G/evidence/s5g.json. Production fix:
fallback to system trust on API28+ only with a verified package/UID.
No active suite after 95429.

S5h validated: CarExternal2/0 HTTP/TLS + normal APK/test/JVM54/lint without CA.
External playFromMediaId observes the canonical ID/playing and PCM; the URI reopens before
logout and is denied after it. See SLICE_5H/evidence/s5h.json. No active suite after 75392.

Priority corrected because of the user's cost/time: stop granular Auto
extensions for now and complete Live, the largest functional gap. Then close pending
phone/DJ/Auto items, signing and the final regression/browser4. Google Auto host not run.

S4a validated: LiveInputTest3/0, 12.817s (NORMAL Core HTTP/TLS + synthetic PCM),
runner exit 0 and normal APK/test/JVM54/lint without CA. Real WebRTC/Opus between peers,
mono16k→stereo48k, local mute keeps the broadcast, pause=zeros and resume recovers PCM.
No AudioRecord and no microphone permission; native post-DSP/pre-volume input.
See SLICE_4A/evidence/s4a.json. Dependency SHA pinned, Java JNI recorder replaced,
rest of the SDK/binaries intact and licenses in assets; Python 2/0, normal recheck notices.
Next: WHIP/WHEP with an isolated relay, then room/chat/background/UI. Live is not
complete and there is no parity. No active suite after 63622/74578. Do not copy the old Auto clone over root; the current source is root. Updating the tree does not prove updated
labels of the active program. Then external UID, DJ negatives, Live/phone/
signing and the final regression/browser4. Clone /tmp/soundsible-auto-next was already moved;
do not copy it over the current root. Do not apply the old stash/clone. No merge/automerge/release.

### Commands and operating rules

- JDK21: /home/arsu/.cache/soundsible/android-toolchain/jdk/jdk-21.0.12.1+1;
  SDK: /home/arsu/.cache/soundsible/android-toolchain/sdk. Export JAVA_HOME,
  ANDROID_HOME and their bin in PATH **for prepare and integration**.
- `.venv/bin/python scripts/android.py prepare`; integration with android.py
  integration. Targeted runs through ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class.
  Gradle only :app:*; never npm run build in ui_web. UI: npm test + tsc.
- Do not use the real engine/accounts. Fixtures 5097/5098/5099; do not log secrets.
- Before the PR: full browser4 suites, fetch and ancestry of current origin/main,
  exactly one impact label. Each validated implementation ends with commit/push.
- The old clone /tmp/soundsible-android-next has sharing already integrated and old
  network work in a stash; do not apply or copy it over the updated main checkout.
- Earlier Live research not implemented: JavaADM AudioRecord is not an external PCM
  input; SamplesReadyCallback does not inject the program. Validate post-DSP/
  pre-volume input without microphone and independent receiving before claiming broadcast.

S4b native relay validated: Core HTTP/TLS creates a signed session in real Community;
authenticated WHIP HTTPS → MediaMTX pinned by digest → WHEP HTTPS → native PCM.
Local mute, pause/silence, resume, closed Activity and a second publisher rejected
without losing the tap. 2/0, runner exit 0 + normal APK/test APK/JVM54/lint without CA.
See SLICE_4B/evidence/s4b.json. The runner starts a disposable relay automatically
in main or with the LiveRelayTest filter. Next priority: socket/lease and host
metadata from the service, UI adapter and MediaSession listening. No parity yet.

S4c host owned by PlaybackService: signed session, WHIP + Community socket,
metadata/heartbeat without Activity, title and chat; secrets only in the service.
Host2 + Relay2 + Input3, 7/0, 42.984s, runner exit 0 and normal APK/test APK/JVM54/lint
without CA. An explicit end deletes the room keeping KEY/local playback. See SLICE_4C and
evidence/s4c.json. Next: native MediaSession listening and UI controls; then
DJ/metadata/artwork and recovery. No active suite after exec30219. AVD5554 still running.

S4d NativeLivePlayer listening in MediaSession: Listener2 + Host2 + Relay2 + Input3,
9/0, 54.967s, runner exit 0 + normal APK/test APK/JVM54/lint without CA.
Independent PCM via relay, pause/volume/closed Activity/stop-prepare/return
to NORMAL; received Live is not recaptured for broadcast. Real fix: music
selection commands when leaving Live. See SLICE_4D/evidence/s4d.json.
Next: UI controls + guest socket/metadata/artwork, then DJ/recovery.
No active suite after exec11498. AVD5554 still running. PR only open/manual review.

S4e native UI/guest: directory through NativeLiveDirectory (WebView blocks remote
JSON), real host and guest controls/chat from Solid→Capacitor→service.
Guest receives program/MediaSession metadata/chat/presence/end from the native socket.
JS state without tokens. Listening hides queue/lyrics/DJ/autoplay as song actions.
Combined 11/0, 71.289s before the 401 probe; final attempt 11/2 only because of a fixture
marker omitted in both UI probes (the other 9 pass). Test fixed; UI2/0, 20.704s,
runner exit 0 + normal APK/test APK/JVM54/lint. 205/1599 and TypeScript pass.
The UI tests broadcast/title/chat/end and directory/PCM listening/pause/volume/chat/exit,
plus real 401→login/library/panel removed. See SLICE_4E/evidence/s4e.json.
Next Live: public DJ/transition metadata + artwork; media/network/
lease recovery and handshake/reset/process. No active suite after exec29062. AVD5554 still running.

S4f validated: Host4/Listener2, 6/0, 76.723s, runner exit 0 + normal APK/test APK/JVM54/lint
without CA. Real DJ to the relay with two tracks/gains/mix progress, NORMAL
publishes a private cover and the guest receives a public thumbnail in MediaSession.
Separate HTTPS client without Core cookies, bounded origin/room/bytes/dimensions.
TLS close fix only on a worker; deterministic DJ seed from current. See SLICE_4F
and evidence/s4f.json. Log /tmp/soundsible-live-s4f-corrected-native.log. No active
suite after 58980. AVD5554 still running. Next: media/network/lease recovery and handshake/
reset/process; then joint Live regression. No parity, merge or release.

S4g validated: combined Live 14/0, 148.745s, runner exit 0 + normal APK/test APK/
JVM56/lint without temporary CA. Host4/Listener2/UI2/Relay2/Input3/Handshake1: cutting
the real publisher keeps the room and recovers PCM; cutting the real listener keeps pause,
volume and identity. A slow 10s TLS OPTIONS is cancelled from main in less than 3s.
LivePeer.cancel + DELETE 2s + Location/media; retries 1/2/4s deadline 30s; lease
watchdog 10s implemented but exhaustion/lease still without targeted acceptance.
See SLICE_4G/evidence/s4g.json, log /tmp/soundsible-live-recovery-native.log.
No active suite after 13061. AVD5554 still running. Next: guest authorization before
WHEP (today Socket and media start in parallel), lease/polling and process death/
resume 409; service reset during handshake. Then DJ negatives, phone/
Auto/signing and final regression. No parity, merge, automerge or release.

S4h validated: Host4/Listener2 pass in combined 9/2; TLS UI chat was sent
before title finished, and an uncleaned room contaminated Polling. Only tests
fixed: UI2/Polling1, 3/0, runner exit 0 + normal APK/test APK/JVM56/lint.
Product identical between runs. See SLICE_4H/evidence/s4h.json, logs
/tmp/soundsible-live-leases-native.log and /tmp/soundsible-live-leases-ui-fixed-native.log.
Host/guest wait for Socket authorization before WHIP/WHEP; room rejection with
real WHEP produces no PCM. A lease lost in background removes Live after 10s,
keeping local playback; polling-only 35s on ping 20s stable. No active suite after
31747. AVD5554 still running. Next: process/resume 409 and exhaustion/reset. The
dead publisher can keep occupying MediaMTX even if Core rotates tokens;
continuity must remove only the resource of the signed owner and be tested on a real
relay; POST resume is not enough. Current sources are in root. PR not created yet (gh pr view
verified). Not the end at a checkpoint, no merge/automerge/release.

S4i validated: signed resume removes the real publisher before rotating credentials,
keeps room/program and protects a late DELETE with if_host_token. Native creates or
resumes 409 and continues seq. Core 19/0; LiveResume HTTP/TLS2/0, 16.256s;
LiveRestart prepare 1/0, 5.935s + force-stop + resume 1/0, 5.277s: different PID,
encrypted cookie kept, same room, increasing seq and independent WHEP PCM.
Both runners exit 0 + normal APK/test APK/JVM56/lint without temporary CA.
Logs /tmp/soundsible-live-resume-fixed-native.log and
/tmp/soundsible-live-process-restart-native.log. See SLICE_4I/evidence/s4i.json.
No main/full browser regression in this block. AVD5554 still running, no
active suite. Next: Live exhaustion/reset/focus, then remaining phone/
DJ/Auto/signing and final regression. Open PR for manual review when parity is reached;
no merge, automerge or release. Community ping 20s/timeout 25s corrected in docs.

S4j targeted acceptance 4/0, 56.701s: listener real relay authorization rejections,
exactly four attempts, stable exhaustion, manual recovery/volume, transient focus
through AudioManager and noisy through system UID. Account reset during a
slow TLS OPTIONS removes the receiver in <3s; it does not retry in 8s or accept an old prepare.
Runner 53807 exit 0 + normal APK/test APK/JVM56/lint without temporary CA. Log
/tmp/soundsible-live-recovery-final.log. See SLICE_4J. Next: targeted publisher
exhaustion/reset, Live presentation/share and pending matrix items.

S4k validated: publisher HTTP/TLS2/0, 85.109s, runner 21182 exit 0 + normal APK/test APK/
JVM56/lint. Closed Activity: three real rejected retries, Live
removed stably keeping music/KEY, Go live recovers the same room. A second
cut + reset cancels retries without a publisher and without new authorizations in 5s.
Log /tmp/soundsible-live-publisher-exhaustion.log, SLICE_4K/evidence/s4k.json.
No active suite; AVD5554 still running. Next: program presentation and
Live sharing; then the remaining matrix and the final regression. No merge or release.

S4l validated: program primary/secondary/artist/thumbnail/mix/pause and common public
share web→native chooser. UI 206/1602 + TypeScript pass. Initial 4/1:
HTTP UI/Share2 pass; TLS UI tapped a disabled Pause during a volume change.
The test waits for available controls; slider disabled while busy. Final UI2/0,
24.451s, runner 36960 exit 0 + normal APK/test APK/JVM56/lint without temporary CA.
Real WebView image, intercepted chooser and rejection of extra/duplicated query/fragment.
SLICE_4L/evidence/s4l.json, /tmp/soundsible-live-presentation-fixed-native.log.
No active suite, AVD5554 still running. Next: invites/admin/multi-device
according to the real inventory, DJ/Auto negatives and distribution; final main/browser4
still pending. Open PR manual review, no merge/automerge/release.

S2aj validated: invite pasted explicitly in the connection, native preview/accept,
confirmed password, profile/cookie bind and isolated library without reload.
Native 2/0 HTTP/TLS, 17.238s, runner 28188 exit 0 + normal APK/test APK/JVM56/lint.
Initial 2/2 because of a test helper that expected an unconfigured startup even though Core was still
configured; fixed with fresh start/wait for library on recreate. Whole UI 208/1606
before the copy hint and the pending preview message guard; final targeted 5/0 and
TypeScript pass. SLICE_2AJ/evidence/s2aj.json, log
/tmp/soundsible-invite-corrected-native.log. No active suite, AVD5554 still running.
Next: admin and controls/handoff between devices, DJ/Auto negatives,
distribution and final regression. OS invite intent not tested yet. Manual PR;
no merge/automerge/release. Current sources are in root.

S2ak validated: Settings People admin-only reuses the web panel with account/current
and guards after dialogs/responses/copy; cleanup invalidates. Whole UI 209/1610 +
TypeScript pass; UsersTest HTTP/TLS2/0, 25.67s, runner 53270 exit 0 + normal APK/test APK/
JVM56/lint. Admin creates account/invite and deactivates, confirmed by Core; member
without menu or access to /api/users 403. SLICE_2AK/evidence/s2ak.json, log
/tmp/soundsible-people-native.log. No active suite, AVD5554 still running. Next
multi-device: owner/socket in PlaybackService with playback_register, events
playback_*_requested and Core state/handoff; do not activate web audio/store.
ProgramCarSubscriptions only when subscribing Auto, not a general remote owner. Missing:
DJ/Auto negatives, signing/distribution and final main/browser4. Manual PR.

S2al accepted: NativeDeviceSession owns authenticated Core registration/control
with Activity closed. NORMAL bounded state and real incoming handoff preserve
queue/index/position/shuffle/repeat; remote resume preserves occurrence identities.
Two Core bugs fixed: socket registration binds its account rather than default;
remote pause retains track/position/session, avoiding immediate-play404.
Core14/0; DeviceSession HTTP/TLS2/0,15.639s; integration exit0 and normal APK/test
APK/JVM56/lint without fixture CA. Log /tmp/soundsible-device-session-final-native.log.
See SLICE_2AL and evidence/s2al.json. No UI change in this slice.
Next device-list UI/outgoing handoff, DJ/Radio workspace and pending catalog
restoration; then remaining pairing/public links, DJ/Auto negatives, distribution
and final principal/browser4. Do not claim full multi-device parity yet.
Never merge/automerge/release; final PR stays open for manual review.

S2am accepted: Settings Devices reads native service identity, lists account-scoped
Core devices and sends controls through authenticated native HTTP. UI210/1613+TS;
DevicesUi + DeviceSession4/0 HTTP/TLS,31.097s, runner exit0 + normal APK/test
APK/JVM56/lint. Core15/0; /api/devices now exposes socket_active from active_sid
for shared web/native UI. Earlier UI test failure was API contract mismatch,
not registration overwriting SID; latter was an incorrect intermediate diagnosis.
See SLICE_2AM/evidence/s2am.json. Next outgoing handoff must publish exact fresh
native state then call Core handoff with same-account/generation checks. Full DJ/
Radio/pending catalog restore, public invite intents/pairing, negative coverage,
distribution and final full suites remain. Continue; PR manual, no release/merge.

S2an accepted: Settings transfer delegates to native actor, verifies same-account
online peer, publishes fresh bounded NORMAL queue/position then calls Core handoff.
Queue/preferences/transport/identity changes cancel pre-send, reset cancels future/
request, no optimistic source pause. Real UI to remote Core socket + source pause
HTTP/TLS, combined DevicesUi/DeviceSession4/0,31.965s; normal APK/test/JVM56/lint
and integration exit0. UI210/1614+TS. FR/ZH transfer label added after native runner,
covered by final UI typecheck/tests; no four-language native claim. SLICE_2AN and
evidence/s2an.json. Outgoing DJ disabled until workspace restore complete. Next
DJ/Radio/pending catalog and device reconnect exhaustion; then remaining public
invites/pairing, DJ/Auto negatives, distribution, principal/browser4. Continue.

S2ao accepted: shared auto workspace restored in native dual decoders at index/
position with source trays/direction/profile/heard/avoid/exploration and proposals.
Wire transition fromKey = musical identity, native fromKey = preceding occurrence;
bridge owners remapped; public plan labels preserved. Genuine Core handoff marker
prevents same-queue resume optimization discarding edits from another device.
Native DJ background controls and incoming/outgoing PCM/socket contract, returned
direction edit and malformed-profile refusal pass HTTP/TLS; combined6/0,51.706s;
Core16/0; runner exit0 + normal APK/test/JVM56/lint. SLICE_2AO/evidence/s2ao.json.
NORMAL test seeks shortened for independence from short PCM fixtures; historical
54s/123s evidence unchanged. Next Radio workspace + pending catalog resolution,
device reconnection exhaustion, public invites/pairing, broader negatives,
distribution and final principal/browser4. Do not merge/automerge/publish.

S2ap accepted: Radio seed/profile/intent and generated occurrence ownership survive
incoming/outgoing NORMAL handoff; Stop keeps manual future and current identity.
Autoplay imported markers obey receiver account setting; disabled strips only its
runway. Shared radio fields active/seedId; profile/seed are native extensions,
balanced default for web/common snapshots. Context metadata + identity/loudness
facts retained for imported NORMAL. DeviceRadio+DeviceDj+DeviceSession+DevicesUi
8/0 HTTP/TLS,86.694s; exit0 + normal APK/test/JVM56/lint. See SLICE_2AP/evidence.
Next device reconnect exhaustion and deferred catalog playback/handoff, then
public invites/pairing, broader negatives, distribution and final full suites.
Continue; no PR merge/automerge/publication. Last UI complete210/1614+TS unchanged.

S2aq accepted: exhausted device Socket.IO manager is retired and retried after30s
cooldown with cookie/profile revalidation and stable UUID. Actor reset removes
manager callbacks. Activity-closed real transport503 exhaustion/recovery while
20s PCM repeats, same device registration/publication and restored remote controls
HTTP/TLS2/0; exit0 + normal APK/test/JVM56/lint. SLICE_2AQ/evidence/s2aq.json.
Initial fixture-path test issue corrected with raw test client; no production
path restriction weakened. Next deferred catalogue: retain pending entries and
resolve in native source loader, generation/occurrence guarded, no web audio.
Then public invites/pairing, broader negatives, distribution and final full suites.

### Environment recovery after restart

Current workspace: `/mnt/storage/Git-projects-storage/soundsible` on HDD ext4
`/dev/sda1`, mounted rw. On 2026-10-06 write/read/fsync and fetch
from GitHub were verified; HEAD b119384d was already on the remote. `/home/arsu/soundsible` was a
clean clone from June (`new-ui`, HEAD 3e4a961, an ancestor of the current work),
without exclusive commits or pending non-ignored files. Deleted at the user's
request; `.claude`, `.gstack` and the ignored `.env` were preserved outside the repo
in `/mnt/storage/Git-projects-storage/recovered-soundsible-home`. Do not copy that
backup over the current work or publish its content. AVD API36 restarted.
The earlier `/tmp` logs do not survive the restart; evidence JSON and commits
keep the historical results; do not claim that they were rerun.

S2ar validated: pending catalog in NORMAL and collections UI, Core source loader
with Activity closed, identity/context kept, replay without an extra matcher and
reset during a slow matcher without resurrection. DeviceCatalogSession2 +
CollectionProfile4 + CatalogSearch2 HTTP/TLS8/0, 95.019s; runner exit 0 and normal
APK/test APK/JVM56/lint. Whole UI 210/1616 + TS pass. Log
`/tmp/soundsible-deferred-native.log`, SLICE_2AR/evidence/s2ar.json.
Immediate next step: matcher 404 must continue the collection; bounded temporary retry,
DJ/Radio menus must not turn pending items into a local source. Then OS invites/
pairing, DJ/Auto negatives, signing/distribution and final main/browser4.
Manual PR, no merge/automerge/publication.

S2as validated: matcher 404 continues to the next song; two 503 retries
recover PCM and three attempts exhaust stably; explicit Retry keeps the row and
recovers. HTTP/TLS2/0, 51.339s + runner exit 0 and normal APK/test APK/JVM56/lint.
Whole UI 210/1617+TS; Core fixture 1/0. SLICE_2AS/evidence/s2as.json.
Next: guard for the pending occurrence menu (AndroidStart currently rebuilds
the fallback without pendingResolve), and VIEW/SEND invites with an explicit action
without changing account/origin when they are received. Then pairing/negatives/signing/final.

S2at validated (Claude Code takes over from Codex): an invite shared through SEND is a
proposal; without a session Connect, with a session a notice + "Use invitation" signs out
explicitly (Android makes the choice, it does not copy the web discard). The pending
occurrence menu only removes (negative verified). Combined 8/0 HTTP/TLS,
66.403s, runner exit 0 + APK/test APK/JVM56/lint; UI 211/1620+TS. SLICE_2AT/
evidence/s2at.json. Parity = functions: if the web uses a workaround because of a browser
limitation, Android does it in the best native way. Next: public
bridge/App Links (VIEW https), DJ/Auto negatives, signing/distribution and
final main/browser4 regression. Manual PR, no merge/automerge/publication.

S2au validated: native Settings with Library, Downloads (admin), Community,
About and Devices (name per installation + paired). Views extracted
from SettingsSections and shared with the web. Default name from the system and
immediate re-registration. Block 22/0 HTTP/TLS, 280.499s + normal; UI 213/1631+TS.
SLICE_2AU/evidence/s2au.json. Next: inventory of the
remaining parity (library/search/queue/podcasts), DJ/Auto negatives, signing and
final main/browser4 regression. Manual PR, no merge/automerge/publication.

S2av validated: the user decided that the pairing QR starts a full
session of the account that shows it (not a restricted token as in iOS). Core claim
`credential: session` only with the sheet open, linked and revocable; Android scans
with CameraX+ZXing (without GMS) or a typed code; the QR uses the visible address/connected
server. Block 20/0 HTTP/TLS, 235.817s + normal JVM59/lint; Core 78; UI 215/1637.
SLICE_2AV/evidence/s2av.json. Next: inventory of the remaining parity
(library/search/queue/podcasts), DJ/Auto negatives, signing and final
main/browser4 regression. Manual PR, no merge/automerge/publication.

