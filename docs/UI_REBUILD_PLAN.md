# Player UI Rebuild — Master Plan (SolidJS)

> Status: **Phase 3 done — all views + full playback subsystem landed; next: Phase 4 (desktop), then tests** — created 2026-06-16. Living document.
>
> Done: Solid+TS+Vite toolchain alongside legacy (builds clean, served at `/player/app.html`);
> design direction locked (dark · dense · pro · adaptive · orange); tokens + seed primitives
> (`Button`, `SongRow`) + preview page. **Architecture spine:** HashRouter + app shell
> (`app.tsx`, `TabBar`, `OmniBar`); single reactive store (`stores/index.ts`) replacing the
> window-globals; typed REST + Socket.IO clients (`lib/api.ts`, `lib/socket.ts`) over the
> existing engine contract; **overlay manager** (`lib/overlay.tsx`) — the one place modals
> mount, auto-disposed (the Discover leak is now structurally impossible). Placeholder routes
> exercise store + overlay.
>
> **Home/Library view DONE** (`routes/Home.tsx`): real engine data (`/api/library` + `/api/library/favourites`)
> in the store; virtualized `SongRow` list (`@tanstack/solid-virtual`); favourite toggle (optimistic
> + `/api/library/favourites/toggle`, revert on failure); real audio playback via a shared element
> (`lib/audio.ts`, streams `/api/static/stream/<id>`) reflected in `OmniBar` with play/pause. Builds +
> typechecks clean. (Note: 2026-06-16 the flaky `/mnt/storage` disk intermittently dropped node_modules
> files mid-build — reinstall + retry clears it; reseat SATA + fsck pending.)
>
> **Views done so far:** Home, **Favourites**, **Search** (client-side library filter), **Settings**
> (connection, library reload/rescan, device name). Reusable `TrackList` (virtualized) + `ViewHeader`
> extracted; tab bar IA = Inicio / Buscar / Discover / Ajustes (Favoritos + Listas via Home chips).
>
> **Process (user decision 2026-06-16):** build ALL views first, then ONE full test-coverage pass at
> the end — not test-as-you-go. Verify each batch with typecheck + build for now.
>
> **Playlists DONE** — `routes/Playlists.tsx` (cover grid, covers via `lib/playlists.ts`) +
> `routes/PlaylistDetail.tsx` (`/playlists/:name`, virtualized tracks, play, back). Store gained
> `playlists` + `librarySettings` slices; `api.getLibrary()` now returns the full payload.
>
> **Discover DONE** — `routes/Discover.tsx`: instant YouTube-Music search (250ms debounce +
> AbortController cancellation + in-memory cache), one-tap **preview** (`/api/preview/stream/<id>`,
> no download, via the playback refactor where `currentTrack` is the object + `source:'preview'`),
> one-tap **add to library** (`POST /api/downloader/queue`, row shows spinner → ✓ when the track lands
> in the library via `library_updated`), and **radio** (`/api/downloader/youtube/related`) for endless
> discovery. New `api.ts` methods: searchYouTube / relatedYouTube / enqueueDownload.
>
> **Podcasts DONE** — `routes/Podcasts.tsx` (subscriptions grid + iTunes search → subscribe) +
> `routes/PodcastShow.tsx` (`/podcasts/:id`, episodes via `createResource`, play via peek→token→stream,
> unsubscribe). Store gained `podcastSubscriptions`; `actions.playEpisode`. `types/podcast.ts`.
>
> **Playback subsystem DONE** — single shared audio element + store-owned `playback` slice:
> queue with next/prev/auto-advance, shuffle, repeat (off/all/one), seek bar, expand-to-Now-Playing
> sheet (with queue list + jump-to), and Media Session API (lock-screen metadata + transport handlers).
> (`stores/index.ts`, `OmniBar.tsx`, `NowPlaying.tsx`, `lib/audio.ts`.)
>
> **Downloads DONE** — `routes/Downloads.tsx`: the live mirror of the engine queue. New `downloads`
> store slice seeded from `GET /api/downloader/queue/status` and driven by `downloader_update` socket
> events (`applyDownloadEvent` mirrors the legacy `mergeDownloaderEvent` — completed items leave the
> queue, unknown ids append). Per-row progress bar (determinate %/indeterminate), phase + speed·ETA,
> optimistic retry/remove + clear-failed/clear-all, and a transient "recently added" strip. New
> `api.ts` methods: getDownloadQueue / retryDownload / removeDownload / clearDownloads /
> clearFailedDownloads. Reachable via a **Home "Descargas" chip with a live active-count badge**.
>
> **Artist DONE** — `routes/Artist.tsx` (`/artist/:name`): every library track by one artist (matches
> `artist`/`album_artist`), artist hero (gradient avatar + initial), play-all + shuffle. Reachable by
> tapping an artist name in any `SongRow`/`TrackList` row, or on the Now Playing screen (library tracks
> only — preview/podcast sources are not library artists). Store gained `actions.playShuffled`.
>
> **🎉 ALL VIEWS DONE:** Inicio · Buscar · Discover · Favoritos · Listas (+detalle) · Podcasts (+show)
> · **Descargas** · **Artista** · Ajustes, on the single store + overlay manager, dark/dense/pro,
> virtualized, fine-grained.
>
> Remaining before tests: (1) **cross-device playback resume/remote** (the legacy `playback_resume.js`
> / `remote_control.js` sync — socket events are already typed in `lib/socket.ts`, not yet wired);
> (2) the **desktop surface** (responsive + sidebar nav vs bottom tabs); (3) then the **full Vitest +
> @solidjs/testing-library coverage pass** (user decision: tests LAST).

## Context

The player web UI (`ui_web/`) is mature in features but structurally weak. It was
built in vanilla JS without a component model, and four root deficiencies cause
every recurring symptom:

1. **No component lifecycle** → modals/tooltips/dropdowns get `document.body.appendChild`'d
   and never cleaned up (e.g. `discovery.js:825` resolution sheet at `z-[9999]`, the
   `_personalRailIntervalId` timer at `discovery.js:169`). This is the "Discover elements
   leak into other views" bug class.
2. **No style scoping** → global Tailwind + custom CSS + hard-coded `z-index` (9999, 1280, 220…)
   with no system → visual bleed.
3. **Coarse reactivity** → manual `innerHTML` and full-section re-renders on tiny state
   changes (toggling one favourite re-renders the whole home). Hence chronic perf pain
   and band-aids (progressive chunking, ref-equality guards).
4. **Split state** → a central `Store` (`store.js`) *plus* ~20 `window._*` globals
   (`_currentPlaylistTracks`, `_discoverSurfaceTracks`, search caches…) → desync bugs.

Goal: rebuild the player on a foundation where these classes of bug are **impossible by
design**, not patched away — scalable, efficient, and visually at the level of the
author's other work.

## Locked decisions

- **Framework:** SolidJS + TypeScript. Fine-grained reactivity (no VDOM, component body
  runs once) → kills the re-render footgun class; reactivity is plain primitives usable
  anywhere → clean single store; best-in-class TS → strong API/state contracts. Tiny
  runtime suits Tauri (WebKitGTK on Linux) + PWA.
- **Strategy:** Full rewrite of the frontend on branch `dev`. Built **alongside** the
  legacy app; backend untouched; cut over at parity.
- **Sequence:** Design system first, then redesign each view as it is ported.
- **Surface priority:** Mobile/PWA first; desktop second on the same shared core.

## Target architecture

```
ui_web/
  legacy/            # current vanilla app, kept servable until cutover (moved from js/, css/)
  src/               # new SolidJS app (TS)
    main.tsx         # mount
    app.tsx          # shell + router outlet
    routes/          # one folder per view (home, favourites, artist, playlists,
                     #   discover, podcasts, settings, search, downloads, now-playing)
    components/      # design-system primitives (Button, Sheet, VirtualList, SongRow, …)
    stores/          # reactive single source of truth (createStore / signals)
    lib/
      api.ts         # typed REST client (wraps existing /api/* contract)
      socket.ts      # typed Socket.IO client (wraps existing events)
      overlay.tsx    # portal/overlay manager — the ONE place modals mount, auto-disposed
    styles/
      tokens.css     # design tokens (CSS custom properties) — single source of truth
    types/           # shared domain types (Track, Playlist, LibraryMetadata, …)
```

Key pillars:

- **Single store**: all the `window._*` globals collapse into typed Solid stores. UI
  derives from state; no DOM-as-source-of-truth.
- **Router**: `@solidjs/router` replaces the manual `UI.showView` slide machinery and the
  brittle `setTimeout(450)` transition cleanup. View transitions become declarative.
- **Overlay/portal manager**: modals/sheets render through `<Portal>` owned by a manager
  that disposes them on unmount — the resolution-sheet leak becomes structurally impossible.
- **Virtualized lists**: large song/discover lists use a virtualizer (TanStack Virtual /
  `@solid-primitives/virtual`) instead of full `innerHTML`; works for drag-drop playlists too.
- **Motion**: declarative transitions via `solid-transition-group` + Motion One (small libs)
  — replaces the hand-rolled slide state machine.
- **Styling**: design tokens as CSS variables; Tailwind (v4 CSS-first, consuming the tokens)
  for utilities; CSS Modules co-located per component for structure → auto-scoped, no bleed.
- **Toolchain**: existing Vite 6 + `vite-plugin-solid`, TypeScript, ESLint, multi-entry
  (mobile + desktop) preserved.

### Backend = stable contract (do not touch)

Flask + Socket.IO + yt-dlp/FFmpeg stay as-is. The `/api/*` REST surface and socket events
are the contract the new UI binds to. This is what makes a "big-bang" frontend rewrite safe:
the hard, tested half of the system doesn't move.

## Phased roadmap (mobile/PWA first)

- **Phase 0 — Design direction & system.** Gather visual references from the user; extend
  `DESIGN.md` with a *player* design system (the current `DESIGN.md` only covers the Tauri
  shell): tokens (reuse existing `--accent #f97a12`, `--bg-base #0d0d0f` for continuity),
  type scale, spacing, radii, motion, and a component inventory. Output: token file +
  font/color preview page. **(blocks Phase 2; needs user input — see below.)**
- **Phase 1 — Toolchain & core skeleton.** Solid+TS+Vite wired; move legacy to `ui_web/legacy/`;
  build the single store, typed `api.ts` + `socket.ts`, router, overlay manager, app shell.
  Flask serves the new build behind a flag/route; legacy stays default.
- **Phase 2 — Design-system primitives.** Build the reusable Solid components (Button, Icon,
  Sheet/Modal via overlay manager, Tabs, VirtualList, SongRow, ArtistCard, Skeleton, Toast…)
  with a preview page. Each ships with a component test.
- **Phase 3 — Views, one at a time, mobile-first.** Suggested order (value + risk):
  Home/Library → Favourites → Artist detail → Playlists/detail → **Discover** (worst leaker,
  now trivially correct) → Podcasts → Settings → Search → Downloads → Now-Playing/omni player.
  Each view: bind to store + API client, redesign per the design system, add component +
  e2e tests, and check off a **parity checklist** against the legacy view.
- **Phase 4 — Desktop.** Desktop layout/shell on the shared core; `app_desktop` parity.
- **Phase 5 — Cutover.** Parity audit, flip Flask to serve the new build by default, delete
  `ui_web/legacy/`, run perf benchmark + regression suite, update docs (`ARCHITECTURE.md`,
  `README`, this file).

## Testing strategy

- **Component/unit:** Vitest + `@solidjs/testing-library` — render, state mutation,
  cleanup-on-unmount (assert no leaked nodes/listeners). This is the coverage the legacy
  app never had.
- **E2E:** Playwright against built UI + real Flask engine — core flows (play, queue,
  favourite, download, navigate-away-from-Discover-and-assert-no-leak).
- **Backend:** existing 34 pytest tests remain the contract guard.

## Verification (per phase)

1. `npm run build` in `ui_web/` succeeds; new app loads at the feature-flagged route.
2. Vitest + Playwright green for the phase's surface.
3. Manual: navigate into Discover, trigger a sheet, navigate away → assert no orphaned
   overlay/timer (the original sin) via the browse tool / devtools.
4. Benchmark a 1000+ track list scroll vs legacy (Phase 5 gate).

## Open input needed from user

- **Visual direction for Phase 0:** 3–4 reference apps whose *feel* to aim for, light/dark
  intent, and any non-negotiables (keep orange accent? density? glass vs flat?). Can be
  driven via the `/design-consultation` skill or freeform.
