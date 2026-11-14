# P12: revalidation of the final analyzer

Measured on 2026-10-27, with analyzer 11 that reached the release.
**The 62 inputs reproduce exactly the BPM, the confidences and the per-case metrics
of the model and of the grid of the previous integrated report.** No new
regression appears in that corpus and production is not changed. Traceability is
completed and the evidence for pairs, AAC, SQLite, HTTP and long windows is extended.
P13 was pending in this revalidation and was closed later ([P13](../P13.md)); the decision for Beat This! `final0` from #395 is kept.

## References and traceability

- Original corpus and partitions: 30 GTZAN (10 development, 20 test), 12 Ballroom
  seen in training and 20 known signals. Audio and annotations verified
  by SHA256 before inference; original tolerances of 70/10 ms, unchanged.
- [Final analyzer, events and complete analyses](results/integrated-final.json.gz):
  revision `2695bd9a`, analyzer version, 42 hashes of
  sources, weights, FFmpeg, Python, NumPy and ONNX Runtime. Each phase identifies its
  own evaluator; [release provenance](results/final-provenance.json)
  checks that the analyzer sources match the published ones.
- [Previous report](results/integrated-p12b.json): its hash is recorded in the comparison.
  It did not record a version or revision: one is not assigned to it retrospectively. The
  previous equalities are of the measured outputs, not a guess about its code.
- [Per-case comparison](results/final-method-case.csv): previous baselines,
  `final0` original DBN, model events and final integrated grid. The
  [29 original configurations](results/method-case.csv) are kept; this
  revalidation repeats the chosen method, without running inference again on the discarded ones.
- Reproduction: commands in the [README](README.md#revalidation-of-the-final-analyzer).
  The `.json.gz` files contain complete JSON; no audio is redistributed.

## Detection

F1 is over events, not a percentage of correct songs. Cases with a reference
are averaged; explicit absence of events and missing annotation are kept.
The grouping and subdivision per case are in the CSV and the JSON, without filling
the notated unit of the real music or folding its tempo errors.

| Corpus / partition | Cases | Beat F1, grid | Downbeat F1, grid | Correct tempo (<4 %) | Confirmed downbeat coverage |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ballroom/seen_diagnostic | 12 | 0.9522 | 0.9733 | 12 | 0.0 % |
| GTZAN/development | 10 | 0.9151 | 0.8919 | 10 | 0.0 % |
| GTZAN/test | 20 | 0.8131 | 0.7695 | 14 | 0.0 % |
| synthetic/known_signal | 20 | 0.8449 | 0.7052 | 15 | 53.5 % |

That is 24/30 correct tempos in GTZAN and a downbeat F1 of 0.8103 when combining development and
test; the fixed split is kept in the table. Ballroom does not prove
independence. The first 579 confirmed downbeats of known signals
match the reference, without false certainties; in real music none
is confirmed. Beat confidence expresses stability, not the probability of a
correct musical reading: eleven GTZAN test cases exceed 0.6 and three disagree in
tempo with the reference (`disco_00001`, `disco_00002`, `reggae_00002`).

Phase errors persist even when the tempo is correct, such as `gtzan_metal_00001`
and `synthetic_3_2_syncopated`, both with beat F1 0 and confidence 1. The signals
with two ternary beats keep readings at another level. These limits were already
in the integrated report; repeating it does not turn them into solved detection.

## Continuity over the retained events

[Corpus continuity](results/final-continuity.json) and
[AAC continuity](results/final-continuity-aac.json), with `mir_eval` 0.8.2 in the
experimental environment. Inference is not repeated and no dependencies are added to the
engine. The recomputed F1 matches the retained one for both outputs and all
cases; complete CMLc/CMLt/AMLc/AMLt are per case in the JSON.

| Corpus / partition | Beat/downbeat cases | Beat CMLt | Downbeat CMLt | Beat AMLt | Downbeat AMLt |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ballroom/seen_diagnostic | 12/12 | 0.9893 | 1.0000 | 0.9893 | 1.0000 |
| GTZAN/development | 10/10 | 0.9183 | 0.9671 | 0.9183 | 0.9671 |
| GTZAN/test | 20/20 | 0.6677 | 0.6928 | 0.9570 | 0.8898 |
| synthetic/known_signal | 18/17 | 0.7778 | 0.6367 | 0.8333 | 0.6956 |

CMLt and AMLt are continuity metrics different from the F1 at 70/10 ms. They are not
converted into downbeat confidence: the real AAC has a downbeat F1 equal to 0, CMLt 0 and
AMLt 0.9375. Cases without events or without a reference are not converted into zeros;
the table shows the effective denominators. Metric equivalences are not
interpreted as correct identification of the annotated first beat.

## AAC and production path

The five AAC files fixed before the comparison are codec diagnostics, without
extending the independent test. [Complete results](results/integrated-final-aac.json.gz):

| Corpus / partition | Cases | Beat F1, grid | Downbeat F1, grid | Correct tempo (<4 %) |
| --- | ---: | ---: | ---: | ---: |
| GTZAN/codec_diagnostic | 1 | 0.9920 | 0.0000 | 1 |
| synthetic/codec_diagnostic | 4 | 0.7267 | 0.7381 | 2 |

The real AAC keeps the beat (F1 0.992) but its downbeat has F1 0: this is not hidden behind
the synthetic mean. The synthetic ones confirm 108 downbeats, none false.

[Production → SQLite → HTTP](results/final-pipeline.json): eight files, the
five AAC and three diagnostic WAV, actually analyzed with `analyse_audio`;
no predictions are injected. The eight analyses match completely the
retained outputs of the probe. Rows of the previous version are not accepted;
the eight cold pairs use the fallback, with `measured: false` and `alignment: none`.

Warm, the same plan is checked in seven inputs: refinement, sources,
placement, repair, legacy and track/artist requests. That is 56 responses
with zero decodes; the largest takes 8645 bytes and the summary does not
include complete grids or regions. Each file is decoded once.
The eight cold measurements add up to 57.791 s of CPU and the eight warm reads
1.055 ms of CPU, a single observation, without a performance interval.
The first cold analysis includes loading the model.

The long 600 s recording is generated by repeating a fixed signal. Only
[0,90] and [480,600] s are decoded; the two windows have regions and grid, and the gap
[90,480] has none. Requesting alignment at 300 s returns `none`.
It is a coverage check, not another musical precision corpus.

HTTP uses the test client and providers/acquisition replaced by
local fixtures. The station cache and library are not opened. This
validates production from local files, not a real provider download.

## Planning of all pairs

[3782 directed pairs, without self-repetition](results/final-pairs.json.gz),
with the complete plan retained. All of them satisfy coherence between technique,
guarantee and `beatmatch_fits`, the 8 % limit and normal speed in the fallback.
No specific technique is forced and no new weights are assigned.

| Outgoing / incoming | Pairs | `beats` | `bars` | `none` |
| --- | ---: | ---: | ---: | ---: |
| Ballroom/Ballroom | 132 | 38 | 0 | 94 |
| Ballroom/GTZAN | 360 | 66 | 0 | 294 |
| Ballroom/synthetic | 240 | 92 | 0 | 148 |
| GTZAN/Ballroom | 360 | 66 | 0 | 294 |
| GTZAN/GTZAN | 870 | 126 | 0 | 744 |
| GTZAN/synthetic | 600 | 146 | 0 | 454 |
| synthetic/Ballroom | 240 | 75 | 0 | 165 |
| synthetic/GTZAN | 600 | 116 | 0 | 484 |
| synthetic/synthetic | 380 | 170 | 40 | 170 |

In total: 895 `beats`, 40 `bars` and 2847 fallbacks. The 40 `bars` are synthetic;
their 80 cues can be checked and match annotated downbeats, without false cues or
evaluator abstentions. A uniform beat without an identifiable downbeat does not get
`bars`. In real music the maximum observed is `beats`; many pairs require
the fallback because of the execution guards. Admitting a plan does not prove perceptual
quality or that the model chose the correct downbeat when it only promises a beat.
These rates belong to the fixed corpus fragments; they do not estimate
beatmatch admission on complete songs or in the user's library.

## Cost and server response

CPU in seconds per minute of audio, mean of per-case ratios, one pass.
The model uses one thread and one inference at a time. Shared Linux x86_64 machine;
frequency and other activity are not controlled. The real fragments of 30.01 s
force computing two blocks: do not extrapolate their cost to long songs.

| Corpus / partition | Decoding | Model + DBN | Measurements |
| --- | ---: | ---: | ---: |
| Ballroom/seen_diagnostic | 0.010 | 8.129 | 0.144 |
| GTZAN/development | 0.010 | 8.598 | 0.145 |
| GTZAN/test | 0.007 | 8.547 | 0.140 |
| synthetic/known_signal | 0.008 | 5.174 | 0.122 |

[Real gevent server, client in another process](results/http-latency-final.json):
two simultaneous complete analyses of 120 s WAV, without providers. During
the final run 4684 requests are answered: median
1.22 ms, p95 2.00 ms and maximum
25.18 ms. The reference of the same published code is also
repeated in another process; these are response observations, not evidence of a
new optimization. Memory and model size remain documented in
[RESULTS](RESULTS.md#running-without-pytorch); their peak is not measured again here.

## Validation and limits

The revalidation adds integrity checks for the corpus, cohorts and annotation
margins. Local validation:

- Comparison, model, grid, metric and HTTP suite: 190 passed and one
  skipped because no weights were found in `models/` inside the initial worktree.
- Follow-up with the verified weights: 29 passed in comparison and
  model checksum; it includes the skipped check and the two new cases
  of the annotation margin. The two passes overlap, they are not added up as distinct cases.
- `ruff check docs/internal/dj/detector_comparison tests/test_dj_detector_comparison.py`
  and `git diff --check` pass; the seven measurement/evaluation runs and the
  comparison of the eight analyses with the production path completed.

The GitHub checks of the last head are recorded in the PR.
The implementation changes only the experimental bench and the documentation;
the production sources and the analyzer version are kept.

This run is Linux x86_64. It does not repeat inference on Windows/ARM64, physical tests
of web/Android players or listening. It also does not add references from
the personal library, music not seen by all the models or annotations
of phrases/sections. Continuity is completed in the experimental phase indicated above; its
explicit absences are not converted into zeros. The original
generalization limits remain in force and P13 keeps its independent acceptance.
