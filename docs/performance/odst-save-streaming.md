# ODST library saves without a whole JSON output string

`ODSTDownloader.save_library()` now writes the shared `iter_json()` output in
blocks instead of constructing `to_json()` before writing. The track batch is
128, using the existing shared serializer. Successful files remain byte-identical.

The lock still covers reading, preservation of Station's podcast data and the
entire write. Existing behavior is preserved: I/O failures and valid JSON that
cannot construct the model retain podcast fields in memory; malformed JSON
returns an empty model and clears those fields. The latter distinction was
confirmed by the subsequent podcast-reader differential tests. Write and
serialization errors propagate. The existing file is rewritten in place, keeping
its inode, permissions and symlink target. No debounce, fsync or atomic rename
was added. A failed save can still leave a corrupt file: a streaming encoding
failure may leave a prefix where the former eager encoding left an empty file.
Neither implementation guarantees recovery of the previous document.

This removes the complete output string and full track-dictionary serialization
copy. It does **not** remove ODST's resident model or the full read and model
reconstruction used to preserve podcasts. The shared iterator also retains a
list of track references and serializes non-track fields whole; total save
memory is not constant or bounded to one track batch.

## Measurements

Baseline `d06bd6469db48e5f6e0e65853fea67c8e2b21a63`; [raw results](odst-save-results.jsonl).
Five timing repetitions, alternating before/after, on temporary files on the
repository storage volume. Each invocation starts from identical file bytes and
checks output equality. A separate tracemalloc invocation measures temporary
Python allocations, excluding the preloaded model and expected JSON; it is not
RSS and excludes native allocations. Read and write caches are not cold.

| Library | Before ms | After ms | Before peak MiB | After peak MiB |
| --- | ---: | ---: | ---: | ---: |
| Real-copy, 208 tracks | 9.44 | 9.85 | 2.88 | 2.71 |
| Synthetic, 1,000 | 26.55 | 27.00 | 5.02 | 4.70 |
| Synthetic, 10,000 | 280.00 | 319.83 | 49.01 | 45.84 |
| Synthetic, 50,000 | 1,768.45 | 1,746.02 | 245.14 | 229.11 |

The real-copy is the existing 208-track, 719,005-byte fixture used by the Station
export benchmark, read-only; actual saves run only on temporary copies. No
personal metadata or source paths are recorded in results. The synthetic corpus
uses the existing export benchmark's deterministic track generator.

At 50k, temporary peak falls by 16.04 MiB (~6.5%). Full-save memory remains high
because reading reconstructs all tracks. At 10k this run is ~14% slower; at 208
and 1k it is also slightly slower. This is an accepted memory/latency tradeoff,
not evidence that every save is faster. Bytes written are unchanged, and no
reduction in physical disk traffic, total process RSS or listening cost is
claimed.

A separate instrumented phase run at 50k recorded:

| Phase | Before ms | After ms |
| --- | ---: | ---: |
| Read text | 19.8 | 19.8 |
| Reconstruct model | 782.2 | 785.7 |
| JSON encoding | 599.3 | 606.6 |
| Write calls + close | 269.7 | 303.7 |

Phase times are single diagnostic runs, not the medians above. Their write time
includes buffered close, not fsync. They exclude file opening, lock acquisition
and other bookkeeping and must not be summed as the full-save medians. No
benchmark ran concurrently with the full test suite.

## Reproduction and validation

```sh
venv/bin/python scripts/benchmark_odst_save.py --repeats 5 \
  --output /tmp/odst-save.jsonl
# Optional read-only fixture:
venv/bin/python scripts/benchmark_odst_save.py --library PATH/library.json \
  --output /tmp/odst-save-real.jsonl
venv/bin/python -m pytest -q tests/test_odst_library_save.py
```

The baseline method is loaded from the trusted git revision; the shared model
implementation is held constant. Constructor side effects, downloads and cloud
sync are intentionally excluded. Missing files, malformed old JSON, empty and
batch-boundary libraries, exact bytes, podcast preservation, permissions,
symlinks, lock ownership and recovery after open/write/encoding errors are
covered by 12 targeted tests. Linux validation does not establish native Windows
behavior or cross-process safety with concurrent Station writes. The latter is
an existing limitation of the two writers and was not changed here.

Final validation: full Python suite **1,521 passed**; Ruff on modified Python
files and `git diff --check` passed. No frontend files changed; frontend tests
were not rerun. The running engine and user's library files were not modified.
