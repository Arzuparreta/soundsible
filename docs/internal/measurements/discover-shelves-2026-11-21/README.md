# Structured Discover shelves and entity attribution (2026-11-21)

Before/after captures for the first discovery slice (`D1`, `D5`, `D2`), which replaces the flat `"Songs you might like"` dump on Discover with localized structured shelves, section reasons, and entity card attribution.

## What changed

- **Backend (`D1`, `D5`)**:
  - `shared/api/routes/discovery_feed.py`: `"More like {artist}"` now folds diacritics to resolve the seed artist, fetches Deezer `artist/{id}/related`, and interleaves top tracks from up to 5 related artists round-robin (skipping the seed artist and owned library tracks) instead of pulling the seed artist's own top tracks.
  - `shared/discovery_intelligence.py` + `shared/db/user_state.py`: `Rediscover` reads `track_user_state` and JSONL timestamps, enforces a 14-day recency cooldown, skips low-rated (`<= 2`) and podcast rows, scores affinity + dormancy with a 2-per-artist cap, and preserves section-referenced items past `limit`.
- **Frontend (`D2`, web + Android)**:
  - `ui_web/src/lib/searchDiscovery.ts`, `ui_web/src/components/SearchDiscoveryView.tsx`, `ui_web/src/components/SearchDiscovery.tsx`, `ui_web/src/mobile/discoveryFeed.ts`, `ui_web/src/mobile/CatalogSearch.tsx`: resolve backend `sections` into localized track shelves (`More like {artist}`, `Explore from {title}`, `Rediscover`, `From {playlist}`, `Made for your library`) with localized `reason` subtitles, bounded 5-row previews, dynamic `?browse=<sectionId>` expansion, and `Similar to {artist}` card attribution from `reason_artist`, falling back to the flat `"Songs you might like"` shelf when `sections` is omitted.

## Captures

Chromium, dark theme, Spanish copy, fixture `/api/discovery/music/feed` payload carrying `browse_sections` (with `reason_artist`), 3 structured `sections` (`because_you_listen_extremoduro`, `rediscover`, `explore_from_seed_1`), and `items`.

| View | Before | After |
| --- | --- | --- |
| Desktop Discover top (1366×768) | [Before](desktop-discover-before.png) | [After](desktop-discover-after.png) |
| Desktop Discover scrolled to shelves (1366×768) | [Before](desktop-shelves-before.png) | [After](desktop-shelves-after.png) |
| Desktop expanded shelf (`?browse=because_you_listen_extremoduro`) | — | [After](desktop-shelf-expanded-after.png) |
| Mobile Discover (390×844) | [Before](mobile-discover-before.png) | [After](mobile-discover-after.png) |
