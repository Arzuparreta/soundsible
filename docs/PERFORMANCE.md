# Resource usage and performance validation

Soundsible can run its server and installed web client on the same machine as a
GPU-bound game. Diagnose those processes separately: low aggregate CPU usage
neither rules out an expensive rendering thread nor proves that audio decoding
is responsible for stutters.

## Findings and limits

Measurements on 2026-09-11/12 used a Ryzen 5800X, RTX 3060, 32 GiB RAM and
FirefoxPWA under X11/i3. The resumed comparisons ran **without Arma Reforger**,
with a 1760 × 990 CSS-pixel client viewport. CPU percentages below refer to one
logical CPU; 100% is not the whole 16-thread machine. Client numbers sum the
browser process tree. Server numbers include its descendants.

The following are controlled changes to wallpaper animation timing in the same
client, with the same track reset before each sample. They are not a comparison
between two complete application releases.

| Scenario | Existing continuous drift | Drift at 10 updates/second |
| --- | ---: | ---: |
| NORMAL playing, three alternating 40-second samples per variant | 48.46–49.62% CPU | 19.43–19.77% CPU |
| DJ view playing, one 30-second sample per variant | 46.23% CPU | 19.80% CPU |
| Full player paused, one 30-second sample per variant | 44.98% CPU | 6.27% CPU |
| Whole GPU board power in the paused comparison | 38.77 W | 21.78 W |

Final acceptance repeated NORMAL with three alternating **60-second** samples
per variant on the completed implementation. Reference client CPU was 48.25,
48.35 and 48.78%; updated CPU was 19.03, 19.07 and 19.65% (about 60% lower).
Server CPU ranged from 0.75 to 1.42% across these runs. Whole-board power was
38.91–39.61 W in the reference samples and 31.92–33.43 W in the updated samples.
The playing comparison saves less board power than the paused control above;
remaining animated playback UI still generates graphical work. Both comparisons
use the same 1760 × 990 viewport. Playback remained active and the temporary
animation overrides were restored afterward.

During stable playback, the server used approximately 0.7–1.3% of one CPU.
The collapsed client used 0.07% while paused and 11.80% while playing in separate
30-second samples. A frozen-wallpaper, paused control used 0.73%; freezing a
visible wallpaper is a diagnostic control, **not product behavior**.

GPU clocks changed substantially with the workload. Per-process `nvidia-smi`
utilization did not show a consistent proportional improvement: it is not a
measure of additive shares of total GPU capacity. The power figures describe
the whole board, including other applications. Client PSS was approximately
722–739 MiB across the alternating samples; no sustained client-memory
improvement was established.

Browser-induced page hiding used Firefox's browsing-context activation, which
produced a real `visibilitychange` event and `document.hidden === true`. Client
CPU averaged 2.82% over 30 seconds. The displayed position remained at 20 seconds
while hidden and caught up to 73 seconds on returning, with playback still
active. This validates page-lifecycle behavior, not physical audibility or the
window manager's occlusion detection. In this i3 setup, moving the PWA to another
workspace could leave its page reported as visible. Losing focus must never be
used as a substitute for hiding.

Early exploratory automation changed recommended preferences in the original
browser profile. Later comparisons used a separate copied profile with automatic
recommended-preference changes disabled. Do not treat the early exploration as
an untouched-profile baseline. Raw browser profiles and account-local traces
are not repository artifacts.

The reported game drop from roughly 90 to 40 FPS was not reproduced with a
controlled frame-time recording. Earlier HUD snapshots varied with the game
scene and server conditions. These results establish lower Soundsible resource
usage; they do **not** establish a particular FPS recovery or allocate a
percentage of game stutters to either client or server.

## Work by subsystem

| Subsystem | Work and policy |
| --- | --- |
| Player wallpaper and translucent panels | The slow full-viewport background causes repeated composition. Retain the artwork, blur, scale and crossfade; quantize only its 38-second pan into 380 steps. |
| Hidden-page presentation | Pause decorative CSS animation and unsubscribe progress/lyric presentation from the clock. Catch up immediately on visibility restoration. |
| Audio and DJ transport | Keep media clocks, hidden-page handoffs, recovery, Media Session and device synchronization independent of presentation visibility. |
| Playback diagnostics | Track pending serialized size incrementally rather than serializing the accumulated batch on every event. Preserve ordering, bounded storage, retries and account isolation. |
| DJ analysis | Calculate spectral features in batches of at most 256 frames. Carry adjacent-frame flux across batch boundaries and retain the mean spectrum. Avoid BLAS worker teams for small reductions. |
| Cooperative server scheduling | The daemon patches threading with gevent. Offload pure numerical composition to its native thread pool; keep subprocess and SQLite ownership unchanged and retain two concurrent analysis jobs. Plain unpatched processes run directly. |
| Preview streaming and prefetch | Existing shared transfers, bounded queues, cancellation and foreground priority already prevent redundant competing downloads. Preserve them. |
| Artwork, loudness and background jobs | Existing bounded artwork generation, cached measurements and disk-aware worker limits remain in place. No blanket resource caps or quality reductions are introduced. |

Rasterizing the wallpaper into a canvas did not reduce sustained cost in repeated
native-browser comparisons and was discarded. Pausing small equalizer bars or
forcing their composition produced little benefit. Explicitly hiding the
already-covered mini-player did not reduce cost either. These experiments do not
justify additional product complexity.

## Server benchmarks

The reference is commit `f597171`; comparison processes execute its trusted
`shared/dj_engine.py` directly against the same installed dependencies and current
shared helpers; this isolates the analysis change rather than checking out a
second complete server. Fresh processes prevent allocator high-water
marks from leaking between runs. Synthetic PCM and temporary WAVs do not touch
the station library or caches. Numeric equivalence is checked recursively with
`rtol=atol=1e-10`; strings, keys and list lengths must agree.

Three-run medians for feature extraction, excluding FFmpeg and provider traffic:

| Synthetic audio | Reference wall time | Updated wall time | Reference peak RSS | Updated peak RSS |
| --- | ---: | ---: | ---: | ---: |
| 18 seconds | 12.2 ms | 10.9 ms | 60.6 MiB | 52.5 MiB |
| 120 seconds | 52.2 ms | 32.4 ms | 149.6 MiB | 61.9 MiB |
| 480 seconds | 207.6 ms | 82.0 ms | 507.5 MiB | 122.7 MiB |

Full synthetic-WAV analysis including FFmpeg also preserved all output fields.
Three-run median wall times were 43.5 → 42.8 ms (18 seconds), 88.6 → 69.7 ms
(120 seconds), 249.9 → 129.7 ms (480 seconds), and 152.9 → 113.3 ms
(900 seconds). Long files already use head/tail windows, so they are not expected
to scale like full-song FFTs. Eight real cached music files, 159–361 seconds long,
produced equivalent complete analysis against the reference; a second call
reused each temporary analysis cache without decoding. Personal caches were not
modified. These timings are local observations, not fixed performance promises.

RSS includes imported libraries and synthetic-input construction, not just FFT
scratch space. In particular, constructing a long synthetic input can dominate
the high-water mark even though actual analysis already uses head/tail windows.
Reported CPU time is for the Python process; it excludes FFmpeg child CPU time.
Do not interpret those fields as whole-station resource usage.

A separate-process HTTP client queried an isolated gevent WSGI server while two
480-second synthetic analyses ran. In three exploratory repetitions the largest
response delay fell from 395–402 ms to 5–13 ms. Typical latency was similar: the
change removes an intermittent loop blockage. This isolates numerical work;
it does not benchmark the production daemon, cold provider downloads, or TLS.
The durable HTTP benchmark repeated the result with 398–402 ms reference maxima
and 2.6–5.4 ms updated maxima. The personal running daemon was not restarted to
obtain these server results.

## Reproduce safely

Run resource comparisons separately from tests, builds and analysis benchmarks.
Find the actual server and browser parent PIDs before each session. Use a separate
browser profile for automation and preserve the normal profile's preferences.
Record viewport, device density, visibility, focus, NORMAL/DJ state, playback
position, cache warmth and concurrent jobs in the sample label or accompanying
notes. Keep track position and visual content equivalent across variants.

```sh
python scripts/resource_sample.py --group server=123 --group client=456 \
  --seconds 60 --label 'NORMAL playing; visible; warm cache; fixed viewport' \
  --output /tmp/soundsible-normal.json

.venv/bin/python scripts/benchmark_dj_analysis.py --reference f597171 \
  --repeats 3 --output /tmp/soundsible-dj-features.json

.venv/bin/python scripts/benchmark_dj_analysis.py --reference f597171 \
  --pipeline --seconds 18 120 480 900 --repeats 3 \
  --output /tmp/soundsible-dj-pipeline.json

.venv/bin/python scripts/benchmark_dj_analysis.py --reference f597171 \
  --http --seconds 480 --repeats 3 --output /tmp/soundsible-dj-http.json
```

The resource sampler writes process CPU/PSS/I/O and system pressure to JSON,
raw per-process GPU counters to `.gpu.txt`, and whole-board power, utilization,
clocks, memory and temperature to `.gpu.csv`. Missing counters remain missing.
A vanished or reused root PID invalidates its group, and incomplete intervals
are excluded from printed CPU means. Short-lived subprocesses can be missed;
use process accounting or a profiler when such jobs are the suspected cause.
Groups may overlap and should not be blindly added together.

The HTTP benchmark exposes only a temporary loopback server in a child process
and shuts it down afterward. Its p95 can miss a single long stall; inspect the
maximum delay as well as the percentile and number of requests. Larger workloads
may require extending the observation window. It measures two numerical jobs,
not a complete station startup.

## Acceptance and regression coverage

- Alternate original and updated timing for three 60-second samples each after
  warm-up; include NORMAL, DJ, paused, collapsed and hidden states. Check both
  themes, artwork crossfades, lyrics, reduced motion and opening/closing gestures.
- Verify visible-but-unfocused windows keep animating. Hidden presentation must
  stop while playback advances; on return, progress and lyrics catch up. Native
  window-manager behavior and synthetic lifecycle tests are separate evidence.
- Verify NORMAL and DJ hidden handoffs, seek, pause/resume, recovery and media
  controls. Automated Chromium/WebKit results do not prove locked iPhone/car
  behavior; the audio pipeline itself is unchanged by presentation gating.
- Verify silence, pulses, spectral block boundaries and long head/tail analysis;
  compare complete analysis results, cache reuse and concurrent readers. Confirm
  HTTP stays responsive during numerical work without reducing musical fidelity.
- Run `npm test` from `ui_web`, Python tests, lint and affected Playwright suites.
  Use the project's normal automatic UI-dist refresh; do not manually build it.
- Complete a later game session with recorded frame times, the same scene/camera
  and server conditions, and warm caches. Compare frame-time distributions and
  long stalls, not screenshots of instantaneous FPS. Include server only,
  client paused, NORMAL playing, DJ and a genuinely hidden client.

Performance measurements are review evidence, not fixed CI timing assertions on
shared runners. Functional invariants and bounded FFT sizes belong in tests.
