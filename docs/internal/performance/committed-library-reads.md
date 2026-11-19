# Committed library reads

Two read paths walked the whole library to answer questions about a small
part of it:

- Every conditional `GET /api/library` fingerprinted the live in-memory model
  (one memo-free pickle of every track) to decide whether to answer 304, and a
  successful delta fingerprinted it twice more.
- Every download commit hashed all of the pool's `<music>/library.json` to
  check nobody else had written it, then read its podcast section again.

Both now ask the source of record instead of re-deriving it.

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

Every fast path rests on one rule, in `library_incremental.live_fingerprint()`:
the live model stands for the committed source only once it is **known** to
be it. `shared.library_fingerprint.record()` keeps on the model object the
fingerprint it was last proven to have: by the save that committed it (the
saved model becomes the live one), by a track edit, or by a full response. A
model reloaded from SQLite has none and pays one pass, recorded; if its values
differ from the proof (a value normalized on the way into SQLite), it never
stands for that source, and the requests behave as before this change.
Saves also write back to the model the one value SQLite overrides, the first
stored `added_at`, so the proof describes the stored row.

- **Conditional request.** The validator is looked up under the live model's
  fingerprint: one SQLite row while the model is known to be the committed
  source, one pass over the library otherwise. A client holding the revision
  of an unsaved or normalized model still gets its 304.
- **Delta.** Only from a model known to be the committed source. The journal
  names the affected tracks; `affected()` returns each one's committed row hash
  with its position. The route copies those rows and checks each copy, and the
  copied headers, against the committed hashes. Any mismatch (an edit not yet
  saved, one racing the copy) sends the full response instead. Nothing else in
  the model is read.
- **Full response.** Unchanged: it serves the live model, fingerprints the
  detached copy, records that fingerprint, and carries the committed revision
  only when that copy is the committed source.

Annotation dependencies (artwork and loudness tokens) are skipped for an empty
library, as before. For a conditional request, whether the library is empty
is the committed source's answer while the live model is that source, never
what a writer has done to the live list in the meantime.

A targeted track edit, once it has proven the headers are the committed ones,
writes their hash for the new source, so a database upgraded before the hash
existed regains deltas on its first edit or save.

### Contract change

A conditional request and a delta describe the **committed** library. An
in-place edit that has not been saved and that no request has seen yet no
longer makes every polling client download the full library: they get 304,
since nothing was committed. Once a request has seen the live model differ
(a full response, or the pass after a reload), the route answers for that
live model as before: clients holding its revision get 304, and the others
get the full response with a content revision. An unsaved edit is never
labelled with a committed revision, and no delta is built from a model that
differs from the committed source. Models without a verified committed
source (no database, a proof invalidated by raw SQL) keep the previous
behaviour.

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

The directory's publications are now counted: the lock file stores a 64-bit
generation after its first byte, advanced by every `publish()` and
`replace_contents()` in any process, even a failed one (a new lock file starts
counting at a random value). Holding the lock to read writes nothing. The
pool remembers, as `_seen`, the generation, the manifest's `stat` signature
(device, inode, size, modification and change times) and its content digest
as it last observed them; separately, `_manifest_revision` is the digest of
the file its resident model came from. On the next hold:

- same generation **and** unchanged signature: nothing was published in the
  directory since and nothing else replaced or rewrote the
  file, so the remembered digest is the file's. Nothing is read. The model in
  memory is the file's model, podcasts included, so they are not read either.
- otherwise: one pass over the file computes its signature (from the open
  descriptor), its digest and its model together; the model is adopted if the
  digest is not the one the pool's model came from, and then carries the other
  writer's podcasts. Before, this case read the file four times (digest,
  model, digest again, podcasts).

The signature the pool remembers after publishing is taken by
`replace_contents()` straight after the rename, before the directory sync, and
kept only if its device, inode, size and modification time are those of the
descriptor it wrote; otherwise, or if `stat` fails, the next commit reads the
file. Any later write by anyone, even one that restores the modification
time, changes the change time and so the signature. "Not known" is its own
value, never confused with the digest of a missing file. A generation that
cannot be read or written leaves the lock working and makes the pool read the
file; the lock file is unbuffered, so a failed counter write cannot resurface
when the lock is released. Bookkeeping never fails a publication.

`replace_snapshot` (cloud sync) keeps the current file's podcasts: from memory
when the pool's model is the current file, from `read_podcast_fields` when it
is not, and the snapshot's own when there is no file yet. The offset reader
and `LibraryJSONWriter.podcast_offset` were removed, and so was `Downloader.save_library()`, which had no production caller.

Limits. Cooperating Soundsible writers are detected exactly. A writer that
ignores the lock (an editor, a sync tool, an older Soundsible) is detected by
the signature. It misses an in-place rewrite that keeps the size and both
timestamps within the file system's timestamp resolution, and one that lands
in the microseconds between the rename and the `stat` that follows it. Such a
writer was never fully protected: before, a write landing between the pool's
digest and its rename, a window as long as serializing the whole manifest,
was overwritten the same way. Any other publication in the same directory
makes the pool read the file once more: conservative, never wrong.
On Windows, `stat` reports the creation time in `st_ctime_ns`. The pool
checks the file's digest there even for an unchanged signature, and only
loads the model when that digest differs from the resident model's.
The counter lives in the directory's lock file because the Station's export
uses the generic `publish()`; each publication there writes nine bytes to it.

## Measurements

`scripts/benchmark_committed_reads.py --reference origin/main --sizes 1000
10000 50000 --repeats 5`, run on 2026-11-19 on the development machine
(Python 3.14, repository storage volume), [raw results](committed-library-reads-results.jsonl).
Medians of five; "before" is `origin/main` at `16a8955b`, run by the same
benchmark code. Each delta is applied and compared with an unconditional full
response.

HTTP, with `LibraryManager.patch_track_metadata` making each title edit:

| Tracks | 304 poll (ms) | Delta after a title edit (ms) |
| ---: | ---: | ---: |
| 1,000 | 2.13 → 0.58 | 55.71 → 51.77 |
| 10,000 | 16.05 → 0.59 | 104.67 → 60.85 |
| 50,000 | 87.64 → 0.60 | 247.69 → 59.66 |

Pool commits, alone and in the single-account download cycle (the account
saves and exports into the same file before each commit):

| Tracks | Pool-only commit (ms) | Bytes read | Cycle commit (ms) | Bytes read | Full cycle (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 67.10 → 75.38 | 1,474,785 → 139 | 83.75 → 75.97 | 5,079,392 → 1,269,957 | 384.63 → 376.90 |
| 10,000 | 233.76 → 217.10 | 11,071,053 → 147 | 417.19 → 342.20 | 43,464,469 → 10,866,233 | 2,302.00 → 2,219.23 |
| 50,000 | 882.59 → 858.91 | 53,921,069 → 156 | 2,001.20 → 1,676.04 | 214,864,462 → 53,716,237 | 11,638.46 → 11,371.90 |

- The 304 no longer grows with the library: about 0.6 ms at every size.
- A one-title delta avoids scanning unrelated tracks. Order changes still
  fetch and transmit the order, and header work scales with the header size.
  Almost all of the measured time is one commit to the delta-history database
  (`library_incremental.remember`): a profile at 1,000 tracks puts 65 of 69 ms
  in that commit's sync on this disk. That sync varies by tens of milliseconds
  between runs and can dominate the impact at 1,000 tracks.
- A pool-only commit reads nothing of the manifest. In the download cycle the
  commit reads the Station's new file once (the manifest size) instead of
  four times. Commit time stays dominated by serializing and syncing the whole
  manifest.
- Bytes read are `rchar`, which counts page-cache hits: physical disk reads
  saved depend on the cache.

The full cycle includes the Station's save and export and the pool commit.
Commit times include the manifest's fsync on this disk, which varies between
runs. The benchmark excludes network, compression, playback and measurements
on other hardware.

## Reproduce

```sh
venv/bin/python scripts/benchmark_committed_reads.py --reference origin/main
venv/bin/python -m pytest -q tests/test_library_incremental.py tests/test_library_revision.py \
  tests/test_pool_library_save.py tests/test_pool_podcast_reader.py
```
