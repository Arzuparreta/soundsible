# DJ analysis queue: priority decision gate

## Decision

**Do not add priority at `dj-transition` in this chunk.** The proposed change
fails the consumer-side acceptance gate: an analysis completed after the
refinement response is not consumed for that pair. A shorter queue wait alone
would not establish a better transition or lower resource use.

Verified against `b6942eb` on 2026-09-22. No engine, queue, analysis, audio or
client-store implementation was changed. The deliverable is the reproducer,
raw measurements and browser characterization. This is a negative optimization
result, not completion of the engineering resource audit.

The endpoint first reads each cached analysis and, on a miss, requests analysis
and returns a conservative fallback immediately. The client
`maybeRefineTransition()` records `refinedPair` before making the request. A
`measured: false` response leaves the safe transition intact, and subsequent
timeupdates for the same pair do not retry. Neither the endpoint nor the client
waits for the just-requested background work. The endpoint's existing
“never triggers a decode” docstring is stale: it does request background work.

Giving that work priority after the cache miss cannot make the response wait
for its result. Reordering analysis could help other future callers, but this
experiment does not establish a benefit to them. A retry or notification
contract would be a separate functional change, not a transparent queue-only
optimization.

## Reproducer and boundaries

`python scripts/benchmark_dj_queue.py` launches a fresh isolated child per case:

- gevent is patched before importing the engine, Flask or numerical libraries;
- temporary config, data, cache, logs and music directories, an isolated account;
- current explicit-source `dj-plan` collection route and `dj-transition` handlers;
- real two-worker executor, FFmpeg decoding, numerical analysis and SQLite cache;
- a generated three-minute mono WAV (11,025 Hz), reused under independent track
  identities; every accepted analysis must finish with usable cached features;
- deterministic related candidates and local-path lookup; external graph warming
  is disabled. No external providers, real downloads or live user files;
- cold, warm, two consecutive routes, and four concurrent independent sessions
  in one account. Four sessions are **not** four browsers or four accounts.

The Flask test client exercises actual handlers, not real HTTP transport or a
whole engine boot. Browser characterization is a separate experiment with the
real app/store/audio but controlled API responses and a silent WAV with Range
support. These two experiments are not an end-to-end connected listening test.

Queue instrumentation exists only inside the benchmark. It records monotonic
submission/start/finish times for at most 36 fixture identities, plus a bounded
10 ms hub probe. Both enabled and disabled runs retain the same verification
wrappers; their difference measures event collection, not all harness overhead.
No production logging, persistent in-memory index or public endpoint was added.

Five repeats alternate instrumentation order. Raw data contains the application
revision, benchmark SHA-256, Python, kernel and CPU. This host used FFmpeg
`n9.0.1`; browser evidence used Chromium `151.0.7922.34` with a 1366 × 768 viewport.
Files and decoded audio are synthetic, not a copy of the user's music library.
The first repetition overlapped the brief browser characterization; medians are
reported without deleting samples. This is not a controlled whole-machine
resource baseline or an estimate of instrumentation overhead in production.

## Results

[Early refinement, raw data](dj-queue-gate-results.jsonl): refinement 50 ms
after route responses. This models an early seek or direction change, not the
normal delay before a three-minute track's handoff.

Medians of five instrumented runs; waiting excludes execution:

| Case | Analyses | Maximum waiting | All analyses finished after | Queue wait p95 | Pair ready at first refinement |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold route | 9 | 7 | 0.446 s | 0.283 s | 0/5 |
| Warm route | 0 | 0 | already cached | — | 5/5 |
| Route switch | 18 | 16 | 0.854 s | 0.752 s | 0/5 |
| Four concurrent sessions | 36 | 34 | 1.549 s | 1.372 s | 0/5 |

The current pair's two analyses finished at median 0.109 / 0.593 / 1.269 s for
the three cold cases. Every diagnostic read **after drain** reported the pair
measured; this extra read is an observer, not a retry made by today's client.
All accepted analyses completed and the pending set emptied. No artificial
sleep was inserted in decoding or analysis.

[Delayed refinement, raw data](dj-queue-delayed-gate-results.jsonl) repeats the
three cold cases with a two-second delay. All five runs per case found the pair
measured on the first request, with instrumentation both on and off. This is a
controlled availability check, not a proposed two-second retry policy.

Early-run refinement handlers took median 1.47–1.71 ms. Instrumented hub-lag
p95 medians were 1.5–2.0 ms in cold cases; these are short samples, not API/hub
SLOs. Final process PSS was approximately 155–161 MiB, **not peak memory**.
Process CPU/I/O excludes FFmpeg subprocesses. No client CPU, energy, speaker
continuity or total server-tree savings are claimed.

Enabled versus disabled median experiment duration differed by -3.4%, -0.2%,
+6.7% and -1.2% across the four cases. These mixed short-run differences do not
justify a zero-overhead claim. No production instrumentation is being shipped.
`wall_s` includes the intentional refinement delay and drain observation;
`analysis_finished_at_s` is the last actual analysis completion, used above.

[Chromium observations](dj-refinement-browser-results.jsonl): five repetitions
of each consumer case, ten passed with no retries:

- available at the first response: measured confidence 0.95 is applied;
- available only after that response: three later seeks/timeupdates for the
  same pair still make no second request; confidence remains 0.18.

The browser test is explicitly a characterization of today's contract, not a
requirement to preserve the missing retry forever. Update it if that contract
is deliberately changed.

## Reproduction

```sh
venv/bin/python scripts/benchmark_dj_queue.py --repeats 5 --seconds 180 \
  --output /tmp/dj-queue-early.jsonl
venv/bin/python scripts/benchmark_dj_queue.py --repeats 5 --seconds 180 \
  --refine-delay 2 --scenarios cold switch four_sessions \
  --output /tmp/dj-queue-delayed.jsonl
cd ui_web
npx playwright test tests/browser/dj-refinement-audit.spec.ts \
  --project chromium-desktop --workers 1 --repeat-each 5 \
  --output /tmp/dj-refinement-browser
```

On this checkout older root-owned Vite cache files prevented a normal dev-server
start. The browser run reused an isolated server at port 4187 with
`cacheDir: /tmp/soundsible-dj-audit-vite` and
`SOUNDSIBLE_UI_TEST_PORT=4187`. It did not change permissions, rebuild the bundle
or touch the engine listening on port 5005.

## Validation

- 70 isolated benchmark executions: 40 early/warm and 30 delayed; all accepted
  analyses cached usable results and every diagnostic post-drain read succeeded.
- Raw-data verification: stored script hashes match the committed reproducer;
  timestamps are ordered, job totals match accepted identities, and active
  analysis never exceeds two.
- Chromium desktop: 10 passed, no retries or skipped cases.
- Full Python suite: 1,509 passed.
- `cd ui_web && npm test`: typecheck and 1,123 tests / 115 files passed.
- Ruff for the new script and `git diff --check` passed.

## Remaining work

This gate was run before the planned long workload matrix because it found a
consumer-contract prerequisite for the proposed intervention. The 30-second
warmup / 120-second concurrent listening runs, other executor instrumentation,
real-library scans/downloads, separate client/server process-tree sampling and
long-session memory study **were not executed**. They remain audit work, not
acceptance evidence for this result. No before/after scheduler comparison exists
because no new scheduler was introduced.

There is no evidence here to add global admission limits, discard analyses,
merge pools or change exports. To revisit transition priority, first define how
an unfinished analysis can be consumed before commit, with cancellation on pair
or account changes and a bounded retry/notification budget. Alternatively,
measure contention in the other pools independently of this rejected candidate.
