# Handoff: Discovery, Recommendations & Music Sources (2026-11-21)

Entry point for recalling the discovery study, settled product direction, and
active backlog for Soundsible's discovery flow, recommendation engine, and
Discover UI without the original chat history.

Baseline checked against `main` at `7f5486e7` on 2026-11-21. Line numbers below
describe that baseline; search by symbol name if code has moved.

---

## Product Direction

Soundsible Discovery does **not** aim to replicate every tab, widget, or
editorial vertical of Spotify/Apple Music. Every change in this handoff must
serve one coherent loop over the surfaces Soundsible already has:

> **Open Discover with music that actually fits you → tap and play full tracks without avoidable waits → explore Artist/Album → flow into Radio or DJ.**

Guiding principles:
- **Improve existing surfaces under the hood** rather than inventing gimmick
  screens (no 2D vibe maps, no standalone DSP showcase views, no adventure
  dials, no 30-second preview clips).
- **Keep music Discover focused on music** (do not mix podcasts or unrelated
  navigation rewrites into `/search` Discover).
- **Zero external API key required by default:** Core discovery works out of
  the box. ListenBrainz and Last.fm read-back activate automatically when the
  user has scrobbling connected.
- **Respect `docs/internal/ARCHITECTURE.md`:** explicit text search
  (`/api/catalog/search`) stays strictly query-only (never reads recommendation
  signals, favourites, or account history). All personalization belongs to
  discovery, radio, autoplay, and DJ.

---

## How to work with this document

- **Recall first.** Before proposing or implementing any change to Discover,
  recommendations, artist/album catalog enrichment, or external discovery
  sources, read this handoff and its **Active Backlog**, **Descoped**, and
  **Decisions** tables.
- **Tackle by ID.** Work item by item using the stable IDs below (`D*` baseline
  defects, `U*` UX/freshness/latency, `S*` intelligence & open sources, `X*`
  Soundsible differentiators).
- **Keep this handoff current on every PR.** Whenever an item is refined,
  decided, started, partially shipped, closed, or rejected:
  1. Update its row in the **Active Backlog & Status** (or **Descoped**) table
     with status, PR/commit, evidence, and any remaining limit.
  2. Record any product or architectural decision in **Decisions**.
  3. Append a concise dated entry to the **Iteration Log**.
- **Follow `AGENTS.md` gates:**
  - Branch off latest `origin/main`, commit, open a PR with an `impact:*` label,
    and wait for every GitHub check on the latest remote head to pass.
  - Never run `npm run build` in `ui_web/`.
  - If `ui_web/` changes, run the full Playwright suite on all four CI profiles.
    A UI-aimed pull request shows before/after images (or a video for
    motion/timing) in its description, as `AGENTS.md` says; never commit them.
  - Keep web and Android (`ui_web/src/mobile/`) in sync where they share
    contracts (`SearchDiscoveryView.tsx`, `ArtistDiscoveryView.tsx`,
    `discoveryFeed.ts`, `CatalogSearch.tsx`).

---

## Baseline Inventory (as of `7f5486e7`, updated through Phase 1)

### Discovery surfaces & engines
1. **Unified Discover surface** — empty-query state of `/search`
   (`ui_web/src/routes/Search.tsx` → `SearchDiscovery.tsx` →
   `SearchDiscoveryView.tsx`; shared on Android by
   `ui_web/src/mobile/CatalogSearch.tsx` + `discoveryFeed.ts`) and the player
   search panel's **For you** (`PlayerSearchPanel.tsx`), unified onto `discoveryFeedStore.ts` +
   `GET /api/discovery/music/feed` + `discovery_feed_ready` Socket.IO push
   (closed in `D1`–`D6`).
2. **Passive & active continuation** — Autoplay, Radio, and two-deck
   beatmatched DJ mode (`shared/api/routes/auto_mode.py`,
   `shared/listening_planner.py`, `shared/music_plan.py`,
   `shared/music_candidates.py`).
3. **Entity exploration** — native Artist (`ui_web/src/routes/Artist.tsx`,
   `ArtistDiscoveryView.tsx`) and Album (`ui_web/src/routes/Album.tsx`) pages
   backed by Deezer (`shared/api/routes/catalog.py`, `shared/deezer_catalog.py`)
   with library reconciliation.

### Sources & signal inventory
| Layer | Source / Store | Current Role | Remaining Potential for Active Backlog |
| --- | --- | --- | --- |
| Metadata & browse | **Deezer public API** (`shared/providers/deezer.py`) | Artist/album profiles, related artists, artist top tracks, global charts, text search | Album `release_date` freshness (`U1`), already-fetched album `duration` + `label` + artist latest release (`U5`). Quota: ~50 req/5s unauthenticated; field-search syntax broke in Oct 2026. |
| Audio resolution & cache | **YouTube via `yt-dlp` + SQLite caches** (`shared/catalog_resolution.py`, `shared/preview_streams.py`, `shared/preview_cache.py`) | Full-track resolution `(artist, title) -> video_id`, 6h egress-keyed stream-URL cache, single-flight disk spool & prefetch | Audit/fix cache-reuse and prefetch gaps (`U2`): e.g. SQLite resolution hits not warming stream URLs, client prefetch not linking `video_id` back to `CatalogItem`, no prefetch on Artist/Album. |
| Scrobbling (outbound) | **ListenBrainz, Last.fm, Maloja** (`shared/scrobble/clients.py`) | Write-only (`submit-listens` / `track.scrobble` / `now_playing`) | **Zero read-back (`S1`).** ListenBrainz offers free CF recommendations, Fresh Releases, Weekly Exploration, and Similar Artists by MBID; Last.fm offers `artist.getSimilar` and `track.getSimilar`. |
| Local listening & library | `listening-events.jsonl`, `discovery_signals`, `tracks`, `track_user_state` (`shared/discovery_intelligence.py`, `shared/db/schema.py`) | 45-day half-life artist frequency, local candidate pool ranking, exact-identity `not_interested` | Cross-provider identity unification (`deezer_id` ↔ `youtube_id` ↔ `isrc` ↔ `mbid`) + artist-level negative feedback (`S3`). |
| Audio DSP | `cache/dj/analysis.sqlite3` (`shared/dj/features.py`, `shared/dj/contracts.py`) | DJ transition ordering & cue planning only (`shared/dj/routes.py`) | Out of scope for Discovery: requires decoded local audio and must not rank unmeasured external candidates against cached tracks. |

---

## Active Backlog & Status

ID prefixes:
- **D** — Baseline defects & leaked signals (Phase 1 — **complete**)
- **U** — Freshness, full-track resolution latency & entity completeness (Phase 2)
- **S** — Feedback & open-source recommendation read-back (Phase 3)

| ID | Phase | Item | Key Files | Status |
| --- | --- | --- | --- | --- |
| **D1** | 1 | Fix `"More like {artist}"` bug: fetch tracks from *related* artists instead of the seed artist's own top tracks (which `compose_discovery_feed` then truncates to 2 rows via its 2-per-artist cap). | `shared/api/routes/discovery_feed.py`, `shared/discovery_intelligence.py` | Closed (`feat/discovery-shelves-and-signals`: `_deezer_related_artist_rows` folds diacritics, fetches `artist/{id}/related` + round-robin `/top`, skips seed/owned tracks, and populates `reason_key="because_listen"`.) |
| **D2** | 1 | Render backend `sections`, `reason`, and `reason_artist` in the Discover UI instead of discarding `feed().sections` and flattening into one 5–10 row `"Songs you might like"` list. | `ui_web/src/components/SearchDiscovery.tsx`, `SearchDiscoveryView.tsx`, `ui_web/src/mobile/discoveryFeed.ts` | Closed (`feat/discovery-shelves-and-signals`: `resolveDiscoveryTrackShelves` renders localized shelves + reason subtitles, `?browse=<sectionId>` expansion, `reason_artist` attribution on entity cards, and flat-`items` fallback across web + Android.) |
| **D3** | 1 | Fix unreachable feedback & actions on Discover rows: add overflow (`…`) / context menu on desktop `CatalogResultRow`, and expose `Not interested`, `Start Radio`, and recommendation `reason` for unresolved Deezer rows (web + Android). | `ui_web/src/components/CatalogResultRow.tsx`, `entryActions.ts`, `trackActions.tsx`, `ui_web/src/mobile/CatalogSearch.tsx` | Closed (`feat/discovery-row-actions-and-feedback`: desktop `CatalogResultRow` adds overflow `<IconButton>` + right-click + `ContextMenu`/`Shift+F10`; `entryActions.ts` & `CatalogSearch.tsx` expose `Start radio`, recommendation `reason`, and `Not interested` with `deezer_id`/`isrc` + immediate row dismissal & Undo on unresolved Deezer rows; `rank_recommendation_rows` preserves canonical `music:deezer:` and `music:track:` identities.) |
| **D4** | 1 | Fix browse & freshness edge cases: fold diacritics in `discovery_browse.py`, include singles/EPs in releases, add seed rotation + Refresh button, replace 5s polling loop with Socket.IO push, and prefetch/pre-resolve top Discover songs. | `shared/discovery_seeds.py`, `shared/discovery_browse.py`, `shared/api/routes/discovery_feed.py`, `ui_web/src/lib/discoveryEvents.ts`, `ui_web/src/components/SearchDiscovery.tsx`, `SearchDiscoveryView.tsx`, `ui_web/src/mobile/discoveryFeed.ts`, `EnginePlugin.kt` | Closed (`feat/discovery-freshness-and-push`: `shared/discovery_seeds.py` adds diacritic-folded seed scoring and per-user soft rotation (`0.02` penalty); `discovery_browse.py` uses `fold_text` + `nb_fan` tiebreak and preserves `single`/`ep` with `record_type`/`release_date`; `discovery_feed.py` emits `discovery_feed_ready` after clearing inflight state; web and Android replace 5s polling with push-first + 15s bounded fallback, add a home Refresh button, label Singles/EPs, and speculatively pre-resolve/prefetch top visible Discover songs.) |
| **D5** | 1 | Fix `Rediscover` section to use real listening recency & affinity (`last_played_at`, `play_count`, old favourites) instead of the first 12 unplayed tracks in manifest order. | `shared/discovery_intelligence.py`, `shared/api/routes/discovery_feed.py` | Retired / Descoped (`feat/distill-discovery-shelves`: retired `Rediscover`, `Made for Your Library`, and `From {playlist}` from Discover so `/search` only surfaces music not already in the user's library, while `build_music_recommendations` serves strictly as the local candidate pool ranker for Radio/Autoplay/DJ.) |
| **D6** | 1 | Unify the two disconnected discovery engines (`discovery_feed.py` vs. `nodeDiscover.ts` / `discovery_graph.py`) around one shared candidate/seed contract and cache lifecycle. | `shared/api/routes/discovery_common.py`, `discovery_graph.py`, `ui_web/src/lib/discoveryFeedStore.ts`, `SearchDiscovery.tsx`, `NowPlayingBrowser.tsx` | Closed (`feat/unify-discovery-engines`: retired `nodeDiscover.ts`, `api.discoverFeed`, and client `discover_seed_ready` handlers; introduced reactive `discoveryFeedStore.ts` (`retainDiscoveryFeed`, `discoveryExploreItems`, `dismissDiscoveryItem`/`restoreDiscoveryItem`, `resetDiscoveryFeed`, push-first `discovery_feed_ready`) consumed by both `SearchDiscovery.tsx` and `NowPlayingBrowser.tsx` Explore with shared cache and `Not interested` dismissal; updated `discovery_graph.py` to auto-select rotated seeds via `select_graph_seed_tracks`, delegate `_top_warm_seed_ids`, and trigger user feed refresh after expansion.) |
| **U1** | 2 | **New Releases / Release Radar** shelf: background check of saved + high-affinity artists' recent releases (albums, singles, EPs) sorted by `release_date` (newest first, highlighting last 14–30 days). | `shared/discovery_browse.py`, `shared/discovery_seeds.py`, `shared/api/routes/discovery_feed.py`, `ui_web/src/components/SearchDiscoveryView.tsx`, `ui_web/src/lib/searchDiscovery.ts` | Closed (`feat/discovery-new-releases-and-day1`: `select_release_seed_artists` supplies unrotated artist seeds prioritizing `saved_entities`; `build_browse_sections` emits `new_releases` over a 180-day window sorted newest-first with 30-day `is_new` badges and album deduplication; web & Android render `New releases`, localized release dates, `New` badge, and `?browse=new_releases` expansion.) |
| **U2** | 2 | **Full-Track Resolution Latency Audit & Optimization**: study and validate the existing full-track resolution, caching, and prefetch pipeline (SQLite resolution & stream-URL caches, single-flight extraction, Discover/Artist/Album prefetch) and ship concrete latency or cache-reuse fixes (e.g. warming stream URLs on SQLite resolution hits, reusing resolved `video_id` on the client without duplicate `/api/catalog/resolve` calls, and letting cold-start free DJ in `dj.ts` resolve Deezer Discover seeds instead of dropping rows without `youtube_id`). | `shared/catalog_resolution.py`, `shared/preview_streams.py`, `shared/preview_cache.py`, `ui_web/src/lib/catalogItem.ts`, `ui_web/src/components/SearchDiscovery.tsx`, `ui_web/src/stores/dj.ts` | Open |
| **U3** | 2 | **Passive Day-1 Adaptation (Zero-Friction Cold Start)**: include saved artists & albums (`saved_entities`) in `select_taste_artists`, emit `music_search_played` on search playback, and automatically invalidate/refresh a cached cold Discover feed on the first real user signal (first save, play, favourite, import, or scrobble connection), with at most a subtle non-blocking hint while 100% empty. | `shared/discovery_seeds.py`, `shared/discovery_intelligence.py`, `shared/discovery_signals.py`, `shared/api/routes/discovery_common.py`, `discovery_feed.py`, `discovery.py`, `library.py`, `scrobble.py`, `ui_web/src/routes/Search.tsx`, `ui_web/src/mobile/CatalogSearch.tsx`, `ui_web/src/mobile/discoveryFeed.ts` | Closed (`feat/discovery-new-releases-and-day1`: `load_saved_entity_artists` feeds `select_taste_artists`; `music_search_played` (`0.6`) accepted and emitted from web/Android active search plays; `notify_discovery_signal` (`shared/discovery_signals.py` → `discovery_feed.py`) auto-refreshes cached cold feeds and bookmark/favourite updates across discovery events, saved entities, favourites, scrobble connects, intake/scan/migration; web & Android render a subtle `coldHint` note on cold popular feeds and reload paused Android feeds on resume via `staleFromPush`.) |
| **U5** | 2 | **Complete Artist & Album Pages**: surface already-available Deezer metadata on Album pages (release date, total runtime, label, *"More by Artist"*), add a Latest Release spotlight and direct **Artist Radio / DJ** CTA on Artist pages. *(Multi-hop MusicBrainz/Wikidata/Wikipedia bios deferred as an optional follow-up.)* | `shared/api/routes/catalog.py`, `ui_web/src/routes/Artist.tsx`, `ArtistDiscoveryView.tsx`, `ui_web/src/routes/Album.tsx`, `ui_web/src/mobile/EntityProfile.tsx` | Closed (`feat/discovery-artist-album-pages`: `_deezer_album_profile` / `_album_profile_uncached` return `release_date`, `label`, `duration` with track-sum fallback, `record_type`, `artist_deezer_id`, and up to 12 newest-first `more_by_artist` releases excluding self with `partial_failures` isolation; `_deezer_artist_releases` keeps `release_date` and `_artist_profile_uncached` returns `latest_release`; web & Android Album pages show localized release date, track count and runtime in the hero (genre deliberately not shown) plus `℗ <label>` credit and a Discover-only *"More by {artist}"* rail; web & Android Artist pages add the Latest Release spotlight, a visible **Start radio** CTA, and an options-menu **Start a DJ session** entry reusing existing radio/DJ paths.) |
| **S3** | 3 | **Cross-Provider Identity & Artist-Level Negative Feedback**: unify `deezer_id` ↔ `youtube_id` ↔ `isrc` ↔ `mbid` in `discovery_signals`, and add **"Less from this artist"** alongside `"Not interested"` so rejecting an artist demotes their catalog across shelves. | `shared/discovery_intelligence.py`, `shared/db/discovery.py`, `ui_web/src/components/entryActions.ts`, `ui_web/src/mobile/CatalogSearch.tsx` | Closed (`feat/discovery-identity-and-artist-feedback`: `identity_aliases` + write-time `discovery_signal_aliases` table backfilled via policy v3 unify `youtube_id`/`track_id`/`isrc`/`deezer_id`/`mbid`/folded `music:meta:` in O(signals + aliases) with one-hop aliasing and no double counting; `less_from_artist` stores undoable primary-artist signals (`music:artist:` + `music:deezer_artist:`), excludes rejected artists from taste/release seeds, softly demotes tracks/collaborations/browse shelves/related-artist pools, and adds "Less from this artist" with immediate feed-wide artist dismissal + Undo on web and Android.) |
| **S1** | 3 | **Two-Way ListenBrainz & Last.fm Federation**: when scrobbling is connected, read back ListenBrainz CF recommendations (`/1/cf/recommendation/…`), Fresh Releases, Weekly Exploration, and Similar Artists by MBID, and Last.fm `artist.getSimilar` / `track.getSimilar`, feeding Discover and Radio directly without new screens. | `shared/scrobble/clients.py`, `shared/providers/`, `shared/api/routes/discovery_feed.py` | Open |

---

## Descoped / Moved Out of This Handoff

Recorded explicitly so future sessions do not re-introduce rejected scope or
pull unrelated initiatives back into Discovery:

| Former ID | Topic | Disposition & Rationale |
| --- | --- | --- |
| **D5** & local shelves | `Made for Your Library`, `From {playlist}` & `Rediscover` shelves in Discover | **Rejected / Retired.** In Soundsible, `/` is Library and `/search` is Discover. Re-listing owned favourites, local playlist tracks, or dormant library songs inside `/search` duplicated `/` and out-scored actual external recommendations. Favourites, playlists, and listening history now act exclusively as silent taste seeds (`discovery_seeds.py`) and local Radio/Autoplay/DJ pool inputs (`music_plan.py`), while every track shelf and `"Albums for you"` card in Discover leads outward to music not already in the library. |
| *(old)* **U2** | Deezer 30-second clip auditioning | **Rejected.** Listeners want full tracks, Deezer's 30s excerpts do not align cleanly with full YouTube streams for handoff, and short-lived signed preview URLs add maintenance overhead. Replaced by full-track resolution audit (`U2`). |
| *(old)* **U3** | Cold-start taste wizard & Deezer `/genre`, `/chart/{genre}`, `/radio` | **Rejected.** Onboarding taste pickers add friction and Deezer `/radio` competes with Soundsible Radio/DJ. Replaced by passive day-1 adaptation (`U3`), since `select_taste_artists` only needs a single artist signal to personalize Discover. |
| **U4** | Home (`/`) vs. Discover (`/search`) IA rewrite | **Rejected.** `#477` already established `/` as Library and `/search` as Discover; do not reopen top-level navigation IA here. |
| *(part of)* **S3** | `"Snooze 30 days"` & `Comfort Zone ↔ Deep Cuts` dial | **Rejected.** Unclear/cluttered UI controls; keep negative feedback strictly to `"Not interested"` and `"Less from this artist"`. |
| **S4** | Podcasts & Live rooms inside music Discover | **Moved / Rejected.** Mixing podcasts into music Discover hurts focus; wiring `/api/discovery/podcasts/recommendations` on web belongs to `/podcasts` parity, and Live opt-in/discovery belongs to Community (`docs/ROADMAP.md` §5). |
| **S5** | Audio source resilience beyond YouTube | **Moved.** Critical platform work, but already tracked under acquisition resilience in `docs/ROADMAP.md` §2 rather than Discovery. |
| **S2** / **X1** | DSP-based Discover/Radio ranking, taste pockets & 2D Vibe/Energy Map | **Rejected.** The DJ engine already uses `cache/dj/analysis.sqlite3` DSP features to order sets (`order_continuous_route`). Unplayed external Discover/Radio candidates have no decoded audio to measure, and scoring candidates by cached DSP would create a self-reinforcing loop favoring already-downloaded songs (`shared/dj/routes.py`). |
| **X2** | `"Play Discover as a DJ Mix"` shelf CTA | **Rejected.** Launching a DJ session from a `"More like {artist}"` shelf duplicates existing Artist/Track DJ entry points, while free DJ sessions already launch dynamically via `enterAutoMode()` (`openAutoFromCollection` in `ui_web/src/stores/dj.ts`; fixing its empty-library Deezer seed resolution is rolled into `U2`). |
| **X3** | MusicBrainz Label / Band Member / Scene pages | **Rejected.** Strict 1 req/s upstream limit and high multi-surface UI maintenance for narrow niche value. |
| **X4** | Bandcamp, SoundCloud, Internet Archive, Radio Browser | **Rejected / Moved.** Bandcamp/SoundCloud lack stable public APIs (fragile scraping); Internet Archive is too niche; Radio Browser (if ever pursued) belongs to a separate live-radio initiative. |
| **X5** | Station Circle (multi-user) & Agent API NL queries | **Rejected / Deferred.** Low priority; Agent API should expose structured filters when needed rather than server-side NLP. |

---

## Guardrails

- **Payload budget:** Web UI `ui_build` enforces a strict gzipped initial
  authenticated payload ceiling (see `docs/internal/audits/WEB_UI_REVIEW_HANDOFF.md`).
- **Full-track playback only (`U2`):** Do not add 30-second Deezer preview clip
  playback. Latency work targets full-track resolution, cache reuse, and
  prefetching while preserving single-flight guarantees, egress-keyed stream
  caches, and upstream rate limits.
- **Privacy & local-first defaults:** All external read-back (`S1`) and
  personalization signals must respect `learning_enabled`
  (`discovery_settings.json`) and activate only for services the user explicitly
  connected.

---

## Decisions

Record user product and architecture choices here so future sessions never relitigate settled questions.

| Date | Topic | Decision |
| --- | --- | --- |
| 2026-11-21 | Scope & workflow | Track Discovery & recommendation iterations in this living handoff (`docs/internal/discovery/HANDOFF.md`), keeping it updated as items are discussed, changed, or closed. |
| 2026-11-21 | Rediscover (`D5`) | *(Superseded)* The recency + affinity ranking rules described here (14-day cooldown, rating/favourites/play-count weighting, 2-per-artist cap, and retaining section-referenced items past `limit`) were implemented in `feat/discovery-shelves-and-signals`, and the `Rediscover` shelf was later retired from Discover on 2026-11-22 (see the outward-only Discover distillation row below). |
| 2026-11-21 | Structured shelves (`D2`) | `SearchDiscoveryView` consumes localized `trackShelves` resolved from `feed.sections` via `resolveDiscoveryTrackShelves` (shared across web and Android), displaying section `reason` subtitles and `Similar to {artist}` entity card attribution while falling back cleanly to a single `"Songs you might like"` shelf when a feed returns flat `items` without `sections`. |
| 2026-11-21 | Freshness, seed rotation & push (`D4`) | `shared/discovery_seeds.py` consolidates taste and graph seed selection with diacritic folding and per-user LRU rotation damping (`penalty=0.02`); `discovery_browse.py` keeps `single` and `ep` releases alongside `album` with `record_type` and `release_date`; `discovery_feed_ready` pushes over a zero-dependency `ui_web/src/lib/discoveryEvents.ts` bus so `ui_web/src/mobile/` avoids importing `socket.io-client`, while `AndroidStart.tsx` catches `discovery_feed_ready` directly instead of triggering a full library sync. |
| 2026-11-21 | Row actions & canonical ranking (`D3`) | `rank_recommendation_rows` preserves canonical `music:deezer:` and `music:track:` identities instead of copying bare `id` to `youtube_id`, allowing `not_interested` feedback (including `isrc`/`deezer_id`) to demote Deezer rows; desktop `CatalogResultRow` exposes a full `<IconButton>` overflow trigger (`…`, grouped in `.actionStripe`) + keyboard/context-menu parity, unresolved Deezer rows offer `Start radio`, recommendation `reason`, and immediate UI dismissal with Undo across web and Android, and the Discover Refresh trigger lives in the top `Descubrir` header row (`ViewHeader` / `AppBar` on web, beside the search bar on Android) so zero blank band appears above the first shelf. |
| 2026-11-21 | Unified discovery engine (`D6`) | `discoveryFeedStore.ts` becomes the single reactive web client store (`search-discovery` namespace + `discovery_feed_ready` push + refcounted `retainDiscoveryFeed` abort/cleanup) powering both `/search` Discover (`SearchDiscovery.tsx`) and Now Playing Explore (`NowPlayingBrowser.tsx`), sharing dismissal state (`dismissDiscoveryItem`/`restoreDiscoveryItem`) and unresolved Deezer recommendation feedback/menu actions while retiring `nodeDiscover.ts` and client `api.discoverFeed` / `discover_seed_ready` consumers; server `/api/discover/feed` keeps `?seeds=` 400 validation for external callers while auto-selecting rotated seeds via `select_graph_seed_tracks` and refreshing active user discovery caches in `_expand_seed`. |
| 2026-11-21 | Full-track resolution over 30s previews (`U2`) | Rejected Deezer 30-second clip auditioning: listeners want full songs, Deezer's 30s excerpts do not align cleanly with full YouTube streams for handoff, and short-lived signed preview URLs add maintenance overhead. Replaced `U2` with auditing and validating whether the existing full-track resolution, caching, and prefetch pipeline has concrete improvements worth shipping. |
| 2026-11-22 | Focused Discovery direction & backlog trim | Narrowed the active backlog to one clear loop (`Discover → play full tracks cleanly → Artist/Album → Radio/DJ`) across 8 focused items (`U1`, `U2`, `U3`, `U5`, `S3`, `S1`, `S2`, `X2`). Replaced the onboarding wizard / Deezer `/genre` & `/radio` with passive day-1 adaptation (`U3`: read `saved_entities` as taste seeds, emit `music_search_played`, and auto-refresh cold cached feeds on the first real signal). Rejected `"Snooze 30 days"`, the `Comfort Zone ↔ Deep Cuts` dial, 2D Vibe Map / `"Sonic Twins"` UI (absorbing `analysis.sqlite3` DSP features silently into `S2` for mood/tempo coherence in clustering, Radio, Autoplay, and `Rediscover` — `S2` later descoped, see the outward-only row), `/` vs. `/search` IA rewrite (`U4`), MusicBrainz label/scene pages (`X3`), Bandcamp/SoundCloud/Archive (`X4`), and Station Circle/NL Agent queries (`X5`); moved podcasts/Live (`S4`) and audio source resilience (`S5`) back to their own areas. |
| 2026-11-22 | New Releases (`U1`) & Day-1 adaptation (`U3`) | `U1` checks up to 8 unrotated artist seeds (`select_release_seed_artists`, prioritizing saved entity bookmarks and reusing stored `deezer_artist_id`) over a 180-day window (`_NEW_RELEASE_WINDOW_DAYS = 180`), sorting strictly newest-first, capping at 2 per artist, flagging releases within 30 days with `is_new`, and deduplicating against `albums`. `U3` scores saved artist (`8.5` base) and album (`5.5` base) bookmarks in `select_taste_artists`, accepts `music_search_played` (`0.6`) on active search playback (`q.trim().length >= 2`), wakes cached cold feeds (or saved-entity/favourite changes) via `notify_discovery_signal`, and displays a non-blocking `coldHint` only on cold popular feeds without spawning background refreshes when no feed is cached. |
| 2026-11-22 | Outward-only Discover distillation (`D5`, `S2`, `X2` retired) | Removed `Made for Your Library`, `From {playlist}`, and `Rediscover` from Discover (`/api/discovery/music/feed`, `discovery_intelligence.py`, `searchDiscovery.ts`, and locale bundles) so `/search` never re-lists tracks the listener already owns in Library (`/`). Kept `build_music_recommendations` strictly as the local candidate pool ranker (`sections: []`) for Radio/Autoplay/DJ (`music_plan.py`), updated `build_browse_sections` (`discovery_browse.py`) so `"Albums for you"` prioritizes related artists first (`[*artists, *seeds]`) and excludes owned albums (`owned_album_keys`), discarded `S2` (DSP cannot score unmeasured external candidates and is already used by DJ ordering) and `X2` (duplicate shelf DJ CTA; empty-library Deezer seed resolution in `openAutoFromCollection` rolled into `U2`), leaving 4 focused open items (`U2`, `U5`, `S3`, `S1`). |
| 2026-11-22 | Complete Artist & Album Pages (`U5`) | Enriched `/api/catalog/album` from the already-fetched Deezer `album/{id}` payload (`release_date`, `label`, `duration` with track-sum fallback, `record_type`, `artist_deezer_id`) plus up to 12 newest-first `more_by_artist` releases (excluding self, failure isolated in `partial_failures`), and added `release_date` + `latest_release` to `/api/catalog/artist` with no extra Deezer request. Shared `ReleaseShelf`, `formatTotalDuration`, `formatReleaseDate`, and `formatRecordType` across web and Android (`Artist.tsx`, `Album.tsx`, `ArtistDiscoveryView.tsx`, `EntityProfile.tsx`), adding the Latest Release spotlight, Discover-only label credit and *"More by {artist}"* rail, a visible **Start radio** hero button, and an options-menu **Start a DJ session** action reusing existing radio and DJ paths (`startCatalogRadio`, `actions.startRadio`, `enterAutoMode` + `useCatalogCollection`/`startDjSelection`, and Android `djSelection`). |
| 2026-11-22 | Album genre not shown (`U5`) | The album hero does not show Deezer's album genre. It is a coarse label-assigned category ("Pop", "Films/Jeux vidéo"; CAM Sugar's composer compilations come tagged jazz), it leads nowhere and filters nothing, and no recommendation, Radio, Autoplay or DJ logic reads it. The hero keeps release date, track count and runtime. Library genre from file tags (Library filters, metadata editor, Subsonic) is a separate field and unaffected. |
| 2026-11-22 | Cross-provider alias table & artist feedback (`S3`) | Added write-time `discovery_signal_aliases(alias, identity)` table (backfilled once for existing installs by bumping `DISCOVERY_PROFILE_POLICY_VERSION` to `"3"` in `ensure_discovery_profile_policy`) so request-scoped `_SignalIndex` loads in O(signals + aliases) without scanning `discovery_events`, with one-hop aliasing (no transitive closure) and deduplicated canonical aggregation across `youtube_id`, `track_id`, `isrc`, `deezer_id`, `mbid`, and diacritic-folded `music:meta:`. Wrapped background discovery refresh/graph workers in `request_scope.request_scope()`. Added `less_from_artist` on `/api/discovery/feedback` storing undoable primary-artist signals (`artists[0]` else `artist`, matching collaborations via structured `artists` without string splitting) gated by `learning_enabled`: excludes rejected artists from taste/release seeds (`discovery_seeds.py`), softly demotes them via `_signal_multiplier` across `rank_recommendation_rows`, `discovery_browse.py`, and `_deezer_related_artist_rows`, and wires `"Less from this artist"` with immediate artist-wide dismissal and Undo on web (`discoveryFeedStore.ts`, `entryActions.ts`, `trackActions.tsx`) and Android (`songActions.ts`, `CatalogSearch.tsx`). |

---

## Iteration Log

| Date | Commit / PR | Summary |
| --- | --- | --- |
| 2026-11-21 | `docs/discovery-handoff` (baseline `7f5486e7`) | Initial full-stack discovery study covering sources, backend feed/planner/graph, local signals, DJ DSP features, and web/Android Discover UI; established phased backlog (`D1–D6`, `U1–U5`, `S1–S5`, `X1–X5`). |
| 2026-11-21 | `feat/discovery-shelves-and-signals` | Closed **D1**, **D5**, and **D2** in a single vertical slice: `"More like {artist}"` now pulls round-robin top tracks from related artists (with diacritic folding); `Rediscover` scores dormant high-affinity tracks via `track_user_state` + rollup timestamps with a 14-day cooldown; web and Android `SearchDiscoveryView` render localized backend track shelves, section reasons, dynamic `?browse=<sectionId>` expansion, and entity `reason_artist` attribution. |
| 2026-11-21 | `feat/discovery-freshness-and-push` | Closed **D4**: added `shared/discovery_seeds.py` for diacritic-folded seed ranking and per-user soft rotation; fixed diacritic matching and included `single`/`ep` releases with `record_type` and `release_date` in `discovery_browse.py`; wired `discovery_feed_ready` Socket.IO push (web + Android `EnginePlugin.kt`), home Refresh control, Single/EP release labels, and speculative prefetch of top Discover songs. |
| 2026-11-21 | `feat/discovery-row-actions-and-feedback` | Closed **D3**: added desktop overflow (`…`), right-click, and keyboard menu parity on `CatalogResultRow`; exposed `Start radio`, recommendation `reason`, and `Not interested` (`deezer_id`/`isrc` + immediate row dismissal and Undo) on unresolved Deezer rows across web (`entryActions.ts`, `SearchDiscovery.tsx`) and Android (`songActions.ts`, `CatalogSearch.tsx`, `AndroidStart.tsx`); fixed `rank_recommendation_rows` canonical identity handling. |
| 2026-11-21 | `feat/unify-discovery-engines` | Closed **D6**: unified `/search` Discover and Now Playing Explore onto `discoveryFeedStore.ts` (`/api/discovery/music/feed` + `discovery_feed_ready` Socket.IO push), brought recommendation reasons and `Not interested`/Undo feedback into Now Playing Explore, retired `nodeDiscover.ts` / `api.discoverFeed` / `discover_seed_ready` client handlers, and wired `discovery_graph.py` to `select_graph_seed_tracks` + active feed cache invalidation. |
| 2026-11-22 | `docs/discovery-u2-full-track-resolution` (PR #491) | Distilled Discovery around one clear product loop (`Discover → full-track playback → Artist/Album → Radio/DJ`): replaced **U2** with a full-track resolution audit, replaced **U3** with passive day-1 adaptation (`saved_entities` + instant cold-feed refresh), folded `analysis.sqlite3` DSP features silently into **S2**, trimmed **U5** and **S3**, and moved rejected/out-of-scope items (`old U2`, `old U3`, `U4`, `S4`, `S5`, `X1` UI, `X3`, `X4`, `X5`) into an explicit Descoped table. |
| 2026-11-22 | `feat/discovery-new-releases-and-day1` | Closed **U1** and **U3**: added the `New releases` / `Novedades` rail (`new_releases`, 180-day window, 30-day `New` badge, localized release dates, unrotated saved-entity & taste seeds, album deduplication, `?browse=new_releases`) and passive Day-1 adaptation (`saved_entities` taste seeding, `music_search_played` telemetry on web & Android, automatic cold-feed cache refresh via `notify_discovery_signal`, subtle `coldHint` note, and Android resume-sync on `discovery_feed_ready`). |
| 2026-11-22 | `feat/distill-discovery-shelves` | Distilled Discover shelves to strictly outward music discovery and trimmed the remaining open backlog to 4 items (`U2`, `U5`, `S3`, `S1`): retired `Made for Your Library`, `From {playlist}`, and `Rediscover` (**D5**) from Discover and client shelf resolvers, stopped injecting local library shelves into `/api/discovery/music/feed`, prioritized related-artist albums in `"Albums for you"` (`discovery_browse.py`) while excluding owned albums, and descoped **S2** (DSP for Discover) and **X2** (duplicate shelf DJ CTA; cold-start free DJ Deezer seed fix folded into `U2`). |
| 2026-11-22 | `feat/discovery-artist-album-pages` | Closed **U5**: surfaced Deezer album metadata (`release_date`, `label`, `duration` with track-sum fallback, `record_type`, `artist_deezer_id`) and up to 12 newest-first `more_by_artist` releases (excluding self, error-isolated in `partial_failures`) in `/api/catalog/album`; kept `release_date` on artist releases and returned `latest_release` from `/api/catalog/artist`; updated web (`Album.tsx`, `Artist.tsx`, `ArtistDiscoveryView.tsx`) and Android (`EntityProfile.tsx`, `CatalogSearch.tsx`, `AndroidStart.tsx`) with localized album hero metadata, Discover-only `℗ <label>` credit and *"More by {artist}"* rail, Artist Latest Release spotlight, visible **Start radio** CTA, and options-menu **Start a DJ session** action. |
| 2026-11-22 | `fix/discovery-album-credited-artists` | Credited multi-artist Deezer releases truthfully across `New releases` and Album pages: `_deezer_album_profile` (`shared/api/routes/catalog.py`) joins deduplicated `role == "Main"` `contributors` in Deezer order for `artist` (with structured `artists` for individual `<ArtistLinks>` on `Album.tsx` and resolved header credit on Android `EntityProfile.tsx`) and only populates `artist_deezer_id` / `more_by_artist` when an album has a single main artist other than Various Artists (`5080`); `build_browse_sections` (`shared/discovery_browse.py`) inspects chosen `new_releases` via `album/{id}` to surface multi-artist `Main` credits while keeping the 2-per-seed-artist cap by `owner_id` and falling back to `owner_name` on error. |
| 2026-11-22 | `feat/discovery-identity-and-artist-feedback` | Closed **S3**: unified `youtube_id`/`track_id`/`isrc`/`deezer_id`/`mbid`/folded `music:meta:` signals via `identity_aliases` and a write-time `discovery_signal_aliases` table (backfilled via policy v3, one-hop O(signals + aliases) lookup, no double counting), wrapped background discovery refresh/graph workers in `request_scope`, added undoable `"less_from_artist"` feedback (`music:artist:` + `music:deezer_artist:`, structured `artists` collaboration matching) excluding rejected artists from taste/release seeds and softly demoting them across ranked shelves, browse sections, and related-artist pools, and wired `"Less from this artist"` with immediate artist-wide dismissal + Undo across web, Now Playing Explore, Android, and all four i18n bundles. |
| 2026-11-22 | `fix/queue-pending-songs` | Unresolved Discover rows (Deezer songs not yet matched to a video) now offer **Play next** and **Add to queue**; before, only resolved and library songs did. Both queues already hold a `pendingResolve` song and match it shortly before it plays, so each platform has one queue pair for every song: web `queueActions` (`trackActions.tsx`, used by `buildTrackMenu` and by `buildEntryMenu` through `pendingEntryTrack`; `enqueue`/`playNext` take a `ContextTrack`) and Android `programQueueActions` (`lib/program/libraryMenu.ts`, used by `programLibraryMenu` and by the unresolved-row menu in `CatalogSearch.tsx` with `pendingCatalogTrack`). The pair stays out of DJ sessions, as for library songs. |
| 2026-11-23 | `feat/now-playing-search-panel` | The player's left panel (`PlayerSearchPanel.tsx`, replacing `NowPlayingBrowser.tsx`) no longer has an Explore tab: its idle state shows the first five `discoveryExploreItems()` as **For you**, with the same `Not interested` / `Less from this artist` menu and a link to `/search` Discover. It reads the same `discoveryFeedStore.ts` (`retainDiscoveryFeed` while the panel is active), so dismissals stay shared with Discover. Catalog search requests now go through one controller, `lib/catalogSearch.ts`, used by both `/search` and the panel. |
