# Web UI rendering baseline, 2026-11-16

The first run of `ui_web/perf/bench.mjs`, taken on `main` at
`a7ec7c72` plus the step 1 fixes (the bench itself changes no application
code). Every later step of the
[web UI review](../../audits/WEB_UI_REVIEW_HANDOFF.md) is compared against
these two files with `node perf/bench.mjs --table`.

- Browser: Chromium 156.0.8078.4, headless, GPU `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL ES 3.2)`
- Host: AMD Ryzen 7 5800X 8-Core Processor, 16 threads
- Viewport 1366×768 at DPR 1; 3.2 s wheel burst at 7,500 px/s; median of 3 runs
- Fixture: 6,000 tracks, 600 albums, 200 artists, 1,800 saved, 900 favourites

Column definitions are in [ui_web/perf/README.md](../../../../ui_web/perf/README.md).
The frame counts are not comparable with the review's own tables: the review
counted `PipelineReporter` states, this bench counts the DevTools frame
events, and the two classify a late frame differently (dropped there, partial
here). Main-thread times are comparable.

## Paused

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| songs | 1× | 208/212 | 4/0 | 16.7 / 18.6 / 22.9 | 16.9 | 980.6 / 197.7 / 273.1 |
| songs | 6× | 121/243 | 122/0 | 10.6 / 18.6 / 325.4 | 329 | 2696.8 / 319.1 / 219.6 |
| favourites | 1× | 199/207 | 7/1 | 16.7 / 19.2 / 32 | 16.4 | 643.7 / 178.9 / 254.3 |
| favourites | 6× | 64/218 | 153/1 | 16.7 / 27.1 / 372.7 | 330.4 | 2386.3 / 426.1 / 395.3 |
| albums | 1× | 197/203 | 6/0 | 16.7 / 23 / 26.6 | 8.8 | 38.8 / 229.1 / 421.2 |
| albums | 6× | 61/162 | 101/0 | 16.7 / 84.9 / 96.3 | 49.7 | 80.9 / 482.9 / 889.5 |
| artists | 1× | 91/92 | 1/0 | 16.7 / 18.7 / 23 | 4.7 | 17.9 / 58.2 / 146.6 |
| artists | 6× | 67/90 | 23/0 | 16.7 / 28.9 / 30.7 | 22.6 | 60.4 / 246.2 / 587.3 |
| album | 1× | 54/55 | 1/0 | 16.7 / 16.9 / 22.8 | 3.8 | 7.8 / 9 / 59.7 |
| album | 6× | 54/66 | 10/2 | 16.7 / 22.8 / 23.3 | 39.9 | 29.3 / 37.3 / 329.5 |
| artist | 1× | 62/74 | 9/3 | 16.6 / 17 / 23.1 | 22.7 | 7.8 / 8.9 / 216.5 |
| artist | 6× | 62/68 | 6/0 | 16.7 / 22.8 / 23 | 33.6 | 30 / 37.9 / 359.4 |
| playlist | 1× | 62/64 | 1/1 | 16.7 / 19 / 24 | 12.5 | 220.3 / 45.8 / 70.7 |
| playlist | 6× | 72/124 | 52/0 | 15.7 / 16.8 / 26 | 284.9 | 738.3 / 96.4 / 116 |

## Playing

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| songs, playing | 1× | 211/217 | 2/4 | 16.7 / 18.2 / 25.2 | 13.2 | 977.5 / 189.5 / 259.5 |
| songs, playing | 6× | 95/268 | 171/2 | 16.3 / 16.7 / 339.8 | 306.1 | 2756.3 / 356 / 232.1 |
| favourites, playing | 1× | 202/210 | 6/2 | 16.7 / 18.6 / 28.5 | 14.5 | 635.7 / 182.2 / 261.1 |
| favourites, playing | 6× | 80/240 | 154/6 | 16.7 / 30.2 / 210.5 | 301 | 2394 / 452.1 / 397.5 |
| albums, playing | 1× | 190/199 | 9/0 | 16.7 / 24.3 / 99.6 | 9.6 | 36.9 / 241.1 / 431.1 |
| albums, playing | 6× | 64/188 | 123/1 | 16.7 / 39.7 / 100 | 49.9 | 95.9 / 407.8 / 832.2 |
| artists, playing | 1× | 115/139 | 1/23 | 16.7 / 130.8 / 133 | 5.1 | 21.1 / 67.8 / 172.6 |
| artists, playing | 6× | 80/137 | 32/25 | 18.7 / 128.4 / 133.2 | 26.2 | 87.5 / 236 / 620.4 |
| album, playing | 1× | 84/116 | 2/30 | 16.7 / 132.6 / 133.1 | 4.1 | 11.1 / 13.5 / 76 |
| album, playing | 6× | 85/117 | 1/31 | 16.7 / 130.7 / 132.2 | 20.3 | 43.6 / 52.5 / 353.8 |
| artist, playing | 1× | 92/124 | 1/31 | 16.7 / 132.5 / 132.8 | 4.2 | 11.6 / 15.1 / 90.7 |
| artist, playing | 6× | 92/128 | 1/35 | 16.7 / 129.4 / 131.7 | 22 | 49.9 / 49.1 / 407.8 |
| playlist, playing | 1× | 90/123 | 4/29 | 16.8 / 132.7 / 133.1 | 12.8 | 232.5 / 52.3 / 80.7 |
| playlist, playing | 6× | 96/178 | 56/26 | 15.8 / 119.3 / 136.7 | 281.8 | 719.3 / 106 / 137.2 |

## What it shows

1. **Song rows are main-thread bound (P1, P2).** At 6× the Songs and
   Favourites lists spend 2.4–2.7 s of the burst in script, with 300–330 ms
   tasks, and half to two thirds of their frames are shown without their rows.
   A playlist of 120 behaves the same way at 6× (285 ms task).
2. **Grids are paint bound (P3).** Albums at 6× spends 890 ms painting and
   483 ms in layout with almost no script.
3. **Playback drops frames only where the main thread is idle (P5, corrected).**
   With a track playing, the album page, artist page, playlist and artists
   grid lose 23–35 frames per burst at 1× with 130 ms gaps, while their longest
   task stays under 13 ms. Songs, Favourites and Albums do not show it. The
   review recorded this as "every route surface"; on this bench it is the
   surfaces whose scroll needs little or no main-thread work per frame.
