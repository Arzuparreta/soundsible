# One search field on every view (2026-11-17)

Before/after captures for the change that makes `SearchField` the only search
control and lets it fill its container on every view.

## What changed

- Discover's field was capped at `44rem` plus gutters (added in #432 with the
  comment "capped for reading"). No other view capped its field: Podcasts,
  Library and Settings filled the content width. The cap is removed.
- Library (`routes/Library.tsx`) built its own field: 48 px tall instead of
  `--control-h`, its own colours and focus style, and without the autofill
  opt-outs `SearchField` carries. It now uses `SearchField`.
- The Android library (`mobile/LibraryBrowser.tsx`) used an unstyled
  `<label>` and `<input>`. It now uses `SearchField`, like the other Android
  screens.
- The player panel (`components/NowPlayingBrowser.tsx`) built its own field
  around its scope button. It now uses `SearchField` with that button in the
  new `leading` slot, and supplies the stage colours through the
  `--search-field-*` properties.

## Captures

Chromium, fixture engine (`tests/browser/music-browser-fixture.ts`), dark theme,
Spanish copy. Desktop at 1880×1000, phone at 390×844 (Pixel 7 profile). The
player captures are cropped to the panel header.

| View | Before | After |
| --- | --- | --- |
| Discover, desktop | [Before](desktop-discover-before.png) | [After](desktop-discover-after.png) |
| Library, desktop | [Before](desktop-library-before.png) | [After](desktop-library-after.png) |
| Library, phone | [Before](mobile-library-before.png) | [After](mobile-library-after.png) |
| Player panel, desktop | [Before](desktop-player-before.png) | [After](desktop-player-after.png) |
| Player panel, phone | [Before](mobile-player-before.png) | [After](mobile-player-after.png) |

The Android library renders only inside the Android shell and has no browser
capture; `mobile/LibraryBrowser.test.tsx` covers its search.

The player browser's reviewed screenshot baselines
(`ui_web/tests/browser/design-system.spec.ts-snapshots`) were re-run in the
Playwright image for all five profiles and still match within the configured
1.5 % tolerance, so none was replaced.
