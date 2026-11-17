# Player rendering and activity scopes

Step 7 of the [web UI review](../../audits/WEB_UI_REVIEW_HANDOFF.md).

## Changes

- The player browser and manual queue use `CollectionRows`, retaining row slots
  instead of rebuilding subtrees. Local search is bounded and mixed artist/song
  results update through accessors. Header origins are measured by the collection.
- Queue occurrences use their stable IDs. Variable editing rows are measured;
  the edited occurrence is pinned and focus survives scrolling and reordering.
- Both panel boxes have `contain: strict`. Their workspace already supplies
  definite dimensions, so changing row text cannot invalidate the intrinsic
  dimensions of neighbouring player tiles. This is panel containment, in addition
  to the row containment that the earlier prototypes tried.
- `createActivityMemo` retains presentation projections without subscribing to
  domain updates while inactive. Library sorting, filtering, search and indexes
  sleep with the browser; queue projections sleep with the queue. The phone's
  inactive panel and a hidden document are inactive too. On activation they catch
  up once. Mounted DOM, scroll and editing state remain. The initial current
  occurrence costs one row, without projecting the full hidden queue. Transport
  scheduling does not use presentation activity.
- Artwork metadata is reconciled per key and per artwork field. An unchanged
  cover reader no longer reruns when another track changes or a full snapshot
  replaces the collection (A3). Account reset still removes every key and hint.

## Visual evidence

The production fixture, normal density, dark theme, with playback running. These are
rendering changes; labels, artwork, dimensions and composition stay equivalent.

| View | Before | After |
| --- | --- | --- |
| Desktop | [Before](player-desktop-before.png) | [After](player-desktop-after.png) |
| Phone browser | [Before](player-phone-before.png) | [After](player-phone-after.png) |

[Short scroll recording](player-scroll-after.webm). Recording is a separate run,
not used for performance numbers.

## Reproduction

Use `SURFACES=player-browser,player-queue RATES=1,6 REPEATS=3 TAG=step7 node
perf/bench.mjs` in `ui_web`. The queue case creates 300 requests through the
real menu before tracing. The fixtures never access a running engine. Raw
exploratory traces are under `/tmp/soundsible-step7-traces-before` and
`/tmp/soundsible-step7-traces-after` on the measurement host, not in Git.

## Repeated results

Three runs per case, median longest task, on the same idle Ryzen desktop and
NVIDIA GPU. The [before](before.json) and [after](after.json) JSON include every
run's counts. CPU 6× is a proxy, not acceptance on a physical slow device.

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms | Busy: main / compositor / GPU / display, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| player-browser (before) | 1× | 199/200 | 1/0 | 16.7 / 18 / 23.1 | 8.5 | 250.5 / 384.5 / 222.1 | 1191.2 / 169.4 / 1210 / 85.2 |
| player-browser (after) | 1× | 197/200 | 3/0 | 16.7 / 18.1 / 23.1 | 5.1 | 203.2 / 142.2 / 195.2 | 837.2 / 160.9 / 1188 / 81.2 |
| player-browser (before) | 6× | 93/213 | 119/1 | 16.7 / 31.4 / 32.4 | 49.6 | 900.8 / 991.8 / 552.4 | 3300 / 84.7 / 800.9 / 39.5 |
| player-browser (after) | 6× | 135/206 | 71/0 | 19.5 / 25.7 / 32.1 | 27.7 | 899.2 / 553.2 / 690.1 | 3231.2 / 111.2 / 1079.2 / 54 |
| player-queue (before) | 1× | 122/124 | 2/0 | 16.7 / 22.5 / 34.8 | 7.7 | 129.4 / 308.4 / 195.6 | 751.4 / 86.4 / 1070.3 / 45 |
| player-queue (after) | 1× | 119/124 | 4/1 | 16.4 / 18.7 / 28.2 | 5 | 98.2 / 68.4 / 162.1 | 431.4 / 83.6 / 760.8 / 39.7 |
| player-queue (before) | 6× | 57/124 | 67/0 | 16.7 / 31.9 / 47.4 | 67 | 441.5 / 616.7 / 474.1 | 1763.9 / 45 / 733.9 / 20.7 |
| player-queue (after) | 6× | 69/111 | 42/0 | 19 / 29 / 34.7 | 36.9 | 345.4 / 227.5 / 468.6 | 1336.6 / 52.9 / 652.3 / 26.8 |

At 6×, browser layout falls 44% (992 → 553 ms) and queue layout 63% (617 →
228 ms). Longest tasks fall 49.6 → 27.7 ms and 67.0 → 36.9 ms. Frame ratios
improve but partial frames remain; this does not establish perfect scrolling
at 6× or on an iPhone. At 1× the browser's main-thread cost also falls; the
queue's one dropped frame in the selected run is retained in the report.

## Validation

- `npm test`: 1,985 Vitest tests and four rendering-analysis tests passed.
- Whole browser suite, fresh Vite server and closed fixture engine: Chromium
  mobile/desktop 436 passed, 76 intentional skips; WebKit mobile/desktop in
  the matching Playwright image, one worker, 423 passed, 89 intentional skips.
- The only obsolete browser assertion named `data-virtual-rows`; it now checks
  that the new collection renders a bounded window. The pinned-occurrence test
  also found and fixed focus loss during document-order restoration.
- Exported production build: initial authenticated payload 211,271 gzip bytes,
  below the unchanged 215,316-byte ceiling. The engine-owned `ui_web/dist` was
  never built or changed.
