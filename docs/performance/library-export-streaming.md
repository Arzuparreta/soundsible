# Streamed library.json exports

After every canonical save the engine refreshes portable `library.json` copies:
the per-user manifest, `<music>/library.json` on single-user instances, and the
storage provider's mirror. It used to build the whole document twice per save —
`to_json()` for the local copies, then again inside `provider.save_library()` —
each time as a tree of track dictionaries plus one string of the full file.
Now it is serialized once, in pieces, and every other copy is a byte copy of
the first. File contents, locations, permissions and durability are unchanged.

## What changed

- `LibraryMetadata.iter_json()` yields `to_json()` in pieces. Header values are
  encoded exactly as before; tracks are encoded 128 at a time and indented one
  level deeper. JSON escapes newlines inside strings, so every newline in an
  encoded block is layout. `to_json()` itself is unchanged and both share one
  definition of the public keys and their order.
- `_export_metadata()` takes the model instead of a string. It streams into the
  first writable destination (temporary file, fsync, rename — as before), then
  publishes the other local copies as byte copies of that file, the same way.
  Unwritable destinations are still reported once and skipped; if the first
  fails, the next one is serialized instead.
- The provider receives the finished file (`save_library_file`). The local
  provider copies it **in place**, exactly like the `write_text` it replaces:
  the mirror keeps its inode, permissions and any symlink, and is still not
  fsynced. Remote providers upload the same text as before (platform line
  endings turned back into `\n`), without a second serialization; their upload
  still holds the file's text in memory once. With no local copy written, the
  provider serializes the model as before.
- Exports of one library hold a lock, so they never interleave: a copy never
  reads a file another export is replacing, which Windows would refuse.
- Each export logs one INFO line with its size, destinations and duration, so an
  instance's own logs show what exports cost there.

## Validation

`tests/test_library_export.py` checks `iter_json()` against `to_json()` byte for
byte (empty headers; 0/1/511/512/513/1025 tracks; blocks of 1/2/128/512;
non-ASCII, quotes, backslashes, control characters, NUL, `None`, nested lists
and dictionaries, podcasts), that a save never builds the whole document, that
every copy equals `to_json()` without leftover temporaries, shared music
folders, unwritable and failing destinations, failed renames, the in-place
mirror keeping symlink/inode/mode, the provider fallback, the export lock,
remote uploads including CRLF files, and a memory bound. Existing canonical
library, folder scan and multi-user tests pass unchanged.

## Reproduction and measured results

```sh
venv/bin/python scripts/benchmark_library_export.py --repeats 5 --library PATH/library.json
```

The previous exporter is loaded from `89493bc`; its caller's `to_json()` is
included, as it ran before the call. Both write the three copies of a default
single-user install into temporary directories on the repository storage
volume, and every copy is checked against `to_json()`. The SQLite save that
precedes an export is not included. Peaks are tracemalloc (Python allocations,
excluding the loaded library). `wchar` counts bytes passed to `write()`;
storage writes come from `/proc/self/io`, not device telemetry.

Local run on 2026-09-22: [raw measurements](library-export-streaming-results.jsonl).
"Real" is an existing 208-track library whose file is 60% podcast episode cache.

| Library | File | Previous ms | Current ms | Peak MiB | Serializations |
| --- | ---: | ---: | ---: | --- | --- |
| Real, 208 tracks | 719,005 B | 106.57 | 99.73 | 2.197 → 1.347 | 2 → 1 |
| 200 tracks | 234,148 B | 89.91 | 79.41 | 0.809 → 0.531 | 2 → 1 |
| 1,000 tracks | 1.17 MB | 115.05 | 97.49 | 3.483 → 0.689 | 2 → 1 |
| 10,000 tracks | 11.73 MB | 469.68 | 366.89 | 33.693 → 0.759 | 2 → 1 |
| 50,000 tracks | 58.86 MB | 2,470.42 | 1,921.95 | 168.533 → 1.066 | 2 → 1 |

Bytes written did not change (for example 2,157,015 at 208 tracks and 176.6 MB
at 50,000: three full copies). At small sizes an export is dominated by its two
fsyncs, so the time saved there is small and within disk noise.

## Coalescing exports: not done

Writing `library.json` at most every N seconds would remove whole exports in
bursts of saves. It was evaluated and deferred:

- On the measured real library an export is ~100 ms, mostly two fsyncs, and
  about 2.2 MB written. Saves follow user actions, and download commits are
  already coalesced (`orchestrator.schedule_metadata_commit`, 2 s).
- ODST also reads `<music>/library.json` (at construction and on each of its
  saves, to keep podcast data) and rewrites it in place. A delayed Station export
  lengthens the window in which ODST can write stale podcast data back.
- The existing commit debounce has no flush on shutdown. A delayed export would
  be lost when the engine stops; it is rewritten from SQLite only when the
  account's core is next built.

Revisit with the INFO lines from a real instance: large libraries saved often
are where it would pay off (three full copies per save).

These are single-machine measurements of the export alone, not end-to-end save
latency, total RSS, energy use or listening behaviour.
