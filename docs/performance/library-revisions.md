# Conditional library snapshots

`GET /api/library` now returns an opaque, weak ETag over the serialized public
snapshot plus the authenticated account identity. Sending that ETag in
`If-None-Match` returns a bodyless 304 when the representation is unchanged.
The response uses `Cache-Control: private, no-cache` and varies on Cookie and
the desktop owner-token header. Authentication still runs before the route.
The JSON payload is unchanged, so clients without conditional requests continue
to receive complete snapshots.

A database revision is insufficient here: artwork and loudness annotations are
updated independently of the library manifest. This first revision contract
hashes the actual response after annotations and serialization, with no shared
snapshot cache. It covers additions, deletions, order, metadata edits, playlists,
settings and podcasts as well as annotation changes. Private file paths and mtimes
are excluded with the existing public serialization contract.

The web store owns one validator, in memory, associated with its last accepted
snapshot. It uses explicit conditional requests with fetch `cache: no-store`;
neither browser caches nor persistent storage supply the snapshot. On 304 it
keeps track/list identities and artwork metadata, continues to refresh saved
entries, and skips a catalog projection that already loaded successfully for
that revision. Failed catalog requests are retried. Full responses from older
engines without ETags still work; malformed full snapshots fail without clearing
the accepted state.

Invalidation clears the validator and scheduled refresh, abandons the old
request generation, and lets the next request start immediately. Stale replies
cannot install tracks, artwork metadata, or validators. Login/logout already
reload the page; reloading starts without a validator. Concurrent sync callers
share a promise that includes the coalesced follow-up refresh, so awaiting a
mutation's refresh no longer returns before that refresh has happened.

## Evidence and limits

Run `venv/bin/python scripts/benchmark_library_revisions.py` for synthetic
metadata through the real Flask route. The fixture excludes database refresh,
annotation lookups, compression and network transport. No user data is read or
written. Example run on 2026-09-21, median of three requests:

| Tracks | Full body bytes | Unchanged body bytes | Full ms | Unchanged ms |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 712,815 | 0 | 12.93 | 12.48 |
| 10,000 | 7,156,815 | 0 | 129.18 | 126.86 |
| 50,000 | 35,916,815 | 0 | 648.37 | 651.10 |

Headers still travel with a 304. This slice saves payload transfer, client JSON
parsing, array replacement and successful catalog refetches on unchanged
libraries. It does **not** remove server snapshot construction, annotation,
serialization or the full library scan; hashing adds a linear pass. There is no
claim of improved audio, server CPU savings, or measured production latency.

Backend tests cover HTTP revalidation, account isolation, public mutations and
independent annotations. Frontend tests cover identity preservation, failure
recovery, invalidation, stale responses, old-engine compatibility and shared
completion. Chromium and WebKit exercise conditional fetch over a real HTTP
fixture, reload, and stale artwork/account replies. The HTTP fixture serves
synthetic responses; Flask behavior is checked separately by backend tests.

Next work: incremental library deltas and a cheaper server revision/invalidation
source that includes every dependency. A manifest-only early 304 must not hide
artwork or loudness changes. No delta history or extra retained snapshots are
introduced in this chunk.
