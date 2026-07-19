# Soundsible web UI

The Station player: a responsive **SolidJS + TypeScript** app in `src/`, built with Vite. It is the only web frontend — used by browsers, mobile/PWA clients, and the Tauri desktop shell. Legacy paths (`/player/app.html`, `/player/mobile/`, …) redirect to `/player/`.

The production bundle (`dist/`) is not committed. The Station engine rebuilds it automatically when `src/` (or Vite config) is newer than `dist/` — on API boot and when serving `/player/`. You can still use the Vite dev server while developing, or force a rebuild with `python3 scripts/ensure_ui_dist.py`.

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

First-time setup still needs dependencies:

```bash
cd ui_web && npm ci && cd ..
```

After that, starting the engine is enough — it runs `vite build` when `dist/` is missing or stale. Skip with `SOUNDSIBLE_SKIP_UI_BUILD=1`. Desktop builds that set `SOUNDSIBLE_UI_DIST` to a bundled tree are left alone.

The API serves `ui_web/dist/index.html` at:

| Route | Use |
| --- | --- |
| `/player/` | Browsers, phones, PWAs |
| `/player/desktop/` | Same UI with owner-token bootstrap for the desktop shell |

Set `SOUNDSIBLE_WEB_UI_DIST=1` to require the built bundle explicitly, or `0`/`false`/`no` to force the source tree (not useful for production — `index.html` is a Vite dev entry pointing at `/src/main.tsx`).
