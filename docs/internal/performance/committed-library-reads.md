# Committed library reads

Two read paths walked the whole library to answer questions about a small
part of it:

- Every conditional `GET /api/library` fingerprinted the live in-memory model
  (one memo-free pickle of every track) to decide whether to answer 304. A
  successful delta performed two complete passes.
- Every download commit hashed all of the pool's `<music>/library.json` to
  check nobody else had written it, then read its podcast section again.

HTTP reuses what SQLite committed. The pool verifies the file contents and
avoids a separate podcast read.

## Library HTTP reads

The flat `GET /api/library` representation comes from the canonical SQLite
tables. Fresh, conditional and delta requests see committed tracks and header
fields, including during an in-memory edit or a save. The catalog keeps its own
projection of artist names. The flat response exposes the stored structured
credits, including null for legacy tracks without credits, and the original
display artist. SQLite supplies normalized scalar values the same way before
and after a restart.

- **Conditional request.** A weak ETag combines the account, public projection,
  SQLite revision and proof, and artwork and loudness tokens. A matching ETag
  needs a fixed number of lookups and bypasses track and header queries.
- **Delta.** Read the journal and changed rows from the same SQLite snapshot.
  An unchanged header hash skips playlists, settings and podcast fields
  entirely. When headers changed, compare their field hashes against the
  client's base. Only changed tracks are annotated. Recheck source and
  annotation cursors before returning a delta. Order changes include the
  complete ID order. A size check visits at most as many IDs as the delta can
  account for under a conservative minimum track size.
- **Full response.** A single SQLite snapshot supplies headers and tracks
  with item IDs in index order. It shares the SQL projection and validator
  of a delta when annotation tokens stay current. Missing or expired
  bases, pruned journals, and large changes can require a full response.
  Unverified SQL state and annotation errors fall back to content validators.
  Annotation tokens are skipped for empty libraries.

The public-source and per-track hashes still commit with the saved values.
The batch writer hashes the same captured track values it binds to SQL and
uses a single detached header snapshot for both SQLite and the proof. A
targeted edit shares the encoding pass for its before and after proofs, and
rejects unrelated unsaved model changes. When SQLite normalizes a legacy
record on reload, an edit checks the live model against the stored view and
uses the original stored credits for the write. It edits one row when the
stored snapshot matches the journal and rebuilds the proof otherwise.

Playlists, imports, acquisitions, podcast updates, scans and repairs publish
their candidates after commit. Podcast fetching stays outside the write lock,
and refresh cannot recreate an unsubscribed feed. Subsonic builds its playlist
response and sends its notifications outside the global write lock. A purge
checks storage before changing membership and filters the tracks and playlist
references once.

### Upgrades

Existing SQLite libraries keep their journals and gain the optional table of
header hashes and the track position index. An older writer can still read and save them. The flat SQLite
projection uses a new ETag namespace. A client holding a pre-upgrade base
bootstraps once from a full response, then receives small deltas without any
library save. When a header hash is absent, the reader can take committed
headers from the same SQLite snapshot as the changed rows and skip them when
the base already describes that revision.

## Pool manifest

`<music>/library.json` has two writers: the pool (ODST, `Downloader`) and,
on single-user instances, the Station's portable export. Both publish under
`shared.file_revision.publication_lock`. The pool must not overwrite a newer
file, and must keep the podcast subscriptions and episodes the Station writes
there.

The pool holds the existing directory lock from reading the manifest through
publishing its update. Its resident model carries the SHA-256 and byte count
of the file it loaded or wrote. Every commit validates the bytes under the
lock. The byte count only chooses how to read the file:

- A different size takes one combined parse and digest pass. The parsed
  model already contains the other writer's podcast fields. Adding a track
  in the Station export usually takes this path.
- The same size takes a digest pass. A match keeps the resident model and
  needs neither JSON parsing nor a podcast read. A mismatch rewinds the same
  descriptor and parses and hashes the changed bytes together.

Cloud sync captures the digest and detached podcast fields when it opens its
initial snapshot. On return it verifies the current file's digest before
publication, then uses the captured podcasts. It keeps the incoming podcasts
if the original file was absent. Replacement needs no JSON parse at this
stage, even when a stale file now contains malformed JSON. This removes the
separate podcast parser, its publication offset and the unused
`Downloader.save_library()`.

A download commit finds the replacement with one scan and stages membership
changes in a shallow list copy only when reusing the resident model. It avoids
building lookup maps solely for a single commit. It publishes that model
after the file replacement succeeds and before the directory sync can yield. A failed
rename cannot leave a pending addition or replacement in the next unrelated
commit. If the task is cancelled during the directory sync, the in-memory
model already reflects the renamed file.

A writer that finishes an edit before the pool opens the file is visible even
when it restores timestamps and preserves the byte count. Cooperating
writers cannot change the file between verification and publication. A
third-party writer that changes it during that interval is outside the lock
protocol, as before.

## Measurements

`scripts/benchmark_committed_reads.py --reference origin/main --sizes 1000
10000 50000 --repeats 5`, run on 2026-11-19 on the development machine
(Python 3.14, repository storage volume), [raw results](committed-library-reads-results.jsonl).
The table shows medians of five. The reference is `origin/main` at
`16a8955b`. Both trees use the same benchmark code, which applies each delta
and compares the result with an unconditional full response.

The HTTP numbers cover `/api/library`. Once the stock web client bootstraps
the collection, its recurring refresh uses `/api/library/collection`, which
already has revision-based 304s. The download-pool measurements are
independent of the client.

The HTTP fixture uses `LibraryManager.patch_track_metadata` for each title edit.

| Tracks | 304 poll (ms) | Delta after a title edit (ms) | Full GET (ms) |
| ---: | ---: | ---: | ---: |
| 1,000 | 2.97 → 0.63 | 69.93 → 64.14 | 17.58 → 14.85 |
| 10,000 | 23.70 → 0.60 | 113.68 → 64.93 | 151.23 → 137.89 |
| 50,000 | 109.40 → 0.70 | 294.69 → 68.08 | 757.77 → 740.09 |

Pool commits, alone and in the single-account download cycle. A cycle begins
with the pool commit, then adds that same track to the account and exports
into the shared file. One warm-up cycle gives the first timed pool commit the
preceding Station export, as in a steady stream of downloads.

| Tracks | Pool-only commit (ms) | Bytes read | Cycle commit (ms) | Bytes read | Full cycle (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 75.35 → 67.07 | 1,474,785 → 1,269,849 | 117.07 → 84.72 | 5,079,396 → 1,269,942 | 451.42 → 401.35 |
| 10,000 | 242.09 → 225.35 | 11,071,053 → 10,866,120 | 458.34 → 382.46 | 43,464,445 → 10,866,214 | 2,693.78 → 2,577.15 |
| 50,000 | 950.62 → 925.70 | 53,921,065 → 53,716,133 | 2,209.76 → 1,924.46 | 214,864,459 → 53,716,223 | 13,605.62 → 13,555.70 |

- The 304 took 0.60 to 0.70 ms across the three library sizes.
- A one-title delta avoids scanning unrelated tracks. Order changes still
  fetch and transmit the order. Header reads and hashing happen only when
  the base may have different headers.
  Almost all of the measured time is one commit to the delta-history database
  (`library_incremental.remember`): a profile at 1,000 tracks puts 65 of 69 ms
  in that commit's sync on this disk. That sync varies by tens of milliseconds
  between runs and can dominate the impact at 1,000 tracks.
- A pool-only commit verifies the digest and skips the podcast reread. In
  the benchmark cycle, the Station adds a track, so the pool reads the changed
  manifest once instead of four times. Encoding and syncing the portable
  manifest still dominate the commit. The full-cycle and pool-only timings
  include storage and sync costs, which varied across runs.
- Bytes read are `rchar`, which counts page-cache hits: physical disk reads
  saved depend on the cache.

The full cycle includes the Station's save and export and the pool commit.
Commit times include the manifest's fsync on this disk, which varies between
runs. The benchmark excludes network, compression, playback and measurements
on other hardware.

After sharing the two track-edit fingerprints' encoding pass,
`scripts/benchmark_track_metadata_patch.py --sizes 10000 --repeats 5` measured
493 ms on the base and 476 ms on the candidate for the complete title edit,
including portable exports. The samples overlapped. The proof improvement is
one shared encoding pass inside the transaction; the pre-edit validation and
portable export still traverse the library.

A separate cloud conflict probe opened a 50,000-track snapshot, rewrote one
title in the portable file, then attempted the stale replacement five times.
Median time under the replacement path was 28.0 ms on the base, 331.8 ms on
`8ac8e3b5` with parsing before verification, and 27.6 ms with digest-only
verification. Each attempt returned 409 and preserved the changed file.

## Reproduce

```sh
venv/bin/python scripts/benchmark_committed_reads.py --reference origin/main
venv/bin/python -m pytest -q tests/test_library_incremental.py tests/test_library_revision.py \
  tests/test_pool_library_save.py tests/test_api_sync_task.py
```
