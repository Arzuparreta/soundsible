# Experimental meter and downbeat bench

P12-a comparison, outside the dependencies and the production cache.
The engine does not import this package and no method is chosen automatically.
The choice and the P12-b integration were completed in #395; the outputs of the
other candidates keep their experimental status.

The interpretive report is in [RESULTS](RESULTS.md); the tables and the
compact records are generated with `export` once the run is complete.

The bench separates four things: backend observations, normalization without
inventing evidence, metrics against references and testing of the P12 contract.
The reference revisions are `main` at
`8f520a797c3470c1e2a53d86673ef6694dd3105c` and the experimental infrastructure
of #394 at `2ca8ccf248d4fe38caa664ec7442332a59160353`. The second was later merged
as `3f98b485` without changes in `shared/`; here it is still a
measured candidate, not the reference for what must be integrated.

## Inputs and references

62 inputs are fixed before running the candidates: 30 GTZAN excerpts
(indexes 0, 1 and 2 of ten genres), the twelve Ballroom excerpts from the previous diagnosis,
17 rhythm signals and three structure signals. GTZAN separates ten
development cases and twenty test cases; no models are tuned with those partitions.
Ballroom remains as an already-seen diagnosis and the training overlap
is declared per method. The structure signals only prepare P13.

`prepare.py` downloads sources, Beat This! weights and GTZAN at pinned
revisions. The Ballroom audio comes from the archive of the original contest and is not
redistributed. `corpus.py` requires its local manifest with `file`, `genre` and
`annotation`; its synthetic generator is pinned to #394. The manifest records
the SHA256 of audio and annotations. The reference process used NumPy 1.26.4
to synthesize; another environment must not overwrite a frozen manifest.
The hash of the original manifest also identifies its absolute paths. In
another location, the identifiers and audio/annotation hashes are compared;
the exported reference files normalize the paths to local names.

The tolerances are 70 ms for real musical references and 10 ms for
known synthetic onsets. Matching maximizes one-to-one hits
and then minimizes the time error. The tolerance includes its mathematical
boundary, with 1 ns for binary representation. The annotated window keeps
that margin at its ends. Without a subdivision annotation, that
subdivision is not scored. Absence of annotation and explicit absence of meter are different.

## Execution

The environments are disposable and separate from the engine's `.venv`. The large
packages and weights are prepared before measuring. Spleeter's working
directory must be the experiment's so that it finds its prepared weights.

```sh
DJ_LAB=/path/to/experiment
uv venv --python 3.11 "$DJ_LAB/venv"
uv pip install --python "$DJ_LAB/venv/bin/python" \
  -r docs/internal/dj/detector_comparison/locks/python311.txt \
  --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match
"$DJ_LAB/venv/bin/python" -m docs.internal.dj.detector_comparison.prepare "$DJ_LAB"
uv pip install --python "$DJ_LAB/venv/bin/python" --no-deps \
  "$DJ_LAB/sources/CPJKU_beat_this" "$DJ_LAB/sources/mjhydri_BeatNet" "$DJ_LAB/sources/mir-aidj_all-in-one"
NATTEN_N_WORKERS=1 MAX_JOBS=1 uv pip install --python "$DJ_LAB/venv/bin/python" \
  --no-deps --no-build-isolation "$DJ_LAB/sources/CPJKU_madmom" natten==0.15.1
"$DJ_LAB/venv/bin/python" -m docs.internal.dj.detector_comparison.corpus "$DJ_LAB" --ballroom-manifest /path/to/manifest.json
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMBA_NUM_THREADS=1 \
  "$DJ_LAB/venv/bin/python" -m docs.internal.dj.detector_comparison.run "$DJ_LAB" beatthis-small0-direct
```

The four locks record the environments that were run; they do not modify
the engine's `requirements.txt`. Compiling madmom/NATTEN needs a
compiler and the offline import of BeatNet requires PyAudio/PortAudio.
The preparation of the HTDemucs, All-In-One and Spleeter weights and their hashes is recorded
in the report's asset manifest. Do not start a timer while
weights are being downloaded. The madmom-modern fork and the Python 3.14 checks
use their respective environments. Spleeter uses Python 3.8, its lock and the
`pretrained_models/5stems` directory prepared before measuring.

After creating the two required environments, `prepare ROOT
--separated-weights` downloads the eight Harmonix checkpoints at the pinned
revision and uses the original HTDemucs and Spleeter providers to prepare
their weights. Run this before the timer; check their files against the
hashes in the report. Beat Transformer and BeatNet+ include their weights in the
frozen sources.

Run **one method at a time**, with CPU and one thread. `run` makes two passes per
input, saves predictions and compressed activations and records errors,
load, CPU/wall times, model loading and peak RSS. A failure is not
turned into a musical abstention. Three consecutive failures interrupt that
configuration and stay visible. Existing results are not overwritten
unless `--overwrite` is given; a fix to the evaluator is applied to the retained output.
The runner refuses to reuse a results folder with a different manifest.
A change of weights, configuration or environment requires another experiment folder;
`--overwrite` is for repeating the same manifest, not for mixing cohorts.
The temporary files of Python and its children go to `ROOT/temporary`; the large data and
environments can live on another disk, keeping symbolic links.
At least 1 GiB of free space is checked before starting a new input.

`decode` consumes the original activations with a single DBN of groupings
2/3/4/6. It changes the post-processing, it does not repeat or alter the network. Its times measure
only the decoder; it keeps those of the original pipeline separately. That
small time must not be presented as the total latency of a new detector.

```sh
"$DJ_LAB/venv/bin/python" -m docs.internal.dj.detector_comparison.decode "$DJ_LAB" beatthis-small0-direct
"$DJ_LAB/venv/bin/python" -m docs.internal.dj.detector_comparison.report "$DJ_LAB" "$DJ_LAB/comparison-results.json"
"$DJ_LAB/venv/bin/python" -m pytest -q tests/test_dj_detector_comparison.py
```

`report` recalculates metrics from the saved events and applies the same
onset adjustment from P1 to all of them. It does not change octave or pulse to correct a
backend. Both outputs are published; the time percentile of the
correct events does not hide the omissions, which remain in recall/F1 and continuity.
The bootstrap intervals describe this small sample; they do not remove its bias
or prove generalization to all music.

## Beat This! without PyTorch

`onnx_probe.py` checks the runtime proposed for integration. `export` runs
in the lab environment with PyTorch and `beat_this`; `--sliced-attention`
exports the same attention per band and per head so that all
the matrices are not materialized at once. `run` uses a clean environment with only NumPy and ONNX
Runtime and compares against the retained `.npz`/`.json` of `beatthis-*-direct`.

```sh
uv venv --python 3.13 "$DJ_LAB/onnx-runtime-venv"
uv pip install --python "$DJ_LAB/onnx-runtime-venv/bin/python" numpy onnxruntime==1.31.0
"$DJ_LAB/venv/bin/python" docs/internal/dj/detector_comparison/onnx_probe.py export --sliced-attention \
  --checkpoint small0 "$DJ_LAB/checkpoints/small0.ckpt" \
  --checkpoint final0 ~/.cache/torch/hub/checkpoints/beat_this-final0.ckpt \
  --out "$DJ_LAB/onnx-sliced" --derivatives "$DJ_LAB/derivatives"
"$DJ_LAB/onnx-runtime-venv/bin/python" -I docs/internal/dj/detector_comparison/onnx_probe.py run \
  --onnx "$DJ_LAB/onnx-sliced" --manifest "$DJ_LAB/corpus/manifest.json" \
  --derivatives "$DJ_LAB/derivatives" --results "$DJ_LAB/results" --output "$DJ_LAB/onnx-sliced/run.json"
```

`export` needs the `onnx` package (1.17.0 in the run) together with PyTorch
2.5.1. `memory` measures the peak RSS of a new process with one input
(`--onnx` for ONNX Runtime, `--checkpoint` for PyTorch); run it once per
configuration. The results are copied to `results/onnx-*`.

## P12-b integration

`dbn_probe.py` decodes the retained activations of `beatthis-*-direct`
with the engine's NumPy DBN (`shared/dj/dbn.py`) and compares them with the events
that madmom produced for `beatthis-*-dbn`. `integrated_probe.py` runs the
full production analyzer on the pinned corpus: FFmpeg at 22050 Hz,
Beat This! on ONNX Runtime, DBN and measurements. It scores separately the
model events, the final grid and the downbeats of the confirmed regions. Both run
in the engine environment, without PyTorch or madmom.

```sh
.venv/bin/python -I docs/internal/dj/detector_comparison/dbn_probe.py "$DJ_LAB/results" dbn.json
.venv/bin/python -I docs/internal/dj/detector_comparison/integrated_probe.py "$DJ_LAB" integrated.json
```

## Revalidation of the final analyzer

The updated report is in [FINAL_RESULTS](FINAL_RESULTS.md). The
discarded networks are not rerun and their timings are not mixed with a new
run: the 29 original configurations are kept and the integrated method is
measured again on the same corpus. Corpus, tolerances,
weights, thresholds and policies are not changed based on its results.

`integrated_probe` checks all audio/annotation hashes and the
equality of references before inferring, allowing only relocation of paths.
It saves revision, hashes of the executed code, analyzer version, runtime,
weights and FFmpeg, raw events, full analysis, per-case metrics and per-component CPU
times. It requires prepared and verified weights: it does not download
or write a station cache. A `.gz` output keeps the full JSON.
The comparison with the previous report explicitly states that the previous one did not
record the version or the revision; no retrospective version is assigned to it.

```sh
export SOUNDSIBLE_BEAT_MODEL=/path/to/beat_this-final0.onnx
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
DJ_RESULTS=docs/internal/dj/detector_comparison/results
.venv/bin/python -I docs/internal/dj/detector_comparison/integrated_probe.py "$DJ_LAB" \
  "$DJ_RESULTS/integrated-final.json.gz" --baseline "$DJ_RESULTS/integrated-p12b.json"
.venv/bin/python -I docs/internal/dj/detector_comparison/integrated_probe.py "$DJ_LAB" \
  "$DJ_RESULTS/integrated-final-aac.json.gz" --aac
.venv/bin/python -I docs/internal/dj/detector_comparison/final_pairs.py \
  "$DJ_RESULTS/integrated-final.json.gz" "$DJ_RESULTS/final-pairs.json.gz"
.venv/bin/python -I docs/internal/dj/detector_comparison/final_pipeline.py "$DJ_LAB" \
  "$DJ_RESULTS/final-pipeline.json"
"$DJ_LAB/venv/bin/python" -I docs/internal/dj/detector_comparison/final_continuity.py \
  "$DJ_RESULTS/integrated-final.json.gz" "$DJ_RESULTS/final-continuity.json"
"$DJ_LAB/venv/bin/python" -I docs/internal/dj/detector_comparison/final_continuity.py \
  "$DJ_RESULTS/integrated-final-aac.json.gz" "$DJ_RESULTS/final-continuity-aac.json" --aac
```

Run in series, with no other inference during the CPU measurements.
`final_pairs` plans the 3782 directed pairs without self-repetition from
the retained analyses, verifies admission/speed and checks the `bars`
promises in both cues against the references. Its data do not prove listening
or physical execution of the players.

`final_pipeline` uses the real analyzer for the five AAC and three diagnostic
WAV files. The measurements reach a temporary SQLite through `analyse_audio`,
without injecting predictions. It rejects measurements from the previous version,
checks cold/warm, zero decodes when warm and the same plan
in sources, requests, placement, repair, legacy and HTTP refinement.
It also creates a 600-second recording and verifies the
90/120-second windows and the absence of coverage/alignment in the gap. The
providers and acquisition are replaced by local fixtures; HTTP uses
the test client, not the personal server. The station's cache and library
are not opened. This does not certify another architecture or operating
system, and the physical web/Android tests are not repeated.

`final_continuity` completes the optional `mir_eval` metrics from the
retained events, with the already pinned experimental environment. It does not infer again
and does not add SciPy/`mir_eval` to the engine. It checks cohort, reference hash and
equality of the F1 when recalculating; it keeps CMLc/CMLt/AMLc/AMLt per case and their
explicit absences, as well as the versions and hashes of this evaluator.

## P12 boundary and limits of the comparison

`normalize` is the only experimental adapter to the #394 contract. The
events do not by themselves provide a meter confidence. If the backend
does not define it, it stays null in the raw data and passes as zero evidence to the existing
guards. Sigmoids are not converted into a calibrated musical probability.
The subdivision and the notated unit stay unknown when they are not measured.

`pipeline` uses a temporary runtime and one SQLite per configuration. It injects
the experimental measurements at the #394 storage boundary, after the
real execution of the backend on AAC. It checks HTTP for sources, placement,
repair, legacy and refinement, cold/warm state, absence of decoding
when warm, compact responses and the same plan in all inputs. It does not
replace acquisition or install a detector in production. Its record
distinguishes adaptation/contract from musical certification of a mix.
It also passes to HTTP the WAV outputs of the uniform pulse and of the two meter
changes, kept in the main run. It records whether the plan promises
bar alignment even though there is no identifiable downbeat.

Native packages, accuracy on music, the planner contract,
the web/Android players and physical listening are different kinds of evidence.
A correct inference on Linux x86_64 does not certify execution on Windows,
macOS or ARM64. The report records the tests performed and what is missing.
