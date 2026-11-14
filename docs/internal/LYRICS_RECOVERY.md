# Lyrics recovery

The player keeps a lyrics lookup open for up to one minute. It polls an active
engine job and, if that job reports the provider unavailable, starts another
after 2, 4, then 8 seconds, with up to 250 ms of jitter. Further waits remain at
8 seconds. Temporary transport failures use the same recovery window;
authentication, permission and missing-track errors stop immediately.

The first pending poll retains its previous 750 ms delay. Subsequent polls
wait 1.5 seconds, staying below the metadata endpoint's 60 requests/minute limit.
Ready lyrics, instrumental tracks and genuine not-found answers return at once.
The one-minute timer covers requests, polling and backoff together, and aborts
an in-flight request when it expires. A continuous outage then shows the
existing unavailable message and manual retry button.

Changing song, closing the panel or replacing the account cancels client work.
The engine's existing short jobs, two dedicated lookup slots, single-flight
keys, cache and zero-backlog policy are unchanged. Its slots are free between
completed jobs while the client waits; one listener's recovery does not reserve
a slot for the entire minute. Already running server work retains its existing
short allowance after client cancellation.

This policy lives in `ui_web/src/lib/lyricsLookup.ts`, used by the shared
`LyricsPanelView` for the web, desktop shell and Android UI. It introduces no
new API contract, dependency, queue, scheduler or provider integration.

## Why recovery was extended

The previous player stopped at the first `unavailable` response. The engine
already retried LRCLIB's 503/429 answers within its short lookup allowance, but
an extended overload could reject every attempt in that job. The original fix
was [PR #369](https://github.com/Arzuparreta/soundsible/pull/369); it was still
unchanged when this improvement was measured.

LRCLIB's maintainer described its 503 responses as
[global overload rejection](https://github.com/tranxuanthang/lrclib/issues/130#issuecomment-6522399481),
and separately reported a
[failed migration and damaged database](https://github.com/tranxuanthang/lrclib/issues/138#issuecomment-6554255725).
Longer recovery can obtain lyrics when capacity returns; it cannot repair the
provider or guarantee success during a sustained outage.

## Measured improvement, 2026-11-02

[Recorded results](measurements/lyrics-recovery-2026-11-02.json) contain ten
selected real songs, requested sequentially from one machine and network. The
production resolver ran behind isolated Flask library routes with disposable
runtime directories, using live LRCLIB. The final TypeScript `lookupLyrics`
called the metadata route without persisting lyrics. No user database or
playback session was used.

Each lookup was observed at its **first completed engine job**, where the old
player would have stopped, and then continued through automatic recovery. This
paired method avoids warming a query in a separate before/after run:

- Five of ten first completed jobs supplied lyrics; five reported unavailable.
- Automatic recovery obtained lyrics for all ten in this sample.
- The five recovered queries took 11.1, 12.7, 14.2, 41.5 and 56.4 seconds in
  total. Two would still have been missed by a 30-second window.
- Responses during the final sample included explicit LRCLIB
  `503 ServerOverloaded` answers. The resolver itself was unchanged.

These observations demonstrate recovery of actual failures, not a claim of
100% availability elsewhere. In an earlier exploratory run, one song remained
unavailable for the full minute. Results depend on the provider's condition.

## Repeatable verification

`npm test` covers an eight-second failed engine job followed by recovery, with
API latencies of 0, 300, 1,500 and 4,000 ms. It also covers slow transport
timeouts, continuous outages, a fully busy engine, cancellation, late answers,
permanent errors, manual retry and stopping at the shared deadline. These tests
use controlled time rather than depending on the developer's connection.

The complete browser suite runs in Chromium and WebKit, mobile and desktop.
Its lyrics test opens the real panel and serves `unavailable → pending → ready`
without a retry click. API fixtures are scoped to API URLs so that they cannot
intercept the new source module in Vite's development server.

No physical network-speed, Android-device or iOS acceptance is inferred from
these tests. The web/Android shared panel is covered by the existing UI suite;
the separate Swift iOS client is outside this change.
