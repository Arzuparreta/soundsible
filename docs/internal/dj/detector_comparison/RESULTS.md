# P12-a: evidence for choosing the detector

**Measurements complete; the user chose Beat This! `final0` (2026-10-26).**
The comparison and the P12-b integration were merged together in #395. This
document keeps the evaluation that preceded the choice; the
[final revalidation](FINAL_RESULTS.md) checks the analyzer that reached the release.
The full table is in
`results/TABLES.md` and the per-case records are in `results/method-case.csv`.

## Recommendation

**Beat This! main (`final0`) with its 3/4-beat DBN decoder,
run with ONNX Runtime and a NumPy frontend, without PyTorch or madmom in the
engine.** It is the method with the best measured downbeat on unseen music,
with MIT license for code and weights, and it is the only strong candidate that can
run on all engine platforms (Docker `linux/amd64` and
`linux/arm64`, Windows desktop x64 and arm64).

| Measure (music not seen by Beat This!) | `final0` DBN | `small0` DBN | Production before #394 | #394 (on `main`) |
| --- | ---: | ---: | ---: | ---: |
| Downbeat F1, fixed test (20 GTZAN) | 0.764 | 0.734 | 0.315 | 0.000 |
| Downbeat F1, all 30 GTZAN (test + development) | 0.809 | 0.709 | 0.246 | 0.000 |
| Beat F1, test | 0.820 | 0.793 | 0.658 | 0.476 |
| Tempo within ±4 % of the reference, 30 GTZAN | 24 | 19 | 21 | 10 |
| CPU s per minute of audio, 132 s song, ONNX Runtime 1 thread | 3.6 | 2.2 | 0.09 | 0.13 |
| Process peak memory, ONNX Runtime, same song | 507 MiB | 383 MiB | — | — |
| ONNX weights | 84 MB | 11 MB | — | — |

Paired downbeat F1 differences (bootstrap 95 %). On the fixed test of
20 recordings, `final0` DBN versus `small0` DBN: +0.031 [−0.064, +0.119],
no demonstrable difference. With all 30 GTZAN: +0.100 [+0.004, +0.199]. Combining
development and test happens after the fixed protocol; it is accepted as additional
evidence because the development split was not used to tune anything
(`calibration-results.json` is descriptive, with no tuned thresholds). With all 30:
`final0` DBN also beats its direct output (+0.067 [+0.017, +0.122]),
Beat Transformer (+0.105 [+0.021, +0.210]) and madmom (+0.168 [+0.015,
+0.330]). Against the detector before #394, also with all 30, `small0` DBN wins by
+0.463 [+0.295, +0.620].

`small0` is the alternative if cost is the priority: 40 % less
CPU, 120 MiB less memory and 11 MB weights, in exchange for about 0.10 of downbeat F1 and five
fewer correct tempos out of 30 songs.

### Why not the others

| Method | Reason for not integrating it |
| --- | --- |
| Beat Transformer | Downbeat lower than `final0` DBN: −0.045 [−0.138, +0.014] on the fixed test and −0.105 [−0.210, −0.021] on all 30 GTZAN. Requires Spleeter 2.3.2 on Python 3.8 + TensorFlow: a second unmaintained runtime. |
| All-In-One | Downbeat lower: −0.098 [−0.185, −0.024] on the fixed test (`fold0`). 15–124 s of CPU per minute depending on the variant, plus ~48 s/min of HTDemucs. On the structure signals it labels everything as `intro` and recovers 25–37.5 % of the boundaries. |
| madmom (upstream and fork) | Downbeat lower: −0.106 [−0.282, +0.058] on the fixed test and −0.168 [−0.330, −0.015] on all 30 GTZAN. Weights CC BY-NC-SA (non-commercial use). PyPI only has the 2018 source code (0.16.1, 19 MiB with models); the fork is not published. |
| BeatNet model 1 | Downbeat lower: −0.237 [−0.413, −0.090] on the fixed test. Imports PyAudio also for files. |
| BeatNet model 2 | Trained on GTZAN: its 0.937 there is not an independent test. On Ballroom, which it did not see, its downbeat F1 is 0.637 (BeatNet 1 and Beat This!, which did see it: 0.974 and 0.988). There is no corpus unseen by all of them to compare it. |
| BeatNet+ | No distribution license in the published revision. |
| Essentia, librosa | Beat only; they do not estimate the downbeat. Essentia is AGPL. |
| Own prototypes (`joint`, `joint-dbn`) | Downbeat with F1 0.000 and 0.273 on test. |
| #394 detector | See *Regression measured on `main`*. |

## Running without PyTorch

[`onnx_probe.py`](onnx_probe.py) exports each checkpoint to ONNX (opset 17,
PyTorch 2.5.1) and reimplements in NumPy the Beat This! log-mel spectrogram,
the chunking into blocks of 1500 frames and the "minimal" postprocessing. The
run uses a Python 3.13 environment with only NumPy and ONNX Runtime 1.31.
It compares against the activations and events kept from the main run,
without running PyTorch again.

- NumPy frontend versus `LogMelSpect`: maximum difference 0.00018 (float32
  rounding). The detail that matters is `normalized="frame_length"`: torchaudio
  divides by √n_fft, not by the window norm.
- Identical events on all 62 inputs, for `small0` and `final0`. Maximum
  logit difference: 0.0002 and 0.0005.
- The direct export materializes all 1500 × 1500 attention matrices
  at once: peak of ~1.1–1.6 GB. Exporting the same operation per
  frequency band (time attention in the frontend) and per head
  (main transformer) lowers the peak to 383 MiB (`small0`) and 507 MiB
  (`final0`), equivalent to PyTorch with the same file and method (440 and
  501 MiB). The split export also gives identical events on all 62
  inputs. Disabling the ONNX Runtime arena raises the peak (541 and 734 MiB).
- CPU on the 132 s song: 2.2 s/min (`small0`) and 3.6 s/min (`final0`);
  PyTorch, 2.1 and 3.7 s/min. Figures in `results/onnx-memory.jsonl`, a
  new process per configuration. The 30.01 s GTZAN clips take 1501 frames
  and force computing two full blocks: this is why the tables of the main
  run show almost double per minute.
- PyPI wheels checked on 2026-10-26: ONNX Runtime 1.31.0 publishes for
  Python 3.11–3.14 on Linux x86_64/aarch64, macOS arm64 and Windows x64/arm64
  (14–23 MB). PyTorch 2.14.1 does not publish Windows arm64 and its Linux x86_64 wheel
  weighs 529 MB.

It has not yet been run on Windows or ARM64: wheel availability
does not replace that test, which belongs to P12-b.

Estimated cost on a library: a 4-minute song is ~14 s of CPU
with `final0` (~9 s with `small0`), versus 0.4 s for the current analysis. A thousand
songs are ~4 h of single-thread CPU on a Ryzen 7 5800X (~2.5 h with
`small0`), split between the two background analysis threads. On
low-end ARM64 it will be several times slower; it is not measured.

## Integration into the engine (P12-b)

Measured after the decision with the full production analyzer
(`integrated_probe.py`, `results/integrated-p12b.json`): FFmpeg at 22050 Hz
from the files, Beat This! on ONNX Runtime, DBN in NumPy and the P1 grid.

- The engine's NumPy DBN reproduces madmom's events on all 62 inputs,
  with both checkpoints (`results/dbn-port.json`), at 0.24 s of CPU per minute
  of audio.
- Model events on GTZAN test: beat F1 0.820 and downbeat F1 0.768, like
  `beatthis-final0-dbn` in the comparison (0.820 and 0.764), with a different
  decoding and the time read between frames.
- Final grid: beat F1 0.813 (test) and 0.915 (development); downbeat, 0.770 and
  0.892. Tempo within ±4 % on 24 of the 30 GTZAN. A first version aligned to
  onsets within ±35 ms, like P1, and on `gtzan_rock_00001` it jumped to an onset 32 ms
  before the beat (F1 from 1.0 to 0.78). It is limited to one model frame, 20 ms.
  On synthetic signals the 90th percentile of the beat error is 1.5 ms.
- Server during analysis (`scripts/benchmark_dj_analysis.py --http`,
  `results/http-latency-p12b.json`): with two full 120 s analyses at the
  same time, 3129 requests answered with a median of 0.39 ms, p95 of 0.99 ms and
  maximum of 10.6 ms. Inference runs outside the gevent loop.
- Independent downbeat confirmation: 0 % coverage on GTZAN and Ballroom, and
  54 % on synthetic signals with precision 1.0 (579 confirmed downbeats, none
  false). In beatmatches of real music the maximum guarantee is `beats`;
  pairs that are not accepted use `none`. `bars` requires that harmony and
  accents measurably repeat the model's bar.

## What this comparison does not resolve

- **Downbeat confidence.** The network activation does not distinguish hits from
  errors: with `final0` DBN, 93 % of the downbeats emitted on test have
  activation > 0.8 and their precision is 0.82. The errors are whole bars
  shifted with the same high activation. P12-b requires the independent
  confirmation described above to certify `alignment: bars`; a
  sigmoid is not interpreted as a probability.
- **Controls without a downbeat.** All neural models invent downbeats
  on the uniform pulse (`final0` DBN: 47 without reference). The guard cannot
  certify with the model output alone.
- **DBN.** It is madmom code. Integrating it as a dependency is not viable (see
  table); P12-b ports it to NumPy with verified equality (above).
- **Reading level.** The Beat This! DBN groups into 3 or 4 beats and chooses
  a beat level; a 6/8 or a 12/8 is read at one level or the other. The
  2/3/4/6 variant (`-common`) does not improve real music: 0.040 below the
  3/4 DBN on all 30 GTZAN (CI [−0.097, +0.010]). By decision of the user, the
  mix does not depend on the reading: P12-b aligns the common cycle of both beats
  (ratios 2ᵃ·3ᵇ). Beat This! does not estimate subdivision: those contract
  fields are measured by the analyzer on its own or stay unknown.
- **Sample.** 30 GTZAN recordings of 30 s, almost all in 4; only one
  ternary. Ballroom is in the Beat This! training data. The results
  do not demonstrate general detection of any meter.
- **P13.** No candidate provides useful structure (All-In-One, above).
  Phrases and sections will be built on top of the chosen metrics.

## Historical regression of #394 (replaced by #395)

#394 was merged as `3f98b485` with the detector measured here as `soundsible-p12`:
`shared/` does not change between `2ca8ccf2` and `3f98b485`. It was measured before publishing
the next release; #395 replaced that detector before its publication.

- On all 30 GTZAN, correct tempo drops from 21 to 10 songs. The new
  errors are 3:2 and 4:3 ratios in pop, hip-hop, metal, rock, disco and reggae
  in 4/4 that the previous detector got right (for example +49.5 %, −24.8 %,
  +27.2 %). They are the ternary ratios that P12 added to beat selection.
- The downbeat is not identified on any real recording (F1 0.000; correct grouping
  coverage 1.5 %). The beatmatch techniques require `alignment:
  bars`, so with real music almost all transitions are fallback ones.
- User's local cache on 2026-10-26: of 278 songs analyzed by the
  two versions (v8 and v9), 162 change BPM (66 ×1.5, 54 ×2, 14 ×4/3, 27
  others) and 116 keep it. On the 272 v9 songs, the identified downbeat covers
  on average 2.2 % of the analyzed duration; none reaches 50 %.

Its meter detection on synthetic signals is the best in the comparison
(downbeat F1: 0.990), but it does not carry over to real music.

## What this comparison answers

It compares beat and downbeat detection, the observed grouping,
the subdivision when it exists, timing precision and execution cost.
F1 combines precision and recall of events: it is not a percentage of songs
or of bars interpreted correctly. Grouping, its coverage and the
subdivision are scored separately. An absent field keeps that condition.

The two own references are the engine before #394 (`8f520a79`,
`soundsible-main`) and #394 (`2ca8ccf2`, `soundsible-p12`). #394 was later merged
into `main` as `3f98b485`, with no changes in `shared/` relative to the
measured revision. The user's choice preceded P12-b; both pieces of work
were delivered in #395. The original outputs are kept as reference.

## Protocol and scope

The same 62 inputs were fixed before inference: 30 GTZAN, twelve Ballroom
already diagnosed, 17 rhythmic signals and three structure signals. GTZAN reserves
index zero of each genre for development and indices one and two for
test: ten and twenty recordings, respectively. No models were trained,
no thresholds were tuned and no songs were chosen after seeing results.
Tolerances are 70 ms on music and 10 ms on known signals. The SHA256
of the audio and the references are in the manifests.

The signals cover groupings of three and four beats, two beats with
ternary subdivision, anacruses, weak downbeats, syncopation, drift, changes,
silence, tone and uniform pulse without an identifiable downbeat. The notated
unit and the subdivision of real music are not annotated: a 6/8
ground truth is not invented from two detected beats. The real test contains
mostly groupings of four and only one ternary recording.
Therefore, its mean does not demonstrate general detection of any meter.

Ballroom remains as a seen diagnostic. The training exclusions
are statements by the authors per corpus, with exceptions per checkpoint;
the training audio is not available to rule out duplicates of the
same recording across corpora. BeatNet model 2 includes GTZAN in training:
its result there must be read as a diagnostic and not compete as an independent
test. The per-family detail is in `results/training-overlap.json`.

Each backend runs separately, with one thread and two passes per input.
The machine is a Ryzen 7 5800X with 32 GB, Linux x86_64, shared with other
activities of the user. CPU time and wall time are recorded; processor frequency
is not controlled and wall time is not presented as a stable
microbenchmark. Memory sampling uses another process without the evaluator, the same
real 30-second clip and two passes; that peak does not guarantee the maximum
for any long song.

## Costs that must not be confused

Audio derivatives are shared and cached by bytes and transformation.
`frontend-costs.json` measures decoding and resampling separately with
new caches. The backend table uses those already prepared derivatives. Their sum
with the frontend is a per-component estimate, not a new complete
pipeline that was timed.

All-In-One and Beat Transformer need separation. The preparation cost
is kept even when another pass or variant reuses the spectrogram. Inference
with the cached frontend is also reported. Variants
that reuse separation, such as the ensemble, add the previously measured preparation
cost and that of their inference; another full pass
with cold separation has not been timed for each variant. The
`-common` variants reuse activations: their timer measures the decoder; the
cost of the source is kept and their sum is presented, without attributing to the full method
the small latency of postprocessing.

Model loading is in the metadata; downloads were left outside the
timer. The locks record the environments that were run. The installed size
uses the files declared by the dependencies, without interpreter or caches:
it is not a measurement of a minimal installer. Some packages include weights,
also unused models; those columns must not be added up as if they were
disjoint files. Installation time was not measured in a controlled way;
it included downloads and exploratory compilation.

During the run, environments and data were moved to `/mnt/storage` to avoid
filling the root. The pause lasted 4.116 s; the wall time of the affected input
is excluded, keeping its CPU. The I/O location changed and is declared as
another limitation of the wall time. Later temporary files also go to that disk.

## Software, weights and maintenance

| Family | Evidence and work needed to integrate |
| --- | --- |
| Beat This! | [MIT code and weights](https://github.com/CPJKU/beat_this/tree/b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c). Small/main and direct output/DBN are compared. PyTorch and torchaudio are a large part of the runtime. |
| BeatNet | [CC BY 4.0 repository](https://github.com/mjhydri/BeatNet/tree/81cedd4beeb7235262db80969a0c9ce9a48a0ed4), checkpoints and explicit DBN/PF modes. The package imports PyAudio even for offline files. Do not confuse the models that exclude GTZAN and Ballroom. |
| BeatNet+ | [Published sources and weights](https://github.com/mjhydri/BeatNet-Plus/tree/bb90eb0a9065b101a4b4c4cb2b2061950266cb4b); no distribution license was found in that revision. It is measured and this limitation is declared. |
| madmom/upstream and modern fork | BSD code; [CC BY-NC-SA weights](https://github.com/CPJKU/madmom_models/blob/7e3dc1b0cad499792767074d03c38b194b9b0a79/LICENSE). The matrices of the twenty compared files are identical; the fork is a maintenance variant, not another trained family. Using only the DBN does not require the networks; an integration will have to review which files it distributes. |
| All-In-One | [MIT code](https://github.com/mir-aidj/all-in-one/tree/18e78903c0365147a2c5d4e5e57ebf88cb7d800e) and [MIT weights card](https://huggingface.co/taejunkim/allinone/tree/379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19). Needs NATTEN, madmom and HTDemucs. The age of the code and the cost of its eight networks matter for maintaining it. |
| Beat Transformer | [Code and checkpoints](https://github.com/zhaojw1998/Beat-Transformer/tree/063667fc9e4e11507f9d76dc1154d9db953a85eb), MIT license of the project. The frontend from its Colab with Spleeter 2.3.2 is used; it requires a separate Python 3.8/TensorFlow environment in this experiment. |
| Essentia and librosa | Beat controls: [Essentia AGPL](https://github.com/MTG/essentia) and [librosa ISC](https://github.com/librosa/librosa). Their tested algorithms do not provide downbeat or subdivision; that capability is not attributed to them. |
| Own prototypes | BIC comparison of hypotheses and joint DBN with onset/harmonic change observations. They are bounded experiments, with their errors visible; they are not presented as solved musical detectors. |

Installation and local inference on Linux do not demonstrate distribution on
ARM64, Windows or macOS. The Python 3.14 checks are distinguished from the
Python 3.11 performance environment and from the Python 3.8 worker. Compatibility
with the product's delivery platforms is still P12-b work.

[md_beat_this](https://github.com/fosfrancesco/md_beat_this/tree/aca41a23a26881ba3d1e5b5e4bc3f4869d6a3ed7) was also inspected:
the revision contains evaluation and predictions, but not inference and weights
that can run on our frozen inputs. It is excluded because of that lack of
reproduction, keeping the reason in the inventory.

## Mix contract and P13 limits

The backends run on WAV and AAC. A single adapter carries their
observations to an isolated SQLite and to the HTTP planner of the #394 reference.
Confidences that the backend does not provide stay absent in the raw data and pass
as zero evidence to their guards. A high sigmoid does not by itself certify
the meter or the downbeat. Therefore, a conservative plan does not prove that the model
cannot become useful; nor does always abstaining demonstrate detection.

The uniform pulse in the corpus has no identifiable downbeat. The
detectors that invent one are penalized even if they get its tempo right.
The P12 reference produces sixty downbeats and local grouping/downbeat confidence
equal to one when it receives the version resampled from 44100 Hz; its original test
synthesizes directly at 11025 Hz. That difference is diagnosed separately,
without modifying the corpus or retuning the detector. Coverage and unit
guards are still necessary; local confidence is not calibrated musical
truth either.

Sources, track/artist requests, placement, repair,
legacy and refinement are tested; cold/warm state, absence of decoding when warm
and compact responses. Injection into SQLite validates that boundary and its
consumers; it does not replace production acquisition and does not yet prove
how many musical mixes the chosen one can safely enable.

The three structure signals have known content changes every
four, eight and sixteen bars. All-In-One boundaries are compared,
without using its labels as musical truth. There is no annotated evaluation of
real phrases, drops or sections. P13 was implemented later on top of the
chosen metrics, with its own signals and limits ([P13](../P13.md)).
Running the web/Android contracts and physical listening are evidence
separate from the detector metrics.
