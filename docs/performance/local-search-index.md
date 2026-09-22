# Local search index

The library provider of `/api/catalog/search` used to fold and score every
track in the in-memory library for each query. It now asks a per-account SQLite
table for the tracks that can match, in library order, and runs the unchanged
ranker and selection over those only. The ranking function, per-shape budgets,
provider merge, response payload and the full-scan fallback are unchanged. No
copy of the library is kept in RAM.

## Data and request flow

`library_search` in each account's `library.db` (`shared/library_search.py`)
stores, per library track, its position and its title, artist and album already
folded exactly as the ranker compares them (`search_title`/`search_text`, which
`_text_score` now uses too). `library_search_state` holds a validity flag, the
index `VERSION` and a fingerprint of the library the rows describe.

`_load_library_tracks()` returns the request's track list tied to the database
it was loaded from. `_local_catalog()` then, in one read snapshot:

1. Returns `[]` for an empty folded query (every field scores zero).
2. Checks that the index is valid and built by this `VERSION` (index format,
   interpreter release, Unicode data version).
3. Fingerprints the in-memory list: blake2b over memo-free pickles of each
   track's `(title, artist, album_artist, album)` in chunks of 512. It must equal
   the stored fingerprint. IDs are not included; see below.
4. Reads `(position, title, artist, album)` for rows whose folded fields can
   score, ordered by position, and ranks `tracks[position]` with those texts.

If any step fails — unsaved edits, an invalid or outdated index, a missing
table, an SQL error, a query SQLite cannot bind — the request scans the model
from scratch exactly as before. Partial selection state is discarded first.

## Why the results and their order cannot differ

- **Same candidates.** A positive score needs the folded query inside a field
  (exact, prefix and contains tiers) or every query token among the field's
  tokens. The SQL keeps rows where `instr(field, query)` holds or every token is
  a substring of the field. `instr` compares UTF-8 at character boundaries and
  handles NUL, so it is Python's `in`. Tokens of stored texts are substrings of
  them; a row where one is not (non-idempotent folding) is flagged `loose` and
  always returned. None was found across Unicode on CPython 3.14.7 / Unicode
  16.0.0, but it is checked per row instead of assumed. Without a token branch
  the filter is exactly "some field scores"; with one it is a superset (a token
  inside a longer word), and the ranker drops the extras.
- **Same order.** The fingerprint proves the in-memory sequence of search
  fields equals the stored one, positions are proven contiguous and each index
  row carries its track's position. Candidates therefore reach the ranker in
  library order: entity representatives (first track with the best score) and
  ties are chosen as before. The ranker reads IDs, covers and payloads from the
  model itself, so a rekey that is not saved yet is still reported correctly.
- **Same scores.** Stored texts are what the ranker computes from the same raw
  values with the same functions. A test pins the source of the normalization
  helpers, `_score_folded` and the SQL filter to `INDEX_FORMAT`, so changing any
  of them requires reviewing this argument and, if stored values change,
  bumping the format.

## Maintenance

The index is derived from committed rows only (`tracks` and `library_tracks`),
inside the canonical save transaction and during schema setup, in a savepoint.
A failure there is logged and leaves the index invalid; it never fails a save.

Triggers stored in the database (so raw SQL and older engines are covered):

| Change | Effect |
| --- | --- |
| `tracks` id/title/artist/album_artist/album, insert, delete | delete that index row, invalidate |
| `library_tracks` insert, delete | invalidate |
| `library_tracks` position | move that index row, invalidate |
| `library_search` delete or position edit | invalidate |
| `library_search` folded values written outside `sync` | full rebuild |
| any other `tracks` column (duration, `added_at`, `album_id`...) | nothing |

A save whose index is still valid costs one state read. Otherwise `sync`
removes orphan rows, folds only missing ones (keyset batches of 512 read from
SQLite, never the model) and makes one ordered pass that computes the stored
fingerprint and verifies positions. Misaligned positions, missing or recreated
index objects, another table shape or a new `VERSION` rebuild everything.
Databases from before this change are indexed once, at their first schema
setup in a new engine process.

## Costs and bounds

- The table grows with the library, on disk: about 90 bytes per track here.
  SQLite page cache and the sorter used for ordering matches are native memory
  and not measured below.
- Each indexed query fingerprints the whole in-memory list (the fixed floor
  below) and holds one pooled connection and a read snapshot while ranking.
- Dense queries still rank every matching track in Python; the index removes
  folding and non-matching tracks, not the ranker's per-match work.
- Saves that change search fields or order pay for folding changed rows and one
  ordered pass; moving tracks updates one index row per moved track.
- The first schema setup after upgrading folds the whole library while holding
  the process-wide schema lock.
- Per-request entity caches remain bounded at 4,096 entries, as before.

## Validation

`tests/test_library_search_index.py` compares complete ordered results of the
indexed path, the current scan and the frozen reference selector
(`tests/fixtures/local_catalog_reference.py`) and asserts which path answered.
It covers randomized libraries (accents, combining marks, `ß`/`İ`, CJK, emoji,
NUL, punctuation, release junk, empty/`None` fields, `album_artist` fallback,
ties, reversed order), the SQL filter against scores directly, forced `loose`
rows, unsaved title/artist/`album_artist`/album/order/add/remove edits, unsaved
rekeys, saves folding only changed rows, saved rekeys, restart, a fresh
subprocess, `VERSION` changes, raw SQL on each table, dropped or foreign-format
tables, pre-index databases, misaligned positions, fold failures during a save,
unbindable queries, empty libraries, concurrent queries and the HTTP route.

## Reproduction and measured results

```sh
venv/bin/python scripts/benchmark_local_search_index.py --sizes 1000 10000 50000 --repeats 5
```

`previous` is `_local_catalog` loaded from `78acb5e`; `scan` and `indexed` are
the current code without and with the index. All three return equal lists for
every query, and the indexed runs are asserted to have used the index. Timings
are medians of the selector alone: no providers, HTTP, JSON, network or
playback. Peaks are tracemalloc and exclude the loaded library and native
SQLite. Libraries have one artist per 100 tracks and one album per 10, uuid4
IDs, periodic `(Official Video)` titles and accented album names. Writes run
the previous revision's canonical writer and the current one on separate
databases, alternating each repetition. Temporary databases live on the
repository storage volume.

Local run on 2026-09-21: [raw measurements](local-search-index-results.jsonl).
"Matching" counts the rows the index handed to the ranker.

| Tracks | Query | Matching | Previous ms | Scan ms | Indexed ms | Peak MiB (previous → indexed) |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 50,000 | `so` (dense) | 49,990 | 196.58 | 193.65 | 143.41 | 0.964 → 0.769 |
| 50,000 | `song` | 49,990 | 198.91 | 194.47 | 152.68 | 0.964 → 0.769 |
| 50,000 | `artist 42` | 1,500 | 253.18 | 243.85 | 39.11 | 0.998 → 0.130 |
| 50,000 | `song 4242` | 15 | 256.43 | 241.13 | 32.84 | 0.961 → 0.072 |
| 50,000 | `album 14` (accents) | 1,990 | 250.46 | 242.46 | 40.84 | 0.997 → 0.121 |
| 50,000 | `14 album` (reordered) | 1,990 | 264.81 | 238.71 | 39.00 | 0.961 → 0.087 |
| 50,000 | `zzqx` (absent) | 0 | 253.00 | 238.17 | 28.97 | 0.958 → 0.072 |
| 10,000 | `so` (dense) | 9,990 | 38.27 | 37.73 | 27.30 | 0.231 → 0.188 |
| 10,000 | `artist 42` | 100 | 48.19 | 46.55 | 8.21 | 0.243 → 0.102 |
| 10,000 | `zzqx` (absent) | 0 | 48.00 | 45.37 | 5.90 | 0.184 → 0.069 |
| 1,000 | `so` (dense) | 990 | 4.37 | 3.91 | 2.95 | 0.072 → 0.089 |
| 1,000 | `zzqx` (absent) | 0 | 4.35 | 4.21 | 0.70 | 0.025 → 0.068 |

The in-memory fingerprint alone took 0.47, 4.33 and 22.16 ms at 1,000, 10,000
and 50,000 tracks: it is most of an indexed query that matches little. Small
libraries allocate slightly more (the fingerprint chunk and SQLite cursor).

Canonical saves, median ms, previous writer → current writer:

| Tracks | Title edit | Append | Duration edit | Remove middle | Import (1 run) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 20.31 → 23.52 | 44.86 → 46.99 | 21.24 → 21.08 | 43.78 → 46.88 | 81.84 → 92.14 |
| 10,000 | 191.34 → 217.83 | 428.42 → 455.77 | 188.82 → 190.46 | 430.40 → 479.96 | 1,193.60 → 1,401.46 |
| 50,000 | 1,084.77 → 1,279.10 | 2,434.18 → 2,590.11 | 1,113.16 → 1,104.86 | 2,476.03 → 2,931.73 | 6,387.67 → 6,862.89 |

Edits to fields the index ignores cost the same. At 50,000 tracks a title edit
costs about 194 ms more (18%): one fold plus the ordered verification pass.
Removing a track from the middle moves about 25,000 index positions and costs
about 456 ms more (18%). Building the index for a database written by the
previous revision took 16.55, 155.36 and 1,306.63 ms (one run each).

The index's own pages were 90,112, 860,160 and 4,435,968 bytes. Database plus
WAL files grew from 99.26 to 108.17 MB at 50,000 tracks after the same write
sequence; that includes WAL not yet checkpointed and is not a steady-state size.

These are synthetic, single-machine selector measurements. They are not
end-to-end search latency, total RSS, energy use, event-loop responsiveness or
evidence about audible playback.
