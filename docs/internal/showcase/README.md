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

## Social card

`ui_web/showcase/card.html` renders `docs/images/social-card.png` at 1280×640.
It uses the landing header's flat dark background, rounded icon and lowercase
wordmark, with only “self-hosted music experience” below it, kept on one line
at 36px with brighter text for small feed previews. The desktop shell
shows lyrics, library and queue; the overlapping phone uses the same intact
mobile-library capture as the README. The dark desktop-lyrics capture is staged
by `screens.spec.ts`; the README composition and its source captures are unchanged.

All three elements fit within the central 1280×480 region, with at least 80px
of horizontal padding. `card.spec.ts` checks these bounds and GitHub's 1 MB
upload limit. This protects the composition against the shorter centered crop
seen in GitHub feeds. The full card and a 360px-wide cropped preview are inspected
before committing.

To refresh only the card and its lyrics capture, run these commands sequentially
in `ui_web/` (the Playwright container used by `scripts/refresh_showcase.sh` keeps
font rendering consistent):

```sh
npm run showcase -- --project=desktop --grep desktop-lyrics
npm run showcase -- --project=card --no-deps
```

The committed PNG must also be uploaded in the repository's **Settings → Social
preview** to replace GitHub's stored image; committing it alone does not update
that setting.
