# Artwork, acquisition and work budgets

Delivery started from `main` at `1d904020`, after reviewing the audio,
artwork and cache flow, and validated with the combined base of #423/#424 (`adff0c88`).
Before opening the PR, #425 (`9560a121`) was also merged in: it only removes the stub
`gui.sh` and updates architecture point 8, without changing the sources run
by the earlier suites. That removal is not part of the diff of this PR.
The visual original stays separate from the audio file:
a large image no longer blocks the first sample in its header.

## Diagnosis and path of the requests

The historical feature had not disappeared. PR #113 reduced the embedded image
and removed unnecessary video; PR #171 kept durable originals, variants and
later recovery. The contract found was not "a GET requests audio and a minimal
JPEG and always replaces them": audio, visible image and recovery were
independent operations. This delivery keeps that separation.

The symptom had two different causes: library and preview could choose
images of different provenance, and a 1280×720 thumbnail only provides at
most 720×720 when cropped to a square. A screen at DPR 3 may need more.
The endpoints queried for the small images in the sample did not offer
a confirmed improvement. Upscaling them or relaxing the comparator does not create detail.

| Moment | Final requests and work |
| --- | --- |
| Load library | `/api/library` delivers metadata/revisions/dimensions/scope, not images. Keeps 304 and deltas. |
| Listen to acquired audio | `/api/static/stream/<id>`, possibly several Range requests. Does not query YouTube to get the artwork. |
| Show acquired artwork | `/api/static/cover/<id>` serves the original or a local variant. If the master is still missing, it can extract the local embedded image. It does not make a remote GET on this route. |
| Show NORMAL/DJ stage | `CoverImage` builds `srcset` according to slot, DPR and effective resolution. It does not download all sizes; the browser selects one. Media Session can request its own variant. |
| Search/listen to preview | The provider/yt-dlp resolves metadata and audio; one extraction call can make several HTTP requests. Candidates already present are used, without a new visual extraction. The image bytes require their normal GET. |
| Prepare preview | The existing memo/singleflight, signed stream expiration and progressive cache are kept. The status responses already queried optionally carry artwork; no polls are added. |
| Acquire | yt-dlp CLI gets audio and metadata with an embedded thumbnail; the repair preserves the original before reducing the header. The hash after tagging is kept. An existing preview is not promoted with the current contract. |
| Save from catalog album | The Deezer record is revalidated to bind edition and image to a receipt. It is a deliberate authority query, not an image download in the audio path. |
| Complete catalog acquisition | Audio ownership is confirmed before processing the image. The queue saves the durable intent before closing; the recoverer downloads the candidate separately. |
| Recover old library | A sequential recoverer per instance keeps/reviews known sources. Negatives and backoff avoid repeating the GET on every play; new evidence or reevaluation can enable it. |

The old search took `thumbnail` and ignored `thumbnails`; the resolver
discarded the images by keeping only the stream. The recoverer compared
the shorter side with 1280: a 1280×720 source could trigger another GET of itself.
The final states prevented retrying even temporary failures. In addition, three
large square variants of a 480×360 source could store the same
JPEG under different keys. The following fixes address those specific losses
and duplications.

## What yt-dlp allows

`extract_info(download=False)` gets metadata/formats without downloading the audio;
it does not imply a single network request. `thumbnail`/`thumbnails` allow reusing
references, although the extractor also builds speculative URLs. Declared
dimensions and provenance are kept as unverified observations.

`--write-thumbnail` saves a separate image; `--skip-download` avoids the audio
but not the necessary extraction. `--list-thumbnails` inspects references,
`--embed-thumbnail` embeds them and `--convert-thumbnails` changes their format.
No option creates detail. Requesting all thumbnails or doing another extraction
only to discover them would increase requests. There is also no ordinary GET
that delivers audio and an independent JPEG at the same time. The artwork is discovered in
responses that are already needed and is downloaded by its independent visual consumer.

References: [thumbnail options](https://github.com/yt-dlp/yt-dlp#thumbnail-options)
and [extractor arguments](https://github.com/yt-dlp/yt-dlp#extractor-arguments).
The names and formats offered depend on the current extractor/provider; the
audio fallback is still necessary.

## Contracts

- Searches use `thumbnails` when they include dimensions, without another discovery
  query. Alternative frames are excluded; declared dimensions
  are not equivalent to a verified download. The resolver keeps safe public
  candidates in SQLite, independently of the stream expiration.
- The existing preparation/status carries those references. The web only
  upgrades a main thumbnail of the same video and keeps the previous one if
  it fails. It does not replace a catalog artwork with a video image or increase
  the prefetch or the number of polls.
- When saving a song from a Deezer album, the server revalidates the
  record, artist, title and album. It issues an authenticated receipt that binds the
  canonical URL to the account, video, record and ordered intent. A URL or
  edition identity sent by the client is not a download authority.
- The audio is added before scheduling that optional selection. The durable
  intent is processed by the existing recoverer, with a lease per attempt,
  persisted pauses and bounded batches. Publishing the artwork and completing the attempt
  share a transaction. An old intent or a late result cannot
  replace a new, manual or removed one. Orphaned selections are removed
  in pages and identity changes copy only the pending ones of the account.
  The receipt is checked against the current video of the incoming track. The job stays
  replayable until that intent is persisted, also after the library commit.
- Objects by hash and source artwork are shared. Selections and overrides
  belong to an account. `none` is a tombstone. The historical manual global
  references are kept: it is not invented whom they belonged to.
- Clients receive a visual scope per account. Versioned variants
  keep ETag and private retention; URLs without revision and placeholders
  revalidate. Saturation, timeout and crash are 503 with `no-store`, not a missing
  artwork cached for a day. Subsonic respects the effective reference.
- Recovery distinguishes the known ceiling of a source from the detail a
  screen needs. A known 1280×720 source does not trigger another GET for not reaching
  1280 on its shorter side. A new image or new candidates reopen the evaluation;
  negatives and pauses survive restarts. Aspect ratio and pHash are kept
  conservative: they are not proof of edition identity.
- Visual downloads only accept HTTPS from specific hosts/paths, without
  redirects, user cookies, netrc or environment proxy. They reuse a single
  public session in a lazy HTTP child separate from the transformer. It only admits
  one job; saturation defers without contact and without consuming an attempt. The parent
  supervises the full deadline from before admission, including startup, DNS,
  TLS and headers; stop or timeout kill and reap the child and IPC reader.
  `Retry-After` pauses the host durably and a 404 keeps a negative.
  The body goes through staging with a byte limit and four million pixels.
  The bounded process reaping margin is added to the operational deadline; an
  instant interruption of a kernel operation is not promised.
- In the gevent engine, a lazy child validates new originals and transforms
  variants. The parent keeps quota, atomic publication and open descriptors.
  A warm hit does not wait for the child or query SQLite if its metadata is
  recent. Equivalent buckets share bytes and key. Queue and wait
  share a deadline, also when waiting for the quota with non-blocking locks and
  cooperative pauses. There is no Pillow fallback to the hub after the child fails.
  Staging is in the cache and has parent/writer leases and reconciliation after
  a crash. The child cleans up its last result when it loses the parent, has a watchdog
  per job and is reaped on inactivity/shutdown. The old perceptual comparison
  is still local: it is not claimed that all visual computation has been isolated.
  There can be two visual interpreters; it is not claimed that their RSS is free.
  These limits are fixed, not proportional to the cores: a Pi avoids
  multiplying decoders and the desktop keeps the hub available. There is no
  physical Pi evidence or automatic tuning that promises the optimum for each host.
- The YouTube visitor has cooldown, renewal and rejection without a queue per effective
  egress configuration. An old rejection does not invalidate a new identifier.
  The stream caches distinguish relay A and B through a fingerprint without storing
  their credentials in the key.
- A download has a single budget across the native attempt, cookies and fallback.
  It includes silent stdout, output without newline, waiting, descendants and
  later FFprobe/remux, which share the first deadline. The
  real validity of the item/attempt and the shutdown reach the runner and the later
  phases; cancelling does not leave the slot consuming network for another ten minutes.
  POSIX uses a process group; Windows assigns a suspended process to a Job
  with KILL_ON_JOB_CLOSE before resuming its main thread. The diagnostics are
  a byte ring and retry causes are not lost by rotation.
- Android and the car API request a square 640 variant; iOS uses
  NSCache with image cost and an entry limit. NSCache is an eviction
  policy, not a physical guarantee of total process memory.

## Scope decision: audio promotion

Promotion of previews to acquisition is not enabled. The current cache does not prove
equivalence with the acquisition selector or completeness for all its
paths. The normal download is kept. Enabling it requires a new contract
that binds generation, integrity, selected format and quality policy,
plus complete measurements. It is a correctness decision backed by
the two systems critiques, not an achieved network saving.

Redis, a global scheduler, workers by number of cores,
a preview sweep or relaxation of the visual comparison are not introduced either. The existing
limits for disk, CDN audio and DJ analysis remain independent.

## Critique and iteration

Systems critiques were requested with `gpt-6.1-sol` and effort `xhigh`.
The first blocked global selections and promotion without evidence;
isolation and source authority were added. The second found:

| Finding | Disposition |
| --- | --- |
| Subsonic recovered a removed artwork | The extractor queries the effective override/tombstone first; regression. |
| Trickle bypassed the visual deadline | Partial reads and budget from before opening; real slow server. |
| Cancellation did not reach the downloader | Explicit item/attempt/stop context; real child and descendants. |
| Concurrent replays altered success | Durable claim and publication/completion in one transaction. |
| Orphans blocked the batch | Pagination with cleanup and remap of selections. |
| Temporary error cached a placeholder | Private no-store 503 with Retry-After. |
| Deadline started after a lock | Deadline created at admission and propagated to the child. |
| Crash retained durable staging | Cache staging, lease and reconciliation; child EOF/watchdog. |
| Double decode in the hub | Master validation outside the hub; lower remote limit and hits without decode. |
| Failed upgrade removed artwork | Fallback to the previous artwork and bounded session negative. |

The third critique reproduced partial fixes and additional races:

| Finding | Disposition |
| --- | --- |
| Personal rekey copied other users' choices | Copy of overrides/receipts limited to the active account; Alice/Bob regression. |
| Quota lock blocked the hub and exceeded the deadline | Non-blocking file locks, cooperative wait and deadline until publication; real gevent probe. |
| Receipt of the previous video survived the content change | It is removed when checked against the current video; the adoption receives that current identity. |
| FFprobe/remux outside cancellation | Common runner with budget inherited across stages; real cancellation and timeout. |
| Header trickle bypassed the deadline | Fourth design critique recommended a separate HTTP child, with one admission, supervision and kill/reap. DNS/headers/body/stop covered. |
| Incomplete fallback in CSS | Small rows keep the thumbnail; large CSS surfaces keep the previous image as a layer. Test of the real row component. |
| Crash lost the intent after adding audio | Persistence before completing the job and replay after commit; crash/SQLite error covered without redownloading or resurrecting a deleted track. |

The last review verified that the seven findings were closed and did not find
other confirmed blockers. It also reproduced the SQLite wait of `observe`
in the audio path: an external writer also delayed the hub. Commit
`f8587f4d`, prepared during that review, changes that optional observation to
`timeout=0`; the reviewer verified its immediate return. Its 15 selected tests
passed. It statically validated the separate HTTP process, single admission,
supervision, IPC reader and leases. It did not run the long suites or demonstrate
Windows frozen with real traffic, specific TLS blocking, WebKit or Pi.

## Evidence and limits

The final tests and measurements of this delivery are recorded here before
opening the PR. `scripts/benchmark_artwork_pipeline.py` compares cold/warm HTTP
requests and hub delay against a git revision, on the same corpus,
encoder and disk, in a temporary runtime. It does not touch real libraries.

An improvement in hub response is not equivalent to lower latency for each image:
IPC, staging and child startup add costs that must be reported. The
desktop measurements do not prove Raspberry Pi, battery, physical listening or
Windows/macOS acceptance. Running the worker entrypoint in Python
does not by itself amount to testing a frozen binary.

### Isolated HTTP measurement

Ryzen 7 5800X, Linux, same disk; five repetitions, twelve simultaneous
requests to the real cover route, synthetic 1280×720 images and a square
960 variant. Account bound per request. Only the library and the
file source are replaced, without a real service or library. The visual process is
started before the cold batch; its first startup is not included. Medians of
the batches; the hub column is the median of the maximum observed in each batch:

| Operation | Base | Pipeline |
| --- | ---: | ---: |
| Full cold batch | 363.56 ms | 207.69 ms |
| HTTP p95 of the cold batch | 362.24 ms | 204.38 ms |
| Maximum hub delay, cold | 300.47 ms | 21.92 ms |
| **Parent** CPU, cold batch | 189.19 ms | 52.87 ms |
| Full warm batch | 28.58 ms | 29.76 ms |
| HTTP p95 of the warm batch | 28.43 ms | 29.45 ms |

The bodies are identical in all cases. The isolation reduces CPU work
inside the server; it does not prove lower total CPU: the child's CPU is not
in that column. The warm batch adds about 1.2 ms; it is not claimed that every
request is faster. The relevant improvement is not monopolizing the hub during
the cold batch and keeping the selection per account. These are measurements on this machine,
not a guarantee for other disks, Pi or music playback.

Data and reproduction: [JSONL](../performance/artwork-pipeline-results.jsonl),
`python scripts/benchmark_artwork_pipeline.py --baseline 1d904020 --repeats 5`.

### Local validation and pending gates

- Initial main regression: 2645 passed and two skipped; a payload
  expectation did not include the new scope and the worktree did not have the ONNX model
  included. The expectation was fixed and the verified public copy
  of the model was prepared; the 17 cases of that radius passed. The full regression on the
  combined base finished with **2674 passed and one skipped**, in 626.55 s.
- Regression after the third critique: 117 passed; additional identity/processes/replay radius: 66 passed. The second full main run, with the new transport, finishes with **2688 passed and one skipped**, in 594.08 s. The later small observation/visitor/reader changes have their final radii passed (57, 50 and four cases).
- Final combined client: TypeScript and **1871 tests passed** in 228 files.
- Final full Chromium: **384 passed and 74 skipped** across mobile/desktop, in 3.6 min. An earlier pass with the Vite graph already modified failed in eight state/imports cases; after restarting the server, the ten cases of that radius and the full suite pass, without changing their assertions.
- Combined Android: preparation, debug APK, JVM and lint passed. Device panel does not detect the SDK; it is not
  presented as acceptance of emulator execution or physical listening.
- Process/worker contracts: 37 cases passed in the pipeline suite;
  later audio/observation radius: 57 passed and four reader/contention tests passed. The optional observation uses SQLite without waiting so as not to hold audio. The existing Windows x64/ARM64 jobs also run them
  and use the built sidecar to test the frozen visual entrypoint; their
  remote results are still pending.
- Final full WebKit: **371 passed and 87 skipped** across mobile/desktop, in 7.1 min, Docker with a read-only mount and one worker; run after Chromium and the Python load. Test Vite server stopped.
- Ruff and manifest check passed. CI of the last head is still a delivery gate. This implementation has not been merged or published.
- First remote CI: Android shards 2/5 failed before running the app, when
  losing ADB during the Wi-Fi preparation. Recovery of that single
  command was bounded and four regressions were added (eight module tests passed).
  Diagnostics and limits in `docs/internal/android/CI_DIAGNOSTICS.md`. Product tests are not hidden or
  retried automatically; full CI of the new head is required.
- Windows x64 ran the sidecar contracts, but the descendant test
  did not recognize the handshake: the binary runner kept the `\r` of CRLF in the
  callbacks. The line contract without terminators was restored and a
  CRLF bytes regression that also runs on Linux was added, keeping the real
  assertion of cancellation and closing of the descendant.
