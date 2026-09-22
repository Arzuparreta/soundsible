# Incremental canonical library writes

`DatabaseManager.replace_library()` still replaces the complete logical snapshot
in one transaction, checks `expected_revision` inside `BEGIN IMMEDIATE`, and
increments the revision on every successful call, including unchanged snapshots.
It now writes only changed canonical rows. Aliases, first `added_at`, user state,
playlist order/repeated entries, external playlist IDs and catalog aggregation
retain their previous semantics. Catalog entity timestamps change only when the
entity changes; creation timestamps survive updates.

Tracks are compared against persisted values in batches of 500. Membership,
order, playlist entries and catalog credits use transaction-local SQLite tables
with `temp_store=FILE` and a 512 KiB temporary page cache. Temporary tables and
connection settings are cleaned up on success and failure. There is no retained
metadata cache or schema migration. SQLite chooses the temporary-file directory;
deployments should keep it on disk (a RAM-backed `SQLITE_TMPDIR` defeats that
storage choice). The cache limit bounds scratch pages, not total process memory.

Title/technical/playlist-only edits skip catalog construction. Changes to track
membership/order or catalog-driving fields still use the existing full catalog
builder so order-sensitive aggregation remains identical. Its output is persisted
incrementally: unchanged artists, albums, credits and album links are untouched,
and orphan entities are pruned.

## Validation

Tests compare the resulting canonical tables and public payload against frozen
writer functions from `2ad6db3`, across unchanged saves, additions/removals,
empty libraries, ordering, artist/album/year/media-kind changes and headers.
Database triggers verify actual row mutation counts: an unchanged save updates
only `library_state`; a title edit updates one track; a playlist edit updates
one entry. Tests also cover first-added dates, surviving user state, rollback,
failed staging cleanup/retry, SQLite's 999-parameter limit, selective catalog
timestamps and competing writers sharing a revision.

## Reproducing the measurements

```sh
venv/bin/python scripts/benchmark_library_writes.py --sizes 1000 10000 50000 --repeats 3 --memory
```

The benchmark compares the frozen writer and current implementation against
separate fresh databases on the repository's storage filesystem. Each edit starts
from the same logical library; WAL is truncated before each measured write and
automatic checkpoints are disabled. Times and byte counts are medians of three
runs. Initial imports are single measurements. A separate run with `tracemalloc`
measures additional Python allocations, excluding the preexisting input snapshot
and native SQLite allocations; timings exclude that instrumentation. Linux
`/proc/self/io` counters include temporary I/O: `wchar` counts bytes passed to
write calls, while `write_bytes` counts storage writes charged to this process,
not physical-device traffic after filesystem caching.

These are synthetic canonical-write measurements. They do not measure JSON
export, API serialization/deltas, browser work or audible playback. Small
libraries can use more temporary Python memory than the old writer because of
the fixed comparison batch; large catalog-changing saves still construct the
full projection. Initial imports also incur extra temporary I/O, so this change
primarily improves repeated saves and small edits.

A save now rebuilds the artist/album projection only when a song's catalog
fields or order change. The old writer rebuilt it on every save, which also
applied any change to the projection rules at the next save. That job belongs to
`shared.library_catalog.PROJECTION_VERSION` now: bump it with any change that
makes the same tracks project differently, and each library rebuilds once, in
manifest order, when the engine next opens it. The same check rebuilds songs
that have no catalog links at all. Otherwise a start costs two small reads.
Measured on tmpfs with the export benchmark's synthetic tracks: a normal start
~1.2 ms at any size; a start that rebuilds ~115 ms at 1k tracks, ~1.2 s and
30 MiB of Python allocations at 10k, ~6.4 s and 151 MiB at 50k, once per bump.

## Recorded results (2026-09-21)

Raw measurements: [JSONL](incremental-library-writes-results.jsonl). Linux,
SQLite temporary files observed on `/var/tmp` (ext4), databases on the storage
volume (ext4). The baseline is `2ad6db3`; the candidate is the implementation
committed with this report. The first small-library measurements overlapped the
Python test suite; the 50,000-track measurements ran after it completed. Treat
absolute timings as local observations, not cross-machine guarantees.

For 50,000 tracks, arrows show baseline → incremental writer. MB are decimal.

| Save | Time (ms) | WAL bytes | Process storage writes (MB) | Extra Python peak (MB) |
| --- | ---: | ---: | ---: | ---: |
| initial | 2768 → 3018 | 27,550,472 → 27,550,472 | 27.67 → 36.50 | not measured |
| same | 2922 → 450 | 19,388,752 → 4,152 | 19.39 → 2.95 | 19.65 → 0.85 |
| title | 2976 → 467 | 19,594,752 → 28,872 | 24.22 → 2.97 | 19.65 → 0.86 |
| playlist | 2927 → 446 | 19,652,432 → 8,272 | 19.66 → 2.95 | 19.66 → 0.85 |
| album | 2936 → 1471 | 19,565,912 → 57,712 | 19.61 → 6.62 | 19.66 → 18.69 |
| order | 2987 → 1469 | 21,893,712 → 927,032 | 21.90 → 8.40 | 19.66 → 18.69 |

Unchanged saves at 1,000 / 10,000 / 50,000 tracks used about 0.83 / 0.84 /
0.85 MB of additional Python allocations, versus 0.40 / 3.92 / 19.65 MB in the
baseline. There is a bounded small-library overhead, rather than an additional
Python representation growing with every song on ordinary saves.

Initial import was about 9% slower at 50,000 tracks and process-charged storage
writes rose from 27.67 to 36.50 MB. Write-system-call bytes increased from 61.49
to 534.73 MB, including scratch/journal writes; these are not equivalent to
physical device writes. WAL reductions alone must not be presented as total
I/O reductions. Subsequent ordinary saves reduced both WAL and the measured
process storage writes; catalog-changing saves retain a larger memory cost.

Validation: full Python suite, 1,331 passed; final focused suite, 23 passed
(including an additional malformed-staging rollback test); Ruff and
`git diff --check` passed. No frontend code changed.
