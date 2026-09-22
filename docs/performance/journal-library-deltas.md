# Journal-driven public library deltas

The previous route prepared and annotated every public track, then hashed all
rows to discover a small delta. This implementation records changed keys in
SQLite and prepares only affected public rows when it can prove the client's
base and current source. It introduces no process-local metadata cache.

## Data and request flow

Canonical saves maintain `library_public_rows`: one public-value hash and
loudness identity per current track. Batches of 500 compare these rows and
update only differences. `library_public_source` stores a fingerprint of the
exact encoded public values and an ordering generation. The proof and journal
commit in the same transaction as the canonical library, preserving revision
checks, aliases, dates and user state. Failures roll back all of them. Raw SQL
changes to source/catalog tables invalidate the proof; only a subsequent
verified canonical save enables the shortcut again. Existing databases start
unverified after migration and use the complete route until such a save.

Transactional key journals also track artwork references/object dimensions and
loudness identities, including direct SQL changes and deletions. Changed object
hashes are mapped through indexed artwork references; changed loudness identities
are mapped through the canonical identity index. Selected loudness queries load
only requested identities, rather than all measurements.

A delta base retains only the canonical proof, annotation tokens/cursors and
header hashes in the existing disposable history database. On a supported
request, the route:

1. Verifies the mutable in-memory model against its committed fingerprint.
2. Loads bounded changed-key sets since the client's base and resolves current
   canonical positions. Coalescing preserves the first operation, so a song added
   and deleted between polls does not produce an invalid removal.
3. Copies only affected tracks and detached headers. A second fingerprint uses
   those exact copies, guarding edits during copying and edits not yet saved.
4. Annotates only those tracks, rechecks all source cursors, and returns a delta
   only if it is provably smaller than the complete JSON representation.

Membership/order changes include a full ordered ID list, as required by the
existing client protocol. Header-only edits include changed header blocks, not
track dictionaries. Deleted annotations disappear because upserts remain
complete public track dictionaries. Restart, account isolation and clients with
a base from the previous implementation use the same wire shape and fallback.

## Validators and compatibility

For verified canonical sources, weak ETags now hash account-scoped public-source
and annotation dependency tokens, not serialized JSON bytes. The ETag is still
an opaque string; full responses and partial responses for the same verified
state agree. Annotation tokens can conservatively change even for an unrelated
song. The existing validator cache still contains only short strings and retains
early 304 behavior. Custom/pretty JSON providers, empty libraries, unverified
models, annotation failures, missing/expired history, pruned journals and large
change sets fall back safely. The legacy content-hash path remains available
for models without a verified canonical source.

The public fingerprint now ignores Python object-sharing topology. Equal strings
or nested containers must produce the same proof whether loaded afresh from
SQLite or shared by an existing model. Fingerprints encode values with a bounded,
memo-free Pickler; encoded values are never retained or unpickled. Cyclic or
unsupported models cannot establish a valid optimization proof.

## Resource bounds and remaining work

- Each journal retains at most 10,255 events (10,000 plus a pruning interval).
  Event keys are limited to 512 UTF-8 bytes; larger keys record a gap requiring
  full fallback. Epochs distinguish recreated stores. Journals store keys and
  operations, never track metadata bodies.
- A request admits at most 2,000 changed keys. Large artwork-object fanout and
  shared loudness identities also respect this bound.
- Lightweight bases retain four per account, 256 globally, for at most 24 hours;
  each proof is at most 8 KiB. Cleanup occurs on admission. They share the existing
  history database's 64 MiB physical page cap. History failures do not prevent
  serving the library. Canonical journals and current per-track hash/index rows
  live in the library database; annotation journals live in their own stores.
- The canonical current hash index grows with the library, on disk, rather than
  holding additional metadata in RAM. Normal SQLite/page-cache behavior still
  applies; these bounds do not describe total process or operating-system RAM.
- Requests still fingerprint the model twice on successful changed responses.
  They are **not O(number of changed songs)** overall. Removing these scans
  requires controlling all in-memory mutations. SQL library reloads can still
  materialize the model when another writer changed it.
- Headers and optional ID order are copied when required; very large playlists
  or order changes therefore need memory proportional to those response fields.
  Canonical saves now pay for hashing and maintaining the proof/index. This is a
  measured write/read tradeoff, not free optimization.
- Numeric/string normalization and catalog projection can make a reloaded model
  differ from an earlier saved model. A mismatch disables partial preparation
  until a later canonical save; correctness takes precedence over hit rate.

## Validation

The full Python suite passed 1,397 tests; a final focused run passed 32 tests,
including three additional rollback/concurrent-write/migration cases. The client
`npm test` gate passed type checking and 1,123 tests. Ruff and whitespace checks
passed. No frontend source or audio code changed.

HTTP tests fail if an eligible delta constructs the whole public snapshot or
loads the whole loudness table. They compare applying each delta with an
unconditional full response and compare validators, covering title/add/remove/
order/header changes, artwork dimensions/deletion, loudness deletion/shared
identities, transient add-delete, unsaved edits, raw SQL, bulk/empty fallback,
TTL/quotas, journal pruning/oversized keys/epoch changes, transactional rollback,
concurrent annotation/library commits and a fresh subprocess with no memory
cache. Migration leaves existing data usable before any new proof exists.

## Reproduction and measured results

```sh
venv/bin/python scripts/benchmark_library_journals.py --reference cd2311b --sizes 1000 10000 50000 --repeats 3 --memory
```

The script loads the previous route and canonical writer/schema from local git
for comparison. Remaining shared helpers use candidate code, including the
value-based fingerprint and annotation journal schema. This is a controlled
comparison of the old/full and new/partial paths, not execution of a complete
historical checkout. Temporary libraries/history and real annotation stores live
on the repository storage volume. Every delta is applied and compared with a
full response. Timing uses three repetitions; a separate title-edit request uses
`tracemalloc`. Initial import/request is a single observation.

The measurements exclude canonical SQL model reload, network, compression,
portable JSON export and playback. Python allocation peaks exclude the
already-loaded model and native SQLite allocations. Storage writes come from
`/proc/self/io`, not physical-device telemetry. Measurements are local synthetic
cost evidence, not real listening latency or total application RAM.

Local run on 2026-09-21: [raw measurements](journal-library-deltas-results.jsonl).
Arrows show previous → candidate; MB are decimal.

| Tracks | Title request (ms) | Additional Python peak (MB) | Title save (ms) |
| ---: | ---: | ---: | ---: |
| 1,000 | 157.28 → 100.19 | 1.679 → 0.042 | 65.77 → 78.43 |
| 10,000 | 573.69 → 172.93 | 10.041 → 0.043 | 160.51 → 244.08 |
| 50,000 | 2187.21 → 550.05 | 49.344 → 0.042 | 688.13 → 1187.41 |

At 50,000 tracks, the title response remained 930 bytes. Its additional Python
peak fell from 49.34 MB to 42,481 bytes. The save plus one changed request took
2,875.34 → 1,737.46 ms (about 40% less); the save itself was slower. This does
not include JSON export or other work surrounding a save in the application.

| Other 50,000-track request | Previous (ms) | Candidate (ms) |
| --- | ---: | ---: |
| playlist | 2773.24 | 512.36 |
| artwork | 2608.65 | 499.73 |
| loudness | 2788.9 | 574.73 |
| remove | 2682.46 | 592.4 |
| order | 2216.64 | 539.81 |

For that title save, WAL grew 28,872 → 49,472 bytes; process-charged storage
writes were 2,973,696 → 2,994,176 bytes. The initial canonical import cost
4.11 → 5.58 seconds and WAL 27.43 → 31.80 MB, including the new current hash
index and bounded journal. Initial HTTP response cost 2.29 → 1.58 seconds.

The response-history file in this fresh benchmark was 16.93 MB for the previous
four-revision row history versus 49,152 bytes for lightweight bases. That is
**not total disk usage**: canonical and annotation journals/indexes live in
separate databases. Existing legacy history is not vacuumed by this change.
Early 304 after title edits stayed near 253 → 249 ms.
