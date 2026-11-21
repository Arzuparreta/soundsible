# Handoff: Discovery, Recommendations & Music Sources (2026-11-21)

Entry point for recalling the full discovery study and iterating on Soundsible's
discovery flow, recommendation engine, music sources, and Discover UI without
the original chat history.

Baseline checked against `main` at `7f5486e7` on 2026-11-21. Line numbers below
describe that baseline; search by symbol name if code has moved.

---

## How to work with this document

- **Recall first.** Before proposing or implementing any change to Discover,
  recommendations, Browse/Home IA, artist/album catalog enrichment, or external
  discovery sources, read this handoff and its **Status** and **Decisions**
  tables.
- **Tackle by ID or theme.** Work item by item (or in user-selected groups)
  using the stable IDs below (`D*` baseline defects, `U*` UI/UX & freshness,
  `S*` sources & intelligence, `X*` Soundsible-only differentiators).
- **Keep this handoff current on every PR.** Whenever an item is refined,
  decided, started, partially shipped, closed, or rejected:
  1. Update its row in the **Status** table (status, PR/commit, evidence, and
     any remaining limit).
  2. Record any product or architectural decision in **Decisions**.
  3. Append a concise dated entry to the **Iteration log** so the next agent
     sees the trajectory at a glance.
- **Follow `AGENTS.md` gates:**
  - Branch off latest `origin/main`, commit, open a PR with an `impact:*` label,
    and wait for every GitHub check on the latest remote head to pass.
  - Never run `npm run build` in `ui_web/`.
  - If `ui_web/` changes, run the full Playwright suite on all four CI profiles
    and include before/after images (or video for motion/timing).
  - Keep web and Android (`ui_web/src/mobile/`) in sync where they share
    contracts (`SearchDiscoveryView.tsx`, `ArtistDiscoveryView.tsx`,
    `discoveryFeed.ts`, `CatalogSearch.tsx`).
  - Respect the architectural boundary in `docs/internal/ARCHITECTURE.md`:
    **explicit text search (`/api/catalog/search`) stays strictly query-only**
    (never reads recommendation signals, favourites, or account history). All
    personalization belongs to discovery, home/browse, radio, autoplay, and DJ.

---

## Baseline Inventory (as of `7f5486e7`)

### Current discovery surfaces
1. **Primary Discover surface** — empty-query state of `/search`
   (`ui_web/src/routes/Search.tsx` → `ui_web/src/components/SearchDiscovery.tsx`
   → `ui_web/src/components/SearchDiscoveryView.tsx`; shared on Android by
   `ui_web/src/mobile/CatalogSearch.tsx` + `ui_web/src/mobile/discoveryFeed.ts`).
   Calls `GET /api/discovery/music/feed` (`shared/api/routes/discovery_feed.py`)
   and renders only 3 static blocks:
   - `Artists to discover` (or `Popular artists`): up to 10 Deezer related or
     global chart artists (`shared/discovery_browse.py`).
   - `Albums for you` (or `Popular albums`): up to 10 Deezer full albums
     (`record_type == "album"` only; singles and EPs excluded).
   - `Songs you might like`: 5 rows inline (`slice(0, 10)` on "See all"),
     flattened from `feed().items`.
2. **Secondary hidden Discover surface** — inside the full player's browser
   (`ui_web/src/components/NowPlayingBrowser.tsx`, `RootView`), powered by a
   completely separate client-side seed sampler (`ui_web/src/lib/nodeDiscover.ts`)
   calling `GET /api/discover/feed` (`shared/api/routes/discovery_graph.py`)
   with Socket.IO streaming (`discover_seed_ready`) over YouTube `RD` mixes.
3. **Passive & active continuation** — Autoplay, Radio, and the two-deck
   beatmatched DJ mode (`shared/api/routes/auto_mode.py`,
   `shared/listening_planner.py`, `shared/music_plan.py`,
   `shared/music_candidates.py`).
4. **Entity exploration** — native Artist (`ui_web/src/routes/Artist.tsx`,
   `ArtistDiscoveryView.tsx`) and Album (`ui_web/src/routes/Album.tsx`) pages
   backed by Deezer (`shared/api/routes/catalog.py`, `shared/deezer_catalog.py`)
   with library reconciliation.
5. **Library root (`/`)** — `ui_web/src/routes/LibraryHome.tsx` +
   `ui_web/src/components/SavedEntities.tsx`: static navigation shortcuts and
   saved album/artist bookmarks only; no Home feed or Jump Back In.
6. **Podcasts (`/podcasts`)** — `ui_web/src/routes/Podcasts.tsx` +
   `shared/api/routes/podcasts_directory.py`: Apple RSS country top-20 shows
   and top-20 episodes, client-side genre dropdown over only those 20 rows, and
   iTunes search. `GET /api/discovery/podcasts/recommendations` is called only
   on Android (`ui_web/src/mobile/PodcastDirectory.tsx`), not web.
   `GET /api/discovery/music/recommendations` has no frontend caller at all.
7. **Live community rooms (`/live`)** — `shared/api/routes/community.py`:
   completely isolated from Discover.

### Current sources & signal inventory
| Layer | Source / Store | Current Role | Unused Potential Already in Repo |
| --- | --- | --- | --- |
| Metadata & browse | **Deezer public API** (`shared/providers/deezer.py`) | Artist/album profiles, related artists, artist top tracks, global charts, text search | `/genre`, `/chart/{genre}`, `/editorial`, `/radio`, `/playlist`, album `release_date` freshness, and **direct 30-second HTTPS `preview` MP3 URLs** on track rows. Quota: ~50 req/5s unauthenticated; field-search syntax broke in Oct 2026. |
| Metadata & identity | **MusicBrainz** (`shared/catalog_search.py`, `shared/musicbrainz.py`) | Recording search inside `/api/catalog/search` only; MBID stored on tracks | Artist relationships (band members, collaborations, labels), folksonomy genre/scene tags, release groups, Wikidata/Wikipedia bio links. |
| Audio & related graph | **YouTube via `yt-dlp`** (`shared/downloader/youtube/search.py`, `shared/preview_streams.py`) | 100% of audio previews, downloads, and `RD{video_id}` related mixes | Single point of failure; cold Deezer tap costs ~0.9s search + ~1–3s stream extraction; exposed to music-video intros, live/lyrics noise, and VPS bot blocks. |
| Podcasts | **Apple RSS & iTunes API** (`shared/api/routes/podcasts_directory.py`) | Country top charts, top episodes, search | Personalized episode/show recommendations unused on web. |
| Scrobbling (outbound) | **ListenBrainz, Last.fm, Maloja** (`shared/scrobble/clients.py`) | Write-only (`submit-listens` / `track.scrobble` / `now_playing`) | **Zero read-back.** ListenBrainz offers free CF recommendations, Fresh Releases, Weekly Exploration, and Similar Artists by MBID; Last.fm offers `artist.getSimilar`, `track.getSimilar`, `tag.getTopTracks`, `artist.getInfo`. |
| Local listening & library | `listening-events.jsonl`, `discovery_signals`, `tracks`, `track_user_state` (`shared/discovery_intelligence.py`, `shared/db/schema.py`) | 45-day half-life artist frequency over last 2,000 JSONL lines; exact-identity soft multiplier | `genre`, `year`, `play_count`, `rating`, `last_played_at` in `tracks`/`track_user_state` are unused by Discover. |
| Audio DSP | `cache/dj/analysis.sqlite3` (`shared/dj/features.py`, `shared/dj/contracts.py`) | DJ transition ordering & cue planning only | Measured **BPM, key, mode, note rate, LUFS, spectral flatness, octave-band energy, and structure (intro/build/drop/breakdown/outro)** are never read by Discover. |

---

## Competitive Gap Summary (vs. Spotify & Apple Music)

Qualitative capability snapshot (0–10) at baseline `7f5486e7`:

| Dimension | Soundsible Today | Spotify / Apple Music | Self-Hosted Ceiling | Primary Gap |
| --- | ---: | ---: | ---: | --- |
| Sources & Catalog | 4.0 | 9.2 | 8.8 | Single metadata source (Deezer) in Discover; single audio source (YouTube); MusicBrainz/ListenBrainz/Last.fm/underground sources untapped. |
| Taste & Collaborative Graph | 2.8 | 9.5 | 7.8 | No collaborative filtering read-back; no taste clustering (genre blender); deterministic top-5 seeds freeze the feed. |
| Audio / DSP & Moods | 1.5 | 8.5 | 9.6 | Rich DSP analysis exists in `analysis.sqlite3` but is completely disconnected from Discover; no mood/vibe browsing. |
| Freshness & Releases | 1.0 | 9.0 | 8.6 | Zero release-date awareness; no Release Radar / New Music Friday; singles & EPs dropped from `Albums for you`. |
| Discover UI & Browse | 2.4 | 9.2 | 9.0 | Discover buried in Search empty state; backend sections/reasons discarded; no Home hub, Quick Picks, genre/mood tiles, or card hover actions. |
| Auditioning & Latency | 3.2 | 9.6 | 8.2 | 2–4s cold `yt-dlp` resolve wait per tapped Deezer song; Deezer 30s instant previews unused; no prefetch on Discover songs. |
| Transparency & Control | 3.0 | 5.2 | 9.8 | `"Not interested"` unreachable on desktop web and unresolved Deezer rows; exact-ID-only decay; no user-facing taste dials. |
| Active & Live Discovery | 6.5 | 6.8 | 9.6 | Strong DJ/Radio foundation, but DJ mixes and Live community rooms are not surfaced inside Discover. |

---

## Work Backlog & Status

ID prefixes:
- **D** — Baseline defects & leaked signals (Phase 1: fix what is already built)
- **U** — Discover/Home UX, freshness & entity richness (Phase 2: core daily parity)
- **S** — Open source federation & taste intelligence (Phase 3: recommendation depth)
- **X** — Soundsible-only differentiators (Phase 4: surpass paid services)

| ID | Phase | Item | Key Files | Status |
| --- | --- | --- | --- | --- |
| **D1** | 1 | Fix `"More like {artist}"` bug: fetch tracks from *related* artists instead of the seed artist's own top tracks (which `compose_discovery_feed` then truncates to 2 rows via its 2-per-artist cap). | `shared/api/routes/discovery_feed.py`, `shared/discovery_intelligence.py` | Closed (`feat/discovery-shelves-and-signals`: `_deezer_related_artist_rows` folds diacritics, fetches `artist/{id}/related` + round-robin `/top`, skips seed/owned tracks, and populates `reason_key="because_listen"`.) |
| **D2** | 1 | Render backend `sections`, `reason`, and `reason_artist` in the Discover UI instead of discarding `feed().sections` and flattening into one 5–10 row `"Songs you might like"` list. | `ui_web/src/components/SearchDiscovery.tsx`, `SearchDiscoveryView.tsx`, `ui_web/src/mobile/discoveryFeed.ts` | Closed (`feat/discovery-shelves-and-signals`: `resolveDiscoveryTrackShelves` renders localized shelves + reason subtitles, `?browse=<sectionId>` expansion, `reason_artist` attribution on entity cards, and flat-`items` fallback across web + Android.) |
| **D3** | 1 | Fix unreachable feedback & actions on Discover rows: add overflow (`…`) / context menu on desktop `CatalogResultRow`, and expose `Not interested`, `Start Radio`, and recommendation `reason` for unresolved Deezer rows (web + Android). | `ui_web/src/components/CatalogResultRow.tsx`, `entryActions.ts`, `trackActions.tsx`, `ui_web/src/mobile/CatalogSearch.tsx` | Closed (`feat/discovery-row-actions-and-feedback`: desktop `CatalogResultRow` adds overflow `<IconButton>` + right-click + `ContextMenu`/`Shift+F10`; `entryActions.ts` & `CatalogSearch.tsx` expose `Start radio`, recommendation `reason`, and `Not interested` with `deezer_id`/`isrc` + immediate row dismissal & Undo on unresolved Deezer rows; `rank_recommendation_rows` preserves canonical `music:deezer:` and `music:track:` identities.) |
| **D4** | 1 | Fix browse & freshness edge cases: fold diacritics in `discovery_browse.py` (like `deezer_catalog.resolve_artist_id`), include singles/EPs in releases, add seed rotation + Refresh button, replace 5s polling loop with Socket.IO push, and prefetch/pre-resolve top Discover songs. | `shared/discovery_seeds.py`, `shared/discovery_browse.py`, `shared/api/routes/discovery_feed.py`, `ui_web/src/lib/discoveryEvents.ts`, `ui_web/src/components/SearchDiscovery.tsx`, `ui_web/src/components/SearchDiscoveryView.tsx`, `ui_web/src/mobile/discoveryFeed.ts`, `EnginePlugin.kt` | Closed (`feat/discovery-freshness-and-push`: `shared/discovery_seeds.py` adds diacritic-folded seed scoring and per-user soft rotation (`0.02` penalty); `discovery_browse.py` uses `fold_text` + `nb_fan` tiebreak and preserves `single`/`ep` with `record_type`/`release_date`; `discovery_feed.py` emits `discovery_feed_ready` after clearing inflight state; web and Android replace 5s polling with push-first + 15s bounded fallback, add a home Refresh button, label Singles/EPs, and speculatively pre-resolve/prefetch top visible Discover songs.) |
| **D5** | 1 | Fix `Rediscover` section to use real listening recency & affinity (`last_played_at`, `play_count`, old favourites) instead of the first 12 unplayed tracks in manifest order. | `shared/discovery_intelligence.py`, `shared/db/user_state.py` | Closed (`feat/discovery-shelves-and-signals`: `_build_rediscover_section` reads `track_user_state` + JSONL timestamps, enforces a 14-day cooldown, skips low-rated/podcast rows, scores affinity + dormancy with 2-per-artist cap, and preserves section-referenced items in `build_music_recommendations`.) |
| **D6** | 1 | Unify the two disconnected discovery engines (`discovery_feed.py` vs. `nodeDiscover.ts` / `discovery_graph.py`) around one shared candidate/seed contract and cache lifecycle. | `shared/api/routes/discovery_common.py`, `discovery_graph.py`, `ui_web/src/lib/discoveryFeedStore.ts`, `SearchDiscovery.tsx`, `NowPlayingBrowser.tsx` | Closed (`feat/unify-discovery-engines`: retired `nodeDiscover.ts`, `api.discoverFeed`, and client `discover_seed_ready` handlers; introduced reactive `discoveryFeedStore.ts` (`retainDiscoveryFeed`, `discoveryExploreItems`, `dismissDiscoveryItem`/`restoreDiscoveryItem`, `resetDiscoveryFeed`, push-first `discovery_feed_ready`) consumed by both `SearchDiscovery.tsx` and `NowPlayingBrowser.tsx` Explore with shared cache and `Not interested` dismissal; updated `discovery_graph.py` to auto-select rotated seeds via `select_graph_seed_tracks`, delegate `_top_warm_seed_ids`, and trigger user feed refresh after expansion.) |
| **U1** | 2 | **New Releases / Release Radar** shelf: background check of saved + high-affinity artists' recent releases (albums, singles, EPs) sorted by `release_date` (newest first, highlighting last 14–30 days). | `shared/discovery_browse.py`, `shared/deezer_catalog.py`, `SearchDiscoveryView.tsx` | Open |
| **U2** | 2 | **Instant 30s Auditioning**: use Deezer's direct HTTPS `preview` MP3 URLs for instant hover/tap/crate-digging auditioning (<200ms) while full-track YouTube resolution warms in the background. | `shared/deezer_catalog.py`, `shared/api/routes/discovery_feed.py`, `ui_web/src/lib/catalogItem.ts`, `ui_web/src/lib/audio.ts` | Open |
| **U3** | 2 | **Genre, Mood & Chart Browse + Cold-Start Onboarding**: surface Deezer `/genre`, `/chart/{genre}`, `/radio`, and an interactive 3–5 artist/genre taste picker when `profile.maturity == "cold"`. | `shared/providers/deezer.py`, `shared/discovery_browse.py`, `SearchDiscoveryView.tsx` | Open |
| **U4** | 2 | **Home & Discover Information Architecture**: evaluate separating or upgrading Home (`/` vs. `/search`) with Jump Back In / Quick Picks grid, filter pills (`All`, `Music`, `New`, `Mixes`, `Podcasts`, `Live`), hover play overlays on cards, and varied visual rhythm. | `ui_web/src/routes/LibraryHome.tsx`, `Search.tsx`, `primaryNavigation.tsx`, `SearchDiscoveryView.tsx` | Open |
| **U5** | 2 | **Richer Artist & Album Pages**: Latest Release spotlight, Artist Radio / Mix with DJ CTA, clickable genre/scene tags, MusicBrainz/Wikidata (or Last.fm) bios & active years; show Album genre (already fetched), total runtime, release date, label, and "More by Artist / Similar Albums". | `shared/api/routes/catalog.py`, `ui_web/src/routes/Artist.tsx`, `ArtistDiscoveryView.tsx`, `Album.tsx` | Open |
| **S1** | 3 | **Two-Way ListenBrainz & Last.fm Federation**: read back ListenBrainz CF recommendations (`/1/cf/recommendation/…`), Fresh Releases, Weekly Exploration, and Similar Artists by MBID; read Last.fm `artist.getSimilar`, `track.getSimilar`, `tag.getTopTracks`, and `artist.getInfo` when connected. | `shared/scrobble/clients.py`, new provider modules under `shared/providers/`, `shared/api/routes/discovery_feed.py` | Open |
| **S2** | 3 | **Taste Clustering & Daily Mixes**: cluster the user's library + listening history by artist-graph neighborhoods, genres, and DSP features into 3–5 coherent taste pockets instead of one blended top-5 list; allow muting pockets (e.g. sleep/focus). | `shared/discovery_intelligence.py`, `shared/dj/store.py` | Open |
| **S3** | 3 | **Propagating Negative Feedback & Steerable Taste Dials**: unify cross-provider track identity (`deezer_id` ↔ `youtube_id` ↔ `isrc` ↔ `mbid`) in `discovery_signals`; propagate feedback to artist/tag/cluster with options ("Not this song", "Less from this artist", "Snooze 30 days"); expose an interactive `Comfort Zone ↔ Deep Cuts` adventure dial. | `shared/discovery_intelligence.py`, `shared/db/discovery.py`, Discover UI header | Open |
| **S4** | 3 | **Integrate Podcasts & Community Live into Discover**: wire personalized podcast recommendations into web (not just Android) and surface active public Live DJ rooms (`On Air Now`) with 1-tap tune-in and track save. | `ui_web/src/routes/Podcasts.tsx`, `shared/api/routes/community.py`, `SearchDiscoveryView.tsx` | Open |
| **S5** | 3 | **Audio Source Resilience (Reduce YouTube Single-Point-of-Failure)**: modularize playback/acquisition source selection beyond YouTube (aligned with `docs/ROADMAP.md` §2). | `shared/catalog_resolution.py`, `shared/preview_streams.py`, `shared/downloader/` | Open |
| **X1** | 4 | **DSP-Powered Sonic Discovery**: leverage `cache/dj/analysis.sqlite3` (BPM, Camelot key/mode, note rate, spectral flatness, LUFS) for *"Sonic Twins"*, *"Harmonic Neighbours"*, and a 2D Vibe/Energy Map (`Calm ↔ Driving` × `Warm/Acoustic ↔ Bright/Electronic`). | `shared/dj/store.py`, `shared/dj/features.py`, new discovery DSP index + UI | Open |
| **X2** | 4 | **"Play Discover as a DJ Mix"**: 1-tap continuous beatmatched radio set built from weekly discovery candidates or a selected taste pocket, using the existing DJ planner & transitions. | `shared/api/routes/auto_mode.py`, `shared/dj/planning.py`, Discover UI | Open |
| **X3** | 4 | **MusicBrainz Crate-Digging Rabbit Holes**: navigable **Record Label** pages (*"More on Warp / ECM / Stones Throw"*), **Band Member / Collaboration Trees**, and **Scene / City** exploration. | `shared/musicbrainz.py`, `shared/api/routes/catalog.py`, `ui_web/src/routes/` | Open |
| **X4** | 4 | **Underground & Human-Curated Open Sources**: optional providers for **Radio Browser** (40k+ internet radio stations like NTS, FIP, KEXP with live track ID → 1-tap save), **Bandcamp** tags/editorial, **SoundCloud** mixes/edits, and **Internet Archive** live sets. | `shared/providers/`, Discover UI | Open |
| **X5** | 4 | **Station Circle (Multi-User Opt-In) & Structured/Agent Discovery**: optional household/friends discovery (*"Spotted on this Station"* / shared blend) across accounts on the same instance, plus natural-language/structured queries via the Agent API (*"90s Bristol trip-hop under 90 BPM I don't own"*). | `shared/users.py`, `shared/api/routes/agent.py`, `shared/discovery_intelligence.py` | Open |

---

## Detailed Problem & Design Notes

### Phase 1 Diagnosis (Exact Code Findings)

- **D1 (`shared/api/routes/discovery_feed.py:213-248` + `shared/discovery_intelligence.py:931-945`)**:
  `_append_personalized_artist_sections` loops over `_top_taste_artists(metadata, fav_ids)` and calls `_deezer_artist_top_rows(artist, ...)`, putting that artist's own top tracks into a section titled `"More like {artist}"`. Then `compose_discovery_feed` enforces `artist_counts.get(artist, 0) >= 2` per section, dropping 8 of the 10 rows and penalizing the section via `size_quality = min(1.0, len(section_items) / 8)`. Fix: resolve each taste seed to its Deezer `artist/{id}/related` neighbors and pull representative top tracks from those related artists (plus optionally a separate `"Deep cuts from {artist}"` section if owned tracks are excluded).
- **D2 (`ui_web/src/components/SearchDiscovery.tsx:37-39`, `SearchDiscoveryView.tsx:41-66`)**:
  The backend already returns `sections`, `items`, `browse_sections`, and `profile`, and `discovery_browse.py` attaches `reason_artist` to every artist/album card. None of those fields are rendered. Fix: evolve `SearchDiscoveryView` to render typed shelves from the backend contract (horizontal entity rails, track shelves with `"Because you listen to X"` subtitles, and expandable sections) while preserving shared web/Android parity.
- **D3 (`ui_web/src/components/CatalogResultRow.tsx:54-108`, `entryActions.ts:25-58`, `catalogTrack.ts:22-57`)**:
  Desktop `CatalogResultRow` omits the overflow button and right-click menu altogether. On mobile, `entryActions.ts` only delegates to `buildTrackMenu` when `track` is non-null, which skips unresolved Deezer items (`catalogTrack` returns `null`). Fix: expose a unified overflow trigger + context menu on desktop and mobile `CatalogResultRow`, and move recommendation `reason`, `Not interested`, and `Start Radio` (which can seed via `title + artist` on `/api/discovery/music/plan`) outside the `if (track)` guard in `entryActions.ts`.
- **D4 (`shared/discovery_browse.py:53-106`, `discovery_feed.py:450-538`, `SearchDiscovery.tsx:43-65`)**:
  - Replace strict `casefold()` equality in `discovery_browse.py:56` with `fold_text` + fan-count tiebreak (reuse `deezer_catalog.resolve_artist_id`).
  - Allow `single` and `ep` in release rails (or separate/label record types rather than silently dropping them).
  - Rotate seeds across refreshes (inspired by `nodeDiscover.ts`'s `RECENT_SEED_PENALTY`) and expose a manual Refresh control.
  - Emit a Socket.IO event when `_refresh_discovery_feed_cache` completes instead of polling every 5s in `SearchDiscovery.tsx` / `discoveryFeed.ts`.
  - Speculatively pre-resolve + prefetch the first visible Discover songs (matching `Search.tsx:449-474`).
- **D5 (`shared/discovery_intelligence.py:762-781`)**:
  `_build_rediscover_section` currently iterates `tracks` in manifest order and picks the first 12 IDs not in `rollup.played_track_ids`. Instead, score owned tracks by high historical affinity (favourites, high `play_count` / `rating`, playlist membership) combined with long time since `last_played_at` (or old `added_at` with zero recent plays).
- **D6 (`shared/api/routes/discovery_graph.py` + `ui_web/src/lib/nodeDiscover.ts`)**:
  `NowPlayingBrowser` (`RootView`) runs a parallel discovery stack (`nodeDiscover.ts` → `/api/discover/feed`). Consolidate seed selection, exclusion, freshness tracking, and WebSocket push so both surfaces draw from one coherent engine.

### Key Guardrails for Later Phases
- **Payload budget:** Web UI `ui_build` enforces a strict gzipped initial authenticated payload ceiling (see `docs/internal/audits/WEB_UI_REVIEW_HANDOFF.md`). Heavy new Discover visualizations (e.g., 2D Vibe Map in X1) must be lazy-loaded.
- **No external API key required by default:** Core discovery (Phases 1–2 and DSP/MusicBrainz features) must work out of the box with zero user-supplied API keys. ListenBrainz and Last.fm read-back (S1) activate automatically when the user already has scrobbling connected (and public ListenBrainz/MusicBrainz endpoints work unauthenticated within their documented rate limits).
- **Deezer preview URL lifetime (U2):** Deezer `preview` MP3 URLs carry short-lived signed tokens (~15–30 min); do not cache them long-term in SQLite without re-fetching when expired.
- **Privacy & local-first defaults:** Multi-user Station Circle (X5) and any external source queries must stay strictly opt-in and respect `learning_enabled` (`discovery_settings.json`).

---

## Decisions

Record user product and architecture choices here so future sessions never relitigate settled questions.

| Date | Topic | Decision |
| --- | --- | --- |
| 2026-11-21 | Scope & workflow | Track the full Spotify/Apple Music discovery gap study and iterative improvements in this living handoff (`docs/internal/discovery/HANDOFF.md`), keeping it updated as items are discussed, changed, or closed. |
| 2026-11-21 | Rediscover (`D5`) | Exclude tracks played within the last 14 days and tracks rated `<= 2` (or podcast episodes); rank candidates by historical affinity (`favourites`, `rating`, `play_count`, playlist membership, artist affinity) + dormancy (`last_played_at`, or `added_at` for unplayed songs) with a 2-per-artist diversity cap, and ensure `build_music_recommendations` retains all section-referenced items past `limit`. |
| 2026-11-21 | Structured shelves (`D2`) | `SearchDiscoveryView` consumes localized `trackShelves` resolved from `feed.sections` via `resolveDiscoveryTrackShelves` (shared across web and Android), displaying section `reason` subtitles and `Similar to {artist}` entity card attribution while falling back cleanly to a single `"Songs you might like"` shelf when a feed returns flat `items` without `sections`. |
| 2026-11-21 | Freshness, seed rotation & push (`D4`) | `shared/discovery_seeds.py` consolidates taste and graph seed selection with diacritic folding and per-user LRU rotation damping (`penalty=0.02`); `discovery_browse.py` keeps `single` and `ep` releases alongside `album` with `record_type` and `release_date`; `discovery_feed_ready` pushes over a zero-dependency `ui_web/src/lib/discoveryEvents.ts` bus so `ui_web/src/mobile/` avoids importing `socket.io-client`, while `AndroidStart.tsx` catches `discovery_feed_ready` directly instead of triggering a full library sync. |
| 2026-11-21 | Row actions & canonical ranking (`D3`) | `rank_recommendation_rows` preserves canonical `music:deezer:` and `music:track:` identities instead of copying bare `id` to `youtube_id`, allowing `not_interested` feedback (including `isrc`/`deezer_id`) to demote Deezer rows; desktop `CatalogResultRow` exposes a full `<IconButton>` overflow trigger (`…`, grouped in `.actionStripe`) + keyboard/context-menu parity, unresolved Deezer rows offer `Start radio`, recommendation `reason`, and immediate UI dismissal with Undo across web and Android, and the Discover Refresh trigger lives in the top `Descubrir` header row (`ViewHeader` / `AppBar` on web, beside the search bar on Android) so zero blank band appears above the first shelf. |
| 2026-11-21 | Unified discovery engine (`D6`) | `discoveryFeedStore.ts` becomes the single reactive web client store (`search-discovery` namespace + `discovery_feed_ready` push + refcounted `retainDiscoveryFeed` abort/cleanup) powering both `/search` Discover (`SearchDiscovery.tsx`) and Now Playing Explore (`NowPlayingBrowser.tsx`), sharing dismissal state (`dismissDiscoveryItem`/`restoreDiscoveryItem`) and unresolved Deezer recommendation feedback/menu actions while retiring `nodeDiscover.ts` and client `api.discoverFeed` / `discover_seed_ready` consumers; server `/api/discover/feed` keeps `?seeds=` 400 validation for external callers while auto-selecting rotated seeds via `select_graph_seed_tracks` and refreshing active user discovery caches in `_expand_seed`. |

---

## Iteration Log

| Date | Commit / PR | Summary |
| --- | --- | --- |
| 2026-11-21 | `docs/discovery-handoff` (baseline `7f5486e7`) | Initial full-stack discovery study covering sources, backend feed/planner/graph, local signals, DJ DSP features, and web/Android Discover UI; established phased backlog (`D1–D6`, `U1–U5`, `S1–S5`, `X1–X5`). |
| 2026-11-21 | `feat/discovery-shelves-and-signals` | Closed **D1**, **D5**, and **D2** in a single vertical slice: `"More like {artist}"` now pulls round-robin top tracks from related artists (with diacritic folding); `Rediscover` scores dormant high-affinity tracks via `track_user_state` + rollup timestamps with a 14-day cooldown; web and Android `SearchDiscoveryView` render localized backend track shelves, section reasons, dynamic `?browse=<sectionId>` expansion, and entity `reason_artist` attribution. Before/after captures recorded in `docs/internal/measurements/discover-shelves-2026-11-21/`. |
| 2026-11-21 | `feat/discovery-freshness-and-push` | Closed **D4**: added `shared/discovery_seeds.py` for diacritic-folded seed ranking and per-user soft rotation; fixed diacritic matching and included `single`/`ep` releases with `record_type` and `release_date` in `discovery_browse.py`; wired `discovery_feed_ready` Socket.IO push (web + Android `EnginePlugin.kt`), home Refresh control, Single/EP release labels, and speculative prefetch of top Discover songs. Before/after captures recorded in `docs/internal/measurements/discover-freshness-2026-11-21/`. |
| 2026-11-21 | `feat/discovery-row-actions-and-feedback` | Closed **D3**: added desktop overflow (`…`), right-click, and keyboard menu parity on `CatalogResultRow`; exposed `Start radio`, recommendation `reason`, and `Not interested` (`deezer_id`/`isrc` + immediate row dismissal and Undo) on unresolved Deezer rows across web (`entryActions.ts`, `SearchDiscovery.tsx`) and Android (`songActions.ts`, `CatalogSearch.tsx`, `AndroidStart.tsx`); fixed `rank_recommendation_rows` canonical identity handling. Before/after captures recorded in `docs/internal/measurements/discover-row-actions-2026-11-21/`. |
| 2026-11-21 | `feat/unify-discovery-engines` | Closed **D6**: unified `/search` Discover and Now Playing Explore onto `discoveryFeedStore.ts` (`/api/discovery/music/feed` + `discovery_feed_ready` Socket.IO push), brought recommendation reasons and `Not interested`/Undo feedback into Now Playing Explore, retired `nodeDiscover.ts` / `api.discoverFeed` / `discover_seed_ready` client handlers, and wired `discovery_graph.py` to `select_graph_seed_tracks` + active feed cache invalidation. Before/after captures recorded in `docs/internal/measurements/discover-engine-unification-2026-11-21/`. |
