# Artwork variant disk quota

Generated JPEG sizes/crops now share a 512 MiB quota per artwork cache directory.
`SOUNDSIBLE_ARTWORK_CACHE_MB` overrides it with a nonnegative integer in MiB,
read when the store is constructed. Restart the engine after changing it.
`0` disables retention; negative/invalid values log a warning and use 512 MiB.
Original images, references and their public revision tokens are never evicted.

## Admission and lifetime

A separate `variants.sqlite3` records filenames, sizes and recent use; its
indexed ordering and byte counter avoid directory scans on normal hits. Reads
update usage at most once per minute per variant, without touching JPEG mtime.
There is no resident collection of cached images or indexed filenames in Python.
Main and reconciliation temporary SQLite page caches have 512 KiB targets.

If admitting an image would exceed the quota, oldest usage records are evicted
in indexed pages of 100 until old bytes plus the new image fit within 90% of the
quota. An image larger than that target but within the quota may occupy the
cache alone. An image larger than the quota is served without retention.

Directory reconciliation runs on first variant access for each store instance,
after restart, or when an interrupted operation left the persistent dirty flag.
It uses `scandir` and a disk-backed temporary SQLite membership table, retaining
known usage timestamps and importing legacy files with mtime as initial usage.
Missing files leave the index; recognized orphan variants enter it. Known
publication staging leftovers are removed under the same coordination lock.
Missing/corrupt indexes are rebuilt; arbitrary files and symlinks are not cleaned.
Overlapping cache/original directories disable retention and cleanup.

A directory lock (`flock` on Unix, one-byte `msvcrt.locking` on Windows) coordinates
admission/open/unlink across processes; a thread lock handles local callers.
Image decoding occurs outside this quota lock. Existing 64 image lock stripes
and two generation slots per ArtworkStore instance remain. Processes may still
encode the same cold image concurrently, but admission rechecks the winner and
never charges or publishes the variant twice.

HTTP obtains an already-open descriptor while coordination is held, then sends
from it after releasing all locks. It explicitly supplies JPEG MIME, length,
last-modified time and a filename-derived ETag; ranges, HEAD, conditional 304,
revision redirects and cache policy remain. The new ETag may cause one fresh
200 response for an older browser validator, then remains stable on regeneration.
Descriptors close on normal completion, 304/HEAD, exceptions and cancellation.

On Unix an unlinked file remains readable through an open descriptor. On Windows
an unlink denied because of an open reader is skipped. If no sufficient space
can be reclaimed, the requested image is delivered from a temporary disk file
that closes with the response. Failure to coordinate/index also uses temporary
delivery; if temporary generation fails, the route keeps its existing image
fallback. No fallback writes unaccounted permanent variants.

## What the quota counts

The limit counts retained generated JPEG bytes, not originals, index files,
SQLite journals, lock files, temporary encoding/publication files or deleted
files still held open by clients. Those can temporarily require extra disk.
All generated response files use the configured cache directory, including when
retention is disabled; a cache on tmpfs is still RAM-backed storage. Pillow must
still decode images in memory; this is not a zero-memory image pipeline.

Startup reconciliation and eviction can delay the first image request. Existing
undeletable files can keep a legacy cache over quota until the operating system
allows deletion; subsequent accesses retry cleanup and new admissions cannot
increase that overage. There is no background cleaner, whole-directory scan on
each hit, or vacuum inside HTTP requests. SQLite reuses freed index pages.

## Validation

The full Python suite passed 1,429 tests. Final focused quota tests passed 25,
including three additional index-failure/interrupted-publication/path-safety
cases. `npm test` passed type checking and 1,123 client tests. Ruff and
`git diff --check` passed.

Coverage includes LRU/size limits, zero/oversized admission, invalid configuration,
original preservation and unchanged public revisions, missing/corrupt indexes,
legacy adoption, crash reconciliation, missing files, symlinks/unknown paths,
no hot-path scan or regeneration, amortized usage writes, threaded and three-
process admission, active-reader eviction, temporary fallback and descriptor
closure. HTTP tests cover JPEG bytes/length, ETag/304, HEAD, byte ranges, invalid
ranges and client cancellation, with retained and temporary variants.

Tests ran on Linux. Windows open-file deletion denial is simulated, but native
Windows locking/HTTP behavior has **not been validated** in this environment.

## Measurement

```sh
venv/bin/python scripts/benchmark_artwork_variants.py --counts 1000 10000
```

The script uses an on-storage temporary directory beside the repository, real
JPEG fixtures and real decoding for a new 640px variant. A deliberately small
quota forces adoption/eviction of about half the legacy variants. Warm times
are medians of 30 uninstrumented accesses; memory is measured separately with
tracemalloc. Reconciliation time includes tracemalloc overhead. Fixtures are
excluded from Python peaks, as are native SQLite/Pillow allocations. These are
local cache costs, not full HTTP latency, total RSS or audio-performance claims.

Recorded locally after the test suites completed; [raw results](artwork-variant-quota-results.jsonl).
Byte values are exact; timing is milliseconds.

| Legacy variants | JPEG limit | Retained JPEGs | Index bytes | Warm median ms | Extra warm Python bytes | Instrumented reconciliation ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 25,556,511 | 23,266,522 | 364,544 | 0.181 | 267,381 | 590.158 |
| 10,000 | 255,071,004 | 229,829,498 | 3,514,368 | 0.181 | 267,381 | 5085.273 |

Reconciliation peak Python allocations were about 1.31 MB / 1.28 MB, respectively.
Generating the new 640px variant took 218 / 260 ms, including disk admission.
These figures do not compare against the previous unbounded-cache implementation.
They demonstrate quota enforcement, bounded scratch allocation and hot-path cost;
they are not a claim that adding quota bookkeeping makes cache hits faster.
