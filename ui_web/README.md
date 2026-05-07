# Soundsible web UI

The Station UI includes **Library**, **Search** (ODST / YouTube Music–style results), **Discover** (Deezer metadata for charts and editorial playlists; playback resolves to YouTube via the same search API as the downloader), and **Downloads**. Discover-related logic lives mainly in `js/discovery.js`, `js/deezer_actions.js`, and shared list code in `js/renderers.js` (with `playback_context.js` routing `deezer_*` ids to preview playback).

## Development (Flask serves source)

1. `npm install` (optional for JS work; `postinstall` refreshes `js/vendor/socket.io-client.esm.min.js` from `socket.io-client`. That vendor file is **committed** so `http://<station>:5005/player/` works on machines that never run npm—without it, the browser gets HTML 404s and the app stays on “Initializing”.)
2. `npm run css:build` (or `npm run css:watch` in another terminal)
3. Start the Python API as usual; open `http://localhost:<port>/player/`

Tailwind output is `assets/tailwind-compiled.css` (required for styles when not using the Vite dev server).

## Vite dev server (optional)

`npm run dev` serves the UI on port 5173 with `/api` and `/socket.io` proxied to `http://127.0.0.1:5005` (change `vite.config.js` if your station port differs).

## Production build

```bash
npm run build
```

Outputs `dist/` with hashed JS/CSS. Serve it by setting **`SOUNDSIBLE_WEB_UI_DIST=1`** when starting the API so Flask uses `ui_web/dist` instead of `ui_web/`.

## Scripts

| Script        | Purpose                                      |
|---------------|----------------------------------------------|
| `css:build`   | One-shot Tailwind → `assets/tailwind-compiled.css` |
| `css:watch`   | Rebuild CSS when templates/JS change         |
| `build`       | CSS + Vite bundle + static copy + HTML fix   |
| `preview`     | Preview the production `dist/` build         |
