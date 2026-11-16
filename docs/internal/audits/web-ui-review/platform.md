# Platform, engine and runtime architecture review

> Imported from an independent review of `00fd7d0a` (2026-11-16). Only links were rewritten. Scripts, traces, screenshots and data files it names stayed in the reviewer's working directory and are not part of the repository. Read [the handoff](../WEB_UI_REVIEW_HANDOFF.md) first: it records which findings were verified, refuted or reclassified afterwards.

Review date: 2026-11-16. Independent, read-only review of commit 00fd7d0ae3b0d48e610d8643d6e6614e5ece63ed on docs/web-ui-architecture-review.

## 1. Summary verdict

1. **Keep the Solid DOM UI as the universal client; substantially strengthen its rendering and platform contracts.** A native wrapper is not a faster list renderer by itself.
2. Target shared domain models, presentation components and design tokens, with explicit asynchronous adapters for playback, storage, networking, lifecycle, sharing and host geometry.
3. Keep browser/PWA delivery first-class across Chromium, WebKit and Gecko: every station must still serve an install-free client.
4. Keep Android's locally packaged Solid UI and native media/offline services; measure its System WebView presentation independently from Chrome.
5. Keep Windows Tauri/WebView2 provisionally for its installation and desktop integration benefits; require measured benefits over the PWA.
6. Keep Linux browser-only. A future macOS Tauri app would use WKWebView, not Chromium, and needs its own justification.
7. Do not adopt Electron/CEF as a platform-wide performance cure: it standardizes desktop engine versions, not browser/mobile delivery or application work.
8. Native or cross-platform-rendered lists are credible escalation options after a controlled prototype proves a durable advantage and includes their maintenance cost.
9. The current evidence does not establish the cause of the owner's desktop freeze. It does justify investigating application rendering work, blocking touch dispatch and actual GPU/runtime configuration before a framework rewrite.

These are recommendations inferred from the **read**, **measured** and **sourced** evidence below, rather than a measured ranking of alternative implementations.

## 2. Scope and evidence boundary

- **Measured:** git branch --show-current and git rev-parse HEAD confirmed the branch and commit above. git status --porcelain was empty before and after inspection. No repository files were changed. The locally cached origin/main reference read 77811eab2bfa5b8490d361f8ced6b6021b9eace0 later in this review; the brief's equality with origin/main is no longer true of that local reference. This report remains about HEAD 00fd7d0a. No fetch or remote-history assumption was used.
- **Read:** AGENTS.md, the architecture and engineering handoffs, the Android handoff/architecture, the supplied desktop/iOS/design/performance material, and the relevant source paths cited below. Historical slices and comments were treated as recorded observations, not current runtime proof.
- **Measured:** two small, sequential, offline Playwright capability probes. Chromium ran locally; WebKit ran in the already-installed v1.64.0-noble Playwright image, with the repository mounted read-only and Docker networking disabled. They used synthetic HTML, no Vite server, no real account, no station request, no scrolling benchmark and no external asset.
- No build, Gradle task, emulator, long browser suite, performance stress test or request to port 5005 was run. No process belonging to another person or reviewer was stopped.
- **Sourced:** primary vendor/framework documentation, standards and release notes accessed during this review; links are attached to claims. Framework maturity statements are snapshots, not promises.
- **Unverified:** actual iPhone/PWA presentation, Android hardware, installed Windows WebView2, the user's GPUs/drivers, physical background-audio behavior, and the owner's comparative frame rates. No claim below turns the owner's report or a historical repository measurement into a measurement performed here.

Evidence labels mean: **measured** = executed here; **read** = repository/dependency file and line; **sourced** = linked external primary source. “Inference” and “expected effect” explicitly identify conclusions that have not been measured.

### Lightweight probe: results and limits

**Measured:** `capability-probe.cjs`, Chromium output (`chromium-capabilities.json`, not imported), WebKit output (`webkit-capabilities.json`, not imported).

| Synthetic check | Chromium 156.0.8078.4 | Playwright Linux WebKit 27.2 | What this settles |
| --- | --- | --- | --- |
| Standard backdrop-filter parses/computes | true / blur(4px) | true / blur(4px) | Both accept the standard property. |
| Prefixed-only -webkit-backdrop-filter | unsupported; standard computed value none | supported; computed blur(4px) | A prefix alone does not preserve Chromium rendering. |
| 100dvh, scrollbar-gutter:stable, scrollbar-width:thin | All report supported | All report supported | Parsing support alone cannot establish equivalent geometry. |
| 200px overflow:scroll box, offsetWidth minus clientWidth | 0px | 0px | These headless configurations initially use no allocated vertical gutter. |
| Same box with scrollbar-gutter:stable | 15px | 0px | This configuration produces different layout despite support detection succeeding. |
| Same box with thin plus a 10px WebKit scrollbar rule | 0px gutter | 0px gutter | A CSS scrollbar width is not a portable measurement of reserved layout space. |

These are computed-style/geometry results, not a pixel comparison, compositing test, production bug reproduction or speed result. The WebKit UA identifies itself as Macintosh although execution was Linux; neither the UA nor browser.version() establishes the Apple OS build. audioSession and serviceWorker also returned false in the synthetic about:blank context; those values are deliberately **not** used to infer production support, because origin/security context and port matter.

Reproduce with OUT set to this report's directory and REPO set to the reviewed repository:

    PW_MODULE="$REPO/ui_web/node_modules/playwright" node "$OUT/capability-probe.cjs" chromium
    docker run --rm --network none --ipc host \
      -v "$REPO:/work:ro" -v "$OUT:/probe:ro" -w /work/ui_web \
      -e PW_MODULE=/work/ui_web/node_modules/playwright \
      mcr.microsoft.com/playwright:v1.64.0-noble \
      node /probe/capability-probe.cjs webkit

## 3. Current surface/runtime matrix

“Evergreen” means updates can arrive independently of the application; it does not mean users cannot disable updates, an OS never ages out, or all devices use the same build.

| Surface | Rendering / JavaScript engine and update policy | What the host adds | What it does not add | Evidence |
| --- | --- | --- | --- | --- |
| Browser / desktop PWA, Windows/Linux/macOS | User's browser: Blink/V8 in Chromium, Gecko/SpiderMonkey in Firefox, WebKit/JavaScriptCore in Safari. Chromium/Firefox normally update separately (Linux distributor packages follow their distributor); Safari availability depends on Apple's supported OS/Safari combinations. | Installation/window presentation where the browser supports it; browser media controls and origin-bound web storage. | No mandated common renderer; installation does not turn DOM lists into OS lists or provide an Android-style media service. | **Read:** [main.tsx:1](../../../../ui_web/src/main.tsx#L1), [pwa.ts:28](../../../../ui_web/src/lib/pwa.ts#L28), [DESKTOP_BETA.md:28](../../../../docs/DESKTOP_BETA.md#L28). **Sourced:** [S1], [S4], [S39], [S40]. |
| iPhone / iPad Home Screen PWA | System WebKit/JavaScriptCore for the Safari/Home Screen path under review; engine fixes follow the OS distribution, not a station UI release. | Standalone presentation, safe-area environment, supported web media/session/storage capabilities. | No native media-service contract, arbitrary background JS lifetime, native offline-file ownership or full platform API access merely by installing the icon. | **Read:** [app.module.css:12](../../../../ui_web/src/app.module.css#L12), [audio/transport.ts:154](../../../../ui_web/src/lib/audio/transport.ts#L154). **Sourced:** [S4], [S5], [S6], [S7]. |
| Android Capacitor 8 app | Installed Android System WebView/provider, Chromium/Blink/V8 in the normal Google provider. Normally independently updatable, but constrained by provider, OS support and update policy. Capacitor is not the engine version. The project sets a WebView 120 floor and emits for chrome120. | Locally shipped UI; Kotlin/OkHttp session and resource transport; Media3 service/native mixer, offline copies, system sharing/import/clipboard, appearance, feedback and car integration code. | DOM/CSS still render in WebView; native audio does not accelerate UI lists. It does not receive station UI changes until the APK updates. | **Read:** [capacitor.config.json:4](../../../../ui_web/capacitor.config.json#L4), [vite.android.config.ts:18](../../../../ui_web/vite.android.config.ts#L18), [MainActivity.kt:17](../../../../android/app/src/main/java/com/soundsible/android/MainActivity.kt#L17), [PlaybackService.kt:29](../../../../android/app/src/main/java/com/soundsible/android/PlaybackService.kt#L29). **Sourced:** [S2], [S8]. |
| Windows Tauri 2 app | WebView2: Microsoft's Chromium/Blink/V8 runtime. Current configuration uses Tauri's normal system runtime path, with no fixed runtime configured. Evergreen updates independently; administrative policies/offline machines remain constraints. | Engine sidecar installation/supervision, folder dialog, tray/background window lifecycle, shortcuts, deep links and appearance bridge. | No native list rendering and no current native media bridge. Playback/Media Session remain browser-owned. A bundled Python engine is not a bundled browser engine. | **Read:** [Cargo.toml:19](../../../../desktop-shell/src-tauri/Cargo.toml#L19), [tauri.conf.json:38](../../../../desktop-shell/src-tauri/tauri.conf.json#L38), [README.md:3](../../../../desktop-shell/README.md#L3), [desktop.rs:48](../../../../desktop-shell/src-tauri/src/desktop.rs#L48). **Sourced:** [S1], [S3]. |
| Native iOS app | SwiftUI/platform frameworks and AVFoundation, not the Solid DOM renderer or a WebKit UI. Framework behavior follows supported Apple OS releases. | Separate car-contract client, native audio-session, remote-command and offline code. | Not a drop-in full-feature replacement for the web UI; runtime acceptance has not happened. Do not treat an IPA build as installed/working evidence. | **Read:** [SoundsibleApp.swift:1](../../../../ios/App/SoundsibleApp.swift#L1), [AudioSessionController.swift:25](../../../../ios/App/Audio/AudioSessionController.swift#L25), [IOS.md:5](../../../../docs/IOS.md#L5), [android/ARCHITECTURE.md:43](../../../../docs/internal/android/ARCHITECTURE.md#L43). **Sourced:** [S9]. |
| Hypothetical Tauri 2 macOS app | WKWebView/WebKit/JavaScriptCore. System framework/Apple update policy, not bundled Chromium; do not assume installing another browser replaces WKWebView. | Potential native shell/services, subject to implementation. | No existing macOS product or proven performance benefit. | **Read:** [DESKTOP_BETA.md:25](../../../../docs/DESKTOP_BETA.md#L25). **Sourced:** [S1]. |
| Hypothetical Tauri 2 Linux app | WebKitGTK/JavaScriptCore, installed through distribution/runtime packaging. Version/codec/graphics stack depend on packaging, not the Chrome installed alongside it. | Potential native shell/services. | No existing supported Linux app; another port of WebKit is not equivalent to Safari or an installed Chromium browser. | **Read:** [DESKTOP_BETA.md:36](../../../../docs/DESKTOP_BETA.md#L36). **Sourced:** [S1], [S10]. |

**Sourced constraint:** Apple's EU alternative-engine program includes browser and embedded-browser entitlements, eligible OS/region conditions and ongoing obligations [S11]. Thus “iOS can never use another engine” is too broad. It also does not give this station-served PWA or a normal music wrapper a portable right or practical mechanism to replace Home Screen WebKit worldwide.

**Read constraint:** Android's current policy is feature parity with the best native implementation, explicitly not copying browser workarounds; pure logic/presentation are shared while the web audio-owning stores stay out of Android ([HANDOFF.md:17](../../../../docs/internal/android/HANDOFF.md#L17)). This is a sound distinction to retain.

## 4. Findings ranked by impact on the reported problem

### F1 — High: an engine/wrapper migration cannot remove the shared rendering dependency

**Read:** The station serves the same web bundle under /player/ and /player/desktop/ ([vite.config.js:34](../../../../ui_web/vite.config.js#L34)). VirtualRows derives the visible window, mounts absolute-positioned DOM rows and moves them with transforms ([VirtualRows.tsx:83](../../../../ui_web/src/components/VirtualRows.tsx#L83), [VirtualRows.tsx:118](../../../../ui_web/src/components/VirtualRows.tsx#L118)). Windows hands that UI to WebView2, rather than replacing its rendering pipeline.

**Read, historical evidence:** The X270 report recorded p95 rAF intervals dropping from 50ms to about 33.4ms in Library after a scrollbar-allocation change within the same Chrome runtime; it explicitly distinguishes those intervals from presented FPS and says lag remained ([player-song-scroll.md:18](../../../../docs/internal/performance/player-song-scroll.md#L18), [player-song-scroll.md:41](../../../../docs/internal/performance/player-song-scroll.md#L41)). I did not rerun those measurements.

**Sourced:** Chromium can scroll existing composited content without main-thread layout/paint, but new content still goes through the rendering pipeline [S12]. A visible video can take an independent decode/compositor path; visual complexity is not a reliable estimate of layout/raster work. Spotify describes a shared web UI inside CEF with platform APIs, not an all-native desktop list system [S13].

**Consequence / inference:** If the stall also occurs in the normal browser, swapping Tauri for Electron while retaining the DOM, reactive updates and image/layer topology is not a demonstrated repair. A wrapper rewrite also leaves the mandatory browser client needing the original repair. This does not exonerate the engine: a driver, renderer regression or app-triggered pathological layout can still be causal.

**Verification:** Compare identical fixtures/viewport/refresh rate in a real accelerated browser and the actual host; separate input dispatch, main-thread rendering, raster/decode and GPU presentation. Identify which work spans the freeze before choosing a new renderer.

### F2 — High for touch surfaces: broad non-passive gesture listeners can undermine independent scrolling

**Read:** PlayerSurface registers a non-passive touchmove listener on the enclosing surface ([PlayerSurface.tsx:356](../../../../ui_web/src/components/PlayerSurface.tsx#L356)). It decides between list scrolling and sheet dismissal at runtime and can preventDefault and move the entire surface ([PlayerSurface.tsx:281](../../../../ui_web/src/components/PlayerSurface.tsx#L281), [PlayerSurface.tsx:305](../../../../ui_web/src/components/PlayerSurface.tsx#L305)). Overlay sheets use a similar non-passive listener ([overlay.tsx:224](../../../../ui_web/src/lib/overlay.tsx#L224), [overlay.tsx:278](../../../../ui_web/src/lib/overlay.tsx#L278)). In contrast, scroll-history cancellation uses passive wheel/touch listeners ([scrollHistory.tsx:231](../../../../ui_web/src/lib/scrollHistory.tsx#L231)).

**Sourced:** Chromium documents synchronous touch/wheel handlers as a reason to hand input back to Blink rather than handling it entirely on the compositor [S14].

**Consequence / inference:** The current gesture design introduces a main-thread dependency over touch interaction areas that include nested scrollers. Returning early in the handler does not make the registered listener passive. This is a credible source of poor gesture responsiveness under load, not a measured attribution of the desktop wheel freeze. Exact scroll-blocking regions and latching behavior must be inspected on each engine.

**Verification:** Trace rapid list flicks while the player/sheet is open, including list top versus mid-list. Prototype dismissal confined to a header/handle or another explicitly owned region, preserving native list scrolling. Do not simply mark a handler passive while retaining preventDefault; that breaks dismissal semantics.

### F3 — High: the current four browser profiles cannot certify the shipped runtime matrix

**Read:** The four profiles are two sizes of Chromium and two sizes of Playwright WebKit; no Firefox project is present. All profiles default to reducedMotion:reduce ([playwright.config.ts:35](../../../../ui_web/playwright.config.ts#L35), [playwright.config.ts:46](../../../../ui_web/playwright.config.ts#L46)). Those checks deliberately neutralize motion and do not embed Capacitor or WebView2.

**Sourced:** Playwright's WebKit comes from current WebKit main-branch sources, can precede Safari releases, and is not the installed Safari application [S15]. WebKitGTK/WPE have their own graphics/compositor architecture [S10].

**Read:** PERFORMANCE.md records retaining nested blurs because the Linux software-composited WebKit test did not settle after their removal ([PERFORMANCE.md:103](../../../../docs/internal/PERFORMANCE.md#L103)). overlay.module.css records a different Linux WebKit blur-paint discrepancy ([overlay.module.css:130](../../../../ui_web/src/lib/overlay.module.css#L130)).

**Consequence / inference:** Functional checks are valuable, but treating every Linux WebKit failure as an iPhone graphics contract can preserve costly structures for a test-port artifact. Conversely, passing those profiles says little about real iPhone motion, installed WebView builds, GPU acceleration or scrolling under playback. Neither recorded discrepancy proves a current Safari defect.

**Verification:** Retain all four functional profiles, add a small motion-enabled rendering fixture and Firefox coverage, and keep separate acceptance on actual Safari/Home Screen PWA, Android WebView and Windows WebView2. Attribute a workaround to the affected engine build/port and minimal reproduction; remove it only after the intended devices pass.

### F4 — Medium/high for visual consistency: material behavior mixes capability detection, composition and fallback choices

**Read:** tokens.css says its opaque-enough fill was chosen because blur did not paint equivalently across tested compositions ([tokens.css:123](../../../../ui_web/src/styles/tokens.css#L123)). The overlay's fallback tests whether a property parses, while its own comment acknowledges that this cannot detect a missing painted effect ([overlay.module.css:114](../../../../ui_web/src/lib/overlay.module.css#L114)). OmniBar currently supplies both standard and prefixed declarations ([OmniBar.module.css:64](../../../../ui_web/src/components/OmniBar.module.css#L64)).

**Measured:** The probe confirmed a concrete prefix difference; it did not validate the broader comment that a particular production engine drops a blur. The earlier Firefox report about prefixed-only panels is historical, not an assertion that the same panels still contain that code.

**Sourced:** The Filter Effects draft describes backdrop capture, clipping and backdrop-root boundaries, and explicitly notes that parts of its backdrop-root definition lack working-group consensus [S16]. Parser support is a different question from correct painting or acceptable cost.

**Consequence / inference:** A uniform CSS declaration is insufficient to promise a uniform translucent composition. Nesting and opacity may change what is sampled; high fill opacity may be an intentional product fallback rather than an engine failure. These cases need separate labels. Existing broad engine statements in comments should not become permanent product doctrine.

**Verification:** Use minimal pixel fixtures with contrasting moving content, then the real panel hierarchy on supported engines. Require readable, cohesive surfaces with and without blur. Diagnose a failing composition before adding engine sniffing or a runtime pixel probe.

### F5 — Medium: the native-service boundary is useful, but it is not a shared runtime guarantee

**Read:** Android's MediaLibraryService owns the programme independently of the Activity ([PlaybackService.kt:29](../../../../android/app/src/main/java/com/soundsible/android/PlaybackService.kt#L29)); its asynchronous runtime rejects obsolete generations/sequences ([program/runtime.ts:55](../../../../ui_web/src/lib/program/runtime.ts#L55)). Windows explicitly reports media:false and retains browser Media Session ([desktop.rs:48](../../../../desktop-shell/src-tauri/src/desktop.rs#L48)). The browser's transport uses two HTMLAudioElements, Web Audio-related lifecycle handling and an optional navigator.audioSession declaration ([audio/transport.ts:100](../../../../ui_web/src/lib/audio/transport.ts#L100), [audio/transport.ts:154](../../../../ui_web/src/lib/audio/transport.ts#L154)).

**Sourced:** Android provides MediaSessionService for background playback [S8]; Apple's native playback audio-session category plus background mode enables the corresponding native capability [S9]. A service worker is event-driven and terminable, not an always-running audio scheduler [S7].

**Consequence / inference:** Keep native playback/offline ownership where already implemented. Do not promise Android's background reliability from the Windows or iPhone web path merely because controls look alike. Moving native programme control back into shared web timers would sacrifice a platform benefit without helping list rendering.

**Verification:** Suspend/recreate the UI while audio transitions, media commands and downloads continue; verify authoritative snapshots on return. Physical audio/lock/Bluetooth/car acceptance stays separate from UI/rendering checks. The native iOS code remains unverified, including the PAL distribution path ([IOS.md:5](../../../../docs/IOS.md#L5), [AGENTS.md:102](../../../../AGENTS.md#L102)).

### F6 — Medium: engine/version policy is underspecified at failure boundaries

**Read:** Android declares minSdkVersion 24 but targets the UI to chrome120 and configures minWebViewVersion 120 ([variables.gradle:1](../../../../android/variables.gradle#L1), [vite.android.config.ts:28](../../../../ui_web/vite.android.config.ts#L28), [capacitor.config.json:5](../../../../ui_web/capacitor.config.json#L5)). There is no configured server.errorPath. In the installed Capacitor dependency, a failed minimum-WebView test without that path logs an error and proceeds to load the UI (Bridge.java:305 (`ui_web/node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/Bridge.java:305`)). This dependency reading is not a device execution.

**Sourced:** Chromium M120 raised its minimum Android SDK to Oreo/API 26 [S17]. Thus stock Google Nougat providers cannot satisfy this configured UI floor, despite an APK OS floor of API 24. Non-Google providers must be assessed separately.

**Read:** nativeBuildInfo exposes app identity/version/build, not the selected WebView provider ([mobile/platform.ts:4](../../../../ui_web/src/mobile/platform.ts#L4)). Browser automatic playback diagnostics distinguish reported iOS versus “other” and display mode, not a complete renderer/host inventory ([stores/runtime.ts:129](../../../../ui_web/src/stores/runtime.ts#L129)).

**Consequence / inference:** “Works on Android” or “latest app” does not identify the engine. Below-floor installations can attempt an unsupported UI with poor recovery, and graphics reports may group unrelated runtimes. This is a concrete compatibility/recovery issue, not evidence that old WebView caused the owner's desktop stall.

**Verification:** Explicitly align the supported OS/provider floor, or provide an actionable unsupported-runtime screen. Record provider/runtime version, app/UI revision, host type, display mode, viewport/DPR and acceleration details in opt-in local diagnostics. Exercise below-floor and enterprise/offline-update cases.

### F7 — Medium for cohesion: much apparent platform divergence is an application policy, not an engine limitation

**Read:** The browser entry maintains a visualViewport height variable, while standalone app/surface CSS overrides height to 100vh ([main.tsx:27](../../../../ui_web/src/main.tsx#L27), [app.module.css:12](../../../../ui_web/src/app.module.css#L12), [PlayerSurface.module.css:491](../../../../ui_web/src/components/PlayerSurface.module.css#L491)). Android starts through a different entry/composition and uses its own 100dvh shell styles ([mobile/main.tsx:1](../../../../ui_web/src/mobile/main.tsx#L1), [AndroidStart.module.css:1](../../../../ui_web/src/mobile/AndroidStart.module.css#L1)). AppearancePlugin explicitly branches for Android 15 transparent system bars ([AppearancePlugin.kt:19](../../../../android/app/src/main/java/com/soundsible/android/AppearancePlugin.kt#L19)).

**Consequence / inference:** Shared Solid technology and tokens do not by themselves mean shared geometry, navigation or input behavior. Some differences are justified host integration; others are implementation choices. Replacing the engine does not unify these policies.

**Verification:** Define one host-geometry contract and presentation invariants: exactly one owner for each safe inset, keyboard-visible height, scroll container and back/dismiss gesture. Test browser toolbar changes, PWA launch, rotation, keyboard, Android edge-to-edge and resized Windows windows independently.

## 5. Engine/platform-specific inventory and classification

**Read:** This is a categorized inventory of the matching source, excluding test descriptions as runtime behavior. The broader raw search is saved in `ui-platform-inventory.txt`; it includes test matches and must not be used as a count of shipped workarounds.

| Pattern / location | Classification | Interpretation and concrete consequence |
| --- | --- | --- |
| -webkit-backdrop-filter beside the standard property; overlay @supports | **Engine/API compatibility + project fallback choice.** [overlay.module.css:10](../../../../ui_web/src/lib/overlay.module.css#L10), [OmniBar.module.css:64](../../../../ui_web/src/components/OmniBar.module.css#L64) | Useful prefix coverage; no assurance of painted parity. F4/probe. |
| Global thin/color plus ::-webkit-scrollbar; hidden rails | **Engine/OS scrollbar behavior + project styling.** [app.css:47](../../../../ui_web/src/styles/app.css#L47), [Artist.module.css:75](../../../../ui_web/src/routes/Artist.module.css#L75) | Standard styling coexists with legacy pseudo-elements; OS overlay/classic policy and keyword widths still vary. |
| -webkit-box/-webkit-line-clamp/-webkit-box-orient | **Compatibility syntax, not evidence of Safari-only code.** [AlbumGrid.module.css:38](../../../../ui_web/src/components/AlbumGrid.module.css#L38), [SearchDiscovery.module.css:34](../../../../ui_web/src/components/SearchDiscovery.module.css#L34) | Multiple engines implement the legacy clamping form. Audit actual truncation and line height; do not rewrite merely to remove a prefix. |
| -webkit-text-size-adjust, font-smoothing, tap highlight, user-select and touch-callout | **Engine/OS defaults + project interaction/typography policy.** [app.css:12](../../../../ui_web/src/styles/app.css#L12), [app.css:145](../../../../ui_web/src/styles/app.css#L145) | The project suppresses several native defaults and supplies its own selection/press behavior. Cohesion depends on those replacements working. |
| Prefixed range thumbs/tracks, autofill fill/shadow, search-cancel/detail markers | **Browser-owned control differences + custom skin.** [NowPlaying.module.css:241](../../../../ui_web/src/components/NowPlaying.module.css#L241), [SearchField.module.css:54](../../../../ui_web/src/components/SearchField.module.css#L54), [BottomNavigationSettings.module.css:36](../../../../ui_web/src/components/BottomNavigationSettings.module.css#L36) | Similar color tokens do not unify hit targets, focus, autofill or form-control rasterization. |
| visualViewport, vh/dvh, env(safe-area-inset-*), display-mode:standalone | **Browser/host geometry differences + project workaround.** F7 locations; [TabBar.module.css:9](../../../../ui_web/src/components/TabBar.module.css#L9) | Some are standard responsive APIs, not hacks. The phantom-toolbar explanation is a recorded bug report without an OS/build/minimal repro here. The standalone override applies to all installed PWAs, not just iPhone. |
| navigator.standalone / display-mode reporting; iOS UA parsing | **Wrapper-mode detection / diagnostic project choice.** [stores/runtime.ts:105](../../../../ui_web/src/stores/runtime.ts#L105) | The UA parsing inspected here labels playback traces; it is not a pervasive renderer selection system. |
| navigator.userAgent plus navigator.platform in migration guidance | **Project content selection.** [MigrateView.tsx:81](../../../../ui_web/src/routes/MigrateView.tsx#L81) | Chooses platform guidance; not a graphical optimization. Linux falls into its default “mac” category. |
| Capacitor.getPlatform and registerPlugin in mobile adapters | **Wrapper difference, intentionally native.** [mobile/platform.ts:12](../../../../ui_web/src/mobile/platform.ts#L12), [MainActivity.kt:21](../../../../android/app/src/main/java/com/soundsible/android/MainActivity.kt#L21) | Audio, transport, offline/import/share and system appearance are outside the browser runtime. Keep those capabilities explicit. |
| __SOUNDSIBLE_DESKTOP__, native media:false, /player/desktop service-worker exclusion | **Wrapper capability / project packaging choice.** [desktopBridge.ts:1](../../../../ui_web/src/lib/desktopBridge.ts#L1), [pwa.ts:20](../../../../ui_web/src/lib/pwa.ts#L20) | Actual desktop bridge is appearance-oriented. Desktop route differs from generic remote-station /player/ mode; it is not a second native renderer. |
| webkitAudioContext fallback, optional audioSession, Media Session reconciliation | **Engine/audio capability differences.** [audio/graph.ts:110](../../../../ui_web/src/lib/audio/graph.ts#L110), [audio/transport.ts:154](../../../../ui_web/src/lib/audio/transport.ts#L154), [stores/runtime.ts:208](../../../../ui_web/src/stores/runtime.ts#L208) | Availability checks and recovery are appropriate; no blanket conclusion that Web Audio cannot work in background follows. |
| WebKit src/srcset race comment; warm artwork hints | **Recorded engine observation + project decoding policy.** [CoverImage.tsx:5](../../../../ui_web/src/components/CoverImage.tsx#L5), [CoverImage.tsx:43](../../../../ui_web/src/components/CoverImage.tsx#L43) | Bounds fallback artwork and changes eager/sync hints after a URL painted. Does not prove the decoded image still resides in memory. |
| WebKit kinetic-click comment, pointerup activation, ghost-click suppression | **Engine/input observation + project gesture model.** [SettingsShell.tsx:87](../../../../ui_web/src/components/SettingsShell.tsx#L87), [responsiveTap.ts:119](../../../../ui_web/src/lib/responsiveTap.ts#L119) | Mouse/keyboard retain click; touch follows a custom path. Needs tap-after-fling, cancel, long-press and nested-control coverage. |
| Delayed carousel frame cancellation, reduced-motion visibility fix, overflow:clip | **Project lifecycle/layout choices exposed by engine timing.** [PlayerWorkspace.tsx:186](../../../../ui_web/src/components/PlayerWorkspace.tsx#L186), [tokens.css:839](../../../../ui_web/src/styles/tokens.css#L839), [PlayerSurface.module.css:30](../../../../ui_web/src/components/PlayerSurface.module.css#L30) | Late-frame arbitration and hidden-scrollport removal are valid app responsibilities; comments alone do not establish an upstream engine bug. |
| Withdrawn Linux defects: MediaStream silence, stale frames, NVIDIA blanking, distro AAC | **Recorded engine/port/driver/codec-package differences.** [DESKTOP_BETA.md:36](../../../../docs/DESKTOP_BETA.md#L36) | Important evidence against automatically restoring a WebKitGTK wrapper, but not rerun here or generalized to every WebKit version. |

There was no basis in this inspection to describe the UI as dominated by UA-based rendering forks. The more significant divergence is the combination of different host capabilities, different entry compositions and custom gesture/geometry policies.

## 6. Rendering differences that should shape the architecture

| Area | Primary evidence | Architectural implication / verification |
| --- | --- | --- |
| Compositing and threaded scrolling | **Sourced:** Chromium separates main-thread work from compositor/raster work [S12], [S14]. WebKitGTK documents a separate async scrolling path [S10]; Apple's WebKit discussion also describes async overflow scrolling [S18]. | Neither “web is single-threaded” nor “WebKit has no threaded scrolling” is a sound diagnosis. Existing rasterized content can move smoothly while main-thread row production misses deadlines. Measure input-to-presentation, new-row paint and blank/checkerboard regions separately. |
| Video thumbnails versus rows | **Sourced:** Chromium describes video decoding into GPU textures outside the normal DOM paint stages [S12]. | A moving thumbnail need not invalidate or lay out a whole list. The owner's YouTube observation is consistent with that architecture, but I did not measure the site or establish its current implementation. |
| Backdrop-filter and filter | **Sourced:** The Filter Effects draft distinguishes filtering an element's image from sampling the backdrop and describes nested boundaries [S16]. **Read:** the player wallpaper uses a filtered, enlarged layer [PlayerSurface.module.css:111](../../../../ui_web/src/components/PlayerSurface.module.css#L111). | Effect area, invalidation frequency, hierarchy and acceleration matter. “All blur is cheap” and “remove all effects” are both unsupported. Preserve the intended material while simplifying redundant sampling if a trace/pixel control proves it helps. |
| Scrollbars | **Sourced:** Chrome's documentation distinguishes classic bars that consume layout space from overlay bars [S19]; standard scrollbar styling is not a universal pixel-width contract [S20]. **Measured:** probe geometry above. | Reserve/measure geometry intentionally. Test OS “always show scrollbars,” zoom/DPR and input types; do not calculate columns or row widths assuming the global 10px rule. |
| Font rendering | **Sourced:** Microsoft documents differences between Chromium's Skia/DirectWrite pipeline and historical Edge text rendering, including OS contrast preferences [S21]. **Read:** fonts are self-hosted [fonts.ts:1](../../../../ui_web/src/boot/fonts.ts#L1), but global -webkit-font-smoothing is requested [app.css:29](../../../../ui_web/src/styles/app.css#L29). | Bundling the same engine would not guarantee identical platform text rasterization. Target consistent hierarchy, metrics, clipping and contrast rather than identical antialiasing pixels. Check real Windows text settings, Apple rendering and Linux at relevant DPR. No font-speed comparison was run. |
| Image loading/decoding | **Sourced:** HTML specifies decoding as a hint and decode() as a separate readiness operation [S22]. **Read:** CoverImage uses srcset, a ResizeObserver and URL-based warm hints [CoverImage.tsx:28](../../../../ui_web/src/components/CoverImage.tsx#L28). | HTTP cache, decoded-image cache and uploaded GPU texture are different states. Virtualization can reduce DOM yet cause repeated image lifecycle work. Verify requested dimensions, decode/raster bursts and cold/warm remounts. The warm URL set is not proof of resident decoded pixels. |
| Wheel and touch | **Sourced:** synchronous handlers can require main-thread input handling [S14]. **Read:** browser pager uses scroll snap; sheet dismissal uses custom touch capture, F2. | Keep list scrolling platform-owned; limit competing gestures. A wheel test is not equivalent to finger momentum or trackpad scrolling. Do not compare engines at equal nominal scroll settings without matching actual distance/velocity. |
| Native versus custom renderer | **Sourced:** SwiftUI List, Compose lazy lists and Windows ListView offer platform collection primitives [S23], [S24], [S25]; Flutter describes its own widget/rendering architecture [S26]. | “Native app” can mean native OS widgets, an app-owned drawing engine or a WebView. Specify which one, and require the same features, accessibility and measured responsiveness in comparisons. Native frameworks also need bounded list composition; switching languages does not remove that duty. |

### iPhone music-app limits that materially affect the decision

- **Sourced + read:** Background media can work, but the OS/browser release and audio path matter. Safari 27 release notes explicitly include a fix for advancing a playlist in a background tab [S4]; the current web transport configures optional audioSession and has recovery/unlock machinery (F5). It is not defensible to promise arbitrary DJ transitions, Live capture or uninterrupted JS scheduling through lock based on API presence alone.
- **Sourced:** Service-worker execution is terminable [S7]. Do not move programme scheduling into a worker expecting a native media service lifetime.
- **Sourced:** WebKit storage is quota/eviction governed; Home Screen web apps receive browser-equivalent quota treatment, and persistent storage can be requested [S5]. The obsolete blanket “all installed iPhone app data disappears after seven days” is not an accurate architectural premise. Browser storage still is not the same contract as explicit native offline files.
- **Sourced:** Service workers require a secure context; private LAN HTTP is not made secure merely by being local to the network [S7]. This matters for a station-served client on arbitrary hosts. **Read:** PWA registration caches the app shell rather than providing native Android offline music ownership ([pwa.ts:1](../../../../ui_web/src/lib/pwa.ts#L1)).
- **Read:** Native iOS already uses AVAudioSession code, but its device behavior and full web-feature parity are unverified (F5). Replacing the PWA with that app today would change the product, not just its runtime.

## 7. Alternatives and survival-cost decision matrix

The survival estimates are **engineering inferences from read source + sourced runtime models**, not measured LOC percentages, delivery dates or benchmarks. “Existing UI survives” means components/CSS can execute substantially unchanged; it does not mean existing problems disappear. API contracts, identity rules, assets, design decisions and fixture data have value under every option.

| Option | Existing Solid UI/code survival | Capabilities and constraints | Browser/station consequence | Decision |
| --- | --- | --- | --- | --- |
| Current web + native-service wrappers, with revised boundaries | Nearly all presentation and TS can remain; refactor app/host ownership and measured hot paths. Lowest migration cost; continued multi-engine verification cost. | Native adapters can own audio/storage/lifecycle. Engine differences remain explicit. Supported by current Android pattern and Spotify's platform-API model [S13]. | Preserves install-free /player/ and HTML semantics. | **Keep/change: recommended target.** |
| Electron desktop | Nearly all Solid DOM/CSS/pure TS survives. Tauri Rust shell/tray/engine supervision and security boundaries need a new host integration; medium shell migration, not a UI rewrite. | Bundles Chromium and Node for Windows/macOS/Linux [S27]. Engine rollout becomes the app maintainer's job; same GPU/driver and renderer-work constraints remain. Native audio still requires integration. | Does not standardize external browsers, iPhone PWA or the Android app. Web UI must remain. | **Conditional prototype only** if a supported desktop runtime demonstrably loses to the same-content Chromium build. |
| CEF desktop, custom host | Nearly all web presentation survives. More native embedding, packaging, IPC, updating and integration work than retaining the current host. Existing Rust code reuse depends on binding/host choice. | CEF provides Chromium embedding on Windows/macOS/Linux [S28]. Spotify documents this model [S13]; it is not evidence of free performance. | Same desktop-only standardization limit; no arbitrary-browser replacement. | **Conditional alternative**, not default. |
| Tauri 3 CEF runtime | Web UI mostly survives; potential preservation of more Rust shell code than Electron, but migration/plugins and packaging must be checked. | Late-2026 official documentation exposes a CEF runtime, but labels Tauri 3 **alpha**; Tauri 2 always uses wry [S29]. Not a stable switch in the reviewed project. | Still does not make the station's browser client or iOS worldwide use CEF. | **Track, do not base delivery on an unvalidated alpha.** |
| Native UI per platform: SwiftUI, Jetpack Compose, WinUI | No Solid DOM component or CSS module executes as native UI unchanged. Platform screens/navigation/state binding require rewrite; native Kotlin/Swift media/offline code can remain. Pure TS logic needs a port or deliberate JS embedding. Very high total cost and several maintained UIs. | Strongest access to each platform's controls/lifecycle/accessibility; list primitives exist [S23], [S24], [S25]. UI performance still depends on data, item work and images. Scope of current iOS app is much smaller than full web parity. | Must retain/maintain a web client as well, unless browser delivery is deliberately removed from product scope. | **Use for validated platform-specific requirements**, not a blanket response to current list freezes. |
| React Native | No drop-in reuse of Solid DOM/JSX semantics or CSS modules. Many pure TS models/algorithms may survive after decoupling; UI becomes React/native components. Existing native media code needs TurboModule/native integration. High migration cost. | Fabric uses React/C++ host trees [S30]. Windows/macOS are partner implementations; Web uses React DOM; Linux has community alternatives rather than identical support [S31]. Platform/version integration remains. | Either keep Solid web or migrate web too through a separate web renderer; browser behavior does not disappear. | **Not justified by present evidence.** Candidate if the product deliberately adopts mobile-native UI as a sustained strategy. |
| Flutter | No Solid UI/CSS or TS runtime executes unchanged. Reuse assets/contracts/fixtures and wrap native media code; rewrite UI/domain glue in Dart. Very high migration cost. | App-owned rendering and widgets, with platform embedders [S26]. More controlled visual composition is possible; OS-native controls are not automatic. Web uses CanvasKit/Skwasm over browser graphics APIs [S32]. | Can still serve browser assets from each station, but adds a rendering/runtime payload and changes HTML/text/accessibility integration. Must test low-end browsers and WebKit, not assume native speed on web. | **Credible greenfield choice, weak migration case here** without a representative winning prototype. |
| Compose Multiplatform | Existing Solid UI/CSS does not survive as UI; Kotlin native programme code is a more useful reuse asset than with a Dart rewrite. UI moves to Compose; TS logic ports or is replaced. High/very high cost. | Official matrix lists Android/iOS/desktop stable and Kotlin/Wasm UI beta at access time [S33]. Desktop/JVM/custom drawing is not WinUI/AppKit controls by default. | Web target is a different deployment/runtime trade-off; the station can serve it, but PWA/media/browser integration needs revalidation. | **Plausible Kotlin-centric consolidation**, not a proven performance repair. |
| Lynx / ReactLynx / Lynxtron | Existing DOM components, document APIs and Solid bindings are not drop-in. CSS concepts/assets and pure TS can help, but UI and adapters need a substantial port. A Solid custom renderer would itself become product infrastructure. | Dual-thread architecture uses different runtimes by thread/platform [S34]. Lynx announced Windows/macOS support in 2026; Lynxtron was announced September 2026 with specific tested desktop targets [S35], [S36]. No assumed Linux/ARM64/every-feature parity from those announcements. | A Web target exists, but does not make native renderer behavior identical to browser behavior; existing Web Audio/native bridges need explicit work. | **Exploratory only.** Current vendor examples/benchmarks do not establish this music app's scrolling, accessibility or service integration. |
| Hybrid: native collection screens, shared web elsewhere | Retain most existing web screens; replace the chosen list/screen and its DOM-specific interactions. Native services and protocol can survive. Medium cost per complete surface, potentially high ongoing synchronization cost. | Native list/scroller can own item reuse and gestures. Shared selection/identity/queue commands are required. Layering arbitrary native rows into a scrolling blurred WebView risks clipping, z-order, focus and accessibility splits. | A separate web equivalent is still required for browsers; hybrid cannot fix it automatically. | **Best fallback experiment if web hot-path remediation fails.** Prefer a whole collection screen with a clean boundary over native cells embedded among DOM nodes. |

**Sourced constraints for bundling:** Electron explicitly documents main/renderer blocking as a performance problem even with its bundled Chromium [S37]. Its security guidance requires keeping the framework current and constraining capabilities exposed to remote content [S38]. This is especially relevant because the existing shell loads a selected station's UI and exposes only restricted appearance capabilities ([desktop.rs:136](../../../../desktop-shell/src-tauri/src/desktop.rs#L136)). A replacement must preserve that boundary, not expose Node/native authority directly to station pages.

**Decision:** Retain current runtime families initially, but treat that as a testable choice. Prefer an app/runtime adapter architecture to a promise of identical engines. A bundled desktop engine becomes attractive if reproducible host-engine failures remain after a same-content browser comparison; a native/custom list renderer becomes attractive if a feature-complete prototype beats the best web implementation enough to justify maintaining both.

### Does the industry comparison establish engine capability?

**Sourced:** Spotify's engineering account is unusually relevant: a shared TypeScript/web UI, CEF desktop container and platform APIs for different playback/data systems [S13]. It supports the feasibility of shared presentation with native services. It does not say that this project's Solid framework is slower than React, that CEF eliminates jank, or that every current Spotify feed maintains a specified FPS.

**Read:** The repository's earlier Chrome experiment changed scroll behavior materially without changing runtime (F1). **Sourced:** both Chromium and WebKit support scrolling paths independent of main-thread work (section 6). **Inference:** there is no platform-level reason that a bounded music list must freeze merely because it uses the web; an application workload or a specific app/engine/driver interaction is a more useful initial hypothesis than the framework name alone.

**Could not verify:** a controlled, current YouTube/Spotify-versus-Soundsible smoothness comparison on the owner's hardware. I did not find a primary, matching-hardware/frame-presentation study that would justify presenting the owner's observed zero-dropped-frame result as independent proof. Therefore this review does not claim that runtime has been ruled out, or that a particular replacement would be faster.

## 8. Ordered recommendations: keep, change, replace

Expected effects are hypotheses to validate, not measured gains.

| Order | Action | Expected effect | Acceptance / falsification |
| --- | --- | --- | --- |
| 1 | **Change:** establish a representative rendering contract before choosing a new runtime. Include large songs/queue/search lists, artwork, panels, live updates and playback. Use fake/local data and production-like assets. | Locates whether failure is input blocking, JS, layout, image/raster, compositor or host/driver. Prevents an expensive migration that reproduces the same workload. F1–F3. | On designated low-end hardware, capture actual frame presentation/missed deadlines and input latency at real refresh rate; report p95/p99 and worst stall plus blank rows. Compare browser/host under the same content, DPR, distance and acceleration. Proposed target: no visible freezes or persistent blanks; choose an explicit missed-frame budget before implementation. rAF alone is insufficient. |
| 2 | **Change:** redesign gesture ownership and shared list/image/layer boundaries based on those traces. Keep native scrolling; constrain dismiss gestures. | Lower dependency on the main thread during flicks and lower work producing newly visible content. F1/F2. | A/B complete gestures and rapid scrolling; retain tap-after-fling, nested controls, long press, focus and scroll restoration. Require improvement in presented frames/latency, not just lower handler duration. No assumption that every listener must be removed. |
| 3 | **Keep/change:** make the existing platform seam explicit and consistent. Domain commands/snapshots and capabilities should precede host-specific controllers and reusable presentation. | Shared behavior without emulating native media lifetimes with web timers; easier coherent UI changes. F5/F7. | Same user intent/identity/action invariants across browser/native adapters, with generation ordering and ownership tests. Native playback continues while UI is absent. No requirement to flatten platform features to the least capable browser. |
| 4 | **Change:** define a material, geometry and control contract with scoped platform exceptions. Every workaround gets affected engine/OS/build, minimal repro and removal condition. | Cohesion survives missing blur, different gutters, keyboard/toolbars and system bars. F3/F4/F7. | Motion-enabled and reduced-motion fixtures; pixel/contrast checks for materials; semantic/layout checks for typography; real insets/keyboard/rotation checks. A parser-support result cannot close visual acceptance. |
| 5 | **Change:** maintain a runtime support/diagnostic policy. Start with Android floor/recovery and actual engine identity, then Windows runtime version and browser-mode identity. | Actionable failures and reproducible reports; distinguishes stale providers from UI regressions. F6. | Below-minimum WebView shows a useful recovery path. OS/app/UI/provider versions are distinguishable without account data. Test oldest supported and current stable engines; exercise system update-disabled behavior. |
| 6 | **Keep:** browser/PWA as the universal distribution and Linux experience; Android native services; Windows integration provisionally. **Change:** verify benefits against browser/PWA instead of equating app packaging with speed. | Protects reach and existing useful native work. Avoids multiplying products with no user advantage. | Per wrapper, document measurable audio/offline/system-integration benefits and UI performance that does not regress against the PWA. Retain no-Linux-app decision until a new candidate passes. |
| 7 | **Replace only if evidence warrants:** prototype one representative collection screen in the best alternate renderer, or the same UI in a bundled desktop Chromium host. | Tests the remaining engine/renderer hypothesis while bounding migration exposure. | Include menu/selection/keyboard/accessibility/artwork/updates/scroll-return, not a text-only demo. Compare steady and cold behavior, memory/startup/energy and packaging maintenance. Proceed only with a durable, meaningful advantage and an explicit browser maintenance plan. |

Recommended dependency rule: presentation consumes typed platform interfaces; browser/native adapters implement those interfaces; shared domain/protocol models depend on neither the host nor DOM rendering. Composition roots select adapters. The UI should not need to know whether an authoritative programme snapshot came from Media3 or browser media, but capabilities and lifetime differences must remain truthful. This extends the already-present asynchronous Android boundary; it is not a recommendation to rewrite every existing service before addressing the freeze.

## 9. Open questions and what would settle them

1. **Which stage owns the desktop freeze?** No current trace of the owner's failing gesture was collected here. Settle with a short headed/hardware-accelerated trace and frame-presentation recording on the affected machine, using disposable data; separate paused/playing, panels closed/open, warm/cold artwork.
2. **Does the same artifact differ between Chrome/Edge, WebView2, Firefox and Safari?** Settle with matched viewport, DPR/zoom, refresh rate, actual scroll distance, graphics backend and provider version. Distinguish input method and fonts/material rendering before ranking engines.
3. **How much touch scrolling waits on gesture dispatch?** Inspect non-fast-scroll regions and input latency with sheet/surface listeners present, then with a scoped-header prototype. Do not extrapolate a touch result to wheel freezes.
4. **Are the documented blur/viewport/WebKit workarounds still needed on supported Apple devices?** Reduce each to a self-contained repro; test the oldest supported and current Apple OS builds. Linux Playwright agreement/disagreement does not settle it.
5. **What is the oldest Android OS/provider combination the product actually intends to support?** Reconcile minSdk 24 with chrome120 output and the native provider check. Test unsupported-provider recovery and any non-Google provider path; do not infer support from an installable APK.
6. **Do real platform apps meet the owner's “beat the PWA” criterion?** Establish explicit dimensions: background/DJ reliability, offline behavior, input/frame latency, memory/startup and system integration. Existing native code is evidence of implementation, not comparative hardware acceptance.
7. **Can image readiness remain stable under fast virtualized remounts and memory pressure?** Measure selected image size, network requests, decode/raster/cache misses and placeholders. The URL warm hint cannot answer this alone.
8. **Would native/custom-rendered collections justify two maintained presentation paths?** A full representative prototype plus an inventory of surviving UI/adapters and browser obligations would settle this better than a framework benchmark.
9. **What Apple/native distribution and physical acceptance can actually be completed?** The existing iOS app and PAL path cannot be promoted to an established alternative based on CI. Installation, lock/background, interruption, offline and car evidence remain needed.
10. **How quickly must engine fixes reach users?** Decide whether independent evergreen updates or app-controlled bundled updates best fit each platform, including offline/managed machines. This is an operational trade-off, not a universal performance ranking.

## Primary source references

All are **sourced** evidence accessed for this review. Drafts, alpha documentation and vendor performance claims retain those limitations.

- [S1] Tauri 2: system webview families and versions.
- [S2] Chromium: Android WebView provider selection.
- [S3] Microsoft: Evergreen versus Fixed Version WebView2.
- [S4] WebKit: Safari 27 release notes, including background-playlist fix and update availability.
- [S5] WebKit: storage quota, Home Screen treatment, persistence and eviction.
- [S6] WebKit: historical background-audio bug discussion; historical context only, not proof of a current defect.
- [S7] W3C Service Workers draft: lifetime and secure-context requirements.
- [S8] Android: Media3 background playback services.
- [S9] Apple: native playback audio-session category/background mode.
- [S10] WebKit: GTK/WPE graphics and async scrolling architecture.
- [S11] Apple: EU alternative browser/embedded-engine entitlement conditions.
- [S12] Chromium: RenderingNG architecture.
- [S13] Spotify Engineering: shared desktop/web UI and platform APIs, published 2021.
- [S14] Chromium: compositor input flow and synchronous handler constraints.
- [S15] Playwright: browser distribution and WebKit provenance.
- [S16] CSS Filter Effects Level 2 draft: backdrop processing and unresolved backdrop-root details.
- [S17] Chromium developers: Android Nougat deprecation in M120.
- [S18] WebKit: macOS async overflow-scrolling discussion.
- [S19] Chrome: scrollbar styling and classic/overlay differences.
- [S20] W3C: CSS Scrollbars Styling Level 1.
- [S21] Microsoft: Windows text contrast and Chromium text-rendering pipeline.
- [S22] WHATWG HTML: image decoding/readiness.
- [S23] Apple: SwiftUI List.
- [S24] Android: Compose lazy lists/grids.
- [S25] Microsoft: Windows ListView/GridView.
- [S26] Flutter: architecture and platform embedding.
- [S27] Electron: supported desktop platforms and bundled runtime.
- [S28] CEF: usage and desktop embedding.
- [S29] Tauri 3 alpha: wry/CEF runtime selection.
- [S30] React Native: Fabric render/commit/mount pipeline.
- [S31] React Native: out-of-tree platform implementations.
- [S32] Flutter: web rendering model.
- [S33] JetBrains: supported-platform stability matrix.
- [S34] Lynx: JS engines and dual-thread runtime.
- [S35] Lynx: 2026 desktop platform announcement.
- [S36] Lynx: September 2026 Lynxtron announcement and tested targets.
- [S37] Electron: performance guidance.
- [S38] Electron: security and update responsibilities.
- [S39] Mozilla: Firefox update policy and distributor-package exceptions.
- [S40] Mozilla: Gecko and SpiderMonkey components.

[S1]: https://v2.tauri.app/reference/webview-versions/
[S2]: https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/webview-providers.md
[S3]: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version
[S4]: https://webkit.org/blog/18325/webkit-features-for-safari-27-0/
[S5]: https://webkit.org/blog/14403/updates-to-storage-policy/
[S6]: https://bugs.webkit.org/show_bug.cgi?id=198277
[S7]: https://w3c.github.io/ServiceWorker/#service-worker-lifetime
[S8]: https://developer.android.com/media/media3/session/background-playback
[S9]: https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback
[S10]: https://docs.webkit.org/Ports/WebKitGTK%20and%20WPE%20WebKit/Graphics.html
[S11]: https://developer.apple.com/support/alternative-browser-engines/
[S12]: https://developer.chrome.com/docs/chromium/renderingng-architecture
[S13]: https://engineering.atspotify.com/2021/04/building-the-future-of-our-desktop-apps
[S14]: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/how_cc_works.md
[S15]: https://playwright.dev/docs/browsers
[S16]: https://drafts.csswg.org/filter-effects-2/
[S17]: https://groups.google.com/a/chromium.org/g/chromium-dev/c/B9AYI3WAvRo
[S18]: https://trac.webkit.org/wiki/WhatsChangingwithscrollingonmacOS
[S19]: https://developer.chrome.com/docs/css-ui/scrollbar-styling
[S20]: https://www.w3.org/TR/css-scrollbars-1/
[S21]: https://blogs.windows.com/msedgedev/2025/01/30/better-text-contrast-for-all-chromium-based-browsers-on-windows/
[S22]: https://html.spec.whatwg.org/multipage/images.html
[S23]: https://developer.apple.com/documentation/swiftui/list
[S24]: https://developer.android.com/develop/ui/compose/lists
[S25]: https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/listview-and-gridview
[S26]: https://docs.flutter.dev/resources/architectural-overview
[S27]: https://www.electronjs.org/docs/latest
[S28]: https://github.com/chromiumembedded/cef/blob/master/docs/general_usage.md
[S29]: https://v3.tauri.app/develop/webview-runtime/
[S30]: https://reactnative.dev/architecture/render-pipeline
[S31]: https://reactnative.dev/docs/out-of-tree-platforms
[S32]: https://docs.flutter.dev/platform-integration/web
[S33]: https://kotlinlang.org/docs/multiplatform/supported-platforms.html
[S34]: https://lynxjs.org/next/guide/scripting-runtime/index.html
[S35]: https://lynxjs.org/3.7/blog/lynx-3-7.html
[S36]: https://lynxjs.org/next/blog/lynxtron
[S37]: https://www.electronjs.org/docs/latest/tutorial/performance
[S38]: https://www.electronjs.org/docs/latest/tutorial/security


[S39]: https://support.mozilla.org/en-US/kb/update-firefox-latest-release
[S40]: https://firefox-source-docs.mozilla.org/overview/gecko.html
