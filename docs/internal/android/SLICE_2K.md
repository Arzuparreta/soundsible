# S2k: first podcast vertical

## Result it must demonstrate

From the account's subscriptions, open episodes and play one with the same
Media3 as the NORMAL programme. Pause, skip forward/back fifteen seconds, reopen the
activity and continue from real progress. An acquired copy and the streaming of the
same enclosure must share progress. This vertical is implemented and validated; the results are in
[evidence/s2k.json](evidence/s2k.json). Directory, following and complete
acquisition remain pending to close podcasts.

## Verified references

- `ui_web/src/mobile/AndroidStart.tsx`: refresh transforms tracks with
  `musicLibraryRows`; keep acquired episodes and subscriptions separate.
- `ui_web/src/lib/api.ts`: LibrarySnapshot, getPodcastEpisodes, browsePodcastFeed,
  podcastPeek and subscribe/unsubscribe; use the native transport already installed.
- `ui_web/src/lib/track.ts`: podcastEpisodeToTrack keeps GUID, feed and enclosure.
- `ui_web/src/lib/podcastProgress.ts`: web progress contract; maximum 500,
  completed ones go back to zero, enclosure identity first and feed/GUID after.
  Do not import `stores/podcasts.ts`: it depends on web audio.
- `shared/api/routes/podcasts.py`: POST enclosure/peek mints a token; GET stream/token
  validates the URL, forwards Range and delivers the provider's status/headers. Test these
  real routes; never send the session cookie to the enclosure.
- `shared/podcast_preview_token.py`: signed token with TTL; do not confuse it with an
  episode ID or occurrence UUID.
- `ProgramQueue.kt`: local/preview and maximum id 512 currently. A GUID/enclosure
  requires its own descriptor; do not widen the video regex to introduce URLs.
- PlaybackService/PlaybackPlugin and `lib/program/runtime.ts`: a single audio owner,
  commands and snapshots guarded by generation, occurrence and queue token.

## Implementation in order

1. Inventory real podcast sources and acquisition; keep music and episodes
   distinguished in the library snapshot. Add show/episode navigation
   reusing shared rows/texts, with empty, loading and Retry states.
2. Define a typed and bounded podcast descriptor. Native mints/validates the token through
   the API of the verified origin and builds its internal URI. Do not receive an arbitrary audio URL
   through the bridge. Validate everything before replacing the programme; reject
   remote episodes without a session even if a music offline profile exists.
3. Persist private progress per origin and confirmed account. Stable enclosure
   identity, feed/GUID fallback; never token/occurrence. The service saves during
   playback/background and on pause/seek/change/end. Limit records, clamp to the known
   duration, tolerate damaged storage. On completion, selecting starts from zero.
4. ±15s commands on the player's looper with its real positions; zero/
   duration limits and seekable availability. The UI shows confirmed state, without estimating
   the final position from an old snapshot. Consistent remote controls.
5. Token expiration and preparation: bounded renewal only for the current occurrence/
   generation, keeping position and pause intent. Logout, new
   account, new episode and closure invalidate any pending resolution. Do not turn
   every 403 into an infinite retry; distinguish session revocation from an expired token.
6. A disposable fixture replaces only the external RSS/enclosure; parser/token/proxy/
   Range/roles remain real. Use synthetic audio and an audit without credentials.
   Do not weaken production SSRF to accept the fixture's localhost.

## Acceptance required to close

- Unit: streaming/acquired joins, origin/account isolation, progress limit/validation,
  completion, cancelled renewal and out-of-order commands.
- Python: real feed/episodes and proxy, Range 206 and headers, invalid/expired token,
  account/roles, absence of cookie to the provider and closure of the upstream reader.
- APK over HTTP and verified HTTPS: subscription → episode → native audio; resume,
  ±15s, pause during preparation, recreation/background, alternated account and closure.
- Full integration with S1–S2j/S6a preserved; explicit reset of the synthetic cache
  before tests that require cold sources, without weakening their assertions.
- Whole npm test and four browser profiles before the cumulative PR. Normal APK without
  fixture CA, clean HEAD metadata, verified debug signature, evidence and handoff.

## Outside this first vertical, still required for parity

Directory/search, follow/unfollow, acquisition and complete podcast actions
are counted explicitly in the matrix according to what is actually validated. Offline B
covers only acquired music: do not introduce an implicit podcast copy. External
covers require the corresponding secure transport, without cookies to RSS hosts.

Radio is NORMAL music recommendations: see `startRadio` in stores/dj.ts and
GeneratedQueueController. Audit after podcasts; keep the seed in playback
without restarting, manual insertions and reliable planning in background. Do not create
a station directory as a substitute. DJ/Live/Auto and signing/update
remain independent gates; this vertical does not enable alpha or merge.


## Implemented contract

`ProgramTrack.source=podcast` distinguishes an enclosure from a video preview. JS delivers
bounded identity and metadata; native mints an authorized token via POST and builds
the proxy of the verified origin. Each open/range uses a new token, without storing
provider audio URLs or credentials in snapshots. An open can
reuse the DataSource after close; cancellation of an occurrence does invalidate it.
Peek and bodies are cancelled on closure/account/occurrence. Network/503 failures keep
position and pause intent and offer an explicit Retry; there is no infinite replay.

The service saves progress every five seconds and on events/seek/pause/closure,
with a maximum of five hundred episodes across profiles. Origin/confirmed account are obtained
from the native profile. The enclosure hash and feed/GUID alias join streaming and acquired;
a local copy without an enclosure can also read/write that progress. Completion is preserved
when removing an item whose duration was already lost; going back resets it.
±15s is computed on the looper from the real position, with clamp; remote Media3
controls have the same increments. The whole timeline is not persisted yet.

PodcastBrowser keeps subscriptions and acquired episodes separate from music.
It opens real feeds, refresh/pagination, Retry and playback of an episode. The engine's Acquired
keeps feed/GUID and RSS, not the enclosure: it is joined by that provenance and only
the playback descriptor is enriched from the RSS. The row communicates acquired
with the shared text Downloaded; it does not imply an offline copy on the phone.
Account/teardown invalidate pending responses. External covers use a placeholder.

The fixture replaces only the I/O of a reserved public hostname with a localhost
provider; the real SSRF rules, parser, tokens and proxy remain. Synthetic AAC/MP4 audio
with Range, an audit without cookies, a controlled peek 503 failure and a synthetic acquired
copy test different contracts. Creating the copy in the fixture does not
yet test the acquisition pipeline. The production proxy now closes its upstream
Response when the reader finishes/is cancelled or when headers/status fail.

Directory, follow/unfollow and complete acquisition/progress/errors are the next
podcast extension. Radio is still pending; none of these cuts closes the
full matrix or authorizes publishing a partial alpha. Results and metadata are recorded in HANDOFF and evidence/s2k.json.
