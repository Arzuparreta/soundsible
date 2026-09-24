# Library integrity and recovery

## Audio ownership

A library owns references; managed audio can belong to several accounts. Removing
one account's reference is committed before physical cleanup. Cleanup intents
live in `instance.db` and survive crashes. A periodic pass checks all canonical
account databases (including disabled accounts); unknown or unreadable state
retains the object. Storage changes do not retarget old cleanup intents.

Canonical replacements and cleanup use one reentrant process/file lock, acquired
before SQLite transactions. External scanned originals are borrowed and never
removed. Repairs and optimization retain their previous objects until canonical
references have moved. A failed remap preserves the original and reports failure.

A library wipe clears that account only; it no longer enumerates and deletes a
shared bucket. Artwork remains under its existing reference-management policy.

Validation uses temporary libraries and managed files. No live library is used
for fault injection; Windows file locking still needs native platform acceptance.

## Durable downloads

The queue now uses `download_jobs` in `instance.db`. Startup initializes accounts
first, imports `download_queue.json` transactionally, and keeps the source as
`download_queue.json.sqlite.bak`. The migration marker makes retries safe. Invalid
JSON stops migration with an explicit error and is not overwritten. Legacy rows
without an owner are assigned to the instance administrator.

Acceptance and state transitions commit before HTTP success. Progress remains
volatile and never rewrites the durable queue. Each claimed job has an attempt
token: a second claimant, a cancelled job, and a late previous worker cannot
commit a result. Downloads interrupted by restart become pending automatically;
failed jobs remain visible until retried or cleared. Disabled/deleted owners are
not eligible to run jobs.

A downloaded track is checkpointed before incorporation. The library transaction
also records the job ID in `library_operations`; replay after that commit finishes
the job without re-adding music (including music deleted since that commit).
Cancellation after acquisition but before incorporation prevents incorporation.
Files produced by an interrupted acquisition before its checkpoint can require
acquisition again; resuming a partial network transfer byte-for-byte is not promised.

Completed/cancelled jobs and their library receipts are retained for seven days
and pruned on startup. Pending/failed jobs are never silently expired. Shutdown
stops claims and allows five seconds for active downloads before leaving their
persisted state to restart recovery. A forced process exit is covered separately
from orderly shutdown tests; sudden power loss and native Windows remain untested.

## Rollback and errors

An older release cannot see jobs added to SQLite. Before downgrading, finish or
explicitly cancel outstanding jobs; restoring the JSON backup alone would replay
old work and omit new work. Do not run old and new engines concurrently against
the same state directory. Keep backups of the stopped instance for rollback.

Library conflicts return HTTP 409; persistence unavailability returns HTTP 503.
The download view waits for server confirmation and reports failure instead of
removing a task optimistically. Missing Socket.IO events are reconciled by the
existing HTTP refresh on reconnect.

Portable JSON exports remain derived from committed SQLite. Export errors do not
turn a durable commit into failure; unwritable destinations are tried again on
subsequent exports. All-user repair failures preserve old audio and report failure.

## Shared exports and validation

Multiuser personal exports use `users/<account>/library.json` on the storage
provider. The global `library.json` remains the pool catalog; a personal deletion
must not overwrite it with that account's smaller collection. Single-user export
paths remain compatible. The personal SQLite library remains authoritative.

The isolated commit-cost check used five warm title changes, real SQLite and
portable exports in a temporary Linux directory: median 9.13 ms at 200 tracks,
34.57 ms at 1,000 tracks. This measures the cost now paid before acknowledgement,
not an acceleration versus the previous deferred response, total RSS, real disk
performance in another installation, or playback quality. A regression confirms
that 100 progress updates perform no durable queue writes.

Automated acceptance includes per-account file ownership, failed commits and
physical cleanup retry, batch-admission rollback, corrupt migration input,
exclusive job claims, late-worker rejection, checkpoint recovery after forced
process exit, and the real worker's idempotent incorporation/cancellation path.
Browser checks cover recovery on refresh and durable cancellation success/failure
in Chromium mobile and desktop, against controlled HTTP responses.

Acceptance run: full Python suite 1,557 passing; frontend typecheck and 1,142
unit tests passing; six Chromium browser cases passing. The final cleanup error
handling also passed 49 focused library/export tests and a new cache-failure
regression (nine lifecycle tests total). Ruff and `git diff --check` passed.
