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
| `SURFACES` | all | `songs`, `favourites`, `albums`, `artists`, `album`, `artist`, `playlist` |
| `RATES` | `1,6` | CPU throttling rates. 6× on a desktop CPU is a proxy for a slow laptop, not a measurement of one |
| `PLAYING` | off | `1` starts a track first and keeps it playing |
| `REPEATS` | `3` | Runs per case. The reported row is the run with the median longest task; every run's frame counts are kept under `runs` |
| `SIZE` | `1366x768` | Viewport, at device pixel ratio 1 |
| `SOFTWARE` | off | `1` forces SwiftShader: the no-GPU case |
| `TAG` | `run` | Result file name: `perf/results/<TAG>.json` (ignored by git) |
| `INPUT` | `wheel` | `none` sends nothing and measures 3.6s of the page at rest |
| `KEEP_TRACE` | — | Directory to keep each raw Chrome trace in, for Perfetto |
| `DIST` | — | Use an existing bundle instead of building one |

## Fixture and input

`fixture.mjs`: 6,000 tracks, 600 albums, 200 artists, 24 playlists of 120,
1,800 saved songs (1,200 files and 600 without a file) of which 900 are
favourites, and JPEG artwork from the showcase catalog. Album 0 has 100
tracks; artist 0 owns it. Everything is generated from indexes, so two runs
see the same library. The engine is in collection-identity mode, as a current
engine is.

Input is one 120px wheel event every 16ms for 3.2s (7,500px/s) at the middle
of the content area, sent through the DevTools protocol, followed by 400ms for
the frames it caused. A run that scrolls less than one viewport fails instead
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
it shows up as dropped frames. The GPU string in the result says whether
compositing was hardware (`ANGLE (NVIDIA …)`) or software (`SwiftShader`).

## Limits

- One machine, headless Chromium, 60 Hz. It says nothing about WebKit, an
  iPhone, Android WebView, WebView2 or a 144 Hz display.
- The player queue and the player's own browser are not surfaces yet; they
  need the full player opened first (handoff items P4 and A2).
- It is not a CI gate. Shared CI runners have no GPU and uneven CPU; a
  threshold there would fail on the runner, not on the code.
