# DJ responsibilities after the P12 infrastructure

P11 extracted `ad59b838` without changing measurements, orders or plans. The public
entry point is still `shared/dj_engine.py`: it re-exports the functions,
without copies of the cache or job state. P12 added local metric
measurements and execution validation ([P12](P12.md)). P12-b replaces its beat
and metre detector with the one chosen in the [P12-a comparison](DETECTOR_COMPARISON.md):
Beat This! `final0` on ONNX Runtime with the DBN ported to NumPy. The
experimental adapters remain outside these production owners.

## Owners and dependencies

All the musical modules are in `shared/dj/`. Only `store` accesses disk,
SQLite, FFmpeg, runtime and jobs, and only `weights` accesses the model weights and
their download. The pure modules can be imported without loading
storage or Flask; a test checks this in another process.

| Module | Responsibility and output | DJ dependencies |
| --- | --- | --- |
| `contracts` | `Analysis`, `AnalysisSummary`, `WindowFeatures`, `RhythmWindow`, `Structure`, `TransitionPlan`, units, analysis version and absence of evidence | None |
| `beat_model` | Log-mel spectrogram, block-wise Beat This! prediction with a given session and time of each beat between frames | `dbn` |
| `dbn` | Joint decoding of beats and downbeats (3/4 beats, 55–215 BPM), equal to madmom | None |
| `rhythm` | Precise grid from the model beats (local straight/curved line and P1 onsets), harmonic/onset observations and subdivision per region | `contracts`, `metre` |
| `metre` | Metre and downbeats estimated by the model per region; independent confirmation with groupings of 2/3/4/6 beats; abstentions | None |
| `features` | Note onsets, key, texture and measurements of a window | `rhythm`, `contracts` |
| `structure` | Phrases from measured arrangement changes on the bar lines, phrase length, sections with a role and candidate cues, over the bars received from P12 and the octave bands of `features` | `contracts`, `timing` (`projected_bar`) |
| `analysis` | Decimation to 11025 Hz and composition of the complete measurements; aggregates windows without filling gaps | `features`, `structure`, `contracts` |
| `weights` | ONNX weights: packaged or cached path, SHA-256, single download and single-thread session | None (runtime) |
| `store` | Identity, content stamp, SQLite, decoding to 22050 Hz with LUFS in the same pass, bounded queue; in the engine, each measurement is delegated to `worker` | `analysis`, `beat_model`, `weights`, `contracts`, `worker` |
| `worker` | Analysis process: measures one song at a time outside the engine; the engine starts it, closes it after 5 min without work and replaces it if it hangs or dies | `store` (in the child process), `contracts` |
| `timing` | Local period and metre, half/double beat equivalence, drift and beatmatch admission | `contracts` |
| `transitions` | Single `plan_transition`: compatibility, technique, cues, speed and echo | `timing`, `features` (note names), `contracts` |
| `routes` | Continuity, legacy route, arrival at requests, gap choice and repair between anchors | `transitions`, `timing`, `contracts` |
| `shared/dj_pool.py` | Admission of bridges within the fixed set before querying the cache | `transitions`, `timing` |
| `session` | HTTP demand of the session: epochs, cancellable requests and actually accepted route | `shared/work`, `store`; adaptation towards `auto_mode` |
| `shared/work.py` | Bounded jobs shared per resource, interests, cancellation and expiry | Runtime and account context |
| `shared/related_work.py` | One extraction and cache write of related tracks per seed for DJ and Discover | `shared/work`, database |
| `shared/preview_cache.py` | Shared complete bytes, acquisition with demand; on completion, it notifies only the DJs that still need them | `session` → `store`, `shared/work` |
| `shared/api/routes/auto_mode.py` | Sources, references, session, acquisition, calls to pure policies and HTTP adaptation | Facade, `routes`, `contracts`, `dj_pool` |

There are no storage imports from the pure modules and no dependencies going
back from the planner towards HTTP. The endpoints no longer contain the
gap search, request scoring or musical reconstruction of the
repair. The sources and the recommender still choose the set.

Since P14 there is no automatic analysis of
the library or of NORMAL playback. The clients publish the current song
and the next eight of the accepted route. The set of alternatives to order
is still fixed before reading the cache; cold discards are not acquired. The
bridges already measured can be reused within that set. The cache does not
own jobs: only the current consumers keep them. Contract, fallbacks
and disconnection limits in [P14](P14.md).
The sweep module that was no longer started was removed in the
[legacy code cleanup](../audits/2026-11-03-unused-code.md).

## Contracts, units and coverage

The `TypedDict` describe the boundaries and keep the current JSON. The aliases
`Seconds`, `BeatsPerMinute` and `PlaybackRatio` make their units explicit without
adding wrappers to the PCM or to the persisted format. `AnalysisInput` accepts
partial/old reads; a complete type does not mean that input is validated.

- `WindowFeatures` and `RhythmWindow` use seconds relative to the window. Their
  coverage is `[offset, offset + window_seconds]`. `Structure` transforms those
  points to absolute seconds, without extending the grid between head and tail.
- `Analysis` keeps the complete lists of beats, downbeats, phrases, sections
  and `metric_regions`. `AnalysisSummary` omits them for v6; it does not remove unknown scalars,
  zeros or future measurements. The other endpoints keep their previous response.
- `note_rate` and `spectral_flatness`: `None` means no measurement; zero is valid.
  `loudness_lufs = None` can also mean that the meter has no
  reading, for example in silence. Zero BPM expresses an unknown beat.
  `outro_cue = None` requires placing the fade with the loaded duration.
  An empty list expresses lack of grid/structure evidence.
- `confidence` still combines tempo and key. In `metric_regions`,
  `beats_per_bar`, `bar_seconds` and `downbeats` are the model estimate
  (P12-b); `metre_confidence` and `downbeat_confidence` only stop being zero
  if the independent grouping matches in size and phase. None of them is a
  calibrated probability of musical correctness. `bar_seconds` can be `None`:
  the unknown is not filled with four beats. The scalar summary also
  distinguishes changes or unknowns.
- `Phrase` and `Section` (P13, [P13](P13.md)): phrases start at a measured
  arrangement change or at whole bars from a downbeat; `evidence` distinguishes
  `boundary`, `counted` (measured length) and `assumed` (eight bars, fallback).
  Sections group phrases with a measured role; `label = None` is lack of
  evidence, and `low_db`/`upper_db` are the levels in dB relative to the
  loudest section of the song. `analysis_summary` omits `phrases` like the other
  lists; the client contract does not change.
- `TransitionPlan` is the executable decision of the server. `score` describes
  compatibility for ordering; it does not certify that beatmatch is executed. The echo
  keeps its measured outgoing period. P12 adds shared metric vectors;
  P12-b changes `three-to-four` to `beats` by user decision and adds three
  `beats` vectors. When closing P11-a the structural and echo vectors
  of P7/P8/P9 are regenerated with analyses that carry `metric_regions`, like the
  production ones: same cues and techniques, now with `alignment`.

`timing.pulse_relations` gives the common cycle of two beats (m beats of the outgoing
song = n of the incoming one, relations 2ᵃ·3ᵇ) and its speed; it is shared by
scoring, entry at the drop, final speed, `metric_sync` and bridge
admission. `tempo_coordinate` keeps the logarithmic projection of BPM onto
the octave of the route reference: it is a different operation and has a different goal.
`local_period` keeps the fit on the grid around the cue.
`rate_fits` uses the rounded periods and speed and the whole overlap;
the planner limit is still 5 ms. Bridge admission also verifies
BPM and technique, and rejects plans without executable `alignment`, incomplete plans
or plans with invalid values.
`metric_sync` declares what the two players can maintain during
the whole segment: `bars` with confirmed downbeats in both songs, equal
executed bars, phase of both cues and stable grids; `beats` (P12-b)
with a shared stable beat, both cues on measured beats and regular grids
without gaps, and the common estimated metre only as a
repositioning guide; `none` in the rest. The previous musical score is kept for
executable mixes and becomes zero with `none`. `beatmatch_fits` is the same admission for
source bridges, request bridges, placement bridges and repair bridges. An analysis
without `metric_regions` is treated as one without measured regions: there is no previous
contract to keep (P11-a).

The guards of each player still check identity, duration,
overlap, speed and ownership of the plan; sharing a server rule
does not replace that execution boundary.

## Policy inventory

| Input | Order/choice | Bridges and constraints |
| --- | --- | --- |
| `dj-plan` with sources, v6 | Set/shuffle independent of the cache; `order_continuous_route`: `score` deficit and differences in notes/s, LUFS, flatness and BPM, normalized by dispersion; fixed cold positions | `add_measured_bridges`: seed and whole set measured, both segments with beatmatch technique and admissible executed drift; keeps all the destinations |
| `dj-plan` legacy, v4 fill | `order_route`: 0.42 transition + 0.38 semantic + 0.20 relevance; source sequence; neutral quality 0.62 when analysis is missing | Does not expand the set like v6; analyzes the accepted route |
| Legacy song/artist requests | `choose_request_segment` → `route_to_request`; mean of `score`, destination relevance and existing delay costs | Beam of up to 48 states, 12 candidates, up to four bridges; destination preferred next. Requires `beatmatch_fits` on every segment, including the final one (P12; P11-a closed) |
| Automatic `dj-place` | `choose_placement`: mean of incoming and outgoing transitions, minus 0.009 per gap; a tie favours the earlier gap | Up to two bridges; with a fixed position no bridges are acquired or admitted |
| `dj-repair` | `repair_route`: anchors and depth kept; fill with `order_route`; stability bonus of 0.06 to the existing rows | Arrival at the anchor with `route_to_request`, up to two bridges; ceiling of 16; does not grow by filling. Exclusions do not override explicit anchors |
| `dj-transition` | Only `plan_transition` against the current measurements of the two files; without choosing songs or reordering | Cache read and possible asynchronous scheduling; no decoding inside the request |

The double influence of tempo is kept explicitly: the `score` uses the
global BPM mismatch to describe the compatibility of the pair (together with harmony
and confidence); the continuity distance uses BPM to keep the
magnitudes of the route close. The dispersion of each dimension determines its scale.
They are not two independent confirmations of the beat or two estimates of the
metre. P11 does not add weights or recalibrate that influence. P12 keeps the weights
and applies metric validity as a binary requirement, not as another taste weight.
The difference between
v6 continuity and legacy semantics/relevance is deliberate and was already present in P3.

### P11-a: closed

Contradiction that the P11 extraction kept: `route_to_request` claimed to
improve safety but compared only `score`. In the fixture
100 → 109 → 119 BPM, with keys C → A → F# major, it returned a bridge
with two `echo_cut` at speed 1 that won only by key, while
`add_measured_bridges` kept the direct destination.

P12 required both segments to be executable when an analysis carried
`metric_regions` and left the old rule for those that did not carry it. In
production that branch was not reached: the cache only returns rows of the
current analyzer version, every current measurement carries `metric_regions` and the
fallback analysis carries it empty. Only hand-written test fixtures
and the structural and echo vectors used it. When closing P11-a that
branch is removed (also `comparable_ratio` and the reading of four beats per bar on
the web), the fixtures now carry metric regions and the same fixture
remains as `test_request_and_cohort_bridges_refuse_the_same_unexecutable_legs`.
Android keeps reading plans without `alignment` because it can talk to
a station older than P12.

## Extraction evidence

`python -I docs/internal/dj/extraction_probe.py --reference ad59b838`, in `67d086cf`
(removed when closing P11-a: since P12 the analyzer version no longer matches
the one of `ad59b838`), ran the previous monolith and the P11 modules
with the same dependencies and signals, without personal data. It required complete
equality, not a newly generated expectation:

- 7 PCM analyses: beats at 90/137 BPM, silence, tone, noise, regions of known
  level and a 600 s recording measured by head/tail. No beat is added
  in the gap between 90 and 480 s.
- 784 pairs and 168 routes, including cold data, zeros, unknown duration,
  half/double tempo, low confidence, short file and long mix.
- WAV/AAC: one decoding per file and identical analysis; four reads
  without decoding of old/new rows in both directions. Same analyzer
  version and SQLite schema; the cache is not invalidated.

The existing tests keep their musical expectations and HTTP,
web and Android vectors. The private injection points move to the owner:
`store._cache_path`, `store._analyse_pcm`, `store._decode_measured` and
`store._compose` for storage/execution outside the loop;
`features._spectral_features` for FFT and `analysis._compose` for pure PCM.
The public imports of the facade keep working with a single instance
of the state. The tempo and key probes and the analysis/queue benchmarks
use those owners; the queue instrumentation observes the real work
of `store`, and the separate revisions are loaded in another namespace.

Up to 64 pending identities, deduplication by identity,
SQLite connections per thread and block-wise FFT are kept. The rhythm,
key and note-onset FFTs are not merged and no performance improvement is claimed: P11 changes
the organization and the boundaries.

## Execution: analysis never runs inside the engine

Since 2026-10-28 the engine does not decode, does not run ONNX Runtime and does not do
DSP with NumPy. `store.start_analysis_process()` (called when the API starts)
makes each measurement go to `shared/dj/worker.py`, a child process without
gevent that measures one song at a time with OpenBLAS on one thread. The engine keeps
SQLite, identities, queue and priorities; it waits for the response without blocking its
loop. The acquisition queue has one job, because the process measures one
at a time; the library sweep still yields to session requests.

Reason: the engine serves everything from a single gevent loop and gevent starts
each subprocess with `fork()`. With the DSP in native threads of the same process,
an FFmpeg `fork()` coinciding with a multithreaded OpenBLAS matrix product
blocked in the OpenBLAS `atfork` handler: the loop did not
return and the station became unreachable with one core at 100 % until a
manual restart (three times between 26 and 28-10). Rules of the engine
process in `shared/cooperative.py`; tests in `tests/test_cooperative_process.py`
and `tests/test_dj_worker.py`.

- An analysis that does not respond in 630 s is killed and the next request starts
  another process; the child dumps its stack and exits at 600 s on its own.
- A source that the process could not measure (error, crash or timeout) is not
  retried until its stamp changes or the engine restarts.
- The result is identical to the in-process analysis, which tests,
  probes and benchmarks still use (`store._analyse_pcm`).
- The desktop executable (PyInstaller) is also its own analysis
  process: `soundsible-engine --dj-analysis-worker`.
- The child reads the next request only between measurements, on its main
  thread. A thread blocked reading stdin during a measurement hung the
  Windows version when loading the NumPy DLLs (a pending synchronous read
  on a pipe blocks other calls on that handle).
