# P12-a: compare joint detection and open alternatives

**Original plan of 2026-10-25, executed in #395.** The P12-a measurements
ended on 2026-10-26; the user chose Beat This! `final0` and P12-b
integrated it in the same PR. P12 is closed with the limits recorded in
[P12](P12.md); P13 was closed afterwards ([P13](P13.md)). The original results are in
[detector_comparison/RESULTS](detector_comparison/RESULTS.md), and the
revalidation of the final analyzer in
[detector_comparison/FINAL_RESULTS](detector_comparison/FINAL_RESULTS.md).

The rest keeps the agreed protocol: comparison on the same
inputs and an explicit decision before integrating. The partial condition of
#394 and the decision stops it describes are historical, not pending
work or a new detector choice. Abstention protects the mix,
but on its own it does not demonstrate correct musical detection.

## Order to develop quickly without redoing code

| Block | Concrete deliverable | Dependency / limit |
| --- | --- | --- |
| P12-a, common bench and comparison | One runner, isolated adapters, frozen corpus, results per method/case and a test of its output through the planner and the existing boundaries | Authorized now; get almost end to end without selecting or replacing the production detector |
| User decision | Table of accuracy/coverage, errors, costs and maintainability; options and trade-offs without a winner chosen by preference weights | Explicit stop before choosing and integrating; have results, not only plans or figures from the papers |
| P12-b, integration of the chosen one | One musical implementation, persistence, HTTP, routes and web/Android execution; closing of P12 with real evidence | After the decision; reuse the #394 contract and remove production prototypes that are not used |
| P13, phrases and sections | Consume the chosen meter and validate musical form | Design fixtures and record limits during P12-a; implement after that meter is stable. It can be delivered together with P12-b if it reduces repeated changes and both acceptances are verified separately |

The one-point-per-session rule does not force micro-deliveries in this assignment:
the user authorizes progress in wide, almost end-to-end blocks.
Do not make a production PR for each detector. Build the bench and
the adapters together, run the full comparison and present results.
Then integrate the chosen option in one wide block; avoid rewriting
`rhythm`, `structure` and the consumers once per candidate.

## Initial candidates and controls

Inventory consulted on 2026-10-25 in repositories and documentation from their
authors. The published dates and licenses are inventory evidence, not a
certification of maintainability or a Soundsible measurement. Pin the actual
revision and the hash of **each checkpoint** when running. Do not confuse variants,
postprocessors and forks with independent model families.

| Method / family | What to compare | Admission and known limits |
| --- | --- | --- |
| Soundsible before #394 (`8f520a79`) and the #394 detector (`2ca8ccf2`) | Two baselines: four-beat assumption versus local grouping/abstention | Freeze the revisions; keep the original results without recalibrating them on the test |
| Own joint prototype | Several hypotheses of pulse, subdivision, meter and phase over several bars; joint temporal decoding with rhythmic and harmonic observations | Develop as an experimental adapter; do not first fix a single BPM or require the 1 to be the strongest beat. No new preference weights |
| [Beat This!](https://github.com/CPJKU/beat_this) | Main and small model; direct output and, as a separate variant, common temporal decoding over activations | Beats and downbeats; CPU and checkpoints available. Code and weights published under MIT. Upstream warns about training overlap: its main/small models exclude GTZAN, which does not mean they exclude any other corpus |
| [BeatNet](https://github.com/mjhydri/BeatNet) | CRNN with offline DBN inference and a PF variant processing the file without waiting for real time | Beats/downbeats and metrical tracking; CPU and published weights. Check the madmom and PyAudio dependencies even in offline mode. The repository declares CC BY; verify the terms of the specific checkpoint |
| [madmom](https://github.com/CPJKU/madmom) and [madmom-modern](https://github.com/imcmurray/madmom-modern) | Beat/downbeat RNN and DBN; the original as a reference and the compatible fork as a maintenance variant | The fork declares compatibility with current Python/NumPy. BSD code and models published under CC BY-NC-SA: record them separately; do not assume they can be distributed as unrestricted weights. Verify installation, tests and the fork's divergences |
| [Beat Transformer](https://github.com/zhaojw1998/Beat-Transformer) | Beat/downbeat Transformer with source-separated input and its postprocessing | MIT code and checkpoints in the project. Also measure preparation/separation and dependencies; assess maintenance of the research code and the weight terms, without turning an extensive adaptation into a requirement of the comparison |
| [All-In-One](https://github.com/mir-aidj/all-in-one) | Beats/downbeats and segmentation in the same family; a variant without doing structure work we do not need, if upstream supports it | Also relevant to avoid duplicating P13. Documents PyTorch, NATTEN, madmom and source separation; native installation on Windows and full cost still to be checked. MIT code; verify weights and dependencies separately |
| [Essentia RhythmExtractor2013](https://essentia.upf.edu/reference/std_RhythmExtractor2013.html) | `multifeature` and `degara` as two beat/cost baselines | The algorithm returns tempo and beats, not downbeats; no intrinsic downbeat score. Input at the sample rate required by its API; `degara` does not estimate confidence. [AGPL repository](https://github.com/MTG/essentia) |
| [librosa](https://github.com/librosa/librosa) | `beat_track` and local pulse as tracking/drift controls | Beat baseline, not a complete meter/downbeat detector. ISC code; use the [official API](https://github.com/librosa/librosa/blob/main/librosa/beat.py). A hybrid with our decoder will be a separate explicit method, never a capability attributed to librosa |

The joint model with a network and temporal decoding has reproducible
precedents in [Böck, Krebs and Widmer, ISMIR 2016](https://archives.ismir.net/ismir2016/paper/000186.pdf).
Reimplementing all of those networks is not required: first compare the
public packages/weights and the bounded joint prototype. If another
maintainable candidate with reproducible code, weights and execution appears, add it to the
inventory before freezing the run. The list does not attempt to enumerate all
existing papers.

### Revisions consulted

| Repository | Revision consulted | Date of the consulted commit |
| --- | --- | --- |
| CPJKU/beat_this | [`b95c8ab0c58c`](https://github.com/CPJKU/beat_this/commit/b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c) | 2026-05-28 |
| mjhydri/BeatNet | [`81cedd4beeb7`](https://github.com/mjhydri/BeatNet/commit/81cedd4beeb7235262db80969a0c9ce9a48a0ed4) | 2026-04-13 |
| zhaojw1998/Beat-Transformer | [`063667fc9e4e`](https://github.com/zhaojw1998/Beat-Transformer/commit/063667fc9e4e11507f9d76dc1154d9db953a85eb) | 2024-04-07 |
| mir-aidj/all-in-one | [`18e78903c036`](https://github.com/mir-aidj/all-in-one/commit/18e78903c0365147a2c5d4e5e57ebf88cb7d800e) | 2023-10-10 |
| CPJKU/madmom | [`27f032e89472`](https://github.com/CPJKU/madmom/commit/27f032e8947204902c675e5e341a3faf5dc86dae) | 2024-08-25 |
| imcmurray/madmom-modern | [`df718c704a3b`](https://github.com/imcmurray/madmom-modern/commit/df718c704a3b460ac6c61b7e61663a0436b91bda) | 2026-02-16 |
| MTG/essentia | [`33108c709296`](https://github.com/MTG/essentia/commit/33108c70929684ed14091dfb671a30264cf8bb84) | 2026-10-22 |
| librosa/librosa | [`4ffed287f904`](https://github.com/librosa/librosa/commit/4ffed287f9044654cc4a1a7393f895cd716a0a5d) | 2026-10-22 |

The age of a commit does not decide admission on its own. Check
useful activity, CI/tests, reproducible installation, platforms and dependence
on own patches. All candidates in this table were installed and
measured; the exclusions and their reasons are in the results report.

## A single bench and a single boundary

- One owner for the runner, manifest, units and adapter towards the P12
  contract. Each family lives in its own adapter module. If the
  work is split, assign different files; the adapters do not edit the planner,
  `rhythm`, `structure`, the stores or the native mixer.
- Separate backend execution, normalization and metrics. A result includes
  method/revision/checkpoint/configuration, beat/downbeat times in seconds,
  grouping/subdivision/unit if they exist, coverage, the original activations or confidence
  if available, and explicit absences. Keep the raw output to
  recalculate metrics without repeating inferences.
- A single input decoder and derived data cached by bytes,
  transformation, sample rate and configuration. Each method receives the format
  it needs; do not feed all of them with the P1 sample-rate reduction.
  Count the cost of resampling/spectrograms/separation even if they are cached.
- Experimental models and dependencies in isolated environments or containers,
  outside `requirements.txt` and the engine's distribution packages.
  Pinned dependencies and weights; downloads prepared before measuring. An
  installation failure, missing weights or a license restriction is recorded as an
  admission result; it is not hidden and does not force maintaining a large fork.
- Freeze the minimum experiment contract first; extend it only if
  a necessary measurement is missing. Reuse `metric_regions` and the compact plan from
  #394. Do not invalidate the production cache to run the isolated bench.
- In the comparison, do not train from scratch or separate sources for all methods by
  default. Run the documented pipeline when a candidate needs it,
  identifying it and counting its cost. An optimized variant will be a
  separate row, with equality of results checked.

## Corpus, fair comparison and metrics

Pin manifest, references, splits, tolerances and configuration before
running. The twelve Ballroom tracks of P12 are **already-seen diagnostics**,
not a blind test. For each checkpoint, declare whether each recording was seen in
training, excluded or of unknown provenance. Do not present as
independent validation a result with known or unclarified overlap.
GTZAN can serve as a test for the Beat This! checkpoints that exclude it;
check this for each other candidate, without extrapolating that exclusion to all of them.

Use the same synthetic and real recordings for all methods, with
the windows and offsets recorded. Add to the existing cases 3/4, 4/4,
6/8, coexisting subdivisions, meter/tempo changes, anacruses, weak 1,
syncopation, offbeats, silence and beats without an identifiable meter. For
real music, cover varied styles and conditions with auditable time
references. The references are musical annotations, not preference notes.
Keep ambiguous regions as such and do not choose songs after seeing
which method wins.

Measure separately, with results per case, style, unit and coverage:

- Tempo error without hiding octaves or 3:2 relations; also document the
  unit equivalences that actually preserve the bar duration.
- Precision/recall/F1 and continuity of beat and downbeat, median/percentile
  timing error and phase offset of the bar.
- Accuracy of grouping, subdivision, physical bar duration and changes;
  fields that are not provided are "not available", never a 4/4 inferred
  silently. A hybrid is evaluated with its full name and components.
- Coverage, abstentions and **false certainties**: error when the method claims
  to know the 1. Abstaining on every song does not count as a solution.
  A network's activations are also not a calibrated musical confidence
  merely because they pass through a sigmoid; check their relation to the
  error on the development split and evaluate the result on the test split.
- Raw output and output with the same P1 onset timing refinement,
  separately. Distinguish getting the beat/meter wrong from placing a correct
  onset late. Do not give each backend a different fix tuned to the test.
- Installation and load time, cold/warm latency, CPU and
  wall-clock seconds per minute of audio, peak RAM, disk/weights and runtime size.
  CPU is the mandatory reference; GPU is optional as another configuration.
  Measure one method at a time, same hardware and threads, with repetitions and
  variability. Separate backend cost and total pipeline cost.
- Maintainability: code and weights with identified terms, reproducible
  availability, tests, compatibility with the project's Python/NumPy and
  Linux/ARM64/Windows/macOS distribution; need for and size of patches.

Publish a **method × case** matrix, summaries with uncertainty and a complete
comparison table. Include all admitted methods, their variants,
failures, absences and reasons for exclusion. Do not choose a winner with a sum of
weights written by preference; present the trade-offs of accuracy, coverage,
cost and maintenance for the user's decision.

## Get almost end to end before deciding

The bench does not end in a list of BPM values. Convert each output that has
sufficient evidence to the P12 contract through **the same adapter**, without
inventing fields. Reuse the planner to check compatible pairs,
3/4 → 4/4, different units that keep the meter, changes within the segment,
drift and unknowns. Measure how many valid mixes each method enables and how many false
alignments it promises. Keep the P12 guards for speed, phase,
coverage and echo.

Also run the path AAC/WAV → decoding → backend → normalization →
experimental SQLite → planning/routes → HTTP for sources, requests,
placement, repair and refinement. Cover cold/warm, failure/timeout,
cache identity/configuration and gaps in long recordings. The compact
outputs and the existing execution vectors make it possible to compare web and
Android without creating a new interface per candidate or moving musical logic
to the client. Mark clearly which part has been executed and which part has only
been validated as a contract; physical listening remains separate evidence.

P13 is prepared by reusing that work: phrase/section fixtures and
recording of the All-In-One structural output if it is evaluated. That output is
scored against dedicated structure references; sharing a model with the beat
does not on its own prove a phrase or a drop. Do not rewrite the section
detector now on top of a meter that could be replaced after the comparison.

## Closing of P12-a and delivery for the decision

- Reproducible runner, pinned manifests and revisions/checkpoints; report
  per case and table of all admitted and excluded methods with their reason.
- Separation between diagnostics, development and independent test; training
  overlaps and missing references documented.
- Musical and execution results almost end to end, together with
  cost and maintenance. Criteria/tolerances fixed before the test; green
  software tests do not replace the detection evidence.
- Present to the user options supported by those results and **wait for
  their decision**. Do not automatically change the production detector, its
  cache or the musical policies, and do not start the P13 rewrite.

After the choice, P12-b integrates a single musical path and shares its evidence
with P13. Group persistence, endpoints and executors in a coherent delivery,
with analysis invalidation if its meaning changes and the corresponding
regressions. P12 is only closed when there is real evidence of the usefulness of the
detection and execution guarantees; P13 keeps its own acceptance of
phrases/sections even if both are delivered together.
