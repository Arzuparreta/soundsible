# Explicit track metadata edits

`LibraryManager.patch_track_metadata` declares a small edit instead of asking
SQLite to rediscover differences across a complete mutable library. Manual
metadata-only fallback and the metadata/cover flags use this operation. Audio
rewrites, rekeys, downloads, removals and playlist edits retain their existing
contracts and full writer.

Only title, artist, album, album artist, cover source and the user-modified flag
are accepted. The library revision and pre-edit public fingerprint must match
inside the transaction. The live track is changed only after commit. A conflict
or storage failure reloads canonical state and reports failure. Invalidated
proofs use a canonical reload and the established full writer for that operation;
a dirty but supposedly verified snapshot is rejected, not silently certified.

The targeted transaction updates one track and the library revision. It retains
public-row journals and search proofs; artist/album changes still rebuild the
catalog projection. Track order, playlists, aliases, acquisition dates and user
state are not replaced. This removes track/playlist staging and comparisons,
not every O(N) operation: checking mutable models, search fingerprints, public
proofs and portable exports still require full passes. No debounce is introduced.

Reproduce on temporary directories on the repository's filesystem:

```sh
PYTHONPATH=. .venv/bin/python scripts/benchmark_track_metadata_patch.py \
  --sizes 200 1000 10000 --repeats 3
```

[Raw samples](track-metadata-patch.jsonl), title edit including two local exports,
three repetitions per path on Linux:

| Tracks | Whole snapshot median | Explicit edit median |
| --- | ---: | ---: |
| 200 | 92.8 ms | 83.6 ms |
| 1,000 | 133.9 ms | 133.9 ms |
| 10,000 | 600.8 ms | 517.7 ms |

These short sequential samples include filesystem flush variability. They do
not establish a universal speedup, memory reduction or audible improvement.
Differential tests compare canonical output against the established full writer,
and cover failed projections/commits, invalid proofs and a newly loaded manager.
