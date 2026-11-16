# Web UI architecture review — UX and design-system cohesion

> Imported from an independent review of `00fd7d0a` (2026-11-16). Only links were rewritten. Scripts, traces, screenshots and data files it names stayed in the reviewer's working directory and are not part of the repository. Read [the handoff](../WEB_UI_REVIEW_HANDOFF.md) first: it records which findings were verified, refuted or reclassified afterwards.

Review target: **00fd7d0ae3b0d48e610d8643d6e6614e5ece63ed**. Independent design review, 2026-11-16. No implementation changes.

## Summary verdict

1. **Judgment from read/observed/measured evidence:** keep Solid, CSS modules, semantic themes and the existing native-controller boundary.
2. The foundation is suitable as a rendering stack, but incomplete as a design-system architecture.
3. Shared tokens coexist with separately owned row, card, control, menu and loading recipes; fixes do not reliably propagate.
4. The most consequential gap is the missing shared collection/presentation contract: geometry, actions, state, scrolling and resource policy are chosen in many places.
5. Several inconsistencies are functional: keyboard menus keep focus behind them, menu bounds overflow, and Back can leave a stale menu open.
6. Accessibility size recipes work for the main rows but are bypassed by player chrome, compact artwork and some result controls.
7. Target a small, owned system: semantic tokens → accessible primitives → media/collection patterns → page templates → web/native command adapters.
8. Keep deliberate mobile/desktop composition differences; make the anatomy, state meanings and action rules consistent within those variants.
9. Migrate actual views through those patterns, including the player and Android presentation; another showcase-only reskin would leave the same failure mode.
10. This review establishes cohesion and interaction faults. It does **not** establish the cause of the reported freezes or a measured speedup from a framework change.

## Scope, evidence and reproducibility

**Read.** The checkout remained at the requested revision. Comparing `00fd7d0a` with the supplied later commit `77811eab` produced no `ui_web/` diff. AGENTS, the architecture/resource handoffs, the Android/DJ handoffs where relevant, DESIGN, VIEW_REDESIGN, MOBILE_LISTS and UI_REBUILD_PLAN were read as context. Earlier positive design verdicts were not treated as acceptance evidence. DESIGN explicitly began as a consumer-shell specification; its later player sizing decisions do not specify every web pattern ([DESIGN.md:10](../../../../DESIGN.md#L10), [DESIGN.md:258](../../../../DESIGN.md#L258)).

**Measured / observed.** All 18 baseline destinations were captured at **1920×1080, 1366×768 and 390×844**, in dark/light and Normal size: Library home, Songs, Albums, Artists, Favourites, playlists, playlist detail, album, artist, Discover, search results, podcasts, podcast show, Settings index, Appearance, Downloads, Live and Preview. Additional captures cover Compact/Normal/Large at390/1366, restored/playing/lyrics/queue/browser/buffering/failed/empty player presentation, menus, drawer, prompt, confirmation, playlist picker, loading/error/empty states, populated Live and YouTube results. See `SCREENSHOTS.md` for the full matrix, `gallery.html` for images, and `manifest.ndjson` for URL, viewport, theme, size, headings and state provenance.

**Method.** Chromium screenshots allow classic scrollbars with `ignoreDefaultArgs: ['--hide-scrollbars']`. Fresh document loads prevent persistent overlays or saved route state from contaminating later captures. Fixtures use the repository’s showcase catalogue and local artwork; invented playlists, download jobs, podcast episodes and Live rooms are review data. Requests in the main capture scripts are restricted to the local fixture origin. Vite ran on4184 with engine proxy `http://127.0.0.1:9`, external cache/config; fixture proxy on4186. The owner’s engine on5005 was not queried or controlled. No build/full test suite was run; sessions were short and sequential.

**Measured cleanup.** The two owned server PIDs were verified and stopped; ports4184/4186 have no listeners. Capture browsers completed with `browser.close`; the active performance-review browser was identified and left untouched. Final HEAD is the requested revision, with an empty `git status --porcelain` and no diff. `cleanup.json` records the checks.

**Observed / limits.** A focused WebKit subset was captured at390px light and1366px dark using the already-installed Playwright1.64 container with a read-only repository mount. Native host WebKit failed on missing system libraries; no packages were installed. These are Linux WebKit images, not iPhone/PWA, Android or Windows WebView2 acceptance. Buffering, failed, empty and DJ captures seed presentation state directly; they do not reproduce network/transport/planner failures or establish DJ correctness. Playing screenshots use fixture silence, not audible-output verification. Still images disable animations and are not frame-performance measurements.

**Evidence classes used below.** **Observed** = inspected PNG path; **read** = source file:line; **measured** = extraction/DOM/style/contrast output; **sourced** = public URL. Recommendations are proposals derived from the indicated evidence, not observations of a future implementation. No human rating scale is used.

**Continuation correction.** The inherited PNG filenames could not be trusted: contact sheets repeatedly showed Preview under unrelated view names. All108 inherited captures were moved to `rejected-preview-captures/` and excluded. The original lexical audit was reproducible; its JSX counts were reclassified as call sites. The old38 Button count included five Preview examples; production has33. Fixture defects were corrected before accepting new captures: saved entities need `name`/`destination`, favourites are supplied through saved entries, not the obsolete favourites response alone. Artificial fixture failures and script-locator errors remain in logs and are not reported as product defects.

## Findings, ranked by impact on the stated problem

### 1. The system shares values but does not own recurring presentation and collection behavior

**Read / measured.** The inventory identifies **ten media/status row recipes**, **nine browse/answer card families**, three shelf interaction implementations and two menu presentation engines. Most phone media rows now delegate to MusicListRow; desktop retains SongRow, CatalogResultRow, SearchResultRow, player navigation/queue and episode/result recipes. See `PATTERN_INVENTORY.md`, `ALL_CSS_RECIPES.md`, [components/SongRow.tsx:116](../../../../ui_web/src/components/SongRow.tsx#L116), [components/CatalogResultRow.tsx:48](../../../../ui_web/src/components/CatalogResultRow.tsx#L48), [components/SearchResultRow.tsx:49](../../../../ui_web/src/components/SearchResultRow.tsx#L49), [components/PlayerTrackList.tsx:628](../../../../ui_web/src/components/PlayerTrackList.tsx#L628).

**Read.** Collection rendering policy also varies. TrackList uses a virtualizer and density-derived row slots ([components/TrackList.tsx:90](../../../../ui_web/src/components/TrackList.tsx#L90)); album library and catalogue lists use direct For loops ([routes/Album.tsx:410](../../../../ui_web/src/routes/Album.tsx#L410), [routes/Album.tsx:433](../../../../ui_web/src/routes/Album.tsx#L433)); player album sections also use direct loops ([components/NowPlayingBrowser.tsx:919](../../../../ui_web/src/components/NowPlayingBrowser.tsx#L919)), while other player sections use VirtualRows. There is no common collection API that determines when a list is bounded, how row estimates match CSS, where the one scrollport is, or what skeleton fits the final layout.

**Observed.** Compare main Songs (`1366-dark-normal-library-songs.png`, not imported), album (`1366-dark-normal-album.png`, not imported), YouTube results (`1366-dark-normal-chromium-youtube-search.png`, not imported) and player (`1366-light-normal-player-paused.png`, not imported). These are related media tasks but expose different row controls, image metrics and secondary text hierarchy.

**Consequence / recommendation.** A spacing, focus, image or scrolling fix must be carried into several implementations. Consolidate *presentation anatomy and collection policy*, with explicit semantic variants and host command adapters. Preserve identity/queue/offline behavior. This is directly relevant to both recurring inconsistency and the inability to apply one rendering budget everywhere. **No frame-time saving was measured here; direct For rendering of a short bounded album is not itself proof of a freeze.**

### 2. Menus have different keyboard, placement and Back contracts; several fail visibly

**Observed / measured.** At1366×768, pressing Enter on the first Songs overflow button opens its menu at **x0,y0**, leaves focus on the trigger, ignores ArrowDown, and Tab moves to the next background song. The popover contains zero `menuitem` roles. Enter menu (`1366-dark-normal-chromium-menu-enter.png`, not imported), `interaction-verification.ndjson`. Shift+F10 instead opens a centered dialog with focus inside it: keyboard menu (`1366-dark-normal-keyboard-menu.png`, not imported).

**Observed / measured.** Pointer activation of the same menu gives **x1142.953,y144.625,width224,height641**; its bottom is **785.625px**,17.625px below the viewport. The final44px “Delete from library” action extends to782.625px. There is no popover scrollport. Clipped menu (`1366-dark-normal-row-menu.png`, not imported).

**Read / measured.** [lib/contextMenu.tsx:30](../../../../ui_web/src/lib/contextMenu.tsx#L30) selects placement from the presence of a MouseEvent, not an anchor or invocation intent. Keyboard-generated click coordinates are0,0. Its onMount clamp (`:49`) measures during the `.96` entrance transform ([lib/contextMenu.module.css:23](../../../../ui_web/src/lib/contextMenu.module.css#L23)). The initial215.04px width/615.36px height produces the recorded clamp position; the final224×641px box then overflows. ActionMenuList renders ordinary buttons ([components/ActionMenu.tsx:40](../../../../ui_web/src/components/ActionMenu.tsx#L40)); the cursor wrapper assigns `role="menu"` but supplies no matching keyboard model.

**Observed / read.** Browser Back from Favourites to Songs leaves the prior action menu open: desktop (`1366-dark-normal-chromium-back-with-menu.png`, not imported), phone (`390-dark-normal-chromium-back-with-menu.png`, not imported). Action menus default `history=false` ([components/ActionMenu.tsx:95](../../../../ui_web/src/components/ActionMenu.tsx#L95)), whereas the navigation drawer explicitly pushes history and makes the app inert ([components/NavigationMenu.tsx:63](../../../../ui_web/src/components/NavigationMenu.tsx#L63), `:84`). ContextMenuOutlet closes on scroll/resize/Escape, not route changes ([lib/contextMenu.tsx:59](../../../../ui_web/src/lib/contextMenu.tsx#L59)).

**Consequence / recommendation.** The same action target moves, focus can continue behind it, a destructive action is clipped, and the surface can outlive its route. Replace the presentation engines behind one ActionMenu API with explicit anchor/invocation, bounds/scroll constraints, route ownership, focus entry/return and Back behavior. Keep one action definition. A menu or a dialog may be appropriate; its semantics must match its interaction. This recommendation is supported by [APG menu guidance](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/), not an aesthetic preference.

### 3. Density is a working foundation, but panel and control exceptions break its promise

**Measured.** Main Songs responds coherently: phone row56/64/72px and artwork44/50/60px; desktop row44/52/60px and artwork36/44/52px for Compact/Normal/Large. Yet the desktop player browser fixes its compact artwork at **36px in all three**, and its search field stays **40px in all three**; main desktop Discover search measures34/42/46px. Entity headings at1366 remain40px for every size. `density-measurements.ndjson`.

**Read / measured.** Player-browser buttons are36px, inner view pills32px, queue trailing controls34px with17px glyphs; shared phone row controls use44/48/56px and main desktop overflow36/44/48px. YouTube result rows declare60px/44px at every desktop density. Sources: [SongRow.module.css:226](../../../../ui_web/src/components/SongRow.module.css#L226), [NowPlayingBrowser.module.css:25](../../../../ui_web/src/components/NowPlayingBrowser.module.css#L25), `:58`, `:232`, [PlayerTrackList.module.css:354](../../../../ui_web/src/components/PlayerTrackList.module.css#L354), [SearchResultRow.module.css:1](../../../../ui_web/src/components/SearchResultRow.module.css#L1), [EntityHero.module.css:104](../../../../ui_web/src/components/EntityHero.module.css#L104).

**Observed / measured.** At390px Normal, main song text starts12px from the viewport; entity rows start18px; player-browser row text starts21px (outer inset plus its own12px). AtLarge the analogous offsets are12/20/22px. Normal Songs (`390-dark-normal-density-songs.png`, not imported), Normal album (`390-dark-normal-density-album.png`, not imported), Large player browser (`390-dark-large-density-player-browser.png`, not imported).

**Consequence / recommendation.** Larger text can sit beside controls that remain small; music changes its column alignment when the user enters a collection/player. Introduce named media-row/panel-control roles and make density resolve all of them in one place. A deliberately compact desktop panel may have different metrics, but those metrics need a complete three-size recipe and a documented content tradeoff. Do not use `compact` as a flag that simultaneously shrinks artwork, suppresses marks and removes visible menus.

### 4. Media cards and shelves look related but behave as separate systems

**Read.** The same grid formula is independently declared in seven owners; podcast and skeleton grids add variants. Main album/artist/playlist/saved cards use label-size names; Discover/search entity cards use body-size names. AtNormal this is15px versus17px on phone,14px versus16px desktop. Podcast covers rise3px on hover; album covers change border/shadow; search/discovery titles gain underlines. Card corners are mostly already unified at14px; round artist artwork is an intentional entity distinction, not an inconsistency. [AlbumGrid.module.css:37](../../../../ui_web/src/components/AlbumGrid.module.css#L37), [SearchDiscovery.module.css:34](../../../../ui_web/src/components/SearchDiscovery.module.css#L34), [Search.module.css:413](../../../../ui_web/src/routes/Search.module.css#L413), [Podcasts.module.css:99](../../../../ui_web/src/routes/Podcasts.module.css#L99).

**Observed / read.** Playlist overflow lives on artwork, is hover-revealed desktop and always available touch; saved-album overflow lives below artwork; main album grid has no persistent overflow button but supports context/hold. playlists (`390-dark-normal-playlists.png`, not imported), Library saved rail (`390-dark-normal-library-home.png`, not imported), album grid (`390-dark-normal-library-albums.png`, not imported). Each choice occupies different title/art space.

**Read.** “See all” navigates for saved/discovery shelves but expands in place for artist shelves. Discovery has pointer arrows and hides its scrollbar; saved rail shows a scrollbar; artist rail hides it without arrows. Sources: [SavedEntities.tsx:35](../../../../ui_web/src/components/SavedEntities.tsx#L35), [SearchDiscoveryView.tsx:89](../../../../ui_web/src/components/SearchDiscoveryView.tsx#L89), [ArtistDiscoveryView.tsx:29](../../../../ui_web/src/components/ArtistDiscoveryView.tsx#L29), [SavedEntities.module.css:26](../../../../ui_web/src/components/SavedEntities.module.css#L26), [Artist.module.css:68](../../../../ui_web/src/routes/Artist.module.css#L68).

**Consequence / recommendation.** Similar cards teach different action locations; identical labels can change navigation depth or only local layout. Build one MediaCard anatomy and Shelf/Grid container, with explicit person/record/playlist/top-answer variants. Give See all one default route/focus/return contract; use a differently named expand control for an intentional in-place expansion. This also centralizes card image and focus behavior.

### 5. The information architecture loses provenance and changes action discoverability inside the player

**Observed / read.** Opening an owned album from Library selects **Discover** in primary navigation: owned album from Library (`390-dark-normal-chromium-owned-album-from-library.png`, not imported). [primaryNavigation.tsx:110](../../../../ui_web/src/components/primaryNavigation.tsx#L110) assigns every album/artist route to Search regardless of origin or `view=library`; [tabMemory.ts:8](../../../../ui_web/src/lib/tabMemory.ts#L8) then remembers that entity in Search’s stack. Actual browser Back may return correctly, while the highlighted destination and remembered tab territory tell a different story.

**Observed / read.** Main phone Songs shows overflow per row; player browser songs remove it and rely on a hold, including rows carrying the same Play command: Songs (`390-dark-normal-density-songs.png`, not imported), player browser (`390-dark-normal-player-browser.png`, not imported). [SongRow.tsx:118](../../../../ui_web/src/components/SongRow.tsx#L118) ties `menuOnHold` to compact. Row geometry, collection marks and menu discoverability are bundled into the same option. The player also has its own Library/Favourites/Playlists/Saved/Explore stacks ([musicBrowserNavigation.ts:21](../../../../ui_web/src/lib/musicBrowserNavigation.ts#L21)) alongside the main navigation.

**Read.** Main Library is a home page of six shortcuts plus saved-entity shelves; three Library views exist below it; bottom navigation is configurable and defaults to Library/Favourites/Discover/Settings ([primaryNavigation.tsx:95](../../../../ui_web/src/components/primaryNavigation.tsx#L95)). The drawer supplies additional destinations. Entity content selection is a native select; the player browser uses pills for analogous Songs/Albums/Artists and underlined destination buttons. These controls represent different levels, but their hierarchy has no single documented model.

**Consequence / recommendation.** Preserve the originating collection/primary destination for entity visits, with explicit deep-link fallback. Separate “browse music” from “pick a song/reference for this playback task”; reuse presentation and query/scroll contracts without requiring a second independently designed application inside the player. Keep visible overflow wherever the same ordinary song actions exist, or provide a discoverable edit/action mode. Hold may be an accelerator, not the only visible explanation.

**Sourced.** Competitor documentation supports a clear browse/library/queue distinction and explicit queue access, but their save semantics differ. See [Spotify Library](https://support.spotify.com/us/article/your-library/), [YouTube Music Library](https://support.google.com/youtubemusic/answer/6313542?hl=en) and [Apple queue](https://support.apple.com/en-ca/guide/iphone/ipha4521ef7d/27/ios/27). This does not justify copying their branding or removing DJ workflows.

### 6. Shared Solid components do not currently guarantee shared web/Android composition

**Read.** Android’s entry renders AndroidStart, with ProgramTransport and ProgramQueue plus a wrapping top-level button navigation ([mobile/main.tsx:21](../../../../ui_web/src/mobile/main.tsx#L21), [mobile/AndroidStart.tsx:496](../../../../ui_web/src/mobile/AndroidStart.tsx#L496), `:515`). Web renders HashRouter/Shell, OmniBar, PlayerSurface and routed Settings ([AuthenticatedPlayer.tsx:47](../../../../ui_web/src/AuthenticatedPlayer.tsx#L47), [app.tsx:27](../../../../ui_web/src/app.tsx#L27)). ProgramTransport uses labelled transport buttons/native repeat select and ProgramQueue has a240px scroll area ([ProgramTransport.tsx:12](../../../../ui_web/src/components/ProgramTransport.tsx#L12), [ProgramQueue.module.css:5](../../../../ui_web/src/components/ProgramQueue.module.css#L5)); these are structurally different from the web’s artwork player/carousel and queue panels.

**Read.** The Android handoff explicitly calls for shared pure presentation with native controllers; it correctly prevents importing web audio stores. LibraryBrowser/VirtualBrowseRows and EntityProfile already demonstrate that separation. Source-level parity is therefore not achieved merely because both clients use Solid or tokens.

**Consequence / recommendation.** Share templates/presentation contracts across web and native adapters, while keeping native playback, offline permissions, device behavior and audio lifecycle native. Give justified platform differences an explicit variant rather than a separately styled fallback interface. **Android and WebView2 were not launched in this review; this is source evidence of composition divergence, not a claim about native runtime defects or release parity.**

### 7. Loading, empty and failure states are reusable in places but not governed as a complete state model

**Read / observed.** SkeletonRows phone composition is **text → artwork → trailing placeholder** ([Skeleton.module.css:166](../../../../ui_web/src/components/Skeleton.module.css#L166)); loaded MusicListRow is **text → overflow → artwork** ([MusicListRowView.tsx:128](../../../../ui_web/src/components/MusicListRowView.tsx#L128)). Compare loading album (`390-dark-normal-loading-album.png`, not imported) with loaded album (`390-dark-normal-album.png`, not imported). SkeletonCards uses132px/148px minima and space-md gaps versus the browse grid’s144px/160px minima and larger gaps ([Skeleton.module.css:90](../../../../ui_web/src/components/Skeleton.module.css#L90), `:152`). The placeholder component is shared, but final anatomy is not its input.

**Read / observed.** EmptyState is used50 times and provides useful tone/compact behavior, but Live has its own dashed empty well, discovery a plain notice, player browser another centered empty region, and download success/failure their own cards. empty Downloads (`390-dark-normal-empty-downloads.png`, not imported), Live (`390-dark-normal-live.png`, not imported), album error (`390-dark-normal-error-album.png`, not imported). Different status shapes are sometimes appropriate; they currently have no agreed rule for recovery action, stale data, loading placement or text hierarchy.

**Read.** A more serious state ambiguity exists in [DeviceSheet.tsx:41](../../../../ui_web/src/components/DeviceSheet.tsx#L41): failed device fetch leaves the same empty list used for “no other devices”; SettingsLoad, by contrast, models an initial failure with retry ([SettingsLoad.tsx:17](../../../../ui_web/src/components/SettingsLoad.tsx#L17)).

**Consequence / recommendation.** Make loading/refresh/empty/filter-empty/offline/failed/stale explicit input states for collection and picker patterns. Generate skeletons from the same slots and geometry; keep old content during a refresh when valid, and never treat failed reads as confirmed emptiness. Verify state transitions, not only final screenshots.

### 8. Colour reuse is relatively strong, but text roles still permit insufficient contrast

**Measured / read.** Dark tertiary `#6a6a72` on base `#0c0c0e` calculates **3.6456:1**; it is used for small counts/durations/metadata ([tokens.css:23](../../../../ui_web/src/styles/tokens.css#L23), [AlbumGrid.module.css:61](../../../../ui_web/src/components/AlbumGrid.module.css#L61), [SongRow.module.css:192](../../../../ui_web/src/components/SongRow.module.css#L192)). White on danger `#ff453a` calculates **3.4067:1**; confirm/prompt destructive buttons explicitly use white ([confirm.module.css:64](../../../../ui_web/src/lib/confirm.module.css#L64), [prompt.module.css:85](../../../../ui_web/src/lib/prompt.module.css#L85)). These are source-pair calculations, not estimates from anti-aliased glyph pixels. `contrast-calculations.json`, confirmation (`1366-dark-normal-chromium-delete-confirm.png`, not imported).

**Read / measured.** The light palette already distinguishes brand fill from readable accent ink: `--accent-ink:#9c4a08` ([tokens.css:306](../../../../ui_web/src/styles/tokens.css#L306)). Some bypasses still use `--accent` for text, including SongRow primaryAction and player-browser cancellation ([SongRow.module.css:229](../../../../ui_web/src/components/SongRow.module.css#L229), [NowPlayingBrowser.module.css:422](../../../../ui_web/src/components/NowPlayingBrowser.module.css#L422)); brand orange on light base calculates2.4863:1. This is a source-level risk in those states, not an assertion that every visible orange element fails.

**Consequence / recommendation.** Define semantic text/subtle-text/status-text/on-danger roles with tested surface pairs. Reuse accent ink for text; reserve brand accent for fills/decorative contexts. Do not globally brighten every muted border or icon. [WCAG’s normal-text minimum is4.5:1](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html); large-text and inactive/decorative exceptions must be evaluated per use.

### 9. Surface and motion policies are fragmented; raw-value cleanup alone will not solve graphical performance

**Read.** Page surfaces, glass dock, stage material, dialog scrim and inline overlays use different material recipes. Some differences are intentional. The full player has two crossfade backgrounds, a wash/grain, blur62–64px artwork and a38s stepped drift even while opened and paused ([PlayerSurface.module.css:101](../../../../ui_web/src/components/PlayerSurface.module.css#L101), `:133`, [tokens.css:487](../../../../ui_web/src/styles/tokens.css#L487)). The dock uses glass blur22/24px; modal scrim blur8px; other layers use12px. Global reduced motion and hidden-page decorative pause already exist ([tokens.css:829](../../../../ui_web/src/styles/tokens.css#L829), [app.css:41](../../../../ui_web/src/styles/app.css#L41)).

**Measured.** Outside tokens there are56 duration occurrences and25 distinct duration strings including0s, beyond the100/200/300ms scale. Several correspond to gestures, progress or status loops and should remain distinguishable. Source location/value details: `RAW_VALUES_BY_FILE.md`.

**Consequence / recommendation.** Establish a shared material and motion policy with bounded effect regions and explicit static/reduced-motion behavior; use semantic motion roles for surface entry, exit, gesture settle, progress and decorative activity. Measure scroll/idle-frame costs before changing effects. The user’s faster, visually richer competitors refute “visual complexity alone explains it”; this audit supplies no trace proving that any particular blur causes the freezes. Static backgrounds or isolated effects are candidate experiments, not a substitute for fixing collection architecture.

### 10. The current safeguards verify many behaviors, but do not systematically prevent recipe drift

**Read / measured.** The central Button has only three styles/two sizes and33 production usages;348 raw button sites appear across90 files. This is not evidence that every native button should be replaced with Button: switches, row activators and menu items need their own semantics. There is no declared Stylelint/ESLint design-token or primitive-usage gate in `ui_web/package.json`. A search of the browser suite found one `toHaveScreenshot()` assertion (`tests/browser/interface-scale.spec.ts:424`), alongside numerous saved screenshots, geometry and behavioral tests. The latter are valuable but do not automatically compare a changed card to an approved baseline.

**Read.** Preview demonstrates tokens/components and realistic mobile row cases, but most main-route compositions, overlays, panel controls and native variants are not authored from a single pattern catalogue ([pages/DesignPreview.tsx:1](../../../../ui_web/src/pages/DesignPreview.tsx#L1)). The stale UI_REBUILD_PLAN still describes early milestones and a historical Linux/Tauri premise; the supplied product context correctly has no Linux desktop app. It should not be the current source of design-system acceptance criteria.

**Consequence / recommendation.** Enforce new work at pattern boundaries: property-aware token rules, raw interactive-element rules outside owned primitives, approved exception comments, stable fixture stories and reviewed visual baselines of real views. A token census or a polished preview cannot enforce a composed page. Preserve the existing behavioral/geometry suites and add targeted cross-pattern assertions rather than screenshot-testing every combination indiscriminately.

## Token discipline: complete counts and interpretation

**Measured.** The reproducible lexical audit covers **84 CSS files outside tokens.css**: **1,419 px literals +51 colour literals +56 durations =1,526 lexical occurrences**. There are also19 raw font-size declarations and38 raw z-index declarations, which overlap the unit counts and are not added to1,526. `CSS_AUDIT.md` has counts for every file; `RAW_VALUES_BY_FILE.md` lists values/frequencies per file; `raw-css-values.json` supplies occurrence lines; `source-inventory.json` supplies parsed declarations including font/rem/em/calculated cases.

| Largest files | px | colours | durations | Lexical total |
|---|---:|---:|---:|---:|
| NowPlaying.module.css |129|0|4|133|
| PlayerTrackList.module.css |106|2|3|111|
| OmniBar.module.css |99|4|2|105|
| PlayerSurface.module.css |60|0|14|74|
| NowPlayingBrowser.module.css |56|4|1|61|
| boot/startup.css |29|17|2|48|
| routes/Migrate.module.css |42|0|0|42|
| AutoMode.module.css |31|1|6|38|
| routes/Library.module.css |36|0|2|38|
| MusicListRow.module.css |34|1|0|35|

**Interpretation.** These are exposure counts, **not1,526 defects**. The extractor includes borders, breakpoints, token fallback arguments, local custom properties, SVG/noise payloads and calc operands; it strips comments and does not count named colours such as `white`. Useful raw values include1px hairlines, viewport breakpoints and local stacking offsets. Most colour decisions already flow through tokens; the main weakness is semantic component geometry, interaction and typography. Prioritize uncontrolled control heights, text colours, role typography, state opacity and surface timings; do not turn every1px border into a global token or expose every local geometry value to consumers.

## What the public comparisons support

**Sourced.** Spotify’s design-system lead describes a period where mobile and web shared foundational tokens but still diverged in button size, padding, typography and states. The response was to define anatomy, terminology, state and property contracts jointly, including intentional platform differences. Its public before/after illustrations make the mechanism concrete: a palette does not standardize a control. This is the closest documented analogue to the current findings ([first-person account and illustrations](https://www.figma.com/blog/creating-coherence-how-spotifys-design-system-goes-beyond-platforms/)).

**Sourced / recommendation.** Spotify Engineering describes local systems over a shared foundation and a facade that reduces consumer integration choices ([engineering account](https://engineering.atspotify.com/2024/02/applying-the-facade-pattern-on-spotify-for-artists)). For this smaller codebase, that argues for a stable MediaRow/Menu/Collection API with web/native adapters, not reproducing Spotify’s organizational hierarchy or adopting its framework stack.

**Sourced.** Spotify explicitly separates saved albums/artists from saving their songs; YouTube Music says album songs appear under Songs when the album is saved. Both document content filters and a Library destination. Apple documents MiniPlayer → Now Playing → Playing Next and explicit queue reordering. Soundsible already has an explicit queue button; the improvement is consistent task/state/navigation language, not adding another destination. Sources: [Spotify Library](https://support.spotify.com/us/article/your-library/), [YouTube Music Library](https://support.google.com/youtubemusic/answer/6313542?hl=en), [Apple queue](https://support.apple.com/en-ca/guide/iphone/ipha4521ef7d/27/ios/27).

**Sourced / limits.** `SOURCES.md` records14 primary product/design-system/tooling references and retrieval limits, including official public illustrations and Apple’s search-indexed material after direct429 responses. No logged-in competitor UI was measured, and no private implementation or frame-time comparison is inferred. Carbon supplies a useful spacing/Stack example; Stylelint and Playwright provide enforcement mechanisms. A design-system migration still needs explicit ownership and reviewed expectations in this repository.

## Ordered recommendations: keep, change, replace

All entries are **recommendations based on the read/observed/measured evidence above**, not measured outcomes of unimplemented code.

| Order | Decision | Expected effect | How to verify |
|---|---|---|---|
|1| **Keep** Solid, CSS modules, semantic density/themes, shared identity/command logic, native audio boundary, responsive taps, global now-playing markers, scroll-history and existing geometry tests. | Retain working contracts and avoid a framework rewrite whose design benefit is unproven. | Same playback/queue/offline IDs, commands and persistence before/after; no native web-audio imports; existing regression suite. |
|2| **Replace** menu presentation internals behind one explicit API; repair bounds/focus/route ownership immediately. | Removes directly reproduced keyboard, clipping and stale-overlay faults across all callers. | Mouse, Enter, Space, Shift+F10, Escape, Back, scroll/resize, long translated labels and all densities. Menu bounds within viewport; keyboard focus enters and returns; no old menu after navigation. |
|3| **Change** shared media-row and collection contracts, migrate main Songs/Favourites/Search/Album plus player browser/queue as the first complete vertical slice. | One place controls anatomy, focus, images, density and bounded rendering; directly addresses both cohesion and future rendering-policy propagation. | Cross-view row/column metrics and action availability; virtual DOM bounded with10,000 items; first/last reachable, scroll-return/focus maintained, real target-device frame traces. No claimed FPS gain until measured. |
|4| **Change** primitives/tokens for role-based icon controls, typography, semantic text/status colours, hit areas and state styling; separate compact panel density from action suppression. | Large size affects all relevant controls; colour/press/focus behavior becomes predictable. | Three sizes, two themes, pointer/coarse input,200% zoom and forced/reduced modes; computed target/contrast checks and approved screenshots. |
|5| **Replace** copied media cards/shelf/grid layouts with shared patterns and state-derived skeletons. | Consistent artwork/title/actions; See all and loading preserve predictable location and return behavior. | Same entity in Library, Discover, Search and Artist; long titles, missing/failed artwork, rail ends, keyboard arrows/focus and two-column narrow layouts. |
|6| **Change** navigation provenance and player task structure; bring Android presentation into shared templates through adapters. | Entity visits retain context; ordinary browsing and DJ placement have explicit intent; fewer separately learned surfaces. | Library→album→Back/tab-return, search→artist→album, queued-song placement/cancel, native Back, deep links and offline flows. Native acceptance remains separate from browser captures. |
|7| **Change** enforcement and acceptance ownership; baseline real views and primitive/state stories; ratchet legacy exceptions. | Prevents new visual recipes and raw values from silently returning. | Deliberately introduce a forbidden literal, raw control and changed row/menu snapshot: each appropriate gate must fail; approved exception must be local/reviewable. |
|8| **Change** motion/material policy using measured experiments. | Bounded compositing and predictable transitions without losing visual identity. | Controlled target-hardware before/after scroll/idle/open/close traces, blur/fallback image comparison, reduced motion and phone gestures. Repeat only experiments that reveal unresolved concerns. |

## Open questions and what settles them

- **What actually freezes?** This review did not run sustained performance tests. Settle with a trace of the owner’s fast scrolling, per surface and target device, recording long tasks, layout/paint/composite, mounted rows, image decode/requests and memory. Run one representative list through the proposed collection contract and compare end-to-end behavior; token counts cannot answer it.
- **Which density differences are intentional?** Compact compatibility is a documented requirement. Settle by approving a matrix of row/control/art/type roles for main and panel contexts, preserving Compact explicitly. The present fixed36px/40px panel values must become an accepted role or be changed.
- **Does the phone trailing-art composition improve use?** It is an existing deliberate design, not rejected solely for differing from desktop. Settle with one-handed browse/menu/play/scroll-stop tasks on a physical phone, including Large text. Browser screenshots establish geometry, not ergonomics.
- **What belongs to Library, Saved and Favourites?** The implementation distinguishes bookmarked entities, acquired/saved songs, favourites, engine downloads and Android offline copies. Settle the visible vocabulary and empty-state instructions with concrete task flows; do not import conflicting Spotify/YouTube save semantics.
- **How far should player browsing duplicate the main navigation?** Settle with real tasks: add next, inspect album, save a song, request a DJ song, add reference material and return. Retain only task-specific UI/state that earns its extra surface.
- **What differs in WebKit/WebView2/native Android?** Linux WebKit can be checked in a read-only Playwright container, but that is not iPhone/PWA acceptance. Windows WebView2 and native Android were not exercised here. Settle with the same stories and native device tasks on those engines, including Back, system text, inset/keyboard behavior, failed artwork and glass fallback.
- **Can an existing accessible Solid primitive replace the custom popup internals?** Kobalte is a concrete candidate ([documentation](https://kobalte.dev/docs/core/components/dropdown-menu/)); no package was installed or benchmarked. Settle with a tiny menu/dialog spike behind the proposed API, including touch dismissal and existing native hosts. Do not make the full migration depend on a new component framework.

## Target design-system architecture for this codebase

**Proposed architecture, grounded in the evidence above:** keep the current application stack; replace distributed presentation ownership with these layers. Names/paths below are proposed, not files claimed to exist.

```text
src/design/
  tokens/       primitive scales → semantic roles → component recipes
                theme × interface size × main/panel context
  primitives/   Button, IconButton, Text, Artwork, Field,
                Menu/Sheet/Dialog, Choice, FilterChip, Tabs, Status
  patterns/     MediaRow, MediaCard, CollectionView, Shelf,
                PageHeader, EntityHeader, CollectionState, PlayerChrome
  stories/      pure fixture cases + state/interaction matrix

src/features/   library/search/playlists/podcasts/downloads/live/player
                prepare typed view models; supply commands and navigation
src/adapters/   web store/audio/router | native program/offline/navigation
src/routes/     compose templates; do not restyle shared pattern anatomy
```

**Proposed token contract.** Keep existing values initially. Split conceptual primitive scales, semantic roles and pattern recipes without requiring an immediate token-file conversion. Add roles such as `text.metadata`, `text.danger`, `control.icon.hitSize`, `mediaRow.coverSize`, `panel.headerHeight`, `motion.surfaceEnter` and `surface.overlay`. CSS modules remain implementation detail of the owning component. Keep local stacking offsets local; expose named overlay layers. DTCG-compatible typed JSON is useful later for web/native interchange, not a prerequisite for stopping drift ([DTCG](https://www.designtokens.org/tr/2025.10/format/)).

**Proposed primitive contract.** Every interactive primitive owns disabled/busy/selected/hover/focus/pressed semantics, visual glyph versus hit box, keyboard and pointer/touch handling, and accessible naming. The central icon registry owns shape, optical box and intended weight; functional text substitutes/inline duplicates become explicit exceptions. Artwork owns fit/aspect/fallback/error/loading; callers provide image identity/variants and semantic shape, not CSS background strings. Native form controls remain usable where they already solve keyboard/OS behavior.

**Proposed pattern contract.** MediaRow owns stable named slots and a small set of semantic variants; track/entity/podcast/download adapters provide content and commands. Expose task intent (`play`, `openEntity`, `request`, `pickReference`) separately from density and layout. Current audible, selected/requested, saved, file-owned, offline and busy are distinct state meanings. A shared *anatomy* does not require identical metadata or actions everywhere and must not collapse musical item, source and queue-occurrence identity.

**Proposed collection contract.** CollectionView owns the scrollport, bounded/virtual rendering policy, size estimates tied to the row recipe, header offset, empty/error/refresh states, skeleton slots and focus/scroll restoration. A grid or shelf owns image budget and keyboard access as well as layout. Small bounded content may opt out of virtualization through an explicit reason/limit; route authors should not silently create a new unbounded renderer. Keep high-frequency playback progress isolated from collection view models. Performance budgets are measured on actual target hardware, not inferred from component count.

**Proposed governance.** One owner/file per pattern recipe with explicit variants; extension requires a concrete scenario and tests. Stylelint/PostCSS AST checks constrain semantic property categories while allowing structural values; JSX lint limits raw button/SVG/style use outside primitives, with reviewed exceptions for specialized controls. Ratchet existing debt from a checked-in baseline instead of blocking every legacy file at once. Add semantic geometry/state assertions, menu navigation tests and reviewed Playwright baselines for representative real routes. Keep main/panel/native adapter stories separate from domain tests and reuse the showcase fixture catalogue. Public Spotify practice supports shared component anatomy/properties across platforms, not a mandatory one-component-for-everything approach ([first-person account](https://www.figma.com/blog/creating-coherence-how-spotifys-design-system-goes-beyond-platforms/)).

## Prioritized UX changes

1. Repair shared menu keyboard entry, anchoring, viewport bounds, focus return and route/Back dismissal.
2. Make ordinary song actions discoverable in the main list and player; separate compact density from hiding overflow/collection marks.
3. Align media text/art/action columns and density recipes across main Songs, Search, Album and player; migrate them together.
4. Make loading geometry match final rows/cards, and distinguish failed reads from empty results in every picker.
5. Give cards one action location, text hierarchy and shelf navigation contract; retain intentional entity shapes and top-result emphasis.
6. Preserve Library/Search provenance across entity visits and return; reduce redundant browsing chrome inside the player to task-specific intent.
7. Apply semantic text/status contrast and consistent control states; preserve accessibility recipes and native conventions.
8. Converge Android presentation through shared templates/adapters, then validate WebKit/PWA and WebView2/native behavior separately.
9. Admit new patterns only through the owned API, fixture stories and real-view visual/interaction gates; evaluate motion changes against measured rendering evidence.
