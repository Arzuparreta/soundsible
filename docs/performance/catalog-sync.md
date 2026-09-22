# Catalog synchronization: share work and acknowledge the latest revision

Repeated library refreshes could request the same artist/genre/year projection
several times. `syncCatalog()` returned `false` immediately to callers arriving
during a fetch, then ran an unobserved follow-up. Meanwhile the first caller's
success was rejected if another library refresh had happened, even when its
revision was unchanged. The next refresh fetched the projection again.

The coordinator now shares one promise through all necessary rounds. Equal
revision tokens reuse the current round; changed tokens request one follow-up
for the latest target. Results superseded before publication are discarded.
All three requests settle before starting another round, including failures.
Only a complete successful round publishes the projection.

The library passes its accepted revision and acknowledges success using a
separate invalidation generation plus revision equality. A later unchanged
library refresh no longer invalidates useful success. Pending work is still
informed when the manifest returns from B to an already acknowledged A.
Library loading does not wait for catalog loading.

Invalidation detaches the old operation immediately. The new generation can
start while abandoned requests finish; their payload and cleanup are ignored.
This intentionally allows up to six requests during an account switch instead
of making the new account wait behind three old ones. Existing requests are not
aborted. Invalidation preserves an already available catalog because playlist
mutations also invalidate without immediately refetching; existing account
teardown remains responsible for clearing account data.

Failures retain the previous catalog and are retried on the next library
refresh, including an unchanged manifest. There is no periodic retry. Engines
without revisions still require a follow-up after overlapping refresh requests.
No endpoints, response schemas, analysis or playback behavior changed.

## Controlled before/after measurements

[Raw observations](catalog-sync-results.jsonl). Baseline:
`64d76c3a2d5f33c36ba45a9d37d17fcfe0ee2cee`; after-source hashes are recorded in the
file. Both runs use the real library, catalog and core stores. Only API calls
are simulated. This is deterministic virtual time, **not measured network
latency, server CPU, energy or real-library traffic**.

Three projection responses take 100 ms each in parallel. Manifest refreshes
occur at 0, 10, 20 and 250 ms; observations stop at 500 ms. The failure case
fails artists after 10 ms and holds years until 200 ms, then retries at 250 ms.
The waiter case directly calls the catalog at 0 and 10 ms.

| Scenario | Requests before → after | Fixture JSON bytes before → after | Publications before → after |
| --- | ---: | ---: | ---: |
| Same revision | 9 → 3 | 483 → 161 | 3 → 1 |
| A → B → C | 9 → 6 | 483 → 322 | 3 → 1 |
| Account change, same token | 9 → 6 | 483 → 322 | 2 → 1 |
| Partial failure and retry | 6 → 6 | 247 → 247 | 1 → 1 |
| No revision | 9 → 9 | 528 → 528 | 3 → 2 |
| Two concurrent waiters | 6 → 3 | 322 → 161 | 2 → 1 |

For the same revision, catalog data is available at 100 ms in both runs; the
change removes redundant work, not the first response's latency. For A → B → C,
C is available at 200 ms in both; the new code does not publish superseded A.
The new account publishes at 110 ms instead of 200 ms in this fixture. The
second waiter previously returned `false` at 10 ms; both now return `true` at
100 ms, when the required data actually exists.

Bytes are UTF-8 encodings of the controlled successful endpoint JSON bodies,
excluding headers, compression and failure bodies. Percentage savings in these
traces must not be generalized to all use or to server resource consumption.

## Reproduce and validate

From `ui_web/`:

```sh
SOUNDSIBLE_CATALOG_MEASUREMENTS=/tmp/catalog-sync.jsonl \
  npx vitest run src/stores/catalogSync.test.ts -t 'measures controlled'
npm test
npx playwright test tests/browser/catalog-sync.spec.ts \
  tests/browser/library-revisions.spec.ts --project chromium-desktop \
  --workers 1 --output /tmp/catalog-sync-browser
```

The measurement test intentionally makes only baseline-compatible assertions;
its other tests enforce the corrected behavior. To reproduce the historical
trace, use a separate checkout of the baseline revision, copy the current
`catalogSync.test.ts` into it, install the lockfile dependencies, and run only
`-t 'measures controlled'`. Never replace the live checkout's stores to measure
old behavior. The revision argument is cast in that trace so the old
no-argument function can execute the same scenario.

Regression cases additionally cover A → B → A, old responses arriving before
and after the new account, invalidation before the initial microtask, failed
round siblings, no automatic retry, synchronous API exceptions, reentrant
loading/publication subscribers, and playlist-only invalidation.

Validation: typecheck and 1,138 frontend tests across 116 files; seven Chromium
desktop tests including existing real-HTTP 304/revision coverage. The four new
browser scenarios use actual fetch/API/store code with controlled responses,
not a live engine. An isolated Vite server at port 4187 and cache directory
`/tmp/soundsible-catalog-vite` avoided old root-owned cache files; no build or
production engine restart was needed. `git diff --check` passes. No Python
implementation changed, so the Python suite was not rerun for this frontend-only
change.

Catalog endpoints still do not provide a common snapshot token. This change
coordinates requests against the latest *observed* library revision; it does
not add cross-endpoint transactional consistency or discover server mutations
before the next library refresh.
