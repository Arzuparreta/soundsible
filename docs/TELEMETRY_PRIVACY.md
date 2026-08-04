# Soundsible telemetry and privacy contract

**Status:** Active. This contract applies to **local-first** observability and recommendation learning.

## What we collect (when enabled)

All events are **append-only JSON lines** under the runtime **data directory**, never under config:

| Category | File(s) under `data_dir/telemetry/` | Purpose |
|----------|-------------------------------------|---------|
| Setup | `setup-events.jsonl` | Setup funnel, time-to-first-play, errors (Phase 1 gate). |
| Migration | `migration-events.jsonl` | Import progress, decisions, completion (Phase 1 gate). |
| Play timing | `play-timing.jsonl` | Latency segments for Phase 2 baseline (instrumentation only in Phase 1). |
| Listening and recommendation feedback | `listening-events.jsonl` | Per-account positive outcomes and explicit soft-negative feedback. |

**Schema versions:** Setup and migration records use `"v": 1`. Playback
attempts use `"v": 2`; listening history uses `"v": 2`. Event shapes are
catalogued in [LAYER_CONTRACTS.md](./LAYER_CONTRACTS.md) §3. Future fields are
additive within a version or bump `v` with a documented migration.

**Listening history schema:** active records use `"v": 2`. Writers record actual
30-second playback, explicit saves/playlist/subscription actions, and
`not_interested` feedback. Search text and search-result clicks are never
written. Skips never create a negative signal.

## Where it lives

- **Root:** `{SOUNDSIBLE_DATA_DIR or platform user-data}/users/<account>/telemetry/`
- **Not** under `config_dir`: telemetry is durable operational data, not user settings (review §5 D5).

## Retention and rotation

- **Rotation:** Active JSONL files rotate at **16 MB** per file; **up to 5** rotated segments retained; older rotated files may be **gzip-compressed** (implementation detail).
- **Effective retention:** Bounded by rotation + cap (roughly on the order of tens of MB per category on a typical install). Operators may delete `data_dir/telemetry/` manually to reset local metrics.
- **No remote copies** are created by this contract unless a **separate**, explicit opt-in feature is shipped and documented later.

## Opt-out

- **Environment:** If `SOUNDSIBLE_TELEMETRY_ENABLED` is set to `0`, `false`, or `off` (case-insensitive), the engine **must not** append local telemetry events (implementation must treat this as a hard off switch).
- **Default:** Local telemetry **on** (local-only, no network) so Phase 1 quality gates can be measured on the operator’s machine.
- **Personal UI toggle:** “Learn from my activity” controls recommendation
  writers for the signed-in account. “Reset recommendation learning” removes
  that account's transactional profile and feedback audit.

## Never collected (Phase 1)

The following are **out of scope** for local JSONL sinks and must not be written by Phase 1 telemetry code:

- Passwords, API secrets, OAuth tokens, owner/admin tokens, session cookies.
- Full request/response bodies from third-party APIs.
- Raw clipboard contents, unrelated filesystem paths outside declared music/setup directories, or arbitrary user file contents.
- **Cross-service tracking IDs** or phone-home identifiers; **no network upload** from telemetry writers.
- Exact **full-text** of user communications or non-music personal notes.

Track-related fields (e.g. `track_id`, `source`, timing) are allowed **only** as needed for product quality metrics defined in the frozen schemas.
Search queries are not allowed in listening events or the recommendation
profile.

## Operator rights

- Data stays on the host running Soundsible (self-hosted).
- Operators can **inspect, export, backup, or delete** `data_dir/telemetry/` like any other local data.
- This document is the **published contract**; changes require an explicit doc update and changelog note.

## Play timing segments (`play-timing.jsonl`)

Version-2 `play_timing` events correlate browser and Station work with an
opaque `attempt_id`. They may include:

- `source_kind`: local, preview, or podcast;
- `cache_state`: disk, URL-warm, cold, or unknown;
- `egress`: direct, relay, or unknown;
- trigger, queue lane, terminal state and bounded failure reason;
- click-to-playing, resolution, upstream TTFB, and recovery counts;
- how a response was delivered: the size of the file, the size of what was
  promised, the byte offset asked for, the shape of the `Range` header, whether
  it was narrowed to a chunk and why not when it was not, and the container
  extension. All of it describes the transfer, none of it the audio;
- once per audible play (`ui_play_delivery`): how long it sounded, and how often
  and for how long it stopped after starting.

Buffering before the first sound and buffering after it are recorded as separate
fields. They used to be one counter emitted at the moment of first sound, where
the second kind cannot have happened yet — so it reported the opening wait that
`click_to_playing_ms` already described, and read the same on essentially every
play whatever the delivery did.

Cancelled and superseded attempts are written explicitly and are not counted as
successful latency samples. Timing values ending in `_ms` outside the accepted
0–300 second range are rejected instead of polluting percentiles. Version-1
rows remain inspectable but are not mixed into the version-2 SLO report.

Signed media URLs, relay addresses, cookies, tokens and audio contents are
never recorded. Generate a local seven-day report with:

```bash
python3 scripts/playback_report.py /path/to/play-timing.jsonl
```

## Relation to product privacy claims

Soundsible remains **no third-party ad tracking**. This contract adds **transparent, local-only** technical telemetry so phase quality gates (setup success, migration accuracy) are measurable **without** contradicting the privacy posture.
