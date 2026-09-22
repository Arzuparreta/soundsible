# ODST podcast preservation without reconstructing disk tracks

ODST saves retain Station's podcast subscriptions and episode cache from the
portable JSON on disk. Previously, this required reading the entire string,
decoding every dictionary and constructing a second `LibraryMetadata` with every
`Track`, only to use two fields. The new `read_podcast_fields()` reads from one
open descriptor in 64 KiB text chunks, decodes and validates each track with the
standard JSON decoder, then discards it. It retains the podcast fields only.
The full document is still scanned: this is a memory/allocation optimization,
not fewer bytes read or incremental persistence.

## Measurement and decision

Baseline `f5a5a8a` already streams serialization. The benchmark compares its
actual save method with the new complete save, alternating five repetitions on
temporary copies on the repository filesystem. Every output must match the
expected serialized bytes. The real library is read only; no production writes
or engine restart were performed. [Raw results](odst-podcast-read-results.jsonl)
include timings, source hashes and separate allocation/phase runs.

| Library | Median before → after | Temporary Python peak before → after |
| --- | ---: | ---: |
| Real copy, 208 tracks | 9.32 → 10.88 ms | 2.715 → 2.139 MiB |
| Synthetic, 1,000 tracks | 26.20 → 18.07 ms | 4.700 → 0.689 MiB |
| Synthetic, 10,000 tracks | 325.76 → 231.92 ms | 45.841 → 0.759 MiB |
| Synthetic, 50,000 tracks | 1,755.02 → 1,155.98 ms | 229.107 → 1.067 MiB |

At 50k, complete-save peak allocations fall 99.5% and median elapsed time falls
34.1%. The separate phase run reduces parsing/model work from 761 to 286 ms.
The real copy regresses by 1.56 ms (16.7%); parsing large selected fields across
chunks has overhead, so this is not a universal latency improvement. Accept the
change for large-library memory scaling, with that explicit small-library cost.
The 1k after samples include a 42.72 ms outlier; it is retained in the raw data.

Peaks are tracemalloc allocations during the complete save, excluding the
preloaded resident model and expected-output string. They are not process RSS,
energy or listening measurements. Timing, tracing and phase instrumentation run
separately. Filesystem cache and hardware affect results; there is no fsync.

## Compatibility and limits

Differential tests compare against `LibraryMetadata.from_json`, including tiny
chunk boundaries, Unicode, nested values, split exponents, duplicate keys (last
wins), missing track fields, types/defaults, trailing data, truncation and
nonfinite version values. The required track fields come from the dataclass;
this validator must evolve if `Track.from_dict` gains further validation.

Legacy failure behavior is preserved, including an unintuitive distinction:
malformed JSON returns empty podcast fields; valid JSON with an invalid model
or an I/O failure retains in-memory fields through the existing save exception
handler. No new recovery behavior is claimed. Tests explicitly assert both
outcomes instead of comparing to an already-mutated model alone.

For valid normal libraries, parser memory is proportional to one decoded track
or header field, the selected podcast data and the read buffer. Large individual
values still decode whole. Malformed input can accumulate to EOF while the
standard decoder waits for a complete value. Total save memory also includes
the existing serializer's track-reference list and whole non-track fields; it
is not strictly constant. No resident cache or third-party parser was added.

ODST still locks only its own instance. It rewrote the shared path in place
when this was measured; it now replaces it whole, as Station publishes its
portable exports, still without a common writer lock. A POSIX test verifies that replacement during reading preserves the old
open descriptor's contents and that the next read sees the new file. This does
not fix lost updates or the read-to-write race. Cross-writer ownership and
native Windows validation remain separate work. A failed write now leaves the
previous file (see [ODST saves](odst-save-streaming.md#atomic-replacement)).

Validation: **1,532 Python tests passed**, focused Ruff checks and
`git diff --check` passed. A small benchmark smoke also verified the additional
reader hash in its metadata. No frontend code changed.

## Reproduce

```sh
venv/bin/python scripts/benchmark_odst_save.py --reference f5a5a8a \
  --library /absolute/path/to/library.json \
  --output /tmp/odst-podcast-read-results.jsonl
venv/bin/python -m pytest -q
venv/bin/ruff check odst_tool/library_podcasts.py odst_tool/odst_downloader.py \
  scripts/benchmark_odst_save.py tests/test_odst_podcast_reader.py \
  tests/test_odst_library_save.py
git diff --check
```

`--library` is optional. The default synthetic sizes are 1k, 10k and 50k.
Do not omit `--reference f5a5a8a` when reproducing this comparison: the script's
older default is the baseline for the serialization experiment.
