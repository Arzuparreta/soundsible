# Rendering and platform closure

Step 9 of the [web UI review](../../audits/WEB_UI_REVIEW_HANDOFF.md).

## Software-composition cause and fix (P6)

The current player scene still spent 3.28 s of a 3.2 s wheel burst in display
composition with the GPU disabled. Chromium `SystemInfo.getInfo` reported
`gpu_compositing: disabled_software`. Its WebGL renderer still named
SwiftShader, which is why a renderer string alone cannot establish the
compositor mode. With SwiftShader GL emulation instead, `gpu_compositing` was
`enabled`; these are different configurations. Every result records both.

Single-run causal probes on the same step-8 bundle:

| CPU-composited player browser | Complete / expected | Dropped | Display busy, ms |
| --- | ---: | ---: | ---: |
| Original scene | 85/203 | 117 | 3,236 |
| Wallpaper filter disabled | 199/200 | 0 | 512 |
| Surface transform disabled | 86/203 | 116 | 3,258 |
| Grain disabled | 87/204 | 116 | 3,280 |

The [filter](step9-cpu-no-filter.json), [transform](step9-cpu-no-transform.json)
and [grain](step9-cpu-no-grain.json) ablations preserve the exact injected CSS.
These probes isolate the current cost; they do not rewrite the earlier
reviewer's historical all-effects experiment as though it measured this code.

`ArtworkBackdrop` draws the existing cover/blur/saturation/brightness recipe
into a canvas on image, theme or size changes. Scrolling composites a bitmap
instead of filtering the viewport again. The artwork crossfade, slow drift,
veil, grain and theme opacity remain. One raster pixel per CSS pixel bounds
the heavily blurred bitmap without DPR-squared growth. The two crossfade
slots retain at most two bitmaps. Closed/hidden players defer new raster work
until visible. Engines without Canvas filter support retain the CSS fallback.

Three repeated production runs per case, same Ryzen/NVIDIA host, median
longest task. The committed JSON retains each run's frame counts and actual
GPU features. The final closed/document-hidden guard does not change the timed open
player path; a final exported bundle also passed the CI budget smoke.

### CPU composition

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms | Busy: main / compositor / GPU / display, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| songs (before) | 1× | 199/200 | 1/0 | 16.7 / 16.8 / 22.8 | 5.5 | 175 / 152.1 / 295.8 | 874.5 / 238.1 / 4.3 / 266.1 |
| songs (after) | 1× | 200/201 | 1/0 | 16.7 / 17.5 / 23.6 | 6.1 | 173.7 / 156 / 295 | 877.8 / 235.9 / 3.7 / 260.1 |
| player-browser (before) | 1× | 87/203 | 1/115 | 38.2 / 41.2 / 44.7 | 8.2 | 170.5 / 114 / 157.2 | 729.9 / 129.1 / 3.1 / 3281.6 |
| player-browser (after) | 1× | 198/200 | 2/0 | 16.7 / 18.4 / 23.1 | 6.5 | 217.4 / 146.5 / 383.3 | 1052 / 193.9 / 4.5 / 494.6 |

[Before](step9-cpu-before-final.json) / [after](step9-cpu-after-final.json).
Player complete frames rise 87/203 → 198/200 and display work falls
3,282 → 495 ms (85%). The ordinary Songs view remains about 200/201.

### SwiftShader GL emulation

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms | Busy: main / compositor / GPU / display, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| songs (before) | 1× | 200/201 | 1/0 | 16.7 / 17.9 / 24.1 | 8.3 | 224.1 / 222.5 / 396.7 | 1151.5 / 283.7 / 788.8 / 81.6 |
| songs (after) | 1× | 199/200 | 1/0 | 16.7 / 17 / 22.8 | 6.8 | 226.2 / 220.7 / 400 | 1149.4 / 286 / 783.9 / 80.4 |
| player-browser (before) | 1× | 197/222 | 13/12 | 16.8 / 19.5 / 23.3 | 14.7 | 364.8 / 252.5 / 469.4 | 1672.1 / 413.4 / 3303.6 / 131.7 |
| player-browser (after) | 1× | 199/200 | 1/0 | 16.7 / 18.2 / 23.1 | 7.6 | 298.7 / 200.2 / 364.7 | 1263.8 / 256 / 1194.6 / 81.3 |

[Before](step9-swiftshader-before-final.json) /
[after](step9-swiftshader-after-final.json). This is not CPU-only composition.

### Hardware composition and remaining limits

[The hardware run](step9-hardware-after-final.json) still has partial frames:
at CPU 6× Songs 195/272 complete and player browser 126/207. This step fixes
the measured software wallpaper bottleneck, not every slow-CPU style/paint
deadline. No physical X270, iPhone PWA, Android WebView or WebView2
performance acceptance, live-library acceptance or 144 Hz result is inferred.
No runtime/framework rewrite or reduced-artwork product mode is introduced.

## Touch ownership (X1)

Player, overlay dismissal and pull-to-refresh register non-passive `touchmove`
only during an eligible gesture, synchronously from passive `touchstart`.
Idle, excluded and already-scrolled surfaces do not register it. An upward or
cross-axis rejection, touch end/cancel, multiple touches and disposal release
it. Gesture thresholds, exit timing, body pull-down, sideways paging and
ghost-click shielding remain.

A trusted Chromium/CDP test inspects the real listener registry, scrolls a
deep list, rejects an upward gesture from the top and then dismisses the
player downwards. It runs with normal motion at CPU 6×. Unit coverage checks
registration/release and preserves existing overlay/pull gesture contracts.

Three-run native touch+fling measurements at 390×844 and CPU 6×:

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms | Busy: main / compositor / GPU / display, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| player-browser (before) | 6× | 54/68 | 14/0 | 16.6 / 22.7 / 33.8 | 38.5 | 162.7 / 89.7 / 85.2 | 339.6 / 18.3 / 142.2 / 15.8 |
| player-browser (after) | 6× | 55/69 | 14/0 | 16.6 / 22.7 / 32.3 | 39.9 | 153.9 / 83.8 / 92.6 | 330.3 / 15 / 103.7 / 9.1 |

[Before](step9-touch-before.json) / [after](step9-touch-after.json). The gesture
travels about 800 px, more than the actual inner scrollport's height, followed
by native inertia. Timing/frame ratios do not establish an improvement here;
the improvement established is releasing blocking listener ownership. Traces
include real `touchmove` and `scroll` events. Earlier synthetic-gesture
attempts with no motion were rejected, not included in the result. Wheel and
touch use different profiles and cannot be compared directly.

## Shared collections and activity

`VirtualBrowseRows`, native `ProgramQueue` and podcast episodes use
`CollectionRows`; the old `VirtualRows` integration is retired. Reused slots
read through accessors, stable occurrence keys are preserved across snapshots
and same-count reorder, and edited/focused queue occurrences remain pinned.
Menu actions capture the occurrence/episode at open time. DJ browser and
route projections pause with inactive phone panels/workspace/document;
transport/planning behavior and analysis versions are unchanged.

## Matrix and enforcement (X2)

The four whole-suite Chromium/WebKit profiles remain. Firefox desktop adds
shared design/menu/navigation/entity/scaling contracts with normal motion;
existing normal-motion player/navigation coverage remains on supported engines.
It does not run Chromium-only CDP or audio-clock probes.

CI's production-bundle smoke scrolls Songs, Albums and player browser with the
6,000-track fixture. It enforces ≤1,800 DOM elements, actual scroll and
presented frames, and uploads results/traces for seven days. Frame timing is
recorded rather than gated to an unstable shared runner's FPS. Local
[budget evidence](ci-scene.json) passed. Firefox/Linux WebKit are engine
coverage, not physical device acceptance.

## Android floor (X3)

API 26 / Android 8 aligns installation with WebView 120 and the Chrome 120
bundle target. Android 7 cannot install the required provider. This needs
`impact:major` because existing Android 7 installations cannot upgrade.
Capacitor routes an old WebView to independently packaged HTML before
loading the UI. The page has no JS or external stylesheet and links to
WebView/Chrome updates. `android.py prepare` validates the invariant and
packaged asset before sync. This is a development artifact, not a release.

Local `scripts/android.py build` passed APK/test-APK assembly and lint.
`aapt dump badging` confirms `sdkVersion: 26`; ZIP inspection confirms
`assets/public/webview-error.html`, WebView 120 and the matching configured
error path in the actual APK. The packaged update screen
was also rendered with JavaScript disabled; this is an HTML/package check,
not an old Android device test. Six checker tests passed. The separate `:app:testDebugUnitTest` task passed 102 tests in 27 report
files with zero failures/errors/skips. Remote emulator checks remain required.

## Validation checkpoint

- `npm test`: type checking, design-debt gate, 1,989 Vitest tests, seven
  trace/budget tests and three design-gate tests passed.
- Initial authenticated payload: 211,685 gzip bytes under the unchanged
  215,316-byte ceiling. Exported Vite output only; engine UI dist untouched.
- Whole Chromium phone/desktop suite: 454 passed, 78 intentional skips
  with two workers. Whole WebKit phone/desktop suite: 438 passed, 94 intentional skips
  with one worker. Firefox desktop normal-motion contracts: 51 passed, four intentional skips.
- Native JVM: 102 passed. Remote latest-head CI is pending.

Raw exploratory traces remain under `/tmp/soundsible-step9-*-traces` on the
measurement host; the stable summaries and probes above are committed.

## Validation incidents

The first whole Chromium run used eight workers: 451 passed, 78 skipped and
three failures. Two were an obsolete podcast selector for the retired
`VirtualRows`; it now targets `CollectionRows` and keeps the same wrapping-header,
first/last-episode and bounded-DOM assertions. The shared-tempo PCM test
reported 78 ms mean phase error against its 30 ms limit under that concurrent
load. No audio implementation changes are made in this step. Isolated and
final whole-suite results are recorded below; a later pass alone is not proof
that the native/audio cause was repaired.

The isolated Chromium pass ran shared-tempo PCM and all podcast contracts
with one worker: 33 passed and one intentional skip. The final full pass
uses two workers to limit unrelated concurrent renderer load; remote CI
retains its existing single-worker policy. No audio threshold was weakened.

The final whole Chromium run passed all 532 cases (454 passed, 78 intentional
skips), including the unchanged shared-tempo threshold. This narrows the
observed intermittency to a failing concurrent run versus isolated and lower-load
passes; it does not establish the internal cause of the PCM deviation.

Firefox's first screenshot pass produced all seven baselines and passed the
layout assertions, but one test ended with a legacy assertion that the browser
name must be Chromium or WebKit. That runner-name assertion was removed; the
viewport, control-size, clipping and accessibility assertions remain. All six
Firefox theme/density images and the high-contrast Settings image were visually
reviewed. The complete Firefox contract run passed: 51 tests and four intentional skips.

The first complete Firefox run found three false failures in the full-title
helper: with the actual UI font loaded, Firefox reports 33px scroll height for
a 31.05px line box (text range 34px), with both overflow axes explicitly
visible and no clamp. The text is not clipped. The helper now waits for fonts
and checks horizontal overflow plus actual vertical clipping/clamping, rather
than treating visible font ink outside tight leading as truncation. No product
CSS or font was changed. The portable title/scale contracts are re-run on all
four original profiles after that test correction.

Final portable title/scale revalidation: 46 passed on Chromium phone/desktop
and 46 passed on WebKit phone/desktop. The exported final production bundle
also passed the DOM/scroll budget again; [payload report](payload.json) records
211,685 initial authenticated gzip bytes. The fixture-only Vite server was
stopped after testing. All local gates are complete; latest-head remote CI
and fresh-base verification remain required for delivery.

## CI environment follow-up for PR #469

Head `9fdec01` exposed two deterministic configuration errors that the original
local environment did not reproduce:

- CI Node 24 treats `node --test perf/` as a module path and fails before the
  rendering bench runs. Node 26 accepts that directory argument. Both the
  package test script and workflow now select `perf/*.test.mjs` explicitly.
  Reproduced on Node 24.21.0 in the matching Playwright image: old command
  fails with `MODULE_NOT_FOUND`, explicit selection passes all seven tests.
- Actions mounts `/github/home` with UID 1001, while the browser container
  runs as root. Firefox rejects that home before running any test; all 55
  cases fail to launch. The Firefox matrix entry now gives only that ephemeral
  home directory the current process UID/GID, without changing `HOME` or
  recursively changing files. A tmpfs reproduction with owner 1001 confirms
  the original rejection and successful launch after the exact ownership fix.

The complete Firefox contracts passed again with the ownership correction:
51 passed and four intentional skips. Node 24.21.0 passed all seven perf
tests and the three-surface production DOM/scroll budget
([result](ci-node24.json)); the quoted glob also passes, without relying on
shell expansion. These changes affect CI/test scripts,
not application rendering or the earlier performance comparisons.

### Checkout metadata and production startup follow-up

Head `9896be7` passed all three CI rendering bursts but failed while recording
Git provenance: the root container rejected the runner-owned checkout. The
previous local container reproduction configured Git trust explicitly; that
setup was missing from the workflow. The rendering step now trusts only
`$GITHUB_WORKSPACE` in that job's Git config. A fresh container with a
UID-mismatched home/checkout reproduced the rejection, then completed the
seven tests, all three bursts, provenance export and the DOM/scroll budget
after executing the workflow's exact trust command.

The downstream startup job also runs Firefox, so its ephemeral home ownership
is aligned there as well. Startup projects explicitly select the two startup
specs; Firefox's separate compatibility matcher previously overrode the
top-level startup matcher. The 55 UI contracts remain in their dedicated
Firefox matrix job. Full production startup across all five profiles passed with Node 24.21.0
and the same image: 123 passed and seven intentional skips. The read-only local reproduction
uses private tmpfs Vite caches and the exported production bundle.

The new Firefox startup coverage exposed an automation interaction in the
offline test. An independent service worker that always returns a fixed HTML
response reproduces `NS_ERROR_OFFLINE` with Playwright HTTP routing enabled;
removing routing restores a worker-served offline reload. The product worker
is not involved in that control. The test now removes HTTP mocks before the
outage and restores them before reconnecting, so connection recovery also
runs against an actual failed network.

Firefox's protocol `response.text()` then rejected an already-decoded,
compressed worker body with `NS_ERROR_INVALID_CONTENT_ENCODING`, while the
document rendered and booted. The HTML-loader assertion now reads the decoded
CacheStorage body directly in the browser; worker provenance, offline
navigation, boot completion and reconnection assertions remain. Targeted
production offline cases pass on Chromium phone/desktop and Firefox (three
passed); the two existing WebKit automation skips remain unchanged. The final complete startup rerun also passed (123 passed, seven skips). No application code or service-worker
policy was changed by these CI follow-ups.


### Native virtualized-library test follow-up

Six emulator shards on `9896be7` failed because test DOM predicates assumed
that every library row remained mounted. The affected fixtures contain saved,
radio and PCM tracks; the original private track and a planned retirement
can sit below the shared collection's bounded window. The diagnostics showed
valid library rows at the current scroll position, without an application
exception.

`StartupTest` now reaches the requested ID/title through the library's actual
scrollport, polling mounted rows and traversing by three quarters of a viewport.
It does not filter, mutate the library or enlarge the rendering window. The
failed connection, metadata, bookmarks, Live, review, Subsonic, offline-removal
and planner tests use it, along with adjacent native library interactions that
had the same assumption. Duplicate-playlist/queue and ordering assertions are
retained. The offline-refusal test brings its saved preview into view before
opening the manager, preserving the retention assertion during the failure.

The updated Java/Kotlin instrumentation APK compiles, lint passes and the JVM
task succeeds (102 existing test results; unchanged tests reused by Gradle).
The native runtime remains a latest-head CI gate: the Device tool reported no
available local Android emulator/device, so no local instrumentation success
is claimed. Workflow reproduction results are in
[ci-workflow-repro.json](ci-workflow-repro.json).
