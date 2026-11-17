# Rendering bench

Scrolls the collection surfaces of a **production bundle** with real wheel
input and reports what the frame pipeline did. It exists so that every change
to list rendering is compared against the same fixture, input and definitions.
Background: [the web UI review handoff](../../docs/internal/audits/WEB_UI_REVIEW_HANDOFF.md).

```sh
cd ui_web
node perf/bench.mjs                             # every surface, paused, 1× and 6× CPU
PLAYING=1 node perf/bench.mjs                   # the same with a track playing
SURFACES=songs,favourites RATES=6 TAG=p1 node perf/bench.mjs
node perf/bench.mjs --table before.json after.json   # compare two saved runs
```

It builds the bundle into a temporary directory with `vite build --outDir`,
so `ui_web/dist` — which the running engine owns — is never touched. It talks
only to its own fixture server on a free port, never to an engine.

## Options (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SURFACES` | all | `songs`, `favourites`, `albums`, `artists`, `album`, `artist`, `playlist`, `player-browser`, `player-queue` |
| `RATES` | `1,6` | CPU throttling rates. 6× on a desktop CPU is a proxy for a slow laptop, not a measurement of one |
| `PLAYING` | off | `1` starts a track first and keeps it playing |
| `REPEATS` | `3` | Runs per case. The reported row is the run with the median longest task; every run's frame counts are kept under `runs` |
| `SIZE` | `1366x768` | Viewport, at device pixel ratio 1 |
| `SOFTWARE` | off | `1` selects SwiftShader GL emulation; it is distinct from CPU composition |
| `COMPOSITOR` | `hardware` | `hardware`, `swiftshader` or `cpu` (GPU composition disabled). The report records actual `SystemInfo` feature status as well as the WebGL renderer |
| `SCENE_CSS` | — | File containing diagnostic scene CSS. Its exact contents are recorded; this is an ablation, never a product setting |
| `TAG` | `run` | Result file name: `perf/results/<TAG>.json` (ignored by git) |
| `INPUT` | `wheel` | `touch` sends a paced 12-step, ≤480px upward finger stroke over 192ms, then native fling; `none` measures the page at rest |
| `PASSIVE_PROBE` | off | Diagnostic `1` forces non-passive move listeners passive, deliberately breaking dismissal cancellation; never a product setting |
| `KEEP_TRACE` | — | Directory to keep each raw Chrome trace in, for Perfetto |
| `DIST` | — | Use an existing bundle instead of building one |
| `PROFILE` | — | Directory for a CPU profile of each burst (`.cpuprofile` and a self-time summary). Builds unminified so functions keep their names; the frame numbers of a profiled run are not comparable |

## Fixture and input

`fixture.mjs`: 6,000 tracks, 600 albums, 200 artists, 24 playlists of 120,
1,800 saved songs (1,200 files and 600 without a file) of which 900 are
favourites, and JPEG artwork from the showcase catalog. Album 0 has 100
tracks; artist 0 owns it. Everything is generated from indexes, so two runs
see the same library. The engine is in collection-identity mode, as a current
engine is.

Input is one 120px wheel event every 16ms for 3.2s (7,500px/s) at the middle
of the content area, sent through the DevTools protocol, followed by 400ms for
the frames it caused. A run that scrolls less than one actual scrollport fails instead
of reporting a list that never moved.

**The measured window is the time the list was moving**: from the first wheel
event to 100ms after the last scroll event. A list of 100 rows reaches its end
0.8s into the burst; what follows is the page at rest. With a track playing
the only thing changing then is the progress bar, a few times a second, and
Chromium reports every frame between two of its updates as dropped. Counting
that as scrolling is how handoff item P5 came to exist. `INPUT=none` measures
the page at rest on purpose.

## Reading the table

| Column | Definition |
| --- | --- |
| Complete / expected | Frames shown with the main thread's content, over frames the compositor was asked to produce |
| Partial | Frames shown with the scroll offset applied but without the rows the main thread had not delivered yet: the list visibly lags or shows blank space |
| Dropped | Frames not shown at all |
| Display gap | Time between consecutive shown frames. 16.7ms is 60 Hz |
| Longest task | Longest single task on the page's main thread |
| Script / layout / paint | Main-thread time in each, as a union of intervals so nested work is not counted twice |
| Busy | Task time on the page's main thread, its compositor thread, the GPU process and the display compositor. Work that never touches the main thread shows up here |

Frames come from the events the DevTools Performance panel draws its Frames
track from (`DrawFrame`, `DroppedFrame`, `hasPartialUpdate`). A partial frame
is not a good frame: acceptance counts **complete** frames (handoff item P7).

Under CPU throttling the burst takes longer than 3.2s to drain, so `expected`
grows; compare ratios and the longest task, not raw frame counts.

## Comparing

Keep the result file of the state you are changing (`TAG=before`), make the
change, run again (`TAG=after`) and print both with `--table`. Baselines that
a pull request cites are copied to `docs/internal/measurements/`.

Run it on an otherwise idle machine: the result file records the 1-minute load
average at the end of the run, and a browser suite or a build running next to
it shows up as dropped frames. The report records Chromium GPU feature status: a WebGL renderer string alone
does not establish composition mode. With GPU composition disabled WebGL can
still identify itself as SwiftShader. The bundle build ID records the actual
exported input, including when the worktree has uncommitted source changes.

## Limits

- One machine, headless Chromium, 60 Hz. It says nothing about WebKit, an
  iPhone, Android WebView, WebView2 or a 144 Hz display.
- `player-browser` opens the full player and scrolls its library browser.
  `player-queue` adds 300 requests through the real song menu before opening
  the player and scrolling the manual lane. Setup is outside the timed window.
- CI runs songs, albums and player-browser against the built production bundle
  with 6,000 tracks. `budget.mjs` requires bounded DOM (≤1,800 elements), actual
  scroll and presented frames. Timing and partial frames are uploaded for
  diagnosis; there is no absolute FPS gate on uneven shared runners.
- Touch and wheel have different input profiles and cannot be compared as if
  they were the same gesture. Failed zero-motion injection attempts are rejected.
  Raw traces need the input categories enabled for native touch arbitration.
