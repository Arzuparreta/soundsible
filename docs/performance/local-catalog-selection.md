# Local catalog selection

This slice reduces repeated artist/album scoring and full-match sorting in
`_local_catalog`. It does not introduce a persistent search index or change the
ranking function, provider merge, per-shape budgets, or response payload.

Each request has two LRU caches (4,096 entries each): entity field scores and
folded entity keys. Titles are scored directly. Caches contain strings/numbers,
not library snapshots, and disappear after the request. Track selection uses
stable `heapq.nsmallest`, keeping only the track budget in the selection heap.
Artist/album maps still retain a representative for every matching entity;
selection of their final winners no longer sorts the whole map. The complete
library is still scanned. Simultaneous requests have separate caches.

## Reproduction

Run `venv/bin/python scripts/benchmark_local_catalog.py --repeats 3`.
The baseline is the frozen selector from `e6b1a4e` in
`tests/fixtures/local_catalog_reference.py`. Both selectors use the current
payload helpers and must return exactly equal lists. The benchmark generates
100 songs per artist and 10 per album, measures median request CPU-path wall
time, and separately uses tracemalloc for peak additional Python allocations.
Library construction is outside measurement. Each repetition starts fresh.

Example local run on 2026-09-21, 50,000 tracks:

| Query | Before ms | After ms | Before peak MiB | After peak MiB |
| --- | ---: | ---: | ---: | ---: |
| artist | 535.08 | 261.10 | 10.77 | 2.32 |
| song | 398.85 | 165.96 | 9.96 | 0.96 |
| album 17 | 450.48 | 218.72 | 0.25 | 1.00 |
| absent | 431.65 | 216.60 | <0.01 | 0.96 |

Caches trade extra memory on sparse/no-match queries for less repeated CPU
work. Entry counts are bounded, not string bytes. Entity deduplication maps
remain proportional to matching unique entities. These are synthetic selector
measurements, not end-to-end search latency, RSS, provider latency, event-loop
responsiveness, or audible playback evidence. Persistent normalization/indexing,
library revisions/deltas, and global resource admission remain separate work.

Regression coverage compares complete ordered payloads against the frozen
selector for accents, reordered words, empty and missing queries, substring
matches, metadata fallback, duplicate IDs/ties, reversed library order, cache
eviction with unique entities, and concurrent queries. Another check verifies
repeated entity scoring is reused and metadata edits are visible next request.
