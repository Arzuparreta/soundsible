# iPhone / car playback-state experiment

Status: diagnostic implementation, **not a verified fix**. The normal player
remains the reference. Neither a successful `play()` nor `playbackState=playing`
proves what Now Playing, CarPlay or the head unit displays, or that sound reaches
the speakers. Device acceptance is still required.

## Evidence and hypothesis

The September 8 trip window (21:30–23:00 Europe/Madrid) contains 325 server
telemetry records, including 14 completed PWA handoffs. All handoff projections
declare playing with source and carrier active. At 22:27:27 an inactive source
play was rejected; at 22:30:45 a handoff completed, followed by in-app pause and
resume at 22:30:48–49. These are server receipt times, not client execution times.
The inactive-play event's `media_session` origin is inferred by the existing
code, not proof of a remote command.

The source deck being retired is paused but left unmuted; preload and volume
operations also leave idle elements unmuted. WebKit can select one of these
elements for platform controls even though the mixed carrier stays playing.
Its candidate comparator includes user-interaction recency; it does not always
prefer the playing element. Metadata and the selected element's playing state
can therefore disagree. This is a hypothesis about this incident, not proof
that the inspected WebKit revision matches the affected phone.

Source references pinned to the inspected WebKit commit:

- [Candidate selection](https://github.com/WebKit/WebKit/blob/ca3a9f205bcecd15c9d2ed0680acc25b56785109/Source/WebCore/html/HTMLMediaElement.cpp)
- [Element eligibility and Now Playing state](https://github.com/WebKit/WebKit/blob/ca3a9f205bcecd15c9d2ed0680acc25b56785109/Source/WebCore/html/MediaElementSession.cpp)
- [Metadata projection](https://github.com/WebKit/WebKit/blob/ca3a9f205bcecd15c9d2ed0680acc25b56785109/Source/WebCore/Modules/mediasession/MediaSession.cpp)

## Run a capture

1. Open **Settings → Playback → Car playback diagnosis** in the affected PWA.
   Enter the exact iOS version from the phone's settings and the car connection.
   Select Reference, Delayed retirement, or Muted retirement. Pause first; a
   variant cannot be changed during the capture. Start a new capture.
2. Start the same sequence of at least three tracks from its first song, then
   lock the phone. Use the same mode, tracks, transition and connection in each
   comparison. An observer records car state, audible playback and volume
   response without opening the phone at the transition. Record the transition
   number and approximate delay before failure; unlocking can change the result.
3. The marker buttons record **when the observation is reported**, not when it
   happened. They do not read the car. Opening Settings can itself unlock audio;
   `gesture.audio_unlock` and visibility events make that intervention visible.
4. Pause and finish, then **Export capture**. Export before starting another
   capture or reloading/closing the PWA. Records live only in this page's memory.
   An export during playback is allowed but does not stop the experiment.

The capture includes the chosen variant, a random capture ID, reported iOS
version, client wall-clock start, client monotonic timestamps and sequence
numbers. Production embeds a SHA-256 identity of UI sources, lockfile and Vite
configuration; development is explicitly marked unverified because HMR can
change its sources. This identity is not the server's Git SHA or an iOS build.

Raw events cover both decks and the carrier before active-deck filtering. Call,
return and promise-settlement events describe application play/pause/load calls.
Browser-internal operations only expose their resulting events. Source changes
are recorded without their URLs. Snapshots contain media flags, source presence,
position/rate, graph clock/state, active deck, phase and gain targets (not sampled
audibility). Media Session is read before sync and passively on media events.
Reads after sync remain declarations, never OS acknowledgments.

## Compare the variants

- **Reference:** current transport and retirement, with the same recorder active.
- **Delayed retirement:** after the normal handoff, hold the outgoing source at
  zero mix gain for eight seconds before pausing/releasing it. Preload and
  automatic next-transition preparation wait. A media-event clock also checks
  the deadline because background timers can be late. `retirement.release`
  records the actual execution and lateness. This requires the mixing graph;
  `retirement.delay_unavailable` means the comparison is invalid.
- **Muted retirement:** mute the source before retiring it, keep retired/preloaded
  sources muted, and unmute a source as it joins playback. Volume/mute changes
  preserve this experiment's exclusion. This is a candidate intervention, not
  a default fix or proof that the carrier owns the system session.

A new load, manual skip, cancellation or transport pause flushes a pending
retirement and discards its queued reuse. An early `retirement.release` means
that trial did not complete the intended eight-second hold. An outgoing `ended`
event before the deadline also invalidates the intended hold comparison. Do not
manually skip again within that window; use a transition with sufficient source
duration remaining when testing the delay. Do not count invalid trials as passes.

Run Reference → Delayed → Reference and Reference → Muted → Reference, repeating
each valid condition at least three times. Evidence for retirement as the trigger
requires the fault to move with delayed retirement, not merely disappear once.
Evidence for the muted candidate requires disappearance under the intervention
and return under the reference with matched conditions. Contradictory or missing
evidence leaves the cause unresolved. Compare the selection code with the actual
iOS/WebKit release before attributing a platform implementation defect.

## Acceptance and next change

The experimental variants stay opt-in until device evidence supports a fix.
If confirmed, promote the exclusion invariant in a separate reviewed change;
if not, discard it as the incident's solution. Do not replace the experiment
with periodic state assertions or automatic pause/play.

After a supported correction, verify five manual and five automatic transitions
for each of NORMAL and DJ over Bluetooth and wired CarPlay with the phone locked.
Observe sound, track identity, playing/paused state and volume response. Exercise
pause/resume from the car and lock screen, including a longer pause, without
recovering inside the PWA. Treat inability to resume as a separately measured
failure until evidence links it to retirement.

Unit tests cover recorder ordering/privacy/loss, promise lifetime, experimental
retirement cancellation, and inactive-source exclusion. Browser UI tests cover
capture controls/export only. Neither proves physical iPhone/car behavior.
