# Branding assets

Single source of truth for Soundsible logos and icons. Any frontend (web, GTK, future) uses these or the generated outputs.

| File | Purpose |
|------|--------|
| `logo-app.png` | Main app icon (with background). Used for PWA, install icon, GTK window/tray, and in-app placeholders when “Default” is selected. |
| `logo-app-alt.png` | Secondary icon (with background). Activatable in Appearance → App icon as “Secondary” in the web app. |
| `logo-mark.svg` | Transparent mark (no background). Used for loading screen, desktop sidebar next to “Soundsible”, and README header. |

## Changing icons

1. Replace the PNG or SVG in this folder with the new asset (keep the same filenames).
2. Run the build script from the repo root:
   ```bash
   python3 scripts/build_app_icons.py
   ```
   This regenerates `ui_web/assets/icons/` (main set, alt set, and a copy of `logo-mark.svg`).
3. PWA and in-app references use the generated files; no need to edit HTML/JS for a simple icon swap.
