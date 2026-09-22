# ODST library saves without a whole JSON output string

`ODSTDownloader.save_library()` now writes the shared `iter_json()` output in
blocks instead of constructing `to_json()` before writing. The track batch is
128, using the existing shared serializer. Successful files remain byte-identical.

The lock still covers reading, preservation of Station's podcast data and the
entire write. Existing behavior is preserved: I/O failures and valid JSON that
cannot construct the model retain podcast fields in memory; malformed JSON
returns an empty model and clears those fields. The latter distinction was
confirmed by the subsequent podcast-reader differential tests. Write and
serialization errors propagate. The blocks stream into a temporary beside the
file, which is fsynced and renamed over it (`shared.atomic_file.replace_contents`,
see [Atomic replacement](#atomic-replacement) below): the Station reads this file
while ODST writes it, and a failed save now leaves the previous document intact.

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

## Atomic replacement

The streamed save first wrote in place, as the eager one had: truncate, then
write. Across 128-track blocks that left a window in which the Station could
read a partial `library.json`, and a crash or encoding error left one behind.
The save now goes through `replace_contents`, which keeps what the in-place
write offered its users:

- a symlink is followed and stays a symlink; its target is replaced;
- the file keeps its permission bits, and a new file gets the umask default
  (a plain `mkstemp` temporary would have left it 0600);
- a folder that refuses a temporary gets the old in-place write rather than none.

The inode and owner change. Hard links to `library.json` no longer follow it;
nothing in Soundsible creates them.

Cost, measured against the in-place writer `ee94fdb` with the same benchmark,
five alternating repetitions, on an ext4 filesystem on a spinning disk
(Seagate ST1000DM010): [raw results](odst-save-atomic-results.jsonl).

| Library | In place ms | Atomic ms | Peak MiB (both) |
| --- | ---: | ---: | ---: |
| Synthetic, 200 | 4.21 | 57.22 | 0.53 |
| Synthetic, 1,000 | 20.22 | 71.71 | 0.69 |
| Synthetic, 10,000 | 238.06 | 312.02 | 0.76 |
| Synthetic, 50,000 | 1,261.66 | 1,439.97 | 1.07 |

The added ~50–75 ms is the fsync on this disk. At 50k the difference is noisy:
an earlier identical run measured +2 ms, this one +178 ms. It is paid once per
save, that is once per finished download, inside ODST's lock. Memory peaks are
unchanged. The benchmark's per-phase split instruments `open` in the ODST
module, so it no longer sees the candidate's writes; read the medians, not the
phase rows, for this comparison.

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
symlinks, lock ownership and keeping the previous file after temporary, write and
encoding errors are covered by targeted tests. Linux validation does not establish native Windows
behavior or cross-process safety with concurrent Station writes. The latter is
an existing limitation of the two writers and was not changed here.

Final validation: full Python suite **1,521 passed**; Ruff on modified Python
files and `git diff --check` passed. No frontend files changed; frontend tests
were not rerun. The running engine and user's library files were not modified.
