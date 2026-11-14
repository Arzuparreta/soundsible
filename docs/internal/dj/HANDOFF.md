# Handoff: DJ mode review

Entry point for reviewing and improving DJ mode point by point, in new
sessions and without the chat history. The original diagnosis starts from `main` at
`f1e79d30`; the second phase (P11–P13), agreed on 2026-10-25, is checked against
`main` at `ad59b838`. The line numbers in the original diagnoses are
historical; search by function name in the current code.

The document started as a diagnosis. Closed points say so in the status table
and in their section; the rest is still diagnosis.

Direction analysis (2026-11-13): [DIRECTION](DIRECTION.md) compares the DJ with
other products, measures what real sessions executed and proposes the order
of the next points. It closes no point of the table below.

## Musical identity and sources (PR #423)

The collection assigns a stable `item_id` to library, saved items and playlists. DJ
candidates and plans keep that reference when it is known, separate from the
source ID used for analysis and from the occurrence used by the transport.
Downloading or repairing does not replace audio that is already prepared. This change does not modify
measurements or their meaning and does not change `ANALYSER_VERSION`; it also closes no
musical points of the table. The native regression detected that, after recovering the
outgoing deck because the incoming one was starved, reopening the same cached prefix could
make it audible again before receiving new data. The retry of that
occurrence requires exceeding the known buffer limit; an explicit seek clears
that guard. The clock of the outgoing deck is kept and measurements are not changed.
Contract: [collection identity](../audits/COLLECTION_IDENTITY.md).

## How to work with this document

- Review **one point per session** (or the ones the user indicates). For the
  continuation of P12, the user authorizes large blocks and a nearly
  end-to-end comparison; see P12-a/P12-b. When closing a point, update
  its row in the status table and its section, with the commit or PR.
- Follow `AGENTS.md`: branch + PR, `impact:*` label, wait for CI, no merge without
  the user's permission, no `npm run build`, full Playwright suite if
  `ui_web/` is touched.
- Any change to the measurements or their meaning must bump
  `ANALYSER_VERSION`: the cache `cache/dj/analysis.sqlite3` is indexed by that
  version and old measurements are not invalidated any other way. This still
  applies when P11 moves the analysis to other modules; an extraction that
  keeps the measurements and their format exactly does not require invalidating them.
- User decisions that are still in force:
  - Mixing is automatic: there is no style or "booth" selector by design
    (removed in `ae161f0`). There is only the switch **Settings → DJ →
    Mix between songs**.
  - Volume levelling is a constant gain per song: never change
    the volume of a song while it plays.
  - Android must match the web features, with the best native
    implementation, not copy temporary workarounds from the web. The DJ logic is
    on the server; Android only executes the mix. An interface difference
    from the web is only accepted if the port imposes it, and if a change breaks
    Android it is fixed in the same PR (2026-10-22).
- Decisions of 2026-10-22 (see *Design decisions* below):
  - The energy arc is removed. The DJ does not direct the session: the
    sources and the recommender direct it. The DJ orders so that the transitions are
    good, and mixes.
  - No hand-written taste value and no human rating (neither from the user
    nor from the assistant) to calibrate measurements. The code measures quantities with
    units, testable with synthetic signals of known response.
  - The DJ must have more analysed music than reaches it today, and may
    add bridge songs to the pool, **as long as the circular preference
    for already downloaded songs is removed or mitigated as much as possible**
    (user's condition).
- Answer in the language the user uses, with clarity and precision.

## Symptom the user hears

Before #377: transitions usually landed in the correct place, but with a few
milliseconds of offset: when the kicks of the two songs coincided on
beat 1, the kick of one was heard and very shortly after that of the other ("flam" effect).
The measured cause was in P1.

After #377 the user (a musician) hears no offset. P2 is parked:
there is no symptom that justifies it.

## Status

Physical acceptance (2026-10-30): the user confirms that the DJ changes
work as expected in real listening. The listening acceptance
of P12-b, P13, P14, P15 and P16 is closed. This confirmation is not a
phase measurement on Android and does not replace the musical references of the corpus. The
listening limitations noted in earlier deliveries are historical.

| Point | Topic | Evidence | Status |
| --- | --- | --- | --- |
| P1 | Precision of tempo and of the beat grid | Measured | Closed (#377) |
| P2 | Phase alignment in the browser | Station trace: a `seek` at the cue left 115 ms of offset for 30 s, heard by the user | Closed on the web (PR #395): phase held with `playbackRate` during the mix; Android measured in [P18](P18.md): the incoming song sounds 6–15 ms late, constant, cause not identified |
| P3 | The route order ignores transition quality | Quantity tests, synthetic audio → HTTP and replay of local analyses | Closed (implementation `0e62b0fb`) |
| P4 | "Energy" does not measure intensity | Measured | Closed (#385): notes/s, LUFS and flatness; `energy` removed |
| P5 | Analysed pool, previews and bridge songs | AAC → cache → HTTP, cold/warm pools and real acquisition of 16 previews | Closed (implementation `31f696bc`) |
| P6 | Key compatibility scored badly | Measured: 576 pairs and known cadences | Closed (`af6521f1`); detector and limits documented below |
| P7 | Automatic selection of techniques, without profiles | AAC → SQLite → HTTP in planning, placement, repair and refinement; common web/Android vectors | Closed (implementation `d678f625`): option (b) |
| P8 | Sections measured and not used | AAC → SQLite → HTTP; common vectors executed by web and Android | Closed (implementation `90b6c7e9`) |
| P9 | Echo not synchronised with the tempo | AAC → SQLite → HTTP; impulses in real Web Audio and native PCM | Closed (`a8a22618`); automatic activation closed in P7 (`d678f625`) |
| UI1 | External selection starts a new session from the selection; management inside the shell | Store, browser and native contract tests | Closed (#389) |
| UI2 | Empty shell when switching from NORMAL to DJ after updating the station | 404 of the DJ module in the journal of 2026-11-08 at 12:52:38–43; reproduction with 404 in Chromium and regression of switching without download, with real WAV | Fixed in PR #431: both views are loaded together when opening the player; initial load recoverable without reloading or stopping the song |
| P10 | Dead code and outdated documentation | No readers of `automation`; types and contract retired; [later cleanup](../audits/2026-11-03-unused-code.md) of the sweep deactivated in P14 | Closed (#385 and `d678f625`); the P14 module without startup also retired |
| P11 | Rewrite by responsibilities, contracts and policy coherence | Before/after equality: 7 analyses, 784 plans, 168 routes and bidirectional WAV/AAC cache; contracts and policies inventoried | Closed (implementation `67d086cf`); P11-a closed (branch `dj/p11a-remove-legacy`) |
| P12 | Meter, subdivision, identification of the 1 and their confidences | Contracts and guards in #394; detector integrated in #395; [final revalidation](detector_comparison/FINAL_RESULTS.md) of the corpus, pairs and cache/HTTP | Closed with P12-b; revalidated on 2026-10-27; limits below |
| P12-a | Joint estimation and comparison of open detectors | 29 configurations × 62 inputs + 5 AAC, HTTP contract and execution without PyTorch; [results](detector_comparison/RESULTS.md) | Closed (PR #395): complete measurements and user decision (2026-10-26): Beat This! `final0` |
| P12-b | Integration of the chosen method and closing of P12 | DBN equal to madmom 62/62; GTZAN tempo 24/30 and F1 of the 1 0.81; P1 green; `beats`/`bars` on server, web and Android | Closed (PR #395, together with P12-a) |
| P13 | Phrases and sections on an explicit metric basis | Signals with known changes and roles (4/4, 3/4, 6/8), wrong meters and real network; AAC → SQLite → HTTP; web/Android vectors; [results](p13-results.json) | Closed (PR #399); limits in [P13](P13.md) |
| P14 | First mix and work tied to the current session | Cancellable queue, real process interrupted, shared interests, cache and HTTP protocol; early refinement web/Android; [contract and evidence](P14.md) | Closed; physical acceptance confirmed by the user (2026-10-30) |
| P15 | Continuity under clock failures and gaps without samples | Two complete captures of 2026-10-29; playback tests and real WAV; [evidence](P15.md) | Closed in PR #405: fixes and complete local suites; physical acceptance confirmed by the user (2026-10-30) |
| P16 | Continuity measured per deck and PWA reconnection | Capture of the trip of 2026-10-30; before/after regressions, real PCM in the browser and connection recovery; [contract and follow-ups](P16.md) | Original closed (#408), listening accepted on 2026-10-30; Retry fixed on 2026-11-06; confirmation of the transient deficit implemented in `fix/confirm-media-clock-starvation`, new listening pending |
| P18 | Tempo shared between the two songs | Plans and common server/web/Android vectors; AAC → analysis → HTTP with and without header; real clicks through the web mixer and the native service, compared with `main`; [method and measurements](P18.md) | Implemented (PR #416, branch `dj/split-tempo`); 1:1 first when it fits; real listening pending |
| P17 | Evolution of the session without interaction | 12 paired planning sessions, 8 delivery segments and replay of 31 pairs; [first measurements](SESSION_PROGRESS.md); [linked capture](SESSION_CAPTURE.md) | Retrospective study completed; prospective web/PWA capture implemented in PR #409. General improvement not demonstrated: real sessions with the new capture are missing; Android outside the web recorder |

Web recovery follow-up (2026-11-06): the station traces show
a loading stall, exhausted recovery and `native_paused_on_restore`. Afterwards,
Retry published "loading", but `recover()` finished without acting because there was
no longer an active playback request. The explicit retry now requests
playback before loading the other deck; automatic recovery
keeps the pause, and Pause/Stop during the wait cancel the late start.
Regression reproduced before fixing it, transport/store tests and Retry
button with real WAV in the browser. This follow-up fixes the retry that did not
act: it does not attribute the cause of the initial stall nor certify a new physical
listening. It does not change the analysis, the plans or the Android executor.

Interface follow-up (2026-11-08, UI2): Fly on the ThinkPad requested
`AutoMode-DB77Yq2v.js` and received 404 three times; after reloading, the station
served `AutoMode-1JRlnK_1.js` with 200. The open client kept a reference
to a module from an earlier build. Reproduced: when returning 404 to the deferred
DJ load, NORMAL is hidden and the DJ view stays empty. Both views are
now resolved from a common deferred entry when opening the player: the
mode switch no longer downloads interface code. DJ also reuses the recoverable
load of NORMAL for failures when opening it for the first time. Regressions with
real WAV verify switching and returning without new downloads, reload or restart of
the song, and recovery from the initial failure. A race
in the planner has not been demonstrated; the transport, the plans and Android are not modified.

Clock follow-up (2026-11-07): the NORMAL cuts correlate with
deficit alarms at startup, followed by pauses and reactivations issued by
the supervisor. A transient offset also appears in five DJ mixes at 1×
that afterwards advance normally. The observer now requires two consecutive deficient
windows; a healthy one clears the suspicion. It keeps the protection
against regressions and the independent monitoring of the frozen context. An
alarm already at 1× does not declare speed control incompatible for future mixes.
Transport and real PCM regressions, diagnosis and limits in [P16](P16.md).
New listening on the iPhone pending; the internal mechanism of the
transient is not attributed and the analysis, the plans and Android are not modified.

Order agreed with the user (2026-10-22): **P4 redone → P6 → P3 → P5
extended**, then P8 and P9. P7 and P10 are decisions and cleanup. P2 is not worked on
unless the symptom returns. P4, P6, P3, P5, P8 and the synchronisation of P9 are
closed. **P7 and P10 are also closed in `d678f625`; UI1 is closed in
#389.** P2 remains parked: it is only resumed if the offset symptom returns.

**Next agreed work (2026-10-25): P11 → P12 → P13.** The closures of the
first phase are kept with their original scope: P1 improved the precision of the
beat and P8 started using the existing sections; they did not solve the
general detection of the meter, of the 1 or of musical phrases. P2 fixes the
temporal alignment of playback; it does not fix a wrong musical
interpretation even if the two players coincide to the millisecond.

**P13 is closed (PR #399). The user authorized P14 on 2026-10-28:** fix
the first mix and all the unnecessary work paths found in
that audit. DJ work belongs exclusively to current sessions;
processing songs from earlier sessions is a bug. This decision replaces
the automatic sweep and the speculative acquisition of 16 previews from P5;
the cache remains shared and reusable. Recorded,
without a decided order: splitting the tempo change between the two
songs during the mix (user decision of 2026-10-26; implemented
in [P18](P18.md)) and P2 on Android, measured with P18: the incoming song sounds 6–15 ms late with a
single deck, cause not identified. P11-a is closed: the legacy branch was not reached in production and has been
removed.

**P12 was closed with P12-b; P13 came after.** History: the earlier
closure was premature: `2ca8ccf2` and PR #394 provide contracts and guards,
but the twelve Ballroom fragments do not certify correct meter and 1. The user
agrees to test joint estimation and several maintainable open solutions,
compare them and decide with the results. **The comparison and the integration
were merged together in #395.** The revalidation
of the final analyser and the additional measurements are recorded in
[detector_comparison/FINAL_RESULTS](detector_comparison/FINAL_RESULTS.md).
Results and limits in [detector_comparison/RESULTS](detector_comparison/RESULTS.md).

**User decisions (2026-10-26):**

- Detector: **Beat This! `final0`** with its DBN of 3/4 beats. It runs with
  ONNX Runtime and a NumPy frontend, without PyTorch or madmom in the engine: PyTorch does not
  publish Windows arm64 and madmom only exists as 2018 source code with
  CC BY-NC-SA weights. The DBN is ported to NumPy and verified against the retained
  outputs of the comparison.
- Guards: **beatmatch by beat when the beat is reliable**; bar
  alignment only with additional evidence of the 1. The network activation is not
  that evidence: it does not separate hits from errors. This changes the P12 policy,
  which today requires bars for any beatmatch.
- Version: **publish no version until P12-b is integrated**, instead of
  reverting #394.
- Speed: the stretch limit of the incoming song goes from 6% to
  8%, the pitch range of a turntable or CDJ (120 ↔ 128 BPM, 6.7%, sounded
  mixable and fell into `echo_cut`). Its own point, implemented in
  [P18](P18.md): split the tempo change between the two songs during
  the mix (each one ≤ 8%, up to ~16%, e.g. 120 ↔ 140) and return
  gradually, keeping the phase on web and Android.
- Beatmatch gate: **only the execution decides whether there is a fallback**. If the
  two beats are stable and the local speed fits within 8% with ≤ 5 ms of
  offset, there is beatmatch. The gate `score ≥ 0.55` is removed: with it the
  key caused fallbacks (120 A minor ↔ 128 G minor scored 0.495 and
  played as `echo_cut`) and the tempo part left a hidden limit near
  7%. All intervals between keys are considered mixable; the
  Camelot classification is kept to order the route and to choose between
  bass_swap (≥ 0.72), filter_blend and long_blend (harmony ≥ 6/7). Measured on
  6000 pairs from the user's library: between 6 and 8% of tempo
  difference, beatmatch goes from 2% to 75%; between 4 and 6%, from 26% to
  78%.
- 1 counted from the first measured 1: if the cue falls in a segment where the
  model gives no 1 (a counterpoint intro that suggests another 1, such as
  "Teardrops (Rules Remix)"), the cue is placed a whole number of bars from the nearest
  measured 1 along the same beat, the next one first: the bar that
  the entry of the drums reveals. Only with a regular grid, without gaps and a
  stable beat up to that 1 (`projected_bar`). The repositioning uses that bar.
  The guarantee is still `beats`. Measured on the station: the earlier plan
  put the 1 of the drums on the 2 of the outgoing song. In the user's
  library, 17 of 227 songs with a stable beat have this pattern in their entry
  cue.
- Common cycle: binary and ternary readings are equivalent; two songs
  are mixed with beatmatch in any 2ᵃ·3ᵇ ratio of beats that the
  players can sustain (including 3:2, e.g. 116 ↔ 174), aligning the
  common cycle from the two downbeats. Inside the P12-b PR.
- Weights: the `.onnx` of `final0` (84 MB, MIT) is published as an asset of a
  Soundsible GitHub release with a pinned SHA256. The Docker image and the
  desktop installer include it; an installation from source
  downloads it the first time.

**Regression measured on `main` (#394, not published yet).** With the 30
unseen GTZAN recordings, the correct tempo drops from 21 to 10 and the real 1 is not
identified in any of them (F1 0). In the user's local cache, 162 of 278
songs change BPM compared with v8 (66 ×1.5) and the 1 covers on average
2.2% of each v9 song: almost all transitions with real music are
fallbacks. The user decides to hold the next version until P12-b.

**Agreed development order (2026-10-25): bench/adapters and comparison
P12-a → results and user decision → P12-b integration → P13.** To
save rewrites, prepare P13 fixtures during the comparison so that its
implementation can be delivered together with P12-b if they share an already chosen metric,
with independent acceptances. Do not change production per candidate. The single
operational plan is in [DETECTOR_COMPARISON](DETECTOR_COMPARISON.md).
P11-a is not another detector that has to be rewritten in the comparison; it is already
closed.

Why this order: P3 orders with the measurements of P4 and with the key
score of P6 (`plan_transition`: `0.46·tempo + 0.32·harmony + 0.22·confidence`),
so it goes after both. P5 extends the pool that P3 orders.

## Design decisions (2026-10-22)

### External selection and session control (2026-10-24)

With DJ active, playing music from outside the shell starts a new session:
the selected song starts from zero and is the only source; choosing a
collection uses that collection as the source and starts with its first song.
The earlier sources, requests, exclusions, exploration and route are discarded;
the new planner has another identity. Responses and callbacks from the
earlier session cannot restore it. Web and Android share this rule, including selection from Android Auto.

Management of a running session stays inside the shell: adding sources,
requesting/placing songs, changing the material without cutting the current song and repairing the
route. External menus offer starting DJ, without actions to edit the current
session. Entering DJ from NORMAL and the changes requested from the shell itself
keep their earlier contract.

### No energy arc

The arc is `_auto_set_arc_position` (`auto_mode.py`): six fixed values
`(0.34, 0.52, 0.74, 0.9, 0.78, 0.58)` written by hand. The index is (distinct
songs heard among the last 4 + `segment_index`) mod 6; `segment_index` is
incremented by the client on each reload (`ui_web/src/lib/generatedQueue.ts`,
`ProgramDjPlanner.kt`). From the fourth song it advances one step per reload, and the
8 songs of a reload look for the same target. The response includes
`"arc": {"target", "phase"}` and no client reads it.

The user removes it: it adds nothing the recommender does not already do (with party
techno, normal playback already keeps giving party techno). Removed in
#385: `_auto_set_arc_position`, the energy ordering of
`_build_music_set_route`, the choice of the first song by energy and the
`arc` field of the response.

### Measure, do not calibrate

User condition: if a taste value has to be written by hand or songs have to be
rated, it is not implemented. What is valid:

- Quantities with a physical unit: notes per second, LUFS, BPM, spectral flatness.
- Signal processing constants (windows, bands, minimum separation between
  attacks) set so that synthetic signals of known response give the
  correct value, like the click tracks of P1.
- Scales that come from the data of each route (spread among the candidates
  of the moment), not global constants.

Not valid: intensity ratings set by a person, curves or weights tuned
"so that it comes out right", a single "energy" number that mixes rhythm, timbre and
volume with chosen weights.

### More analysed music, without circular preference

Today only what is already on disk is analysed (`_dj_source_path`): the local
library and the previews already downloaded. YouTube related songs that are not downloaded do not
have BPM, key or mix points. The user wants the DJ to have
more music located and analysed and to be able to add it to the pool (bridge songs).

Background: until `76113008` (2026-07-31) the previews of all candidates were downloaded
in advance. It was removed for two reasons, written in
`_dj_source_path`: it was expensive, and it gave a **circular advantage** to songs already
downloaded (analysed → chosen more → stay downloaded). The user's
condition is to remove or mitigate that advantage as much as possible. See P5.

### Direction and styles: removed (2026-10-22)

User decision: without a single energy, the direction (`direction.energy`) is
removed; and Android must be the same as the web. The style menu (4 profiles) and the
direction dialog had been added by the Android port (#300) to the `⋯` menu of
`ProgramTransport.tsx`, two months after the web removed them
(`ae161f0`): nobody had decided it. They are removed in both clients, and the
whole direction (energy, familiarity, text, include, exclude) on server,
web and Android, because nothing can set it anymore. After #385 both clients sent `dj_profile: "adaptive"`. P7 (`d678f625`)
also removes that parameter from the clients and the profiles from the server: the
technique is decided per pair. The server ignores the field from old clients.

---

## How it works today

### Files

| Part | File |
| --- | --- |
| Public entry (re-exports, no state of its own) | `shared/dj_engine.py` |
| Contracts, storage, analysis, structure, timing rules, transitions and routes | `shared/dj/`; dependency map in [ARCHITECTURE](ARCHITECTURE.md) |
| Beat and downbeat model (Beat This! on ONNX Runtime, DBN in NumPy) and its weights | `shared/dj/beat_model.py`, `shared/dj/dbn.py`, `shared/dj/weights.py`; notices in `shared/dj/third_party/` |
| Admission of bridges from the measured set | `shared/dj_pool.py` |
| Endpoints `dj-plan`, `dj-place`, `dj-repair`, `dj-transition` | `shared/api/routes/auto_mode.py` |
| When and how each transition is launched (browser) | `ui_web/src/stores/dj.ts` |
| Execution of the mix with two players | `ui_web/src/lib/audio/mixer.ts` |
| Filter and echo nodes | `ui_web/src/lib/audio/graph.ts` |
| Android: requests the plans from the same server and mixes natively | `android/.../ProgramDjPlanner.kt`, `ProgramDjRefiner.kt`, `ProgramMixCurve.kt` |
| User documentation | `docs/AUTO_MODE.md` |

### Flow

1. **Analysis** (`analyse_audio`). The local library of all accounts is
   traversed in the background at startup and every five minutes (without podcasts or
   audio available only in the cloud). Previews are analysed when their
   acquisition completes. Each reload prepares a bounded set of candidates (P5). FFmpeg decodes once
   to mono, 22050 Hz, with the LUFS meter in the same pass. Beat This!
   `final0` (ONNX Runtime, one thread, one inference at a time) and the DBN give beats
   and downbeats; the rest of the measurements use the same window decimated to 11025 Hz in
   NumPy. Only the measurements are stored in SQLite. In the background, 2 jobs
   (`request_analysis`). Songs longer than 8 minutes: only the first 90 s and
   the last 120 s. Without verified weights nothing is analysed or stored
   (P12-b). While there is no analysis, `contracts.fallback_analysis()` is used with
   `confidence` 0.18.
2. **Candidates** (`_build_music_set_route`, `auto_mode.py:1219`): songs from each
   source, plus the YouTube Music "related" songs (25 per seed) of the last 4
   songs of each source, plus the related songs of the last 4 automatic
   songs that actually played ("exploration"). Excluded songs, songs already
   heard and recordings longer than 20 minutes are removed.
3. **Selection and order**: shuffled with a fixed seed per session and segment; a
   set of up to 16 candidates is chosen before reading their analysis. The
   first 8 (or the requested `limit`) are the destinations of the route; the rest are
   possible bridges. The measured positions are ordered by transition quality
   and continuity in the four quantities of P4 (P3). The unanalysed ones keep
   their position. Bridges can only be inserted with the whole set and the seed measured,
   without removing original destinations (P5). A session without a seed opens
   from the most recent source, according to the shuffle.
4. **Transition of each pair** (`plan_transition`, `shared/dj/transitions.py`), with automatic
   technique selection (P7), common to all endpoints.
5. **Execution** in the browser (`stores/dj.ts`, `mixer.ts`).

### Measurements per song (`_compose`, `_window_features`)

| Field | How it is computed | Used when planning? |
| --- | --- | --- |
| `bpm` | Line (or local curve) through the model's beats, weighted by the attack of each one; see P1 and P12-b | Yes |
| `beat_grid` | Model beats where there are any (without extending them), phase and period set with the attacks, 4 decimals | Yes |
| `downbeats` | Downbeats estimated by the model, on grid points (P12-b) | Yes |
| `metric_regions` | Beats/bar and downbeats: model estimate. `metre/downbeat_confidence`: independent confirmation (harmonic changes and accents on the same grid), zero if it does not match. Subdivision measured; explicit unknowns | Yes, validity of the pair and of the overlap; the plan transmits only two compact coverages |
| `key`, `mode` | Pearson correlation with the Krumhansl profiles; chroma with resolution for the bass (P6) | Yes |
| `note_rate` | Attacks per second of music that is sounding (P4) | Yes, route continuity (P3) |
| `loudness_lufs` | EBU R128 integrated loudness from FFmpeg, in the same decode (P4) | Yes, route continuity (P3) |
| `spectral_flatness` | Spectral flatness 100–5000 Hz of the strong frames, weighted by power (P4) | Yes, route continuity (P3) |
| `intro_cue` | First instant with energy above the 35th percentile | Yes (entry point) |
| `outro_cue` | First phrase start about 64 beats before the last sound | Yes (exit point) |
| `phrases` | Phrase starts on the P12 bars: measured change of the arrangement (`boundary`), whole bars of the length measured from a downbeat (`counted`) or of eight, assumed (`assumed`); P13 | Yes, end of the mix on arrival at the drop (measured before assumed) |
| `sections` | Consecutive phrases with a measured role: intro, build, drop, breakdown, body, outro or `None` without evidence; `low_db`/`upper_db` in dB relative to the loudest section (P13) | Yes, exit during the outro/before breakdown, arrival at the drop and hint for the long mix (P8) |
| `tempo_confidence` | Share of beats that fit the grid; ≤ 0.6 if the tempo drifts | Yes, inside `confidence` and as an independent beatmatch requirement (P8) |
| `confidence` | `0.38 + 0.36·tempo_conf + min(0.2, key_margin/8)` | Yes |

### Transition calculation (`plan_transition`)

```
ratio = bpm_outgoing / bpm_incoming, brought to the speed of the nearest common cycle
        (m beats of the outgoing song = n of the incoming one; 1:1, 2:1, 3:2, 4:3, 3:1, 4:1
        and their inverses; the old contract only folds one octave)
tempo      = 1 − |1−ratio| / 0.08
harmony    = 1 − Camelot_steps / 7 (±1 in the same mode or a relative change = one step; with no known key 0.55)
confidence = minimum of the two songs
score_base = 0.46·tempo + 0.32·harmony + 0.22·confidence
score      = score_base if there is an executable alignment (`bars` or `beats`); 0 otherwise
             (old entries without a metric contract keep score_base)
```

The score keeps the scale of the earlier `adaptive` to order routes and
choose between bass_swap and filter_blend; it does not decide a fallback (P12-b). The
technique checks the local period, the speed and the meter actually
executed. The three beatmatch techniques require executable
alignment during the whole overlap, not only compatible BPM (P12-b):
`bars` with confirmed downbeats in both songs and equal executed bars;
`beats` with a shared stable beat (region with `pulse_confidence > 0.6`,
regular grid without gaps and both cues on measured beats). In `beats` the
meter estimated by the model is only sent if it matches in the two songs;
it is not promised.

**Common cycle (user decision, 2026-10-26).** Reading a song as
binary or ternary is a choice of level: a 12/8 is a 4/4 with ternary
beats and a 6/8 is read as two beats or as three. The mix does not depend
on that reading: it looks for the shortest duration that is a whole number of
beats of both songs (`cycle_beats` = [m, n], 2ᵃ·3ᵇ ratios within
8% of speed) and keeps it starting on the two downbeats. Examples: 3 against 4
beats at the same beat (downbeats together at the start and every 12 beats), 120 ↔ 180 BPM
(2 beats = 3), 90 ↔ 120 (3 = 4), 116 ↔ 176 at speed 0.9886, 6/8 at 80 ↔ 4/4
at 120. The cue is only repositioned by `relocation_seconds`: whole bars of the
outgoing song that are also whole cycles, so as not to separate the two downbeats. Where the
model gives no 1, the downbeats are counted in whole bars from the nearest measured
1 of the same continuous beat (`projected_bar`): the cue and the
repositioning use those downbeats.

| Condition | Technique | Bars requested |
| --- | --- | --- |
| Reliable beat, score ≥ 0.72 and executable local adjustment | bass_swap | 16 |
| The above, equal/neighbouring/relative keys and measured calm opening/tail long enough, without gaps or drift | long_blend | 32 |
| Reliable beat and executable local adjustment, score < 0.72 | filter_blend | 16 |
| No executable mix, confidence ≥ 0.42, reliable beat in both songs and valid measured outgoing hit | echo_cut | 8 |
| Confidence ≥ 0.42 without the above requirements | structural_fade | 8 |
| Rest | safe_fade | 8 |

The local adjustment does not exceed 8% per deck (pitch range of a turntable or CDJ;
user decision, 2026-10-26, previously 6%). With clients that declare it
(`X-Soundsible-Dj-Rates: split`), the two songs share the change and each
deck stays at 7.75% at most ([P18](P18.md)); for the rest only the
incoming song moves. It must accumulate at most 5 ms of offset
with the rounded values of the contract. A high score from key cannot
bypass that check. Any common cycle keeps aligned all the
levels the two songs share; half/double tempo is the 2:1 case.

- Overlap: bars × measured local bar duration of the outgoing
  song, between 4 and 48 s; without a bar a temporal fallback is used and
  `overlap_bars = null`, with the same 25% duration limit as the players (minimum
  1.5 s in short files). Cut or fade techniques are limited to 8 bars.
- `out_cue` = `outro_cue` snapped to the nearest downbeat within its region.
  `in_cue` = `intro_cue` snapped within its region; it does not jump to another window
  when the beginning lacks a measurement. They are the fallback points:
  P8 uses the sections when they fit in the window and may shorten the overlap.
- Beatmatch only with known BPM, `tempo_confidence > 0.6` and alignment
  `bars` or `beats` of both cues and of the whole segment. Fallbacks declare
  `none`, keep normal speed and their mix score is zero in the
  metric contract. The key cannot bypass the guard.
- `playback_rate` = ratio that equalizes the common cycle with the periods measured
  near each point (n · periodo_entra / (m · periodo_sale)): seconds of the
  incoming song per second of the outgoing song. Only in bass_swap, long_blend and
  filter_blend, and only if the decks fit within their range. Otherwise, 1.0.
- `split` clients: `out_playback_rate` = 2 / (1 + playback_rate), speed of
  the outgoing song during the mix, reached with `out_rate_ramp` between
  `out_cue − 15` and `out_cue − 7` s of its file; the incoming song plays at
  `playback_rate · out_playback_rate` ([P18](P18.md)).

### Execution in the browser

`stores/dj.ts`:

- From 65 to 45 s before `out_cue`: if the transition has `confidence < 0.35`,
  it requests `dj-transition`, with one request in flight and retries every 2 s while
  it stays pending or the network fails. It stops on getting a measurement or committing the
  transition. Late responses do not change a committed mix.
- 45 s before `out_cue`: loads the next song in the second player
  (`armTransition`).
- Transition with `confidence < 0.35`: it becomes a `safe_fade` of 6 s at
  most, the incoming song starts at 0:00. In a 4-minute song the
  fade starts about 24 s before the end.
- Reliable transition: overlap limited to 25% of the duration. The exit does not
  start before 90 s or 60% of the song, whichever comes first. If
  `out_cue` falls outside that window it is moved by whole bars (`bars`, or
  `beats` with a common bar sent) or whole beats (`beats` without a bar),
  within the measured coverage (`metricCuePlacement` in
  `ui_web/src/lib/djCue.ts` and `ProgramDjPlan.metricCuePlacement` on Android),
  not by an arbitrary amount. If it does not fit, the beatmatch becomes `structural_fade`.
- "Mix between songs" off: technique `direct`, the next song starts
  when the file ends.

`mixer.ts` and `graph.ts`:

- With shared tempo, the outgoing song reaches `out_playback_rate` with a smooth
  ramp driven by the position in its file before the incoming song starts.
- The incoming song starts silent up to 4 s before the mix point, at
  `playback_rate` times the speed of the outgoing song (each deck within 0.92–1.08,
  `preservesPitch` enabled). While it is silent its position is corrected **once**
  so that `in_cue` coincides with `out_cue`, with a tolerance of 5 ms,
  and since P18 also its speed (the phase corrections).
- Volume: equal-power curve (sine/cosine) during the overlap,
  computed with the clock of the incoming song. Limiter threshold at −6 dB
  during the mix.
- When finished, the speed of the incoming song returns to 1.0 in 8 s with a smooth start and
  end; the count stops during pauses.

| Technique | What it does |
| --- | --- |
| `bass_swap` | 220 Hz lowshelf: the outgoing song goes down from 0 to −18 dB and the incoming one goes up from −18 to 0 dB, in 6 steps spread over the whole overlap |
| `filter_blend` | Low-pass: the outgoing song goes down from 22 kHz to 700 Hz; the incoming one goes up from 900 Hz to 22 kHz |
| `long_blend` | `bass_swap` and `filter_blend` at the same time |
| `echo_cut` | One measured outgoing hit, corrected for speed; feedback 0.32 and echo send up to 0.32 (P9) |
| `structural_fade`, `safe_fade` | Only the volume curve; in the browser they are the same operation |

---

## P1. Precision of tempo and of the beat grid

**What happens.** `_window_features` (`dj_engine.py:466`) uses `hop = 512` at 11025 Hz:
one step equals 46.4 ms. The autocorrelation lag is a whole number
of steps, so the BPM can only take values separated by 8–10% near
120. `_snap_beat_frames` places each beat on a whole step, so each
beat can be off by up to about 23 ms. `_local_period` (the period used
to stretch the tempo) comes from those same intervals.

**Evidence (measured).** `python -I docs/internal/dj/bpm_probe.py` with click tracks:

| Real BPM | Measured `bpm` | Local period (BPM) | Grid intervals (s) |
| --- | --- | --- | --- |
| 118 | 117.45 | 117.42 | 0.464 / 0.511 |
| 120 | 117.45 | 117.42 | 0.464 / 0.511 |
| 122 | 117.45 | 117.42 | 0.464 / 0.511 |
| 124 | 129.20 | 129.03 | 0.464 / 0.511 |
| 126 | 129.20 | 129.03 | 0.464 / 0.511 |
| 128 | 64.60 | 64.59 | 0.928 / 0.976 |
| 130 | 64.60 | 64.59 | 0.882 / 0.929 |
| 140 | 143.56 | 143.54 | 0.417 / 0.465 |
| 174 | 86.13 | 86.08 | 0.650 / 0.697 |

Reading half the tempo (64.6 instead of 128) does not affect the mix because the
ratio is multiplied or divided by 2. What affects it is the jump between values.

**When it fails.**

- 120 against 122 BPM: both measure 117.45, the speed is not adjusted, and in a
  16-bar bass_swap (about 32 s) they end up out of phase by approximately one beat.
- 122 against 124 BPM: 117.45 against 129.2 (9%). It is considered incompatible, it is not
  stretched, and the tempo `score` is 0.
- Any pair: the entry point and the exit point are beats with up to ~23 ms
  of error each. This is the offset of a few milliseconds that the user hears.

In addition, when measuring with synthetic tracks of known beats (encoded in AAC,
like the previews) another, larger error appeared: the grid sat about 140 ms
**before** each beat, because of the time convention of the 186 ms frame, and
that bias varied ±15 ms depending on the type of kick drum. In some tracks it locked
onto the offbeat (+110 to +135 ms). And the clients clipped `out_cue` to their
allowed window (`resolveTransition`, `ProgramDjPlan.resolve`) by an arbitrary
amount, which took the entry off the bar when the clip was actually applied.

**Status: closed in #377.** `ANALYSER_VERSION` 4. Original changes:

P12 update (`2ca8ccf2`): the synthetic beat tolerances are kept,
the selection of their unit is revised, local grouping and subdivision
with abstentions are added, and the clients receive the explicit meter. The
`out_period × 4` described below is historical and only remains as compatibility
for old plans; [P12](P12.md) documents the current operation and real
errors. The evaluation figures of #377 are historical.

- `shared/dj_engine.py`, section *Rhythm*: its own STFT (window 1024, step 128
  = 11.6 ms) with logarithmic flux in 24 bands; tempo by autocorrelation with
  support at 2 and 4 beats and an interpolated peak; beat tracker by dynamic
  programming (Ellis 2007, vectorised by blocks); fit of a line by
  phase consensus and least squares (`_phase_fit`), or robust local curve
  (`_local_lines`) if the song drifts; beat/offbeat check with the
  energy level; and final alignment of the grid to the start of the attack
  (energy with pre-emphasis 0.95 in 2 ms windows, average over many beats).
- Constant or local grid decision: median of the deviation of the local curve
  from the line ≤ 12 ms, local tempo within 0.3% of that of the line and
  ≥ 55% of the weight of the beats on the line. It matches the classification of
  the reference in 47 of 53 real songs.
- `tempo_confidence` now measures something: share of beats that fit the grid; in a
  local grid it is multiplied by 0.7 (the mix keeps a single speed
  during the whole overlap). It enters `confidence` with the same formula.
- `downbeats`: chroma change (two beats before against two after) plus the strength
  of the attack. In the 17 real songs whose grid matches the reference,
  it is right in 9 (previously 4).
- `_local_period(analysis, cue, span)`: line through the beats of the segment being
  mixed, not the median of rounded intervals.
- `plan_transition`: `out_cue` ≤ `duration − overlap − 1.5 s` (the clients
  clip at 1 s) and cues, rate and periods with more decimals.
- Clients (web/iPhone and Android parity): if they have to move a measured `out_cue`,
  they move it by whole bars (`sync.out_period × 4`). The web now passes
  `sync.phase_tolerance_ms` to the mixer, as Android already did.

**Results (measured).**

- `python -I docs/internal/dj/bpm_probe.py`: 118–140 BPM measured with error ≤ 0.004 BPM and
  grid at ~1 ms from each click. 174 is still read as 87 (same beat).
- 18 synthetic tracks in AAC with kick drums of five shapes: BPM error ≤ 0.002%
  and grid at ±0.7 ms from the attack in those with fixed tempo; correct bar in 16.
  Mixable pairs (100): offset at the start of the mix, median 0.8 ms (previously
  49.6 ms); maximum during the overlap, median 1.0 ms (previously 237 ms).
- 53 real previews against beat_this (external reference, only for evaluation):
  grid on the beat in 19 (previously 8), different tempo in 11 (previously 25, mostly
  because of the value jumps).
- `tests/test_dj_beat_grid.py` fixes these thresholds with synthetic songs.
- Cost: see `docs/internal/PERFORMANCE.md`, *Beat grid analyser*. A single thread, without
  an increase in peak memory.

**Remaining limits (measured).**

- Salsa and other styles where the bass and the percussion accent the offbeat: the
  grid can sit half a beat from where a listener marks it. Two such songs
  mix well with each other; with one whose grid is on the beat, they do not.
- Live rock with a ternary feel: sometimes 3:2 or 4:3 of the reference
  tempo is measured.
- Breakbeat at 174 BPM with a syncopated kick drum: it is read at 87 and the grid can fall on
  the offbeats (synthetic case 12).
- A song that drifts keeps the local grid, but the mix uses a single
  speed: the offset grows during the overlap (P2).
- The attack rule marks about 3 ms inside a slow attack (6 ms) when there
  is no transient on the beat; with a click, on the click.

## P2. Phase alignment in the browser

**Status: closed on the web (PR #395).** Symptom measured and heard on 2026-10-26
("It's Not Right But It's Okay" → "Teardrops (Rules Remix)", web with
platform `other` and the page hidden at times): at the cue, the incoming song was 11 ms
out of phase and `mixer.ts` moved it with a `seek` while it was playing. The `seek`
took 370 ms (`media.seeking` → `media.seeked` in the trace) and left it 115 ms
(−0.24 beats) behind during the 30 s of the mix; the user heard the kick drums
doubled. Before the fix nothing corrected the phase after the cue.

**Fix.** During a mix with beatmatch, each tick compares the position of
the incoming song with the one it should have according to the outgoing song and, if it deviates more than
the plan's tolerance (5 ms), adjusts its `playbackRate` like a DJ with the pitch:
error/1 s, at most ±2%, in steps of 0.25%; it returns to the exact speed of the
plan when it is within half the tolerance. At the cue a
`seek` is only done if the error exceeds 100 ms, once and with the incoming song silent; the
mix opens when the `seek` finishes and the pitch closes whatever remains. Tests
in `ui_web/src/lib/audio.test.ts`.

What follows is the diagnosis before the fix, from reading the code.

**What happens.** `mixer.ts` (`tick`, phase `prerolling`) moves `currentTime` of the
incoming `<audio>` only once, while it is silent, with a timer
of 40 ms (`TICK_MS`). After that there is no more correction: if the tempos do not match
exactly, the offset grows during the whole overlap. `bass_swap` keeps
the bass of the two songs audible during a good part of the mix (−4 and
−12 dB in the outgoing song), so any offset is heard.

**Evidence.** Code reading. The error of `currentTime` has not been measured in
each browser.

**Android is different.** `ProgramMixOutput.kt` mixes the two songs into a
single output and `ProgramMixPlayer.kt` schedules the start of the mix in samples
of that output; the speed is applied with `PlaybackParameters` in
`ProgramDjSession.kt`. This point mainly affects the web. P1 affects both
platforms, because the entry and exit points come from the same server.
The offset on Android has not been measured.

**iPhone.** The native iOS app does not have DJ mode (`ios/App/Audio/DualDeckPlayer.swift`
only does crossfade). The DJ on iPhone is the web in Safari, so this point
affects it the same as any browser.

**When it fails.** In every mix with beatmatch. After P1 the points and the speed
arrive with an error of ~1 ms and 1e-6; what remains on the web is the precision of
`currentTime` in the single alignment and the drift of songs with variable tempo.

**Android, to be verified (not measured).** `ProgramDjSession.advance` loads the
incoming song with `setMediaItem(item, positionMs)` and `ProgramMixOutput.arm` consumes
`prerollMs` of its PCM assuming that it starts exactly at that position
(`streams[standby].positionOffsetUs`). If the decoder starts at the boundary of
an AAC frame (1024 samples = 23 ms at 44.1 kHz) and not at the requested position, the
incoming song would arrive up to 23 ms early or late. This can be checked with the
`presentationTimeUs` of the first `write()` after the seek in `ProgramMixOutput.Source`.

**Possible solutions.**

- Correct the drift during the whole mix: periodically compare the expected position
  of the incoming song with the real one and adjust `playbackRate` in small steps,
  instead of a single jump.
- In the longer term: play the two songs as `AudioBuffer` /
  `AudioWorklet` and schedule them with `AudioContext.currentTime` to get
  sample precision. Cost: decoding into memory (it conflicts with the policy
  of not retaining audio in RAM) and large changes in `graph.ts`.
- Measure first: instrument the phase error (expected incoming position against
  real) in `recordPlaybackDiagnostic` to have numbers per device,
  especially on the iPhone (WebKit).

## P3. The route order ignores transition quality

**What happened (since #385, before P3).** In the v6 route (`_build_music_set_route`, the one
the web always uses because it sends `sources`, and Android when it has sources):

1. `rng.shuffle(available)`, with a seed per session and segment.
2. The first 8 are taken and the transition of each pair is computed.

The energy arc (`_auto_set_arc_position`, the energy ordering, the choice
of the first song by energy and the `arc` field of the response) was removed
in #385; the test that fixed it too. These do not count: the transition
quality, `score`, `semantic_score` or the weight of the source
(`weight = 0.38 + 0.62·…`; it is only used to choose the first song).

`order_route` (`dj_engine.py:767`) does order with `0.42·transition + 0.38·semantic
+ 0.20·relevance`, but it is only used in the old route without `sources` (Android
without sources), in Fix mix (`dj-repair`) and when placing songs (`dj-place`).

**When it fails.** On every reload of the route. Two consecutive songs can be
incompatible in tempo or key even if there are compatible candidates in the pool.
`docs/internal/ARCHITECTURE.md`, `docs/internal/PLAYBACK_QUEUE_CONTRACT.md` and `README.md` no longer
say "recency decay" or "orders songs by tempo, key and energy" (#385).

**Decided design (2026-10-22).**

- No arc (done in #385).
- The v6 route orders by transition quality (`order_route` or its logic) and by
  **continuity**: the next song close to the current one in each P4 quantity
  (notes/s, LUFS, timbre, tempo). Each quantity is scaled by its spread
  among the candidates of that route; they weigh the same after scaling. There are no weights
  tuned to taste.
- Keep the weight of the source where it already counts (choosing the first song).
- The old `test_dj_plan_v6_does_not_steer_by_energy` fixed that the order did not
  depend on the analysis; P3 changes that part on purpose and keeps the selection
  and opening guards.
- The quantities are in the analysis: `note_rate`, `loudness_lufs`,
  `spectral_flatness`, `bpm`. `loudness_lufs` can be `None` (silence or
  less than 400 ms); `note_rate` and `spectral_flatness` are 0 in silence. An
  unanalysed song has none of them (P5: do not score it worse because of that).

**Status: closed, implementation `0e62b0fb`, on `main` at `6bb1af5d`.**

- `_build_music_set_route` first fixes the set (up to 8 songs), without
  consulting any measurement to choose its members. The opening keeps the
  weight of the source and the tie-break by shuffle; now it also requests its
  analysis if it is missing. No candidates or bridges are added in P3.
- `order_continuous_route` orders that set greedily. For each
  measured position it computes the distance to the remaining ones: differences of
  `note_rate`, `loudness_lufs`, `spectral_flatness` and `bpm`, each one divided
  by its population standard deviation in the chosen set. It adds the quality
  deficit relative to the best transition of that step, divided by the
  standard deviation of those scores. It minimizes the sum of the five
  squares, with coefficient 1 for all; there are no new weights tuned to taste.
  The transition score is still the one from `plan_transition`.
- The scales of the four quantities are kept during the whole route. The
  tempo is brought to the octave of the beat of the seed (or of the first available
  measurement): 60, 120 and 240 BPM represent the same beat. Constant or
  incomplete dimensions are omitted for all candidates; a measured zero
  does count. Ties keep the shuffle.
- An unanalysed song keeps its position. After it, the transition to the next one
  is not compared either: the shuffle order is kept
  among the remaining measured ones. This way no bad score is invented for the cold
  song, and a downloaded song cannot push it out of the set or delay it.
- Each transition of the response corresponds to the predecessor that actually
  stays in front of it, including the seed or the opening. Web and Android consume the
  same contract without client changes. The old route without sources, `dj-place`
  and `dj-repair` keep their existing `order_route` policy.

**Validation.** `tests/test_dj_route_continuity.py` checks the four
quantities separately, key, equality of influence when changing units
and permuting axes, half/double tempo, zeros, missing data, ties, cold
songs and chaining. `tests/test_discovery_save_route.py` checks the limit and
the selection independent of the cache with more candidates than positions,
opening on the recent source, determinism and the same members in cold,
mixed and warm. It includes a test with synthetic WAVs that goes through FFmpeg,
the real SQLite cache and HTTP; the final request cannot decode again.

**Read-only measurement, 2026-10-23.** Reproducible with
`python -I docs/internal/dj/route_probe.py --cache ~/.cache/soundsible/dj/analysis.sqlite3`.
10 current analyses, 1024 samples of 8 songs and random seed 0; same
set and same starting song in both variants. SHA-256 of the measurements:
`a7d3361172d784b6196619c0c942003986a17e172acf31623c94aa3e9a5f927d`.
No providers, decoding, cache writing or playback.

| Mean per transition (CPU per route) | Earlier shuffle | P3 |
| --- | ---: | ---: |
| Internal transition score | 0.383 | 0.484 |
| Fallback transitions | 82.0% | 60.8% |
| Notes/s jump | 0.537 | 0.514 |
| LUFS jump | 2.162 | 2.048 |
| Flatness jump | 0.0160 | 0.0142 |
| Beat jump in BPM (equivalent octave) | 18.66 | 10.20 |
| CPU per 8-song route | 0.63 ms | 3.29 ms |

**Limits.** Ten analyses do not represent a complete library; they are a
check of the measurements and of the cost, not a listening evaluation. The greedy
order does not guarantee the global optimum nor does it maximize only the mix score:
it also preserves continuity. With the whole set cold, the order is still
the shuffle and the conservative fades are kept; extending the
analysis coverage and adding bridges belongs to P5. There is no physical
acceptance of web, iPhone or Android audio in this delivery.

## P4. "Energy" does not measure intensity

**What happens (on `main`).** `energy = rms / percentil95(rms)` within the same
song (`_window_features`), and the mean is stored (`_compose`). It measures how uniform
the level of the song is, not how intense it is. Normalizing each song
against itself makes the values not comparable between songs, which
is exactly what the route needs.

**First attempt discarded: #384 (branch `fix/dj-energy-intensity`).** It replaced
`energy` with the spectral flatness of the strong frames on a logarithmic
scale (0.002 → 0, 0.25 → 1). It was validated against intensity ratings from 1 to 5
that the assistant gave to 75 songs from the user's library: Spearman 0.84
against 0.23 for the old measurement. The user rejected it, with reason:

- Flatness measures **timbre** (noise or clean tones), not musical activity.
  Bach's "Little" Fugue for recorder quartet (fast, dense
  counterpoint) gives 0.03, almost the same as Barber's Agnus Dei by VOCES8 (legato,
  long chords), which gives 0.00: flatness 0.0023 against 0.0017. Mozart 25 and the
  prelude to act 3 of Lohengrin also came out low.
- The ratings were given by the assistant, almost all on pop, rock and electronic music, where
  intensity and distortion go together. The global 0.84 hid that classical music
  failed entirely.
- The scale 0.002 → 0, 0.25 → 1 was a value chosen by hand.
- The "attacks per second" detector of the prototype was wrong: it gave 8.9/s to the
  Agnus Dei and 8.1/s to the fugue, because it counted vibrato, reverberation and noise, not
  notes. That is why it seemed that rhythm contributed nothing.

**Before starting.** The user's service (`soundsible.service`) was restarted
on 2026-10-22 at 15:04 with the repository on the #384 branch and wrote
analyses with `ANALYSER_VERSION` 5 to `~/.cache/soundsible/dj/analysis.sqlite3`.
**The redone P4 must use `ANALYSER_VERSION` 6**, so that those flatness
rows are not read as valid. #384 is a draft and is not merged.

**Decided design (2026-10-22).** Do not compute a single "energy". Measure per
song quantities with units, each one checked with synthetic signals of
known response:

| Quantity | Unit | Synthetic check |
| --- | --- | --- |
| Note density (real attacks) | notes/s | Tracks with known N notes/s, legato and staccato, with and without reverberation and vibrato |
| Integrated loudness | LUFS | `shared/loudness/measure.py` (EBU R128) already exists; the plans already carry `loudness_lufs` (`_annotate_plan_loudness`). Decide whether that measurement is reused or computed in the DJ analysis |
| Timbre: spectral flatness | 0–1 | Pure tone against noise; the block computation of #384 in `_spectral_features` can be reused, without the 0–1 scale |
| Tempo | BPM | Already exists (P1) |

Minimum acceptance criterion: Bach's fugue for recorders must measure
many more notes per second than Barber's Agnus Dei. Check it also with
real music from the library (`/mnt/storage/ARSU/music/library.json`,
`tracks/<id>.<format>`) without giving ratings: only compare measured quantities with what
is known from the score (tempo and figuration).

What is reused from #384: the block computation of flatness and its
equivalence test (`tests/test_dj_spectral_memory.py`), the shape of the synthetic
tests (`tests/test_dj_energy.py`) and the benchmark (`docs/internal/PERFORMANCE.md`,
`scripts/benchmark_dj_analysis.py --allow-changes`). What is not: the 0–1 scale, the
choice of the first song by energy and the `energy or 0.5` changes
(they stop making sense without a single energy).

**Status: closed in #385.** `ANALYSER_VERSION` 6. `energy` and `loudness_db`
disappear from the analysis; in their place:

- `note_rate` (notes/s). `_note_onsets` in `shared/dj_engine.py`, section
  *Notes*: spectral flux in the style of SuperFlux (Böck and Widmer, 2013). Window
  of 512 samples (46 ms) and step 128 (11.6 ms) at 11025 Hz; quarter-tone
  bands from 40 Hz to 5 kHz (below ~400 Hz each bin is a band);
  logarithm with a floor of −60 dB from the strong level; mean of 3 frames; each
  band against the maximum of its neighbours 2 frames earlier (cancels vibrato);
  from each band its own fluctuation is subtracted (median of the change in blocks
  of 3 s), so that noise does not count. Peaks: local maximum ±30 ms, 2 above
  the mean from −50 to +70 ms, 60 ms between attacks. It is counted over the
  seconds within 20 dB of the strong level, with silences of up to 1 s
  included (the silences of a piece are music). Memory bounded to blocks
  of 256 frames.
- `loudness_lufs`: the FFmpeg `ebur128` meter in the same decode
  (`_decode_measured`, one branch of the `asplit` ends in `anullsink`). It measures the
  original channels and frequency, the same as `shared/loudness` (same value
  as the levelling store for the same song) and it also works for the
  previews, which the store does not measure. The PCM comes out byte-for-byte identical to a
  decode without a meter (test). Songs longer than 8 min: power sum
  of the two measured windows (90 s + 120 s). Cost: +0.2 s of CPU on
  an 8 min song.
- `spectral_flatness`: geometric mean over arithmetic mean of the power, 100–
  5000 Hz, in the frames within 20 dB of the strong level, weighted by their
  power. No scale: 0 for a pure tone, e^−γ ≈ 0.56 for white noise.

The detector constants were chosen only with synthetic signals of
known response (`tests/test_dj_note_rate.py`), with a grid search
over 63 signals. Real music was measured afterwards, without ratings given by anyone.

**Synthetic results (measured, in the tests).** Melodies of 1, 2, 4, 8 and 12
notes/s, legato and staccato, with and without 50-cent vibrato and room
reverberation (RT60 2 s, reverberation 6 dB below the direct sound): all within
±25%. Four-voice chords repeated 2 to 8 times/s with 12 dB drops:
±25%. Sustained choir that changes chord 0.25–1 time/s: ±0.3. Drums: ±25%.
White noise: < 1 note/s (0.6). Fixed tone: 0. Level ×0.02: same value ±5%.

**Real results (measured, complete `analyse_audio` with FFmpeg).**

| Recording | notes/s | LUFS | flatness |
| --- | ---: | ---: | ---: |
| Bach, "Little" Fugue BWV 578, bass recorders | 5.00 | −14.5 | 0.0023 |
| Barber, Agnus Dei, VOCES8 | 0.42 | −14.7 | 0.0017 |
| Lumen Valo, Aestimatus sum (chant) | 0.79 | −31.5 | 0.0013 |
| Mozart, Concerto K. 488, II. Adagio | 1.46 | −25.8 | 0.0028 |
| Wagner, Lohengrin, prelude to act 3 | 1.53 | −13.0 | 0.0502 |
| Mozart, Symphony 25, I. Allegro con brio | 2.46 | −20.9 | 0.0162 |
| Bach, Concerto BWV 1052, I. Allegro (harpsichord) | 4.80 | −25.7 | 0.0229 |
| Radiohead, Everything In Its Right Place | 2.53 | −9.4 | 0.0144 |
| Soundgarden, Black Hole Sun | 2.75 | −7.9 | 0.1200 |
| Oliver Heldens, Ruins | 4.32 | −7.0 | 0.1050 |
| Sonora Ponceña, Fuego en el 23 | 5.20 | −9.7 | 0.0421 |
| Skrillex, Smoke | 7.56 | −6.0 | 0.1490 |

Acceptance criterion met: the fugue measures 12 times more notes per second
than the Agnus Dei (with #384 the flatness of the two was almost the same). The fugue is
in sixteenth notes at about 75 quarter notes per minute (≈ 5 notes/s): it matches.

**Remaining limits (measured).**

- Chords repeated on the same note with drops of only 6 dB and a room that
  fills the gap: ~40% of the strokes are counted (test
  `test_shallow_repeated_strokes_are_undercounted_but_still_ordered`). This is what
  happens with the triplets of the Lohengrin prelude (1.53 against ~6 in the
  score) and in part with Mozart's Symphony 25. They are still ordered: more
  strokes measure more.
- Fast legato (12 notes/s) in a cathedral (reverberation at the level of the
  direct sound): ~45%. With the test room (−6 dB), within ±25%.
- Pure white noise gives 0.6 notes/s.
- Flatness measures timbre (noise or clean tones), not activity: it is a
  continuity quantity for P3, not an intensity.

## P5. Analysed pool, previews and bridge songs

**Original diagnosis (before `31f696bc`).**

- When planning, `_dj_item_analysis(..., schedule=True)` only requests the analysis
  if the file already exists (`_dj_source_path`). For a preview that has not yet been
  downloaded it requests nothing.
- The browser downloads the preview in advance, but that download does not request
  analysis.
- The only one that requests it is `dj-transition`, 65 s before the cut, in the same
  call that responds `measured: false`.
- `maybeRefineTransition` marks the pair in `refinedPair` (`dj.ts:321`) before
  asking and does not ask again.

**Evidence.** Code reading. How many transitions end up like this has not been measured
in real playback.

**When it fails.** In the first transition to a YouTube song that was not
in the cache: it stays `safe_fade` of 6 s, entry at 0:00.

**Possible solutions.** Request the analysis when the server finishes
saving the preview in the cache. Repeat the refinement until there is a measurement or until the
moment of loading the next song (45 s before). Apply the same in
`ProgramDjRefiner.kt`.

**Extended (2026-10-22): analysed pool and bridge songs.**

1. **Measure first.** Add to the `dj-plan` log how many candidates had
   analysis on each reload. The `cache_hit` field of the current log counts the
   related cache, not the analysis cache. Measure how much it costs to download and analyse
   the previews of a typical reload (in the logs there are between 17 and 46
   unique candidates per reload; a preview takes about 3 MB; the analysis takes
   0.1–0.3 s of CPU per song).
2. **Analyse before choosing.** Download and analyse in the background the
   previews of a bounded number of candidates, chosen by the recommendation
   score or by the session seed, **never because they are already in the cache**.
3. **Whole local library analysed** in the background. It is cheap: 221
   songs shorter than 8 minutes in 25 s with 8 processes.
4. **Bridge songs.** If the next song mixes badly with the current one, insert
   between the two an analysed song compatible with both. The user
   accepts it. There are already bridges in `dj-place` (`_dj_place_bridge_pool`) and in
   `dj-repair` (`route_kind == "bridge"`); the v6 route does not use them.

**Condition: no circular preference.** What decides whether a song enters the
route cannot be that it is already downloaded or analysed. Ideas to meet this:
choose the set that is analysed before looking at the cache; do not score an
unanalysed song as worse than an analysed one (or do not choose until the whole
set is measured); and check it with a test that compares two identical pools
except in the state of the cache.

**Status: closed in `31f696bc`.** Implementation:

- **Set independent of the cache.** The session and segment seed fixes
  up to 16 candidates. The first `limit` (maximum 8) are still the original
  destinations, even if they are cold; the remaining ones are also prepared as possible
  bridges. Downloading and analysis never decide which songs enter that
  set. Exclusions, history and explicit sources are kept.
- **Preparation on the server.** `_dj_prepare_cohort` requests the local analysis and
  the acquisition of previews through the same prefetch queue as playback:
  one download path, deduplication by video, account context, refresh after
  CDN rejection, LRU limit and existing playback priority. It does not wait
  for the network or for FFmpeg inside `dj-plan`. Cache disabled: it does not download; the
  destinations still enter with conservative fades. The analysis queue
  accepts up to 64 pending identities, with two workers (since
  2026-10-28, one: the analysis runs in its own process; see
  [ARCHITECTURE](ARCHITECTURE.md#execution-analysis-never-runs-inside-the-engine)).
- **Immediate publication.** `CacheWriter.commit` requests the analysis after saving
  complete and validated bytes, whether the web, Android or the pool requested them.
  The signature of a preview uses size and content revision. Its `mtime` is the
  LRU clock, changes when serving ranges and no longer invalidates the analysis. Replacing the
  content or remuxing it does invalidate it. `ANALYSER_VERSION` 8 renews the cache;
  the musical measurements of P1/P4/P6 do not change.
- **Whole library (historical).** The serial sweep of all accounts
  deduplicated files and revalidated every five minutes. P14 removed its startup
  because the jobs belong to current sessions. Its module and the tests
  of that abandoned behaviour were removed in the
  [legacy code cleanup](../audits/2026-11-03-unused-code.md).
- **Measured bridges.** `shared/dj_pool.py`: only if the seed and **the whole**
  set are analysed. A cold candidate blocks the insertion, even if
  another, already downloaded one would serve as a bridge. At most one bridge per segment is accepted,
  without repeating it or removing destinations, when it replaces a transition without
  beatmatch with two segments whose real speed adjustment keeps the accumulated
  offset within the plan's tolerance (5 ms), and it improves the worse score of both
  compared with the direct segment. The best of those scores is chosen; ties
  follow the shuffle, without new ratings or taste weights. Maximum: 16 route
  songs. The sources of the recommender are still the explicit ones and the
  songs that actually played.
- **Web/iPhone and Android refinement.** Retries every 2 s within the window
  65–45 s, one request in flight per segment. They end on receiving a measurement or on
  committing the transition; the account, session, route change
  and late response guards are kept. A pending measurement or a network failure keeps
  the safe fade.
- **Contract and observability.** `analysis_coverage` in the response and the fields
  `analysis_candidates`, `analysis_ready`, `analysis_cohort`,
  `analysis_cohort_ready`, `bridges` in the log. `cache_hit`/`cache_miss`
  still count related songs, not analyses. The v6 response carries summarized measurements;
  complete grids and sections stay on the server. Sixteen grids of
  eight minutes at 220 BPM plus the seed would exceed 256 KiB, the native limit.

**Reproducible real measurement (2026-10-23).**
`.venv/bin/python -I docs/internal/dj/pool_probe.py --previews ~/.cache/soundsible/previews`
chooses 16 previews with seed 0 and writes the measurements to a temporary runtime;
it does not change the library or the personal cache. With `--download` it uses the normal
resolution and new acquisitions in that runtime. It does not print identities or URLs.

| Run over the 16 previews | Audio bytes | Acquisition | Analysis: wall / CPU |
| --- | ---: | ---: | ---: |
| Files already present, cold analysis | 78,863,763 (75.2 MiB) | — | 11.50 s / 8.36 s |
| Resolution + real download + cold analysis | 78,867,963 (75.2 MiB) | 59.74 s; median 3.39 s per preview | 10.69 s / 7.83 s |

The 16 downloads and the 16 analyses finished. Median per file: 4.90 MB and
0.50 s of CPU. Complete files are downloaded, not clipped samples. The
acquisition includes resolution, transfer, validation and remux; these figures
are from this machine and this connection, not a promise of general latency. The
limit of 16 avoids downloading the 17–46 candidates of a typical reload.

**Validation.** Tests of identical cold/warm pools verify the same
opening, destinations and prepared set, with limit, exclusions and history;
a partial cache adds no bridges. Bridge tests check both
transitions, absence of duplicates and preservation of destinations. Real AAC →
preview commit → analysis → SQLite → measured HTTP, with LRU read and
replacement of the content. Library of several accounts, podcasts, broken
files and shutdown. Web: pending requests and network failures, response after
committing the load of the second deck and complete browser4 suite. Android: JVM retry
policy and HTTP `DjRefinementTest` with real engine, service and decoders
(two pending responses and the third measured); native execution in the Android
checks of the PR. There is no physical listening acceptance in this delivery.

**Limits.** A cold reload responds immediately with the conservative order;
the refinement improves each transition before loading the second deck. Bridges
are considered in a planning run that finds the whole set measured:
a route already loaded is not redone when the background work finishes. If
a download fails persistently or the cache does not retain the whole set,
there are no bridges in that reload. That song is not penalized or removed because of it.

---

## P6. Key compatibility scored badly

**What happened.** `_harmonic_score` only looked at the distance between
tonics and uses the mode only when the distance is 0:

- The relative minor (A minor ↔ C major, distance 3): 0.68. On the Camelot wheel
  it is the most compatible combination after the identical one.
- C major ↔ C minor (parallel): 0.82. On Camelot it is 3 positions away.
- Fifth with a different mode (C major ↔ G minor): 0.86.

The detection (`_window_features`) used the mean spectrum of the whole song without
compensating harmonics, with bins of 5.4 Hz, which do not separate semitones below
~130 Hz. In addition it compared the profiles with a dot product without centring or
normalizing: the minor profile has a higher mean and norm, and won even with
major cadences.

**Status: closed in `af6521f1`.** `ANALYSER_VERSION` 7 invalidates the earlier
measurements. Planning stays on the server; web and Android receive the
same contract and the same fix through `dj-plan`, `dj-place`,
`dj-repair` and `dj-transition`.

- Compatibility: minimum distance in the graph of the
  [official Camelot wheel](https://mixedinkey.com/camelot-wheel/0/). The edges
  are ±1 position in the same mode and change to the relative major/minor. It is
  normalized by the diameter of the graph (7): `1 − pasos / 7`. There is no table of
  taste ratings per interval. Same key: 1; relative or fourth/fifth in
  the same mode: 6/7; C major → G minor: 4/7; C major → C minor: 3/7.
  Key or mode absent/unknown: the neutral 0.55 is kept.
- Chroma: Hann FFT of 16384 samples (0.67 Hz at 11025 Hz), hop of half a
  window, mean spectrum between 32.7 Hz (C1) and 5 kHz. Bins folded by pitch
  class; blocks of 32 windows, without a spectral matrix of the whole song.
  It resolves the low notes instead of discarding them. It adds no dependencies.
- Detector: Pearson correlation, like the
  [Krumhansl–Schmuckler algorithm](https://extras.humdrum.org/man/keycor/), with
  the published profiles that already existed, centred and normalized. `key_margin`
  is now the correlation difference between the first two. A silence
  is left without a key; previously it returned B minor because of the tie-break.
- The resolution constants are validated with synthetic cadences of known
  response, without human ratings or tuning with music from the library. It does not change
  the beat tracker of P1 or the execution of the mixes.

**Reproducible measurement.** `python -I docs/internal/dj/key_probe.py --reference 956e5344`
compares the earlier code with the current one, without writing to the personal cache.
Cadences I–IV–ii–V–I and i–iv–ii°–V–i, two seconds per chord, transposed to
the 24 keys. Pure tones and a timbre of six partials of amplitude 1/h:

| Register and timbre | Hits before | Hits now |
| --- | ---: | ---: |
| C3–B3, pure tones | 20/24 | 24/24 |
| C1–B1, pure tones | 1/24 | 24/24 |
| C3–B3, six partials | 12/24 | 24/24 |
| C1–B1, six partials | 9/24 | 24/24 |

In addition: 48/48 cadences at ±20 cents. The tests check the 576 key
pairs against an independent traversal of the graph, route selection,
HTTP response and technique choice, memory limits, PCM and
AAC decoding and replacement of the earlier cache. The bridge fixture of `dj-repair`
used 100 → 113 → 128 BPM: neither of the two segments could beatmatch and
it only passed because C → D was scored badly. It is corrected to 100 → 106 → 112 BPM,
with two mixable segments, without changing the bridge admission threshold.

**Real music (FFmpeg and complete analysis, without cache).** It was measured after
fixing the synthetic signals. `key_probe.py --audio <archivo>` accepts several
files and `--reference` to repeat the comparison. The audio is not uploaded.

| Library recording | Before | Now | Reference |
| --- | --- | --- | --- |
| Bach, BWV 578, bass recorders | D minor | G minor | G minor, title of the recording |
| Mozart, K. 488, II. Adagio | F♯ minor | F♯ minor | F♯ minor, [Mozarteum catalogue](https://kv.mozarteum.at/en/work/concerto-in-a-5654) |
| Mozart, Symphony 25, I. Allegro con brio | G minor | G minor | G minor, title of the recording |
| Bach, BWV 1052, I. Allegro, Bob van Asperen | C♯ minor | G♯ minor | D minor in the title; tuning of the recording not verified |

**Limits.** The harpsichord is not counted as a hit: there is still ambiguity
between tonic and dominant, and the analysis does not verify historical tuning nor
compensate the harmonics of each instrument. It also does not model modulations,
different keys at the entry and exit or atonal material; it keeps one
estimate per window. The 96 synthetic hits are not a general hit
rate on real music. The profiles have not been retouched for these examples.

Measured cost: +22 ms of CPU when analysing eight minutes of PCM, with equivalent peak
memory; method and reproduction in `docs/internal/PERFORMANCE.md`, *Tonality analyser*.

## P7. DJ profiles and direction without effect on the route

**Done in #385 (user decision, 2026-10-22: Android the same as the web).**

- The direction was removed entirely: `direction` in `dj-plan` (the old route no longer
  reads energy, familiarity, include or exclude; an old request that
  sends it gets the same route, test
  `test_dj_plan_ignores_the_direction_older_clients_still_send`), the endpoint
  `dj-command`, `api.interpretDjCommand`, `lib/djDirection.ts`,
  `mobile/DjDirection.tsx`, `setAutoDirection`, the `direction` state of the web
  and of Android and its passing through cross-device sessions (an old session
  that carries it is read without it).
- The 4-style menu of the Android `⋯` (`ProgramTransport.tsx`) was removed. The
  Android DJ menu offers the same as the web: sources and Fix mix.
- Web and Android always send `dj_profile: "adaptive"`: removed
  `localStorage` `auto:dj-profile`, `setAutoDjProfile`, the profile of the
  Android state (`ProgramDjPlanner.profile`, `djProfile` of `PlaybackService` and of
  `PlaybackPlugin`) and its validation in `ProgramDeviceState`.

**Status: closed in `d678f625`, option (b).** The request to implement the
next P applies automatic mixing to each pair, without bringing back style menus.

- **A single policy.** Removed `DJ_PROFILES`, `_PROFILE_POLICY`, the argument
  `profile` of the planners, `DjProfile`, `DJ_PROFILE` and
  `ProgramDjPlanner.PROFILE`. No client sends `dj_profile`; the server
  ignores it if an old client sends it, even with an unknown value.
  The scales, thresholds and execution limits of the earlier policy are
  kept; no new ratings are calibrated with songs and no randomness is added.
- **Executable technique.** The plan is built at its real points and the
  local adjustment is verified within the speed limit (6% then; 8% since
  P12-b) and the phase budget of 5 ms. If it does not fit,
  it is not labelled as beatmatch at speed 1: an eight-bar echo with a measured
  outgoing hit is planned again, or a structural/safe fade
  if there is not enough beat or confidence. The synchronisation of P9 does not change.
- **Measurable long mix.** It reuses the 32 bars and the maximum of 48 s that the
  clients already execute. It requires equal keys, Camelot neighbours or
  relatives, and more overlap than the ordinary mix. The intro opening and
  the outro tail can be extended only by contiguous breakdown blocks: the
  detector labels intro/outro in a single block of eight bars. Body,
  build, drop or a gap interrupt that region. Both grids must cover
  the whole segment; each one has half of the 5 ms to deviate from its
  local period. A mix is not extended across an unmeasured window.
- **All paths.** Explicit source route, legacy route, bridges,
  requests, repair and refinement use the same planner. `automation`
  is removed from the response, vectors and types (closing of P10); the players
  still execute `technique`. Measurements and analyser cache do not change.

**Reproducible validation.**
`PYTHONPATH=. .venv/bin/pytest -q -s tests/test_discovery_save_route.py -k 'measured_audio_sections or measured_aac_echo'`
generates known signals, encodes AAC, analyses and persists to SQLite. The long
mix uses a calm opening up to 64.25 s and a calm tail from
176.25 s, with a body of higher level between them: the detector produces the
contiguous blocks that allow an overlap of 48 s. Planning of
sources, legacy, placement, repair and refinement return the same plan,
with and without each old profile. The tests isolate the in-memory HTTP counter
per runtime: the matrix does not consume the budget of later tests. The
echo cases at 90 and 137 BPM against 120 BPM
choose it automatically in both routes and in the refinement.

`tests/test_dj_automatic.py` covers the six techniques, half/double tempo,
local period different from the global BPM, absence of sections, short opening,
gaps between sections, body/drop, grid gap, local drift, absent/distant key and
short file. The new long vector of `dj_structural_plans.json` and the five
echo vectors are executed by the web stores and `ProgramDjPlanTest` on
Android without moving points, shortening the segment or removing effects. The
native PCM tests and real Web Audio impulse tests of P9 are kept. The browser
regression is complete in the four profiles; build, lint and Android emulators
are checked in the PR checks.

**Limits.** There is no physical listening acceptance. The sections keep the
eight-bar heuristic and the analyser limits: without enough
opening/tail evidence the long mix is not chosen. There is no new energy
arc, style, hand-written taste or speed correction during
playback (P2 remains parked).

## P8. Sections measured and not used

**Original diagnosis.** `_sections_from_features` labels blocks of 8 bars (intro,
build, drop, breakdown, body, outro), but nobody reads the labels. `outro_cue`
only uses the phrase boundaries; `intro_cue` is the first instant with sound.
`loudness_db` was removed in P4 (replaced by `loudness_lufs`); `tempo_confidence` only enters `confidence`.

**Status: closed in `90b6c7e9`.** Only the planning changes, not the stored
measurements or their format; it was not necessary to invalidate the cache in P8. P12 consumes
the known groupings per region and invalidates its earlier measurements;
it kept the eight-bar assumption for phrases and labels. P13
replaces it with measured changes of the arrangement and roles with units; a region
without bar/1 does not fabricate structure from another window.

- **Exit by sections.** `plan_transition` reads the starts of outro and
  breakdown. It can start the mix in the outro or end it on reaching a
  breakdown. Since P13 a measured outro can be long: the exit can fall
  at its start or at any of its phrase starts. It chooses the valid opportunity closest to the earlier
  exit point; contiguous blocks with the same label form a single
  section. It adds no human ratings or taste weights. A short outro reduces
  the overlap to leave the 1.5 s margin of the server.
- **Entry at the drop.** With a reliable beat, it looks for the first drop that admits a
  measured entry and the farthest outgoing phrase within the maximum overlap.
  The end of that phrase and the drop coincide on the playback clock with
  a tolerance of 5 ms. The speed is computed near the chosen points and is
  checked with the rounding that the clients execute. It is not allowed to start
  before the intro or to skip more than the first quarter of the incoming song.
  If phrases, grids or speed limit do not fit, it keeps the intro.
- **Executable window.** The server first applies the limit of 25% of the file
  and the exit no earlier than `min(90 s, 60 % of duration)`, like web and Android.
  This way the clients do not later shorten a mix that was aligned to the drop.
  `overlap_bars` now describes the effective overlap.
- **Beat independent of key.** Absent BPM or `tempo_confidence ≤ 0.6`
  prevent bass_swap, filter_blend and long_blend: a structural or
  safe fade at normal speed is used. The 0.6 is the ceiling that the local grid already has
  in P1 (`(0.7 − 0.4) / 0.5`), not a new rating tuned with songs.
- **Same contract.** All routes and the refinement use `plan_transition`.
  The server keeps sections and grids; v6 continues sending compact
  summaries and the final plan. Web and Android do not interpret musical labels.

**Reproducible measurement (2026-10-24).**
`PYTHONPATH=. .venv/bin/pytest -q -s tests/test_discovery_save_route.py -k measured_audio_sections`
generates four-minute songs with beats at 120 BPM and eight-bar regions
of known level, encodes AAC with FFmpeg, analyses, stores to SQLite
and requests `dj-plan` and `dj-transition`. The two endpoints give the same plan:

| Measured case | Exit | Entry | Overlap | Speed |
| --- | ---: | ---: | ---: | ---: |
| Breakdown at 208.25 s, incoming drop at 64.25 s | 176.2499 s | 32.2498 s | 32 s | 0.999998 |
| Outro at 224.25 s, without a later phrase that fits | 224.2499 s | 0.2498 s | 14.25 s | 1 |

The first case makes drop and breakdown coincide within 5 ms; the second
keeps the intro and ends before exhausting the file. The grid tests
with synthetic drift also check the fade without beatmatch.
The end bound uses the duration actually decoded and the serialization
precision of 1 ms: AAC can keep additional samples relative to the
nominal 240 s of the signal (observed in the CI decoder).
`shared/contracts/dj_structural_plans.json` fixes four common vectors
(120→125 BPM with drop, short outro, unreliable beat and 90 s file): Python
checks the plan and the web suites and the Android JVM suites execute it without moving
points or shortening the overlap. There is no physical listening in this delivery.

**Limits.** The eight-bar heuristic labels were kept
(replaced in P13) and the detection limits of P1; these signals do not prove the classification of all
genres. No sections are invented in the central gap of long files
analysed by windows. Without a usable section the fallback points
are kept; without a reliable grid it fades without beatmatch. No speed
correction during playback is added (P2 remains parked).

## P9. Echo not synchronised with the tempo

**Original diagnosis.** `ensureEcho` used 280 ms with any BPM; Android
repeated that fixed delay in `ProgramDeckEffects`. Changing only the `delayTime`
to one beat was not enough either: in Chromium and WebKit the feedback loop
adds a block of 128 samples on each pass after the first.

**Status: synchronisation closed in `a8a22618`.** The existing HTTP
contract allows `echo_cut` with the profiles `cuts_drops` and `open_format`.
In that delivery the explicit route and both clients used `adaptive`, without
echo; the later automatic activation is closed in P7 (`d678f625`).
No selector is added and the technique policy is not changed to close P9.

- **Measured delay.** `plan_transition` includes `echo_delay_seconds`: one beat
  of the outgoing song, measured near the exit point and during the mixed
  segment. It does not use the incoming tempo or invent a period from
  `bar_seconds`. It requires analysed audio, grid, known BPM and
  `tempo_confidence > 0.6`; without them it replaces the echo with `structural_fade`.
  Only the plan changes: the measurements and the version of their cache are not modified.
- **Web.** Store → executable plan → mixer → graph keeps the delay and
  divides it by the real speed of the outgoing deck. The graph subtracts one block
  from the loop delay and adds it before the first input: both the first
  echo and the following ones fall on the beat. The echo path fixes two channels
  so that the loop negotiation does not cancel stereo in phase opposition.
  When removing it, it also disconnects the input of the effect.
- **Android.** The same field passes through `ProgramDjPlanner`, `ProgramDjPlan`,
  `ProgramDjSession` and `ProgramMixOutput` to the PCM buffer. It is adjusted to the
  outgoing speed and rounded to the nearest sample of the output.
  The buffer is prepared outside the sample loop, only for echo and with a
  maximum of two seconds. Changing the delay or restarting the deck empties the
  earlier tail. The session export keeps the field.
- **Fallback and levels.** Old plan without delay, invalid value, different
  origin, low confidence or mixing turned off: 280 ms are not invented. The echo still
  takes the levelled signal before the fade; the existing feedback
  0.32 and send curve are kept. No taste values are tuned.

**Reproducible measurement (2026-10-24).**
`PYTHONPATH=. .venv/bin/pytest -q -s tests/test_discovery_save_route.py -k measured_aac_echo`
generates synthetic music of known beat, encodes AAC, analyses, stores to
SQLite and requests legacy `dj-plan` and `dj-transition` with `cuts_drops`. The two
endpoints deliver the same plan:

| BPM of the outgoing signal | Expected period | HTTP delay |
| --- | ---: | ---: |
| 90 | 0.666667 s | 0.666668 s |
| 137 | 0.437956 s | 0.437956 s |

`shared/contracts/dj_echo_plans.json` fixes five cases: 55, 90, 120, 137 and
220 BPM against an entry of 173 BPM. The web stores keep the field.
`dj-echo.spec.ts` executes the real graph with stereo impulses of opposite polarity
in Chromium and WebKit: 44.1/48 kHz, speeds 1/1.04 and three repetitions per
case, 60 repetitions per profile. It checks position and amplitude of each channel;
the maximum error observed is one sample. The tolerance is three samples
(0.068 ms at 44.1 kHz), far below the 5 ms of the plan. `ProgramDeckEffectsTest` executes the same periods in native PCM and
checks the three repetitions, levelling, feedback and emptying of the tail.
`ProgramDjPlanTest` checks confidence, membership, mixing turned off and absent
or invalid values. `ProgramMixOutputTest` keeps echo with real decoders and
output, with an explicit period of 0.5 s, in the Android checks.

**Limits.** No physical listening in this delivery. A constant period does not follow
rubato: the echo is not applied with an unreliable beat. The web compensation corresponds
to the block of 128 samples of the default contexts verified in the
two engines. P9 by itself did not enable automatic echo or remove profiles or
`automation`: those later changes are closed in P7 and P10 (`d678f625`).

## P10. Dead code and outdated documentation

Done in #385: `api.interpretDjCommand`, `/api/discovery/music/dj-command`,
`_dj_command_direction`, `setAutoDjProfile`, `setAutoDirection`,
`setAutoProfile` (without callers; in addition it requested keys `autoMode.note.crate.*`
that did not exist), 76 unused `autoMode` text keys in the four
languages, "DJ style" in `docs/AUTO_MODE.md`, "recency decay" and "energy arc" in
`docs/internal/ARCHITECTURE.md` and `docs/internal/PLAYBACK_QUEUE_CONTRACT.md`, and the "orders songs by
tempo, key and energy" of `README.md`.

**Status: closed in `d678f625` together with P7 (b).** Removed `automation` from
`plan_transition`, the shared vectors and the web types; no player
read it and both still execute `technique`. The user documentation and
the operation sections of this handoff describe the current policy.

Later cleanup: removed the full sweep module that P14 no longer
started and its fixtures. It does not change the analyser, the cache, the plans or the
jobs associated with sessions; it does not require invalidating stored analyses.
See [scope and validation](../audits/2026-11-03-unused-code.md).

---

## Second phase: responsibilities and musical structure (2026-10-25)

**User decision:** add the rewrite by responsibilities and solve
the identification of the meter and of beat 1, taking into account their dependencies
with the phrases, the sections, the ordering and the players. The starting
diagnosis is kept as historical; the current closures are in the table
and in each point. Order: **P11 → P12 → P13**, one point per session unless
the user indicates otherwise.

### Starting diagnosis: historical checks and assumptions

At `ad59b838` there is no other pipeline that detects binary or ternary meter:

- `_tempo_lag` contains the comment "Binary metre" and reinforces the
  autocorrelation at one, two and four periods. It is an assumption of the tempo
  detector, not a meter or subdivision classifier.
- `_downbeat_phase` chooses among four positions by harmonic change and strength
  of the attack. It returns a position, without a specific confidence or the possibility
  of abstaining in the face of a tie or an ambiguous signal.
- `_compose` takes one of every four beats as the start of a bar and sets
  `bar_seconds = period * 4`. The contract does not express the beats per bar or
  the subdivision of each beat.
- `phrase_boundaries` starts from one of every eight bar starts.
  `_sections_from_features` also divides into blocks of eight bars and
  labels them by their level and movement measurements. Phrases and sections share
  that heuristic basis: they are not two independent detections that confirm the 1.
- `confidence` combines tempo confidence and key margin. It does not measure the
  certainty of the meter, of the 1 or of the phrase. A very regular beat does not guarantee
  any of the other three.
- The web (`planBarSeconds`, `djCue.ts`) and Android
  (`ProgramDjPlan.resolve`) reconstruct the bar as four periods of the
  outgoing beat. Changing only the server detector would leave this assumption
  active in both clients.

Separate musical concepts: **beat**, **beats per bar**, **subdivision of the
beat**, **start of bar**, **start of phrase** and **section**. For example,
3/4 has three quarter-note beats; 6/8 can be organized as two dotted quarter-note
beats, each one subdivided into three. A "ternary" label does not distinguish
those cases. Half/double tempo is not a meter detection either: changing the
unit of the beat changes how many beats describe the same bar.

**One-off synthetic diagnosis of this review.** Mono PCM at 11025 Hz,
48 seconds, beats every 0.5 s from 0.25 s; kick drum on all beats, accent
and chord change every three or four. `_compose` was executed directly in
memory and then `plan_transition`; without FFmpeg, cache, HTTP or playback.
Match of the 1: distance below 10 ms from the known start.

| Meter of the signal | Detected BPM | `tempo_confidence` | Real bar | `bar_seconds` | Detected downbeats that match the real one |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3/4 | 120.001 | 1 | 1.5 s | 2 s | 8/24 |
| 4/4 | 120.001 | 1 | 2 s | 2 s | 24/24 |

The pair 3/4 → 4/4 produced `bass_swap`, `playback_rate = 1`, confidence 0.763 and
`fallback = false`. It verifies the lack of a metric check; it does not prove
that a mix between different meters is always impossible nor does it determine
which technique must be used in each case. It is not a hit rate on real
music, a permanent test or a physical acceptance. P12 must turn the
case and its variants into reproducible fixtures with a known response.

### Relationships between the earlier points that must be made explicit

- **Tempo and order:** `plan_transition.score` already contains tempo; P3 again
  includes BPM among its continuity dimensions. There is influence through two
  paths. That is not enough to declare it a bug: document which goal each
  path serves and check whether the combined effect is the one decided, without new
  weights tuned to taste.
- **Route policies:** the source route uses `order_continuous_route`;
  the legacy route and parts of requests/repair use `order_route`, which
  combines transition, semantics and relevance. All of them call `plan_transition`,
  but sharing that calculation does not make their ordering goals equal.
- **Validity of the mix:** the calculation of half/double tempo relationships and
  of executed drift appears in planning, entry at the drop and admission of
  bridges (`dj_pool._beatmatched`). There must be a coherent definition of
  comparable beat and executable mix, not variants that diverge when
  the rhythmic model changes.
- **Phrases and sections:** a wrong 1 can shift both and their cues.
  P8 consumes the existing labels; P13 will review their detection and their limits.
- **Audio analysis:** rhythm, note attacks, key and texture use
  different windows and resolutions for different needs. Do not merge
  their FFTs or detectors just because all of them start from the same PCM. Sharing
  work requires demonstrating equivalence of measurements and a cost benefit.

## P11. Rewrite by responsibilities, contracts and policy coherence

**Status: closed, implementation `67d086cf`.** The responsibilities
and their contracts were separated without changing musical results or the cache format.
Map, units, dependencies, policies and reproducible evidence in
[ARCHITECTURE](ARCHITECTURE.md). The P12 contracts came later in
`2ca8ccf2`; the P12-a comparison and the P12-b integration were merged in #395;
P13 was closed afterwards.

- `shared/dj_engine.py` remains as the public facade. `shared/dj/` separates models,
  storage/acquisition, rhythm, per-window measurements, composition, structure,
  timing rules, transitions and routes. SQLite and the jobs have a single
  owner. The pure modules do not load storage or Flask.
- The searches for requests, gaps and repair are extracted from the endpoints.
  Tempo equivalence, local period and executed drift are centralized,
  keeping the two route policies and the web and Android guards.
- `Analysis`, `AnalysisSummary`, `WindowFeatures`, `RhythmWindow`, `Structure` and
  `TransitionPlan` distinguish complete measurements, summary and execution. They keep
  seconds, BPM, playback ratio, absent data and measured zeros. The
  central gap between windows is not filled and the cache is not invalidated.
- `python -I docs/internal/dj/extraction_probe.py --reference ad59b838` (available in
  `67d086cf`; removed when closing P11-a because since P12 the analyser
  version no longer matches that of `ad59b838`): complete equality
  of 7 PCM analyses, 784 plans, 168 routes, WAV/AAC and four cache reads
  without decoding, in both directions. The common vectors do not change.
  `key_probe.py` keeps 96/96 cadences, before and after; it can also load
  a revision after the separation without importing the current code by mistake.
  The analysis and queue benchmarks migrate their private points to the owner;
  extraction (18/480 s), WAV pipeline (18/900 s), HTTP with two
  analyses and the four queue scenarios with/without instrumentation are executed. It is a
  functional check of the tools, not a measured cost improvement.
- Local regression: 2,287 engine tests passed, one skipped and coverage
  77.30%; 1,762 UI tests. After closing the extraction, 74 targeted cases
  include the 13 boundary tests, bounded acquisition and gevent. The PR checks
  cover the final set and the web/Android executors. Without physical listening
  acceptance; no cost improvement or new metric detection is claimed.

### P11-a. Request bridges based only on score

**Status: closed (branch `dj/p11a-remove-legacy`).** The discrepancy was not
reached in production; the code that kept it is removed.

Before P12, `route_to_request` claimed to improve safety but did not require
beatmatch execution. With measurements of 100 → 109 → 119 BPM and keys
C → A → F# major it chose a bridge with two `echo_cut` at speed 1 that
won only by key, while `add_measured_bridges` added no bridge.
P12 required `beatmatch_fits` in each request, placement and repair segment,
but only if one of the two analyses had the `metric_regions` key.

Why the branch without `metric_regions` was not reached in production:
`_dj_item_analysis` and `/dj-transition` take the analyses from `cached_analysis`,
which only reads rows of the current `ANALYSER_VERSION`, or from the fallback analysis.
Every current analysis carries `metric_regions` (`analysis.py`) and the fallback one
carries it empty (`fallback_analysis`). The clients do not return analyses to the
server. The branch was only used by hand-written fixtures and the vectors
`dj_structural_plans.json` and `dj_echo_plans.json`.

Changes when closing it:

- Server: `beatmatch_fits` without condition in `route_to_request`; removed the
  legacy branch of `_closest_rate`, `_nearest_grid_point`,
  `_grid_point_at_or_before`, the echo and `metric_sync`; `rate_fits` requires
  `alignment` and `cycle_beats`; `comparable_ratio` is removed.
- Web: `planBarSeconds` no longer deduces a four-beat bar and
  `metricCuePlacement` does not accept a plan without `alignment`. The web is served by the
  engine itself, so it always receives plans of its same version.
- Android keeps reading plans without `alignment`
  (`ProgramDjPlan.barSeconds`/`metricCuePlacement`): the app does not check the
  station version and may talk to one from before P12.
- Fixtures with `metric_regions` (`test_dj_sections.measured`). The structural
  vectors keep cues and techniques and gain `alignment`. The echo ones use
  entry tempos without a common cycle within ±8% (with common cycles, 120 → 173
  BPM is a 2:3 at 1.04), and since they align nothing they score 0, as in production.
- `test_preserved_request_bridge_policy_differs_from_measured_cohort_admission`
  becomes `test_request_and_cohort_bridges_refuse_the_same_unexecutable_legs`.
- `docs/internal/dj/extraction_probe.py`, which no longer worked since P12, is removed.

The double influence of tempo (global compatibility of the pair and continuity of
BPM) remains inventoried in [ARCHITECTURE](ARCHITECTURE.md), without new weights
or recalibration; it did not depend on this branch.

### Scope

The starting diagnosis: `shared/dj_engine.py` gathered about 1800 lines of SQLite, background
jobs, FFmpeg, DSP, analysis composition, planning and routes. In addition,
`auto_mode.py` orchestrates sources and endpoints, and the clients own execution
guards. Define modules with these responsibilities; the names and the
concrete distribution of files are decided when implementing it:

| Responsibility | Produces / owns | Must not decide |
| --- | --- | --- |
| Models and contracts | Measurements, temporal coverage, units, absence of evidence and executable plan | Disk access, providers or playback |
| Analysis storage and acquisition | Identity, version, SQLite, decoding and bounded jobs | Musical order or mix technique |
| Musical analysis | Rhythm, key, note density, loudness and texture per measured windows | Sources, chosen candidates or player controls |
| Musical structure | Bars received from the rhythmic analysis, phrases, sections and candidate cues | Inventing a new beat or choosing songs |
| Transitions | Compatibility of the pair, technique, cues, speed, effects and execution check | Acquiring music or modifying the session |
| Routes and bridges | Order within the chosen set and evaluation of its transitions | Redefining the measurements or the validity of beatmatch |
| HTTP adapters and players | Session orchestration, compact contract and execution on each platform | Inferring meter or musical structure again |

- Define explicit types and units at the boundaries, separating complete
  analysis, summary for clients and transition plan. Distinguish absent,
  unknown and measured zero. Keep per-window coverage: do not interpolate
  the unanalysed central gap of long recordings.
- Centralize the repeated operations of tempo equivalence and
  plan validation, keeping their current result. Keep a validation
  boundary when admitting bridges and when executing; sharing the definition does not
  mean blindly trusting an incomplete or old plan.
- Inventory the policy of each entry: source planning, legacy,
  requests, placement, repair and refinement. Record which criteria are
  common and which differences are deliberate. Review the double influence of
  tempo and the use of `score` compared with the technique that is actually executable.
- Keep in this extraction the musical results and the existing policy
  differences. If the inventory confirms a contradiction that requires
  changing results, leave a concrete sub-point and its evidence in this handoff
  before closing P11; do not hide it as an organizational change.
- Keep the public boundaries and the injection points used by the
  tests, or migrate their consumers in the same delivery. Avoid circular
  dependencies, duplicated global state and SQLite access from the pure module.
- The server remains the owner of the musical plan; web and Android keep
  their appropriate executors. Do not incorporate the web stores into Android audio.

### Closing criteria

- Map of modules and dependencies documented, with a single owner for each
  shared measurement and rule. The endpoints do not contain a second planner.
- Before/after comparison on the same fixtures and analyses: same
  measurements, compatible cache, same orders and plans, with the same limits
  of rounding, speed, phase and overlap. Do not regenerate expectations to
  make an extraction that changes behaviour pass.
- Keep the common server, web and Android vectors, the existing AAC →
  SQLite → HTTP tests and the cold/warm and external session cases.
  Run the suites relevant to the real scope, including the complete browser
  regression if `ui_web/` is touched, according to `AGENTS.md`.
- Verify that single decoding, bounded memory and concurrency,
  DSP work outside the cooperative loop and compact responses are kept.
- Inventory of policy differences resolved or with explicit sub-points;
  update the table and leave P12 as the next work. An extraction without
  measurement changes does not invalidate the cache; if they change, apply their versioning.

## P12. Meter, subdivision, identification of the 1 and their confidences

**Status: closed with P12-b (2026-10-26).** #394 (`2ca8ccf2`) provided contracts
and guards, but its detector did not certify meter or 1 on real music and made the
tempo worse on `main`. P12-a compared open alternatives and the user chose
Beat This! `final0`. P12-b integrates it: beats and downbeats from the model (ONNX Runtime,
DBN in NumPy), grid fixed to the attacks as in P1 and two mix
guarantees, `beats` and `bars`. Evidence in
[detector_comparison/RESULTS](detector_comparison/RESULTS.md) (section P12-b) and
in [P12](P12.md). The [final revalidation](detector_comparison/FINAL_RESULTS.md)
of 2026-10-27 repeats the measurements and extends the evidence of planning,
cache and HTTP without changing the analyser or its policies. The P2 clock
fix was also delivered in #395; this revalidation does not modify it.

Current limits after P12-b:

- The reading of the meter may not be the written one: the DBN groups in 3 or 4
  beats and chooses the beat level (in the signals with two ternary beats it reads
  180 binary BPM where 120 ternary were generated). The common cycle makes
  the mix the same with any reading. What does depend on it is
  the count of phrases and sections (P13). In the synthetic 3/4 signals
  the model groups by 4 (in real waltzes, seen in its training,
  it is right); the independent confirmation does not promise it, but the estimated 1
  can fall on another beat of the bar.
- The independent confirmation does not appear in the real music measured (0% in
  GTZAN and Ballroom): real beatmatches declare `beats`; pairs without
  executable alignment keep `none`.
- Without annotations of the user's library, the v8/v9/v10 comparison of
  a sample only measures agreement (section P12-b of RESULTS).
- Physical acceptance confirmed by the user on 2026-10-30.

The following describes the contract of #394, which P12-b keeps:

- `metric_regions` distinguishes period/unit, beats per bar, subdivision,
  coverage and confidences of beat, grouping, subdivision and 1. Unknowns and
  changes are not filled with 4/4. The confidences describe evidence from the model,
  not calibrated probabilities of musical truth.
- #394 contrasted binary/ternary beat hypotheses; P12-b removes them
  (they were the cause of the 3:2 and 4:3 errors). The local groupings of 2/3/4/6
  beats remain as independent confirmation of the model's bars.
  The fixtures include anacruses, weak 1, offbeats, two subdivisions
  present, changes inside/outside a block, drift, tone, uniform beat and
  model downbeats wrong in phase or in grouping.
- The plan certifies `alignment: bars` only with both cues and the whole segment
  measured, confirmed and executable; 4 beats of 0.5 s and 2 of 1 s can
  share bars of 2 s. Since P12-b, the same beat in 3/4 → 4/4 gives `beats`:
  beat aligned, without promising the downbeats. Zero score and explicit fallback only
  without executable alignment (`none`).
- Routes, requests, placement, repair, refinement and bridges share that
  rule. Web and Android read the local bar, keep coverage when repositioning
  and degrade if it does not fit. Eleven common vectors verify both executors
  (three of `beats` since P12-b); the old contract keeps its fallback, without
  presenting it as a measurement.
- Cache invalidated and compact summary with explicit null values. AAC →
  SQLite → HTTP covers earlier rows, cold/warm state, one decode
  per file and all endpoints without re-detecting music in clients.
- Separate real evaluation: twelve Ballroom fragments, fixed annotations and
  hashes of each input. None certifies correct meter and 1; there are errors
  of unit, grouping and abstentions. They are documented without calibrating on those
  songs or turning synthetic results into real precision. There is no
  new physical listening acceptance.
- P8 now consumes only the known bars of each region, keeping
  the eight-bar assumption for phrases/sections (#394). P13
  replaces it with measured changes of the arrangement and roles with units.

Local validation of #394: main suite of 2,330 cases (77.44%), followed by 201
targeted cases on the final adjustments and three AAC/HTTP request cases
(single songs and artist); 1,772 UI tests and 23 JVM tests. Complete Chromium
with one worker: 353 passed, 71 expected skips; complete WebKit in a
Playwright image and read-only mount: 344 passed, 80 expected skips. The
runs with local concurrency had intermittent navigation/load failures
that do not repeat with the CI configuration; expectations have not been relaxed.
The GitHub checks of the last head of the PR complete the remote validation;
the physical listening acceptance is not replaced by these results.

### Agreed continuation: P12-a and P12-b

The user authorizes **testing and comparing** joint estimation of beat/meter/1
and maintainable open solutions, not only Beat This!. **With the results
on the table the user will decide** what to integrate. This agreement does not choose a
library or authorize skipping that decision because tests are green.

The [operational plan](DETECTOR_COMPARISON.md) fixes the order to advance quickly:

1. Freeze baselines, corpus/partitions and a common result boundary;
   develop a single runner and adapters in separate files. Include
   the joint tracking prototype and the families Beat This!, BeatNet,
   madmom/origin and modern fork, Beat Transformer and All-In-One; Essentia and
   librosa also serve as beat controls, without attributing to them a downbeat
   detector that they do not provide. Review availability, weights,
   licences, dependencies and maintenance; record exclusions with a reason.
2. Run all admitted ones and their variants on the same signals and
   recordings. Separate errors of tempo/unit, beat, grouping/subdivision
   and 1; measure coverage, abstentions, false certainties, CPU/RAM, load, disk
   and maintainability. Declare the training overlap per checkpoint:
   Ballroom already seen is not an independent test of all those models.
3. Get nearly end to end with the same adapter towards P12:
   AAC/WAV → backend → normalization → experimental SQLite → planner,
   routes and HTTP; contrast the existing plans and executors. Keep
   production and distribution dependencies stable during the comparison.
   Do not create a detector, cache or client interface per alternative.
4. Present a matrix by method/case, results, costs and trade-offs to the
   user and wait for their decision. P12-a does not end with just an inventory or
   with figures copied from papers. It also does not select a winner with manual
   weights or turn always abstaining into a resolved detection.
5. After the choice, integrate a single path in P12-b and develop P13 on
   it. Prepare the phrase/section fixtures beforehand and record the structural
   output of the models that have it; do not rewrite structure yet
   on a metric that could be discarded. Large deliveries that
   close P12-b and P13 together are allowed if they avoid overwriting code and demonstrate each criterion.

### P12-b: integration plan (2026-10-26)

**Executed.** Differences from the plan: the grid takes the time of each
beat from the activation peak between frames, weights the line by the measured
attack and corrects phase and period with the attacks at ±20 ms (one frame of the
model), not at ±35 ms: in `gtzan_rock_00001` the P1 window jumped to another
instrument. The ONNX session disables the 1DS telemetry of ONNX Runtime.

Test on the user's station (2026-10-26, techno/house). The
transitions sound much better, but in a `beats` mix the 2 of the
incoming song fell on the 1 of the outgoing song (measured by the user by hand and in the
traces: +0.47 s, one beat at 125 BPM, constant for the whole mix). Two causes,
fixed with regression tests:

- The browser did not apply at the edge of the coverage the 5 ms that the
  server allows; an overlap 0.9 ms longer than what was measured made the cue move.
- The repositioning step took the bar of the whole segment; a block without a
  regular bar inside the overlap reduced it to one beat. Now it is the
  bar of the cue's region.

In the same test: the DBN skips beats in half-time passages, and the
initial slope assumed consecutive beats. Stable songs ended up
as "drift" (confidence 0.34-0.49) and without beatmatch. The beats are numbered
across the skips before fitting (confidence 1.0 in those songs) and
`ANALYSER_VERSION` goes to 11.

A single path, with the decisions above. One coherent delivery (server,
persistence, endpoints, web, Android and packaging), supported by the contracts
and guards of #394. Starting evidence in
[detector_comparison/RESULTS](detector_comparison/RESULTS.md).

1. **Runtime and weights.** Single, lazy ONNX Runtime session, one thread,
   export with split attention (`onnx_probe.py --sliced-attention`),
   NumPy frontend and chunking of Beat This!. `onnxruntime` enters
   `requirements.txt`, the Docker lock and the PyInstaller sidecar. The asset
   carries SHA256; without valid weights the analysis abstains, without another detector.
2. **DBN in NumPy.** Port of the `DBNDownBeatTrackingProcessor` that Beat
   This! uses (3 and 4 beats, 55–215 BPM, 50 fps, λ 100, observation 16, threshold
   0.05, correction to peaks). Equality against the retained `beatthis-final0-dbn`
   outputs, with activation fixtures in the tests.
3. **A single decode.** FFmpeg at 22050 Hz with the LUFS meter in the same
   pass; the 11025 Hz measurements are derived in NumPy. Check P1/P4/P6
   with their synthetic signals; `ANALYSER_VERSION` goes up.
4. **Grid.** The model decides tempo, octave, phase and the candidate 1. The
   fine adjustment of P1 cannot move a beat to another attack: in the comparison,
   the local refinement lowered the synthetic F1 from 0.80 to 0.68 although it left the
   90th percentile at 1.4 ms. Result: 0.845 synthetic F1 and 1.5 ms
   90th percentile with the P12-b grid.
5. **Guards.** New level `alignment: beats`: beatmatch with a reliable beat at
   both cues and the whole overlap, speed ≤ 8% and 5 ms of phase. `bars`
   only if the model's 1 coincides with independent evidence (grouping
   and phase of `metre` on the same grid); otherwise, `beats`. Web
   (`metricCuePlacement`) and Android (`ProgramDjPlan`) today degrade everything that
   is not `bars`: they must reposition by whole beats. New common vectors.
6. **Cleanup.** Remove from the beat the 3:2/4:3 hypotheses of #394 and the code
   that no longer has readers.
7. **Evidence.** Repeat the comparison with the integrated analyser (it must
   equal `beatthis-final0-dbn`), AAC → SQLite → HTTP cold/warm, complete
   web/Android suites and comparison of the local v8/v9/v10 cache.

The original scope and criteria are kept below.

### Scope

- Extend the rhythmic model to express the unit of the beat, its period,
  the beats per bar, the subdivision, the bar starts and the temporal
  coverage of each estimate. Allow ambiguity, changes per region and
  "unknown"; do not fill them with a 4/4 that looks measured.
- Separate confidence of beat, of meter and of identification of the 1. Define
  which evidence allows asserting each thing. A clear key or a regular
  beat must not automatically raise the certainty of the meter.
- Evaluate grouping and subdivision hypotheses with known signals,
  including 3/4, 4/4 and 6/8. Do not limit it to changing `range(4)` to another number,
  nor treat ternary subdivision as a half/double tempo relationship.
- Review together tempo selection, beat/offbeat and bar
  phase. The current detector favours binary repetitions before estimating
  the 1; changing only its last stage leaves that bias intact.
- Adjust cues, bar duration and overlaps to the local measurements.
  Half/double tempo must keep the interpretation of the meter and the declared
  unit; it cannot accidentally turn two bars into one.
- Evaluate metric compatibility per pair and during the mixed segment.
  Making the two downbeats coincide at the start does not ensure that they keep coinciding
  if the bars have different durations. Define and verify the alignment
  that each technique actually promises, including a conservative exit when
  there is not enough evidence. Do not declare all different meters incompatible
  by default nor promise bar alignment based only on BPM.
- Bring the same rule to ordering, requests, repair, refinement and
  bridges; the choice of a technique and its admission must use the same
  metric validation of the pair. Review the `score` and its consumers so that
  the declared quality does not hide that the requested alignment is not executable.
- The server must send the information needed to keep the bar
  when repositioning cues. Remove the implicit `out_period * 4` from web and Android and
  review `overlap_bars`, limits and types. Keep explicit compatibility
  with old or incomplete plans, without presenting their 4/4 as a new measurement.
- Keep the echo tied to a measured outgoing beat and to the real speed,
  with an unambiguous unit. A meter change does not authorize turning the delay
  into a bar or deducing it from the incoming tempo.
- Invalidate the old measurements with `ANALYSER_VERSION` and adapt persistence
  and HTTP summary. The clients receive the compact plan, not the complete
  grids of the whole set or their own musical detector.

### Closing criteria

- Reproducible fixtures with known beats, meters and subdivisions:
  3/4, 4/4, 6/8, different starting positions, anacruses, weak accents
  on the 1, syncopations, offbeats and half/double tempo ambiguity. Include
  meter changes, drift and material without a beat or without an identifiable meter.
- Measure separately tempo error, temporal beat error, accuracy of the
  meter/subdivision, accuracy of the 1 and abstentions. Set tolerances with
  known signals, without human ratings, taste scores or calibration
  on songs chosen after the fact.
- Reproduce the earlier 3/4 → 4/4 diagnosis: do not require a specific technique
  by its name; check that the plan respects the interpretation and alignment
  guarantees it declares. Also cover compatible pairs and local periods
  different from the global BPM.
- AAC → analysis → SQLite → HTTP, with replacement of the earlier cache and
  cold/warm cases; shared vectors executed by web and Android,
  including cue repositioning without assuming four beats again.
- Separate evaluation with real music and an explicit reference, without confusing
  agreement with another detector with absolute musical truth. Report coverage,
  errors and limits per case; physical listening remains separate evidence.
- Update the current operation and the limits of P1/P8; P13 stays
  pending until phrases and sections are checked on the new model.

## P13. Phrases and sections on an explicit metric basis

**Status: closed (PR #399).** Method, constants and evidence in [P13](P13.md).
On the bars of P12-b (model downbeats or projected ones), without another detector:

- **Phrase start**: measured change of the arrangement at a bar line (in an
  octave band, ≥ 3.01 dB and more than three standard errors between the four
  bars on each side; each bar is the median of its beats). Between
  changes, whole bars from each one: with the length that their
  intervals share (binomial test at the 3σ level with Bonferroni) or with eight
  bars marked as `assumed`. The count restarts at each change
  (extensions, phases that do not start on the first 1).
- **Roles** with units: without a bass beat (44–177 Hz ≥ 10 dB below the
  loudest section, less than half the loudness) → breakdown/build;
  return of the bass beat → drop; opening/closing by the entry/exit of the
  bass beat or by changes that only add/remove sound → intro/outro;
  `None` without evidence. A level jump is not a drop.
- **Planner**: end of the mix on measured phrases before assumed ones;
  exit at any phrase start of a measured outro, not only at its
  beginning. Client contract unchanged; `ANALYSER_VERSION` 12.
- **Evidence**: `tests/test_dj_structure.py` (4/4, 3/4 and 6/8; phrases of 4, 8
  and 16 bars, shifted phase, extension, no common length; roles;
  ambiguous material; wrong bars; gaps and windows), AAC → SQLite →
  HTTP with the real network (four cases, one new one of phrase phase) and two
  new vectors executed by web and Android. Separate measurement with
  `docs/internal/dj/structure_probe.py` → [p13-results.json](p13-results.json).
- **Limits**: without structure annotations of real music (the library only
  gives agreement); physical acceptance confirmed by the user on 2026-10-30; the errors of the 1 and of the
  grouping are inherited as they are; changes that are only harmonic are not detected.

Starting diagnosis: P12-b did not change the grouping of phrases and sections;
it counted eight bars from the model's downbeats. The structure fixtures of
P12-a (`structure_4/8/16_bars`) are in the fixed corpus; All-In-One did not
provide a useful structural output on them (P12-a, RESULTS). P8 closed the use of the sections when
planning, not a general detection of musical form. The grouping
into eight bars did not demonstrate where a phrase starts or where a
section changes; both could look coherent because they shared the same assumption.

### Scope

- Distinguish the estimate of the 1, the start of a phrase and the section boundary,
  with their evidence and coverage. Consume the rhythmic model of P12, without another
  meter detector or reconstruction by independent modules.
- Review the fixed eight-bar grouping and the initial phase of that
  grouping. Consider phrases of other lengths, anacruses, extensions
  and meter changes; it is not enough to count from the first available 1.
- Estimate boundaries from measured changes of structure and content,
  contrasted with the available meter. When an eight-bar assumption is used
  as a fallback, keep its status as an assumption and its uncertainty.
- Separate boundary detection and musical label. A level jump by
  itself does not prove a drop; review intro, outro, build, breakdown and body with
  signals that distinguish their conditions, without taste ratings or new weights
  calibrated by ear. Do not force labels when evidence is missing.
- Revalidate exit in outro/before breakdown, arrival at the drop and long mix
  of P7/P8: cues and overlaps must respect the measured structure and the
  real execution limits, without using correlated phrases and sections
  as if they were independent confirmations.
- Keep the unmeasured regions of long files as unknown.
  Do not fabricate phrase, section or bar continuity across the gap.
- Keep a single planner for all endpoints and web/Android execution
  parity. Version the cache if measurements or their meaning change.

### Closing criteria

- Known signals with phrases of four, eight and sixteen bars, shifted
  starts and extensions; 3/4, 4/4 and 6/8; section changes inside and outside
  the old fixed block. Cover ambiguous material and discontinuous windows.
- Measure separately boundary error, phrase length/phase, section
  label and abstentions; distinguish the failure inherited from the beat or meter from the
  structure's own failure. The tests must not fix only label names.
- Prove that the boundaries and labels change the correct decisions of
  exit, entry and duration through AAC → SQLite → HTTP, and that the same
  plan arrives executable at web and Android without adjustments that break the alignment.
- Keep the physical limits, the selection without cache bias and the other
  current decisions. Record real evaluation and physical acceptance
  separately; update table, operation and limitations when closing.
