# Bounded JSON serialization for library deltas

A changed library response previously built both the detached public snapshot
and a complete Flask JSON response before choosing a small delta. That full
JSON body was used to calculate its ETag and byte length, then discarded when
the delta was smaller. For 50,000 tracks this meant constructing roughly 36 MB
of JSON, with additional intermediate string/byte allocations, to send a
925-byte edit.

For requests with `delta=1` and a nonempty, valid-length `since`, the route now
hashes the exact compact Flask representation in batches of 500 tracks and
counts its UTF-8 bytes. It constructs the full response only if the history or
size comparison requires it. No response-body cache, new disk storage, database
schema change or client protocol change is introduced.

The signature preserves account scoping, key ordering, Unicode escaping,
separators and the trailing newline. Batching uses Flask's JSON encoder rather
than an alternative representation. Custom JSON providers and pretty-print
settings use the existing full-response path. Initial downloads without a base
also use the existing path. Warm conditional requests still return early 304
responses before public copying, annotation or JSON work.

## Bounds and remaining work

Serialization scratch space is proportional to one batch of track dictionaries
or one top-level header. A single unusually large track/header can therefore
still be large. The detached public snapshot and annotations remain proportional
to the library; public fingerprinting, JSON hashing and history comparison still
visit all songs. Catalog loading and portable JSON exports are unchanged.

An expired/unknown base, unavailable history or a delta larger than the full
body causes a full fallback. The optimized path has already counted/hashed the
JSON, so these requests can pay for another encoding pass when constructing the
full body. No extra encoding pass is introduced for ordinary initial downloads,
non-delta clients, or early 304 responses.

## Validation

Tests compare the signature and byte count against the actual Flask response,
including empty collections, 499/500/501-track boundaries, multiple batches,
Unicode, escaped strings, nested fields, alternate sorting/escaping settings,
pretty output and custom providers. A real HTTP regression edits a song in a
1,001-track library and fails if the route constructs the full JSON response.
Existing tests retain exact delta application, account isolation, lost history,
locked/corrupt history, large-delta fallback and concurrent dependency changes.

## Measurements

Compare the route from `5e7994d` with the candidate committed with this report:

```sh
venv/bin/python scripts/benchmark_library_deltas.py --reference 5e7994d --sizes 1000 10000 50000 --repeats 3 --memory
venv/bin/python scripts/benchmark_library_deltas.py --sizes 1000 10000 50000 --repeats 3 --memory
```

The `--reference` option loads only the route from a local git revision; shared
helpers remain from the working tree. They are unchanged for the baseline path
in this comparison. `--fallbacks` additionally measures missing-base and bulk-edit
full responses. Timings use three uninstrumented requests; memory is measured
in a separate request with `tracemalloc`. Every delta is applied and compared
with a full response; fallback bodies are also checked for exact equality.

The synthetic benchmark exercises Flask and real disk history. It excludes
canonical database loading, real annotation lookups, compression, networking
and playback. Additional Python allocations exclude the existing library model
and native SQLite memory. These numbers do not represent total process RAM or
physical-device audio performance.

Recorded locally on 2026-09-21; [raw results](library-delta-serialization-results.jsonl).
Arrows show baseline → candidate; MB are decimal.

| Tracks | Changed delta time (ms) | Extra Python peak (MB) | Delta bytes | History file bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 151.32 → 151.68 | 2.29 → 1.58 | 925 | 348,160 |
| 10,000 | 413.38 → 445.35 | 22.74 → 9.15 | 925 | 3,264,512 |
| 50,000 | 1615.39 → 1598.25 | 113.90 → 42.79 | 925 | 16,928,768 |

At 50,000 tracks, the changed-response Python allocation peak fell about 62%.
Timing did not show a consistent improvement across sizes; this chunk targets
transient memory. Wire bytes, retained-history file sizes and revision counts
were unchanged. The 50,000-track early 304 took 157.22 → 154.94 ms, with no
change to its implementation.

A separate sequential run with `--sizes 50000 --repeats 3 --fallbacks` measured
the fallback cost (same reference and working-tree commands above):

| Request | Baseline (ms) | Candidate (ms) |
| --- | ---: | ---: |
| Unknown base, full fallback | 767.06 | 966.40 |
| Every title changed, full fallback | 2255.32 | 2515.04 |

Thus these fallbacks cost roughly 0.20–0.26 seconds more at this size. The
benefit is lower transient RAM for incremental responses, not a universal
latency improvement. The route still has further opportunities to avoid
constructing/annotating/hashing the whole public snapshot.

Validation: 73 focused tests and the full Python suite (1,368 tests) passed;
Ruff and `git diff --check` passed. No frontend files or wire contracts changed.
