# Soundsible web UI

The Station player: a responsive **SolidJS + TypeScript** app in `src/`, built with Vite. It is the only web frontend — used by browsers, mobile/PWA clients, and the Tauri desktop shell. Legacy paths (`/player/app.html`, `/player/mobile/`, …) redirect to `/player/`.

The production bundle (`dist/`) is not committed. Build it before serving through the engine, or use the Vite dev server while developing.

## Prerequisites

- **Node.js 20+** and **npm**
- Station Engine listening on **port 5005** (start via `python3 run.py` or the launcher)

## Development

Start the Python engine, then:

```bash
npm install    # first time; use npm ci in CI or clean installs
npm run dev
```

Vite serves the UI on `http://localhost:5173/player/` and proxies `/api` and `/socket.io` to `http://127.0.0.1:5005`.

## Verification

```bash
npm test
npm run build
```

`npm test` runs the TypeScript check and Vitest unit tests. `npm run build` typechecks and writes the production bundle to `dist/`.

## Running through the engine

Build first, then start Soundsible normally:

```bash
npm ci && npm run build
```

The API serves `ui_web/dist/index.html` at:

| Route | Use |
| --- | --- |
| `/player/` | Browsers, phones, PWAs |
| `/player/desktop/` | Same UI with owner-token bootstrap for the desktop shell |

Set `SOUNDSIBLE_WEB_UI_DIST=1` to require the built bundle explicitly, or `0`/`false`/`no` to force the source tree (not useful for production — `index.html` is a Vite dev entry pointing at `/src/main.tsx`).
