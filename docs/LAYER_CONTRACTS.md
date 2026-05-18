# Layer 1 and Layer 2 contracts (draft)

**Status:** Draft — definition artifact for platform and implementation alignment.  
**Related:** [PREMIUM_QUALITY_CONTRACT.md](./PREMIUM_QUALITY_CONTRACT.md) (outcome gates), [TELEMETRY_PRIVACY.md](./TELEMETRY_PRIVACY.md) (privacy and sinks).

This document freezes **boundaries** between layers, the **event catalog** for quality telemetry, and a **scorecard mapping** so Phase 1–3 work stays traceable to gates. It does not replace product sign-off on numerical targets (that lives in the Premium Quality Contract).

---

## 1. Scope of each layer

### Layer 1 — Premium Baseline (Phase 1) + structural prep for Phase 2

**Owns**

- Guided setup and library path resolution (music directory, persisted config, env overrides).
- **Migration truth path:** parse external exports → match against local library → confidence bands → user-visible confirmation → apply (e.g. playlist creation).
- **Playback and queue** correctness as exposed by the Station API and control plane (single source of truth for “what is playing”).
- **Local-only** JSONL telemetry for setup, migration, and play timing (see §3).

**Must not** (without an explicit Phase 3 contract revision)

- Require network upload of telemetry or listening data.
- Introduce obligatory third-party recommendation or “phone home” analytics.

### Layer 2 — Premium Intelligence (Phase 3)

**Owns**

- **Listening graph** inputs (repeatable, explainable features derived from on-device history and library signals).
- **Recommendation surfaces** with **human-readable reasons** on every response (contract tests gate).
- **Trust controls** (tune / hide / boost / etc. as designed per feature) and UX telemetry for adoption metrics.
- **Offline evaluation** dataset + CI-scored job before online cohort experiments.

**Consumes** Layer 1 outputs as **read-only inputs** where possible (library IDs, play outcomes, migration-derived playlists). Writers for `listening-events.jsonl` and Layer 2 reco events are **out of scope for Phase 1** unless a dedicated task enables them with schema version bump.

---

## 2. Data and API boundaries

| Concern | Layer 1 | Layer 2 |
|--------|---------|---------|
| Library metadata & playlists | Source of truth in existing metadata store | Reads; may annotate with reco tags in extension fields or sidecar docs per future ADR |
| Playback / queue state | Station API + engine; queue consistency tests | Reads outcomes; may suggest queue inserts only through defined APIs |
| Migration batches | `batch_id` in telemetry + API responses | May use imported playlists as cold-start signal later |
| Explainability strings | N/A | Required on every reco API response once Layer 2 ships |
| Telemetry files | `setup-events`, `migration-events`, `play-timing` | Future: `listening-events`, reco outcome logs (local-first, same privacy contract unless otherwise agreed) |

**Versioning:** Each JSONL record includes `"v": <int>`. Additive fields may appear within the same `v`; breaking changes require a new `v` and a short migration note in this file and [TELEMETRY_PRIVACY.md](./TELEMETRY_PRIVACY.md).

---

## 3. Event catalog (`v: 1`)

All events are append-only JSON lines. Common fields: `v`, `event`, `ts` (Unix seconds unless noted).

### 3.1 `setup-events.jsonl` (Layer 1)

| `event` | When emitted | Payload (required / optional) | Status |
|---------|----------------|------------------------------|--------|
| `setup_music_dir_saved` | `POST /api/setup/music-dir` succeeds | `env_override` (bool) | **Implemented** |
| `setup_session_started` | First contact of a guided setup session (future: wizard open) | `setup_session_id` (uuid), optional `client` | **Planned** |
| `setup_step_completed` | Operator completes a named setup step | `setup_session_id`, `step` (string) | **Planned** |
| `setup_first_play` | First confirmed playback after session start (gate: time-to-first-play) | `setup_session_id`, optional `track_id`, `elapsed_ms_since_session` | **Planned** |
| `setup_error` | Recoverable setup failure | `setup_session_id`, `code`, `message` (no secrets) | **Planned** |

**Gate note:** The Phase 1 setup gate in [PREMIUM_QUALITY_CONTRACT.md](./PREMIUM_QUALITY_CONTRACT.md) needs a correlated `setup_session_id` and `setup_first_play`; until then, rollups use partial proxies (e.g. time between `setup_music_dir_saved` and first `play_timing`) only as an interim **engineering metric**, not as the signed gate.

### 3.2 `migration-events.jsonl` (Layer 1)

| `event` | When emitted | Payload | Status |
|---------|----------------|---------|--------|
| `migration_import_preview_started` | `POST /api/migration/preview` after parse | `batch_id`, `format`, `source_rows` | **Implemented** |
| `migration_import_preview_completed` | After matching | `batch_id`, `format`, `total`, `matched`, `auto_accept`, `needs_confirmation`, `unmatched`, `matched_ratio` | **Implemented** |
| `migration_import_apply` | Playlist import committed | `playlist_name`, `track_count` | **Implemented** |
| `migration_row_decision` | User confirms/rejects a row (future repair UX) | `batch_id`, `source_index`, `decision`, optional `track_id` | **Planned** |

**Confidence policy (implementation):** Matching uses a confirm band **0.90–0.95** and silent **auto** only at **≥0.95** (`shared/migration/match.py`). The Premium Quality Contract states auto-accept at **≥0.90** with explicit confirmation below that; the code is **stricter** on silent auto. Align copy and contract in a future sign-off pass if product wants 0.90 silent auto.

### 3.3 `play-timing.jsonl` (Layer 1 instrumentation; Phase 2 gate)

| `event` | When emitted | Payload | Status |
|---------|----------------|---------|--------|
| `play_timing` | `POST /api/playback/play-timing` | `segments` object (see [TELEMETRY_PRIVACY.md](./TELEMETRY_PRIVACY.md)); optional `track_id`, `device_id`, `phase` | **Implemented** |

### 3.4 `listening-events.jsonl` (Layer 2 — writers disabled in Phase 1)

Planned shapes TBD; must respect [TELEMETRY_PRIVACY.md](./TELEMETRY_PRIVACY.md) and must not store PII payloads. Reserved for recommendation inputs/outcomes and control usage when Phase 3 tasks enable writers.

---

## 4. Premium quality scorecard (roll-up)

One-page mapping from **user outcomes** to **signals** (product scorecard requested in plan “Next Steps” #1).

| Outcome | Contract § | Primary signals | Telemetry / tests | Layer |
|--------|------------|-----------------|---------------------|-------|
| Setup → first play | §1 | Success %, median time, “shell intervention” tagging | `setup-events` + `play-timing`; future gate script | L1 |
| Migration trust | §2 | Match rate on fixtures; confirmation rate | `migration-events` + audit reports | L1 |
| Playback responsive & stable | §3 | `intent_to_playing_ms` p95; stall rate; queue tests | `play-timing` + automated queue checks | L1 → L2 |
| Discovery usefulness | §4 | 30s play rate; offline eval score; uplift | Layer 2 reco + eval job | L2 |
| Trust, explainability, control | §5 | 100% reason field; control adoption; privacy checklist | API tests + Layer 2 UX events | L2 |

---

## 5. Phase 1 implementation backlog (engineering)

Ordered for **token-efficient** progress toward signed Phase 1 gates:

1. **Setup funnel model:** introduce `setup_session_id` (client or server issued), emit `setup_session_started`, `setup_step_*`, and **`setup_first_play`** at first confirmed play for that session.
2. **Gate script stub:** read-only tool (CLI or doc-only recipe) that estimates setup success and time-to-first-play from JSONL for a date window; no network.
3. **Migration repair UX events:** emit `migration_row_decision` when UI confirms/changes rows; extend import apply payload with `batch_id` when available.
4. **Reference import fixtures:** versioned test fixtures + documented expected match rates for the migration gate.

---

## 6. Change control

- Edits to event **names**, **required fields**, or **layer ownership** require updating this doc and a one-line note in [TELEMETRY_PRIVACY.md](./TELEMETRY_PRIVACY.md) or contract docs as appropriate.
- Relaxing privacy “Never collected” rules requires explicit product + privacy review and is not implied by Layer 2 work.
