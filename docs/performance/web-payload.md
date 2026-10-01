# Web payload and authenticated runtime

This change separates the login/invitation bootstrap from the authenticated client,
and keeps the full NORMAL player unloaded until its surface first opens. Closing
that surface retains its mounted view and does not stop playback. Routes and
panels do not own the playback runtime. Authentication owns its lifetime: sign-out
closes socket, media-session handlers, reporters, timers, audio decks/graph and
capture; delayed work from that lifetime cannot change the next account. Account identity
changes replace the runtime even if both accounts are authenticated; discovery
warming also discards old responses before changing signals or account cache.

Stores are composed in `src/stores/index.ts` through typed domain ports. Their
public actions remain compatible. Audio is composed in `src/lib/audio.ts` from
transport, graph, mixer and capture modules; the existing transition, interruption,
levelling and podcast algorithms are retained. Pure state and visual preferences
cannot statically reach the audio/socket runtime. Boundary tests enforce this.

## Bundle budget

`web-payload-baseline.json` records the pre-change entry and static dependency
closure at `d608588`. `web-payload-after.json` records the production manifest's
bootstrap closure and its union with `AuthenticatedPlayer`. Both count JS/CSS,
excluding HTML, fonts, locale dictionaries, deferred routes and API. The CI gate
`node scripts/check-payload.mjs` requires at least 50% gzip reduction for login and
15% for the authenticated library, using gzip level 9. `--record` refreshes the
review artifact after the engine's automatic bundle update.

Build-time gzip/Brotli files remove request-time compression work. HTTP negotiation
keeps MIME types, representation-specific ETags, `Vary: Accept-Encoding`, and
identity byte ranges. Existing bundles without sidecars still work. API/media and
owner-token-injected desktop HTML do not enter the compressed asset path.

## Repeatable network measurement

Run the fixture against the baseline and current production dist, then:

```sh
PYTHONPATH=. .venv/bin/python docs/performance/payload_fixture.py --dist /path/to/baseline/dist --port 4181
PYTHONPATH=. .venv/bin/python docs/performance/payload_fixture.py --dist ui_web/dist --port 4182
cd ui_web
node scripts/measure-payload.mjs http://127.0.0.1:4181 http://127.0.0.1:4182 ../docs/performance/web-payload-network.json
```

Use separate terminals for the two fixture servers. To reproduce the old bundle,
use a detached worktree at the baseline revision and invoke `ensure_ui_dist` with
its `ui_web` path. The fixture never starts an engine or changes real user data.
Five fresh Chromium contexts per screen measure cold navigation and same-context
reload. Service workers are blocked in this measurement to isolate the HTTP cache;
request interception is avoided because Playwright interception disables caching.
The resource report separates JS, CSS, fonts, API, socket and other transfers.
`--constrained` records three repeats at 150 ms latency, 1.6 Mbit/s download,
0.75 Mbit/s upload and 4x Chromium CPU slowdown; conditions are stored in its JSON.
`ready_ms` waits for the navigation load event and the visible login/navigation
locator; it is not a first-paint or LCP measurement. It is a local laboratory
result, not an Internet or physical-device promise.

Measured local medians in `web-payload-network.json` (all resource response
transfers, excluding the navigation document):

| Screen | Before cold | After cold | Before warm | After warm |
| --- | ---: | ---: | ---: | ---: |
| Login | 971,243 B | 201,870 B | 636 B | 636 B |
| Library | 920,328 B | 262,408 B | 3,737 B | 3,737 B |

The old fixture serves the original bundle without sidecars; the new fixture
negotiates the actual generated Brotli variants. This measures the combined
bundle and HTTP improvement, while the manifest budget isolates gzip bundle size.
Cold local navigation-to-visible-UI medians were 72 -> 42 ms (login) and
78 -> 118 ms (library). The local library delay reflects the deferred authenticated import and is not
a device speed claim. The authenticated screen requests more small modules (22 vs 14 JS
resources), so constrained-network evidence is recorded separately.

At the recorded constrained conditions, cold visible-UI medians were
4,793 -> 971 ms for login and 4,837 -> 2,080 ms for library. Warm medians were
559 -> 441 ms and 565 -> 454 ms respectively. These are three repeats against
an empty-library fixture, recorded in `web-payload-network-constrained.json`;
they are not physical mobile or live-provider measurements.

## Bounded offline shell

The worker identifies each shell by a source-content build hash, pins only its
bootstrap resources, and activates only after the full bootstrap has been cached.
It retains the current and previous complete generations; each generation allows
at most 8 MiB of resource bodies and 256 resource entries, plus its small metadata
record. Optional resources are admitted only after use, with FIFO eviction and
oversize rejection. It adopts resources used before the first controller without
prefetching other routes. Account API responses, media, range requests and desktop
HTML are bypassed. Unrelated CacheStorage entries are never removed. Storage
failure leaves usable network responses intact. Worker/public/branding changes
invalidate the automatic production bundle.

The previous shell can reopen offline and use its previously visited chunks;
a first-time offline session exposes recovery without importing playback. Failed
native module loads can remain rejected in the browser's module map, including
across WebKit reloads. The bootstrap and NORMAL view each compile a distinct
recovery entry URL. Their first retry uses that entry; a further bootstrap retry
reloads the shell to recover stale deployments. A deferred view failure keeps
playback running and offers retry without reloading the page. Its recovery controls
sit clear of the floating player chrome.

Cached public shell/assets are matched independently of transport `Vary` headers
because their decoded content does not vary by Origin or compression. Account and
desktop responses never enter these caches.

## Acceptance boundary

Unit/server tests and the full Chromium/WebKit browser profiles cover existing
playback, queue, DJ, podcast, library, accessibility and route contracts. Production
startup tests exercise delayed/failed resources and Chromium offline reopening.
Playwright WebKit offline document navigation remains excluded because its browser
fails before returning the cached document; worker policy is independently tested.
Physical iPhone, Bluetooth and CarPlay acoustic acceptance remains a device check,
not a conclusion from browser automation.

Validated final bundle: 1,320 unit tests; full browser suites with 278 Chromium
and 269 WebKit passes (66/75 profile exclusions); production startup/PWA with
78 passes and 6 exclusions across the four profiles. Relevant Python checks and
`ruff check .` pass. Browser suites ran sequentially with one worker.
