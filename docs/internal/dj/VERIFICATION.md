# Checking DIRECTION's blocking claims without listening

2026-11-15, against `main` at `f364bbdc`. [DIRECTION](DIRECTION.md) left two
measurements as the first step of its points 4.2 and 4.3, and named them as
what decides how many transitions any later control can reach:

- **4.2.** Does the iPhone's media clock really stall when `playbackRate`
  leaves 1, or does the `clock_starved` detector raise a false alarm there?
- **4.3.** Do the songs `rhythm.py` classifies as having no steady pulse
  really drift, or does their grid follow attack jitter in music produced to a
  constant tempo?

DIRECTION proposed answering both with a person: listening on the device with
a click pair, and marking songs by ear. This document answers what can be
answered from measurements alone, and lists what remains open because no
measurement here can settle it.

Both probes are read-only and print aggregates without song, session or
device identity:

- [rate_stall_probe.py](rate_stall_probe.py): the linked web capture.
- [pulse_straightness_probe.py](pulse_straightness_probe.py): a second pulse
  measure, its synthetic validation, and the library.

## 1. Rate changes on the iPhone (DIRECTION 4.2)

### Method

Every captured event carries a snapshot of both decks (`currentTime`,
`playbackRate`, paused, `readyState`) and the AudioContext's `currentTime`,
stamped with the page's monotonic clock. Between two snapshots of a deck that
keeps playing (no seek, pause, play, `waiting`, `stalled` or load of that
deck in between), a healthy element advances its media position by the
requested rate times the elapsed time. The shortfall is media time the element
did not deliver.

A late `currentTime` reading and a real loss of progress look the same in one
snapshot but not in the next ones. A late reading is corrected by a later
snapshot, and the shortfall returns to zero. A loss of progress stays: the
position remains behind the wall clock by the same amount for the rest of the
song. The AudioContext clock in the same snapshots says whether the output
device kept consuming samples meanwhile.

For each `ratechange` on a playing deck, the probe takes the last snapshot at
least 1 s before it and the first at least 3 s after it. "Leaving 1×" is a
change whose previous rate was exactly 1: the first write of a ramp.

The capture holds 2026-11-06 to 2026-11-15. The iPhone PWA (`ios-reported-18.7`)
captured on 2026-11-08, 09 and 11. The capture of 2026-10-30 that P16 used has
been rotated out.

### Results

| Platform, page | Rate changes leaving 1× | Media time lost (s) |
| --- | ---: | --- |
| iPhone PWA, hidden | 3 | 1.455, 2.380, 2.905 |
| iPhone PWA, visible | 0 | — |
| Desktop browser, hidden | 6 | max 0.026 |
| Desktop browser, visible | 7 | max 0.024 |

Over every rate write, not only the first of a ramp, the desktop has 1243:
median 0.005 s lost when the page is hidden and 0.000 s when it is visible;
the largest is one write of 0.317 s with the page visible. The iPhone has 6
rate writes: the 3 above and the 3 returns to 1 that the fallback made
immediately after.

- **The AudioContext ran.** Across these windows the AudioContext clock
  differs from the wall clock by at most 4 ms on the iPhone and 13 ms on the
  desktop. The output device kept consuming samples while the deck's media
  position did not advance.
- **The loss stayed.** After each of the three iPhone events, the next
  snapshots advance at 1.000 s of media per second of wall clock (for
  example 5.017 s of media in 5.018 s), without recovering the missing time,
  until the mixer's next seek of that deck 5–10 s later. A late reading would
  have been corrected by those updates; this is a loss of media progress.
- **A 0.25 % change was enough.** Each event was the first quarter-percent
  step of the outgoing deck's ramp (`rampOutgoing` in `mixer.ts`, phase
  `prepare`), to 0.9975 or 1.0025.
- **Steady playback on the same iPhone does not show it.** At 1× without a
  rate change, the iPhone played 13 183 s (9918 s hidden, 3265 s visible).
  28 snapshot pairs lost more than 0.25 s. 27 of them start within 1 s of a
  `play`, `playing` or `seeked` of that deck: the start transient that P16's
  follow-up describes (0.25–0.35 s, once). One, 0.34 s, came in the middle of
  a song. The largest loss outside a start is 0.34 s in 3.7 hours; each rate
  change lost 1.5–2.9 s.

### What this establishes

1. The `clock_starved` alarms that disabled rate control on the iPhone were
   not false alarms. In all three, the element's media position fell 1.5–2.9 s
   behind the wall clock within seconds of the first `playbackRate` write and
   never recovered, while the AudioContext ran on time. Each loss is more than
   five times the 0.25 s threshold of the detector, so it would have fired with
   or without the two-window confirmation of P16's November 7 follow-up.
   DIRECTION's caveat about which detector the station was running does not
   change the result.
2. Desktop browsers in the same captures, running the same mixer code,
   show none of it. The loss belongs to the iPhone's renderer, not to the
   mixer's arithmetic.
3. It agrees with the capture of 2026-10-30 in P16: "loss of approximately
   one second of progress during speed changes".

### What remains open

- **What the listener heard.** A media element that does not advance does not
  deliver that stretch of the song. Whether it came out as silence, as slowed
  audio or as a mixture is not measured. The pre-fader meter is a single
  256-sample reading per event. At the alarm it read digital silence on the
  active deck in two of the three events and 0.26 RMS in the third.
- **Page visible.** All three events happened with the page hidden (screen
  locked or another app in front). No rate change was ever captured on the
  iPhone with the page visible: n = 0.
- **Later writes, and writes while paused.** After the first loss, the mixer
  disables rate control for the audio runtime, so the iPhone never executed a
  second write on a playing deck. It also never played a deck whose rate was
  set while paused (the incoming deck is returned to 1 by the same fallback).
  It is not known whether either variant also loses time.
- **Other iOS versions.** All captures are iOS 18.7.
- **Android.** Outside the web capture; nothing here applies to it.

These gaps decide between DIRECTION 4.2's branches more finely than "stall or
false alarm". The false-alarm branch is excluded. The real-stall branch holds
for the case the DJ hits on the iPhone: the outgoing deck ramping with the
page hidden. Whether `<audio>` with a variable rate is unusable on iOS in
every case, which is what would make the PCM engine the only route, depends
on the open variants above.

A measurement that would close them without listening: a page on the iPhone
that plays a click track through `<audio>` into an AudioWorklet that records
the PCM it receives, changes the rate on a schedule (first write, later
writes, a rate set while paused), and counts missing clicks and gaps per
write, once visible and once with the screen locked. It needs a person to
open the page on the iPhone and lock the screen, but nobody needs to listen.
It is not built here.

## 2. Is the "not steady" half drifting? (DIRECTION 4.3)

### A second measure

[pulse_straightness_probe.py](pulse_straightness_probe.py) shares no code,
model or constant with `rhythm.py`. It does not track beats. From a band-wise
onset envelope (24 bands, 2.9 ms frames), it folds the song over one beat
cycle into a mean pattern of attacks, and locates each 16-beat stretch
(4-beat hop) against that pattern by circular cross-correlation. All attacks
of the cycle count, off-beats included, so the jitter of single hits
averages out. A straight line through the stretch offsets is the best
fixed-rate grid. The result is the distance from it, in ms: the median over
the window, and the largest within 16-bar spans (the length of a 16-bar
overlap). Songs up to 480 s are read whole and longer ones in the
analyser's two windows (`store.py`), keeping the worse of the two as the
analyser does.

### Validation on signals with known beats

Kick and snare on the beats, hats on the eighths, a held chord, 180 s.
"Jitter" displaces every hit independently by N(0, σ). "Tempo ±d every c"
swings the tempo sinusoidally. The true distance is that of the generated
beat times from their own best line. The last column runs the real analyser
(`shared.dj.store._analyse_pcm`, Beat This! and `rhythm.py`) on the same
signal.

| Signal | True median / max (ms) | Measured median / max (ms) | Analyser `tempo_confidence` |
| --- | --- | --- | ---: |
| Constant 120 BPM, jitter 0 ms | 0.0 / 0.0 | 0.0 / 0.1 | 1.00 |
| Constant, jitter 5 ms | 0.0 / 0.0 | 0.9 / 2.7 | 1.00 |
| Constant, jitter 10 ms | 0.0 / 0.0 | 1.9 / 5.7 | 1.00 |
| Constant, jitter 15 ms | 0.0 / 0.0 | 2.8 / 8.6 | 1.00 |
| Constant, jitter 20 ms | 0.0 / 0.0 | 3.6 / 11.7 | 1.00 |
| Tempo ±0.2 % every 60 s, jitter 10 ms | 13.5 / 19.2 | 12.8 / 21.1 | 0.60 |
| Tempo ±0.5 % every 60 s | 33.9 / 47.9 | 32.6 / 48.1 | 0.60 |
| Tempo ±1.0 % every 60 s | 67.8 / 95.9 | 67.0 / 95.6 | 0.60 |
| Tempo ±1.0 % every 20 s | 22.5 / 32.0 | 23.7 / 31.7 | 0.60 |
| Tempo ±2.0 % every 60 s | 135.0 / 191.4 | 60.6 / 111.9 | 0.60 |

The measure reads constant tempo as straight within 3.6 ms median at 20 ms of
per-hit jitter, and drift within about 2 ms of the truth up to ±1 %. At ±2 %
the pulse moves too far within one 16-beat stretch and the measure reads
about half of the truth, still 17 times its reading of the jittered
constant-tempo signal. Its error at that size is an underestimate.

The analyser is right on all ten. Per-hit jitter up to 20 ms does not make
`rhythm.py` call a constant tempo unsteady (`tempo_confidence` 1.00, above
`STEADY_PULSE` 0.6), and a drift of 19 ms from the line is already rejected.
On these signals, the hypothesis that the grid follows attack jitter does
not hold.

### The library

662 of the 899 songs analysed with a pulse at `ANALYSER_VERSION` 12 have
their file on this station (the others are previews no longer cached); all
662 were measured. Distances in ms:

| Analyser class | Songs | Median over the window: p25 / median / p75 | Largest in a 16-bar span: median | Window median ≤ 12 ms |
| --- | ---: | --- | ---: | ---: |
| Steady (`tempo_confidence > 0.6`) | 291 | 1.2 / 2.0 / 4.3 | 5.4 | 263 (90 %) |
| Not steady | 371 | 28.7 / 46.7 / 64.7 | 131.3 | 59 (16 %) |

12 ms is `rhythm.py`'s own wander tolerance (`_CONSTANT_WANDER`), used here
only to count. The two measures agree on 575 of the 662 songs (87 %).

The measure's clarity (the correlation of a stretch's pattern with the song's
pattern, 0–1) separates two kinds of "not steady":

| Not steady, clarity | Songs | Window median (ms) | Within 12 ms |
| --- | ---: | ---: | ---: |
| ≥ 0.9 | 81 | 30.2 | 30 |
| 0.8–0.9 | 68 | 44.8 | 14 |
| 0.6–0.8 | 78 | 54.3 | 6 |
| < 0.6 | 144 | 49.2 | 9 |

For comparison, 241 of the 291 steady songs have clarity ≥ 0.9.

### What this establishes

1. Attack jitter does not explain the split in general. On signals with
   known beats the analyser accepts 20 ms of per-hit jitter as steady. In the
   library, an independent measure finds the "not steady" songs tens of ms
   away from any straight grid (median 46.7 ms), against 2.0 ms for the
   steady ones.
2. 149 "not steady" songs have a clearly repeating pattern (clarity ≥ 0.8),
   and 105 of them still move more than 12 ms from a straight line. For
   those, two independent measures agree that a fixed rate cannot hold the
   pulse. The cause may be a performance without a click or a tempo change
   between sections; in both cases one fixed rate does not hold it.
3. 144 "not steady" songs have no clear repeating pattern (clarity < 0.6).
   There, this measure's offsets are not reliable either; what both measures
   share is that neither finds a straight pulse to hold.
4. Upper bound of what correcting `rhythm.py` could recover: the 59 songs
   (16 % of "not steady", 9 % of the measured library) that the second
   measure finds straight. If all of them became steady, the steady share
   would rise from 44 % to 53 % of the measured songs. The share of random
   pairs with both songs steady would rise from about 19 % to about 28 %.

### What remains open

- **Who is right on the 87 disagreements.** 59 "not steady" songs look
  straight to the second measure, and 28 "steady" songs are more than 12 ms
  off a straight line by it (the second kind would be beatmatched while
  drifting). Both measures are validated on synthetic signals and neither
  has a ground truth on real recordings. A third opinion would be the
  session file or tempo map of the production, which this library does not
  have.
- **Why the analyser rejects them.** `rhythm.py` combines three tests
  (wander, local tempo, share of beat weight) and stores none of them. Telling
  which one fails needs the analyser's intermediate values for those songs,
  which is a code change to the analyser or a probe that re-runs it.

DIRECTION 4.3's question was whether many songs are misclassified. The
answer is: not most. At most about one in six, and only if the second
measure is the one that is right on those 59. The other branch of 4.3
therefore applies to most of the library: the transition that is heard most
is the non-beatmatched one, and its quality is the product question.
