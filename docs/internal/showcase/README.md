# README device composition

The README combines the existing desktop now-playing and mobile-library
captures from `docs/images/screenshots/`, in matching light and dark themes.
`readme.html` supplies the window frame, phone frame and shadows; the app
screenshots stay intact. A separate status area keeps the phone's rounded
upper corners clear of the library header, with vector signal, Wi-Fi and
battery icons. The library capture retains its original aspect ratio below
that area. No swipe indicator overlays the capture.
The transparent canvas follows the README background.
The phone overlaps only the lower part of the desktop's left library pane,
leaving the player and the entire right queue panel visible.

After installing the dependencies in `ui_web/`, run
`node scripts/render_readme.mjs` from the repository root to compose both PNGs
without recapturing the app. Inspect both outputs before committing.
`scripts/refresh_showcase.sh` also regenerates them after refreshing the source
captures. The README selects the light image with `prefers-color-scheme` and
uses the dark image as its fallback, matching the screenshot gallery.

The source captures retain their existing Jamendo music credits in
`ui_web/showcase/CREDITS.md`.
