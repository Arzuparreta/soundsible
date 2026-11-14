# Engineering and resource consumption review

Date: 2026-09-20. Code reviewed: `a77181f`, local `main`, tree initially
clean. No code from open PRs was used. This review has not been checked
against possible later commits on GitHub. This document and its reproducer are
the deliverable: the proposed optimizations are not yet implemented.

The main opportunity is in **doing less work per operation and correctly closing
the lifecycle of resources**. There are reproducible failures and
avoidable costs; there is no evidence to promise a specific overall reduction in CPU or
memory. Reformatting files or changing framework would not resolve the
causes found.

## Evidence and scope

The review covered library reads/writes, SQLite, search, discovery,
background jobs, prefetch, caches, artwork, diagnostics, web startup, audio
transport and state organization. The review of desktop, iOS, Live, providers
and packaging is partial: it is not equivalent to an exhaustive audit of each platform.

| Check | Result | What it shows and what it does not |
| --- | --- | --- |
| Existing server, passive 30 s sample | Mean CPU per sample 0.033% of one core; stable PSS 354.63 MiB; no physical reads/writes counted | Describes that interval with no visible local client; it is not a controlled idle or playback test |
| `/api/health` on the existing server | Pool: 14 created, 0 idle, maximum 16 | Signal to investigate; a single snapshot does not by itself prove a leak or its origin |
| Temporary SQLite, 16 sequential workers without scope | Pool reaches 16/16 with none idle; one worker gets `TimeoutError` | Reproducible return defect; does not depend on the real library |
| Pool factory fails twice, capacity 2 | `created=2`, `idle=0`, although no connection was created | Reproducible capacity loss on an open error |
| Synthetic serialization, median of 3 repetitions | See next table | Conversion cost; excludes SQL, annotations, HTTP and browser |
| Synthetic 90 s DJ analysis, same HEAD in both processes | 27–36 ms wall time; peak RSS 64–65 MiB; equivalent results | One run per process, feature extraction only; it is not a before/after improvement and does not include decoding |
| Existing validation | 44 targeted Python tests; 1,073 frontend tests in 113 files; typecheck and Ruff correct | The baseline passes these checks despite the reproduced defects; it does not certify physical devices |

The server process was already running: its loaded revision was not verified,
so its metrics must not automatically be attributed to the HEAD of the checkout.
Other applications were running, including a game. System I/O pressure was
high during the sample, but there was no physical I/O attributed to the server process tree:
that pressure must not be attributed to Soundsible.

| Synthetic tracks | Current conversion, median | Compact uncompressed JSON |
| --- | ---: | ---: |
| 1,000 | 15.60 ms | 712,821 bytes |
| 10,000 | 164.55 ms | 7,156,821 bytes |
| 50,000 | 856.18 ms | 35,916,821 bytes |

The measurement reproduces `to_json → json.loads → json.dumps`, with simple tracks.
It is not endpoint latency or transferred size with compression. The attached
script allows repeating it; its times will vary with the machine and the load.

## Priority findings

### 1. Incomplete return of connections outside requests — high priority

**Confirmed by reproduction.** In [database.py](../../../shared/database.py),
`_get_connection()` takes a connection and `_release_at_request_end()` registers its
return. [request_scope.py](../../../shared/request_scope.py) registers nothing if
there is no scope. Ending the worker does not return the slot to the pool. In addition,
`ConnectionPool.acquire()` increments `_created` before calling the factory and
does not correct it when the factory fails.

There is an explicit scope in the orchestrator's deferred commit, but not in its
general `_wrap_task()`. There are also independent pools and per-search pools.
With gevent patched, "thread" must not automatically be interpreted as a
persistent native thread. The entry points must be inventoried, including
workers, timers, sockets and commands, and reproduced with the real import order.

**Change:** explicit ownership of the connection per unit of work; return
in `finally`, including exceptions and cancellation; rollback of the counter if the
factory fails. Review nested scopes and resources released before streaming.
Increasing the pool maximum is not enough.

**Acceptance:** hundreds of short-lived jobs do not consume cumulative slots;
an open error does not reduce capacity; simultaneous requests and jobs
do not share a borrowed connection; streaming does not hold unnecessary connections.
Medium risk due to concurrency and transactions. First recommended intervention.

### 2. Full library refresh and redundant conversions — high priority

**Confirmed in code and partially measured.**
[get_library](../../../shared/api/routes/library.py) converts the model to indented
JSON, parses it again, adds annotations and serializes it again.
[models.py](../../../shared/models.py) uses `asdict` for each track.
[stores/library.ts](../../../ui_web/src/stores/library.ts) replaces the whole library
and requests the catalog again; the 1.5 s debounce groups bursts, but does not prevent
full refreshes during a long download with spaced-out completions.

**Change in two steps:** first a structured public payload that omits
exactly the same local fields and keeps the contract, without an intermediate JSON
round trip. Then revisions/ETag and deltas for tracks, removals and playlists, with
fallback to a full snapshot after revision gaps or reconnection. The revisions
of artwork, loudness and saved items must also invalidate their data: using only the
library revision would produce stale information.

**Acceptance:** payload equivalence, account isolation and edits;
downloading an album does not retransmit N libraries; measure bytes, CPU, temporary memory
and index rebuilding. First step low risk; deltas medium risk.

### 3. Small mutations with a full snapshot write — high priority

**Confirmed in code.** `LibraryManager._save_metadata()` calls
`DatabaseManager.replace_library()` and exports JSON. That path deletes the
absent tracks, upserts all incoming ones and rebuilds projections; the cost
grows with the library even when the
initial operation is small. Not all mutations use this path: each
caller must be measured, rather than claiming that every write is a full one.

**Change:** specific transactional operations for metadata, additions/removals and
playlists; keep optimistic revision, aliases, date added, user
state and catalog invariants. Batched portable export with an
explicit durability policy. Reserve full replacement for import,
repair or migration.

**Acceptance:** affected rows and WAL bytes per edit stop growing with all
the tracks; tests of concurrent writes, rekey and recovery after a crash.
High risk: decompose after stabilizing the pool and measuring the paths.

### 4. Local search scans and sorts before limiting — high priority at scale

**Confirmed in code; latency still to be measured.** `_local_catalog()` in
[catalog.py](../../../shared/api/routes/catalog.py) scores title, artist and album of
all tracks and sorts the matches before applying the output
budget. Limiting the response does not limit the work. The provider pool is created
per search; different simultaneous queries multiply the work.

**Change:** precompute normalization per revision; top-k selection where it keeps
tie-breaks; evaluate indexed candidate generation and apply the current ranker
afterwards. FTS alone does not guarantee the current semantics of substring, accents and
artist/album: it needs a comparison of results, not just a quick benchmark.

**Acceptance:** a corpus of real queries and ambiguous cases keeps results and
order; compare 1k/10k/50k tracks, cold/warm and concurrent queries; measure
p95 and event loop delay while audio is playing. Medium risk.

### 5. Fragmented concurrency budgets — high priority under load

**Structurally confirmed; saturation not measured.** There are separate pools for
orchestration, search, resolution, graph, discovery, DJ, lyrics and migration.
`max_workers` limits execution, but does not guarantee a bounded queue. `request_analysis`
deduplicates by identity without a global limit on pending identities. Lyrics already
offers an example of admission with a semaphore.

**Change:** admission budgets per resource (CPU, disk, provider), priority
for immediate playback and next tracks, deduplication and dropping only
obsolete speculative work. Do not merge everything into a single queue: the graph
is separate precisely so that it does not end up behind slow resolution. Keep
reserved quotas and a wait/retry policy for requested work.

**Acceptance:** audio and remote control keep responding during downloads,
scanning and cold DJ; measure depth, age and cancellations of each queue, API p95
and hub lag. Check which work actually leaves the gevent hub.
Medium-high risk; do not cut analysis or discovery to make it cheaper.

### 6. Prefetch state without a retention budget — medium priority

**Confirmed in code.** [prefetch.ts](../../../ui_web/src/lib/prefetch.ts) keeps
`lastWarm`, `lastDownloadAttempt` and `preparation` per ID without eviction. The TTL decides
when to retry, it does not remove entries. The observation queries the first eight
IDs; tasks that do not reach a terminal state can delay later ones.

**Change:** bounded retention of terminal results, ownership/cancellation of
subscriptions, fair observation and revalidation of the `ready` state if the server
restarts or deletes the file. Do not evict active work or break the guarantee
that the next track is prepared.

**Acceptance:** thousands of IDs and prolonged navigation stabilize heap, listeners
and requests; disconnection/reconnection and partial failures keep recovery.
The growth exists; its relative weight in memory is not yet measured.

### 7. Diagnostics do work proportional to the backlog — medium priority

**Confirmed in code; impact during listening still to be measured.** Automatic capture
uses a bounded ring, persists and flushes periodically.
[PlaybackTraceOutbox.pending](../../../ui_web/src/lib/playbackTraceOutbox.ts) uses
`getAll`, filters by account, sorts and serializes the whole set to calculate size
before trimming it. The limit is applied when reading; there is no equivalent admission
control in the persistent `put`. The flush calls `pending()` before checking
the network backoff. The persistence promise can also accumulate work if
storage is slow.

**Change:** cursors/indexes by account and date, size counted on write,
incremental pruning and reading only the needed batch. Separate bounded maintenance from
sending. Keep ACK, deduplication, isolation and the ability to diagnose
iOS interruptions; disabling traces would lose a valuable capability.

**Acceptance:** 24 h of simulated offline, several accounts and a slow disk do not require
loading the whole outbox per cycle; verifiable limits and reported gaps.

### 8. Artwork: global read and variants without a total quota — medium priority

**Confirmed in code.** `ArtworkStore.annotate()` reads all references of
the instance even when only a few tracks are requested. `variant()` bounds sizes and
concurrency, but there is no total disk quota/eviction of variants in that module.
"Finite number of sizes per image" does not limit the number of images.

**Change:** query by IDs in batches, quota/LRU of rebuildable derivatives,
separate metrics for originals and variants. Originals and references
are persistent data: do not treat them as a disposable cache.

**Acceptance:** annotating 20 tracks does not materialize all references; regenerating
a deleted variant keeps the appearance and the revisions. Low-medium risk.

## Architecture, code and maintenance

The central state has 5,128 lines, audio 2,079, `shared.api` 2,099 and the
database layer 3,008. Length does not prove slowness. It does concentrate transitions,
effects and cross-cutting knowledge, which makes it hard to change policies without breaking
playback or recovery.

The useful separation would be by ownership and lifecycle: session/queue, DJ
coordinator, transport, remote sync and persistence; library,
search and job services injected into the routes. Each piece must have explicit inputs,
outputs, cancellation and owner. Avoid moving functions to other
files while keeping the same global state and calling it an architectural improvement.

Additional concrete points:

- `syncLibrary()` and `syncCatalog()` return immediately when they find an
  operation in flight, although their callers may interpret the `await` as
  finished synchronization. Share a promise with an explicit freshness and
  generation contract; test account change and simultaneous calls.
- `Memo.resolve()` checks the cache before acquiring the flights lock. A
  caller that saw a miss can be delayed until another one completes and removes
  its flight, and then start another computation. Revalidate under coordination;
  add a deterministic test for that window. Inspection finding, not
  reproduced in this pass.
- `ensure_ui_dist()` walks sources and stats when serving the shell and rebuilds
  under a lock if needed. It is a startup/reload cost, not an audio loop cost.
  Measure first; if it matters, observed invalidation/fingerprint that keeps the
  automatic update, including public sources and deleted files.
- The `except: pass` or equivalents in background work need classification:
  expected fallback, cancellation or operational error with a counter. Do not replace them
  all with noisy logs and do not hide analysis failures indefinitely.
- Ruff passes; a mass of removable dead code has not been demonstrated. F401/F841
  do not detect all unreachable code, and the configured `max-complexity` does not by
  itself enable C901 with the current selection. A later cleanup must rely
  on Python/TS references, routes, dynamic imports, builds and consumers.
- The size of the existing `ui_web/dist` is 2.2 MiB with 103 files in assets.
  It is not the initial transferred JS or proof of a current bundle. Measure the waterfall
  and the chunks actually loaded before blaming dependencies or fonts.

Keep the improvements already present: virtualization and variable rows, lazy routes,
memoized identity selectors, event batching, preview caches,
single-flight, DJ analysis limits and visibility protections. The
`ProgramOutput` carrier was removed on 2026-11-06 after measuring its acoustic output in
Chromium (see `docs/internal/PLAYBACK_DIAGNOSIS.md`); all output goes to the
context destination.

## Work sequence and decision criteria

| Delivery | Content | Required evidence |
| --- | --- | --- |
| A | Pool lifecycle and factory failure | Reproducers turned into regressions; HTTP, sockets, workers and gevent |
| B | Direct payload, artwork annotation by IDs | Contract equivalence; CPU/bytes/memory at scale |
| C | Prefetch retention and incremental outbox | Long/offline sessions; heap and pending work stabilized |
| D | Revision/deltas and search indexes | Less traffic and CPU without changes in results, identity or order |
| E | Incremental writes and work budgets | Lower WAL/I/O; stable audio/control latency under load |
| Cross-cutting | Extract module boundaries when touching each domain | Same contracts; fewer shared dependencies and effects |

There is no reason for a global rewrite with the available evidence. Each
delivery must be reviewable and revertible separately, with a PR and its impact
label; functional fixes will normally be `impact:patch`.

A **controlled client baseline** is missing to answer how much consumption
can really be saved during listening. Acceptance protocol:

1. Fix the server and bundle revision, browser, hardware, library, song,
   network, volume and viewport. Measure the server and the client process tree separately.
2. Three repetitions after warm-up: client closed, open and paused,
   NORMAL local, NORMAL preview cold/warm, DJ cold/warm, Live. Repeat
   visible and hidden; separate startup from steady state.
3. Record integrated CPU, PSS/heap, long tasks, hub lag, p50/p95 latency,
   network and disk bytes, queue sizes and number of connections. GPU/energy of the
   machine must not be presented as consumption exclusive to the browser.
4. Add concurrent search/download and a run of several hours to check growth.
   For audio changes: skips, seek, pause/resume, end of track, mixes,
   reconnection, lock and Safari PWA with wired CarPlay on a real device.
5. Require functional equivalence and a repeatable reduction of the target metric.
   Define numeric budgets after the baseline; do not invent a savings
   percentage and do not accept a CPU improvement that worsens time to audio.

## Reproduction

From the repository root:

```sh
venv/bin/python docs/internal/audits/reproduce_resource_review.py
venv/bin/python scripts/benchmark_dj_analysis.py --reference HEAD --seconds 90 --repeats 1 --output /tmp/soundsible-audit-dj.json
venv/bin/python -m pytest -q tests/test_connection_pool.py tests/test_request_db_budget.py tests/test_api_memo.py tests/test_dj_spectral_memory.py tests/test_discovery_feed_budget.py tests/test_artwork.py
venv/bin/ruff check .
```

Frontend: `npm test` from `ui_web`. Passive sampling:
`python scripts/resource_sample.py --group server=PID --seconds 30 --output /tmp/resources.json`,
replacing PID with the current process. The synthetic reproducer only creates a
temporary database and shortens its exhaustion timeout; it does not modify user data.

The previous performance review guided the client/server separation, but
its historical percentages have not been reused as current results.
