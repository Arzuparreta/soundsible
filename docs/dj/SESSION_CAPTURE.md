# Automatic linked DJ session evidence

2026-10-30. Follow-up to [the retrospective study](SESSION_PROGRESS.md).
The listener authorised automatic capture to measure whether uninterrupted DJ
sessions improve as they progress. This adds observation, not a mixing policy.
The implementation belongs to PR #409 until merged.

## Scope and ownership

The authenticated web player, including the iPhone PWA, uses the existing
account-local recorder and durable offline outbox. No activation or export is
required. Native Android is outside this browser recorder's coverage.

- `djSession`: opaque ID for an actual DJ start. External selection creates
  a new ID. Restoring an active session marks `startKnown=false`; it cannot
  stand in for an observed opening.
- `edgeId`: opaque ID joining first selection, refinements and a specific
  incoming occurrence/predecessor. A different predecessor creates a new edge.
- `transitionId`: fresh ID for each arm attempt, carried by the actual mixer
  through start, cancellation, failure, retirement and rate-return fallback.
  Rearming a refined edge retains its ordinal but gets a new attempt ID.
- `ordinal`: order in which distinct edges were first committed in the session.
  Cancelled edges may leave gaps; the report does not hide them.
- `direction`, `planId`, `plannerSession`, `segment`: correlate accepted route
  responses. A measurement session is distinct from a planner request or browser
  capture lifetime.

Song identities remain transient application state. These observations add no
titles, song IDs, media URLs or audio. Observation fields never feed planning
or audio decisions. Mixer IDs belong to that mix, so a late callback cannot
inherit the next session's identity. Sparse session context is attached to
transport/connection events, not every media timeupdate. The edge registry is
capped at 64 entries. Source changes, requests, reordering, repair, manual
advance, seek and mixing toggles mark interventions. Visibility alone does not
exclude background listening.

## Stages and units

| Event | Observation |
| --- | --- |
| `dj.session_started/ended` | Observed/restored opening, monotonic session time, direction and end reason |
| `dj.route` | Accepted response's candidate/cohort counts, ready cohort members and route length |
| `dj.selected` | Observed outgoing/incoming analysis readiness, planner score, technique, cues, overlap, rate and alignment |
| `dj.refined` | Cache-only response and whether adopted; only adoption updates the reading used at commit |
| `dj.committed` | Exact live plan passed to the mixer, observed readiness, manual/automatic and mixing enabled/disabled |
| `mix.started`, existing fallback/suspend/resume events | Initial execution technique/rate/overlap and subsequent degradation, linked to the armed attempt |
| `dj.outcome`, `mix.cancelled/failed`, `handoff.retirement` | Ownership transfer, completion, staging, cancellation or failure |
| `dj.interaction`, `dj.direction_changed`, transport/connection events | Interventions and interruptions |

Cues and overlap are seconds; rate is a ratio; session time is monotonic
milliseconds. Absolute feature changes use notes per sounding second, original
recording LUFS and dimensionless spectral flatness, from normal API responses.
No extra analysis, speculative work or recommendation requests are made.
Planner scores and overlap duration are not listener quality ratings.

Unknown analysis is null, distinct from explicitly unanalysed. Commit readiness
describes analysis observed in its accepted plan, not an independent cache
query. An unobserved placement/repair edge remains unknown; user placement and
repair also exclude the session from unattended comparison.

## Local report

```sh
python3 scripts/dj_session_report.py \
  ~/.local/share/soundsible/users/<account>/telemetry/playback-traces.sqlite3
```

The report uses client sequence order and explicit IDs, never upload receipt
times to reconstruct sessions. It deduplicates retries, digests payloads read,
and emits numbered aggregates without account/device/session/transition/song
identifiers. Existing retention, offline retry and telemetry opt-out apply.

Eligibility requires an observed opening and at least four completed
transitions with contiguous ordinals from one. Sequence gaps, reported loss,
missing selection/execution, unknown openings, interventions, manual/unmixed
transitions and observed connection/transport interruptions are explicit
exclusions. A cancelled arm followed by successful refinement of the same edge
is allowed; two completions claiming one ordinal are ambiguous and excluded.
Initial source configuration before any selection is treated as setup;
direction changes after selection begins are interventions.

Compare the first two completed transitions with the latest two in the observed
prefix. Each session has one vote; group comparisons by client source revision,
platform and first selected pair's observed analysis readiness (ready, not
ready, or unknown). That is not a claim that the whole candidate pool was warm.
Unknown readings at an endpoint remove that session from that
metric. A beatmatched start followed by fallback does not count as maintained
beatmatch. Still-running sessions are labelled open.

Old traces produce zero linked sessions. No fresh real-listening result is
claimed before new sessions are captured. Physical sound and preference remain
outside these measurements. Candidate counts and selected occurrences do not
reconstruct the entire unselected pool.

## Validation

Tests cover adoption/rejection of refinement, rearming, changed predecessors,
late ownership, unknown values, deduplication, trace loss, interruption
exclusions and paired calculations. A browser/store test links cold selection
to accepted measured refinement without song identities in the new records.
The full four-profile browser suite and remote CI remain delivery gates.
