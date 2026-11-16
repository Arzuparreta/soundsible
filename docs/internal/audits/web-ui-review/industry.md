# Independent architecture research: industry practice and the web UI

> Imported from an independent review of `00fd7d0a` (2026-11-16). Only links were rewritten. Scripts, traces, screenshots and data files it names stayed in the reviewer's working directory and are not part of the repository. Read [the handoff](../WEB_UI_REVIEW_HANDOFF.md) first: it records which findings were verified, refuted or reclassified afterwards.

Research date: 2026-11-16. Repository baseline: `00fd7d0ae3b0d48e610d8643d6e6614e5ece63ed`, branch `docs/web-ui-architecture-review`.

## Summary verdict

1. **Keep Solid, TypeScript, native HTML/CSS, and the shared web client as the default foundation.** The evidence does not justify a framework migration as the first response. **Sourced:** [S02], [S12], [S35], [S43], [S45].
2. **The present implementation is not yet the target architecture:** common dependencies coexist with several collection, row, image and scroll implementations. **Read:** [R01], [R02], [R03], [R04], [R05], [R06].
3. Target one rendering system: bounded collection views, explicit identity and geometry, inexpensive row presentation, and predictable scroll ownership. **Proposal based on sourced/read:** [S20], [S23], [S53], [R01], [R02].
4. Give artwork a shared, size-aware loading and decode policy instead of separate CSS-background and image-element paths. **Proposal based on sourced/read:** [S27], [S28], [R05], [R06], [R07].
5. Make materials and motion a small set of tested surface recipes with an opaque legibility floor and measured rendering budgets. **Proposal based on sourced/read:** [S18], [S56], [R08], [R09].
6. Build cohesion through shared behavior, semantic tokens, documented components and automated enforcement; token files alone cannot enforce consistent patterns. **Sourced/read synthesis:** [S05], [S54], [S55], [R10], [R11].
7. Keep playback and platform services independent of route and presentation lifecycles, with capability-based shell adapters. **Sourced/read synthesis:** [S02], [S35], [R12], [R13].
8. Establish gates for presented frames, content readiness, interaction latency and resource use on the X270 and real WebKit/WebViews. **Proposal based on sourced/read:** [S03], [S33], [S34], [R14], [R15].
9. A video-rich feed can remain smooth because video and scrolling have independent engine paths; visual complexity is not proportional to main-thread rendering work. **Sourced:** [S12], [S17], [S20].
10. The exact current YouTube home/search recycling strategy and Spotify playlist library are not established by the primary material found here; claims naming particular libraries or savings should not be repeated as facts.
11. Replace an individual primitive or rendering path when controlled traces prove its limitation; a full rewrite needs evidence that these boundaries cannot be repaired economically. **Recommendation informed by sourced:** [S35], [S40], [S43].

## Scope, method and evidence rules

This is the industry-practice review, performed alone. It is an architectural opinion based on public engineering evidence and current source inspection, not a new performance diagnosis. Other reviewers' measurements and conclusions were neither requested nor used.

- **Measured** means executed in this review, with a command and result. The baseline commands `git status --short`, `git branch --show-current`, and `git rev-parse HEAD` returned an empty status, the branch and commit above. No application timing, frame-rate, memory or GPU measurement was run.
- **Read** means a fact in the repository at a linked file and line. Measurements reported in repository documents remain **read historical evidence**, not measurements reproduced here. Comments and test expectations establish author intent or an assertion, not universal browser behavior.
- **Sourced** means external evidence at a linked URL. The source register distinguishes engine documentation/source and specifications, first-party historical engineering accounts, vendor guidance, and weaker third-party material. A company's report of its own improvement is attributed to that company; it is not independent replication.
- Recommendations and causal interpretations are labeled as proposals, hypotheses or synthesis from those evidence classes. Confidence in a mechanism does not establish that the mechanism dominates this application's current freezes.

[AGENTS.md](../../../../AGENTS.md#L1) and the [architecture](../../../../docs/internal/audits/ARCHITECTURE_HANDOFF.md#L1) and [engineering](../../../../docs/internal/audits/ENGINEERING_HANDOFF.md#L1) handoffs were read. The specific read-only brief takes precedence over their implementation and handoff-update workflows. No repository files, branches, dependencies or commits were changed. Nothing contacted the engine on port 5005. Public sources were retrieved through search and HTTP requests; there were no logged-in sessions, public-product browser runs, scroll benchmarks or background services. General technical queries contained no private project content or owner identifiers.

The source snapshots and search responses are in the output directory's `sources/` subdirectory and `search-evidence.json`. Some sites exposed their text through the search reader while direct extraction returned a challenge, an empty client-rendered shell or HTTP 403. This is called out below. Absence of a public implementation account is a limit of this review, not proof that the product lacks that technique.

## Findings ranked by impact on the reported problem

### 1. Scroll performance must be an architectural contract; a framework choice and a virtualizer do not provide it

**Evidence: sourced, high mechanism confidence; read, high code confidence; current causal attribution unmeasured.** Chromium separates main-thread DOM/style/layout/paint work from compositor scrolling, raster/decode workers and Viz presentation [S12]. Gecko similarly separates asynchronous pan/zoom from content generation and explicitly documents running beyond the available displayport [S20]. WebKit has an iOS-specific remote scrolling integration and explicit synchronous-scrolling reasons [S16], [S17].

**Location:** [VirtualRows.tsx:30][R02] remounts the virtual window after a layout sample; its rows use translated absolute slots. [TrackList.tsx:59][R01] and [VirtualBrowseRows.tsx:13][R03] construct other virtualizers. [PlayerWorkspace.module.css:43][R16] combines a horizontal snap scroller with vertically scrolling panels. [NowPlayingBrowser.module.css:99][R17] owns another overflow policy. The existing scroll investigation explicitly says lag remains, its rAF figures are not presented FPS, and warm/offline lag survives [R18].

**Concrete consequence:** bounded DOM can still be expensive to reveal, measure, paint or raster. The compositor can move an existing surface while its content is late, or scrolling can require a main-thread synchronization. These are different failure modes. None is solved merely by saying the app is already virtualized, or by moving its JSX to another framework.

**Architectural conclusion:** every collection needs an explicit scroll owner, geometry model, render-ahead policy, identity model and performance acceptance test. First separate input-to-scroll delay, viewport movement, row readiness and frame presentation. This is the highest-priority contract because it directly addresses the owner's freeze report across surfaces.

### 2. The collection abstraction is fragmented, and some collections remain proportional to total data size

**Evidence: read, direct; sourced, strong general mechanism.** There are separate virtual-window implementations in [TrackList][R01], [VirtualRows][R02], [VirtualBrowseRows][R03] and [LibrarySearchResults][R04]. Each has its own scroll integration. [ArtistGrid.tsx:15][R19] creates a card for every supplied artist. The browser's album branch renders its supplied albums with `For`, while its song branches use `VirtualRows`; search sections also render supplied items directly [R20]. This proves differing strategies, not that every supplied array is large or unbounded at the API.

Google's virtualization guidance explains the visible-window/overscan tradeoff [S23]. TanStack documents index keys as its default and persistent unique keys as the preferred override where possible [S53]. Solid's `For` tracks item identity, whereas `Index` tracks positions with reactive item accessors [S46], [S66]. These are different identity layers.

**Concrete consequence:** a performance fix or correctness fix in one list does not establish the same behavior elsewhere. Lazy-loaded images do not remove the DOM, reactive owners and event wiring for all the cards. The virtual-list copies also make geometry, focus retention and prepend/reorder behavior harder to enforce consistently.

**Architectural conclusion:** keep TanStack provisionally, consolidate its integration, and offer explicit fixed-row, variable-row and grid collection primitives. Small finite sections may stay ordinary DOM. Apply a documented bound or containment strategy to every potentially large surface. Do not indiscriminately switch every `For` to `Index`: a recycled position must not inherit another item's local state, long-press timer, focus or artwork request.

### 3. Artwork has two presentation policies, so collection performance and visual readiness can differ by surface

**Evidence: read, direct; sourced, strong API/engine evidence; performance magnitude unknown.** [CoverImage.tsx:29][R06] measures its slot with `getBoundingClientRect` and a ResizeObserver, supplies `srcset`/`sizes`, and uses eager/lazy and sync/async hints according to a bounded set of previously painted URLs. In contrast, desktop [SongRow.tsx:142][R05] and [MusicListRowView.tsx:140][R21] use CSS backgrounds through [cover.ts:24][R07]. Those backgrounds do not use the image element's loading, decoding or responsive-candidate attributes. The existing URL layer already supports thumbnail and revision-aware variants [R22].

`decoding` is a scheduling hint, not a promise that the image is ready. `decode()` resolves when it is safe to present an image; loading and decoded-image availability are different states [S28], [S29]. YouTube documented a thumbnail-format pipeline [S09]; Discord documents resizing, format negotiation and platform-specific decode tradeoffs [S41].

**Concrete consequence:** grids and rows can have different fetch selection and placeholder/reveal behavior even when they represent the same music. Recycled mounts can repeatedly exercise image readiness. Per-image geometry observations are another cost to inspect. Conversely, CSS backgrounds are not intrinsically main-thread decoded, and the presence of `sync` is not proof of a stall.

**Architectural conclusion:** use one artwork contract with an explicit displayed size, density, priority, stable cache identity, placeholder and error behavior. Evaluate an image-element implementation for rows, preserve fixed geometry, and decode only a bounded near-viewport set. Do not preload or await every cover. Do not claim an image change fixes warm-cache lag: the repository already documents such lag without new image requests [R18].

### 4. Existing tests protect appearance and behavior more strongly than sustained graphical delivery

**Evidence: read, direct within inspected test/configuration paths; sourced, high.** The four browser profiles are present in [playwright.config.ts:46][R14] and run through CI [R15]. The default is reduced motion; screenshot comparisons disable animations. Dedicated rendering tests opt into motion and assert wallpaper/filter policy and animation states [R09]. Navigation tests inspect first-frame state and scroll restoration [R23]. These are valuable protections.

They do not establish accelerated frame presentation on an HD 520, iOS WebKit, Android System WebView or WebView2. A search of the browser tests and CI found no `PerformanceObserver`, `longtask`, `long-animation`, `p95`, frame-time or dropped-frame performance gate; this is a bounded source inspection, not a claim that the whole repository has no performance tooling. INP explicitly excludes scrolling and hovering [S33]. Long Animation Frames reports rendering updates beyond 50 ms and is not a detector for every missed refresh [S34].

**Concrete consequence:** a PR can retain pixel geometry, accessibility and all expected CSS values while increasing raster cost or missing refresh deadlines. A good Lighthouse/INP result would leave the main complaint untested.

**Architectural conclusion:** add a reproducible scroll/render acceptance suite and a lightweight field/lab observability boundary alongside the existing correctness suite. Keep renderer timing, presented frames, visible-content readiness, playback continuity and resource use as separate outputs.

### 5. Materials need a compositing policy, but a blanket blur explanation is not supported

**Evidence: read and sourced; strong mechanism, uncertain present bottleneck.** The current stage already has one wallpaper/veil arrangement rather than a backdrop filter on every panel [R08], [R09]. Its backdrop is enlarged, filtered, animated in steps and marked `will-change: transform` [R08]. The floating-player token has a substantial tint beneath its blur [R10]. The historical performance document describes earlier composition experiments [R24]; the later scroll document says removing backdrop filters did not consistently eliminate remaining lag [R18]. Neither is a fresh diagnosis of this commit.

WebKit's own backdrop-filter explanation warns about additional rendering passes [S18]. Apple's current HIG gives materials semantic roles and advises sparse use of custom glass; it does not publish a CSS equivalent with the same implementation cost [S56]. Layer-promotion hints consume resources and can change stacking/containing behavior [S26].

**Concrete consequence:** a small changing object can participate in a larger compositing dependency, but a browser may cache or optimize a filter. Cost depends on affected area, invalidation, clips, overlaps, scale, DPR, driver and engine. Neither “GPU accelerated means free” nor “blur always repaints everything” is a valid universal rule.

**Architectural conclusion:** retain visual richness through a small surface/material API. Measure the current single-background design before further changes. Compare a static or preprocessed artwork texture only where a trace identifies repeated filter/raster work. Preserve a fill-based contrast guarantee independently of feature detection and blur correctness.

### 6. Cohesion is partly implemented in code, but ownership and enforcement remain the important next step

**Evidence: read, direct; sourced, strong first-party design-system evidence.** [tokens.css][R10] already has surface, ink, type, spacing, geometry and motion roles; it is not a token-free application. [SongRow][R05] switches to the shared mobile row but keeps a distinct desktop implementation. [MusicListRowView][R21], [PlayerTrackList][R11] and the browser's row composition [R20] carry related presentations and behaviors. This is evidence of multiple pattern implementations, not a rendered judgment that each difference is wrong. [DESIGN.md:7][R25] explicitly scopes itself to the consumer shell, and the UI rebuild plan records an older stage [R26]. Neither alone is an authoritative current full-web design-system specification.

Encore's authors report moving toward semantic tokens, reusable components, adoption analytics and automation after flexibility produced inconsistency [S05]. Material documents reference → system → component token roles [S54]. Atlassian publishes rules that reject hardcoded/legacy values in favor of tokens [S55].

**Concrete consequence:** common colors can coexist with different action order, row rhythm, menu behavior, selection feedback and loading states. New screens can choose a familiar-looking but behaviorally different pattern.

**Architectural conclusion:** define one implementation per interaction pattern, with explicit density and capability variants. Document anatomy, semantics and states; enforce adoption in code review, lint/static checks and visual regression fixtures. Preserve deliberate mobile/desktop adaptations. Sharing behavior does not require an identical DOM tree or identical target sizes everywhere.

### 7. Shared web rendering is an industry-proven option; platform parity still needs a capability contract

**Evidence: sourced, strong historical implementation account; read, direct entry-point evidence.** Spotify describes sharing a React UI between its browser player and CEF desktop container through typed Platform APIs [S02]. The current project has a common player entry, shell and state modules, plus an Android boot entry [R12], [R13], [R27]. The supplied context establishes Capacitor/System WebView, Tauri/WebView2 and the separate SwiftUI car client; this review did not audit native adapters or change any port.

**Concrete consequence:** replacing Solid with React would not replace WebKit, Android's embedded draw integration, or WebView2 runtime policy. Conversely, sharing the UI need not force playback, downloads, navigation integration and device services to use identical implementations.

**Architectural conclusion:** keep a shared presentation and domain contract with typed platform capabilities. Localize shell-specific integration at ports. Test the actual supported runtime versions. Treat a native list/surface as a possible isolated response to a demonstrated engine limitation, with a real maintenance and parity cost, rather than an automatic next architecture.

### 8. The industry evidence favors controlled boundary changes over copying a company's current stack

**Evidence: sourced, strong historical accounts; read mapping.** Netflix reports that its initial web React migration regressed playback startup and video frames; isolating the redesign from the architecture change and narrowing high-frequency updates were part of the successful retry [S35]. Twitch's web-chat work targeted update batching and per-item bookkeeping [S37]. SoundCloud documents the need to bound retained data in long-lived media clients [S38], [S39]. These are different mechanisms, not a common winning framework.

**Concrete consequence:** a sweeping redesign plus framework replacement plus new list implementation would make regressions difficult to attribute and could discard existing identity, accessibility, scroll-return and audio behavior. The source already contains explicit protections for those contracts [R01], [R02], [R09], [R23].

**Architectural conclusion:** the scope should remain broad, but delivery should isolate rendering, data-flow and visual changes sufficiently to establish causation. Broad scope does not require replacing every layer simultaneously.

## What the compared products actually document

### YouTube web

**Sourced, primary and historical:** YouTube's SPF project describes fragment navigation, persistent chrome, resource management and caching [S08]. Its May 2017 announcement explicitly names Polymer and Material Design [S07]. That establishes a historical web-components architecture, not the exact framework/version of every current surface. The company's “faster” description in the launch announcement is not a controlled scroll benchmark.

**Sourced, primary product behavior:** YouTube distinguishes hover-triggered inline playback on home/search from short video previews; it does not describe every thumbnail as a concurrently running full player [S10], [S11]. Its thumbnail pipeline adopted WebP, with a historical page-load improvement reported by Chromium [S09]. That page-load report says nothing directly about current scroll frame times or image decode cost on an HD 520.

**Not established here:** a first-party specification of current home-feed and search-result item recycling, retained-DOM limits, current overscan policy, feed-worker scheduling, or which JavaScript computations run off the main thread. Sources naming custom elements, Polymer's `iron-list`, userscripts, clones and social posts do not prove the policy of those two production surfaces. No live DOM/recycling experiment was run. The official Polymer Summit talk is a historical lead, not treated as a verified current implementation description.

**Engine-backed inference:** eligible video decode and composition can proceed on media/compositor paths independently of application DOM rendering [S12]. This makes a feed with an active video preview compatible with smooth scrolling. The browser still needs newly visible content rasterized and available. It does not imply that YouTube runs arbitrary DOM work in a Web Worker, and it does not explain a particular freeze without a trace.

**Transfer:** persistent shell, bounded work around the viewport, correctly sized cached imagery, conditional preview activation and independent playback lifecycle. Do not port Polymer or imitate private DOM structure to obtain these properties.

### Spotify web player and desktop

**Sourced, first-party historical:** the 2019 account describes replacing isolated iframe views with a simpler React/Redux web player; the 2021 account describes a shared UI over platform APIs in browser and CEF containers [S01], [S02]. The point applicable here is common UI with explicit integration boundaries and reusable components. It is not evidence that a React rewrite is faster than Solid.

**List implementation evidence limit:** no primary source found in this research identifies the current playlist virtualizer, recycling semantics or overscan parameters. Third-party descriptions of virtualized playlist DOM are plausible but weaker; an unsourced social post naming `react-window` and precise savings was excluded. A public Web API's pagination is not proof of DOM virtualization. The exact implementation remains an open question, not a premise needed to adopt bounded lists.

**Cohesion:** Encore's documented development is more useful than its visual styling. Its authors describe semantic roles, reusable components, code as token truth, automated design synchronization and measuring actual adoption [S04], [S05]. Their lessons also warn that a “system of systems” can mirror organizational divisions rather than coherent user experiences. This project does not need Spotify's distributed design-system organization.

**Materials evidence limit:** the researched engineering accounts do not establish how Spotify's current web/desktop blurred backgrounds are rasterized or cached. “Spotify uses blur” cannot justify an arbitrary full-screen CSS filter tree.

**Performance practice:** Spotify publishes a lab-plus-field approach, Lighthouse CI integration and journey-level monitoring [S03]. Its SSR example concerns loading; copying SSR would not resolve an already-loaded list's scroll work.

### Other media and list-heavy products

| Product | What the public evidence supports | Strength, limits and transfer |
| --- | --- | --- |
| Apple Music web | Secondary accounts claim different framework generations; Apple's services job material lists several frameworks without identifying a specific deployed player [S62]. | **Sourced, weak for player internals.** No primary list/recycling/blur implementation found. Do not treat Svelte, Ember or Stencil claims as a performance prescription. Apple's HIG is strong design guidance for material hierarchy and consistency, not evidence about Music web's renderer [S56], [S57]. |
| YouTube Music web | No primary account found here documenting its current collection renderer, image decode scheduler or recycling policy. | **Research limit.** Its relationship to YouTube is not sufficient to transfer undocumented implementation details. Apply engine and collection principles independently. |
| SoundCloud | Its 2012 web architecture describes reusable views, shared model identity, request deduplication and releasing unused models [S38]. A 2019 article discusses bounded normalized Redux data for its Xbox client [S39]. | **Sourced, strong but historical and platform-specific.** Do not relabel the Xbox Redux implementation as the main website. Useful lesson: DOM virtualization and data/cache retention are separate budgets in a long-running audio client. |
| Deezer web | Searches did not uncover a strong first-party description of list/recycling or compositing. Its annual report describes CDN delivery of assets, not client rendering [S63]. | **Sourced, narrow company disclosure; no list evidence.** CDN choice, recruitment ads and third-party clones cannot explain scroll smoothness. No architecture recommendation here depends on unseen Deezer internals. |
| Netflix web | The web playback modernization account reports a failed initial migration, excessive root updates and a successful controlled retry [S35]. | **Sourced, strong historical account.** Protect playback lifecycle and narrow reactive updates. It does not identify today's browse-list implementation. |
| Netflix TV | React-Gibbon targets a custom drawing primitive on constrained devices; the team measured input response, startup, frame consistency and memory [S36]. | **Sourced, strong for that renderer; indirect for browsers.** Gibbon is not browser DOM. Its custom optimizations cannot be assumed to transfer to Solid/CSS. |
| Twitch web | Its 2016 chat investigation profiles real rendering, batches incoming updates and reduces per-line work [S37]. | **Sourced, strong historical web example.** Transfer workload budgeting and cheap item presentation. Do not copy its 100 ms batching interval into touch input, playback clocks or every UI update. |
| Discord | Current engineering material separates its React desktop UI from native/React Native mobile list work [S40]. Its image pipeline account explicitly spans web and desktop and explains format/decode tradeoffs [S41]. | **Sourced, strong, with platform boundaries.** Native recycling is evidence for bounding work, not evidence that a DOM app should become React Native. Its selective Android emoji-picker rewrite shows when a measured local replacement can justify maintenance cost. |
| Facebook.com | Meta describes CSS colocation/build-time processing, CSS-variable theming and code/data/navigation improvements in its 2020 rewrite [S42]. | **Sourced, strong historical large-web example.** Enforce defaults and ownership. It does not establish that adopting StyleX, Relay or microfrontends would help this smaller app. |

## The engine mechanics that determine whether scrolling is smooth

### Chromium: Blink → cc → Viz, with embedded-runtime qualifications

**Sourced, engine documentation:** DOM changes pass through style, layout, pre-paint and display-list painting. Commit transfers relevant state; compositor-side layerization and raster/decode work produce tiles; Viz aggregates and draws frames [S12]. Eligible scroll/transform/opacity updates can bypass earlier stages. Video has a distinct decoding path feeding composited frames.

There are at least four separate ways a collection can look slow:

1. An input path must wait for main-thread handling before scrolling can proceed. Cancelable touch/wheel handling and event regions are relevant; passive listeners and correct `touch-action` can preserve the asynchronous path [S13]. A normal `scroll` listener is not itself a cancelable pre-scroll veto, although its work can be expensive.
2. Scrolling moves existing content, but JavaScript has not populated the newly visible virtual window. More compositor independence cannot create missing DOM.
3. DOM exists, but layout/paint/raster/decode has not supplied ready content. Cold imagery and insufficient render-ahead can expose blanks even with fast input [S12], [S15].
4. Compositing/drawing itself exceeds the deadline because of render passes, affected area, textures or driver behavior. Low overall CPU use does not eliminate this possibility [S12], [S18].

**Sourced with historical caveat:** Chromium's older compositing document explains overlap-induced layers and layer squashing [S14]. Modern RenderingNG describes layerization after painting [S12]. The lesson that an element, stacking context, paint layer and GPU surface are not interchangeable survives; old RenderLayer heuristics should not be treated as a current universal checklist. `translateY` or `will-change` does not promise one dedicated, beneficial GPU texture per row.

Android WebView has its own OS-level drawing-thread integration in Chromium's documented architecture [S12]. WebView2 has an explicit Evergreen-versus-fixed runtime policy [S59]. The desktop browser, Android WebView and Windows shell therefore need their runtime/version/acceleration recorded separately; all being Chromium-based does not make them interchangeable test environments.

### WebKit, especially iPhone PWA

**Sourced, engine source:** WebKit's iOS remote scrolling coordinator links scrolling state and platform scroll views outside the web-content DOM lifecycle [S17]. Its shared types enumerate reasons to require synchronous scrolling, including unsupported viewport-constrained objects, slow-repaint objects and synchronous descendant scrollers [S16]. These are diagnostic concepts, not a declaration that every fixed element or CSS filter forces synchronous scrolling in this app.

**Sourced, release documentation:** Safari 18 added `content-visibility` and unprefixed `backdrop-filter`; Safari 26 added scroll-driven animations [S19], [S31]. A blanket claim that iOS lacks either containment-based visibility skipping or scroll timelines is outdated. Availability and performance of specific combinations still depend on the supported OS and embedded runtime.

**Read/sourced synthesis:** the existing horizontal pager, vertical panel scrollers, fixed player surface and gesture handling deserve testing as a composition [R08], [R16], [R28]. Replacing native scroll with JS position updates would sacrifice useful engine behavior unless a demonstrated interaction requires it. Linux Playwright WebKit checks web behavior; it does not reproduce UIKit scrolling, device GPU/memory pressure, PWA lifecycle or all physical-iPhone compositor behavior [R14], [S17].

**Sourced, image scheduling:** WebKit's pinned July 2026 `ImageFrameWorkQueue` implementation dispatches image-frame decoding through a work queue and returns completion to the rendering side [S67]. Its older tracking discussion describes synchronous and asynchronous paths, but is historical rather than a current default-policy guarantee. This rules out the simplistic claim that WebKit necessarily decodes all row artwork on its main thread. It does not establish that a requested frame is decoded, uploaded and ready by the time a virtual row appears. The installed iPhone engine may precede or differ from this source revision.

### Gecko/WebRender

**Sourced, engine documentation:** APZ applies transforms to already available content while the content process constructs a scene. Its displayport deliberately trades memory against render-ahead; sufficiently fast scrolling can outrun it and checkerboard [S20]. WebRender culls a scene into frames, uses spatial/clip trees, caches reusable picture regions and introduces offscreen render passes for effects [S21]. It is not the same implementation as Chromium tiles/layers.

**Transfer:** distinguish absent virtual DOM content from browser checkerboarding and compositor stalls. Audit actual computed styles before cross-engine comparisons; the repository itself warns that older Firefox and Chrome captures did not always render the same filter declarations [R18]. Do not promise cross-engine performance from one engine's layer trace.

**Sourced, image scheduling:** Gecko's `DecodePool` schedules asynchronous tasks as off-main-thread-only and also exposes synchronous execution paths; `RasterImage` selects paths using request/draw flags and decoder state [S68], [S69]. Thus neither “all images are off-thread” nor “CSS backgrounds block the main thread” describes every case. Async decode still competes for CPU and memory, and the final draw needs a usable decoded surface. In all three engines, prioritize and size the needed images before considering more decode concurrency; worker availability is not unlimited rendering capacity [S12], [S67]–[S69].

## Practice catalog: mechanism, adoption evidence and platform applicability

In the table, **all** means Solid-generated DOM in desktop browsers, iPhone WebKit PWA, Android WebView and WebView2, subject to their supported versions. “Used by” is limited to the named source's documented time and platform. A product name in this table is not a claim about all its current clients.

| Practice | What it is; documented adoption | Engine mechanism | Applicability and evidence strength |
| --- | --- | --- | --- |
| 1. Persistent shell; independent media lifecycle | Keep audio/video services outside replaceable route subtrees. Spotify's shared client and Netflix web describe this separation [S02], [S35]. | Avoid teardown, reinitialization and broad UI work delaying playback. | **All. High primary historical evidence.** Keep the present shared-shell direction [R12], [R13]; strengthen ports and lifecycle tests. It is not a scroll optimization by itself. |
| 2. Windowed collection rendering | Mount visible items plus a bounded render-ahead region. Documented in Google's windowing guidance and Discord mobile work [S23], [S40]. | Bounds DOM, reactive owners, layout/paint input and retained media; trades mount work against blanks. | **All. High mechanism; direct product evidence is platform-specific.** Reuse a Solid/TanStack integration. Exact current Spotify/YouTube policies remain unverified. |
| 3. Recycling with explicit identity | Rebind positions or retain item-keyed instances deliberately; use occurrence identity for duplicate queue entries [S46], [S53]. Discord describes native component recycling [S40]. | Reduces allocation, but local state and measurement caches must follow the correct identity. | **All. High API evidence; indirect native analogy.** A viewport's array index is not a music or queue identity. Verify sorting, prepends, duplicates, pointer cancellation and focus before changing reconciliation. |
| 4. `content-visibility` with intrinsic-size estimates | Let the engine skip offscreen subtree rendering while retaining DOM. Standardized containment; Google demonstrates it; WebKit ships it [S22], [S24], [S19]. | Skips style/layout/paint work for relevant offscreen subtrees; DOM/state retention and initial component creation remain. | **All on supported modern versions. High spec/engine evidence.** Good for finite heterogeneous sections and some grids; not a replacement for bounding tens of thousands of interactive rows. Check find-in-page, accessibility and scroll estimates. No unsupported attribution to a media service. |
| 5. Targeted containment | Isolate a subtree's layout/paint effects where its sizing and overflow contract allows [S24]. | Limits propagation; paint containment clips overflow and creates new rendering/containing relationships. | **All. High specification evidence.** Evaluate collection islands or slots, not `contain: strict` on every ancestor. Fixed/sticky children, shadows, menus and measurements can change. |
| 6. Native asynchronous scrolling | Use browser overflow, native momentum and scroll snap with clear axis ownership. Chromium/WebKit/Gecko document their independent scroll paths [S12], [S17], [S20]. | Existing pixels can move without waiting for DOM work; cancelable event handling and synchronous reasons can require coordination. | **All. High engine evidence.** Retain the native pager/list approach. Audit canceling touch/wheel listeners; `passive` does not make an expensive handler inexpensive. |
| 7. Batch reads, then writes; cache geometry | Avoid alternating DOM mutation and synchronous geometry reads. Google's layout guidance documents the forced-layout mechanism [S25]. | Prevents repeated forced style/layout within one task and reduces invalidation scope. | **All. High engine/vendor guidance.** The overflow-marker handler reads dimensions and writes a dataset [R29]; treat it as a bounded trace target, not a proven bottleneck. ResizeObserver reads are not automatically layout thrashing. |
| 8. Cheap row presentation; narrow subscriptions | Keep row display work bounded; high-frequency changes update only necessary visual nodes. Netflix and Twitch describe reducing root/per-item work [S35], [S37]. | Less JS, allocation and DOM invalidation precede a frame; fewer unrelated owners update. | **All. Strong primary historical evidence.** Solid provides a suitable mechanism [S45]. Derived metadata, queue membership and saving state still require profiling; fine-grained reactivity is not an automatic complexity bound. |
| 9. Correctly sized, revision-stable images | Generate bounded derivatives and let the client select a suitable candidate. YouTube's WebP deployment and Discord's resizing/format work are documented [S09], [S41]. | Reduces transferred/decoded pixels and texture pressure; stable URLs enable reuse. | **All with format negotiation. High primary evidence, device-specific results.** Keep existing variants [R22]. Compare JPEG/WebP/AVIF for bytes, decode latency, quality and cache behavior; the smallest file need not be cheapest to decode. |
| 10. Separate image request, decode and presentation policy | Reserve geometry; prioritize visible covers; lazily load offscreen media; optionally decode just ahead of reveal [S27], [S28], [S29]. | Avoids layout shifts and postpones low-value requests; controlled decode can avoid a blank swap. | **All. Strong API evidence; not a known current Spotify policy.** A virtualizer's overscan and native lazy-loading distance interact. Don't double-defer the visible row or create an unbounded image prefetch pool. |
| 11. Activate rich previews conditionally | Start inline media for the relevant hover/viewport/selection and stop inactive work. YouTube documents inline playback and preview behavior [S10], [S11]. | Media decode/composition can use specialized paths; limiting active previews bounds decoder and bandwidth demand [S12]. | **All, subject to media/autoplay policy. High product-behavior and engine evidence; exact YouTube scheduler unknown.** Relevant if adding previews; no need to add them to repair existing scrolling. |
| 12. Bound data and cache retention separately | Normalize shared entities, deduplicate requests, release no-longer-needed cached state. SoundCloud documents both model lifetime and Redux-cache collection [S38], [S39]. | Avoids steadily rising JS heap and GC pressure even when only a few DOM items are mounted. | **All. Strong historical evidence.** Preserve canonical identity and playback references; measure actual growth before building a custom collector. The browser owns decoded-image cache lifetime. |
| 13. Small, semantic material recipes | Use distinct opaque, translucent and artwork-background roles; avoid independently filtering many overlapping content surfaces. Apple and WebKit explain hierarchy and extra passes [S56], [S18]. | Bounds filter inputs, changed area and render-pass dependencies; opaque/tinted fills preserve contrast independently. | **All; engine results differ. High mechanism/design guidance, no exact Spotify blur implementation evidence.** Existing single-stage veil is a useful base [R08]. Preprocessing a static background is an experiment, not a mandatory redesign. |
| 14. Budget layer promotion | Apply `will-change` to a small, justified set of animated elements and release it where feasible [S26]. | May preallocate compositing resources; excess layers cost memory, management and raster work [S12], [S14]. | **All. Strong guidance; promotion is a hint.** Do not promote every virtual row or prescribe universal `translateZ(0)`. Inspect actual layers/tiles and worst-case DPR. |
| 15. Declarative scroll-driven animation | Use scroll timelines for optional transform/opacity effects instead of per-scroll JS. Chrome's case study and Safari's shipping account document the facility [S30], [S31]. | Eligible effects can track the engine's scroll state without a round trip through main-thread event callbacks. | **Version-gated across all targets. High engine evidence; property/composition limits remain.** Use progressive enhancement and reduced-motion behavior. It does not populate missing virtual rows or fix filter-heavy frames. |
| 16. View Transitions for navigation polish | Capture old/new states for a controlled transition [S32]. | Snapshots decouple transition presentation from some DOM updates, with texture/capture cost. | **Feature-detect in every target. High API evidence; no inherent list-throughput benefit.** Add after core performance is sound. Avoid snapshots of huge active lists or media without specific testing. |
| 17. Semantic tokens plus reusable primitives | Reference values feed roles and components. Encore and Material document this; Apple documents consistent relationships [S05], [S54], [S57]. | This is primarily an organizational/API mechanism; shared implementations make both behavior and rendering policy repeatable. | **All. Strong primary design-system evidence.** Retain CSS modules and variables. Build the system in Solid; adopting a new styling runtime is not required. |
| 18. Enforce design-system adoption | Document variants/states; lint hardcoded tokens and disallowed patterns; exercise common fixtures visually. Encore measures usage; Atlassian publishes token rules [S05], [S55]. | Prevents new parallel patterns and token bypasses; visual tests detect appearance drift, not frame delivery. | **All. Strong primary tooling evidence.** Adapt rules to CSS modules rather than installing an unrelated React component library. Existing screenshot tests are a base [R14]. Do not claim Spotify uses a specific visual-test vendor without a source. |
| 19. Journey-level budgets and field/lab feedback | Monitor actual user journeys, compare changes and preserve evidence. Spotify documents Lighthouse CI and field dashboards; Google's guidance covers build thresholds [S03], [S58]. | Makes regressions observable; separates input, rendering, loading and memory failures. | **All, with engine-specific tooling. Strong primary practice plus vendor guidance.** Add privacy-safe local diagnostics and opt-in aggregation only if appropriate. A cloud analytics service is not required. |
| 20. Yield or offload only appropriate CPU work | Reduce presentation task size; defer background work; use workers for pure computation, not DOM. Engine architecture documents workers/helpers; Twitch defers nonessential chat work [S12], [S37]. | Leaves main-thread time for events and rendering; serialization and messaging still cost time. | **All, feature-gated scheduling APIs. High engine evidence, workload-dependent benefit.** `requestIdleCallback` still runs on the main thread. Do not move critical playback timing or generate worker infrastructure before identifying a substantial computation. |

## Framework landscape and what benchmarks can establish

**Sourced:** the mechanisms below come from framework documentation/source, not framework-vendor performance claims [S45]–[S52]. **Read:** this application already uses Solid and TanStack [R30]. **Synthesis:** the recommendation to retain them is provisional and based on the absence of evidence that their necessary cost, rather than the surrounding rendering architecture, dominates the problem.

| Foundation | Rendering model relevant to lists | What adopting it could change | What it would leave to solve |
| --- | --- | --- | --- |
| Solid | Fine-grained subscriptions update dependent DOM expressions. `For` retains item identity; `Index` retains a positional mapping with reactive content [S45], [S46]. | It already avoids a mandatory whole-component virtual-DOM render/diff for each small state change. Subscription scope, derivation complexity and mount allocation remain application choices. | Window size, row lifetime, key correctness, image readiness, scroll ownership, style/layout/raster and GPU work. There is no “Solid makes all lists fast” guarantee. |
| React | Render computes component output; commit applies necessary DOM changes [S47]. Memoization and scheduling can reduce or prioritize work, depending on the implementation. | Can provide useful ecosystem components and team conventions; could help if a superior measured list implementation is only practical there. | It is not a new browser compositor. Migration can add component work if subscriptions broaden; Netflix's historical example demonstrates this risk [S35]. React is not disqualified either. |
| Svelte 5 | Compiler-backed templates and runes-based reactivity; explicit state and derivations [S48]. | Changes component syntax, compilation and reactive bookkeeping. It is a plausible efficient DOM framework. | Does not inherently remove the same filter dependency, image decode or forced layout. A switch from one fine-grained/compiled approach to another needs a workload-specific benefit. |
| Vue | Its documented renderer combines virtual DOM with compiler analysis such as static hoisting and patch flags [S49]. | Different component/data-flow ergonomics and compile-time work reduction. | Same browser pipeline and collection contracts. “Uses virtual DOM” is too coarse to predict this workload. |
| Vue Vapor | A no-virtual-DOM mode. The original research repository is archived and directs development to Vue core [S50]. | Another compiled direct-DOM approach; relevant to a controlled prototype, not evidence that this project needs migration. | Exact supported release, feature parity, tooling and benchmark implementation must be pinned. An old experimental repository is not current production-readiness evidence. |
| Lit / web components | Template parts update DOM; `repeat` can preserve item-keyed DOM. Lit's separate Labs virtualizer supplies windowing [S51], [S52]. | Useful interoperability and encapsulation boundaries. YouTube's historical use of web components does not make them a scroll accelerator. | Custom elements do not automatically virtualize content or avoid layout. The retrieved virtualizer documentation labels it late prerelease; check maturity and accessibility before replacing a working library. |
| Handwritten DOM or canvas/WebGL | Direct DOM can minimize selected framework work; a custom drawing surface controls more of rendering. Netflix TV's Gibbon is an example of a distinct custom renderer [S36]. | Potentially removes a demonstrated abstraction cost or supports specialized visualization. | A canvas list must recreate accessible semantics, selection, text, focus, layout and interaction behavior. No evidence here justifies taking on that burden for ordinary music lists. |

### Benchmark methodology, not a leaderboard verdict

**Sourced, independent harness:** `js-framework-benchmark` publishes implementations, operations and measurement procedures [S43]. It exercises table creation, replacement, partial updates, selection, swapping, removal, append/clear, memory and startup. Operations have different warmup rules; timings include rendering. Its README warns that the moving “current” snapshot may mix browser versions or sample counts. The dated Chrome 146 archive [S44] is a better reference than an undated screenshot, but it is still a different environment from the owner's WebViews.

Keyed and positional implementations must not be conflated. They can perform different DOM work and have different correctness semantics; the retrieved README also records the project's move toward keyed-only accepted implementations. The precise harness release and implementation code must therefore accompany any reproduced result. A fast update to every tenth text row does not establish fast cold-artwork scrolling under a translucent fixed panel.

This review did **not** run the benchmark or extract numerical framework rankings from its client-rendered result page. No percentages or “fastest framework” assertion from it are used. Its useful evidence is a reproducible way to compare JS/DOM operations, plus a warning against comparing unlike implementations. There is no controlled benchmark in this evidence set that holds this app's DOM/CSS/images/interaction contracts constant across Solid, React, Svelte, Vapor and Lit on all required engines.

**How to make a migration decision:** first profile the current renderer. If JS construction/reconciliation is a substantial part of missed deadlines, compare the same bounded collection in Solid, a minimal direct-DOM reference and at most one serious alternative. Keep markup, style, data identities, image assets, viewport, device, acceleration, scroll input, build mode and correctness equivalent. Record mount/update/cleanup cost, visible blank duration, style/layout/paint, presented frames, memory, focus/selection correctness and playback continuity. Run production artifacts through the sanctioned build path, outside this read-only review. Do not use the development server's compile/HMR overhead as a shipped-framework comparison.

**Decision rule, proposed:** migration is justified only by an end-to-end improvement large and repeatable enough to offset rewrite/parity cost, or by a concrete missing capability. If most time remains in layout/raster/composition with unchanged DOM and CSS, a framework swap has little of that work to eliminate. A healthy architecture also makes a later renderer replacement smaller.

## Recommended target architecture

The following is a **proposal based on the sourced and read evidence**, not a description of work already delivered.

1. **Domain and platform services:** musical/entity/occurrence identity, playback, downloads, account state and persistent caches remain independent of route presentation. Typed capability ports expose browser, Android and Windows integrations. The separate car client consumes its own contract; it need not adopt web presentation.
2. **View models and selectors:** collection views receive ordered identities and only the fields/state they render. Derived selection, save and playing state have clear update scope. Expensive pure derivations may move to a worker after measurement; the UI does not rebuild full data projections on each presentation clock update.
3. **Collection renderer:** one supported integration for fixed rows, variable rows and grids, each with scroll ownership, keys, estimates, render-ahead, restoration and focus policy. It may continue to use TanStack. It is not responsible for playback decisions or fetching each row's domain metadata.
4. **Presentation primitives:** shared track/entity row anatomy, controls, menus, fields, sheets, empty/loading/error states and artwork. Density and input-capability variants are explicit. Layout variants compose these patterns rather than cloning their behavior.
5. **Surface and theme system:** semantic tokens and a few surface recipes establish hierarchy, contrast, motion and compositing policy. Opaque, tinted artwork and small live-backdrop surfaces have distinct purposes. CSS modules remain a suitable implementation.
6. **Evidence and enforcement:** component examples, static adoption checks, visual/accessibility tests, collection invariants and device-level performance budgets make these contracts reviewable. Diagnostics distinguish main-thread, content-readiness and graphics failures.

The intended replacement is the collection of ad hoc rendering and pattern policies, not automatically the language, router, styling technology or native containers. Hash routing is not implicated by the researched scroll mechanisms. SSR, server components, a BFF or microfrontends should enter only for independently demonstrated loading, data or organizational needs.

## Ordered recommendations: keep, change or replace

### 1. Change: define performance acceptance before changing the renderer

**Expected effect, hypothesis:** makes the largest source of missed frames distinguishable and prevents spending the rewrite budget on the wrong layer. It does not itself increase FPS. **Basis:** [S03], [S12], [S20], [S33], [S34], [R18].

**Verify:** after the concurrent measurement review finishes, record repeatable journeys on the X270 and desktop, then real iPhone PWA, Android WebView and Windows WebView2. Include long songs, artists/albums, mixed search and queue; player open/closed; playing/paused; cold/warm artwork; rapid wheel/flick and a normal reading scroll. Record source commit, production/development mode, OS/runtime version, viewport/DPR, display refresh rate, GPU acceleration and cache state. Use synthetic data or isolated fixtures, never an account-bearing public trace.

Capture separate input/scroll offsets, virtual-window readiness, JS and style/layout work, paint/raster/decode, compositor presentation and memory. At 60 Hz the full refresh interval is about 16.7 ms; that is not an application-JS allowance [S34]. rAF intervals, draw calls and presented frames must not be reported as the same metric. INP supplements this work but cannot stand in for scrolling. Use trace/frame evidence plus a short visual capture for stalls; do not rely on average FPS alone.

### 2. Keep TanStack provisionally; replace the parallel list integrations with one collection contract

**Expected effect, hypothesis:** reduces inconsistent mount/measurement behavior and makes DOM/layout work scale with viewport size instead of full collection size. **Basis:** [S23], [S46], [S53], [R01]–[R04], [R19], [R20].

**Verify:** migrate one fixed song list and one large grid first, with identical visuals. Demonstrate that increasing total items at fixed viewport size leaves mounted item count bounded; document the overscan/memory/blanking tradeoff. Test prepend, append, filter, sort, resize, interface scale, late font load, empty-to-populated state and scroll-return. Exercise duplicates with occurrence keys, keyboard focus and held/dragged rows. Avoid synchronously remounting a whole collection during an active scroll. Preserve the existing desktop overflow fix unless a controlled replacement proves equal or better behavior; do not copy it blindly into mobile's horizontal pager.

Retain ordinary DOM for small finite sections. Use `content-visibility`/intrinsic estimates for appropriate long heterogeneous sections when retaining DOM is useful. Do not combine windowing and visibility skipping on the same slots without evidence that their two estimation systems cooperate.

### 3. Change: make the row an inexpensive, shared presentation pattern

**Expected effect, hypothesis:** lowers repeated per-item work and removes behavioral drift between library, search, browsing and queue surfaces. **Basis:** [S05], [S35], [S37], [R05], [R11], [R21].

**Verify:** a playhead/progress update should not recompute every row's static title, artwork identity or menu description. A favorite or current-track change should update the appropriate displayed states without rebuilding the collection. Instrument mounts/disposals and high-frequency derivations, not just React-style “render counts.” Cover domain-to-row mapping, playback-versus-navigation activation, disabled/loading/saved state, long press, keyboard menu, drag and text selection. Share interaction logic while allowing a deliberate desktop/mobile anatomy.

### 4. Keep the artwork backend; change and unify its frontend contract

**Expected effect, hypothesis:** more predictable first-visible covers, less excess decode/texture work and consistent fallback behavior. It may not improve a warm text/geometry bottleneck. **Basis:** [S09], [S27]–[S29], [S41], [R06], [R07], [R22].

**Verify:** compare the current row background with a fixed-geometry image primitive using the same cache identity and selected pixels. Measure bytes, requested dimensions versus displayed size × DPR, decode time, repeated mount behavior, blank duration and memory. Provide fixed size hints where known instead of automatically adding one ResizeObserver per cover. Keep eager visible artwork and bounded lookahead; use a placeholder until an asynchronously prepared replacement is ready, with cancellation/stale-identity protection.

Try alternative formats only as a controlled pipeline experiment with visual parity and decode measurements. `loading="lazy"`, `decoding="async"`, or `decode()` alone is not an architecture or a guaranteed win. A session URL having loaded previously is not proof that its decoded pixels remain resident.

### 5. Change: formalize the existing material/motion policy and test its actual composition

**Expected effect, hypothesis:** limits repeat rendering and produces consistent hierarchy without abandoning translucent surfaces. **Basis:** [S18], [S26], [S56], [R08]–[R10], [R18].

**Verify:** start from the current one-veil stage. Inspect repaint regions, tiles/layers and render passes with motion active [S61]. Compare equivalent current, static/preprocessed-background and bounded-live-backdrop variants only where traces point. Test bright/dark artwork and every theme, reduction preferences, resizing and return from full player. Check computed style, captured pixels and timing separately: declared support does not prove correct appearance, and correct appearance does not prove low cost.

Avoid blanket blur removal, blanket promotion, forced low-frequency interaction feedback or a user-facing “performance mode” that merely hides the unresolved default problem. If a decorative feature cannot meet the device budget, design a coherent adaptive recipe and verify its visual and accessibility equivalence.

### 6. Keep semantic tokens/CSS modules; change governance and pattern ownership

**Expected effect, hypothesis:** improves polish and reduces the rate at which inconsistencies return. **Basis:** [S05], [S54]–[S57], [R10], [R25], [R26].

**Verify:** create an authoritative current component/pattern catalog with one owner per pattern and examples of all states. Start with rows, icon buttons, menus/sheets, search fields, entity headers, navigation, artwork and material surfaces. Define what changes by density/input capability and what never changes semantically. Distinguish reference values, roles and component overrides only where the distinction helps safe change; avoid generating a second decorative token vocabulary.

Add scoped static enforcement for new raw visual values and banned duplicate patterns, with explicit exceptions for intentional geometry/artwork. Track actual component adoption. Add visual fixtures across themes, interface scale, long/localized text, focus, reduced motion, high contrast, touch and pointer layouts. Keep the existing four-profile browser gate. A gallery without adoption checks would repeat the old problem.

Material's token organization is useful; wholesale adoption of its component package is not implied. The retrieved Material Web repository itself warns that it is in maintenance mode pending maintainers [S64].

### 7. Keep shared web delivery; change platform testing from nominal engines to supported runtime contracts

**Expected effect, hypothesis:** fewer WebView-specific regressions and clearer responsibility for capability differences. **Basis:** [S02], [S12], [S17], [S59], [S60], [R14], [R27].

**Verify:** document minimum iOS/Safari and Android WebView versions and Windows runtime policy. Test feature fallbacks and real input paths in those shells. Record native bridge work during a flick, resume/background behavior, safe-area/keyboard resize, download/offline capability and media continuity. Existing Linux WebKit/Chromium tests remain the fast behavioral layer; device runs cover the OS/compositor integration they cannot emulate. Avoid user-agent-based “fast/slow” heuristics where a capability or measured rendering policy suffices.

### 8. Change: add low-noise performance regression gates without turning all UI tests into benchmarks

**Expected effect, hypothesis:** sustained improvements survive later design and feature work. **Basis:** [S03], [S34], [S58], [R09], [R14], [R15].

**Verify:** use cheap CI invariants for DOM growth, mount churn, unexpected geometry changes, oversized imagery and unrelated high-frequency subscriptions. Add a small, pinned performance suite with committed fixtures and trace artifacts. Establish variance on a stable runner before choosing regression thresholds; supplement with scheduled or release-time real-device journeys. Repeated controls and current/baseline alternation matter more than a single “green FPS” number.

Budget visible-content stalls and frame-time tails as well as resource use. Long Tasks/LoAF can expose severe renderer blockage where supported, but neither proves that every refresh was delivered. Do not gate ordinary PRs on noisy one-off GPU numbers from heterogeneous hosted runners. Keep correctness, accessibility, visual and graphical-performance results separate.

### 9. Replace selectively only after the relevant boundary fails the contract

**Expected effect, conditional:** allows a real foundational replacement when evidence supports it, while avoiding an unsupported framework rewrite. **Basis:** [S35], [S40], [S43], [S45]–[S53].

**Verify:** if the shared virtualizer cannot meet geometry/focus/render-ahead requirements, compare alternatives behind the same collection API. If a reduced DOM/CSS reference still fails in a specific embedded runtime, investigate its scrolling/compositing path and runtime support before porting the app. If substantial unavoidable Solid/runtime work dominates, use the controlled framework experiment above. If a native surface wins, include accessibility, interaction parity, two implementations and long-term maintenance in the acceptance decision. The verdict is not “never replace”; it is “replace the layer for which there is evidence.”

## Open questions and the evidence that would settle them

| Question | What would settle it |
| --- | --- |
| During the reported freeze, does the scroll offset stop, does content go blank, or are complete frames delayed? | Correlated native-input, scroll/virtual-range, browser trace and presented-frame recording on the actual affected surface. These symptoms select different mechanisms. |
| Which part dominates warm-cache scrolling on the current commit? | Main/compositor/raster tracks with images already resident and controls that preserve geometry. The historical scroll report narrows the question but does not answer it for all views. |
| Is the virtual window producing rows too late or producing too much work? | Timestamp range changes, mounts/disposals, row readiness and paints; compare overscan/row-cost controls at identical velocity. An increased overscan can hide one failure and worsen another. |
| Which currently non-windowed collections can actually become large? | Data-contract limits plus fixture sizes for artists, albums, remote sections, podcasts and playlists. Direct `For` alone does not prove a production scalability failure. |
| How much cold-image delay is network, variant generation, decode or reveal policy? | Resource timing, chosen candidate dimensions, decode/raster attribution and a bounded decoded-lookahead experiment. Compare CSS-background and image-element rows with equivalent imagery. |
| Are per-cover geometry observers or broad reactive derivations materially expensive? | Trace attribution plus mount/update counters on the target list; hold the rest of the render tree fixed. Source presence alone is insufficient. |
| Does current backdrop composition repeatedly rasterize or merely recomposite cached content? | Actual layer/tile/render-pass traces under scrolling and playback, with same-pixel static and filtered controls. CSS declarations and average GPU utilization cannot settle this. |
| What exact OS/WebView versions and acceleration paths are supported and affected? | A device/runtime inventory and traces from the real PWA/System WebView/WebView2. Browser brands alone are not enough. |
| Is a framework's necessary cost a material part of the budget? | Equivalent production-renderer micro-prototypes and end-to-end journeys, holding the DOM/CSS/media contract constant. A generic table leaderboard cannot settle this. |
| Which UI differences are intentional adaptations, and which are drift? | A reviewed interaction/anatomy contract and rendered state matrix. This research did not perform a visual usability audit or claim to rank individual screens' aesthetics. |
| How do current YouTube home/search and Spotify playlist renderers recycle and schedule work? | A recent first-party account/source, or a narrowly scoped authorized logged-out DOM identity experiment with observations explicitly limited to that version, cohort and surface. Custom tag names and library strings alone do not settle it. |
| What are Apple Music, YouTube Music and Deezer's current list/compositing internals? | Suitable primary implementation material or controlled current observation. This remains an evidence gap; no conclusions about them are inferred from recruitment ads or third-party framework detectors. |

## Source register and strength

All external items below are **sourced**. They were consulted on 2026-11-16. Dates identify publication or the versioned material where known, not a claim that the implementation still matches in every detail.

**Primary product-engineering accounts.** Strong evidence that the company used the described architecture at the reported time; reported improvements are not independently reproduced here.

- [S01] — Spotify, *Building Spotify's New Web Player* (2019): React/Redux SPA, replacing isolated views; historical.
- [S02] — Spotify, *Building the Future of Our Desktop Apps* (2021): shared web/CEF UI and Platform APIs; historical.
- [S03] — Spotify, *From Development to Real Users* (2022): Lighthouse CI, field monitoring and journey-specific work; metrics terminology in that article is historical.
- [S04] — Encore introduction (2019), preserved by its author Shaun Bent: primary-author copy, not a current public component API.
- [S05] — Encore retrospective (2022), preserved by its coauthor: semantic tokens, reusable components, automation, adoption and standardization lessons. Strong primary-author evidence; current org structure unverified.
- [S06] — Spotify for Artists facade-pattern account (2024): local systems over a shared foundation; a different Spotify product, not proof of consumer-player internals.
- [S07] — YouTube's Polymer/Material announcement (2017): strong for historical stack and design goals, weak for current implementation/performance.
- [S08] — YouTube's SPF repository: primary implementation/documentation of fragment navigation; historical, not today's feed spec.
- [S09] — Chromium's YouTube WebP deployment report (2014): primary company-reported image/page-load result, not current scrolling evidence.
- [S10], [S11] — YouTube Help: authoritative public descriptions of inline playback and previews; no private scheduling/virtualization detail.
- [S35] — Netflix web playback modernization (2018): direct engineering retrospective. Direct HTTP fetch returned 403; the search reader supplied the article text. Strong historical evidence, distinct from Netflix TV.
- [S36] — Netflix React-Gibbon TV account (2017): custom-renderer evidence. Direct HTTP fetch returned 403; read through the search reader. Not DOM-browser evidence.
- [S37] — Twitch web chat performance (2016): explicit method and optimizations; historical Ember-specific costs are not modern Solid costs.
- [S38] — SoundCloud's Next web architecture (2012): shared views/models and lifetime management; historical.
- [S39] — SoundCloud Redux GC (2019): Xbox-client constraints and normalized-cache lifetime; not evidence that main web uses that exact implementation.
- [S40] — Discord mobile performance (2025): separates native/React Native changes from desktop; reported numbers not reproduced or transferred here.
- [S41] — Discord image formats (2025): cross-platform media pipeline and platform decoder tradeoffs; native-iOS decoder work is not a WebKit patch available to this app.
- [S42] — Meta's Facebook.com rebuild (2020): CSS/data/navigation practices; historical at a much larger organizational scale.

**Engine documentation, source and standards.** Strong for the documented model or normative semantics; not proof that an optimization will help this particular composition. Moving source branches were inspected on the research date, not pinned to the installed browser binary.

- [S12] — Chromium RenderingNG architecture: modern pipeline, threads, video and Android WebView draw integration.
- [S13] — Chrome's input/compositor explainer (2018): event-region/passive/touch-action model; historical explanatory terminology.
- [S14] — Chromium GPU compositing design document: valuable layer-squashing explanation but older object names/heuristics; subordinate to RenderingNG for current architecture.
- [S15] — Chromium *Anatomy of Jank*: synchronization/raster diagnostic concepts; older trace examples.
- [S16] — WebKit `ScrollingCoordinatorTypes.h`: synchronous-scrolling reason enum in moving `main` source.
- [S17] — WebKit iOS `RemoteScrollingCoordinatorProxyIOS.mm`: actual platform-specific coordinator source in moving `main`.
- [S18] — WebKit backdrop-filter introduction (2015): filter/render-pass mechanism and explicit performance warning; shipping support dates updated from newer release notes.
- [S19] — WebKit Safari 18 release account (2024): `content-visibility` and unprefixed backdrop filter.
- [S20], [S21] — Mozilla source documentation: APZ/displayport and WebRender rendering/caching architecture.
- [S24] — CSS Containment Level 2: normative containment semantics; performance benefit remains workload-dependent.
- [S31] — WebKit Safari 26 release account (2025): shipped scroll-driven animation support; not a guarantee that every effect executes off the main thread.
- [S65] — HTML Standard image algorithms: primary semantics supplementing the API guidance below.
- [S67] — WebKit image-frame work queue at commit `98bd399284d49c61001e4b3f2d2d93f2c05fbc6b` (July 2026): pinned implementation evidence, not an installed-Safari default-policy guarantee. Current moving paths had changed, so the pinned source is cited explicitly.
- [S68], [S69] — Mozilla `DecodePool.cpp` and `RasterImage.cpp` in moving Firefox `main`: primary scheduling/path-selection evidence, not a guarantee that every image request follows an asynchronous path.

**API/tool/framework guidance.** Strong for semantics and supported technique; vendor demonstrations are not product deployment evidence or independent comparisons.

- [S22] — web.dev, content visibility; demo-specific gains are not reused here.
- [S23] — web.dev, list windowing with react-window; generic technique, not proof Spotify uses that package.
- [S25] — web.dev, layout complexity and layout thrashing.
- [S26] — MDN, `will-change`; maintained API guidance, not an engine-specific layer guarantee.
- [S27] — web.dev, browser image lazy loading.
- [S28], [S29] — MDN, image decode promise and decoding hint; supported by [S65].
- [S30] — Chrome scroll-animation performance case study; controlled vendor demo, not universal browser performance.
- [S32] — Chrome View Transition documentation; snapshot model and API behavior.
- [S33] — web.dev INP documentation, especially its explicit exclusion of scrolling/hovering.
- [S34] — Chrome Long Animation Frames documentation, including scope and 50 ms threshold.
- [S43] — independent `js-framework-benchmark` source/README: inspectable methodology and caveats; no app-specific result.
- [S44] — dated official Chrome 146 benchmark archive: a reproducible reference; client-rendered numerical data were not extracted in this review.
- [S45], [S46], [S66] — Solid fine-grained reactivity and `For`/`Index` reference documentation. API reference is used for exact identity behavior rather than loose “rerender” language in the concepts page.
- [S47] — React render/commit documentation; mechanism, not a benchmark.
- [S48] — Svelte 5 migration guide; runes/reactivity model, not a comparative result.
- [S49], [S50] — Vue rendering guide and Vapor's repository. The archived Vapor repo points to core; it is not a current release-status authority.
- [S51], [S52] — Lit list documentation and Labs virtualizer README; explicit package maturity caveat retained.
- [S53] — TanStack Virtual API reference; current online docs may describe features newer than the project's pinned dependency. Only the general key/overscan contract is relied on.
- [S54] — Material Web theming source: reference/system/component tokens. This is a primary accessible alternative to the client-rendered Material website.
- [S55] — Atlassian `ensure-design-token-usage` rule: primary enforcement example. The generic token landing page had no extractable text; this specific rule page was readable.
- [S56], [S57] — Apple HIG materials and layout, including readable Markdown versions. Strong design guidance, primarily native-platform recommendations; not implementation evidence for Apple Music web.
- [S58] — web.dev build-time budget guidance: CI mechanism, not a substitute for sustained graphical measurements.
- [S59] — Microsoft WebView2 runtime distribution guidance; authoritative version-policy distinction.
- [S60] — Chrome WebView remote-debugging documentation; tooling availability, not a measurement made here.
- [S61] — Chrome rendering diagnostics: paint flashing, layer/tile borders and frame presentation categories.
- [S64] — Material Web repository maintenance notice; reason to separate design-system lessons from package adoption.

**Narrow or weak evidence, not used to justify rendering claims.**

- [S62] — Apple services UI-engineer job description: primary hiring material but weak evidence of a specific shipped framework. Third-party “made with Svelte”/older Ember reports were not promoted to facts about current Music web.
- [S63] — Deezer 2023 annual report: primary corporate disclosure of infrastructure/CDN usage, encountered via search extraction. No list/scroll implementation claim is derived from it.
- Excluded as implementation proof: unsourced social-media percentages, framework detectors, clones, generic interview system designs, userscript internals and bug-forum anecdotes. They can suggest a follow-up question but cannot establish current production architecture.

## Repository evidence locations

All items below are **read** at the baseline commit. Links open the source at the indicated line; the surrounding implementations and the named ranges described in the findings were inspected.

| Reference | Location and what it establishes |
| --- | --- |
| [R01] | `TrackList.tsx:59–136`: independent virtualizer, estimates, overscan, translated slots and reactive item access. |
| [R02] | `VirtualRows.tsx:30–145`: layout-epoch remount, initial rectangle/offset, range extraction and slot renderer. |
| [R03] | `VirtualBrowseRows.tsx:13–28`: another virtualizer and inline scroll geometry. |
| [R04] | `LibrarySearchResults.tsx:82–145`: separate mixed-result virtualizer and row composition. |
| [R05] | `SongRow.tsx:115–154`: mobile/desktop split and desktop background cover. |
| [R06] | `CoverImage.tsx:29–62`: observed width, responsive candidates, loading/decoding hints and fallback. |
| [R07] | `cover.ts:24–33`: CSS-background layering helper. |
| [R08] | `PlayerSurface.module.css:101–178`: backdrop, veil, grain, transform hint and drift. |
| [R09] | `player-rendering.spec.ts:13–112`: appearance/motion contracts and current single-veil assertion. |
| [R10] | `tokens.css:7–165`: semantic roles and glass fallback recipe; later theme/stage sections were also inspected. |
| [R11] | `PlayerTrackList.tsx:117–218`: queue presentation/edit/drag state and virtualization option. |
| [R12] | `main.tsx:1–59`: shared entry, global presentation preferences and page lifecycle. |
| [R13] | `app.tsx:18–53`: persistent shell and player surface. |
| [R14] | `playwright.config.ts:8–63`: screenshot/motion defaults and four engine/layout profiles. |
| [R15] | `.github/workflows/ci.yml:421–492`: browser profile matrix and aggregate gate. |
| [R16] | `PlayerWorkspace.module.css:43–79`: horizontal native snap pager and axis policy. |
| [R17] | `NowPlayingBrowser.module.css:99–114`: overflow and desktop scrollbar reservation. |
| [R18] | `player-song-scroll.md:16–55`: historical X270 experiment and explicit remaining-lag/measurement limits. |
| [R19] | `ArtistGrid.tsx:15–31`: one card per supplied artist. |
| [R20] | `NowPlayingBrowser.tsx:919` and nearby branches: mixed virtual/nonvirtual strategies; search rendering at 1224–1237. |
| [R21] | `MusicListRowView.tsx:96–149`: shared mobile row anatomy and background artwork. |
| [R22] | `media.ts:53–74,95–133`: responsive variant generation, revision-aware cover identity and row thumbnail helper. |
| [R23] | `navigation-paint.spec.ts:6–49`: first-frame return state and scroll-restoration assertions. |
| [R24] | `PERFORMANCE.md:70–137`: historical graphics experiments, platform differences and limits. |
| [R25] | `DESIGN.md:7–10`: consumer-shell scope, not a complete current web pattern specification. |
| [R26] | `UI_REBUILD_PLAN.md:3–25`: older design/toolchain stage; historical, not current performance proof. |
| [R27] | `mobile/main.tsx:1–23`: Android entry and shared token/global styles. |
| [R28] | `responsiveTap.ts:15–27,59–149`: gesture ownership, cancel/reset and virtualized-row cleanup behavior. |
| [R29] | `NowPlayingBrowser.tsx:155–170`: dimension reads and dataset writes in an overflow-marker scroll handler. |
| [R30] | `package.json:17–40`: declared framework/runtime/library dependencies. |

[S01]: https://engineering.atspotify.com/2019/3/building-spotifys-new-web-player
[S02]: https://engineering.atspotify.com/2021/4/building-the-future-of-our-desktop-apps
[S03]: https://engineering.atspotify.com/2022/09/from-development-to-real-users-how-to-create-a-web-performance-story
[S04]: https://www.shaunbent.co.uk/blog/reimagining-design-systems-at-spotify/
[S05]: https://www.shaunbent.co.uk/blog/encore-design-system-three-years-on/
[S06]: https://engineering.atspotify.com/2024/02/applying-the-facade-pattern-on-spotify-for-artists
[S07]: https://blog.youtube/news-and-events/a-sneak-peek-at-youtubes-new-look-and/
[S08]: https://github.com/youtube/spfjs
[S09]: https://blog.chromium.org/2014/03/webp-improves-while-rolling-out-across.html
[S10]: https://support.google.com/youtube/answer/7640367?co=GENIE.Platform%3DDesktop&hl=en
[S11]: https://support.google.com/youtube/answer/7074781?hl=en
[S12]: https://developer.chrome.com/docs/chromium/renderingng-architecture
[S13]: https://developer.chrome.com/blog/inside-browser-part4/
[S14]: https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/
[S15]: https://www.chromium.org/developers/how-tos/trace-event-profiling-tool/anatomy-of-jank/
[S16]: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/scrolling/ScrollingCoordinatorTypes.h
[S17]: https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/RemoteLayerTree/ios/RemoteScrollingCoordinatorProxyIOS.mm
[S18]: https://webkit.org/blog/3632/introducing-backdrop-filters/
[S19]: https://webkit.org/blog/15865/webkit-features-in-safari-18-0/
[S20]: https://firefox-source-docs.mozilla.org/gfx/AsyncPanZoom.html
[S21]: https://firefox-source-docs.mozilla.org/gfx/RenderingOverview.html
[S22]: https://web.dev/articles/content-visibility
[S23]: https://web.dev/articles/virtualize-long-lists-react-window
[S24]: https://www.w3.org/TR/css-contain-2/
[S25]: https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing
[S26]: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/will-change
[S27]: https://web.dev/articles/browser-level-image-lazy-loading
[S28]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode
[S29]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decoding
[S30]: https://developer.chrome.com/blog/scroll-animation-performance-case-study/
[S31]: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
[S32]: https://developer.chrome.com/docs/web-platform/view-transitions/
[S33]: https://web.dev/articles/inp
[S34]: https://developer.chrome.com/docs/web-platform/long-animation-frames
[S35]: https://netflixtechblog.com/modernizing-the-web-playback-ui-1ad2f184a5a0
[S36]: https://netflixtechblog.com/crafting-a-high-performance-tv-user-interface-using-react-3350e5a6ad3b
[S37]: https://blog.twitch.tv/en/2016/08/08/improving-chat-rendering-performance-1c0945b82764/
[S38]: https://developers.soundcloud.com/blog/building-the-next-soundcloud/
[S39]: https://developers.soundcloud.com/blog/garbage-collection-in-redux-applications/
[S40]: https://discord.com/blog/supercharging-discord-mobile-our-journey-to-a-faster-app
[S41]: https://discord.com/blog/modern-image-formats-at-discord-supporting-webp-and-avif
[S42]: https://engineering.fb.com/2020/05/08/web/facebook-redesign/
[S43]: https://github.com/krausest/js-framework-benchmark/blob/master/README.md
[S44]: https://krausest.github.io/js-framework-benchmark/2026/chrome146_260401.html
[S45]: https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity
[S46]: https://docs.solidjs.com/reference/components/for
[S47]: https://react.dev/learn/render-and-commit
[S48]: https://svelte.dev/docs/svelte/v5-migration-guide
[S49]: https://vuejs.org/guide/extras/rendering-mechanism.html
[S50]: https://github.com/vuejs/vue-vapor
[S51]: https://lit.dev/docs/templates/lists/
[S52]: https://github.com/lit/lit/tree/main/packages/labs/virtualizer
[S53]: https://tanstack.com/virtual/latest/docs/api/virtualizer
[S54]: https://github.com/material-components/material-web/blob/main/docs/theming/README.md
[S55]: https://atlassian.design/components/eslint-plugin-design-system/ensure-design-token-usage/usage
[S56]: https://developer.apple.com/design/human-interface-guidelines/materials.md
[S57]: https://developer.apple.com/design/human-interface-guidelines/layout.md
[S58]: https://web.dev/articles/incorporate-performance-budgets-into-your-build-tools
[S59]: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version
[S60]: https://developer.chrome.com/docs/devtools/remote-debugging/webviews/
[S61]: https://developer.chrome.com/docs/devtools/rendering/performance
[S62]: https://jobs.apple.com/en-us/details/200597002/ui-engineer-apple-services-engineering
[S63]: https://www.deezer-investors.com/wp-content/uploads/2024/04/DZR2023_DEEZER_URD_EN_2024_04_30pdf.pdf
[S64]: https://github.com/material-components/material-web
[S65]: https://html.spec.whatwg.org/multipage/embedded-content.html#decoding-images
[S66]: https://docs.solidjs.com/reference/components/index-component
[S67]: https://github.com/WebKit/WebKit/blob/98bd399284d49c61001e4b3f2d2d93f2c05fbc6b/Source/WebCore/platform/graphics/ImageFrameWorkQueue.cpp
[S68]: https://github.com/mozilla-firefox/firefox/blob/main/image/DecodePool.cpp
[S69]: https://github.com/mozilla-firefox/firefox/blob/main/image/RasterImage.cpp
[R01]: ui_web/src/components/TrackList.tsx:59
[R02]: ui_web/src/components/VirtualRows.tsx:30
[R03]: ui_web/src/components/VirtualBrowseRows.tsx:13
[R04]: ui_web/src/components/LibrarySearchResults.tsx:82
[R05]: ui_web/src/components/SongRow.tsx:115
[R06]: ui_web/src/components/CoverImage.tsx:29
[R07]: ui_web/src/lib/cover.ts:24
[R08]: ui_web/src/components/PlayerSurface.module.css:101
[R09]: ui_web/tests/browser/player-rendering.spec.ts:13
[R10]: ui_web/src/styles/tokens.css:7
[R11]: ui_web/src/components/PlayerTrackList.tsx:117
[R12]: ui_web/src/main.tsx:1
[R13]: ui_web/src/app.tsx:18
[R14]: ui_web/playwright.config.ts:8
[R15]: .github/workflows/ci.yml:421
[R16]: ui_web/src/components/PlayerWorkspace.module.css:43
[R17]: ui_web/src/components/NowPlayingBrowser.module.css:99
[R18]: docs/internal/performance/player-song-scroll.md:16
[R19]: ui_web/src/components/ArtistGrid.tsx:15
[R20]: ui_web/src/components/NowPlayingBrowser.tsx:919
[R21]: ui_web/src/components/MusicListRowView.tsx:96
[R22]: ui_web/src/lib/media.ts:53
[R23]: ui_web/tests/browser/navigation-paint.spec.ts:6
[R24]: docs/internal/PERFORMANCE.md:70
[R25]: DESIGN.md:7
[R26]: docs/internal/UI_REBUILD_PLAN.md:3
[R27]: ui_web/src/mobile/main.tsx:1
[R28]: ui_web/src/lib/responsiveTap.ts:15
[R29]: ui_web/src/components/NowPlayingBrowser.tsx:155
[R30]: ui_web/package.json:17

