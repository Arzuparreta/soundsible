# Committed library reads

Two read paths walked the whole library to answer questions about a small
part of it:

- Every conditional `GET /api/library` fingerprinted the live in-memory model
  (one memo-free pickle of every track) to decide whether to answer 304, and a
  successful delta fingerprinted it twice more.
- Every download commit hashed all of the pool's `<music>/library.json` to
  check nobody else had written it, then read its podcast section again.

HTTP reuses what SQLite committed. The pool verifies the file contents and
avoids a separate podcast read.

## Library HTTP: answer from the committed source

The account database already commits, with each canonical save, a public
source (`library_public_source`: a fingerprint of the exact public model it
saved) and one hash per track (`library_public_rows`). This change adds the
hash of the public header fields, in the same transaction, in its own table
`library_public_headers` keyed by the source fingerprint it belongs to.

A save takes one detached copy of the headers
(`LibraryMetadata.public_headers()`, the same projection responses and exports
use) and uses that copy for the stored playlists and `library_state`, for the source
fingerprint and for the header hash, so an edit to the live model during the
save cannot make the three disagree.

The full writer captures each track's values once in its existing SQLite
batch. It computes the public fingerprint and journal row hash from those
values and uses them to bind the SQL write. The batch fetches the saved row
and its public hash together. This removes the later query and scan that
could certify a title changed in memory after it was written to SQLite.

The hint on the live model is the last fingerprint verified against a commit.
A canonical save, track edit, or a read that verifies a match can record it.
A model reloaded from SQLite has none and pays a verification pass. SQLite can
normalize field values during the write, so a reloaded model can differ from
the proof. The writer also carries the first stored `added_at` back to the
saved model.

If the proof differs after a reload, a label edit can use the full writer
after verifying that the live model matches a fresh SQLite snapshot. This
lets older imports be edited without certifying unrelated unsaved changes.

- **Conditional request.** A verified fingerprint that matches the
  committed source can revalidate a revision of that source without a new
  model scan. Otherwise the route fingerprints the live model and can
  revalidate its own revision. The route shares that result with the delta
  attempt. Holders of a revision served from unsaved content can still
  revalidate it after the committed shortcuts decline the request.
- **Delta.** Candidate models must have a verified fingerprint that
  matches the source. The journal names the affected tracks and supplies
  their committed positions and hashes. Every detached row and all detached
  headers must match their committed hashes before the route labels the
  response with the committed revision. A mismatch falls back to a full
  response. The route leaves unrelated rows alone.
- **Full response.** The route serves the live model and fingerprints the
  detached copy. It uses the committed revision and records its fingerprint
  only when that copy matches the committed source. An intervening full read
  of unsaved content does not change whether a later delta can use that source.

Annotation dependencies (artwork and loudness tokens) are skipped for an empty
library, as before. For a conditional request, whether the library is empty
comes from SQLite while the verified fingerprint matches the committed
source.

A targeted track edit detaches the headers and changed row once. It builds
the pre-edit and post-edit fingerprints in one traversal, encoding shared
rows once and feeding the same bytes to both digests. The verified pre-edit
fingerprint binds the shared bytes to the prior commit. The same detached
headers and row supply the new committed hashes. This also gives a database
upgraded before the header hash existed a persisted hash on the next edit or
save.

### Contract change

While the model's verified fingerprint matches the committed source,
conditional requests can return 304 during an unsaved edit. A small delta
can describe the committed source during an unsaved edit to an unrelated
row. Such an edit does not travel in the delta. A full response can serve the
current live contents under a content revision, which its holder can
revalidate separately. Models without a verified committed source use full
comparison as before.

Playlist endpoints, including legacy imports, stage the playlist map and
settings together, using the same commit-then-publish path as acquisitions.
Fresh and conditional reads
both see the previous playlist until the save succeeds. Subsonic updates
also parse the removal indices before applying any addition. Subsonic builds
the playlist creation response after releasing the library write lock.

Podcast requests fetch RSS outside the write lock. A subscription or cache
update then uses the current library revision and saves a candidate. A
playlist saved during the fetch survives, a pending subscription stays
invisible until commit, and a refresh cannot recreate an unsubscribed feed.
URL checks strip surrounding whitespace from older saved feed URLs.

A purge checks storage before changing membership, then filters the track
list and playlist references once. It publishes the candidate after the
canonical save, as do individual deletion and clearing the library. A read
during the storage checks sees the complete previous library.

Existing databases gain the `library_public_headers` table on open. Their
proofs stay valid. Until the first save writes a header hash, a served base
for the same canonical fingerprint proves the client's headers. The route
compares the detached fields with that base, so artwork and loudness changes
can still use small deltas. A base from a different canonical fingerprint
falls back to one full snapshot. The previous engine can still open and save
such a database because `library_public_source` retains its columns.

On a disposable 1,000-track database created by the base version, an artwork
change before any new save returned a 1,108-byte delta. The same probe on
`23cf30f3` returned a 779,456-byte full snapshot.

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

A download commit stages membership changes in a shallow list copy only
when reusing the resident model. It publishes that model after the file
replacement succeeds and before the directory sync can yield. A failed
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
Medians of five; "before" is `origin/main` at `16a8955b`, run by the same
benchmark code. Each delta is applied and compared with an unconditional full
response.

The HTTP numbers cover `/api/library`. Once the stock web client bootstraps
the collection, its recurring refresh uses `/api/library/collection`, which
already has revision-based 304s. The download-pool measurements are
independent of the client.

HTTP, with `LibraryManager.patch_track_metadata` making each title edit:

| Tracks | 304 poll (ms) | Delta after a title edit (ms) |
| ---: | ---: | ---: |
| 1,000 | 3.37 → 0.81 | 94.65 → 88.77 |
| 10,000 | 23.28 → 0.78 | 112.98 → 76.75 |
| 50,000 | 108.66 → 0.80 | 302.76 → 73.72 |

Pool commits, alone and in the single-account download cycle. A cycle begins
with the pool commit, then adds that same track to the account and exports
into the shared file. One warm-up cycle gives the first timed pool commit the
preceding Station export, as in a steady stream of downloads.

| Tracks | Pool-only commit (ms) | Bytes read | Cycle commit (ms) | Bytes read | Full cycle (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 83.71 → 75.38 | 1,474,785 → 1,269,849 | 100.35 → 85.04 | 5,079,396 → 1,269,942 | 434.73 → 410.21 |
| 10,000 | 242.33 → 250.37 | 11,071,053 → 10,866,116 | 467.15 → 412.57 | 43,464,445 → 10,866,211 | 2,802.56 → 2,777.08 |
| 50,000 | 1,017.37 → 997.16 | 53,921,065 → 53,716,132 | 2,251.03 → 2,018.68 | 214,864,459 → 53,716,222 | 14,164.79 → 14,114.18 |

- The 304 no longer grows with the library: about 0.6 ms at every size.
- A one-title delta avoids scanning unrelated tracks. Order changes still
  fetch and transmit the order, and header work scales with the header size.
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
