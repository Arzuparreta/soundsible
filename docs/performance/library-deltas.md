# Disk-backed library deltas

Clients opt in with `GET /api/library?delta=1`. A full response keeps the existing
JSON shape and weak ETag. Subsequent requests include `since=<unquoted ETag>` and
`If-None-Match`. Unchanged libraries keep the existing early 304 path, without
opening the history database. Legacy clients that do not opt in are unchanged.

A changed response can instead contain:

```json
{
  "kind": "delta",
  "base_revision": "<base digest>",
  "revision": "<target digest>",
  "upserts": [{"id": "song", "title": "complete changed track and its public fields"}],
  "removed": ["deleted-song"],
  "order": ["song", "other-song"],
  "fields": {"playlists": {}, "settings": {}}
}
```

`upserts` contains complete added/changed public tracks, including artwork and
loudness. A removed field is therefore removed on the client too. `order` is
present only when the ordered ID sequence changes; it gives the complete new
order. Each entry in `fields` replaces that whole top-level field, including
empty playlists/settings/podcast collections. Unchanged blocks are omitted.
The target revision is the ETag digest of the full public snapshot. Delta
responses have `Cache-Control: private, no-store` and no ETag: they represent a
transition, not the full resource used by the validator.

Missing, expired, foreign-account or unavailable history yields a full response
in the same request. A delta at least as large as the full JSON is discarded in
favor of the full response. The frontend validates the base, IDs, order and
fields before application. An invalid delta gets one unconditional full retry;
stale generations are checked before either response can touch state/artwork.

## Storage and resource bounds

History lives in `get_cache_dir()/library-deltas.sqlite3`, with mode 0600. It is
rebuildable but survives restarts. Each revision stores ordered IDs and SHA-256
hashes of complete public track dictionaries and the other public fields. No
track titles, metadata bodies or full snapshots are retained. Numeric revision
keys avoid repeating account IDs and ETags for every track. There is no new
process-local history cache or permanent connection.

Retention is at most four revisions per account, at most 24 hours old, and
64 MiB globally for conservatively accounted records. SQLite also enforces a
64 MiB main-database page cap. Oldest bases are evicted before new data is
inserted. Expiration is cleaned on history access, not by a background timer.
The database reuses freed pages; it does not vacuum inside HTTP requests. Thus
allocated file size need not fall when records expire, but cannot keep growing
past its cap. Rollback journals and file-backed temporary comparison tables are
additional transient disk usage, not retained history, and are released when
the connection closes. The OS may cache disk pages in its normal page cache.

SQLite main/temp page caches each have a 512 KiB target. Current hashes are
computed once into a file-backed temporary table, compared with indexed SQL
joins, and selected positions are consumed in batches of 500. Previous full
revisions are not loaded into Python maps. Application lists contain only the
response's changed rows, removals and optional new order. The existing current
public snapshot still requires memory proportional to library size. Delta-target
JSON hashing uses batches of 500 tracks rather than a retained full body; full
responses and large deltas can still add transient response memory. See
[bounded serialization](library-delta-serialization.md) for measurements and
fallback costs.

Initialization and admission are transactional. Concurrent duplicate admissions
are idempotent. Writers wait at most 100 ms per SQLite lock acquisition; errors,
corruption, oversized admission or disk exhaustion fall back to a full library.
Connection closure runs on success and failure. A corrupt history file remains
unused until it is cleared/replaced; it never becomes a prerequisite to serving
the library. Recreating the cache loses only the optimization.

## Client application

Deltas reuse untouched row objects and apply the result through Solid keyed
reconciliation in a batch. Reconciliation also removes obsolete nested fields.
Header-only deltas preserve the library array. Artwork metadata is patched only
for changed/deleted rows. Its existing signal dictionary is shallow-copied when
patched; no second persistent library is introduced. Tracks and small temporary
maps used during validation are needed for the current UI, not history.

Metadata edits, playlist mutation responses, deletions and rollbacks invalidate
the accepted base when they change local state outside library sync. Full
fallback also reconciles rows/collections, so removed playlist or annotation
keys cannot survive it. Saved-entry refresh and catalog retry behavior remain.

## Validation and measurements

`venv/bin/python scripts/benchmark_library_deltas.py --memory` exercises the real
Flask route and real SQLite history in a temporary directory beside the repo
(on storage, rather than this host's RAM-backed `/tmp`). It excludes canonical
DB loading, annotation/token lookups, network, compression and playback. Every
delta is applied and compared to an unconditional full response. Timings and
tracemalloc are separate runs; changed timing is the median of three edits.
Original delta implementation, before bounded JSON serialization, measured
locally on 2026-09-21:

| Tracks | Full bytes | One-edit delta bytes | Full without history ms | First full + history ms | Changed delta ms | Four-revision file bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 712,815 | 925 | 16.75 | 189.15 | 146.40 | 348,160 |
| 10,000 | 7,156,815 | 925 | 158.48 | 457.45 | 414.68 | 3,264,512 |
| 50,000 | 35,916,815 | 925 | 781.90 | 1,470.12 | 1,682.60 | 16,928,768 |

In that original implementation, for 50,000 tracks, changed-response peak
additional Python allocation was
113,896,531 bytes: this slice does not remove full server snapshot construction.
Unchanged requests still took about 168 ms through the existing early 304 path.
The benefit here is transfer and client work, paid for by extra server hashing,
SQLite writes and disk usage. These results are not evidence of improved CPU,
audio continuity or production end-to-end latency. The subsequent
[bounded serialization chunk](library-delta-serialization.md) reduces that memory
peak. Avoiding full snapshot construction, annotation and per-row hashing on
changed responses remains separate work.

Tests cover exact ordered equivalence, annotations disappearing, additions and
removals, header/podcast changes, account isolation, restart in a fresh process,
TTL/count/byte quotas, rollback, concurrent admission, locked/corrupt history,
physical page limits and connection closure. Frontend tests verify validation,
object identity, atomic application, fallback and stale replies. Chromium and
WebKit exercise conditional HTTP, reload, artwork, deltas and bad-base recovery.
