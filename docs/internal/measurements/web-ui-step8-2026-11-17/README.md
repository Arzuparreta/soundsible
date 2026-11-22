# Shared web design recipes and interaction contracts

Step 8 of the [web UI review](../../audits/WEB_UI_REVIEW_HANDOFF.md).

## Delivered

Shared native controls, named fields, keyboard tabs, row patterns and artwork
contracts live in `src/design`. Compatibility exports keep existing callers
on one implementation. Density tokens cover panel rows, artwork, fields and
search results. Overflow buttons stay visible in player rows. Skeleton rows
follow the loaded mobile order; skeleton and loaded grids share their columns.

Sheets and context popovers share the overlay registry, dismissal and focus
lifecycle. Shift+F10 carries its anchor; Escape dismisses one surface; focus
returns without scrolling. Canonical album/artist pages remain under Search
(U4), with browser Back retaining the origin. The per-file JSX/CSS debt gate
prevents new raw controls and literal recipe debt without blocking legacy code.
See [the design contracts](../../ui/DESIGN_SYSTEM.md).

## Measured tradeoffs

Three runs per case on the same Ryzen desktop with NVIDIA hardware composition.
The [before](before.json) and [after](after.json) files preserve the results.
CPU 6× is a proxy, not physical-device acceptance. The final exported bundle
was rebuilt after the cover-density and tabpanel changes.

| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms | Busy: main / compositor / GPU / display, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| songs (before) | 1× | 200/201 | 1/0 | 16.7 / 16.9 / 22.8 | 5.8 | 165 / 149.8 / 253.3 | 818.3 / 165.9 / 1356.5 / 42.4 |
| songs (after) | 1× | 201/202 | 1/0 | 16.7 / 17.2 / 22.8 | 5.7 | 171.9 / 155.5 / 259.4 | 846.9 / 175.3 / 1045.3 / 43.5 |
| songs (before) | 6× | 186/272 | 79/7 | 15.6 / 25.4 / 29.2 | 33.3 | 736.4 / 585.9 / 899.6 | 3143 / 119.2 / 1429.3 / 36.2 |
| songs (after) | 6× | 195/279 | 81/3 | 12.6 / 24.7 / 28 | 92.4 | 770.8 / 614.5 / 901.8 | 3333.9 / 120.2 / 1486.5 / 38.5 |
| player-browser (before) | 1× | 199/201 | 2/0 | 16.7 / 17.9 / 22.7 | 4.9 | 202.7 / 143.4 / 192.2 | 828.3 / 161.1 / 1278.7 / 81.1 |
| player-browser (after) | 1× | 200/201 | 1/0 | 16.7 / 17.4 / 22.8 | 5.4 | 214.4 / 149.3 / 220.7 | 875.6 / 170.7 / 1493.6 / 82.6 |
| player-browser (before) | 6× | 142/208 | 66/0 | 19.9 / 25 / 28 | 28.5 | 899.8 / 557.2 / 694.1 | 3222 / 112.8 / 1187.5 / 58 |
| player-browser (after) | 6× | 128/208 | 80/0 | 19 / 26.6 / 29.3 | 30.5 | 883.3 / 544.8 / 749.1 | 3226.3 / 110.2 / 1061.5 / 49.9 |

This is a consistency/accessibility change, with a measurable tradeoff: the
player browser has 80 partial frames at 6× versus 66 before, and paint rises
694 → 749 ms with the visible menu controls. Its longest task is 30.5 versus
28.5 ms. Songs' selected longest task rises 33.3 → 92.4 ms, while its complete
frame ratio is similar (186/272 → 195/279); the cause of that task difference
is not established. Neither this step nor the earlier collection changes
guarantees complete frames on slow hardware.

## Validation

- `npm test`: 1,986 Vitest tests, four trace-analysis tests and three design-gate
  tests passed, including type checking and the debt gate.
- Whole Chromium phone/desktop suite: 451 passed, 77 intentional skips.
- Whole WebKit phone/desktop suite in the matching Playwright image with one
  worker: 438 passed, 90 intentional skips. Both used a fresh fixture-only Vite
  server with unmatched requests sent to the closed port 9.
- Initial authenticated payload: 211,161 gzip bytes, below the unchanged
  215,316-byte ceiling. Vite output was `/tmp/soundsible-step8-dist`; the real
  engine-owned distribution was not rebuilt.
- Local source checkout included merged step 7. Latest remote-head CI and
  current-base verification remain required before merging.
