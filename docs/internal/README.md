# Internal documentation

Documents for people and agents working on Soundsible itself: architecture,
contracts, handoffs, audits, measurements and design notes. User guides live
one level up, in [`docs/`](../README.md), and only those are published on the
Soundsible website.

A document belongs here when its reader is changing Soundsible, not using it.
Handoffs and status tables are kept current; dated audits, slices and
measurement reports record what was true when they were written.

## Architecture and contracts

| Document | Covers |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Processes, components and data flow. |
| [Playback queue contract](PLAYBACK_QUEUE_CONTRACT.md) | Occurrence-based play order in the web player. |
| [Artwork](ARTWORK.md) | Artwork storage, variants and delivery. |
| [Lyrics recovery](LYRICS_RECOVERY.md) | Lyrics lookup polling and retries. |
| [Mobile lists](MOBILE_LISTS.md) | The shared `MusicListRow` composition below 1024 CSS pixels. |
| [Layer contracts](LAYER_CONTRACTS.md) · [Premium quality contract](PREMIUM_QUALITY_CONTRACT.md) | Draft quality gates and telemetry boundaries. |
| [Releasing](RELEASING.md) | Versioning and the release process. |

## Handoffs

Read the matching handoff before continuing one of these lines of work.

| Area | Handoff |
| --- | --- |
| Android port | [android/HANDOFF.md](android/HANDOFF.md) — development setup in [ANDROID.md](ANDROID.md) |
| DJ mode | [dj/HANDOFF.md](dj/HANDOFF.md) — responsibilities in [dj/ARCHITECTURE.md](dj/ARCHITECTURE.md), direction in [dj/DIRECTION.md](dj/DIRECTION.md) |
| Architecture review | [audits/ARCHITECTURE_HANDOFF.md](audits/ARCHITECTURE_HANDOFF.md) |
| Resource optimization | [audits/ENGINEERING_HANDOFF.md](audits/ENGINEERING_HANDOFF.md) |

## Folders

| Folder | Contents |
| --- | --- |
| [`android/`](android/) | Port plan, slices, release gates, evidence and capability files read by the release scripts. |
| [`dj/`](dj/) | DJ analysis work packages (P12–P18), detector comparison and probes. |
| [`audits/`](audits/) | Dated engineering and architecture reviews. |
| [`performance/`](performance/) | Performance investigations with their raw results. |
| [`engineering/`](engineering/) | Library integrity, recovery and catalog reconciliation. |
| [`design/`](design/) | View redesign notes. |
| [`measurements/`](measurements/) | Raw measurement records. |

## Other notes

[Performance](PERFORMANCE.md) · [Playback diagnosis](PLAYBACK_DIAGNOSIS.md) ·
[UI rebuild plan](UI_REBUILD_PLAN.md) · [Appliance rework plan](appliance-rework-plan.md)

Some of these are working notes that are no longer maintained; the
[roadmap](../ROADMAP.md) is the current product direction.
