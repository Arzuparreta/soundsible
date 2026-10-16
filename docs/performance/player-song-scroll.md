# Player song-list scroll: X270 diagnosis and scoped fix

The desktop player song browser now keeps its vertical scrollbar allocated
while a nonempty virtual song list is mounted. Previously its shared body used
`overflow: auto` on both axes. Replacing virtual rows repeatedly incurred costly
layout and paint work in native Chrome on the ThinkPad X270.

The modifier applies to Library's Songs tab and song collections such as
Favourites and playlists. Albums, artists, empty collections and playlist edit
content keep their existing overflow rules. The rule is desktop-only
(`min-width: 1024px`); mobile pager behaviour and horizontal overflow stay as
before. Artwork, materials, effects, row sizing and overscan are unchanged.
Nonempty short desktop collections also reserve the thin scrollbar gutter;
their text can consequently have slightly less available width.

## Evidence and limits

Measured on i5-6300U, Intel HD 520/i915/Mesa, native headed Chrome with hardware
compositing and rasterization enabled. The window occupied workspace 1 alone:
1533 × 755 CSS px at zoom/DPR 1.25. Playback was paused. Repeated warm-cache
scrolls used native CDP wheel gestures at a requested 2400 CSS px/s.

| Player surface | Distance | Original p95 rAF interval | Vertical-scroll control |
| --- | ---: | --- | --- |
| Library | 6000 px | 50 / 50 / 50 ms | 33.4 / 33.4 / 33.4 ms |
| Favourites | 2400 px | 66.6 / 50 / 66.5 ms | 33.4 / 33.3 / 33.3 ms |

These alternating/control-order samples fetched no new images. Geometry,
scroll distance and child-list mutations matched within each surface. Fixing
only horizontal overflow did not reproduce the improvement. In an earlier
traced pair, fixed vertical and horizontal overflow reduced accumulated Layout
thread time from 600.0 to 219.8 ms and Paint from 345.3 to 125.7 ms. Those are
inclusive event-specific times, not total CPU or GPU utilization.

Native full-surface captures (1916 × 944) compared the original and vertical-only
control in Library and Favourites, in light and dark CSS themes. All four pairs
had identical pixels and row rectangles. Animations were paused only for that
frame comparison, not the performance runs. This does not validate every size,
short list or physical iPhone interaction.

The rAF percentiles describe scheduling intervals, not presented FPS. Lag
remains after this change. Temporarily removing backdrop filters did not make
the remaining scroll consistently smooth, so this fix retains those materials.
Warm lag also persisted with client HTTP offline; server/Samba latency cannot
alone explain it. Cold artwork decoding and visible placeholders remain a
separate investigation, not a claimed benefit of this fix.

Firefox was measured separately, with WebRender acceleration verified. Its
native wheel implementation differs, and some panel filters compute to `none`
in the served bundle because those rules contain only the WebKit-prefixed
declaration. Its figures are not a same-rendering comparison with Chrome.

Raw account-bearing traces and screenshots are kept outside the repository;
the local audit archive records each run, script and rejected control. Do not
generalize these measurements to other hardware or promise constant 60 FPS.
