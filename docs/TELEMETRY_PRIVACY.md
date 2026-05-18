# Soundsible telemetry and privacy contract (Phase 1 baseline)

**Status:** Active for Phase 1. This contract applies to **local-first** observability only. It is the precondition for any telemetry code in the repository (see design review §1.3 #1, §3.4).

## What we collect (when enabled)

All events are **append-only JSON lines** under the runtime **data directory**, never under config:

| Category | File(s) under `data_dir/telemetry/` | Purpose |
|----------|-------------------------------------|---------|
| Setup | `setup-events.jsonl` | Setup funnel, time-to-first-play, errors (Phase 1 gate). |
| Migration | `migration-events.jsonl` | Import progress, decisions, completion (Phase 1 gate). |
| Play timing | `play-timing.jsonl` | Latency segments for Phase 2 baseline (instrumentation only in Phase 1). |

**Schema versions:** Records use `"v": 1` and event shapes defined in the Phase 1 engineering review (`setup_session_started`, `setup_step_*`, `setup_first_play`, `migration_*`, `play_timing`, etc.). Future fields are additive within a version or bump `v` with a documented migration.

**Listening history file:** `listening-events.jsonl` may exist with a **frozen schema** for Layer 2; **writers are not enabled in Phase 1** unless explicitly specified in a later task. No listening events are required for Phase 1 gate scripts until such a task lands.

## Where it lives

- **Root:** `{SOUNDSIBLE_DATA_DIR or platform user-data}/telemetry/`
- **Not** under `config_dir`: telemetry is durable operational data, not user settings (review §5 D5).

## Retention and rotation

- **Rotation:** Active JSONL files rotate at **16 MB** per file; **up to 5** rotated segments retained; older rotated files may be **gzip-compressed** (implementation detail).
- **Effective retention:** Bounded by rotation + cap (roughly on the order of tens of MB per category on a typical install). Operators may delete `data_dir/telemetry/` manually to reset local metrics.
- **No remote copies** are created by this contract unless a **separate**, explicit opt-in feature is shipped and documented later.

## Opt-out

- **Environment:** If `SOUNDSIBLE_TELEMETRY_ENABLED` is set to `0`, `false`, or `off` (case-insensitive), the engine **must not** append local telemetry events (implementation must treat this as a hard off switch).
- **Default:** Local telemetry **on** (local-only, no network) so Phase 1 quality gates can be measured on the operator’s machine.
- **Future UI toggle** (“Help improve Soundsible”) may mirror the same flag; until then, env var is the operator control.

## Never collected (Phase 1)

The following are **out of scope** for local JSONL sinks and must not be written by Phase 1 telemetry code:

- Passwords, API secrets, OAuth tokens, owner/admin tokens, session cookies.
- Full request/response bodies from third-party APIs.
- Raw clipboard contents, unrelated filesystem paths outside declared music/setup directories, or arbitrary user file contents.
- **Cross-service tracking IDs** or phone-home identifiers; **no network upload** from telemetry writers.
- Exact **full-text** of user communications or non-music personal notes.

Track-related fields (e.g. `track_id`, `source`, timing) are allowed **only** as needed for product quality metrics defined in the frozen schemas.

## Operator rights

- Data stays on the host running Soundsible (self-hosted).
- Operators can **inspect, export, backup, or delete** `data_dir/telemetry/` like any other local data.
- This document is the **published contract**; changes require an explicit doc update and changelog note.

## Relation to product privacy claims

Soundsible remains **no third-party ad tracking**. This contract adds **transparent, local-only** technical telemetry so phase quality gates (setup success, migration accuracy) are measurable **without** contradicting the privacy posture.
