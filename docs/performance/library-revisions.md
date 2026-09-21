# Conditional library snapshots

`GET /api/library` returns an opaque, weak ETag over the serialized public
snapshot plus the authenticated account identity. Sending that ETag in
`If-None-Match` returns a bodyless 304 when the representation is unchanged.
Responses use `Cache-Control: private, no-cache` and vary on Cookie and the
desktop owner-token header. Authentication runs before the route. The JSON
payload is unchanged; clients without conditional requests get full snapshots.

## Early revalidation

A database revision alone is insufficient: the manifest is mutable between
saves, and artwork and loudness change independently. The fast path combines:

- A streaming fingerprint of every public metadata field, including nested
  settings, playlists, podcasts, track ordering and structured artist lists.
  Machine-local paths and mtimes are excluded.
- Persistent SQLite invalidation tokens for artwork references/objects and
  loudness rows. Triggers change tokens within each write transaction, including
  writes from another connection or process. Rollback rolls back the token;
  new databases get independent tokens. Recovery bookkeeping does not invalidate
  artwork. Empty libraries need no annotation tokens or queries.
- The authenticated account identity.

A bounded process-local cache (128 entries, 10-minute TTL) maps these keys to
ETags. It retains no tracks, snapshots or response bodies. A matching request
returns before the public copy, loudness/artwork annotation and JSON serialization.
Misses use the complete response path and seed the cache from the **detached
snapshot's** fingerprint. Thus a metadata edit during copying cannot cache the
response under different source content. Annotation tokens must match before
and after construction; failures and concurrent commits prevent admission.
Unavailable revision stores or unsupported model shapes fall back to the full
path. Eviction and process restarts affect performance only.

The fingerprint uses pickle solely as an internal typed byte encoder feeding
a digest. It never retains or unpickles the bytes. The encoder memo is cleared
between tracks, so scratch allocations depend on the header metadata and largest
track, not the number of tracks. The manifest is still traversed on each
conditional request; this is not an O(1) database revision check.

## Web behavior

The web store owns one validator in memory for its last accepted snapshot.
Explicit conditional fetches use `cache: no-store`. On 304 it keeps track/list
identities and artwork metadata, refreshes saved entries, and skips a catalog
projection already loaded successfully for that revision. Failed catalog fetches
are retried. Engines without ETags still work; malformed snapshots cannot clear
the accepted state.

Invalidation clears the validator and scheduled refresh, abandons the old
request generation, and lets the next request start immediately. Stale replies
cannot install tracks, artwork metadata or validators. Login/logout reload the
page, which starts without a validator. Concurrent sync callers share a promise
that includes the coalesced follow-up refresh.

## Evidence and limits

Run `venv/bin/python scripts/benchmark_library_revisions.py --memory` for
synthetic metadata through the real Flask route. Database refresh, annotation
lookups/token reads, compression and network transport are excluded. No user
data is read or written. Timing and tracemalloc run separately. Example local
run on 2026-09-21, median of three requests:

| Tracks | Full body bytes | Unchanged body bytes | Full ms | Warm unchanged ms | Full peak Python bytes | Warm peak Python bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 712,815 | 0 | 15.88 | 3.63 | 2,285,261 | 22,920 |
| 10,000 | 7,156,815 | 0 | 156.08 | 32.23 | 22,735,659 | 22,096 |
| 50,000 | 35,916,815 | 0 | 785.33 | 163.03 | 113,894,228 | 21,616 |

For context, the preceding `93902d4` implementation measured approximately
651 ms for an unchanged 50,000-track response: it serialized before returning
304. Its full response was approximately 648 ms. The fast path trades extra
fingerprint work on full responses for lower repeated validation cost. A changed
conditional request performs both the source check and the detached fingerprint.
These are synthetic runs, not a controlled production latency or audio benchmark.
Headers still travel with a 304. Peak allocations are not process RSS; libraries
with large playlists or podcast caches require more fingerprint scratch space.

Backend coverage exercises early bypass, dirty in-memory mutations, additions,
deletions, ordering, annotations, account isolation, concurrent construction,
rollback, external writes, reopen, failures, and connection budgets. Frontend
and Chromium/WebKit tests from the preceding chunk cover conditional HTTP,
reload, stale responses, and object identity preservation; their protocol is
unchanged by the early server path.

Incremental library deltas and a fully transactional manifest revision remain
separate work. This chunk introduces no delta journal or retained snapshots.
