# DJ session progress: first measurements

2026-10-30. Question from the listener: do transitions and the music selected
fit better as a session progresses, without interaction?

**Result: an evolving candidate neighbourhood is visible; a general improvement
in transition compatibility is not established.** The preparation hypothesis
needs a distinction: analysis coverage when a route is selected does not
generally rise. Analysis becoming ready before the actual mix remains a
plausible benefit that the historical logs cannot measure completely.

This is an observational study plus an offline counterfactual. It changes no
selection, analysis, planning, audio execution or telemetry. The listener's
physical acceptance remains recorded in HANDOFF; it is different evidence from
a trend within sessions.

## Evidence and reproducibility

- Code baseline: merged `main` at `81e331df`; the preceding two local commits
  only update the language instruction and the listener's physical acceptance.
- Private snapshot taken at 2026-10-30 17:10:03 UTC, covering evidence from
  October 26 onward. Historical clients and analysis versions differ across
  these days; this is not exclusively a post-P16 population.
- Engine journal: 43 logged DJ session IDs; 12 have a nonempty opening response
  at segment 0 and at least one later nonempty segment. Retries at one segment
  count once, using its first nonempty response. Each session has one vote.
- Account-local delivery logs, including their gzip rotation: eight eligible
  continuous handoff runs, 58 completed track attempts. Runs require at least
  five tracks, with four handoffs, on the same device. Their inferred start/end
  times must join within five seconds. Selection, resume, ordinary ended/next
  loads, missing deliveries and larger gaps split runs. Changing the joining
  allowance to two or ten seconds still gives eight runs.
- Trace database: 42 captures, 157 retirement events. Only five `mix.started`
  events retain a technique; older clients omit it. One retained capture has
  missing sequences. Capture lifetime is not DJ session lifetime.
- Current analysis cache: 515 analyses. Four of the eight delivery runs have
  current analysis for every track, yielding 31 pairs for replay. Never fill a
  missing analysis with an older version or bridge over a missing track.

[Aggregate results](session-progress-results.json) include hashes of every input
snapshot and relevant Python source. Raw databases, device/session/song
identities and logs stay outside the repository, under
`~/.cache/soundsible-dj-session-study/2026-10-30/`. SQLite inputs were frozen
through the backup API in read-only connections, including committed WAL data.
JSONL inputs were copied; the study reads those copies. No audio was acquired
or decoded, and no provider requests were made.

```sh
.venv/bin/python docs/dj/session_progress_probe.py \
  --snapshot ~/.cache/soundsible-dj-session-study/2026-10-30 \
  --output /tmp/session-progress-results.json
.venv/bin/python -m pytest tests/test_dj_session_progress_probe.py -q
```

`plans.log` contains only journal lines with `dj-plan session=` since October
26. Journal timestamps use Europe/Madrid; the tool converts them with its
timezone rules. Delivery timestamps are Unix time. Input hashes distinguish a
new snapshot from a rerun. No seed or session identifiers enter the output.

## What changes during a session

The current web client calls `rememberDjExploration` on actual playing events
and forward playback updates (`stores/runtime.ts`). It admits generated songs
in the current direction, retaining four distinct recent roots
(`stores/dj.ts`). This does not wait for the 30-second listening-learning event.

`_build_music_set_route` combines explicit sources with neighbours of these
roots. `_exploration_related` calls `_planner_context_related` with
`personalise=False`: this path expands from played songs; the evidence does not
show an online taste model being trained to improve this session. It is also
different from using all proposed candidates as new roots.

Membership is frozen before analysis reads. The DJ then orders measured songs
for continuity; unmeasured songs keep their shuffled slots. Only accepted
upcoming songs obtain preparation demand. Refinement can later improve the
mixing plan as their analysis arrives. Therefore **better execution-time
preparation and better selection-time ordering are separate hypotheses**.

## Planning: opening versus last observed refill

These are paired, equally weighted means over the 12 eligible planner
sessions. Each row compares the same session's first nonempty segment 0 with
its last observed nonempty segment. The last observed segment need not be the
session's eventual final segment.

| Measurement | Opening | Later | Session direction |
| --- | ---: | ---: | --- |
| Available candidate songs | 29.5 | 57.75 | 11 grew, 1 shrank |
| Analysed share of the planning cohort | 41.15% | 29.69% | 4 rose, 6 fell, 2 tied |
| Analysed songs in that cohort | 6.58 | 4.75 | 4 rose, 6 fell, 2 tied |
| Related-graph request cache-hit share | 87.50% | 61.25% | 2 rose, 10 fell |

The cohort has 16 songs in these observations; it includes possible spares,
so its coverage is not the analysed fraction of the final audible route.
Related-graph cache hits describe recommendation lookup, not downloaded audio
or DJ analysis. Their decline is consistent with newly encountered roots; it
does not by itself identify why any candidate appeared.

All paired sessions retain one source at both endpoints. The logs do not
retain source contents or direction revisions, so that count cannot certify
an absence of user edits.

The latest session is a useful counterexample to monotonically warming
selection: candidates go 24 → 104 → 97, while analysed cohort members go
1/16 → 0/16 → 1/16. Later music is often drawn from a broader and less analysed
neighbourhood, rather than an increasingly warm fixed pool.

## Delivery and retrospective pair replay

For each eligible delivery run, compare its first two incoming handoff tracks
with its last two. These are disjoint even in the shortest run. Seven runs
report zero rebuffering at both ends. One reports 432.5 ms per incoming track
early and zero late. No compared endpoint reports a recovery. These events
measure declared transport behaviour, not beat phase or physical audio output.

For musical pair measurements, replay the actual sequence with current cached
analysis and the current pure planner. This is **a present-day counterfactual**:
it does not recover the historical plans, analysis availability, manual cues,
client fallback or runtime speed restrictions.
Cache entries are matched by production identity and current analysis version;
their source stamps are not revalidated against audio bytes in this study.

| Fully replayable run (delivery run number) | Tracks | Score: first two → last two pairs | Fallback share: first two → last two |
| --- | ---: | ---: | ---: |
| Oct 28 afternoon (5) | 17 | 0.696 → 0.200 | 0% → 50% |
| Oct 29 morning (6) | 5 | 0 → 0 | 100% → 100% |
| Oct 30 late morning (7) | 5 | 0 → 0 | 100% → 100% |
| Oct 30 afternoon (8) | 8 | 0.428 → 0.761 | 50% → 0% |

Only the 17-track run matches an observed planner session opening within five
seconds. The other three start within existing sessions. **Four replayable
runs are not four complete session starts**, and the longest run gets one vote,
like the shortest. The replayable subset excludes half of eligible runs due
to missing current analyses; that selection can bias the result.

Across the four runs, mean planner score goes 0.281 → 0.240, fallback share
stays at 62.5%, and planned overlap goes 12.79 → 15.53 seconds. Smaller measured
changes are not consistent either: loudness difference falls 1.06 → 0.91 LUFS,
note-rate difference rises 0.432 → 0.525 notes/s, and spectral-flatness
difference rises 0.0302 → 0.0315. Planner score and overlap duration are not
listener quality scores; longer overlap does not establish a better mix.

The tool also shuffles each run's non-opening songs 256 times with fixed seed
0, preserving its opening and membership. The aggregate JSON retains the
resulting mean early/late differences. These are a positional control, not a
reconstruction of historical recommendation pools. The sample is too small
and selected to interpret this as a significance test of listening quality.

## Same pairs with and without analysis

Replan the same 31 pairs twice: with current full analysis, and with only each
track's duration plus the production absence-of-analysis representation.
Fallback share changes from 100% without analysis to 41.94% with it: **18 of
31 pairs become beatmatch-capable in this replay**.

This confirms a concrete mechanism by which preparation can help. It does not
measure how many live transitions waited for analysis, whether that happened
more often early, or whether the listener preferred those techniques. Cold
planner overlap values are not actual client fade durations: client confidence
guards, placement and refinement still apply.

## Interpretation and next measurement

The strongest supported statement is that the session's musical neighbourhood
changes and usually broadens. The general early-to-late improvement remains
unresolved. These results neither substantiate a universal warming trend nor
disprove the listener's experience.

To measure the original claim prospectively, the missing evidence is one
linked record per session and transition, obtained automatically:

1. Session ID, direction revision, transition ordinal and source changes, plus
   manual versus automatic advance, pause/resume and reconnect markers.
2. At route selection: fixed cohort membership, measured coverage and the
   selected sequence's feature changes, without letting analysis availability
   affect cohort membership.
3. At refinement/commit: whether both analyses are ready, chosen technique,
   cues, overlap, alignment guarantee, and reason for a conservative plan.
4. At execution: actual technique/rate, signal/clock fallback and completion,
   joined to that exact plan and pair rather than inferred from timestamps.

Compare the first two transitions against later ones within unchanged,
unattended sessions, separately by client revision and cold/warm opening. Keep
recommendation continuity, preparation and execution as separate outcomes.
The existing logs cannot reconstruct those missing historical fields. A future
capture change should collect them before changing an algorithm in response
to this study. No such production instrumentation is included here.

Validation: seven focused tests cover retry and upload deduplication, missing
openings, session boundaries, missing analysis versions, missing trace
sequences, absent technique fields and equal weighting. Ruff and diff checks
pass; PR checks must pass on the final remote head before delivery.
