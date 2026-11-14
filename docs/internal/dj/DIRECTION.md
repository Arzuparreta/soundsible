# DJ mode: where it stands and where to take it

2026-11-13, against `main` at `cd443d6f`. An analysis, not an implementation:
no code path, measure or plan changes here. It answers three questions from
the owner: what else does this, how far the current code scales, and what to
build first so that user-facing DJ controls rest on something known to work.

The numbers in *What the listener actually gets* come from this station's own
analysis cache and from the linked web capture of [SESSION_CAPTURE](SESSION_CAPTURE.md).
They are reproducible with [direction_probe.py](direction_probe.py), which
opens both databases read-only and prints no song, session or device
identity. They describe one library and one listener's sessions between
2026-10-30 and 2026-11-12. They are not a general benchmark.

## Summary

1. No streaming product does the whole of what Soundsible's DJ does (choose
   the songs, order them for the seams, and mix them with a technique chosen
   per pair). Apple and Spotify mix a queue the listener already chose. The
   closest in behaviour are DJ applications (djay, DJ.Studio), which are not
   music players.
2. The pure planning code scales. The limits are elsewhere: session logic
   exists twice (web and Android), a technique is a name hard-coded in three
   places, and five entry points order music with different policies.
3. In captured sessions, **63 % of transitions between two analysed songs
   were planned as a plain structural fade, 29 % as a beatmatch, and on the
   iPhone none of the 24 planned beatmatches was executed as one.** On the
   desktop browser 15 of 16 were.
4. Recommendation: before designing controls, (a) make "what was executed"
   a standing per-platform figure, (b) restore beatmatch on the iPhone,
   (c) decide what the DJ does with the half of the library whose pulse is
   not steady, (d) turn the plan into a declarative contract with one policy
   object. Controls are then fields of that object. Until (b) and (c) are
   settled, most controls would change nothing audible in most transitions.

## 1. Who else does this

Checked on 2026-11-13 against the vendors' own pages where they exist; the
internals of Apple's and Algoriddim's systems are not published.

| Product | Chooses the songs | Orders for the seams | Mixes | What the user controls |
| --- | --- | --- | --- | --- |
| Apple Music AutoMix (iOS 26, 2025; iOS 27 beta, 2026) | No: the listener's queue | No | Time stretch and beatmatch when it judges the pair suitable, otherwise crossfade or silence removal. iOS 27 beta adds remixed intros/outros and repeated sections | One setting: AutoMix, Crossfade or off |
| Spotify playlist *Mix* (beta since 2025-08, desktop 2026-05) | No: a playlist the user owns | No; it shows BPM and Camelot key so the user can | *Auto*, presets (*Fade*, *Rise*), or hand-edited volume, EQ and effect curves at a point chosen on a waveform with beat data | Every transition, saved with the playlist and shareable |
| Spotify AI DJ | Yes | No | No: ordinary playback with spoken commentary | Requests |
| Algoriddim djay, Automix | No: a queue or playlist | No | Detected intro/outro points, tempo sync, a transition style: Automatic, Fade, Filter, EQ, Echo, Dissolve, Neural Mix (real-time stems) | Style and duration. Staff state that how mix points are found cannot be customised |
| DJ.Studio, *Harmonize* | No | Yes: BPM and Camelot key with a slider between the two; flags incompatible neighbours; *Solve* searches the library for a bridge track | Offline, on a timeline, at phrase boundaries; stems | Everything; it is an editor |
| Mixxx Auto DJ (open source, GPL) | No | No | Crossfade sized from intro/outro cues. Its own documentation says it considers neither rhythm nor frequency content | Fade mode and length |
| YouTube Music, Tidal, Deezer | — | — | No beatmatched automatic mixing found | — |

Published research worth knowing: Bittner et al., *Automatic Playlist
Sequencing and Transitions* (ISMIR 2017, Spotify); Vande Veire and De Bie,
*From raw audio to a seamless mix* (EURASIP 2018), an automatic DJ restricted
to drum and bass; Kim et al., *A Computational Analysis of Real-World DJ
Mixes* (ISMIR 2020), which measures what human DJs do with tempo, cue
placement and overlap length; Chen et al., *Automatic DJ Transitions with
Differentiable Audio Effects and GANs* (ICASSP 2022); Kim and Nam, *All-In-One
Metrical and Functional Structure Analysis* (WASPAA 2023).

Building blocks, with the licence because Soundsible is MIT:

| Need | Candidate | Licence | Note |
| --- | --- | --- | --- |
| Beats and downbeats | Beat This! `final0` | MIT | In use (P12-b) |
| Time stretch under our control | Signalsmith Stretch | MIT | C++ and WebAssembly builds exist |
| | Rubber Band | GPL or commercial | Not compatible with MIT distribution without a licence |
| | SoundTouch | LGPL | |
| Stems | Demucs (`htdemucs`) | MIT | Minutes of CPU per song; four stems per song to store or recompute |
| Sections | `all-in-one` | MIT code; depends on Demucs and madmom | madmom's weights are CC BY-NC-SA, the reason P12-a rejected it |
| Sample-accurate web playback | `AudioWorklet` plus a WebAssembly decoder | Web platform | Replaces `<audio>` decks; see 4.2 |

### Where Soundsible is ahead and behind

Ahead: it is the only one in the table that generates the route and mixes it;
it selects the technique per pair from measurements; it holds any common
cycle of the two pulses (3:2, 4:3), not only equal or double tempo; it shares
the tempo change between both decks (P18); it inserts measured bridge songs.

Behind the best in each column:

- **Analysis before it is needed.** Apple and Spotify analyse the catalogue
  ahead of playback. Soundsible analyses only what the live session demands
  (P14), one song at a time. Consequence measured below: the route is
  ordered almost entirely without measures.
- **A playback engine it controls.** The web mixes two `<audio>` elements and
  depends on the browser's `playbackRate` with `preservesPitch`. Android owns
  its PCM (`ProgramMixOutput.kt`) and uses Media3's speed processing.
- **Material manipulation.** No loops or repeated sections (Apple, iOS 27
  beta), no stems (djay, DJ.Studio), no key shift.
- **Editing a transition.** Spotify lets the user reshape one; Soundsible's
  plan is not editable and carries a technique name, not its automation.

## 2. What the listener actually gets

### 2.1 Planned techniques

142 automatically mixed transitions were committed in the capture; in 139
both songs were analysed at commit.

| Technique at commit (both analysed) | Count | Share |
| --- | ---: | ---: |
| `structural_fade` | 88 | 63 % |
| `bass_swap` | 21 | 15 % |
| `filter_blend` | 20 | 14 % |
| `echo_cut` | 8 | 6 % |
| `safe_fade` | 2 | 1 % |
| `long_blend` | 0 | 0 % |

Alignment: `beats` in 41, `none` in 98, `bars` in 0.

`structural_fade` with both songs analysed means `plan_transition` found
`confidence ≥ 0.42` and at least one song without a steady pulse
(`tempo_confidence ≤ 0.6`). It is an equal-power volume fade of at most eight
bars placed with the section data; in the browser it is the same operation as
`safe_fade`.

### 2.2 Execution of the planned beatmatches

Completed transitions whose committed technique was a beatmatch:

| Platform reported by the capture | Held as planned | Degraded | Reason |
| --- | ---: | ---: | --- |
| `other` (desktop browser) | 15 | 1 | `rate_ramp_late` |
| `ios-reported-18.7` (iPhone PWA) | 0 | 24 | `rate_control_unavailable` in all 24; `clock_starved` precedes it |

`mixer.ts` keeps one `rateControlAvailable` flag per audio runtime. A
`clock_starved` alarm while a deck plays at a speed other than 1 clears it,
and every later beatmatch in that runtime starts as `structural_fade`. On
2026-11-09 two such alarms during `prepare` were followed by 23 planned
beatmatches executed as fades.

What this does and does not establish: it is a fact that on the iPhone no
captured beatmatch was executed. It is **not** established whether WebKit
really stalls the media clock when `playbackRate` changes, or whether the
detector raises a false alarm there. P16 changed the detector on 2026-11-07
to require two consecutive deficient windows and recorded that a new listen
on the iPhone was pending; the 2026-11-09 and 2026-11-11 captures are after
that change, provided the station was already running it.

Android has no linked capture, so there is no equivalent figure for it.

### 2.3 Why most pairs are not beatmatched

From the analysis cache, 871 songs at the current analyser version:

| Measure | Value |
| --- | ---: |
| Songs with a steady pulse (`tempo_confidence > 0.6`) | 445 (51 %) |
| Random pairs planned as a beatmatch (6000 pairs, split-rate clients) | 17 % |
| Random pairs of two steady songs planned as a beatmatch | 69 %; the other 31 % are `echo_cut` (tempo outside both decks' range) |
| `long_blend` among random pairs | 4 of 6000 |
| Metric regions with a confirmed downbeat | 202 of 9432 (2 %), in 151 songs |
| Songs with a song-level `downbeat_confidence > 0` | 0 |

So half of the library is classified as having a pulse that drifts, and a
pair needs both songs steady. The stored grid of those 426 songs is not
locally straight either: over the 16 s after the cue, the beats are within
5 ms of one line in 41 (intro) and 49 (outro) songs; the median largest
deviation is 33 and 27 ms. A fixed playback rate cannot hold two such grids
together, so the fallback is consistent with the measurement.

Not established: whether those 426 songs really drift (played by people, no
click) or whether the grid follows attack jitter in music that was produced
to a constant tempo. `rhythm.py` decides it with three constants (12 ms
median wander, 0.3 % local tempo, 55 % of beat weight on the line), validated
in P1 on 53 previews. Nobody has checked this library's split against a
reference.

The `bars` alignment exists in the contract, in both clients and in the
shared vectors, and did not occur once. In practice bar and phrase alignment
is the model's own estimate carried through `beats`.

### 2.4 Ordering works mostly blind

The session report (`scripts/dj_session_report.py`) knows the analysis state
at selection for 95 transitions: both songs were analysed in 11 (12 %). By
commit time the figure is 133 of 134. Analysis arrives in time for the mix
but after the route was ordered, so `order_continuous_route` (P3) had measures
for about one seam in eight. This agrees with
[SESSION_PROGRESS](SESSION_PROGRESS.md) (30–41 % of the cohort analysed).

The cache also holds 2582 rows of which 878 belong to the current analyser
version: ten versions in about four months. Each `ANALYSER_VERSION` bump
makes the whole library cold again, and since P14 a song is only re-measured
when a session reaches it.

## 3. How far the code scales

"Scales" is three separate questions.

### 3.1 More music, more load: adequate

- `plan_transition`, `order_continuous_route` and the bridge admission are
  pure functions over at most 16 candidates. A plan costs a few dozen pair
  evaluations. This is not a bottleneck and will not become one.
- Analysis is one process measuring one song at a time, never inside the
  engine. That is correct for a home station and the right isolation after
  the OpenBLAS/`fork` freezes. It is the binding limit on how warm the pool
  can be, by design (P14), not by defect.
- The cache never drops rows of old analyser versions (1704 of 2582 here).
  Small today; it only grows.

### 3.2 More behaviour: this is where it does not scale

1. **A technique is a closed name implemented three times.**
   `TransitionPlan.technique` is a `Literal` in `contracts.py`; the curves
   that realise it are literal arrays in `ui_web/src/lib/audio/mixer.ts`
   (`[0, 0, -4, -12, -18, -18]` …) and the same arrays again in
   `ProgramMixCurve.kt`. A new technique, or one parameter of an existing
   one (how deep the bass cut, how long the filter sweep), is a server
   change, a web change, an Android change and new shared vectors. A user
   control over any of it inherits that cost.
2. **Session logic exists twice.** The server is stateless: each request
   carries sources, heard songs, exclusions and exploration roots. The
   session lives in `ui_web/src/stores/dj.ts` (2403 lines, one `createDj`
   closure with 38 inner functions) and again in Android's `ProgramDj*.kt`
   (about 1300 lines, besides its mixer). Every session-level control has to be implemented,
   persisted, restored and sent by both.
3. **Five entry points, five ordering policies.** `dj-plan` v6 (continuity
   scaled by dispersion), `dj-plan` legacy v4 (`order_route`, weights
   0.42/0.38/0.20), requests (beam search over `score`), `dj-place`
   (mean of two seams minus 0.009 per slot) and `dj-repair` (stability bonus
   0.06). [ARCHITECTURE](ARCHITECTURE.md) inventories them. A control such as
   "prefer harmonic neighbours" must mean the same thing in all five or the
   route will contradict itself when the user places or repairs a song.
4. **Policy constants are literals inside the planner.** `0.46/0.32/0.22`,
   the `0.72` and `0.42` thresholds, `6/7`, the 16/32/8 bar lengths and the
   8 % range sit in `transitions.py` and `timing.py`. They are exactly the
   values a control would move, and today nothing names them as a policy.
   They also predate the "measure, don't calibrate" rule and were kept
   deliberately to preserve ordering.
5. **Names left over from removed features.** The v6 response still sends
   `profile: "balanced"`, `source_profile`, `direction_revision` and
   `pool_counts.discovery: 0`; the web state still calls its session epoch
   `directionRevision` and has `pendingDirection`. Direction and profiles
   were removed on 2026-10-22. The epoch is in use; its name and the constant
   fields are not information.

### 3.3 More platforms: bounded by the web player

Android executes the mix on a sample clock it owns. The web cannot: two media
elements, a 40 ms timer and rate nudges (P2). That was good enough on the
desktop (15 of 16) and is the platform where the iPhone result in 2.2
appears. The iOS native app has no DJ mode; the iPhone's DJ is the PWA.

## 4. Direction

Ordered by what unblocks the next item. Each is sized as a HANDOFF point;
none is started here.

### 4.1 Make "what was executed" a standing figure

The capture already links plan, commit and execution. What is missing is a
habit and one platform:

- A fixed report (the two tables of 2.1 and 2.2) from
  `scripts/dj_session_report.py`, per platform and client revision, so every
  later point states its effect in the same units.
- The same linked events from Android, which today is outside the recorder.

Reason for doing it first: the listener's acceptance on 2026-10-30 and the
capture disagree about how often a beatmatch is heard. Both can be true (a
well-placed fade is a good transition), but every later decision needs to
know which transitions the listener was judging.

### 4.2 Beatmatch on the iPhone

Step one is a measurement, not a fix: on the device, with a click pair,
record whether the audible output stalls when `playbackRate` leaves 1, and
compare with the `clock_starved` alarms. Two outcomes:

- **False alarm.** The detector is corrected for WebKit, and the
  `rateControlAvailable` flag stops being permanent for the runtime (retry
  after a clean mix instead of never).
- **Real stall.** `<audio>` with variable rate is not usable on iOS, and the
  only way to beatmatch there is an engine that renders PCM itself:
  `AudioWorklet`, a WebAssembly decoder and a stretcher such as Signalsmith
  Stretch. That engine would also give sample-accurate starts (ending P2's
  rate nudging), loops, and later stems. Its costs are concrete: decoded
  audio in memory (about 50 MB per five-minute stereo deck at 16 bit, against
  the standing rule of not holding audio in RAM), background playback on iOS
  (which today relies on a playing media element), and a second playback
  path to keep working. It needs a spike on the iPhone before any commitment.

This is the one decision in this document with a large architectural
consequence, and it should be taken on the measurement.

### 4.3 The half of the library without a steady pulse

Also a measurement first: take a sample of the 426 songs, mark by ear or with
a second detector which have a constant produced tempo, and count how many
`rhythm.py` classified as drifting.

- If many are misclassified, the fix is in the constant/local decision and
  raises beatmatch coverage directly (a new `ANALYSER_VERSION`).
- If they really drift, a fixed-rate beatmatch is impossible for them and the
  product question becomes the quality of the non-beatmatched transition,
  which is already what is heard most. Today that is one equal-power fade.
  Measured material exists to do more without inventing taste: section roles
  (604 songs have a measured intro, 526 an outro), per-section band levels,
  loudness. A fade that starts where the outgoing arrangement thins and
  ends at the incoming song's first full section is a structural decision,
  not a style.

Following a drifting grid with a continuously varying rate is possible only
with the engine of 4.2 and belongs after it.

### 4.4 Measures before the route is ordered

Ordering has data for 12 % of seams. Within the standing decision that DJ
work belongs to the live session, the unit of demand could be the session's
**sources** (the collection the listener handed over is known in full when
the session starts) rather than only the next eight songs. Whether that
counts as work for the current session is the owner's call; the measured
cost of the present rule is that P3 seldom runs with data.

Independently: keep measures across analyser versions whose meaning did not
change. A version bump for a new downbeat rule should not discard LUFS and
key. That means versioning groups of measures, not the row.

### 4.5 One declarative contract and one policy

The base the controls need:

- **The plan carries automation, not a name.** Per deck: gain, low-shelf,
  filter cutoff and echo send as curves over the overlap, plus the cues,
  rates and alignment it already has. Clients become executors of curves;
  both already interpolate the same arrays. A new technique, or a parameter
  of one, is then a server change with vectors, and a transition becomes
  something a client could display and, later, let the user edit. `technique`
  stays as a label for the interface and the capture.
- **One `MixPolicy` object.** Named fields with units and today's values as
  defaults: maximum rate change per deck (%), overlap in bars per situation,
  harmonic distance accepted for a long blend (Camelot steps), whether to
  mix at all. `plan_transition` and all route functions take it as an
  argument; the client sends it with the session; the server validates
  ranges. The existing "Mix between songs" switch becomes its first field.
- **One ordering objective** used by plan, request, placement and repair,
  and removal of the legacy v4 route once Android always sends sources.
- Rename the leftovers of 3.2.5 in the same change.

The equality harness of P11 (same analyses in, same plans out) is the right
acceptance test: the refactor must reproduce today's plans exactly with the
default policy.

### 4.6 Later, on that base

Section loops to extend a short outro (Android can do this on its PCM path
before the web can), key shift of one semitone when it turns a clash into a
neighbour, stems. Each needs 4.2's engine on the web and is not a
prerequisite for controls.

Moving the session itself to the server (a resource the clients observe)
would remove the duplication of 3.2.2 and allow moving a session between
devices. It conflicts with Android's offline goals and is a larger change
than everything above; the policy object gives most of the benefit for
controls without it.

## 5. What this means for user controls

A control is worth exposing when three things hold:

1. It is a field of the policy with a unit, not a style name. This keeps the
   2026-10-22 decisions (no style chooser, no hand-set taste values): the
   user sets a magnitude, the DJ still chooses the technique per pair.
2. It changes what is heard in most transitions on the listener's device.
3. The capture can show it was honoured.

Against today's measurements:

| Candidate control | Policy field | Works today? |
| --- | --- | --- |
| Mix between songs (exists) | `mix` | Yes |
| Mix length | Overlap in bars | Only for the 29 % planned as beatmatch; fades are capped at eight bars and on the iPhone everything is a fade |
| Tempo range | Maximum rate change per deck | No effect on the iPhone (2.2); on the desktop it moves pairs between beatmatch and `echo_cut` |
| Harmonic strictness | Camelot distance | Affects ordering only where both songs were measured at selection: 12 % |
| Keep the session close / let it wander | Continuity terms of the ordering | Same 12 % |
| Edit this transition | Per-edge override of the plan | Needs 4.5 |

That table is the argument for the order in section 4: 4.2 and 4.3 decide how
many transitions a control can reach, 4.4 decides whether ordering controls
have data, 4.5 makes a control one implementation instead of three.

## Open decisions for the owner

1. Is analysing a session's whole source collection "work of the live
   session" (4.4)?
2. If the iPhone measurement shows a real stall, is a PCM engine in the web
   player acceptable given the memory rule (4.2)?
3. If the unsteady half really drifts, is investing in the structural fade
   the next musical point, ahead of further beatmatch refinement (4.3)?

## Sources

- Spotify, *Transitions on tap* (2025-08-19, updated 2026-05-19):
  <https://newsroom.spotify.com/?p=35598>
- Spotify support, *Mixed playlists*:
  <https://support.spotify.com/jm/article/mixed-playlists/>
- 9to5Mac, *AutoMix in Apple Music, iOS 26*:
  <https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/>
- RouteNote, *Apple Music AutoMix gets a major upgrade in iOS 27* (2026-07-17):
  <https://routenote.com/radar/apple-music-automix-gets-a-major-upgrade-in-ios-27/>
- Algoriddim, djay manual, *Automix*:
  <https://help.algoriddim.com/user-manual/djay-pro-mac/settings/automix>
- DJ.Studio help, *Harmonize (previously Automix)*:
  <https://help.dj.studio/en/articles/7878402-harmonize-previously-automix>
- Mixxx, *Intro & outro cues and AutoDJ improvements* (2020-07-09):
  <https://mixxx.org/news/2020-07-09-intro-outro-sections>
