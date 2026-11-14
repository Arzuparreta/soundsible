# Dependency update in three blocks

Maintainer decision, 2026-10-11: start with security and consistency,
complete the validations and leave a PR open, without merging it.

## Block 1 · Immediate value

- Fix the compatible advisories in Python, npm and Rust, without migrating tools
  or platforms. Also raise the security minimums for new installations
  and regenerate the Docker lock with Python 3.13, keeping the rest.
- Align the sidecar's yt-dlp with the engine; packaging installed it after
  the general requirements and could roll it back to an older version.
- Fix and diagnose the Android failure on `main` reported by the maintainer.
- Validate before opening the PR; wait for all checks on its latest head.

Changes in this delivery:

| Area | Change |
| --- | --- |
| Python | cryptography 50.0.2 except on Intel Mac (48.0.1 to <49 to keep wheels), Werkzeug 3.1.9, urllib3 2.8.0 and Flask 3.1.3. |
| Community | Flask 3.1.3, Werkzeug 3.1.9 and cryptography 50.0.2; Flask-SocketIO 5.6.1 for compatibility with the fixed Flask RequestContext. |
| Sidecar | yt-dlp 2026.8.19, same as requirements.txt. |
| npm | Vitest 4.1.11 in both clients; Solid 1.9.17 allows seroval/seroval-plugins 1.6.9. Locks with the compatible patches of the affected transitive dependencies and their dependencies. |
| Rust | rustls 0.23.42 → 0.23.45 and rustls-webpki 0.103.13 → 0.103.15; rest of the lock kept. |

### Advisories that are not resolved by forcing versions

The review found that cryptography 49 removed the macOS x86_64 wheels.
The documented native installation does not require Rust/OpenSSL to compile it:
requirements.txt selects >=48.0.1,<49 only on Intel Mac, the last line with
universal wheels, and >=50.0.2 everywhere else. That exception is not presented as
free of advisories: OSV still reports three distinct problems (PKCS#7 and two in the
X.509 verifier), also published as PYSEC. Soundsible uses Fernet,
PBKDF2 and Ed25519; it does not call PKCS#7 decryption or the X.509 verifier of
cryptography. The exception and its advisories remain visible; the other
platforms and the containers receive the fixed version. See the
[changelog](https://cryptography.io/en/50.0.2/changelog/#v49-0-0) and
[the 48.0.1 wheels](https://pypi.org/project/cryptography/48.0.1/#files).

`npm audit` goes from 13 affected packages to 3 in web and from 4 to 0 in the shell.
In web a single moderate chain remains: `@capacitor/cli → xcode → uuid`.
The [UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq) affects
v3/v5/v6 with buffers; `xcode/lib/pbxProject.js` uses `uuid.v4()` without a buffer.
In addition, Soundsible uses Capacitor for Android and its iOS app is independent Swift.
The documented advisory is kept: no uuid major is forced inside xcode,
and the Capacitor downgrade proposed by `npm audit fix --force` is not applied.

OSV queried the 656 pinned package/version combinations of Docker, community,
sidecar and Cargo: no Python advisories remain, and the fixed rustls TLS advisory is gone.
`glib` 0.18.5 remains in the Linux GTK chain, with
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
`cargo tree --locked --target x86_64-pc-windows-msvc --invert glib` and the same
query for ARM64 do not find that package in the Windows installers,
the only distributed desktop clients. The lock keeps the Tauri Linux
dependency; glib 0.20 is not forced inside an incompatible GTK family.

The other seven Rust advisories are maintenance advisories: `paste`, `proc-macro-error`
and five `unic-*`. They remain visible for block 2; they are not presented as
seven exploitable vulnerabilities or as resolved problems.

### Android failure and diagnosis

The [main run](https://github.com/Arzuparreta/soundsible/actions/runs/38135594239)
failed in `LiveListenerTest.httpCoreRelay`, with
"Activity close stopped remote programme". The other three shards and the build
passed. The log shows the receiver active until the cleanup after the assertion;
that alone does not prove that there was audio, nor does it allow blaming the close.

The test mixed WHEP recovery, READY state and audio after closing the
Activity. It now requires new decoded audio after the recovery,
before closing, and at least 50 non-silent buffers after the close.
It counts the buffers in the callback: reading the latest RMS every 50 ms
could miss buffers that arrived between two polls. The timeout keeps its
20 seconds; no retries are added. The failure prints the controller state,
decoded/audible buffers, publisher buffers and latest RMS to
distinguish transport, source, audio and lifecycle in a future regression.

Of the last 25 Android runs examined, 18 passed, 4 failed and 3 were
cancelled. The failures do not have a single cause: two were the incomplete cookie
registration of the podcast fixture (already fixed in main), another had
outdated menu expectations (already fixed in PR #344) and the last one
was Live. It is not concluded that all Android CI is flaky, nor that rerunning it closes
a failure: any new assertion must be reviewed with its artifacts.

### Validation

- Python 3.13, lock installation with hashes: 1921 tests, coverage 76.54 %;
  Ruff, pip check and version sync passed.
- Intel Mac exception: marker selection in five
  platform/architecture combinations; pip download --only-binary retrieves the universal wheel
  of 48.0.1 for CPython 3.13/macOS x86_64. With 48.0.1, 38 backup,
  community identity and Subsonic authentication tests passed on Linux; that check is not
  presented as a native run on macOS.
- Community service in a separate environment with its real pins: 21 tests.
  Flask-SocketIO 5.5.1 failed with the updated Flask; 5.6.1 fixed that combination.
- Web: 1720 Vitest tests and typecheck. Shell: 9 tests and 13 browser cases.
- Chromium mobile/desktop: 320 passed, 66 skips defined by the profiles.
- LiveListener HTTP/TLS: three runs of the final class, 6 cases passed,
  plus JVM/lint/APK in each run. Evidence in docs/internal/android/EVIDENCE.md.
- WebKit mobile/desktop: 311 passed, 75 skips defined by the profiles,
  Playwright image on a read-only mount and one worker, after Chromium.
- Community Docker image built; it imports the expected versions,
  SQLite responds. Without relay, /health returns 503 with mediamtx=error, as required by
  the contract; the smoke test with the full relay is also checked in GitHub CI.
- The local Linux cargo test is limited by the missing javascriptcoregtk
  4.1. Compilation, packaging and smoke test of the Windows x64/ARM64 clients are
  validated by Desktop Build on the latest head of the PR.

## Block 2 · Compatible maintenance

Clients and infrastructure were initially validated in PRs #347 and #346.
To reduce CI before merging, both changes are now integrated in #347:
a single combined head, one independent review and all its checks complete.
#346 is incorporated; no release is published from this delivery.

1. **Clients, Python and Node.** Node 24.21.0 LTS as the reference in `.nvmrc`,
   CI and Docker; the manifests also accept Node 22.22.2+ and 26. Vite 8.3.4,
   Playwright 1.64.0 (CI image derived from the lock), coordinated Capacitor 8.5.3
   and Tauri 2.12.3 with its compatible plugins/transitive dependencies. Python: curl-cffi
   0.16.3, Flask-SocketIO 5.7.0, gevent 26.9.0, PyInstaller 6.22.3 and full
   regeneration of the Docker lock with hashes under Python 3.13. The compatible minimums
   of the native installation and the Intel Mac exception from block 1 are kept.
2. **Infrastructure.** Actions, MediaMTX, Coturn and FFmpeg, with their own validation;
   evidence in `docs/internal/audits/DEPENDENCY_INFRASTRUCTURE.md`. Deploying is not
   required to review these deliveries.

Vite 8.3 exposed a reproducible failure in the dependency scan with
`import.meta.glob` inside TSX: after stripping types, it tried to parse JSX
as JavaScript. The two recovery globs are extracted to TS modules without JSX;
they keep lazy loading and the alternative `?recovery` URL required by WebKit.
Startup with a cold cache no longer fails. The browser tests wait for the style
after the reflow and measure geometry in the same frame; the playback check
after recovering a module also finds the mini-player hidden under the panel.
The DJ fixture waits for the panel content to be visible before responding
the first time and keeps the final response pending until the wait is verified; a slow animation cannot consume that state before the assertion.
With two CPUs and cold startup, a real WebKit failure was also reproduced: the
global reduced-motion rule gave a non-zero duration to the visibility transition
of every descendant. The panel was revealed layer by layer and its rows
stayed hidden under load. The rule now disables the transitions; it keeps
the animation events and the user preference. The timeout is not increased,
no retries are added and the Android audio requirement is not reduced.
In production, the failure fixture keeps the 503 until retry is pressed: failing
only the preload let the later import load the module correctly.
The four actions of a found song have independent tests and
a restored session and a short queue; the favourites test starts from a
song that is already saved, as the product requires. Coverage of long queues
remains in its own cases.
A second shard flagged as flaky the mobile test that accumulated two insertions
and the movement geometry. Each insertion now has its own case and the
geometry prepares two requests through the real store. The mobile fixture serves
valid silent WAV instead of the JSON fallback, avoiding decoding failures
that advanced the transport during the gestures. Retries and timeout are not changed.

Local validation of clients/Python:

- Docker lock installation with hashes: 1921 Python tests, coverage 76.54 %;
  Ruff, dependency check and version sync passed.
- Community environment with its real pins: 21 tests passed.
- Web: typecheck and 1720 tests; shell: 9 tests and 13 browser cases.
- Before opening the PR, Chromium mobile/desktop: 320 passed and 66 profile skips. Then,
  WebKit mobile/desktop: 311 passed and 75 skips, read-only Playwright image
  and one worker. The DJ case also passed six consecutive isolated runs
  in WebKit. The failures were diagnosed and fixed before
  opening the PR; all GitHub CI passing on its latest head is also required.
  The first CI failed in the library refresh. Its fixture only closed
  playback and left the syncs/timers of the previous client alive.
  It now calls the full disposeStore before changing the module registry.
  The DJ ownership and podcast token tests wait for the expected observable
  state, not a single timer turn that could finish before the asynchronous work
  on loaded runners; they keep their original assertions.
- After the CI fixes: module recovery in production passed in
  the four profiles and the eight DJ actions passed in WebKit mobile/desktop
  limited to two CPUs. The full rerun passed 328 Chromium cases (68 skips) and 319 WebKit
  (77 skips), in that order and without local retries. Green on every
  check of the latest remote head is also required before the delivery is considered complete.
- Android: StartupTest, PlaybackTest and LiveListenerTest, 5 native HTTP/TLS cases
  passed on AVD API 36, plus JVM/lint/development APK with JDK 21 selected
  only for those commands. The local test does not include OfflineRestartTest;
  the four full shards and Windows x64/ARM64 are validated in GitHub CI.
- Local Cargo is still limited by the missing javascriptcoregtk 4.1; it is not equivalent to
  validating the Windows installers. The global Java and Node are not changed.

Advisories: `npm audit` keeps the moderate chain Capacitor CLI → xcode → uuid
(3 web packages, none in shell) with the disposition documented in block 1.
OSV queried 662 pinned combinations: no Python advisory in those locks; what remains is
`glib` 0.18.5, `paste` and `proc-macro-error`. The five abandoned `unic-*` go away
with the new Tauri family. `glib` is still absent from both Windows targets. `dirs`
6 is still the direct dependency; the new `dirs` 7 in the lock is a Tauri
transitive dependency, not a migration of our own code. The Intel Mac exception keeps its
advisories and its limits as explained in block 1.

## Block 3 · Major migrations

State checked on 2026-10-12: blocks 1 and 2 are integrated in `main`
(PR #345 and #347). All checks on the latest head of #347 passed, except
the release tag, which was deliberately skipped. #346 was incorporated into block 2.

First delivery of block 3: Android transport and desktop directories.

- OkHttp 4.12.0 → 5.4.0. Gradle selects the Android artifact and aligns the
  Media3 and Socket.IO chains on the same version. It keeps minSdk/targetSdk and
  compileSdk 36; ECH is not enabled and Soundsible's certificate, redirect
  or DNS policy is not changed. The HTTP/2, timeout and
  transport fixes are described in the [official changelog](https://raw.githubusercontent.com/square/okhttp/master/CHANGELOG.md).
- 5.5.0 was tested: `:app:checkDebugAarMetadata` rejects it because it requires
  compileSdk 37. The 5.4.0 AAR requires 36. The jump to 5.5 stays tied to the
  AGP/SDK evaluation, without suppressing that gate or raising SDKs automatically.
- dirs 6 → 7 as a direct dependency; version 7 was already in the lock because of
  Tauri. Only Soundsible's selection in the lock changes. The incompatible change
  affects `preference_dir` on Windows; our own code only uses `config_dir`,
  whose destination does not change. See the [dirs changelog](https://docs.rs/crate/dirs/7.0.0).
- Full local Cargo is still blocked by the missing JavaScriptCoreGTK 4.1.
  The real `state.rs` module compiles with dirs 7 in a temporary crate and its five
  existing tests pass. This does not replace the Windows packaging in CI.

Local validation: 64 JVM tests, lint and APK passed; StartupTest,
PlaybackTest and LiveListenerTest on AVD API 36, five cases passed over
HTTP/TLS without skips. OkHttp's AndroidX initializer present in the merged
manifest. Evidence and limitations in `docs/internal/android/EVIDENCE.md`.
The first CI detected `StackOverflowError` in shards 0 and 3: when
an owned executor is retired, OkHttp 5 can call `onFailure` on the same stack
as `enqueue`. Engine.IO tries to close polling from that callback and reenters
before marking the transport as closed. `SocketIoCallFactory` queues the
failures on EventThread in all Socket.IO transports; it keeps cancellation,
cloning and response callbacks. The executor shutdown is not delayed or removed.
The JVM test uses a handshake and the real stopped executor: it reproduces
the overflow without the adapter and passes with it. Eleven native cases of
markers, Live recovery, polling and HTTP/TLS reset pass; JVM suite:
65 tests. Logs in `/tmp/soundsible-socketio-integration.log` and
`/tmp/soundsible-socketio-baseline.xml`.

The remote gate requires the four Android shards and the two Windows installers
on the latest head of the PR. Nothing is published or merged automatically.

Pending after this delivery; evaluate benefit, compatibility and cost:

- Python 3.15; Debian Trixie is handled in the delivery described below.
- Vitest 5: delivery described below.
- AGP 9 + Gradle 9 + built-in Kotlin: delivery described below.
- OkHttp 5.5 together with compileSdk 37: delivery described below.

The Android/iOS minimums are not raised automatically. Each migration requires
its functional and packaging validation; being on latest is not a
compatibility gate. AltStore PAL remains unverified. No release is published
and the Soundsible version is not modified in these blocks.

### Vitest 5 · 2026-10-12

#349 was merged into `main` after 26 passed checks, four workflow skips
and a Codex review of head `49d6013d` with no findings or inline comments.

Web and shell go from Vitest 4.1.11 to 5.0.4 with their locks. The existing
Node/Vite minimums satisfy the new requirements. `clearMocks: true` is accepted
as the default: no test requires shared history between cases. No
compatibility flags are added and no assertions, configuration or product code
are modified. Only Vitest and its associated transitive dependencies are updated. Reference:
[official migration guide](https://vitest.dev/guide/migration/).

Local validation: typecheck and 1,720 web tests; nine shell tests; full
Chromium mobile/desktop suite, 328 passed and 68 skips; then WebKit mobile/desktop,
319 passed and 77 skips, one worker and read-only mount, without retries.
Logs `/tmp/soundsible-vitest5-{ui,shell,chromium,webkit}.log`. A local
`npm run build` is not run. npm audit keeps the three packages of the moderate chain
Capacitor CLI/xcode/uuid in web and none in shell. The remote checks of the latest head are mandatory before the merge. The
remote review is optional; it can be replaced by a harness-agnostic subagent
or omitted depending on the change. Another account's quota does not block the work.

### Debian Trixie · 2026-10-12

#350 (Vitest 5) was merged after full passing checks and a Codex review
with no findings of head `d05f92a2`. The first Windows x64 smoke test reached a
healthy engine and second launch, but failed when restoring from the tray, with a COM
focus error. A rerun of the same job/commit on a new runner passed the
unchanged assertion. Windows ARM64 and the four Android shards passed.

The engine's Node 24/Python 3.13 stages move from Bookworm to Trixie. The community
image and its CI stub declare Trixie explicitly instead of a floating `slim`.
Python, lock with hashes, user/UID, volumes and ports keep their
contracts; native installation minimums and desktop runtimes are not raised.

Stable Python 3.15 was published, but the direct Docker Hub check
rejected `python:3.15-slim-trixie` with `no such manifest`. The local uv
catalog only offered 3.15.0b1 and rejected 3.15.0; that beta was removed without being used in
validation. Production is not moved to a prerelease and no
alternative runtime is built by default. Reopen Python 3.15 when the stable image exists and
then validate lock, C extensions, gevent/curl-cffi and separate packaging.

Local validation: both images built; engine Debian 13/Python 3.13,
Debian's FFmpeg 7.1.5 and `pip check` passed. Ten FFmpeg runtime and
loudness tests against the real binary, ten community tests with their real pins
(and isolated test tools), passed. Healthy engine and compiled HTML/JS
served by the image; Community health 200 with SQLite and a MediaMTX
stub on an isolated network. Logs `/tmp/soundsible-trixie-*.log`. The full Python
suite and Docker x64/ARM64 are remote gates before the merge. The remote
review is not a gate: its lack of quota does not stop the authorized work.

### Android AGP 9 · 2026-10-12

#351 (Trixie) was merged after full passing checks.

Android toolchain: AGP 8.13.0 → 9.3.3 and Gradle 8.14.3 → 9.8.1 (latest stable),
with the wrapper regenerated and the SHA-256 of the distribution and of the JAR checked against
services.gradle.org.

AGP 9.4.1 was tested and is discarded for now. It runs the connected tests with
`android-test-engine` 1.0.1, pinned inside the plugin, which splits
`android-test.instrumentation-args` on commas without escaping: `notClass=A,B,C` reaches
the device as `notClass=A`, and a filter `class=A,B` as `class=A`, without
an error. In the full suite, LiveRestartTest and ReleaseUpdateTest were included, which
`scripts/android.py` excludes because they run in external phases, and
seven cases failed. With AGP 9.3.3 the same command keeps both values and runs
only the expected class. Engine 1.0.8 already parses escaped commas; reopen AGP
9.4+ when the stable plugin includes it and repeat the argument check
before changing the version. The
`org.jetbrains.kotlin.android` plugin is removed: AGP 9 compiles Kotlin built in and
`jvmTarget` 21 moves to `kotlin.compilerOptions`. AGP 9 behaviour changes
handled explicitly: `resValues` is enabled again (the development APK name
uses it) and `proguard-android.txt` no longer exists;
`proguard-android-optimize.txt` is used, with no effect while `minifyEnabled = false`.
The app script moves to assignment syntax, single-string dependency notation
and explicit lookups in `rootProject.ext`: no Gradle 10 warnings
of our own remain. The remaining ones come from AGP and from the build scripts generated
by Capacitor in `node_modules` and `capacitor-cordova-android-plugins`; they
will be resolved with their versions.

compileSdk 36 → 37 (stable platform `android-37.0` in CI, doctor and docs);
minSdk 24 and targetSdk 36 do not change, so no new system behaviours
are enabled and the supported devices do not change. With this, OkHttp 5.5.0
comes in. Libraries: CameraX 1.4.2 → 1.6.2, AndroidX activity 1.13.0,
appcompat 1.8.0, core 1.19.1, fragment 1.9.1, webkit 1.17.1, ZXing 3.5.4 and
test org.json 20260814. Capacitor stays on stable 8: 9 only exists as
alpha. Media3, Socket.IO, splashscreen, coordinatorlayout and test were already on
their latest stable version.

Local validation: 65 JVM tests, lint (0 errors), development and
test APK, and release APK signed with a temporary keystore (`apksigner verify`;
minSdk 24, targetSdk 36, compileSdk 37 in the manifest). AVD API 36, full
suite of `scripts/android.py integration` without shards: 215 cases, 210
passed. The five failures are TLS variants (CarLibrary, CatalogSearch,
Offline, Podcast and ProgramPcm). OfflineTest and ProgramPcmTest TLS fail the same way
on `main` (AGP 8.13, OkHttp 5.4) with the same local filter; CarLibrary,
CatalogSearch and Podcast pass in isolation on this branch (7 of 7). Local cause:
the TLS fixture closes a reused keep-alive connection and `OfflineStore`
downloads with `retryOnConnectionFailure(false)`, so the copy stays in
`network` (`EOFException` when reading headers). It is not an effect of this migration;
fixed separately: each offline download opens its own socket and never reuses
one from the pool (see `docs/internal/android/EVIDENCE.md`). StartupTest, PlaybackTest and LiveListenerTest (HTTP/TLS)
pass 5 of 5. PairingTest, which uses CameraX, passes.
The remote gate requires the four Android shards on the latest head of the PR.

Python 3.15 is still pending: Docker Hub only offers `3.15.0rc3` and
`python:3.15-slim-trixie` does not exist. It is reopened with the stable image. The other
direct Python, npm and Cargo dependencies were on their latest stable
version on 2026-10-12 (except daily boto3 patches, which the range allows).
