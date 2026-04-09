# Soundsible web UI

## Development (Flask serves source)

1. `npm install` (copies `socket.io-client`’s browser ESM build into `js/vendor/` for native module loading—Flask does not resolve npm package names)
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
