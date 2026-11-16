# Web UI review step 1, 2026-11-16

Chromium, 1366×768, dark theme, 12-track fixture library, motion enabled.
Before: `main` at `a7ec7c72`. After: `fix/web-ui-step1-functional`.

| Case | Before | After |
| --- | --- | --- |
| Enter on a row's options button | `before-menu-enter.webp`: menu at 0,0, focus still on the button | `after-menu-enter.webp`: menu under the button, focus on its first action |
| Pointer click on a row's options button | `before-menu-pointer.webp`: bottom edge 17.6px below the window | `after-menu-pointer.webp`: 8px inside the window |
| Songs list, tertiary text (durations, track count) | `before-songs-dark.webp`: `#6a6a72`, 3.65:1 | `after-songs-dark.webp`: `#888890`, 5.56:1 |

See U1, U5, U6 and U8 in
[WEB_UI_REVIEW_HANDOFF.md](../../audits/WEB_UI_REVIEW_HANDOFF.md).
