# New Releases & Day-1 Passive Adaptation (2026-11-22)

Before/after captures for **U1** (`New releases` / `Novedades` rail) and **U3** (passive Day-1 adaptation with subtle cold-start hint).

## What changed

- **Backend (`U1` + `U3`)**:
  - `shared/discovery_seeds.py`: `load_saved_entity_artists` incorporates bookmarked artists and albums (`saved_entities.json`) into `select_taste_artists`, and `select_release_seed_artists` supplies unrotated artist seeds with known `deezer_id` values.
  - `shared/discovery_browse.py`: `build_browse_sections` adds the `new_releases` rail over a 180-day window sorted strictly by `(release_date, id)` descending, flags releases within 30 days with `is_new: true`, reuses saved `deezer_id` values and per-build caches, and deduplicates against `albums`.
  - `shared/discovery_intelligence.py`: accepts `music_search_played` (`0.6` positive weight) in `POSITIVE_LISTENING_EVENTS`.
  - `shared/api/routes/discovery_common.py`, `discovery_feed.py`, `discovery.py`, `library.py`, `scrobble.py`, `shared/library_intake.py`, `shared/api/library_scan.py`, `shared/migration/service.py`: `notify_discovery_signal` invalidates cached Discover feeds and triggers immediate background refresh + `discovery_feed_ready` push when a cached feed was cold or when bookmarks/favourites change.
- **Frontend (`U1` + `U3`, web + Android)**:
  - `ui_web/src/lib/api.ts`, `ui_web/src/lib/searchDiscovery.ts`, `ui_web/src/components/SearchDiscoveryView.tsx`, `SearchDiscovery.module.css`, `SearchDiscovery.tsx`, `ui_web/src/routes/Search.tsx`, `ui_web/src/mobile/discoveryFeed.ts`, `ui_web/src/mobile/CatalogSearch.tsx`, and all four locale dictionaries (`en`, `es`, `fr`, `zh`): render `Novedades` / `New releases` with the `Nuevo` / `New` badge, localized release dates, `?browse=new_releases` expansion, subtle `coldHint` on cold popular feeds, `music_search_played` telemetry on active search plays, and Android `staleFromPush` refresh on resume.

## Captures

Chromium, dark theme, Spanish copy, mocked `/api/discovery/music/feed` fixtures for personalized (with `new_releases`) and cold (`needs_seed: true`, popular charts only) states.

| View | Before | After |
| --- | --- | --- |
| Desktop personalized Discover (1280×800) | [Before](before-discover-desktop.png) | [After](after-discover-desktop.png) |
| Mobile personalized Discover (390×844) | [Before](before-discover-mobile.png) | [After](after-discover-mobile.png) |
| Desktop cold-start Discover (1280×800) | [Before](before-cold-desktop.png) | [After](after-cold-desktop.png) |
| Mobile cold-start Discover (390×844) | [Before](before-cold-mobile.png) | [After](after-cold-mobile.png) |
