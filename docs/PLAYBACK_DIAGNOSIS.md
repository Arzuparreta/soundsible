# Automatic iPhone / car playback evidence

Status: candidate iOS output and source-retirement correction, **not a device-verified fix**. Collection remains automatic. Neither a successful `play()` nor `playbackState=playing`
proves what Now Playing, CarPlay or the head unit displays, or that sound reaches
the speakers. Device acceptance is still required.

## CarPlay cable disconnect/reconnect recovery

The September 17 device report rejects the previous correction (#197): unlocking
with the phone disconnected still starts music, and reconnecting can leave the
source advancing without sound. The changes below address gaps in that approach;
physical iPhone/PWA/car acceptance is still pending.
The listener reports Safari PWA on iOS 27 with wired CarPlay. The user-agent
version in the traces is not an independently verified OS version.

On September 13 (Europe/Madrid), the same capture paused at 14:54:24 and received
Media Session Play at 14:59:22. The source advanced from 162.301 to 171.729 seconds,
while the AudioContext clock remained exactly 191.147 seconds despite reporting
`running`. In-page pause/play did not move the context clock. A new capture began
at 15:00:53. This fits the reported stop-and-reconnect failure; the traces cannot
identify the physical route or measure the speakers.

At 15:32:01 a native pause and Media Session pause were followed by native
play/playing without an intervening application play call. On September 15 at
14:24:19 a separate sequence included Media Session pause followed by Play.
Media Session does not identify whether Play came from a physical button or
platform behavior. The correction continues to accept those commands; there is
no arbitrary suppression window for car controls.

Playback permission is now separate from native element state. A native programme
pause stops all DJ participants and invalidates pending transport work. Native
play without permission is stopped. Context state changes, page restoration and
generic touch events cannot lift a pause. A platform context interruption now
also revokes permission, even if the source still claims to play. Restoration
reads native state before queued events arrive, and a queued native pause is
honored even if iOS has already restarted the source. Returning to a healthy,
still-playing session does not pause it. There is no resume from visibility,
page thaw, or a generic gesture; deliberate Play remains available while locked.

On iOS direct output, every explicit transport Play renews the existing context
with a bounded suspend/resume cycle and a silent session-prime buffer before
restarting the current source. This also covers a lost output with advancing
clocks, which the clock supervisor cannot detect. It preserves position, gain,
and Live capture. This cycle runs on Play, not on cable removal or page return.
The platform still selects the physical output: the web app cannot verify that
a running context is reaching the car. A successful cycle is not acoustic proof.

A supervisor compares source progress with the context clock. One second of
continuous observations with a frozen context and an advancing source starts
one in-place suspend/resume cycle. Observation gaps above one second, seeks,
source changes and unavailable source data reset the measurement. Signal level
is not used, so musical silence is not a failure. The cycle preserves the graph,
Live tap and current programme owner; failed recovery leaves playback paused
with the existing Play prompt. Async recovery is limited to five seconds when
JavaScript can execute, and a new explicit Play permits another attempt.
The `output.health` trace records recovering/healthy/needs_play; spontaneous
source revivals are recorded as `transport.rejected_native_play`. Both use the
existing trace envelope and field allowlist.

The in-place cycle is a candidate informed by the measured frozen clock and
[WebKit reports](https://bugs.webkit.org/show_bug.cgi?id=276016#c7), not proof of
recovery on the affected iPhone. Repeat these checks for NORMAL and DJ playback,
with wired CarPlay and Bluetooth:

1. Start music with the iPhone locked and the car on. Disconnect while it plays;
   unlock with the PIN while still disconnected. Music must stay paused through
   page return and unrelated taps until explicit Play.
2. While locked and playing, disconnect and reconnect the output (including a
   brief cable contact loss). Press Play on the car and, separately, in the PWA.
   Sound must return to the car at the retained position without closing the PWA.
3. Lock and unlock without an interruption: music must continue. Check both
   unplug/power-off orders, repeated reconnects, and Play/Pause during a DJ blend.
4. Pause or select another song during output renewal. The cancelled work must
   not restart the previous song. Confirm Live capture survives a successful cycle.

Automated tests cover intent, delayed events, output renewal with advancing
clocks, cancellation, deadlines, deck identity and Live preservation. They do
not emulate the iPhone audio session or establish speaker output.

## Evidence and hypothesis

The September 9 trip confirmed by the listener (21:14–21:20 Europe/Madrid)
has 548 received events, no internal sequence gaps and no reported loss. All
recorded media rates are one. At 21:17:34, pausing the outgoing source changes
the observed Media Session declaration from playing to paused; the incoming
source and carrier keep playing. The application republishes playing about
41 ms later. This measures browser observations, not the head unit's delay.

During 33 stable foreground intervals, the context/wall clock median is
0.996618, while source and carrier positions advance at approximately one
second per second. Two other iPhone sessions and desktop sessions have medians
near one. The listener reports normal sound outside the car; the browser does
not identify the physical output route.

WebKit's [AudioSampleDataConverter](https://github.com/WebKit/WebKit/blob/ca3a9f205bcecd15c9d2ed0680acc25b56785109/Source/WebCore/platform/audio/cocoa/AudioSampleDataConverter.mm)
adapts a low buffer with 1.05 output resampling, entering at 20 ms and leaving
above 60 ms. With the observed clock ratio, a simplified buffer model predicts
11.8 seconds of normal playback and 0.86 seconds of correction. This closely
matches the reported periodic slowdown/pitch drop, but does not establish the
exact WebKit build or converter activity on the phone.

The candidate removes the MediaStream carrier from iOS/iPadOS device output:
the mixed monitor connects directly to the AudioContext destination. The
reported mode is `direct`, distinct from a carrier failure's `direct_fallback`.
Gestures cannot switch intentional direct output back to the carrier. The Live
stream tap remains independent, upstream of local volume and mute. Other
platforms retain their carrier path.

Source eligibility is tracked independently of gain: empty, staged and retired
decks stay muted; an incoming deck is unmuted before play, including zero-gain
preroll. Both sources participate during a blend. Retirement mutes before
pausing, while the canonical paused source remains eligible for resume. Volume
changes and completion of an old unlock sample cannot unmute an idle source.
Settled source operations and inactive native events trigger a coalesced
microtask publication of canonical state, including in the background. This
does not issue play commands or claim ownership of iOS's selected element.

Physical acceptance requires matched songs on the same iPhone/car: at least
five minutes of steady playback without periodic pitch dips, multiple automatic
and manual transitions in foreground and with the screen locked, car pause/play,
and correct title/state without unlocking. Compare the reference and candidate;
do not equate an improved clock ratio or passing tests with audible acceptance.

### Earlier evidence

The September 8 trip window (21:30–23:00 Europe/Madrid) contains 325 server
telemetry records, including 14 completed PWA handoffs. All handoff projections
declare playing with source and carrier active. At 22:27:27 an inactive source
play was rejected; at 22:30:45 a handoff completed, followed by in-app pause and
resume at 22:30:48–49. These are server receipt times, not client execution times.
The inactive-play event's `media_session` origin is inferred by the existing
code, not proof of a remote command.

Before this correction the source being retired was paused but left unmuted;
preload and volume operations also left idle elements unmuted. WebKit can select one of these
elements for platform controls even though the mixed carrier stays playing.
Its candidate comparator includes user-interaction recency; it does not always
prefer the playing element. Metadata and the selected element's playing state
can therefore disagree. This is a hypothesis about this incident, not proof
that the inspected WebKit revision matches the affected phone.

Source references pinned to the inspected WebKit commit:

- [Candidate selection](https://github.com/WebKit/WebKit/blob/ca3a9f205bcecd15c9d2ed0680acc25b56785109/Source/WebCore/html/HTMLMediaElement.cpp)
- [Element eligibility and Now Playing state](https://github.com/WebKit/WebKit/blob/ca3a9f205bcecd15c9d2ed0680acc25b56785109/Source/WebCore/html/MediaElementSession.cpp)
- [Metadata projection](https://github.com/WebKit/WebKit/blob/ca3a9f205bcecd15c9d2ed0680acc25b56785109/Source/WebCore/Modules/mediasession/MediaSession.cpp)

## Listener workflow

Play music normally. No settings, experiment selection, markers, export, or
computer connection is required. Collection begins after authentication when the
player loads. The running server must contain the trace endpoint and the player
must have loaded these sources; an already-open old page cannot be instrumented
retroactively. A normal subsequent opening loads the current player.

## Automatic collection and delivery

- Each page session has a random capture ID, source fingerprint, existing device
  ID, client start time and strictly increasing sequence with monotonic elapsed
  milliseconds. The iOS version is inferred from the user agent and explicitly
  marked as reported, not an exact verified OS build. Connection type and the
  car's display are not exposed to the web app and are not invented.
- Records cover source/carrier native media events, source changes, play promise
  outcomes, pause/load calls, context state, gesture unlock, transport origin,
  retirement, and Media Session before/after publication. Snapshots include all
  observed elements, mute/paused/readiness/position, source category, mix state,
  gain targets, and local volume. No media URLs, names, artwork or audio.
- Healthy time updates are sampled every five seconds per element; for ten
  seconds around a handoff they are sampled up to four times per second. Native
  pause/play/load/error events are not sampled away. Background execution can
  be suspended by iOS; the recorder does not claim a timer always runs.
- Events are batched and committed to IndexedDB within one second (or when a
  batch fills), sent every five seconds and on lifecycle/online events. Requests
  use keepalive and bounded bodies. An unacknowledged batch survives reloads and
  is retried with backoff. Delivery order can differ from execution order; the
  report uses capture ID and sequence, not receipt time.
- The server commits each batch in an account-local SQLite database before
  acknowledgement. Batch IDs deduplicate retries. A mismatched authenticated
  account is rejected. Browser outboxes are also partitioned by account.
- The browser prunes its outbox to 16 MiB / 8,192 batches / seven days on each
  delivery cycle (normally five seconds, including offline cycles); the server
  retains at most 64 MiB of payload / 32,768 batches for seven days, whichever
  limit is reached first. SQLite may occupy additional space for indexes and
  reusable pages. Browser storage refusal falls back to bounded memory; a sudden
  process kill may lose events not yet committed. Loss counters and sequence
  gaps are evidence limitations, not successful delivery.
- `SOUNDSIBLE_TELEMETRY_ENABLED=0` disables server storage and the acknowledgement
  stops this page's recorder, clearing its pending account outbox.

## Operator analysis (the listener does not run this)

The authenticated user's server directory contains
`telemetry/playback-traces.sqlite3`. The agent can read it directly:

```sh
python scripts/playback_trace_report.py /path/to/user/telemetry/playback-traces.sqlite3 --since 2026-09-08T21:30:00+02:00
```

The report groups captures/device/revision, prints loss and sequence gaps, and
extracts two seconds before / ten seconds after handoffs and transport commands.
It also compares context and source clocks against client monotonic time in
stable intervals, grouped by output mode and visibility. It excludes observed
transport operations, pauses, seeks, rate changes, transitions and sequence
gaps. At least three usable intervals are required; a clock ratio is not a
measurement of audible pitch. This works with both direct and carrier output.
It also identifies declared non-playing state while media position advances.
That flag is an observation for investigation: seeking or an inactive source can
also advance position. It is not proof of the car's state or audible output.

A raw inactive-element `play` without a preceding application `call.play` or
`media_session.action` is distinguishable from an app-issued operation. It does
not by itself identify the origin as the car. Unlock samples are distinguished
from real source tracks and the mixed stream. Correlate the outgoing source's
pause/unload and the incoming/carrier progression with subsequent commands and
recovery; never interpret a read-back of `playbackState` as OS acknowledgement.

## Validation boundaries

Unit/backend tests cover observation ordering, original promise behavior,
privacy filtering, validation, durability, deduplication, account mismatch,
storage failure and retention. Browser tests cover automatic startup, IndexedDB
retry across reloads, account separation, and telemetry opt-out. These do not
reproduce iPhone/Toyota arbitration. The historical trip cannot be reconstructed
at this detail from the older server logs. No physical-device fix is claimed.
