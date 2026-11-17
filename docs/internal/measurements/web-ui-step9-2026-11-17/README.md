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
GPU features. The final visibility-only guard does not change the timed open
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
error path in the actual APK. Six checker tests passed. The separate `:app:testDebugUnitTest` task passed 102 tests in 27 report
files with zero failures/errors/skips. Remote emulator checks remain required.

## Visual evidence

| View | Before | After |
| --- | --- | --- |
| Desktop | [Before](player-desktop-before.png) | [After](player-desktop-after.png) |
| Phone | [Before](player-phone-before.png) | [After](player-phone-after.png) |

[Short wheel-scroll recording](player-scroll-after.webm) and
[native touch/fling and pull-down recording at CPU 6×](player-touch-after.webm). These captures are
separate from timed runs. Visual review confirms the retained artwork,
material, rows and composition. The font, density and theme screenshot
contracts remain covered by the browser suite.

## Validation checkpoint

- `npm test`: type checking, design-debt gate, 1,989 Vitest tests, seven
  trace/budget tests and three design-gate tests passed.
- Initial authenticated payload: 211,686 gzip bytes under the unchanged
  215,316-byte ceiling. Exported Vite output only; engine UI dist untouched.
- Whole four-profile suite and Firefox final run are in progress.
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
