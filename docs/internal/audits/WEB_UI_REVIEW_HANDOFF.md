# Web UI architecture review handoff (2026-11-16)

Entry point for continuing the web UI architecture review without the chat
history. Update the status table when an item closes.

## What was reviewed and how

The owner reported that Soundsible's web UI renders slowly everywhere, above all
while scrolling lists, freezes outright on a fast flick (even on a high-end
desktop), and looks and behaves less cohesively than Spotify or YouTube, which
are visually richer and stay smooth on a dual-core ThinkPad. They asked for a
review of the whole web UI from its foundations, including industry practice.

Five independent reviews ran on `00fd7d0a` (`ui_web/` is identical in
`77811eab`). None saw the others' work. Their full reports are in
[web-ui-review/](web-ui-review/):

| Angle | Report | Method |
| --- | --- | --- |
| Rendering performance | [performance.md](web-ui-review/performance.md) | Production bundle, mocked engine with 6,000 tracks / 600 albums / 200 artists / 1,800 saved and real JPEG artwork; Chrome traces under real wheel, gesture, keyboard and touch input; hardware GPU (ANGLE over NVIDIA GL, verified), SwiftShader, 4× and 6× CPU throttling; ablations; logged-out YouTube and Spotify with the same method |
| Code architecture | [architecture.md](web-ui-review/architecture.md) | Source reading plus Node operation-count probes of the real stores |
| Industry practice | [industry.md](web-ui-review/industry.md) | Primary sources: engine documentation and source, company engineering accounts, specifications |
| UX and design system | [ux.md](web-ui-review/ux.md) | 362 screenshots (3 viewports × 2 themes × 3 interface sizes, states, menus), DOM measurements, CSS literal audit |
| Platforms and runtimes | [platform.md](web-ui-review/platform.md) | Code inventory of engine-specific workarounds, vendor documentation, Chromium/WebKit capability probes |

Every finding below was re-read against the code before it was written here.
One reviewer finding did not survive that check (A4) and one turned out to be a
recorded design decision rather than a defect (U4).

Not measured by anyone: the X270 itself, an iPhone PWA, Android System WebView,
Windows WebView2, the owner's real library and live socket traffic, and
scrollbar dragging (no automated input produced verified drag motion). 4×/6×
CPU throttling on a Ryzen 5800X and SwiftShader are proxies, not device results.

## Answer

**The foundation is not the cause; what was built on it is.** All five reviews
independently recommend keeping Solid, TypeScript, Vite, CSS Modules,
HashRouter, native browser scrolling, TanStack Virtual and the current runtime
model (the browser/PWA client, Capacitor with native services on Android,
Tauri/WebView2 on Windows, no Linux app). No evidence supports a framework
rewrite, Electron/CEF, a native or Flutter/React Native UI, or a blanket
"remove the blur" pass.

What is missing is one owned contract for collections, rows, artwork, menus,
density and scrolling. Each surface implements its own, so cost and behaviour
depend on where the same music is opened:

- 5 virtualizer integrations, 10 row recipes, 9 card families, 3 horizontal
  rail implementations, 2 menu engines, 1,526 raw CSS literals outside
  `tokens.css` (exposure count, not defects), no lint or visual gate that
  stops new copies.
- The freeze is **main-thread work to build each row as it enters the virtual
  window**, plus **paint on surfaces that are not virtualized at all**.
  Removing every filter, backdrop filter, shadow and animation does not change
  the CPU-bound freeze (measured, see below). The owner's intuition that it is
  not an effects problem is correct for that failure.
- Rich competitors stay smooth because their per-item work is small and video
  thumbnails decode and composite outside the DOM pipeline. Visual complexity
  does not predict main-thread cost.

## Measured evidence

Same machine, same Chromium, hardware GPU, 1366×768, DPR 1, 3.2 s wheel burst.
P/E = frames presented / frames the pipeline expected. Display gap = time
between displayed frames. Source: [performance.md](web-ui-review/performance.md)
per-surface tables and `SAMPLE_INDEX`.

| Scene | CPU | P/E | Partial / dropped | Display gap p50 / p95 / max, ms | Longest main-thread task, ms |
| --- | --- | ---: | ---: | ---: | ---: |
| Spotify album page (public) | 1× | 187/187 | 36/0 | 16.7 / 20.6 / 34.6 | 8.9 |
| YouTube search results (public) | 1× | 109/110 | 17/1 | 32.9 / 50.5 / 67.6 | 20.8 |
| Soundsible Library songs, paused | 1× | 149/149 | 12/0 | 28.4 / 49.1 / 60.2 | 17.5 |
| Soundsible Favourites, paused | 1× | 175/176 | 51/1 | 19.3 / 43.7 / 56.3 | 34.5 |
| Soundsible album (100 tracks), playing | 1× | 79/97 | 0/18 | 34.0 / 52.0 / 84.2 | 7.6 |
| Spotify album page (public) | 6× | 183/192 | 99/9 | 16.7 / 32.3 / 46.6 | 41.4 |
| YouTube search results (public) | 6× | 72/151 | 32/79 | 25.8 / 130.6 / 178.9 | 137.5 |
| Soundsible Library songs | 6× | 43/209 | 34/166 | 60.2 / 211.2 / 228.4 | 215.4 |
| Soundsible Favourites | 6× | 37/218 | 33/181 | 41.5 / 255.5 / 343.6 | 343.0 |
| Songs, all effects stripped (ablation) | 6× | 39/214 | 34/175 | 48.1 / 229.7 / 247.3 | 234.4 |
| Plain 6,000-row text + art list in the same shell (ablation) | 6× | 191/191 | 68/0 | 16.6 / 18.1 / 39.2 | 34.9 |

What the table establishes:

1. Under the CPU proxy the song lists spend 1.7–2.3 s of a 3.2–3.6 s interval
   in JavaScript and present about one frame in five. A plain row in the same
   shell presents every frame. The row, not the shell or the effects, is the
   cost.
2. Spotify under the same proxy keeps its longest task at 41 ms. YouTube also
   drops frames at 6×, so "YouTube never drops a frame" holds only on fast
   hardware.
3. On the fast desktop the song lists already run at a 19–28 ms median frame
   interval, against Spotify's 16.7 ms, with 55–98 ms worst gaps at 1920×1080.
   The owner's 144 Hz monitor has a 6.9 ms frame period.
4. **Desktop playback costs frames on every library surface.** With a track
   playing, every route surface in the desktop layout drops 8–27 frames per
   burst. Surfaces with little main-thread work (album tracks, playlists
   grid, artists, remote search; longest task under 8 ms) go from a 20–24 ms
   to a 34–49 ms median interval. Surfaces inside the open full player, which
   hides the shell, drop none, and the same low-work surfaces in the 390 px
   layout drop none. That points at something the desktop shell does during
   playback. No reviewer investigated it; see P5. **Step 3 found this to be
   a measurement artifact**: the frames are lost after the list stops, not
   while it scrolls.

## Status

IDs: **P** performance, **A** code architecture, **U** UX and design system,
**X** platform and test infrastructure.

| # | Item | Evidence | Status |
| --- | --- | --- | --- |
| P1 | Every entering row resolves its saved/favourite state by scanning the whole saved array: `savedEntryForKeys` ([identity.ts:254](../../../ui_web/src/stores/identity.ts#L254)) calls `savedEntryForIdentity` ([saved.ts:14](../../../ui_web/src/lib/saved.ts#L14)), which uses `find`/`filter`. The ambiguity-aware `savedIndex` memo already exists at [identity.ts:69](../../../ui_web/src/stores/identity.ts#L69) and is not used for it. | Measured: using the index at 6× cut Favourites' longest task from 260–282 ms to 145–157 ms and script time from 1.92 s to 1.17–1.24 s. Necessary, not sufficient. | **Closed (step 4).** `savedEntryForKeys` answers from `buildSavedIdentityIndex` (`lib/saved.ts`), a memo in `stores/identity.ts`; a seeded test checks it against the scan on 10,000 random cases. Songs at 6×: longest task 288 → 125 ms, script 2,635 → 1,122 ms; at 1× script 1,053 → 322 ms ([numbers](../measurements/web-ui-rendering-2026-11-16/README.md)). `mobile/songMarks.ts` and `mobile/AndroidStart.tsx` still call the scanning `savedEntryForIdentity` over their own entries. |
| P2 | The song row is expensive to mount. With a 300-song library, tasks still reach 160–205 ms at 6×; a plain row in the same shell stays at 35 ms. More overscan makes it worse (30 rows: 424 ms task). | Measured | Open |
| P3 | Surfaces with no virtualization: `AlbumGrid`, `ArtistGrid`, the player's album browser ([NowPlayingBrowser.tsx:919](../../../ui_web/src/components/NowPlayingBrowser.tsx#L919)) and local search (`:1040`), artist and album track lists ([Artist.tsx:397](../../../ui_web/src/routes/Artist.tsx#L397), [Album.tsx:410](../../../ui_web/src/routes/Album.tsx#L410)), podcast subscriptions, DJ route entries. | Measured: player album browser 12,214 DOM elements; album grid 1.28 s and artist page 1.38 s of paint at 6×. | Open |
| P4 | Player queue and player browser spend most of their time in ordinary layout (1,073 ms at 6× for the queue). Per-row and list containment, layer promotion, removing the query containers and disabling optional measurement each failed to remove it. | Measured; mechanism not isolated | Open: needs a row/scrollport prototype |
| P5 | ~~Desktop playback drops 8–27 frames per burst on every route surface.~~ The frames reported as dropped come after a short list has reached its end: the `OmniBar` progress fill (`transition: transform 0.25s steps(2, end)`) changes pixels twice per position update while Chromium expects a frame each vsync for a running animation. | Measured in step 3: 0 dropped frames while the list moves, playing or paused; ablation and at-rest runs in [the baseline](../measurements/web-ui-rendering-2026-11-16/README.md). Cost at rest while playing: 85 ms main thread and 43 ms compositor per 3.6 s (30 and 15 paused). | **Closed: measurement artifact, not a defect.** No application change. |
| P6 | Without a GPU (SwiftShader) most surfaces spend 2.7–3.2 s of a 3.2 s burst in buffer swap/fence waits. Stripping all effects did not fix it; replacing the whole shell with a bare scene cut it to 375 ms. The cost is the scene, not the list or one blur. | Measured | Open |
| P7 | Frame counts alone hide late content: at 12,000 px/s on the real GPU the player browser presented 183/183 frames but 162 were partial. | Measured | **Closed (step 2).** `ui_web/perf/bench.mjs` reports complete, partial and dropped frames separately and its headline column is complete frames. |
| A1 | Five separate virtualizer integrations ([VirtualRows](../../../ui_web/src/components/VirtualRows.tsx), [VirtualBrowseRows](../../../ui_web/src/components/VirtualBrowseRows.tsx), [TrackList](../../../ui_web/src/components/TrackList.tsx), [LibrarySearchResults](../../../ui_web/src/components/LibrarySearchResults.tsx), [ProgramQueue](../../../ui_web/src/components/ProgramQueue.tsx)) with different sizing, measurement, overscan, identity and focus rules. `LibrarySearchResults` and the player browser put content above the list without passing `scrollMargin`; overscan currently hides the mismatch. | Read | Open |
| A2 | After the full player opens once it stays mounted, and every mobile panel stays mounted while inert; their whole-library sorting and projections keep recomputing while hidden. | Read | Open |
| A3 | Each accepted collection replaces the whole artwork-metadata dictionary signal ([media.ts:38](../../../ui_web/src/lib/media.ts#L38)), so every `coverUrl` reader becomes eligible to recompute. | Read | Open |
| A4 | "The catalog projection goes stale after a collection change." | **Refuted.** The reviewer's probe stubbed a snapshot without `library_revision`. The real snapshot carries it ([shared/collection.py:551](../../../shared/collection.py#L551)) and the server keys its catalog on the same revision ([catalog.py:1890](../../../shared/api/routes/catalog.py#L1890)). The catalog (artists, genres, years) derives from files, which bump that revision. | Closed: not a defect |
| U1 | Row menus: Enter opens the popover at x0,y0 with focus left behind it, because placement depends on the presence of a `MouseEvent` ([contextMenu.tsx:30](../../../ui_web/src/lib/contextMenu.tsx#L30)). A pointer-opened menu is clamped while its entrance transform scales it to 0.96, so at 1366×768 the final box ends 17.6 px below the viewport and "Delete from library" is clipped. An open menu survives browser Back. | Observed and measured | **Closed (step 1).** `openContextMenu` anchors a keyboard click to its control and moves focus to the first `menuitem`; arrows, Home/End, Tab and Escape work and focus returns to the opener. `placePopover` clamps from `offsetWidth`/`offsetHeight`, and the popover scrolls inside itself when taller than the window. The popover closes on `popstate`; action sheets close on `hashchange` (`closeOnNavigation` in `openOverlay`). Not done: Shift+F10 still opens the centred dialog (it calls `onMenu` without an event), and the sheet and the popover are still two engines — that merge belongs to step 8. |
| U2 | Density is incomplete. Main lists follow Compact/Normal/Large, but the player browser keeps 36 px artwork and a 40 px search field at all three sizes, player controls stay at 32–36 px, and YouTube result rows are fixed at 60 px. | Measured | Open |
| U3 | Rows inside the player hide the overflow button and rely on long-press, because `menuOnHold` is tied to `compact` ([SongRow.tsx:117](../../../ui_web/src/components/SongRow.tsx#L117)). | Read and observed | Open |
| U4 | Opening an owned album from Library highlights Search/Discover in navigation. This is deliberate ([primaryNavigation.tsx:110](../../../ui_web/src/components/primaryNavigation.tsx#L110): "Artist and album pages are Search's, wherever the link that opened them was"). The UX review argues it loses the user's place. | Read and observed | Decision needed: keep or follow origin |
| U5 | Contrast below the WCAG 4.5:1 normal-text minimum: dark tertiary text `#6a6a72` on `#0c0c0e` is 3.65:1; white on danger `#ff453a` is 3.41:1; some light-theme text uses `--accent` (2.49:1) instead of `--accent-ink`. | Measured | **Closed (step 1).** Dark `--ink-tertiary` is `#888890` (5.56:1 on `--bg-base`, 4.61:1 on `--bg-hover`). New `--ink-on-danger` replaces the hard-coded white on `--danger` fills (5.7:1 dark; the slate and forest themes had 1.8:1). Light theme `--danger` is `#c9271d` (5.1:1 as text on the base, 5.5:1 under white). The four `color: var(--accent)` text sites use `--accent-ink`. `Live.module.css` `.heroArt` keeps `--accent`: it colours a decorative glyph, not text. |
| U6 | Loading and failure states: phone skeleton rows order text → artwork → trailing slot while loaded rows order text → overflow → artwork; skeleton cards use different minimum widths and gaps from the real grid; a failed device fetch in `DeviceSheet` renders as "no other devices". | Read and observed | **Partly closed (step 1):** `DeviceSheet` and `DevicesPanel` share `createDeviceList`, which renders a failed read as `common.loadFailed` with a Retry button. Skeleton order and skeleton card metrics remain open for step 8. |
| U7 | No enforcement against recipe drift: 10 row recipes, 9 card families, the same grid formula declared in 7 files, 348 raw `<button>` sites against 33 uses of `Button`, no Stylelint/ESLint design rule, one `toHaveScreenshot()` assertion in the whole browser suite. | Measured and read | Open |
| U8 | The saved-albums/artists rails show scrollbars on classic-scrollbar platforms (Windows, including the Tauri app; Linux). `.rail` sets `overflow-x: auto` ([SavedEntities.module.css:26](../../../ui_web/src/components/SavedEntities.module.css#L26), repeated by [app.css:229](../../../ui_web/src/styles/app.css#L229)), which per spec turns `overflow-y` into `auto`. The `…` button and its `::before` touch target overhang the card by 10 px against 8 px (Compact) or 9 px (Normal) of padding, so the rail scrolls 1–2 px vertically. Reproduced in Chromium: `scrollHeight` 220 vs `clientHeight` 218, 10 px scrollbar. CI cannot see it because Playwright launches Chromium with `--hide-scrollbars`. Unlike the other rails, this one does not hide its horizontal scrollbar either. | Measured | **Closed (step 1).** `.rail` bottom padding is `max(var(--space-sm), 10px)`, so `scrollHeight` equals `clientHeight` at every interface size (asserted in `saved-entities.spec.ts`), and the rail hides its horizontal scrollbar like the other rails. |
| X1 | Non-passive `touchmove` listeners on surfaces that contain scrolling lists ([PlayerSurface.tsx:363](../../../ui_web/src/components/PlayerSurface.tsx#L363), [overlay.tsx:280](../../../ui_web/src/lib/overlay.tsx#L280)) make touch scrolling there wait for the main thread. | Read; not measured | Open: trace on touch |
| X2 | All four Playwright profiles run with `reducedMotion: 'reduce'` ([playwright.config.ts:37](../../../ui_web/playwright.config.ts#L37)), there is no Firefox profile, no rendering-performance gate, and Linux WebKit is not an iPhone. | Read | Open |
| X3 | Android declares `minSdkVersion = 24` ([variables.gradle:2](../../../android/variables.gradle#L2)) but requires WebView 120 ([capacitor.config.json:7](../../../ui_web/capacitor.config.json#L7)); Chromium 120 dropped Android 7. Without `server.errorPath`, Capacitor still loads the UI on an older WebView. | Read and sourced | Open |

## Target architecture

The reviews converge on the same layers. Names are proposals.

1. **Platform adapters (keep).** Browser audio and Media Session, Android
   native programme/offline services, Tauri shell. Presentation consumes
   typed capabilities and never imports web audio stores.
2. **Account-scoped domain state, indexed.** Keyed entities; per-key
   saved/favourite/download/playing state read through indexes, never by
   scanning arrays from a row; queue-occurrence identity kept separate from
   musical identity.
3. **Query/projection layer.** One owner for browse order, search
   normalization and catalog caches. Projections run only while their
   consumer is visible (mounted, visible, interactive and transport-active
   are four different states); audio scheduling never depends on visibility.
4. **One collection component** (`CollectionView`) with fixed-row,
   variable-row, grid and shelf variants. It owns the scrollport,
   virtualization, header origin (`scrollMargin`), overscan, identity, focus
   pinning, scroll restoration, skeleton, and empty, error and refresh states.
   Small lists can skip virtualization only with an explicit reason.
5. **Design system** in `src/design/`: tokens (primitive → semantic → recipe,
   per theme × interface size × main/panel context) → accessible primitives
   (`Button`, `IconButton`, `Artwork`, `Field`, `Menu`/`Sheet`/`Dialog`,
   `Tabs`) → music patterns (`MediaRow`, `MediaCard`, `Shelf`, `EntityHeader`)
   → page templates. A row receives already-derived state and does no lookup
   when it mounts. One artwork contract replaces the current split between
   `<img>` in `CoverImage` and CSS backgrounds in rows. CSS Modules stay as
   the implementation.
6. **Material and motion recipes.** A few named surfaces with an opaque
   legibility floor; effects approved per region with trace evidence, not
   removed wholesale.
7. **Enforcement.** Stylelint and JSX rules for raw values and raw controls
   outside primitives, starting from a checked-in baseline so legacy code
   does not block every PR. Reviewed screenshot baselines of real views. A
   production-bundle rendering suite that counts presented, partial and
   dropped frames separately and uses a CPU-throttled profile. Device runs on
   the X270, an iPhone PWA, Android WebView and WebView2 at release time.

## Migration order

Each step ships on its own and leaves the app working.

1. **Functional fixes that need no measurement:** U1 (menus), U5 (contrast),
   the `DeviceSheet` failure state from U6, U8 (rail scrollbars).
2. **Commit the rendering harness:** the production-bundle fixture and wheel
   bench from the performance review, so every later step is compared
   against the same baseline.
3. **P5 investigation:** trace a static surface paused vs playing on desktop;
   it affects every library view on fast hardware.
4. **P1:** route row state through the existing indexes; measure.
5. **P2 + A1:** extract `CollectionView` and a cheap `MediaRow` from the
   working paths; migrate Songs, Favourites, playlists and local search
   first.
6. **P3:** bound albums, artists, the player browser, artist/album track
   lists and podcasts with the same component.
7. **P4 + A2:** player queue/browser layout prototype and activity scopes.
8. **Design-system migration** (U2, U3, U6, U7) one pattern family at a time,
   with enforcement switched on as each family completes; U4 decided first.
9. **P6, X1–X3:** software-composition scene budget, touch listener
   ownership, test matrix, Android WebView floor.

Revisit the runtime (bundled Chromium on desktop, or a native list for one
surface) only if a bounded, cheap-row web implementation still misses frame
deadlines on target hardware with trace-identified costs removed. Compare it
against a feature-complete prototype, not a text-only demo.

## How to continue

Work goes one migration step per pull request, in the order above. A fresh
session should:

1. Read the status table. The first step with an `Open` item is the next one.
2. Branch from `origin/main` as `fix/web-ui-stepN-…` or `perf/web-ui-stepN-…`.
3. Follow `AGENTS.md` for the browser suite, before/after images
   (`docs/internal/measurements/web-ui-stepN-<date>/`), the impact label and
   the CI gate, then update the status table in the same pull request.

Every performance step is measured with the rendering bench
([ui_web/perf/README.md](../../../ui_web/perf/README.md)) against
[the 2026-11-16 baseline](../measurements/web-ui-rendering-2026-11-16/README.md):
run the affected surfaces before and after on an idle machine and put the
`--table` comparison in the pull request.

Two things that cost time in step 1:

- **Payload budget.** `ui_build` holds the authenticated initial payload to
  215,316 bytes gzip and `main` was 95 bytes under it. Step 1 moved the Live
  broadcast bridge, the Live client and WebRTC out of the initial payload
  (`lib/communityGate.ts`; the shell imports `CommunityBridge` only once Live
  is in use), which left it at 210,910. Measure before opening a pull request:
  build an exported copy (`git archive HEAD ui_web shared/version.py branding
  docs/internal/performance`), symlink `node_modules`, `npm run build` there
  and run `node scripts/check-payload.mjs`. Never build inside `ui_web/`.
- **Stale dev server.** Restart the Vite server on 4173 before a full browser
  run. After edits or a `git stash` under a running server, specs that import
  app modules by URL (`dj-refinement-audit.spec.ts`) get a second module
  instance and fail on every profile.

| Step | Pull request | State |
| --- | --- | --- |
| 1 Functional fixes (U1, U5, U6 `DeviceSheet`, U8) | #461 | Done |
| 2 Rendering harness | #462 | Done |
| 3 P5 investigation | #463 | Done: not a defect |
| 4 P1 | `perf/web-ui-step4-saved-index` | Done |
| 5 P2 + A1 | — | Next |
| 6 P3 | — | |
| 7 P4 + A2 | — | |
| 8 Design system (U2, U3, U6, U7; U4 decision) | — | |
| 9 P6, X1–X3 | — | |

## Evidence kept outside the repository

The raw corpus (Chrome traces, CPU profiles, harness scripts, fixture server,
362 screenshots, probes) stayed in the reviewers' working directories and is
not committed. The imported reports name those files; their numbers are
reproduced in the reports themselves.
