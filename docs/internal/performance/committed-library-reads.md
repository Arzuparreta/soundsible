# Committed library reads

Two read paths walked the whole library to answer questions about a small
part of it:

- Every conditional `GET /api/library` fingerprinted the live in-memory model
  (one memo-free pickle of every track) to decide whether to answer 304, and a
  successful delta fingerprinted it twice more.
- Every download commit hashed all of the pool's `<music>/library.json` to
  check nobody else had written it, then read its podcast section again.

HTTP reuses what SQLite committed. The pool verifies the file once and avoids a separate podcast read.

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

The hint on the live model is the last fingerprint verified against a commit.
A canonical save, track edit, or a read that verifies a match can record it.
A model reloaded from SQLite has none and pays a verification pass. SQLite can
normalize field values during the write, so a reloaded model can differ from
the proof. The writer also carries the first stored `added_at` back to the
saved model.

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
upgraded before the header hash existed its deltas on the next edit or save.

### Contract change

While the model's verified fingerprint matches the committed source,
conditional requests can return 304 during an unsaved edit. A small delta
can describe the committed source during an unsaved edit to an unrelated
row. Such an edit does not travel in the delta. A full response can serve the
current live contents under a content revision, which its holder can
revalidate separately. Models without a verified committed source use full
comparison as before.

Existing databases gain the `library_public_headers` table on open. Their
proofs stay valid for 304s and full responses; deltas start after the next
canonical save records the header hash. The previous engine can still open and
save such a database: `library_public_source` keeps its columns, and a save by
that engine leaves the header hash under the old fingerprint, which turns
deltas off until this engine saves again.

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

Cloud sync validates the current digest against the one captured at the start
of the operation. It selects the podcast fields from the same descriptor
and leaves its incoming podcasts in place when the file is absent. The pool
rejects a stale revision before publication. The old publication offset and
the unused `Downloader.save_library()` were removed.

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
benchmark code. The HTTP and pool results below were recorded on `8ac8e3b5`.
Each delta is applied and compared with an unconditional full response.

HTTP, with `LibraryManager.patch_track_metadata` making each title edit:

| Tracks | 304 poll (ms) | Delta after a title edit (ms) |
| ---: | ---: | ---: |
| 1,000 | 2.47 → 0.60 | 72.25 → 68.70 |
| 10,000 | 20.10 → 0.59 | 102.13 → 76.10 |
| 50,000 | 94.00 → 0.63 | 263.41 → 76.40 |

Pool commits, alone and in the single-account download cycle (the account
saves and exports into the same file before each commit):

| Tracks | Pool-only commit (ms) | Bytes read | Cycle commit (ms) | Bytes read | Full cycle (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 108.71 → 98.81 | 1,474,785 → 1,269,849 | 92.17 → 84.49 | 5,079,392 → 1,269,941 | 393.01 → 384.76 |
| 10,000 | 233.78 → 225.44 | 11,071,053 → 10,866,117 | 408.87 → 361.00 | 43,464,469 → 10,866,217 | 2,360.27 → 2,342.26 |
| 50,000 | 892.33 → 917.34 | 53,921,069 → 53,716,132 | 1,984.38 → 1,666.79 | 214,864,462 → 53,716,221 | 12,080.17 → 11,750.27 |

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
  manifest still dominate the commit. The median pool-only commit at 50,000
  tracks was 2.8% slower in this run despite skipping the podcast suffix.
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

## Reproduce

```sh
venv/bin/python scripts/benchmark_committed_reads.py --reference origin/main
venv/bin/python -m pytest -q tests/test_library_incremental.py tests/test_library_revision.py \
  tests/test_pool_library_save.py tests/test_pool_podcast_reader.py
```
