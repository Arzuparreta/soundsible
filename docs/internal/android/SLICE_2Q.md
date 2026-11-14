# S2q: NORMAL autoplay owned by the service

Implementation and acceptance in progress; see HANDOFF for concrete results.

Preference source: GET/PATCH `/api/discovery/settings`, boolean field
`autoplay_enabled`; the engine enables it by default. Load with the current account and generation,
confirm the PATCH and keep errors. A response from another session can never
enable recommendations. Do not depend on WebView timers.

Product reference: `stores/dj.ts::ensureAutoplay` and
`lib/generatedQueue.ts::ensureAutoplay`. Plan intent `autoplay`, balanced profile,
lookahead eight; prepare only when two or fewer future manual requests remain,
refill when fewer than five recommendations remain. Seed: last future recommendation,
if it exists; otherwise last resolvable manual request, then the current one. Never
podcast, repeat other than off, Radio or DJ. Manual insertion has priority.

Keep sources/position/pause during prepare/refill. Disabling removes only
future autoplay occurrences and cancels worker/timer. Switching account, replacing or
closing the program invalidates responses; do not revive autoplay on an empty queue.
Bounded temporary retries, 401/403 without automatic retry, shared history/deduplication
and queue limits. Unavailable preferences are not equivalent to true.

Real HTTP/HTTPS tests: disabled preference keeps the exact queue, enabled
plans/continues; manual request threshold, priority append, repeat,
podcast, Radio, disabling, background/refill, close/account during a request.
Deterministic walkthrough fixtures must set their preference explicitly,
not modify the product default to protect historical assertions.

Before implementing, revalidate sources: the UI may have advanced since this
inventory. The PHONE/DJ/Live/Auto matrix and signing/release are still mandatory.

The service shares decoder, limits and retry with Radio, with separate intent and
occurrences. After a short batch it checks the threshold again: do not wait for another
player event to refill. Unknown or failed preferences do not enable
planning; the menu offers a reload. A failed write keeps the previous confirmed
preference and exposes an error. Switching Radio explicitly suspends autoplay
before requesting another plan, without deleting the preference. Account changes and
pending callbacks are guarded by serial/generation. The future seed does not modify
the current occurrence or position.

The three-dot menu of the program changes the real preference, without an optimistic
toggle. The queue distinguishes Autoplay from Radio. The autoplay profile is balanced; it
is not a DJ profile selector. Do not mark autoplay complete until also checking
podcasts, cancellation/account with a pending request and extended recovery.
