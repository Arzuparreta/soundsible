# Discover Freshness, Seed Rotation, Push & Prefetch (2026-11-21)

Before/after captures for discovery item **D4**, adding diacritic-folded browse resolution, single/EP release inclusion and badges, per-user seed rotation with a home Refresh control, Socket.IO `discovery_feed_ready` push across web and Android, and speculative prefetch for the top visible Discover songs.

## What changed

- **Backend (`D4`)**:
  - `shared/discovery_seeds.py`: unified taste artist and graph track seed selection using `fold_text` diacritic folding, bounded per-user recent-seed rotation history with soft multiplicative damping (`0.02`), and profile-reset clearing.
  - `shared/discovery_browse.py`: folds diacritics and breaks exact artist ties by `nb_fan` (keeping zero approximate fallback), includes `single` and `ep` releases alongside `album`, and emits `record_type` and `release_date`.
  - `shared/api/routes/discovery_feed.py`: rotates seeds on `refresh=1` and expired cache refreshes, and emits `discovery_feed_ready` to `user_id` after discarding the cache key from `_DISCOVERY_FEED_INFLIGHT`.
- **Frontend & Android (`D4`)**:
  - `ui_web/src/lib/discoveryEvents.ts`, `socket.ts`, `stores/runtime.ts`, `android/app/src/main/java/com/soundsible/android/EnginePlugin.kt`, `ui_web/src/mobile/AndroidStart.tsx`: zero-dependency push bus delivering `discovery_feed_ready` without triggering full library resyncs.
  - `ui_web/src/components/SearchDiscoveryView.tsx`, `SearchDiscovery.tsx`, `SearchDiscovery.module.css`, `ui_web/src/lib/searchDiscovery.ts`, `ui_web/src/mobile/discoveryFeed.ts`, `CatalogSearch.tsx`: home Refresh button (`<Control>`), localized `Single` / `EP` release subtitles, push-first revalidation with 15s bounded safety fallback, and speculative pre-resolve + prefetch of the first visible Discover songs.

## Captures

Chromium, dark theme, Spanish copy (`1280x800` desktop and `390x844` mobile), showing the Discover home before and after adding the Refresh control and `Sencillo` / `EP` release labeling.

| View | Before | After |
| --- | --- | --- |
| Desktop Discover (1280×800) | [Before](desktop-before.png) | [After](desktop-after.png) |
| Mobile Discover (390×844) | [Before](mobile-before.png) | [After](mobile-after.png) |
