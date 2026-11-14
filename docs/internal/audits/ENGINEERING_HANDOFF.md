# Soundsible resource optimization handoff

Entry point for continuing with another agent without the chat history.
The current continuation is the [measured delivery of 2026-11-05](#measured-continuation-2026-11-05).
The original branch/no-push/no-PR restrictions below are historical;
the user authorized this delivery in a single PR against `main`.
State verified when this document was prepared: branch `fix/sqlite-connection-lifecycle`,
last functional chunk `32929f7`. This handoff is added in a later commit.

## Instructions of the original delivery

- Work on **this same branch, chunk by chunk**. Do not open a PR against `main`
  until all the audit work is finished and the user says so.
- Each complete implementation ends with a focused commit. Do not push
  unless explicitly requested: the user has been doing the pushes.
- Prioritize lower resource use without removing features. Avoid keeping data
  in RAM when it does not need immediate access; prefer SQLite/disk and bounded
  buffers. Do not add persistent in-memory copies of the library.
- Plan and complete each chunk end to end: reproduction, change,
  relevant tests, measurement when applicable, documentation and commit.
- Follow `AGENTS.md`: no commits to main, no manual version edits and
  **do not run `npm run build`**. The client gate is `cd ui_web && npm test`.
- Do not delegate to subagents without explicit authorization. None have been used in these chunks.
- Communicate in Spanish. Do not require the user to repeat the context available here.

## Original audit and meaning of its results

- [Original report](2026-09-20-engineering.md).
- [Original reproducer](reproduce_resource_review.py).
- Provenance: commit `0baebe3ef8048ae4d9764a8d55b1ef2897407755`, original branch
  `audit/engineering-resource-review`. Both files were recovered verbatim
  with `git show`; **they were not in the tree of the implementation branch**.

The report is historical evidence, not a current description of all failures.
Do not run its reproducer expecting it to reproduce problems that are already fixed.
Its suggestion of one PR per delivery is replaced by the user's instruction:
one working branch, no PR yet. The report does not prove savings during listening.

## Chunks already completed

The hashes identify real changes on this branch, not proposals:

| Commit | Delivery |
| --- | --- |
| `807926a` | Return SQLite connections when each block finishes; resolve pool exhaustion and the factory failure. |
| `773470a` | Build the public payload directly; artwork queries by IDs. |
| `8c2423f` | Bound retention and control the prefetch lifecycle. |
| `e6b1a4e` | Bound storage, persistence and sending of the trace outbox. |
| `a8241fb` | Reuse entity scores and top-k selection in the local catalog; it still walks all songs. |
| `93902d4` | Per-account revisions/ETags and revalidation without rebuilding the client. |
| `bcf4fbf` | Early 304 from public dependencies without materializing the response. |
| `2ad6db3` | Deltas with on-disk hash history, quotas and incremental application in the client. |
| `5e7994d` | Incremental canonical writes and bounded SQLite staging; keep revisions, aliases, dates and user state. |
| `cd2311b` | Compute hash/size of the full JSON in blocks when only a delta is sent. |
| `563d0c6` | Bounded transactional journals and exclusive preparation of affected rows; covers artwork and volume. |
| `e2efc64` | Fix the `Memo.resolve` race: check the cache and choose the flight inside the same lock. |
| `c544318` | Artwork variant quota, on-disk index and open descriptors for active responses. |
| `bc90a83` | Local search candidates from a fingerprint-verified SQLite index; same ranker, results and order; full scan if it cannot be proven. |
| `32929f7` | `library.json` export serialized once in blocks and copied to the other destinations; same bytes, permissions and durability. |

Documentation and reproducible results:

- [Local selection](../performance/local-catalog-selection.md),
  [revisions](../performance/library-revisions.md),
  [initial deltas](../performance/library-deltas.md).
- [Incremental writes](../performance/incremental-library-writes.md),
  [bounded serialization](../performance/library-delta-serialization.md),
  [journal deltas](../performance/journal-library-deltas.md).
- [Memo coordination](../performance/memo-coordination.md),
  [artwork quota](../performance/artwork-variant-quota.md),
  [local search index](../performance/local-search-index.md),
  [block export](../performance/library-export-streaming.md).
- The measurement JSONL files are next to their documents in `docs/internal/performance/`.
  The corresponding scripts live in `scripts/benchmark_*.py`.

Do not mix numbers between benchmarks: some exclude annotation/SQL and others use
real stores; some compare old functions loaded from git with current
helpers. The documents explain what was included. No figure is equivalent to total
RSS, energy savings, playback quality or acoustic acceptance.

## Technical state that must be preserved

### Library and deltas

- `replace_library()` keeps logical replacement semantics and an atomic
  transaction. A successful call increments the revision even without changes. It only
  writes rows that differ; `expected_revision` is validated inside the transaction.
- Journals and source hashes live in SQLite, not in resident metadata maps.
  `shared/library_changes.py`, `shared/sqlite_changes.py` and
  `shared/api/library_incremental.py` implement source proofs and selection.
- Models are still mutable before they are saved. Partial requests
  **still walk the library to check fingerprints**. Do not replace
  those checks with blind trust in the SQLite revision.
- ETags of verified canonical sources are opaque dependency tokens,
  not hashes of the entire JSON. The old path remains for unverified sources.
- Do not break account isolation, changes during copy/annotation, field
  removal, order, rekeys/aliases, user state or the first `added_at` date.
- Journals have limits and epochs; if equivalence cannot be proven,
  the full response is sent. Do not hide that fallback as a functional failure.
- Known cost: maintaining proofs/journals makes some saves more expensive.
  With 50k songs, a benchmark gave save+title request 2.88 → 1.74 s,
  although the isolated save got worse. Do not claim that every operation is faster.
- "Initial import" means inserting a library into an empty database; **not**
  every engine startup, client open or library query.

### Artwork

- `SOUNDSIBLE_ARTWORK_CACHE_MB=512` by default, selected by the user;
  `0` disables retention. Configuration documented in `docs/CONFIGURATION.md`.
- Only generated JPEG variants count toward the quota; never originals or refs.
  `variants.sqlite3` index in the cache, separate from the durable artwork index.
- `shared/artwork_variants.py`: byte counter, approximate LRU with usage update
  at most once per minute, paginated cleanup, reconciliation at startup or
  after interruptions, file locks between processes. No scan per hit.
- `ArtworkStore.open_variant()` returns an open descriptor and metadata. HTTP
  must use it: a path returned by `variant()` can be evicted before it is opened.
- The quota counts retained JPEGs. The index, temporary files and deleted files still open
  can consume additional space. Files that Windows does not allow to be deleted are skipped;
  without admissible space, serve temporarily. The initial cleanup can delay
  the first image of a large old cache.
- Windows: mechanism implemented and denied deletion simulated, **not native
  Windows validation**. Do not present it as verified on Windows.

### Local search

- `shared/library_search.py`: `library_search` table (per account, in `library.db`)
  with position and title/artist/album already folded the way the ranker compares them, and
  `library_search_state` (valid, `VERSION`, fingerprint and the `syncing` flag of `sync`).
- `_local_catalog()` uses the index **only** if, in a single read
  snapshot, the state is valid, `VERSION` matches and the fingerprint of
  `(title, artist, album_artist, album)` of the in-memory model equals the
  stored one. Otherwise (unsaved edits, invalid index, missing table, SQL
  error, query that cannot be bound) it walks the full model as before. Do not remove
  that check or replace it with the SQLite revision.
- The fingerprint costs ~22 ms per query at 50k: it is the floor of this design. It
  deliberately does not include IDs; the ranker takes IDs and payload from the model itself.
- The SQL filter is a **superset** of what it scores (tokens as substrings);
  `loose` rows are always candidates. `_text_score`/`_score_folded` and the index
  share `search_title`/`search_text`. A test pins the normalization code,
  `_score_folded` and the filter to `INDEX_FORMAT`: if it changes, review
  the superset test and bump the format if the stored values change.
- Maintenance only from committed SQLite rows, inside `replace_library`
  and the schema, in a savepoint: a failure leaves the index invalid and **never**
  makes a save fail. Triggers in the DB invalidate, delete obsolete rows or
  force a rebuild (external writes of folded values). Saves that do not
  touch search fields or order pay nothing.
- Cost measured at 50k: save with title edit +194 ms (+18 %), removal in the middle
  +456 ms (+18 %), addition +156 ms (+6 %); index 4.4 MB; one-time build 1.3 s on
  the first startup after updating (under the global schema lock). Rare queries
  250–265 → 29–41 ms; dense 2-letter queries 197 → 143 ms. See the document.
- Dense queries still score every match in Python; going lower
  would require scoring in SQL, which would duplicate the ranker. This has not been done.

### Portable export: last chunk

- Each canonical save rewrites `library.json` per user, in
  `<music>/library.json` if the instance is not multi-user and in the
  provider mirror. Before, the entire document was built **twice** (export and
  `provider.save_library`); now `LibraryMetadata.iter_json()` generates it in
  blocks of 128 tracks once and the rest are byte-for-byte copies
  (`shared/atomic_file.py`). `to_json()` does not change; a test requires exact
  byte equality.
- Preserved: temporary + fsync + rename in its own copies, non-writable
  destinations warned once, publication order. The local provider mirror
  was rewritten **in place** (same inode, permissions, symlinks; no fsync)
  because `mkstemp` would have left it at 0600 and broken links. Later it was replaced
  by an atomic replacement that preserves symlink and permissions: see "Post-review
  fixes". Remote providers upload the same text.
- A lock per `LibraryManager` prevents two exports from overlapping (Windows does not
  allow replacing a file that another export is reading). There is no
  native Windows validation.
- One INFO line per export (bytes, copies, ms) to decide with data whether
  batching them is worth it.
- Measured: 50k tracks 2.47 → 1.92 s and peak 168.5 → 1.07 MiB; the user's real library
  (208 tracks, 719 KB, 60 % podcast cache) 107 → 100 ms, 2.2 →
  1.3 MiB. Bytes written are the same. At that scale the two fsyncs dominate.
- **Batching exports was not done**: it was recommended not to do it after measuring and the
  user approved the plan with that recommendation. Reasons: little
  savings at their scale, ODST reads and rewrites `<music>/library.json` (it would lengthen the
  window of old podcast data) and the existing debounce does not flush anything on
  shutdown. Revisit only with the INFO lines of a large real instance.
- Findings left untouched: three copies of the same file on the same disk; ODST
  keeps its own complete `LibraryMetadata` in RAM and serializes it entirely after
  each download. Its write is already atomic: see "Post-review fixes".

## Later evaluation: DJ analysis priority (2026-09-22)

The measurement gate for the next candidate was implemented, **not a new
scheduler**. See [decision and reproduction](../performance/dj-queue-priority-gate.md),
`scripts/benchmark_dj_queue.py` and the Chromium characterization
`ui_web/tests/browser/dj-refinement-audit.spec.ts`.

- Current path of explicit collections, gevent and real analysis/FFmpeg/SQLite;
  synthetic candidates and audio, temporary runtime. Five repetitions per case,
  with instrumentation enabled/disabled, without touching the user's engine.
- Nine, 18 and 36 analyses finish with medians of 0.45 / 0.85 / 1.55 s. When
  warm, no new analyses are requested. This is evidence for that corpus and machine,
  not listening latency or demonstrated resource savings.
- The query at 50 ms arrives without analysis in the three cold cases (5/5);
  at two seconds it arrives with analysis (5/5). All jobs finish.
- **Prioritizing from `dj-transition` does not pass functional acceptance:** the
  endpoint returns a fallback when it finds a miss and the client only refines once
  per pair. Finishing earlier after that response does not make the
  result get consumed. Chromium confirmed the ready-before/after cases in
  ten tests. The test characterizes this behavior; it does not require
  keeping it if another refinement contract is defined.
- Queues, workers, discarding, analysis, transport and store were not changed.
  Reopening this candidate first requires defining how to consume a late
  result before the commit. Do not introduce indiscriminate retries.
- Validation of this delivery: 70 isolated benchmark runs, 10 Chromium
  tests, 1,509 Python tests, typecheck and 1,123 client tests; Ruff and
  `git diff --check` pass.
- The long load matrix, instrumentation of other pools, real library,
  downloads/scanning and full client/server measurement **are still pending**.
  That extension was stopped when the functional gate of the candidate change failed.

## Catalog coordination completed (2026-09-22)

`syncCatalog(targetRevision?)` shares one promise per operation/generation,
groups pending revisions and discards superseded results. The library
acknowledges success by generation and revision, not by refresh number. A → B → A
also invalidates query B even if A was already acknowledged. The three
requests finish before a new round, even with a partial error.

- Same revision: 9 → 3 queries in the controlled scenario; A → B → C: 9 → 6.
- A new account starts without waiting for old responses; its results and cleanup
  do not affect the current account. Old requests are not aborted.
- Errors keep the catalog and allow a retry on the next refresh; without
  revisions the conservative refresh is kept. There is no periodic retry.
- Invalidating keeps an already available catalog: it is also used when editing playlists
  without an immediate query. Account cleanup remains in its callers.
- [Contract, measurements and reproduction](../performance/catalog-sync.md), with
  JSONL results. Virtual times/simulated API: they are not CPU or network savings
  measured on a real instance.
- Typecheck and 1,138 frontend tests / 116 files; seven Chromium tests;
  `git diff --check`. No Python changes or physical audio validation.

## Block-based ODST save completed (2026-09-22)

`ODSTDownloader.save_library()` uses `iter_json()` and writes blocks of 128 tracks.
It preserves bytes, lock, podcasts from disk, permissions/inode/symlinks and propagation of
failures. It wrote in place, without fsync or atomicity (fixed later: see
"Post-review fixes"); the coordination between processes
with Station was not modified.

- [Measurements and reproduction](../performance/odst-save-streaming.md): five
  repetitions, real copy of 208 tracks and corpus of 1k/10k/50k.
- Full temporary peak at 50k: 245.14 → 229.11 MiB; at 208: 2.88 → 2.71 MiB.
  Reading and rebuilding the full model still dominates memory.
- Do not claim a general speedup: 50k 1.77 → 1.75 s, but 10k 280 → 320 ms;
  real copy 9.44 → 9.85 ms. Bytes written are the same. This is not RSS or listening.
- Validation: 1,521 Python tests, Ruff on modified files and
  `git diff --check` pass. No frontend changes or engine restart.
- The resident library and the full read for podcasts were not removed;
  there is no new debounce. The partial file after a failure was fixed later
  with the atomic write.

## ODST podcast read without rebuilding tracks completed (2026-09-22)

`read_podcast_fields()` replaces the full read/model during the save:
it reads in blocks with the standard decoder, validates and discards each track and
keeps the two podcast fields. It still walks all the bytes.

- [Measurements, limits and reproduction](../performance/odst-podcast-read.md), with
  baseline `f5a5a8a`, five alternating repetitions and identical final bytes.
- At 50k tracks: Python temporary peak 229.107 → 1.067 MiB; median of the full
  save 1,755 → 1,156 ms. This is not RSS or listening evidence.
- Real copy of 208 tracks: 9.32 → 10.88 ms; 2.715 → 2.139 MiB. That small
  cost is accepted for the scalability improvement; do not claim a universal speedup.
- Differential compatibility: fields/types, duplicate keys, Unicode, block
  boundaries and corruption. Malformed JSON empties podcasts as before; model/I/O
  errors keep the in-memory ones. That distinction was fixed in the previous
  report and its test, which did not explicitly check the expected value.
- A descriptor keeps its read across a POSIX replacement. There is no common
  ODST/Station lock or protection against races between the two writers; the
  partial write was fixed later (see the next section).
- Current validation: **1,532 Python tests**, Ruff and `git diff --check` pass;
  benchmark smoke with the additional hash of the correct reader. No
  frontend changes, engine restart, real library write, push or PR.
- Reader memory is bound to the largest individual value and the podcasts; malformed
  JSON can accumulate until EOF. Serialization keeps its list of
  references. Do not claim strictly constant memory.

## Post-review fixes (2026-09-22)

A `/code-review` of `main...HEAD` left ten unverified findings. The ones
that could lose data or block the interface and the catalog projection
were fixed; the other six were analyzed and discarded (see the end of this
section).

- `c9a40e8` Interface: local edits (metadata, deletion, playlists)
  used the account-change reset, which cleared the refresh scheduled
  after a download and abandoned the in-progress sync without a replacement (`loading`
  could stay active). Now `beginLibraryEdit`/`endLibraryEdit`: old responses
  are still discarded without waiting for them, but the abandoned sync
  stays owed and is paid when the edit finishes, the timer survives and a
  response applied while the edit was in flight triggers another read.
  `invalidateLibrarySync` remains only for account changes and today has no
  production caller.
- ODST: `save_library()` writes to a temporary file with fsync and rename through
  `shared.atomic_file.replace_contents`, which follows symlinks, preserves permissions,
  uses the default umask for new files and, if the folder does not allow
  temporary files, writes in place as before. Inode and owner change (nothing in
  Soundsible creates hard links). A failure keeps the previous document.
  Cost: the fsync, ~50–75 ms per save (once per download) on a spinning
  disk; memory peaks are the same.
  [Measurement](../performance/odst-save-streaming.md#atomic-replacement).
- Local mirror: `save_library_file` opened the destination with `wb` before reading the
  source. With LOCAL storage pointing to the music folder (bucket
  `.`) and the manifest not writable, mirror and source are `<music>/library.json`
  and it was left empty (reproduced in a test). Now it skips the copy if
  `os.path.samefile` and, otherwise, replaces with `replace_contents`, preserving
  symlink and permissions; the inode changes and it gains fsync.
- Catalog projection: a save only rebuilds artists/albums if
  catalog fields or order change, so a change in the rules of
  `build_catalog_snapshot` did not reach existing libraries until the next
  edit or download. Now `library_catalog.PROJECTION_VERSION` is stored in
  `library_info`; when the database is opened with another version it is rebuilt once, in
  manifest order (the album takes the first year/genre). It replaces the
  backfill, whose condition (songs without links) is kept without counting
  podcasts. Normal startup ~1.2 ms; one-time rebuild ~115 ms at 1k and
  ~6.4 s / 151 MiB at 50k (tmpfs). All current libraries are rebuilt
  once on update, because they do not have a version yet.
  [Detail](../performance/incremental-library-writes.md).

Discarded after reviewing the code, because the engine is **a single gevent
process**: SQLite does not yield control, so a transaction finishes before
another request runs. Reopen if the engine moves to multiple processes or real threads.

- Delta history with `BEGIN IMMEDIATE` on each connection (0.1 s wait):
  no contention possible inside the process; ~0.12 ms per call; if it failed,
  the full library is sent.
- Loudness connection per request (gevent turns the thread-local into
  greenlet-local) that installs triggers and does `INSERT OR IGNORE`: ~0.34 ms versus
  0.007 ms when reused; no other process writes that database.
- `ConnectionPool.acquire` calls the factory with the lock held and `release`
  needs that lock (not in `main`): at most 16 opens per database and process, and
  with gevent a SQLite wait already blocks everything. Fix it if the pool is touched.
- Cover variants with lock, `flock` and SQLite on every hit: with gevent they were already
  served serially; the extra cost per hit was not measured. Measure a
  real grid before touching it.
- Loudness token that rotates with retries and failures: clients only
  resync with `loudness_updated`, at most every 5 min and only if there were
  new measurements, and they receive small deltas. Changing it would require migrating
  installed triggers.
- Legacy delta path that returns an empty delta instead of 304 and does not renew
  `created`: it is only used if the early 304 and the incremental path fail; in the
  worst case, one full download per day.

## Pending audit items, without declaring everything finished

The local search index is done in `bc90a83` and the block export
in `32929f7`. The DJ priority candidate was evaluated and discarded as explained
above. Catalog coordination is also completed. Choose the next
chunk from these:

1. Admission budgets per resource and queues: measure saturation first;
   the bounded DJ test does not demonstrate global saturation or justify prioritizing
   from the refinement endpoint without changing the consumer contract;
   prioritize playback and next tracks, discard only obsolete
   speculation. Do not merge pools that are separate to avoid deadlocks.
2. Targeted writes: although SQLite writes are incremental and the
   export no longer duplicates memory, snapshots, fingerprints and exports still
   walk the entire library on every save. The search index
   adds a sorted pass to saves that change search fields or
   order; tracking in-memory mutations would allow removing that pass and the
   per-query fingerprint. Batching exports: see the decision above. In ODST the
   block serialization and the removal of the second model are done;
   still pending are avoiding walking all the bytes to keep podcasts and
   the ownership/coordination of the two writers.
3. Controlled baseline of listening and concurrent load, client and server:
   closed/paused/NORMAL/DJ/Live, cold/warm, visible/hidden, long sessions,
   latencies, queues, CPU and memory. Still pending; synthetic benchmarks do not
   replace it. iPhone/CarPlay validation requires a physical device.
4. Other exploratory points of the report (shell rebuild checks, classification
   of background failures) only justify changes after evidence; do not do global
   cleanup or cosmetic rewrites.

## Last validation and how to resume

Historical validation of the export chunk `32929f7` (the ODST reader one
is in its previous section):

- Full Python suite: **1,509 passed**.
- `tests/test_library_export.py`: **35 passed**; with the canonical library,
  folder scan and multi-user tests, 100.
- `scripts/benchmark_library_export.py` (200/1k/10k/50k and the real library in
  read-only mode, 5 repetitions) requires the three copies to equal `to_json()`.
- `cd ui_web && npm test`: typecheck and **1,123 tests / 115 files** pass.
- Ruff and `git diff --check` pass on modified files.
- Linux validated; native Windows and physical listening are still pending. The real
  engine (port 5005) was not restarted or tested with the search index or with
  the new export; it will do so on its next startup.

Before editing, run `git status --short`, check the branch and read `AGENTS.md`.
The previous results are historical evidence; they do not replace tests of the
next change. Usual commands:

```sh
venv/bin/python -m pytest -q
venv/bin/ruff check <modified_python_files>
git diff --check
cd ui_web && npm test
```

This handoff does not require private memory tools or access to the chat.
The user can start another session with:

> Continue on the branch fix/sqlite-connection-lifecycle. Read AGENTS.md and
> docs/internal/audits/ENGINEERING_HANDOFF.md. Propose the next chunk from the list of
> pending items and plan it before implementing.
> Do not open a PR or push; each finished implementation must be committed.

## Recovery and construction follow-up (2026-09-28)

The four-objective follow-up is recorded in
[recovery and construction](2026-09-28-recovery-and-construction.md). It adds
verified offline restoration, portable-writer revision checks, explicit track
metadata edits, and a measured cooperative export-flush path. That report and
its raw results supersede the older statement that ODST/Station publication has
no shared coordination. They do not close physical-device acceptance or the
full real-listening/Live/remote-provider load matrix. Remaining full-model
fingerprints and exports are explicitly retained, not silently trusted away.

## Later cleanup of code without consumers (2026-11-03)

The user authorized an open PR against `main`, without merging it, to remove
dead code while preserving product behavior and to fix the
Windows failure of the last CI. This delivery has its own scope and evidence in
[unused legacy code](2026-11-03-unused-code.md); it does not declare completed the
pending listening/load matrix of this historical audit.

## Measured continuation (2026-11-05)

The user authorized implementing the demonstrable optimizations in a single
PR to avoid repeated CI runs. Explicit criterion: measurable improvement
greater than 0.5 % of a complete operation, or demonstrated benefit in
functionality, maintainability or reliability. A faster helper or
a proposal without evidence is not enough. This authorization replaces the branch,
push and PR restrictions of the original delivery; it does not authorize merging.

Contract, limits, reproduction and results in
[measured optimizations](../performance/measured-runtime-optimizations.md).

| Candidate | Current status |
| --- | --- |
| Track construction/copy and public fingerprints | Accelerated while keeping all mutability tests and the public bytes. |
| Targeted edits | Only the hash of the affected track is updated; full model verification, revision, catalog, search and exports are kept. |
| ODST saves | Two redundant revision reads per acquisition are removed; podcasts are read by offset only after verifying the full fingerprint of an own publication. External files keep the full reader. |
| Portable serialization | Encoder measured per interpreter: flat path in Python before 3.13 and standard path in newer ones; exact byte equality verified on both paths. |
| Local search fingerprint | SHA-256, same results/order, migration by rehash without normalizing all tracks again. |
| Hot covers | Recent hits without a SQLite connection, with metadata bounded to 256 names/deadlines and invalidation on index/quota changes. No resident images or descriptors. |
| Shell check | One directory pass and an input manifest; it also detects deletions, renames and changes during the build. |
| DJ prioritization/cancellation | The old pending item was already addressed by P14, merged and physically accepted. See [P14](../dj/P14.md). This delivery does not change the musical policy or add another scheduler. |
| Real listening matrix, Live, remote providers and hours-long sessions | Still a separate acceptance; the HTTP/CPU measurements of this delivery do not replace it. |

Full passes are still required to check mutable models,
hash the ODST file and publish its portable bytes. That proof has not been
replaced by trusting only the SQL revision, and no resident copy
of the library has been added. The physical validation restrictions of other platforms
remain in force.


## Covers and acquisition resources (2026-11-07)

The single-PR delivery authorized by the user is described in
[covers and requests](2026-11-07-artwork-requests.md). It preserves originals and
audio contracts, adds per-account cover selections, already-obtained
candidates, re-evaluable recovery and visual execution outside the hub. It connects
real cancellation of acquisitions to the process budget. The xhigh
reviews and their fixes are recorded there. It does not enable promotion of
previews without an equivalence proof and does not claim physical/Pi acceptance.
