# Soundsible web UI

The Station player: a responsive **SolidJS + TypeScript** app in `src/`, built with Vite. It is the only web frontend — used by browsers, mobile/PWA clients, and the Tauri desktop shell. Legacy paths (`/player/app.html`, `/player/mobile/`, …) redirect to `/player/`.

The production bundle (`dist/`) is not committed. The Station engine rebuilds it automatically when `src/` (or Vite config) is newer than `dist/` — on API boot and when serving `/player/`. You can still use the Vite dev server while developing, or force a rebuild with `python3 scripts/ensure_ui_dist.py`.

## Shared building blocks

Reach for these before writing a local copy — each one used to be duplicated across half a dozen views, and the copies drifted:

| Module | Owns |
| --- | --- |
| `lib/cover.ts` | `coverGradient` / `coverStyle` — the seeded placeholder artwork, layered under the cover so a 404 degrades instead of breaking. `neutralCoverStyle` for non-track artwork (playlists, podcast shows). |
| `lib/format.ts` | `formatDuration` (list columns, blank when unknown), `clockTime` (transport readouts, never blank), `trackCount`. |
| `lib/catalogItem.ts` | Catalog row → playable track, plus `playCatalogItem`: resolve-then-play with abort-on-newer-click and a `resolvingItemId` signal for per-row spinners. |
| `components/Spinner.tsx` | The one indeterminate spinner, sized via a prop. |
| `stores/index.ts` | `playback.isLoading` / `playback.loadError` — see the playback loading contract in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). |

## Prerequisites

- **Node.js 22+** and **npm**
- Station Engine listening on **port 5005** (start it with `python3 run.py --daemon`, the terminal menu or the launcher)

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
npx playwright install chromium webkit  # first browser-test run
npm run test:ui-scale
```

`npm test` runs the TypeScript check and Vitest unit tests. The engine builds
`dist/` automatically; CI checks the production bundle.
`npm run test:ui-scale` validates Compact, Normal and Large across Chromium and
WebKit mobile/desktop projects, including overflow, target geometry, pre-login
accessibility, key routes, edge viewports and reviewed screenshots. Only update
the baselines after visually reviewing the rendered result:

```bash
npm run test:ui-scale:update
```

## Screenshots

The README and site screenshots, and the repository's social card, are taken
by `showcase/`, not by hand. Each screen is a spec that puts the player in a
known state against a mocked engine serving real CC BY music from Jamendo
(`showcase/catalog/`, credited in `showcase/CREDITS.md`), and is photographed
once per theme at a fixed viewport and pixel ratio:

```bash
scripts/refresh_showcase.sh   # from the repository root; runs in the Playwright image
```

It writes `docs/images/screenshots/<theme>/*.webp` and
`docs/images/social-card.png`, rewriting a file only when its picture actually
changed. A theme added to `src/boot/themes.ts` is photographed automatically.
The release command runs it before every release. `npm run showcase` runs the
same specs outside Docker, where this machine's font rendering will rewrite
most of the pictures.

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

## Android port

The Android entry reuses the same Solid sources, theme, fonts and dictionaries.
Its packaged assets are separate from the engine bundle. Follow
[the Android guide](../docs/ANDROID.md) and
[the handoff](../docs/android/HANDOFF.md); this is a development client with account login and read-only browsing, not an alpha.
