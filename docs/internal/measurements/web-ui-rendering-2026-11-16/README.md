# Web UI rendering baseline, 2026-11-16

Taken with `ui_web/perf/bench.mjs` on `main` after steps 1 and 2 of the
[web UI review](../../audits/WEB_UI_REVIEW_HANDOFF.md); no later step had
changed list rendering yet. Every later step is compared against these files
with `node perf/bench.mjs --table`.

- Browser: Chromium 156.0.8078.4, headless, GPU `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL ES 3.2)`
- Host: AMD Ryzen 7 5800X 8-Core Processor, 16 threads
- Viewport 1366×768 at DPR 1; wheel burst of 3.2 s at 7,500 px/s; median of 3 runs
- Fixture: 6,000 tracks, 600 albums, 200 artists, 1,800 saved, 900 favourites
- The window is the time the list was moving (see the bench README)

Column definitions are in [ui_web/perf/README.md](../../../../ui_web/perf/README.md).
The frame counts are not comparable with the review's own tables: the review
counted `PipelineReporter` states over a fixed interval, this bench counts
the DevTools frame events while the list moves. Main-thread times are
comparable.

This replaces the first version of this baseline (pull request #462), whose
window ran past the end of short lists; see "Playback" below.

## Paused

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms | Busy: main / compositor / GPU / display, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| songs | 1× | 199/203 | 4/0 | 16.7 / 16.8 / 22.8 | 17 | 1053.2 / 202.8 / 280.5 | 1828.6 / 172.3 / 1073.4 / 50 |
| songs | 6× | 80/228 | 148/0 | 16.4 / 17.2 / 271.9 | 287.7 | 2635.2 / 306.9 / 187.3 | 3510.4 / 40.8 / 525 / 16 |
| favourites | 1× | 197/198 | 1/0 | 16.7 / 19.7 / 30.2 | 12 | 627.2 / 184.4 / 250.4 | 1302 / 158.9 / 1135.8 / 41.2 |
| favourites | 6× | 61/209 | 148/0 | 16.7 / 27 / 291.6 | 340.7 | 2340.9 / 421.3 / 384.3 | 3633.9 / 57.5 / 837.5 / 16.1 |
| albums | 1× | 186/194 | 8/0 | 16.7 / 24 / 27.3 | 9.4 | 40.4 / 251.5 / 436.9 | 1397.6 / 138.9 / 1423.1 / 45.9 |
| albums | 6× | 50/161 | 111/0 | 16.7 / 43.2 / 112 | 47.5 | 79.1 / 495.5 / 830 | 3386.2 / 56.4 / 807.6 / 22.5 |
| artists | 1× | 86/87 | 1/0 | 16.7 / 22.7 / 27.9 | 4.8 | 15.6 / 64.3 / 150.1 | 352.8 / 65.7 / 542.5 / 19 |
| artists | 6× | 56/85 | 29/0 | 17.2 / 30.2 / 33.2 | 24 | 57.5 / 251.9 / 559.9 | 1371.8 / 44.8 / 669 / 14.5 |
| album | 1× | 44/54 | 8/2 | 16.6 / 23.2 / 33.4 | 23 | 4.6 / 8.2 / 341.8 | 383.7 / 33.4 / 343.5 / 7.7 |
| album | 6× | 46/48 | 2/0 | 16.7 / 18.1 / 22.6 | 29.3 | 29.6 / 51 / 312.9 | 544.7 / 37.9 / 207.1 / 10.6 |
| artist | 1× | 50/65 | 11/4 | 16.6 / 22.6 / 23.1 | 22.2 | 4.8 / 8.2 / 198.6 | 241.6 / 37.8 / 351.4 / 8.2 |
| artist | 6× | 50/63 | 10/3 | 16.6 / 22.9 / 23 | 33.2 | 23.6 / 36.3 / 328.9 | 492.1 / 31.2 / 338.6 / 7.3 |
| playlist | 1× | 54/58 | 3/1 | 16.7 / 20.2 / 24.6 | 17.5 | 265.6 / 54.2 / 70.9 | 470.5 / 55.3 / 304.7 / 14.8 |
| playlist | 6× | 61/121 | 60/0 | 16.1 / 16.8 / 30.4 | 319.1 | 796.5 / 107.3 / 126.9 | 1167.5 / 23.1 / 272.2 / 9.7 |

## Playing

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms | Busy: main / compositor / GPU / display, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| songs, playing | 1× | 200/201 | 1/0 | 16.7 / 18.2 / 25.4 | 15.8 | 948.4 / 189.6 / 258.1 | 1685.3 / 174.3 / 1435.5 / 50.3 |
| songs, playing | 6× | 98/206 | 108/0 | 10.9 / 17.9 / 350.3 | 362.1 | 2782.7 / 279.3 / 207.6 | 3653.2 / 46.8 / 259.8 / 22.7 |
| favourites, playing | 1× | 194/200 | 6/0 | 16.7 / 20.5 / 31.1 | 16.6 | 649.4 / 182.8 / 258.5 | 1365.9 / 169.2 / 1064.3 / 44.2 |
| favourites, playing | 6× | 72/235 | 163/0 | 16.7 / 27.9 / 33 | 326.5 | 2262.4 / 412.6 / 386 | 3565.7 / 60.1 / 745.3 / 18.3 |
| albums, playing | 1× | 181/193 | 9/3 | 16.7 / 25.7 / 34.8 | 16.3 | 54.4 / 355.9 / 622.9 | 2177.9 / 216.7 / 1356.6 / 83.3 |
| albums, playing | 6× | 33/114 | 79/2 | 16.7 / 160.5 / 211.8 | 96.7 | 84.2 / 401 / 709.1 | 3439.8 / 56 / 243.4 / 28.8 |
| artists, playing | 1× | 83/86 | 3/0 | 16.7 / 23.2 / 27.1 | 7.1 | 24.6 / 92.1 / 206.8 | 487.2 / 100.8 / 639.7 / 33.1 |
| artists, playing | 6× | 34/73 | 39/0 | 16.7 / 59.1 / 70.5 | 50.1 | 67.2 / 239.7 / 542.4 | 1455.2 / 46.5 / 241.3 / 18.5 |
| album, playing | 1× | 46/47 | 1/0 | 16.7 / 18.7 / 22.3 | 5.4 | 7.3 / 17.3 / 75.7 | 144.9 / 48.3 / 271.4 / 14.9 |
| album, playing | 6× | 47/53 | 6/0 | 16.3 / 22.3 / 24.5 | 35.5 | 35.2 / 69.4 / 381.5 | 692.8 / 43.4 / 238.9 / 13.1 |
| artist, playing | 1× | 54/55 | 1/0 | 16.7 / 19 / 24.2 | 6.1 | 8.4 / 20.9 / 97.7 | 182.4 / 62 / 336.4 / 17 |
| artist, playing | 6× | 54/64 | 10/0 | 16.2 / 23.4 / 25 | 38.3 | 38.2 / 72.7 / 465.3 | 829.1 / 56 / 255.7 / 15.8 |
| playlist, playing | 1× | 53/58 | 5/0 | 16.6 / 20 / 25 | 19.5 | 268.8 / 54.9 / 73.4 | 479.3 / 56 / 324.8 / 17 |
| playlist, playing | 6× | 40/112 | 72/0 | 16.3 / 16.7 / 80.8 | 646 | 1365.8 / 92.3 / 65 | 1704 / 28.2 / 103.2 / 15.2 |

## At rest (no input, album page, 3.6 s)

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms | Busy: main / compositor / GPU / display, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| album | 1× | 16/19 | 3/0 | 16.6 / 17.9 / 17.9 | 2.9 | 3.1 / 1.8 / 11.6 | 30.3 / 15.3 / 65.3 / 5.1 |
| album, playing | 1× | 50/87 | 0/37 | 115.3 / 132.3 / 132.4 | 3.1 | 10.1 / 8.8 / 36 | 85.1 / 42.7 / 57.2 / 25.4 |

## What it shows

1. **Song rows are main-thread bound (P1, P2).** At 6× the Songs and
   Favourites lists spend 2.3–2.8 s in script, with 290–360 ms tasks, and
   about two thirds of their frames are shown without their rows. A playlist
   of 120 behaves the same way (319 ms task; 646 ms while playing).
2. **Grids are paint and layout bound (P3).** Albums at 6× spends 830 ms
   painting and 496 ms in layout with 79 ms of script.
3. **Playback does not drop frames while a list scrolls (P5, closed).** With a
   track playing, the album page, artist page, playlist and artists grid show
   0 dropped frames at 1×, the same as paused.

## Playback: why P5 was a measurement artifact

The review, and the first version of this baseline, reported 23–35 dropped
frames per burst with 130 ms gaps on short surfaces while playing. Three
measurements settle what that was:

- The gaps start when the list reaches its end (0.8–1.5 s into the burst on
  these surfaces), not while it moves. Clipped to the moving time, the same
  runs drop no frame.
- At rest with a track playing the page shows a new frame about every 125 ms
  and reports the frames in between as dropped (the "At rest" table). That is
  the progress fill in `OmniBar`: `transition: transform 0.25s steps(2, end)`,
  restarted by every position update, changes pixels twice per 250 ms while
  the compositor expects a frame each vsync for a running animation.
- With that transition removed (an ablation build, not a change in this pull
  request) the gap becomes 266 ms, the position update period, and frames are
  still reported dropped. Nothing is late: nothing changed on screen.

At rest and playing, the page uses 85 ms of main thread and 43 ms of
compositor per 3.6 s at 1× (30 ms and 15 ms when paused), and
the two steps per update are deliberate (the comment on `.progressFill`
explains the phone case). No change is made.

It only appeared on short lists because long ones never reach their end
inside the burst, and not at 390 px or inside the full player because the
desktop progress bar is not on screen there.

## Step 4: saved state from an index (P1)

`step4-saved-index.json`, against the paused baseline above. Rows now resolve
their saved entry through `buildSavedIdentityIndex` instead of scanning the
1,800-entry collection on every mount.

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms | Busy: main / compositor / GPU / display, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| songs (before) | 1× | 199/203 | 4/0 | 16.7 / 16.8 / 22.8 | 17 | 1053.2 / 202.8 / 280.5 | 1828.6 / 172.3 / 1073.4 / 50 |
| songs (after) | 1× | 199/200 | 1/0 | 16.7 / 17.5 / 23.2 | 8.7 | 321.7 / 276.5 / 349.1 | 1328 / 240.3 / 1455.5 / 69.8 |
| songs (before) | 6× | 80/228 | 148/0 | 16.4 / 17.2 / 271.9 | 287.7 | 2635.2 / 306.9 / 187.3 | 3510.4 / 40.8 / 525 / 16 |
| songs (after) | 6× | 149/294 | 145/0 | 10.8 / 18.6 / 100 | 124.5 | 1122.2 / 814 / 606.1 | 3471.7 / 101.9 / 539.2 / 52.8 |
| favourites (before) | 1× | 197/198 | 1/0 | 16.7 / 19.7 / 30.2 | 12 | 627.2 / 184.4 / 250.4 | 1302 / 158.9 / 1135.8 / 41.2 |
| favourites (after) | 1× | 200/200 | 0/0 | 16.7 / 19 / 22.2 | 9.8 | 306.8 / 271.6 / 347.8 | 1283.4 / 218.3 / 1527.9 / 64.6 |
| favourites (before) | 6× | 61/209 | 148/0 | 16.7 / 27 / 291.6 | 340.7 | 2340.9 / 421.3 / 384.3 | 3633.9 / 57.5 / 837.5 / 16.1 |
| favourites (after) | 6× | 98/236 | 138/0 | 16 / 28.8 / 151.4 | 147.8 | 1198.8 / 724.1 / 640.7 | 3355.9 / 105.9 / 485.3 / 43.9 |
| playlist (before) | 1× | 54/58 | 3/1 | 16.7 / 20.2 / 24.6 | 17.5 | 265.6 / 54.2 / 70.9 | 470.5 / 55.3 / 304.7 / 14.8 |
| playlist (after) | 1× | 55/59 | 3/1 | 16.6 / 17.8 / 22.8 | 9.2 | 70.7 / 67.9 / 86.4 | 313.1 / 67.9 / 397.9 / 21.2 |
| playlist (before) | 6× | 61/121 | 60/0 | 16.1 / 16.8 / 30.4 | 319.1 | 796.5 / 107.3 / 126.9 | 1167.5 / 23.1 / 272.2 / 9.7 |
| playlist (after) | 6× | 55/97 | 42/0 | 15.9 / 17.2 / 42.8 | 126.9 | 292.6 / 209.1 / 213.6 | 995.7 / 42.7 / 193.7 / 19.9 |

Script time falls by 55–70% on every song list and the longest task at 6×
goes from 288–341 ms to 125–148 ms. It is not enough on its own: at 6× half
the frames are still shown without their rows, and layout and paint now take
a larger share because more rows get mounted in the same time. That is P2.
