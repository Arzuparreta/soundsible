# Discovery Engine v2 Architecture

Architectural specification for Soundsible's 4-layer recommendation and discovery engine (`shared/discovery_profile.py`, `shared/discovery_graph_store.py`, `shared/discovery_federation.py`, `shared/discovery_browse.py`, `shared/api/routes/discovery_feed.py`).

---

## Core Design Principles

1. **Separation of concerns across 4 layers:**
   - **Layer 1 — Taste Profile (`user_db`)**: Builds a persistent, multi-horizon model of the listener's demonstrated taste from real listening (`music_played_30s`, `music_play_completed`, `music_play_skipped_early`, OpenSubsonic scrobbles) and log-saturated library priors (favourites, playlists, owned tracks). Pins/bookmarks carry **zero** taste weight.
   - **Layer 2 — Federated Similarity Graph (`instance_db`)**: Persists artist catalog nodes (`artist_graph_nodes`) and multi-provider similarity edges (`artist_similarity_edges`: Deezer, YouTube `related_mix_cache`, Last.fm, ListenBrainz) in `instance.db`, scoring outward candidates by **multi-seed consensus + provider diversity + hub/IDF damping**.
   - **Layer 3 — Objective-Specific Surfaces**:
     - **Home (`/`) — *New releases***: 100% listener's own Taste Profile artists (top 35 across long-term and short-term horizons), 180-day window, served from `instance_db.artist_releases_cache` via `GET /api/discovery/music/new-releases`.
     - **Discover (`/search`) — *Release radar***: Top 15–20 outward consensus artists (excluding Taste Profile artists), 45-day window, `"Similar to {artist}"` attribution, reusing the exact same cached discographies fetched for *Albums for you*.
     - **Discover (`/search`) — *Artists to discover* & *Albums for you***: Outward consensus ranking diversified via Maximal Marginal Relevance (MMR) over graph neighborhoods.
     - **Discover (`/search`) — *More like {artist}* rows**: Diverse taste anchors chosen via MMR across distinct taste clusters (`long_term` core, `short_term` interest, secondary facet).
   - **Layer 4 — Impression Fatigue & Controlled Exploration (`user_db`)**: Tracks candidate impressions (`discovery_impressions`) with a 6-hour normal-browse debounce and explicit `?refresh=1` cooling, plus 2-hop local graph exploration, retiring destructive `0.02` seed damping.

2. **Database Boundary (`shared/database.py`):**
   - `user_db` (`users/<id>/library.db`): `discovery_events`, `discovery_signals`, `discovery_signal_aliases`, `discovery_artist_profile`, `discovery_impressions`.
   - `instance_db` (`instance.db`): `artist_graph_nodes`, `artist_similarity_edges`, `artist_releases_cache` (registered in `INSTANCE_TABLES` so catalog knowledge is shared across users without leaking personal taste).

---

## Layer 1: Taste Profile Formulas

- **Pins (`saved_entities`)**: weight `0` everywhere in Discover and release checks.
- **Search click (`music_search_played`)**: weight `0` in profile and play counts (only signals pre-play search intent; real listening arrives through `music_played_30s` / `music_play_completed` with `source="search"`).
- **Session value** (deduplicated per `play_session_id`):
  - `OutcomeWeight`: `music_play_completed` (`+1.15`), `music_played_30s` (`+0.75`), `music_saved_to_library` (`+1.20`), `music_favourited` / `music_added_to_playlist` / `music_requested_from_dj` (`+1.00`), `music_started_radio` (`+0.60`), `music_added_to_queue` (`+0.40`).
  - `IntentWeight`: active choice = `1.00`, OpenSubsonic = `0.90`, generated/passive (`radio`, `autoplay`, `auto_mode`) = `0.30`.
  - Early skips (`music_play_skipped_early` / `music_generated_skipped_early` when `4s <= listened < min(25s, 25% duration)`): gentle negative counter for discovery/search/generated sources; `0` for owned library/album/playlist skips.
- **Anti-binge daily cap**: $E_a(d) = \min\big(\sum_{e \in (a, d)} v(e),\; 2.5\big)$.
- **Dual half-life decay**:
  - $S_{\text{short}}(a) = \sum_d E_a(d) \cdot 2^{-\text{age}(d)/14}$
  - $S_{\text{long}}(a) = \sum_d E_a(d) \cdot 2^{-\text{age}(d)/120}$
- **Habit breadth multiplier**: $B(a) = 1 + 0.18 \ln(1 + \text{distinct\_days}_a) + 0.12 \ln(1 + \text{distinct\_tracks}_a)$.
- **Log-saturated library prior**:
  - $\text{Prior}(a) = \min\big(6.0,\; 1.6 \ln(1 + \text{favs}_a) + 0.9 \ln(1 + \text{playlist\_tracks}_a) + 0.5 \ln(1 + \text{lib\_tracks}_a)\big)$
  - Weighted by maturity $\gamma$: `1.0` (`< 12` sessions), `0.5` (`12..99` sessions), `0.2` (`>= 100` sessions).
- **Effective profile score**:
  $$\text{Effective}(a) = \max\big(0,\; 0.45 \cdot H_{\text{short}}(a) + 0.55 \cdot H_{\text{long}}(a) + \gamma \cdot \text{Prior}(a) - 0.15 \cdot \text{early\_skips}_a\big)$$

---

## Layer 2–4: Consensus Graph, Shared Release Pipeline & Fatigue

- **Edge weight**: $w_p / \log_2(1 + \text{rank\_pos})$ (`deezer=1.0`, `lastfm=1.0`, `listenbrainz=1.1`, `youtube=0.65`).
- **Candidate consensus score**:
  - $\text{BaseVote}(c) = \sum_{s \in \text{Seeds}} \tilde{W}(s) \cdot \max_p \text{EdgeWeight}(s \to c, p)$
  - $\text{Consensus}(c) = 1 + 0.35 \ln(\text{supporting\_seeds}_c) + 0.25 (\text{distinct\_providers}_c - 1)$
  - $\text{HubPenalty}(c) = \log_2(2 + \text{in\_degree}_c)^{-0.35} \cdot \big(1 + 0.12 \max(0, \log_{10}(\max(1, \text{nb\_fan}_c)) - 5.5)\big)^{-1}$
  - $\text{Score}(c) = \text{BaseVote}(c) \cdot \text{Consensus}(c) \cdot \text{HubPenalty}(c) \cdot \text{ArtistFeedbackMult}(c) \cdot \text{Fatigue}(c)$
- **MMR diversity** ($\lambda = 0.72$): Jaccard similarity over cached neighbor/seed sets prevents genre monopolization without rigid per-genre quotas.
- **Release pipeline**: strict chronological ordering (`release_date DESC`) with affinity/consensus tie-break and quality controlled at artist admission (`select_release_profile_artists` for Home *New releases*, top consensus candidates for Discover *Release radar*), backed by `artist_releases_cache` (24h TTL) and one-time `album/{id}` `Main` contributor resolution.
- **Impression fatigue**: 10-day half-life decay on unclicked impressions (`1 / (1 + 0.50 * effective_shows)`), cleared on interaction, debounced at 6h on normal loads and immediately applied on `?refresh=1`, plus up to 2 unseen 2-hop exploration slots in `artists`.
