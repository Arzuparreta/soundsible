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
| P2 | The song row is expensive to mount. With a 300-song library, tasks still reach 160–205 ms at 6×; a plain row in the same shell stays at 35 ms. More overscan makes it worse (30 rows: 424 ms task). | Measured | **Updated (2026-11-20 ThinkPad X270 overhaul).** Building on step 5's `createSlots` reuse, the follow-up removes `CollectionGrid`'s scroll-frame `offsetHeight` loop, quantizes window ranges, switches dense rows to async `<img>` (`ArtworkSurface`) with fling-velocity budgeting (`ScrollActivityContext` / `createScrollDeferred`) and CSS containment, drops `#app` `blur(16px)`/`scale(0.96)`, caps `ArtworkBackdrop` blur canvas to `240px`, and dynamically loads `PlayerSurface`. Physical X270 (HD Graphics 520, `1920x1080`): Songs complete frames `186/286 → 198/209` (`65.0% → 94.7%`), dropped `8 → 0`, max task `50.6 → 33.9 ms`, GPU busy `3,304.5 → 2,069 ms`; Albums `48/149 → 148/227` (`32.2% → 65.2%`), max gap `127.2 → 34.4 ms`; `dj-idle` `202/202` (`0` partial/dropped) ([measurements](../measurements/web-ui-thinkpad-2026-11-20/README.md)). |
| P3 | Surfaces with no virtualization: `AlbumGrid`, `ArtistGrid`, the player's album browser ([NowPlayingBrowser.tsx:919](../../../ui_web/src/components/NowPlayingBrowser.tsx#L919)) and local search (`:1040`), artist and album track lists ([Artist.tsx:397](../../../ui_web/src/routes/Artist.tsx#L397), [Album.tsx:410](../../../ui_web/src/routes/Album.tsx#L410)), podcast subscriptions, DJ route entries. | Measured: player album browser 12,214 DOM elements; album grid 1.28 s and artist page 1.38 s of paint at 6×. | **Closed (step 6).** `CollectionGrid` ([CollectionGrid.tsx](../../../ui_web/src/components/CollectionGrid.tsx)) bounds `AlbumGrid`, `ArtistGrid` and the podcast subscriptions: one real CSS grid, spacers for the rows not rendered, cards reused and placed by grid line. `EntityTrackList` bounds artist and album track lists over 60 rows with `CollectionRows`, which now measures its own origin under a page header (`lib/scrollOrigin.ts`). The player's album tab was bounded with `VirtualRows` in step 6; step 7 migrates it to `CollectionRows` and bounds the player's local search too. Document size: albums 5,649 → 604 elements, artist page 1,794 → 529. Scroll numbers are a trade, not all better: albums improve (complete frames at 6× 50 → 77), the 200-card artist grid is worse at 6× (56 → 42) ([numbers](../measurements/web-ui-rendering-2026-11-16/README.md)). Left whole on purpose: DJ sources (`AutoReferences`), a list the user adds to by hand. |
| P4 | Player queue and player browser spend most of their time in ordinary layout (1,073 ms at 6× for the queue). Per-row and list containment, layer promotion, removing the query containers and disabling optional measurement each failed to remove it. | Measured in steps 2 and 7 | **Closed (step 7).** Reused rows and strict containment of the definite-size player panels stop descendant row changes from propagating intrinsic layout to neighbouring tiles. At 6× browser layout 992 → 553 ms and queue layout 617 → 228 ms; longest tasks 49.6 → 27.7 ms and 67.0 → 36.9 ms. Partial frames remain: this closes the identified layout defect, not target-device acceptance ([evidence](../measurements/web-ui-step7-2026-11-17/README.md)). |
| P5 | ~~Desktop playback drops 8–27 frames per burst on every route surface.~~ The frames reported as dropped come after a short list has reached its end: the `OmniBar` progress fill (`transition: transform 0.25s steps(2, end)`) changes pixels twice per position update while Chromium expects a frame each vsync for a running animation. | Measured in step 3: 0 dropped frames while the list moves, playing or paused; ablation and at-rest runs in [the baseline](../measurements/web-ui-rendering-2026-11-16/README.md). Cost at rest while playing: 85 ms main thread and 43 ms compositor per 3.6 s (30 and 15 paused). | **Closed: measurement artifact, not a defect.** No application change. |
| P6 | The original no-GPU scene spent 2.7–3.2 s per burst in swap/fence waits. The original ablations did not isolate one effect. | Measured, re-isolated on step 8 | **Closed (step 9).** Actual CPU composition (`SystemInfo`: `disabled_software`) isolates the current player wallpaper filter: disabling only it restores 199/200 complete frames; removing transform or grain does not. `ArtworkBackdrop` prerenders the same filter on image/theme/size changes and defers hidden work, with CSS fallback on unsupported engines. Three runs: CPU player 87/203 → 198/200 complete, display work 3,282 → 495 ms; SwiftShader GL emulation 197/222 → 199/200 ([evidence](../measurements/web-ui-step9-2026-11-17/README.md)). This fixes the identified scene bottleneck, not physical-device acceptance. |
| P7 | Frame counts alone hide late content: at 12,000 px/s on the real GPU the player browser presented 183/183 frames but 162 were partial. | Measured | **Closed (step 2).** `ui_web/perf/bench.mjs` reports complete, partial and dropped frames separately and its headline column is complete frames. |
| A1 | Five separate virtualizer integrations ([VirtualRows](../../../ui_web/src/components/VirtualRows.tsx), [VirtualBrowseRows](../../../ui_web/src/components/VirtualBrowseRows.tsx), [TrackList](../../../ui_web/src/components/TrackList.tsx), [LibrarySearchResults](../../../ui_web/src/components/LibrarySearchResults.tsx), [ProgramQueue](../../../ui_web/src/components/ProgramQueue.tsx)) with different sizing, measurement, overscan, identity and focus rules. `LibrarySearchResults` and the player browser put content above the list without passing `scrollMargin`; overscan currently hides the mismatch. | Read | **Closed (steps 5–9).** `TrackList` (Songs, Favourites, playlists) and `LibrarySearchResults` use `CollectionRows`; local search now passes the height of the saved albums and artists above its rows as `scrollMargin`. Step 7 also migrates the player browser and variable-height manual queue. Step 9 migrates `VirtualBrowseRows`, `ProgramQueue` and podcast episodes to the same collection, preserves occurrence keys and editing focus, captures menu targets and retires `VirtualRows`. Same-count reorder and reused-slot dispatch are regression-tested. |
| A2 | After the full player opens once it stays mounted, and every mobile panel stays mounted while inert; their whole-library sorting and projections keep recomputing while hidden. | Read and regression-tested | **Closed (step 7).** `createActivityMemo` retains the last projection and releases domain subscriptions while the workspace, phone panel or document is hidden. The browser sorts, search and identity index and the queue projections resume from current state on activation. DOM, editing and scroll survive; transport never uses presentation activity. Step 9 applies the same activity contract to DJ browser and route projections. |
| A3 | Each accepted collection replaces the whole artwork-metadata dictionary signal ([media.ts](../../../ui_web/src/lib/media.ts)), so every `coverUrl` reader becomes eligible to recompute. | Regression-tested | **Closed (step 7).** A per-key store reconciles only artwork fields; unchanged readers do not rerun for full snapshots or another track's delta. Account resets still remove keys and preview hints. |
| A4 | "The catalog projection goes stale after a collection change." | **Refuted.** The reviewer's probe stubbed a snapshot without `library_revision`. The real snapshot carries it ([shared/collection.py:551](../../../shared/collection.py#L551)) and the server keys its catalog on the same revision ([catalog.py:1890](../../../shared/api/routes/catalog.py#L1890)). The catalog (artists, genres, years) derives from files, which bump that revision. | Closed: not a defect |
| U1 | Row menus: Enter opens the popover at x0,y0 with focus left behind it, because placement depends on the presence of a `MouseEvent` ([contextMenu.tsx:30](../../../ui_web/src/lib/contextMenu.tsx#L30)). A pointer-opened menu is clamped while its entrance transform scales it to 0.96, so at 1366×768 the final box ends 17.6 px below the viewport and "Delete from library" is clipped. An open menu survives browser Back. | Observed and measured | **Closed (step 1).** `openContextMenu` anchors a keyboard click to its control and moves focus to the first `menuitem`; arrows, Home/End, Tab and Escape work and focus returns to the opener. `placePopover` clamps from `offsetWidth`/`offsetHeight`, and the popover scrolls inside itself when taller than the window. The popover closes on `popstate`; action sheets close on `hashchange` (`closeOnNavigation` in `openOverlay`). Step 8 completes Shift+F10 event propagation and unifies sheets/popovers in the overlay registry; Escape belongs to the top surface and focus returns without scrolling. |
| U2 | Density was incomplete. Main lists follow Compact/Normal/Large, but the player browser keeps 36 px artwork and a 40 px search field at all three sizes, player controls stay at 32–36 px, and YouTube result rows are fixed at 60 px. | Measured | **Closed (step 8).** Row/artwork/control tokens now govern the player browser, panel fields and search results; actual dimensions and theme/density screenshots run on all four profiles ([evidence](../measurements/web-ui-step8-2026-11-17/README.md)). |
| U3 | Rows inside the player hide the overflow button and rely on long-press, because `menuOnHold` is tied to `compact` ([SongRow.tsx:117](../../../ui_web/src/components/SongRow.tsx#L117)). | Read and observed | **Closed (step 8).** Both row recipes expose a visible overflow button; long-press and right-click remain available. |
| U4 | Opening an owned album from Library highlighted Search/Discover. Step 8 kept that behavior as a deliberate decision. | Read and observed | **Updated in #516.** Artist and album details are neutral pages (no tab highlighted; tab memory stays intact). The URL carries the music scope independently. See the [current navigation decision](../ui/DESIGN_SYSTEM.md#navigation-decision-u4). |
| U5 | Contrast below the WCAG 4.5:1 normal-text minimum: dark tertiary text `#6a6a72` on `#0c0c0e` is 3.65:1; white on danger `#ff453a` is 3.41:1; some light-theme text uses `--accent` (2.49:1) instead of `--accent-ink`. | Measured | **Closed (step 1).** Dark `--ink-tertiary` is `#888890` (5.56:1 on `--bg-base`, 4.61:1 on `--bg-hover`). New `--ink-on-danger` replaces the hard-coded white on `--danger` fills (5.7:1 dark; the slate and forest themes had 1.8:1). Light theme `--danger` is `#c9271d` (5.1:1 as text on the base, 5.5:1 under white). The four `color: var(--accent)` text sites use `--accent-ink`. `Live.module.css` `.heroArt` keeps `--accent`: it colours a decorative glyph, not text. Custom colors now derive ink and fill against the worst-case canvas composite, with targeted tests across seed extremes and the artwork tint. |
| U6 | Loading and failure states: phone skeleton rows order text → artwork → trailing slot while loaded rows order text → overflow → artwork; skeleton cards use different minimum widths and gaps from the real grid; a failed device fetch in `DeviceSheet` renders as "no other devices". | Read and observed | **Closed (steps 1 and 8).** `DeviceSheet` and `DevicesPanel` share `createDeviceList`, which renders a failed read as `common.loadFailed` with a Retry button. Step 8 closes skeleton order and card metrics: skeleton and loaded rows share text → menu → artwork order, and grids use the same browse recipe. |
| U7 | No enforcement against recipe drift: 10 row recipes, 9 card families, the same grid formula declared in 7 files, 348 raw `<button>` sites against 33 uses of `Button`, no Stylelint/ESLint design rule, one `toHaveScreenshot()` assertion in the whole browser suite. | Measured and read | **Closed (step 8).** Shared accessible primitives and row/artwork recipes live in `src/design`. A per-file JSX/CSS debt gate rejects new raw controls and style literals; reviewed browser screenshots cover themes and densities. Legacy recipes remain inventoried in the baseline for incremental migration. |
| U8 | The saved-albums/artists rails show scrollbars on classic-scrollbar platforms (Windows, including the Tauri app; Linux). `.rail` sets `overflow-x: auto` ([SavedEntities.module.css:26](../../../ui_web/src/components/SavedEntities.module.css#L26), repeated by [app.css:229](../../../ui_web/src/styles/app.css#L229)), which per spec turns `overflow-y` into `auto`. The `…` button and its `::before` touch target overhang the card by 10 px against 8 px (Compact) or 9 px (Normal) of padding, so the rail scrolls 1–2 px vertically. Reproduced in Chromium: `scrollHeight` 220 vs `clientHeight` 218, 10 px scrollbar. CI cannot see it because Playwright launches Chromium with `--hide-scrollbars`. Unlike the other rails, this one does not hide its horizontal scrollbar either. | Measured | **Closed (step 1).** `.rail` bottom padding is `max(var(--space-sm), 10px)`, so `scrollHeight` equals `clientHeight` at every interface size (asserted in `saved-entities.spec.ts`), and the rail hides its horizontal scrollbar like the other rails. |
| U9 | Routine route names occupied both navigation and the page header, while desktop and touch declared the same commands twice. Local collection filtering was missing on most collections and matched text three different ways (web Library, Android Library, saved entities). | Code reading of `ViewHeader`, `AppBar` and every route; matcher mismatch reproduced in Node (`bjork` vs `Björk`, `office` vs `Oﬃce`) | **Closed.** Routine pages have one heading. It follows the leading control in the touch top bar and appears in `PageIndicator` at the foot of the desktop view. Both title controls scroll to top. Entity pages keep their name beside their artwork in `EntityHero`. Desktop and touch render the same `AppBarAction` list through `PageCommands`. `CollectionSearch` and `librarySearch.ts` give every local collection one field and one matcher, keeping source order (Library stays ranked). Covered by `library-header-scroll`, `mini-player-legibility`, `entity-detail-layout` and `interface-scale` specs, and by `Favourites`, `PlaylistDetail` and `PodcastShow` unit tests for row identity, repeated playlist entries and loaded-episode filtering. |
| X1 | Non-passive `touchmove` listeners on surfaces that contain scrolling lists ([PlayerSurface.tsx:363](../../../ui_web/src/components/PlayerSurface.tsx#L363), [overlay.tsx:280](../../../ui_web/src/lib/overlay.tsx#L280)) make touch scrolling there wait for the main thread. | Trusted touch, listener inspection and traces (step 9) | **Closed (step 9).** Non-passive move handlers are leased only during eligible player/sheet/pull gestures, released on rejection/end/cancel/disposal. A normal-motion CPU-6× native-touch test verifies deep-list scroll, upward rejection and downward dismissal; traces confirm actual motion. Touch frame ratios are unchanged in the three-run sample, so no speedup is claimed ([evidence](../measurements/web-ui-step9-2026-11-17/README.md)). |
| X2 | The original matrix had four reduced-motion default profiles, no Firefox profile or rendering gate; Linux WebKit is not an iPhone. | Read and regression-tested | **Closed (step 9).** Firefox desktop runs shared UI contracts with normal motion; normal-motion player/navigation specs cover supported engines. CI scrolls a 6,000-track production fixture and gates DOM size, actual motion and presented frames, while uploading timing/traces rather than an absolute shared-runner FPS threshold. Physical device/144 Hz acceptance remains a separate limit. |
| X3 | Android advertised API 24 while requiring WebView 120, which cannot run on Android 7; an old WebView had no independent fallback. | Read, sourced and package-verified | **Closed (step 9).** API 26 aligns with WebView/target Chrome 120. Capacitor `server.errorPath` names standalone update HTML, verified before sync and inside the actual development APK; the manifest declares SDK 26. Six checker regressions cover floor/asset invariants. This is a major compatibility impact, not an Android release or physical old-device acceptance. |
| U10 | Shared search inputs still had independent toolbar geometry. Favourites put its count above the field, Playlists kept a width cap, and Library-mode Artist and Album filters reached the pane edge. Podcasts had two search fields. | Browser captures and code review of route headers, entity lists, and podcast search results. | **Closed.** `PageToolbar` owns field sizing, gutters, metadata order, and command spacing. Collection, Discover, settings, and podcast views use it. Podcast search shares directory requests and subscription results with Android. |
| U11 | Mobile collection filters had different entry points, and only Library revealed search on pull. | Collection routes, artist and album profiles, and podcast feed gesture handling. | **Closed.** `SearchReveal` shares the Library gesture, focus and collapse behavior across collection routes. The touch app bar exposes the search command and renders the field above the primary scrollport. Native Android lists reuse the gesture and field with an inline command. Settings and Discover keep their fields visible. Podcast shows give the first pull to search while keeping refresh available from the next pull and the show menu. A continuous pull can reveal search as it crosses the top of the list. Scrolling farther into the list dismisses an idle field. Focus and active queries keep the field visible. |
| Android Library and bookmarks | Saved items lacked a destination, empty Playlists lacked a create action, and Songs search omitted artist results. | 27 November packaged Android audit and follow-up regression tests. | **Closed.** Android and web share the bookmark grid, filter and status UI. Android opens catalogue-only bookmarks through its entity navigator, shows playlist creation from the landing page, and includes catalogued artists in Songs search. |
| Song removal | Deleting a downloaded saved song detached its file but left the saved row in Songs. | SQLite reproduction and browser regression in `collection-identity.spec.ts`. | **Closed.** Web and Android share the intent and confirmation copy for removing a song or removing its download. The [collection contract](COLLECTION_IDENTITY.md#removing-a-song-or-its-download) defines what stays in playlists. |

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
3. Follow `AGENTS.md` for the browser suite, before/after images in the
   pull request description, the impact label and the CI gate, then update the status table in the same pull request.

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
- **Rows are reused.** A `CollectionRows` slot outlives the item it shows, so
  a row must read its item through the accessors it is given, and state a row
  keeps for itself must be keyed on the item. A browser test that needs a row
  must not assume rows far below the window exist: overscan is 6 rows. A
  unit test that renders a bounded collection calls `mockScrollportLayout()`
  (`src/testLayout.ts`), because jsdom measures every element as 0×0.
- **Stale dev server.** Restart the Vite server on 4173 before a full browser
  run. After edits or a `git stash` under a running server, specs that import
  app modules by URL (`dj-refinement-audit.spec.ts`) get a second module
  instance and fail on every profile.

| Step | Pull request | State |
| --- | --- | --- |
| 1 Functional fixes (U1, U5, U6 `DeviceSheet`, U8) | #461 | Done |
| 2 Rendering harness | #462 | Done |
| 3 P5 investigation | #463 | Done: not a defect |
| 4 P1 | #464 | Done |
| 5 P2 + A1 | #465 | Done: P2 and A1 partly closed |
| 6 P3 | #466 | Done |
| 7 P4 + A2 (+ A3) | #467 | Done |
| 8 Design system (U2, U3, U6, U7; U4 decision) | #468 | Done |
| 9 P6, X1–X3 (+ remaining A1/DJ activity) | #469 | Done (baseline for this follow-up) |
| ThinkPad X270 follow-up (scroll, artwork, player/DJ compositing) | #480 | Complete locally; gated by CI checks and merge |
| Docked Now Playing | `feat/now-playing-docked` | Retires the player browser covered by P3, P4 and A2. The production rendering gate now exercises the player queue. The default full-screen split fits the cover to the workspace height, and dragging the divider saves a custom split. |

## Evidence kept outside the repository

The raw corpus (Chrome traces, CPU profiles, harness scripts, fixture server,
362 screenshots, probes) stayed in the reviewers' working directories and is
not committed. The imported reports name those files; their numbers are
reproduced in the reports themselves.

## Final delivery and remaining limits

Step 8 merged as #468 (`47734dd0`). Step 9 is complete and locally verified
on `perf/web-ui-step9-platform`, containing merged step-8 main. PR #469 must pass every latest-head check, including Android and Windows,
and a fresh target-base ancestry check before merge. Merging that change
completes the nine implementation steps. No release is part of this review.

Durable evidence, exact validation counts, before/after images and recordings
are in [step 9](../measurements/web-ui-step9-2026-11-17/README.md); Android
package/JVM evidence is also in its handoff. The final whole-suite passes are
Chromium 454/78 skipped and WebKit 438/94 skipped, plus Firefox 51/4 skipped.
The title/scale helper corrections passed another 46 cases per engine family.
Local JVM: 102; Vitest: 1,989; checker tests: six. The initial authenticated
payload is 211,685 gzip bytes under the unchanged 215,316-byte ceiling.

The implementation worktree is `/tmp/soundsible-web-ui-step9`. The dependency
symlink `ui_web/node_modules` is intentionally untracked: never commit it.
Owned test servers are stopped. Source/fixture changes must be revalidated;
do not overlap browser suites, builds and performance runs. Read live PR
state rather than assuming an open PR has reached main.

The nine migration steps are an implementation sequence, not proof of
Spotify/YouTube parity. Following the 2026-11-20 physical ThinkPad X270
follow-up ([measurements](../measurements/web-ui-thinkpad-2026-11-20/README.md)),
`songs` reaches `198/209` complete (`0` dropped, `33.9 ms` longest task),
`albums` jumps from `48/149` to `148/227`, and `dj-idle` holds `202/202` (`14.3 ms`
longest task) under hardware ANGLE compositing (`1920x1080`), with initial
authenticated `library` payload trimmed to `206,915` B gzip (`8,401` B under the
`215,316` B ceiling). Physical iPhone PWA, Android WebView, Windows WebView2, live-library,
144 Hz acceptance, and cold first-open chunk load vs cached repeat-open remain
explicitly bounded or unmeasured. Any next performance work continues from real
target-device traces rather than assuming a framework rewrite. The legacy
per-file design baseline remains an inventory for incremental migration, not a
claim that every control was rewritten.
