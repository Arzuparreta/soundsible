# Atomic cache lookup and single-flight admission

`Memo.resolve()` previously looked up its cache and elected a computation leader
in separate critical sections. A caller could observe a miss, pause, and resume
after another caller had computed, cached its result and removed its flight.
The delayed caller then saw no flight and unnecessarily repeated the work.
This affects shared consumers such as catalog resolution, downloader search,
related lookups and podcast directory queries.

Cache lookup/expiry and flight lookup/creation now run in one critical section.
A caller that acquires coordination after publication sees the cached result;
a caller arriving before publication joins the current flight. Computation and
waiting still happen outside the lock, so independent keys can run concurrently.
The cache size, TTL policy, exception propagation and wait timeout are unchanged.
No additional entries, retained metadata, background work or disk files are
introduced. Invalidation semantics for already-running leaders are unchanged.

## Evidence

The deterministic regression pauses a request at the old miss/admission boundary
and lets a second request finish first. It uses events rather than scheduler
sleeps to force that interleaving. The previous implementation fails all four
variants (a successful string and cached falsy values `''`, `False`, `0`) by
starting a duplicate computation. The new implementation passes all four:
the delayed request reuses the published value and starts zero extra work.

Additional tests verify independent-key progress, expiration/invalidation/clear,
and the catalog consumer's account isolation and copy-on-read contract. Existing
tests cover simultaneous followers, error fan-out/retry, cache bounds, negative
TTLs and waiter timeout. The focused Memo/catalog suite passes 80 tests; the full Python suite passes
1,407 tests. Ruff and `git diff --check` also pass.

This proves elimination of a specific duplicate-work race. It does not establish
its frequency in production or a percentage CPU/RAM improvement during playback.
There is no frontend or audio-path change in this slice.
