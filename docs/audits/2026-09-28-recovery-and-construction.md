# Recovery, writer ownership and background-load quality

Scope: four construction-quality objectives on one branch, based on merged
`main` at `66fa34d`. No production instance was restarted or modified. All
fault injection and load tests use disposable directories.

## Delivered

1. **Verified offline backup/restore.** New `python -m shared.instance_backup`
   creates a private checksummed directory, copies committed SQLite WAL through
   SQLite's backup API, validates databases and restores only into a new root.
   Rehearsals cover real account/password/favourites/playlist/download state,
   audio/artwork, damaged state after backup, legacy account-layout migration,
   corrupted copies, recursive destinations and encrypted storage credentials
   on a changed machine identity. [Contract](../engineering/instance-recovery.md).
2. **Explicit portable-writer ownership.** A shared local publication lock,
   optimistic file revisions and targeted acquisition commits stop stale ODST
   snapshots from erasing intervening Station/download edits. Cloud sync owns
   an independent snapshot/token even when a download uses the same downloader.
   Tests include independent processes and corrupt manifests.
3. **Measured background-load improvement.** Production HTTP Range handling
   under real SQLite/export and DJ work exposed hub blocking at durable export
   flushes. Native-worker fsync keeps the hub available while preserving flush
   failure semantics. Descriptor lifetime and cancellation are tested in a
   patched child process. Queue diagnostics retain only active timing records
   and aggregate counters; cancelling queued work releases its task identity.
4. **Explicit track-edit operation.** Metadata edits and flags update a known
   row and revision instead of staging every track/playlist/header. Existing
   catalog/search/public-source invariants and portable exports are preserved;
   invalid proofs fall back to the established canonical full writer.
   [Contract and cost](../performance/track-metadata-patch.md).

## Measured evidence

[Playback matrix](../performance/playback-load.jsonl): 11 isolated cases, 5,382
verified range responses, no response/content failures. Alternating synchronous
and native-worker fsync at 200 tracks, two clients, three ten-second runs per
path gives these medians across runs:

| Metric | Synchronous flush | Native-worker flush |
| --- | ---: | ---: |
| Event-loop lag p95 | 99.19 ms | 1.09 ms |
| Range request p95 | 4.39 ms | 3.19 ms |
| Completed range requests | 200 | 369 |

This improves event-loop availability, not necessarily audible playback. The
one-minute 1,000-track loaded run served 2,086 correct ranges, p95 3.82 ms,
with event-loop p95 19.89 ms and maximum 175.15 ms. The cold DJ case still reached
293.96 ms maximum hub lag. These residual synchronous costs remain visible;
there is no claim of zero stalls or a new global admission policy.

The title-edit benchmark includes two local exports. At 10,000 tracks, median
whole-save cost was 600.8 ms versus 517.7 ms for explicit edits. At 1,000 tracks
both were 133.9 ms. Small sequential samples are cost evidence, not a universal
speedup; public/search fingerprints and exports still scan the library.

## Acceptance boundaries

- Backup requires all writers stopped; `--stopped` is an operator assertion,
  not automatic service control. Remote audio, external scanned folders and
  symlinks require separate backups. Absolute storage paths are preserved.
- Restore does not run migrations. Old releases need their original machine
  identity if they cannot read the new optional credential-key file.
- File revision/locking coordinates cooperating local writers. It is not a
  remote object-store transaction or protection from arbitrary external edits.
- The load harness runs real transport/edit/export/analysis code, but fixture
  identity/path lookup and a synthetic filesystem scan. It does not reproduce
  remote downloads, browser visibility, Live, full DJ transitions, sessions of
  many hours or physical iPhone/CarPlay/Windows behavior.
- No UI bundle build was run; frontend validation uses the repository's
  `npm test` gate. No version declarations were manually changed.

## Validation

- Full Python suite: `1616 passed in 70.79s (0:01:10)`.
- Frontend `npm test`: typecheck and 1,179 tests in 121 files passed.
- Repository-wide Ruff and `git diff --check` passed.
- Patched-process durability/cancellation/publication-lock tests passed.
- CI status is reported separately on the PR; local success is not CI completion.
