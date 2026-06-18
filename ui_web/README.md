# Soundsible web UI

The Station UI includes **Library**, **Search** (ODST / YouTube Music–style results), **Discover** (Deezer metadata for charts and editorial playlists; playback resolves to YouTube via the same search API as the downloader), and **Downloads**. Discover-related logic lives mainly in `js/discovery.js`, `js/deezer_actions.js`, and shared list code in `js/renderers.js` (with `playback_context.js` routing `deezer_*` ids to preview playback).

## Development (Flask serves source)

1. `npm install` (optional for JS work; `postinstall` refreshes committed browser-vendor files in `js/vendor/`. Right now that includes `socket.io-client.esm.min.js` and `qrcode.esm.js`, so direct Flask source serving works on machines that never run a bundler.)
2. `npm run css:build` (or `npm run css:watch` in another terminal)
3. Start the Python API as usual; open `http://localhost:<port>/player/`

Tailwind output is `assets/tailwind-compiled.css` (required for styles when not using the Vite dev server).

## Vite dev server (optional)

`npm run dev` serves the UI on port 5173 with `/api` and `/socket.io` proxied to `http://127.0.0.1:5005` (change `vite.config.js` if your station port differs).

For desktop-engine work, remember that the real Flask-served desktop player may be on a random loopback port. The source UI now resolves API base URLs from `window.location.port`, so it works when the Station is not on `5005`.

## Production build

```bash
npm run build
```

Outputs `dist/` with hashed JS/CSS. Once built, the API serves `ui_web/dist` automatically under `/player/` — no env var needed. To force the raw source tree instead (e.g. while editing the legacy player), start the API with **`SOUNDSIBLE_WEB_UI_DIST=0`**.

> The new SolidJS player (`/player/app.html`) only works from a build — its source entry points at the Vite dev server. Run `npm run build` (or `npm run dev` on the Vite server) to see your changes.

## Scripts

| Script        | Purpose                                      |
|---------------|----------------------------------------------|
| `css:build`   | One-shot Tailwind → `assets/tailwind-compiled.css` |
| `css:watch`   | Rebuild CSS when templates/JS change         |
| `build`       | Refresh vendor files + CSS + Vite bundle + static copy + HTML fix |
| `preview`     | Preview the production `dist/` build         |

## Desktop pairing UI

The desktop settings view now includes a first consumer of the pairing APIs:

- open pairing session
- render backend-provided QR payload as a scannable QR
- poll pairing status
- close/cancel the display session
- list and revoke paired phones

Admin/owner requests from the desktop player are authenticated through `js/admin_auth.js`. In desktop-engine mode, `/player/desktop/` receives the owner token automatically from the Flask response bootstrap.
