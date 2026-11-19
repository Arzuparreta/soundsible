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
hash of the public header fields (`library_public_source.headers`) to the same
proof, in the same transaction.

- **Conditional request.** The route reads the committed fingerprint (one
  SQLite row) and looks up the revision cached for it. A client holding that
  revision gets 304 without the live model being touched. Only when the model
  is not known to be the committed source does the route also fingerprint it,
  exactly as before, so a client holding the revision of an unsaved or
  normalized model still gets its 304.
- **Delta.** The journal names the affected tracks; `affected()` now returns
  each one's committed row hash with its position. The route copies those rows
  from the live model and checks each copy, and the copied headers, against the
  committed hashes. Any mismatch (an edit not yet saved, one racing the copy)
  sends the full response instead. Nothing else in the model is read.
- **Full response.** Unchanged: it serves the live model, fingerprints the
  detached copy and carries the committed revision only when that copy is the
  committed source.

`shared.library_fingerprint.record()` keeps, on the model object, the
fingerprint it was last proven to have (by the save that committed it, or by
a full response). It is only ever used to skip a fingerprint whose answer is
already known; it never makes a response carry a revision. An in-place edit
after recording it is caught by the row and header checks above, and costs at
most a full 200 instead of a 304.

### Contract change

A conditional request and a delta describe the **committed** library. Before,
a writer's in-place edit that had not been saved yet made every polling client
download the full library, and a delta refused to describe anything while it
was pending. Now those clients get 304 (nothing was committed) or a delta of
what was committed. An unsaved edit is still never labelled with a committed
revision: a fresh client gets it in a full response under its own content
revision, and a delta whose rows or headers it touched falls back to that full
response. Models without a verified committed source (no database, a proof
invalidated by raw SQL, a database migrated before its first save) keep the
previous behaviour, including the live-model fingerprint.

Existing databases gain the `headers` column on open. Their proofs stay valid
for 304s and full responses; deltas start after the next canonical save
records the header hash.

## Pool manifest

`<music>/library.json` has two writers: the pool (ODST, `Downloader`) and,
on single-user instances, the Station's portable export. Both publish under
`shared.file_revision.publication_lock`. The pool must not overwrite a newer
file, and must keep the podcast subscriptions and episodes the Station writes
there.

`publication_lock` now counts its holds: the lock file stores a 64-bit
generation after its first byte, advanced by every outermost hold in any
process (the counter of a new lock file starts at a random value). The pool
remembers the generation of its last hold together with the manifest's
`stat` signature (device, inode, size, modification and change times) and
content digest. On the next hold:

- generation exactly one higher **and** unchanged signature: no cooperating
  writer held the lock in between and nothing else replaced or rewrote the
  file, so the remembered digest is the file's. Nothing is read. The model in
  memory is the file's model, podcasts included, so they are not read either.
- otherwise: the file is hashed as before and, if it changed, reloaded; the
  reload carries the other writer's podcasts. The second podcast read the
  previous code did after a reload is gone.

`replace_snapshot` (cloud sync) keeps the current file's podcasts: from memory
when the pool's model is the current file, from `read_podcast_fields` when it
is not. The offset reader and `LibraryJSONWriter.podcast_offset` were removed,
and so was `Downloader.save_library()`, which had no production caller.

Limits. Cooperating Soundsible writers are detected exactly. A writer that
ignores the lock (an editor, a sync tool, an older Soundsible) is detected by
the signature, which misses only an in-place rewrite that keeps the size and
both timestamps, or one that lands between the pool's rename and its `stat`.
Before, a full content hash caught those too. Any other hold of the lock in
the same directory, even a read, makes the pool hash once more: conservative,
never wrong.

## Measurements

`scripts/benchmark_committed_reads.py --reference origin/main --sizes 1000
10000 50000 --repeats 5`, run on 2026-11-19 on the development machine
(Python 3.14, repository storage volume), [raw results](committed-library-reads-results.jsonl).
Medians of five; "before" is `origin/main` at `16a8955b`, run by the same
benchmark code. Each delta is applied and compared with an unconditional full
response.

| Tracks | 304 poll (ms) | Delta after a title edit (ms) | Download commit (ms) | Bytes read per commit |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 2.00 → 0.55 | 80.49 → 58.02 | 83.75 → 75.40 | 1,312,361 → 132 |
| 10,000 | 14.39 → 0.57 | 117.88 → 64.46 | 242.14 → 234.35 | 9,457,385 → 140 |
| 50,000 | 80.44 → 0.58 | 250.84 → 72.53 | 775.91 → 750.51 | 45,857,391 → 146 |

- The 304 no longer grows with the library: 0.55–0.58 ms at every size.
- The delta's remaining cost is almost all one commit to the delta-history
  database (`library_incremental.remember`): a profile at 1,000 tracks puts
  65 of its 69 ms in that commit's sync on this disk, independent of library
  size. The rest grows with the rows sent, not the library.
- A download commit no longer reads the manifest it wrote (45.9 MB at 50,000
  tracks with a 20-feed podcast cache). Its time is still dominated by
  serializing and syncing the whole manifest, so it falls only 3–10 %.
  Bytes read are `rchar`, which counts page-cache hits: physical disk reads
  saved depend on the cache.

What this does not measure: network, compression, playback, the Station's
own export, physical devices or a Raspberry Pi. Commit times include the
manifest's fsync on this disk, which varies between runs.

## Reproduce

```sh
venv/bin/python scripts/benchmark_committed_reads.py --reference origin/main
venv/bin/python -m pytest -q tests/test_library_incremental.py tests/test_library_revision.py \
  tests/test_pool_library_save.py tests/test_pool_podcast_reader.py
```
