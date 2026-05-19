# Design System — Soundsible

Created by `/design-consultation` on 2026-05-19. Unblocks T4/T6 (Tauri consumer shell) per D-UX-4.

## Product Context

- **What this is:** Self-hosted music environment (YouTube, YouTube Music, podcasts, Deezer metadata) with a desktop consumer path (Tauri shell + Python sidecar) and an existing web player UI.
- **Who it's for:** Non-technical desktop users on the consumer path; power users keep `run.py` / Docker / NAS workflows.
- **Space/industry:** Music streaming / self-hosted media (Spotify-shaped install, Soundsible-shaped freedom).
- **Project type:** Desktop app shell wrapping existing web player. **This document's implementation scope is the consumer shell** (first-run, engine status, tray). Full player reskin is explicitly out of scope.

## Memorable Thing

**Feels like Spotify's install trust — but it's YOUR music on YOUR machine.** Subtle musician-built credibility in copy and typography, never intimidating sysadmin language on first-run.

## Aesthetic Direction

- **Direction:** Warm Industrial Utility
- **Decoration level:** Minimal on shell (typography + hairline borders). Glass morphism stays in the webview player only.
- **Mood:** Workshop-grade software that treats your library like a physical object you own. Shell = machine room; player = listening room.
- **Reference sites:** Spotify (dark install trust), Plex (tray persistence), Navidrome (self-host honesty — avoid their marketing-site feature grids on shell screens)

## Typography

- **Display/Hero (shell only):** [Fraunces](https://fonts.google.com/specimen/Fraunces) 600–700, opsz 9 — editorial warmth, deliberate departure from category all-sans shells
- **Body/UI:** [Plus Jakarta Sans](https://fonts.google.com/specimen/Plus+Jakarta+Sans) 400/600 — matches existing player `--font-sans` stack
- **UI/Labels:** Same as body
- **Data/Paths/Logs:** [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) 400/500 — already used in player; tabular-nums for byte/track counts
- **Code:** JetBrains Mono
- **Loading:** Self-host woff2 in Tauri shell assets; Google Fonts CDN acceptable for preview/dev. Preload Fraunces + JetBrains Mono; `font-display: swap` on UI, `block` on hero headline only.
- **Scale:**
  - Hero: 36px / 2.25rem (Fraunces)
  - Title: 20px / 1.25rem
  - Body: 15px / 0.9375rem
  - Caption: 12px / 0.75rem
  - Mono: 13px / 0.8125rem

## Color

- **Approach:** Balanced — restrained shell surfaces; orange accent matches existing player; brand gold reserved for mark/badge only.

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-base` | `#0d0d0f` | Shell window background; **must match** player theme-color for seamless webview handoff |
| `--bg-elevated` | `#16161a` | Cards, first-run panel (matches player `--bg-card`) |
| `--bg-inset` | `#0a0a0c` | Path display, log panes |
| `--hairline` | `#2a2a2e` | Visible borders (not rgba white 5%) |
| `--ink-primary` | `#ebebf0` | Primary text (matches player `--text-main`) |
| `--ink-secondary` | `#8e8e93` | Body secondary (matches player `--text-dim`) |
| `--ink-tertiary` | `#636366` | Fine print, disabled hints |
| `--accent` | `#f97a12` | Primary buttons, focus rings (matches player `--accent`) |
| `--accent-hover` | `#ff8d2e` | Button hover |
| `--accent-press` | `#d8630a` | Button pressed |
| `--brand-gold` | `#E0BC00` | Beta badge, logo mark, 3px card accent bar — **never** primary CTA fill |
| `--info` | `#3178c6` | Links, secondary actions (matches player `--secondary`) |
| `--success` | `#34c759` | Ready state, scan complete |
| `--warning` | `#e0a72b` | Caution copy |
| `--danger` | `#ff453a` | Error headlines, destructive confirm |
| `--status-loading` | `#f97a12` | Engine boot |
| `--status-ready` | `#34c759` | Engine healthy |
| `--status-error` | `#ff453a` | Engine failed |

- **Dark mode:** Default. Shell is dark-only for v1 (Win/Linux consumer path).
- **Light mode:** Player supports light via `[data-theme="light"]`; shell light mode deferred to post-beta.

## Spacing

- **Base unit:** 8px
- **Density:** Comfortable (44px minimum touch targets per DT5)
- **Scale:** 4, 8, 12, 16, 24, 32, 48 (named xs, sm, md, lg, xl, 2xl, 3xl)

## Layout

- **Approach:** Hybrid — editorial asymmetric grid on first-run; grid-disciplined on engine/error states
- **First-run grid:** Two columns on ≥768px (headline left, action card right); single column on narrow windows
- **Card max-width:** 480px for action card; full stage uses 560px content area
- **Max content width:** 560px centered stage on shell screens
- **Border radius:** sm 8px (buttons, inputs), md 14px (cards), lg 20px (stage frame)
- **Shell card signature:** 3px left border in `--brand-gold` on action card

## Motion

- **Approach:** Minimal-functional
- **Easing:** enter `ease-out`, exit `ease-in`, state change `ease-in-out`
- **Duration:** micro 100ms, short 200ms, medium 300ms
- **Spinner:** 1s linear rotation on engine boot headline
- **Tray VU meter:** 12fps max, throttled to audio levels when playing; static glyph when paused
- **No** entrance choreography, scroll-driven animation, or gradient transitions on shell screens

## Consumer Shell Chapter

Implementation target: `desktop-shell/` (T4, T6, DT2–DT5).

### Information architecture

```
[Install] → [Tauri: First-run editorial stage] → [Engine starting/log] → [Webview: existing player]
[Tray: always] Open | Restart engine | Quit
```

### Surfaces

#### 1. First-run (editorial)

- **Layout:** Left column — Beta badge (gold, uppercase), Fraunces headline "Point me at your music.", one-line privacy body. Right column — action card with gold left bar.
- **Primary CTA:** "Choose folder…" (native OS dialog via Tauri, D-UX-1)
- **Secondary:** "Continue" (enabled after folder chosen)
- **Path display:** Mono inset field, read-only, shows human path after picker
- **Live scan preview:** After folder pick, show `{track_count} tracks · {size} · scanned in {duration}` before Continue (trust-building, wilder risk)
- **Copy rules:** No "Welcome to Soundsible", no feature grids, no emoji, utility language only
- **Never on first-run:** API tokens, LAN, Tailscale, ports, Advanced settings

#### 2. Engine loading

- **Headline:** "Starting Soundsible…" with spinner
- **Log tail (primary):** Last 4–6 lines in JetBrains Mono, `--ink-secondary`, fade gradient at top. Show path being scanned live.
- **Not allowed:** Blank window, spinner-only with no status text

#### 3. Engine error (blocking, D-UX-2)

- **Headline:** "Couldn't start" in `--status-error`
- **Log tail:** Highlight failing line in red; include actionable detail when known (e.g. permission denied on path)
- **Actions:** "Try again" (primary), "Open logs" (ghost → Advanced log file)
- **No** sad-face illustration, no generic "Something went wrong"

#### 4. System tray (D-UX-3)

- **Menu items:** Open | Restart engine | Quit (platform-native menu)
- **Icon — playing:** 2-bar VU meter animated at ≤12fps from audio levels (wilder risk, v1 target)
- **Icon — paused/idle:** Static Soundsible glyph from `branding/logo-mark.svg` → `desktop-shell/src-tauri/icons/tray-idle.png`
- **Linux fallback:** Static glyph if tray cannot animate; document in platform notes
- **Keyboard:** Tray accessible via platform conventions; menu items ≥44px touch height where drawn by app
- **Global shortcuts (v1):** `Ctrl+Alt+O` open/focus window, `Ctrl+Alt+R` restart engine, `Ctrl+Alt+Q` quit — registered globally and shown as tray menu accelerators
- **Shell UI:** All buttons `min-height: 44px`; `:focus-visible` rings on interactive elements; focus moves to primary action on view change

#### 5. Beta banner (webview, DT4)

- **When:** After `setup_first_play` telemetry fires
- **Copy:** "Soundsible (Beta)" — dismissible, persists dismissal in local storage
- **Style:** Uses player tokens; gold badge text, not shell Fraunces

### Interaction states

| Surface | LOADING | EMPTY | ERROR | SUCCESS |
|---------|---------|-------|-------|---------|
| First-run | "Starting…" in log area | N/A (folder required) | Engine error screen | Open webview |
| Tray | — | — | — | Open / Restart / Quit |
| Webview handoff | `#initial-loader` (existing) | Empty library (existing) | ConnectionManager offline | `setup_first_play` |

### Copy principles

- Imperative, specific: "Point me at your music." not "Configure your Station Engine"
- Buttons name actions: "Choose folder…", "Try again", "Open logs" — not "Continue" alone without context
- Privacy line: "Your library stays on this machine. Nothing uploads. Ever."
- Fine print (optional): "Soundsible (Beta) — built for people who own their music."

### Anti-slop (shell)

- No purple/violet gradients
- No glass blur on shell screens
- No 3-column feature grid
- No centered-everything layout (headline left-weighted)
- No emoji in UI copy
- No gradient buttons
- No Inter/Roboto/Arial as display font
- No "Welcome to…" hero patterns

## Relationship to Existing Player

The webview player (`ui_web/`) keeps its existing tokens in `tailwind-compiled.css` / `_mobile_custom.css`. Shell hands off to `#0d0d0f` background and `#f97a12` accent — **do not** introduce a third accent color on shell CTAs. Brand gold appears only on badge/accent bar, not buttons.

## Preview Artifact

Visual preview: `~/.gstack/projects/Arzuparreta-soundsible/designs/design-system-20260519/design-consultation-preview.html`

Wireframe (superseded for pixels, still valid for IA): `~/.gstack/projects/Arzuparreta-soundsible/designs/tauri-first-run-20260519/wireframe-first-run.html`

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-19 | Initial design system | `/design-consultation` — consumer shell scope per D-UX-4 |
| 2026-05-19 | Keep `#f97a12` accent | Seamless handoff to existing player |
| 2026-05-19 | Fraunces display on shell only | Memorable editorial departure; Plus Jakarta Sans for UI continuity |
| 2026-05-19 | Opaque shell cards, no glass | Machine room vs listening room; anti-slop |
| 2026-05-19 | Log-forward engine status | Self-host trust signal (wilder risk) |
| 2026-05-19 | VU-meter tray icon v1 | Alive-on-your-machine differentiation (wilder risk) |
| 2026-05-19 | Gold accent bar + badge only | Brand `#E0BC00` without clashing orange CTAs |
| 2026-05-19 | Live scan preview on first-run | Trust before Continue commit (wilder risk) |
| 2026-05-19 | DT5 tray keyboard + 44px targets | Global shortcuts + shell focus-visible; beta banner dismiss already 44px |
| 2026-05-19 | DT3 tray + bundle icons from logo-mark.svg | Static idle glyph; VU-meter playing state still deferred |
