# Soundsible Discovery Rework Plan

## Purpose

Soundsible should let a normal listener stop paying for Spotify or Apple Music, self-host their first real service, and still get a polished, practical music experience. The product should feel as comfortable as a paid subscription app, then exceed it through ownership, local control, transparent recommendations, imports, saving, and richer personal workflows.

This is not a Spotify clone plan. The point is to make Soundsible feel like a serious personal music service: private, local-first, understandable, and more useful because the user owns the service and the library.

## Product Direction

- **Ambition:** aggressive moonshot, shipped through practical phases.
- **Recommendation core:** local deterministic scoring first; no ML or agent curation in this roadmap.
- **Visual direction:** quiet premium. The current layout is not sacred and should be redesigned where it cannot support the product.
- **Learning model:** passive-first and positive-only at first.
- **Music and podcasts:** separate product tabs with shared intelligence infrastructure.
- **External music flow:** preview first, then an elegant `Save to Library` path that clearly means local download and durable ownership.
- **Quality policy:** confidence-gated matching; high-confidence saves are direct, uncertain matches show alternatives.
- **Privacy:** local telemetry only, with a consumer-visible learning toggle.

## Current Diagnosis

Soundsible already has strong ingredients: Deezer metadata proxying, YouTube and YouTube Music resolution, preview playback, downloader queue, radio, playlists, favourites, podcasts, migration fixtures, local telemetry, and an existing SQLite YouTube resolution cache.

The product gap is coherence. Discover is still mostly charts plus search. Recommendation logic lives in frontend modules and cannot act as a stable product contract. External resolving and downloading feel like implementation details rather than a premium save flow. Search, radio, podcasts, imports, and library actions are not yet unified as one taste system.

## Implementation Roadmap

### Phase 1: Local Intelligence Foundation

Enable the reserved local listening-event sink and add a discovery learning setting.

Positive-only events:

- `music_played_30s`
- `music_saved_to_library`
- `music_added_to_playlist`
- `music_added_to_queue`
- `music_started_radio`
- `music_search_played`
- `podcast_episode_played_30s`
- `podcast_subscribed`
- `podcast_episode_saved`
- `podcast_search_opened`

Acceptance:

- Turning learning off stops new listening-event writes.
- No secrets, raw third-party responses, arbitrary file paths, or request bodies are logged.
- Existing setup, migration, and play-timing telemetry remain unchanged.

### Phase 2: Server-Side Recommendation Service

Move recommendations behind engine-owned APIs:

- `GET /api/discovery/music/recommendations`
- `GET /api/discovery/podcasts/recommendations`
- `POST /api/discovery/events`
- `GET /api/discovery/settings`
- `PATCH /api/discovery/settings`

Every recommendation item must include a stable id, media type, display metadata, source, reason string, reason code, score, confidence, action state, and external ids when available.

Inputs:

- Local library tracks and metadata.
- Favourites.
- Playlists.
- Imported playlists and match confidence.
- Saved/downloaded external tracks.
- Positive listening outcomes.
- Podcast subscriptions and episode plays.
- Existing radio/related and provider metadata paths.

Acceptance:

- Empty libraries return useful cold-start structure rather than broken states.
- Imported playlists influence recommendations before long listening history exists.
- 100% of recommendation rows include a reason string.
- The API still works when local learning is disabled, but stops recording new learning events.

### Phase 3: Save And Resolve Experience

Make external music feel practical and premium.

- Replace prominent implementation language with `Save to Library` while still showing resolution and download progress.
- Reuse the downloader internally instead of exposing queue plumbing as the main mental model.
- Extend the existing YouTube resolution cache with confidence, failure state, and verification metadata.
- High-confidence matches save directly.
- Medium/low-confidence matches open a resolution sheet with alternatives.
- Failed resolution offers retry and search paths.

Acceptance:

- A high-confidence external track can be saved in one action.
- Uncertain tracks show alternatives before saving.
- Saved external tracks appear in Library and future recommendations.
- Users understand preview is temporary and saved music is durable.

### Phase 4: Full Discovery UI Redesign

Replace the current Discover and Podcasts surfaces with quiet-premium layouts.

Music sections:

- Made for Your Library
- Because You Saved...
- From Your Imported Playlists
- Rediscover
- New to You
- Trending, But Filtered
- Start a Station
- Recently Saved
- Continue This Vibe

Podcast sections:

- Continue Listening
- Your Shows
- Because You Listened To...
- New Episodes
- Shows You Might Like
- Top Podcasts
- Downloaded Episodes

Search sections:

- Top result
- Library
- Songs from web
- Artists
- Playlists
- Podcasts
- Saved/downloaded
- Recent searches

Acceptance:

- Desktop and mobile expose the same recommendation semantics.
- Discover remains useful with no library, a small library, and a large library.
- Podcasts remain separate but share recommendation quality.
- Existing playback, queue, save, and playlist actions still work.

### Phase 5: Quality Gates

Moonshot gates:

- Recommended music 30-second play rate is at least 50% in a local 14-day rollup.
- Search-to-play success improves versus the current baseline.
- Save-to-library completion for high-confidence external tracks is at least 80%.
- Recommendation reason coverage is 100%.
- No local privacy contract regression.
- Manual dogfood: a user can discover, preview, save, and replay a new track without understanding Deezer or YouTube internals.

## First Implementation Slice

The first executable slice should not attempt the full visual redesign. It should land the contracts the redesign needs:

- Root plan document.
- `listening-events.jsonl` support.
- Discovery settings with learning on/off.
- Server-owned music and podcast recommendation endpoints.
- Positive event recording from the current UI.
- Current Discover/Podcast screens consuming recommendation API output where possible.

This makes later design work implementation-safe instead of speculative.

## Implementation Status

Last updated: 2026-05-19 (Phase 3 partial).

Implemented in the first slice:

- `listening-events.jsonl` telemetry category exists.
- Discovery learning settings exist, persist locally, and can be toggled from mobile and desktop Settings.
- `POST /api/discovery/events` records positive-only local discovery events when learning is enabled.
- `GET /api/discovery/music/recommendations` returns deterministic local music recommendations with reasons, scores, confidence, action state, and external ids.
- `GET /api/discovery/podcasts/recommendations` returns deterministic podcast show recommendations from current subscriptions.
- Current UI records positive signals from 30-second playback, search plays, queue actions, playlist adds, radio starts, music saves/download queue submissions, podcast search, podcast subscriptions, and podcast episode saves.
- Discover now includes a small `From your library` rail backed by the local recommendation endpoint.
- Focused tests cover discovery settings, opt-out behavior, event sanitization, and recommendation shape.

Verification run:

- `PYTHONPATH=. pytest tests/test_telemetry.py tests/test_discovery_intelligence.py`
- `git diff --check`
- `node --check` on touched frontend modules

Implemented in Phase 3 (Save and Resolve):

- `youtube_resolution_cache` extended with `confidence`, `confidence_reason`, `candidates_json`, `failure_state`, `verified_at`; migration is additive (ALTER TABLE for existing DBs).
- `shared/resolution_confidence.py`: deterministic confidence scoring (title + artist + duration delta), `classify_confidence`, `best_candidate` helper.
- `POST /api/discovery/save`: resolves artist/title via YouTube search, scores candidates, queues high-confidence matches directly, returns `needs_review` + candidate list for medium/low confidence, caches results.
- Resolution sheet: frontend modal shown for uncertain matches — user picks from alternatives, confirmed selection goes straight to queue.
- `Save to Library` button (+ icon, `save-to-library-btn` class) replaces "Add to download queue" wording on all Discover surface rows.
- `saveTrackToLibrary()` exported from `discovery.js`; wired to all `.dl-add-one[data-deezer-id]` buttons via `deezer_actions.js`.
- Tests: `tests/test_resolution_confidence.py` (13 tests) covering scoring bands, DB migration, upsert, and empty-input guards.

Known limits of the first slice:

- The full quiet-premium Discover and Podcasts redesign has not started.
- External `Save to Library` still mostly uses current downloader queue mechanics under the UI.
- Recommendation scoring is deterministic and intentionally simple; it does not yet read historical listening-event rollups.
- Podcast recommendations are subscription-based only in this slice.
- No confidence-gated resolution sheet has been added yet.

Implemented in Phase 4 (Discovery UI Redesign):

- `renderHome()` replaced in `DiscoveryUI`: now data-driven from the recommendation API sections instead of hardcoded rails.
- New helpers `fetchLocalRecommendationData(limit)` and `_sectionToLibraryTracks(section, itemById, trackById)` for mapping API sections to library tracks.
- Sections rendered in order: **Made for Your Library** → **Because You Saved…** (dynamic title, shown only when rollup has saves) → **Rediscover** (shown only when enough play history exists) → **New to You** (Deezer personalized) → **Trending, But Filtered** (chart filtered to library artists, falls back to full chart) → **Popular Playlists** (Deezer grid).
- Each section is gracefully hidden/empty-stated when data is absent.
- `bindEvents()` updated to cover new section IDs (`disc-new-to-you`, `disc-trending`).
- Preserves all existing search result rendering and playback context.

Implemented in Option A (Listening-Event Rollups):

- `ListeningRollup` dataclass: aggregates `artist_plays`, `artist_saves`, `album_plays`, `podcast_plays`, `played_track_ids` from tail of `listening-events.jsonl` (up to 2 rotations, max 2000 events).
- `load_listening_event_rollups()`: reads events, returns empty rollup when learning disabled or no file.
- `build_music_recommendations` now accepts optional `rollup` argument; boosts artist scores from play/save signals; adds "Because You Saved…" section (tracks sharing artist with recent saves); adds "Rediscover" section (library tracks not in played_track_ids when ≥3 distinct played IDs exist).
- `build_podcast_recommendations` now sorts subscriptions by recent play count; shows "podcast_recently_played" reason for boosted shows.
- Tests: 7 new rollup tests covering aggregation, opt-out, score boost, section generation, and podcast ranking.

## Where The Next Agent Should Continue

Recommended next phase: Phase 3, then Phase 4.

1. Build a first-class `Save to Library` flow on top of the downloader.
   - Replace prominent queue/download wording on Discover rows with ownership language.
   - Keep progress visible, but make queue mechanics secondary.
   - Emit `music_saved_to_library` only after backend queue acceptance, as currently started.

2. Extend resolution confidence.
   - Add confidence, candidate list, verification metadata, and failure state to the existing YouTube resolution path/cache.
   - Direct-save high-confidence matches.
   - Show a resolution sheet for uncertain matches.

3. Add listening-event rollups.
   - Read local `listening-events.jsonl`.
   - Aggregate artist, album, playlist, source, podcast show, search-play, and save signals.
   - Feed those rollups into `build_music_recommendations` and `build_podcast_recommendations`.

4. Redesign Discover.
   - Keep music and podcasts as separate product experiences.
   - Use the API reason/action-state contracts rather than frontend-only heuristics.
   - Prioritize `Made for Your Library`, `Because You Saved...`, `From Your Imported Playlists`, `Rediscover`, and `Continue This Vibe`.

5. Expand tests.
   - Add route-level tests for discovery settings/events/recommendations.
   - Add frontend smoke coverage for the Settings learning toggle and Discover local rail.
   - Add fixture tests for listening-event rollup scoring once rollups exist.
